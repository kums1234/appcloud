'use client'
import { useEffect, useState, useCallback } from 'react'
import ReactFlow, {
  Background, Controls, Panel,
  useNodesState, useEdgesState,
  MarkerType, Position,
  getBezierPath, getSmoothStepPath, EdgeLabelRenderer, BaseEdge,
  Handle,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '@/lib/api'

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  Application: { bg:'#061a0a', border:'#22c55e', glow:'#22c55e', text:'#22c55e' },
  API:         { bg:'#061018', border:'#38bdf8', glow:'#38bdf8', text:'#38bdf8' },
  DB:          { bg:'#180e02', border:'#f59e0b', glow:'#f59e0b', text:'#f59e0b' },
  Worker:      { bg:'#0e0618', border:'#a78bfa', glow:'#a78bfa', text:'#a78bfa' },
  UI:          { bg:'#180608', border:'#f43f5e', glow:'#f43f5e', text:'#f43f5e' },
}
const EC = { sameApp:'#38bdf8', crossApp:'#a78bfa' }
const PROV_COLOR = { aws:'#f59e0b', azure:'#38bdf8', gcp:'#22c55e', onprem:'#a78bfa' }

function nColor(subtype) { return C[subtype] || C.API }

// ── Layout ────────────────────────────────────────────────────────────────────
const COMP_W      = 210
const COMP_H_BASE = 92
const BADGE_H     = 30   // extra height per row of infra badges
const PAD_T       = 50   // top padding inside bubble (for label)
const PAD_S       = 26   // side padding
const PAD_B       = 22   // bottom padding
const COMP_GAP    = 18   // vertical gap between components in same bubble
const BUB_GAP     = 200  // horizontal gap between bubbles — wide to keep lines clear

function infraBadgeRows(n) { return n > 0 ? Math.ceil(n / 2) : 0 }
function nodeH(infraCount) { return COMP_H_BASE + (infraBadgeRows(infraCount) > 0 ? 12 + infraBadgeRows(infraCount) * BADGE_H : 0) }

// ── App group bubble ──────────────────────────────────────────────────────────
function AppGroupNode({ data }) {
  const c = C.Application
  return (
    <div style={{
      width:'100%', height:'100%',
      background:`radial-gradient(ellipse at 50% 0%,${c.glow}07 0%,#020810 60%)`,
      border:`1.5px solid ${c.border}50`,
      boxShadow:`0 0 36px ${c.glow}0c,inset 0 0 40px ${c.glow}04`,
      borderRadius:20, position:'relative', pointerEvents:'none',
    }}>
      <div style={{ position:'absolute',top:0,left:'8%',right:'8%',height:1,
        background:`linear-gradient(90deg,transparent,${c.glow}66,transparent)` }} />
      <div style={{ position:'absolute',top:14,left:18,
        display:'flex',alignItems:'center',gap:7,pointerEvents:'auto' }}>
        <div style={{ width:7,height:7,borderRadius:'50%',
          background:c.glow,boxShadow:`0 0 8px ${c.glow}` }} />
        <span style={{ fontSize:12,fontWeight:800,color:c.text,
          fontFamily:'monospace',letterSpacing:'0.03em' }}>{data.label}</span>
        <span style={{ fontSize:9,color:'#334155',
          fontFamily:'monospace',marginLeft:2 }}>{data.meta}</span>
      </div>
      {/* Handles on the bubble itself for cross-app edges */}
      <Handle id="r" type="source" position={Position.Right}
        style={{ opacity:0,pointerEvents:'none',top:'50%',right:0 }} />
      <Handle id="l" type="target" position={Position.Left}
        style={{ opacity:0,pointerEvents:'none',top:'50%',left:0 }} />
    </div>
  )
}

