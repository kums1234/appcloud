// utils/ai-providers.js
import fs from 'fs'

// Vendor-abstracted AI provider layer for AppCloud.
//
// LOCAL  → Ollama (llama3 / any local model) — privacy-safe, zero egress
// CLOUD  → Anthropic | OpenAI | Google Gemini | Azure OpenAI
//
// Config via environment variables:
//   OLLAMA_BASE_URL       default: http://localhost:11434
//   OLLAMA_MODEL          default: llama3
//   AI_CLOUD_PROVIDER     anthropic | openai | gemini | azure   (required for cloud)
//   ANTHROPIC_API_KEY     (if provider=anthropic)
//   OPENAI_API_KEY        (if provider=openai)
//   GEMINI_API_KEY        (if provider=gemini)
//   AZURE_OPENAI_ENDPOINT (if provider=azure)
//   AZURE_OPENAI_API_KEY  (if provider=azure)
//   AZURE_OPENAI_DEPLOYMENT (if provider=azure, default: gpt-4o)
//   AI_CLOUD_MODEL        override default model for chosen provider
//
// Bare-metal API: OLLAMA_BASE_URL=http://ollama:11434 (from k8s/compose samples) does not
// resolve on your laptop — we map host "ollama" → 127.0.0.1 unless in K8s or a container.

function isLikelyInsideContainer() {
  try {
    if (fs.existsSync('/.dockerenv')) return true
  } catch {}
  try {
    if (fs.existsSync('/run/.containerenv')) return true
  } catch {}
  return false
}

function resolveOllamaBaseUrl(raw) {
  const base = (raw || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')
  if (process.env.KUBERNETES_SERVICE_HOST || isLikelyInsideContainer()) return base
  try {
    const u = new URL(base)
    const h = u.hostname
    if (h === 'ollama' || (h.startsWith('ollama.') && h.endsWith('.svc.cluster.local'))) {
      return 'http://127.0.0.1:11434'
    }
  } catch {}
  return base
}

// ─── Shared types ─────────────────────────────────────────────────────────────
// Message: { role: 'system'|'user'|'assistant', content: string }
// Response: { text: string, model: string, provider: string, tokens?: object }

// ─── Ollama (local) ───────────────────────────────────────────────────────────

/** Transient errors when the API pod is up before Ollama has endpoints, or during pod restarts. */
function isRetryableOllamaNetworkError(err) {
  const c = err?.cause?.code
  return (
    c === 'UND_ERR_SOCKET' ||
    c === 'UND_ERR_CONNECT_TIMEOUT' ||
    c === 'ECONNREFUSED' ||
    c === 'ENOTFOUND' ||
    c === 'ETIMEDOUT' ||
    /fetch failed/i.test(String(err?.message || ''))
  )
}

async function ollamaFetchWithRetries(url, init, { log, op = 'request' } = {}) {
  const maxAttempts = 4
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      lastErr = err
      const retry = isRetryableOllamaNetworkError(err) && attempt < maxAttempts
      if (retry) {
        const delay = Math.min(2000, 350 * 2 ** (attempt - 1))
        log?.warn?.(
          `[AI] Ollama ${op} failed (${err?.cause?.code || err.message}), retry ${attempt}/${maxAttempts} in ${delay}ms`
        )
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export class OllamaProvider {
  constructor({ baseUrl, model, log } = {}) {
    this.baseUrl = resolveOllamaBaseUrl(baseUrl)
    this.model   = model || process.env.OLLAMA_MODEL || 'llama3'
    this.log     = log || console
    this.name    = 'ollama'
  }

  async isAvailable() {
    try {
      const res = await ollamaFetchWithRetries(
        `${this.baseUrl}/api/tags`,
        { signal: AbortSignal.timeout(6000) },
        { log: this.log, op: 'probe /api/tags' }
      )
      return res.ok
    } catch {
      return false
    }
  }

  async chat(messages, { temperature = 0.3, maxTokens = 1024 } = {}) {
    let res
    try {
      res = await ollamaFetchWithRetries(
        `${this.baseUrl}/api/chat`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            model:    this.model,
            messages,
            stream:   false,
            options:  { temperature, num_predict: maxTokens },
          }),
          signal: AbortSignal.timeout(60_000),
        },
        { log: this.log, op: 'POST /api/chat' }
      )
    } catch (err) {
      const detail = err?.cause?.code || err?.cause?.message || err?.message || 'unknown'
      this.log?.error?.(
        `[AI] Ollama unreachable at ${this.baseUrl} (${detail}). Debug: same-namespace DNS (K8s), ` +
          '`kubectl get endpoints -n appcloud ollama`, `kubectl logs -n appcloud deploy/ollama`.'
      )
      throw new Error(
        `Cannot reach Ollama at ${this.baseUrl} (${detail}). ` +
          `If this is Kubernetes, wait until the ollama pod is Ready and endpoints exist, then retry. ` +
          `Otherwise run \`ollama pull ${this.model}\` where Ollama runs.`
      )
    }

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText)
      throw new Error(`Ollama error ${res.status}: ${err}`)
    }

    const data = await res.json()
    return {
      text:     data.message?.content || '',
      model:    data.model || this.model,
      provider: 'ollama',
      tokens:   { prompt: data.prompt_eval_count, completion: data.eval_count },
    }
  }

  async complete(prompt, opts) {
    return this.chat([{ role: 'user', content: prompt }], opts)
  }
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

