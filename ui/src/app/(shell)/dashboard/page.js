'use client'

export const dynamic = 'force-dynamic'
import { useState, useEffect, useCallback } from 'react'
import { api } from '../../../lib/api'
import { useTheme, getT } from '@/lib/theme'

// Module-level fallback — satisfies sub-component defaults and constants.
// The default export re-derives T from useTheme() for live theme switching.
const T = getT('dark')



const mono = { fontFamily:'monospace' }

const TIER_COLOR  = { 1:T.red, 2:T.amber, 3:T.green, 4:T.muted }
const SEV_COLOR   = { CRITICAL:T.red, HIGH:T.orange, MEDIUM:T.amber, LOW:T.green }
const STATUS_COLOR= { approved:T.green, rejected:T.red, draft:T.amber, in_review:T.blue }

// ── Micro helpers ──────────────────────────────────────────────────────────────
function Spinner({ color = T.teal, size = 18 }) {
  return (
    <>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <span style={{ display:'inline-block', width:size, height:size, borderRadius:'50%',
        border:`2px solid ${T.border2}`, borderTopColor:color,
        animation:'spin .7s linear infinite', flexShrink:0 }}/>
    </>
  )
}

function useFetch(fn) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const load = useCallback(() => {
    setLoading(true)
    fn().then(setData).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

// ── Stat card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color = T.text, href, icon, glow }) {
  const inner = (
    <div style={{ background:T.surface, border:`1px solid ${glow ? color+'44' : T.border}`,
      borderRadius:10, padding:'16px 18px', height:'100%',
      boxShadow: glow ? `0 0 20px ${color}18` : 'none',
      transition:'all .15s', cursor: href ? 'pointer' : 'default' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
        <div style={{ ...mono, fontSize:9, color:T.muted, letterSpacing:'0.12em',
          fontWeight:700, textTransform:'uppercase' }}>{label}</div>
        {icon && <span style={{ fontSize:14, color, opacity:.7 }}>{icon}</span>}
      </div>
      <div style={{ ...mono, fontSize:26, fontWeight:800, color, lineHeight:1 }}>{value ?? '—'}</div>
      {sub && <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:6 }}>{sub}</div>}
    </div>
  )
  return href
    ? <a href={href} style={{ textDecoration:'none', display:'block' }}>{inner}</a>
    : inner
}

// ── Section header ─────────────────────────────────────────────────────────────
function SectionHeader({ title, href, linkLabel = 'View all' }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
      <div style={{ ...mono, fontSize:11, fontWeight:700, color:T.text,
        letterSpacing:'-0.01em' }}>{title}</div>
      {href && (
        <a href={href} style={{ ...mono, fontSize:9, color:T.teal, textDecoration:'none',
          background:T.teal+'12', border:`1px solid ${T.teal}30`,
          borderRadius:5, padding:'3px 9px' }}>{linkLabel} →</a>
      )}
    </div>
  )
}

// ── Graph health panel ─────────────────────────────────────────────────────────
function GraphHealth({ summary }) {
  if (!summary) return null
  const nodes = [
    { label:'Applications', value:summary.applications,   color:T.blue,   icon:'◈' },
    { label:'Components',   value:summary.components,     color:T.teal,   icon:'⬡' },
    { label:'Infrastructure',value:summary.infraResources, color:T.purple, icon:'◫' },
    { label:'Changes',      value:summary.changes,        color:T.amber,  icon:'⟳' },
    { label:'Connections',  value:summary.connections,    color:T.green,  icon:'⇌' },
    { label:'Users',        value:summary.users,          color:T.orange, icon:'◎' },
  ]
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
      {nodes.map(n => (
        <div key={n.label} style={{ background:T.surface2, border:`1px solid ${T.border}`,
          borderRadius:8, padding:'12px 14px', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:16, color:n.color }}>{n.icon}</span>
          <div>
            <div style={{ ...mono, fontSize:18, fontWeight:800, color:n.color }}>{n.value ?? 0}</div>
            <div style={{ ...mono, fontSize:9, color:T.muted }}>{n.label}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Score ring (reused from governance) ───────────────────────────────────────
function ScoreRing({ score, size = 80 }) {
  const r   = (size / 2) - 8
  const c   = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score || 0))
  const col = pct >= 80 ? T.green : pct >= 60 ? T.amber : T.red
  return (
    <svg width={size} height={size}>
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={T.border2} strokeWidth={6}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={col} strokeWidth={6}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct/100)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition:'stroke-dashoffset .6s ease' }}/>
      <text x={size/2} y={size/2 + 5}
        textAnchor="middle" fill={col}
        style={{ fontFamily:'monospace', fontSize:15, fontWeight:800 }}>{pct}%</text>
    </svg>
  )
}

