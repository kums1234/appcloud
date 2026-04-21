'use client'

export const dynamic = 'force-dynamic'
import { useState, useEffect, useCallback } from 'react'
import { api } from '../../../lib/api'
import { useTheme, getT } from '@/lib/theme'

const T = getT('dark')
const mono = { fontFamily: 'monospace' }

const TIER_COLOR  = { 1: T.red, 2: T.amber, 3: T.green, 4: T.muted }
const SEV_COLOR   = { CRITICAL: T.red, HIGH: T.orange, MEDIUM: T.amber, LOW: T.green }
const STATUS_COLOR = { approved: T.green, rejected: T.red, draft: T.amber, in_review: T.blue }

// ── Helpers ────────────────────────────────────────────────────────────────────

function Spinner({ color = T.teal, size = 18 }) {
  return (
    <>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%',
        border: `2px solid ${T.border2}`, borderTopColor: color,
        animation: 'spin .7s linear infinite', flexShrink: 0 }} />
    </>
  )
}

function useFetch(fn) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const load = useCallback(() => {
    setLoading(true)
    fn().then(setData).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

function ScoreRing({ score, size = 80 }) {
  const r = (size / 2) - 8
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score || 0))
  const col = pct >= 80 ? T.green : pct >= 60 ? T.amber : T.red
  return (
    <svg width={size} height={size}>
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={T.border2} strokeWidth={6} />
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={col} strokeWidth={6}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset .6s ease' }} />
      <text x={size/2} y={size/2 + 5}
        textAnchor="middle" fill={col}
        style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 800 }}>{pct}%</text>
    </svg>
  )
}

