/**
 * discovery.aws.supplement.js
 *
 * Post-scan supplement for AWS discovery. Slice 3 ships with auto-link
 * Phase 2 as the only layer (delegating to the cross-cloud helper in
 * discovery.autolink.js). Future supplement layers — VPC flow logs
 * (observed traffic) and IAM Access Analyzer (effective access) — are
 * scoped for a later slice; see
 * `docs/discovery-native-graph-slices.md`.
 *
 *   Phase 2 — Auto-link (Component → Infra ownership)
 *     Uses the structural graph populated by the primary Config
 *     scanner plus account+region co-location to infer Component
 *     ownership. Mirrors Azure (resource group) and GCP (project),
 *     scoped to AWS nodes.
 *
 * Edge-write policy: single :CONNECTS_TO {via:'component-mapping'}
 * edge with source='auto-link', provider_source='aws-enrichment',
 * confidence, rule, evidence, discovered_at / last_seen.
 */

import { autoLinkFromStructure as sharedAutoLink } from './discovery.autolink.js'

// AWS auto-link `via→score` table. Mirrors the structural confidence
// values used by the primary scanner so a VPC↔Subnet edge scores the
// same way during direct-link inference.
export const AWS_VIA_TO_AUTOLINK_SCORE = {
  'eni':            90,
  'disk':           88,
  'subnet':         65,
  'vpc':            65,
  'security-group': 55,
  'iam-role':       60,
}

// AWS co-location bucket: account+region pair. Pulled from the ARN
// (which Config-aggregator-sourced cloud_ids carry for most types) or
// from the special-cased per-type cloud_id forms (`i-…` for EC2, raw
// id for ElastiCache).
//
// Returns lowercase 'account-region' or '' when not derivable. The
// helper is exported so the `discovery.autolink` test suite can lock
// AWS-specific behaviour in a fixture.
export function accountRegionFromCloudId(cid = '') {
  if (!cid || typeof cid !== 'string') return ''
  // Standard ARN: arn:partition:service:region:account-id:resource…
  const arnMatch = cid.match(/^arn:[^:]*:[^:]*:([^:]*):([^:]*):/)
  if (arnMatch) {
    const [, region, account] = arnMatch
    if (account || region) return `${account || ''}-${region || ''}`.toLowerCase()
  }
  return ''
}

async function autoLinkFromStructure({ write, query, log, minScore = 60 }) {
  return sharedAutoLink({
    provider:              'aws',
    coLocationFromCloudId: accountRegionFromCloudId,
    coLocationLabel:       'account-region',
    viaToScore:            AWS_VIA_TO_AUTOLINK_SCORE,
    enrichmentSource:      'aws-enrichment',
    write, query, log, minScore,
  })
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * supplementAWSDiscovery(opts)
 *
 * opts:
 *   write    — Neo4j write fn
 *   query    — Neo4j query fn
 *   log      — Fastify logger
 *   layers   — (optional) reserved for future supplement layers
 *              ('vpc-flow-logs', 'iam-access-analyzer'); ignored in v1
 *   autoLink — (optional) boolean, default true
 *   minScore — (optional) number 0–100, default 60
 */
export async function supplementAWSDiscovery({
  write,
  query,
  log,
  layers   = [],
  autoLink = true,
  minScore = 60,
}) {
  log.info?.(`[AWS Supplement] Starting, layers: ${layers.join(', ') || 'none'}, autoLink: ${autoLink}`)

  if (layers.length) {
    log.warn?.(`[AWS Supplement] layers not yet implemented in slice 3: ${layers.join(', ')}`)
  }

  const results = {
    autoLink:           null,
    totalRelationships: 0,
    totalLinked:        0,
    errors:             [],
  }

  if (autoLink) {
    try {
      results.autoLink = await autoLinkFromStructure({ write, query, log, minScore })
      results.totalLinked = results.autoLink.linked
      results.errors.push(...(results.autoLink.errors || []))
    } catch (err) {
      results.errors.push(`auto-link: ${err.message}`)
    }
  }

  log.info?.(`[AWS Supplement] Complete — auto-linked: ${results.totalLinked}`)
  return results
}

// Internal exports for tests.
export const __test__ = {
  accountRegionFromCloudId,
  autoLinkFromStructure,
}
