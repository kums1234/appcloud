'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const T = {
  bg: '#04080f', surface: '#080f1a', surface2: '#0d1626', surface3: '#111d2e',
  border: '#0f1f35', border2: '#1e293b',
  text: '#f1f5f9', muted: '#334155', dim: '#64748b',
  green: '#22c55e', blue: '#38bdf8', amber: '#f59e0b', red: '#f43f5e', purple: '#a78bfa',
}
const ROLE_META = {
  admin:    { color: T.red,    label: 'Admin' },
  manager:  { color: T.amber,  label: 'Manager' },
  engineer: { color: T.blue,   label: 'Engineer' },
  viewer:   { color: T.muted,  label: 'Viewer' },
}
const mono = { fontFamily: 'monospace' }
const inputStyle = { width: '100%', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '9px 12px', color: T.text, fontSize: 12, fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }
const selectStyle = { ...inputStyle, cursor: 'pointer', appearance: 'none' }

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, gap: 10 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 24, height: 24, borderRadius: '50%', border: `2px solid ${T.border2}`, borderTop: `2px solid ${T.purple}`, animation: 'spin .8s linear infinite' }} />
    </div>
  )
}

function RoleBadge({ role }) {
  const m = ROLE_META[role] || { color: T.muted, label: role }
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{m.label}</span>
}

function Avatar({ name, color }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div style={{
      width: 42, height: 42, borderRadius: 12,
      background: color + '20', border: `1.5px solid ${color}44`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: `0 0 12px ${color}22`, flexShrink: 0,
    }}>
      <span style={{ ...mono, fontSize: 13, fontWeight: 800, color }}>{initials}</span>
    </div>
  )
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000bb', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${T.purple}33`, borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: `0 0 60px ${T.purple}11` }}>
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

function UserForm({ onSave, onClose }) {
  const [form, setForm] = useState({ name: '', role: 'engineer', email: '' })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <div>
      <Field label="FULL NAME">
        <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Alice Chen" />
      </Field>
      <Field label="EMAIL">
        <input style={inputStyle} type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="alice@company.com" />
      </Field>
      <Field label="ROLE">
        <select style={selectStyle} value={form.role} onChange={e => set('role', e.target.value)}>
          {Object.entries(ROLE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
        <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(form)} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: T.purple, border: 'none', borderRadius: 8, color: '#000', fontWeight: 700, cursor: 'pointer' }}>Create</button>
      </div>
    </div>
  )
}

function ActivityModal({ user, onClose }) {
  const [changes, setChanges] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.users.get(user.id).then(u => setChanges([])).finally(() => setLoading(false)) }, [user.id])
  const color = ROLE_META[user.role]?.color || T.muted
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000bb', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${color}33`, borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: `0 0 40px ${color}11` }}>
        <style>{`@keyframes mIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <div style={{ animation: 'mIn .2s ease' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
            <Avatar name={user.name} color={color} />
            <div>
              <div style={{ ...mono, fontSize: 14, fontWeight: 700, color: T.text }}>{user.name}</div>
              <div style={{ ...mono, fontSize: 10, color: T.dim, marginTop: 2 }}>{user.email}</div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 20, lineHeight: 1, marginLeft: 'auto' }}>×</button>
          </div>
          <div style={{ padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'SUBMITTED', key: 'submitted', color: T.blue },
                { label: 'APPROVED', key: 'approved', color: T.green },
                { label: 'REJECTED', key: 'rejected', color: T.red },
              ].map(({ label, key, color }) => (
                <div key={key} style={{ background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                  <div style={{ ...mono, fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>—</div>
                  <div style={{ ...mono, fontSize: 8, color: T.muted, marginTop: 4, letterSpacing: '0.1em' }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ ...mono, fontSize: 11, color: T.muted, textAlign: 'center' }}>
              Full activity history available via API
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function UsersPage() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [selected, setSelected] = useState(null)
  const [roleFilter, setRoleFilter] = useState('all')

  const load = () => api.users.list().then(setUsers).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const filtered = roleFilter === 'all' ? users : users.filter(u => u.role === roleFilter)
  const handleSave = async (form) => { await api.users.create(form); setModal(false); load() }

  const roleCounts = Object.keys(ROLE_META).reduce((acc, r) => ({ ...acc, [r]: users.filter(u => u.role === r).length }), {})

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 10% 20%, #0a1628 0%, ${T.bg} 60%)`, padding: '28px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: '0 0 6px' }}>Users</h1>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em' }}>{users.length} TEAM MEMBERS</p>
        </div>
        <button onClick={() => setModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', background: T.purple, border: 'none', borderRadius: 10, color: '#000', ...mono, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New User
        </button>
      </div>

      {/* Role summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
        {Object.entries(ROLE_META).map(([role, m]) => (
          <div key={role} onClick={() => setRoleFilter(roleFilter === role ? 'all' : role)} style={{
            background: T.surface, border: `1px solid ${roleFilter === role ? m.color + '55' : T.border}`,
            borderRadius: 12, padding: '14px 16px', cursor: 'pointer',
            boxShadow: roleFilter === role ? `0 0 20px ${m.color}18` : 'none',
            transition: 'all .2s', position: 'relative', overflow: 'hidden',
          }}>
            {roleFilter === role && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${m.color}77,transparent)` }} />}
            <div style={{ ...mono, fontSize: 28, fontWeight: 800, color: m.color, lineHeight: 1 }}>{roleCounts[role]}</div>
            <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 6, letterSpacing: '0.08em' }}>{m.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* User cards grid */}
      {loading ? <Spinner /> : filtered.length === 0 ? (
        <div style={{ ...mono, fontSize: 13, color: T.muted, textAlign: 'center', padding: '60px 0' }}>No users found</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {filtered.map(u => {
            const m = ROLE_META[u.role] || { color: T.muted }
            return (
              <div key={u.id}
                onClick={() => setSelected(u)}
                style={{
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderRadius: 14, padding: '16px 18px', cursor: 'pointer',
                  transition: 'all .2s', position: 'relative', overflow: 'hidden',
                }}
                onMouseEnter={e => { e.currentTarget.style.border = `1px solid ${m.color}44`; e.currentTarget.style.boxShadow = `0 0 20px ${m.color}11` }}
                onMouseLeave={e => { e.currentTarget.style.border = `1px solid ${T.border}`; e.currentTarget.style.boxShadow = 'none' }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${m.color}33,transparent)` }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                  <Avatar name={u.name} color={m.color} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text }}>{u.name}</div>
                    <div style={{ ...mono, fontSize: 10, color: T.dim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <RoleBadge role={u.role} />
                  <span style={{ ...mono, fontSize: 9, color: T.muted }}>{u.id.slice(0,8)}…</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="NEW USER">
        <UserForm onSave={handleSave} onClose={() => setModal(false)} />
      </Modal>

      {selected && <ActivityModal user={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}