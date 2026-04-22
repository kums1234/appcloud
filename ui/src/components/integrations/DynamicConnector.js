// Dynamic card + config modal driven by a connector spec from GET /connectors.
// One source of truth — adding a backend connector with a uiMetadata block
// automatically surfaces a card here without UI code changes.

'use client'

import { useEffect, useState } from 'react'
import { getT } from '@/lib/theme'
import { api } from '@/lib/api'

const mono = { fontFamily: 'monospace' }

const BADGE_COLORS = (T) => ({
  Discovery:     { bg: T.teal  + '18', border: T.teal  + '44', text: T.teal   },
  Telemetry:     { bg: '#F5A80018',    border: '#F5A80044',    text: '#F5A800' },
  ITSM:          { bg: T.green + '18', border: T.green + '44', text: T.green  },
  Notifications: { bg: T.purple+ '18', border: T.purple+ '44', text: T.purple },
})

// ── Helpers ─────────────────────────────────────────────────────────────────
function matchesVisibleWhen(cond, form) {
  if (!cond) return true
  for (const [k, expected] of Object.entries(cond)) {
    const actual = form[k]
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false
    } else if (actual !== expected) {
      return false
    }
  }
  return true
}

/**
 * Walk uiMetadata.fields + form values and convert each to the shape the
 * backend's authSchema wants:
 *   · number  inputs arrive as strings → parseInt
 *   · boolean checkboxes are already bool
 *   · arrays declared in authSchema arrive as comma-separated strings from
 *     a `text` UI field → split + trim + filter empty
 *   · invisible fields (visibleWhen unmet) are excluded entirely so stale
 *     values don't leak into the POST
 */
function normaliseForm(spec, form) {
  const out = {}
  const props = spec.authSchema?.properties || {}
  const fields = spec.uiMetadata?.fields || []

  for (const field of fields) {
    if (!matchesVisibleWhen(field.visibleWhen, form)) continue
    const raw = form[field.key]
    if (raw === undefined || raw === '' || raw === null) continue

    const propType = props[field.key]?.type
    if (propType === 'array') {
      out[field.key] = String(raw).split(',').map(s => s.trim()).filter(Boolean)
    } else if (propType === 'integer' || field.type === 'number') {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n)) out[field.key] = n
    } else if (propType === 'boolean' || field.type === 'boolean') {
      out[field.key] = !!raw
    } else {
      out[field.key] = raw
    }
  }
  return out
}

function arrayToText(v) {
  return Array.isArray(v) ? v.join(', ') : (v ?? '')
}

function configToForm(spec, config) {
  const form = {}
  for (const field of spec.uiMetadata?.fields || []) {
    const v = config?.[field.key]
    form[field.key] = v === undefined || v === null
      ? ''
      : Array.isArray(v)
        ? arrayToText(v)
        : String(v)
  }
  return form
}

