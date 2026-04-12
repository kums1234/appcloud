/** Browser-stored AI credentials from Integrations (sent only with chat requests). */

export const AI_CLIENT_CONFIG_KEY = 'appcloud_ai_client_config'

export function readAiClientConfig() {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(AI_CLIENT_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function writeAiClientConfig(cfg) {
  if (typeof window === 'undefined') return
  localStorage.setItem(
    AI_CLIENT_CONFIG_KEY,
    JSON.stringify({ ...cfg, savedAt: Date.now() })
  )
}

export function clearAiClientConfig() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(AI_CLIENT_CONFIG_KEY)
}

/** Safe body fragment for POST /ai/chat */
export function buildCloudOverrideForApi() {
  const c = readAiClientConfig()
  if (!c || c.provider === 'auto' || !String(c.apiKey || '').trim()) return null
  return {
    provider: c.provider,
    apiKey: String(c.apiKey).trim(),
    model: c.model === 'auto' || !c.model ? undefined : c.model,
    azureEndpoint: String(c.azureEndpoint || '').trim() || undefined,
    azureDeployment: String(c.azureDeployment || '').trim() || undefined,
  }
}
