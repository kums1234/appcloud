'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

const T = {
  bg: '#04080f', surface: '#080f1a', surface2: '#0d1626',
  border: '#0f1f35', border2: '#1e293b',
  text: '#f1f5f9', muted: '#334155',
  green: '#22c55e', blue: '#38bdf8', amber: '#f59e0b',
  red: '#f43f5e', purple: '#a78bfa',
}
const TIER_COLORS = { 1: T.red, 2: T.amber, 3: T.green, 4: T.muted }
const PROVIDER_COLORS = { aws: T.amber, azure: T.blue, gcp: T.green, onprem: T.muted }
const STATUS_COLORS = { approved: T.green, draft: T.amber, rejected: T.red }
const mono = { fontFamily: 'monospace' }

function Pulse({ color = T.green }) {
  return (
    <>
      <style>{`@keyframes pg{0%,100%{opacity:1;box-shadow:0 0 8px ${color}}50%{opacity:.4}}`}</style>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, animation: 'pg 2s infinite', flexShrink: 0 }} />
    </>
  )
}

function SectionLabel({ children }) {
  return <div style={{ ...mono, fontSize: 9, color: T.muted, letterSpacing: '0.12em', fontWeight: 700, marginBottom: 14 }}>{children}</div>
}

function Card({ children, style = {}, accent }) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${accent ? accent + '33' : T.border}`,
      borderRadius: 14, padding: '18px 20px',
      boxShadow: accent ? `0 0 24px ${accent}11` : '0 4px 24px #00000044',
      position: 'relative', overflow: 'hidden', ...style,
    }}>
      {accent && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${accent}66,transparent)` }} />}
      {children}
    </div>
  )
}

function StatCard({ label, value, sub, color = T.green, icon }) {
  return (
    <Card accent={color}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <SectionLabel>{label}</SectionLabel>
          <div style={{ fontSize: 36, fontWeight: 800, color, ...mono, lineHeight: 1, letterSpacing: '-0.03em' }}>{value}</div>
          {sub && <div style={{ fontSize: 10, color: T.muted, marginTop: 6, ...mono }}>{sub}</div>}
        </div>
        {icon && <div style={{ fontSize: 22, opacity: 0.3 }}>{icon}</div>}
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
  const c = env === 'production' ? T.blue : env === 'staging' ? T.amber : T.muted
  return <span style={{ ...mono, fontSize: 9, color: c, background: c + '15', border: `1px solid ${c}30`, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>{env}</span>
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 400, gap: 14 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 32, height: 32, borderRadius: '50%', border: `2px solid ${T.border2}`, borderTop: `2px solid ${T.green}`, animation: 'spin .8s linear infinite' }} />
      <span style={{ ...mono, fontSize: 10, color: T.muted, letterSpacing: '0.1em' }}>LOADING…</span>
    </div>
  )
}

const ttStyle = {
  contentStyle: { background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 8, fontFamily: 'monospace', fontSize: 11 },
  labelStyle: { color: T.green }, itemStyle: { color: T.text },
}

