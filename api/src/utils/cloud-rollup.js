// Per-provider rollup grouping for Infra nodes.
//
// Every Infra node in the graph carries a `cloud_id` (Azure ARM id, GCP
// self-link or CAI name, AWS ARN or raw id). For incident-response and
// dashboards we frequently want to ask "show me everything in the same
// resource group / project / account+region" — the same buckets the
// autolink co-location rule already keys on.
//
// The bucket parsers are owned by the per-cloud supplements (which set
// them up for the autolink call) — this module just routes by provider
// and returns the bucket in a normalised shape the graph walk attaches
// to every Infra node.
//
// We intentionally route on the node's `provider` field rather than
// sniffing the cloud_id format: the field is set by every scanner, so
// it's the cheapest authoritative answer; sniffing risks false
// positives across the three id syntaxes.

import { rgFromId }                  from '../routes/discovery.azure.supplement.js'
import { projectFromCloudId }        from '../routes/discovery.gcp.supplement.js'
import { accountRegionFromCloudId }  from '../routes/discovery.aws.supplement.js'

/**
 * @param {{ provider?: string, cloud_id?: string }} node
 * @returns {{ kind: string, key: string }|null}
 *   `kind` is one of: 'azure-resource-group', 'gcp-project',
 *   'aws-account-region'. `key` is the bucket identifier
 *   (resource-group name / project id / account-region string).
 *   Returns null when the provider is unknown, the cloud_id is
 *   missing, or the parser couldn't extract a bucket.
 */
export function rollupForInfra({ provider, cloud_id } = {}) {
  if (!cloud_id) return null
  switch ((provider || '').toLowerCase()) {
    case 'azure': {
      const rg = rgFromId(cloud_id)
      return rg ? { kind: 'azure-resource-group', key: rg } : null
    }
    case 'gcp':
    case 'google': {
      const project = projectFromCloudId(cloud_id)
      return project ? { kind: 'gcp-project', key: project } : null
    }
    case 'aws': {
      const ar = accountRegionFromCloudId(cloud_id)
      return ar ? { kind: 'aws-account-region', key: ar } : null
    }
    default:
      return null
  }
}