// ── Recent changes ─────────────────────────────────────────────────────────────
function RecentChanges({ changes }) {
  if (!changes?.length) return (
    <div style={{ ...mono, fontSize:11, color:T.muted, padding:'16px 0', textAlign:'center' }}>
      No recent changes
    </div>
  )
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
      {changes.slice(0, 6).map(ch => {
        const sc = STATUS_COLOR[ch.status] || T.muted
        const rc = ch.riskScore >= 7 ? T.red : ch.riskScore >= 4 ? T.amber : T.green
        return (
          <div key={ch.id} style={{ display:'flex', alignItems:'center', gap:10,
            padding:'9px 12px', background:T.surface2,
            border:`1px solid ${T.border}`, borderRadius:7 }}>
            <div style={{ width:5, height:5, borderRadius:'50%',
              background:sc, boxShadow:`0 0 4px ${sc}`, flexShrink:0 }}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ ...mono, fontSize:11, fontWeight:600, color:T.text,
                overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {ch.title}
              </div>
              <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:1 }}>
                {ch.submittedBy || '—'} · {ch.createdAt ? ch.createdAt.slice(0,10) : ''}
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
              <span style={{ ...mono, fontSize:9, fontWeight:700, color:rc,
                background:rc+'18', border:`1px solid ${rc}33`,
                borderRadius:3, padding:'1px 6px' }}>Risk {ch.riskScore ?? '?'}</span>
              <span style={{ ...mono, fontSize:9, fontWeight:700, color:sc,
                background:sc+'18', border:`1px solid ${sc}33`,
                borderRadius:3, padding:'1px 6px', textTransform:'uppercase' }}>{ch.status}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Active violations ─────────────────────────────────────────────────────────
function ActiveViolations({ violations }) {
  if (!violations?.length) return (
    <div style={{ display:'flex', alignItems:'center', gap:8,
      padding:'14px 16px', background:T.green+'0a',
      border:`1px solid ${T.green}33`, borderRadius:8 }}>
      <span style={{ fontSize:16 }}>✓</span>
      <span style={{ ...mono, fontSize:11, color:T.green, fontWeight:600 }}>
        No active policy violations
      </span>
    </div>
  )

  const bySev = violations.reduce((acc, v) => {
    acc[v.severity] = (acc[v.severity] || 0) + 1; return acc
  }, {})

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap' }}>
        {['CRITICAL','HIGH','MEDIUM','LOW'].map(s => bySev[s] > 0 && (
          <div key={s} style={{ padding:'6px 12px', borderRadius:6,
            background: SEV_COLOR[s]+'18', border:`1px solid ${SEV_COLOR[s]}44`,
            display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ ...mono, fontSize:16, fontWeight:800, color:SEV_COLOR[s] }}>{bySev[s]}</span>
            <span style={{ ...mono, fontSize:9, color:SEV_COLOR[s], fontWeight:700,
              letterSpacing:'0.06em' }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
        {violations.slice(0, 5).map((v, i) => {
          const sc = SEV_COLOR[v.severity] || T.muted
          return (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:8,
              padding:'8px 12px', background:T.surface2,
              border:`1px solid ${sc}22`, borderRadius:7 }}>
              <div style={{ width:4, flexShrink:0, alignSelf:'stretch',
                background:sc, borderRadius:2 }}/>
              <div style={{ flex:1 }}>
                <div style={{ ...mono, fontSize:10, fontWeight:700, color:T.text }}>
                  {v.policy?.replace(/_/g,' ')}
                </div>
                <div style={{ ...mono, fontSize:9, color:T.dim }}>{v.resource}</div>
              </div>
              <span style={{ ...mono, fontSize:8, fontWeight:700, color:sc,
                background:sc+'18', border:`1px solid ${sc}33`,
                borderRadius:3, padding:'1px 5px', letterSpacing:'0.05em',
                flexShrink:0 }}>{v.severity}</span>
            </div>
          )
        })}
        {violations.length > 5 && (
          <a href="/governance" style={{ ...mono, fontSize:9, color:T.muted,
            textAlign:'center', padding:'6px', textDecoration:'none' }}>
            +{violations.length - 5} more violations →
          </a>
        )}
      </div>
    </div>
  )
}

// ── Drift status ───────────────────────────────────────────────────────────────
function DriftStatus({ drift }) {
  if (!drift) return null
  const { graphTerraformResources: total = 0, staleResources: unmapped = 0 } = drift
  const mapped = total - unmapped
  const pct    = total ? Math.round(mapped / total * 100) : 100
  const color  = unmapped === 0 ? T.green : unmapped > 5 ? T.red : T.amber

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
        {[
          { label:'Total Infra',  value:total,   color:T.text  },
          { label:'Mapped',       value:mapped,  color:T.green },
          { label:'Unmapped',     value:unmapped,color        },
        ].map(s => (
          <div key={s.label} style={{ background:T.surface2, border:`1px solid ${T.border}`,
            borderRadius:7, padding:'10px 12px', textAlign:'center' }}>
            <div style={{ ...mono, fontSize:20, fontWeight:800, color:s.color }}>{s.value}</div>
            <div style={{ ...mono, fontSize:9, color:T.muted, marginTop:2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
          <span style={{ ...mono, fontSize:9, color:T.muted }}>Graph coverage</span>
          <span style={{ ...mono, fontSize:9, color, fontWeight:700 }}>{pct}%</span>
        </div>
        <div style={{ height:5, background:T.border2, borderRadius:3 }}>
          <div style={{ height:'100%', width:`${pct}%`, background:color,
            borderRadius:3, transition:'width .4s' }}/>
        </div>
      </div>
      {unmapped > 0 && (
        <a href="/workflows" style={{ ...mono, fontSize:9, fontWeight:700,
          color:T.amber, background:T.amber+'12', border:`1px solid ${T.amber}33`,
          borderRadius:6, padding:'7px 12px', textDecoration:'none', textAlign:'center' }}>
          ⚠ {unmapped} unmapped resources — run drift detection →
        </a>
      )}
    </div>
  )
}

// ── Tier breakdown ─────────────────────────────────────────────────────────────
function TierBreakdown({ applications }) {
  if (!applications?.length) return (
    <div style={{ ...mono, fontSize:11, color:T.muted, textAlign:'center', padding:'12px 0' }}>
      No applications
    </div>
  )
  const byTier = [1,2,3,4].map(t => ({
    tier: t,
    count: applications.filter(a => a.tier === t || Number(a.tier) === t).length,
    color: TIER_COLOR[t],
  })).filter(t => t.count > 0)
  const max = Math.max(...byTier.map(t => t.count), 1)

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {byTier.map(t => (
        <div key={t.tier} style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ ...mono, fontSize:10, fontWeight:700, color:t.color, minWidth:42 }}>
            Tier {t.tier}
          </div>
          <div style={{ flex:1, height:6, background:T.border2, borderRadius:3 }}>
            <div style={{ height:'100%', width:`${t.count/max*100}%`,
              background:t.color, borderRadius:3, transition:'width .4s' }}/>
          </div>
          <div style={{ ...mono, fontSize:11, fontWeight:700, color:t.color, minWidth:20,
            textAlign:'right' }}>{t.count}</div>
        </div>
      ))}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const graphSummary  = useFetch(() => api.graph.summary())
  const changes       = useFetch(() => api.changes.list())
  const violations    = useFetch(() => api.governance.violations())
  const govSummary    = useFetch(() => api.governance.summary())
  const drift         = useFetch(() => api.workflows.drift())
  const apps          = useFetch(() => api.applications.list())
  const discSummary   = useFetch(() => api.discovery.summary())

  const loading = graphSummary.loading && changes.loading && violations.loading

  const gs  = graphSummary.data
  const cs  = govSummary.data?.changes || {}
  const scoreRaw = govSummary.data
    ? (() => {
        const v = violations.data || []
        let s = 100
        s -= v.filter(x => x.severity === 'CRITICAL').length * 15
        s -= v.filter(x => x.severity === 'HIGH').length     * 8
        s -= v.filter(x => x.severity === 'MEDIUM').length   * 3
        if ((cs.approvalRate || 100) < 80) s -= 10
        if ((cs.highRiskUnapproved || 0) > 0) s -= 5 * cs.highRiskUnapproved
        return Math.max(0, Math.min(100, s))
      })()
    : null

  return (
    <div style={{ minHeight:'100vh', background:T.bg, color:T.text,
      fontFamily:'monospace', padding:'28px 32px' }}>
      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
        .dash-section { animation: fadeUp .3s ease both }
      `}</style>

      {/* ── Header ── */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:'flex', alignItems:'center',
          justifyContent:'space-between', marginBottom:6 }}>
          <div>
            <h1 style={{ margin:0, fontSize:20, fontWeight:800,
              letterSpacing:'-0.02em', color:T.text }}>Dashboard</h1>
            <p style={{ margin:'4px 0 0', fontSize:11, color:T.dim }}>
              Infrastructure intelligence at a glance
            </p>
          </div>
          {!loading && (
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              {scoreRaw !== null && (
                <div style={{ display:'flex', alignItems:'center', gap:8,
                  padding:'8px 14px', background:T.surface,
                  border:`1px solid ${T.border}`, borderRadius:10 }}>
                  <ScoreRing score={scoreRaw} size={48}/>
                  <div>
                    <div style={{ ...mono, fontSize:9, color:T.muted,
                      letterSpacing:'0.1em' }}>COMPLIANCE</div>
                    <div style={{ ...mono, fontSize:9, color:T.muted,
                      letterSpacing:'0.1em' }}>SCORE</div>
                  </div>
                </div>
              )}
              <button onClick={() => {
                  graphSummary.reload(); changes.reload(); violations.reload()
                  govSummary.reload();  drift.reload();   apps.reload()
                  discSummary.reload()
                }}
                style={{ ...mono, fontSize:9, color:T.dim, background:'transparent',
                  border:`1px solid ${T.border}`, borderRadius:7,
                  padding:'8px 12px', cursor:'pointer' }}>↻ Refresh</button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ display:'flex', justifyContent:'center', alignItems:'center',
          height:300, gap:12, color:T.muted }}>
          <Spinner size={24}/> <span style={{ ...mono, fontSize:12 }}>Loading dashboard…</span>
        </div>
      ) : (
        <>
          {/* ── Top stat row ── */}
          <div className="dash-section" style={{ display:'grid',
            gridTemplateColumns:'repeat(5,1fr)', gap:10, marginBottom:20 }}>
            <StatCard label="Applications"   value={gs?.applications}
              icon="◈" color={T.blue}  href="/applications"/>
            <StatCard label="Infrastructure" value={gs?.infraResources}
              icon="◫" color={T.purple} href="/infra"/>
            <StatCard label="Pending Changes" value={gs?.pendingChanges}
              icon="⟳" color={gs?.pendingChanges > 0 ? T.amber : T.green}
              glow={gs?.pendingChanges > 0} href="/changes"
              sub="awaiting review"/>
            <StatCard label="Policy Violations" value={violations.data?.length ?? 0}
              icon="⚖" color={violations.data?.length > 0 ? T.red : T.green}
              glow={violations.data?.length > 0} href="/governance"
              sub={violations.data?.filter(v=>v.severity==='CRITICAL').length > 0
                ? `${violations.data.filter(v=>v.severity==='CRITICAL').length} critical`
                : 'all clear'}/>
            <StatCard label="Public Infra" value={gs?.publicInfraCount}
              icon="⊕" color={gs?.publicInfraCount > 0 ? T.amber : T.green}
              sub="internet-facing nodes"/>
          </div>

          {/* ── Middle row ── */}
          <div className="dash-section" style={{ display:'grid',
            gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14,
            animationDelay:'60ms' }}>

            {/* Graph health */}
            <div style={{ background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:12, padding:'16px 18px' }}>
              <SectionHeader title="Graph Health" href="/graph" linkLabel="Open graph"/>
              <GraphHealth summary={gs}/>
              {gs?.componentsByType?.length > 0 && (
                <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${T.border}` }}>
                  <div style={{ ...mono, fontSize:9, color:T.muted, letterSpacing:'0.1em',
                    fontWeight:700, marginBottom:8 }}>COMPONENTS BY TYPE</div>
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                    {gs.componentsByType.map(ct => (
                      <span key={ct.type} style={{ ...mono, fontSize:9,
                        color:T.teal, background:T.teal+'12',
                        border:`1px solid ${T.teal}30`, borderRadius:4,
                        padding:'2px 8px' }}>{ct.type}: {ct.count}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Recent changes */}
            <div style={{ background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:12, padding:'16px 18px' }}>
              <SectionHeader title="Recent Changes" href="/changes"/>
              <RecentChanges changes={changes.data}/>
            </div>
          </div>

          {/* ── Bottom row ── */}
          <div className="dash-section" style={{ display:'grid',
            gridTemplateColumns:'1fr 1fr 1fr', gap:14,
            animationDelay:'120ms' }}>

            {/* Active violations */}
            <div style={{ background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:12, padding:'16px 18px' }}>
              <SectionHeader title="Policy Violations" href="/governance"/>
              <ActiveViolations violations={violations.data}/>
            </div>

            {/* Drift status */}
            <div style={{ background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:12, padding:'16px 18px' }}>
              <SectionHeader title="Drift Status" href="/workflows" linkLabel="Drift detection"/>
              {drift.loading
                ? <div style={{ display:'flex', justifyContent:'center', padding:'20px 0' }}><Spinner/></div>
                : <DriftStatus drift={drift.data}/>}
              {discSummary.data && (
                <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${T.border}` }}>
                  <div style={{ ...mono, fontSize:9, color:T.muted, letterSpacing:'0.1em',
                    fontWeight:700, marginBottom:6 }}>DISCOVERY</div>
                  <div style={{ display:'flex', gap:6 }}>
                    {[
                      { label:'AWS',   count:discSummary.data.byProvider?.aws?.total   ?? 0, color:'#f59e0b' },
                      { label:'Azure', count:discSummary.data.byProvider?.azure?.total ?? 0, color:'#38bdf8' },
                      { label:'GCP',   count:discSummary.data.byProvider?.gcp?.total   ?? 0, color:'#22c55e' },
                    ].map(p => (
                      <div key={p.label} style={{ flex:1, textAlign:'center',
                        background:T.surface2, border:`1px solid ${T.border}`,
                        borderRadius:6, padding:'6px 4px' }}>
                        <div style={{ ...mono, fontSize:14, fontWeight:800, color:p.color }}>{p.count}</div>
                        <div style={{ ...mono, fontSize:8, color:T.muted }}>{p.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* App tier breakdown + compliance */}
            <div style={{ background:T.surface, border:`1px solid ${T.border}`,
              borderRadius:12, padding:'16px 18px' }}>
              <SectionHeader title="Applications by Tier" href="/applications"/>
              <TierBreakdown applications={apps.data}/>
              {govSummary.data && (
                <div style={{ marginTop:14, paddingTop:12, borderTop:`1px solid ${T.border}` }}>
                  <div style={{ ...mono, fontSize:9, color:T.muted, letterSpacing:'0.1em',
                    fontWeight:700, marginBottom:8 }}>CHANGE METRICS</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                    {[
                      { label:'Approval Rate', value:`${cs.approvalRate ?? '—'}%`,
                        color: (cs.approvalRate ?? 100) >= 80 ? T.green : T.amber },
                      { label:'High-Risk',     value:cs.highRiskUnapproved ?? 0,
                        color: cs.highRiskUnapproved > 0 ? T.red : T.green },
                    ].map(m => (
                      <div key={m.label} style={{ background:T.surface2,
                        border:`1px solid ${T.border}`, borderRadius:6, padding:'8px 10px' }}>
                        <div style={{ ...mono, fontSize:15, fontWeight:800, color:m.color }}>{m.value}</div>
                        <div style={{ ...mono, fontSize:8, color:T.muted, marginTop:2 }}>{m.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}