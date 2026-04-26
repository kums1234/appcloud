// routes/integrations.js — Terraform/OpenTofu state file import (multipart upload)
//
// Parsing lives in utils/terraform-state-parser.js and ingestion in
// utils/iac-ingest.js so the connector framework (iac-state-backend,
// terraform-cloud) can reuse both. This route keeps its original behaviour:
// one-shot multipart upload → parse → ingest.
import { parseTerraformState } from '../utils/terraform-state-parser.js'
import { ingestIacResources }  from '../utils/iac-ingest.js'

// ── Route handler ────────────────────────────────────────────────────────────
export default async function integrationRoutes(fastify) {
  // POST /integrations/terraform/import
  // Accepts multipart form-data with a "statefile" field containing the .tfstate JSON
  fastify.post('/terraform/import', {
    schema: {
      summary:     'Import a Terraform / OpenTofu state file (multipart upload)',
      description: 'Send `multipart/form-data` with a `statefile` field containing the `.tfstate` JSON. Resources are parsed via `parseTerraformState` and ingested into Neo4j as Infra nodes. Returns the import-job id, parse summary, and per-status counts.',
      consumes:    ['multipart/form-data'],
      response:    { 200: { type: 'object', additionalProperties: true }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (req, reply) => {
    // Check multipart is available
    if (typeof req.file !== 'function') {
      return reply.internalServerError(
        '@fastify/multipart is not installed. Run: npm install @fastify/multipart, then rebuild the API container.'
      )
    }
    // Parse multipart
    let stateJson, filename, fileSizeBytes
    try {
      const data = await req.file()
      if (!data) return reply.badRequest('No file uploaded — send as multipart field "statefile"')
      filename = data.filename || 'terraform.tfstate'
      const chunks = []
      for await (const chunk of data.file) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      fileSizeBytes = raw.length
      stateJson = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      return reply.badRequest(`Could not parse state file: ${err.message}`)
    }

    // Create import job record in PostgreSQL
    let jobId = null
    if (fastify.pg?.pool) {
      const [job] = await fastify.pg.query(
        `INSERT INTO terraform_imports (filename, file_size_bytes, status)
         VALUES ($1, $2, 'parsing') RETURNING id`,
        [filename, fileSizeBytes]
      )
      jobId = job?.id
    }

    // Parse the state file
    const { resources, errors, version, workspace } = parseTerraformState(stateJson)

    if (errors.length && !resources.length) {
      if (fastify.pg?.pool && jobId) {
        await fastify.pg.query(
          `UPDATE terraform_imports SET status='error', error_message=$1, finished_at=now()
           WHERE id=$2`, [errors.join('; '), jobId]
        )
      }
      return reply.badRequest(errors.join('; '))
    }

    // Ingest via the shared helper
    const ingestResult = await ingestIacResources(fastify.neo4j, resources, {
      source: 'terraform',
      log:    fastify.log,
    })

    const summary = {
      version, workspace,
      resourceTypeCounts: resources.reduce((acc, r) => {
        acc[r.terraformType] = (acc[r.terraformType] || 0) + 1
        return acc
      }, {}),
      sampleNames: ingestResult.importedNames.slice(0, 10),
      parseErrors: errors,
      warnings:    ingestResult.warnings,
    }

    if (fastify.pg?.pool && jobId) {
      await fastify.pg.query(
        `UPDATE terraform_imports SET
           status='done', terraform_version=$1, workspace=$2,
           resources_found=$3, resources_imported=$4, resources_skipped=$5,
           raw_summary=$6, finished_at=now()
         WHERE id=$7`,
        [version, workspace, resources.length,
         ingestResult.resourcesCreated + ingestResult.resourcesUpdated,
         ingestResult.resourcesSkipped,
         JSON.stringify(summary), jobId]
      )
      await fastify.pg.audit(
        'system', 'import', 'TerraformImport', jobId, filename,
        {
          created: ingestResult.resourcesCreated,
          updated: ingestResult.resourcesUpdated,
          skipped: ingestResult.resourcesSkipped,
          total:   resources.length,
        }
      )
    }

    reply.code(200).send({
      jobId,
      filename,
      terraformVersion: version,
      workspace,
      resourcesFound:   resources.length,
      resourcesCreated: ingestResult.resourcesCreated,
      resourcesUpdated: ingestResult.resourcesUpdated,
      resourcesSkipped: ingestResult.resourcesSkipped,
      parseErrors:      errors,
      summary,
    })
  })

  // GET /integrations/terraform/history — recent import jobs
  fastify.get('/terraform/history', {
    schema: {
      summary:     'Recent Terraform import jobs',
      description: 'Returns up to 20 import jobs newest-first with status, parsed Terraform version, workspace, resource counts, and total duration.',
      response:    { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
    },
  }, async (req, reply) => {
    if (!fastify.pg?.pool) return []
    const rows = await fastify.pg.query(
      `SELECT id, filename, status, terraform_version, workspace,
              resources_found, resources_imported, resources_skipped,
              error_message, created_at, finished_at,
              EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000 AS duration_ms
       FROM terraform_imports
       ORDER BY created_at DESC LIMIT 20`
    )
    return rows
  })
}