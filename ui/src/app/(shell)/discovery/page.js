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


function SchedulerPanel() {
  const { theme } = useTheme()
  const T = getT(theme)
  const mono = { fontFamily:'monospace' }
  const mono9 = { ...mono, fontSize:9 }

  const [schedule,       setSchedule]       = useState(null)
  const [saving,         setSaving]         = useState(false)
  const [running,        setRunning]        = useState(false)
  const [hours,          setHours]          = useState(0)
  const [minutes,        setMinutes]        = useState(15)
  const [enabled,        setEnabled]        = useState(false)
  const [autoCreate,     setAutoCreate]     = useState(false)
  const [autoMinScore,   setAutoMinScore]   = useState(70)
  const [msg,            setMsg]            = useState(null)

  const load = () => {
    fetch('/api/discovery/schedule')
      .then(r => r.ok ? r.json() : null)
      .then(s => {
        if (!s) return
        setSchedule(s)
        setEnabled(s.enabled || false)
        setAutoCreate(s.auto_create || false)
        setAutoMinScore(s.auto_create_min_score ?? 70)
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
        body: JSON.stringify({
          enabled, hours, minutes,
          auto_create: autoCreate,
          auto_create_min_score: autoMinScore,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Save failed')
      setSchedule(data)
      const parts = []
      if (enabled) parts.push(`scan every ${totalMins}m`)
      if (autoCreate) parts.push(`auto-create at ${autoMinScore}% confidence`)
      setMsg({ ok:true, text: parts.length ? parts.join(' + ') + ' enabled' : 'Settings saved (disabled)' })
      setTimeout(() => setMsg(null), 4000)
    } catch (e) {
      setMsg({ ok:false, text: e.message })
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    setRunning(true); setMsg(null)
    try {
      await fetch('/api/discovery/schedule/run-now', { method:'POST' })
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

  const Toggle = ({ value, onChange, color }) => (
    <button onClick={() => onChange(!value)}
      style={{ position:'relative', width:40, height:22, borderRadius:11, border:'none',
        cursor:'pointer', transition:'background .2s', flexShrink:0,
        background: value ? (color || T.teal) : T.border2 }}>
      <div style={{ position:'absolute', top:3, left: value ? 21 : 3,
        width:16, height:16, borderRadius:'50%', background:'white',
        transition:'left .2s', boxShadow:'0 1px 3px #0004' }} />
    </button>
  )

  return (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:14,
      padding:'18px 20px', marginBottom:24 }}>

      {/* ── Section: Auto Scan ─────────────────────────────────────────── */}
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
        <Toggle value={enabled} onChange={setEnabled} color={T.teal}/>
      </div>

      {/* Interval picker */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20,
        padding:'12px 14px', borderRadius:10, background:T.surface2,
        border:`1px solid ${enabled ? T.teal+'33' : T.border}`,
        opacity: enabled ? 1 : 0.5 }}>
        <span style={{ ...mono9, color:T.muted, letterSpacing:'0.1em' }}>SCAN EVERY</span>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={() => setHours(h => Math.max(0, h - 1))} disabled={!enabled}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>−</button>
          <div style={{ ...mono, fontSize:20, fontWeight:700, color:T.text, minWidth:28, textAlign:'center' }}>
            {hours}
          </div>
          <button onClick={() => setHours(h => Math.min(23, h + 1))} disabled={!enabled}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>+</button>
          <span style={{ ...mono9, color:T.muted }}>hr</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={() => setMinutes(m => { const n = m-5; return n<0?(hours>0?55:5):n })} disabled={!enabled}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>−</button>
          <div style={{ ...mono, fontSize:20, fontWeight:700, color:T.text, minWidth:28, textAlign:'center' }}>
            {String(minutes).padStart(2,'0')}
          </div>
          <button onClick={() => setMinutes(m => (m+5)%60)} disabled={!enabled}
            style={{ ...mono, width:24, height:24, borderRadius:6, border:`1px solid ${T.border2}`,
              background:T.surface, color:T.text, cursor:'pointer', fontSize:14, lineHeight:1 }}>+</button>
          <span style={{ ...mono9, color:T.muted }}>min</span>
        </div>
        <div style={{ display:'flex', gap:5, marginLeft:4 }}>
          {[[0,15,'15m'],[0,30,'30m'],[1,0,'1h'],[4,0,'4h'],[12,0,'12h']].map(([h,m,label]) => {
            const active = hours===h && minutes===m
            return (
              <button key={label} onClick={() => { setHours(h); setMinutes(m) }} disabled={!enabled}
                style={{ ...mono9, padding:'4px 10px', borderRadius:6, cursor:'pointer',
                  border:`1px solid ${active?T.teal+'66':T.border}`,
                  background:active?T.teal+'18':T.surface,
                  color:active?T.teal:T.muted, fontWeight:active?700:400 }}>
                {label}
              </button>
            )
          })}
        </div>
        <div style={{ ...mono9, color: totalMins<5?T.red:T.muted, marginLeft:'auto' }}>
          {totalMins<5 ? 'Min 5 minutes' : `Every ${totalMins} min`}
        </div>
      </div>

      {/* ── Section: Auto Create ───────────────────────────────────────── */}
      <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:16, marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:32, height:32, borderRadius:8,
              background: autoCreate ? T.purple+'18' : T.surface2,
              border:`1.5px solid ${autoCreate ? T.purple+'44' : T.border}`,
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:16,
              transition:'all .2s' }}>✦</div>
            <div>
              <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>
                Auto Create & Map
                <span style={{ ...mono9, marginLeft:8, padding:'2px 8px', borderRadius:4,
                  background: autoCreate ? T.purple+'18' : T.surface2,
                  border:`1px solid ${autoCreate ? T.purple+'44' : T.border}`,
                  color: autoCreate ? T.purple : T.muted, fontWeight:700 }}>
                  {autoCreate ? 'ON' : 'OFF'}
                </span>
              </div>
              <div style={{ ...mono9, color:T.dim, marginTop:1 }}>
                After each scan, automatically create applications, components and link resources using tag suggestions
              </div>
            </div>
          </div>
          <Toggle value={autoCreate} onChange={setAutoCreate} color={T.purple}/>
        </div>

        {/* Auto-create settings — shown when enabled */}
        <div style={{ padding:'12px 14px', borderRadius:10,
          background: autoCreate ? T.purple+'08' : T.surface2,
          border:`1px solid ${autoCreate ? T.purple+'33' : T.border}`,
          opacity: autoCreate ? 1 : 0.5, transition:'all .2s' }}>

          {/* Min score selector */}
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
            <span style={{ ...mono9, color:T.muted, letterSpacing:'0.1em', minWidth:120 }}>
              MIN CONFIDENCE
            </span>
            <div style={{ display:'flex', gap:6 }}>
              {[
                [50, 'Medium (50%)', T.amber],
                [70, 'High (70%)',   T.green],
                [85, 'Very High (85%)', '#22c55e'],
              ].map(([score, label, color]) => {
                const active = autoMinScore === score
                return (
                  <button key={score}
                    onClick={() => autoCreate && setAutoMinScore(score)}
                    disabled={!autoCreate}
                    style={{ ...mono9, padding:'5px 12px', borderRadius:6, cursor: autoCreate ? 'pointer' : 'default',
                      border:`1px solid ${active ? color+'66' : T.border}`,
                      background: active ? color+'18' : T.surface,
                      color: active ? color : T.muted, fontWeight: active ? 700 : 400 }}>
                    {label}
                  </button>
                )
              })}
            </div>
            <input
              type="range" min="50" max="95" step="5"
              value={autoMinScore}
              onChange={e => autoCreate && setAutoMinScore(parseInt(e.target.value))}
              disabled={!autoCreate}
              style={{ flex:1, accentColor:T.purple }}
            />
            <span style={{ ...mono, fontSize:14, fontWeight:700, color:T.purple, minWidth:40, textAlign:'right' }}>
              {autoMinScore}%
            </span>
          </div>

          {/* Warning about auto-create */}
          <div style={{ display:'flex', gap:8, padding:'8px 10px', borderRadius:7,
            background: T.amber+'0a', border:`1px solid ${T.amber}33` }}>
            <span style={{ color:T.amber, flexShrink:0 }}>⚠</span>
            <span style={{ ...mono9, color:T.amber, lineHeight:1.6 }}>
              Auto Create will automatically create Applications and Components in AppCloud
              based on resource tags. Only suggestions at or above {autoMinScore}% confidence
              will be applied. Review the Analyse panel to preview what will be created before enabling.
            </span>
          </div>

          {/* Last auto-create result */}
          {schedule?.last_auto_create_total > 0 && (
            <div style={{ marginTop:8, ...mono9, color:T.green }}>
              ✓ Last run created/linked {schedule.last_auto_create_total} item(s)
            </div>
          )}
        </div>
      </div>

      {/* ── Status row ────────────────────────────────────────────────── */}
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
            Last: {new Date(schedule.last_run_at).toLocaleString()} · {schedule.last_run_total||0} resources
          </span>
        )}
        {schedule?.last_auto_create_total > 0 && (
          <span style={{ ...mono9, color:T.purple }}>✦ {schedule.last_auto_create_total} auto-created</span>
        )}
        {nextRun && (
          <span style={{ ...mono9, color:T.teal, marginLeft:'auto' }}>⏰ Next at {nextRun}</span>
        )}
      </div>

      {/* Message */}
      {msg && (
        <div style={{ padding:'8px 12px', borderRadius:7, marginBottom:12,
          background: msg.ok?T.green+'0a':T.red+'0a',
          border:`1px solid ${msg.ok?T.green+'44':T.red+'44'}` }}>
          <span style={{ ...mono9, color: msg.ok?T.green:T.red }}>{msg.ok?'✓':'✗'} {msg.text}</span>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display:'flex', gap:8 }}>
        <button onClick={save} disabled={saving}
          style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px', borderRadius:8,
            cursor:'pointer', border:'none', transition:'all .2s',
            background: enabled || autoCreate ? T.teal : T.surface2,
            color: enabled || autoCreate ? 'white' : T.muted,
            opacity: saving ? .6 : 1 }}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        <button onClick={runNow} disabled={running}
          style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px', borderRadius:8,
            cursor:'pointer', background:T.surface2, border:`1px solid ${T.border2}`,
            color:T.text, opacity:running?.6:1,
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

  const [summary, setSummary] = useState({ total: 0, totalMapped: 0, unmapped: 0, byProvider: {} })
  const [accounts, setAccounts] = useState([])
  const [resources, setResources] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [linkResource, setLinkResource] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

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
  const onScanComplete = () => refresh()
  const onMappingApplied = () => refresh()
  const onResourcesChanged = () => refresh()

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <h1 style={{ ...mono, fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: '-0.02em', margin: '0 0 6px' }}>Discovery</h1>
          <p style={{ ...mono, fontSize: 11, color: T.muted, letterSpacing: '0.05em' }}>Live cloud inventory, mapping suggestions and auto-scan scheduling</p>
        </div>
        <button onClick={refresh} style={{ ...mono, fontSize: 11, color: T.text, background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}>
          Refresh
        </button>
      </div>

      {error && <div style={{ ...mono, marginBottom: 14, color: T.red }}>Error: {error}</div>}
      {loading && <div style={{ ...mono, marginBottom: 14, color: T.dim }}>Loading discovery data…</div>}

      <SummaryCards summary={summary} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginBottom: 18 }}>
        {accounts.length ? accounts.map(ac => (
          <AccountCard key={ac.id} account={ac} onScanComplete={onScanComplete} />
        )) : <NoAccounts />}
      </div>

      <ResourceTable
        resources={resources}
        onLink={setLinkResource}
        onDelete={handleDelete}
        onBulkDelete={onResourcesChanged}
      />

      <SuggestionsPanel onMappingApplied={onMappingApplied} />

      <SchedulerPanel />

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
