// services/episodes.js
//
// :IngestionEpisode is the provenance primitive borrowed from graphiti's
// episodic model. One episode = one discrete run of a scanner / connector
// / assessment. Every node or edge that run produces carries the
// episode's uuid via an `episodeId` property, so later queries can
// answer:
//
//   - "which edges did the 2026-04-25T08:00Z Azure scan produce?"
//   - "this edge looks wrong — which run last affirmed it?"
//   - "re-score every edge from this specific run"
//
// The helper is intentionally tiny: start → pass uuid into writers →
// finish (optional; records outcome + stats). Callers that die mid-run
// just leave a dangling episode with no `finishedAt` — still useful for
// audit.
//
// Shape:
//   (e:IngestionEpisode {
//     uuid:        string,       // caller-supplied or generated
//     source:      string,       // 'discovery.scan.all', 'connector:servicenow', …
//     startedAt:   ISO8601,
//     finishedAt:  ISO8601 | null,
//     outcome:     'ok' | 'error' | 'partial' | null,
//     stats:       JSON string | null
//   })

import { randomUUID } from 'crypto'

/**
 * Write an :IngestionEpisode node and return its context. Callers attach
 * the returned `uuid` to every write they issue for this run.
 *
 * @param {{ query: Function, write: Function }} neo4j
 * @param {string} source   Stable label for the run family (e.g.
 *                          'discovery.scan.all', 'connector:servicenow').
 * @param {string} [uuid]   Optional caller-supplied id (useful for tests
 *                          and for re-using a parent episode).
 * @returns {Promise<{ uuid: string, source: string, startedAt: string }>}
 */
export async function startEpisode(neo4j, source, uuid) {
  if (!neo4j?.write) throw new Error('startEpisode requires a neo4j write function')
  const id        = uuid || randomUUID()
  const startedAt = new Date().toISOString()
  await neo4j.write(
    `MERGE (e:IngestionEpisode { uuid: $id })
     ON CREATE SET
       e.source    = $source,
       e.startedAt = $startedAt,
       e.outcome   = null
     RETURN e`,
    { id, source, startedAt },
  )
  return { uuid: id, source, startedAt }
}

/**
 * Stamp finishedAt + outcome + stats onto an existing episode. Missing
 * episodes are a no-op (callers routinely construct an episode object
 * off-graph, e.g. to tag cheap writes during normalize).
 *
 * @param {{ query: Function, write: Function }} neo4j
 * @param {{ uuid: string }} episode  The object returned by startEpisode.
 * @param {'ok'|'error'|'partial'} [outcome]
 * @param {object|null} [stats]   Free-form object serialised to JSON on
 *                                the node. Keep bounded — this is
 *                                operational metadata, not a log.
 */
export async function finishEpisode(neo4j, episode, outcome = 'ok', stats = null) {
  if (!episode?.uuid || !neo4j?.write) return
  const finishedAt = new Date().toISOString()
  await neo4j.write(
    `MATCH (e:IngestionEpisode { uuid: $uuid })
     SET e.finishedAt = $finishedAt,
         e.outcome    = $outcome,
         e.stats      = $stats`,
    {
      uuid:       episode.uuid,
      finishedAt,
      outcome,
      stats:      stats ? JSON.stringify(stats) : null,
    },
  ).catch(() => { /* best-effort; logging is the caller's concern */ })
}
