'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '@/lib/api'

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:'#04080f', surface:'#080f1a', surface2:'#0d1626', surface3:'#111d2e',
  border:'#0f1f35', border2:'#1e293b',
  text:'#f1f5f9', muted:'#334155', dim:'#64748b',
  green:'#22c55e', blue:'#38bdf8', amber:'#f59e0b',
  red:'#f43f5e', purple:'#a78bfa', teal:'#2dd4bf',
}
const STATUS_META = {
  approved:{ color:T.green,  label:'Approved' },
  draft:   { color:T.amber,  label:'Draft'    },
  rejected:{ color:T.red,    label:'Rejected' },
}
const TIER_COLOR = { 1:T.red, 2:T.amber, 3:T.green, 4:T.muted }
const PROV_COLOR = { aws:T.amber, azure:T.blue, gcp:T.green, onprem:T.purple }
const COMP_COLOR = { API:T.blue, DB:T.amber, Worker:T.purple, UI:T.red }
const mono = { fontFamily:'monospace' }

// ── Shared components ─────────────────────────────────────────────────────────
function Spinner({ color=T.amber, size=22 }) {
  return (
    <div style={{ display:'flex',alignItems:'center',justifyContent:'center',padding:24 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width:size,height:size,borderRadius:'50%',
        border:`2px solid ${T.border2}`,borderTop:`2px solid ${color}`,
        animation:'spin .8s linear infinite' }} />
    </div>
  )
}

function StatusBadge({ status }) {
  const m = STATUS_META[status]||{ color:T.muted, label:status }
  return (
    <span style={{ ...mono,fontSize:9,fontWeight:700,color:m.color,
      background:m.color+'18',border:`1px solid ${m.color}33`,
      padding:'2px 8px',borderRadius:4,letterSpacing:'0.06em',
      textTransform:'uppercase' }}>{m.label}</span>
  )
}

function RiskBar({ score }) {
  const pct=(score/10)*100
  const color=score>=8?T.red:score>=5?T.amber:T.green
  return (
    <div style={{ display:'flex',alignItems:'center',gap:8 }}>
      <div style={{ flex:1,height:3,background:T.border2,borderRadius:2,overflow:'hidden' }}>
        <div style={{ width:`${pct}%`,height:'100%',background:color,
          boxShadow:`0 0 6px ${color}`,borderRadius:2,transition:'width .4s ease' }} />
      </div>
      <span style={{ ...mono,fontSize:10,color,fontWeight:700,width:28,textAlign:'right' }}>
        {typeof score==='number'?score.toFixed(1):'—'}
      </span>
    </div>
  )
}

function SLabel({ children, color=T.muted }) {
  return (
    <div style={{ ...mono,fontSize:8,color,letterSpacing:'0.12em',
      fontWeight:700,marginBottom:8 }}>{children}</div>
  )
}

function Dot({ color }) {
  return <div style={{ width:6,height:6,borderRadius:'50%',
    background:color,boxShadow:`0 0 5px ${color}`,flexShrink:0 }} />
}

