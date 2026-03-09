'use client'

export const dynamic = 'force-dynamic'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useTheme, getT } from '@/lib/theme'

// Module-level fallback — satisfies sub-component defaults and constants.
// The default export re-derives T from useTheme() for live theme switching.
const T = getT('dark')



const TIER_COLORS = { 1: T.red, 2: T.amber, 3: T.green, 4: T.muted }
const TYPE_META = {
  API:    { color: T.blue,   icon: '⬡' },
  DB:     { color: T.amber,  icon: '◎' },
  Worker: { color: T.purple, icon: '◈' },
  UI:     { color: T.red,    icon: '⊕' },
}
const mono = { fontFamily: 'monospace' }
const inputStyle = { width: '100%', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '9px 12px', color: T.text, fontSize: 12, fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }
const selectStyle = { ...inputStyle, cursor: 'pointer', appearance: 'none' }

function Spinner({ color = T.green }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30, gap: 10 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 24, height: 24, borderRadius: '50%', border: `2px solid ${T.border2}`, borderTop: `2px solid ${color}`, animation: 'spin .8s linear infinite' }} />
    </div>
  )
}

function TierBadge({ tier }) {
  const c = TIER_COLORS[tier] || T.muted
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: c, background: c + '18', border: `1px solid ${c}33`, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em' }}>TIER {tier}</span>
}

function EnvBadge({ env }) {
  const c = env === 'production' ? T.blue : env === 'staging' ? T.amber : T.muted
  return <span style={{ ...mono, fontSize: 9, color: c, background: c + '15', border: `1px solid ${c}30`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>{env}</span>
}

function TypeBadge({ type }) {
  const m = TYPE_META[type] || { color: T.muted }
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>{type}</span>
}

const AVAIL_META = {
  '99.999': { label:'99.999%', color:'#22c55e' },
  '99.99':  { label:'99.99%',  color:'#38bdf8' },
  '99.9':   { label:'99.9%',   color:'#f59e0b' },
  '99':     { label:'99%',     color:'#f43f5e' },
}
const CONF_META = {
  public:       { label:'Public',        color:'#64748b' },
  internal:     { label:'Internal',      color:'#38bdf8' },
  confidential: { label:'Confidential',  color:'#f59e0b' },
  restricted:   { label:'Restricted',    color:'#f43f5e' },
}

function AvailBadge({ availability }) {
  const m = AVAIL_META[availability] || { label: availability || '—', color: T.muted }
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.04em' }}>⬆ {m.label}</span>
}

function ConfBadge({ confidentiality }) {
  const m = CONF_META[confidentiality] || { label: confidentiality || '—', color: T.muted }
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.04em' }}>⬡ {m.label}</span>
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em', fontWeight: 700, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  )
}

function Modal({ open, onClose, title, accent = T.green, children }) {
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000cc', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${accent}33`, borderRadius: 16, width: '100%', maxWidth: 500, boxShadow: `0 0 60px #00000099, 0 0 40px ${accent}11`, overflow: 'hidden' }}>
        <style>{`@keyframes mIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <div style={{ animation: 'mIn .2s ease' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${accent}66,transparent)` }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
            <span style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text }}>{title}</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ padding: 20 }}>{children}</div>
        </div>
      </div>
    </div>
  )
}

