'use client'

export const dynamic = 'force-dynamic'
import { useState, useEffect, useCallback } from 'react'
import { useTheme, getT } from '@/lib/theme'
import { CustomControlModal } from '@/components/compliance/CustomControlModal'
import { OverrideModal } from '@/components/compliance/OverrideModal'

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

// ── Compliance Panel ───────────────────────────────────────────────────────
// CIS Benchmarks (AWS, Azure, GCP) — select framework, evaluate, view results.
// Each failing control can be expanded to show remediation + blast radius
// preview + a button to generate a draft Change record.

const STATUS_COLOR_CP = {
  PASS: '#22c55e',
  FAIL: '#f43f5e',
  NOT_APPLICABLE: '#64748b',
  MANUAL: '#a78bfa',
}

// ── Tiny inline sparkline (no external deps) ────────────────────────────────
// Draws a 30-day score trend from compliance_runs history. Renders as a solid
// polyline plus a filled area for visual weight. Accepts null scores (shows a
// gap) and degrades gracefully when there's no history yet.
function Sparkline({ points, width = 140, height = 28 }) {
  if (!points || points.length === 0) {
    return (
      <div style={{
        width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        ...mono, fontSize: 8, color: T.dim, fontStyle: 'italic',
      }}>
        no history yet
      </div>
    )
  }
  if (points.length === 1) {
    const s = points[0].score ?? 0
    const color = s >= 80 ? T.green : s >= 60 ? T.amber : T.red
    return (
      <div style={{
        width, height, display: 'flex', alignItems: 'center', gap: 6,
        ...mono, fontSize: 10, color,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%',
          background: color, boxShadow: `0 0 6px ${color}` }} />
        {s}%
      </div>
    )
  }

  const pad = 2
  const scores = points.map(p => p.score ?? 0)
  const min = Math.min(...scores, 0)
  const max = Math.max(...scores, 100)
  const range = max - min || 1
  const step = (width - pad * 2) / (scores.length - 1)
  const toXY = (s, i) => {
    const x = pad + i * step
    const y = height - pad - ((s - min) / range) * (height - pad * 2)
    return [x, y]
  }
  const polyPts = scores.map((s, i) => toXY(s, i).map(v => v.toFixed(1)).join(',')).join(' ')
  // Area polygon: polyline + right/left baseline points
  const [firstX] = toXY(scores[0], 0)
  const [lastX] = toXY(scores[scores.length - 1], scores.length - 1)
  const areaPts = `${firstX},${height - pad} ${polyPts} ${lastX},${height - pad}`

  const latest = scores[scores.length - 1]
  const color = latest >= 80 ? T.green : latest >= 60 ? T.amber : T.red

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polygon points={areaPts} fill={color} fillOpacity="0.15" />
      <polyline fill="none" stroke={color} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" points={polyPts} />
    </svg>
  )
}