export class AnthropicProvider {
  constructor({ apiKey, model, log } = {}) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY
    this.model  = model || process.env.AI_CLOUD_MODEL || 'claude-sonnet-4-6'
    this.log    = log || console
    this.name   = 'anthropic'
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is required')
  }

  async chat(messages, { temperature = 0.3, maxTokens = 2048 } = {}) {
    // Separate system message from user/assistant turns
    const system  = messages.find(m => m.role === 'system')?.content || ''
    const history = messages.filter(m => m.role !== 'system')

    const body = {
      model:      this.model,
      max_tokens: maxTokens,
      messages:   history,
      ...(system ? { system } : {}),
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw new Error(`Anthropic error ${res.status}: ${err?.error?.message || res.statusText}`)
    }

    const data = await res.json()
    return {
      text:     data.content?.[0]?.text || '',
      model:    data.model || this.model,
      provider: 'anthropic',
      tokens:   { prompt: data.usage?.input_tokens, completion: data.usage?.output_tokens },
    }
  }

  async complete(prompt, opts) {
    return this.chat([{ role: 'user', content: prompt }], opts)
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

export class OpenAIProvider {
  constructor({ apiKey, model, baseUrl, log } = {}) {
    this.apiKey  = apiKey  || process.env.OPENAI_API_KEY
    this.model   = model   || process.env.AI_CLOUD_MODEL || 'gpt-4o'
    this.baseUrl = baseUrl || 'https://api.openai.com/v1'
    this.log     = log || console
    this.name    = 'openai'
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required')
  }

  async chat(messages, { temperature = 0.3, maxTokens = 2048 } = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body:    JSON.stringify({ model: this.model, messages, temperature, max_tokens: maxTokens }),
      signal:  AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`OpenAI error ${res.status}: ${err?.error?.message || res.statusText}`)
    }

    const data = await res.json()
    return {
      text:     data.choices?.[0]?.message?.content || '',
      model:    data.model || this.model,
      provider: 'openai',
      tokens:   { prompt: data.usage?.prompt_tokens, completion: data.usage?.completion_tokens },
    }
  }

  async complete(prompt, opts) {
    return this.chat([{ role: 'user', content: prompt }], opts)
  }
}

// ─── Azure OpenAI ─────────────────────────────────────────────────────────────

export class AzureOpenAIProvider {
  constructor({ endpoint, apiKey, deployment, apiVersion, log } = {}) {
    this.endpoint   = endpoint   || process.env.AZURE_OPENAI_ENDPOINT
    this.apiKey     = apiKey     || process.env.AZURE_OPENAI_API_KEY
    this.deployment = deployment || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o'
    this.apiVersion = apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2024-02-01'
    this.log        = log || console
    this.name       = 'azure'
    if (!this.endpoint || !this.apiKey)
      throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are required')
    // Re-use OpenAI-compatible format
    this._openai = new OpenAIProvider({
      apiKey:  this.apiKey,
      model:   this.deployment,
      baseUrl: `${this.endpoint.replace(/\/$/, '')}/openai/deployments/${this.deployment}`,
    })
  }

