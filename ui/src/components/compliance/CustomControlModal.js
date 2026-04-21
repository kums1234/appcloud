'use client'

// Modal for creating and editing custom compliance controls using a form
// builder. Users pick a resource type, add conditions (property / operator /
// value) combined with AND or OR, then fill in severity, rating, remediation.
// The server compiles the form rule into safe parameterised Cypher — no raw
// query is ever accepted from the UI.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { api } from '@/lib/api'
import { useTheme, getT } from '@/lib/theme'

const mono = { fontFamily: 'monospace' }

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

// Operators that take no value (just property)
const UNARY_OPS = new Set(['IS_NULL', 'IS_NOT_NULL'])
// Operators that take an array value
const ARRAY_OPS = new Set(['IN', 'NOT_IN'])
// Operators that are about relationships, not properties
const RELATIONSHIP_OPS = new Set(['EXISTS_RELATIONSHIP', 'MISSING_RELATIONSHIP'])

function emptyCondition() {
  return { property: '', operator: 'IS_NULL', value: '' }
}

function emptyRemediation() {
  return { summary: '', steps: [], references: [] }
}

function defaultForm() {
  return {
    id: '',
    title: '',
    description: '',
    rationale: '',
    severity: 'MEDIUM',
    rating: 5,
    section: '',
    sectionTitle: '',
    level: 1,
    formRule: {
      resourceType: 'Application',
      combineWith: 'AND',
      conditions: [emptyCondition()],
      evidenceTemplate: '',
    },
    remediation: emptyRemediation(),
  }
}

