'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

const T = {
  bg:'#04080f', surface:'#080f1a', surface2:'#0d1626', surface3:'#111d2e',
  border:'#0f1f35', border2:'#1e293b', text:'#f1f5f9', muted:'#334155', dim:'#64748b',
  green:'#22c55e', blue:'#38bdf8', amber:'#f59e0b', red:'#f43f5e',
  purple:'#a78bfa', teal:'#2dd4bf', orange:'#fb923c',
}
const mono = { fontFamily:'monospace' }

const PROVIDER_META = {
  aws:   { label:'AWS',         color:'#f59e0b', icon:'☁',  bgIcon:'⬡' },
  azure: { label:'Azure',       color:'#38bdf8', icon:'◈',  bgIcon:'◈' },
  gcp:   { label:'GCP',         color:'#22c55e', icon:'◎',  bgIcon:'◎' },
}

const RESOURCE_ICONS = {
  ec2_instance:'⬡', rds_instance:'◎', function:'λ', eks_cluster:'⎔',
  ecs_cluster:'⬡', load_balancer:'⇌', elasticache:'⚡', s3_bucket:'◫',
  vm:'⬡', aks_cluster:'⎔', sql_server:'◎', app_service:'◈',
  redis:'⚡', vnet:'⊕',
  compute_instance:'⬡', gke_cluster:'⎔', cloud_sql:'◎', cloud_run:'◈',
}

const AWS_REGIONS = [
  'us-east-1','us-east-2','us-west-1','us-west-2',
  'eu-west-1','eu-west-2','eu-west-3','eu-central-1','eu-north-1',
  'ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-northeast-2',
  'ap-south-1','sa-east-1','ca-central-1',
]

const mono9 = { ...mono, fontSize:9 }

// ── Utilities ─────────────────────────────────────────────────────────────────
function Spinner({ color = T.teal, size = 18 }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <span style={{ width:size, height:size, borderRadius:'50%',
        border:`2px solid ${T.border2}`, borderTopColor:color,
        animation:'spin .7s linear infinite', display:'inline-block' }}/>
    </span>
  )
}

function Badge({ label, color }) {
  return (
    <span style={{ ...mono, fontSize:9, fontWeight:700, color,
      background:color+'18', border:`1px solid ${color}33`,
      borderRadius:3, padding:'1px 7px', letterSpacing:'0.05em',
      whiteSpace:'nowrap' }}>{label}</span>
  )
}

function Field({ label, required, children, half }) {
  return (
    <div style={{ marginBottom:10, ...(half ? {} : {}) }}>
      <div style={{ ...mono9, color:T.muted, letterSpacing:'0.1em', fontWeight:700, marginBottom:4 }}>
        {label}{required && <span style={{ color:T.red }}> ✱</span>}
      </div>
      {children}
    </div>
  )
}

const inputStyle = {
  width:'100%', background:T.surface2, border:`1px solid ${T.border2}`,
  borderRadius:6, padding:'8px 10px', color:T.text,
  fontSize:11, fontFamily:'monospace', outline:'none', boxSizing:'border-box',
}
const selectStyle = { ...inputStyle, cursor:'pointer', appearance:'none' }

