'use client'

export const dynamic = 'force-dynamic'
import { useState, useEffect, useCallback } from 'react'
import { useTheme, getT } from '@/lib/theme'

// Module-level fallback — satisfies sub-component defaults and constants.
// The default export re-derives T from useTheme() for live theme switching.
const T = getT('dark')



const mono = { fontFamily:'monospace' }
const mono9 = { ...mono, fontSize:9 }

const PROVIDER_META = {
  aws:   { label:'AWS',   color:'#f59e0b', icon:'☁', capabilities:'EC2 · RDS · Lambda · EKS · ECS · ALB · ElastiCache' },
  azure: { label:'Azure', color:'#38bdf8', icon:'◈', capabilities:'VMs · AKS · SQL · App Services · Redis · VNets' },
  gcp:   { label:'GCP',   color:'#22c55e', icon:'◎', capabilities:'Compute · GKE · Cloud SQL · Cloud Run' },
}

const AWS_REGIONS = [
  'us-east-1','us-east-2','us-west-1','us-west-2',
  'eu-west-1','eu-west-2','eu-west-3','eu-central-1','eu-north-1',
  'ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-northeast-2','ap-south-1',
  'sa-east-1','ca-central-1',
]

const RESOURCE_ICONS = {
  ec2_instance:'⬡',    rds_instance:'◎',     function:'λ',         eks_cluster:'⎔',
  ecs_cluster:'⬡',     load_balancer:'⇌',    elasticache:'⚡',      s3_bucket:'◫',
  vm:'⬡',              aks_cluster:'⎔',       sql_server:'◎',       app_service:'◈',
  function_app:'λ',    redis:'⚡',             vnet:'⊕',              compute_instance:'⬡',
  gke_cluster:'⎔',    cloud_sql:'◎',         cloud_run:'◈',         app_insights:'◉',
  storage_account:'◫', service_bus:'⇌',      key_vault:'🔐',        dynamodb:'◎',
  cloud_function:'λ',  cosmos_db:'◎',         event_hub:'⇌',        logic_app:'λ',
  container_app:'⬡',   api_management:'⇌',   app_service_plan:'⎔', nsg:'⊘',
  container_registry:'⬡', private_dns:'⊕',   log_analytics:'◉',    static_web_app:'◈',
}

function Spinner({ color = T.teal, size = 20 }) {
  return (
    <>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <span style={{ display:'inline-block', width:size, height:size, borderRadius:'50%',
        border:`2px solid ${T.border2}`, borderTopColor:color,
        animation:'spin .7s linear infinite', flexShrink:0 }}/>
    </>
  )
}

