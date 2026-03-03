'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

const T = {
  bg: '#04080f', surface: '#080f1a', surface2: '#0d1626',
  border: '#0f1f35', border2: '#1e293b',
  text: '#f1f5f9', dim: '#94a3b8', muted: '#334155',
  green: '#22c55e', blue: '#38bdf8', amber: '#f59e0b',
  red: '#f43f5e', purple: '#a78bfa', teal: '#2dd4bf',
}
const TIER_COLORS   = { 1: T.red, 2: T.amber, 3: T.green, 4: T.muted }
const TYPE_COLORS   = { API: T.blue, DB: T.amber, Worker: T.purple, UI: T.red }
const PROVIDER_COLORS = { aws: T.amber, azure: T.blue, gcp: T.green, onprem: T.muted }
const STATUS_COLORS = { approved: T.green, draft: T.amber, rejected: T.red }
const mono = { fontFamily: 'monospace' }

const ttStyle = {
  contentStyle: { background: '#0d1626', border: `1px solid ${T.border2}`, borderRadius: 8, fontFamily: 'monospace', fontSize: 11 },
  labelStyle: { color: T.green }, itemStyle: { color: T.text }, cursor: { fill: '#ffffff08' },
}

// ── Small components ──────────────────────────────────────────────────────────
function Pulse({ color = T.green }) {
  return (
    <>
      <style>{`@keyframes pg{0%,100%{opacity:1;box-shadow:0 0 8px ${color}}50%{opacity:.4}}`}</style>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, animation: 'pg 2s infinite', flexShrink: 0 }} />
    </>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 360, gap: 14 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 32, height: 32, borderRadius: '50%', border: `2px solid ${T.border2}`, borderTop: `2px solid ${T.green}`, animation: 'spin .8s linear infinite' }} />
      <span style={{ ...mono, fontSize: 10, color: T.muted, letterSpacing: '0.1em' }}>LOADING…</span>
    </div>
  )
}

function SLabel({ children }) {
  return <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.12em', fontWeight: 700, marginBottom: 14 }}>{children}</div>
}

function Card({ children, style = {}, accent }) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${accent ? accent + '30' : T.border}`,
      borderRadius: 14, padding: '18px 20px',
      boxShadow: accent ? `0 0 28px ${accent}0e` : '0 4px 24px #00000044',
      position: 'relative', overflow: 'hidden', ...style,
    }}>
      {accent && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${accent}66,transparent)` }} />}
      {children}
    </div>
  )
}

