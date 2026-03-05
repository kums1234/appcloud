'use client'
import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:'#04080f', surface:'#080f1a', surface2:'#0d1626', surface3:'#111d2e',
  border:'#0f1f35', border2:'#1e293b',
  text:'#f1f5f9', muted:'#334155', dim:'#64748b',
  green:'#22c55e', blue:'#38bdf8', amber:'#f59e0b',
  red:'#f43f5e', purple:'#a78bfa', teal:'#2dd4bf',
}
const PROVIDER_META = {
  aws:    { color:T.amber,  label:'AWS',     icon:'⬡' },
  azure:  { color:T.blue,   label:'Azure',   icon:'◈' },
  gcp:    { color:T.green,  label:'GCP',     icon:'◎' },
  onprem: { color:T.muted,  label:'On-Prem', icon:'⊞' },
}
const COMP_COLOR = { API:T.blue, DB:T.amber, Worker:T.purple, UI:T.red }
const TIER_COLOR = { 1:T.red, 2:T.amber, 3:T.green, 4:T.muted }
const RESOURCE_TYPES = [
  'ec2_instance','rds_instance','elasticache','sqs_queue',
  'vpc','s3_bucket','vm','function','other',
]
const mono = { fontFamily:'monospace' }
const inputStyle = {
  width:'100%', background:T.surface2, border:`1px solid ${T.border2}`,
  borderRadius:8, padding:'9px 12px', color:T.text, fontSize:12,
  fontFamily:'monospace', outline:'none', boxSizing:'border-box',
}
const selectStyle = { ...inputStyle, cursor:'pointer', appearance:'none' }

// ── Helpers ───────────────────────────────────────────────────────────────────
function Spinner({ size=26, color=T.amber }) {
  return (
    <div style={{ display:'flex',alignItems:'center',justifyContent:'center',padding:20 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width:size,height:size,borderRadius:'50%',
        border:`2px solid ${T.border2}`,borderTop:`2px solid ${color}`,
        animation:'spin .7s linear infinite' }} />
    </div>
  )
}

function ProviderBadge({ provider }) {
  const m = PROVIDER_META[provider]||{ color:T.muted, label:provider }
  return (
    <span style={{ ...mono,fontSize:9,fontWeight:700,color:m.color,
      background:m.color+'18',border:`1px solid ${m.color}33`,
      padding:'2px 8px',borderRadius:4,letterSpacing:'0.06em' }}>
      {m.label}
    </span>
  )
}

function AccessBadge({ pub }) {
  const c = pub?T.red:T.green
  return (
    <span style={{ display:'inline-flex',alignItems:'center',gap:5,
      ...mono,fontSize:9,fontWeight:600,color:c,
      background:c+'15',border:`1px solid ${c}30`,
      padding:'2px 8px',borderRadius:4,letterSpacing:'0.06em' }}>
      <span style={{ width:5,height:5,borderRadius:'50%',
        background:c,boxShadow:`0 0 5px ${c}`,display:'inline-block' }} />
      {pub?'PUBLIC':'PRIVATE'}
    </span>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ ...mono,fontSize:9,color:T.muted,letterSpacing:'0.1em',
        fontWeight:700,marginBottom:6 }}>{label}</div>
      {children}
    </div>
  )
}