function ComplianceScoreCard({ evaluation, history }) {
  const score = evaluation?.score ?? 0
  const coverage = evaluation?.coverage ?? 0
  const pass = evaluation?.counts?.PASS ?? 0
  const fail = evaluation?.counts?.FAIL ?? 0
  const na = evaluation?.counts?.NOT_APPLICABLE ?? 0
  const color = score >= 80 ? T.green : score >= 60 ? T.amber : T.red

  const sev = evaluation?.severityBreakdown || {}

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: T.surface2, border: `1px solid ${T.border}`,
        borderRadius: 12, padding: '16px 14px' }}>
        <div style={{ position: 'relative', width: 120, height: 120 }}>
          <svg width={120} height={120} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={60} cy={60} r={44} fill="none" stroke={T.border2} strokeWidth={8} />
            <circle cx={60} cy={60} r={44} fill="none" stroke={color} strokeWidth={8}
              strokeDasharray={`${(score / 100) * 2 * Math.PI * 44} ${2 * Math.PI * 44}`}
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: 'stroke-dasharray .6s ease' }} />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ ...mono, fontSize: 28, fontWeight: 800, color, lineHeight: 1 }}>{score}</div>
            <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.1em', marginTop: 2 }}>SCORE</div>
          </div>
        </div>
        <div style={{ ...mono, fontSize: 9, color: T.dim, marginTop: 10, textAlign: 'center' }}>
          {pass} pass / {fail} fail / {na} n/a
        </div>
        {/* Phase 5: 30-day score trend below the ring */}
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}`,
          width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.1em',
            fontWeight: 700 }}>
            30-DAY TREND {history?.length ? `\u00B7 ${history.length} runs` : ''}
          </div>
          <Sparkline points={history || []} width={140} height={28} />
        </div>
      </div>

      <div style={{ background: T.surface2, border: `1px solid ${T.border}`,
        borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ ...mono, fontSize: 9, fontWeight: 700, color: T.muted,
          letterSpacing: '0.12em', marginBottom: 10 }}>
          FAILURES BY SEVERITY
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
          {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(s => (
            <div key={s} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ ...mono, fontSize: 20, fontWeight: 800,
                color: sev[s] > 0 ? SEV_COLOR[s] : T.dim }}>
                {sev[s] || 0}
              </div>
              <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.1em',
                fontWeight: 700, marginTop: 2 }}>
                {s}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ ...mono, fontSize: 10, color: T.dim }}>
              Coverage: <span style={{ color: T.text, fontWeight: 700 }}>{coverage}%</span>
              {' '}({pass + fail} of {evaluation?.total || 0} automated)
            </div>
            {na > 0 && (
              <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 3 }}>
                {na} control{na === 1 ? '' : 's'} not applicable — need data enrichment to evaluate
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ControlRow({ control, frameworkId, expanded, onToggle, remediation, onChangeCreated, onOverride, onEditCustom }) {
  const [blastRadius, setBlastRadius] = useState(null)
  const [brLoading, setBrLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [changeResult, setChangeResult] = useState(null)
  const [noRisk, setNoRisk] = useState(false)

  const sc = STATUS_COLOR_CP[control.status] || T.muted
  const sevColor = SEV_COLOR[control.severity] || T.muted
  const statusIcon = control.status === 'PASS' ? '\u2713'
    : control.status === 'FAIL' ? '\u2717'
    : control.status === 'MANUAL' ? '\u2699' : '\u2013'

  // Effective remediation state: server-side record OR freshly created in this session.
  // changeResult from this session takes priority after a successful creation.
  const effectiveChange = changeResult?.ok
    ? { id: changeResult.id, status: changeResult.status || 'draft',
        type: changeResult.type, noRisk: Boolean(changeResult.noRisk), isOpen: true }
    : (remediation?.isOpen ? remediation : null)

  useEffect(() => {
    if (expanded && control.status === 'FAIL' && !blastRadius && !brLoading) {
      setBrLoading(true)
      fetch(`/api/compliance/controls/${frameworkId}/${control.id}/blast-radius`)
        .then(r => r.ok ? r.json() : null)
        .then(setBlastRadius)
        .catch(() => setBlastRadius(null))
        .finally(() => setBrLoading(false))
    }
  }, [expanded, control.status, control.id, frameworkId, blastRadius, brLoading])

  const handleCreateChange = async () => {
    setCreating(true)
    setChangeResult(null)
    try {
      const res = await fetch(`/api/compliance/controls/${frameworkId}/${control.id}/create-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noRisk }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Failed')
      setChangeResult({ ok: true, ...data })
      onChangeCreated?.()
    } catch (err) {
      setChangeResult({ ok: false, error: err.message })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{
      background: T.surface2, border: `1px solid ${T.border}`,
      borderRadius: 8, marginBottom: 6, overflow: 'hidden',
      borderLeft: `3px solid ${sc}`,
    }}>
      {/* Header row (always visible) */}
      <div onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 14px', cursor: 'pointer' }}>
        <span style={{ ...mono, fontSize: 14, color: sc, width: 16, textAlign: 'center' }}>
          {statusIcon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: T.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: T.dim, marginRight: 8 }}>{control.id}</span>
            {control.title}
          </div>
          {control.status === 'FAIL' && control.failCount > 0 && (
            <div style={{ ...mono, fontSize: 9, color: T.dim, marginTop: 2 }}>
              {control.failCount} resource{control.failCount === 1 ? '' : 's'} failing
            </div>
          )}
        </div>
        {effectiveChange && (
          <span title={`Remediation change ${effectiveChange.id} is ${effectiveChange.status}`}
            style={{ ...mono, fontSize: 8, fontWeight: 700,
              color: T.teal, background: `${T.teal}18`,
              border: `1px solid ${T.teal}44`,
              padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em',
              display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%',
              background: T.teal, boxShadow: `0 0 4px ${T.teal}` }} />
            REMEDIATION {String(effectiveChange.status || 'draft').toUpperCase()}
          </span>
        )}
        {control.source === 'custom' && (
          <span title="Custom control (defined via form builder)"
            style={{ ...mono, fontSize: 8, fontWeight: 700,
              color: '#a78bfa', background: '#a78bfa18',
              border: `1px solid #a78bfa44`,
              padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>
            CUSTOM
          </span>
        )}
        {control.override && (
          <span title={control.override.note || 'Overridden locally'}
            style={{ ...mono, fontSize: 8, fontWeight: 700,
              color: '#fbbf24', background: '#fbbf2418',
              border: `1px solid #fbbf2444`,
              padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>
            OVERRIDDEN
          </span>
        )}
        <span style={{ ...mono, fontSize: 8, fontWeight: 700,
          color: sevColor, background: sevColor + '18',
          border: `1px solid ${sevColor}44`,
          padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>
          {control.severity}
        </span>
        {/* Per-row action — override for built-ins, edit for custom */}
        {control.source === 'custom' && onEditCustom ? (
          <button onClick={(e) => { e.stopPropagation(); onEditCustom() }}
            title="Edit custom control"
            style={{ ...mono, fontSize: 10, width: 24, height: 22, borderRadius: 5,
              background: 'transparent', border: `1px solid ${T.border}`,
              color: T.dim, cursor: 'pointer' }}>
            ✎
          </button>
        ) : onOverride ? (
          <button onClick={(e) => { e.stopPropagation(); onOverride() }}
            title={control.override ? 'Edit override' : 'Override this control'}
            style={{ ...mono, fontSize: 10, width: 24, height: 22, borderRadius: 5,
              background: control.override ? '#fbbf2412' : 'transparent',
              border: `1px solid ${control.override ? '#fbbf2444' : T.border}`,
              color: control.override ? '#fbbf24' : T.dim, cursor: 'pointer' }}>
            ⚑
          </button>
        ) : null}
        <span style={{ ...mono, fontSize: 9, color: T.dim, width: 24, textAlign: 'right' }}>
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '14px 18px 16px', borderTop: `1px solid ${T.border}`,
          background: T.surface }}>
          {/* Rationale */}
          {control.rationale && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...mono, fontSize: 8, fontWeight: 700, color: T.muted,
                letterSpacing: '0.12em', marginBottom: 4 }}>RATIONALE</div>
              <div style={{ ...mono, fontSize: 11, color: T.text, lineHeight: 1.5 }}>
                {control.rationale}
              </div>
            </div>
          )}

          {/* Failing resources list */}
          {control.violations?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...mono, fontSize: 8, fontWeight: 700, color: T.muted,
                letterSpacing: '0.12em', marginBottom: 4 }}>
                AFFECTED RESOURCES ({control.violations.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3,
                maxHeight: 150, overflowY: 'auto' }}>
                {control.violations.slice(0, 20).map((v, i) => (
                  <div key={i} style={{ ...mono, fontSize: 10, color: T.dim,
                    padding: '4px 8px', background: T.surface2, borderRadius: 5 }}>
                    <span style={{ color: T.text }}>{v.resourceName || v.resourceId}</span>
                    {v.resourceType && <span style={{ color: T.muted }}> \u00B7 {v.resourceType}</span>}
                    {v.evidence && <span style={{ color: T.dim, marginLeft: 8 }}>({v.evidence})</span>}
                  </div>
                ))}
                {control.violations.length > 20 && (
                  <div style={{ ...mono, fontSize: 9, color: T.muted, padding: 4 }}>
                    +{control.violations.length - 20} more
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Blast radius */}
          {control.status === 'FAIL' && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...mono, fontSize: 8, fontWeight: 700, color: T.amber,
                letterSpacing: '0.12em', marginBottom: 4 }}>
                BLAST RADIUS (IF REMEDIATED)
              </div>
              {brLoading ? (
                <div style={{ ...mono, fontSize: 10, color: T.dim }}>Computing...</div>
              ) : blastRadius ? (
                <div style={{ ...mono, fontSize: 11, color: T.text, lineHeight: 1.6 }}>
                  <div>\u2022 {blastRadius.applications?.length || 0} application{(blastRadius.applications?.length || 0) === 1 ? '' : 's'} affected
                    {blastRadius.applications?.length > 0 && (
                      <span style={{ color: T.dim }}>
                        {' '}({blastRadius.applications.map(a => a.name).slice(0, 3).join(', ')}
                        {blastRadius.applications.length > 3 ? ', ...' : ''})
                      </span>
                    )}
                  </div>
                  <div>\u2022 {blastRadius.components?.length || 0} component{(blastRadius.components?.length || 0) === 1 ? '' : 's'} touched</div>
                  {blastRadius.tier1Count > 0 && (
                    <div style={{ color: T.red, fontWeight: 700 }}>
                      \u2022 Tier-1 exposure: {blastRadius.tier1Count} critical app{blastRadius.tier1Count === 1 ? '' : 's'} \u2014 schedule outside business hours
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ ...mono, fontSize: 10, color: T.dim }}>Unable to compute blast radius.</div>
              )}
            </div>
          )}

          {/* Remediation */}
          {control.remediation && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...mono, fontSize: 8, fontWeight: 700, color: T.teal,
                letterSpacing: '0.12em', marginBottom: 4 }}>REMEDIATION</div>
              {control.remediation.summary && (
                <div style={{ ...mono, fontSize: 11, color: T.text, lineHeight: 1.5, marginBottom: 6 }}>
                  {control.remediation.summary}
                </div>
              )}
              {control.remediation.steps?.length > 0 && (
                <ol style={{ margin: 0, paddingLeft: 20, ...mono, fontSize: 11,
                  color: T.text, lineHeight: 1.6 }}>
                  {control.remediation.steps.map((step, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>{step}</li>
                  ))}
                </ol>
              )}
              {control.remediation.references?.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {control.remediation.references.map((ref, i) => (
                    <a key={i} href={ref} target="_blank" rel="noopener noreferrer"
                      style={{ ...mono, fontSize: 9, color: T.teal, textDecoration: 'none' }}>
                      \u2192 {ref}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          {control.status === 'FAIL' && (
            <div style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: `1px solid ${T.border}`,
              alignItems: 'center', flexWrap: 'wrap' }}>
              {effectiveChange ? (
                <>
                  <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: T.teal,
                    padding: '7px 14px', borderRadius: 6,
                    background: `${T.teal}18`, border: `1px solid ${T.teal}44`,
                    display: 'flex', alignItems: 'center', gap: 6 }}>
                    \u2713 Remediation change {String(effectiveChange.status || 'draft')}
                  </div>
                  {(effectiveChange?.noRisk || effectiveChange?.type === 'compliance-metadata-remediation') && (
                    <span style={{ ...mono, fontSize: 9, fontWeight: 700,
                      color: T.purple, background: `${T.purple}18`,
                      border: `1px solid ${T.purple}44`,
                      padding: '3px 8px', borderRadius: 4, letterSpacing: '0.06em' }}>
                      NO RISK
                    </span>
                  )}
                  <a href="/changes"
                    style={{ ...mono, fontSize: 10, color: T.teal,
                      textDecoration: 'none', padding: '7px 0' }}>
                    View on Changes page \u2192
                  </a>
                </>
              ) : (
                <>
                  <button onClick={handleCreateChange} disabled={creating}
                    style={{ ...mono, fontSize: 10, fontWeight: 700,
                      padding: '7px 14px', borderRadius: 6,
                      background: noRisk ? `${T.purple}22` : `${T.teal}22`,
                      border: `1px solid ${noRisk ? T.purple : T.teal}44`,
                      color: noRisk ? T.purple : T.teal,
                      cursor: creating ? 'wait' : 'pointer' }}>
                    {creating ? 'Creating...'
                      : noRisk ? '\u25B6 Create Change (no risk)'
                      : '\u25B6 Create Change'}
                  </button>
                  {/* No-risk / metadata-only toggle */}
                  <label title="For metadata-only fixes (tags, ownership, classification) that don't modify infrastructure. Sets risk score to 1 and skips Tier-1 risk bump."
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                      padding: '5px 10px', borderRadius: 6,
                      background: noRisk ? `${T.purple}15` : T.surface2,
                      border: `1px solid ${noRisk ? T.purple + '44' : T.border}` }}>
                    <input type="checkbox" checked={noRisk}
                      onChange={e => setNoRisk(e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: T.purple, margin: 0 }} />
                    <span style={{ ...mono, fontSize: 10,
                      color: noRisk ? T.purple : T.dim, fontWeight: 600 }}>
                      No risk / metadata only
                    </span>
                  </label>
                  {changeResult?.error && (
                    <span style={{ ...mono, fontSize: 10, color: T.red }}>
                      {changeResult.error}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {control.status === 'NOT_APPLICABLE' && control.error && (
            <div style={{ ...mono, fontSize: 10, color: T.dim, fontStyle: 'italic' }}>
              Not evaluated: {control.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ScheduleBar() {
  const [schedule, setSchedule] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    fetch('/api/compliance/schedule').then(r => r.ok ? r.json() : null).then(setSchedule).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const update = async (fields) => {
    setSaving(true)
    try {
      const res = await fetch('/api/compliance/schedule', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (res.ok) setSchedule(await res.json())
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    await fetch('/api/compliance/schedule/run-now', { method: 'POST' })
    // Reload schedule after a short delay to pick up the new last-run time
    setTimeout(load, 2500)
  }

  if (!schedule) return null
  const enabled = schedule.enabled
  const interval = schedule.interval_mins || 60
  const last = schedule.last_run_at
  const next = schedule.next_run_at

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
      padding: '10px 14px', borderRadius: 10,
      background: enabled ? `${T.teal}0a` : T.surface2,
      border: `1px solid ${enabled ? T.teal + '33' : T.border}`,
      flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%',
          background: enabled ? T.teal : T.dim,
          boxShadow: enabled ? `0 0 8px ${T.teal}` : 'none' }} />
        <span style={{ ...mono, fontSize: 10, fontWeight: 700,
          color: enabled ? T.teal : T.muted, letterSpacing: '0.06em' }}>
          AUTO-SCAN {enabled ? 'ON' : 'OFF'}
        </span>
      </div>

      <button onClick={() => update({ enabled: !enabled })} disabled={saving}
        style={{ ...mono, fontSize: 10, padding: '5px 12px', borderRadius: 6,
          background: enabled ? `${T.red}12` : `${T.teal}22`,
          border: `1px solid ${enabled ? T.red + '33' : T.teal + '44'}`,
          color: enabled ? T.red : T.teal,
          cursor: saving ? 'wait' : 'pointer', fontWeight: 700 }}>
        {enabled ? 'Disable' : 'Enable'}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...mono, fontSize: 10, color: T.dim }}>every</span>
        <select value={interval} onChange={e => update({ interval_mins: Number(e.target.value) })}
          disabled={saving}
          style={{ ...mono, fontSize: 10, padding: '4px 8px',
            background: T.surface, color: T.text,
            border: `1px solid ${T.border}`, borderRadius: 5, cursor: 'pointer' }}>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>1 hour</option>
          <option value={180}>3 hours</option>
          <option value={360}>6 hours</option>
          <option value={720}>12 hours</option>
          <option value={1440}>24 hours</option>
        </select>
      </div>

      <button onClick={runNow}
        style={{ ...mono, fontSize: 10, padding: '5px 12px', borderRadius: 6,
          background: `${T.purple}18`, border: `1px solid ${T.purple}44`,
          color: T.purple, cursor: 'pointer', fontWeight: 700 }}>
        Run now
      </button>

      <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column',
        alignItems: 'flex-end', gap: 2 }}>
        {last && (
          <span style={{ ...mono, fontSize: 9, color: T.dim }}>
            Last: {new Date(last).toLocaleString()}
            {schedule.last_run_status && (
              <span style={{ color: schedule.last_run_status === 'success' ? T.green : schedule.last_run_status === 'error' ? T.red : T.amber,
                marginLeft: 6 }}>
                [{schedule.last_run_status}]
              </span>
            )}
          </span>
        )}
        {enabled && next && (
          <span style={{ ...mono, fontSize: 9, color: T.muted }}>
            Next: {new Date(next).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}

function CompliancePanel() {
  const [frameworks, setFrameworks] = useState([])
  const [selected, setSelected] = useState(null)
  const [evaluation, setEvaluation] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [filter, setFilter] = useState('all')
  // Map of controlId -> latest remediation Change (null if none)
  const [remediation, setRemediation] = useState({})
  const [reseeding, setReseeding] = useState(false)
  const [reseedResult, setReseedResult] = useState(null)

  // Phase B: CRUD modals
  const [customModalOpen, setCustomModalOpen] = useState(false)
  const [customEditing, setCustomEditing] = useState(null)
  const [overrideModalFor, setOverrideModalFor] = useState(null)

  // Phase 5: score history for the sparkline next to the framework selector
  const [history, setHistory] = useState([])

  const loadFrameworkList = useCallback(() => {
    return fetch('/api/compliance/frameworks')
      .then(r => r.ok ? r.json() : [])
      .then(list => {
        setFrameworks(list)
        if (list.length > 0 && !selected) setSelected(list[0].id)
        return list
      })
      .catch(() => setFrameworks([]))
  }, [selected])

  // Load framework list
  useEffect(() => { loadFrameworkList() }, [])

  // Re-sync built-in CIS frameworks from the API's JSON files. Overwrites
  // built-in control definitions server-side; never touches custom controls
  // or overrides. Refreshes the framework list + re-evaluates the current
  // framework so the UI reflects the new definitions immediately.
  const handleReseedBuiltins = async () => {
    if (reseeding) return
    setReseeding(true)
    setReseedResult(null)
    try {
      const res = await fetch('/api/compliance/frameworks/reseed-builtins', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Reseed failed')
      const total = (data.frameworks || []).reduce(
        (acc, f) => ({
          inserted: acc.inserted + (f.inserted || 0),
          updated:  acc.updated  + (f.updated  || 0),
          softDeleted: acc.softDeleted + (f.softDeleted || 0),
          errors: acc.errors + (f.error ? 1 : 0),
        }),
        { inserted: 0, updated: 0, softDeleted: 0, errors: 0 },
      )
      setReseedResult({ ok: true, ...total })
      await loadFrameworkList()
      if (selected) runEvaluation(selected)
      setTimeout(() => setReseedResult(null), 4500)
    } catch (err) {
      setReseedResult({ ok: false, error: err.message })
      setTimeout(() => setReseedResult(null), 4500)
    } finally {
      setReseeding(false)
    }
  }

  const loadRemediation = useCallback((frameworkId) => {
    if (!frameworkId) return
    fetch(`/api/compliance/frameworks/${frameworkId}/remediation-status`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setRemediation(d?.byControl || {}))
      .catch(() => setRemediation({}))
  }, [])

  // Evaluate on framework change
  const runEvaluation = useCallback((frameworkId) => {
    if (!frameworkId) return
    setLoading(true)
    setEvaluation(null)
    Promise.all([
      fetch(`/api/compliance/frameworks/${frameworkId}/evaluate`, { method: 'POST' })
        .then(r => r.ok ? r.json() : null),
      fetch(`/api/compliance/frameworks/${frameworkId}/remediation-status`)
        .then(r => r.ok ? r.json() : null),
      fetch(`/api/compliance/frameworks/${frameworkId}/history?days=30`)
        .then(r => r.ok ? r.json() : null),
    ])
      .then(([evalData, remData, histData]) => {
        setEvaluation(evalData)
        setRemediation(remData?.byControl || {})
        setHistory(histData?.points || [])
      })
      .catch(() => setEvaluation(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (selected) runEvaluation(selected)
  }, [selected, runEvaluation])

  const controls = evaluation?.controls || []
  const filtered = filter === 'all' ? controls
    : filter === 'failing' ? controls.filter(c => c.status === 'FAIL')
    : filter === 'passing' ? controls.filter(c => c.status === 'PASS')
    : controls.filter(c => c.status === 'NOT_APPLICABLE' || c.status === 'MANUAL')

  // Group by section
  const bySection = {}
  for (const c of filtered) {
    const key = c.section || 'Other'
    if (!bySection[key]) bySection[key] = { title: c.sectionTitle || key, controls: [] }
    bySection[key].controls.push(c)
  }

  const FILTER_TABS = [
    { id: 'all', label: 'All' },
    { id: 'failing', label: 'Failing' },
    { id: 'passing', label: 'Passing' },
    { id: 'other', label: 'Manual / N/A' },
  ]

  return (
    <div>
      {/* Top row: framework selector + re-evaluate */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        flexWrap: 'wrap' }}>
        <div style={{ ...mono, fontSize: 10, color: T.muted, letterSpacing: '0.1em',
          fontWeight: 700 }}>FRAMEWORK:</div>
        <select value={selected || ''} onChange={e => setSelected(e.target.value)}
          style={{ ...mono, fontSize: 11, padding: '7px 12px',
            background: T.surface2, color: T.text,
            border: `1px solid ${T.border}`, borderRadius: 7,
            cursor: 'pointer', outline: 'none' }}>
          {frameworks.map(fw => (
            <option key={fw.id} value={fw.id}>
              {fw.name} v{fw.version} ({fw.controlCount} controls)
            </option>
          ))}
        </select>
        <button onClick={() => runEvaluation(selected)} disabled={loading || !selected}
          style={{ ...mono, fontSize: 10, fontWeight: 700,
            padding: '7px 14px', borderRadius: 7,
            background: loading ? T.surface2 : `${T.teal}22`,
            border: `1px solid ${loading ? T.border : T.teal + '44'}`,
            color: loading ? T.dim : T.teal,
            cursor: loading ? 'wait' : 'pointer' }}>
          {loading ? 'Evaluating...' : '\u21BB Re-evaluate'}
        </button>
        <button onClick={handleReseedBuiltins} disabled={reseeding}
          title="Re-sync built-in CIS framework definitions from the server's JSON files. Custom controls and overrides are preserved."
          style={{ ...mono, fontSize: 10, fontWeight: 700,
            padding: '7px 14px', borderRadius: 7,
            background: reseeding ? T.surface2 : `${T.purple}18`,
            border: `1px solid ${reseeding ? T.border : T.purple + '44'}`,
            color: reseeding ? T.dim : T.purple,
            cursor: reseeding ? 'wait' : 'pointer' }}>
          {reseeding ? 'Syncing...' : '\u2630 Re-sync built-ins'}
        </button>
        <button onClick={() => { setCustomEditing(null); setCustomModalOpen(true) }}
          title="Add a custom compliance rule using the form builder"
          style={{ ...mono, fontSize: 10, fontWeight: 700,
            padding: '7px 14px', borderRadius: 7,
            background: '#a78bfa22', border: `1px solid #a78bfa44`,
            color: '#a78bfa', cursor: 'pointer' }}>
          + New Custom Control
        </button>
        {/* Phase 5 — export buttons */}
        <a href={selected ? `/api/compliance/frameworks/${selected}/export.csv` : '#'}
          download
          title="Download per-control CSV (pass/fail + evidence)"
          onClick={e => { if (!selected) e.preventDefault() }}
          style={{ ...mono, fontSize: 10, fontWeight: 700,
            padding: '7px 14px', borderRadius: 7,
            background: T.surface2, border: `1px solid ${T.border}`,
            color: selected ? T.dim : T.border,
            cursor: selected ? 'pointer' : 'not-allowed',
            textDecoration: 'none' }}>
          ↓ CSV
        </a>
        <a href={selected ? `/api/compliance/frameworks/${selected}/export.pdf` : '#'}
          target="_blank" rel="noopener noreferrer"
          title="Open auditor-ready report (print to PDF from the new tab)"
          onClick={e => { if (!selected) e.preventDefault() }}
          style={{ ...mono, fontSize: 10, fontWeight: 700,
            padding: '7px 14px', borderRadius: 7,
            background: T.surface2, border: `1px solid ${T.border}`,
            color: selected ? T.dim : T.border,
            cursor: selected ? 'pointer' : 'not-allowed',
            textDecoration: 'none' }}>
          ↗ PDF
        </a>
        {reseedResult && (
          <span style={{ ...mono, fontSize: 9,
            color: reseedResult.ok ? T.green : T.red,
            padding: '4px 10px', borderRadius: 5,
            background: reseedResult.ok ? `${T.green}10` : `${T.red}10`,
            border: `1px solid ${reseedResult.ok ? T.green + '33' : T.red + '33'}` }}>
            {reseedResult.ok
              ? `\u2713 Reseeded \u00B7 ${reseedResult.inserted} inserted, ${reseedResult.updated} updated${reseedResult.softDeleted ? ', ' + reseedResult.softDeleted + ' soft-deleted' : ''}${reseedResult.errors ? ', ' + reseedResult.errors + ' error(s)' : ''}`
              : `\u2717 ${reseedResult.error}`}
          </span>
        )}
        {evaluation?.completedAt && (
          <div style={{ ...mono, fontSize: 9, color: T.dim, marginLeft: 'auto' }}>
            Last run: {new Date(evaluation.completedAt).toLocaleString()}
          </div>
        )}
      </div>

      <ScheduleBar />

      {!evaluation && loading && (
        <div style={{ ...mono, fontSize: 11, color: T.muted, padding: '20px 0', textAlign: 'center' }}>
          Evaluating controls...
        </div>
      )}

      {evaluation && (
        <>
          <ComplianceScoreCard evaluation={evaluation} history={history} />

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 14,
            background: T.surface, borderRadius: 8, padding: 3,
            border: `1px solid ${T.border}`, width: 'fit-content' }}>
            {FILTER_TABS.map(f => {
              const count = f.id === 'all' ? controls.length
                : f.id === 'failing' ? controls.filter(c => c.status === 'FAIL').length
                : f.id === 'passing' ? controls.filter(c => c.status === 'PASS').length
                : controls.filter(c => c.status === 'NOT_APPLICABLE' || c.status === 'MANUAL').length
              const active = filter === f.id
              return (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  style={{ ...mono, fontSize: 10, fontWeight: active ? 700 : 400,
                    padding: '6px 12px', borderRadius: 6, cursor: 'pointer', border: 'none',
                    background: active ? T.purple + '28' : 'transparent',
                    color: active ? T.purple : T.muted }}>
                  {f.label} <span style={{ opacity: 0.6 }}>\u00B7 {count}</span>
                </button>
              )
            })}
          </div>

          {/* Controls grouped by section */}
          {Object.keys(bySection).sort().map(sectionKey => {
            const section = bySection[sectionKey]
            const passCount = section.controls.filter(c => c.status === 'PASS').length
            return (
              <div key={sectionKey} style={{ marginBottom: 16 }}>
                <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: T.muted,
                  letterSpacing: '0.1em', marginBottom: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>SECTION {sectionKey} \u2014 {section.title.toUpperCase()}</span>
                  <span style={{ color: T.dim, fontSize: 9 }}>
                    {passCount}/{section.controls.length} pass
                  </span>
                </div>
                {section.controls.map(c => (
                  <ControlRow key={c.id} control={c} frameworkId={selected}
                    remediation={remediation[c.id] || null}
                    onChangeCreated={() => loadRemediation(selected)}
                    onOverride={() => setOverrideModalFor(c)}
                    onEditCustom={() => {
                      setCustomEditing({ ...c, benchmarkId: selected })
                      setCustomModalOpen(true)
                    }}
                    expanded={expandedId === c.id}
                    onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)} />
                ))}
              </div>
            )
          })}

          {filtered.length === 0 && (
            <div style={{ ...mono, fontSize: 11, color: T.muted, padding: '20px 0', textAlign: 'center' }}>
              No controls match this filter.
            </div>
          )}
        </>
      )}

      {customModalOpen && (
        <CustomControlModal
          benchmarks={frameworks}
          initialFrameworkId={selected}
          editing={customEditing}
          onClose={() => { setCustomModalOpen(false); setCustomEditing(null) }}
          onSaved={async ({ frameworkId }) => {
            await loadFrameworkList()
            if (frameworkId && frameworkId !== selected) setSelected(frameworkId)
            else if (selected) runEvaluation(selected)
          }}
        />
      )}

      {overrideModalFor && (
        <OverrideModal
          control={overrideModalFor}
          frameworkId={selected}
          onClose={() => setOverrideModalFor(null)}
          onSaved={() => { if (selected) runEvaluation(selected) }}
        />
      )}
    </div>
  )
}

export default function GovernancePage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const { data: summary, loading: summaryLoading } = useApi('/api/governance/summary')
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id:'overview',   label:'Overview'      },
    { id:'violations', label:'Policy Checks'  },
    { id:'compliance', label:'Compliance'     },
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

      {activeTab === 'compliance' && (
        <Section title="Compliance Frameworks"
          subtitle="CIS Benchmarks with remediation and blast-radius preview">
          <CompliancePanel/>
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