function Section({ title, children }) {
  return (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`,
      borderRadius:12, overflow:'hidden', marginBottom:14 }}>
      <div style={{ padding:'11px 16px', borderBottom:`1px solid ${T.border}`,
        ...mono, fontSize:12, fontWeight:700, color:T.text }}>{title}</div>
      <div style={{ padding:'14px 16px' }}>{children}</div>
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────
function SummaryCards({ summary }) {
  if (!summary) return null
  const { total, totalMapped, unmapped, byProvider } = summary
  const pct = total ? Math.round(totalMapped / total * 100) : 0

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:10, marginBottom:20 }}>
      {/* Total */}
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ ...mono, fontSize:24, fontWeight:800, color:T.text }}>{total ?? '—'}</div>
        <div style={{ ...mono9, color:T.muted, marginTop:3, letterSpacing:'0.1em' }}>DISCOVERED RESOURCES</div>
      </div>
      {/* Mapped */}
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ ...mono, fontSize:24, fontWeight:800, color:T.green }}>{totalMapped ?? '—'}</div>
        <div style={{ ...mono9, color:T.muted, marginTop:3, letterSpacing:'0.1em' }}>MAPPED TO APPS</div>
        <div style={{ height:2, background:T.border2, borderRadius:1, marginTop:8 }}>
          <div style={{ height:'100%', width:`${pct}%`, background:T.green, borderRadius:1, transition:'width .4s' }}/>
        </div>
      </div>
      {/* Unmapped */}
      <div style={{ background:T.surface, border:`1px solid ${unmapped > 0 ? T.amber+'44' : T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ ...mono, fontSize:24, fontWeight:800, color: unmapped > 0 ? T.amber : T.muted }}>{unmapped ?? '—'}</div>
        <div style={{ ...mono9, color:T.muted, marginTop:3, letterSpacing:'0.1em' }}>UNMAPPED</div>
      </div>
      {/* Provider breakdown */}
      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
          {Object.entries(byProvider || {}).map(([p, d]) => {
            const pm = PROVIDER_META[p] || { color:T.muted, label:p }
            return (
              <div key={p} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ ...mono, fontSize:11, fontWeight:700, color:pm.color, minWidth:40 }}>{pm.label}</span>
                <div style={{ flex:1, height:4, background:T.border2, borderRadius:2 }}>
                  <div style={{ height:'100%', width:`${total ? d.total/total*100 : 0}%`,
                    background:pm.color, borderRadius:2 }}/>
                </div>
                <span style={{ ...mono, fontSize:11, color:T.dim, minWidth:24, textAlign:'right' }}>{d.total}</span>
              </div>
            )
          })}
          {!Object.keys(byProvider || {}).length &&
            <div style={{ ...mono9, color:T.muted }}>No data yet — run a scan</div>}
        </div>
      </div>
    </div>
  )
}

