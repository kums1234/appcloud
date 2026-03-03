'use client'
import { useEffect, useState, useCallback } from 'react'
import ReactFlow, {
  Background, Controls, Panel,
  useNodesState, useEdgesState,
  MarkerType, Position,
  getBezierPath, EdgeLabelRenderer, BaseEdge,
  Handle,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '@/lib/api'

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  Application: { bg: '#061a0a', border: '#22c55e', glow: '#22c55e', text: '#22c55e' },
  API:         { bg: '#061018', border: '#38bdf8', glow: '#38bdf8', text: '#38bdf8' },
  DB:          { bg: '#180e02', border: '#f59e0b', glow: '#f59e0b', text: '#f59e0b' },
  Worker:      { bg: '#0e0618', border: '#a78bfa', glow: '#a78bfa', text: '#a78bfa' },
  UI:          { bg: '#180608', border: '#f43f5e', glow: '#f43f5e', text: '#f43f5e' },
  Infra:       { bg: '#0c111a', border: '#6b7280', glow: '#6b7280', text: '#9ca3af' },
}
const EC = {
  sameApp:  '#38bdf8',
  crossApp: '#a78bfa',
  deploys:  '#475569',
}
function nColor(nodeType, subtype) {
  if (nodeType === 'Application') return C.Application
  if (nodeType === 'Component')   return C[subtype] || C.API
  return C.Infra
}

// ── Application bubble node (group/parent) ────────────────────────────────────
function AppGroupNode({ data, selected }) {
  const c = C.Application
  return (
    <div style={{
      width: '100%', height: '100%',
      background: `radial-gradient(ellipse at 50% 0%, ${c.glow}0a 0%, #020810 70%)`,
      border: `1.5px solid ${selected ? c.glow : c.border + '66'}`,
      boxShadow: selected
        ? `0 0 0 3px ${c.glow}22, 0 0 50px ${c.glow}22, inset 0 0 60px ${c.glow}06`
        : `0 0 30px ${c.glow}12, inset 0 0 40px ${c.glow}04`,
      borderRadius: 20,
      position: 'relative',
      pointerEvents: 'none',   // let clicks fall through to children
    }}>
      {/* Top shimmer */}
      <div style={{ position: 'absolute', top: 0, left: '10%', right: '10%', height: 1,
        background: `linear-gradient(90deg,transparent,${c.glow}88,transparent)` }} />
      {/* App label — top-left corner */}
      <div style={{
        position: 'absolute', top: 14, left: 18,
        display: 'flex', alignItems: 'center', gap: 7, pointerEvents: 'auto',
      }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%',
          background: c.glow, boxShadow: `0 0 8px ${c.glow}` }} />
        <span style={{ fontSize: 11, fontWeight: 800, color: c.text,
          fontFamily: 'monospace', letterSpacing: '0.04em' }}>{data.label}</span>
        <span style={{ fontSize: 9, color: '#334155', fontFamily: 'monospace',
          marginLeft: 4 }}>{data.meta}</span>
      </div>
      {/* Invisible handles so cross-app edges can attach to the group */}
      <Handle type="source" position={Position.Right}
        style={{ opacity: 0, pointerEvents: 'none', right: -4 }} />
      <Handle type="target" position={Position.Left}
        style={{ opacity: 0, pointerEvents: 'none', left: -4 }} />
    </div>
  )
}