function StatCard({ label, value, sub, color = T.green, icon, trend }) {
  return (
    <Card accent={color}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <SLabel>{label}</SLabel>
          <div style={{ fontSize: 38, fontWeight: 800, color, ...mono, lineHeight: 1, letterSpacing: '-0.03em' }}>{value ?? '—'}</div>
          {sub && <div style={{ fontSize: 10, color: T.muted, marginTop: 7, ...mono }}>{sub}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          {icon && <div style={{ fontSize: 22, opacity: 0.2 }}>{icon}</div>}
          {trend != null && (
            <div style={{ ...mono, fontSize: 9, color: trend > 0 ? T.green : T.muted,
              background: (trend > 0 ? T.green : T.muted) + '15',
              border: `1px solid ${(trend > 0 ? T.green : T.muted)}30`,
              borderRadius: 4, padding: '2px 6px' }}>
              {trend > 0 ? `+${trend}` : trend}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

function TierBadge({ tier }) {
  const c = TIER_COLORS[tier] || T.muted
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: c, background: c + '18', border: `1px solid ${c}33`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>T{tier}</span>
}

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || T.muted
  return <span style={{ ...mono, fontSize: 9, fontWeight: 600, color: c, background: c + '15', border: `1px solid ${c}30`, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{status}</span>
}

function EnvBadge({ env }) {
  const c = env === 'production' ? T.red : env === 'staging' ? T.amber : T.muted
  return <span style={{ ...mono, fontSize: 9, color: c, background: c + '15', border: `1px solid ${c}30`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>{env}</span>
}

// Horizontal stacked bar showing component type breakdown
function TypeBreakdown({ data }) {
  const total = data.reduce((s, d) => s + d.count, 0)
  if (!total) return <div style={{ ...mono, fontSize: 10, color: T.muted }}>No components yet</div>
  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2, marginBottom: 12 }}>
        {data.map(d => (
          <div key={d.type} style={{
            flex: d.count, background: TYPE_COLORS[d.type] || T.muted,
            boxShadow: `0 0 8px ${TYPE_COLORS[d.type] || T.muted}66`,
            transition: 'flex .4s',
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
        {data.map(d => {
          const color = TYPE_COLORS[d.type] || T.muted
          return (
            <div key={d.type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: color, boxShadow: `0 0 5px ${color}` }} />
              <span style={{ ...mono, fontSize: 10, color: T.dim }}>{d.type}</span>
              <span style={{ ...mono, fontSize: 11, fontWeight: 700, color: T.text }}>{d.count}</span>
              <span style={{ ...mono, fontSize: 9, color: T.muted }}>{Math.round(d.count / total * 100)}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [summary,  setSummary]  = useState(null)
  const [changes,  setChanges]  = useState([])
  const [apps,     setApps]     = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const load = () => {
    setLoading(true); setError(null)
    Promise.all([
      api.graph.summary(),
      api.changes.list(),
      api.applications.list(),
    ])
      .then(([s, c, a]) => {
        setSummary(s)
        setChanges(c.slice(0, 8))
        setApps(a)
        setLastUpdated(new Date())
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  // Derived chart data from summary (not from separate list calls)
  const tierData = [1,2,3,4].map(t => ({
    name: `T${t}`, value: apps.filter(a => a.tier === t).length, color: TIER_COLORS[t],
  }))

  const providerData = (summary?.infraByProvider || []).map(d => ({
    name: d.provider.toUpperCase(),
    value: d.count,
    color: PROVIDER_COLORS[d.provider] || T.muted,
  }))

  const compTypeData = summary?.componentsByType || []

  const changeStatusData = [
    { name: 'Approved', value: changes.filter(c => c.status === 'approved').length, color: T.green },
    { name: 'Pending',  value: changes.filter(c => c.status === 'draft').length,    color: T.amber },
    { name: 'Rejected', value: changes.filter(c => c.status === 'rejected').length, color: T.red   },
  ].filter(d => d.value > 0)

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 10% 20%, #0a1628 0%, ${T.bg} 60%)`, padding: '28px 32px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Pulse />
            <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: 0 }}>System Overview</h1>
          </div>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em' }}>INFRASTRUCTURE COMMAND CENTER</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastUpdated && (
            <span style={{ ...mono, fontSize: 9, color: T.muted }}>
              updated {lastUpdated.toLocaleTimeString('en-GB', { timeStyle: 'short' })}
            </span>
          )}
          <button onClick={load} style={{
            ...mono, fontSize: 10, padding: '7px 14px',
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 8, color: T.muted, cursor: 'pointer',
          }}>↺ Refresh</button>
          <div style={{ ...mono, fontSize: 10, color: T.muted, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 14px' }}>
            {new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        </div>
      </div>

      {loading ? <Spinner /> : error ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, gap: 12 }}>
          <div style={{ ...mono, fontSize: 12, color: T.red }}>{error}</div>
          <button onClick={load} style={{ ...mono, fontSize: 11, padding: '8px 18px', background: T.red + '15', border: `1px solid ${T.red}44`, borderRadius: 8, color: T.red, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : (
        <>
          {/* ── Row 1: Primary stat cards ───────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 }}>
            <StatCard label="APPLICATIONS"    value={summary?.applications   ?? 0} color={T.green}  sub={`${apps.filter(a=>a.environment==='production').length} in production`} icon="⬡" />
            <StatCard label="COMPONENTS"      value={summary?.components     ?? 0} color={T.blue}   sub={`${compTypeData.length} types`} icon="◈" />
            <StatCard label="INFRA RESOURCES" value={summary?.infraResources ?? 0} color={T.amber}  sub={`${summary?.publicInfraCount ?? 0} internet-exposed`} icon="◎" />
            <StatCard label="PENDING CHANGES" value={summary?.pendingChanges ?? 0} color={summary?.pendingChanges > 0 ? T.red : T.muted} sub="awaiting approval" icon="⚡" />
          </div>

          {/* ── Row 2: Secondary stat cards ─────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
            <StatCard label="CONNECTIONS"  value={summary?.connections    ?? 0} color={T.teal}   sub="component links" icon="⇄" />
            <StatCard label="TOTAL USERS"  value={summary?.users          ?? 0} color={T.purple} icon="◉" />
            <StatCard label="ALL CHANGES"  value={summary?.changes        ?? 0} color={T.blue}   icon="↗" />
            <StatCard label="GRAPH NODES"  value={(summary?.applications ?? 0) + (summary?.components ?? 0) + (summary?.infraResources ?? 0)} color={T.green} sub="apps + components + infra" icon="⬡" />
          </div>

          {/* ── Row 3: Charts ───────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 18, marginBottom: 18 }}>

            {/* Apps by tier bar chart */}
            <Card>
              <SLabel>APPLICATIONS BY TIER</SLabel>
              {apps.length === 0 ? (
                <div style={{ ...mono, fontSize: 10, color: T.muted, paddingTop: 8 }}>No applications yet</div>
              ) : (
                <ResponsiveContainer width="100%" height={170}>
                  <BarChart data={tierData} barSize={34}>
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: T.muted, fontSize: 10, fontFamily: 'monospace' }} />
                    <YAxis hide />
                    <Tooltip {...ttStyle} />
                    <Bar dataKey="value" radius={[6,6,0,0]}>
                      {tierData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            {/* Infra by provider donut */}
            <Card>
              <SLabel>INFRA BY PROVIDER</SLabel>
              {providerData.length === 0 ? (
                <div style={{ ...mono, fontSize: 10, color: T.muted, paddingTop: 8 }}>No infrastructure yet</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <ResponsiveContainer width="55%" height={170}>
                    <PieChart>
                      <Pie data={providerData} cx="50%" cy="50%" innerRadius={42} outerRadius={66} paddingAngle={4} dataKey="value">
                        {providerData.map((d, i) => <Cell key={i} fill={d.color} />)}
                      </Pie>
                      <Tooltip {...ttStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {providerData.map((d, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ width: 7, height: 7, borderRadius: 2, background: d.color, boxShadow: `0 0 5px ${d.color}` }} />
                        <span style={{ ...mono, fontSize: 10, color: T.muted }}>{d.name}</span>
                        <span style={{ ...mono, fontSize: 12, color: T.text, marginLeft: 6, fontWeight: 700 }}>{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Change status donut */}
            <Card>
              <SLabel>CHANGES BY STATUS</SLabel>
              {changeStatusData.length === 0 ? (
                <div style={{ ...mono, fontSize: 10, color: T.muted, paddingTop: 8 }}>No changes recorded</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <ResponsiveContainer width="55%" height={170}>
                    <PieChart>
                      <Pie data={changeStatusData} cx="50%" cy="50%" innerRadius={42} outerRadius={66} paddingAngle={4} dataKey="value">
                        {changeStatusData.map((d, i) => <Cell key={i} fill={d.color} />)}
                      </Pie>
                      <Tooltip {...ttStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {changeStatusData.map((d, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ width: 7, height: 7, borderRadius: 2, background: d.color, boxShadow: `0 0 5px ${d.color}` }} />
                        <span style={{ ...mono, fontSize: 10, color: T.muted }}>{d.name}</span>
                        <span style={{ ...mono, fontSize: 12, color: T.text, marginLeft: 6, fontWeight: 700 }}>{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* ── Row 4: Component type breakdown + Recent changes ────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 18, marginBottom: 18 }}>
            <Card>
              <SLabel>COMPONENTS BY TYPE</SLabel>
              <TypeBreakdown data={compTypeData} />
            </Card>

            <Card>
              <SLabel>RECENT CHANGES</SLabel>
              {changes.length === 0 ? (
                <span style={{ ...mono, fontSize: 11, color: T.muted }}>No changes recorded</span>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {changes.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', background: T.surface2, borderRadius: 8, border: `1px solid ${T.border}` }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ ...mono, fontSize: 11, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.description}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          <span style={{ ...mono, fontSize: 9, color: T.muted }}>{new Date(c.createdAt).toLocaleDateString('en-GB')}</span>
                          {c.application && <span style={{ ...mono, fontSize: 9, color: T.blue }}>{c.application}</span>}
                        </div>
                      </div>
                      <StatusBadge status={c.status} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* ── Row 5: Applications table ────────────────────────────────── */}
          <Card>
            <SLabel>ALL APPLICATIONS</SLabel>
            {apps.length === 0 ? (
              <div style={{ ...mono, fontSize: 11, color: T.muted, textAlign: 'center', padding: '24px 0' }}>No applications yet</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Application', 'Tier', 'Owner', 'Environment', 'Components'].map(h => (
                      <th key={h} style={{ ...mono, fontSize: 9, color: T.muted, textAlign: 'left', padding: '0 12px 10px', letterSpacing: '0.1em', fontWeight: 700, borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {apps.map(a => (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${T.border}` }}
                      onMouseEnter={e => e.currentTarget.style.background = T.surface2}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={{ padding: '11px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: TIER_COLORS[a.tier] || T.muted, boxShadow: `0 0 6px ${TIER_COLORS[a.tier] || T.muted}` }} />
                          <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.text }}>{a.name}</span>
                        </div>
                      </td>
                      <td style={{ padding: '11px 12px' }}><TierBadge tier={a.tier} /></td>
                      <td style={{ padding: '11px 12px', ...mono, fontSize: 11, color: T.dim }}>{a.owner}</td>
                      <td style={{ padding: '11px 12px' }}><EnvBadge env={a.environment} /></td>
                      <td style={{ padding: '11px 12px' }}>
                        <span style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text }}>{a.componentCount ?? 0}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  )
}