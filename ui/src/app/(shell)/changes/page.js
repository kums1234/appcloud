'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const T = {
  bg: '#04080f', surface: '#080f1a', surface2: '#0d1626', surface3: '#111d2e',
  border: '#0f1f35', border2: '#1e293b',
  text: '#f1f5f9', muted: '#334155', dim: '#64748b',
  green: '#22c55e', blue: '#38bdf8', amber: '#f59e0b', red: '#f43f5e', purple: '#a78bfa',
}
const STATUS_META = {
  approved: { color: T.green, label: 'Approved' },
  draft:    { color: T.amber, label: 'Draft' },
  rejected: { color: T.red,   label: 'Rejected' },
}
const mono = { fontFamily: 'monospace' }

function Spinner({ color = T.amber }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30, gap: 10 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${T.border2}`, borderTop: `2px solid ${color}`, animation: 'spin .8s linear infinite' }} />
    </div>
  )
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { color: T.muted, label: status }
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: m.color, background: m.color + '18', border: `1px solid ${m.color}33`, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{m.label}</span>
}

function RiskBar({ score }) {
  const pct = (score / 10) * 100
  const color = score >= 8 ? T.red : score >= 6 ? T.amber : T.green
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 3, background: T.border2, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, boxShadow: `0 0 6px ${color}`, borderRadius: 2, transition: 'width .4s ease' }} />
      </div>
      <span style={{ ...mono, fontSize: 10, color, fontWeight: 700, width: 28, textAlign: 'right' }}>{score.toFixed(1)}</span>
    </div>
  )
}

function BlastRadiusPanel({ changeId, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.changes.blastRadius(changeId).then(setData).catch(() => {}).finally(() => setLoading(false)) }, [changeId])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000bb', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${T.red}33`, borderRadius: 16, width: '100%', maxWidth: 600, boxShadow: `0 0 60px ${T.red}11` }}>
        <style>{`@keyframes mIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
        <div style={{ animation: 'mIn .2s ease' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14 }}>⚡</span>
              <span style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text }}>Blast Radius Analysis</span>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ padding: 20 }}>
            {loading ? <Spinner color={T.red} /> : !data ? <p style={{ ...mono, fontSize: 12, color: T.muted }}>No data</p> : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                {[
                  { label: 'DIRECTLY MODIFIED', items: data.directlyModified, color: T.red, fmt: i => `${i.name} (${i.label})` },
                  { label: 'APPS AFFECTED', items: data.directlyAffected.map(a => ({ name: a })), color: T.amber, fmt: i => i.name },
                  { label: 'INDIRECTLY IMPACTED', items: data.indirectlyAffected.map(a => ({ name: a })), color: T.muted, fmt: i => i.name },
                ].map(({ label, items, color, fmt }) => (
                  <div key={label}>
                    <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em', marginBottom: 10 }}>{label} ({items.length})</div>
                    {items.length === 0
                      ? <div style={{ ...mono, fontSize: 10, color: T.muted }}>None</div>
                      : items.map((item, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, padding: '7px 10px', background: T.surface2, borderRadius: 7, border: `1px solid ${T.border}` }}>
                          <div style={{ width: 5, height: 5, borderRadius: '50%', background: color, boxShadow: `0 0 5px ${color}`, flexShrink: 0 }} />
                          <span style={{ ...mono, fontSize: 10, color: T.text }}>{fmt(item)}</span>
                        </div>
                      ))
                    }
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ConfirmModal({ open, onClose, title, message, onConfirm, confirmLabel, confirmColor, children }) {
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#000000bb', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: T.surface, border: `1px solid ${confirmColor || T.border2}44`, borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: '0 0 60px #00000088' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text }}>{title}</span>
        </div>
        <div style={{ padding: 20 }}>
          {message && <p style={{ ...mono, fontSize: 12, color: T.dim, marginBottom: 16 }}>{message}</p>}
          {children}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button onClick={onClose} style={{ ...mono, fontSize: 11, padding: '8px 16px', background: 'none', border: `1px solid ${T.border2}`, borderRadius: 8, color: T.muted, cursor: 'pointer' }}>Cancel</button>
            <button onClick={onConfirm} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: confirmColor || T.green, border: 'none', borderRadius: 8, color: '#000', fontWeight: 700, cursor: 'pointer' }}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ChangesPage() {
  const [changes, setChanges] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [blastId, setBlastId] = useState(null)
  const [approveModal, setApproveModal] = useState(null)
  const [rejectModal, setRejectModal] = useState(null)
  const [rejectReason, setRejectReason] = useState('')

  const load = () => Promise.all([
    api.changes.list(filter === 'all' ? undefined : filter),
    api.users.list(),
  ]).then(([c, u]) => { setChanges(c); setUsers(u) }).finally(() => setLoading(false))

  useEffect(() => { setLoading(true); load() }, [filter])

  const handleApprove = async () => {
    if (!users.length) return
    await api.changes.approve(approveModal, users[0].id)
    setApproveModal(null); load()
  }

  const handleReject = async () => {
    if (!rejectReason.trim() || !users.length) return
    await api.changes.reject(rejectModal, users[0].id, rejectReason)
    setRejectModal(null); setRejectReason(''); load()
  }

  const statusCounts = ['draft','approved','rejected'].reduce((acc, s) => ({
    ...acc, [s]: changes.filter(c => c.status === s).length
  }), {})

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 10% 20%, #0a1628 0%, ${T.bg} 60%)`, padding: '28px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: '0 0 6px' }}>Changes</h1>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em' }}>CHANGE MANAGEMENT & APPROVALS</p>
        </div>
        {/* Status summary */}
        <div style={{ display: 'flex', gap: 1 }}>
          {Object.entries(STATUS_META).map(([s, m], i, arr) => (
            <div key={s} style={{
              padding: '8px 16px', background: T.surface, border: `1px solid ${T.border}`,
              borderLeft: i > 0 ? 'none' : `1px solid ${T.border}`,
              borderRadius: i === 0 ? '10px 0 0 10px' : i === arr.length - 1 ? '0 10px 10px 0' : 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            }}>
              <span style={{ ...mono, fontSize: 18, fontWeight: 800, color: m.color }}>{statusCounts[s] ?? 0}</span>
              <span style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.1em' }}>{s.toUpperCase()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {['all', 'draft', 'approved', 'rejected'].map(f => {
          const m = STATUS_META[f] || { color: T.green }
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              ...mono, fontSize: 10, fontWeight: 600, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em',
              background: filter === f ? m.color + '20' : T.surface,
              border: `1px solid ${filter === f ? m.color : T.border2}`,
              color: filter === f ? m.color : T.muted, transition: 'all .15s',
            }}>{f}</button>
          )
        })}
      </div>

      {/* Table */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {['Change', 'Status', 'Risk Score', 'Submitted By', 'Date', 'Actions'].map(h => (
                <th key={h} style={{ ...mono, fontSize: 9, color: T.muted, textAlign: 'left', padding: '12px 16px', letterSpacing: '0.1em', fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><Spinner /></td></tr>
            ) : changes.length === 0 ? (
              <tr><td colSpan={6} style={{ ...mono, fontSize: 12, color: T.muted, textAlign: 'center', padding: 40 }}>No changes found</td></tr>
            ) : changes.map(c => (
              <tr key={c.id} style={{ borderBottom: `1px solid ${T.border}`, transition: 'background .15s' }}
                onMouseEnter={e => e.currentTarget.style.background = T.surface2}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <td style={{ padding: '13px 16px', maxWidth: 240 }}>
                  <div style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.description}</div>
                  <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 2 }}>{c.id.slice(0,8)}…</div>
                </td>
                <td style={{ padding: '13px 16px' }}><StatusBadge status={c.status} /></td>
                <td style={{ padding: '13px 16px', width: 130 }}><RiskBar score={c.riskScore} /></td>
                <td style={{ padding: '13px 16px', ...mono, fontSize: 11, color: T.dim }}>{c.submittedBy || '—'}</td>
                <td style={{ padding: '13px 16px', ...mono, fontSize: 10, color: T.muted }}>{new Date(c.createdAt).toLocaleDateString('en-GB')}</td>
                <td style={{ padding: '13px 16px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setBlastId(c.id)} style={{ ...mono, fontSize: 10, padding: '5px 10px', background: T.purple + '15', border: `1px solid ${T.purple}30`, borderRadius: 6, color: T.purple, cursor: 'pointer' }}>Blast</button>
                    {c.status === 'draft' && (
                      <>
                        <button onClick={() => setApproveModal(c.id)} style={{ ...mono, fontSize: 10, padding: '5px 10px', background: T.green + '15', border: `1px solid ${T.green}30`, borderRadius: 6, color: T.green, cursor: 'pointer' }}>✓ Approve</button>
                        <button onClick={() => setRejectModal(c.id)} style={{ ...mono, fontSize: 10, padding: '5px 10px', background: T.red + '12', border: `1px solid ${T.red}30`, borderRadius: 6, color: T.red, cursor: 'pointer' }}>✗ Reject</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {blastId && <BlastRadiusPanel changeId={blastId} onClose={() => setBlastId(null)} />}

      <ConfirmModal open={!!approveModal} onClose={() => setApproveModal(null)} title="APPROVE CHANGE" message="Are you sure you want to approve this change?" onConfirm={handleApprove} confirmLabel="Approve" confirmColor={T.green} />

      <ConfirmModal open={!!rejectModal} onClose={() => { setRejectModal(null); setRejectReason('') }} title="REJECT CHANGE" onConfirm={handleReject} confirmLabel="Reject" confirmColor={T.red}>
        <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.1em', marginBottom: 6 }}>REJECTION REASON</div>
        <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3} placeholder="Explain why this change is being rejected…" style={{ width: '100%', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '9px 12px', color: T.text, fontSize: 12, fontFamily: 'monospace', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
      </ConfirmModal>
    </div>
  )
}