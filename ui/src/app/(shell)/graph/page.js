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
  contains: '#22c55e',
  sameApp:  '#38bdf8',
  crossApp: '#a78bfa',
  deploys:  '#475569',
}
function nColor(nodeType, subtype) {
  if (nodeType === 'Application') return C.Application
  if (nodeType === 'Component')   return C[subtype] || C.API
  return C.Infra
}

// ── Custom node — Handles are REQUIRED for edges to render ───────────────────
const handleStyle = { background: 'transparent', border: 'none', width: 8, height: 8 }

function GraphNode({ data, selected }) {
  const c = nColor(data.nodeType, data.subtype)
  return (
    <div style={{
      background: `linear-gradient(135deg,${c.bg},#020810)`,
      border: `1.5px solid ${selected ? c.glow : c.border + 'bb'}`,
      boxShadow: selected
        ? `0 0 0 2px ${c.glow}33,0 0 28px ${c.glow}55`
        : `0 0 14px ${c.glow}22`,
      borderRadius: 12, padding: '10px 15px', minWidth: 155,
      cursor: 'pointer', position: 'relative', overflow: 'visible',
      transition: 'border-color .2s,box-shadow .2s',
    }}>
      {/* ReactFlow connection handles — invisible but required */}
      <Handle type="target" position={Position.Left}  style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <Handle type="target" position={Position.Top}   style={{ ...handleStyle, left: '50%' }} />
      <Handle type="source" position={Position.Bottom} style={{ ...handleStyle, left: '50%' }} />

      <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
        background:`linear-gradient(90deg,transparent,${c.glow}99,transparent)` }} />
      <div style={{ display:'inline-flex',alignItems:'center',gap:5,
        background:c.glow+'18',border:`1px solid ${c.glow}33`,
        borderRadius:4,padding:'2px 7px',marginBottom:6 }}>
        <div style={{ width:5,height:5,borderRadius:'50%',
          background:c.glow,boxShadow:`0 0 6px ${c.glow}` }} />
        <span style={{ fontSize:8,fontFamily:'monospace',color:c.text,
          letterSpacing:'0.1em',fontWeight:700 }}>
          {data.nodeType === 'Component'
            ? (data.subtype||'COMPONENT').toUpperCase()
            : data.nodeType.toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize:12,fontWeight:700,color:'#f1f5f9',
        fontFamily:'monospace',lineHeight:1.35 }}>{data.label}</div>
      {data.meta && <div style={{ fontSize:9,color:'#475569',marginTop:4,
        fontFamily:'monospace',lineHeight:1.4 }}>{data.meta}</div>}
    </div>
  )
}