// ── Card ────────────────────────────────────────────────────────────────────
export function DynamicConnectorCard({ spec, instanceCount, onOpen, T }) {
  const [hover, setHover] = useState(false)
  const meta = spec.uiMetadata || {}
  const color  = meta.color || T.teal
  const second = meta.secondaryColor || color
  const badge  = BADGE_COLORS(T)[meta.badge] || BADGE_COLORS(T).Discovery
  const connected = instanceCount > 0

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      style={{
        background: hover ? `linear-gradient(135deg,${color}0d,${T.surface2})` : T.surface,
        border: `1.5px solid ${connected ? color + '66' : hover ? color + '33' : T.border}`,
        borderRadius: 14, padding: '18px 18px 16px',
        cursor: 'pointer', position: 'relative', overflow: 'hidden',
        transition: 'all .2s',
        boxShadow: connected ? `0 0 28px ${color}18` : hover ? `0 0 20px ${color}10` : 'none',
      }}
    >
      {connected && (
        <div style={{ position:'absolute', top:0, left:0, right:0, height:1,
          background:`linear-gradient(90deg,transparent,${color}77,transparent)` }} />
      )}

      {/* Logo + badge */}
      <div style={{ display:'flex', alignItems:'flex-start',
        justifyContent:'space-between', marginBottom:14 }}>
        <div style={{ width:46, height:46, borderRadius:12,
          background:`linear-gradient(135deg,${color}20,${color}08)`,
          border:`1.5px solid ${color}${connected?'66':'33'}`,
          display:'flex', alignItems:'center', justifyContent:'center',
          boxShadow: connected ? `0 0 16px ${color}33` : 'none',
          flexShrink: 0 }}>
          <span style={{ ...mono, fontSize:11, fontWeight:900, color }}>
            {meta.logo || spec.id.slice(0,3).toUpperCase()}
          </span>
        </div>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:5 }}>
          {meta.badge && (
            <span style={{ ...mono, fontSize:8, fontWeight:700,
              color: badge.text, background: badge.bg, border:`1px solid ${badge.border}`,
              padding:'2px 7px', borderRadius:4, letterSpacing:'0.07em' }}>
              {meta.badge}
            </span>
          )}
          {connected ? (
            <div style={{ display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ width:5, height:5, borderRadius:'50%',
                background:T.green, boxShadow:`0 0 6px ${T.green}` }} />
              <span style={{ ...mono, fontSize:8, color:T.green, fontWeight:700 }}>
                {instanceCount} CONNECTED
              </span>
            </div>
          ) : (
            <span style={{ ...mono, fontSize:8, color:T.muted }}>NOT CONNECTED</span>
          )}
        </div>
      </div>

      <div style={{ ...mono, fontSize:13, fontWeight:800, color:T.text,
        marginBottom:2, letterSpacing:'-0.01em' }}>{spec.displayName}</div>
      {meta.vendor && (
        <div style={{ ...mono, fontSize:9, color:T.muted, marginBottom:8 }}>
          {meta.vendor}
        </div>
      )}

      {meta.tagline && (
        <div style={{ fontSize:11, color:T.dim, lineHeight:1.5,
          marginBottom:12, fontFamily:'monospace' }}>
          {meta.tagline}
        </div>
      )}

      {/* Capability pills */}
      {(meta.capabilities || []).length > 0 && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
          {meta.capabilities.slice(0,4).map(cap => (
            <span key={cap} style={{ ...mono, fontSize:8,
              color: connected ? color : T.muted,
              background: connected ? color + '12' : T.surface2,
              border: `1px solid ${connected ? color + '30' : T.border}`,
              borderRadius:4, padding:'2px 6px' }}>
              {cap}
            </span>
          ))}
          {meta.capabilities.length > 4 && (
            <span style={{ ...mono, fontSize:8, color:T.muted,
              background:T.surface2, border:`1px solid ${T.border}`,
              borderRadius:4, padding:'2px 6px' }}>
              +{meta.capabilities.length - 4} more
            </span>
          )}
        </div>
      )}

      <div style={{ position:'absolute', bottom:14, right:14,
        opacity: hover || connected ? 1 : 0, transition:'opacity .15s' }}>
        <div style={{ ...mono, fontSize:9, fontWeight:700, color,
          padding:'4px 10px', background: color + '15',
          border:`1px solid ${color}44`, borderRadius:6 }}>
          {connected ? 'Manage →' : 'Configure →'}
        </div>
      </div>
    </div>
  )
}

// ── Modal ───────────────────────────────────────────────────────────────────
/**
 * Managing connector-framework instances. Two modes:
 *   · instance list + "Add another"  (when saved instances exist)
 *   · fresh form                     (when adding new or editing one)
 */
