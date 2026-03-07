'use client'
import { useState, useEffect, useCallback } from 'react'

const T = {
  bg:'#04080f', surface:'#080f1a', surface2:'#0d1626', surface3:'#111d2e',
  border:'#0f1f35', border2:'#1e293b', text:'#f1f5f9', muted:'#334155', dim:'#64748b',
  green:'#22c55e', blue:'#38bdf8', amber:'#f59e0b', red:'#f43f5e',
  purple:'#a78bfa', teal:'#2dd4bf', orange:'#fb923c',
}
const mono = { fontFamily:'monospace' }
const TIER_COLOR  = { 1:'#f43f5e', 2:'#f59e0b', 3:'#22c55e', 4:'#334155' }
const STEP_COLOR  = { complete:'#22c55e', active:'#38bdf8', failed:'#f43f5e',
                      required:'#f59e0b', optional:'#334155', pending:'#1e293b' }
const STATUS_COLOR = { approved:T.green, rejected:T.red, draft:T.amber,
                       deployed:T.blue, blocked:T.red }

// ── shared helpers ────────────────────────────────────────────────────────────
function useApi(url, deps=[]) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const load = useCallback(() => {
    if (!url) return
    setLoading(true); setError(null)
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(setData).catch(e => setError(e.message))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps])
  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
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
function Err({ msg, onRetry }) {
  return (
    <div style={{ textAlign:'center', padding:'20px' }}>
      <div style={{ ...mono, fontSize:11, color:T.red, marginBottom:8 }}>Error: {msg}</div>
      {onRetry && <button onClick={onRetry} style={{ ...mono, fontSize:10, color:T.teal,
        background:'transparent', border:`1px solid ${T.teal}44`, borderRadius:5,
        padding:'4px 12px', cursor:'pointer' }}>Retry</button>}
    </div>
  )
}
function Empty({ label }) {
  return <div style={{ ...mono, fontSize:11, color:T.muted, textAlign:'center', padding:'24px 0' }}>{label}</div>
}

