// Locks the routing decisions in ai-providers.js — which provider gets
// instantiated for which env / option combination, base-URL resolution
// for Ollama (the K8s vs host-network distinction), and the network-
// retry classifier. These are routed-by-env decisions where a silent
// regression can leave the system "running" but degraded (wrong cloud
// provider, infinite retry on a non-retryable error).

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import {
  createCloudProvider,
  createCloudProviderFromOptions,
  createLocalProvider,
  resolveOllamaBaseUrl,
  isRetryableOllamaNetworkError,
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  AzureOpenAIProvider,
} from '../ai-providers.js'

const ENV_KEYS = [
  'AI_CLOUD_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL',
  'KUBERNETES_SERVICE_HOST', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AZURE_OPENAI_API_KEY',
]
function snapshotEnv() {
  const out = {}
  for (const k of ENV_KEYS) out[k] = process.env[k]
  return out
}
function restoreEnv(s) {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k]
    else                    process.env[k] = s[k]
  }
}

describe('createCloudProvider — env-driven factory', () => {
  let snap
  beforeEach(() => { snap = snapshotEnv() })
  afterEach(()  => restoreEnv(snap))

  test('AI_CLOUD_PROVIDER unset → null (cloud disabled)', () => {
    delete process.env.AI_CLOUD_PROVIDER
    expect(createCloudProvider({})).toBeNull()
  })

  test('case-insensitive routing for each supported provider', () => {
    // Each provider's constructor validates that its API key is set;
    // populate every key so we can exercise the routing branches
    // without tripping the "missing key" assertion.
    process.env.ANTHROPIC_API_KEY    = 'k'
    process.env.OPENAI_API_KEY       = 'k'
    process.env.GEMINI_API_KEY       = 'k'
    process.env.AZURE_OPENAI_API_KEY = 'k'
    process.env.AZURE_OPENAI_ENDPOINT = 'https://x.azure.com'

    process.env.AI_CLOUD_PROVIDER = 'AnThRoPiC'
    expect(createCloudProvider({})).toBeInstanceOf(AnthropicProvider)
    process.env.AI_CLOUD_PROVIDER = 'OPENAI'
    expect(createCloudProvider({})).toBeInstanceOf(OpenAIProvider)
    process.env.AI_CLOUD_PROVIDER = 'gemini'
    expect(createCloudProvider({})).toBeInstanceOf(GeminiProvider)
    process.env.AI_CLOUD_PROVIDER = 'azure'
    expect(createCloudProvider({})).toBeInstanceOf(AzureOpenAIProvider)
  })

  test('unrecognised provider name → null (typo defense)', () => {
    process.env.AI_CLOUD_PROVIDER = 'definitely-not-a-real-provider'
    expect(createCloudProvider({})).toBeNull()
  })
})

