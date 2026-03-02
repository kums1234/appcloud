'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const T = {
  bg: '#04080f', surface: '#080f1a', surface2: '#0d1626', surface3: '#111d2e',
  border: '#0f1f35', border2: '#1e293b',
  text: '#f1f5f9', muted: '#334155', dim: '#64748b',
  green: '#22c55e', blue: '#38bdf8', amber: '#f59e0b', red: '#f43f5e', purple: '#a78bfa',
}
const PROVIDER_META = {
  aws:    { color: T.amber,  label: 'AWS',    icon: '⬡' },
  azure:  { color: T.blue,   label: 'Azure',  icon: '◈' },
  gcp:    { color: T.green,  label: 'GCP',    icon: '◎' },
  onprem: { color: T.muted,  label: 'On-Prem',icon: '⊞' },
}
const RESOURCE_TYPES = ['ec2_instance','rds_instance','elasticache','sqs_queue','vpc','s3_bucket','vm','function','other']
const mono = { fontFamily: 'monospace' }
const inputStyle = { width: '100%', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '9px 12px', color: T.text, fontSize: 12, fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }
const selectStyle = { ...inputStyle, cursor: 'pointer', appearance: 'none' }

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, gap: 12 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: `2px solid ${T.border2}`, borderTop: `2px solid ${T.amber}`, animation: 'spin .8s linear infinite' }} />
    </div>
  )
}

function ProviderBadge({ provider }) {
  const m = PROVIDER_META[provider] || { color: T.muted, label: provider }
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em' }}>{m.label}</span>
}

function AccessBadge({ pub }) {
  const c = pub ? T.red : T.green
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...mono, fontSize: 9, fontWeight: 600, color: c, background: c + '15', border: `1px solid ${c}30`, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c, boxShadow: `0 0 5px ${c}`, display: 'inline-block' }} />
      {pub ? 'PUBLIC' : 'PRIVATE'}
    </span>
  )
}

function Modal({ open, onClose, title, accent, children }) {
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000bb', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${accent ? accent + '44' : T.border2}`, borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: `0 0 60px #00000088${accent ? `, 0 0 40px ${accent}11` : ''}` }}>
        <style>{`@keyframes mIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <div style={{ animation: 'mIn .2s ease' }}>
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

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em', fontWeight: 700, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  )
}

function InfraForm({ onSave, onClose }) {
  const [form, setForm] = useState({ provider: 'aws', resource_type: 'ec2_instance', name: '', region: '', public: false })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <div>
      <Field label="RESOURCE NAME">
        <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. payments-api-server" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="PROVIDER">
          <select style={selectStyle} value={form.provider} onChange={e => set('provider', e.target.value)}>
            {Object.entries(PROVIDER_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="RESOURCE TYPE">
          <select style={selectStyle} value={form.resource_type} onChange={e => set('resource_type', e.target.value)}>
            {RESOURCE_TYPES.map(r => <option key={r}>{r}</option>)}
          </select>
        </Field>
      </div>
      <Field label="REGION">
        <input style={inputStyle} value={form.region} onChange={e => set('region', e.target.value)} placeholder="us-east-1, eastus…" />
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, padding: '10px 12px', background: T.surface2, borderRadius: 8, border: `1px solid ${T.border}`, cursor: 'pointer' }} onClick={() => set('public', !form.public)}>
        <div style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${form.public ? T.red : T.border2}`, background: form.public ? T.red + '30' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s' }}>
          {form.public && <span style={{ color: T.red, fontSize: 10, lineHeight: 1 }}>✓</span>}
        </div>
        <span style={{ ...mono, fontSize: 11, color: form.public ? T.red : T.dim }}>Internet-exposed (public)</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(form)} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: T.amber, border: 'none', borderRadius: 8, color: '#000', fontWeight: 700, cursor: 'pointer' }}>Create</button>
      </div>
    </div>
  )
}

