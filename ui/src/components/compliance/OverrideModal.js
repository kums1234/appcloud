'use client'

// Modal for overriding a built-in compliance control. Lets admins disable
// the control outright or tweak severity / rating / remediation for their
// organisation without editing the shipped JSON files.

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useTheme, getT } from '@/lib/theme'

const mono = { fontFamily: 'monospace' }
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

export function OverrideModal({
  control,        // { id, benchmarkId, title, severity, rating, override }
  frameworkId,
  onClose,
  onSaved,
}) {
  const { theme } = useTheme()
  const T = getT(theme)
  const accent = '#fbbf24' // amber — override

  const existing = control?.override || null

  const [disabled, setDisabled] = useState(existing?.disabled || false)
  const [severity, setSeverity] = useState(existing?.severity || '')
  const [rating, setRating] = useState(existing?.rating ?? '')
  const [overrideRemediation, setOverrideRemediation] = useState(
    Boolean(existing?.remediation)
  )
  const [remediation, setRemediation] = useState(() => {
    const r = existing?.remediation || {}
    return {
      summary: r.summary || '',
      steps: (r.steps || []).join('\n'),
      references: (r.references || []).join('\n'),
    }
  })
  const [note, setNote] = useState(existing?.note || '')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState(null)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const payload = {
        disabled: Boolean(disabled),
        severity: severity || null,
        rating: rating === '' ? null : Number(rating),
        note: note || null,
      }
      if (overrideRemediation) {
        payload.remediation = {
          summary: remediation.summary || null,
          steps: remediation.steps
            ? remediation.steps.split('\n').map(s => s.trim()).filter(Boolean)
            : [],
          references: remediation.references
            ? remediation.references.split('\n').map(s => s.trim()).filter(Boolean)
            : [],
        }
      }
      await api.compliance.setOverride(frameworkId, control.id, payload)
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    if (!existing) { onClose(); return }
    if (!confirm('Clear the override? The control reverts to its built-in definition.')) return
    setClearing(true)
    try {
      await api.compliance.clearOverride(frameworkId, control.id)
      onSaved?.()
      onClose()
    } catch (err) {
      setError(err.message || 'Clear failed')
    } finally {
      setClearing(false)
    }
  }

  const input = {
    background: T.surface2, border: `1px solid ${T.border2}`,
    borderRadius: 7, padding: '8px 11px', color: T.text,
    fontSize: 12, fontFamily: 'monospace', outline: 'none',
    boxSizing: 'border-box', width: '100%',
  }
  const label = {
    ...mono, fontSize: 8, fontWeight: 700, color: T.muted,
    letterSpacing: '0.12em', marginBottom: 5, textTransform: 'uppercase',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <style>{`
        @keyframes mIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
        .ov-scroll::-webkit-scrollbar{width:4px}
        .ov-scroll::-webkit-scrollbar-track{background:transparent}
        .ov-scroll::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
      `}</style>
      <div style={{ position: 'absolute', inset: 0, background: '#000000cc',
        backdropFilter: 'blur(6px)' }} onClick={onClose} />

      <div style={{
        position: 'relative', background: T.surface,
        border: `1px solid ${accent}33`, borderRadius: 16,
        width: '100%', maxWidth: 540, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: `0 0 60px ${accent}18, 0 30px 80px #00000099`,
        animation: 'mIn .22s cubic-bezier(.16,1,.3,1)',
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10,
            background: `linear-gradient(135deg,${accent}22,${accent}08)`,
            border: `1.5px solid ${accent}44`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, color: accent }}>
            ⚑
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ ...mono, fontSize: 14, fontWeight: 800, color: T.text }}>
              Override control
            </div>
            <div style={{ ...mono, fontSize: 10, color: T.dim, marginTop: 2 }}>
              {control.id} — {control.title}
            </div>
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.muted,
              cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div className="ov-scroll" style={{ overflowY: 'auto', padding: '16px 22px', flex: 1 }}>

          <div style={{
            padding: '10px 12px', borderRadius: 8, marginBottom: 16,
            background: `${accent}10`, border: `1px solid ${accent}33`,
            ...mono, fontSize: 10, color: T.dim, lineHeight: 1.5,
          }}>
            Null fields inherit from the built-in definition. Overrides survive
            "Re-sync built-ins" runs — they're never overwritten by the seeder.
          </div>

          {/* Disabled toggle */}
          <label style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: 10, borderRadius: 8, marginBottom: 14,
            background: disabled ? `${T.red}12` : T.surface2,
            border: `1px solid ${disabled ? T.red + '44' : T.border}`,
            cursor: 'pointer',
          }}>
            <input type="checkbox" checked={disabled}
              onChange={e => setDisabled(e.target.checked)}
              style={{ margin: 0, cursor: 'pointer', accentColor: T.red }} />
            <div style={{ flex: 1 }}>
              <div style={{ ...mono, fontSize: 11, fontWeight: 700,
                color: disabled ? T.red : T.text }}>
                Disable this control
              </div>
              <div style={{ ...mono, fontSize: 9, color: T.dim, marginTop: 2 }}>
                Skips evaluation and hides failing resources for this control.
              </div>
            </div>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            <div>
              <div style={label}>Severity (optional)</div>
              <select value={severity} onChange={e => setSeverity(e.target.value)} style={input}>
                <option value="">— inherit ({control.severity}) —</option>
                {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <div style={label}>Rating (optional)</div>
              <input type="number" min={1} max={10}
                placeholder={`inherit (${control.rating ?? '—'})`}
                value={rating} onChange={e => setRating(e.target.value)} style={input} />
            </div>
          </div>

          {/* Remediation override toggle */}
          <label style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={overrideRemediation}
              onChange={e => setOverrideRemediation(e.target.checked)}
              style={{ margin: 0, cursor: 'pointer', accentColor: accent }} />
            <span style={{ ...mono, fontSize: 11, color: T.text, fontWeight: 600 }}>
              Override remediation text
            </span>
          </label>

          {overrideRemediation && (
            <div style={{ padding: 10, borderRadius: 8,
              background: `${accent}08`, border: `1px solid ${accent}33`,
              marginBottom: 14 }}>
              <div style={{ marginBottom: 10 }}>
                <div style={label}>Summary</div>
                <input value={remediation.summary}
                  onChange={e => setRemediation({ ...remediation, summary: e.target.value })}
                  style={input} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={label}>Steps (one per line)</div>
                <textarea rows={4} value={remediation.steps}
                  onChange={e => setRemediation({ ...remediation, steps: e.target.value })}
                  style={{ ...input, resize: 'vertical', fontSize: 11 }} />
              </div>
              <div>
                <div style={label}>References (one per line)</div>
                <textarea rows={2} value={remediation.references}
                  onChange={e => setRemediation({ ...remediation, references: e.target.value })}
                  style={{ ...input, resize: 'vertical', fontSize: 11 }} />
              </div>
            </div>
          )}

          <div style={{ marginBottom: 4 }}>
            <div style={label}>Note (why this override exists)</div>
            <textarea rows={2} value={note}
              onChange={e => setNote(e.target.value)}
              style={{ ...input, resize: 'vertical', fontSize: 11 }} />
          </div>

          {error && (
            <div style={{
              padding: '9px 12px', borderRadius: 7, marginTop: 10,
              background: `${T.red}12`, border: `1px solid ${T.red}44`,
              ...mono, fontSize: 11, color: T.red,
            }}>
              ✗ {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 22px', borderTop: `1px solid ${T.border}`,
          display: 'flex', gap: 8, flexShrink: 0 }}>
          {existing && (
            <button onClick={handleClear} disabled={clearing}
              style={{ ...mono, fontSize: 11, padding: '9px 14px',
                background: `${T.red}12`, border: `1px solid ${T.red}33`,
                borderRadius: 8, color: T.red, cursor: 'pointer' }}>
              {clearing ? 'Clearing...' : 'Clear override'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose}
            style={{ ...mono, fontSize: 11, padding: '9px 14px',
              background: T.surface2, border: `1px solid ${T.border}`,
              borderRadius: 8, color: T.dim, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ ...mono, fontSize: 11, fontWeight: 700, padding: '9px 22px',
              background: `linear-gradient(135deg,${accent},#f59e0b)`,
              border: 'none', borderRadius: 8, color: '#000',
              cursor: saving ? 'wait' : 'pointer',
              boxShadow: `0 0 20px ${accent}33` }}>
            {saving ? 'Saving...' : (existing ? 'Update override' : 'Save override')}
          </button>
        </div>
      </div>
    </div>
  )
}
