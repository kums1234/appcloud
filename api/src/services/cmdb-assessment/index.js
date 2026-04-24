// services/cmdb-assessment/index.js
//
// Orchestrates one full CMDB assessment pass:
//
//   1. Fetch all :Infra + :CmdbCi nodes with the fields the matcher needs.
//   2. Build an infra index (buildInfraIndex) once.
//   3. For each CI:
//        a. matchCiToInfra → null or { infraId, matchType, confidence, evidence }
//        b. check OTel activity signal (best-effort; 0 if unavailable)
//        c. scoreRelevance + scoreQuality
//        d. queue graph writes
//   4. Upsert :REPRESENTS edges in bulk with bi-temporal fields (validAt /
//      expiredAt) — per graphiti. Edges no longer supported by this pass
//      get expiredAt set (not deleted) so audit history is preserved.
//   5. Write the per-CI scores back to the :CmdbCi node.
//   6. Emit an :IngestionEpisode node tagged with the assessment run id
//      so every edge created/refreshed in this pass is retraceable.
//
// Returns a summary: counts + timings. Callers decide how to log/persist.

import { buildInfraIndex, matchCiToInfra } from './matcher.js'
import { scoreRelevance, scoreQuality, daysBetween } from './scoring.js'
import { startEpisode, finishEpisode } from '../episodes.js'

const EPISODE_SOURCE = 'cmdb-assessment'

// Batch size for UNWIND writes. Balances round-trip cost vs Bolt packet size.
const WRITE_BATCH = 500