export function DynamicConnectorModal({ spec, instances, onClose, onChanged }) {
  const T = getT('dark')
  const [editing, setEditing] = useState(null)  // null | instanceRow | { __new: true }

  const startAdd  = () => setEditing({ __new: true, type: spec.id, name: '', config: {} })
  const startEdit = (row) => setEditing(row)

  // If no saved instances yet, jump straight to the form
  useEffect(() => {
    if (!instances.length && !editing) setEditing({ __new: true, type: spec.id, name: '', config: {} })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const meta = spec.uiMetadata || {}
  const color  = meta.color || T.teal

  // Instance list view
  if (!editing) {
    return (
      <ModalShell spec={spec} color={color} onClose={onClose}>
        <div style={{ padding:'14px 22px' }}>
          {instances.map(inst => (
            <InstanceRow key={inst.id} inst={inst} color={color} T={T}
              onEdit={() => startEdit(inst)}
              onDeleted={() => onChanged()} />
          ))}
          <button onClick={startAdd}
            style={{ ...mono, fontSize:11, fontWeight:700, width:'100%',
              padding:'10px 0', borderRadius:10,
              background: color + '18', border:`1px solid ${color}44`,
              color, cursor:'pointer', marginTop:4 }}>
            + Add Another
          </button>
        </div>
      </ModalShell>
    )
  }

  // Form view (add or edit)
  return (
    <ConnectorForm
      spec={spec}
      existing={editing.__new ? null : editing}
      color={color}
      onClose={() => { setEditing(null); onClose() }}
      onBack={instances.length > 0 ? () => setEditing(null) : null}
      onSaved={() => { onChanged(); setEditing(null); if (!instances.length) onClose() }}
    />
  )
}

// ── Instance row (in the instance-list view) ───────────────────────────────
function InstanceRow({ inst, color, T, onEdit, onDeleted }) {
  const [busy, setBusy] = useState(false)
  const status = inst.last_sync_status
  const dot = status === 'success' ? T.green
            : status === 'error'   ? T.red
            : status === 'running' ? T.amber
            : T.muted

  const handleDelete = async () => {
    if (!window.confirm(`Remove "${inst.name}"?`)) return
    setBusy(true)
    try { await api.integrations.delete(inst.id); onDeleted() }
    catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display:'flex', alignItems:'center', gap:10,
      padding:'10px 14px', borderRadius:10, marginBottom:8,
      background:T.surface2, border:`1px solid ${T.border}` }}>
      <div style={{ width:8, height:8, borderRadius:'50%', background:dot, flexShrink:0 }} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ ...mono, fontSize:12, fontWeight:700, color:T.text }}>{inst.name}</div>
        <div style={{ ...mono, fontSize:9, color:T.muted, marginTop:1 }}>
          {inst.last_sync_at
            ? `Last sync: ${new Date(inst.last_sync_at).toLocaleString()} · ${inst.last_sync_status || 'idle'}`
            : 'Never synced'}
        </div>
      </div>
      <button onClick={onEdit} disabled={busy}
        style={{ ...mono, fontSize:10, padding:'5px 12px', borderRadius:7,
          background: color + '18', border:`1px solid ${color}44`,
          color, cursor:'pointer' }}>Edit</button>
      <button onClick={handleDelete} disabled={busy}
        style={{ ...mono, fontSize:10, padding:'5px 10px', borderRadius:7,
          background:T.red + '12', border:`1px solid ${T.red}33`,
          color:T.red, cursor:'pointer' }}>✕</button>
    </div>
  )
}