// ── Animated bezier edge ──────────────────────────────────────────────────────
function AnimEdge({ id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected, markerEnd }) {
  const [path, lx, ly] = getBezierPath(
    { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const color = data?.color || '#334155'
  return (
    <>
      <path d={path} fill="none" stroke={color} strokeWidth={8} opacity={0.06} />
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{
        stroke: color,
        strokeWidth: selected ? 2.5 : 1.5,
        strokeDasharray: data?.dashed ? '7 4' : undefined,
        opacity: selected ? 1 : 0.7,
        filter: selected ? `drop-shadow(0 0 5px ${color})` : 'none',
        transition: 'all .2s',
      }} />
      <circle r={selected ? 4 : 3} fill={color}
        style={{ filter:`drop-shadow(0 0 5px ${color})`,opacity:.9 }}>
        <animateMotion dur={data?.dur||'2s'} repeatCount="indefinite" path={path} />
      </circle>
      {data?.label && (
        <EdgeLabelRenderer>
          <div style={{
            position:'absolute',
            transform:`translate(-50%,-50%) translate(${lx}px,${ly}px)`,
            pointerEvents:'none',zIndex:10,
          }}>
            <span style={{
              display:'inline-block',
              background:'#04080f',
              border:`1px solid ${color}55`,
              borderRadius:4,padding:'2px 6px',
              fontSize:9,fontFamily:'monospace',fontWeight:600,
              color,letterSpacing:'0.05em',
              opacity: selected ? 1 : 0.9,
              boxShadow: selected ? `0 0 8px ${color}44` : 'none',
              whiteSpace:'nowrap',
            }}>{data.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { gnode: GraphNode }
const edgeTypes = { anim: AnimEdge }

// ── Layout ────────────────────────────────────────────────────────────────────
function buildGraph({ apps, components, connections, deployments, infra }) {
  const nodes = [], edges = []

  // Group components by app
  const compsByApp = {}
  components.forEach(c => {
    const k = c.appId || '__none__'
    if (!compsByApp[k]) compsByApp[k] = []
    compsByApp[k].push(c)
  })
  const infraById = Object.fromEntries((infra||[]).map(i=>[i.id,i]))

  const APP_W      = 200  // approx width of app node
  const COMP_W     = 200  // approx width of comp node
  const H_GAP      = 120  // horizontal gap: app → components
  const COMP_V_GAP = 130  // vertical gap between components
  const GROUP_GAP  = 100  // horizontal gap between app groups

  let cursorX = 0

  apps.forEach(app => {
    const appComps = compsByApp[app.id] || []
    const groupH   = Math.max(appComps.length, 1) * COMP_V_GAP
    const appY     = (groupH - 70) / 2   // vertically centre app node

    nodes.push({
      id: `app-${app.id}`,
      type: 'gnode',
      position: { x: cursorX, y: appY },
      data: {
        label: app.name,
        nodeType: 'Application',
        meta: `tier ${app.tier} · ${app.environment}`,
      },
    })

    appComps.forEach((c, ci) => {
      nodes.push({
        id: `comp-${c.id}`,
        type: 'gnode',
        position: { x: cursorX + APP_W + H_GAP, y: ci * COMP_V_GAP },
        data: {
          label: c.name,
          nodeType: 'Component',
          subtype: c.type,
          meta: c.runtime || null,
        },
      })
      // App → Component
      edges.push({
        id: `e-owns-${c.id}`,
        source: `app-${app.id}`,
        target: `comp-${c.id}`,
        type: 'anim',
        data: { color: EC.contains, label: 'owns', dur: '3s' },
        markerEnd: { type: MarkerType.ArrowClosed, color: EC.contains, width: 14, height: 14 },
      })
    })

    cursorX += APP_W + H_GAP + COMP_W + GROUP_GAP
  })

  // Infra nodes
  const addedInfra = new Set()
  ;(deployments||[]).forEach((d,di) => {
    const inf = infraById[d.infraId]
    if (!inf) return
    if (!addedInfra.has(d.infraId)) {
      addedInfra.add(d.infraId)
      const compNode = nodes.find(n => n.id === `comp-${d.compId}`)
      nodes.push({
        id: `infra-${d.infraId}`,
        type: 'gnode',
        position: {
          x: compNode ? compNode.position.x : di * 280,
          y: compNode ? compNode.position.y + 200 : 500,
        },
        data: {
          label: inf.name,
          nodeType: 'Infra',
          meta: [inf.provider,inf.region,inf.resourceType].filter(Boolean).join(' · '),
        },
      })
    }
    edges.push({
      id: `e-dep-${d.compId}-${d.infraId}`,
      source: `comp-${d.compId}`,
      target: `infra-${d.infraId}`,
      type: 'anim',
      data: { color: EC.deploys, label: 'deployed on', dashed: true, dur: '4s' },
      markerEnd: { type: MarkerType.ArrowClosed, color: EC.deploys, width: 11, height: 11 },
    })
  })

  // Component → Component
  ;(connections||[]).forEach((conn,i) => {
    const sameApp = conn.fromAppId && conn.toAppId && conn.fromAppId === conn.toAppId
    const color   = sameApp ? EC.sameApp : EC.crossApp
    const label   = conn.protocol
      ? (conn.port ? `${conn.protocol}:${conn.port}` : conn.protocol)
      : '→'
    edges.push({
      id: `e-conn-${i}`,
      source: `comp-${conn.fromId}`,
      target: `comp-${conn.toId}`,
      type: 'anim',
      data: { color, label, dur: sameApp ? '1.5s' : '2.2s' },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    })
  })

  return { nodes, edges }
}

// ── Legend ────────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div style={{ background:'#04080fee',border:'1px solid #0a1a2e',
      borderRadius:12,padding:'12px 14px',backdropFilter:'blur(10px)' }}>
      <div style={{ fontSize:8,color:'#1e3a5f',fontFamily:'monospace',
        letterSpacing:'0.12em',marginBottom:10,fontWeight:700 }}>LEGEND</div>
      {[
        [C.Application.border,'Application'],
        [C.API.border,'API'],
        [C.DB.border,'Database'],
        [C.Worker.border,'Worker'],
        [C.UI.border,'UI'],
        [C.Infra.border,'Infrastructure'],
      ].map(([color,label]) => (
        <div key={label} style={{ display:'flex',alignItems:'center',gap:8,marginBottom:5 }}>
          <div style={{ width:9,height:9,borderRadius:2,
            border:`1.5px solid ${color}`,background:color+'18',
            boxShadow:`0 0 4px ${color}44` }} />
          <span style={{ fontSize:10,color:'#475569',fontFamily:'monospace' }}>{label}</span>
        </div>
      ))}
      <div style={{ height:1,background:'#0a1a2e',margin:'8px 0' }} />
      {[
        [EC.contains,'App → Component',false],
        [EC.sameApp, 'Internal connection',false],
        [EC.crossApp,'Cross-app connection',false],
        [EC.deploys, 'Deployed on infra',true],
      ].map(([color,label,dashed]) => (
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
      position:'absolute',right:16,top:58,width:268,zIndex:20,
      background:'#03060dee',border:`1px solid ${c.border}44`,
      borderRadius:14,overflow:'hidden',
      boxShadow:`0 0 40px ${c.glow}18,0 20px 60px #00000099`,
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
  const [allNodes,  setAllNodes]  = useState([])
  const [allEdges,  setAllEdges]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [selected,  setSelected]  = useState(null)
  const [filter,    setFilter]    = useState('all')
  const [counts,    setCounts]    = useState({ apps:0, comps:0, infra:0, edges:0 })

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

  useEffect(() => {
    if (filter === 'all') { setNodes(allNodes); setEdges(allEdges); return }
    const vis  = allNodes.filter(n => n.data.nodeType === filter)
    const ids  = new Set(vis.map(n => n.id))
    setNodes(vis)
    setEdges(allEdges.filter(e => ids.has(e.source) && ids.has(e.target)))
  }, [filter, allNodes, allEdges])

  const onNodeClick = useCallback((_, n) => setSelected(n), [])
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
        .react-flow__handle{opacity:0!important;pointer-events:none!important;width:1px!important;height:1px!important}
        .react-flow__controls button{background:#04080f!important;border-color:#081428!important;color:#475569!important}
        .react-flow__controls button:hover{background:#080f1a!important}
      `}</style>

      {/* Top bar */}
      <div style={{
        display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'9px 18px',borderBottom:'1px solid #081428',
        background:'#02060eee',zIndex:5,flexShrink:0,gap:16,
      }}>
        <div style={{ display:'flex',alignItems:'center',gap:10 }}>
          <div style={{ width:7,height:7,borderRadius:'50%',
            background:'#22c55e',boxShadow:'0 0 10px #22c55e',
            animation:'pulse 2s infinite' }} />
          <span style={{ fontSize:13,fontWeight:700,color:'#e2e8f0' }}>
            Infrastructure Graph
          </span>
          <span style={{ fontSize:10,color:'#0f2040' }}>· LIVE TOPOLOGY</span>
        </div>

        {/* Stat chips */}
        <div style={{ display:'flex',gap:1 }}>
          {[['APPS',counts.apps,'#22c55e'],['COMPONENTS',counts.comps,'#38bdf8'],
            ['INFRA',counts.infra,'#6b7280'],['EDGES',counts.edges,'#a78bfa']]
            .map(([label,value,color],i,arr) => (
              <div key={label} style={{
                padding:'5px 14px',background:'#080f1a',border:'1px solid #081428',
                borderLeft:i>0?'none':undefined,
                borderRadius:i===0?'8px 0 0 8px':i===arr.length-1?'0 8px 8px 0':0,
                display:'flex',flexDirection:'column',alignItems:'center',gap:1,
              }}>
                <span style={{ fontSize:16,fontWeight:800,color,fontFamily:'monospace' }}>
                  {value}
                </span>
                <span style={{ fontSize:7,color:'#1e3a5f',letterSpacing:'0.1em' }}>
                  {label}
                </span>
              </div>
            ))}
        </div>

        {/* Filters + refresh */}
        <div style={{ display:'flex',gap:6,alignItems:'center' }}>
          {[['all','All'],['Application','Apps'],['Component','Components'],['Infra','Infra']]
            .map(([key,label]) => (
              <button key={key} onClick={() => setFilter(key)} style={{
                padding:'5px 12px',borderRadius:6,cursor:'pointer',
                fontFamily:'monospace',fontWeight:600,fontSize:11,
                border:`1px solid ${filter===key?'#22c55e55':'#081428'}`,
                background:filter===key?'#22c55e12':'transparent',
                color:filter===key?'#22c55e':'#334155',
                transition:'all .15s',
              }}>{label}</button>
            ))}
          <button onClick={loadGraph} title="Refresh" style={{
            padding:'5px 11px',background:'#080f1a',border:'1px solid #081428',
            borderRadius:6,color:'#475569',fontSize:14,cursor:'pointer',
          }}>↺</button>
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
            <span style={{ fontSize:10,color:'#1e3a5f',letterSpacing:'0.12em' }}>
              LOADING TOPOLOGY…
            </span>
          </div>
        ) : error ? (
          <div style={{ position:'absolute',inset:0,display:'flex',
            flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12 }}>
            <div style={{ fontSize:11,color:'#f43f5e',fontFamily:'monospace' }}>{error}</div>
            <button onClick={loadGraph} style={{
              padding:'7px 16px',background:'#f43f5e15',border:'1px solid #f43f5e44',
              borderRadius:8,color:'#f43f5e',fontFamily:'monospace',fontSize:11,cursor:'pointer',
            }}>Retry</button>
          </div>
        ) : nodes.length === 0 ? (
          <div style={{ position:'absolute',inset:0,display:'flex',
            alignItems:'center',justifyContent:'center' }}>
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
            fitView fitViewOptions={{ padding:0.25 }}
            minZoom={0.05} maxZoom={4}
            defaultEdgeOptions={{ type:'anim' }}
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