describe('createCloudProviderFromOptions — Integrations-UI factory', () => {
  let snap
  beforeEach(() => { snap = snapshotEnv() })
  afterEach(()  => restoreEnv(snap))

  test('missing provider or apiKey → null (don\'t silently misroute)', () => {
    expect(createCloudProviderFromOptions({})).toBeNull()
    expect(createCloudProviderFromOptions({}, { provider: 'anthropic' })).toBeNull()
    expect(createCloudProviderFromOptions({}, { provider: 'anthropic', apiKey: '' })).toBeNull()
    expect(createCloudProviderFromOptions({}, { provider: '', apiKey: 'k' })).toBeNull()
  })

  test('provider=auto is treated as "no provider"', () => {
    expect(createCloudProviderFromOptions({}, { provider: 'auto', apiKey: 'k' })).toBeNull()
  })

  test('Anthropic / OpenAI / Gemini route to the right class with the supplied key', () => {
    const log = { warn: () => {} }
    expect(createCloudProviderFromOptions(log, { provider: 'anthropic', apiKey: 'k' })).toBeInstanceOf(AnthropicProvider)
    expect(createCloudProviderFromOptions(log, { provider: 'openai',    apiKey: 'k' })).toBeInstanceOf(OpenAIProvider)
    expect(createCloudProviderFromOptions(log, { provider: 'gemini',    apiKey: 'k' })).toBeInstanceOf(GeminiProvider)
  })

  test('model="auto" or omitted leaves the default-model selection to the provider', () => {
    const a = createCloudProviderFromOptions({}, { provider: 'anthropic', apiKey: 'k' })
    const b = createCloudProviderFromOptions({}, { provider: 'anthropic', apiKey: 'k', model: 'auto' })
    // Both should produce a valid provider with some model set; the
    // exact default is the provider's choice.
    expect(typeof a.model).toBe('string')
    expect(typeof b.model).toBe('string')
    expect(a.model.length).toBeGreaterThan(0)
    expect(b.model.length).toBeGreaterThan(0)
  })

  test('Azure: explicit model overrides the auto default', () => {
    const p = createCloudProviderFromOptions({}, {
      provider: 'azure', apiKey: 'k', azureEndpoint: 'https://x.azure.com', model: 'gpt-4o-mini',
    })
    expect(p).toBeInstanceOf(AzureOpenAIProvider)
    expect(p.deployment).toBe('gpt-4o-mini')
  })

  test('Azure without endpoint throws — the integration-UI form requires it', () => {
    delete process.env.AZURE_OPENAI_ENDPOINT
    expect(() =>
      createCloudProviderFromOptions({}, { provider: 'azure', apiKey: 'k' }),
    ).toThrow(/Azure OpenAI endpoint is required/)
  })
})

describe('resolveOllamaBaseUrl — host-network vs in-cluster', () => {
  let snap
  beforeEach(() => { snap = snapshotEnv() })
  afterEach(()  => restoreEnv(snap))

  test('explicit URL with custom host passes through unchanged', () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(resolveOllamaBaseUrl('http://my-llm.example.com:11434'))
      .toBe('http://my-llm.example.com:11434')
  })

  test('trailing slash is stripped', () => {
    expect(resolveOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434')
  })

  test('inside K8s, the `ollama` service hostname is preserved', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(resolveOllamaBaseUrl('http://ollama:11434')).toBe('http://ollama:11434')
  })

  test('outside K8s, the `ollama` service hostname is rewritten to localhost', () => {
    // No KUBERNETES_SERVICE_HOST + no /.dockerenv signal → host-machine
    // dev. The K8s service name `ollama` won't resolve there; rewrite
    // to 127.0.0.1 so port-forward / brew-installed Ollama works.
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(resolveOllamaBaseUrl('http://ollama:11434')).toBe('http://127.0.0.1:11434')
  })

  test('falls back to env or default when called with no arg', () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    process.env.OLLAMA_BASE_URL = 'http://example.com:11434'
    expect(resolveOllamaBaseUrl()).toBe('http://example.com:11434')
    delete process.env.OLLAMA_BASE_URL
    expect(resolveOllamaBaseUrl()).toBe('http://localhost:11434')
  })
})

describe('isRetryableOllamaNetworkError', () => {
  test('retryable: classic transient network errors', () => {
    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']) {
      const err = Object.assign(new Error('x'), { cause: { code } })
      expect(isRetryableOllamaNetworkError(err)).toBe(true)
    }
  })

  test('retryable: undici "fetch failed" message even when cause.code is not listed', () => {
    expect(isRetryableOllamaNetworkError(new Error('fetch failed'))).toBe(true)
  })

  test('not retryable: domain errors / generic failures', () => {
    expect(isRetryableOllamaNetworkError(new Error('Bad input'))).toBe(false)
    expect(isRetryableOllamaNetworkError({ cause: { code: 'EBADF' } })).toBe(false)
    expect(isRetryableOllamaNetworkError(null)).toBe(false)
    expect(isRetryableOllamaNetworkError(undefined)).toBe(false)
  })
})

describe('createLocalProvider', () => {
  test('returns an OllamaProvider with a resolved base URL', () => {
    const p = createLocalProvider({})
    expect(p).toBeInstanceOf(OllamaProvider)
    expect(typeof p.baseUrl).toBe('string')
    expect(p.baseUrl).toMatch(/^https?:\/\//)
  })
})