function AppForm({ onSave, onClose }) {
  const [form, setForm] = useState({ name: '', tier: 2, owner: '', environment: 'production', availability: '99.9', confidentiality: 'internal', domain: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <div>
      <Field label="APPLICATION NAME">
        <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Payment Service" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="TIER">
          <select style={selectStyle} value={form.tier} onChange={e => set('tier', parseInt(e.target.value))}>
            {[1,2,3,4].map(t => <option key={t} value={t}>Tier {t} — {['Critical','High','Medium','Low'][t-1]}</option>)}
          </select>
        </Field>
        <Field label="ENVIRONMENT">
          <select style={selectStyle} value={form.environment} onChange={e => set('environment', e.target.value)}>
            {['production','staging','development'].map(e => <option key={e}>{e}</option>)}
          </select>
        </Field>
      </div>
      <Field label="OWNER / TEAM">
        <input style={inputStyle} value={form.owner} onChange={e => set('owner', e.target.value)} placeholder="e.g. platform-team" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="AVAILABILITY SLA ✱">
          <select style={selectStyle} value={form.availability} onChange={e => set('availability', e.target.value)}>
            <option value="99.999">99.999% — Five nines</option>
            <option value="99.99">99.99% — Four nines</option>
            <option value="99.9">99.9% — Three nines</option>
            <option value="99">99% — Two nines</option>
          </select>
        </Field>
        <Field label="CONFIDENTIALITY ✱">
          <select style={selectStyle} value={form.confidentiality} onChange={e => set('confidentiality', e.target.value)}>
            <option value="public">Public</option>
            <option value="internal">Internal</option>
            <option value="confidential">Confidential</option>
            <option value="restricted">Restricted</option>
          </select>
        </Field>
      </div>
      <Field label="DOMAIN (optional)">
        <input style={inputStyle} value={form.domain} onChange={e => set('domain', e.target.value)} placeholder="e.g. payments, identity, data-platform" />
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
        <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(form)} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: T.green, border: 'none', borderRadius: 8, color: '#000', fontWeight: 700, cursor: 'pointer' }}>Create</button>
      </div>
    </div>
  )
}

function ComponentForm({ appId, onSave, onClose }) {
  const [form, setForm] = useState({ name: '', type: 'API', runtime: '', applicationId: appId })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <div>
      <Field label="COMPONENT NAME">
        <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. payments-api" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="TYPE">
          <select style={selectStyle} value={form.type} onChange={e => set('type', e.target.value)}>
            {Object.keys(TYPE_META).map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="RUNTIME">
          <input style={inputStyle} value={form.runtime} onChange={e => set('runtime', e.target.value)} placeholder="node18, python3.11…" />
        </Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
        <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(form)} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: T.blue, border: 'none', borderRadius: 8, color: '#000', fontWeight: 700, cursor: 'pointer' }}>Add Component</button>
      </div>
    </div>
  )
}

