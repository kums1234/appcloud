'use client'
import { useEffect, useState, useCallback } from 'react'
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  MarkerType, Panel,
  getBezierPath, EdgeLabelRenderer, BaseEdge,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '@/lib/api'

// ─── Colour palette ───────────────────────────────────────────────────────────
const C = {
  app:    { bg: '#0d1f0d', border: '#22c55e', glow: '#22c55e', text: '#22c55e', label: 'Application' },
  API:    { bg: '#0d1826', border: '#38bdf8', glow: '#38bdf8', text: '#38bdf8', label: 'API' },
  DB:     { bg: '#1a1208', border: '#f59e0b', glow: '#f59e0b', text: '#f59e0b', label: 'Database' },
  Worker: { bg: '#130d1f', border: '#a78bfa', glow: '#a78bfa', text: '#a78bfa', label: 'Worker' },
  UI:     { bg: '#1a0d12', border: '#f43f5e', glow: '#f43f5e', text: '#f43f5e', label: 'UI' },
  infra:  { bg: '#111827', border: '#6b7280', glow: '#6b7280', text: '#9ca3af', label: 'Infra' },
}
const EDGE_COLORS = {
  contains:   '#22c55e',  // app → component (ownership)
  connects:   '#38bdf8',  // component → component (same app)
  crossApp:   '#a78bfa',  // component → component (cross-app)
  deploys:    '#6b7280',  // component → infra
}

function getC(nodeType, subtype) {
  if (nodeType === 'Application') return C.app
  if (nodeType === 'Component') return C[subtype] || C.API
  return C.infra
}