export async function runAssessment(ctx, opts = {}) {
  const { neo4j, log } = ctx
  if (!neo4j?.query || !neo4j?.write) {
    throw new Error('runAssessment requires ctx.neo4j with query + write')
  }
  // Use shared episode helper so the :IngestionEpisode node shape matches
  // every other producer in the system.
  const episode = await startEpisode(neo4j, EPISODE_SOURCE, opts.episodeId)
  const { uuid: episodeId, startedAt } = episode
  const t0 = Date.now()

  // ── 1. Fetch :Infra + :CmdbCi ─────────────────────────────────────────────
  const infraRows = await neo4j.query(`
    MATCH (i:Infra)
    RETURN i.id AS id,
           i.name AS name,
           i.cloud_id AS cloud_id,
           i.fqdn AS fqdn,
           i.ip_address AS ip_address,
           i.privateIp AS privateIp,
           i.lastSeenAt AS lastSeenAt
  `)
  const infraNodes = infraRows.map(r => ({
    id:         r.get('id'),
    name:       r.get('name'),
    cloud_id:   r.get('cloud_id'),
    fqdn:       r.get('fqdn'),
    ip_address: r.get('ip_address'),
    privateIp:  r.get('privateIp'),
    lastSeenAt: r.get('lastSeenAt'),
  }))

  const ciRows = await neo4j.query(`
    MATCH (ci:CmdbCi)
    RETURN ci.sys_id AS sys_id,
           ci.name AS name,
           ci.cloud_id AS cloud_id,
           ci.fqdn AS fqdn,
           ci.ip_address AS ip_address,
           ci.owned_by AS owned_by,
           ci.environment AS environment,
           ci.operational_status AS operational_status,
           ci.support_group AS support_group,
           ci.sn_updated_on AS sn_updated_on,
           ci.lastSeenAt AS lastSeenAt
  `)
  const cis = ciRows.map(r => ({
    sys_id:             r.get('sys_id'),
    name:               r.get('name'),
    cloud_id:           r.get('cloud_id'),
    fqdn:               r.get('fqdn'),
    ip_address:         r.get('ip_address'),
    owned_by:           r.get('owned_by'),
    environment:        r.get('environment'),
    operational_status: r.get('operational_status'),
    support_group:      r.get('support_group'),
    sn_updated_on:      r.get('sn_updated_on'),
    lastSeenAt:         r.get('lastSeenAt'),
  }))

  log?.info?.(`[cmdb-assessment] fetched ${cis.length} CIs, ${infraNodes.length} :Infra nodes`)

  // ── 2. Build index ───────────────────────────────────────────────────────
  const index = buildInfraIndex(infraNodes)
  const infraById = new Map(infraNodes.map(n => [n.id, n]))

  // ── 3. Score + queue writes ──────────────────────────────────────────────
  const now = new Date().toISOString()
  const matched = []        // { sys_id, infraId, matchType, confidence, evidence, relevance, quality }
  const unmatched = []      // { sys_id, relevance, quality }
  const nodeUpdates = []    // { sys_id, relevance, quality, reasonsJson, assessedAt }

  for (const ci of cis) {
    const match = matchCiToInfra(ci, index)
    const matchedInfra = match ? infraById.get(match.infraId) : null
    const otelSignal = await detectOtelActivity(ctx, ci, matchedInfra).catch(() => ({ hasOtelActivity: false }))

    const rel = scoreRelevance({ match, ...otelSignal })
    const qu  = scoreQuality(ci, {
      updatedAgeDays:      ci.sn_updated_on ? daysBetween(ci.sn_updated_on, now) : null,
      matchedToLiveInfra:  !!matchedInfra,
    })

    const reasonsJson = JSON.stringify({
      relevance: rel.reasons,
      quality:   qu.reasons,
      otel:     otelSignal,
      matchType: match?.matchType || null,
    })

    nodeUpdates.push({
      sys_id:     ci.sys_id,
      relevance:  rel.score,
      quality:    qu.score,
      reasonsJson,
      assessedAt: now,
    })

    if (match) {
      matched.push({
        sys_id:     ci.sys_id,
        infraId:    match.infraId,
        matchType:  match.matchType,
        confidence: match.confidence,
        evidence:   match.evidence,
      })
    } else {
      unmatched.push({ sys_id: ci.sys_id })
    }
  }

  log?.info?.(`[cmdb-assessment] matched=${matched.length} unmatched=${unmatched.length}`)

  // ── 4. Upsert :REPRESENTS edges + expire stale ones ──────────────────────
  //
  // Upsert strategy: one edge per (CmdbCi, Infra) pair. We MERGE on the
  // pair identity; creating a new edge sets createdAt + validAt, a MATCH
  // updates lastSeenAt + confidence + evidence. Edges for CIs that no
  // longer have a match this run get expiredAt=$now via a follow-up pass.
  for (let i = 0; i < matched.length; i += WRITE_BATCH) {
    const slice = matched.slice(i, i + WRITE_BATCH)
    await neo4j.write(`
      UNWIND $rows AS row
      MATCH (ci:CmdbCi  { sys_id: row.sys_id })
      MATCH (i:Infra    { id:     row.infraId })
      MERGE (ci)-[r:REPRESENTS]->(i)
      ON CREATE SET
        r.createdAt = $now,
        r.validAt   = $now
      SET
        r.source     = 'cmdb-assessment',
        r.matchType  = row.matchType,
        r.confidence = row.confidence,
        r.evidence   = row.evidence,
        r.lastSeenAt = $now,
        r.expiredAt  = null,
        r.episodeId  = $episodeId
    `, { rows: slice, now, episodeId })
  }

  // Expire any :REPRESENTS edge whose CI wasn't matched this run (and that
  // was last seen before this run). This captures both "CI no longer
  // matches" and "CI disappeared entirely" — graphiti's expiredAt pattern.
  await neo4j.write(`
    MATCH (ci:CmdbCi)-[r:REPRESENTS]->(:Infra)
    WHERE r.source = 'cmdb-assessment'
      AND r.lastSeenAt < $now
      AND (r.expiredAt IS NULL)
    SET r.expiredAt = $now
  `, { now })

  // ── 5. Write per-CI scores back to :CmdbCi ───────────────────────────────
  for (let i = 0; i < nodeUpdates.length; i += WRITE_BATCH) {
    const slice = nodeUpdates.slice(i, i + WRITE_BATCH)
    await neo4j.write(`
      UNWIND $rows AS row
      MATCH (ci:CmdbCi { sys_id: row.sys_id })
      SET ci.relevance     = row.relevance,
          ci.quality       = row.quality,
          ci.assessedAt    = row.assessedAt,
          ci.assessEpisode = $episodeId,
          ci.assessReasons = row.reasonsJson
    `, { rows: slice, episodeId })
  }

  // ── 6. Finish the episode ────────────────────────────────────────────────
  await finishEpisode(neo4j, episode, 'ok', {
    cis:       cis.length,
    infra:     infraNodes.length,
    matched:   matched.length,
    unmatched: unmatched.length,
  })

  const finishedAt = new Date().toISOString()
  const durationMs = Date.now() - t0
  return {
    episodeId,
    startedAt,
    finishedAt,
    durationMs,
    cis:       cis.length,
    infra:     infraNodes.length,
    matched:   matched.length,
    unmatched: unmatched.length,
  }
}

// ── OTel activity probe ─────────────────────────────────────────────────────
//
// Best-effort. The OTel aggregator writes service topology to Neo4j (exact
// shape is a Slice-8 concern — we don't want to hard-depend on it). Probe
// for a node with a service-like label whose name or fqdn matches. Returns
// { hasOtelActivity, otelActivityDays } with defaults if the query fails.
async function detectOtelActivity(ctx, ci, matchedInfra) {
  // If we never matched to Infra, skip the hop — we'd have no anchor.
  if (!matchedInfra) return { hasOtelActivity: false }
  try {
    const now = Date.now()
    const rows = await ctx.neo4j.query(`
      MATCH (i:Infra { id: $infraId })
      OPTIONAL MATCH (i)<-[:DEPLOYED_ON]-(c:Component)
      WHERE c.lastSeenAt IS NOT NULL
      RETURN max(c.lastSeenAt) AS lastSeenAt
    `, { infraId: matchedInfra.id })
    const ts = rows[0]?.get?.('lastSeenAt')
    if (!ts) return { hasOtelActivity: false }
    const age = (now - new Date(ts).getTime()) / 86_400_000
    if (!Number.isFinite(age) || age < 0) return { hasOtelActivity: false }
    return { hasOtelActivity: true, otelActivityDays: age }
  } catch {
    return { hasOtelActivity: false }
  }
}