export default function DashboardPage() {
  const [summary, setSummary] = useState(null)
  const [changes, setChanges] = useState([])
  const [apps, setApps] = useState([])
  const [infra, setInfra] = useState([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    Promise.all([api.graph.summary(), api.changes.list(), api.applications.list(), api.infra.list()])
      .then(([s, c, a, i]) => { setSummary(s); setChanges(c.slice(0, 6)); setApps(a); setInfra(i) })
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

  const tierData = [1,2,3,4].map(t => ({ name: `T${t}`, value: apps.filter(a => a.tier === t).length, color: TIER_COLORS[t] }))
  const providerData = Object.entries(PROVIDER_COLORS)
    .map(([p, color]) => ({ name: p.toUpperCase(), value: infra.filter(i => i.provider === p).length, color }))
    .filter(d => d.value > 0)

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
        <div style={{ ...mono, fontSize: 10, color: T.muted, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 14px' }}>
          {new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
        </div>
      </div>

      {loading ? <Spinner /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
            <StatCard label="APPLICATIONS" value={summary?.applications ?? 0} color={T.green} sub="registered services" icon="⬡" />
            <StatCard label="COMPONENTS" value={summary?.components ?? 0} color={T.blue} sub="APIs · DBs · Workers · UIs" icon="◈" />
            <StatCard label="INFRA RESOURCES" value={summary?.infraResources ?? 0} color={T.amber} sub="cloud & on-prem" icon="◎" />
            <StatCard label="PENDING CHANGES" value={summary?.pendingChanges ?? 0} color={summary?.pendingChanges > 0 ? T.red : T.muted} sub="awaiting approval" icon="⚡" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
            <StatCard label="TOTAL USERS" value={summary?.users ?? 0} color={T.purple} icon="◉" />
            <StatCard label="ALL CHANGES" value={summary?.changes ?? 0} color={T.blue} icon="↗" />
            <StatCard label="PUBLIC INFRA" value={summary?.publicInfraCount ?? 0} color={T.red} sub="internet-exposed" icon="⊕" />
            <StatCard label="GRAPH NODES" value={(summary?.applications ?? 0) + (summary?.components ?? 0) + (summary?.infraResources ?? 0)} color={T.green} icon="⬡" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: 18, marginBottom: 24 }}>
            <Card>
              <SectionLabel>APPLICATIONS BY TIER</SectionLabel>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={tierData} barSize={32}>
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: T.muted, fontSize: 10, fontFamily: 'monospace' }} />
                  <YAxis hide />
                  <Tooltip {...ttStyle} />
                  <Bar dataKey="value" radius={[6,6,0,0]}>
                    {tierData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card>
              <SectionLabel>INFRA BY PROVIDER</SectionLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ResponsiveContainer width="55%" height={180}>
                  <PieChart>
                    <Pie data={providerData} cx="50%" cy="50%" innerRadius={44} outerRadius={68} paddingAngle={4} dataKey="value">
                      {providerData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip {...ttStyle} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {providerData.map((d, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color, boxShadow: `0 0 6px ${d.color}` }} />
                      <span style={{ ...mono, fontSize: 10, color: T.muted }}>{d.name}</span>
                      <span style={{ ...mono, fontSize: 11, color: T.text, marginLeft: 8, fontWeight: 700 }}>{d.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <SectionLabel>RECENT CHANGES</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {changes.length === 0
                  ? <span style={{ ...mono, fontSize: 11, color: T.muted }}>No changes recorded</span>
                  : changes.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px', background: T.surface2, borderRadius: 8, border: `1px solid ${T.border}` }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ ...mono, fontSize: 11, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{c.description}</div>
                        <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 2 }}>{new Date(c.createdAt).toLocaleDateString('en-GB')}</div>
                      </div>
                      <StatusBadge status={c.status} />
                    </div>
                  ))
                }
              </div>
            </Card>
          </div>

          <Card>
            <SectionLabel>ALL APPLICATIONS</SectionLabel>
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
                  <tr key={a.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: '11px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 5, height: 5, borderRadius: '50%', background: TIER_COLORS[a.tier] || T.muted, boxShadow: `0 0 6px ${TIER_COLORS[a.tier] || T.muted}` }} />
                        <span style={{ ...mono, fontSize: 12, fontWeight: 600, color: T.text }}>{a.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '11px 12px' }}><TierBadge tier={a.tier} /></td>
                    <td style={{ padding: '11px 12px', ...mono, fontSize: 11, color: T.muted }}>{a.owner}</td>
                    <td style={{ padding: '11px 12px' }}><EnvBadge env={a.environment} /></td>
                    <td style={{ padding: '11px 12px', ...mono, fontSize: 11, color: T.muted }}>{a.componentCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  )
}