export function CustomControlModal({
  benchmarks,              // full list from the panel (both builtin + custom)
  initialFrameworkId,      // suggested framework to target (optional)
  editing,                 // optional: existing control shape { id, benchmarkId, ... }
  onClose,
  onSaved,
}) {
  const { theme } = useTheme()
  const T = getT(theme)

  // Accent colour for the modal
  const accent = '#a78bfa'

  // Framework selection: either pick an existing custom framework or inline-create a new one
  const customFrameworks = useMemo(
    () => (benchmarks || []).filter(fw => fw.source === 'custom' || fw.source === 'imported'),
    [benchmarks]
  )
  const [mode, setMode] = useState(editing ? 'existing' : (customFrameworks.length ? 'existing' : 'new'))
  const [selectedFw, setSelectedFw] = useState(
    editing?.benchmarkId || initialFrameworkId || customFrameworks[0]?.id || ''
  )
  const [newFw, setNewFw] = useState({
    id: '', name: '', version: '1.0', description: '', provider: 'custom',
  })

  const [form, setForm] = useState(() => {
    if (!editing) return defaultForm()
    return {
      id: editing.id || '',
      title: editing.title || '',
      description: editing.description || '',
      rationale: editing.rationale || '',
      severity: editing.severity || 'MEDIUM',
      rating: editing.rating ?? 5,
      section: editing.section || '',
      sectionTitle: editing.sectionTitle || '',
      level: editing.level ?? 1,
      formRule: editing.formRule || {
        resourceType: editing.resourceType || 'Application',
        combineWith: 'AND',
        conditions: [emptyCondition()],
        evidenceTemplate: '',
      },
      remediation: editing.remediation && typeof editing.remediation === 'object'
        ? { summary: editing.remediation.summary || '',
            steps: editing.remediation.steps || [],
            references: editing.remediation.references || [] }
        : emptyRemediation(),
    }
  })

  const [schema, setSchema] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    api.compliance.schema()
      .then(setSchema)
      .catch(err => setError(err.message || 'Failed to load schema'))
  }, [])

  // Derived: which properties are available for the chosen resource type
  const availableProperties = useMemo(() => {
    if (!schema) return []
    const t = form.formRule.resourceType
    return schema.propertiesByType[t] || schema.propertiesByType.Infra || []
  }, [schema, form.formRule.resourceType])

  const setField = (path, value) => {
    setForm(prev => {
      const next = { ...prev }
      const parts = path.split('.')
      let cursor = next
      for (let i = 0; i < parts.length - 1; i++) {
        cursor[parts[i]] = { ...cursor[parts[i]] }
        cursor = cursor[parts[i]]
      }
      cursor[parts[parts.length - 1]] = value
      return next
    })
  }

  const updateCondition = (idx, patch) => {
    setForm(prev => ({
      ...prev,
      formRule: {
        ...prev.formRule,
        conditions: prev.formRule.conditions.map((c, i) => i === idx ? { ...c, ...patch } : c),
      },
    }))
  }

  const addCondition = () => {
    setForm(prev => ({
      ...prev,
      formRule: { ...prev.formRule, conditions: [...prev.formRule.conditions, emptyCondition()] },
    }))
  }

  const removeCondition = (idx) => {
    setForm(prev => ({
      ...prev,
      formRule: {
        ...prev.formRule,
        conditions: prev.formRule.conditions.filter((_, i) => i !== idx),
      },
    }))
  }

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      // Ensure framework exists (inline-create if the user chose "new")
      let fwId = selectedFw
      if (mode === 'new') {
        if (!newFw.id || !newFw.name) {
          setError('Framework id and name are required')
          setSaving(false)
          return
        }
        const created = await api.compliance.createFramework({
          id: newFw.id, name: newFw.name, version: newFw.version,
          description: newFw.description, provider: newFw.provider,
        })
        fwId = created.id
      }
      if (!fwId) {
        setError('Framework is required')
        setSaving(false)
        return
      }
      if (!form.id || !form.title) {
        setError('Control id and title are required')
        setSaving(false)
        return
      }

      // Clean up empty conditions and convert array-op values to arrays
      const cleanConditions = form.formRule.conditions
        .filter(c => c.operator && (UNARY_OPS.has(c.operator)
          || RELATIONSHIP_OPS.has(c.operator) || c.property))
        .map(c => {
          if (UNARY_OPS.has(c.operator)) return { property: c.property, operator: c.operator }
          if (RELATIONSHIP_OPS.has(c.operator)) {
            return {
              operator: c.operator,
              relationship: c.relationship,
              targetLabel: c.targetLabel || undefined,
            }
          }
          if (ARRAY_OPS.has(c.operator)) {
            const arr = String(c.value || '').split(',').map(s => s.trim()).filter(Boolean)
            return { property: c.property, operator: c.operator, value: arr }
          }
          // Attempt to coerce numeric values so operators like > / < work
          let value = c.value
          if (typeof value === 'string' && value !== '' && !isNaN(Number(value))) {
            value = Number(value)
          }
          return { property: c.property, operator: c.operator, value }
        })

      const payload = {
        id: form.id,
        title: form.title,
        description: form.description || null,
        rationale: form.rationale || null,
        severity: form.severity,
        rating: form.rating,
        section: form.section || null,
        sectionTitle: form.sectionTitle || null,
        level: form.level ?? null,
        formRule: { ...form.formRule, conditions: cleanConditions },
        remediation: form.remediation,
      }

      if (editing) {
        await api.compliance.updateControl(fwId, form.id, payload)
      } else {
        await api.compliance.createControl(fwId, payload)
      }
      onSaved?.({ frameworkId: fwId, controlId: form.id })
      onClose()
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [editing, form, mode, newFw, selectedFw, onClose, onSaved])

  const handleDelete = async () => {
    if (!editing) return
    if (!confirm(`Delete control "${editing.title}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.compliance.deleteControl(editing.benchmarkId, editing.id)
      onSaved?.({ deleted: true })
      onClose()
    } catch (err) {
      setError(err.message || 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
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

  const operators = schema?.operators || []

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <style>{`
        @keyframes mIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .cc-scroll::-webkit-scrollbar{width:4px}
        .cc-scroll::-webkit-scrollbar-track{background:transparent}
        .cc-scroll::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
      `}</style>
      <div style={{ position: 'absolute', inset: 0, background: '#000000cc',
        backdropFilter: 'blur(6px)' }} onClick={onClose} />

      <div style={{
        position: 'relative', background: T.surface,
        border: `1px solid ${accent}33`, borderRadius: 16,
        width: '100%', maxWidth: 720, maxHeight: '90vh',
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
            ⚙
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ ...mono, fontSize: 14, fontWeight: 800, color: T.text }}>
              {editing ? 'Edit custom control' : 'New custom control'}
            </div>
            <div style={{ ...mono, fontSize: 10, color: T.dim, marginTop: 2 }}>
              Form builder — server compiles to safe Cypher
            </div>
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: T.muted,
              cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div className="cc-scroll" style={{ overflowY: 'auto', padding: '16px 22px', flex: 1 }}>

          {/* Framework selector */}
          {!editing && (
            <>
              <div style={label}>Framework</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <button onClick={() => setMode('existing')} disabled={!customFrameworks.length}
                  style={{ ...mono, fontSize: 10, padding: '6px 12px', borderRadius: 6,
                    background: mode === 'existing' ? `${accent}22` : T.surface2,
                    border: `1px solid ${mode === 'existing' ? accent + '44' : T.border}`,
                    color: mode === 'existing' ? accent : T.dim,
                    cursor: customFrameworks.length ? 'pointer' : 'not-allowed',
                    fontWeight: 700 }}>
                  Use existing
                </button>
                <button onClick={() => setMode('new')}
                  style={{ ...mono, fontSize: 10, padding: '6px 12px', borderRadius: 6,
                    background: mode === 'new' ? `${accent}22` : T.surface2,
                    border: `1px solid ${mode === 'new' ? accent + '44' : T.border}`,
                    color: mode === 'new' ? accent : T.dim,
                    cursor: 'pointer', fontWeight: 700 }}>
                  + New framework
                </button>
              </div>

              {mode === 'existing' ? (
                <select value={selectedFw} onChange={e => setSelectedFw(e.target.value)}
                  style={{ ...input, marginBottom: 14 }}>
                  {customFrameworks.map(fw => (
                    <option key={fw.id} value={fw.id}>{fw.name} (v{fw.version})</option>
                  ))}
                </select>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                  <input placeholder="id (e.g. internal-v1)" value={newFw.id}
                    onChange={e => setNewFw({ ...newFw, id: e.target.value })} style={input} />
                  <input placeholder="name (e.g. Internal Controls v1)" value={newFw.name}
                    onChange={e => setNewFw({ ...newFw, name: e.target.value })} style={input} />
                  <input placeholder="version" value={newFw.version}
                    onChange={e => setNewFw({ ...newFw, version: e.target.value })} style={input} />
                  <input placeholder="description (optional)" value={newFw.description}
                    onChange={e => setNewFw({ ...newFw, description: e.target.value })} style={input} />
                </div>
              )}
            </>
          )}

          {/* Identity fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginBottom: 12 }}>
            <div>
              <div style={label}>Control ID</div>
              <input placeholder="CUSTOM-001" value={form.id} disabled={!!editing}
                onChange={e => setField('id', e.target.value)}
                style={{ ...input, opacity: editing ? 0.6 : 1 }} />
            </div>
            <div>
              <div style={label}>Title</div>
              <input placeholder="What is being checked?" value={form.title}
                onChange={e => setField('title', e.target.value)} style={input} />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={label}>Description</div>
            <textarea rows={2} placeholder="What does a failure mean?" value={form.description}
              onChange={e => setField('description', e.target.value)}
              style={{ ...input, resize: 'vertical', fontSize: 11 }} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={label}>Rationale (why it matters)</div>
            <textarea rows={2} value={form.rationale}
              onChange={e => setField('rationale', e.target.value)}
              style={{ ...input, resize: 'vertical', fontSize: 11 }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
            <div>
              <div style={label}>Severity</div>
              <select value={form.severity}
                onChange={e => setField('severity', e.target.value)} style={input}>
                {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <div style={label}>Rating (1–10)</div>
              <input type="number" min={1} max={10} value={form.rating}
                onChange={e => setField('rating', Number(e.target.value))} style={input} />
            </div>
            <div>
              <div style={label}>Section (optional)</div>
              <input placeholder="1.2" value={form.section}
                onChange={e => setField('section', e.target.value)} style={input} />
            </div>
          </div>

          {/* Rule builder */}
          <div style={{
            padding: 12, borderRadius: 10, marginBottom: 14,
            background: `${accent}08`, border: `1px solid ${accent}33`,
          }}>
            <div style={{ ...label, color: accent, marginBottom: 8 }}>Rule Builder</div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 10 }}>
              <div>
                <div style={label}>Resource Type</div>
                <select value={form.formRule.resourceType}
                  onChange={e => setField('formRule.resourceType', e.target.value)}
                  style={input}>
                  {(schema?.resourceTypes || ['Application']).map(rt => (
                    <option key={rt} value={rt}>{rt}</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={label}>Combine With</div>
                <select value={form.formRule.combineWith}
                  onChange={e => setField('formRule.combineWith', e.target.value)}
                  style={input}>
                  <option value="AND">All (AND)</option>
                  <option value="OR">Any (OR)</option>
                </select>
              </div>
            </div>

            {/* Conditions */}
            {form.formRule.conditions.map((cond, idx) => {
              const isUnary = UNARY_OPS.has(cond.operator)
              const isRel = RELATIONSHIP_OPS.has(cond.operator)
              return (
                <div key={idx} style={{
                  display: 'grid',
                  gridTemplateColumns: isRel ? '1.3fr 1.3fr 1.3fr 28px' : '1.3fr 1.3fr 1.6fr 28px',
                  gap: 6, marginBottom: 6, alignItems: 'center',
                }}>
                  {isRel ? (
                    <>
                      <input placeholder="REL (e.g. DEPLOYED_ON)"
                        value={cond.relationship || ''}
                        onChange={e => updateCondition(idx, { relationship: e.target.value.toUpperCase() })}
                        style={{ ...input, padding: '6px 8px' }} />
                      <select value={cond.operator}
                        onChange={e => updateCondition(idx, { operator: e.target.value })}
                        style={{ ...input, padding: '6px 8px' }}>
                        {operators.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
                      </select>
                      <input placeholder="target label (optional)"
                        value={cond.targetLabel || ''}
                        onChange={e => updateCondition(idx, { targetLabel: e.target.value })}
                        style={{ ...input, padding: '6px 8px' }} />
                    </>
                  ) : (
                    <>
                      <input list={`props-${idx}`} placeholder="property"
                        value={cond.property || ''}
                        onChange={e => updateCondition(idx, { property: e.target.value })}
                        style={{ ...input, padding: '6px 8px' }} />
                      <datalist id={`props-${idx}`}>
                        {availableProperties.map(p => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </datalist>
                      <select value={cond.operator}
                        onChange={e => updateCondition(idx, { operator: e.target.value })}
                        style={{ ...input, padding: '6px 8px' }}>
                        {operators.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
                      </select>
                      {isUnary ? (
                        <span style={{ ...mono, fontSize: 10, color: T.dim,
                          padding: '6px 8px' }}>— no value —</span>
                      ) : (
                        <input placeholder={ARRAY_OPS.has(cond.operator) ? 'a,b,c' : 'value'}
                          value={cond.value ?? ''}
                          onChange={e => updateCondition(idx, { value: e.target.value })}
                          style={{ ...input, padding: '6px 8px' }} />
                      )}
                    </>
                  )}
                  <button onClick={() => removeCondition(idx)} title="Remove condition"
                    disabled={form.formRule.conditions.length <= 1}
                    style={{
                      background: 'transparent', border: `1px solid ${T.border}`,
                      color: T.dim, borderRadius: 6, cursor: 'pointer',
                      width: 28, height: 28, fontSize: 12,
                      opacity: form.formRule.conditions.length <= 1 ? 0.4 : 1,
                    }}>×</button>
                </div>
              )
            })}
            <button onClick={addCondition}
              style={{ ...mono, fontSize: 10, padding: '5px 12px', borderRadius: 6,
                background: `${accent}15`, border: `1px solid ${accent}44`,
                color: accent, cursor: 'pointer', fontWeight: 700, marginTop: 4 }}>
              + Add condition
            </button>

            <div style={{ marginTop: 12 }}>
              <div style={label}>Evidence text (what to show on violations)</div>
              <input placeholder="e.g. 'Missing owner tag'"
                value={form.formRule.evidenceTemplate || ''}
                onChange={e => setField('formRule.evidenceTemplate', e.target.value)}
                style={input} />
            </div>
          </div>

          {/* Remediation */}
          <div style={{ marginBottom: 10 }}>
            <div style={label}>Remediation summary</div>
            <input placeholder="One-line fix summary"
              value={form.remediation.summary}
              onChange={e => setField('remediation.summary', e.target.value)}
              style={input} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={label}>Remediation steps (one per line)</div>
            <textarea rows={4}
              value={(form.remediation.steps || []).join('\n')}
              onChange={e => setField('remediation.steps',
                e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
              style={{ ...input, resize: 'vertical', fontSize: 11 }} />
          </div>
          <div style={{ marginBottom: 6 }}>
            <div style={label}>References (URLs, one per line)</div>
            <textarea rows={2}
              value={(form.remediation.references || []).join('\n')}
              onChange={e => setField('remediation.references',
                e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
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
          {editing && (
            <button onClick={handleDelete} disabled={deleting}
              style={{ ...mono, fontSize: 11, padding: '9px 14px',
                background: `${T.red}12`, border: `1px solid ${T.red}33`,
                borderRadius: 8, color: T.red, cursor: 'pointer' }}>
              {deleting ? 'Deleting...' : 'Delete'}
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
              background: `linear-gradient(135deg,${accent},#8b5cf6)`,
              border: 'none', borderRadius: 8, color: '#fff',
              cursor: saving ? 'wait' : 'pointer',
              boxShadow: `0 0 20px ${accent}33` }}>
            {saving ? 'Saving...' : (editing ? 'Update' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  )
}
