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
  redis:'⚡',           vnet:'⊕',              compute_instance:'⬡', gke_cluster:'⎔',
  cloud_sql:'◎',       cloud_run:'◈',         app_insights:'◉',     storage_account:'◫',
  service_bus:'⇌',     key_vault:'🔐',        dynamodb:'◎',         cloud_function:'λ',
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

function AccountCard({ account, onScanComplete }) {
  const pm = PROVIDER_META[account.provider] || { color:T.muted, label:account.provider, capabilities:'' }
  const [scanning,    setScanning]    = useState(false)
  const [result,      setResult]      = useState(null)
  const [regions,     setRegions]     = useState(['us-east-1'])
  const [showRegions, setShowRegions] = useState(false)

  const runScan = async () => {
    setScanning(true); setResult(null)
    try {
      const body = {}, cfg = account.config || {}
      if (account.provider === 'aws') {
        body.regions = regions
        // Support both secretKey (stored name) and secretAccessKey (AWS SDK name)
        const secret = cfg.secretAccessKey || cfg.secretKey
        if (cfg.accessKeyId && secret)
          body.credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: secret }
      }
      if (account.provider === 'azure') {
        body.subscriptionId = cfg.subscriptionId
        // clientSecret is stored in config — if missing, prompt the user
        let secret = cfg.clientSecret
        if (cfg.tenantId && cfg.clientId && !secret) {
          secret = window.prompt(
            `Enter Client Secret for ${account.name}\n(It was not saved — paste it here to scan):`
          )
        }
        if (cfg.tenantId && cfg.clientId && secret)
          body.credentials = { tenantId:cfg.tenantId, clientId:cfg.clientId, clientSecret:secret }
      }
      if (account.provider === 'gcp') {
        body.projectId = cfg.projectId
        if (cfg.serviceAccount) { try { body.credentials = JSON.parse(cfg.serviceAccount) } catch {} }
      }
      const res  = await fetch(`/api/discovery/scan/${account.provider}`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Scan failed')
      setResult({ ok:true, ...data }); onScanComplete?.()
    } catch (e) { setResult({ ok:false, error:e.message }) }
    finally { setScanning(false) }
  }

  return (
    <div style={{ background:T.surface, border:`1px solid ${pm.color}44`, borderRadius:12, overflow:'hidden' }}>
      <div style={{ height:1, background:`linear-gradient(90deg,transparent,${pm.color}66,transparent)` }}/>
      <div style={{ padding:'14px 16px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
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
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:12 }}>
            {account.provider==='aws' && account.config.accountId &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Account: {account.config.accountId}</span>}
            {account.provider==='azure' && account.config.subscriptionId &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Sub: {account.config.subscriptionId?.slice(0,8)}…</span>}
            {account.provider==='gcp' && account.config.projectId &&
              <span style={{ ...mono9, color:T.dim, background:T.surface2, border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 7px' }}>Project: {account.config.projectId}</span>}
          </div>
        )}
        {account.provider === 'aws' && (
          <div style={{ marginBottom:12 }}>
            <button onClick={() => setShowRegions(s => !s)} style={{ ...mono9, color:T.dim, background:'transparent',
              border:`1px solid ${T.border}`, borderRadius:5, padding:'3px 8px', cursor:'pointer', marginBottom: showRegions ? 8 : 0 }}>
              {showRegions ? '▲' : '▼'} Regions ({regions.length} selected)
            </button>
            {showRegions && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                {AWS_REGIONS.map(r => {
                  const active = regions.includes(r)
                  return (
                    <button key={r} onClick={() => setRegions(rs => rs.includes(r) ? rs.filter(x=>x!==r) : [...rs,r])}
                      style={{ ...mono9, padding:'3px 7px', borderRadius:3, cursor:'pointer', border:'1px solid',
                        background: active ? pm.color+'22' : 'transparent',
                        color: active ? pm.color : T.muted,
                        borderColor: active ? pm.color+'55' : T.border }}>{r}</button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <button onClick={runScan} disabled={scanning}
          style={{ ...mono, fontSize:12, fontWeight:700, width:'100%', padding:'9px 0', borderRadius:8,
            cursor:'pointer', background:pm.color+'22', border:`1px solid ${pm.color}66`,
            color:pm.color, opacity:scanning?.6:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          {scanning ? <><Spinner color={pm.color} size={14}/> Scanning…</> : `▶ Run ${pm.label} Discovery`}
        </button>
        {result && (
          <div style={{ marginTop:10, padding:'9px 12px', borderRadius:7,
            background: result.ok ? T.green+'0a' : T.red+'0a',
            border:`1px solid ${result.ok ? T.green+'44' : T.red+'44'}` }}>
            {result.ok ? (
              <>
                <div style={{ ...mono, fontSize:10, fontWeight:700, color:T.green, marginBottom:5 }}>
                  ✓ {result.total} resources in {(result.duration/1000).toFixed(1)}s
                </div>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                  {Object.entries(result.breakdown||{}).filter(([k])=>k!=='errors').map(([k,v]) => v > 0 && (
                    <span key={k} style={{ ...mono9, color:T.dim, background:T.surface2,
                      border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 5px' }}>{k}: {v}</span>
                  ))}
                </div>
                {result.breakdown?.errors?.length > 0 && (
                  <div style={{ marginTop:5 }}>
                    {result.breakdown.errors.map((e,i) => <div key={i} style={{ ...mono9, color:T.amber }}>⚠ {e}</div>)}
                  </div>
                )}
              </>
            ) : <div style={{ ...mono9, color:T.red }}>✗ {result.error}</div>}
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

function ResourceTable({ resources, onLink, onDelete }) {
  const [filter,   setFilter]   = useState({ provider:'', mapped:'', search:'' })
  const [selected, setSelected] = useState(null)
  const inputStyle = { background:T.surface2, border:`1px solid ${T.border2}`, borderRadius:6,
    padding:'7px 10px', color:T.text, fontSize:11, fontFamily:'monospace', outline:'none', boxSizing:'border-box' }
  const filtered = (resources||[]).filter(r => {
    if (filter.provider && r.provider !== filter.provider) return false
    if (filter.mapped === 'mapped'   && !r.mapped) return false
    if (filter.mapped === 'unmapped' &&  r.mapped) return false
    if (filter.search && !r.name?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })
  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap' }}>
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
        <span style={{ ...mono9, color:T.dim, alignSelf:'center', marginLeft:'auto' }}>{filtered.length} of {resources?.length??0} resources</span>
      </div>
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${T.border}` }}>
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
                  style={{ borderBottom:`1px solid ${T.border}`, cursor:'pointer', background:isSel?T.surface2:'transparent', transition:'background .1s' }}
                  onMouseEnter={e=>!isSel&&(e.currentTarget.style.background=T.surface3)}
                  onMouseLeave={e=>!isSel&&(e.currentTarget.style.background='transparent')}>
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

  const [suggestions,  setSuggestions]  = useState([])
  const [loading,      setLoading]      = useState(false)
  const [applying,     setApplying]     = useState(false)
  const [selected,     setSelected]     = useState({}) // { infraId: { componentId, score } }
  const [result,       setResult]       = useState(null)
  const [expanded,     setExpanded]     = useState({}) // { infraId: bool }
  const [minScore,     setMinScore]     = useState(25)

  const [diagnostic, setDiagnostic] = useState(null)

  const load = async () => {
    setLoading(true); setSuggestions([]); setSelected({}); setResult(null); setDiagnostic(null)
    try {
      const res = await fetch(`/api/discovery/suggest?minScore=${minScore}&limit=50`)
      const data = await res.json()
      // Handle both array (old) and {suggestions, diagnostic} (new) response shapes
      const list = Array.isArray(data) ? data : (data.suggestions || [])
      const diag = Array.isArray(data) ? null : data.diagnostic
      setSuggestions(list)
      setDiagnostic(diag)
      // Auto-select highest-confidence suggestions
      const autoSelect = {}
      for (const item of list) {
        const top = item.suggestions?.[0]
        if (top && top.confidence === 'high' && top.componentId) {
          autoSelect[item.infra.id] = { componentId: top.componentId, score: top.score }
        }
      }
      setSelected(autoSelect)
    } catch (e) {
      setDiagnostic({ message: `Failed to load: ${e.message}`, error: true })
    } finally {
      setLoading(false)
    }
  }

  const applySelected = async () => {
    const mappings = Object.entries(selected)
      .filter(([, v]) => v?.componentId)
      .map(([infraId, v]) => ({ infraId, componentId: v.componentId }))

    if (!mappings.length) return

    setApplying(true); setResult(null)
    try {
      const res = await fetch('/api/discovery/suggest/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings }),
      })
      const data = await res.json()
      setResult(data)
      if (data.applied > 0) {
        onMappingApplied?.()
        // Remove applied items from suggestions
        setSuggestions(prev => prev.filter(s => !selected[s.infra.id]?.componentId))
        setSelected({})
      }
    } catch (e) {
      setResult({ applied: 0, errors: [e.message] })
    } finally {
      setApplying(false)
    }
  }

  const CONF_COLOR = { high: T.green, medium: T.amber, low: T.muted }
  const selectedCount = Object.values(selected).filter(v => v?.componentId).length

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
              AI-assisted mapping of discovered resources to applications and components
            </div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {/* Min score filter */}
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ ...mono9, color:T.muted }}>MIN SCORE</span>
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
          <button onClick={load} disabled={loading}
            style={{ ...mono, fontSize:11, fontWeight:700, padding:'7px 16px', borderRadius:8,
              cursor:'pointer', background:T.purple+'18', border:`1px solid ${T.purple}44`,
              color:T.purple, opacity:loading?.6:1,
              display:'flex', alignItems:'center', gap:6 }}>
            {loading ? <><Spinner size={12} color={T.purple}/> Analysing…</> : '⟡ Analyse'}
          </button>
        </div>
      </div>

      {/* Results */}
      {suggestions.length === 0 && !loading && (
        <div style={{ padding:'16px', borderRadius:8, textAlign:'center',
          background: diagnostic?.error ? T.red+'0a' : T.surface2,
          border: `1px solid ${diagnostic?.error ? T.red+'33' : T.border}` }}>
          {!diagnostic ? (
            <div style={{ ...mono9, color:T.muted }}>
              Click Analyse to scan unmapped resources for mapping suggestions
            </div>
          ) : (
            <>
              <div style={{ ...mono9, color: diagnostic.error ? T.red : T.muted, marginBottom:6 }}>
                {diagnostic.message}
              </div>
              {diagnostic.hint && (
                <div style={{ ...mono9, color:T.teal }}>{diagnostic.hint}</div>
              )}
              {diagnostic.unmappedInfra > 0 && (
                <div style={{ display:'flex', gap:12, justifyContent:'center', marginTop:8 }}>
                  <span style={{ ...mono9, color:T.dim }}>
                    Unmapped resources: <strong style={{ color:T.text }}>{diagnostic.unmappedInfra}</strong>
                  </span>
                  <span style={{ ...mono9, color:T.dim }}>
                    Applications: <strong style={{ color:T.text }}>{diagnostic.applications}</strong>
                  </span>
                  {diagnostic.belowThreshold > 0 && (
                    <span style={{ ...mono9, color:T.amber }}>
                      Below score threshold: {diagnostic.belowThreshold}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {suggestions.length > 0 && (
        <>
          {/* Bulk action bar */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12,
            padding:'8px 12px', borderRadius:8, background:T.surface2, border:`1px solid ${T.border}` }}>
            <span style={{ ...mono9, color:T.muted, flex:1 }}>
              {suggestions.length} unmapped resource{suggestions.length!==1?'s':''} ·{' '}
              {selectedCount} selected for mapping
            </span>
            <button
              onClick={() => {
                const all = {}
                for (const item of suggestions) {
                  const top = item.suggestions?.find(s => s.componentId)
                  if (top) all[item.infra.id] = { componentId: top.componentId, score: top.score }
                }
                setSelected(all)
              }}
              style={{ ...mono9, padding:'4px 10px', borderRadius:5, cursor:'pointer',
                border:`1px solid ${T.border}`, background:T.surface, color:T.dim }}>
              Select all
            </button>
            <button onClick={() => setSelected({})}
              style={{ ...mono9, padding:'4px 10px', borderRadius:5, cursor:'pointer',
                border:`1px solid ${T.border}`, background:T.surface, color:T.dim }}>
              Clear
            </button>
            <button onClick={applySelected} disabled={applying || selectedCount === 0}
              style={{ ...mono, fontSize:11, fontWeight:700, padding:'7px 16px', borderRadius:8,
                cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
                background: selectedCount > 0 ? T.green : T.surface2,
                border:`1px solid ${selectedCount > 0 ? T.green+'44' : T.border}`,
                color: selectedCount > 0 ? 'white' : T.muted,
                opacity: applying ? .6 : 1 }}>
              {applying ? 'Applying…' : `✓ Apply ${selectedCount} Mapping${selectedCount!==1?'s':''}`}
            </button>
          </div>

          {/* Result banner */}
          {result && (
            <div style={{ padding:'8px 12px', borderRadius:7, marginBottom:10,
              background: result.applied > 0 ? T.green+'0a' : T.red+'0a',
              border:`1px solid ${result.applied > 0 ? T.green+'33' : T.red+'33'}` }}>
              <span style={{ ...mono9, color: result.applied > 0 ? T.green : T.red }}>
                {result.applied > 0
                  ? `✓ ${result.applied} mapping${result.applied!==1?'s':''} applied successfully`
                  : `✗ No mappings applied`}
                {result.errors?.length > 0 && ` · ${result.errors.length} error(s)`}
              </span>
            </div>
          )}

          {/* Suggestion rows */}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {suggestions.map(item => {
              const sel = selected[item.infra.id]
              const isExpanded = expanded[item.infra.id]
              const topConf = item.topConfidence
              const confColor = CONF_COLOR[topConf] || T.muted

              return (
                <div key={item.infra.id} style={{ border:`1px solid ${T.border}`,
                  borderRadius:10, overflow:'hidden',
                  borderLeft:`3px solid ${confColor}` }}>

                  {/* Resource row */}
                  <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
                    background: sel?.componentId ? T.green+'08' : T.surface2 }}>

                    {/* Select checkbox */}
                    <input type="checkbox"
                      checked={!!sel?.componentId}
                      onChange={e => {
                        if (e.target.checked) {
                          const top = item.suggestions?.find(s => s.componentId)
                          if (top) setSelected(prev => ({ ...prev, [item.infra.id]: { componentId: top.componentId, score: top.score } }))
                        } else {
                          setSelected(prev => { const n = {...prev}; delete n[item.infra.id]; return n })
                        }
                      }}
                      style={{ width:14, height:14, cursor:'pointer', flexShrink:0 }}
                    />

                    {/* Infra info */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>
                          {RESOURCE_ICONS[item.infra.resourceType] || '◎'} {item.infra.name}
                        </span>
                        <span style={{ ...mono9, color:T.muted, background:T.surface,
                          border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 6px' }}>
                          {item.infra.resourceType}
                        </span>
                        <span style={{ ...mono9, color:T.muted }}>{item.infra.provider} · {item.infra.region}</span>
                      </div>
                      {/* Tag preview */}
                      {Object.keys(item.infra.tags || {}).length > 0 && (
                        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:4 }}>
                          {Object.entries(item.infra.tags).slice(0,5).map(([k,v]) => (
                            <span key={k} style={{ ...mono9, color:T.dim, background:T.surface,
                              border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 6px' }}>
                              {k}: {v}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Confidence badge */}
                    <div style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
                      <div style={{ width:6, height:6, borderRadius:'50%', background:confColor }} />
                      <span style={{ ...mono9, color:confColor, fontWeight:700, textTransform:'uppercase' }}>
                        {topConf}
                      </span>
                      <span style={{ ...mono9, color:T.muted }}>{item.topScore}%</span>
                    </div>

                    {/* Expand toggle */}
                    <button onClick={() => setExpanded(e => ({ ...e, [item.infra.id]: !e[item.infra.id] }))}
                      style={{ ...mono9, background:'none', border:'none', color:T.muted,
                        cursor:'pointer', padding:'2px 6px' }}>
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  </div>

                  {/* Suggestions list */}
                  <div style={{ padding:'0 14px 10px',
                    display: isExpanded ? 'block' : suggestions.length <= 5 ? 'block' : 'none' }}>
                    {item.suggestions.map((s, si) => {
                      const isSelected = sel?.componentId === s.componentId
                      const sColor = CONF_COLOR[s.confidence] || T.muted
                      return (
                        <div key={si} onClick={() => {
                            if (s.componentId)
                              setSelected(prev => ({ ...prev, [item.infra.id]: { componentId: s.componentId, score: s.score } }))
                          }}
                          style={{ display:'flex', alignItems:'flex-start', gap:10,
                            padding:'8px 10px', borderRadius:7, marginTop:6, cursor: s.componentId ? 'pointer' : 'default',
                            border:`1px solid ${isSelected ? sColor+'44' : T.border}`,
                            background: isSelected ? sColor+'0a' : T.surface }}>

                          <input type="radio" readOnly
                            checked={isSelected}
                            disabled={!s.componentId}
                            style={{ marginTop:2, flexShrink:0 }}
                          />
                          <div style={{ flex:1 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                              <span style={{ ...mono, fontSize:11, fontWeight:700, color:T.text }}>
                                {s.applicationName}
                                {s.componentName && <span style={{ color:T.muted }}> / {s.componentName}</span>}
                              </span>
                              {s.noComponent && (
                                <span style={{ ...mono9, color:T.amber, background:T.amber+'12',
                                  border:`1px solid ${T.amber}33`, borderRadius:3, padding:'1px 6px' }}>
                                  no component — create one first
                                </span>
                              )}
                            </div>
                            <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                              {s.reasons.map((r, ri) => (
                                <span key={ri} style={{ ...mono9, color:T.dim, background:T.surface2,
                                  border:`1px solid ${T.border}`, borderRadius:3, padding:'1px 6px' }}>
                                  {r}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:4, flexShrink:0 }}>
                            <span style={{ ...mono9, color:sColor, fontWeight:700 }}>{s.score}%</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function SchedulerPanel() {
  const { theme } = useTheme()
  const T = getT(theme)
  const mono = { fontFamily:'monospace' }
  const mono9 = { ...mono, fontSize:9 }

  const [schedule,  setSchedule]  = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [running,   setRunning]   = useState(false)
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

  // Refresh status every 30s when enabled
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
      setMsg({ ok:true, text: enabled ? `Auto-scan enabled — every ${totalMins} minutes` : 'Auto-scan disabled' })
      setTimeout(() => setMsg(null), 3000)
    } catch (e) {
      setMsg({ ok:false, text: e.message })
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    setRunning(true); setMsg(null)
    try {
      const res = await fetch('/api/discovery/schedule/run-now', { method:'POST' })
      const data = await res.json()
      setMsg({ ok:true, text:'Scan triggered — running in background' })
      setTimeout(() => { setMsg(null); load() }, 4000)
    } catch (e) {
      setMsg({ ok:false, text: e.message })
    } finally {
      setRunning(false)
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
    <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:14,
      padding:'18px 20px', marginBottom:24 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:T.teal+'18',
            border:`1.5px solid ${T.teal}44`, display:'flex', alignItems:'center',
            justifyContent:'center', fontSize:16 }}>⏱</div>
          <div>
            <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>Auto Discovery</div>
            <div style={{ ...mono9, color:T.dim, marginTop:1 }}>
              Automatically scan all configured cloud accounts on a schedule
            </div>
          </div>
        </div>
        {/* Enable toggle */}
        <button
          onClick={() => setEnabled(e => !e)}
          style={{ position:'relative', width:44, height:24, borderRadius:12, border:'none',
            cursor:'pointer', transition:'background .2s',
            background: enabled ? T.teal : T.border2, flexShrink:0 }}>
          <div style={{ position:'absolute', top:3, left: enabled ? 23 : 3,
            width:18, height:18, borderRadius:'50%', background:'white',
            transition:'left .2s', boxShadow:'0 1px 3px #0004' }} />
        </button>
      </div>

      {/* Interval picker */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
        <span style={{ ...mono9, color:T.muted, letterSpacing:'0.1em' }}>SCAN EVERY</span>

        {/* Hours */}
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={() => setHours(h => Math.max(0, h - 1))}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface2, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>−</button>
          <div style={{ ...mono, fontSize:20, fontWeight:700, color:T.text, minWidth:28, textAlign:'center' }}>
            {hours}
          </div>
          <button onClick={() => setHours(h => Math.min(23, h + 1))}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface2, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>+</button>
          <span style={{ ...mono9, color:T.muted }}>hr</span>
        </div>

        {/* Minutes */}
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={() => setMinutes(m => {
              const next = m - 5; return next < 0 ? (hours > 0 ? 55 : 5) : next
            })}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface2, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>−</button>
          <div style={{ ...mono, fontSize:20, fontWeight:700, color:T.text, minWidth:28, textAlign:'center' }}>
            {String(minutes).padStart(2,'0')}
          </div>
          <button onClick={() => setMinutes(m => (m + 5) % 60)}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface2, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>+</button>
          <span style={{ ...mono9, color:T.muted }}>min</span>
        </div>

        {/* Quick presets */}
        <div style={{ display:'flex', gap:5, marginLeft:8 }}>
          {[[0,15,'15m'],[0,30,'30m'],[1,0,'1h'],[4,0,'4h'],[12,0,'12h']].map(([h,m,label]) => {
            const active = hours === h && minutes === m
            return (
              <button key={label} onClick={() => { setHours(h); setMinutes(m) }}
                style={{ ...mono9, padding:'4px 10px', borderRadius:6, cursor:'pointer',
                  border:`1px solid ${active ? T.teal+'66' : T.border}`,
                  background: active ? T.teal+'18' : T.surface2,
                  color: active ? T.teal : T.muted, fontWeight: active ? 700 : 400 }}>
                {label}
              </button>
            )
          })}
        </div>

        <div style={{ ...mono9, color: totalMins < 5 ? T.red : T.muted, marginLeft:'auto' }}>
          {totalMins < 5 ? 'Minimum 5 minutes' : `Every ${totalMins} min total`}
        </div>
      </div>

      {/* Status row */}
      <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:14,
        padding:'10px 14px', borderRadius:8, background:T.surface2, border:`1px solid ${T.border}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ width:7, height:7, borderRadius:'50%', background:statusColor,
            boxShadow:`0 0 6px ${statusColor}` }} />
          <span style={{ ...mono9, color:statusColor, fontWeight:700 }}>
            {schedule?.last_run_status?.toUpperCase() || 'NEVER RUN'}
          </span>
        </div>
        {schedule?.last_run_at && (
          <span style={{ ...mono9, color:T.muted }}>
            Last: {new Date(schedule.last_run_at).toLocaleString()} · {schedule.last_run_total || 0} resources
          </span>
        )}
        {nextRun && (
          <span style={{ ...mono9, color:T.teal, marginLeft:'auto' }}>
            ⏰ Next at {nextRun}
          </span>
        )}
      </div>

      {/* Message */}
      {msg && (
        <div style={{ padding:'8px 12px', borderRadius:7, marginBottom:12,
          background: msg.ok ? T.green+'0a' : T.red+'0a',
          border:`1px solid ${msg.ok ? T.green+'44' : T.red+'44'}` }}>
          <span style={{ ...mono9, color: msg.ok ? T.green : T.red }}>{msg.ok ? '✓' : '✗'} {msg.text}</span>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display:'flex', gap:8 }}>
        <button onClick={save} disabled={saving}
          style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px', borderRadius:8,
            cursor:'pointer', border:'none', transition:'all .2s',
            background: enabled ? T.teal : T.surface2,
            color: enabled ? 'white' : T.muted,
            opacity: saving ? .6 : 1 }}>
          {saving ? 'Saving…' : enabled ? '✓ Save Schedule' : 'Save (Disabled)'}
        </button>
        <button onClick={runNow} disabled={running}
          style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px', borderRadius:8,
            cursor:'pointer', background:T.surface2, border:`1px solid ${T.border2}`,
            color:T.text, opacity: running ? .6 : 1,
            display:'flex', alignItems:'center', gap:7 }}>
          {running ? <><Spinner size={12} color={T.teal}/> Running…</> : '▶ Run Now'}
        </button>
      </div>
    </div>
  )
}

export default function DiscoveryPage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const [accounts,   setAccounts]   = useState([])
  const [summary,    setSummary]    = useState(null)
  const [resources,  setResources]  = useState([])
  const [loadingRes, setLoadingRes] = useState(false)
  const [linkTarget, setLinkTarget] = useState(null)

  const loadAccounts = useCallback(() => {
    fetch('/api/discovery/accounts').then(r=>r.ok?r.json():[])
      .then(rows => setAccounts(rows.map(a => ({
        ...a, config: (() => { try { return JSON.parse(a.config||'{}') } catch { return {} } })()
      })))).catch(()=>setAccounts([]))
  }, [])

  const loadSummary = useCallback(() => {
    fetch('/api/discovery/summary').then(r=>r.json()).then(setSummary).catch(()=>{})
  }, [])

  const loadResources = useCallback(() => {
    setLoadingRes(true)
    fetch('/api/discovery/resources?limit=500').then(r=>r.json()).then(setResources)
      .catch(()=>setResources([])).finally(()=>setLoadingRes(false))
  }, [])

  useEffect(() => { loadAccounts(); loadSummary(); loadResources() }, [loadAccounts, loadSummary, loadResources])

  const onScanComplete = () => { loadSummary(); loadResources() }

  const deleteResource = async (id) => {
    if (!confirm('Remove this discovered resource from the graph?')) return
    await fetch(`/api/discovery/resources/${id}`, { method:'DELETE' })
    loadResources(); loadSummary()
  }

  return (
    <div style={{ minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'monospace', padding:'28px 32px' }}>
      <div style={{ marginBottom:22 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <div style={{ width:28, height:28, borderRadius:7, background:T.purple+'22',
            border:`1.5px solid ${T.purple}55`, display:'flex', alignItems:'center',
            justifyContent:'center', fontSize:14, color:T.purple }}>◎</div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:800, letterSpacing:'-0.02em' }}>Cloud Discovery</h1>
        </div>
        <p style={{ margin:0, fontSize:11, color:T.dim, lineHeight:1.7 }}>
          Scan connected cloud accounts to discover infrastructure and populate the graph.
          Configure credentials in{' '}
          <a href="/integrations" style={{ color:T.teal, textDecoration:'none' }}>Integrations</a>.
        </p>
      </div>

      <SummaryCards summary={summary}/>

      <SchedulerPanel />

      <SuggestionsPanel onMappingApplied={onScanComplete}/>

      {accounts.length > 0 ? (
        <>
          <div style={{ ...mono, fontSize:11, fontWeight:700, color:T.text, marginBottom:10 }}>Connected Accounts</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px,1fr))', gap:14, marginBottom:24 }}>
            {accounts.map(acc => <AccountCard key={acc.id} account={acc} onScanComplete={onScanComplete}/>)}
          </div>
        </>
      ) : <div style={{ marginBottom:24 }}><NoAccounts/></div>}

      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'12px 16px', borderBottom:`1px solid ${T.border}`,
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>
            Discovered Resources{resources.length ? ` (${resources.length})` : ''}
          </div>
          <button onClick={loadResources} style={{ ...mono9, color:T.dim, background:'transparent',
            border:`1px solid ${T.border}`, borderRadius:5, padding:'3px 9px', cursor:'pointer' }}>↻ Refresh</button>
        </div>
        <div style={{ padding:'14px 16px' }}>
          {loadingRes
            ? <div style={{ textAlign:'center', padding:'24px 0' }}><Spinner/></div>
            : <ResourceTable resources={resources} onLink={r=>setLinkTarget(r)} onDelete={deleteResource}/>}
        </div>
      </div>

      {linkTarget && (
        <LinkModal resource={linkTarget} onClose={()=>setLinkTarget(null)}
          onLinked={()=>{ loadResources(); loadSummary() }}/>
      )}
    </div>
  )
}