  async chat(messages, opts) {
    // Azure appends api-version as a query param — patch the underlying fetch
    const baseRes = await fetch(
      `${this.endpoint.replace(/\/$/, '')}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
        body:    JSON.stringify({
          messages,
          temperature:  opts?.temperature ?? 0.3,
          max_tokens:   opts?.maxTokens ?? 2048,
        }),
        signal: AbortSignal.timeout(120_000),
      }
    )
    if (!baseRes.ok) {
      const err = await baseRes.json().catch(() => ({}))
      throw new Error(`Azure OpenAI error ${baseRes.status}: ${err?.error?.message || baseRes.statusText}`)
    }
    const data = await baseRes.json()
    return {
      text:     data.choices?.[0]?.message?.content || '',
      model:    this.deployment,
      provider: 'azure',
      tokens:   { prompt: data.usage?.prompt_tokens, completion: data.usage?.completion_tokens },
    }
  }

  async complete(prompt, opts) {
    return this.chat([{ role: 'user', content: prompt }], opts)
  }
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

export class GeminiProvider {
  constructor({ apiKey, model, log } = {}) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY
    this.model  = model  || process.env.AI_CLOUD_MODEL || 'gemini-1.5-pro'
    this.log    = log || console
    this.name   = 'gemini'
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is required')
  }

  async chat(messages, { temperature = 0.3, maxTokens = 2048 } = {}) {
    const system = messages.find(m => m.role === 'system')?.content || ''
    const history = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))

    const body = {
      contents:         history,
      generationConfig: { temperature, maxOutputTokens: maxTokens },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    }

    // Gemini accepts the key as `?key=` OR an `x-goog-api-key` header. Header
    // form keeps the key out of access logs / proxy logs / Referer headers
    // that often capture full URLs.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-goog-api-key':  this.apiKey,
      },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Gemini error ${res.status}: ${JSON.stringify(err?.error || res.statusText)}`)
    }

    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
    return {
      text,
      model:    this.model,
      provider: 'gemini',
      tokens:   {
        prompt:     data.usageMetadata?.promptTokenCount,
        completion: data.usageMetadata?.candidatesTokenCount,
      },
    }
  }

  async complete(prompt, opts) {
    return this.chat([{ role: 'user', content: prompt }], opts)
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createCloudProvider(log) {
  const provider = (process.env.AI_CLOUD_PROVIDER || '').toLowerCase()
  switch (provider) {
    case 'anthropic': return new AnthropicProvider({ log })
    case 'openai':    return new OpenAIProvider({ log })
    case 'azure':     return new AzureOpenAIProvider({ log })
    case 'gemini':    return new GeminiProvider({ log })
    default: return null   // cloud AI disabled
  }
}

/**
 * Build a cloud provider from explicit credentials (e.g. browser-saved Integrations UI).
 * `model` may be omitted or "auto" to use each vendor’s default.
 */
export function createCloudProviderFromOptions(log, opts = {}) {
  const provider = (opts.provider || '').toLowerCase()
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : ''
  const modelRaw = opts.model
  const autoModel = !modelRaw || String(modelRaw).toLowerCase() === 'auto'

  if (!provider || provider === 'auto') return null
  if (!apiKey) return null

  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey,
        model: autoModel ? undefined : modelRaw,
        log,
      })
    case 'openai':
      return new OpenAIProvider({
        apiKey,
        model: autoModel ? undefined : modelRaw,
        log,
      })
    case 'gemini':
      return new GeminiProvider({
        apiKey,
        model: autoModel ? undefined : modelRaw,
        log,
      })
    case 'azure': {
      const endpoint = (opts.azureEndpoint || '').trim() || process.env.AZURE_OPENAI_ENDPOINT
      const deployment = (opts.azureDeployment || '').trim()
        || (autoModel ? undefined : String(modelRaw))
        || process.env.AZURE_OPENAI_DEPLOYMENT
        || 'gpt-4o'
      if (!endpoint) {
        throw new Error('Azure OpenAI endpoint is required')
      }
      return new AzureOpenAIProvider({
        endpoint,
        apiKey,
        deployment,
        log,
      })
    }
    default:
      return null
  }
}

export function createLocalProvider(log) {
  return new OllamaProvider({ log })
}