function relTime(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Card wrapper ──────────────────────────────────────────────────────────────

function Card({ children, glow, glowColor, style = {} }) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${glow ? glowColor + '44' : T.border}`,
      borderRadius: 12, padding: '18px 20px',
      boxShadow: glow ? `0 0 24px ${glowColor}15` : 'none',
      transition: 'all .15s', ...style,
    }}>
      {children}
    </div>
  )
}

function SectionLabel({ children, color = T.muted }) {
  return (
    <div style={{
      ...mono, fontSize: 9, fontWeight: 700, color,
      letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12,
    }}>{children}</div>
  )
}

// ── Agent Status Banner ───────────────────────────────────────────────────────

function AgentBanner({ aiStatus, discoverySummary }) {
  const localOk = aiStatus?.local?.available
  const cloudOk = aiStatus?.cloud?.available
  const anyOnline = localOk || cloudOk
  const disc = discoverySummary

  const totalDiscovered = disc
    ? (disc.byProvider?.aws?.total || 0) + (disc.byProvider?.azure?.total || 0) + (disc.byProvider?.gcp?.total || 0)
    : 0
  const mapped = disc?.mapped ?? 0
  const unmapped = disc?.unmapped ?? 0

  return (
    <Card glow={anyOnline} glowColor={T.teal}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* Agent status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: anyOnline ? `${T.teal}18` : `${T.dim}18`,
            border: `1.5px solid ${anyOnline ? T.teal + '44' : T.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>
            {anyOnline ? '⚡' : '○'}
          </div>
          <div>
            <div style={{ ...mono, fontSize: 12, fontWeight: 700, color: anyOnline ? T.teal : T.dim }}>
              AI Agents {anyOnline ? 'Online' : 'Offline'}
            </div>
            <div style={{ ...mono, fontSize: 9, color: T.muted, marginTop: 2 }}>
              Local {localOk ? '●' : '○'} · Cloud {cloudOk ? '●' : '○'}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 32, background: T.border }} />

        {/* Discovery stats */}
        <div style={{ display: 'flex', gap: 20 }}>
          <div>
            <div style={{ ...mono, fontSize: 18, fontWeight: 800, color: T.text }}>{totalDiscovered}</div>
            <div style={{ ...mono, fontSize: 8, color: T.muted }}>Discovered</div>
          </div>
          <div>
            <div style={{ ...mono, fontSize: 18, fontWeight: 800, color: T.green }}>{mapped}</div>
            <div style={{ ...mono, fontSize: 8, color: T.muted }}>Mapped</div>
          </div>
          <div>
            <div style={{ ...mono, fontSize: 18, fontWeight: 800, color: unmapped > 0 ? T.amber : T.green }}>{unmapped}</div>
            <div style={{ ...mono, fontSize: 8, color: T.muted }}>Unmapped</div>
          </div>
        </div>

        {/* Provider badges */}
        {disc && (
          <>
            <div style={{ width: 1, height: 32, background: T.border }} />
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { label: 'AWS',   count: disc.byProvider?.aws?.total ?? 0, color: '#f59e0b' },
                { label: 'Azure', count: disc.byProvider?.azure?.total ?? 0, color: '#38bdf8' },
                { label: 'GCP',   count: disc.byProvider?.gcp?.total ?? 0, color: '#22c55e' },
              ].map(p => (
                <div key={p.label} style={{
                  ...mono, fontSize: 9, fontWeight: 700,
                  color: p.color, background: p.color + '15',
                  border: `1px solid ${p.color}33`,
                  borderRadius: 5, padding: '4px 10px',
                }}>
                  {p.label} {p.count}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

// ── Agent Pipeline ───────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  { id: 'discovery',   label: 'Discovery',    icon: '◎', color: T.teal,   description: 'Scan cloud accounts',
    run: () => api.discovery.scanAll({}),
    summary: r => `${r.total ?? 0} resources from ${r.accounts ?? 0} account(s)` },
  { id: 'mapping',     label: 'Mapping',      icon: '◈', color: T.purple, description: 'Link resources to apps',
    run: () => api.discovery.bootstrap({}),
    summary: r => `${r.appsCreated ?? 0} apps, ${r.linked ?? 0} linked` },
  { id: 'onboarding',  label: 'Onboarding',   icon: '⬡', color: T.blue,   description: 'Create apps & components',
    run: () => api.discovery.bootstrap({ strategy: 'name-heuristics' }),
    summary: r => `${r.appsCreated ?? 0} apps, ${r.componentsCreated ?? 0} components` },
  { id: 'blastRadius', label: 'Blast Radius', icon: '⟳', color: T.amber,  description: 'Analyse change impact',
    run: () => api.workflows.drift(),
    summary: r => {
      const total = r.graphTerraformResources ?? 0
      const stale = r.staleResources ?? 0
      const pct = total ? Math.round((total - stale) / total * 100) : 100
      return `${pct}% coverage, ${stale} unmapped`
    }},
]

function AgentPipeline({ onComplete }) {
  const [stages, setStages] = useState(() =>
    PIPELINE_STAGES.map(() => ({ status: 'idle', result: null, error: null }))
  )
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState(null)

  const updateStage = (idx, patch) =>
    setStages(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s))

  const runFrom = async (startIdx) => {
    if (running) return
    setRunning(true)
    // Reset stages from startIdx onward
    setStages(prev => prev.map((s, i) => i >= startIdx ? { status: 'idle', result: null, error: null } : s))

    for (let i = startIdx; i < PIPELINE_STAGES.length; i++) {
      updateStage(i, { status: 'running', result: null, error: null })
      try {
        const result = await PIPELINE_STAGES[i].run()
        updateStage(i, { status: 'done', result })
      } catch (err) {
        updateStage(i, { status: 'error', error: err.message || 'Failed' })
        break // stop pipeline on error
      }
    }
    setRunning(false)
    setLastRun(new Date().toISOString())
    onComplete?.()
  }

  const STATUS_ICON = {
    idle:    { symbol: '○', color: T.muted },
    running: { symbol: null, color: T.teal },  // spinner
    done:    { symbol: '✓', color: T.green },
    error:   { symbol: '✗', color: T.red },
  }

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <SectionLabel color={T.teal}>Agent Pipeline</SectionLabel>
        <button
          onClick={() => runFrom(0)}
          disabled={running}
          style={{
            ...mono, fontSize: 10, fontWeight: 700,
            padding: '5px 14px', borderRadius: 6,
            background: running ? T.surface2 : `${T.teal}18`,
            border: `1px solid ${running ? T.border : T.teal + '44'}`,
            color: running ? T.dim : T.teal,
            cursor: running ? 'wait' : 'pointer',
            transition: 'all .15s',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {running ? (
            <>
              <span style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                border: `1.5px solid ${T.border2}`, borderTopColor: T.teal,
                animation: 'spin .7s linear infinite',
              }} />
              Running...
            </>
          ) : '▶ Run All'}
        </button>
      </div>

      {/* Pipeline stages */}
      <div style={{
        display: 'flex', alignItems: 'stretch', gap: 0,
      }}>
        {PIPELINE_STAGES.map((stage, idx) => {
          const state = stages[idx]
          const si = STATUS_ICON[state.status]
          const isLast = idx === PIPELINE_STAGES.length - 1
          const stageColor = state.status === 'done' ? T.green
            : state.status === 'error' ? T.red
            : state.status === 'running' ? T.teal
            : stage.color

          return (
            <div key={stage.id} style={{ flex: 1, display: 'flex', alignItems: 'stretch' }}>
              {/* Stage node */}
              <div style={{
                flex: 1, padding: '12px 14px', borderRadius: 10,
                background: state.status === 'running' ? `${T.teal}0a`
                  : state.status === 'done' ? `${T.green}08`
                  : state.status === 'error' ? `${T.red}08`
                  : T.surface2,
                border: `1px solid ${state.status === 'running' ? T.teal + '33'
                  : state.status === 'done' ? T.green + '33'
                  : state.status === 'error' ? T.red + '33'
                  : T.border}`,
                transition: 'all .2s',
                position: 'relative',
              }}>
                {/* Header row: icon + label + play button */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                    background: `${stageColor}15`, border: `1px solid ${stageColor}33`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, color: stageColor,
                  }}>
                    {state.status === 'running' ? (
                      <span style={{
                        display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
                        border: `2px solid ${T.border2}`, borderTopColor: T.teal,
                        animation: 'spin .7s linear infinite',
                      }} />
                    ) : state.status !== 'idle' ? (
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{si.symbol}</span>
                    ) : (
                      stage.icon
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: T.text }}>
                      {stage.label}
                    </div>
                    <div style={{ ...mono, fontSize: 8, color: T.dim, marginTop: 1 }}>
                      {stage.description}
                    </div>
                  </div>
                  {/* Play from here button */}
                  {!running && (
                    <button
                      onClick={(e) => { e.stopPropagation(); runFrom(idx) }}
                      title={`Run from ${stage.label}`}
                      style={{
                        width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                        background: 'transparent', border: `1px solid ${T.border}`,
                        color: T.dim, cursor: 'pointer', fontSize: 9,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all .15s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = `${stage.color}55`
                        e.currentTarget.style.color = stage.color
                        e.currentTarget.style.background = `${stage.color}10`
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = T.border
                        e.currentTarget.style.color = T.dim
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >▶</button>
                  )}
                </div>

                {/* Result / error summary */}
                {state.status === 'done' && state.result && (
                  <div style={{ ...mono, fontSize: 9, color: T.green, marginTop: 4,
                    padding: '4px 8px', background: `${T.green}0a`, borderRadius: 5,
                    border: `1px solid ${T.green}22` }}>
                    {PIPELINE_STAGES[idx].summary(state.result)}
                  </div>
                )}
                {state.status === 'error' && (
                  <div style={{ ...mono, fontSize: 9, color: T.red, marginTop: 4,
                    padding: '4px 8px', background: `${T.red}0a`, borderRadius: 5,
                    border: `1px solid ${T.red}22`,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {state.error}
                  </div>
                )}
                {state.status === 'running' && (
                  <div style={{ ...mono, fontSize: 9, color: T.teal, marginTop: 4 }}>
                    Running...
                  </div>
                )}
              </div>

              {/* Connector arrow */}
              {!isLast && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, flexShrink: 0, color: T.border2, fontSize: 14,
                }}>
                  →
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer: last run time */}
      {lastRun && (
        <div style={{ ...mono, fontSize: 8, color: T.dim, marginTop: 10, textAlign: 'right' }}>
          Last run: {relTime(lastRun)}
        </div>
      )}
    </Card>
  )
}

// ── Risks & Recommendations ──────────────────────────────────────────────────

function RisksPanel({ violations, govSummary, heatmap }) {
  const cs = govSummary?.changes || {}
  const vList = violations || []

  const bySev = vList.reduce((acc, v) => {
    acc[v.severity] = (acc[v.severity] || 0) + 1; return acc
  }, {})

  return (
    <Card style={{ height: '100%' }}>
      <SectionLabel color={T.red}>Risks & Recommendations</SectionLabel>

      {/* Severity counts */}
      {vList.length > 0 ? (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(s => bySev[s] > 0 && (
              <div key={s} style={{
                padding: '5px 10px', borderRadius: 5,
                background: SEV_COLOR[s] + '18', border: `1px solid ${SEV_COLOR[s]}44`,
                display: 'flex', alignItems: 'center', gap: 5,
              }}>
                <span style={{ ...mono, fontSize: 14, fontWeight: 800, color: SEV_COLOR[s] }}>{bySev[s]}</span>
                <span style={{ ...mono, fontSize: 8, color: SEV_COLOR[s], fontWeight: 700, letterSpacing: '0.06em' }}>{s}</span>
              </div>
            ))}
          </div>

          {/* Top violations */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {vList.slice(0, 6).map((v, i) => {
              const sc = SEV_COLOR[v.severity] || T.muted
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px', background: T.surface2,
                  border: `1px solid ${sc}22`, borderRadius: 7,
                }}>
                  <div style={{ width: 3, flexShrink: 0, alignSelf: 'stretch',
                    background: sc, borderRadius: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: T.text,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.policy?.replace(/_/g, ' ')}
                    </div>
                    <div style={{ ...mono, fontSize: 9, color: T.dim,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.resource}
                    </div>
                  </div>
                  <span style={{ ...mono, fontSize: 8, fontWeight: 700, color: sc,
                    background: sc + '18', border: `1px solid ${sc}33`,
                    borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>{v.severity}</span>
                </div>
              )
            })}
            {vList.length > 6 && (
              <a href="/governance" style={{ ...mono, fontSize: 9, color: T.muted,
                textAlign: 'center', padding: 6, textDecoration: 'none' }}>
                +{vList.length - 6} more →
              </a>
            )}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 16px', background: T.green + '0a',
          border: `1px solid ${T.green}33`, borderRadius: 8 }}>
          <span style={{ fontSize: 16 }}>✓</span>
          <span style={{ ...mono, fontSize: 11, color: T.green, fontWeight: 600 }}>
            No active policy violations
          </span>
        </div>
      )}

      {/* Compliance metrics */}
      {govSummary && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div style={{ background: T.surface2, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ ...mono, fontSize: 15, fontWeight: 800,
                color: (cs.approvalRate ?? 100) >= 80 ? T.green : T.amber }}>
                {cs.approvalRate ?? '—'}%
              </div>
              <div style={{ ...mono, fontSize: 8, color: T.muted, marginTop: 2 }}>Approval Rate</div>
            </div>
            <div style={{ background: T.surface2, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ ...mono, fontSize: 15, fontWeight: 800,
                color: (cs.highRiskUnapproved || 0) > 0 ? T.red : T.green }}>
                {cs.highRiskUnapproved ?? 0}
              </div>
              <div style={{ ...mono, fontSize: 8, color: T.muted, marginTop: 2 }}>High-Risk Unapproved</div>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Upcoming Changes ─────────────────────────────────────────────────────────

function ChangesPanel({ changes }) {
  const sorted = [...(changes || [])].sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0))

  return (
    <Card style={{ height: '100%' }}>
      <SectionLabel color={T.amber}>Upcoming Changes</SectionLabel>

      {sorted.length === 0 ? (
        <div style={{ ...mono, fontSize: 11, color: T.muted, padding: '16px 0', textAlign: 'center' }}>
          No pending changes
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {sorted.slice(0, 8).map(ch => {
            const sc = STATUS_COLOR[ch.status] || T.muted
            const rc = ch.riskScore >= 7 ? T.red : ch.riskScore >= 4 ? T.amber : T.green
            return (
              <div key={ch.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 12px', background: T.surface2,
                border: `1px solid ${T.border}`, borderRadius: 7,
              }}>
                <div style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: sc, boxShadow: `0 0 4px ${sc}`, flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...mono, fontSize: 11, fontWeight: 600, color: T.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ch.title}
                  </div>
                  <div style={{ ...mono, fontSize: 9, color: T.dim, marginTop: 1 }}>
                    {ch.submittedBy || '—'} · {ch.createdAt ? ch.createdAt.slice(0, 10) : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  <span style={{ ...mono, fontSize: 9, fontWeight: 700, color: rc,
                    background: rc + '18', border: `1px solid ${rc}33`,
                    borderRadius: 3, padding: '1px 6px' }}>
                    Risk {ch.riskScore ?? '?'}
                  </span>
                  <span style={{ ...mono, fontSize: 8, fontWeight: 700, color: sc,
                    background: sc + '18', border: `1px solid ${sc}33`,
                    borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' }}>
                    {ch.status}
                  </span>
                </div>
              </div>
            )
          })}
          {sorted.length > 8 && (
            <a href="/changes" style={{ ...mono, fontSize: 9, color: T.muted,
              textAlign: 'center', padding: 6, textDecoration: 'none' }}>
              +{sorted.length - 8} more changes →
            </a>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Quick Stats & Drift ──────────────────────────────────────────────────────

function StatsPanel({ graphSummary, drift, apps }) {
  const gs = graphSummary

  const { graphTerraformResources: total = 0, staleResources: unmapped = 0 } = drift || {}
  const mapped = total - unmapped
  const pct = total ? Math.round(mapped / total * 100) : 100
  const driftColor = unmapped === 0 ? T.green : unmapped > 5 ? T.red : T.amber

  // Tier breakdown
  const byTier = apps?.length > 0
    ? [1, 2, 3].map(t => ({
        tier: t, count: apps.filter(a => Number(a.tier) === t).length, color: TIER_COLOR[t],
      })).filter(t => t.count > 0)
    : []
  const maxTier = Math.max(...byTier.map(t => t.count), 1)

  return (
    <Card style={{ height: '100%' }}>
      <SectionLabel color={T.blue}>Overview</SectionLabel>

      {/* Quick stat grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        {[
          { label: 'Applications', value: gs?.applications ?? 0, color: T.blue, icon: '◈' },
          { label: 'Infrastructure', value: gs?.infraResources ?? 0, color: T.purple, icon: '◫' },
          { label: 'Pending Changes', value: gs?.pendingChanges ?? 0, color: gs?.pendingChanges > 0 ? T.amber : T.green, icon: '⟳' },
          { label: 'Public Infra', value: gs?.publicInfraCount ?? 0, color: gs?.publicInfraCount > 0 ? T.amber : T.green, icon: '⊕' },
        ].map(s => (
          <div key={s.label} style={{
            background: T.surface2, border: `1px solid ${T.border}`,
            borderRadius: 7, padding: '10px 12px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 14, color: s.color }}>{s.icon}</span>
            <div>
              <div style={{ ...mono, fontSize: 16, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ ...mono, fontSize: 8, color: T.muted }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Drift */}
      {drift && (
        <>
          <SectionLabel>Drift Status</SectionLabel>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ ...mono, fontSize: 9, color: T.muted }}>Graph coverage</span>
            <span style={{ ...mono, fontSize: 9, color: driftColor, fontWeight: 700 }}>{pct}%</span>
          </div>
          <div style={{ height: 5, background: T.border2, borderRadius: 3, marginBottom: 8 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: driftColor,
              borderRadius: 3, transition: 'width .4s' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {[
              { label: 'Total', value: total, color: T.text },
              { label: 'Mapped', value: mapped, color: T.green },
              { label: 'Unmapped', value: unmapped, color: driftColor },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center',
                background: T.surface2, border: `1px solid ${T.border}`,
                borderRadius: 6, padding: '6px 4px' }}>
                <div style={{ ...mono, fontSize: 14, fontWeight: 800, color: s.color }}>{s.value}</div>
                <div style={{ ...mono, fontSize: 7, color: T.muted }}>{s.label}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Tier breakdown */}
      {byTier.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <SectionLabel>App Tiers</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {byTier.map(t => (
              <div key={t.tier} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ ...mono, fontSize: 9, fontWeight: 700, color: t.color, minWidth: 36 }}>
                  Tier {t.tier}
                </div>
                <div style={{ flex: 1, height: 5, background: T.border2, borderRadius: 3 }}>
                  <div style={{ height: '100%', width: `${t.count / maxTier * 100}%`,
                    background: t.color, borderRadius: 3 }} />
                </div>
                <div style={{ ...mono, fontSize: 10, fontWeight: 700, color: t.color, minWidth: 16, textAlign: 'right' }}>
                  {t.count}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Risk Details & Recommendations ──────────────────────────────────────────
//
// Curated knowledge base mapping each governance policy to:
// - A plain-English impact statement ("what could go wrong")
// - A numeric risk rating (1-10) that refines the severity bucket
// - A list of recommended actions the user can take to remediate

const POLICY_META = {
  NO_OWNER: {
    rating: 7,
    impact: 'Without a designated owner, incidents cannot be routed to an accountable team, changes may go unreviewed, and compliance audits will flag this resource. Recovery time during outages increases significantly.',
    recommendations: [
      'Assign a team or individual as owner via the Applications page',
      'Update the appcloud:owner tag on the underlying cloud resource and re-run discovery',
      'Document ownership in your internal CMDB or team wiki',
    ],
  },
  HIGH_RISK_UNAPPROVED: {
    rating: 9,
    impact: 'A high-risk change affecting a Tier-1 application is pending without approval. Deploying without independent review risks outages to business-critical systems with no audit trail.',
    recommendations: [
      'Route the change through the approval workflow',
      'Request sign-off from the application owner and on-call engineer',
      'Schedule a deployment window with a documented rollback plan',
    ],
  },
  PUBLIC_INFRA_TIER1: {
    rating: 8,
    impact: 'A Tier-1 application component is exposed to the public internet. A misconfigured security group, unpatched service, or zero-day vulnerability could lead to a breach of business-critical data.',
    recommendations: [
      'Move the workload behind a load balancer, API gateway, or private link',
      'Verify security groups restrict inbound traffic to the minimum required IPs and ports',
      'Add a WAF in front of the service if it accepts user input',
      'Enable detailed access logging and alerting on anomalies',
    ],
  },
  CONFIDENTIAL_ON_PUBLIC_INFRA: {
    rating: 9,
    impact: 'Confidential or restricted data is on public-facing infrastructure. This can trigger regulatory violations (GDPR, PCI-DSS, HIPAA) and expose sensitive information through misconfiguration.',
    recommendations: [
      'Immediately restrict public access or migrate the workload to a private subnet',
      'Audit the data flow and confirm encryption at rest and in transit',
      'Notify your security and compliance teams and initiate the standard breach-assessment process',
    ],
  },
  NO_DEPLOYMENT_RECORD: {
    rating: 5,
    impact: 'A Tier-1 application has no infrastructure deployment recorded. Blast-radius analysis cannot determine impact of infrastructure changes, and incident response will be delayed.',
    recommendations: [
      'Link at least one component to a deployed infrastructure resource',
      'Run the Mapping agent on the Command Center to auto-link by tags',
      'Update your Terraform state and re-import via Integrations → Terraform',
    ],
  },
  SELF_APPROVED: {
    rating: 7,
    impact: 'A change was submitted and approved by the same user. This bypasses segregation-of-duties controls and creates an audit/compliance risk. Change governance is effectively disabled for this workflow.',
    recommendations: [
      'Require a separate reviewer for every change before approval',
      'Rollback the approval and route the change through the normal workflow',
      'Update RBAC or workflow policy to block self-approval at the system level',
    ],
  },
}

// Humanise policy IDs (e.g. NO_OWNER → "Missing Application Owner")
const POLICY_TITLES = {
  NO_OWNER:                    'Missing Application Owner',
  HIGH_RISK_UNAPPROVED:        'High-Risk Change Unapproved',
  PUBLIC_INFRA_TIER1:          'Public Infrastructure on Tier-1 App',
  CONFIDENTIAL_ON_PUBLIC_INFRA:'Confidential Data Publicly Exposed',
  NO_DEPLOYMENT_RECORD:        'Tier-1 App Missing Deployment',
  SELF_APPROVED:               'Self-Approved Change',
}

function RiskDetails({ violations, changes }) {
  const [filter, setFilter] = useState('ALL')

  // Combine governance violations + high-risk pending changes into a unified list
  const risks = []

  for (const v of violations || []) {
    const meta = POLICY_META[v.policy] || {}
    risks.push({
      id: `${v.policy}-${v.resourceId || v.resourceName}`,
      severity: v.severity,
      rating: meta.rating ?? (v.severity === 'CRITICAL' ? 9 : v.severity === 'HIGH' ? 7 : v.severity === 'MEDIUM' ? 5 : 3),
      title: POLICY_TITLES[v.policy] || v.policy?.replace(/_/g, ' '),
      description: v.description || '',
      resource: v.resourceName || v.resourceId || '—',
      resourceType: v.resourceType || 'Resource',
      impact: meta.impact || 'This policy violation reduces overall compliance posture and may indicate a governance gap.',
      recommendations: meta.recommendations || [
        'Review the resource in the Governance page',
        'Coordinate with the application owner to resolve',
      ],
    })
  }

  // Add high-risk pending changes not already tracked by policy
  const highRiskChanges = (changes || []).filter(c => (c.riskScore || 0) >= 7 && c.status !== 'approved' && c.status !== 'rejected')
  for (const ch of highRiskChanges) {
    risks.push({
      id: `CHANGE-${ch.id}`,
      severity: ch.riskScore >= 9 ? 'CRITICAL' : 'HIGH',
      rating: Math.min(10, ch.riskScore),
      title: `Pending High-Risk Change`,
      description: ch.title || 'Change with high risk score is awaiting action',
      resource: ch.title || ch.id,
      resourceType: 'Change',
      impact: `This change has a risk score of ${ch.riskScore}/10 and is in "${ch.status}" state. If deployed without review, it could impact connected applications and infrastructure.`,
      recommendations: [
        'Review the blast radius on the Changes page',
        'Require explicit approval from the application owner',
        'Ensure a rollback plan is documented before deployment',
      ],
    })
  }

  // Sort by rating desc
  risks.sort((a, b) => b.rating - a.rating)

  // Severity counts
  const counts = { ALL: risks.length, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  for (const r of risks) counts[r.severity] = (counts[r.severity] || 0) + 1

  const filtered = filter === 'ALL' ? risks : risks.filter(r => r.severity === filter)

  if (risks.length === 0) {
    return (
      <Card>
        <SectionLabel color={T.green}>Risk Details & Recommendations</SectionLabel>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px', background: `${T.green}0a`,
          border: `1px solid ${T.green}33`, borderRadius: 10,
        }}>
          <span style={{ fontSize: 18 }}>✓</span>
          <div>
            <div style={{ ...mono, fontSize: 12, fontWeight: 700, color: T.green }}>
              All clear — no active risks detected
            </div>
            <div style={{ ...mono, fontSize: 10, color: T.dim, marginTop: 2 }}>
              No policy violations or high-risk changes require attention.
            </div>
          </div>
        </div>
      </Card>
    )
  }

  const FILTER_TABS = [
    { id: 'ALL', label: 'All', color: T.text },
    { id: 'CRITICAL', label: 'Critical', color: T.red },
    { id: 'HIGH', label: 'High', color: T.orange },
    { id: 'MEDIUM', label: 'Medium', color: T.amber },
    { id: 'LOW', label: 'Low', color: T.green },
  ]

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <SectionLabel color={T.red}>Risk Details & Recommendations</SectionLabel>
        <div style={{ display: 'flex', gap: 4 }}>
          {FILTER_TABS.map(tab => {
            const count = counts[tab.id] || 0
            const active = filter === tab.id
            const isEmpty = count === 0 && tab.id !== 'ALL'
            return (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                disabled={isEmpty}
                style={{
                  ...mono, fontSize: 9, fontWeight: 700,
                  padding: '4px 10px', borderRadius: 5,
                  background: active ? `${tab.color}22` : 'transparent',
                  border: `1px solid ${active ? tab.color + '55' : T.border}`,
                  color: isEmpty ? T.dim : (active ? tab.color : T.muted),
                  cursor: isEmpty ? 'default' : 'pointer',
                  opacity: isEmpty ? 0.4 : 1,
                  transition: 'all .15s',
                }}
              >
                {tab.label} · {count}
              </button>
            )
          })}
        </div>
      </div>

      {/* Risk cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map(r => {
          const sc = SEV_COLOR[r.severity] || T.muted
          return (
            <div key={r.id} style={{
              background: T.surface2, border: `1px solid ${sc}33`,
              borderRadius: 10, padding: '14px 16px',
              position: 'relative',
            }}>
              {/* Left accent bar */}
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
                background: sc, borderRadius: '10px 0 0 10px',
              }} />

              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8, paddingLeft: 8 }}>
                {/* Rating badge */}
                <div style={{
                  flexShrink: 0, width: 48, height: 48, borderRadius: 8,
                  background: `${sc}15`, border: `1px solid ${sc}44`,
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <div style={{ ...mono, fontSize: 16, fontWeight: 800, color: sc, lineHeight: 1 }}>
                    {r.rating}
                  </div>
                  <div style={{ ...mono, fontSize: 7, color: sc, opacity: 0.8, marginTop: 2 }}>
                    / 10
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{
                      ...mono, fontSize: 8, fontWeight: 700, color: sc,
                      background: `${sc}18`, border: `1px solid ${sc}33`,
                      borderRadius: 3, padding: '2px 6px',
                      letterSpacing: '0.06em',
                    }}>
                      {r.severity}
                    </span>
                    <span style={{ ...mono, fontSize: 8, color: T.dim, letterSpacing: '0.06em' }}>
                      {r.resourceType.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ ...mono, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 2 }}>
                    {r.title}
                  </div>
                  <div style={{ ...mono, fontSize: 10, color: T.dim,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Resource: <span style={{ color: T.muted }}>{r.resource}</span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div style={{ ...mono, fontSize: 11, color: T.text, lineHeight: 1.5,
                paddingLeft: 8, marginBottom: 8 }}>
                {r.description}
              </div>

              {/* Impact */}
              <div style={{
                paddingLeft: 8, paddingRight: 4, marginBottom: 8,
              }}>
                <div style={{ ...mono, fontSize: 8, fontWeight: 700, color: sc,
                  letterSpacing: '0.12em', marginBottom: 4 }}>
                  IMPACT
                </div>
                <div style={{ ...mono, fontSize: 11, color: T.muted, lineHeight: 1.5,
                  fontStyle: 'italic' }}>
                  {r.impact}
                </div>
              </div>

              {/* Recommendations */}
              <div style={{ paddingLeft: 8, paddingRight: 4 }}>
                <div style={{ ...mono, fontSize: 8, fontWeight: 700, color: T.teal,
                  letterSpacing: '0.12em', marginBottom: 4 }}>
                  RECOMMENDED ACTIONS
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, ...mono, fontSize: 11,
                  color: T.text, lineHeight: 1.6 }}>
                  {r.recommendations.map((rec, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>{rec}</li>
                  ))}
                </ul>
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer hint */}
      <div style={{ ...mono, fontSize: 9, color: T.dim, marginTop: 10, textAlign: 'right' }}>
        Showing {filtered.length} of {risks.length} risks
      </div>
    </Card>
  )
}

// ── Agent Activity Feed ──────────────────────────────────────────────────────

function ActivityFeed({ violations, drift, discoverySummary, changes }) {
  const items = []

  // Violations as agent-detected items
  if (violations?.length > 0) {
    const critCount = violations.filter(v => v.severity === 'CRITICAL').length
    const highCount = violations.filter(v => v.severity === 'HIGH').length
    items.push({
      icon: '⚖', color: critCount > 0 ? T.red : T.amber,
      text: `Agent detected ${violations.length} policy violation${violations.length > 1 ? 's' : ''}${critCount > 0 ? ` (${critCount} critical)` : highCount > 0 ? ` (${highCount} high)` : ''}`,
      type: 'governance',
    })
  }

  // Drift
  if (drift?.staleResources > 0) {
    items.push({
      icon: '⧖', color: T.amber,
      text: `Agent found ${drift.staleResources} unmapped infrastructure resource${drift.staleResources > 1 ? 's' : ''} — drift detection recommended`,
      type: 'drift',
    })
  }

  // Discovery
  if (discoverySummary) {
    const total = (discoverySummary.byProvider?.aws?.total || 0) +
      (discoverySummary.byProvider?.azure?.total || 0) +
      (discoverySummary.byProvider?.gcp?.total || 0)
    const providers = ['aws', 'azure', 'gcp'].filter(p => (discoverySummary.byProvider?.[p]?.total || 0) > 0)
    if (total > 0) {
      items.push({
        icon: '◎', color: T.teal,
        text: `Agent discovered ${total} resources across ${providers.length} provider${providers.length > 1 ? 's' : ''} (${providers.join(', ').toUpperCase()})`,
        type: 'discovery',
      })
    }
  }

  // High-risk changes
  const highRisk = (changes || []).filter(c => (c.riskScore || 0) >= 7)
  if (highRisk.length > 0) {
    items.push({
      icon: '⟳', color: T.red,
      text: `${highRisk.length} high-risk change${highRisk.length > 1 ? 's' : ''} pending review — immediate attention recommended`,
      type: 'changes',
    })
  }

  // All clear
  if (items.length === 0) {
    items.push({
      icon: '✓', color: T.green,
      text: 'All systems nominal — no risks or drift detected',
      type: 'ok',
    })
  }

  return (
    <Card>
      <SectionLabel color={T.teal}>Agent Activity</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 14px', background: T.surface2,
            border: `1px solid ${item.color}22`,
            borderRadius: 8, transition: 'all .15s',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: `${item.color}15`, border: `1px solid ${item.color}33`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, color: item.color,
            }}>{item.icon}</div>
            <div style={{ flex: 1, ...mono, fontSize: 11, color: T.text, lineHeight: 1.5 }}>
              {item.text}
            </div>
            <div style={{
              ...mono, fontSize: 8, fontWeight: 700, color: item.color,
              background: item.color + '15', border: `1px solid ${item.color}33`,
              borderRadius: 4, padding: '2px 8px', flexShrink: 0,
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>{item.type}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { theme } = useTheme()
  const T = getT(theme)

  const graphSummary = useFetch(() => api.graph.summary())
  const changes      = useFetch(() => api.changes.list())
  const violations   = useFetch(() => api.governance.violations())
  const govSummary   = useFetch(() => api.governance.summary())
  const heatmap      = useFetch(() => api.governance.heatmap())
  const drift        = useFetch(() => api.workflows.drift())
  const apps         = useFetch(() => api.applications.list())
  const discSummary  = useFetch(() => api.discovery.summary())
  const aiStatus     = useFetch(() => api.ai.status())

  // Only show the full-page spinner on the initial load (when no data exists yet).
  // On reload (e.g., after running the agent pipeline), keep showing the existing
  // UI so the pipeline component isn't unmounted and its results aren't lost.
  const initialLoading =
    !graphSummary.data && !changes.data && !violations.data &&
    (graphSummary.loading || changes.loading || violations.loading)
  const loading = initialLoading

  // Compliance score
  const cs = govSummary.data?.changes || {}
  const scoreRaw = govSummary.data
    ? (() => {
        const v = violations.data || []
        let s = 100
        s -= v.filter(x => x.severity === 'CRITICAL').length * 15
        s -= v.filter(x => x.severity === 'HIGH').length * 8
        s -= v.filter(x => x.severity === 'MEDIUM').length * 3
        if ((cs.approvalRate || 100) < 80) s -= 10
        if ((cs.highRiskUnapproved || 0) > 0) s -= 5 * cs.highRiskUnapproved
        return Math.max(0, Math.min(100, s))
      })()
    : null

  const reloadAll = () => {
    graphSummary.reload(); changes.reload(); violations.reload()
    govSummary.reload(); heatmap.reload(); drift.reload()
    apps.reload(); discSummary.reload(); aiStatus.reload()
  }

  return (
    <div style={{
      minHeight: '100vh', background: T.bg, color: T.text,
      fontFamily: 'monospace', padding: '24px 28px',
    }}>
      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
        .v2-section { animation: fadeUp .3s ease both }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 20,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800,
            letterSpacing: '-0.03em', color: T.text,
            fontFamily: "'Syne', monospace",
          }}>
            Command Center
          </h1>
          <p style={{ margin: '3px 0 0', fontSize: 10, color: T.dim }}>
            AI-powered infrastructure intelligence
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {scoreRaw !== null && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 14px', background: T.surface,
              border: `1px solid ${T.border}`, borderRadius: 10,
            }}>
              <ScoreRing score={scoreRaw} size={44} />
              <div style={{ ...mono, fontSize: 8, color: T.muted, letterSpacing: '0.1em' }}>
                COMPLIANCE
              </div>
            </div>
          )}
          <button onClick={reloadAll}
            style={{ ...mono, fontSize: 9, color: T.dim, background: 'transparent',
              border: `1px solid ${T.border}`, borderRadius: 7,
              padding: '8px 12px', cursor: 'pointer', transition: 'all .15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = `${T.teal}44`; e.currentTarget.style.color = T.teal }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.dim }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center',
          height: 300, gap: 12, color: T.muted }}>
          <Spinner size={24} />
          <span style={{ ...mono, fontSize: 12 }}>Loading command center...</span>
        </div>
      ) : (
        <>
          {/* Agent Status Banner */}
          <div className="v2-section" style={{ marginBottom: 16 }}>
            <AgentBanner aiStatus={aiStatus.data} discoverySummary={discSummary.data} />
          </div>

          {/* Agent Pipeline */}
          <div className="v2-section" style={{ marginBottom: 16, animationDelay: '30ms' }}>
            <AgentPipeline onComplete={reloadAll} />
          </div>

          {/* Three-column critical grid */}
          <div className="v2-section" style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
            gap: 14, marginBottom: 16, animationDelay: '90ms',
          }}>
            <RisksPanel
              violations={violations.data}
              govSummary={govSummary.data}
              heatmap={heatmap.data}
            />
            <ChangesPanel changes={changes.data} />
            <StatsPanel
              graphSummary={graphSummary.data}
              drift={drift.data}
              apps={apps.data}
            />
          </div>

          {/* Risk Details & Recommendations */}
          <div className="v2-section" style={{ marginBottom: 16, animationDelay: '120ms' }}>
            <RiskDetails
              violations={violations.data}
              changes={changes.data}
            />
          </div>

          {/* Agent Activity Feed */}
          <div className="v2-section" style={{ animationDelay: '180ms' }}>
            <ActivityFeed
              violations={violations.data}
              drift={drift.data}
              discoverySummary={discSummary.data}
              changes={changes.data}
            />
          </div>
        </>
      )}
    </div>
  )
}
