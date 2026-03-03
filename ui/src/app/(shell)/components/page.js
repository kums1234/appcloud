'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const mono = { fontFamily: 'monospace' }

function Spinner() {
  return (
    <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: '2px solid #0f172a', borderTop: '2px solid #22c55e', animation: 'spin .8s linear infinite' }} />
    </div>
  )
}

export default function ComponentsPage() {
  const [components, setComponents] = useState([])
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'API', runtime: '', applicationId: '' })

  const load = async () => {
    setLoading(true)
    try {
      const [comps, appsList] = await Promise.all([api.components.list(), api.applications.list()])
      setComponents(comps)
      setApps(appsList)
    } catch (err) {
      console.error(err)
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const create = async () => {
    await api.components.create(form)
    setShowCreate(false)
    setForm({ name: '', type: 'API', runtime: '', applicationId: '' })
    load()
  }

  return (
    <div style={{ padding: 18, fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Components</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>List of registered components</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '6px 12px', borderRadius: 6 }}>Refresh</button>
          <button onClick={() => setShowCreate(true)} style={{ padding: '6px 12px', borderRadius: 6, background: '#22c55e', border: 'none', color: '#000' }}>Create</button>
        </div>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {components.length === 0 && <div style={{ color: '#64748b' }}>No components found.</div>}
          {components.map(c => (
            <div key={c.id} style={{ padding: 12, borderRadius: 8, background: '#071026', border: '1px solid #0f172a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.type} · {c.runtime || '—'} {c.application ? `· ${c.application}` : ''}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => navigator.clipboard?.writeText(c.id)} style={{ padding: '6px 10px', borderRadius: 6 }}>Copy ID</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
          <div style={{ position: 'absolute', inset: 0, background: '#000000aa' }} onClick={() => setShowCreate(false)} />
          <div style={{ position: 'relative', width: 520, background: '#071026', border: '1px solid #0f172a', borderRadius: 12, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Create Component</div>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 20 }}>×</button>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <input placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ padding: 10, borderRadius: 8, border: '1px solid #0f172a' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={{ padding: 10, borderRadius: 8, border: '1px solid #0f172a', flex: 1 }}>
                  <option>API</option>
                  <option>DB</option>
                  <option>Worker</option>
                  <option>UI</option>
                </select>
                <input placeholder="Runtime" value={form.runtime} onChange={e => setForm(f => ({ ...f, runtime: e.target.value }))} style={{ padding: 10, borderRadius: 8, border: '1px solid #0f172a', width: 180 }} />
              </div>
              <select value={form.applicationId} onChange={e => setForm(f => ({ ...f, applicationId: e.target.value }))} style={{ padding: 10, borderRadius: 8, border: '1px solid #0f172a' }}>
                <option value="">— no application —</option>
                {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setShowCreate(false)} style={{ padding: '8px 12px', borderRadius: 8 }}>Cancel</button>
                <button onClick={create} style={{ padding: '8px 12px', borderRadius: 8, background: '#22c55e', border: 'none', color: '#000' }}>Create</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}