// ── Blast radius panel (existing change) ──────────────────────────────────────
function BlastRadiusPanel({ changeId, onClose }) {
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(true)
  useEffect(()=>{
    api.changes.blastRadius(changeId).then(setData).catch(()=>{}).finally(()=>setLoading(false))
  },[changeId])

  return (
    <Modal onClose={onClose} maxWidth={620} title="Blast Radius Analysis" titleIcon="⚡"
      accentColor={T.red}>
      {loading?<Spinner color={T.red}/>:!data?(
        <p style={{ ...mono,fontSize:12,color:T.muted }}>No data</p>
      ):(
        <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:16 }}>
          {[
            { label:'DIRECTLY MODIFIED', items:data.directlyModified, color:T.red,   fmt:i=>`${i.name} (${i.label})` },
            { label:'APPS AFFECTED',     items:data.directlyAffected.map(a=>({name:a})), color:T.amber, fmt:i=>i.name },
            { label:'INDIRECTLY IMPACTED',items:data.indirectlyAffected.map(a=>({name:a})),color:T.muted,fmt:i=>i.name },
          ].map(({ label,items,color,fmt })=>(
            <div key={label}>
              <SLabel color={T.muted}>{label} ({items.length})</SLabel>
              {items.length===0
                ?<div style={{ ...mono,fontSize:10,color:T.muted }}>None</div>
                :items.map((item,i)=>(
                  <div key={i} style={{ display:'flex',alignItems:'center',gap:7,
                    marginBottom:6,padding:'7px 10px',background:T.surface2,
                    borderRadius:7,border:`1px solid ${T.border}` }}>
                    <Dot color={color}/>
                    <span style={{ ...mono,fontSize:10,color:T.text }}>{fmt(item)}</span>
                  </div>
                ))
              }
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ── Generic modal wrapper ─────────────────────────────────────────────────────
function Modal({ onClose, maxWidth=520, title, titleIcon, accentColor=T.border2, children }) {
  return (
    <div style={{ position:'fixed',inset:0,zIndex:50,display:'flex',
      alignItems:'center',justifyContent:'center',padding:20 }}>
      <style>{`@keyframes mIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{ position:'absolute',inset:0,background:'#000000bb',
        backdropFilter:'blur(4px)' }} onClick={onClose} />
      <div style={{ position:'relative',background:T.surface,
        border:`1px solid ${accentColor}33`,borderRadius:16,
        width:'100%',maxWidth,maxHeight:'90vh',
        display:'flex',flexDirection:'column',
        boxShadow:`0 0 60px ${accentColor}11,0 24px 80px #00000088`,
        animation:'mIn .22s ease' }}>
        <div style={{ position:'absolute',top:0,left:'10%',right:'10%',height:1,
          background:`linear-gradient(90deg,transparent,${accentColor}66,transparent)` }} />
        <div style={{ display:'flex',alignItems:'center',
          justifyContent:'space-between',padding:'16px 20px',
          borderBottom:`1px solid ${T.border}`,flexShrink:0 }}>
          <div style={{ display:'flex',alignItems:'center',gap:10 }}>
            {titleIcon&&<span style={{ fontSize:15 }}>{titleIcon}</span>}
            <span style={{ ...mono,fontSize:13,fontWeight:700,color:T.text }}>{title}</span>
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',
            color:T.muted,cursor:'pointer',fontSize:22,lineHeight:1 }}>×</button>
        </div>
        <div style={{ overflowY:'auto',padding:20,flex:1 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Add Change Modal ──────────────────────────────────────────────────────────
function AddChangeModal({ onClose, onCreated, users }) {
  // Form state
  const [step,      setStep]      = useState(1) // 1=select targets, 2=details+preview, 3=confirm
  const [targetType,setTargetType]= useState('component') // 'component' | 'infra'
  const [allComps,  setAllComps]  = useState([])
  const [allInfra,  setAllInfra]  = useState([])
  const [selected,  setSelected]  = useState(new Set())
  const [search,    setSearch]    = useState('')
  const [loadingItems, setLoadingItems] = useState(true)

  // Impact preview
  const [preview,      setPreview]      = useState(null)
  const [loadingPreview,setLoadingPreview]=useState(false)
  const [previewError, setPreviewError] = useState(null)

  // Change details
  const [description, setDescription] = useState('')
  const [submittedBy, setSubmittedBy] = useState(users[0]?.id||'')
  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState(null)

  // Load items
  useEffect(()=>{
    setLoadingItems(true)
    Promise.all([api.components.list(), api.infra.list()])
      .then(([c,i])=>{ setAllComps(c); setAllInfra(i) })
      .finally(()=>setLoadingItems(false))
  },[])

  // When selection changes and we're on step 2, re-run preview
  const runPreview = useCallback(async (ids)=>{
    if(!ids.size) { setPreview(null); return }
    setLoadingPreview(true); setPreviewError(null)
    try {
      const result = await api.changes.impactPreview([...ids])
      setPreview(result)
    } catch(e) { setPreviewError(e.message) }
    finally { setLoadingPreview(false) }
  },[])

  const toggleItem = (id)=>{
    setSelected(prev=>{
      const next=new Set(prev)
      next.has(id)?next.delete(id):next.add(id)
      return next
    })
  }

  const goToStep2 = ()=>{
    setStep(2)
    runPreview(selected)
  }

  const handleSubmit = async ()=>{
    if(!description.trim()) { setSubmitError('Description is required'); return }
    if(!submittedBy)        { setSubmitError('Select a submitter'); return }
    setSubmitting(true); setSubmitError(null)
    try {
      await api.changes.create({
        description: description.trim(),
        riskScore: preview?.riskScore || 1,
        submittedBy,
        modifiesIds: [...selected],
        affectsIds: (preview?.affectedApplications||[]).map(a=>a.id).filter(Boolean),
      })
      onCreated()
      onClose()
    } catch(e) { setSubmitError(e.message) }
    finally { setSubmitting(false) }
  }

  const items  = targetType==='component' ? allComps : allInfra
  const filtered = items.filter(i=>
    (i.name||'').toLowerCase().includes(search.toLowerCase()) ||
    (i.type||i.resourceType||'').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Modal onClose={onClose} maxWidth={900} title="New Change Request"
      titleIcon="+" accentColor={T.amber}>

      {/* Step indicator */}
      <div style={{ display:'flex',alignItems:'center',gap:0,marginBottom:20 }}>
        {[['1','Select Targets'],['2','Impact Preview'],['3','Submit']].map(([n,label],i)=>{
          const active=step===i+1, done=step>i+1
          const color=done?T.green:active?T.amber:T.muted
          return (
            <div key={n} style={{ display:'flex',alignItems:'center' }}>
              <div style={{ display:'flex',alignItems:'center',gap:7 }}>
                <div style={{ width:22,height:22,borderRadius:'50%',
                  background:color+'20',border:`1.5px solid ${color}`,
                  display:'flex',alignItems:'center',justifyContent:'center',
                  ...mono,fontSize:10,fontWeight:700,color }}>
                  {done?'✓':n}
                </div>
                <span style={{ ...mono,fontSize:10,color,
                  fontWeight:active?700:400 }}>{label}</span>
              </div>
              {i<2&&<div style={{ width:40,height:1,background:T.border2,margin:'0 10px' }} />}
            </div>
          )
        })}
      </div>

      {/* ── STEP 1: Select targets ─────────────────────────────── */}
      {step===1&&(
        <div>
          {/* Target type toggle */}
          <div style={{ display:'flex',gap:8,marginBottom:16 }}>
            {[['component','App Components'],['infra','Infrastructure']].map(([key,label])=>(
              <button key={key} onClick={()=>{ setTargetType(key); setSelected(new Set()); setSearch('') }}
                style={{ ...mono,fontSize:11,fontWeight:600,padding:'7px 16px',
                  borderRadius:8,cursor:'pointer',
                  background:targetType===key?T.amber+'18':T.surface2,
                  border:`1px solid ${targetType===key?T.amber:T.border2}`,
                  color:targetType===key?T.amber:T.dim,transition:'all .15s' }}>
                {label}
              </button>
            ))}
          </div>

          {/* Search */}
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder={`Search ${targetType==='component'?'components':'infrastructure'}…`}
            style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
              borderRadius:8,padding:'9px 13px',color:T.text,fontSize:12,
              fontFamily:'monospace',outline:'none',marginBottom:12,boxSizing:'border-box' }} />

          {/* Item list */}
          {loadingItems?<Spinner/>:(
            <div style={{ maxHeight:320,overflowY:'auto',display:'flex',
              flexDirection:'column',gap:6 }}>
              {filtered.length===0&&(
                <div style={{ ...mono,fontSize:11,color:T.muted,textAlign:'center',padding:20 }}>
                  No items found
                </div>
              )}
              {filtered.map(item=>{
                const isComp   = targetType==='component'
                const color    = isComp ? (COMP_COLOR[item.type]||T.blue) : (PROV_COLOR[item.provider]||T.muted)
                const tag      = isComp ? item.type : (item.provider||'').toUpperCase()
                const subtitle = isComp ? item.appName||'Unassigned' : [item.resourceType,item.region].filter(Boolean).join(' · ')
                const isSel    = selected.has(item.id)
                return (
                  <div key={item.id} onClick={()=>toggleItem(item.id)}
                    style={{ display:'flex',alignItems:'center',gap:12,
                      padding:'10px 14px',borderRadius:9,cursor:'pointer',
                      background:isSel?color+'0f':T.surface2,
                      border:`1px solid ${isSel?color+'55':T.border}`,
                      transition:'all .12s' }}>
                    {/* Checkbox */}
                    <div style={{ width:16,height:16,borderRadius:4,flexShrink:0,
                      background:isSel?color:T.surface3,
                      border:`1.5px solid ${isSel?color:T.border2}`,
                      display:'flex',alignItems:'center',justifyContent:'center',
                      fontSize:10,color:'#000',fontWeight:800 }}>
                      {isSel?'✓':''}
                    </div>
                    <Dot color={color}/>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                        <span style={{ ...mono,fontSize:12,fontWeight:600,color:T.text }}>
                          {item.name}
                        </span>
                        <span style={{ ...mono,fontSize:8,fontWeight:700,color,
                          background:color+'15',border:`1px solid ${color}30`,
                          borderRadius:3,padding:'1px 5px',letterSpacing:'0.06em' }}>
                          {tag}
                        </span>
                      </div>
                      {subtitle&&(
                        <div style={{ ...mono,fontSize:9,color:T.muted,marginTop:2 }}>
                          {subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ display:'flex',justifyContent:'space-between',
            alignItems:'center',marginTop:16 }}>
            <span style={{ ...mono,fontSize:10,color:T.dim }}>
              {selected.size} selected
            </span>
            <button onClick={goToStep2} disabled={selected.size===0}
              style={{ ...mono,fontSize:11,fontWeight:700,padding:'9px 22px',
                borderRadius:8,cursor:selected.size?'pointer':'not-allowed',
                background:selected.size?T.amber:T.muted,
                border:'none',color:'#000',opacity:selected.size?1:0.5 }}>
              Analyse Impact →
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2: Impact preview ─────────────────────────────── */}
      {step===2&&(
        <div style={{ display:'grid',gridTemplateColumns:'1fr 1.2fr',gap:20 }}>

          {/* Left: description + submitter */}
          <div>
            <SLabel>CHANGE DESCRIPTION</SLabel>
            <textarea value={description} onChange={e=>setDescription(e.target.value)}
              rows={4} placeholder="Describe what is changing and why…"
              style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
                borderRadius:8,padding:'10px 13px',color:T.text,fontSize:12,
                fontFamily:'monospace',outline:'none',resize:'vertical',
                boxSizing:'border-box',marginBottom:16 }} />

            <SLabel>SUBMITTED BY</SLabel>
            <select value={submittedBy} onChange={e=>setSubmittedBy(e.target.value)}
              style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
                borderRadius:8,padding:'9px 13px',color:T.text,fontSize:12,
                fontFamily:'monospace',outline:'none',marginBottom:16 }}>
              {users.map(u=>(
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>

            <SLabel>SELECTED TARGETS ({selected.size})</SLabel>
            <div style={{ display:'flex',flexDirection:'column',gap:5,marginBottom:16 }}>
              {[...selected].map(id=>{
                const comp = allComps.find(c=>c.id===id)
                const inf  = allInfra.find(i=>i.id===id)
                const item = comp||inf
                if(!item) return null
                const isComp = !!comp
                const color  = isComp?(COMP_COLOR[item.type]||T.blue):(PROV_COLOR[item.provider]||T.muted)
                return (
                  <div key={id} style={{ display:'flex',alignItems:'center',gap:8,
                    padding:'7px 10px',background:T.surface2,borderRadius:7,
                    border:`1px solid ${color}30` }}>
                    <Dot color={color}/>
                    <span style={{ ...mono,fontSize:11,color:T.text }}>{item.name}</span>
                    <span style={{ ...mono,fontSize:8,color,marginLeft:'auto',
                      background:color+'15',border:`1px solid ${color}30`,
                      borderRadius:3,padding:'1px 5px',letterSpacing:'0.06em',
                      textTransform:'uppercase' }}>
                      {isComp?item.type:(item.provider||'INFRA')}
                    </span>
                  </div>
                )
              })}
            </div>

            {submitError&&(
              <div style={{ ...mono,fontSize:11,color:T.red,marginBottom:10 }}>
                {submitError}
              </div>
            )}

            <div style={{ display:'flex',gap:10 }}>
              <button onClick={()=>setStep(1)}
                style={{ ...mono,fontSize:11,padding:'9px 18px',borderRadius:8,
                  cursor:'pointer',background:'none',
                  border:`1px solid ${T.border2}`,color:T.muted }}>
                ← Back
              </button>
              <button onClick={()=>setStep(3)} disabled={!description.trim()||!preview}
                style={{ ...mono,fontSize:11,fontWeight:700,padding:'9px 22px',
                  borderRadius:8,cursor:description.trim()&&preview?'pointer':'not-allowed',
                  background:description.trim()&&preview?T.amber:T.muted,
                  border:'none',color:'#000',flex:1,
                  opacity:description.trim()&&preview?1:0.5 }}>
                Review & Submit →
              </button>
            </div>
          </div>

          {/* Right: impact preview */}
          <div style={{ background:T.surface2,borderRadius:12,
            border:`1px solid ${T.border}`,padding:16 }}>
            <SLabel color={T.amber}>IMPACT ANALYSIS</SLabel>
            {loadingPreview?<Spinner color={T.amber}/>:
            previewError?(
              <div style={{ ...mono,fontSize:11,color:T.red }}>{previewError}</div>
            ):!preview?(
              <div style={{ ...mono,fontSize:11,color:T.muted }}>Select targets to analyse impact</div>
            ):(
              <div>
                {/* Risk score */}
                <div style={{ marginBottom:16,padding:'12px 14px',
                  background:T.surface3,borderRadius:9,
                  border:`1px solid ${T.border}` }}>
                  <div style={{ display:'flex',justifyContent:'space-between',
                    alignItems:'center',marginBottom:8 }}>
                    <SLabel>CALCULATED RISK</SLabel>
                    <span style={{ ...mono,fontSize:20,fontWeight:800,
                      color:preview.riskScore>=8?T.red:preview.riskScore>=5?T.amber:T.green }}>
                      {preview.riskScore.toFixed(1)}
                      <span style={{ fontSize:10,color:T.muted }}>/10</span>
                    </span>
                  </div>
                  <RiskBar score={preview.riskScore}/>
                </div>

                {/* Affected applications */}
                {preview.affectedApplications?.length>0&&(
                  <div style={{ marginBottom:14 }}>
                    <SLabel>AFFECTED APPLICATIONS ({preview.affectedApplications.length})</SLabel>
                    {preview.affectedApplications.map((app,i)=>{
                      const tc=TIER_COLOR[app.tier]||T.muted
                      return (
                        <div key={i} style={{ display:'flex',alignItems:'center',gap:8,
                          padding:'7px 10px',marginBottom:5,background:T.surface3,
                          borderRadius:7,border:`1px solid ${tc}22` }}>
                          <Dot color={tc}/>
                          <span style={{ ...mono,fontSize:11,color:T.text,fontWeight:600 }}>
                            {app.name}
                          </span>
                          <span style={{ ...mono,fontSize:8,color:tc,marginLeft:'auto',
                            background:tc+'18',border:`1px solid ${tc}33`,
                            borderRadius:3,padding:'1px 5px' }}>T{app.tier}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Affected components */}
                {preview.affectedComponents?.length>0&&(
                  <div style={{ marginBottom:14 }}>
                    <SLabel>AFFECTED COMPONENTS ({preview.affectedComponents.length})</SLabel>
                    <div style={{ maxHeight:140,overflowY:'auto',
                      display:'flex',flexDirection:'column',gap:4 }}>
                      {preview.affectedComponents.map((comp,i)=>{
                        const cc=COMP_COLOR[comp.type]||T.blue
                        return (
                          <div key={i} style={{ display:'flex',alignItems:'center',gap:7,
                            padding:'5px 9px',background:T.surface3,borderRadius:6,
                            border:`1px solid ${cc}18` }}>
                            <Dot color={cc}/>
                            <span style={{ ...mono,fontSize:10,color:T.text }}>{comp.name}</span>
                            <span style={{ ...mono,fontSize:8,color:T.muted,marginLeft:'auto' }}>
                              {comp.appName}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Teams */}
                {preview.teams?.length>0&&(
                  <div>
                    <SLabel color={T.teal}>TEAMS TO INVOLVE ({preview.teams.length})</SLabel>
                    <div style={{ display:'flex',flexWrap:'wrap',gap:6 }}>
                      {preview.teams.map((t,i)=>(
                        <div key={i} style={{ display:'inline-flex',alignItems:'center',gap:6,
                          padding:'5px 11px',background:T.teal+'12',
                          border:`1px solid ${T.teal}33`,borderRadius:20 }}>
                          <div style={{ width:5,height:5,borderRadius:'50%',
                            background:T.teal,boxShadow:`0 0 4px ${T.teal}` }} />
                          <span style={{ ...mono,fontSize:10,color:T.teal,fontWeight:600 }}>
                            {t.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {preview.affectedApplications?.length===0&&
                 preview.affectedComponents?.length===0&&(
                  <div style={{ ...mono,fontSize:11,color:T.muted,textAlign:'center',
                    padding:'12px 0' }}>No downstream impact detected</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 3: Confirm + submit ───────────────────────────── */}
      {step===3&&(
        <div style={{ maxWidth:560,margin:'0 auto' }}>
          <div style={{ padding:'16px 18px',background:T.surface2,borderRadius:12,
            border:`1px solid ${T.amber}33`,marginBottom:16 }}>
            <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
              background:`linear-gradient(90deg,transparent,${T.amber}55,transparent)` }} />
            <SLabel color={T.amber}>CHANGE SUMMARY</SLabel>
            <div style={{ ...mono,fontSize:13,fontWeight:700,color:T.text,marginBottom:10 }}>
              {description}
            </div>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10 }}>
              {[
                ['RISK SCORE', `${preview?.riskScore?.toFixed(1)||'?'}/10`,
                  preview?.riskScore>=8?T.red:preview?.riskScore>=5?T.amber:T.green],
                ['APPS AFFECTED', preview?.affectedApplications?.length||0, T.amber],
                ['TEAMS',         preview?.teams?.length||0,                T.teal],
              ].map(([label,value,color])=>(
                <div key={label} style={{ textAlign:'center',padding:'10px 8px',
                  background:T.surface3,borderRadius:8,border:`1px solid ${color}22` }}>
                  <div style={{ ...mono,fontSize:18,fontWeight:800,color }}>{value}</div>
                  <div style={{ ...mono,fontSize:8,color:T.muted,marginTop:4,
                    letterSpacing:'0.1em' }}>{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Teams to notify */}
          {preview?.teams?.length>0&&(
            <div style={{ marginBottom:16,padding:'12px 14px',background:T.surface2,
              borderRadius:10,border:`1px solid ${T.teal}22` }}>
              <SLabel color={T.teal}>TEAMS REQUIRED FOR TESTING</SLabel>
              <div style={{ display:'flex',flexWrap:'wrap',gap:6 }}>
                {preview.teams.map((t,i)=>(
                  <div key={i} style={{ display:'inline-flex',alignItems:'center',gap:6,
                    padding:'5px 12px',background:T.teal+'12',
                    border:`1px solid ${T.teal}33`,borderRadius:20 }}>
                    <div style={{ width:5,height:5,borderRadius:'50%',
                      background:T.teal,boxShadow:`0 0 4px ${T.teal}` }} />
                    <span style={{ ...mono,fontSize:10,color:T.teal,fontWeight:600 }}>
                      {t.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {submitError&&(
            <div style={{ ...mono,fontSize:11,color:T.red,marginBottom:12 }}>
              ⚠ {submitError}
            </div>
          )}

          <div style={{ display:'flex',gap:10 }}>
            <button onClick={()=>setStep(2)}
              style={{ ...mono,fontSize:11,padding:'10px 18px',borderRadius:8,
                cursor:'pointer',background:'none',
                border:`1px solid ${T.border2}`,color:T.muted }}>
              ← Back
            </button>
            <button onClick={handleSubmit} disabled={submitting}
              style={{ ...mono,fontSize:12,fontWeight:700,padding:'10px 0',
                borderRadius:8,cursor:submitting?'wait':'pointer',
                background:T.amber,border:'none',color:'#000',flex:1 }}>
              {submitting?'Submitting…':'Submit Change Request'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Confirm modal ─────────────────────────────────────────────────────────────
function ConfirmModal({ open,onClose,title,message,onConfirm,confirmLabel,confirmColor,children }) {
  if(!open) return null
  return (
    <Modal onClose={onClose} maxWidth={420} title={title} accentColor={confirmColor||T.border2}>
      {message&&<p style={{ ...mono,fontSize:12,color:T.dim,marginBottom:16 }}>{message}</p>}
      {children}
      <div style={{ display:'flex',justifyContent:'flex-end',gap:10,marginTop:16 }}>
        <button onClick={onClose} style={{ ...mono,fontSize:11,padding:'8px 16px',
          background:'none',border:`1px solid ${T.border2}`,
          borderRadius:8,color:T.muted,cursor:'pointer' }}>Cancel</button>
        <button onClick={onConfirm} style={{ ...mono,fontSize:11,padding:'8px 18px',
          background:confirmColor||T.green,border:'none',borderRadius:8,
          color:'#000',fontWeight:700,cursor:'pointer' }}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ChangesPage() {
  const [changes,     setChanges]     = useState([])
  const [users,       setUsers]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [filter,      setFilter]      = useState('all')
  const [blastId,     setBlastId]     = useState(null)
  const [showAdd,     setShowAdd]     = useState(false)
  const [approveModal,setApproveModal]= useState(null)
  const [rejectModal, setRejectModal] = useState(null)
  const [rejectReason,setRejectReason]= useState('')

  const load = useCallback(()=>{
    setLoading(true)
    Promise.all([
      api.changes.list(filter==='all'?undefined:filter),
      api.users.list(),
    ]).then(([c,u])=>{ setChanges(c); setUsers(u) })
      .finally(()=>setLoading(false))
  },[filter])

  useEffect(()=>{ load() },[load])

  const handleApprove = async ()=>{
    if(!users.length) return
    await api.changes.approve(approveModal, users[0].id)
    setApproveModal(null); load()
  }
  const handleReject = async ()=>{
    if(!rejectReason.trim()||!users.length) return
    await api.changes.reject(rejectModal, users[0].id, rejectReason)
    setRejectModal(null); setRejectReason(''); load()
  }

  const statusCounts = ['draft','approved','rejected'].reduce((acc,s)=>({
    ...acc,[s]:changes.filter(c=>c.status===s).length
  }),{})

  return (
    <div style={{ minHeight:'100vh',
      background:`radial-gradient(ellipse at 10% 20%,#0a1628 0%,${T.bg} 60%)`,
      padding:'28px 32px' }}>

      {/* Header */}
      <div style={{ display:'flex',alignItems:'center',
        justifyContent:'space-between',marginBottom:24 }}>
        <div>
          <h1 style={{ ...mono,fontSize:20,fontWeight:800,color:T.text,
            letterSpacing:'-0.02em',margin:'0 0 6px' }}>Changes</h1>
          <p style={{ ...mono,fontSize:11,color:T.muted,
            letterSpacing:'0.05em' }}>CHANGE MANAGEMENT & APPROVALS</p>
        </div>
        <div style={{ display:'flex',alignItems:'center',gap:12 }}>
          {/* Status counts */}
          <div style={{ display:'flex',gap:1 }}>
            {Object.entries(STATUS_META).map(([s,m],i,arr)=>(
              <div key={s} style={{ padding:'8px 16px',background:T.surface,
                border:`1px solid ${T.border}`,
                borderLeft:i>0?'none':`1px solid ${T.border}`,
                borderRadius:i===0?'10px 0 0 10px':i===arr.length-1?'0 10px 10px 0':0,
                display:'flex',flexDirection:'column',alignItems:'center',gap:2 }}>
                <span style={{ ...mono,fontSize:18,fontWeight:800,color:m.color }}>
                  {statusCounts[s]??0}
                </span>
                <span style={{ ...mono,fontSize:8,color:T.muted,
                  letterSpacing:'0.1em' }}>{s.toUpperCase()}</span>
              </div>
            ))}
          </div>
          {/* Add button */}
          <button onClick={()=>setShowAdd(true)}
            style={{ ...mono,fontSize:11,fontWeight:700,padding:'10px 20px',
              borderRadius:10,cursor:'pointer',
              background:`linear-gradient(135deg,${T.amber},#d97706)`,
              border:'none',color:'#000',
              boxShadow:`0 0 20px ${T.amber}33` }}>
            + New Change
          </button>
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ display:'flex',gap:8,marginBottom:20 }}>
        {['all','draft','approved','rejected'].map(f=>{
          const m=STATUS_META[f]||{ color:T.green }
          return (
            <button key={f} onClick={()=>setFilter(f)} style={{
              ...mono,fontSize:10,fontWeight:600,padding:'6px 14px',
              borderRadius:8,cursor:'pointer',textTransform:'uppercase',
              letterSpacing:'0.05em',
              background:filter===f?m.color+'20':T.surface,
              border:`1px solid ${filter===f?m.color:T.border2}`,
              color:filter===f?m.color:T.muted,transition:'all .15s',
            }}>{f}</button>
          )
        })}
      </div>

      {/* Table */}
      <div style={{ background:T.surface,border:`1px solid ${T.border}`,
        borderRadius:14,overflow:'hidden' }}>
        <table style={{ width:'100%',borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${T.border}` }}>
              {['Change','Status','Risk Score','Submitted By','Date','Actions'].map(h=>(
                <th key={h} style={{ ...mono,fontSize:9,color:T.muted,
                  textAlign:'left',padding:'12px 16px',
                  letterSpacing:'0.1em',fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading?(
              <tr><td colSpan={6}><Spinner/></td></tr>
            ):changes.length===0?(
              <tr><td colSpan={6} style={{ ...mono,fontSize:12,color:T.muted,
                textAlign:'center',padding:40 }}>No changes found</td></tr>
            ):changes.map(c=>(
              <tr key={c.id}
                style={{ borderBottom:`1px solid ${T.border}`,transition:'background .15s' }}
                onMouseEnter={e=>e.currentTarget.style.background=T.surface2}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <td style={{ padding:'13px 16px',maxWidth:260 }}>
                  <div style={{ ...mono,fontSize:12,color:T.text,fontWeight:500,
                    whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis' }}>
                    {c.description}
                  </div>
                  <div style={{ ...mono,fontSize:9,color:T.muted,marginTop:2 }}>
                    {c.id.slice(0,8)}…
                  </div>
                </td>
                <td style={{ padding:'13px 16px' }}>
                  <StatusBadge status={c.status}/>
                </td>
                <td style={{ padding:'13px 16px',width:140 }}>
                  <RiskBar score={c.riskScore}/>
                </td>
                <td style={{ padding:'13px 16px',...mono,fontSize:11,color:T.dim }}>
                  {c.submittedBy||'—'}
                </td>
                <td style={{ padding:'13px 16px',...mono,fontSize:10,color:T.muted }}>
                  {new Date(c.createdAt).toLocaleDateString('en-GB')}
                </td>
                <td style={{ padding:'13px 16px' }}>
                  <div style={{ display:'flex',gap:6 }}>
                    <button onClick={()=>setBlastId(c.id)}
                      style={{ ...mono,fontSize:10,padding:'5px 10px',
                        background:T.purple+'15',border:`1px solid ${T.purple}30`,
                        borderRadius:6,color:T.purple,cursor:'pointer' }}>
                      Blast
                    </button>
                    {c.status==='draft'&&(
                      <>
                        <button onClick={()=>setApproveModal(c.id)}
                          style={{ ...mono,fontSize:10,padding:'5px 10px',
                            background:T.green+'15',border:`1px solid ${T.green}30`,
                            borderRadius:6,color:T.green,cursor:'pointer' }}>
                          ✓ Approve
                        </button>
                        <button onClick={()=>setRejectModal(c.id)}
                          style={{ ...mono,fontSize:10,padding:'5px 10px',
                            background:T.red+'12',border:`1px solid ${T.red}30`,
                            borderRadius:6,color:T.red,cursor:'pointer' }}>
                          ✗ Reject
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modals */}
      {blastId&&<BlastRadiusPanel changeId={blastId} onClose={()=>setBlastId(null)}/>}

      {showAdd&&(
        <AddChangeModal
          onClose={()=>setShowAdd(false)}
          onCreated={load}
          users={users}
        />
      )}

      <ConfirmModal open={!!approveModal} onClose={()=>setApproveModal(null)}
        title="APPROVE CHANGE"
        message="Are you sure you want to approve this change?"
        onConfirm={handleApprove} confirmLabel="Approve" confirmColor={T.green} />

      <ConfirmModal open={!!rejectModal}
        onClose={()=>{ setRejectModal(null); setRejectReason('') }}
        title="REJECT CHANGE" onConfirm={handleReject}
        confirmLabel="Reject" confirmColor={T.red}>
        <div style={{ ...mono,fontSize:9,color:T.muted,
          letterSpacing:'0.1em',marginBottom:6 }}>REJECTION REASON</div>
        <textarea value={rejectReason} onChange={e=>setRejectReason(e.target.value)}
          rows={3} placeholder="Explain why this change is being rejected…"
          style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
            borderRadius:8,padding:'9px 12px',color:T.text,fontSize:12,
            fontFamily:'monospace',outline:'none',resize:'vertical',
            boxSizing:'border-box' }} />
      </ConfirmModal>
    </div>
  )
}