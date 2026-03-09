'use client'

export const dynamic = 'force-dynamic'
import { useState, useEffect, useCallback } from 'react'
import { useTheme, getT } from '@/lib/theme'

// Module-level fallback — satisfies sub-component defaults and constants.
// The default export re-derives T from useTheme() for live theme switching.
const T = getT('dark')



const mono = { fontFamily:'monospace' }
const TIER_COLOR = { 1:'#f43f5e', 2:'#f59e0b', 3:'#22c55e', 4:'#334155' }
const SEV_COLOR  = { CRITICAL:'#f43f5e', HIGH:'#fb923c', MEDIUM:'#f59e0b', LOW:'#22c55e' }
const STATUS_COLOR = { approved:T.green, rejected:T.red, draft:T.amber }

function useApi(url) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const load = useCallback(() => {
    setLoading(true); setError(null)
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(setData).catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [url])
  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

function ScoreRing({ score }) {
  const r = 44, circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const dash = (pct / 100) * circ
  const color = pct >= 80 ? T.green : pct >= 60 ? T.amber : T.red
  return (
    <div style={{ position:'relative', width:120, height:120, flexShrink:0 }}>
      <svg width={120} height={120} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={60} cy={60} r={r} fill="none" stroke={T.border2} strokeWidth={8}/>
        <circle cx={60} cy={60} r={r} fill="none" stroke={color} strokeWidth={8}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ filter:`drop-shadow(0 0 6px ${color})`, transition:'stroke-dasharray .6s ease' }}/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column',
        alignItems:'center', justifyContent:'center' }}>
        <div style={{ ...mono, fontSize:26, fontWeight:800, color, lineHeight:1 }}>{pct}</div>
        <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.1em', marginTop:2 }}>SCORE</div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color = T.text, glow = false }) {
  return (
    <div style={{ background:T.surface2, border:`1px solid ${T.border}`, borderRadius:10,
      padding:'14px 16px', display:'flex', flexDirection:'column', gap:4 }}>
      <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.12em',
        fontWeight:700, textTransform:'uppercase' }}>{label}</div>
      <div style={{ ...mono, fontSize:24, fontWeight:800, color,
        ...(glow ? { textShadow:`0 0 12px ${color}` } : {}) }}>{value ?? '\u2014'}</div>
      {sub && <div style={{ ...mono, fontSize:9, color:T.dim }}>{sub}</div>}
    </div>
  )
}

function SevBadge({ sev }) {
  const c = SEV_COLOR[sev] || T.muted
  return (
    <span style={{ ...mono, fontSize:8, fontWeight:700, letterSpacing:'0.08em',
      color:c, background:c+'18', border:`1px solid ${c}33`,
      borderRadius:3, padding:'2px 6px', whiteSpace:'nowrap' }}>{sev}</span>
  )
}

function Spinner() {
  return (
    <div style={{ display:'flex', justifyContent:'center', padding:'32px 0' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width:22, height:22, borderRadius:'50%',
        border:`2px solid ${T.border2}`, borderTop:`2px solid ${T.teal}`,
        animation:'spin .7s linear infinite' }}/>
    </div>
  )
}
function ErrMsg({ msg, onRetry }) {
  return (
    <div style={{ textAlign:'center', padding:'24px 0' }}>
      <div style={{ ...mono, fontSize:11, color:T.red, marginBottom:8 }}>Error: {msg}</div>
      <button onClick={onRetry} style={{ ...mono, fontSize:10, color:T.teal,
        background:'transparent', border:`1px solid ${T.teal}44`, borderRadius:5,
        padding:'5px 14px', cursor:'pointer' }}>Retry</button>
    </div>
  )
}
function EmptyState({ label }) {
  return <div style={{ ...mono, fontSize:11, color:T.muted, textAlign:'center', padding:'24px 0' }}>{label}</div>
}

