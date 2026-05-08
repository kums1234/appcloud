// api/src/utils/iac-ingest.js
//
// Shared Neo4j ingester for IaC-sourced resources. Consumed by:
//   · routes/integrations.js                 — multipart state-file upload
//   · connectors/iac-state-backend           — S3/Azure/GCS/Consul polling
//   · connectors/terraform-cloud             — TFC/TFE state version download
//
// Input shape matches parseTerraformState(…).resources — i.e. ParsedResource
// objects from utils/terraform-state-parser.js. This keeps all IaC-flavoured
// writes going through the same MERGE path, so provenance + typed-label
// application stay consistent.

import { buildLabelSetClause } from '../routes/discovery.schema.js'

/**
 * MERGE a batch of ParsedResource objects into Neo4j as :Infra nodes.
 *
 * @param {{ write: Function }} neo4j            fastify.neo4j handle
 * @param {import('./terraform-state-parser.js').ParsedResource[]} resources
 * @param {object} [opts]
 * @param {string} [opts.source]                 value written to i.source (default 'terraform')
 * @param {string} [opts.integrationId]          when set, recorded on the node for audit
 * @param {import('fastify').FastifyBaseLogger} [opts.log]
 * @returns {Promise<{ resourcesFound:number, resourcesCreated:number,
 *                     resourcesUpdated:number, resourcesSkipped:number,
 *                     importedNames:string[], warnings:string[] }>}
 */
export async function ingestIacResources(neo4j, resources, opts = {}) {
  const source         = opts.source || 'terraform'
  const integrationId  = opts.integrationId || null
  const log            = opts.log
  const { write } = neo4j

  const result = {
    resourcesFound:   resources.length,
    resourcesCreated: 0,
    resourcesUpdated: 0,
    resourcesSkipped: 0,
    importedNames:    [],
    warnings:         [],
  }

  for (const res of resources) {
    try {
      const now = Date.now()
      const records = await write(`
        MERGE (i:Infra {terraform_id: $terraformId})
        ON CREATE SET
          i.id             = randomUUID(),
          i.firstseen      = $now,
          i.name           = $name,
          i.provider       = $provider,
          i.resource_type  = $resourceType,
          i.region         = $region,
          i.public         = $public,
          i.terraform_type = $terraformType,
          i.terraform_name = $terraformName,
          i.source         = $source,
          i.iac_engine     = $iacEngine,
          i.tf_workspace   = $workspaceId,
          i.integration_id = $integrationId,
          i.imported_at    = datetime()
        ON MATCH SET
          i.name          = $name,
          i.provider      = $provider,
          i.resource_type = $resourceType,
          i.region        = $region,
          i.public        = $public,
          i.source        = $source,
          i.iac_engine    = coalesce($iacEngine, i.iac_engine),
          i.tf_workspace  = coalesce($workspaceId, i.tf_workspace),
          i.integration_id = coalesce($integrationId, i.integration_id),
          i.lastupdated   = $now,
          i.updated_at    = datetime()
        RETURN i.id AS nodeId,
               CASE WHEN i.imported_at = i.updated_at OR i.updated_at IS NULL
                    THEN 'created' ELSE 'updated' END AS action
      `, {
        terraformId:   res.terraformId,
        name:          res.name,
        provider:      res.provider,
        resourceType:  res.resourceType,
        region:        res.region || '',
        public:        !!res.public,
        terraformType: res.terraformType,
        terraformName: res.terraformName,
        source,
        iacEngine:     res.iacEngine || null,
        workspaceId:   res.workspaceId || null,
        integrationId,
        now,
      })

      if (!records.length) { result.resourcesSkipped++; continue }

      const action = records[0].get('action')
      if (action === 'created') result.resourcesCreated++
      else                      result.resourcesUpdated++
      result.importedNames.push(res.name)

      // Apply typed labels (additive, best-effort). Failure here is
      // cosmetic — keeps untyped :Infra nodes usable either way.
      const nodeId      = records[0].get('nodeId')
      const labelClause = buildLabelSetClause(res.provider, res.resourceType)
      if (nodeId && labelClause) {
        await write(`MATCH (i:Infra {id: $nodeId}) ${labelClause}`, { nodeId })
          .catch(err => result.warnings.push(`label-set failed for ${res.name}: ${err.message}`))
      }
    } catch (err) {
      log?.warn?.(`[iac-ingest] ${res.terraformType}.${res.terraformName}: ${err.message}`)
      result.warnings.push(`${res.terraformType}.${res.terraformName}: ${err.message}`)
      result.resourcesSkipped++
    }
  }

  return result
}