function ConnectForm({ sourceComp, allComponents, onSave, onClose }) {
  const [targetId, setTargetId] = useState('')
  const [protocol, setProtocol] = useState('HTTPS')
  const [port, setPort] = useState('')
  const targets = allComponents.filter(c => c.id !== sourceComp.id)

  // Group targets by application for better UX
  const grouped = targets.reduce((acc, c) => {
    const key = c.application || 'No Application'
    if (!acc[key]) acc[key] = []
    acc[key].push(c)
    return acc
  }, {})

  return (
    <div>
      {/* Source */}
      <div style={{ marginBottom: 16, padding: '10px 14px', background: T.surface2, borderRadius: 8, border: `1px solid ${T.purple}33` }}>
        <div style={{ ...mono, fontSize: 9, color: T.purple, letterSpacing: '0.08em', marginBottom: 6 }}>SOURCE COMPONENT</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: 2, background: TYPE_META[sourceComp.type]?.color || T.muted, boxShadow: `0 0 6px ${TYPE_META[sourceComp.type]?.color || T.muted}` }} />
          <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 600 }}>{sourceComp.name}</span>
          <TypeBadge type={sourceComp.type} />
          {sourceComp.application && <span style={{ ...mono, fontSize: 9, color: T.muted }}>· {sourceComp.application}</span>}
        </div>
      </div>

      <Field label="TARGET COMPONENT">
        <select style={selectStyle} value={targetId} onChange={e => setTargetId(e.target.value)}>
          <option value="">— select target —</option>
          {Object.entries(grouped).map(([appName, comps]) => (
            <optgroup key={appName} label={appName}>
              {comps.map(c => (
                <option key={c.id} value={c.id}>{c.name} [{c.type}]</option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="PROTOCOL">
          <select style={selectStyle} value={protocol} onChange={e => setProtocol(e.target.value)}>
            {['HTTPS','HTTP','gRPC','TCP','AMQP','JDBC','Redis','WebSocket'].map(p => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="PORT (OPTIONAL)">
          <input style={inputStyle} value={port} onChange={e => setPort(e.target.value)} placeholder="5432" />
        </Field>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
        <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
        <button
          disabled={!targetId}
          onClick={() => onSave({ targetId, protocol, port: port ? parseInt(port) : undefined })}
          style={{ ...mono, fontSize: 11, padding: '8px 18px', background: targetId ? T.purple : T.border2, border: 'none', borderRadius: 8, color: targetId ? '#000' : T.muted, fontWeight: 700, cursor: targetId ? 'pointer' : 'not-allowed' }}
        >Create Connection</button>
      </div>
    </div>
  )
}

function DeployForm({ component, allInfra, onSave, onClose }) {
  const [infraId, setInfraId] = useState('')
  const PROVIDER_COLORS = { aws: T.amber, azure: T.blue, gcp: T.green, onprem: T.muted }

  // Group infra by provider
  const grouped = allInfra.reduce((acc, i) => {
    const k = i.provider || 'other'
    if (!acc[k]) acc[k] = []
    acc[k].push(i)
    return acc
  }, {})

  return (
    <div>
      <div style={{ marginBottom: 16, padding: '10px 14px', background: T.surface2, borderRadius: 8, border: `1px solid ${T.amber}33` }}>
        <div style={{ ...mono, fontSize: 9, color: T.amber, letterSpacing: '0.08em', marginBottom: 4 }}>DEPLOYING COMPONENT</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: 2, background: TYPE_META[component.type]?.color || T.muted }} />
          <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 600 }}>{component.name}</span>
          <TypeBadge type={component.type} />
        </div>
      </div>

      <Field label="TARGET INFRASTRUCTURE">
        <select style={selectStyle} value={infraId} onChange={e => setInfraId(e.target.value)}>
          <option value="">— select infra resource —</option>
          {Object.entries(grouped).map(([provider, items]) => (
            <optgroup key={provider} label={`${provider.toUpperCase()} (${items.length})`}>
              {items.map(i => (
                <option key={i.id} value={i.id}>
                  {i.name} · {i.resource_type} · {i.region}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>

      {infraId && (() => {
        const selected = allInfra.find(i => i.id === infraId)
        if (!selected) return null
        const pc = PROVIDER_COLORS[selected.provider] || T.muted
        return (
          <div style={{ marginBottom: 14, padding: '10px 14px', background: pc + '0d', border: `1px solid ${pc}33`, borderRadius: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[['Provider', selected.provider?.toUpperCase()], ['Region', selected.region], ['Type', selected.resource_type], ['Access', selected.public ? '🌐 Public' : '🔒 Private']].map(([k, v]) => (
                <div key={k}>
                  <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.08em' }}>{k}</div>
                  <div style={{ ...mono, fontSize: 11, color: T.text, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
        <button disabled={!infraId} onClick={() => onSave(infraId)} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: infraId ? T.amber : T.border2, border: 'none', borderRadius: 8, color: infraId ? '#000' : T.muted, fontWeight: 700, cursor: infraId ? 'pointer' : 'not-allowed' }}>
          ⬡ Deploy
        </button>
      </div>
    </div>
  )
}


function AppPanel({ app, onClose, allComponents, allInfra, onRefresh }) {
  const [topology, setTopology] = useState(null)
  const [loading, setLoading] = useState(true)
  const [addComp, setAddComp] = useState(false)
  const [connectComp, setConnectComp] = useState(null)
  const [deployComp, setDeployComp] = useState(null)  // component to deploy
  const [toast, setToast] = useState(null)
  const accentColor = TIER_COLORS[app.tier] || T.green

  const showToast = (msg, color = T.green) => {
    setToast({ msg, color })
    setTimeout(() => setToast(null), 2500)
  }

  const loadTopology = () => {
    setLoading(true)
    api.applications.topology(app.id).then(setTopology).finally(() => setLoading(false))
  }

  useEffect(() => { loadTopology() }, [app.id])

  const handleAddComponent = async (form) => {
    await api.components.create(form)
    setAddComp(false); loadTopology(); onRefresh()
    showToast('Component added', T.blue)
  }

  const handleDeleteComponent = async (compId, e) => {
    e.stopPropagation()
    if (!confirm('Remove this component?')) return
    await api.components.delete(compId)
    loadTopology(); onRefresh()
    showToast('Component removed', T.red)
  }

  const handleConnect = async ({ targetId, protocol, port }) => {
    await api.components.connect(connectComp.id, { targetId, protocol, port })
    setConnectComp(null); loadTopology()
    showToast(`Connected via ${protocol}`, T.purple)
  }

  const handleDeploy = async (infraId) => {
    await api.components.deploy(deployComp.id, infraId)
    setDeployComp(null); loadTopology()
    showToast('Deployed to infrastructure', T.amber)
  }

  const components = topology?.components || []
  const infraLinks = topology?.infra || []

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000cc', backdropFilter: 'blur(4px)' }} onClick={onClose} />

      {toast && (
        <div style={{ position: 'fixed', top: 24, right: 24, zIndex: 100, padding: '10px 18px', background: T.surface, border: `1px solid ${toast.color}55`, borderRadius: 10, ...mono, fontSize: 12, color: toast.color, boxShadow: `0 0 20px ${toast.color}22`, pointerEvents: 'none' }}>
          ✓ {toast.msg}
        </div>
      )}

      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${accentColor}33`, borderRadius: 18, width: '100%', maxWidth: 860, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: `0 0 80px ${accentColor}11, 0 40px 80px #00000099`, overflow: 'hidden' }}>
        <style>{`@keyframes mIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <div style={{ animation: 'mIn .2s ease', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${accentColor}77,transparent)` }} />

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: accentColor, boxShadow: `0 0 10px ${accentColor}` }} />
                <span style={{ ...mono, fontSize: 16, fontWeight: 800, color: T.text }}>{app.name}</span>
                <TierBadge tier={app.tier} />
                <EnvBadge env={app.environment} />
                <AvailBadge availability={app.availability} />
                <ConfBadge confidentiality={app.confidentiality} />
              </div>
              <div style={{ ...mono, fontSize: 10, color: T.muted, paddingLeft: 18 }}>
                {app.owner}{app.domain ? ` · ${app.domain}` : ''} · {app.id.slice(0,8)}…
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
          </div>

          {/* Body — 3 columns */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
            {loading ? <Spinner /> : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 18 }}>

                {/* ── Col 1: Components ─────────── */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em' }}>COMPONENTS ({components.length})</span>
                    <button onClick={() => setAddComp(true)} style={{ ...mono, fontSize: 9, padding: '4px 10px', background: T.blue + '18', border: `1px solid ${T.blue}33`, borderRadius: 6, color: T.blue, cursor: 'pointer', fontWeight: 700 }}>+ ADD</button>
                  </div>

                  {components.length === 0 ? (
                    <div style={{ ...mono, fontSize: 11, color: T.muted, padding: '24px 0', textAlign: 'center', border: `1px dashed ${T.border2}`, borderRadius: 10 }}>No components yet</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {components.map(c => {
                        const cm = TYPE_META[c.type] || { color: T.muted }
                        return (
                          <div key={c.id} style={{ background: T.surface2, border: `1px solid ${cm.color}22`, borderRadius: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px' }}>
                              <div style={{ width: 7, height: 7, borderRadius: 2, background: cm.color, boxShadow: `0 0 7px ${cm.color}`, flexShrink: 0 }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.text }}>{c.name}</div>
                                <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 1 }}>{c.runtime || '—'}</div>
                              </div>
                              <TypeBadge type={c.type} />
                            </div>
                            {/* Action row */}
                            <div style={{ display: 'flex', gap: 4, padding: '0 12px 9px', justifyContent: 'flex-end' }}>
                              <button onClick={() => setConnectComp(c)} style={{ ...mono, fontSize: 9, padding: '3px 8px', background: T.purple + '18', border: `1px solid ${T.purple}33`, borderRadius: 5, color: T.purple, cursor: 'pointer', fontWeight: 700 }}>⟶ Link</button>
                              <button onClick={() => setDeployComp(c)} style={{ ...mono, fontSize: 9, padding: '3px 8px', background: T.amber + '18', border: `1px solid ${T.amber}33`, borderRadius: 5, color: T.amber, cursor: 'pointer', fontWeight: 700 }}>⬡ Deploy</button>
                              <button onClick={(e) => handleDeleteComponent(c.id, e)} style={{ ...mono, fontSize: 9, padding: '3px 8px', background: T.red + '12', border: `1px solid ${T.red}25`, borderRadius: 5, color: T.red, cursor: 'pointer' }}>✕</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div style={{ marginTop: 12, padding: '9px 12px', background: T.surface3, borderRadius: 8, border: `1px solid ${T.border}`, ...mono, fontSize: 10, color: T.dim, lineHeight: 1.6 }}>
                    <span style={{ color: T.purple }}>⟶ Link</span> connects components · <span style={{ color: T.amber }}>⬡ Deploy</span> maps to infra
                  </div>
                </div>

                {/* ── Col 2: Connections ─────────── */}
                <div>
                  <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em', marginBottom: 12 }}>
                    CONNECTIONS ({topology?.connections?.length ?? 0})
                  </div>
                  {!topology?.connections?.length ? (
                    <div style={{ ...mono, fontSize: 11, color: T.muted, padding: '24px 0', textAlign: 'center', border: `1px dashed ${T.border2}`, borderRadius: 10 }}>No connections yet</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {topology.connections.map((conn, i) => {
                        const crossApp = conn.fromApp !== conn.toApp && conn.toApp
                        return (
                          <div key={i} style={{ padding: '9px 11px', background: T.surface2, borderRadius: 9, border: `1px solid ${crossApp ? T.purple + '33' : T.blue + '22'}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ ...mono, fontSize: 10, color: T.text, fontWeight: 600 }}>{conn.from}</span>
                              <span style={{ ...mono, fontSize: 9, color: crossApp ? T.purple : T.blue }}>——{conn.protocol}——▶</span>
                              <span style={{ ...mono, fontSize: 10, color: T.text, fontWeight: 600 }}>{conn.to}</span>
                            </div>
                            {crossApp && (
                              <div style={{ ...mono, fontSize: 9, color: T.purple, marginTop: 3, opacity: 0.7 }}>cross-app · {conn.toApp}</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* ── Col 3: Infrastructure ──────── */}
                <div>
                  <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em', marginBottom: 12 }}>
                    INFRASTRUCTURE ({infraLinks.length})
                  </div>
                  {infraLinks.length === 0 ? (
                    <div style={{ ...mono, fontSize: 11, color: T.muted, padding: '24px 0', textAlign: 'center', border: `1px dashed ${T.border2}`, borderRadius: 10 }}>
                      No infra linked · use <span style={{ color: T.amber }}>⬡ Deploy</span> on a component
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {infraLinks.map(i => {
                        const PROVIDER_COLORS = { aws: T.amber, azure: T.blue, gcp: T.green, onprem: T.muted }
                        const pc = PROVIDER_COLORS[i.provider] || T.muted
                        return (
                          <div key={i.id} style={{ display: 'flex', gap: 10, padding: '10px 12px', background: T.surface2, borderRadius: 10, border: `1px solid ${pc}22` }}>
                            <div style={{ width: 7, height: 7, borderRadius: 2, background: pc, marginTop: 3, flexShrink: 0, boxShadow: `0 0 5px ${pc}` }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 600 }}>{i.name}</div>
                              <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 2 }}>{i.provider?.toUpperCase()} · {i.region}</div>
                              <div style={{ ...mono, fontSize: 9, color: T.muted }}>{i.resource_type}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>
        </div>
      </div>

      <Modal open={addComp} onClose={() => setAddComp(false)} title="ADD COMPONENT" accent={T.blue}>
        <ComponentForm appId={app.id} onSave={handleAddComponent} onClose={() => setAddComp(false)} />
      </Modal>

      <Modal open={!!connectComp} onClose={() => setConnectComp(null)} title="CONNECT COMPONENT" accent={T.purple}>
        {connectComp && (
          <ConnectForm sourceComp={connectComp} allComponents={allComponents} onSave={handleConnect} onClose={() => setConnectComp(null)} />
        )}
      </Modal>

      <Modal open={!!deployComp} onClose={() => setDeployComp(null)} title="DEPLOY TO INFRASTRUCTURE" accent={T.amber}>
        {deployComp && (
          <DeployForm component={deployComp} allInfra={allInfra} onSave={handleDeploy} onClose={() => setDeployComp(null)} />
        )}
      </Modal>
    </div>
  )
}

export default function ApplicationsPage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const [apps, setApps] = useState([])
  const [allComponents, setAllComponents] = useState([])
  const [allInfra, setAllInfra] = useState([])
  const [loading, setLoading] = useState(true)
  const [newAppModal, setNewAppModal] = useState(false)
  const [selectedApp, setSelectedApp] = useState(null)

  const load = async () => {
    const [a, c, i] = await Promise.all([api.applications.list(), api.components.list(), api.infra.list()])
    setApps(a); setAllComponents(c); setAllInfra(i); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const handleCreateApp = async (form) => { await api.applications.create(form); setNewAppModal(false); load() }
  const handleDeleteApp = async (id, e) => {
    e.stopPropagation()
    if (!confirm('Delete this application and all its relationships?')) return
    await api.applications.delete(id); load()
  }

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 10% 20%, #0a1628 0%, ${T.bg} 60%)`, padding: '28px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: '0 0 6px' }}>Applications</h1>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em' }}>{apps.length} SERVICES · {allComponents.length} COMPONENTS</p>
        </div>
        <button onClick={() => setNewAppModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', background: T.green, border: 'none', borderRadius: 10, color: '#000', ...mono, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New Application
        </button>
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {['Application', 'Tier', 'Availability', 'Confidentiality', 'Owner', 'Environment', ''].map(h => (
                <th key={h} style={{ ...mono, fontSize: 9, color: T.muted, textAlign: 'left', padding: '12px 16px', letterSpacing: '0.1em', fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><Spinner /></td></tr>
            ) : apps.length === 0 ? (
              <tr><td colSpan={7} style={{ ...mono, fontSize: 12, color: T.muted, textAlign: 'center', padding: 48 }}>No applications yet</td></tr>
            ) : apps.map(a => {
              const tierColor = TIER_COLORS[a.tier] || T.muted
              const appComps = allComponents.filter(c => c.applicationId === a.id || c.application === a.name)
              return (
                <tr key={a.id} onClick={() => setSelectedApp(a)} style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer', transition: 'background .15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surface2}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '13px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: tierColor, boxShadow: `0 0 8px ${tierColor}`, flexShrink: 0 }} />
                      <span style={{ ...mono, fontSize: 13, fontWeight: 600, color: T.text }}>{a.name}</span>
                    </div>
                    <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 3, paddingLeft: 17 }}>{a.id.slice(0,8)}…</div>
                  </td>
                  <td style={{ padding: '13px 16px' }}><TierBadge tier={a.tier} /></td>
                  <td style={{ padding: '13px 16px' }}><AvailBadge availability={a.availability} /></td>
                  <td style={{ padding: '13px 16px' }}><ConfBadge confidentiality={a.confidentiality} /></td>
                  <td style={{ padding: '13px 16px', ...mono, fontSize: 11, color: T.dim }}>{a.owner}</td>
                  <td style={{ padding: '13px 16px' }}><EnvBadge env={a.environment} /></td>
                  <td style={{ padding: '13px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text }}>{a.componentCount ?? 0}</span>
                      <div style={{ display: 'flex', gap: 3 }}>
                        {Object.entries(TYPE_META).map(([type, m]) => {
                          const count = appComps.filter(c => c.type === type).length
                          if (!count) return null
                          return <span key={type} style={{ ...mono, fontSize: 9, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '1px 5px', borderRadius: 3 }}>{count} {type}</span>
                        })}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '13px 16px' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ ...mono, fontSize: 10, color: T.blue }}>Open →</span>
                      <button onClick={(e) => handleDeleteApp(a.id, e)} style={{ ...mono, fontSize: 10, padding: '4px 10px', background: T.red + '12', border: `1px solid ${T.red}30`, borderRadius: 6, color: T.red, cursor: 'pointer' }}>Delete</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {apps.length > 0 && (
        <p style={{ ...mono, fontSize: 10, color: T.muted, marginTop: 14, textAlign: 'center' }}>Click any row to manage components and connections</p>
      )}

      <Modal open={newAppModal} onClose={() => setNewAppModal(false)} title="NEW APPLICATION" accent={T.green}>
        <AppForm onSave={handleCreateApp} onClose={() => setNewAppModal(false)} />
      </Modal>

      {selectedApp && (
        <AppPanel app={selectedApp} onClose={() => setSelectedApp(null)} allComponents={allComponents} allInfra={allInfra} onRefresh={load} />
      )}
    </div>
  )
}