// ── Form (add or edit an instance) ─────────────────────────────────────────
function ConnectorForm({ spec, existing, color, onClose, onBack, onSaved }) {
  const T = getT('dark')
  const meta = spec.uiMetadata || {}
  const fields = meta.fields || []
  const isPush = spec.style === 'push'

  // Local state
  const [name, setName] = useState(existing?.name || '')
  const [form, setForm] = useState(() => existing ? configToForm(spec, existing.config) : {
    // Fill select defaults if available
    ...Object.fromEntries(fields
      .filter(f => f.type === 'select' && f.options?.[0])
      .map(f => [f.key, f.options[0]]))
  })
  const [saving,  setSaving]   = useState(false)
  const [saved,   setSaved]    = useState(null) // {id, config}
  const [testing, setTesting]  = useState(false)
  const [testMsg, setTestMsg]  = useState(null)
  const [scanning, setScanning]  = useState(false)
  const [scanMsg,  setScanMsg]   = useState(null)
  const [error,    setError]     = useState(null)

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const integrationId = saved?.id || existing?.id || null
  const canTest = !!integrationId
  const canScan = !!integrationId && !isPush

  const handleSave = async () => {
    setError(null); setSaving(true)
    try {
      const config = normaliseForm(spec, form)
      let row
      if (existing?.id) {
        row = await api.integrations.update(existing.id, { config })
      } else {
        if (!name.trim()) throw new Error('Name is required')
        row = await api.integrations.create({ type: spec.id, name: name.trim(), config })
      }
      setSaved(row)
      // Push-style connectors generate fields server-side (e.g. tokens) —
      // refresh the form to show them.
      if (isPush) setForm(configToForm(spec, row.config))
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true); setTestMsg(null)
    try {
      const res = await api.integrations.test(integrationId)
      setTestMsg(res)
    } catch (e) {
      setTestMsg({ ok: false, detail: e.message })
    } finally { setTesting(false) }
  }

  const handleScan = async () => {
    setScanning(true); setScanMsg(null)
    try {
      const res = await api.integrations.scan(integrationId)
      setScanMsg({ ok: true, ...res })
      onSaved()
    } catch (e) {
      setScanMsg({ ok: false, error: e.message })
    } finally { setScanning(false) }
  }

  return (
    <ModalShell spec={spec} color={color} onClose={onClose}>
      <div className="cfg-scroll" style={{ overflowY:'auto', padding:'18px 22px', flex:1 }}>
        {/* Instance name */}
        {!existing && (
          <div style={{ marginBottom:16, padding:'12px 14px', borderRadius:10,
            background:T.surface2, border:`1px solid ${color}33` }}>
            <div style={{ ...mono, fontSize:8, color, letterSpacing:'0.12em',
              fontWeight:700, marginBottom:6 }}>INSTANCE NAME</div>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. prod-tf-state"
              style={{ width:'100%', background:T.surface, border:`1px solid ${T.border2}`,
                borderRadius:8, padding:'8px 12px', color:T.text, fontSize:12,
                fontFamily:'monospace', outline:'none', boxSizing:'border-box' }} />
            <div style={{ ...mono, fontSize:9, color:T.muted, marginTop:5 }}>
              A unique label for this integration. Add multiple instances by saving with different names.
            </div>
          </div>
        )}

        {/* Fields */}
        {fields.map(field => {
          if (!matchesVisibleWhen(field.visibleWhen, form)) return null
          const val = form[field.key] ?? ''
          return (
            <div key={field.key} style={{ marginBottom:14 }}>
              <div style={{ ...mono, fontSize:8, color:T.muted,
                letterSpacing:'0.12em', fontWeight:700, marginBottom:6 }}>
                {field.label}
                {field.readonly && <span style={{ color:T.amber, marginLeft:6 }}>(read-only)</span>}
              </div>
              <FieldInput field={field} value={val} setValue={v => setField(field.key, v)} T={T} />
              {field.help && (
                <div style={{ ...mono, fontSize:9, color:T.muted, marginTop:4 }}>{field.help}</div>
              )}
            </div>
          )
        })}

        {testMsg && (
          <div style={{ padding:'9px 13px', borderRadius:8, marginTop:4, marginBottom:4,
            background: testMsg.ok ? T.green + '12' : T.red + '12',
            border:`1px solid ${testMsg.ok ? T.green + '44' : T.red + '44'}` }}>
            <span style={{ ...mono, fontSize:11, color: testMsg.ok ? T.green : T.red }}>
              {testMsg.ok ? '✓ ' : '✗ '}{testMsg.detail || (testMsg.ok ? 'OK' : 'Failed')}
            </span>
          </div>
        )}

        {scanMsg && (
          <div style={{ padding:'9px 13px', borderRadius:8, marginBottom:4,
            background: scanMsg.ok ? T.green + '12' : T.red + '12',
            border:`1px solid ${scanMsg.ok ? T.green + '44' : T.red + '44'}` }}>
            {scanMsg.ok ? (
              <div style={{ ...mono, fontSize:11, color:T.green }}>
                ✓ Scan complete · found {scanMsg.resourcesFound ?? 0} ·
                {' '}created {scanMsg.resourcesCreated ?? 0} ·
                {' '}updated {scanMsg.resourcesUpdated ?? 0}
                {(scanMsg.warnings?.length > 0) && (
                  <div style={{ ...mono, fontSize:9, color:T.amber, marginTop:4 }}>
                    {scanMsg.warnings.slice(0,3).map((w,i) => (
                      <div key={i}>⚠ {w}</div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span style={{ ...mono, fontSize:11, color:T.red }}>✗ {scanMsg.error}</span>
            )}
          </div>
        )}

        {error && (
          <div style={{ padding:'9px 13px', borderRadius:8, marginBottom:4,
            background:T.red + '12', border:`1px solid ${T.red}44` }}>
            <span style={{ ...mono, fontSize:11, color:T.red }}>✗ {error}</span>
          </div>
        )}
      </div>

      {/* Footer buttons */}
      <div style={{ padding:'14px 22px', borderTop:`1px solid ${T.border}`,
        display:'flex', gap:8, flexShrink:0 }}>
        {onBack && (
          <button onClick={onBack}
            style={{ ...mono, fontSize:11, padding:'9px 14px',
              background:T.surface2, border:`1px solid ${T.border2}`,
              borderRadius:8, color:T.dim, cursor:'pointer' }}>
            ← Back
          </button>
        )}
        {canScan && (
          <button onClick={handleScan} disabled={scanning}
            style={{ ...mono, fontSize:11, padding:'9px 14px',
              background:T.teal + '18', border:`1px solid ${T.teal}44`,
              borderRadius:8, color:T.teal, cursor:'pointer',
              opacity: scanning ? .6 : 1 }}>
            {scanning ? 'Scanning…' : '▶ Scan Now'}
          </button>
        )}
        {canTest && (
          <button onClick={handleTest} disabled={testing}
            style={{ ...mono, fontSize:11, padding:'9px 16px',
              background:T.surface2, border:`1px solid ${T.border2}`,
              borderRadius:8, color:T.dim, cursor:'pointer' }}>
            {testing ? 'Testing…' : 'Test'}
          </button>
        )}
        <button onClick={handleSave} disabled={saving}
          style={{ ...mono, fontSize:11, fontWeight:700, padding:'9px 22px',
            background: saved ? T.green : `linear-gradient(135deg,${color},${meta.secondaryColor || color})`,
            border:'none', borderRadius:8, color:'#fff', cursor:'pointer',
            flex:1, boxShadow: saved ? `0 0 20px ${T.green}44` : `0 0 20px ${color}33` }}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : (existing ? 'Update' : 'Save')}
        </button>
      </div>
    </ModalShell>
  )
}

// ── Individual field widgets ───────────────────────────────────────────────
function FieldInput({ field, value, setValue, T }) {
  const common = {
    value,
    onChange: e => setValue(e.target.value),
    readOnly: !!field.readonly,
    style: {
      width:'100%',
      background: field.readonly ? T.surface3 : T.surface2,
      border:`1px solid ${T.border2}`,
      borderRadius:8, padding:'9px 12px',
      color: field.readonly ? T.dim : T.text,
      fontSize:12, fontFamily:'monospace',
      outline:'none', boxSizing:'border-box',
    },
  }

  if (field.type === 'select') {
    return (
      <select {...common} style={{ ...common.style, cursor:'pointer', appearance:'none' }}>
        <option value="">Select…</option>
        {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (field.type === 'textarea') {
    return <textarea {...common} rows={4} placeholder={field.placeholder}
      style={{ ...common.style, resize:'vertical', fontSize:11 }} />
  }
  if (field.type === 'boolean') {
    return (
      <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
        <input type="checkbox" checked={!!value}
          onChange={e => setValue(e.target.checked)}
          style={{ width:16, height:16 }} />
        <span style={{ ...mono, fontSize:11, color:T.dim }}>
          {value ? 'Enabled' : 'Disabled'}
        </span>
      </label>
    )
  }
  if (field.type === 'number') {
    return <input type="number" placeholder={field.placeholder} {...common} />
  }
  if (field.type === 'password') {
    return <input type={field.readonly ? 'text' : 'password'} placeholder={field.placeholder} {...common} />
  }
  return <input type="text" placeholder={field.placeholder} {...common} />
}

// ── Modal chrome ────────────────────────────────────────────────────────────
function ModalShell({ spec, color, onClose, children }) {
  const T = getT('dark')
  const meta = spec.uiMetadata || {}
  return (
    <div style={{ position:'fixed', inset:0, zIndex:60,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <style>{`
        @keyframes mIn { from{opacity:0;transform:translateY(14px) scale(.98)} to{opacity:1;transform:none} }
        .cfg-scroll::-webkit-scrollbar { width:4px }
        .cfg-scroll::-webkit-scrollbar-track { background:transparent }
        .cfg-scroll::-webkit-scrollbar-thumb { background:#1e293b; border-radius:2px }
      `}</style>
      <div style={{ position:'absolute', inset:0, background:'#000000cc',
        backdropFilter:'blur(6px)' }} onClick={onClose} />

      <div style={{ position:'relative', background:T.surface,
        border:`1px solid ${color}33`, borderRadius:18,
        width:'100%', maxWidth:560, maxHeight:'90vh',
        display:'flex', flexDirection:'column',
        boxShadow:`0 0 80px ${color}18, 0 30px 80px #00000099`,
        animation:'mIn .22s cubic-bezier(.16,1,.3,1)' }}>

        <div style={{ position:'absolute', top:0, left:'5%', right:'5%', height:1,
          background:`linear-gradient(90deg,transparent,${color}88,transparent)` }} />

        <div style={{ padding:'18px 22px', borderBottom:`1px solid ${T.border}`,
          display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
          <div style={{ width:44, height:44, borderRadius:12,
            background:`linear-gradient(135deg,${color}22,${color}08)`,
            border:`1.5px solid ${color}44`,
            display:'flex', alignItems:'center', justifyContent:'center',
            flexShrink:0 }}>
            <span style={{ ...mono, fontSize:11, fontWeight:900, color }}>
              {meta.logo || spec.id.slice(0,3).toUpperCase()}
            </span>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ ...mono, fontSize:14, fontWeight:800, color:T.text }}>
              {spec.displayName}
            </div>
            <div style={{ ...mono, fontSize:10, color:T.dim, marginTop:2 }}>
              {meta.tagline || ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none',
            color:T.muted, cursor:'pointer', fontSize:22, lineHeight:1 }}>×</button>
        </div>

        {children}
      </div>
    </div>
  )
}