function Badge({ label, color }) {
  return (
    <span style={{ ...mono9, fontWeight:700, color,
      background:color+'18', border:`1px solid ${color}33`,
      borderRadius:3, padding:'1px 7px', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>
      {label}
    </span>
  )
}

function SummaryCards({ summary }) {
  const { total = 0, totalMapped = 0, unmapped = 0, byProvider = {} } = summary || {}
  const pct = total ? Math.round(totalMapped / total * 100) : 0
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:20 }}>
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ ...mono, fontSize:24, fontWeight:800, color:T.text }}>{total}</div>
        <div style={{ ...mono9, color:T.muted, marginTop:3, letterSpacing:'0.1em' }}>TOTAL RESOURCES</div>
      </div>
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ ...mono, fontSize:24, fontWeight:800, color:T.green }}>{totalMapped}</div>
        <div style={{ ...mono9, color:T.muted, marginTop:3, letterSpacing:'0.1em' }}>MAPPED TO APPS</div>
        <div style={{ height:2, background:T.border2, borderRadius:1, marginTop:8 }}>
          <div style={{ height:'100%', width:`${pct}%`, background:T.green, borderRadius:1, transition:'width .4s' }}/>
        </div>
      </div>
      <div style={{ background:T.surface, border:`1px solid ${unmapped > 0 ? T.amber+'44' : T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ ...mono, fontSize:24, fontWeight:800, color: unmapped > 0 ? T.amber : T.muted }}>{unmapped}</div>
        <div style={{ ...mono9, color:T.muted, marginTop:3, letterSpacing:'0.1em' }}>UNMAPPED</div>
      </div>
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {Object.keys(PROVIDER_META).map(p => {
            const pm = PROVIDER_META[p], d = byProvider[p] || { total:0 }
            return (
              <div key={p} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ ...mono9, fontWeight:700, color:pm.color, minWidth:36 }}>{pm.label}</span>
                <div style={{ flex:1, height:4, background:T.border2, borderRadius:2 }}>
                  <div style={{ height:'100%', width:`${total ? d.total/total*100 : 0}%`, background:pm.color, borderRadius:2 }}/>
                </div>
                <span style={{ ...mono9, color:T.dim, minWidth:22, textAlign:'right' }}>{d.total}</span>
              </div>
            )
          })}
          {!Object.keys(byProvider).length && <div style={{ ...mono9, color:T.muted }}>Run a scan to populate</div>}
        </div>
      </div>
    </div>
  )
}

function AccountCard({ account }) {
  const pm = PROVIDER_META[account.provider] || { color:T.muted, label:account.provider, capabilities:'' }

  return (
    <div style={{ background:T.surface, border:`1px solid ${pm.color}44`, borderRadius:12, overflow:'hidden' }}>
      <div style={{ height:1, background:`linear-gradient(90deg,transparent,${pm.color}66,transparent)` }}/>
      <div style={{ padding:'14px 16px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:34, height:34, borderRadius:8, background:pm.color+'20',
            border:`1.5px solid ${pm.color}55`, display:'flex', alignItems:'center',
            justifyContent:'center', fontSize:15, color:pm.color, flexShrink:0 }}>{pm.icon}</div>
          <div style={{ flex:1 }}>
            <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>{pm.label}</div>
            <div style={{ ...mono9, color:T.dim, marginTop:1 }}>{pm.capabilities}</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:T.green, boxShadow:`0 0 5px ${T.green}` }}/>
            <span style={{ ...mono9, color:T.green, fontWeight:700 }}>CONNECTED</span>
          </div>
        </div>
        {account.config && (
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginTop:10 }}>
            {account.provider==='aws' && account.config.accountId &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Account: {account.config.accountId}</span>}
            {account.provider==='aws' && account.config.regions &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Regions: {account.config.regions}</span>}
            {account.provider==='azure' && account.config.subscriptionId &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Sub: {account.config.subscriptionId?.slice(0,8)}…</span>}
            {account.provider==='gcp' && account.config.projectId &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Project: {account.config.projectId}</span>}
            {account.last_scan_status &&
              <span style={{ ...mono9, color: account.last_scan_status === 'success' ? T.green : T.amber,
                background: (account.last_scan_status === 'success' ? T.green : T.amber) + '15',
                border:`1px solid ${(account.last_scan_status === 'success' ? T.green : T.amber)}33`,
                borderRadius:3, padding:'1px 7px' }}>
                {account.last_scan_status === 'success' ? '✓' : '⚠'} Last scan: {account.last_scan_status}
              </span>}
          </div>
        )}
      </div>
    </div>
  )
}

function NoAccounts() {
  return (
    <div style={{ padding:'40px 24px', textAlign:'center', background:T.surface,
      border:`1px solid ${T.border}`, borderRadius:12 }}>
      <div style={{ fontSize:32, marginBottom:12, opacity:.4 }}>◎</div>
      <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text, marginBottom:6 }}>No cloud accounts configured</div>
      <div style={{ ...mono, fontSize:11, color:T.dim, maxWidth:360, margin:'0 auto 16px', lineHeight:1.7 }}>
        Connect AWS, Azure or GCP in <strong style={{ color:T.teal }}>Integrations</strong> to enable live discovery.
        Credentials are stored once and reused here.
      </div>
      <a href="/integrations" style={{ ...mono, fontSize:11, fontWeight:700,
        color:T.teal, background:T.teal+'18', border:`1px solid ${T.teal}44`,
        borderRadius:8, padding:'8px 18px', textDecoration:'none', display:'inline-block' }}>
        Go to Integrations →
      </a>
    </div>
  )
}

function ResourceTable({ resources, onLink, onDelete, onBulkDelete }) {
  const [filter,        setFilter]        = useState({ provider:'', mapped:'', search:'' })
  const [selected,      setSelected]      = useState(null)   // detail panel
  const [checkedIds,    setCheckedIds]    = useState(new Set()) // bulk select
  const [bulkDeleting,  setBulkDeleting]  = useState(false)
  const [bulkResult,    setBulkResult]    = useState(null)
  const inputStyle = { background:T.surface2, border:`1px solid ${T.border2}`, borderRadius:6,
    padding:'7px 10px', color:T.text, fontSize:11, fontFamily:'monospace', outline:'none', boxSizing:'border-box' }
  const filtered = (resources||[]).filter(r => {
    if (filter.provider && r.provider !== filter.provider) return false
    if (filter.mapped === 'mapped'   && !r.mapped) return false
    if (filter.mapped === 'unmapped' &&  r.mapped) return false
    if (filter.search && !r.name?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  const toggleCheck = (id, e) => {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (checkedIds.size === filtered.length) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(filtered.map(r => r.id)))
    }
  }

  const bulkDelete = async () => {
    if (!checkedIds.size) return
    if (!window.confirm(`Delete ${checkedIds.size} resource(s)? Linked resources will be skipped.`)) return
    setBulkDeleting(true); setBulkResult(null)
    try {
      const res = await fetch('/api/discovery/resources/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...checkedIds] }),
      })
      const data = await res.json()
      setBulkResult(data)
      setCheckedIds(new Set())
      onBulkDelete?.()
    } catch (e) {
      setBulkResult({ deleted: 0, errors: [{ error: e.message }] })
    } finally {
      setBulkDeleting(false)
    }
  }

  const allChecked = filtered.length > 0 && checkedIds.size === filtered.length
  const someChecked = checkedIds.size > 0

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap', alignItems:'center' }}>
        <input style={{ ...inputStyle, width:200 }} placeholder="Search by name…"
          value={filter.search} onChange={e => setFilter(f=>({...f,search:e.target.value}))}/>
        <select style={{ ...inputStyle, cursor:'pointer', appearance:'none', width:130 }}
          value={filter.provider} onChange={e => setFilter(f=>({...f,provider:e.target.value}))}>
          <option value="">All providers</option>
          {Object.entries(PROVIDER_META).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select style={{ ...inputStyle, cursor:'pointer', appearance:'none', width:130 }}
          value={filter.mapped} onChange={e => setFilter(f=>({...f,mapped:e.target.value}))}>
          <option value="">All</option>
          <option value="mapped">Mapped to app</option>
          <option value="unmapped">Unmapped</option>
        </select>
        {someChecked && (
          <button onClick={bulkDelete} disabled={bulkDeleting}
            style={{ ...mono, fontSize:11, fontWeight:700, padding:'6px 14px', borderRadius:7,
              cursor:'pointer', background:T.red+'18', border:`1px solid ${T.red}44`,
              color:T.red, opacity:bulkDeleting?.6:1,
              display:'flex', alignItems:'center', gap:6 }}>
            {bulkDeleting ? <><Spinner size={11} color={T.red}/> Deleting…</> : `🗑 Delete ${checkedIds.size} selected`}
          </button>
        )}
        <span style={{ ...mono9, color:T.dim, alignSelf:'center', marginLeft:'auto' }}>
          {filtered.length} of {resources?.length??0} resources
          {someChecked && <span style={{ color:T.red }}> · {checkedIds.size} selected</span>}
        </span>
      </div>

      {/* Bulk delete result */}
      {bulkResult && (
        <div style={{ padding:'8px 12px', borderRadius:7, marginBottom:8,
          background: bulkResult.deleted > 0 ? T.green+'0a' : T.amber+'0a',
          border:`1px solid ${bulkResult.deleted > 0 ? T.green+'33' : T.amber+'33'}` }}>
          <span style={{ ...mono9, color: bulkResult.deleted > 0 ? T.green : T.amber }}>
            {bulkResult.deleted > 0 && `✓ ${bulkResult.deleted} deleted  `}
            {bulkResult.skipped?.length > 0 && `⚠ ${bulkResult.skipped.length} skipped (linked to components)  `}
            {bulkResult.errors?.length > 0 && `✗ ${bulkResult.errors.length} errors`}
          </span>
          {bulkResult.skipped?.map((s,i) => (
            <div key={i} style={{ ...mono9, color:T.amber, marginTop:2 }}>
              – {s.name}: {s.reason}
            </div>
          ))}
        </div>
      )}
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${T.border}` }}>
              <th style={{ padding:'10px 8px 10px 14px', width:32 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll}
                  style={{ cursor:'pointer', width:14, height:14 }}/>
              </th>
              {['Resource','Type','Provider','Region','Status','Applications',''].map(h => (
                <th key={h} style={{ ...mono9, color:T.muted, textAlign:'left', padding:'10px 14px', letterSpacing:'0.1em', fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!filtered.length ? (
              <tr><td colSpan={7} style={{ ...mono, fontSize:11, color:T.muted, textAlign:'center', padding:'32px 0' }}>No resources found</td></tr>
            ) : filtered.map(r => {
              const pm = PROVIDER_META[r.provider]||{color:T.muted,label:r.provider}
              const icon = RESOURCE_ICONS[r.resource_type]||'⬡'
              const isSel = selected?.id === r.id
              const sc = ['running','active','available'].includes(r.status)?T.green:['stopped','failed','error'].includes(r.status)?T.red:T.amber
              return (
                <tr key={r.id} onClick={()=>setSelected(isSel?null:r)}
                  style={{ borderBottom:`1px solid ${T.border}`, cursor:'pointer',
                    background: checkedIds.has(r.id) ? T.red+'08' : isSel ? T.surface2 : 'transparent',
                    transition:'background .1s' }}
                  onMouseEnter={e=>!checkedIds.has(r.id)&&!isSel&&(e.currentTarget.style.background=T.surface3||T.surface2)}
                  onMouseLeave={e=>!checkedIds.has(r.id)&&!isSel&&(e.currentTarget.style.background='transparent')}>
                  <td style={{ padding:'10px 8px 10px 14px' }} onClick={e=>e.stopPropagation()}>
                    <input type="checkbox" checked={checkedIds.has(r.id)}
                      onChange={e => toggleCheck(r.id, e)}
                      style={{ cursor:'pointer', width:14, height:14 }}/>
                  </td>
                  <td style={{ padding:'10px 14px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ color:pm.color, fontSize:13 }}>{icon}</span>
                      <div>
                        <div style={{ ...mono, fontSize:12, fontWeight:600, color:T.text }}>{r.name}</div>
                        <div style={{ ...mono9, color:T.dim, marginTop:1 }}>{r.cloud_id?.slice(0,44)}{r.cloud_id?.length>44?'…':''}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding:'10px 14px' }}><Badge label={r.resource_type?.replace(/_/g,' ')} color={pm.color}/></td>
                  <td style={{ padding:'10px 14px' }}><Badge label={pm.label} color={pm.color}/></td>
                  <td style={{ padding:'10px 14px', ...mono, fontSize:10, color:T.dim }}>{r.region||'—'}</td>
                  <td style={{ padding:'10px 14px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                      <div style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background:sc }}/>
                      <span style={{ ...mono, fontSize:10, color:T.dim }}>{r.status||'—'}</span>
                    </div>
                  </td>
                  <td style={{ padding:'10px 14px' }}>
                    {r.applications?.length
                      ? <div style={{ display:'flex', gap:3 }}>
                          {r.applications.slice(0,2).map(a=>(
                            <span key={a} style={{ ...mono9, color:T.teal, background:T.teal+'15', border:`1px solid ${T.teal}33`, borderRadius:3, padding:'1px 5px' }}>{a}</span>
                          ))}
                          {r.applications.length>2&&<span style={{ ...mono9, color:T.dim }}>+{r.applications.length-2}</span>}
                        </div>
                      : <span style={{ ...mono9, color:T.muted }}>unmapped</span>}
                  </td>
                  <td style={{ padding:'10px 14px' }}>
                    <div style={{ display:'flex', gap:5 }}>
                      <button onClick={e=>{e.stopPropagation();onLink?.(r)}} style={{ ...mono9, padding:'3px 8px', cursor:'pointer', background:T.teal+'15', border:`1px solid ${T.teal}33`, borderRadius:4, color:T.teal }}>Link</button>
                      <button onClick={e=>{e.stopPropagation();onDelete?.(r.id)}} style={{ ...mono9, padding:'3px 8px', cursor:'pointer', background:T.red+'12', border:`1px solid ${T.red}30`, borderRadius:4, color:T.red }}>Delete</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {selected && (() => {
        // Handle tags and raw being either a parsed object or a JSON string
        const parseProp = (val) => {
          if (!val) return {}
          if (typeof val === 'object') return val
          try { return JSON.parse(val) } catch { return {} }
        }
        const rawObj  = parseProp(selected.raw)
        const tagsObj = parseProp(selected.tags)
        const rawEntries  = Object.entries(rawObj).filter(([,v]) => v != null && v !== '')
        const tagsEntries = Object.entries(tagsObj)
        return (
          <div style={{ marginTop:10, background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
            {/* Header */}
            <div style={{ padding:'10px 16px', borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ color:(PROVIDER_META[selected.provider]||{color:T.muted}).color, fontSize:16 }}>
                  {RESOURCE_ICONS[selected.resource_type]||'⬡'}
                </span>
                <div>
                  <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>{selected.name}</div>
                  <div style={{ ...mono9, color:T.dim }}>{selected.resource_type?.replace(/_/g,' ')} · {selected.provider} · {selected.region}</div>
                </div>
              </div>
              <button onClick={()=>setSelected(null)} style={{ ...mono, fontSize:18, color:T.muted, background:'transparent', border:'none', cursor:'pointer', lineHeight:1 }}>×</button>
            </div>

            {/* Tags — shown prominently since they drive mapping */}
            {tagsEntries.length > 0 && (
              <div style={{ padding:'12px 16px', borderBottom:`1px solid ${T.border}` }}>
                <div style={{ ...mono9, color:T.muted, letterSpacing:'0.1em', fontWeight:700, marginBottom:8 }}>TAGS</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                  {tagsEntries.map(([k,v]) => (
                    <div key={k} style={{ display:'flex', alignItems:'center', borderRadius:5, overflow:'hidden',
                      border:`1px solid ${T.border}`, fontSize:11, fontFamily:'monospace' }}>
                      <span style={{ padding:'3px 8px', background:T.surface2, color:T.muted, borderRight:`1px solid ${T.border}` }}>{k}</span>
                      <span style={{ padding:'3px 8px', background:T.teal+'10', color:T.teal, fontWeight:600 }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {tagsEntries.length === 0 && (
              <div style={{ padding:'10px 16px', borderBottom:`1px solid ${T.border}` }}>
                <div style={{ ...mono9, color:T.muted, letterSpacing:'0.1em', fontWeight:700, marginBottom:4 }}>TAGS</div>
                <div style={{ ...mono9, color:T.muted, fontStyle:'italic' }}>
                  No tags — add tags in the cloud console to enable auto-mapping
                </div>
              </div>
            )}

            {/* Raw metadata */}
            {rawEntries.length > 0 && (
              <div style={{ padding:'12px 16px' }}>
                <div style={{ ...mono9, color:T.muted, letterSpacing:'0.1em', fontWeight:700, marginBottom:8 }}>METADATA</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  {rawEntries.map(([k,v]) => (
                    <div key={k} style={{ padding:'6px 10px', background:T.surface2, border:`1px solid ${T.border}`, borderRadius:6 }}>
                      <div style={{ ...mono9, color:T.muted, letterSpacing:'0.08em', marginBottom:2 }}>{k.replace(/_/g,' ').toUpperCase()}</div>
                      <div style={{ ...mono, fontSize:10, color:T.text, wordBreak:'break-all' }}>
                        {v==null?'—':typeof v==='boolean'?(v?'✓ Yes':'✗ No'):Array.isArray(v)?v.join(', ')||'—':String(v)||'—'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

function LinkModal({ resource, onClose, onLinked }) {
  const [components, setComponents] = useState([])
  const [selected,   setSelected]   = useState('')
  const [linking,    setLinking]     = useState(false)
  useEffect(() => { fetch('/api/components').then(r=>r.json()).then(setComponents).catch(()=>{}) }, [])
  const doLink = async () => {
    if (!selected) return
    setLinking(true)
    try {
      await fetch('/api/discovery/link', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ infraId:resource.id, componentId:selected }) })
      onLinked?.(); onClose()
    } finally { setLinking(false) }
  }
  return (
    <div style={{ position:'fixed', inset:0, zIndex:80, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ position:'absolute', inset:0, background:'#000000cc', backdropFilter:'blur(4px)' }} onClick={onClose}/>
      <div style={{ position:'relative', background:T.surface, border:`1px solid ${T.teal}44`, borderRadius:14, width:'100%', maxWidth:440, boxShadow:'0 0 50px #00000099' }}>
        <div style={{ padding:'14px 18px', borderBottom:`1px solid ${T.border}` }}>
          <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>Link to Component</div>
          <div style={{ ...mono9, color:T.dim, marginTop:3 }}>{resource.name}</div>
        </div>
        <div style={{ padding:'16px 18px' }}>
          <div style={{ ...mono9, color:T.muted, marginBottom:6, letterSpacing:'0.1em', fontWeight:700 }}>SELECT COMPONENT</div>
          <select style={{ width:'100%', background:T.surface2, border:`1px solid ${T.border2}`, borderRadius:7, padding:'9px 11px',
            color:T.text, fontSize:11, fontFamily:'monospace', outline:'none', cursor:'pointer', appearance:'none', marginBottom:14 }}
            value={selected} onChange={e=>setSelected(e.target.value)}>
            <option value="">— choose a component —</option>
            {components.map(c=><option key={c.id} value={c.id}>{c.name} [{c.type}]</option>)}
          </select>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{ ...mono, fontSize:11, padding:'8px 16px', background:'transparent', border:`1px solid ${T.border2}`, borderRadius:7, color:T.muted, cursor:'pointer' }}>Cancel</button>
            <button onClick={doLink} disabled={!selected||linking} style={{ ...mono, fontSize:11, fontWeight:700, padding:'8px 18px', background:T.teal+'22', border:`1px solid ${T.teal}66`, borderRadius:7, color:T.teal, cursor:'pointer', opacity:!selected||linking?.5:1 }}>
              {linking?'Linking…':'Link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── Scheduler Panel ───────────────────────────────────────────────────────────

// ── Mapping Suggestions Panel ─────────────────────────────────────────────────
function SuggestionsPanel({ onMappingApplied }) {
  const { theme } = useTheme()
  const T = getT(theme)
  const mono  = { fontFamily:'monospace' }
  const mono9 = { ...mono, fontSize:9 }

  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)
  const [diagnostic, setDiagnostic] = useState(null)
  const [minScore, setMinScore] = useState(25)

  const load = async () => {
    setLoading(true)
    setSuggestions([])
    setResult(null)
    setDiagnostic(null)

    try {
      const res = await fetch(`/api/discovery/suggest?minScore=${minScore}&limit=200`)
      const data = await res.json()
      const list = Array.isArray(data) ? data : data.suggestions || []
      const diag = Array.isArray(data) ? null : data.diagnostic
      setSuggestions(list)
      setDiagnostic(diag)
    } catch (e) {
      setDiagnostic({ message: `Failed to load: ${e.message}`, error: true })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [minScore])

  const recommendedActions = suggestions
    .map(item => {
      const top = (item.suggestions || [])[0]
      if (!top) return null
      return { ...top, infraId: item.infra.id }
    })
    .filter(Boolean)

  const applyAll = async () => {
    if (!recommendedActions.length) return
    setApplying(true)
    setResult(null)

    try {
      const res = await fetch('/api/discovery/suggest/apply-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: recommendedActions }),
      })
      const data = await res.json()
      setResult(data)
      onMappingApplied?.()
      load()
    } catch (e) {
      setResult({ errors: [e.message] })
    } finally {
      setApplying(false)
    }
  }

  const ACTION_META = {
    link_component:     { color: '#2dd4bf', icon: '⟶', label: 'Link' },
    create_component:   { color: '#a78bfa', icon: '+', label: 'Create Component' },
    create_application: { color: '#f59e0b', icon: '✦', label: 'Create Application' },
  }
  const CONF_COLOR = { high: T.green, medium: T.amber, low: T.muted }

  return (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:14,
      padding:'18px 20px', marginBottom:24 }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:T.purple+'18',
            border:`1.5px solid ${T.purple}44`, display:'flex', alignItems:'center',
            justifyContent:'center', fontSize:16 }}>⟡</div>
          <div>
            <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>Mapping Suggestions</div>
            <div style={{ ...mono9, color:T.dim, marginTop:1 }}>
              Tag-driven recommendations — link, create components, or onboard new applications
            </div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {[25,45,70].map(s => (
            <button key={s} onClick={() => setMinScore(s)}
              style={{ ...mono9, padding:'3px 8px', borderRadius:5, cursor:'pointer',
                border:`1px solid ${minScore===s ? T.purple+'66' : T.border}`,
                background: minScore===s ? T.purple+'18' : T.surface2,
                color: minScore===s ? T.purple : T.muted }}>
              {s === 25 ? 'All' : s === 45 ? 'Medium+' : 'High'}
            </button>
          ))}
        </div>
      </div>

      {/* Empty / diagnostic state */}
      {suggestions.length === 0 && !loading && (
        <div style={{ padding:'16px', borderRadius:8, textAlign:'center',
          background: diagnostic?.error ? T.red+'0a' : T.surface2,
          border: `1px solid ${diagnostic?.error ? T.red+'33' : T.border}` }}>
          {!diagnostic ? (
            <div style={{ ...mono9, color:T.muted }}>
              No suggestions found at current threshold — try lowering the confidence filter above
            </div>
          ) : (
            <>
              <div style={{ ...mono9, color: diagnostic.error ? T.red : T.muted, marginBottom:4 }}>
                {diagnostic.message}
              </div>
              {diagnostic.hint && <div style={{ ...mono9, color:T.teal }}>{diagnostic.hint}</div>}
              {diagnostic.unmappedInfra > 0 && (
                <div style={{ display:'flex', gap:16, justifyContent:'center', marginTop:8 }}>
                  <span style={{ ...mono9, color:T.dim }}>Unmapped: <strong style={{ color:T.text }}>{diagnostic.unmappedInfra}</strong></span>
                  <span style={{ ...mono9, color:T.dim }}>Applications: <strong style={{ color:T.text }}>{diagnostic.applications}</strong></span>
                  {diagnostic.belowThreshold > 0 && <span style={{ ...mono9, color:T.amber }}>Below threshold: {diagnostic.belowThreshold}</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {suggestions.length > 0 && (
        <>
          {/* Bulk action bar */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12,
            padding:'8px 12px', borderRadius:8, background:T.surface2, border:`1px solid ${T.border}` }}>
            <span style={{ ...mono9, color:T.muted, flex:1 }}>
              {suggestions.length} resource{suggestions.length!==1?'s':''} with suggestions
            </span>
            {/* Legend */}
            <div style={{ display:'flex', gap:10 }}>
              {Object.entries(ACTION_META).map(([k, m]) => (
                <div key={k} style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ ...mono9, color:m.color, fontWeight:700 }}>{m.icon}</span>
                  <span style={{ ...mono9, color:T.muted }}>{m.label}</span>
                </div>
              ))}
            </div>
            <button onClick={applyAll} disabled={applying || recommendedActions.length === 0}
              style={{ ...mono, fontSize:11, fontWeight:700, padding:'7px 18px', borderRadius:8,
                cursor: recommendedActions.length === 0 ? 'not-allowed' : 'pointer',
                background: recommendedActions.length > 0 ? T.green : T.surface2,
                border:`1px solid ${recommendedActions.length > 0 ? T.green+'44' : T.border}`,
                color: recommendedActions.length > 0 ? 'white' : T.muted,
                opacity: applying ? .6 : 1,
                display:'flex', alignItems:'center', gap:6 }}>
              {applying ? <><Spinner size={12} color="white"/> Applying…</> : `✦ Apply All (${recommendedActions.length})`}
            </button>
          </div>

          {/* Result banner */}
          {result && (
            <div style={{ padding:'8px 12px', borderRadius:7, marginBottom:10,
              background: (result.errors?.length === 0) ? T.green+'0a' : T.amber+'0a',
              border:`1px solid ${result.errors?.length === 0 ? T.green+'33' : T.amber+'33'}` }}>
              <div style={{ ...mono9, color: result.errors?.length === 0 ? T.green : T.amber }}>
                {result.linked > 0 && `✓ ${result.linked} linked  `}
                {result.componentsCreated > 0 && `✓ ${result.componentsCreated} component(s) created  `}
                {result.applicationsCreated > 0 && `✓ ${result.applicationsCreated} application(s) created  `}
                {result.errors?.length > 0 && `⚠ ${result.errors.length} error(s)`}
              </div>
              {result.errors?.map((e,i) => (
                <div key={i} style={{ ...mono9, color:T.red, marginTop:2 }}>✗ {typeof e === 'string' ? e : JSON.stringify(e)}</div>
              ))}
            </div>
          )}

          {/* Suggestion cards */}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {suggestions.map(item => {
              const topSuggestion = item.suggestions?.[0]
              const confColor = CONF_COLOR[item.topConfidence] || T.muted

              return (
                <div key={item.infra.id} style={{ border:`1px solid ${T.border}`,
                  borderRadius:10, overflow:'hidden',
                  borderLeft:`3px solid ${confColor}`,
                  background: 'transparent' }}>

                  {/* Resource header row */}
                  <div style={{ display:'flex', alignItems:'center', gap:10,
                    padding:'10px 14px', background:T.surface2 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <span style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>
                          {RESOURCE_ICONS[item.infra.resourceType]||'◎'} {item.infra.name}
                        </span>
                        <span style={{ ...mono9, color:T.muted, background:T.surface,
                          border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 6px' }}>
                          {item.infra.resourceType?.replace(/_/g,' ')}
                        </span>
                        <span style={{ ...mono9, color:T.muted }}>{item.infra.provider} · {item.infra.region}</span>
                      </div>
                      {/* Tag preview */}
                      {Object.keys(item.infra.tags || {}).length > 0 && (
                        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:4 }}>
                          {Object.entries(item.infra.tags).slice(0,4).map(([k,v]) => (
                            <span key={k} style={{ ...mono9, borderRadius:4, overflow:'hidden',
                              border:`1px solid ${T.border}`, display:'flex' }}>
                              <span style={{ padding:'1px 6px', background:T.surface, color:T.muted, borderRight:`1px solid ${T.border}` }}>{k}</span>
                              <span style={{ padding:'1px 6px', background:T.teal+'10', color:T.teal }}>{String(v)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                      <span style={{ ...mono9, color:confColor, fontWeight:700 }}>{item.topScore}%</span>
                    </div>
                  </div>

                  {/* Recommended action */}
                  {topSuggestion && (
                    <div style={{ padding:'8px 14px 10px', display:'flex', flexDirection:'column', gap:6 }}>
                      <div style={{ display:'flex', alignItems:'flex-start', gap:10,
                        padding:'8px 12px', borderRadius:8,
                        border:`1px solid ${T.border}`,
                        background: T.surface }}>

                        <div style={{ width:14, height:14, borderRadius:'50%', flexShrink:0, marginTop:1,
                          border:`2px solid ${T.green}`,
                          background: T.green,
                          display:'flex', alignItems:'center', justifyContent:'center' }}>
                          <div style={{ width:5, height:5, borderRadius:'50%', background:'white' }}/>
                        </div>

                        <div style={{ flex:1, minWidth:0 }}>
                          {/* Recommended badge + action label */}
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                            <span style={{ ...mono9, padding:'2px 8px', borderRadius:4,
                              background:T.green+'18', border:`1px solid ${T.green}44`,
                              color:T.green, fontWeight:700 }}>
                              Recommended
                            </span>
                            <span style={{ ...mono, fontSize:11, color:T.text }}>{topSuggestion.actionLabel}</span>
                          </div>
                          {/* Reasons */}
                          <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                            {topSuggestion.reasons?.map((r, ri) => (
                              <span key={ri} style={{ ...mono9, color:T.dim, background:T.surface2,
                                border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 6px' }}>
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>

                        <span style={{ ...mono9, color:CONF_COLOR[topSuggestion.confidence] || T.muted, fontWeight:700, flexShrink:0 }}>
                          {topSuggestion.score}%
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}


function AutoDiscoveryBar({ onScanTriggered }) {
  const { theme } = useTheme()
  const T = getT(theme)
  const mono = { fontFamily:'monospace' }
  const mono9 = { ...mono, fontSize:9 }

  const [schedule,  setSchedule]  = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [hours,     setHours]     = useState(0)
  const [minutes,   setMinutes]   = useState(15)
  const [enabled,   setEnabled]   = useState(false)
  const [msg,       setMsg]       = useState(null)

  const load = () => {
    fetch('/api/discovery/schedule')
      .then(r => r.ok ? r.json() : null)
      .then(s => {
        if (!s) return
        setSchedule(s)
        setEnabled(s.enabled || false)
        const h = Math.floor((s.interval_mins || 15) / 60)
        const m = (s.interval_mins || 15) % 60
        setHours(h)
        setMinutes(m)
      })
      .catch(() => {})
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [enabled])

  const totalMins = hours * 60 + minutes

  const save = async () => {
    if (totalMins < 5) { setMsg({ ok:false, text:'Minimum interval is 5 minutes' }); return }
    setSaving(true); setMsg(null)
    try {
      const res = await fetch('/api/discovery/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, hours, minutes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Save failed')
      setSchedule(data)
      setMsg({ ok:true, text: enabled ? `Auto-scan every ${totalMins}m` : 'Auto-scan disabled' })
      setTimeout(() => setMsg(null), 3000)
    } catch (e) {
      setMsg({ ok:false, text: e.message })
    } finally {
      setSaving(false)
    }
  }

  const statusColor = schedule?.last_run_status === 'success' ? T.green
    : schedule?.last_run_status === 'error' ? T.red
    : schedule?.last_run_status === 'running' ? T.amber
    : T.muted

  const nextRun = schedule?.next_run_at && enabled
    ? new Date(schedule.next_run_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    : null

  return (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10,
      padding:'10px 16px', marginBottom:18, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>

      {/* Toggle */}
      <button onClick={() => setEnabled(e => !e)}
        style={{ position:'relative', width:36, height:20, borderRadius:10, border:'none',
          cursor:'pointer', transition:'background .2s', flexShrink:0,
          background: enabled ? T.teal : T.border2 }}>
        <div style={{ position:'absolute', top:2, left: enabled ? 18 : 2,
          width:16, height:16, borderRadius:'50%', background:'white',
          transition:'left .2s', boxShadow:'0 1px 3px #0004' }} />
      </button>

      <span style={{ ...mono, fontSize:11, fontWeight:700, color: enabled ? T.teal : T.muted, flexShrink:0 }}>
        Auto Discovery
      </span>

      {/* Interval presets */}
      <div style={{ display:'flex', gap:4, opacity: enabled ? 1 : 0.4 }}>
        {[[0,15,'15m'],[0,30,'30m'],[1,0,'1h'],[4,0,'4h'],[12,0,'12h']].map(([h,m,label]) => {
          const active = hours===h && minutes===m
          return (
            <button key={label} onClick={() => { if(enabled){ setHours(h); setMinutes(m) }}}
              style={{ ...mono9, padding:'3px 9px', borderRadius:5, cursor: enabled?'pointer':'default',
                border:`1px solid ${active?T.teal+'66':T.border}`,
                background:active?T.teal+'18':'transparent',
                color:active?T.teal:T.muted, fontWeight:active?700:400 }}>
              {label}
            </button>
          )
        })}
      </div>

      {/* Custom interval */}
      <div style={{ display:'flex', alignItems:'center', gap:4, opacity: enabled ? 1 : 0.4 }}>
        <button onClick={() => enabled && setHours(h => Math.max(0, h - 1))}
          style={{ ...mono9, width:20, height:20, borderRadius:4, border:`1px solid ${T.border2}`,
            background:'transparent', color:T.text, cursor: enabled?'pointer':'default', lineHeight:1 }}>−</button>
        <span style={{ ...mono, fontSize:12, fontWeight:700, color:T.text, minWidth:18, textAlign:'center' }}>{hours}</span>
        <button onClick={() => enabled && setHours(h => Math.min(23, h + 1))}
          style={{ ...mono9, width:20, height:20, borderRadius:4, border:`1px solid ${T.border2}`,
            background:'transparent', color:T.text, cursor: enabled?'pointer':'default', lineHeight:1 }}>+</button>
        <span style={{ ...mono9, color:T.muted }}>h</span>
        <button onClick={() => enabled && setMinutes(m => { const n = m-5; return n<0?(hours>0?55:5):n })}
          style={{ ...mono9, width:20, height:20, borderRadius:4, border:`1px solid ${T.border2}`,
            background:'transparent', color:T.text, cursor: enabled?'pointer':'default', lineHeight:1, marginLeft:4 }}>−</button>
        <span style={{ ...mono, fontSize:12, fontWeight:700, color:T.text, minWidth:18, textAlign:'center' }}>{String(minutes).padStart(2,'0')}</span>
        <button onClick={() => enabled && setMinutes(m => (m+5)%60)}
          style={{ ...mono9, width:20, height:20, borderRadius:4, border:`1px solid ${T.border2}`,
            background:'transparent', color:T.text, cursor: enabled?'pointer':'default', lineHeight:1 }}>+</button>
        <span style={{ ...mono9, color:T.muted }}>m</span>
      </div>

      {/* Save button */}
      <button onClick={save} disabled={saving}
        style={{ ...mono, fontSize:10, fontWeight:700, padding:'5px 14px', borderRadius:6,
          cursor:'pointer', border:'none', transition:'all .2s',
          background: enabled ? T.teal : T.surface2,
          color: enabled ? 'white' : T.muted,
          opacity: saving ? .6 : 1 }}>
        {saving ? '…' : 'Save'}
      </button>

      {/* Status */}
      <div style={{ display:'flex', alignItems:'center', gap:8, marginLeft:'auto', flexShrink:0 }}>
        {schedule?.last_run_at && (
          <span style={{ ...mono9, color:T.muted }}>
            Last: {new Date(schedule.last_run_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}
          </span>
        )}
        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:statusColor,
            boxShadow:`0 0 5px ${statusColor}` }} />
          <span style={{ ...mono9, color:statusColor, fontWeight:700 }}>
            {schedule?.last_run_status?.toUpperCase() || 'IDLE'}
          </span>
        </div>
        {nextRun && <span style={{ ...mono9, color:T.teal }}>Next {nextRun}</span>}
      </div>

      {/* Feedback message */}
      {msg && (
        <div style={{ width:'100%', padding:'5px 10px', borderRadius:5, marginTop:2,
          background: msg.ok?T.green+'0a':T.red+'0a',
          border:`1px solid ${msg.ok?T.green+'33':T.red+'33'}` }}>
          <span style={{ ...mono9, color: msg.ok?T.green:T.red }}>{msg.ok?'✓':'✗'} {msg.text}</span>
        </div>
      )}
    </div>
  )
}

export default function DiscoveryPage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const [summary, setSummary] = useState({ total: 0, totalMapped: 0, unmapped: 0, byProvider: {} })
  const [accounts, setAccounts] = useState([])
  const [resources, setResources] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [linkResource, setLinkResource] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [suggestKey, setSuggestKey] = useState(0)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const [sRes, aRes, rRes] = await Promise.all([
        fetch('/api/discovery/summary'),
        fetch('/api/discovery/accounts'),
        fetch('/api/discovery/resources?limit=500'),
      ])

      if (!sRes.ok) throw new Error('Failed to load discovery summary')
      if (!aRes.ok) throw new Error('Failed to load discovery accounts')
      if (!rRes.ok) throw new Error('Failed to load discovered resources')

      const s = await sRes.json()
      const a = await aRes.json()
      const r = await rRes.json()

      setSummary(s || { total: 0, totalMapped: 0, unmapped: 0, byProvider: {} })
      setAccounts(Array.isArray(a) ? a : [])
      setResources(Array.isArray(r) ? r : [])
    } catch (err) {
      setError(err?.message || 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [refreshKey])

  useEffect(() => { loadData() }, [loadData])

  const refresh = () => setRefreshKey(k => k + 1)
  const onScanComplete = () => { refresh(); setSuggestKey(k => k + 1) }
  const onMappingApplied = () => refresh()
  const onResourcesChanged = () => refresh()

  // Single "Run Discovery" — scans all configured accounts
  const runAllDiscovery = async () => {
    setScanning(true); setScanResult(null)
    try {
      const res = await fetch('/api/discovery/scan/all', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Scan failed')
      setScanResult({ ok:true, ...data })
      onScanComplete()
      setTimeout(() => setScanResult(null), 6000)
    } catch (e) {
      setScanResult({ ok:false, error:e.message })
    } finally {
      setScanning(false)
    }
  }

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`/api/discovery/resources/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.message || 'Delete failed')
      }
      refresh()
    } catch (err) {
      setError(err?.message || 'Unable to delete resource')
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(ellipse at 10% 20%, #0a1628 0%, ${T.bg} 60%)`, padding: '28px 32px' }}>
      {/* Header with Run Discovery button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: '0 0 4px' }}>Discovery</h1>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em', margin:0 }}>Live cloud inventory and mapping suggestions</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {scanResult && (
            <span style={{ ...mono, fontSize:10, color: scanResult.ok ? T.green : T.red }}>
              {scanResult.ok ? `✓ ${scanResult.total || 0} resources` : `✗ ${scanResult.error}`}
            </span>
          )}
          <button onClick={runAllDiscovery} disabled={scanning || !accounts.length}
            style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px', borderRadius:8,
              cursor: accounts.length ? 'pointer' : 'not-allowed',
              background:T.teal+'22', border:`1px solid ${T.teal}66`,
              color:T.teal, opacity:scanning?.6:1,
              display:'flex', alignItems:'center', gap:7 }}>
            {scanning ? <><Spinner color={T.teal} size={13}/> Scanning…</> : '▶ Run Discovery'}
          </button>
          <button onClick={refresh} style={{ ...mono, fontSize: 11, color: T.muted, background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}>
            ↻
          </button>
        </div>
      </div>

      {error && <div style={{ ...mono, marginBottom: 14, color: T.red }}>Error: {error}</div>}
      {loading && <div style={{ ...mono, marginBottom: 14, color: T.dim }}>Loading discovery data…</div>}

      <SummaryCards summary={summary} />

      {/* Compact auto-discovery bar */}
      <AutoDiscoveryBar onScanTriggered={onScanComplete} />

      {/* Cloud account cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginBottom: 18 }}>
        {accounts.length ? accounts.map(ac => (
          <AccountCard key={ac.id} account={ac} />
        )) : <NoAccounts />}
      </div>

      <ResourceTable
        resources={resources}
        onLink={setLinkResource}
        onDelete={handleDelete}
        onBulkDelete={onResourcesChanged}
      />

      <SuggestionsPanel key={suggestKey} onMappingApplied={onMappingApplied} />

      {linkResource && (
        <LinkModal
          resource={linkResource}
          onClose={() => setLinkResource(null)}
          onLinked={() => { setLinkResource(null); onResourcesChanged() }}
        />
      )}
    </div>
  )
}