// ─── Custom node ──────────────────────────────────────────────────────────────
function InfraNode({ data, selected }) {
  const c = getC(data.nodeType, data.subtype)
  return (
    <div style={{
      background: c.bg,
      border: `1.5px solid ${selected ? c.glow : c.border + '99'}`,
      boxShadow: selected
        ? `0 0 0 2px ${c.glow}44, 0 0 24px ${c.glow}55, inset 0 0 12px ${c.glow}11`
        : `0 0 12px ${c.glow}22`,
      borderRadius: 12, padding: '10px 16px', minWidth: 150,
      transition: 'all 0.2s', cursor: 'pointer', position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${c.glow}66,transparent)` }} />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: c.glow + '18', border: `1px solid ${c.glow}33`, borderRadius: 4, padding: '1px 7px', marginBottom: 6 }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: c.glow, boxShadow: `0 0 6px ${c.glow}` }} />
        <span style={{ fontSize: 9, fontFamily: 'monospace', color: c.text, letterSpacing: '0.08em', fontWeight: 600 }}>{c.label.toUpperCase()}</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#f1f5f9', fontFamily: 'monospace' }}>{data.label}</div>
      {data.meta && <div style={{ fontSize: 10, color: '#64748b', marginTop: 3, fontFamily: 'monospace' }}>{data.meta}</div>}
    </div>
  )
}

// ─── Animated edge ────────────────────────────────────────────────────────────
function AnimatedEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const color = data?.color || '#334155'
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{
        stroke: selected ? color : color + '77',
        strokeWidth: selected ? 2 : 1.5,
        strokeDasharray: data?.dashed ? '5 3' : undefined,
        filter: selected ? `drop-shadow(0 0 5px ${color})` : 'none',
        transition: 'all 0.2s',
      }} />
      {data?.animated && (
        <circle r="3" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
          <animateMotion dur={data?.dur || '2s'} repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div style={{
            position: 'absolute',
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            fontSize: 9, fontFamily: 'monospace',
            background: '#0f172a', border: `1px solid ${color}44`,
            color: color, padding: '1px 5px', borderRadius: 3,
            pointerEvents: 'none', letterSpacing: '0.05em',
          }}>{data.label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { infra: InfraNode }
const edgeTypes = { animated: AnimatedEdge }

// ─── Layout ───────────────────────────────────────────────────────────────────
// connections: [{ fromId, fromApp, toId, toApp, protocol }]
// deployments: [{ compId, infraId }]
function buildGraph(apps, components, infraList, connections, deployments) {
  const nodes = []
  const edges = []

  const infraMap = Object.fromEntries(infraList.map(i => [i.id, i]))

  // Group components by applicationId first, fall back to application name.
  // Using ID is more reliable than name matching.
  const compsByAppId = {}
  const compsByAppName = {}
  components.forEach(c => {
    if (c.applicationId) {
      if (!compsByAppId[c.applicationId]) compsByAppId[c.applicationId] = []
      compsByAppId[c.applicationId].push(c)
    }
    const nameKey = c.application || '__none__'
    if (!compsByAppName[nameKey]) compsByAppName[nameKey] = []
    compsByAppName[nameKey].push(c)
  })

  const appGap = 300
  const compGap = 200
  let cursorX = 0

  apps.forEach((app) => {
    // Prefer ID-based grouping; fall back to name-based
    const appComps = compsByAppId[app.id] || compsByAppName[app.name] || []
    const totalWidth = Math.max(appComps.length - 1, 0) * compGap
    const appX = cursorX + totalWidth / 2

    // ── Application node ─────────────────────────────────────
    nodes.push({
      id: `app-${app.id}`, type: 'infra',
      position: { x: appX, y: 0 },
      data: { label: app.name, nodeType: 'Application', meta: `tier ${app.tier} · ${app.environment}` },
    })

    // ── Component nodes + App→Component CONTAINS edges ───────
    appComps.forEach((c, ci) => {
      const compId = `comp-${c.id}`
      nodes.push({
        id: compId, type: 'infra',
        position: { x: cursorX + ci * compGap, y: 220 },
        data: { label: c.name, nodeType: 'Component', subtype: c.type, meta: c.runtime },
      })
      edges.push({
        id: `e-contains-${c.id}`,
        source: `app-${app.id}`, target: compId, type: 'animated',
        data: { color: EDGE_COLORS.contains, label: 'CONTAINS' },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.contains, width: 10, height: 10 },
      })
    })

    cursorX += totalWidth + appGap
  })

  // ── Infra nodes (only those with at least one deployment) ─
  const addedInfra = new Set()
  deployments.forEach((d, di) => {
    const infra = infraMap[d.infraId]
    if (!infra) return
    if (!addedInfra.has(d.infraId)) {
      addedInfra.add(d.infraId)
      nodes.push({
        id: `infra-${d.infraId}`, type: 'infra',
        position: { x: di * 230, y: 460 },
        data: { label: infra.name, nodeType: 'Infra', meta: `${infra.provider} · ${infra.region} · ${infra.resource_type}` },
      })
    }
    // ── Component DEPLOYED_ON Infra edge ───────────────────
    edges.push({
      id: `e-deploy-${d.compId}-${d.infraId}`,
      source: `comp-${d.compId}`, target: `infra-${d.infraId}`, type: 'animated',
      data: { color: EDGE_COLORS.deploys, label: 'DEPLOYED_ON', dashed: true },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.deploys, width: 8, height: 8 },
    })
  })

  // ── Component CONNECTS_TO Component edges (all, same-app + cross) ─
  connections.forEach((conn, i) => {
    const sameApp = conn.fromApp && conn.toApp && conn.fromApp === conn.toApp
    const color = sameApp ? EDGE_COLORS.connects : EDGE_COLORS.crossApp
    edges.push({
      id: `e-conn-${i}`,
      source: `comp-${conn.fromId}`, target: `comp-${conn.toId}`, type: 'animated',
      data: { color, label: conn.protocol || 'HTTPS', animated: true, dur: sameApp ? '1.4s' : '2.2s' },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
    })
  })

  return { nodes, edges }
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function Legend() {
  const nodeItems = [
    { color: C.app.border,    label: 'Application' },
    { color: C.API.border,    label: 'API Component' },
    { color: C.DB.border,     label: 'DB Component' },
    { color: C.Worker.border, label: 'Worker Component' },
    { color: C.UI.border,     label: 'UI Component' },
    { color: C.infra.border,  label: 'Infrastructure' },
  ]
  const edgeItems = [
    { color: EDGE_COLORS.contains,  label: 'App → Component',      solid: true },
    { color: EDGE_COLORS.connects,  label: 'Internal connection',   dashed: false, animated: true },
    { color: EDGE_COLORS.crossApp,  label: 'Cross-app connection',  dashed: false, animated: true },
    { color: EDGE_COLORS.deploys,   label: 'Deployed on infra',     dashed: true },
  ]
  return (
    <div style={{ background: '#080f1a', border: '1px solid #1e293b', borderRadius: 12, padding: '12px 14px', minWidth: 180 }}>
      <div style={{ fontSize: 9, color: '#334155', fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: 10 }}>LEGEND</div>
      <div style={{ fontSize: 9, color: '#334155', fontFamily: 'monospace', letterSpacing: '0.08em', marginBottom: 6 }}>NODES</div>
      {nodeItems.map((n, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: n.color + '22', border: `1.5px solid ${n.color}`, boxShadow: `0 0 5px ${n.color}44` }} />
          <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>{n.label}</span>
        </div>
      ))}
      <div style={{ fontSize: 9, color: '#334155', fontFamily: 'monospace', letterSpacing: '0.08em', marginBottom: 6, marginTop: 10 }}>EDGES</div>
      {edgeItems.map((e, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <div style={{ width: 22, height: 0, borderTop: `${e.dashed ? '1.5px dashed' : '2px solid'} ${e.color}`, boxShadow: e.animated ? `0 0 4px ${e.color}` : 'none' }} />
          <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>{e.label}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
function StatsBar({ counts }) {
  return (
    <div style={{ display: 'flex', gap: 1 }}>
      {counts.map((s, i) => (
        <div key={i} style={{
          padding: '5px 14px', background: '#080f1a', border: '1px solid #1e293b',
          borderLeft: i > 0 ? 'none' : undefined,
          borderRadius: i === 0 ? '8px 0 0 8px' : i === counts.length - 1 ? '0 8px 8px 0' : 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9', fontFamily: 'monospace' }}>{s.value}</span>
          <span style={{ fontSize: 8, color: '#334155', fontFamily: 'monospace', letterSpacing: '0.1em' }}>{s.label}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar({ active, onChange }) {
  const filters = [
    { key: 'all',          label: 'All' },
    { key: 'Application',  label: 'Apps' },
    { key: 'Component',    label: 'Components' },
    { key: 'Infra',        label: 'Infra' },
  ]
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {filters.map(f => (
        <button key={f.key} onClick={() => onChange(f.key)} style={{
          padding: '5px 14px', borderRadius: 6, border: `1px solid ${active === f.key ? '#22c55e' : '#1e293b'}`,
          background: active === f.key ? '#22c55e18' : '#0f172a',
          color: active === f.key ? '#22c55e' : '#475569',
          fontSize: 11, fontFamily: 'monospace', fontWeight: 600, cursor: 'pointer', letterSpacing: '0.05em', transition: 'all .15s',
        }}>{f.label}</button>
      ))}
    </div>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function DetailPanel({ node, onClose }) {
  if (!node) return null
  const c = getC(node.data.nodeType, node.data.subtype)
  return (
    <div style={{ position: 'absolute', right: 16, top: 80, width: 260, zIndex: 10, background: '#080f1a', border: `1px solid ${c.border}44`, borderRadius: 14, overflow: 'hidden', boxShadow: `0 0 40px ${c.glow}22, 0 20px 60px #00000088` }}>
      <style>{`@keyframes slideIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}`}</style>
      <div style={{ animation: 'slideIn .2s ease' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg,transparent,${c.glow}66,transparent)` }} />
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${c.border}22`, background: `linear-gradient(135deg,${c.bg},transparent)`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 9, fontFamily: 'monospace', color: c.text, letterSpacing: '0.1em', fontWeight: 700, marginBottom: 4 }}>{c.label.toUpperCase()}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', fontFamily: 'monospace' }}>{node.data.label}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {node.data.meta && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: '#334155', fontFamily: 'monospace', marginBottom: 4 }}>DETAILS</div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>{node.data.meta}</div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: c.glow + '10', border: `1px solid ${c.glow}22`, borderRadius: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: c.glow, boxShadow: `0 0 8px ${c.glow}` }} />
            <span style={{ fontSize: 10, color: c.text, fontFamily: 'monospace' }}>Node active</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function GraphPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [allNodes, setAllNodes] = useState([])
  const [allEdges, setAllEdges] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('all')
  const [counts, setCounts] = useState({ apps: 0, comps: 0, infra: 0, edges: 0 })

  const loadGraph = () => {
    setLoading(true)
    Promise.all([
      api.applications.list(),
      api.components.list(),
      api.infra.list(),
      api.graph.allConnections(),
    ]).then(([apps, components, infraList, connData]) => {
      console.debug('[graph] apps:', apps.length, 'components:', components.length,
        'connections:', connData.connections?.length, 'deployments:', connData.deployments?.length)
      console.debug('[graph] sample component:', components[0])
      const connections = connData?.connections || []
      const deployments = connData?.deployments || []
      const { nodes: n, edges: e } = buildGraph(apps, components, infraList, connections, deployments)
      console.debug('[graph] built nodes:', n.length, 'edges:', e.length)
      setAllNodes(n)
      setAllEdges(e)
      setNodes(n)
      setEdges(e)
      setCounts({ apps: apps.length, comps: components.length, infra: infraList.length, edges: e.length })
    }).catch(err => {
      console.error('[graph] load failed:', err)
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    loadGraph()
    const onVisible = () => { if (document.visibilityState === 'visible') loadGraph() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  useEffect(() => {
    if (filter === 'all') { setNodes(allNodes); return }
    setNodes(allNodes.filter(n => n.data.nodeType === filter))
  }, [filter, allNodes])

  const onNodeClick = useCallback((_, node) => setSelected(node), [])
  const onPaneClick = useCallback(() => setSelected(null), [])

  return (
    <div style={{ width: '100%', height: '100vh', background: 'radial-gradient(ellipse at 20% 50%, #0a1628 0%, #050d1a 50%, #020810 100%)', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', position: 'relative' }}>

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid #0f1f35', background: '#04080f', zIndex: 5, gap: 16, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 12px #22c55e', animation: 'pulse 2s infinite' }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>Infrastructure Graph</span>
          <span style={{ fontSize: 10, color: '#1e3a5f' }}>·</span>
          <span style={{ fontSize: 10, color: '#334155', letterSpacing: '0.05em' }}>LIVE TOPOLOGY</span>
        </div>
        <StatsBar counts={[
          { label: 'APPS',       value: counts.apps },
          { label: 'COMPONENTS', value: counts.comps },
          { label: 'INFRA',      value: counts.infra },
          { label: 'EDGES',      value: counts.edges },
        ]} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <FilterBar active={filter} onChange={setFilter} />
          <button onClick={loadGraph} title="Refresh graph" style={{ padding: '5px 12px', background: '#0f1f35', border: '1px solid #1e293b', borderRadius: 6, color: '#334155', fontSize: 12, cursor: 'pointer' }}>↺</button>
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        {loading ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            <div style={{ width: 40, height: 40, borderRadius: '50%', border: '2px solid #1e293b', borderTop: '2px solid #22c55e', animation: 'spin .8s linear infinite' }} />
            <span style={{ fontSize: 11, color: '#334155', letterSpacing: '0.1em' }}>LOADING GRAPH…</span>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.1}
            maxZoom={3}
            style={{ background: 'transparent' }}
          >
            <Background variant="dots" gap={28} size={1} color="#0d1f35" />
            <Controls style={{ background: '#080f1a', border: '1px solid #1e293b', borderRadius: 10 }} />
            <MiniMap
              style={{ background: '#04080f', border: '1px solid #1e293b', borderRadius: 10 }}
              nodeColor={n => getC(n.data?.nodeType, n.data?.subtype)?.border || '#334155'}
              maskColor="#020810cc"
            />
            <Panel position="top-right" style={{ marginTop: 8 }}>
              <Legend />
            </Panel>
          </ReactFlow>
        )}
        <DetailPanel node={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  )
}