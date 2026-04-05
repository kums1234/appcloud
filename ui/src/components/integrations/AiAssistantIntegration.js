'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { useTheme, getT } from '@/lib/theme'
import {
  readAiClientConfig,
  writeAiClientConfig,
  clearAiClientConfig,
} from '@/lib/ai-client-config'

const mono = { fontFamily: 'monospace' }

const PROVIDERS = [
  { value: 'auto', label: 'Auto — use API server environment' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'azure', label: 'Azure OpenAI' },
]

const MODELS_BY_PROVIDER = {
  auto: [{ value: 'auto', label: 'Auto' }],
  anthropic: [
    { value: 'auto', label: 'Auto' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  ],
  openai: [
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  gemini: [
    { value: 'auto', label: 'Auto' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  ],
  azure: [
    { value: 'auto', label: 'Auto (deployment name below)' },
    { value: 'gpt-4o', label: 'gpt-4o' },
  ],
}

export function AiAssistantIntegrationCard({ intg, connected, onConfigure }) {
  const { theme } = useTheme()
  const T = getT(theme)
  const [hover, setHover] = useState(false)
  const badgeMeta = {
    bg: `${intg.color}18`,
    border: `${intg.color}44`,
    text: intg.color,
  }

  return (
    <div
      id="ai-assistant"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover
          ? `linear-gradient(135deg,${intg.color}0d,${T.surface2})`
          : T.surface,
        border: `1.5px solid ${
          connected ? `${intg.color}66` : hover ? `${intg.color}33` : T.border
        }`,
        borderRadius: 14,
        padding: '18px 18px 16px',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        transition: 'all .2s',
        boxShadow: connected
          ? `0 0 28px ${intg.color}18`
          : hover
            ? `0 0 20px ${intg.color}10`
            : 'none',
      }}
      onClick={onConfigure}
    >
      {connected && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: `linear-gradient(90deg,transparent,${intg.color}77,transparent)`,
          }}
        />
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: `linear-gradient(135deg,${intg.color}20,${intg.color}08)`,
            border: `1.5px solid ${intg.color}${connected ? '66' : '33'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: connected ? `0 0 16px ${intg.color}33` : 'none',
            transition: 'all .2s',
            flexShrink: 0,
          }}
        >
          <span style={{ ...mono, fontSize: 11, fontWeight: 900, color: intg.color }}>
            {intg.logo}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 5,
          }}
        >
          <span
            style={{
              ...mono,
              fontSize: 8,
              fontWeight: 700,
              color: badgeMeta.text,
              background: badgeMeta.bg,
              border: `1px solid ${badgeMeta.border}`,
              padding: '2px 7px',
              borderRadius: 4,
              letterSpacing: '0.07em',
            }}
          >
            {intg.badge}
          </span>
          {connected ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: T.green,
                  boxShadow: `0 0 6px ${T.green}`,
                }}
              />
              <span style={{ ...mono, fontSize: 8, color: T.green, fontWeight: 700 }}>
                CONFIGURED
              </span>
            </div>
          ) : (
            <span style={{ ...mono, fontSize: 8, color: T.muted }}>NOT CONFIGURED</span>
          )}
        </div>
      </div>

      <div
        style={{
          ...mono,
          fontSize: 13,
          fontWeight: 800,
          color: T.text,
          marginBottom: 2,
          letterSpacing: '-0.01em',
        }}
      >
        {intg.name}
      </div>
      <div style={{ ...mono, fontSize: 9, color: T.muted, marginBottom: 8 }}>
        {intg.vendor}
      </div>

      <div
        style={{
          fontSize: 11,
          color: T.dim,
          lineHeight: 1.5,
          marginBottom: 12,
          fontFamily: 'monospace',
        }}
      >
        {intg.tagline}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {intg.capabilities.slice(0, 4).map((cap) => (
          <span
            key={cap}
            style={{
              ...mono,
              fontSize: 8,
              color: connected ? intg.color : T.muted,
              background: connected ? `${intg.color}12` : T.surface2,
              border: `1px solid ${connected ? `${intg.color}30` : T.border}`,
              borderRadius: 4,
              padding: '2px 6px',
            }}
          >
            {cap}
          </span>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 14,
          right: 14,
          opacity: hover || connected ? 1 : 0,
          transition: 'opacity .15s',
        }}
      >
        <div
          style={{
            ...mono,
            fontSize: 9,
            fontWeight: 700,
            color: intg.color,
            padding: '4px 10px',
            background: `${intg.color}15`,
            border: `1px solid ${intg.color}44`,
            borderRadius: 6,
          }}
        >
          {connected ? 'Edit config →' : 'Configure →'}
        </div>
      </div>
    </div>
  )
}

export function AiAssistantConfigModal({ intg, onClose, onSaved }) {
  const { theme } = useTheme()
  const T = getT(theme)

  const [provider, setProvider] = useState('auto')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('auto')
  const [azureEndpoint, setAzureEndpoint] = useState('')
  const [azureDeployment, setAzureDeployment] = useState('')

  const [status, setStatus] = useState(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    const c = readAiClientConfig()
    if (c) {
      setProvider(c.provider || 'auto')
      setApiKey(c.apiKey || '')
      setModel(c.model || 'auto')
      setAzureEndpoint(c.azureEndpoint || '')
      setAzureDeployment(c.azureDeployment || '')
    }
  }, [])

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      setStatus(await api.ai.status())
    } catch {
      setStatus(null)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    setModel((prev) => {
      const models = MODELS_BY_PROVIDER[provider] || MODELS_BY_PROVIDER.auto
      if (models.some((m) => m.value === prev)) return prev
      return models[0]?.value || 'auto'
    })
  }, [provider])

  const modelOptions = MODELS_BY_PROVIDER[provider] || MODELS_BY_PROVIDER.auto
  const showKey = provider !== 'auto'
  const showAzureExtra = provider === 'azure'

  const handleSave = () => {
    setSaving(true)
    try {
      writeAiClientConfig({
        provider,
        apiKey: showKey ? apiKey : '',
        model,
        azureEndpoint: showAzureExtra ? azureEndpoint : '',
        azureDeployment: showAzureExtra ? azureDeployment : '',
      })
      setSavedFlash(true)
      onSaved?.()
      setTimeout(() => {
        setSavedFlash(false)
        onClose()
      }, 700)
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = () => {
    clearAiClientConfig()
    setProvider('auto')
    setApiKey('')
    setModel('auto')
    setAzureEndpoint('')
    setAzureDeployment('')
    onSaved?.()
    onClose()
  }

  const localOn = status?.local?.available
  const cloudOn = status?.cloud?.available

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <style>{`
        @keyframes mIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .ai-cfg-scroll::-webkit-scrollbar{width:4px}
        .ai-cfg-scroll::-webkit-scrollbar-track{background:transparent}
        .ai-cfg-scroll::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
      `}</style>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: '#000000cc',
          backdropFilter: 'blur(6px)',
        }}
        onClick={onClose}
      />

      <div
        style={{
          position: 'relative',
          background: T.surface,
          border: `1px solid ${intg.color}33`,
          borderRadius: 18,
          width: '100%',
          maxWidth: 560,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: `0 0 80px ${intg.color}18, 0 30px 80px #00000099`,
          animation: 'mIn .22s cubic-bezier(.16,1,.3,1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: '5%',
            right: '5%',
            height: 1,
            background: `linear-gradient(90deg,transparent,${intg.color}88,transparent)`,
          }}
        />

        <div
          style={{
            padding: '18px 22px',
            borderBottom: `1px solid ${T.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              flexShrink: 0,
              background: `linear-gradient(135deg,${intg.color}22,${intg.color}08)`,
              border: `1.5px solid ${intg.color}44`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `0 0 20px ${intg.color}22`,
            }}
          >
            <span style={{ ...mono, fontSize: 11, fontWeight: 900, color: intg.color }}>
              {intg.logo}
            </span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ ...mono, fontSize: 14, fontWeight: 800, color: T.text }}>{intg.name}</div>
            <div style={{ ...mono, fontSize: 10, color: T.dim, marginTop: 2 }}>{intg.tagline}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 22, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <div className="ai-cfg-scroll" style={{ overflowY: 'auto', padding: '18px 22px', flex: 1 }}>
          <div
            style={{
              ...mono,
              fontSize: 8,
              color: T.muted,
              letterSpacing: '0.12em',
              marginBottom: 8,
              fontWeight: 700,
            }}
          >
            STATUS
          </div>
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 10,
              background: T.surface2,
              border: `1px solid ${T.border}`,
              marginBottom: 18,
              ...mono,
              fontSize: 10,
              color: T.dim,
              lineHeight: 1.6,
            }}
          >
            {loadingStatus ? (
              'Loading…'
            ) : (
              <>
                <div>
                  <span style={{ color: localOn ? T.teal : T.muted }}>●</span> Local (Ollama):{' '}
                  {localOn ? 'reachable' : 'offline'}
                  {status?.local?.baseUrl ? ` · ${status.local.baseUrl}` : ''}
                </div>
                <div>
                  <span style={{ color: cloudOn ? T.purple : T.muted }}>●</span> Cloud (server env):{' '}
                  {cloudOn ? 'configured' : 'not configured'}
                  {status?.cloud?.provider ? ` · ${status.cloud.provider}` : ''}
                </div>
                {!localOn && (
                  <div style={{ marginTop: 10, color: T.muted, fontSize: 9, lineHeight: 1.5 }}>
                    {status?.local?.inCluster || status?.local?.baseUrl?.includes('.svc.cluster.local') ? (
                      <>
                        K8s: the API pod cannot reach Ollama yet. Check{' '}
                        <code style={{ color: T.dim }}>kubectl get pods -n appcloud -l app=ollama</code> — the pod must be
                        Ready (first <code style={{ color: T.dim }}>ollama pull</code> can take many minutes). Then{' '}
                        <code style={{ color: T.dim }}>kubectl logs -n appcloud deploy/ollama</code>.
                      </>
                    ) : (
                      <>
                        Local: start Ollama where the API runs (Compose/K8s includes an ollama service). Ensure the
                        model exists: <code style={{ color: T.dim }}>ollama pull {status?.local?.model || 'llama3'}</code>
                      </>
                    )}
                  </div>
                )}
                {!cloudOn && (
                  <div style={{ marginTop: !localOn ? 6 : 10, color: T.muted, fontSize: 9, lineHeight: 1.5 }}>
                    Cloud: set <code style={{ color: T.dim }}>AI_CLOUD_PROVIDER</code> and the matching API key on the
                    server, or pick a provider below (keys stay in the browser).
                  </div>
                )}
              </>
            )}
            <button
              type="button"
              onClick={loadStatus}
              style={{
                ...mono,
                marginTop: 10,
                fontSize: 9,
                padding: '4px 10px',
                borderRadius: 6,
                border: `1px solid ${T.border}`,
                background: T.surface,
                color: T.text,
                cursor: 'pointer',
              }}
            >
              Refresh status
            </button>
          </div>

          <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.12em', marginBottom: 6, fontWeight: 700 }}>
            CLOUD PROVIDER
          </div>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={{
              width: '100%',
              background: T.surface2,
              border: `1px solid ${T.border2}`,
              borderRadius: 8,
              padding: '9px 12px',
              color: T.text,
              fontSize: 12,
              fontFamily: 'monospace',
              outline: 'none',
              cursor: 'pointer',
              marginBottom: 14,
              appearance: 'none',
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

          {showKey && (
            <>
              <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.12em', marginBottom: 6, fontWeight: 700 }}>
                API KEY
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste API key — stored only in this browser"
                autoComplete="off"
                style={{
                  width: '100%',
                  background: T.surface2,
                  border: `1px solid ${T.border2}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: T.text,
                  fontSize: 12,
                  fontFamily: 'monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                  marginBottom: 14,
                }}
              />
            </>
          )}

          {showAzureExtra && (
            <>
              <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.12em', marginBottom: 6, fontWeight: 700 }}>
                AZURE OPENAI ENDPOINT
              </div>
              <input
                type="text"
                value={azureEndpoint}
                onChange={(e) => setAzureEndpoint(e.target.value)}
                placeholder="https://your-resource.openai.azure.com"
                style={{
                  width: '100%',
                  background: T.surface2,
                  border: `1px solid ${T.border2}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: T.text,
                  fontSize: 12,
                  fontFamily: 'monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                  marginBottom: 12,
                }}
              />
              <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.12em', marginBottom: 6, fontWeight: 700 }}>
                DEPLOYMENT NAME
              </div>
              <input
                type="text"
                value={azureDeployment}
                onChange={(e) => setAzureDeployment(e.target.value)}
                placeholder="e.g. gpt-4o"
                style={{
                  width: '100%',
                  background: T.surface2,
                  border: `1px solid ${T.border2}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: T.text,
                  fontSize: 12,
                  fontFamily: 'monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                  marginBottom: 14,
                }}
              />
            </>
          )}

          <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.12em', marginBottom: 6, fontWeight: 700 }}>
            MODEL
          </div>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              width: '100%',
              background: T.surface2,
              border: `1px solid ${T.border2}`,
              borderRadius: 8,
              padding: '9px 12px',
              color: T.text,
              fontSize: 12,
              fontFamily: 'monospace',
              outline: 'none',
              cursor: 'pointer',
              marginBottom: 14,
              appearance: 'none',
            }}
          >
            {modelOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>

          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: `${T.amber}10`,
              border: `1px solid ${T.amber}33`,
              ...mono,
              fontSize: 9,
              color: T.dim,
              lineHeight: 1.5,
            }}
          >
            API keys in this form are stored in <strong style={{ color: T.text }}>localStorage</strong> on this browser and
            sent to your AppCloud API only when you use the assistant. For production, prefer server environment
            variables on the API container.
          </div>
        </div>

        <div
          style={{
            padding: '14px 22px',
            borderTop: `1px solid ${T.border}`,
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={handleRemove}
            style={{
              ...mono,
              fontSize: 11,
              padding: '9px 14px',
              background: `${T.red}12`,
              border: `1px solid ${T.red}33`,
              borderRadius: 8,
              color: T.red,
              cursor: 'pointer',
            }}
          >
            Clear saved
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || savedFlash || (showKey && !apiKey.trim()) || (showAzureExtra && (!azureEndpoint.trim() || !azureDeployment.trim()))}
            style={{
              ...mono,
              fontSize: 11,
              fontWeight: 700,
              padding: '9px 22px',
              background: savedFlash ? T.green : `linear-gradient(135deg,${intg.color},${intg.secondaryColor})`,
              border: 'none',
              borderRadius: 8,
              color: '#fff',
              cursor: saving ? 'wait' : 'pointer',
              flex: 1,
              boxShadow: savedFlash ? `0 0 20px ${T.green}44` : `0 0 20px ${intg.color}33`,
            }}
          >
            {savedFlash ? 'Saved' : saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