// ── Expanded dependency panel ─────────────────────────────────────────────────
function DependencyPanel({ infraId, infraName, providerColor }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(()=>{
    setLoading(true); setError(null)
    api.graph.impact(infraId)
      .then(setData)
      .catch(err=>{
        // 404 just means no deployments — not a real error
        if (err.message?.includes('404')||err.message?.includes('not found')) {
          setData({ impactedComponents:[], impactedApplications:[] })
        } else {
          setError(err.message)
        }
      })
      .finally(()=>setLoading(false))
  },[infraId])

  return (
    <tr>
      <td colSpan={6} style={{ padding:0, borderBottom:`1px solid ${T.border}` }}>
        <div style={{
          background:`linear-gradient(135deg,${providerColor}06,${T.surface2})`,
          borderTop:`1px solid ${providerColor}22`,
          padding:'16px 20px 18px 44px',
          position:'relative', overflow:'hidden',
        }}>
          {/* Left accent bar */}
          <div style={{ position:'absolute',top:0,left:20,bottom:0,width:2,
            background:`linear-gradient(180deg,${providerColor}66,transparent)`,
            borderRadius:2 }} />

          <div style={{ ...mono,fontSize:8,color:providerColor,
            letterSpacing:'0.12em',fontWeight:700,marginBottom:12 }}>
            DEPENDENT COMPONENTS & APPLICATIONS
          </div>

          {loading ? (
            <Spinner size={20} color={providerColor}/>
          ) : error ? (
            <div style={{ ...mono,fontSize:11,color:T.red }}>{error}</div>
          ) : !data || (data.impactedComponents.length===0 && data.impactedApplications.length===0) ? (
            <div style={{ display:'flex',alignItems:'center',gap:8 }}>
              <div style={{ width:5,height:5,borderRadius:'50%',
                background:T.muted,flexShrink:0 }} />
              <span style={{ ...mono,fontSize:11,color:T.dim }}>
                No components are deployed on this resource
              </span>
            </div>
          ) : (
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:20 }}>

              {/* Components column */}
              <div>
                <div style={{ ...mono,fontSize:8,color:T.muted,letterSpacing:'0.1em',
                  fontWeight:700,marginBottom:8 }}>
                  COMPONENTS ({data.impactedComponents.length})
                </div>
                <div style={{ display:'flex',flexDirection:'column',gap:5 }}>
                  {data.impactedComponents.map((comp,i)=>{
                    const cc = COMP_COLOR[comp.type]||T.blue
                    return (
                      <div key={i} style={{ display:'flex',alignItems:'center',gap:9,
                        padding:'7px 11px',background:T.surface3,borderRadius:8,
                        border:`1px solid ${cc}22` }}>
                        <div style={{ width:5,height:5,borderRadius:'50%',
                          background:cc,boxShadow:`0 0 5px ${cc}`,flexShrink:0 }} />
                        <span style={{ ...mono,fontSize:11,fontWeight:600,
                          color:T.text,flex:1 }}>{comp.name}</span>
                        <span style={{ ...mono,fontSize:8,fontWeight:700,color:cc,
                          background:cc+'15',border:`1px solid ${cc}30`,
                          borderRadius:3,padding:'1px 6px',letterSpacing:'0.06em',
                          textTransform:'uppercase' }}>{comp.type}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Applications column */}
              <div>
                <div style={{ ...mono,fontSize:8,color:T.muted,letterSpacing:'0.1em',
                  fontWeight:700,marginBottom:8 }}>
                  APPLICATIONS ({data.impactedApplications.length})
                </div>
                <div style={{ display:'flex',flexDirection:'column',gap:5 }}>
                  {data.impactedApplications.map((app,i)=>{
                    const tier = typeof app.tier?.toNumber==='function'
                      ? app.tier.toNumber() : Number(app.tier)
                    const tc = TIER_COLOR[tier]||T.muted
                    const env = app.environment||''
                    const envColor = env==='production'?T.red:env==='staging'?T.amber:T.muted
                    return (
                      <div key={i} style={{ display:'flex',alignItems:'center',gap:9,
                        padding:'7px 11px',background:T.surface3,borderRadius:8,
                        border:`1px solid ${tc}22` }}>
                        <div style={{ width:5,height:5,borderRadius:'50%',
                          background:tc,boxShadow:`0 0 5px ${tc}`,flexShrink:0 }} />
                        <span style={{ ...mono,fontSize:11,fontWeight:600,
                          color:T.text,flex:1 }}>{app.name}</span>
                        <div style={{ display:'flex',gap:5 }}>
                          <span style={{ ...mono,fontSize:8,fontWeight:700,color:tc,
                            background:tc+'15',border:`1px solid ${tc}30`,
                            borderRadius:3,padding:'1px 6px' }}>T{tier}</span>
                          {env&&(
                            <span style={{ ...mono,fontSize:8,color:envColor,
                              background:envColor+'15',border:`1px solid ${envColor}30`,
                              borderRadius:3,padding:'1px 6px',letterSpacing:'0.04em' }}>
                              {env}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Add infra modal ───────────────────────────────────────────────────────────
function InfraModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    provider:'aws', resource_type:'ec2_instance',
    name:'', region:'', public:false,
  })
  const set = (k,v) => setForm(f=>({...f,[k]:v}))
  return (
    <div style={{ position:'fixed',inset:0,zIndex:50,display:'flex',
      alignItems:'center',justifyContent:'center',padding:20 }}>
      <style>{`@keyframes mIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{ position:'absolute',inset:0,background:'#000000bb',
        backdropFilter:'blur(4px)' }} onClick={onClose} />
      <div style={{ position:'relative',background:T.surface,
        border:`1px solid ${T.amber}44`,borderRadius:16,
        width:'100%',maxWidth:480,
        boxShadow:`0 0 60px #00000088,0 0 40px ${T.amber}11`,
        animation:'mIn .2s ease' }}>
        <div style={{ position:'absolute',top:0,left:'10%',right:'10%',height:1,
          background:`linear-gradient(90deg,transparent,${T.amber}66,transparent)` }} />
        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',
          padding:'16px 20px',borderBottom:`1px solid ${T.border}` }}>
          <span style={{ ...mono,fontSize:13,fontWeight:700,color:T.text }}>
            NEW INFRA RESOURCE
          </span>
          <button onClick={onClose} style={{ background:'none',border:'none',
            color:T.muted,cursor:'pointer',fontSize:20,lineHeight:1 }}>×</button>
        </div>
        <div style={{ padding:20 }}>
          <Field label="RESOURCE NAME">
            <input style={inputStyle} value={form.name}
              onChange={e=>set('name',e.target.value)}
              placeholder="e.g. payments-api-server" />
          </Field>
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12 }}>
            <Field label="PROVIDER">
              <select style={selectStyle} value={form.provider}
                onChange={e=>set('provider',e.target.value)}>
                {Object.entries(PROVIDER_META).map(([k,v])=>(
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </Field>
            <Field label="RESOURCE TYPE">
              <select style={selectStyle} value={form.resource_type}
                onChange={e=>set('resource_type',e.target.value)}>
                {RESOURCE_TYPES.map(r=><option key={r}>{r}</option>)}
              </select>
            </Field>
          </div>
          <Field label="REGION">
            <input style={inputStyle} value={form.region}
              onChange={e=>set('region',e.target.value)}
              placeholder="us-east-1, eastus…" />
          </Field>
          <div onClick={()=>set('public',!form.public)}
            style={{ display:'flex',alignItems:'center',gap:10,marginBottom:18,
              padding:'10px 12px',background:T.surface2,borderRadius:8,
              border:`1px solid ${form.public?T.red+'44':T.border}`,
              cursor:'pointer',transition:'border-color .15s' }}>
            <div style={{ width:16,height:16,borderRadius:4,flexShrink:0,
              border:`1.5px solid ${form.public?T.red:T.border2}`,
              background:form.public?T.red+'30':'transparent',
              display:'flex',alignItems:'center',justifyContent:'center',
              transition:'all .15s' }}>
              {form.public&&<span style={{ color:T.red,fontSize:10,lineHeight:1 }}>✓</span>}
            </div>
            <span style={{ ...mono,fontSize:11,
              color:form.public?T.red:T.dim }}>Internet-exposed (public)</span>
          </div>
          <div style={{ display:'flex',justifyContent:'flex-end',gap:10 }}>
            <button onClick={onClose}
              style={{ ...mono,fontSize:11,padding:'8px 16px',background:'none',
                border:`1px solid ${T.border2}`,borderRadius:8,
                color:T.muted,cursor:'pointer' }}>Cancel</button>
            <button onClick={()=>onSave(form)}
              style={{ ...mono,fontSize:11,padding:'8px 18px',background:T.amber,
                border:'none',borderRadius:8,color:'#000',
                fontWeight:700,cursor:'pointer' }}>Create</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function InfraPage() {
  const [infra,     setInfra]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [filter,    setFilter]    = useState('all')
  const [expanded,  setExpanded]  = useState(null) // id of expanded row

  const load = useCallback(()=>{
    api.infra.list().then(setInfra).finally(()=>setLoading(false))
  },[])
  useEffect(()=>{ load() },[load])

  const filtered = filter==='all'   ? infra
    : filter==='public' ? infra.filter(i=>i.public)
    : infra.filter(i=>i.provider===filter)

  const handleSave   = async (form)=>{ await api.infra.create(form); setShowModal(false); load() }
  const handleDelete = async (id)=>{
    if(!confirm('Delete this resource?')) return
    await api.infra.delete(id)
    if(expanded===id) setExpanded(null)
    load()
  }
  const toggleExpand = (id)=>setExpanded(prev=>prev===id?null:id)

  const providerCounts = Object.keys(PROVIDER_META).reduce((acc,p)=>({
    ...acc,[p]:infra.filter(i=>i.provider===p).length
  }),{})
  const publicCount = infra.filter(i=>i.public).length

  return (
    <div style={{ minHeight:'100vh',
      background:`radial-gradient(ellipse at 10% 20%,#0a1628 0%,${T.bg} 60%)`,
      padding:'28px 32px' }}>
      <style>{`
        @keyframes expand{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
        .infra-row:hover td{background:${T.surface2}!important}
      `}</style>

      {/* Header */}
      <div style={{ display:'flex',alignItems:'center',
        justifyContent:'space-between',marginBottom:24 }}>
        <div>
          <h1 style={{ ...mono,fontSize:20,fontWeight:800,color:T.text,
            letterSpacing:'-0.02em',margin:'0 0 6px' }}>Infrastructure</h1>
          <p style={{ ...mono,fontSize:11,color:T.muted,letterSpacing:'0.05em' }}>
            {infra.length} RESOURCES · {publicCount} PUBLIC
          </p>
        </div>
        <button onClick={()=>setShowModal(true)}
          style={{ display:'flex',alignItems:'center',gap:8,padding:'10px 18px',
            background:T.amber,border:'none',borderRadius:10,color:'#000',
            ...mono,fontSize:12,fontWeight:700,cursor:'pointer',
            boxShadow:`0 0 20px ${T.amber}33` }}>
          <span style={{ fontSize:16,lineHeight:1 }}>+</span> New Resource
        </button>
      </div>

      {/* Provider summary cards */}
      <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',
        gap:12,marginBottom:24 }}>
        {Object.entries(PROVIDER_META).map(([key,m])=>(
          <div key={key}
            onClick={()=>setFilter(filter===key?'all':key)}
            style={{ background:T.surface,
              border:`1px solid ${filter===key?m.color+'55':T.border}`,
              borderRadius:12,padding:'14px 16px',cursor:'pointer',
              boxShadow:filter===key?`0 0 20px ${m.color}18`:'none',
              transition:'all .2s',position:'relative',overflow:'hidden' }}>
            {filter===key&&(
              <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
                background:`linear-gradient(90deg,transparent,${m.color}77,transparent)` }} />
            )}
            <div style={{ fontSize:20,marginBottom:8,opacity:0.5 }}>{m.icon}</div>
            <div style={{ ...mono,fontSize:26,fontWeight:800,
              color:m.color,lineHeight:1 }}>{providerCounts[key]}</div>
            <div style={{ ...mono,fontSize:9,color:T.muted,
              marginTop:4,letterSpacing:'0.08em' }}>{m.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* Filter pills */}
      <div style={{ display:'flex',gap:8,marginBottom:20 }}>
        {[['all','All',T.green],['public','🌐 Public Only',T.red]].map(([key,label,color])=>(
          <button key={key} onClick={()=>setFilter(key)} style={{
            ...mono,fontSize:10,fontWeight:600,padding:'6px 14px',
            borderRadius:8,cursor:'pointer',
            background:filter===key?color+'20':T.surface,
            border:`1px solid ${filter===key?color:T.border2}`,
            color:filter===key?color:T.muted,transition:'all .15s',
          }}>{label}</button>
        ))}
        {expanded&&(
          <div style={{ ...mono,fontSize:10,color:T.dim,
            display:'flex',alignItems:'center',gap:6,marginLeft:'auto' }}>
            <div style={{ width:5,height:5,borderRadius:'50%',
              background:T.teal,boxShadow:`0 0 4px ${T.teal}` }} />
            1 resource expanded — click row to collapse
          </div>
        )}
      </div>

      {/* Table */}
      <div style={{ background:T.surface,border:`1px solid ${T.border}`,
        borderRadius:14,overflow:'hidden' }}>
        <table style={{ width:'100%',borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${T.border}` }}>
              {[
                { label:'',        width:40  },
                { label:'Resource'            },
                { label:'Provider', width:100 },
                { label:'Type',     width:140 },
                { label:'Region',   width:130 },
                { label:'Access',   width:100 },
                { label:'',         width:80  },
              ].map((h,i)=>(
                <th key={i} style={{ ...mono,fontSize:9,color:T.muted,
                  textAlign:'left',padding:'12px 16px',
                  letterSpacing:'0.1em',fontWeight:700,
                  width:h.width||undefined }}>{h.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading?(
              <tr><td colSpan={7}><Spinner/></td></tr>
            ):filtered.length===0?(
              <tr><td colSpan={7} style={{ ...mono,fontSize:12,color:T.muted,
                textAlign:'center',padding:40 }}>No resources found</td></tr>
            ):filtered.map(item=>{
              const m = PROVIDER_META[item.provider]||{ color:T.muted }
              const isOpen = expanded===item.id
              return (
                <>
                  {/* Main row */}
                  <tr key={item.id}
                    className="infra-row"
                    onClick={()=>toggleExpand(item.id)}
                    style={{ borderBottom:isOpen?'none':`1px solid ${T.border}`,
                      cursor:'pointer',
                      background:isOpen?`${m.color}08`:'transparent',
                      transition:'background .15s' }}>

                    {/* Chevron */}
                    <td style={{ padding:'13px 0 13px 16px',width:40 }}>
                      <div style={{ width:20,height:20,borderRadius:5,
                        display:'flex',alignItems:'center',justifyContent:'center',
                        background:isOpen?m.color+'20':T.surface2,
                        border:`1px solid ${isOpen?m.color+'44':T.border}`,
                        transition:'all .2s',fontSize:10,color:m.color }}>
                        {isOpen?'▾':'▸'}
                      </div>
                    </td>

                    {/* Name */}
                    <td style={{ padding:'13px 16px' }}>
                      <div style={{ display:'flex',alignItems:'center',gap:10 }}>
                        <div style={{ width:6,height:6,borderRadius:2,
                          background:m.color,boxShadow:`0 0 8px ${m.color}`,
                          flexShrink:0 }} />
                        <div>
                          <span style={{ ...mono,fontSize:13,fontWeight:600,
                            color:T.text }}>{item.name}</span>
                          <div style={{ ...mono,fontSize:9,color:T.muted,marginTop:2 }}>
                            {item.id.slice(0,8)}…
                          </div>
                        </div>
                      </div>
                    </td>

                    <td style={{ padding:'13px 16px' }}>
                      <ProviderBadge provider={item.provider}/>
                    </td>
                    <td style={{ padding:'13px 16px',...mono,fontSize:11,color:T.dim }}>
                      {item.resource_type}
                    </td>
                    <td style={{ padding:'13px 16px',...mono,fontSize:11,color:T.dim }}>
                      {item.region||'—'}
                    </td>
                    <td style={{ padding:'13px 16px' }}>
                      <AccessBadge pub={item.public}/>
                    </td>
                    <td style={{ padding:'13px 16px' }} onClick={e=>e.stopPropagation()}>
                      <button onClick={()=>handleDelete(item.id)}
                        style={{ ...mono,fontSize:10,padding:'5px 12px',
                          background:T.red+'12',border:`1px solid ${T.red}30`,
                          borderRadius:6,color:T.red,cursor:'pointer' }}>
                        Delete
                      </button>
                    </td>
                  </tr>

                  {/* Expanded dependency panel */}
                  {isOpen&&(
                    <DependencyPanel
                      key={`dep-${item.id}`}
                      infraId={item.id}
                      infraName={item.name}
                      providerColor={m.color}
                    />
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>

      {showModal&&(
        <InfraModal onSave={handleSave} onClose={()=>setShowModal(false)}/>
      )}
    </div>
  )
}