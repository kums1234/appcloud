// services/cmdb-assessment/matcher.js
//
// Deterministic match ladder for :CmdbCi → :Infra resolution. Three stages:
//
//   1. Exact key match on the strong identifiers ServiceNow stores (in
//      decreasing priority): cloud_id → fqdn → ip_address.
//   2. Entropy-gated fuzzy name match via MinHash + LSH + Jaccard
//      (minhash.js).
//   3. No match — the CI is considered unrepresented.
//
// Each positive result carries `matchType`, `confidence`, and an
// `evidence` string so the :REPRESENTS edge is fully traceable per the
// CLAUDE.md traceability contract.

import { buildLshIndex, resolveByName } from './minhash.js'

// Confidence by match type. Higher = stronger; mirrors the scoring
// convention already used by the suggest engine (RG 45–75, ASP 80).
export const MATCH_CONFIDENCE = {
  exact_cloud_id: 95,
  exact_fqdn:     90,
  exact_ip:       80,
  exact_normalized_name: 75,   // equal normalised name, no entropy concern
  fuzzy_name:     70,          // MinHash/LSH + Jaccard ≥ threshold
}

// ── Index builder ───────────────────────────────────────────────────────────
//
// infraNodes: Array<{ id, name, cloud_id?, fqdn?, ip_address?, privateIp? }>
//
// Returns a struct reused across every CI resolution in one assessment pass.
export function buildInfraIndex(infraNodes) {
  const byCloudId = new Map()
  const byFqdn    = new Map()
  const byIp      = new Map()
  const lsh       = buildLshIndex(infraNodes)

  for (const n of infraNodes) {
    if (!n?.id) continue
    if (n.cloud_id) byCloudId.set(String(n.cloud_id).toLowerCase(), n.id)
    if (n.fqdn)     byFqdn.set(String(n.fqdn).toLowerCase(), n.id)
    // :Infra nodes store their primary IP under various names depending on
    // provider — try the usual suspects without committing to one canonical
    // property (that normalisation is a separate concern).
    const ip = n.ip_address || n.privateIp || n.private_ip || n.publicIp
    if (ip) byIp.set(String(ip), n.id)
  }

  return { byCloudId, byFqdn, byIp, lsh, size: infraNodes.length }
}

// ── Resolver ────────────────────────────────────────────────────────────────
//
// ci: :CmdbCi property bag. The fields we use: cloud_id, fqdn,
// ip_address, name.
//
// Returns { infraId, matchType, confidence, evidence } or null.
export function matchCiToInfra(ci, index, opts = {}) {
  if (!ci || !index) return null

  // Stage 1 — exact keys (priority order).
  if (ci.cloud_id) {
    const hit = index.byCloudId.get(String(ci.cloud_id).toLowerCase())
    if (hit) {
      return {
        infraId:    hit,
        matchType:  'exact_cloud_id',
        confidence: MATCH_CONFIDENCE.exact_cloud_id,
        evidence:   `cloud_id '${ci.cloud_id}' matches Infra.cloud_id`,
      }
    }
  }
  if (ci.fqdn) {
    const hit = index.byFqdn.get(String(ci.fqdn).toLowerCase())
    if (hit) {
      return {
        infraId:    hit,
        matchType:  'exact_fqdn',
        confidence: MATCH_CONFIDENCE.exact_fqdn,
        evidence:   `fqdn '${ci.fqdn}' matches Infra.fqdn`,
      }
    }
  }
  if (ci.ip_address) {
    const hit = index.byIp.get(String(ci.ip_address))
    if (hit) {
      return {
        infraId:    hit,
        matchType:  'exact_ip',
        confidence: MATCH_CONFIDENCE.exact_ip,
        evidence:   `ip_address '${ci.ip_address}' matches Infra IP`,
      }
    }
  }

  // Stage 2 — entropy-gated fuzzy name match.
  if (ci.name) {
    const nameHit = resolveByName(ci.name, index.lsh, opts)
    if (nameHit) {
      const conf = MATCH_CONFIDENCE[nameHit.matchType] ?? MATCH_CONFIDENCE.fuzzy_name
      return {
        infraId:    nameHit.candidateId,
        matchType:  nameHit.matchType,
        confidence: conf,
        evidence:   nameHit.matchType === 'exact_normalized_name'
          ? `normalised name '${ci.name}' matches Infra name`
          : `fuzzy name match '${ci.name}' (Jaccard ${nameHit.jaccard.toFixed(2)})`,
      }
    }
  }

  return null
}
