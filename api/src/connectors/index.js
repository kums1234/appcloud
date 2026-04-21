// api/src/connectors/index.js
//
// Registry. Scans sibling directories on startup, imports each one's
// index.js, and registers the exported ConnectorSpec keyed by `id`.
//
// Directory layout (one folder per connector):
//   api/src/connectors/
//     terraform-upload/index.js       → exports default ConnectorSpec
//     iac-state-backend/index.js
//     terraform-cloud/index.js
//     otel-ingest/index.js
//
// A connector folder may export additional helper modules; only index.js is
// auto-imported.

import { readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const registry = new Map()

/**
 * Scan ./connectors/*\/index.js and populate the registry. Idempotent —
 * re-running clears and reloads.
 * @param {import('fastify').FastifyBaseLogger} [log]
 */
export async function loadConnectors(log) {
  registry.clear()

  let entries
  try { entries = readdirSync(__dirname, { withFileTypes: true }) }
  catch (err) {
    log?.warn(`[Connectors] Registry scan failed: ${err.message}`)
    return registry
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const specPath = join(__dirname, entry.name, 'index.js')
    try { statSync(specPath) }
    catch { continue }

    try {
      const mod = await import(pathToFileURL(specPath).href)
      const spec = mod.default
      if (!spec || typeof spec !== 'object') {
        log?.warn(`[Connectors] ${entry.name}: no default export — skipping`)
        continue
      }
      if (!spec.id || typeof spec.id !== 'string') {
        log?.warn(`[Connectors] ${entry.name}: spec missing valid id — skipping`)
        continue
      }
      if (registry.has(spec.id)) {
        log?.warn(`[Connectors] duplicate id "${spec.id}" (from ${entry.name}) — keeping first`)
        continue
      }
      registry.set(spec.id, spec)
      log?.info(`[Connectors] Loaded: ${spec.id} (${spec.category || 'uncategorised'})`)
    } catch (err) {
      log?.warn(`[Connectors] Failed to load ${entry.name}: ${err.message}`)
    }
  }

  return registry
}

export function getConnector(id) { return registry.get(id) }
export function listConnectors()  { return Array.from(registry.values()) }
export function hasConnector(id)  { return registry.has(id) }

/**
 * Return a UI-safe subset of a ConnectorSpec (functions stripped, schemas
 * intact). Used by GET /connectors.
 */
export function serializeSpec(spec) {
  if (!spec) return null
  return {
    id:          spec.id,
    category:    spec.category,
    displayName: spec.displayName,
    description: spec.description || null,
    authSchema:  spec.authSchema  || null,
    configSchema: spec.configSchema || null,
    style:       spec.receiver ? 'push' : 'pull',
  }
}