function Section({ title, subtitle, children, action }) {
  return (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`,
      borderRadius:12, overflow:'hidden' }}>
      <div style={{ padding:'14px 20px', borderBottom:`1px solid ${T.border}`,
        display:'flex', alignItems:'center', justifyContent:'space-between', gap:16 }}>
        <div>
          <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>{title}</div>
          {subtitle && <div style={{ ...mono, fontSize:10, color:T.muted, marginTop:2 }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      <div style={{ padding:'16px 20px' }}>{children}</div>
    </div>
  )
}

function ViolationsPanel() {
  const { data, loading, error, reload } = useApi('/api/governance/policy-violations')
  const POLICY_LABELS = {
    NO_OWNER:             'Unowned Application',
    HIGH_RISK_UNAPPROVED: 'Unapproved High-Risk Change',
    PUBLIC_INFRA_TIER1:   'Public Infra on Tier-1 App',
    NO_DEPLOYMENT_RECORD: 'Missing Deployment Record',
    SELF_APPROVED:        'Self-Approved Change',
  }
  if (loading) return <Spinner/>
  if (error)   return <ErrMsg msg={error} onRetry={reload}/>
  if (!data?.length) return (
    <div style={{ textAlign:'center', padding:'32px 0' }}>
      <div style={{ fontSize:28, marginBottom:8 }}>✓</div>
      <div style={{ ...mono, fontSize:12, color:T.green, fontWeight:700 }}>No policy violations detected</div>
      <div style={{ ...mono, fontSize:10, color:T.muted, marginTop:4 }}>All 5 governance policies are passing</div>
    </div>
  )
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {data.map((v, i) => (
        <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:12,
          padding:'12px 14px', background:T.surface2,
          border:`1px solid ${SEV_COLOR[v.severity]}33`,
          borderLeft:`3px solid ${SEV_COLOR[v.severity]}`, borderRadius:8 }}>
          <SevBadge sev={v.severity}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ ...mono, fontSize:11, fontWeight:700, color:T.text, marginBottom:3 }}>
              {POLICY_LABELS[v.policy] || v.policy}
            </div>
            <div style={{ ...mono, fontSize:10, color:T.dim, marginBottom:4 }}>{v.description}</div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ ...mono, fontSize:8, color:T.muted,
                background:T.surface3, border:`1px solid ${T.border}`,
                borderRadius:3, padding:'1px 6px' }}>{v.resourceType}</span>
              <span style={{ ...mono, fontSize:10, color:T.blue }}>{v.resourceName}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function RiskHeatmap() {
  const { data, loading, error, reload } = useApi('/api/governance/risk-heatmap')
  if (loading) return <Spinner/>
  if (error)   return <ErrMsg msg={error} onRetry={reload}/>
  if (!data?.length) return <EmptyState label="No applications found"/>
  const maxRisk = Math.max(...data.map(d => d.maxRisk || 0), 1)
  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', ...mono, fontSize:11 }}>
        <thead>
          <tr style={{ borderBottom:`1px solid ${T.border2}` }}>
            {['Application','Tier','Owner','Changes','Avg Risk','Max Risk','Pending'].map(h => (
              <th key={h} style={{ padding:'6px 10px', textAlign:'left', fontSize:8,
                color:T.muted, letterSpacing:'0.1em', fontWeight:700, whiteSpace:'nowrap' }}>
                {h.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((app, i) => {
            const tc  = TIER_COLOR[app.tier] || T.muted
            const risk = app.avgRisk || 0
            const rc  = risk >= 7 ? T.red : risk >= 4 ? T.amber : T.green
            const barW = maxRisk > 0 ? (app.maxRisk / maxRisk) * 80 : 0
            return (
              <tr key={app.id||i} style={{ borderBottom:`1px solid ${T.border}`,
                background: i%2===0?'transparent':T.surface+'44' }}>
                <td style={{ padding:'10px 10px', color:T.text, fontWeight:600 }}>{app.name}</td>
                <td style={{ padding:'10px 10px' }}>
                  <span style={{ color:tc, background:tc+'18', border:`1px solid ${tc}33`,
                    borderRadius:4, padding:'2px 7px', fontSize:9, fontWeight:700 }}>T{app.tier}</span>
                </td>
                <td style={{ padding:'10px 10px', color:T.dim }}>{app.owner || '\u2014'}</td>
                <td style={{ padding:'10px 10px', color:T.text, textAlign:'center' }}>{app.changeCount}</td>
                <td style={{ padding:'10px 10px' }}>
                  <span style={{ color:rc, fontWeight:700 }}>{risk.toFixed(1)}</span>
                </td>
                <td style={{ padding:'10px 10px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <div style={{ height:4, width:80, background:T.surface3, borderRadius:2, overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${barW}%`,
                        background: app.maxRisk>=7?T.red:app.maxRisk>=4?T.amber:T.green,
                        borderRadius:2, transition:'width .3s' }}/>
                    </div>
                    <span style={{ color:app.maxRisk>=7?T.red:app.maxRisk>=4?T.amber:T.green,
                      fontWeight:700, minWidth:24 }}>{app.maxRisk}</span>
                  </div>
                </td>
                <td style={{ padding:'10px 10px', textAlign:'center' }}>
                  {app.pendingChanges > 0
                    ? <span style={{ color:T.amber, fontWeight:700 }}>{app.pendingChanges}</span>
                    : <span style={{ color:T.muted }}>\u2014</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function AuditTrail() {
  const { data, loading, error, reload } = useApi('/api/governance/change-audit')
  const [filter, setFilter] = useState('all')
  if (loading) return <Spinner/>
  if (error)   return <ErrMsg msg={error} onRetry={reload}/>
  if (!data?.length) return <EmptyState label="No changes recorded yet"/>
  const filtered = filter === 'all' ? data : data.filter(c => c.status === filter)
  return (
    <div>
      <div style={{ display:'flex', gap:6, marginBottom:14 }}>
        {['all','approved','rejected','draft'].map(f => {
          const c = STATUS_COLOR[f] || T.blue
          return (
            <button key={f} onClick={()=>setFilter(f)} style={{
              ...mono, fontSize:9, fontWeight:700, letterSpacing:'0.08em',
              padding:'4px 10px', borderRadius:5, cursor:'pointer', border:'1px solid',
              textTransform:'uppercase',
              background: filter===f ? c+'22' : 'transparent',
              color:       filter===f ? c : T.muted,
              borderColor: filter===f ? c+'44' : T.border,
            }}>{f}</button>
          )
        })}
        <div style={{ marginLeft:'auto', ...mono, fontSize:9, color:T.muted, alignSelf:'center' }}>
          {filtered.length} records
        </div>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:480, overflowY:'auto' }}>
        {filtered.map((ch, i) => {
          const sc  = STATUS_COLOR[ch.status] || T.muted
          const risk = ch.riskScore || 0
          const rc  = risk >= 7 ? T.red : risk >= 4 ? T.amber : T.green
          return (
            <div key={ch.id||i} style={{ display:'grid',
              gridTemplateColumns:'1fr auto auto auto', gap:10, alignItems:'center',
              padding:'10px 12px', background:T.surface2,
              border:`1px solid ${T.border}`, borderRadius:7 }}>
              <div style={{ minWidth:0 }}>
                <div style={{ ...mono, fontSize:11, color:T.text, fontWeight:600,
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {ch.description || 'No description'}
                </div>
                <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:2 }}>
                  {[
                    ch.submittedBy && `by ${ch.submittedBy}`,
                    ch.approvedBy  && `approved by ${ch.approvedBy}`,
                    ch.rejectedBy  && `rejected by ${ch.rejectedBy}`,
                    ch.affectedApps?.length && `affects: ${ch.affectedApps.join(', ')}`,
                  ].filter(Boolean).join(' \u00b7 ')}
                </div>
              </div>
              <div style={{ ...mono, fontSize:10, color:rc, fontWeight:700,
                background:rc+'12', border:`1px solid ${rc}33`,
                borderRadius:4, padding:'2px 8px', whiteSpace:'nowrap' }}>
                Risk {typeof risk === 'number' ? risk.toFixed(1) : risk}
              </div>
              <span style={{ ...mono, fontSize:8, fontWeight:700, color:sc,
                background:sc+'18', border:`1px solid ${sc}33`,
                borderRadius:3, padding:'2px 7px', letterSpacing:'0.06em',
                textTransform:'uppercase', whiteSpace:'nowrap' }}>{ch.status}</span>
              <div style={{ ...mono, fontSize:9, color:T.muted, whiteSpace:'nowrap' }}>
                {ch.createdAt ? new Date(ch.createdAt).toLocaleDateString('en-GB') : '\u2014'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const POLICIES = [
  'All applications must have a designated owner',
  'High-risk changes (score \u2265 7) require approval before affecting Tier-1 apps',
  'Tier-1 application components must not be on public-facing infrastructure',
  'Tier-1 applications must have at least one recorded deployment',
  'A user cannot submit and approve the same change',
]

export default function GovernancePage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const { data: summary, loading: summaryLoading } = useApi('/api/governance/summary')
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id:'overview',   label:'Overview'      },
    { id:'violations', label:'Policy Checks'  },
    { id:'heatmap',    label:'Risk Heatmap'   },
    { id:'audit',      label:'Audit Trail'    },
  ]

  const cs = summary?.changes        || {}
  const rs = summary?.risk           || {}
  const as = summary?.applications   || {}
  const is = summary?.infrastructure || {}

  const complianceScore = summary
    ? Math.max(0, Math.min(100,
        100
        - (cs.highRiskUnapproved||0) * 10
        - (as.unowned||0) * 8
        - ((cs.approvalRate||100) < 80 ? 10 : 0)
      ))
    : null

  return (
    <div style={{ minHeight:'100vh', background:T.bg, color:T.text,
      fontFamily:'monospace', padding:'28px 32px' }}>

      <div style={{ marginBottom:28 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <div style={{ width:28, height:28, borderRadius:7,
            background:T.purple+'22', border:`1.5px solid ${T.purple}55`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:13, color:T.purple }}>
            &#9878;
          </div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:800, letterSpacing:'-0.02em' }}>
            Governance &amp; Compliance
          </h1>
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <p style={{ margin:0, fontSize:11, color:T.dim }}>
            Policy enforcement, audit trail and risk posture across your infrastructure portfolio.
          </p>
          <div style={{ display:'flex', gap:8 }}>
            <a href="/api/governance/compliance-report/csv" download
              style={{ ...mono, fontSize:10, fontWeight:700,
                color:T.teal, background:T.teal+'18', border:`1px solid ${T.teal}44`,
                borderRadius:7, padding:'7px 14px', textDecoration:'none',
                display:'flex', alignItems:'center', gap:5 }}>
              ↓ CSV
            </a>
            <a href="/api/governance/compliance-report/pdf" target="_blank" rel="noreferrer"
              style={{ ...mono, fontSize:10, fontWeight:700,
                color:T.purple, background:T.purple+'18', border:`1px solid ${T.purple}44`,
                borderRadius:7, padding:'7px 14px', textDecoration:'none',
                display:'flex', alignItems:'center', gap:5 }}>
              ↗ PDF
            </a>
          </div>
        </div>
      </div>

      {!summaryLoading && summary && (
        <div style={{ display:'grid', gridTemplateColumns:'auto 1fr',
          gap:0, marginBottom:24, background:T.surface,
          border:`1px solid ${T.border}`, borderRadius:12, overflow:'hidden' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
            justifyContent:'center', padding:'24px 28px',
            borderRight:`1px solid ${T.border}`, gap:8 }}>
            <ScoreRing score={complianceScore}/>
            <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.12em',
              textAlign:'center', lineHeight:1.6 }}>COMPLIANCE<br/>POSTURE</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)',
            gap:0, padding:'16px' }}>
            {[
              { label:'Approval Rate',       value:`${cs.approvalRate ?? '\u2014'}%`,
                sub:`${cs.approved||0} of ${cs.total||0} changes`,
                color: cs.approvalRate >= 80 ? T.green : T.amber, glow:true },
              { label:'High-Risk Unapproved', value: cs.highRiskUnapproved ?? '\u2014',
                sub:'changes with score \u2265 7',
                color: cs.highRiskUnapproved > 0 ? T.red : T.green,
                glow: cs.highRiskUnapproved > 0 },
              { label:'Avg Risk Score',       value: rs.avgScore ?? '\u2014',
                sub:`max ${rs.maxScore ?? '\u2014'} recorded`,
                color: rs.avgScore >= 6 ? T.red : rs.avgScore >= 3 ? T.amber : T.green },
              { label:'Unowned Apps',         value: as.unowned ?? '\u2014',
                sub:`of ${as.total||0} applications`,
                color: as.unowned > 0 ? T.amber : T.green },
              { label:'Total Changes',        value: cs.total ?? '\u2014',
                sub:`${cs.draft||0} draft \u00b7 ${cs.rejected||0} rejected`,
                color: T.blue },
              { label:'Public Infra',         value: is.publicCount ?? '\u2014',
                sub:`${is.privateCount||0} private resources`,
                color: is.publicCount > 0 ? T.amber : T.green },
              { label:'High-Risk Changes',    value: cs.highRiskTotal ?? '\u2014',
                sub:`${cs.highRiskApproved||0} approved`,
                color: T.purple },
              { label:'Policies Monitored',   value: 5,
                sub:'automated checks active', color: T.teal },
            ].map((s,i) => (
              <div key={i} style={{ padding:'10px 14px',
                borderRight: i%4===3 ? 'none' : `1px solid ${T.border}`,
                borderBottom: i < 4 ? `1px solid ${T.border}` : 'none' }}>
                <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.12em',
                  fontWeight:700, textTransform:'uppercase', marginBottom:4 }}>{s.label}</div>
                <div style={{ ...mono, fontSize:22, fontWeight:800, color:s.color,
                  ...(s.glow ? { textShadow:`0 0 10px ${s.color}` } : {}) }}>{s.value}</div>
                <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:3 }}>{s.sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:4, marginBottom:20,
        background:T.surface, borderRadius:10, padding:4,
        border:`1px solid ${T.border}`, width:'fit-content' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{
            ...mono, fontSize:11, fontWeight: activeTab===t.id ? 700 : 400,
            padding:'7px 16px', borderRadius:7, cursor:'pointer', border:'none',
            background: activeTab===t.id ? T.purple+'28' : 'transparent',
            color:       activeTab===t.id ? T.purple : T.muted,
            outline:     activeTab===t.id ? `1px solid ${T.purple}44` : 'none',
          }}>{t.label}</button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <Section title="Policy Violations" subtitle="Active governance rule breaches">
            <ViolationsPanel/>
          </Section>
          <Section title="Risk Heatmap" subtitle="Applications by change risk exposure">
            <RiskHeatmap/>
          </Section>
        </div>
      )}

      {activeTab === 'violations' && (
        <Section title="Policy Checks"
          subtitle="5 automated policies enforced continuously"
          action={
            <div style={{ display:'flex', flexDirection:'column', gap:5, alignItems:'flex-end' }}>
              {POLICIES.map((p,i) => (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <div style={{ width:5, height:5, borderRadius:'50%',
                    background:T.teal, boxShadow:`0 0 4px ${T.teal}` }}/>
                  <span style={{ ...mono, fontSize:9, color:T.dim }}>{p}</span>
                </div>
              ))}
            </div>
          }>
          <ViolationsPanel/>
        </Section>
      )}

      {activeTab === 'heatmap' && (
        <Section title="Application Risk Heatmap"
          subtitle="Ranked by tier and average change risk score">
          <RiskHeatmap/>
        </Section>
      )}

      {activeTab === 'audit' && (
        <Section title="Change Audit Trail"
          subtitle="Full history with submitters, approvers and affected applications">
          <AuditTrail/>
        </Section>
      )}
    </div>
  )
}