// ── Step pipeline visualiser ──────────────────────────────────────────────────
function StepPipeline({ steps, compact = false }) {
  if (!steps?.length) return null
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, overflowX:'auto',
      paddingBottom: compact ? 0 : 4 }}>
      {steps.map((s, i) => {
        const sc = STEP_COLOR[s.status] || T.muted
        const isLast = i === steps.length - 1
        return (
          <div key={s.key || i} style={{ display:'flex', alignItems:'center', flexShrink:0 }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              {/* Node */}
              <div style={{ width: compact?22:28, height: compact?22:28, borderRadius:'50%',
                background: sc+'22', border:`2px solid ${sc}`,
                display:'flex', alignItems:'center', justifyContent:'center',
                boxShadow: s.status==='active' ? `0 0 10px ${sc}` : 'none',
                transition:'all .2s' }}>
                <span style={{ fontSize: compact?8:10, color:sc }}>
                  {s.status==='complete' ? '✓' : s.status==='failed' ? '✗' :
                   s.status==='active'   ? '●' : s.order}
                </span>
              </div>
              {/* Label */}
              {!compact && (
                <div style={{ ...mono, fontSize:8, color:sc, whiteSpace:'nowrap',
                  letterSpacing:'0.04em', maxWidth:64, textAlign:'center',
                  overflow:'hidden', textOverflow:'ellipsis' }}>{s.label}</div>
              )}
            </div>
            {/* Connector */}
            {!isLast && (
              <div style={{ width: compact?16:24, height:2, flexShrink:0,
                background: s.status==='complete' ? T.green+'66' : T.border2,
                margin: compact?'0 0 0 0':'0 0 14px 0' }}/>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────
function WorkflowSummary({ data }) {
  if (!data) return null
  const cards = [
    { label:'Change Lifecycle', icon:'⟳', color:T.blue,
      stats:[
        { k:'Total Changes',  v:data.changeLcm?.total    },
        { k:'In Draft',       v:data.changeLcm?.draft,    alert: data.changeLcm?.draft > 0 },
        { k:'Blocked',        v:data.changeLcm?.blocked,  alert: data.changeLcm?.blocked > 0 },
      ]},
    { label:'App Onboarding', icon:'◈', color:T.teal,
      stats:[
        { k:'Total Apps',     v:data.onboarding?.total   },
        { k:'Complete',       v:data.onboarding?.complete },
        { k:'Pending',        v:data.onboarding?.pending, alert: data.onboarding?.pending > 0 },
      ]},
    { label:'Drift Detection', icon:'⬡', color:T.amber,
      stats:[
        { k:'TF Resources',   v:data.drift?.total        },
        { k:'Unmapped',       v:data.drift?.unmapped,     alert: data.drift?.unmapped > 0 },
      ]},
  ]
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:24 }}>
      {cards.map(card => (
        <div key={card.label} style={{ background:T.surface, border:`1px solid ${T.border}`,
          borderRadius:12, padding:'16px 18px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
            <div style={{ width:26, height:26, borderRadius:6,
              background:card.color+'20', border:`1px solid ${card.color}44`,
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:12, color:card.color }}>{card.icon}</div>
            <span style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>{card.label}</span>
          </div>
          <div style={{ display:'flex', gap:10 }}>
            {card.stats.map(s => (
              <div key={s.k} style={{ flex:1 }}>
                <div style={{ ...mono, fontSize:18, fontWeight:800,
                  color: s.alert ? T.amber : T.text }}>{s.v ?? '—'}</div>
                <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.08em',
                  marginTop:2 }}>{s.k.toUpperCase()}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── CHANGE LIFECYCLE TAB ──────────────────────────────────────────────────────
function ChangeLcmTab() {
  const { data, loading, error, reload } = useApi('/api/workflows/changes')
  const [selected, setSelected] = useState(null)
  const [advancing, setAdvancing] = useState(false)

  const advance = async (id, action, note='') => {
    setAdvancing(true)
    try {
      const res = await fetch(`/api/workflows/changes/${id}/advance`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ action, note, userId:'system' }),
      })
      const result = await res.json()
      reload()
      if (selected?.id === id) {
        const updated = await fetch(`/api/workflows/changes/${id}`).then(r=>r.json())
        setSelected(updated)
      }
      return result
    } finally { setAdvancing(false) }
  }

  if (loading) return <Spinner/>
  if (error)   return <Err msg={error} onRetry={reload}/>
  if (!data?.length) return <Empty label="No changes found. Create a change to start a lifecycle workflow."/>

  const ACTIONS = {
    policy_check: [{ action:'pass_policy',   label:'Run Policy Check', color:T.blue }],
    review:       [{ action:'submit_review', label:'Mark Reviewed',    color:T.teal }],
    approval:     [{ action:'approve',       label:'Approve',          color:T.green },
                   { action:'reject',        label:'Reject',           color:T.red }],
    scheduled:    [{ action:'schedule',      label:'Mark Scheduled',   color:T.blue }],
    deployed:     [{ action:'deploy',        label:'Mark Deployed',    color:T.green }],
    verified:     [{ action:'verify',        label:'Mark Verified',    color:T.teal }],
  }

  return (
    <div style={{ display:'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', gap:14 }}>
      {/* List */}
      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {data.map(ch => {
          const sc = STATUS_COLOR[ch.blocked ? 'blocked' : ch.status] || T.muted
          const tc = TIER_COLOR[ch.affectedApps?.[0]?.tier] || T.muted
          const isSelected = selected?.id === ch.id
          return (
            <div key={ch.id} onClick={() => setSelected(isSelected ? null : ch)}
              style={{ padding:'12px 14px', background: isSelected ? T.surface2 : T.surface,
                border:`1px solid ${isSelected ? T.blue+'66' : T.border}`,
                borderRadius:10, cursor:'pointer', transition:'all .15s' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {ch.description || 'Untitled change'}
                  </div>
                  <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:2 }}>
                    {ch.submittedBy ? `by ${ch.submittedBy}` : ''}
                    {ch.affectedApps?.length ? ` · ${ch.affectedApps.map(a=>a.name).join(', ')}` : ''}
                  </div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                  {ch.blocked && (
                    <span style={{ ...mono, fontSize:8, fontWeight:700, color:T.red,
                      background:T.red+'18', border:`1px solid ${T.red}33`,
                      borderRadius:3, padding:'1px 6px' }}>BLOCKED</span>
                  )}
                  <span style={{ ...mono, fontSize:8, fontWeight:700, color:sc,
                    background:sc+'18', border:`1px solid ${sc}33`,
                    borderRadius:3, padding:'1px 6px', letterSpacing:'0.06em',
                    textTransform:'uppercase' }}>{ch.status}</span>
                  <span style={{ ...mono, fontSize:10, color:T.amber, fontWeight:700 }}>
                    R{ch.riskScore?.toFixed ? ch.riskScore.toFixed(1) : ch.riskScore}
                  </span>
                </div>
              </div>
              <StepPipeline steps={ch.workflowSteps} compact/>
            </div>
          )
        })}
      </div>

      {/* Detail panel */}
      {selected && (
        <DetailPanel title={selected.description || 'Change'} onClose={() => setSelected(null)}>
          <ChangeDetail ch={selected} onAdvance={advance} advancing={advancing}
            actions={ACTIONS[selected.currentStep] || []}/>
        </DetailPanel>
      )}
    </div>
  )
}

function ChangeDetail({ ch, onAdvance, advancing, actions }) {
  const { data: detail } = useApi(`/api/workflows/changes/${ch.id}`)
  const d = detail || ch
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* Policy check result */}
      {d.policyCheck && (
        <div style={{ padding:'10px 12px', borderRadius:8,
          background: d.policyCheck.passed ? T.green+'0a' : T.red+'0a',
          border:`1px solid ${d.policyCheck.passed ? T.green+'44' : T.red+'44'}` }}>
          <div style={{ ...mono, fontSize:10, fontWeight:700,
            color: d.policyCheck.passed ? T.green : T.red, marginBottom:4 }}>
            {d.policyCheck.passed ? '✓ Policy Check Passed' : '✗ Policy Violations'}
          </div>
          {d.policyCheck.issues?.map((issue,i) => (
            <div key={i} style={{ ...mono, fontSize:9, color:T.red }}>· {issue}</div>
          ))}
          <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:4 }}>
            Risk score: {d.policyCheck.riskScore} · Tiers: {d.policyCheck.affectedTiers?.join(', ')||'—'}
          </div>
        </div>
      )}
      {/* Full step pipeline */}
      {d.workflowSteps && (
        <div>
          <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.1em',
            fontWeight:700, marginBottom:10 }}>WORKFLOW STEPS</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {d.workflowSteps.map(s => {
              const sc = STEP_COLOR[s.status] || T.muted
              return (
                <div key={s.key} style={{ display:'flex', alignItems:'flex-start', gap:10,
                  padding:'8px 10px', background:T.surface2,
                  border:`1px solid ${sc}33`, borderRadius:7 }}>
                  <div style={{ width:20, height:20, borderRadius:'50%', flexShrink:0,
                    background:sc+'22', border:`1.5px solid ${sc}`,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:9, color:sc, marginTop:1 }}>
                    {s.status==='complete'?'✓':s.status==='failed'?'✗':
                     s.status==='active'?'●':s.order}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ ...mono, fontSize:10, fontWeight:700, color:T.text }}>{s.label}</div>
                    <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:2 }}>{s.description}</div>
                    {s.integrationRequired && (
                      <div style={{ ...mono, fontSize:8, color:T.purple, marginTop:3 }}>
                        Requires: {s.integrationRequired}
                      </div>
                    )}
                  </div>
                  <span style={{ ...mono, fontSize:8, fontWeight:700, color:sc,
                    background:sc+'18', borderRadius:3, padding:'1px 6px',
                    letterSpacing:'0.06em', flexShrink:0, marginTop:1 }}>
                    {s.status.toUpperCase()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {/* Actions */}
      {actions.length > 0 && (
        <div style={{ display:'flex', gap:8, paddingTop:4 }}>
          {actions.map(a => (
            <button key={a.action} disabled={advancing}
              onClick={() => onAdvance(ch.id, a.action)}
              style={{ ...mono, fontSize:11, fontWeight:700, flex:1,
                padding:'9px 14px', borderRadius:8, cursor:'pointer',
                background:a.color+'22', border:`1px solid ${a.color}66`,
                color:a.color, opacity: advancing ? .5 : 1 }}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── ONBOARDING TAB ────────────────────────────────────────────────────────────
function OnboardingTab() {
  const { data, loading, error, reload } = useApi('/api/workflows/onboarding')
  const [selected, setSelected] = useState(null)
  const [filter,   setFilter]   = useState('all')

  if (loading) return <Spinner/>
  if (error)   return <Err msg={error} onRetry={reload}/>
  if (!data?.length) return <Empty label="No applications found."/>

  const filtered = filter === 'all'      ? data
                 : filter === 'complete'  ? data.filter(a => a.complete)
                 : data.filter(a => !a.complete)

  return (
    <div style={{ display:'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', gap:14 }}>
      <div>
        {/* Filter row */}
        <div style={{ display:'flex', gap:6, marginBottom:12 }}>
          {['all','pending','complete'].map(f => (
            <button key={f} onClick={()=>setFilter(f)} style={{
              ...mono, fontSize:9, fontWeight:700, letterSpacing:'0.08em',
              padding:'4px 12px', borderRadius:5, cursor:'pointer',
              textTransform:'uppercase', border:'1px solid',
              background: filter===f ? T.teal+'22' : 'transparent',
              color:       filter===f ? T.teal : T.muted,
              borderColor: filter===f ? T.teal+'44' : T.border,
            }}>{f} ({f==='all'?data.length:f==='complete'?data.filter(a=>a.complete).length:data.filter(a=>!a.complete).length})</button>
          ))}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {filtered.map(app => {
            const tc = TIER_COLOR[app.tier] || T.muted
            const pct = app.completionPct || 0
            const pc = pct===100 ? T.green : pct >= 60 ? T.amber : T.red
            const isSelected = selected?.id === app.id
            return (
              <div key={app.id} onClick={() => setSelected(isSelected ? null : app)}
                style={{ padding:'12px 14px', background: isSelected?T.surface2:T.surface,
                  border:`1px solid ${isSelected?T.teal+'66':T.border}`,
                  borderRadius:10, cursor:'pointer', transition:'all .15s' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                      <span style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>{app.name}</span>
                      <span style={{ ...mono, fontSize:9, color:tc, background:tc+'18',
                        border:`1px solid ${tc}33`, borderRadius:3, padding:'1px 6px',
                        fontWeight:700 }}>T{app.tier}</span>
                      {app.domain && <span style={{ ...mono, fontSize:9, color:T.dim }}>·  {app.domain}</span>}
                    </div>
                    <div style={{ ...mono, fontSize:9, color:T.dim }}>
                      {app.owner||'No owner'} · {app.environment}
                      {app.availability ? ` · ${app.availability}%` : ''}
                      {app.confidentiality ? ` · ${app.confidentiality}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ ...mono, fontSize:16, fontWeight:800, color:pc }}>{pct}%</div>
                    <div style={{ ...mono, fontSize:8, color:T.muted }}>COMPLETE</div>
                  </div>
                </div>
                {/* Progress bar */}
                <div style={{ height:3, background:T.border2, borderRadius:2, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${pct}%`,
                    background: pc, borderRadius:2, transition:'width .4s' }}/>
                </div>
                {/* Step dots */}
                <div style={{ display:'flex', gap:4, marginTop:8 }}>
                  {Object.entries(app.stepStatus||{}).map(([key, s]) => (
                    <div key={key} title={key} style={{ width:8, height:8, borderRadius:'50%',
                      background: s.done ? T.green : T.border2,
                      border:`1px solid ${s.done ? T.green : T.border}` }}/>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <DetailPanel title={selected.name} onClose={() => setSelected(null)}>
          <OnboardingDetail app={selected} onRefresh={reload}/>
        </DetailPanel>
      )}
    </div>
  )
}

function OnboardingDetail({ app, onRefresh }) {
  const { data } = useApi(`/api/workflows/onboarding/${app.id}`)
  const d = data || app

  const completeStep = async (step) => {
    await fetch(`/api/workflows/onboarding/${app.id}/complete-step`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ step })
    })
    onRefresh()
  }

  const steps = d.steps || Object.entries(d.stepStatus||{}).map(([k,v],i) => ({
    key:k, label:k, order:i+1, status: v.done?'complete':'pending', note:v.note,
    blocking: ['owner','classification','component'].includes(k)
  }))

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Classification summary */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        {[
          { label:'Availability', value:app.availability, required:true },
          { label:'Confidentiality', value:app.confidentiality, required:true },
          { label:'Domain', value:app.domain, required:false },
          { label:'Owner', value:app.owner, required:true },
        ].map(f => (
          <div key={f.label} style={{ padding:'8px 10px', background:T.surface2,
            border:`1px solid ${f.value ? T.border : f.required ? T.red+'33' : T.border}`,
            borderRadius:7 }}>
            <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.1em',
              marginBottom:3 }}>{f.label.toUpperCase()}{f.required?' ✱':''}</div>
            <div style={{ ...mono, fontSize:11, fontWeight:700,
              color: f.value ? T.text : f.required ? T.red : T.muted }}>
              {f.value || (f.required ? 'Required' : 'Not set')}
            </div>
          </div>
        ))}
      </div>

      {/* Steps */}
      <div>
        <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.1em',
          fontWeight:700, marginBottom:8 }}>ONBOARDING STEPS</div>
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
          {steps.map(s => {
            const sc = STEP_COLOR[s.status] || T.muted
            const isBlocker = s.blocking || s.status === 'required'
            return (
              <div key={s.key} style={{ display:'flex', alignItems:'center', gap:10,
                padding:'9px 11px', background:T.surface2,
                border:`1px solid ${sc}33`, borderRadius:7 }}>
                <div style={{ width:18, height:18, borderRadius:'50%', flexShrink:0,
                  background:sc+'22', border:`1.5px solid ${sc}`,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:8, color:sc }}>
                  {s.status==='complete'?'✓':s.status==='failed'?'✗':s.order}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ ...mono, fontSize:10, fontWeight:700, color:T.text }}>
                    {s.label}
                    {isBlocker && s.status!=='complete' &&
                      <span style={{ color:T.red, marginLeft:4, fontSize:8 }}>required</span>}
                  </div>
                  {s.note && <div style={{ ...mono, fontSize:9, color:T.dim, marginTop:1 }}>{s.note}</div>}
                  {s.description && <div style={{ ...mono, fontSize:8, color:T.muted, marginTop:1 }}>{s.description}</div>}
                </div>
                {s.key==='notify' && s.status!=='complete' && (
                  <button onClick={() => completeStep('notify')}
                    style={{ ...mono, fontSize:9, color:T.teal, background:'transparent',
                      border:`1px solid ${T.teal}44`, borderRadius:5,
                      padding:'3px 8px', cursor:'pointer', flexShrink:0 }}>Send</button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── DRIFT DETECTION TAB ───────────────────────────────────────────────────────
function DriftTab() {
  const { data: drift,    loading: dl, error: de, reload: dr } = useApi('/api/workflows/drift')
  const { data: analysis, loading: al, error: ae, reload: ar } = useApi('/api/workflows/drift/analysis')
  const [creatingChanges, setCreatingChanges] = useState(false)
  const [selected, setSelected] = useState([])
  const [result, setResult] = useState(null)

  const toggleSelect = (id) => setSelected(s =>
    s.includes(id) ? s.filter(x=>x!==id) : [...s, id])

  const createDriftChanges = async () => {
    if (!selected.length) return
    setCreatingChanges(true)
    try {
      const res = await fetch('/api/workflows/drift/create-changes', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ infraIds: selected, submittedBy: 'system' })
      })
      const data = await res.json()
      setResult(data); setSelected([]); ar()
    } finally { setCreatingChanges(false) }
  }

  if (dl || al) return <Spinner/>
  if (de || ae) return <Err msg={de||ae} onRetry={()=>{dr();ar()}}/>

  const unmapped = analysis?.resources?.filter(r=>r.status==='unmapped') || []
  const mapped   = analysis?.resources?.filter(r=>r.status==='mapped')   || []

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
        {[
          { label:'Total TF Resources', value:analysis?.total||0, color:T.text },
          { label:'Mapped to Apps',     value:analysis?.mapped||0, color:T.green },
          { label:'Unmapped',           value:analysis?.unmapped||0, color:T.amber,
            alert:analysis?.unmapped > 0 },
          { label:'Recent Imports',     value:drift?.recentImports?.length||0, color:T.blue },
        ].map(s => (
          <div key={s.label} style={{ background:T.surface, border:`1px solid ${T.border}`,
            borderRadius:10, padding:'12px 14px' }}>
            <div style={{ ...mono, fontSize:22, fontWeight:800,
              color: s.alert ? T.amber : s.color }}>{s.value}</div>
            <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.1em',
              marginTop:4 }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* Recent imports */}
      {drift?.recentImports?.length > 0 && (
        <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:12 }}>
          <div style={{ padding:'12px 16px', borderBottom:`1px solid ${T.border}`,
            ...mono, fontSize:12, fontWeight:700, color:T.text }}>Recent Imports</div>
          <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:6 }}>
            {drift.recentImports.slice(0,5).map((imp,i) => {
              const done = imp.status==='done'||imp.status==='success'
              const sc = done ? T.green : imp.status==='error' ? T.red : T.amber
              return (
                <div key={imp.id||i} style={{ display:'flex', alignItems:'center', gap:10,
                  padding:'8px 10px', background:T.surface2, border:`1px solid ${T.border}`,
                  borderRadius:7 }}>
                  <div style={{ width:6, height:6, borderRadius:'50%',
                    background:sc, boxShadow:`0 0 4px ${sc}`, flexShrink:0 }}/>
                  <span style={{ ...mono, fontSize:11, color:T.text, flex:1,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {imp.filename}
                  </span>
                  <StepPipeline steps={imp.driftSteps} compact/>
                  <span style={{ ...mono, fontSize:9, color:T.dim }}>
                    {imp.resources_imported||0} imported
                  </span>
                  <span style={{ ...mono, fontSize:8, fontWeight:700, color:sc,
                    background:sc+'18', border:`1px solid ${sc}33`,
                    borderRadius:3, padding:'1px 6px', letterSpacing:'0.06em' }}>
                    {imp.status?.toUpperCase()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Drift analysis */}
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:12 }}>
        <div style={{ padding:'12px 16px', borderBottom:`1px solid ${T.border}`,
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>Drift Analysis</div>
            <div style={{ ...mono, fontSize:9, color:T.muted, marginTop:2 }}>
              Terraform resources not linked to any application component
            </div>
          </div>
          {selected.length > 0 && (
            <button onClick={createDriftChanges} disabled={creatingChanges}
              style={{ ...mono, fontSize:11, fontWeight:700, padding:'7px 14px',
                background:T.amber+'22', border:`1px solid ${T.amber}66`,
                borderRadius:8, color:T.amber, cursor:'pointer',
                opacity: creatingChanges ? .5 : 1 }}>
              Create {selected.length} Draft Change{selected.length>1?'s':''}
            </button>
          )}
        </div>
        <div style={{ padding:'12px 16px' }}>
          {result && (
            <div style={{ padding:'8px 12px', background:T.green+'0a',
              border:`1px solid ${T.green}44`, borderRadius:7, marginBottom:10,
              ...mono, fontSize:10, color:T.green }}>
              ✓ Created {result.created} draft change{result.created!==1?'s':''}
            </div>
          )}
          {unmapped.length === 0 ? (
            <div style={{ textAlign:'center', padding:'20px 0' }}>
              <div style={{ fontSize:24, marginBottom:6 }}>✓</div>
              <div style={{ ...mono, fontSize:11, color:T.green, fontWeight:700 }}>
                All Terraform resources are mapped to application components
              </div>
            </div>
          ) : (
            <div>
              <div style={{ ...mono, fontSize:9, color:T.amber, marginBottom:10 }}>
                ⚠ {unmapped.length} unmapped resource{unmapped.length!==1?'s':''} detected
                — select to create draft changes
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:4,
                maxHeight:320, overflowY:'auto' }}>
                {unmapped.map(r => {
                  const isSelected = selected.includes(r.nodeId)
                  const PROV_COLOR = { aws:T.amber, azure:T.blue, gcp:T.green, onprem:T.purple }
                  const pc = PROV_COLOR[r.provider] || T.muted
                  return (
                    <div key={r.nodeId} onClick={() => toggleSelect(r.nodeId)}
                      style={{ display:'flex', alignItems:'center', gap:10,
                        padding:'9px 11px', background: isSelected?T.amber+'0a':T.surface2,
                        border:`1px solid ${isSelected?T.amber+'66':T.border}`,
                        borderRadius:7, cursor:'pointer', transition:'all .12s' }}>
                      <div style={{ width:14, height:14, borderRadius:3, flexShrink:0,
                        background: isSelected ? T.amber+'22' : T.surface3,
                        border:`1.5px solid ${isSelected ? T.amber : T.border}`,
                        display:'flex', alignItems:'center', justifyContent:'center',
                        fontSize:9, color:T.amber }}>{isSelected && '✓'}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ ...mono, fontSize:11, fontWeight:700, color:T.text,
                          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {r.name}
                        </div>
                        <div style={{ ...mono, fontSize:9, color:T.dim }}>
                          {r.resourceType} · {r.region||'no region'}
                        </div>
                      </div>
                      <span style={{ ...mono, fontSize:9, fontWeight:700, color:pc,
                        background:pc+'18', border:`1px solid ${pc}33`,
                        borderRadius:3, padding:'1px 7px' }}>{r.provider}</span>
                    </div>
                  )
                })}
              </div>
              {mapped.length > 0 && (
                <div style={{ marginTop:14, paddingTop:12, borderTop:`1px solid ${T.border}` }}>
                  <div style={{ ...mono, fontSize:8, color:T.muted, letterSpacing:'0.1em',
                    fontWeight:700, marginBottom:8 }}>MAPPED RESOURCES ({mapped.length})</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:3,
                    maxHeight:160, overflowY:'auto' }}>
                    {mapped.map(r => (
                      <div key={r.nodeId} style={{ display:'flex', alignItems:'center', gap:8,
                        padding:'6px 10px', background:T.surface2,
                        border:`1px solid ${T.border}`, borderRadius:6 }}>
                        <div style={{ width:5, height:5, borderRadius:'50%', background:T.green,
                          boxShadow:`0 0 4px ${T.green}`, flexShrink:0 }}/>
                        <span style={{ ...mono, fontSize:10, color:T.text, flex:1 }}>{r.name}</span>
                        <span style={{ ...mono, fontSize:9, color:T.dim }}>
                          {r.applications.join(', ') || r.components.join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Shared detail panel ───────────────────────────────────────────────────────
function DetailPanel({ title, onClose, children }) {
  return (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`,
      borderRadius:12, overflow:'hidden', alignSelf:'start',
      position:'sticky', top:20 }}>
      <div style={{ padding:'12px 16px', borderBottom:`1px solid ${T.border}`,
        display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text,
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          maxWidth:280 }}>{title}</div>
        <button onClick={onClose} style={{ ...mono, fontSize:16, color:T.muted,
          background:'transparent', border:'none', cursor:'pointer', padding:'0 4px',
          lineHeight:1 }}>×</button>
      </div>
      <div style={{ padding:'14px 16px', maxHeight:'calc(100vh - 200px)', overflowY:'auto' }}>
        {children}
      </div>
    </div>
  )
}

// ── Integration awareness badge ───────────────────────────────────────────────
function IntegrationNote({ type }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 10px',
      background:T.purple+'0a', border:`1px solid ${T.purple}33`, borderRadius:6,
      ...mono, fontSize:9, color:T.purple }}>
      ⟁ Integration step — requires <strong style={{ color:T.purple }}>{type}</strong>
      &nbsp;to be connected in Integrations
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function WorkflowsPage() {
  const { data: summary } = useApi('/api/workflows/summary')
  const [tab, setTab] = useState('change')

  const tabs = [
    { id:'change',     label:'Change Lifecycle', icon:'⟳', color:T.blue   },
    { id:'onboarding', label:'App Onboarding',   icon:'◈', color:T.teal   },
    { id:'drift',      label:'Drift Detection',  icon:'⬡', color:T.amber  },
  ]

  return (
    <div style={{ minHeight:'100vh', background:T.bg, color:T.text,
      fontFamily:'monospace', padding:'28px 32px' }}>

      {/* Header */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <div style={{ width:28, height:28, borderRadius:7,
            background:T.blue+'22', border:`1.5px solid ${T.blue}55`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:13, color:T.blue }}>⟳</div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:800, letterSpacing:'-0.02em' }}>
            Workflows
          </h1>
        </div>
        <p style={{ margin:0, fontSize:11, color:T.dim }}>
          Automated and manual workflows for change lifecycle, application onboarding and infrastructure drift detection.
        </p>
      </div>

      {/* Summary cards */}
      <WorkflowSummary data={summary}/>

      {/* Integration awareness */}
      <div style={{ display:'flex', gap:8, marginBottom:20, padding:'10px 14px',
        background:T.surface, border:`1px solid ${T.border}`, borderRadius:10 }}>
        <span style={{ ...mono, fontSize:9, color:T.muted }}>NOTIFICATION STEPS REQUIRE:</span>
        {['slack','teams','servicenow'].map(i => (
          <span key={i} style={{ ...mono, fontSize:9, color:T.purple,
            background:T.purple+'15', border:`1px solid ${T.purple}33`,
            borderRadius:3, padding:'1px 8px' }}>⟁ {i}</span>
        ))}
        <span style={{ ...mono, fontSize:9, color:T.dim, marginLeft:4 }}>
          — configure in Integrations
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20,
        background:T.surface, borderRadius:10, padding:4,
        border:`1px solid ${T.border}`, width:'fit-content' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            ...mono, fontSize:11, fontWeight: tab===t.id ? 700 : 400,
            padding:'7px 18px', borderRadius:7, cursor:'pointer', border:'none',
            display:'flex', alignItems:'center', gap:6,
            background: tab===t.id ? t.color+'22' : 'transparent',
            color:       tab===t.id ? t.color : T.muted,
            outline:     tab===t.id ? `1px solid ${t.color}44` : 'none',
          }}>
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {tab === 'change'     && <ChangeLcmTab/>}
      {tab === 'onboarding' && <OnboardingTab/>}
      {tab === 'drift'      && <DriftTab/>}
    </div>
  )
}