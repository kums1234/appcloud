// services/cmdb-assessment/scoring.js
//
// Two scores per :CmdbCi row:
//
//   relevance (0–100) — does this CI represent something real and in use?
//   quality   (0–100) — how well-maintained is this CI record?
//
// Both are clamped to [0, 100]. Combination logic is localised here so it
// can be tuned in one place with fixture tests, per CLAUDE.md's rule that
// "combination logic should be reviewed before being extended".

// ── Relevance ───────────────────────────────────────────────────────────────
// Input: the ladder match (from matcher.js) + external signals.
//
// signals shape:
//   {
//     match:    { matchType, confidence } | null,   // from matchCiToInfra
//     hasOtelActivity: boolean,                     // seen in recent traces
//     otelActivityDays: number | null,              // age of most recent span
//   }
//
// Model:
//   start at 0
//   if matched → add the match confidence (see MATCH_CONFIDENCE in matcher.js)
//   if OTel activity is recent (< 7 days) → +15
//   if OTel activity is older (7–30 days) → +5
//   no match, no telemetry → 0  (unrepresented / phantom record)
export function scoreRelevance(signals) {
  let s = 0
  const reasons = []
  const m = signals?.match
  if (m?.matchType) {
    s += m.confidence || 0
    reasons.push(`matched via ${m.matchType} (+${m.confidence})`)
  }
  if (signals?.hasOtelActivity) {
    const age = signals.otelActivityDays
    if (age != null && age < 7) {
      s += 15
      reasons.push(`recent OTel activity < 7 days (+15)`)
    } else if (age != null && age < 30) {
      s += 5
      reasons.push(`OTel activity 7–30 days (+5)`)
    } else {
      s += 10   // telemetry seen, age unknown — modest boost
      reasons.push(`OTel activity recorded (+10)`)
    }
  }
  const clamped = clamp(s, 0, 100)
  if (!reasons.length) reasons.push('no match in any source')
  return { score: clamped, reasons }
}

// ── Quality ─────────────────────────────────────────────────────────────────
// Inputs: the :CmdbCi property bag + the age (in days) of sys_updated_on +
// whether the CI matched a live cloud Infra node.
//
// Model:
//   start at 100
//   deduct per missing critical field (owned_by, environment, operational_status, support_group)
//   deduct per freshness bucket (>30d, >90d, >365d)
//   deduct on the "retired but matched to a live resource" contradiction
const CRITICAL_FIELDS = ['owned_by', 'environment', 'operational_status', 'support_group']

const FIELD_PENALTY       = 15
const FRESHNESS_30D_PEN   = 5
const FRESHNESS_90D_PEN   = 15
const FRESHNESS_365D_PEN  = 30
const CONTRADICTION_PEN   = 30

export function scoreQuality(ci, { updatedAgeDays, matchedToLiveInfra = false } = {}) {
  let s = 100
  const reasons = []

  // Field completeness.
  const missing = CRITICAL_FIELDS.filter(f => !ci?.[f])
  if (missing.length) {
    const pen = Math.min(missing.length * FIELD_PENALTY, 60)
    s -= pen
    reasons.push(`missing fields [${missing.join(', ')}] (-${pen})`)
  }

  // Freshness.
  if (updatedAgeDays != null) {
    let pen = 0
    if (updatedAgeDays > 365) pen = FRESHNESS_365D_PEN
    else if (updatedAgeDays > 90)  pen = FRESHNESS_90D_PEN
    else if (updatedAgeDays > 30)  pen = FRESHNESS_30D_PEN
    if (pen) {
      s -= pen
      reasons.push(`sys_updated_on > ${updatedAgeDays.toFixed(0)} days (-${pen})`)
    }
  } else {
    s -= 5
    reasons.push('sys_updated_on missing (-5)')
  }

  // Contradiction: retired in CMDB but matched to a live resource.
  const status = String(ci?.operational_status || '').toLowerCase()
  const isRetired = status === 'retired' || status === '7' || status === 'decommissioned'
  if (isRetired && matchedToLiveInfra) {
    s -= CONTRADICTION_PEN
    reasons.push(`retired in CMDB but matched to a live :Infra (-${CONTRADICTION_PEN})`)
  }

  const clamped = clamp(s, 0, 100)
  if (!reasons.length) reasons.push('all critical fields present, record is fresh')
  return { score: clamped, reasons }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null
  const a = new Date(isoA).getTime()
  const b = new Date(isoB).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.abs(b - a) / 86_400_000
}

function clamp(v, min, max) {
  if (v < min) return min
  if (v > max) return max
  return v
}

export const SCORING = {
  CRITICAL_FIELDS,
  FIELD_PENALTY,
  FRESHNESS_30D_PEN,
  FRESHNESS_90D_PEN,
  FRESHNESS_365D_PEN,
  CONTRADICTION_PEN,
}
