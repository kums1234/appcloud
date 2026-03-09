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
  ec2_instance:'⬡', rds_instance:'◎', function:'λ', eks_cluster:'⎔',
  ecs_cluster:'⬡', load_balancer:'⇌', elasticache:'⚡', s3_bucket:'◫',
  vm:'⬡', aks_cluster:'⎔', sql_server:'◎', app_service:'◈', redis:'⚡', vnet:'⊕',
  compute_instance:'⬡', gke_cluster:'⎔', cloud_sql:'◎', cloud_run:'◈',
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
        if (cfg.accessKeyId && cfg.secretKey)
          body.credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretKey }
      }
      if (account.provider === 'azure') {
        body.subscriptionId = cfg.subscriptionId
        if (cfg.tenantId && cfg.clientId && cfg.clientSecret)
          body.credentials = { tenantId:cfg.tenantId, clientId:cfg.clientId, clientSecret:cfg.clientSecret }
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
      {selected && (
        <div style={{ marginTop:10, background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
          <div style={{ padding:'10px 16px', borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>{selected.name}</div>
            <button onClick={()=>setSelected(null)} style={{ ...mono, fontSize:16, color:T.muted, background:'transparent', border:'none', cursor:'pointer' }}>×</button>
          </div>
          <div style={{ padding:'12px 16px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            {Object.entries(JSON.parse(selected.raw||'{}')).map(([k,v])=>(
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