export default function InfraPage() {
  const [infra, setInfra] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [filter, setFilter] = useState('all')

  const load = () => api.infra.list().then(setInfra).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const filtered = filter === 'all' ? infra
    : filter === 'public' ? infra.filter(i => i.public)
    : infra.filter(i => i.provider === filter)

  const handleSave = async (form) => { await api.infra.create(form); setModal(false); load() }
  const handleDelete = async (id) => { if (!confirm('Delete this resource?')) return; await api.infra.delete(id); load() }

  const providerCounts = Object.keys(PROVIDER_META).reduce((acc, p) => ({ ...acc, [p]: infra.filter(i => i.provider === p).length }), {})
  const publicCount = infra.filter(i => i.public).length

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 10% 20%, #0a1628 0%, ${T.bg} 60%)`, padding: '28px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: '0 0 6px' }}>Infrastructure</h1>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em' }}>{infra.length} RESOURCES · {publicCount} PUBLIC</p>
        </div>
        <button onClick={() => setModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', background: T.amber, border: 'none', borderRadius: 10, color: '#000', ...mono, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New Resource
        </button>
      </div>

      {/* Provider summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
        {Object.entries(PROVIDER_META).map(([key, m]) => (
          <div key={key} onClick={() => setFilter(filter === key ? 'all' : key)} style={{
            background: T.surface, border: `1px solid ${filter === key ? m.color + '55' : T.border}`,
            borderRadius: 12, padding: '14px 16px', cursor: 'pointer',
            boxShadow: filter === key ? `0 0 20px ${m.color}18` : 'none',
            transition: 'all .2s', position: 'relative', overflow: 'hidden',
          }}>
            {filter === key && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${m.color}77,transparent)` }} />}
            <div style={{ fontSize: 20, marginBottom: 8, opacity: 0.5 }}>{m.icon}</div>
            <div style={{ ...mono, fontSize: 26, fontWeight: 800, color: m.color, lineHeight: 1 }}>{providerCounts[key]}</div>
            <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 4, letterSpacing: '0.08em' }}>{m.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[['all', 'All', T.green], ['public', '🌐 Public Only', T.red]].map(([key, label, color]) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            ...mono, fontSize: 10, fontWeight: 600, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
            background: filter === key ? color + '20' : T.surface,
            border: `1px solid ${filter === key ? color : T.border2}`,
            color: filter === key ? color : T.muted, transition: 'all .15s',
          }}>{label}</button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {['Resource', 'Provider', 'Type', 'Region', 'Access', ''].map(h => (
                <th key={h} style={{ ...mono, fontSize: 9, color: T.muted, textAlign: 'left', padding: '12px 16px', letterSpacing: '0.1em', fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><Spinner /></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} style={{ ...mono, fontSize: 12, color: T.muted, textAlign: 'center', padding: 40 }}>No resources found</td></tr>
            ) : filtered.map(i => {
              const m = PROVIDER_META[i.provider] || { color: T.muted }
              return (
                <tr key={i.id} style={{ borderBottom: `1px solid ${T.border}`, transition: 'background .15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surface2}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '13px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 6, height: 6, borderRadius: 2, background: m.color, boxShadow: `0 0 8px ${m.color}`, flexShrink: 0 }} />
                      <span style={{ ...mono, fontSize: 13, fontWeight: 600, color: T.text }}>{i.name}</span>
                    </div>
                    <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 3, paddingLeft: 16 }}>{i.id.slice(0,8)}…</div>
                  </td>
                  <td style={{ padding: '13px 16px' }}><ProviderBadge provider={i.provider} /></td>
                  <td style={{ padding: '13px 16px', ...mono, fontSize: 11, color: T.dim }}>{i.resource_type}</td>
                  <td style={{ padding: '13px 16px', ...mono, fontSize: 11, color: T.dim }}>{i.region}</td>
                  <td style={{ padding: '13px 16px' }}><AccessBadge pub={i.public} /></td>
                  <td style={{ padding: '13px 16px' }}>
                    <button onClick={() => handleDelete(i.id)} style={{ ...mono, fontSize: 10, padding: '5px 12px', background: T.red + '12', border: `1px solid ${T.red}30`, borderRadius: 6, color: T.red, cursor: 'pointer' }}>Delete</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title="NEW INFRA RESOURCE" accent={T.amber}>
        <InfraForm onSave={handleSave} onClose={() => setModal(false)} />
      </Modal>
    </div>
  )
}