// api/src/plugins/connectors.js
//
// Fastify plugin that:
//   1. Loads the connector registry at boot.
//   2. Applies runtime DDL so existing Postgres installs pick up the
//      `integrations` evolution (UNIQUE constraint, poll_interval_seconds,
//      indexes) without needing a volume wipe.
//   3. Decorates fastify.connectors with { get, list, serializeSpec, run }.
//   4. Gives push-style connectors (spec.receiver) a chance to register HTTP
//      routes at boot.

import { loadConnectors, getConnector, listConnectors, serializeSpec } from '../connectors/index.js'
import { runPullScan, ConnectorError } from '../connectors/base.js'
import { startEpisode, finishEpisode } from '../services/episodes.js'

// Applied on every boot — safe due to IF NOT EXISTS / DO-block guards.
const RUNTIME_DDL = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'integrations_type_name_key'
    ) THEN
      ALTER TABLE integrations
        ADD CONSTRAINT integrations_type_name_key UNIQUE (type, name);
    END IF;
  END$$;

  ALTER TABLE integrations
    ADD COLUMN IF NOT EXISTS poll_interval_seconds INTEGER;

  CREATE INDEX IF NOT EXISTS idx_integrations_enabled_type
    ON integrations(enabled, type);

  CREATE INDEX IF NOT EXISTS idx_integrations_next_run
    ON integrations(enabled, last_sync_at)
    WHERE poll_interval_seconds IS NOT NULL;
`

export async function connectorsPlugin(fastify) {
  // 1. Apply runtime DDL (best-effort)
  if (fastify.pg?.pool) {
    try {
      await fastify.pg.query(RUNTIME_DDL)
      fastify.log.info('[Connectors] integrations schema evolution applied')
    } catch (err) {
      fastify.log.warn(`[Connectors] schema evolution warning: ${err.message}`)
    }
  }

  // 2. Load registry
  await loadConnectors(fastify.log)

  // 3. Decorate fastify.connectors
  fastify.decorate('connectors', {
    get:           (id) => getConnector(id),
    list:          ()   => listConnectors(),
    serializeSpec: (s)  => serializeSpec(s),
    /**
     * Execute one scan for a configured integration. Returns an IngestResult.
     * @param {object} integrationRow  row from `integrations` table (decrypted config)
     * @param {{ signal?: AbortSignal }} [opts]
     */
    run: async (integrationRow, opts = {}) => {
      const spec = getConnector(integrationRow.type)
      if (!spec) throw new ConnectorError(integrationRow.type, 'dispatch', 'connector not registered')
      if (spec.receiver && !spec.fetch) {
        throw new ConnectorError(spec.id, 'dispatch', 'push-style connector has no pull entrypoint')
      }
      // Every connector run is an :IngestionEpisode. opts.episodeId lets
      // a caller reuse a parent episode (e.g. when /discovery/scan/all
      // drives several connector runs under one audit id).
      const episode = await startEpisode(
        fastify.neo4j,
        `connector:${spec.id}`,
        opts.episodeId,
      )
      const ctx = {
        log:           fastify.log,
        pg:            fastify.pg,
        neo4j:         fastify.neo4j,
        integrationId: integrationRow.id,
        episodeId:     episode.uuid,
        signal:        opts.signal,
      }
      let outcome = 'ok'
      try {
        const result = await runPullScan(spec, integrationRow.config || {}, ctx)
        if ((result.warnings || []).length) outcome = 'partial'
        await finishEpisode(fastify.neo4j, episode, outcome, {
          resourcesFound:   result.resourcesFound,
          resourcesCreated: result.resourcesCreated,
          resourcesUpdated: result.resourcesUpdated,
          edgesCreated:     result.edgesCreated ?? 0,
        })
        return { ...result, episodeId: episode.uuid }
      } catch (err) {
        await finishEpisode(fastify.neo4j, episode, 'error', { error: err.message })
        throw err
      }
    },
  })

  // 4. Register push-style receivers now that fastify.connectors is live
  for (const spec of listConnectors()) {
    if (spec.receiver?.register) {
      try {
        await spec.receiver.register(fastify)
        fastify.log.info(`[Connectors] receiver registered: ${spec.id}`)
      } catch (err) {
        fastify.log.warn(`[Connectors] receiver ${spec.id} failed to register: ${err.message}`)
      }
    }
  }
}
