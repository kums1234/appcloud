// Integration test — full CMDB assessment pipeline against a real Neo4j
// via Testcontainers. Exercises:
//
//   1. Seeding a :CmdbCi and a matching :Infra node sharing a cloud_id.
//   2. Running services/cmdb-assessment::runAssessment end-to-end.
//   3. Verifying the matcher landed on `exact_cloud_id`, the score
//      reasons made it onto the :CmdbCi node, the :REPRESENTS edge was
//      MERGEd with the right confidence + bi-temporal fields, and the
//      :IngestionEpisode node carries the run summary.
//
// Why integration: the unit tests in services/cmdb-assessment/__tests__
// cover matcher / scorer / minhash in isolation. This test locks the
// graph-level write contract (UNWIND batches, MERGE keys, expiredAt
// behaviour) that those unit tests can't reach.
//
// Skips cleanly if Docker is unavailable so the unit suite still passes
// in environments without the daemon. Run explicitly with:
//   cd api && npm run test:integration

import { test, expect, beforeAll, afterAll, jest } from '@jest/globals'
import { getMaybeDescribe, startNeo4j, wrapNeo4jDriver } from './helpers.js'

jest.setTimeout(600_000)

const maybeDescribe = getMaybeDescribe('cmdb-assessment integration')

maybeDescribe('CMDB assessment → :CmdbCi scores + :REPRESENTS + :IngestionEpisode (Testcontainers)', () => {
  let neo4jContainer, neo4jDriver, ctx

  beforeAll(async () => {
    ;({ container: neo4jContainer, driver: neo4jDriver } = await startNeo4j())
    // ctx is the minimal shape runAssessment expects — logger + a neo4j
    // wrapper with `query` / `write` mirroring the production decorators.
    ctx = {
      log: { info() {}, warn() {}, error() {} },
      neo4j: wrapNeo4jDriver(neo4jDriver),
    }
  })

  afterAll(async () => {
    try { await neo4jDriver?.close() }    catch {}
    try { await neo4jContainer?.stop() }  catch {}
  })

  test('matched CI gets a :REPRESENTS edge, scores written back, episode emitted', async () => {
    const { runAssessment } = await import('../../services/cmdb-assessment/index.js')

    // ── Seed an Infra node and a CmdbCi sharing a cloud_id (the highest-
    //    confidence matcher key) so the matcher returns exact_cloud_id. ──
    const cloudId = '/subscriptions/test-sub/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-1'
    await ctx.neo4j.write(`
      MERGE (i:Infra { id: $infraId })
      SET i.name      = $name,
          i.cloud_id  = $cloudId,
          i.provider  = 'azure',
          i.lastSeenAt = datetime()
    `, { infraId: 'infra-vm-1', name: 'vm-1', cloudId })

    await ctx.neo4j.write(`
      MERGE (ci:CmdbCi { sys_id: $sysId })
      SET ci.name               = $name,
          ci.cloud_id           = $cloudId,
          ci.sys_class_name     = 'cmdb_ci_server',
          ci.operational_status = '1',
          ci.environment        = 'production',
          ci.owned_by           = 'platform-team',
          ci.support_group      = 'platform-oncall',
          ci.sn_updated_on      = '2026-04-20 12:00:00',
          ci.lastSeenAt         = datetime()
    `, { sysId: 'sys-vm-1', name: 'vm-1', cloudId })

    // Also seed an unmatched CI to verify the unmatched accounting +
    // ensure the expire-stale pass doesn't sweep newly-created edges.
    await ctx.neo4j.write(`
      MERGE (ci:CmdbCi { sys_id: $sysId })
      SET ci.name           = $name,
          ci.sys_class_name = 'cmdb_ci_server'
    `, { sysId: 'sys-orphan', name: 'orphan-server' })

    // ── Act ──
    const summary = await runAssessment(ctx)

    // ── Run-summary contract ──
    expect(summary).toMatchObject({
      cis:       2,
      infra:     1,
      matched:   1,
      unmatched: 1,
    })
    expect(summary.episodeId).toMatch(/^[0-9a-f-]{36}$/i)

    // ── :REPRESENTS edge contract ──
    const repRows = await ctx.neo4j.query(`
      MATCH (ci:CmdbCi { sys_id: 'sys-vm-1' })-[r:REPRESENTS]->(i:Infra { id: 'infra-vm-1' })
      RETURN r.source     AS source,
             r.matchType  AS matchType,
             r.confidence AS confidence,
             r.expiredAt  AS expiredAt,
             r.episodeId  AS episodeId
    `)
    expect(repRows).toHaveLength(1)
    const r = repRows[0]
    expect(r.get('source')).toBe('cmdb-assessment')
    expect(r.get('matchType')).toBe('exact_cloud_id')
    // matcher.js MATCH_CONFIDENCE.exact_cloud_id = 95
    const conf = r.get('confidence')
    expect(typeof conf === 'object' ? conf.toNumber?.() : conf).toBe(95)
    expect(r.get('expiredAt')).toBeNull()
    expect(r.get('episodeId')).toBe(summary.episodeId)

    // ── :CmdbCi score writeback ──
    const ciRows = await ctx.neo4j.query(`
      MATCH (ci:CmdbCi { sys_id: 'sys-vm-1' })
      RETURN ci.relevance     AS relevance,
             ci.quality       AS quality,
             ci.assessEpisode AS assessEpisode,
             ci.assessReasons AS assessReasons
    `)
    expect(ciRows).toHaveLength(1)
    const ci = ciRows[0]
    const relevance = ci.get('relevance')
    const quality   = ci.get('quality')
    expect(typeof relevance === 'object' ? relevance.toNumber?.() : relevance).toBeGreaterThanOrEqual(0)
    expect(typeof quality === 'object' ? quality.toNumber?.() : quality).toBeGreaterThanOrEqual(0)
    expect(ci.get('assessEpisode')).toBe(summary.episodeId)
    const reasons = JSON.parse(ci.get('assessReasons') || '{}')
    expect(reasons.matchType).toBe('exact_cloud_id')
    expect(reasons.relevance).toBeDefined()
    expect(reasons.quality).toBeDefined()

    // ── Unmatched CI: scores written, no :REPRESENTS edge ──
    const orphanRows = await ctx.neo4j.query(`
      MATCH (ci:CmdbCi { sys_id: 'sys-orphan' })
      OPTIONAL MATCH (ci)-[r:REPRESENTS]->()
      RETURN ci.relevance     AS relevance,
             ci.assessEpisode AS assessEpisode,
             count(r)         AS edgeCount
    `)
    expect(orphanRows).toHaveLength(1)
    const orphan = orphanRows[0]
    expect(orphan.get('assessEpisode')).toBe(summary.episodeId)
    const edgeCount = orphan.get('edgeCount')
    expect(typeof edgeCount === 'object' ? edgeCount.toNumber?.() : edgeCount).toBe(0)

    // ── :IngestionEpisode shape ──
    const epRows = await ctx.neo4j.query(`
      MATCH (e:IngestionEpisode { uuid: $uuid })
      RETURN e.source     AS source,
             e.outcome    AS outcome,
             e.startedAt  AS startedAt,
             e.finishedAt AS finishedAt,
             e.stats      AS stats
    `, { uuid: summary.episodeId })
    expect(epRows).toHaveLength(1)
    const ep = epRows[0]
    expect(ep.get('source')).toBe('cmdb-assessment')
    expect(ep.get('outcome')).toBe('ok')
    expect(ep.get('startedAt')).toBeTruthy()
    expect(ep.get('finishedAt')).toBeTruthy()
    const stats = JSON.parse(ep.get('stats') || '{}')
    expect(stats).toMatchObject({ cis: 2, infra: 1, matched: 1, unmatched: 1 })
  })

  test('re-running the assessment is idempotent and refreshes lastSeenAt', async () => {
    const { runAssessment } = await import('../../services/cmdb-assessment/index.js')

    // Capture the existing :REPRESENTS edge's lastSeenAt before the second run.
    const before = await ctx.neo4j.query(`
      MATCH (:CmdbCi { sys_id: 'sys-vm-1' })-[r:REPRESENTS]->(:Infra { id: 'infra-vm-1' })
      RETURN r.lastSeenAt AS t, r.episodeId AS ep
    `)
    expect(before).toHaveLength(1)
    const tBefore  = before[0].get('t')
    const epBefore = before[0].get('ep')

    // Pause briefly so timestamps differ on systems with millisecond
    // resolution (Neo4j datetime is ms-precision).
    await new Promise(r => setTimeout(r, 25))

    const summary = await runAssessment(ctx)
    expect(summary.matched).toBe(1)
    expect(summary.episodeId).not.toBe(epBefore)

    const after = await ctx.neo4j.query(`
      MATCH (:CmdbCi { sys_id: 'sys-vm-1' })-[r:REPRESENTS]->(:Infra { id: 'infra-vm-1' })
      RETURN r.lastSeenAt AS t, r.episodeId AS ep, r.expiredAt AS expired,
             r.createdAt AS created
    `)
    expect(after).toHaveLength(1)
    const tAfter   = after[0].get('t')
    const epAfter  = after[0].get('ep')
    const created  = after[0].get('created')

    // Edge moved to the new episode and is still active.
    expect(epAfter).toBe(summary.episodeId)
    expect(after[0].get('expired')).toBeNull()
    // lastSeenAt advanced; createdAt did not — confirms the edge was MATCHed,
    // not re-CREATEd (idempotent MERGE on the (CmdbCi, Infra) pair).
    expect(String(tAfter)).not.toBe(String(tBefore))
    expect(String(created)).toBe(String(tBefore))
  })

  test('a CI that disappears between runs has its :REPRESENTS edge expired (not deleted)', async () => {
    const { runAssessment } = await import('../../services/cmdb-assessment/index.js')

    // Add a second matched CI, run the assessment, then remove the CI's
    // matching cloud_id (simulating it being unmapped) and re-run.
    const altCloudId = '/subscriptions/test-sub/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-2'
    await ctx.neo4j.write(`
      MERGE (i:Infra { id: 'infra-vm-2' })
      SET i.name = 'vm-2', i.cloud_id = $cloudId, i.provider = 'azure'
      MERGE (ci:CmdbCi { sys_id: 'sys-vm-2' })
      SET ci.name = 'vm-2', ci.cloud_id = $cloudId, ci.sys_class_name = 'cmdb_ci_server'
    `, { cloudId: altCloudId })

    const first = await runAssessment(ctx)
    expect(first.matched).toBe(2)

    // Break the match: clear every signal the matcher could use to resolve
    // sys-vm-2 back to infra-vm-2 — the strong keys plus the name (matcher
    // falls back to exact_normalized_name / fuzzy_name when a CI keeps a
    // matching name even after the strong keys are gone).
    await ctx.neo4j.write(`
      MATCH (ci:CmdbCi { sys_id: 'sys-vm-2' })
      REMOVE ci.cloud_id, ci.fqdn, ci.ip_address
      SET ci.name = 'sys-vm-2-disappeared'
    `)

    const second = await runAssessment(ctx)
    // sys-vm-2 falls into unmatched; sys-vm-1 remains matched. sys-orphan
    // remains unmatched.
    expect(second.matched).toBe(1)
    expect(second.unmatched).toBe(2)

    // The previously-matched edge has been expired, not deleted.
    const expiredRows = await ctx.neo4j.query(`
      MATCH (:CmdbCi { sys_id: 'sys-vm-2' })-[r:REPRESENTS]->(:Infra { id: 'infra-vm-2' })
      RETURN r.expiredAt AS expiredAt, r.lastSeenAt AS lastSeenAt
    `)
    expect(expiredRows).toHaveLength(1)
    expect(expiredRows[0].get('expiredAt')).toBeTruthy()
  })
})
