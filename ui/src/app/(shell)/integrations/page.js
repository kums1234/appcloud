'use client'

export const dynamic = 'force-dynamic'
import { useState, useEffect } from 'react'
import { useTheme, getT } from '@/lib/theme'
import {
  AiAssistantIntegrationCard,
  AiAssistantConfigModal,
} from '@/components/integrations/AiAssistantIntegration'
import {
  CloudAiIntegrationCard,
  CloudAiConfigModal,
} from '@/components/integrations/CloudAiConfig'
import { readAiClientConfig } from '@/lib/ai-client-config'
import { api } from '@/lib/api'

// Module-level fallback — satisfies sub-component defaults and constants.
// The default export re-derives T from useTheme() for live theme switching.
const T = getT('dark')



const mono = { fontFamily:'monospace' }

// ── Integration definitions ───────────────────────────────────────────────────
const CATEGORIES = [
  { id:'iac',      label:'Infrastructure as Code', icon:'⬡' },
  { id:'ai',       label:'AI',                      icon:'🤖' },
  { id:'cloud',    label:'Cloud Providers',         icon:'◈' },
  { id:'k8s',      label:'Kubernetes',              icon:'◎' },
  { id:'itsm',     label:'ITSM & Ticketing',        icon:'◫' },
  { id:'comms',    label:'Communications',          icon:'◎' },
]

const INTEGRATIONS = [
  // ── AI ───────────────────────────────────────────────────────────────────
  {
    id:'ai-assistant', category:'ai',
    name:'AI assistant', vendor:'Ollama & cloud LLMs',
    tagline:'Side-panel chat — local Ollama or hosted models; set cloud credentials here or use API env vars',
    color:'#f472b6', secondaryColor:'#ec4899',
    logo:'AI',
    capabilities:['Side chat','Ollama','Anthropic · OpenAI · Gemini · Azure'],
    badge:'AI',
  },
  {
    id:'cloud-ai', category:'ai',
    name:'Cloud AI Endpoint', vendor:'Server-side LLM',
    tagline:'Cloud LLM credentials stored encrypted on the server — used by agents and all AI features',
    color:'#a78bfa', secondaryColor:'#8b5cf6',
    logo:'☁',
    capabilities:['Anthropic','OpenAI','Gemini','Azure','Encrypted storage','Agent AI'],
    badge:'AI',
  },

  // ── IaC ──────────────────────────────────────────────────────────────────
  {
    id:'terraform', category:'iac',
    name:'Terraform', vendor:'HashiCorp',
    tagline:'Import state files to auto-discover resources and dependencies',
    color:'#7B42BC', secondaryColor:'#9F68D4',
    logo:'TF',
    fields:[
      { key:'stateSource', label:'STATE SOURCE', type:'select',
        options:['Local file upload','S3 bucket','Terraform Cloud / HCP','Azure Blob Storage','GCS bucket'] },
      { key:'workspacePath', label:'WORKSPACE / PATH', type:'text',
        placeholder:'e.g. s3://my-bucket/env/prod/terraform.tfstate' },
      { key:'apiToken', label:'API TOKEN (if Terraform Cloud)', type:'password',
        placeholder:'token …' },
      { key:'autoSync', label:'AUTO-SYNC INTERVAL', type:'select',
        options:['Every 15 minutes','Every hour','Every 6 hours','Daily','Manual only'] },
    ],
    capabilities:['Resource graph import','Dependency mapping','Drift detection','Change correlation'],
    badge:'Discovery',
  },

  // ── Cloud ─────────────────────────────────────────────────────────────────
  {
    id:'aws', category:'cloud',
    name:'Amazon Web Services', vendor:'AWS',
    tagline:'Sync EC2, RDS, EKS, Lambda and 200+ services via AWS Config & APIs',
    color:'#FF9900', secondaryColor:'#FFB347',
    logo:'AWS',
    fields:[
      { key:'accountId',   label:'ACCOUNT ID',       type:'text',     placeholder:'123456789012' },
      { key:'region',      label:'PRIMARY REGION',   type:'text',     placeholder:'us-east-1' },
      { key:'accessKeyId', label:'ACCESS KEY ID',    type:'text',     placeholder:'AKIA…' },
      { key:'secretKey',   label:'SECRET ACCESS KEY',type:'password', placeholder:'••••••••' },
      { key:'roleArn',     label:'IAM ROLE ARN (OPTIONAL)', type:'text', placeholder:'arn:aws:iam::…' },
      { key:'syncScope',   label:'SYNC SCOPE', type:'select',
        options:['All services','EC2 + RDS + EKS only','Custom (tag-based)'] },
    ],
    capabilities:['EC2 instances','RDS / Aurora','EKS clusters','Lambda functions','VPC topology','S3 buckets','CloudWatch alarms'],
    badge:'Discovery',
  },
  {
    id:'azure', category:'cloud',
    name:'Microsoft Azure', vendor:'Microsoft',
    tagline:'Import Azure Resource Manager topology across subscriptions',
    color:'#0078D4', secondaryColor:'#50B0F0',
    logo:'AZ',
    fields:[
      { key:'subscriptionId', label:'SUBSCRIPTION ID',         type:'text',     placeholder:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required:true },
      { key:'clientId',       label:'CLIENT ID (APP REG)',      type:'text',     placeholder:'App registration Application ID', required:true },
      { key:'clientSecret',   label:'CLIENT SECRET',           type:'password', placeholder:'••••••••', required:true },
      { key:'tenantId',       label:'TENANT ID (OPTIONAL)',    type:'text',     placeholder:'Auto-detected if blank — Azure Portal > Azure Active Directory > Overview' },
      { key:'syncScope',      label:'RESOURCE GROUPS (OPTIONAL)', type:'text', placeholder:'* for all, or comma-separated names' },
    ],
    capabilities:['Virtual Machines','AKS clusters','Azure SQL','App Services','VNets','Storage Accounts','Resource Groups'],
    badge:'Discovery',
  },
  {
    id:'gcp', category:'cloud',
    name:'Google Cloud Platform', vendor:'Google',
    tagline:'Discover GCE, GKE, Cloud SQL and services via Cloud Asset Inventory',
    color:'#4285F4', secondaryColor:'#34A853',
    logo:'GCP',
    fields:[
      { key:'projectId',      label:'PROJECT ID',          type:'text',     placeholder:'my-gcp-project' },
      { key:'serviceAccount', label:'SERVICE ACCOUNT JSON', type:'textarea', placeholder:'Paste service account key JSON…' },
      { key:'syncScope',      label:'SYNC SCOPE', type:'select',
        options:['Entire project','GKE + Compute only','Custom label filter'] },
    ],
    capabilities:['Compute Engine','GKE clusters','Cloud SQL','Cloud Functions','VPC networks','Cloud Storage','BigQuery'],
    badge:'Discovery',
  },

  // ── Kubernetes ────────────────────────────────────────────────────────────
  {
    id:'kubernetes', category:'k8s',
    name:'Kubernetes', vendor:'CNCF',
    tagline:'Connect any cluster — self-hosted, EKS, AKS, GKE or OpenShift',
    color:'#326CE5', secondaryColor:'#5B8DEF',
    logo:'K8S',
    fields:[
      { key:'clusterType', label:'CLUSTER TYPE', type:'select',
        options:['Generic / self-hosted','Amazon EKS','Azure AKS','Google GKE','Red Hat OpenShift','Rancher'] },
      { key:'apiServer',   label:'API SERVER URL',  type:'text',     placeholder:'https://k8s.example.com:6443' },
      { key:'kubeconfig',  label:'KUBECONFIG / TOKEN', type:'textarea', placeholder:'Paste kubeconfig or service account token…' },
      { key:'namespaces',  label:'NAMESPACES TO WATCH', type:'text', placeholder:'* for all, or comma-separated' },
      { key:'autoSync',    label:'WATCH MODE', type:'select',
        options:['Real-time (watch API)','Poll every 5 minutes','Poll every 30 minutes','Manual'] },
    ],
    capabilities:['Namespaces & Workloads','Services & Ingress','ConfigMaps & Secrets audit','Node topology','Pod-to-service graph','Helm release tracking'],
    badge:'Discovery',
  },

  // ── ITSM ─────────────────────────────────────────────────────────────────
  {
    id:'servicenow', category:'itsm',
    name:'ServiceNow', vendor:'ServiceNow',
    tagline:'Bi-directional sync of CIs and change requests with your CMDB',
    color:'#62D84E', secondaryColor:'#82E86E',
    logo:'SN',
    fields:[
      { key:'instanceUrl', label:'INSTANCE URL',  type:'text',     placeholder:'https://mycompany.service-now.com' },
      { key:'username',    label:'USERNAME',       type:'text',     placeholder:'integration-user' },
      { key:'password',    label:'PASSWORD',       type:'password', placeholder:'••••••••' },
      { key:'syncMode',    label:'SYNC DIRECTION', type:'select',
        options:['AppCloud → ServiceNow (push)','ServiceNow → AppCloud (pull)','Bi-directional'] },
      { key:'ciClass',     label:'CI CLASS FILTER', type:'text',   placeholder:'cmdb_ci_server, cmdb_ci_appl…' },
    ],
    capabilities:['CMDB CI import','Change request sync','Incident correlation','Approval workflow bridge','Audit trail export'],
    badge:'ITSM',
  },

  // ── Comms ─────────────────────────────────────────────────────────────────
  {
    id:'teams', category:'comms',
    name:'Microsoft Teams', vendor:'Microsoft',
    tagline:'Send change impact alerts and approval requests to Teams channels',
    color:'#6264A7', secondaryColor:'#8B8CC7',
    logo:'MS',
    fields:[
      { key:'webhookUrl',    label:'INCOMING WEBHOOK URL', type:'text', placeholder:'https://outlook.office.com/webhook/…' },
      { key:'tenantId',      label:'TENANT ID (for OAuth)', type:'text', placeholder:'xxxxxxxx-xxxx-…' },
      { key:'botToken',      label:'BOT TOKEN (optional)',  type:'password', placeholder:'••••••••' },
      { key:'defaultChannel',label:'DEFAULT CHANNEL',      type:'text', placeholder:'#infra-changes' },
      { key:'notifyOn',      label:'NOTIFY ON', type:'select',
        options:['All changes','High-risk changes only (score ≥ 7)','Approvals required','All of the above'] },
    ],
    capabilities:['Change impact alerts','Approval request cards','Blast radius summaries','@mention team owners','Sync status digests'],
    badge:'Notifications',
  },
  {
    id:'slack', category:'comms',
    name:'Slack', vendor:'Salesforce',
    tagline:'Post change alerts, impact previews and approval workflows to Slack',
    color:'#4A154B', secondaryColor:'#E01E5A',
    logo:'SL',
    fields:[
      { key:'botToken',      label:'BOT TOKEN',        type:'password', placeholder:'xoxb-…' },
      { key:'signingSecret', label:'SIGNING SECRET',   type:'password', placeholder:'••••••••' },
      { key:'defaultChannel',label:'DEFAULT CHANNEL',  type:'text',     placeholder:'#infra-changes' },
      { key:'alertChannel',  label:'ALERT CHANNEL',    type:'text',     placeholder:'#high-risk-changes' },
      { key:'notifyOn',      label:'NOTIFY ON', type:'select',
        options:['All changes','High-risk changes only (score ≥ 7)','Approvals required','All of the above'] },
    ],
    capabilities:['Change impact notifications','Interactive approval buttons','Blast radius summaries','/appcloud slash commands','DM team owners'],
    badge:'Notifications',
  },
]