// ── Component node (child inside group) ───────────────────────────────────────
const hs = { background: 'transparent', border: 'none', width: 6, height: 6 }
function CompNode({ data, selected }) {
  const c = nColor(data.nodeType, data.subtype)
  return (
    <div style={{
      background: `linear-gradient(135deg,${c.bg},#020810cc)`,
      border: `1.5px solid ${selected ? c.glow : c.border + 'cc'}`,
      boxShadow: selected
        ? `0 0 0 2px ${c.glow}44, 0 0 20px ${c.glow}55`
        : `0 0 12px ${c.glow}22`,
      borderRadius: 11, padding: '9px 14px', minWidth: 148,
      cursor: 'pointer', position: 'relative', overflow: 'visible',
      transition: 'border-color .2s, box-shadow .2s',
    }}>
      <Handle type="target" position={Position.Left}   style={hs} />
      <Handle type="source" position={Position.Right}  style={hs} />
      <Handle type="target" position={Position.Top}    style={{ ...hs, left: '50%' }} />
      <Handle type="source" position={Position.Bottom} style={{ ...hs, left: '50%' }} />

      <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
        background:`linear-gradient(90deg,transparent,${c.glow}88,transparent)` }} />
      <div style={{ display:'inline-flex',alignItems:'center',gap:5,
        background:c.glow+'18',border:`1px solid ${c.glow}33`,
        borderRadius:4,padding:'2px 6px',marginBottom:5 }}>
        <div style={{ width:4,height:4,borderRadius:'50%',
          background:c.glow,boxShadow:`0 0 5px ${c.glow}` }} />
        <span style={{ fontSize:8,fontFamily:'monospace',color:c.text,
          letterSpacing:'0.1em',fontWeight:700 }}>
          {(data.subtype || 'COMPONENT').toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize:12,fontWeight:700,color:'#f1f5f9',
        fontFamily:'monospace',lineHeight:1.3 }}>{data.label}</div>
      {data.meta && <div style={{ fontSize:9,color:'#475569',marginTop:3,
        fontFamily:'monospace' }}>{data.meta}</div>}

      {/* Infra deployment badges */}
      {data.infra && data.infra.length > 0 && (
        <div style={{ marginTop:8, borderTop:`1px solid ${c.glow}18`, paddingTop:6,
          display:'flex', flexWrap:'wrap', gap:4 }}>
          {data.infra.map((inf, i) => {
            const provColor = { aws:'#f59e0b', azure:'#38bdf8', gcp:'#22c55e', onprem:'#a78bfa' }[inf.provider] || '#6b7280'
            return (
              <div key={i} title={`${inf.name} · ${inf.region || ''} · ${inf.resourceType || ''}`}
                style={{
                  display:'inline-flex', alignItems:'center', gap:4,
                  background: provColor + '12',
                  border:`1px solid ${provColor}33`,
                  borderRadius:4, padding:'2px 6px',
                }}>
                <div style={{ width:4,height:4,borderRadius:'50%',
                  background:provColor, boxShadow:`0 0 4px ${provColor}`, flexShrink:0 }} />
                <span style={{ fontSize:8,fontFamily:'monospace',
                  color:provColor, fontWeight:700, letterSpacing:'0.06em',
                  textTransform:'uppercase' }}>{inf.provider || 'infra'}</span>
                <span style={{ fontSize:8,fontFamily:'monospace',color:'#64748b',
                  maxWidth:80, overflow:'hidden', textOverflow:'ellipsis',
                  whiteSpace:'nowrap' }}>{inf.name}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Infra node ─────────────────────────────────────────────────────────────────
// InfraNode removed — infra is now rendered as inline badges inside CompNode

// ── Animated bezier edge ──────────────────────────────────────────────────────
function AnimEdge({ id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected, markerEnd }) {
  const [path, lx, ly] = getBezierPath(
    { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const color     = data?.color || '#334155'
  const isCross   = data?.crossApp
  const baseWidth = isCross ? 2.5 : 1.5
  const glowWidth = isCross ? 18  : 8
  const glowOpacity = isCross ? 0.14 : 0.06
  return (
    <>
      {/* Wide glow halo — extra prominent for cross-app */}
      <path d={path} fill="none" stroke={color} strokeWidth={glowWidth} opacity={glowOpacity} />
      {isCross && (
        <path d={path} fill="none" stroke={color} strokeWidth={6} opacity={0.22} />
      )}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{
        stroke: color,
        strokeWidth: selected ? baseWidth + 1 : baseWidth,
        strokeDasharray: data?.dashed ? '7 4' : undefined,
        opacity: isCross ? (selected ? 1 : 0.92) : (selected ? 1 : 0.75),
        filter: isCross
          ? `drop-shadow(0 0 ${selected ? 8 : 5}px ${color})`
          : (selected ? `drop-shadow(0 0 5px ${color})` : 'none'),
        transition: 'all .2s',
      }} />
      <circle r={selected ? 5 : (isCross ? 4 : 3)} fill={color}
        style={{ filter:`drop-shadow(0 0 ${isCross ? 7 : 5}px ${color})`, opacity: isCross ? 1 : .9 }}>
        <animateMotion dur={data?.dur||'2s'} repeatCount="indefinite" path={path} />
      </circle>
      {data?.label && (
        <EdgeLabelRenderer>
          <div style={{ position:'absolute', pointerEvents:'none', zIndex: isCross ? 1001 : 10,
            transform:`translate(-50%,-50%) translate(${lx}px,${ly}px)` }}>
            <span style={{
              display:'inline-block',
              background: isCross ? '#0a0518' : '#04080f',
              border:`1px solid ${color}${isCross ? 'aa' : '55'}`,
              borderRadius:4,
              padding: isCross ? '3px 8px' : '2px 6px',
              fontSize: isCross ? 10 : 9,
              fontFamily:'monospace', fontWeight: 700,
              color, letterSpacing:'0.05em',
              opacity: selected ? 1 : (isCross ? 1 : 0.9),
              boxShadow: isCross
                ? `0 0 12px ${color}66, 0 2px 8px #00000088`
                : (selected ? `0 0 8px ${color}44` : 'none'),
              whiteSpace:'nowrap',
            }}>{data.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { appGroup: AppGroupNode, comp: CompNode }
const edgeTypes = { anim: AnimEdge }

// ── Layout: apps as parent bubbles, components as children inside ─────────────
function buildGraph({ apps, components, connections, deployments, infra }) {
  const nodes = [], edges = []

  const compsByApp = {}
  components.forEach(c => {
    const k = c.appId || '__none__'
    if (!compsByApp[k]) compsByApp[k] = []
    compsByApp[k].push(c)
  })
  const infraById = Object.fromEntries((infra||[]).map(i => [i.id, i]))

  // Layout constants
  const PADDING_TOP    = 52   // space for app label at top of bubble
  const PADDING_SIDE   = 24
  const COMP_W         = 180
  const COMP_H         = 115   // extra height for infra badges
  const COMP_H_GAP     = 20
  const COMP_V_GAP     = 16
  const COLS           = 2    // components per row inside bubble
  const GROUP_H_GAP    = 80   // horizontal gap between app bubbles

  // Pre-build a map: compId → infra[] so we can embed badges in comp nodes
  const deploysByComp = {}
  ;(deployments||[]).forEach(d => {
    const inf = infraById[d.infraId]
    if (!inf) return
    if (!deploysByComp[d.compId]) deploysByComp[d.compId] = []
    // Avoid duplicates when a component deploys to the same infra multiple times
    if (!deploysByComp[d.compId].find(x => x.id === inf.id)) {
      deploysByComp[d.compId].push(inf)
    }
  })

  let cursorX = 0

  apps.forEach(app => {
    const appComps = compsByApp[app.id] || []
    const cols     = Math.min(appComps.length, COLS)
    const rows     = Math.ceil(appComps.length / COLS)

    // Bubble dimensions
    const bubbleW  = cols  * (COMP_W + COMP_H_GAP) + PADDING_SIDE * 2 - COMP_H_GAP
    const bubbleH  = rows  * (COMP_H + COMP_V_GAP) + PADDING_TOP + PADDING_SIDE

    // App group node
    nodes.push({
      id:       `app-${app.id}`,
      type:     'appGroup',
      position: { x: cursorX, y: 0 },
      style:    { width: bubbleW, height: bubbleH },
      data:     { label: app.name, nodeType: 'Application', meta: `tier ${app.tier} · ${app.environment}` },
    })

    // Component children — positioned relative to parent
    appComps.forEach((c, ci) => {
      const col = ci % COLS
      const row = Math.floor(ci / COLS)
      nodes.push({
        id:         `comp-${c.id}`,
        type:       'comp',
        parentNode: `app-${app.id}`,
        extent:     'parent',
        position:   {
          x: PADDING_SIDE + col * (COMP_W + COMP_H_GAP),
          y: PADDING_TOP  + row * (COMP_H + COMP_V_GAP),
        },
        data: {
          label:    c.name,
          nodeType: 'Component',
          subtype:  c.type,
          meta:     c.runtime || null,
          infra:    deploysByComp[c.id] || [],
        },
      })
    })

    cursorX += bubbleW + GROUP_H_GAP
  })

  // Infra is now embedded as badges inside component nodes — no canvas nodes or edges needed.

  // Component → Component connections (no ownership edges)
  ;(connections||[]).forEach((conn, i) => {
    const sameApp = conn.fromAppId && conn.toAppId && conn.fromAppId === conn.toAppId
    const color   = sameApp ? EC.sameApp : EC.crossApp
    const label   = conn.protocol
      ? (conn.port ? `${conn.protocol}:${conn.port}` : conn.protocol)
      : '→'
    edges.push({
      id:     `e-conn-${i}`,
      source: `comp-${conn.fromId}`,
      target: `comp-${conn.toId}`,
      type:   'anim',
      zIndex: sameApp ? 5 : 1000,   // cross-app edges paint above all group bubbles
      data:   { color, label, dur: sameApp ? '1.5s' : '2.2s', crossApp: !sameApp },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    })
  })

  return { nodes, edges }
}

// ── Legend ────────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div style={{ background:'#04080fee', border:'1px solid #0a1a2e',
      borderRadius:12, padding:'12px 14px', backdropFilter:'blur(10px)' }}>
      <div style={{ fontSize:8,color:'#1e3a5f',fontFamily:'monospace',
        letterSpacing:'0.12em',marginBottom:10,fontWeight:700 }}>LEGEND</div>
      {[
        [C.Application.border, 'Application (bubble)'],
        [C.API.border,         'API'],
        [C.DB.border,          'Database'],
        [C.Worker.border,      'Worker'],
        [C.UI.border,          'UI'],
        [C.Infra.border,       'Infra (badge inside component)'],
      ].map(([color, label]) => (
        <div key={label} style={{ display:'flex',alignItems:'center',gap:8,marginBottom:5 }}>
          <div style={{ width:9,height:9,borderRadius:2,
            border:`1.5px solid ${color}`,background:color+'18',
            boxShadow:`0 0 4px ${color}44` }} />
          <span style={{ fontSize:10,color:'#475569',fontFamily:'monospace' }}>{label}</span>
        </div>
      ))}
      <div style={{ height:1,background:'#0a1a2e',margin:'8px 0' }} />
      {[
        [EC.sameApp,  'Internal connection',   false],
        [EC.crossApp, 'Cross-app connection',  false],
      ].map(([color, label, dashed]) => (
        <div key={label} style={{ display:'flex',alignItems:'center',gap:8,marginBottom:5 }}>
          <div style={{ width:22,height:0,
            borderTop:`${dashed?'1.5px dashed':'2px solid'} ${color}`,opacity:.9 }} />
          <span style={{ fontSize:10,color:'#475569',fontFamily:'monospace' }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Node detail panel ─────────────────────────────────────────────────────────
function NodePanel({ node, allEdges, onClose }) {
  if (!node) return null
  const c   = nColor(node.data.nodeType, node.data.subtype)
  const out = allEdges.filter(e => e.source === node.id)
  const inc = allEdges.filter(e => e.target === node.id)
  return (
    <div style={{
      position:'absolute', right:16, top:58, width:268, zIndex:20,
      background:'#03060dee', border:`1px solid ${c.border}44`,
      borderRadius:14, overflow:'hidden',
      boxShadow:`0 0 40px ${c.glow}18, 0 20px 60px #00000099`,
      backdropFilter:'blur(14px)',
    }}>
      <style>{`@keyframes sIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}`}</style>
      <div style={{ animation:'sIn .18s ease' }}>
        <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
          background:`linear-gradient(90deg,transparent,${c.glow}88,transparent)` }} />
        <div style={{ padding:'13px 16px',borderBottom:'1px solid #0a1a2e',
          display:'flex',justifyContent:'space-between',alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:8,fontFamily:'monospace',color:c.text,
              letterSpacing:'0.12em',fontWeight:700,marginBottom:5 }}>
              {node.data.nodeType==='Component'
                ?(node.data.subtype||'COMPONENT').toUpperCase()
                :node.data.nodeType.toUpperCase()}
            </div>
            <div style={{ fontSize:14,fontWeight:700,color:'#f1f5f9',fontFamily:'monospace' }}>
              {node.data.label}
            </div>
            {node.data.meta&&(
              <div style={{ fontSize:10,color:'#475569',fontFamily:'monospace',marginTop:3 }}>
                {node.data.meta}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',
            color:'#334155',cursor:'pointer',fontSize:18,lineHeight:1,padding:0 }}>×</button>
        </div>
        <div style={{ padding:'12px 16px' }}>
          {[['OUTBOUND',out],['INBOUND',inc]].map(([dir,list]) =>
            list.length > 0 && (
              <div key={dir} style={{ marginBottom:10 }}>
                <div style={{ fontSize:8,color:'#1e3a5f',fontFamily:'monospace',
                  letterSpacing:'0.1em',fontWeight:700,marginBottom:6 }}>
                  {dir} ({list.length})
                </div>
                {list.map((e,i) => (
                  <div key={i} style={{
                    display:'flex',alignItems:'center',gap:7,
                    padding:'5px 9px',marginBottom:4,borderRadius:6,
                    background:(e.data?.color||'#334155')+'0d',
                    border:`1px solid ${e.data?.color||'#334155'}22`,
                  }}>
                    <div style={{ width:5,height:5,borderRadius:'50%',
                      background:e.data?.color,flexShrink:0 }} />
                    <span style={{ fontSize:10,color:e.data?.color,
                      fontFamily:'monospace',fontWeight:600 }}>
                      {e.data?.label||(dir==='OUTBOUND'?'→':'←')}
                    </span>
                    <span style={{ fontSize:9,color:'#475569',fontFamily:'monospace',
                      marginLeft:'auto',maxWidth:110,overflow:'hidden',
                      textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                      {(dir==='OUTBOUND'?e.target:e.source)
                        .replace(/^(comp|app|infra)-/,'')}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
          {out.length===0&&inc.length===0&&(
            <div style={{ fontSize:10,color:'#1e3a5f',fontFamily:'monospace',
              textAlign:'center',padding:'8px 0' }}>No connections</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function GraphPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [allNodes, setAllNodes] = useState([])
  const [allEdges, setAllEdges] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [selected, setSelected] = useState(null)
  const [filter,   setFilter]   = useState('all')
  const [counts,   setCounts]   = useState({ apps:0, comps:0, infra:0, edges:0 })

  const loadGraph = useCallback(() => {
    setLoading(true); setError(null)
    api.graph.topology()
      .then(topology => {
        const { nodes: n, edges: e } = buildGraph(topology)
        setAllNodes(n); setAllEdges(e); setNodes(n); setEdges(e)
        setCounts({
          apps:  topology.apps.length,
          comps: topology.components.length,
          infra: (topology.infra||[]).length,
          edges: e.length,
        })
      })
      .catch(err => { console.error('[graph]', err); setError(err.message) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadGraph()
    const onVis = () => { if (document.visibilityState === 'visible') loadGraph() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [loadGraph])

  // Filter — when filtering by component, show parent app bubbles too
  useEffect(() => {
    if (filter === 'all') { setNodes(allNodes); setEdges(allEdges); return }
    if (filter === 'Component') {
      // Show app group nodes + all component children
      const vis = allNodes.filter(n => n.data.nodeType === 'Application' || n.data.nodeType === 'Component')
      const ids = new Set(vis.map(n => n.id))
      setNodes(vis)
      setEdges(allEdges.filter(e => ids.has(e.source) && ids.has(e.target)))
      return
    }
    const vis = allNodes.filter(n => n.data.nodeType === filter)
    const ids = new Set(vis.map(n => n.id))
    setNodes(vis)
    setEdges(allEdges.filter(e => ids.has(e.source) && ids.has(e.target)))
  }, [filter, allNodes, allEdges])

  const onNodeClick = useCallback((_, n) => {
    // Don't select the app group bubble itself — only components/infra
    if (n.type !== 'appGroup') setSelected(n)
  }, [])
  const onPaneClick = useCallback(() => setSelected(null), [])

  return (
    <div style={{
      width:'100%', height:'100vh',
      background:'radial-gradient(ellipse at 15% 40%,#05101e 0%,#020810 65%)',
      display:'flex', flexDirection:'column', fontFamily:'monospace',
    }}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .react-flow__attribution{display:none!important}
        .react-flow__handle{opacity:0!important;pointer-events:none!important;width:4px!important;height:4px!important}
        .react-flow__controls button{background:#04080f!important;border-color:#081428!important;color:#475569!important}
        .react-flow__controls button:hover{background:#080f1a!important}
        .react-flow__node-appGroup{border-radius:20px!important}
      `}</style>

      {/* Top bar */}
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'9px 18px',borderBottom:'1px solid #081428',
        background:'#02060eee',zIndex:5,flexShrink:0,gap:16 }}>
        <div style={{ display:'flex',alignItems:'center',gap:10 }}>
          <div style={{ width:7,height:7,borderRadius:'50%',background:'#22c55e',
            boxShadow:'0 0 10px #22c55e',animation:'pulse 2s infinite' }} />
          <span style={{ fontSize:13,fontWeight:700,color:'#e2e8f0' }}>Infrastructure Graph</span>
          <span style={{ fontSize:10,color:'#0f2040' }}>· LIVE TOPOLOGY</span>
        </div>
        <div style={{ display:'flex',gap:1 }}>
          {[['APPS',counts.apps,'#22c55e'],['COMPONENTS',counts.comps,'#38bdf8'],
            ['INFRA',counts.infra,'#6b7280'],['EDGES',counts.edges,'#a78bfa']]
            .map(([l,v,color],i,arr) => (
              <div key={l} style={{
                padding:'5px 14px',background:'#080f1a',border:'1px solid #081428',
                borderLeft:i>0?'none':undefined,
                borderRadius:i===0?'8px 0 0 8px':i===arr.length-1?'0 8px 8px 0':0,
                display:'flex',flexDirection:'column',alignItems:'center',gap:1,
              }}>
                <span style={{ fontSize:16,fontWeight:800,color,fontFamily:'monospace' }}>{v}</span>
                <span style={{ fontSize:7,color:'#1e3a5f',letterSpacing:'0.1em' }}>{l}</span>
              </div>
            ))}
        </div>
        <div style={{ display:'flex',gap:6,alignItems:'center' }}>
          {[['all','All'],['Application','Apps'],['Component','Components'],['Infra','Infra']]
            .map(([key,label]) => (
              <button key={key} onClick={() => setFilter(key)} style={{
                padding:'5px 12px',borderRadius:6,cursor:'pointer',
                fontFamily:'monospace',fontWeight:600,fontSize:11,
                border:`1px solid ${filter===key?'#22c55e55':'#081428'}`,
                background:filter===key?'#22c55e12':'transparent',
                color:filter===key?'#22c55e':'#334155',transition:'all .15s',
              }}>{label}</button>
            ))}
          <button onClick={loadGraph} style={{ padding:'5px 11px',background:'#080f1a',
            border:'1px solid #081428',borderRadius:6,color:'#475569',fontSize:14,cursor:'pointer' }}>↺</button>
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex:1,position:'relative' }}>
        {loading ? (
          <div style={{ position:'absolute',inset:0,display:'flex',
            flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14 }}>
            <div style={{ width:36,height:36,borderRadius:'50%',
              border:'2px solid #081428',borderTop:'2px solid #22c55e',
              animation:'spin .7s linear infinite' }} />
            <span style={{ fontSize:10,color:'#1e3a5f',letterSpacing:'0.12em' }}>LOADING TOPOLOGY…</span>
          </div>
        ) : error ? (
          <div style={{ position:'absolute',inset:0,display:'flex',
            flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12 }}>
            <div style={{ fontSize:11,color:'#f43f5e',fontFamily:'monospace' }}>{error}</div>
            <button onClick={loadGraph} style={{ padding:'7px 16px',background:'#f43f5e15',
              border:'1px solid #f43f5e44',borderRadius:8,color:'#f43f5e',
              fontFamily:'monospace',fontSize:11,cursor:'pointer' }}>Retry</button>
          </div>
        ) : nodes.length === 0 ? (
          <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center' }}>
            <span style={{ fontSize:11,color:'#1e3a5f',fontFamily:'monospace' }}>
              No data yet — add applications and components first
            </span>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick} onPaneClick={onPaneClick}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            fitView fitViewOptions={{ padding:0.2 }}
            minZoom={0.05} maxZoom={4}
            style={{ background:'transparent' }}
          >
            <Background variant="dots" gap={30} size={1} color="#081428" />
            <Controls />
            <Panel position="top-right" style={{ marginTop:6,marginRight:6 }}>
              <Legend />
            </Panel>
          </ReactFlow>
        )}
        <NodePanel node={selected} allEdges={allEdges} onClose={() => setSelected(null)} />
      </div>
    </div>
  )
}