// ── Resource table ────────────────────────────────────────────────────────────
function ResourceTable({ resources, onLink, onDelete }) {
  const [filter, setFilter] = useState({ provider:'', mapped:'', search:'' })
  const [selected, setSelected] = useState(null)

  const filtered = (resources || []).filter(r => {
    if (filter.provider && r.provider !== filter.provider) return false
    if (filter.mapped === 'mapped'   && !r.mapped)  return false
    if (filter.mapped === 'unmapped' &&  r.mapped)  return false
    if (filter.search && !r.name?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  return (
    <div>
      {/* Filters */}
      <div style={{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap' }}>
        <input style={{ ...inputStyle, width:180 }} placeholder="Search by name…"
          value={filter.search} onChange={e => setFilter(f => ({...f, search:e.target.value}))}/>
        <select style={{ ...selectStyle, width:120 }}
          value={filter.provider} onChange={e => setFilter(f => ({...f, provider:e.target.value}))}>
          <option value="">All providers</option>
          {Object.entries(PROVIDER_META).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select style={{ ...selectStyle, width:120 }}
          value={filter.mapped} onChange={e => setFilter(f => ({...f, mapped:e.target.value}))}>
          <option value="">All resources</option>
          <option value="mapped">Mapped</option>
          <option value="unmapped">Unmapped</option>
        </select>
        <span style={{ ...mono9, color:T.dim, alignSelf:'center', marginLeft:'auto' }}>
          {filtered.length} of {resources?.length ?? 0}
        </span>
      </div>

      <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${T.border}` }}>
              {['Resource', 'Type', 'Provider', 'Region', 'Status', 'Applications', ''].map(h => (
                <th key={h} style={{ ...mono9, color:T.muted, textAlign:'left',
                  padding:'10px 14px', letterSpacing:'0.1em', fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!filtered.length ? (
              <tr><td colSpan={7} style={{ ...mono, fontSize:11, color:T.muted,
                textAlign:'center', padding:'32px 0' }}>No resources found</td></tr>
            ) : filtered.map(r => {
              const pm = PROVIDER_META[r.provider] || { color:T.muted }
              const icon = RESOURCE_ICONS[r.resource_type] || '⬡'
              const isSelected = selected?.id === r.id
              return (
                <tr key={r.id} onClick={() => setSelected(isSelected ? null : r)}
                  style={{ borderBottom:`1px solid ${T.border}`, cursor:'pointer',
                    background: isSelected ? T.surface2 : 'transparent',
                    transition:'background .12s' }}
                  onMouseEnter={e => !isSelected && (e.currentTarget.style.background = T.surface3)}
                  onMouseLeave={e => !isSelected && (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding:'11px 14px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ color:pm.color, fontSize:13 }}>{icon}</span>
                      <div>
                        <div style={{ ...mono, fontSize:12, fontWeight:600, color:T.text }}>{r.name}</div>
                        <div style={{ ...mono9, color:T.dim, marginTop:1 }}>{r.cloud_id?.slice(0,40)}{r.cloud_id?.length > 40 ? '…' : ''}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    <Badge label={r.resource_type?.replace(/_/g,' ')} color={pm.color}/>
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    <Badge label={pm.label || r.provider} color={pm.color}/>
                  </td>
                  <td style={{ padding:'11px 14px', ...mono, fontSize:10, color:T.dim }}>{r.region || '—'}</td>
                  <td style={{ padding:'11px 14px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                      <div style={{ width:6, height:6, borderRadius:'50%', flexShrink:0,
                        background: r.status==='running'||r.status==='active'||r.status==='available' ? T.green
                                  : r.status==='stopped'||r.status==='failed' ? T.red : T.amber }}/>
                      <span style={{ ...mono, fontSize:10, color:T.dim }}>{r.status || '—'}</span>
                    </div>
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    {r.applications?.length ? (
                      <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                        {r.applications.slice(0,2).map(a => (
                          <span key={a} style={{ ...mono9, color:T.teal,
                            background:T.teal+'15', border:`1px solid ${T.teal}33`,
                            borderRadius:3, padding:'1px 5px' }}>{a}</span>
                        ))}
                        {r.applications.length > 2 &&
                          <span style={{ ...mono9, color:T.dim }}>+{r.applications.length-2}</span>}
                      </div>
                    ) : (
                      <span style={{ ...mono9, color:T.muted }}>unmapped</span>
                    )}
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    <div style={{ display:'flex', gap:6 }}>
                      <button onClick={e => { e.stopPropagation(); onLink?.(r) }}
                        style={{ ...mono, fontSize:9, padding:'3px 8px', cursor:'pointer',
                          background:T.teal+'15', border:`1px solid ${T.teal}33`,
                          borderRadius:4, color:T.teal }}>Link</button>
                      <button onClick={e => { e.stopPropagation(); onDelete?.(r.id) }}
                        style={{ ...mono, fontSize:9, padding:'3px 8px', cursor:'pointer',
                          background:T.red+'12', border:`1px solid ${T.red}30`,
                          borderRadius:4, color:T.red }}>Delete</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Detail drawer */}
      {selected && (
        <div style={{ marginTop:10, background:T.surface, border:`1px solid ${T.border}`,
          borderRadius:10, overflow:'hidden' }}>
          <div style={{ padding:'10px 16px', borderBottom:`1px solid ${T.border}`,
            display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>
              {selected.name} — Raw Details
            </div>
            <button onClick={() => setSelected(null)} style={{ ...mono, fontSize:16, color:T.muted,
              background:'transparent', border:'none', cursor:'pointer' }}>×</button>
          </div>
          <div style={{ padding:'12px 16px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {Object.entries(JSON.parse(selected.raw || '{}')).map(([k, v]) => (
              <div key={k} style={{ padding:'6px 10px', background:T.surface2,
                border:`1px solid ${T.border}`, borderRadius:6 }}>
                <div style={{ ...mono9, color:T.muted, letterSpacing:'0.08em', marginBottom:2 }}>
                  {k.replace(/_/g,' ').toUpperCase()}
                </div>
                <div style={{ ...mono, fontSize:10, color:T.text, wordBreak:'break-all' }}>
                  {v === null || v === undefined ? '—'
                    : typeof v === 'boolean' ? (v ? '✓ Yes' : '✗ No')
                    : Array.isArray(v) ? v.join(', ') || '—'
                    : String(v) || '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Scan runner ───────────────────────────────────────────────────────────────
function ScanResult({ result }) {
  if (!result) return null
  const { provider, duration, total, breakdown } = result
  const pm = PROVIDER_META[provider] || { color:T.muted, label:provider }
  const errCount = breakdown?.errors?.length || 0

  return (
    <div style={{ marginTop:12, padding:'12px 14px',
      background: errCount ? T.amber+'0a' : T.green+'0a',
      border:`1px solid ${errCount ? T.amber+'44' : T.green+'44'}`,
      borderRadius:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        <span style={{ ...mono, fontSize:11, fontWeight:700, color: errCount ? T.amber : T.green }}>
          {errCount ? '⚠' : '✓'} {pm.label} scan complete
        </span>
        <span style={{ ...mono9, color:T.dim }}>{total} resources in {(duration/1000).toFixed(1)}s</span>
      </div>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        {Object.entries(breakdown || {})
          .filter(([k]) => k !== 'errors')
          .map(([k, v]) => (
            <span key={k} style={{ ...mono9, color:T.dim,
              background:T.surface2, border:`1px solid ${T.border}`,
              borderRadius:3, padding:'2px 7px' }}>{k}: {v}</span>
          ))}
      </div>
      {errCount > 0 && (
        <div style={{ marginTop:8 }}>
          {breakdown.errors.map((e, i) => (
            <div key={i} style={{ ...mono9, color:T.red }}>✗ {e}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── AWS config panel ──────────────────────────────────────────────────────────
function AWSPanel({ onScanComplete }) {
  const [form, setForm] = useState({
    accessKeyId: '', secretAccessKey: '', sessionToken: '',
    regions: ['us-east-1'],
  })
  const [scanning, setScanning] = useState(false)
  const [result,   setResult]   = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggleRegion = (r) => setForm(f => ({
    ...f,
    regions: f.regions.includes(r) ? f.regions.filter(x => x !== r) : [...f.regions, r],
  }))

  const scan = async () => {
    setScanning(true); setResult(null)
    try {
      const body = { regions: form.regions }
      if (form.accessKeyId && form.secretAccessKey) {
        body.credentials = {
          accessKeyId:     form.accessKeyId,
          secretAccessKey: form.secretAccessKey,
          ...(form.sessionToken ? { sessionToken: form.sessionToken } : {}),
        }
      }
      const res  = await fetch('/api/discovery/scan/aws', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Scan failed')
      setResult(data)
      onScanComplete?.()
    } catch (e) { setResult({ error: e.message }) }
    finally { setScanning(false) }
  }

  const pm = PROVIDER_META.aws

  return (
    <div>
      <div style={{ ...mono9, color:T.dim, marginBottom:14, lineHeight:1.7 }}>
        Leave credentials empty to use environment variables (<code>AWS_ACCESS_KEY_ID</code>,
        <code> AWS_SECRET_ACCESS_KEY</code>) or IAM instance profile / ECS task role.
        Scans: EC2, RDS, Lambda, EKS, ECS, ALB/NLB, ElastiCache.
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <Field label="ACCESS KEY ID (optional)">
          <input style={inputStyle} type="password" value={form.accessKeyId}
            onChange={e => set('accessKeyId', e.target.value)}
            placeholder="AKIA… or leave blank for env vars"/>
        </Field>
        <Field label="SECRET ACCESS KEY (optional)">
          <input style={inputStyle} type="password" value={form.secretAccessKey}
            onChange={e => set('secretAccessKey', e.target.value)}
            placeholder="leave blank for env vars"/>
        </Field>
        <Field label="SESSION TOKEN (optional — for STS assumed roles)">
          <input style={inputStyle} type="password" value={form.sessionToken}
            onChange={e => set('sessionToken', e.target.value)}
            placeholder="leave blank if not using STS"/>
        </Field>
      </div>
      <Field label="REGIONS TO SCAN">
        <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
          {AWS_REGIONS.map(r => {
            const active = form.regions.includes(r)
            return (
              <button key={r} onClick={() => toggleRegion(r)} style={{
                ...mono9, padding:'4px 9px', borderRadius:4, cursor:'pointer', border:'1px solid',
                background: active ? pm.color+'22' : 'transparent',
                color:       active ? pm.color : T.muted,
                borderColor: active ? pm.color+'44' : T.border,
              }}>{r}</button>
            )
          })}
        </div>
      </Field>
      <button onClick={scan} disabled={scanning || !form.regions.length}
        style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px',
          background: pm.color+'22', border:`1px solid ${pm.color}66`,
          borderRadius:8, color:pm.color, cursor:'pointer',
          opacity: scanning ? .6 : 1, display:'flex', alignItems:'center', gap:8 }}>
        {scanning ? <><Spinner color={pm.color}/> Scanning…</> : '▶ Run AWS Scan'}
      </button>
      {result?.error && <div style={{ ...mono9, color:T.red, marginTop:8 }}>✗ {result.error}</div>}
      {result && !result.error && <ScanResult result={result}/>}
    </div>
  )
}

// ── Azure config panel ────────────────────────────────────────────────────────
function AzurePanel({ onScanComplete }) {
  const [form, setForm] = useState({
    tenantId:'', clientId:'', clientSecret:'', subscriptionId:'',
  })
  const [scanning, setScanning] = useState(false)
  const [result,   setResult]   = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const pm = PROVIDER_META.azure

  const scan = async () => {
    setScanning(true); setResult(null)
    try {
      const body = {
        subscriptionId: form.subscriptionId || undefined,
      }
      if (form.tenantId && form.clientId && form.clientSecret) {
        body.credentials = {
          tenantId:     form.tenantId,
          clientId:     form.clientId,
          clientSecret: form.clientSecret,
        }
      }
      const res  = await fetch('/api/discovery/scan/azure', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Scan failed')
      setResult(data); onScanComplete?.()
    } catch (e) { setResult({ error: e.message }) }
    finally { setScanning(false) }
  }

  return (
    <div>
      <div style={{ ...mono9, color:T.dim, marginBottom:14, lineHeight:1.7 }}>
        Leave credentials empty to use <code>DefaultAzureCredential</code> (environment
        variables <code>AZURE_TENANT_ID</code>, <code>AZURE_CLIENT_ID</code>,
        <code> AZURE_CLIENT_SECRET</code>) or managed identity.
        Scans: VMs, AKS, SQL Servers, App Services, Redis, VNets.
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <Field label="SUBSCRIPTION ID">
          <input style={inputStyle} value={form.subscriptionId}
            onChange={e => set('subscriptionId', e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
        </Field>
        <Field label="TENANT ID (optional)">
          <input style={inputStyle} value={form.tenantId}
            onChange={e => set('tenantId', e.target.value)}
            placeholder="leave blank for DefaultAzureCredential"/>
        </Field>
        <Field label="CLIENT ID (optional)">
          <input style={inputStyle} value={form.clientId}
            onChange={e => set('clientId', e.target.value)}
            placeholder="Service principal app ID"/>
        </Field>
        <Field label="CLIENT SECRET (optional)">
          <input style={inputStyle} type="password" value={form.clientSecret}
            onChange={e => set('clientSecret', e.target.value)}
            placeholder="Service principal secret"/>
        </Field>
      </div>
      <button onClick={scan} disabled={scanning}
        style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px',
          background:pm.color+'22', border:`1px solid ${pm.color}66`,
          borderRadius:8, color:pm.color, cursor:'pointer',
          opacity: scanning ? .6 : 1, display:'flex', alignItems:'center', gap:8 }}>
        {scanning ? <><Spinner color={pm.color}/> Scanning…</> : '▶ Run Azure Scan'}
      </button>
      {result?.error && <div style={{ ...mono9, color:T.red, marginTop:8 }}>✗ {result.error}</div>}
      {result && !result.error && <ScanResult result={result}/>}
    </div>
  )
}

// ── GCP config panel ──────────────────────────────────────────────────────────
function GCPPanel({ onScanComplete }) {
  const [form, setForm]   = useState({ projectId:'', serviceAccountJson:'' })
  const [scanning, setScanning] = useState(false)
  const [result,   setResult]   = useState(null)
  const [jsonError, setJsonError] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const pm = PROVIDER_META.gcp

  const scan = async () => {
    setScanning(true); setResult(null); setJsonError('')
    try {
      const body = { projectId: form.projectId || undefined }
      if (form.serviceAccountJson.trim()) {
        try {
          body.credentials = JSON.parse(form.serviceAccountJson)
        } catch {
          setJsonError('Invalid JSON — check your service account key')
          setScanning(false); return
        }
      }
      const res  = await fetch('/api/discovery/scan/gcp', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Scan failed')
      setResult(data); onScanComplete?.()
    } catch (e) { setResult({ error: e.message }) }
    finally { setScanning(false) }
  }

  return (
    <div>
      <div style={{ ...mono9, color:T.dim, marginBottom:14, lineHeight:1.7 }}>
        Leave service account JSON empty to use Application Default Credentials
        (<code>gcloud auth application-default login</code> or
        <code> GOOGLE_APPLICATION_CREDENTIALS</code> env var).
        Scans: Compute Engine, GKE, Cloud SQL, Cloud Run.
      </div>
      <Field label="PROJECT ID" required>
        <input style={inputStyle} value={form.projectId}
          onChange={e => set('projectId', e.target.value)}
          placeholder="my-gcp-project-id"/>
      </Field>
      <Field label="SERVICE ACCOUNT JSON (optional — paste full key file)">
        <textarea style={{ ...inputStyle, minHeight:100, resize:'vertical', fontSize:10 }}
          value={form.serviceAccountJson}
          onChange={e => set('serviceAccountJson', e.target.value)}
          placeholder='{ "type": "service_account", "project_id": "...", "private_key": "...", ... }'/>
        {jsonError && <div style={{ ...mono9, color:T.red, marginTop:4 }}>{jsonError}</div>}
      </Field>
      <button onClick={scan} disabled={scanning}
        style={{ ...mono, fontSize:12, fontWeight:700, padding:'9px 20px',
          background:pm.color+'22', border:`1px solid ${pm.color}66`,
          borderRadius:8, color:pm.color, cursor:'pointer',
          opacity: scanning ? .6 : 1, display:'flex', alignItems:'center', gap:8 }}>
        {scanning ? <><Spinner color={pm.color}/> Scanning…</> : '▶ Run GCP Scan'}
      </button>
      {result?.error && <div style={{ ...mono9, color:T.red, marginTop:8 }}>✗ {result.error}</div>}
      {result && !result.error && <ScanResult result={result}/>}
    </div>
  )
}

// ── Link modal ────────────────────────────────────────────────────────────────
function LinkModal({ resource, onClose, onLinked }) {
  const [components, setComponents] = useState([])
  const [selected,   setSelected]   = useState('')
  const [linking,    setLinking]     = useState(false)

  useEffect(() => {
    fetch('/api/components').then(r => r.json()).then(setComponents).catch(() => {})
  }, [])

  const doLink = async () => {
    if (!selected) return
    setLinking(true)
    try {
      await fetch('/api/discovery/link', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ infraId: resource.id, componentId: selected }),
      })
      onLinked?.(); onClose()
    } finally { setLinking(false) }
  }

  return (
    <div style={{ position:'fixed', inset:0, zIndex:80, display:'flex',
      alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ position:'absolute', inset:0, background:'#000000cc',
        backdropFilter:'blur(4px)' }} onClick={onClose}/>
      <div style={{ position:'relative', background:T.surface,
        border:`1px solid ${T.teal}44`, borderRadius:14, width:'100%', maxWidth:460,
        boxShadow:`0 0 50px #00000099` }}>
        <div style={{ padding:'14px 18px', borderBottom:`1px solid ${T.border}` }}>
          <div style={{ ...mono, fontSize:13, fontWeight:700, color:T.text }}>Link to Component</div>
          <div style={{ ...mono9, color:T.dim, marginTop:3 }}>{resource.name}</div>
        </div>
        <div style={{ padding:'16px 18px' }}>
          <Field label="SELECT COMPONENT" required>
            <select style={selectStyle} value={selected}
              onChange={e => setSelected(e.target.value)}>
              <option value="">— choose a component —</option>
              {components.map(c => (
                <option key={c.id} value={c.id}>{c.name} [{c.type}]</option>
              ))}
            </select>
          </Field>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:4 }}>
            <button onClick={onClose} style={{ ...mono, fontSize:11, padding:'8px 16px',
              background:'transparent', border:`1px solid ${T.border2}`,
              borderRadius:7, color:T.muted, cursor:'pointer' }}>Cancel</button>
            <button onClick={doLink} disabled={!selected || linking}
              style={{ ...mono, fontSize:11, fontWeight:700, padding:'8px 18px',
                background:T.teal+'22', border:`1px solid ${T.teal}66`,
                borderRadius:7, color:T.teal, cursor:'pointer',
                opacity: !selected || linking ? .5 : 1 }}>
              {linking ? 'Linking…' : 'Link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DiscoveryPage() {
  const [tab,       setTab]       = useState('aws')
  const [summary,   setSummary]   = useState(null)
  const [resources, setResources] = useState([])
  const [loadingRes, setLoadingRes] = useState(false)
  const [linkTarget, setLinkTarget] = useState(null)

  const loadSummary = useCallback(() => {
    fetch('/api/discovery/summary').then(r => r.json()).then(setSummary).catch(() => {})
  }, [])

  const loadResources = useCallback(() => {
    setLoadingRes(true)
    fetch('/api/discovery/resources?limit=500')
      .then(r => r.json()).then(setResources).catch(() => setResources([]))
      .finally(() => setLoadingRes(false))
  }, [])

  useEffect(() => { loadSummary(); loadResources() }, [loadSummary, loadResources])

  const onScanComplete = () => { loadSummary(); loadResources() }

  const deleteResource = async (id) => {
    if (!confirm('Delete this discovered resource?')) return
    await fetch(`/api/discovery/resources/${id}`, { method:'DELETE' })
    loadResources(); loadSummary()
  }

  const tabs = [
    { id:'aws',   label:'AWS',   color:PROVIDER_META.aws.color   },
    { id:'azure', label:'Azure', color:PROVIDER_META.azure.color },
    { id:'gcp',   label:'GCP',   color:PROVIDER_META.gcp.color   },
  ]

  return (
    <div style={{ minHeight:'100vh', background:T.bg, color:T.text,
      fontFamily:'monospace', padding:'28px 32px' }}>

      {/* Header */}
      <div style={{ marginBottom:22 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <div style={{ width:28, height:28, borderRadius:7,
            background:T.purple+'22', border:`1.5px solid ${T.purple}55`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:14, color:T.purple }}>◎</div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:800, letterSpacing:'-0.02em' }}>
            Cloud Discovery
          </h1>
        </div>
        <p style={{ margin:0, fontSize:11, color:T.dim }}>
          Connect to AWS, Azure and GCP to automatically discover and import infrastructure resources into the graph.
        </p>
      </div>

      {/* Summary */}
      <SummaryCards summary={summary}/>

      {/* Scanner tabs */}
      <div style={{ display:'grid', gridTemplateColumns:'260px 1fr', gap:14, marginBottom:20 }}>
        {/* Provider selector */}
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              ...mono, fontSize:12, fontWeight: tab===t.id ? 700 : 400,
              padding:'10px 14px', borderRadius:8, cursor:'pointer',
              border: tab===t.id ? `1px solid ${t.color}55` : `1px solid ${T.border}`,
              background: tab===t.id ? t.color+'18' : T.surface,
              color: tab===t.id ? t.color : T.muted,
              textAlign:'left', display:'flex', alignItems:'center', gap:10,
              transition:'all .12s',
            }}>
              <span style={{ fontSize:16 }}>{PROVIDER_META[t.id].icon}</span>
              {t.label}
            </button>
          ))}
          <div style={{ marginTop:8, padding:'10px 12px', background:T.surface,
            border:`1px solid ${T.border}`, borderRadius:8 }}>
            <div style={{ ...mono9, color:T.muted, marginBottom:6, letterSpacing:'0.1em' }}>CREDENTIAL FLOW</div>
            {[
              'Explicit per-scan credentials',
              'Environment variables',
              'IAM / MSI / ADC',
            ].map((s, i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                <div style={{ width:16, height:16, borderRadius:'50%',
                  background:T.teal+'22', border:`1px solid ${T.teal}55`,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  ...mono, fontSize:8, color:T.teal, flexShrink:0 }}>{i+1}</div>
                <span style={{ ...mono9, color:T.dim }}>{s}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Active scanner */}
        <Section title={`${PROVIDER_META[tab].label} Configuration`}>
          {tab === 'aws'   && <AWSPanel   onScanComplete={onScanComplete}/>}
          {tab === 'azure' && <AzurePanel onScanComplete={onScanComplete}/>}
          {tab === 'gcp'   && <GCPPanel   onScanComplete={onScanComplete}/>}
        </Section>
      </div>

      {/* Resources table */}
      <Section title={`Discovered Resources${resources.length ? ` (${resources.length})` : ''}`}>
        {loadingRes ? (
          <div style={{ textAlign:'center', padding:'24px 0' }}><Spinner/></div>
        ) : (
          <ResourceTable
            resources={resources}
            onLink={r => setLinkTarget(r)}
            onDelete={deleteResource}/>
        )}
      </Section>

      {/* Link modal */}
      {linkTarget && (
        <LinkModal
          resource={linkTarget}
          onClose={() => setLinkTarget(null)}
          onLinked={() => { loadResources(); loadSummary() }}/>
      )}
    </div>
  )
}