const BADGE_COLOR = {
  Discovery:    { bg: T.teal+'18',   border: T.teal+'44',   text: T.teal   },
  ITSM:         { bg: T.green+'18',  border: T.green+'44',  text: T.green  },
  Notifications:{ bg: T.purple+'18', border: T.purple+'44', text: T.purple },
  AI:           { bg: '#f472b618',   border: '#f472b644',   text: '#f472b6' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const CLOUD_IDS = ['aws', 'azure', 'gcp']

function useSavedConnections() {
  // cloudAccounts: array of all saved cloud accounts from Postgres (multiple per provider)
  // connections: map of non-cloud integration state (localStorage)
  const [cloudAccounts, setCloudAccounts] = useState([])
  const [connections,   setConnections]   = useState({})

  const loadCloudAccounts = () => {
    fetch('/api/integrations/cloud')
      .then(r => r.ok ? r.json() : [])
      .then(accounts => {
        setCloudAccounts(Array.isArray(accounts) ? accounts : [])
      })
      .catch(() => setCloudAccounts([]))
  }

  useEffect(() => {
    // Non-cloud integrations from localStorage
    try {
      const base = JSON.parse(localStorage.getItem('appcloud_integrations') || '{}')
      setConnections(base)
    } catch {}
    // Cloud accounts from Postgres
    loadCloudAccounts()
  }, [])

  // Save a cloud account — name differentiates multiple accounts per provider
  const saveCloud = async (provider, name, config) => {
    const res = await fetch('/api/integrations/cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, name, config }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || `Save failed: ${res.status}`)
    }
    const saved = await res.json()
    // Immediately update cloudAccounts so connected status reflects the save
    setCloudAccounts(prev => {
      const without = prev.filter(a => a.id !== saved.id)
      return [...without, saved]
    })
    return saved
  }

  // Save non-cloud integration to localStorage
  const save = async (id, data) => {
    if (CLOUD_IDS.includes(id)) {
      const name = data._name || id
      try {
        await saveCloud(id, name, data)
      } catch (e) {
        console.error('Failed to save cloud account:', e)
        // Fall back to localStorage so UI shows connected even if API failed
        const next = { ...connections, [id]: { ...data, _saved: true } }
        setConnections(next)
        try { localStorage.setItem('appcloud_integrations', JSON.stringify(next)) } catch {}
      }
    } else {
      const next = { ...connections, [id]: { ...data, _saved: true } }
      setConnections(next)
      try { localStorage.setItem('appcloud_integrations', JSON.stringify(next)) } catch {}
    }
  }

  const removeCloud = async (accountId) => {
    try {
      await fetch(`/api/integrations/cloud/${accountId}`, { method: 'DELETE' })
      loadCloudAccounts()
    } catch {}
  }

  const remove = async (id, accountId) => {
    if (CLOUD_IDS.includes(id) && accountId) {
      await removeCloud(accountId)
    } else {
      const next = { ...connections }
      delete next[id]
      setConnections(next)
      try { localStorage.setItem('appcloud_integrations', JSON.stringify(next)) } catch {}
    }
  }

  // Legacy compat: return first saved account per provider as connections[provider]
  const legacyConnections = { ...connections }
  for (const acc of cloudAccounts) {
    if (!legacyConnections[acc.provider]) {
      legacyConnections[acc.provider] = { ...acc.config, _saved: true, _accountId: acc.id }
    }
  }

  return { connections: legacyConnections, cloudAccounts, save, remove, saveCloud, removeCloud, reload: loadCloudAccounts }
}

// ── Terraform upload panel ───────────────────────────────────────────────────
function TerraformUploadPanel() {
  const [file,       setFile]       = useState(null)
  const [dragging,   setDragging]   = useState(false)
  const [status,     setStatus]     = useState(null) // null | 'uploading' | 'done' | 'error'
  const [result,     setResult]     = useState(null)
  const [history,    setHistory]    = useState([])
  const [loadingHist,setLoadingHist]= useState(true)
  const BASE = '/api'

  // Load import history
  const loadHistory = () => {
    fetch(`${BASE}/integrations/terraform/history`)
      .then(r => r.ok ? r.json() : [])
      .then(setHistory).catch(()=>{})
      .finally(()=>setLoadingHist(false))
  }
  useEffect(()=>{ loadHistory() }, [])

  const handleUpload = async (f) => {
    if (!f) return
    setStatus('uploading'); setResult(null)
    const fd = new FormData()
    fd.append('statefile', f)
    try {
      const res = await fetch(`${BASE}/integrations/terraform/import`, {
        method: 'POST', body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Import failed')
      setResult({ ok: true, ...data })
      setStatus('done')
      loadHistory()
    } catch(err) {
      setResult({ ok: false, error: err.message })
      setStatus('error')
    }
  }

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) { setFile(f); handleUpload(f) }
  }

  const STATUS_COLOR = { success:T.green, done:T.green, error:T.red, running:T.amber, pending:T.muted, partial:T.amber }

  return (
    <div>
      {/* Drop zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDragging(true)}}
        onDragLeave={()=>setDragging(false)}
        onDrop={onDrop}
        style={{
          border:`2px dashed ${dragging?'#7B42BC':'#1e293b'}`,
          borderRadius:12, padding:'28px 20px',
          textAlign:'center', marginBottom:16,
          background:dragging?'#7B42BC0a':'#080f1a',
          transition:'all .15s', cursor:'pointer',
        }}
        onClick={()=>document.getElementById('tf-file-input').click()}
      >
        <input id="tf-file-input" type="file" accept=".json,.tfstate"
          style={{ display:'none' }}
          onChange={e=>{ const f=e.target.files[0]; if(f){setFile(f);handleUpload(f)} }} />
        <div style={{ fontSize:28, marginBottom:10, opacity:.5 }}>⬡</div>
        <div style={{ ...mono, fontSize:12, fontWeight:700, color:'#f1f5f9', marginBottom:5 }}>
          {status==='uploading' ? 'Importing…' : 'Drop terraform.tfstate here'}
        </div>
        <div style={{ ...mono, fontSize:10, color:T.dim }}>
          {status==='uploading'
            ? `Parsing ${file?.name}…`
            : 'or click to browse · .tfstate or .json · up to 50 MB'}
        </div>
        {status==='uploading'&&(
          <div style={{ marginTop:14,display:'flex',justifyContent:'center' }}>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            <div style={{ width:20,height:20,borderRadius:'50%',
              border:'2px solid #1e293b',borderTop:'2px solid #7B42BC',
              animation:'spin .7s linear infinite' }} />
          </div>
        )}
      </div>

      {/* Result card */}
      {result&&(
        <div style={{ padding:'14px 16px',borderRadius:10,marginBottom:16,
          background:result.ok?T.green+'0a':T.red+'0a',
          border:`1px solid ${result.ok?T.green+'44':T.red+'44'}` }}>
          {result.ok ? (
            <div>
              <div style={{ ...mono,fontSize:12,fontWeight:700,color:T.green,marginBottom:10 }}>
                ✓ Import complete — {result.filename}
              </div>
              <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:10 }}>
                {[
                  ['Found',   result.resourcesFound,   T.muted],
                  ['Created', result.resourcesCreated, T.green],
                  ['Updated', result.resourcesUpdated, T.blue],
                  ['Skipped', result.resourcesSkipped, T.amber],
                ].map(([label,val,color])=>(
                  <div key={label} style={{ textAlign:'center',padding:'8px',
                    background:T.surface3,borderRadius:7,border:`1px solid ${T.border}` }}>
                    <div style={{ ...mono,fontSize:18,fontWeight:800,color }}>{val}</div>
                    <div style={{ ...mono,fontSize:8,color:T.muted,marginTop:2,
                      letterSpacing:'0.1em' }}>{label.toUpperCase()}</div>
                  </div>
                ))}
              </div>
              {result.summary?.sampleNames?.length>0&&(
                <div style={{ ...mono,fontSize:9,color:T.dim }}>
                  Imported: {result.summary.sampleNames.join(', ')}
                  {result.resourcesFound > 10 ? ` + ${result.resourcesFound-10} more` : ''}
                </div>
              )}
              {result.parseErrors?.length>0&&(
                <div style={{ ...mono,fontSize:9,color:T.amber,marginTop:6 }}>
                  ⚠ {result.parseErrors.join(' · ')}
                </div>
              )}
            </div>
          ):(
            <div style={{ ...mono,fontSize:11,color:T.red }}>
              ✗ {result.error}
            </div>
          )}
        </div>
      )}

      {/* Import history */}
      <div style={{ ...mono,fontSize:8,color:T.muted,letterSpacing:'0.12em',
        fontWeight:700,marginBottom:8 }}>IMPORT HISTORY</div>
      {loadingHist ? (
        <div style={{ ...mono,fontSize:10,color:T.muted,padding:'10px 0' }}>Loading…</div>
      ) : history.length===0 ? (
        <div style={{ ...mono,fontSize:10,color:T.muted,padding:'8px 0' }}>No imports yet</div>
      ) : (
        <div style={{ display:'flex',flexDirection:'column',gap:5,maxHeight:200,overflowY:'auto' }}>
          {history.map((job,i)=>{
            const sc = STATUS_COLOR[job.status]||T.muted
            const dur = job.duration_ms ? `${(job.duration_ms/1000).toFixed(1)}s` : null
            return (
              <div key={job.id||i} style={{ display:'flex',alignItems:'center',gap:10,
                padding:'8px 12px',background:T.surface2,borderRadius:7,
                border:`1px solid ${T.border}` }}>
                <div style={{ width:5,height:5,borderRadius:'50%',
                  background:sc,boxShadow:`0 0 4px ${sc}`,flexShrink:0 }} />
                <span style={{ ...mono,fontSize:11,color:T.text,
                  flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                  {job.filename}
                </span>
                <span style={{ ...mono,fontSize:9,color:T.dim }}>
                  {job.resources_imported||0} imported
                </span>
                {dur&&<span style={{ ...mono,fontSize:9,color:T.muted }}>{dur}</span>}
                <span style={{ ...mono,fontSize:8,fontWeight:700,color:sc,
                  background:sc+'18',border:`1px solid ${sc}33`,
                  borderRadius:3,padding:'1px 6px',letterSpacing:'0.06em' }}>
                  {job.status?.toUpperCase()}
                </span>
                <span style={{ ...mono,fontSize:9,color:T.muted,flexShrink:0 }}>
                  {job.created_at ? new Date(job.created_at).toLocaleDateString('en-GB') : ''}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Config modal ──────────────────────────────────────────────────────────────
function ConfigModal({ integration: intg, existing, accountName, onSave, onDisconnect, onClose }) {
  const IS_CLOUD = ['aws','azure','gcp'].includes(intg.id)
  // accountName field — lets users label multiple accounts per provider
  const [name,    setName]    = useState(accountName || existing?._name || intg.id)
  const [form,    setForm]    = useState(
    () => Object.fromEntries(intg.fields.map(f => [f.key, existing?.[f.key] || '']))
  )
  const [testing,    setTesting]    = useState(false)
  const [testMsg,    setTestMsg]    = useState(null)
  const [saving,     setSaving]     = useState(false)
  const [saved,      setSaved]      = useState(false)
  const [saveError,  setSaveError]  = useState(null)
  const [scanning,   setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleTest = async () => {
    setTesting(true); setTestMsg(null)
    await new Promise(r => setTimeout(r, 1400))
    const ok = Object.values(form).some(v => v.trim?.().length > 3)
    setTestMsg(ok
      ? { ok:true,  text:`Connection to ${intg.name} verified successfully.` }
      : { ok:false, text:'Connection failed — check your credentials and try again.' }
    )
    setTesting(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(form, name)
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 900)
    } catch (e) {
      setSaveError(e.message || 'Save failed — check the console for details')
    } finally {
      setSaving(false)
    }
  }

  const handleScanNow = async () => {
    setScanning(true); setScanResult(null)
    try {
      const endpoint = `/api/discovery/scan/${intg.id}`
      const body = {}
      if (intg.id === 'aws') {
        body.regions = form.region ? [form.region] : ['us-east-1']
        const secret = form.secretKey || form.secretAccessKey
        if (form.accessKeyId && secret)
          body.credentials = { accessKeyId: form.accessKeyId, secretAccessKey: secret }
      } else if (intg.id === 'azure') {
        body.subscriptionId = form.subscriptionId
        // tenantId is optional — send credentials as long as clientId + clientSecret present
        if (form.clientId && form.clientSecret)
          body.credentials = {
            clientId:     form.clientId,
            clientSecret: form.clientSecret,
            ...(form.tenantId ? { tenantId: form.tenantId } : {}),
          }
      } else if (intg.id === 'gcp') {
        body.projectId = form.projectId
        if (form.serviceAccount) { try { body.credentials = JSON.parse(form.serviceAccount) } catch {} }
      }
      const res  = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
      const data = await res.json()
      if (res.ok) {
        setScanResult({
          ok:       true,
          total:    data.total,
          duration: data.duration,
          breakdown:data.breakdown,  // single-account scan
          results:  data.results,    // multi-account scan
        })
      } else {
        setScanResult({ ok:false, error: data.message || data.error || `HTTP ${res.status}` })
      }
    } catch (e) {
      setScanResult({ ok:false, error: e.message || 'Network error — is the API running?' })
    } finally {
      setScanning(false)
    }
  }

  const isConnected = !!existing
  const T = getT('dark')
  const mono = { fontFamily:'monospace' }

  return (
    <div style={{ position:'fixed',inset:0,zIndex:60,display:'flex',
      alignItems:'center',justifyContent:'center',padding:20 }}>
      <style>{`
        @keyframes mIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .cfg-scroll::-webkit-scrollbar{width:4px}
        .cfg-scroll::-webkit-scrollbar-track{background:transparent}
        .cfg-scroll::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
      `}</style>
      <div style={{ position:'absolute',inset:0,background:'#000000cc',
        backdropFilter:'blur(6px)' }} onClick={onClose} />

      <div style={{ position:'relative',background:T.surface,
        border:`1px solid ${intg.color}33`,borderRadius:18,
        width:'100%',maxWidth:560,maxHeight:'90vh',
        display:'flex',flexDirection:'column',
        boxShadow:`0 0 80px ${intg.color}18, 0 30px 80px #00000099`,
        animation:'mIn .22s cubic-bezier(.16,1,.3,1)' }}>

        <div style={{ position:'absolute',top:0,left:'5%',right:'5%',height:1,
          background:`linear-gradient(90deg,transparent,${intg.color}88,transparent)` }} />

        {/* Header */}
        <div style={{ padding:'18px 22px',borderBottom:`1px solid ${T.border}`,
          display:'flex',alignItems:'center',gap:14,flexShrink:0 }}>
          <div style={{ width:44,height:44,borderRadius:12,flexShrink:0,
            background:`linear-gradient(135deg,${intg.color}22,${intg.color}08)`,
            border:`1.5px solid ${intg.color}44`,
            display:'flex',alignItems:'center',justifyContent:'center',
            boxShadow:`0 0 20px ${intg.color}22` }}>
            <span style={{ ...mono,fontSize:11,fontWeight:900,color:intg.color }}>{intg.logo}</span>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ ...mono,fontSize:14,fontWeight:800,color:T.text }}>{intg.name}</div>
            <div style={{ ...mono,fontSize:10,color:T.dim,marginTop:2 }}>{intg.tagline}</div>
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',
            color:T.muted,cursor:'pointer',fontSize:22,lineHeight:1 }}>×</button>
        </div>

        {/* Scrollable form body */}
        <div className="cfg-scroll" style={{ overflowY:'auto',padding:'18px 22px',flex:1 }}>

          {/* Account name — cloud providers only, enables multiple accounts */}
          {IS_CLOUD && (
            <div style={{ marginBottom:16, padding:'12px 14px', borderRadius:10,
              background:T.surface2, border:`1px solid ${intg.color}33` }}>
              <div style={{ ...mono,fontSize:8,color:intg.color,letterSpacing:'0.12em',
                fontWeight:700,marginBottom:6 }}>ACCOUNT LABEL</div>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={`e.g. ${intg.id === 'aws' ? 'prod-account' : intg.id === 'azure' ? 'prod-subscription' : 'my-gcp-project'}`}
                style={{ width:'100%',background:T.surface,border:`1px solid ${T.border2}`,
                  borderRadius:8,padding:'8px 12px',color:T.text,fontSize:12,
                  fontFamily:'monospace',outline:'none',boxSizing:'border-box' }}
              />
              <div style={{ ...mono,fontSize:9,color:T.muted,marginTop:5 }}>
                A unique label for this account. Add multiple accounts by saving with different labels.
              </div>
            </div>
          )}

          {intg.id==='terraform' && (
            <div style={{ marginBottom:20,paddingBottom:20,borderBottom:`1px solid ${T.border}` }}>
              <div style={{ ...mono,fontSize:8,color:T.muted,letterSpacing:'0.12em',
                fontWeight:700,marginBottom:10 }}>IMPORT STATE FILE</div>
              <TerraformUploadPanel/>
            </div>
          )}

          {intg.fields.map(field => (
            <div key={field.key} style={{ marginBottom:14 }}>
              <div style={{ ...mono,fontSize:8,color:T.muted,letterSpacing:'0.12em',
                fontWeight:700,marginBottom:6 }}>{field.label}</div>
              {field.type==='select' ? (
                <select value={form[field.key]} onChange={e=>set(field.key,e.target.value)}
                  style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
                    borderRadius:8,padding:'9px 12px',color:form[field.key]?T.text:T.dim,
                    fontSize:12,fontFamily:'monospace',outline:'none',cursor:'pointer',appearance:'none' }}>
                  <option value="">Select…</option>
                  {field.options.map(o=><option key={o} value={o}>{o}</option>)}
                </select>
              ) : field.type==='textarea' ? (
                <textarea value={form[field.key]} onChange={e=>set(field.key,e.target.value)}
                  rows={4} placeholder={field.placeholder}
                  style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
                    borderRadius:8,padding:'9px 12px',color:T.text,fontSize:11,
                    fontFamily:'monospace',outline:'none',resize:'vertical',boxSizing:'border-box' }} />
              ) : (
                <input type={field.type==='password'?'password':'text'}
                  value={form[field.key]} onChange={e=>set(field.key,e.target.value)}
                  placeholder={field.placeholder}
                  style={{ width:'100%',background:T.surface2,border:`1px solid ${T.border2}`,
                    borderRadius:8,padding:'9px 12px',color:T.text,fontSize:12,
                    fontFamily:'monospace',outline:'none',boxSizing:'border-box' }} />
              )}
            </div>
          ))}

          {testMsg && (
            <div style={{ padding:'9px 13px',borderRadius:8,marginBottom:4,
              background:testMsg.ok?T.green+'12':T.red+'12',
              border:`1px solid ${testMsg.ok?T.green+'44':T.red+'44'}` }}>
              <span style={{ ...mono,fontSize:11,color:testMsg.ok?T.green:T.red }}>
                {testMsg.ok?'✓ ':'✗ '}{testMsg.text}
              </span>
            </div>
          )}
          {saveError && (
            <div style={{ padding:'9px 13px',borderRadius:8,marginBottom:4,
              background:T.red+'12', border:`1px solid ${T.red}44` }}>
              <span style={{ ...mono,fontSize:11,color:T.red }}>✗ {saveError}</span>
            </div>
          )}
        </div>

        {/* Scan result */}
        {scanResult && (
          <div style={{ padding:'8px 22px', borderTop:`1px solid ${T.border}` }}>
            <div style={{ padding:'8px 12px',borderRadius:7,
              background:scanResult.ok?T.green+'0a':T.red+'0a',
              border:`1px solid ${scanResult.ok?T.green+'44':T.red+'44'}` }}>
              {scanResult.ok ? (
                <div>
                  <div style={{ ...mono,fontSize:10,fontWeight:700,color:T.green,marginBottom:4 }}>
                    ✓ {scanResult.total} resource{scanResult.total!==1?'s':''} in {(scanResult.duration/1000).toFixed(1)}s
                  </div>
                  {/* Multi-account results array */}
                  {scanResult.results?.map((r,i) => (
                    <div key={i} style={{ ...mono,fontSize:9,color:T.dim,marginBottom:3 }}>
                      {r.error
                        ? <span style={{ color:T.red }}>✗ {r.account}: {r.error}</span>
                        : <span>✓ {r.account}: {r.total} resources</span>
                      }
                    </div>
                  ))}
                  {/* Single-scan breakdown */}
                  {scanResult.breakdown && (
                    <div style={{ display:'flex',gap:6,flexWrap:'wrap',marginTop:4 }}>
                      {Object.entries(scanResult.breakdown)
                        .filter(([k])=>!['errors','skipped'].includes(k))
                        .map(([k,v]) => v > 0 && (
                          <span key={k} style={{ ...mono,fontSize:8,color:T.dim,
                            background:T.surface2,border:`1px solid ${T.border}`,
                            borderRadius:3,padding:'1px 6px' }}>{k}: {v}</span>
                        ))}
                    </div>
                  )}
                  {(scanResult.breakdown?.errors?.length > 0) && (
                    <div style={{ marginTop:4 }}>
                      {scanResult.breakdown.errors.slice(0,3).map((e,i)=>(
                        <div key={i} style={{ ...mono,fontSize:8,color:T.amber }}>⚠ {e}</div>
                      ))}
                    </div>
                  )}
                  {(scanResult.breakdown?.skipped?.length > 0) && (
                    <div style={{ ...mono,fontSize:8,color:T.muted,marginTop:3 }}>
                      {scanResult.breakdown.skipped.length} service{scanResult.breakdown.skipped.length!==1?'s':''} skipped (not available)
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ ...mono,fontSize:10,color:T.red,fontWeight:700 }}>✗ Scan failed</div>
                  <div style={{ ...mono,fontSize:9,color:T.red,marginTop:3,wordBreak:'break-word' }}>
                    {scanResult.error}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer buttons */}
        <div style={{ padding:'14px 22px',borderTop:`1px solid ${T.border}`,
          display:'flex',gap:8,flexShrink:0 }}>
          {isConnected && (
            <button onClick={onDisconnect}
              style={{ ...mono,fontSize:11,padding:'9px 14px',
                background:T.red+'12',border:`1px solid ${T.red}33`,
                borderRadius:8,color:T.red,cursor:'pointer' }}>
              Remove
            </button>
          )}
          {IS_CLOUD && (
            <button onClick={handleScanNow} disabled={scanning}
              style={{ ...mono,fontSize:11,padding:'9px 14px',
                background:T.teal+'18',border:`1px solid ${T.teal}44`,
                borderRadius:8,color:T.teal,cursor:'pointer',
                display:'flex',alignItems:'center',gap:6,opacity:scanning?.6:1 }}>
              {scanning ? (
                <><div style={{ width:10,height:10,borderRadius:'50%',
                  border:`1.5px solid ${T.teal}33`,borderTop:`1.5px solid ${T.teal}`,
                  animation:'spin .7s linear infinite' }}/> Scanning…</>
              ) : '▶ Scan Now'}
            </button>
          )}
          <button onClick={handleTest} disabled={testing}
            style={{ ...mono,fontSize:11,padding:'9px 16px',
              background:T.surface2,border:`1px solid ${T.border2}`,
              borderRadius:8,color:T.dim,cursor:'pointer',
              display:'flex',alignItems:'center',gap:7 }}>
            {testing && <div style={{ width:10,height:10,borderRadius:'50%',
              border:`1.5px solid ${T.border2}`,borderTop:`1.5px solid ${T.dim}`,
              animation:'spin .7s linear infinite' }} />}
            {testing?'Testing…':'Test Connection'}
          </button>
          <button onClick={handleSave} disabled={saving||saved}
            style={{ ...mono,fontSize:11,fontWeight:700,padding:'9px 22px',
              background:saved?T.green:`linear-gradient(135deg,${intg.color},${intg.secondaryColor})`,
              border:'none',borderRadius:8,color:'#fff',cursor:'pointer',
              flex:1,transition:'all .2s',
              boxShadow:saved?`0 0 20px ${T.green}44`:`0 0 20px ${intg.color}33` }}>
            {saved?'✓ Saved!':saving?'Saving…':(isConnected?'Update':'Save Account')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Integration card ──────────────────────────────────────────────────────────
function IntegrationCard({ intg, connected, accountCount, onConfigure }) {
  const [hover, setHover] = useState(false)
  const badgeMeta = BADGE_COLOR[intg.badge] || BADGE_COLOR.Discovery

  return (
    <div
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      style={{
        background: hover
          ? `linear-gradient(135deg,${intg.color}0d,${T.surface2})`
          : T.surface,
        border:`1.5px solid ${connected
          ? intg.color+'66'
          : hover ? intg.color+'33' : T.border}`,
        borderRadius:14,padding:'18px 18px 16px',
        cursor:'pointer',position:'relative',overflow:'hidden',
        transition:'all .2s',
        boxShadow: connected
          ? `0 0 28px ${intg.color}18`
          : hover ? `0 0 20px ${intg.color}10` : 'none',
      }}
      onClick={onConfigure}
    >
      {/* Top shimmer when connected */}
      {connected&&(
        <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
          background:`linear-gradient(90deg,transparent,${intg.color}77,transparent)` }} />
      )}

      {/* Logo + badges row */}
      <div style={{ display:'flex',alignItems:'flex-start',
        justifyContent:'space-between',marginBottom:14 }}>
        <div style={{ width:46,height:46,borderRadius:12,
          background:`linear-gradient(135deg,${intg.color}20,${intg.color}08)`,
          border:`1.5px solid ${intg.color}${connected?'66':'33'}`,
          display:'flex',alignItems:'center',justifyContent:'center',
          boxShadow: connected?`0 0 16px ${intg.color}33`:'none',
          transition:'all .2s',flexShrink:0 }}>
          <span style={{ ...mono,fontSize:11,fontWeight:900,color:intg.color }}>
            {intg.logo}
          </span>
        </div>
        <div style={{ display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5 }}>
          {/* Category badge */}
          <span style={{ ...mono,fontSize:8,fontWeight:700,
            color:badgeMeta.text,background:badgeMeta.bg,
            border:`1px solid ${badgeMeta.border}`,
            padding:'2px 7px',borderRadius:4,letterSpacing:'0.07em' }}>
            {intg.badge}
          </span>
          {/* Status dot */}
          {connected?(
            <div style={{ display:'flex',alignItems:'center',gap:5 }}>
              <div style={{ width:5,height:5,borderRadius:'50%',
                background:T.green,boxShadow:`0 0 6px ${T.green}` }} />
              <span style={{ ...mono,fontSize:8,color:T.green,fontWeight:700 }}>
                CONNECTED
              </span>
            </div>
          ):(
            <span style={{ ...mono,fontSize:8,color:T.muted }}>NOT CONNECTED</span>
          )}
        </div>
      </div>

      {/* Name + vendor */}
      <div style={{ ...mono,fontSize:13,fontWeight:800,color:T.text,
        marginBottom:2,letterSpacing:'-0.01em' }}>{intg.name}</div>
      <div style={{ ...mono,fontSize:9,color:T.muted,marginBottom:8 }}>
        {intg.vendor}
      </div>

      {/* Tagline */}
      <div style={{ fontSize:11,color:T.dim,lineHeight:1.5,marginBottom:12,
        fontFamily:'monospace' }}>
        {intg.tagline}
      </div>

      {/* Capability pills */}
      <div style={{ display:'flex',flexWrap:'wrap',gap:4 }}>
        {intg.capabilities.slice(0,4).map(cap=>(
          <span key={cap} style={{ ...mono,fontSize:8,
            color:connected?intg.color:T.muted,
            background:connected?intg.color+'12':T.surface2,
            border:`1px solid ${connected?intg.color+'30':T.border}`,
            borderRadius:4,padding:'2px 6px' }}>
            {cap}
          </span>
        ))}
        {intg.capabilities.length>4&&(
          <span style={{ ...mono,fontSize:8,color:T.muted,
            background:T.surface2,border:`1px solid ${T.border}`,
            borderRadius:4,padding:'2px 6px' }}>
            +{intg.capabilities.length-4} more
          </span>
        )}
      </div>

      {/* Configure button — appears on hover */}
      <div style={{ position:'absolute',bottom:14,right:14,
        opacity:hover||connected?1:0,transition:'opacity .15s' }}>
        <div style={{ ...mono,fontSize:9,fontWeight:700,
          color:intg.color,padding:'4px 10px',
          background:intg.color+'15',border:`1px solid ${intg.color}44`,
          borderRadius:6 }}>
          {connected?'Edit Config →':'Configure →'}
        </div>
      </div>
    </div>
  )
}

// ── Sync status banner ────────────────────────────────────────────────────────
function SyncBanner({ connections }) {
  const connectedList = INTEGRATIONS.filter(i => i.id !== 'ai-assistant' && connections[i.id])
  if(!connectedList.length) return null

  return (
    <div style={{ marginBottom:24,padding:'12px 18px',
      background:`linear-gradient(135deg,${T.teal}0a,${T.surface2})`,
      border:`1px solid ${T.teal}33`,borderRadius:12,
      display:'flex',alignItems:'center',gap:14 }}>
      <div style={{ width:8,height:8,borderRadius:'50%',
        background:T.teal,boxShadow:`0 0 10px ${T.teal}`,flexShrink:0 }}>
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      </div>
      <div style={{ flex:1 }}>
        <span style={{ ...mono,fontSize:11,fontWeight:700,color:T.teal }}>
          {connectedList.length} integration{connectedList.length>1?'s':''} active
        </span>
        <span style={{ ...mono,fontSize:11,color:T.dim }}>
          {' '}· {connectedList.map(i=>i.name).join(', ')}
        </span>
      </div>
      <div style={{ ...mono,fontSize:9,color:T.dim }}>
        Discovery syncing continuously
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function IntegrationsPage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const { connections, cloudAccounts, save, remove, saveCloud, removeCloud, reload } = useSavedConnections()
  const [activeCategory, setActiveCategory] = useState('all')
  const [configuring,    setConfiguring]    = useState(null) // integration id
  const [editAccount,    setEditAccount]    = useState(null) // { id, name, config } for editing existing
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [cloudAiModalOpen, setCloudAiModalOpen] = useState(false)
  const [cloudAiConfigured, setCloudAiConfigured] = useState(false)
  const [aiCfgTick, setAiCfgTick] = useState(0)
  const [aiHasSaved, setAiHasSaved] = useState(() =>
    typeof window !== 'undefined' && !!readAiClientConfig()?.savedAt)

  // Check server-side Cloud AI config
  useEffect(() => {
    api.integrations.aiConfig()
      .then(cfg => setCloudAiConfigured(cfg?.configured || false))
      .catch(() => setCloudAiConfigured(false))
  }, [aiCfgTick])

  const filtered = activeCategory==='all'
    ? INTEGRATIONS
    : INTEGRATIONS.filter(i=>i.category===activeCategory)

  useEffect(() => {
    setAiHasSaved(!!readAiClientConfig()?.savedAt)
  }, [aiCfgTick])

  const connectedCount = INTEGRATIONS.filter(i => {
    if (i.id === 'ai-assistant') return aiHasSaved
    if (i.id === 'cloud-ai') return cloudAiConfigured
    return connections[i.id]
  }).length

  const intgBeingConfigured = INTEGRATIONS.find(i=>i.id===configuring)

  // Accounts for the currently-being-configured provider
  const providerAccounts = intgBeingConfigured
    ? cloudAccounts.filter(a => a.provider === intgBeingConfigured.id)
    : []

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.hash !== '#ai-assistant') return
    const scroll = () => document.getElementById('ai-assistant')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const raf = requestAnimationFrame(scroll)
    const t = window.setTimeout(scroll, 180)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [])

  return (
    <div style={{ minHeight:'100vh',
      background:`radial-gradient(ellipse at 15% 10%,#07111f 0%,${T.bg} 55%)`,
      padding:'28px 32px',fontFamily:'monospace' }}>
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .int-card{animation:fadeUp .3s ease both}
      `}</style>

      {/* Header */}
      <div style={{ marginBottom:28 }}>
        <div style={{ display:'flex',alignItems:'flex-start',
          justifyContent:'space-between' }}>
          <div>
            <h1 style={{ ...mono,fontSize:20,fontWeight:800,color:T.text,
              letterSpacing:'-0.02em',margin:'0 0 6px' }}>Integrations</h1>
            <p style={{ ...mono,fontSize:11,color:T.muted,letterSpacing:'0.05em' }}>
              CONNECT YOUR INFRASTRUCTURE · AUTO-DISCOVERY & SYNC
            </p>
          </div>
          {/* Summary chips */}
          <div style={{ display:'flex',gap:1 }}>
            {[
              [connectedCount,      'CONNECTED', T.green],
              [INTEGRATIONS.length-connectedCount,'AVAILABLE',T.muted],
            ].map(([v,label,color],i,arr)=>(
              <div key={label} style={{ padding:'8px 16px',background:T.surface,
                border:`1px solid ${T.border}`,
                borderLeft:i>0?'none':undefined,
                borderRadius:i===0?'10px 0 0 10px':'0 10px 10px 0',
                display:'flex',flexDirection:'column',alignItems:'center',gap:2 }}>
                <span style={{ ...mono,fontSize:18,fontWeight:800,color }}>{v}</span>
                <span style={{ ...mono,fontSize:8,color:T.muted,
                  letterSpacing:'0.1em' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Active sync banner */}
      <SyncBanner connections={connections}/>

      {/* Category filter */}
      <div style={{ display:'flex',gap:8,marginBottom:24,flexWrap:'wrap' }}>
        {[{ id:'all', label:'All', icon:'◈' }, ...CATEGORIES].map(cat=>{
          const active = activeCategory===cat.id
          return (
            <button key={cat.id} onClick={()=>setActiveCategory(cat.id)}
              style={{ ...mono,fontSize:10,fontWeight:active?700:400,
                padding:'7px 14px',borderRadius:8,cursor:'pointer',
                background:active?T.teal+'18':T.surface,
                border:`1px solid ${active?T.teal+'55':T.border2}`,
                color:active?T.teal:T.dim,transition:'all .15s' }}>
              {cat.label}
            </button>
          )
        })}
      </div>

      {/* Cards grid */}
      <div style={{ display:'grid',
        gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',
        gap:14 }}>
        {filtered.map((intg,i)=>(
          <div key={intg.id} className="int-card"
            style={{ animationDelay:`${i*40}ms` }}>
            {intg.id === 'ai-assistant' ? (
              <AiAssistantIntegrationCard
                intg={intg}
                connected={aiHasSaved}
                onConfigure={()=>setAiModalOpen(true)}
              />
            ) : intg.id === 'cloud-ai' ? (
              <CloudAiIntegrationCard
                intg={intg}
                connected={cloudAiConfigured}
                onConfigure={()=>setCloudAiModalOpen(true)}
              />
            ) : (
              <IntegrationCard
                intg={intg}
                connected={
                  CLOUD_IDS.includes(intg.id)
                    ? cloudAccounts.some(a => a.provider === intg.id)
                    : !!connections[intg.id]
                }
                accountCount={CLOUD_IDS.includes(intg.id)
                  ? cloudAccounts.filter(a => a.provider === intg.id).length
                  : undefined}
                onConfigure={()=>setConfiguring(intg.id)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Empty state */}
      {filtered.length===0&&(
        <div style={{ textAlign:'center',padding:'60px 0' }}>
          <div style={{ ...mono,fontSize:12,color:T.muted }}>
            No integrations in this category
          </div>
        </div>
      )}

      {/* Config modal */}
      {/* Saved accounts panel — shows all accounts for this provider */}
      {intgBeingConfigured && ['aws','azure','gcp'].includes(intgBeingConfigured.id) && providerAccounts.length > 0 && !editAccount && (
        <div style={{ position:'fixed',inset:0,zIndex:60,display:'flex',
          alignItems:'center',justifyContent:'center',padding:20 }}>
          <div style={{ position:'absolute',inset:0,background:'#000000cc',backdropFilter:'blur(6px)' }}
            onClick={()=>setConfiguring(null)} />
          <div style={{ position:'relative',background:T.surface,
            border:`1px solid ${intgBeingConfigured.color}33`,borderRadius:18,
            width:'100%',maxWidth:520,
            boxShadow:`0 0 80px ${intgBeingConfigured.color}18, 0 30px 80px #00000099` }}>
            <div style={{ padding:'18px 22px',borderBottom:`1px solid ${T.border}`,
              display:'flex',alignItems:'center',justifyContent:'space-between' }}>
              <div style={{ ...mono,fontSize:14,fontWeight:800,color:T.text }}>
                {intgBeingConfigured.name} Accounts
              </div>
              <button onClick={()=>setConfiguring(null)}
                style={{ background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:22 }}>×</button>
            </div>
            <div style={{ padding:'14px 22px' }}>
              {providerAccounts.map(acc => (
                <div key={acc.id} style={{ display:'flex',alignItems:'center',gap:10,
                  padding:'10px 14px',borderRadius:10,marginBottom:8,
                  background:T.surface2,border:`1px solid ${T.border}` }}>
                  <div style={{ width:8,height:8,borderRadius:'50%',
                    background:acc.last_scan_status==='success'?T.green:acc.last_scan_status==='error'?T.red:T.muted }} />
                  <div style={{ flex:1 }}>
                    <div style={{ ...mono,fontSize:12,fontWeight:700,color:T.text }}>{acc.name}</div>
                    <div style={{ ...mono,fontSize:9,color:T.muted,marginTop:1 }}>
                      {acc.last_scan_at
                        ? `Last scan: ${new Date(acc.last_scan_at).toLocaleString()} · ${acc.last_scan_total || 0} resources`
                        : 'Never scanned'}
                    </div>
                  </div>
                  <button onClick={()=>setEditAccount(acc)}
                    style={{ ...mono,fontSize:10,padding:'5px 12px',borderRadius:7,
                      background:intgBeingConfigured.color+'18',
                      border:`1px solid ${intgBeingConfigured.color}44`,
                      color:intgBeingConfigured.color,cursor:'pointer' }}>Edit</button>
                  <button onClick={()=>{ removeCloud(acc.id); reload() }}
                    style={{ ...mono,fontSize:10,padding:'5px 10px',borderRadius:7,
                      background:T.red+'12',border:`1px solid ${T.red}33`,
                      color:T.red,cursor:'pointer' }}>✕</button>
                </div>
              ))}
              <button onClick={()=>setEditAccount({ id:null, name:'', config:{}, provider:intgBeingConfigured.id })}
                style={{ ...mono,fontSize:11,fontWeight:700,width:'100%',padding:'10px 0',
                  borderRadius:10,background:intgBeingConfigured.color+'18',
                  border:`1px solid ${intgBeingConfigured.color}44`,
                  color:intgBeingConfigured.color,cursor:'pointer',marginTop:4 }}>
                + Add Another Account
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config modal — new account or editing existing */}
      {intgBeingConfigured && intgBeingConfigured.id !== 'ai-assistant' && (
        (editAccount || !['aws','azure','gcp'].includes(intgBeingConfigured.id) || providerAccounts.length === 0) && (
        <ConfigModal
          integration={intgBeingConfigured}
          existing={editAccount?.config ? { ...editAccount.config, _name: editAccount.name } : connections[intgBeingConfigured.id]}
          accountName={editAccount?.name}
          onSave={async (data, name) => {
            if (['aws','azure','gcp'].includes(intgBeingConfigured.id)) {
              await saveCloud(intgBeingConfigured.id, name || intgBeingConfigured.id, data)
              reload()
            } else {
              await save(intgBeingConfigured.id, data)
            }
            setEditAccount(null)
          }}
          onDisconnect={() => {
            if (editAccount?.id) {
              removeCloud(editAccount.id)
              reload()
            } else {
              remove(intgBeingConfigured.id, connections[intgBeingConfigured.id]?._accountId)
            }
            setEditAccount(null)
            setConfiguring(null)
          }}
          onClose={() => { setEditAccount(null); setConfiguring(null) }}
        />
      ))}

      {aiModalOpen && (
        <AiAssistantConfigModal
          intg={INTEGRATIONS.find(x => x.id === 'ai-assistant')}
          onClose={() => setAiModalOpen(false)}
          onSaved={() => setAiCfgTick(t => t + 1)}
        />
      )}

      {cloudAiModalOpen && (
        <CloudAiConfigModal
          intg={INTEGRATIONS.find(x => x.id === 'cloud-ai')}
          onClose={() => setCloudAiModalOpen(false)}
          onSaved={() => setAiCfgTick(t => t + 1)}
        />
      )}
    </div>
  )
}