// ── Component node ────────────────────────────────────────────────────────────
const HS = { background:'transparent',border:'none',width:8,height:8 }
function CompNode({ data, selected }) {
  const c = nColor(data.subtype)
  return (
    <div style={{
      background:`linear-gradient(145deg,${c.bg},#010609e8)`,
      border:`1.5px solid ${selected?c.glow:c.border+'cc'}`,
      boxShadow:selected?`0 0 0 2px ${c.glow}44,0 0 22px ${c.glow}55`:`0 0 10px ${c.glow}18`,
      borderRadius:11,padding:'9px 13px',width:COMP_W,
      cursor:'pointer',position:'relative',overflow:'visible',
      transition:'border-color .18s,box-shadow .18s',boxSizing:'border-box',
    }}>
      {/* Handles: right=out, left=in, bottom=sameapp-out, top=sameapp-in */}
      <Handle id="out"   type="source" position={Position.Right}  style={HS} />
      <Handle id="in"    type="target" position={Position.Left}   style={HS} />
      <Handle id="bot"   type="source" position={Position.Bottom} style={{...HS,left:'30%'}} />
      <Handle id="top"   type="target" position={Position.Top}    style={{...HS,left:'30%'}} />

      <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
        background:`linear-gradient(90deg,transparent,${c.glow}88,transparent)` }} />

      <div style={{ display:'inline-flex',alignItems:'center',gap:5,
        background:c.glow+'15',border:`1px solid ${c.glow}33`,
        borderRadius:4,padding:'2px 7px',marginBottom:6 }}>
        <div style={{ width:4,height:4,borderRadius:'50%',
          background:c.glow,boxShadow:`0 0 5px ${c.glow}` }} />
        <span style={{ fontSize:8,fontFamily:'monospace',color:c.text,
          letterSpacing:'0.1em',fontWeight:700 }}>
          {(data.subtype||'COMPONENT').toUpperCase()}
        </span>
      </div>

      <div style={{ fontSize:12,fontWeight:700,color:'#f1f5f9',
        fontFamily:'monospace',lineHeight:1.3 }}>{data.label}</div>
      {data.meta&&(
        <div style={{ fontSize:9,color:'#475569',marginTop:3,fontFamily:'monospace' }}>
          {data.meta}
        </div>
      )}

      {data.infra&&data.infra.length>0&&(
        <div style={{ marginTop:8,borderTop:`1px solid ${c.glow}18`,
          paddingTop:6,display:'flex',flexWrap:'wrap',gap:4 }}>
          {data.infra.map((inf,i)=>{
            const pc=PROV_COLOR[inf.provider]||'#6b7280'
            return (
              <div key={i}
                title={[inf.name,inf.provider,inf.region,inf.resourceType].filter(Boolean).join(' · ')}
                style={{ display:'inline-flex',alignItems:'center',gap:4,
                  background:pc+'12',border:`1px solid ${pc}33`,
                  borderRadius:4,padding:'2px 6px' }}>
                <div style={{ width:4,height:4,borderRadius:'50%',
                  background:pc,boxShadow:`0 0 4px ${pc}`,flexShrink:0 }} />
                <span style={{ fontSize:8,fontFamily:'monospace',color:pc,
                  fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase' }}>
                  {inf.provider||'infra'}
                </span>
                <span style={{ fontSize:8,fontFamily:'monospace',color:'#64748b',
                  maxWidth:76,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                  {inf.name}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Edge ──────────────────────────────────────────────────────────────────────
function AnimEdge({ id,sourceX,sourceY,targetX,targetY,
  sourcePosition,targetPosition,data,selected,markerEnd }) {
  const isCross = data?.crossApp

  // Cross-app: smooth bezier that arcs between apps
  // Same-app: smooth step that routes around nodes
  const [path,lx,ly] = isCross
    ? getBezierPath({sourceX,sourceY,sourcePosition,targetX,targetY,targetPosition})
    : getSmoothStepPath({sourceX,sourceY,sourcePosition,
        targetX,targetY,targetPosition,borderRadius:28,offset:40})

  const color  = data?.color||'#334155'
  const lineW  = isCross?(selected?3:2.5):(selected?2:1.5)

  return (
    <>
      <path d={path} fill="none" stroke={color}
        strokeWidth={isCross?20:10} opacity={isCross?0.10:0.04} />
      {isCross&&<path d={path} fill="none" stroke={color} strokeWidth={7} opacity={0.18} />}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{
        stroke:color, strokeWidth:lineW,
        opacity:isCross?(selected?1:0.9):(selected?1:0.7),
        filter:isCross?`drop-shadow(0 0 ${selected?8:5}px ${color})`:'none',
        transition:'all .2s',
      }} />
      <circle r={isCross?(selected?5:4):(selected?4:3)} fill={color}
        style={{ filter:`drop-shadow(0 0 ${isCross?7:4}px ${color})`,
          opacity:isCross?1:0.85 }}>
        <animateMotion dur={data?.dur||(isCross?'2.2s':'1.8s')}
          repeatCount="indefinite" path={path} />
      </circle>
      {data?.label&&(
        <EdgeLabelRenderer>
          <div style={{ position:'absolute',pointerEvents:'none',
            zIndex:isCross?1001:10,
            transform:`translate(-50%,-50%) translate(${lx}px,${ly}px)` }}>
            <span style={{
              display:'inline-block',
              background:isCross?'#0b0718':'#030608',
              border:`1px solid ${color}${isCross?'99':'44'}`,
              borderRadius:5,padding:isCross?'3px 9px':'2px 6px',
              fontSize:isCross?10:9,fontFamily:'monospace',fontWeight:700,
              color,letterSpacing:'0.05em',
              boxShadow:isCross?`0 0 16px ${color}55,0 2px 8px #00000099`:'none',
              whiteSpace:'nowrap',
            }}>{data.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { appGroup:AppGroupNode, comp:CompNode }
const edgeTypes = { anim:AnimEdge }

// ── Build graph ───────────────────────────────────────────────────────────────
function buildGraph({ apps, components, connections, deployments, infra }) {
  const nodes=[], edges=[]

  const infraById = Object.fromEntries((infra||[]).map(i=>[i.id,i]))
  const deploysByComp = {}
  ;(deployments||[]).forEach(d=>{
    const inf=infraById[d.infraId]; if(!inf) return
    if(!deploysByComp[d.compId]) deploysByComp[d.compId]=[]
    if(!deploysByComp[d.compId].find(x=>x.id===inf.id))
      deploysByComp[d.compId].push(inf)
  })

  const compsByApp = {}
  components.forEach(c=>{
    const k=c.appId||'__none__'
    if(!compsByApp[k]) compsByApp[k]=[]
    compsByApp[k].push(c)
  })

  // Which components have cross-app connections?
  const crossSrc=new Set(), crossTgt=new Set()
  ;(connections||[]).forEach(conn=>{
    const same=conn.fromAppId&&conn.toAppId&&conn.fromAppId===conn.toAppId
    if(!same){ crossSrc.add(conn.fromId); crossTgt.add(conn.toId) }
  })

  // ── Position bubbles ───────────────────────────────────────────────────────
  const bubbleW = COMP_W + PAD_S*2
  let cursorX = 0

  apps.forEach(app=>{
    const all = compsByApp[app.id]||[]

    // Sort order inside bubble:
    // 1. Cross-app sources at top (their "out" handle is on the right → lines exit cleanly)
    // 2. Neutral components in middle
    // 3. Cross-app targets at bottom
    const sorted = [
      ...all.filter(c=> crossSrc.has(c.id)&&!crossTgt.has(c.id)),
      ...all.filter(c=>!crossSrc.has(c.id)&&!crossTgt.has(c.id)),
      ...all.filter(c=>!crossSrc.has(c.id)&& crossTgt.has(c.id)),
      ...all.filter(c=> crossSrc.has(c.id)&& crossTgt.has(c.id)),
    ]

    // Compute per-component heights based on infra badge count
    const heights = sorted.map(c=>nodeH((deploysByComp[c.id]||[]).length))
    const totalH  = heights.reduce((a,b)=>a+b,0)+Math.max(sorted.length-1,0)*COMP_GAP
    const bubbleH = totalH+PAD_T+PAD_B

    nodes.push({
      id:`app-${app.id}`, type:'appGroup',
      position:{ x:cursorX, y:0 },
      style:{ width:bubbleW, height:bubbleH },
      data:{ label:app.name, nodeType:'Application',
             meta:`tier ${app.tier} · ${app.environment}` },
    })

    let cy=PAD_T
    sorted.forEach((c,ci)=>{
      nodes.push({
        id:`comp-${c.id}`, type:'comp',
        parentNode:`app-${app.id}`, extent:'parent',
        position:{ x:PAD_S, y:cy },
        data:{
          label:c.name, nodeType:'Component',
          subtype:c.type, meta:c.runtime||null,
          infra:deploysByComp[c.id]||[],
          appId:app.id,
        },
      })
      cy+=heights[ci]+COMP_GAP
    })

    cursorX+=bubbleW+BUB_GAP
  })

  // ── Edges ─────────────────────────────────────────────────────────────────
  ;(connections||[]).forEach((conn,i)=>{
    const same  = conn.fromAppId&&conn.toAppId&&conn.fromAppId===conn.toAppId
    const color = same?EC.sameApp:EC.crossApp
    const label = conn.protocol
      ?(conn.port?`${conn.protocol}:${conn.port}`:conn.protocol):'→'

    if(same){
      // Same-app: bottom of source → left side loop → top of target
      // Using left-offset handles so the line sweeps left of the column, not through it
      edges.push({
        id:`e-${i}`,
        source:`comp-${conn.fromId}`, sourceHandle:'bot',
        target:`comp-${conn.toId}`,   targetHandle:'top',
        type:'anim', zIndex:5,
        data:{ color, label, dur:'1.8s' },
        markerEnd:{ type:MarkerType.ArrowClosed, color, width:12, height:12 },
      })
    } else {
      // Cross-app: right handle of source comp → left handle of target comp
      // Direct bezier — moves with nodes when dragged
      edges.push({
        id:`e-${i}`,
        source:`comp-${conn.fromId}`, sourceHandle:'out',
        target:`comp-${conn.toId}`,   targetHandle:'in',
        type:'anim', zIndex:1000,
        data:{ color, label, crossApp:true, dur:'2.2s' },
        markerEnd:{ type:MarkerType.ArrowClosed, color, width:14, height:14 },
      })
    }
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
        [C.Application.border,'Application (bubble)'],
        [C.API.border,'API'],[C.DB.border,'Database'],
        [C.Worker.border,'Worker'],[C.UI.border,'UI'],
      ].map(([color,label])=>(
        <div key={label} style={{ display:'flex',alignItems:'center',gap:8,marginBottom:5 }}>
          <div style={{ width:9,height:9,borderRadius:2,
            border:`1.5px solid ${color}`,background:color+'18',
            boxShadow:`0 0 4px ${color}44` }} />
          <span style={{ fontSize:10,color:'#475569',fontFamily:'monospace' }}>{label}</span>
        </div>
      ))}
      <div style={{ height:1,background:'#0a1a2e',margin:'8px 0' }} />
      {[[EC.sameApp,'Internal connection'],[EC.crossApp,'Cross-app connection']].map(([color,label])=>(
        <div key={label} style={{ display:'flex',alignItems:'center',gap:8,marginBottom:5 }}>
          <div style={{ width:22,height:0,borderTop:`2px solid ${color}`,opacity:.9 }} />
          <span style={{ fontSize:10,color:'#475569',fontFamily:'monospace' }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Node detail panel ─────────────────────────────────────────────────────────
function NodePanel({ node, allEdges, allNodes, onClose }) {
  if(!node) return null
  const c     = nColor(node.data.subtype)
  const infra = node.data.infra||[]
  const out   = allEdges.filter(e=>e.source===node.id)
  const inc   = allEdges.filter(e=>e.target===node.id)

  const nodeLabel = id=>{
    const n=allNodes.find(n=>n.id===id)
    return n?.data?.label||id
  }

  return (
    <div style={{ position:'absolute',right:16,top:58,width:292,zIndex:20,
      background:'#03060dee',border:`1px solid ${c.border}44`,
      borderRadius:14,overflow:'hidden',
      maxHeight:'calc(100vh - 80px)',display:'flex',flexDirection:'column',
      boxShadow:`0 0 40px ${c.glow}18,0 20px 60px #00000099`,
      backdropFilter:'blur(14px)' }}>
      <style>{`
        @keyframes sIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}
        .np-scroll::-webkit-scrollbar{width:4px}
        .np-scroll::-webkit-scrollbar-track{background:transparent}
        .np-scroll::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
      `}</style>

      {/* Sticky header */}
      <div style={{ flexShrink:0,position:'relative',
        borderBottom:'1px solid #0a1a2e' }}>
        <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
          background:`linear-gradient(90deg,transparent,${c.glow}88,transparent)` }} />
        <div style={{ padding:'14px 16px',
          display:'flex',justifyContent:'space-between',alignItems:'flex-start',
          animation:'sIn .18s ease' }}>
          <div>
            <div style={{ fontSize:8,fontFamily:'monospace',color:c.text,
              letterSpacing:'0.12em',fontWeight:700,marginBottom:5 }}>
              {(node.data.subtype||'COMPONENT').toUpperCase()}
            </div>
            <div style={{ fontSize:15,fontWeight:800,color:'#f1f5f9',
              fontFamily:'monospace' }}>{node.data.label}</div>
            {node.data.meta&&(
              <div style={{ fontSize:10,color:'#475569',
                fontFamily:'monospace',marginTop:3 }}>{node.data.meta}</div>
            )}
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',
            color:'#334155',cursor:'pointer',fontSize:20,lineHeight:1,
            padding:0,marginLeft:8,flexShrink:0 }}>×</button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="np-scroll" style={{ overflowY:'auto',padding:'12px 16px' }}>

        {/* Infra deployments */}
        {infra.length>0&&(
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:8,color:'#1e3a5f',fontFamily:'monospace',
              letterSpacing:'0.1em',fontWeight:700,marginBottom:8 }}>
              DEPLOYED ON ({infra.length})
            </div>
            {infra.map((inf,i)=>{
              const pc=PROV_COLOR[inf.provider]||'#6b7280'
              return (
                <div key={i} style={{ marginBottom:8,padding:'10px 12px',
                  background:pc+'0d',border:`1px solid ${pc}28`,
                  borderRadius:9,position:'relative',overflow:'hidden' }}>
                  <div style={{ position:'absolute',top:0,left:0,right:0,height:1,
                    background:`linear-gradient(90deg,transparent,${pc}55,transparent)` }} />
                  <div style={{ display:'flex',alignItems:'center',
                    gap:7,marginBottom:6 }}>
                    <div style={{ width:6,height:6,borderRadius:'50%',
                      background:pc,boxShadow:`0 0 6px ${pc}`,flexShrink:0 }} />
                    <span style={{ fontSize:9,fontFamily:'monospace',color:pc,
                      fontWeight:700,letterSpacing:'0.06em',
                      textTransform:'uppercase' }}>{inf.provider||'INFRA'}</span>
                    <span style={{ fontSize:12,fontFamily:'monospace',
                      color:'#f1f5f9',fontWeight:700 }}>{inf.name}</span>
                  </div>
                  {[['Resource Type',inf.resourceType],['Region',inf.region]]
                    .filter(([,v])=>v).map(([k,v])=>(
                    <div key={k} style={{ display:'flex',gap:8,
                      marginBottom:3,alignItems:'baseline' }}>
                      <span style={{ fontSize:8,color:'#334155',fontFamily:'monospace',
                        fontWeight:700,letterSpacing:'0.07em',minWidth:88 }}>{k}</span>
                      <span style={{ fontSize:10,color:'#94a3b8',
                        fontFamily:'monospace' }}>{v}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {/* Connections */}
        {[['OUTBOUND',out],['INBOUND',inc]].map(([dir,list])=>
          list.length>0&&(
            <div key={dir} style={{ marginBottom:12 }}>
              <div style={{ fontSize:8,color:'#1e3a5f',fontFamily:'monospace',
                letterSpacing:'0.1em',fontWeight:700,marginBottom:7 }}>
                {dir} ({list.length})
              </div>
              {list.map((e,i)=>(
                <div key={i} style={{ display:'flex',alignItems:'center',gap:7,
                  padding:'6px 10px',marginBottom:5,borderRadius:7,
                  background:(e.data?.color||'#334155')+'0d',
                  border:`1px solid ${e.data?.color||'#334155'}25` }}>
                  <div style={{ width:5,height:5,borderRadius:'50%',
                    background:e.data?.color,flexShrink:0 }} />
                  <span style={{ fontSize:10,color:e.data?.color,
                    fontFamily:'monospace',fontWeight:700 }}>
                    {e.data?.label||(dir==='OUTBOUND'?'→':'←')}
                  </span>
                  <span style={{ fontSize:10,color:'#94a3b8',fontFamily:'monospace',
                    marginLeft:'auto',maxWidth:130,overflow:'hidden',
                    textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                    {nodeLabel(dir==='OUTBOUND'?e.target:e.source)}
                  </span>
                </div>
              ))}
            </div>
          )
        )}

        {infra.length===0&&out.length===0&&inc.length===0&&(
          <div style={{ fontSize:10,color:'#1e3a5f',fontFamily:'monospace',
            textAlign:'center',padding:'12px 0' }}>
            No connections or deployments
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function GraphPage() {
  const [nodes,setNodes,onNodesChange] = useNodesState([])
  const [edges,setEdges,onEdgesChange] = useEdgesState([])
  const [allNodes, setAllNodes] = useState([])
  const [allEdges, setAllEdges] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [selected, setSelected] = useState(null)
  const [filter,   setFilter]   = useState('all')
  const [counts,   setCounts]   = useState({ apps:0,comps:0,infra:0,edges:0 })

  const loadGraph = useCallback(()=>{
    setLoading(true); setError(null)
    api.graph.topology()
      .then(topology=>{
        const { nodes:n, edges:e } = buildGraph(topology)
        setAllNodes(n); setAllEdges(e); setNodes(n); setEdges(e)
        setCounts({
          apps:  topology.apps.length,
          comps: topology.components.length,
          infra: (topology.infra||[]).length,
          edges: e.length,
        })
      })
      .catch(err=>{ console.error('[graph]',err); setError(err.message) })
      .finally(()=>setLoading(false))
  },[])

  useEffect(()=>{
    loadGraph()
    const onVis=()=>{ if(document.visibilityState==='visible') loadGraph() }
    document.addEventListener('visibilitychange',onVis)
    window.addEventListener('focus',onVis)
    return ()=>{
      document.removeEventListener('visibilitychange',onVis)
      window.removeEventListener('focus',onVis)
    }
  },[loadGraph])

  useEffect(()=>{
    if(filter==='all'){ setNodes(allNodes); setEdges(allEdges); return }
    const vis = allNodes.filter(n=>
      n.data.nodeType===filter||
      (filter==='Component'&&n.data.nodeType==='Application'))
    const ids = new Set(vis.map(n=>n.id))
    setNodes(vis)
    setEdges(allEdges.filter(e=>ids.has(e.source)&&ids.has(e.target)))
  },[filter,allNodes,allEdges])

  const onNodeClick  = useCallback((_,n)=>{ if(n.type==='comp') setSelected(n) },[])
  const onPaneClick  = useCallback(()=>setSelected(null),[])

  return (
    <div style={{ width:'100%',height:'100vh',
      background:'radial-gradient(ellipse at 15% 40%,#05101e 0%,#020810 65%)',
      display:'flex',flexDirection:'column',fontFamily:'monospace' }}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .react-flow__attribution{display:none!important}
        .react-flow__handle{opacity:0!important;pointer-events:none!important;
          width:4px!important;height:4px!important}
        .react-flow__controls button{background:#04080f!important;
          border-color:#081428!important;color:#475569!important}
        .react-flow__controls button:hover{background:#080f1a!important}
      `}</style>

      {/* Top bar */}
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'9px 18px',borderBottom:'1px solid #081428',
        background:'#02060eee',zIndex:5,flexShrink:0,gap:16 }}>
        <div style={{ display:'flex',alignItems:'center',gap:10 }}>
          <div style={{ width:7,height:7,borderRadius:'50%',background:'#22c55e',
            boxShadow:'0 0 10px #22c55e',animation:'pulse 2s infinite' }} />
          <span style={{ fontSize:13,fontWeight:700,color:'#e2e8f0' }}>
            Infrastructure Graph
          </span>
          <span style={{ fontSize:10,color:'#0f2040' }}>· LIVE TOPOLOGY</span>
        </div>

        <div style={{ display:'flex',gap:1 }}>
          {[['APPS',counts.apps,'#22c55e'],['COMPONENTS',counts.comps,'#38bdf8'],
            ['INFRA',counts.infra,'#6b7280'],['EDGES',counts.edges,'#a78bfa']]
            .map(([l,v,color],i,arr)=>(
              <div key={l} style={{ padding:'5px 14px',background:'#080f1a',
                border:'1px solid #081428',borderLeft:i>0?'none':undefined,
                borderRadius:i===0?'8px 0 0 8px':i===arr.length-1?'0 8px 8px 0':0,
                display:'flex',flexDirection:'column',alignItems:'center',gap:1 }}>
                <span style={{ fontSize:16,fontWeight:800,color,
                  fontFamily:'monospace' }}>{v}</span>
                <span style={{ fontSize:7,color:'#1e3a5f',letterSpacing:'0.1em' }}>{l}</span>
              </div>
            ))}
        </div>

        <div style={{ display:'flex',gap:6,alignItems:'center' }}>
          {[['all','All'],['Application','Apps'],['Component','Components']]
            .map(([key,label])=>(
              <button key={key} onClick={()=>setFilter(key)} style={{
                padding:'5px 12px',borderRadius:6,cursor:'pointer',
                fontFamily:'monospace',fontWeight:600,fontSize:11,
                border:`1px solid ${filter===key?'#22c55e55':'#081428'}`,
                background:filter===key?'#22c55e12':'transparent',
                color:filter===key?'#22c55e':'#334155',transition:'all .15s',
              }}>{label}</button>
            ))}
          <button onClick={loadGraph} style={{ padding:'5px 11px',background:'#080f1a',
            border:'1px solid #081428',borderRadius:6,color:'#475569',
            fontSize:14,cursor:'pointer' }}>↺</button>
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex:1,position:'relative' }}>
        {loading?(
          <div style={{ position:'absolute',inset:0,display:'flex',
            flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14 }}>
            <div style={{ width:36,height:36,borderRadius:'50%',
              border:'2px solid #081428',borderTop:'2px solid #22c55e',
              animation:'spin .7s linear infinite' }} />
            <span style={{ fontSize:10,color:'#1e3a5f',letterSpacing:'0.12em' }}>
              LOADING TOPOLOGY…
            </span>
          </div>
        ):error?(
          <div style={{ position:'absolute',inset:0,display:'flex',
            flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12 }}>
            <div style={{ fontSize:11,color:'#f43f5e',fontFamily:'monospace' }}>{error}</div>
            <button onClick={loadGraph} style={{ padding:'7px 16px',
              background:'#f43f5e15',border:'1px solid #f43f5e44',
              borderRadius:8,color:'#f43f5e',fontFamily:'monospace',
              fontSize:11,cursor:'pointer' }}>Retry</button>
          </div>
        ):nodes.length===0?(
          <div style={{ position:'absolute',inset:0,display:'flex',
            alignItems:'center',justifyContent:'center' }}>
            <span style={{ fontSize:11,color:'#1e3a5f',fontFamily:'monospace' }}>
              No data yet — add applications and components first
            </span>
          </div>
        ):(
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
        <NodePanel node={selected} allEdges={allEdges} allNodes={allNodes}
          onClose={()=>setSelected(null)} />
      </div>
    </div>
  )
}