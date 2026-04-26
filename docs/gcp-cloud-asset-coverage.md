# GCP Cloud Asset Inventory — coverage audit (slice 2)

This doc is the auditable record of what moves from the per-product GCP
SDK calls (`@google-cloud/compute`, `@google-cloud/container`, `googleapis`
sqladmin / run) to a single Cloud Asset Inventory (CAI) `listAssets`
query, plus the decisions made for any field CAI does not surface
directly.

Scope: the GCP scanner block in `api/src/routes/discovery.js` (the
4-product per-SDK loops — Compute Engine instances, GKE clusters,
Cloud SQL, Cloud Run).

CAI returns each asset's full REST resource representation under
`asset.resource.data` — the same shape the per-product SDKs return
today, just routed through one query instead of four. Anything
queryable via the resource's REST GET payload is in CAI.

## Resource types scanned today

| Type (AppCloud) | CAI assetType | Source today | CAI coverage | Decision |
|---|---|---|---|---|
| `compute_instance` | `compute.googleapis.com/Instance` | `@google-cloud/compute` `InstancesClient.aggregatedListAsync` | full (`resource.data.machineType`, `networkInterfaces[]`, `disks[]`, `serviceAccounts[]`, `scheduling.preemptible`, `status`, `creationTimestamp`) | replace with CAI |
| `gke_cluster` | `container.googleapis.com/Cluster` | `@google-cloud/container` `ClusterManagerClient.listClusters` | full (`resource.data.initialClusterVersion`, `currentMasterVersion`, `currentNodeCount`, `endpoint`, `network`, `subnetwork`, `loggingService`, `monitoringService`, `autopilot.enabled`, `privateClusterConfig.enablePrivateEndpoint`) | replace with CAI |
| `cloud_sql` | `sqladmin.googleapis.com/Instance` | `googleapis` `sqladmin.v1.instances.list` | full (`resource.data.databaseVersion`, `settings.tier`, `settings.dataDiskSizeGb`, `settings.backupConfiguration.enabled`, `settings.maintenanceWindow`, `ipAddresses[]`, `settings.availabilityType`, `region`, `state`) | replace with CAI |
| `cloud_run` | `run.googleapis.com/Service` | `googleapis` `run.v2.projects.locations.services.list` | full (`resource.data.uri`, `creator`, `lastModifier`, `template.containers[].image`, `template.scaling.{min,max}InstanceCount`, `ingress`, `terminalCondition.state`) | replace with CAI |

## Resource types CAI gives us "for free" (not scanned today)

CAI is a project-wide projection, so a single call returns every asset
type. These types are picked up automatically in slice 2 — they were
previously invisible to AppCloud and now contribute structural edge
endpoints. Only types listed in `ASSET_TYPE_MAP` produce nodes; the
rest are tolerated and skipped without error.

| AppCloud type | CAI assetType | Why it matters |
|---|---|---|
| `gcp_vpc` | `compute.googleapis.com/Network` | Edge target for Instance → Network, GKE → Network, Subnet → Network |
| `gcp_subnet` | `compute.googleapis.com/Subnetwork` | Edge target for Instance → Subnet, GKE → Subnet, Cloud SQL private connect |
| `gcp_disk` | `compute.googleapis.com/Disk` | Edge target for Instance → Disk |
| `gcp_firewall` | `compute.googleapis.com/Firewall` | Surface egress/ingress posture |
| `gcp_address` | `compute.googleapis.com/Address` | External/internal IP allocations |
| `gcp_router` | `compute.googleapis.com/Router` | Network plumbing for Cloud NAT |
| `gcp_service_account` | `iam.googleapis.com/ServiceAccount` | Edge target for Instance → SA, Cloud Run → SA |
| `gcs_bucket` | `storage.googleapis.com/Bucket` | Object storage; previously not discovered at all |
| `pubsub_topic` | `pubsub.googleapis.com/Topic` | Messaging plane |
| `pubsub_subscription` | `pubsub.googleapis.com/Subscription` | Messaging plane |
| `bigquery_dataset` | `bigquery.googleapis.com/Dataset` | Analytics plane |
| `dataproc_cluster` | `dataproc.googleapis.com/Cluster` | Hadoop / Spark workloads |
| `gcp_redis` | `redis.googleapis.com/Instance` | Cache plane |
| `spanner_instance` | `spanner.googleapis.com/Instance` | Database plane |

## Structural edges emitted by the new scanner

| From type | `via` | Target reference field (CAI) | Confidence |
|---|---|---|---|
| Compute Instance | `subnet` | `networkInterfaces[].subnetwork` | 65 |
| Compute Instance | `network` | `networkInterfaces[].network` | 65 |
| Compute Instance | `disk` | `disks[].source` | 88 |
| Compute Instance | `service-account` | `serviceAccounts[].email` (mapped to SA self-link) | 60 |
| GKE Cluster | `network` | `network` (resolved to full self-link) | 70 |
| GKE Cluster | `subnet` | `subnetwork` (resolved to full self-link) | 70 |
| Cloud Run | `service-account` | `template.serviceAccount` | 60 |
| Subnet | `network` | `network` | 65 |

Confidence values reuse the structural-via score table established by
the Azure scanner (`VIA_TO_CONFIDENCE` in `discovery.azure.js`); shared
keys (`subnet`, `network`, `disk`, `service-account`) keep the same
score across clouds.

Cloud SQL private-services access (peering edge to a VPC) is omitted in
v1 — the relevant field (`settings.ipConfiguration.privateNetwork`) is
present in CAI but the linked VPC is the carrier's "service producer"
network, not user-resolvable to a node ID. Revisit if/when we surface
private-services-access edges as their own kind.

## Known CAI gaps (not covered by slice 2)

CAI is a property projection over GCP resources; signals it does not
express live in supplement layers. Slice 2 ships **without** active
supplement layers — auto-link Phase 2 is the only post-scan step.
Future supplements (out of slice-2 scope):

| Possible supplement | What it would add | Why CAI doesn't cover it |
|---|---|---|
| VPC Flow Logs export to BigQuery | Observed network flows (analog of Azure VM Insights) | CAI is a configuration projection; runtime traffic is not in scope |
| IAM Policy Analyzer | Effective-access edges (who-can-do-what across resources) | CAI surfaces stored bindings; effective access requires evaluation |
| Cloud Run revision-traffic split | Revision-level routing | CAI only surfaces the latest service config |

## Fields consciously dropped

None for slice 2. Every field currently extracted by the per-SDK
scanner is available under CAI's `resource.data`.

## Pagination

The current scanner doesn't paginate (sqladmin / run calls return
single-page results, compute uses `aggregatedListAsync` which paginates
internally). The new CAI scanner pages explicitly via `pageToken` until
exhausted — necessary because a single project can hold tens of
thousands of assets.

## Identity continuity

`cloud_id` is preserved across the migration. The per-SDK scanner uses
`inst.selfLink`, `cluster.selfLink`, `db.selfLink`, `svc.name`. All of
these appear in CAI under `resource.data.selfLink` (Compute / GKE /
Cloud SQL) or `resource.data.name` (Cloud Run) — same string, same
node identity. No re-MERGE risk.

## Edge-write policy during slice 2 (Option A dual-write)

Same as slice 1:

- **Structural edges** dual-write `:CONNECTED_TO` (legacy reader-compat)
  and `:CONNECTS_TO` (new canonical) with the same traceability
  properties (`source: 'gcp-cloud-asset-inventory'`, `via`,
  `confidence`, `evidence`).
- **Auto-link edges** dual-write `:DEPLOYED_ON` and `:CONNECTS_TO` with
  `source: 'auto-link'`.
- Typed relationships are no longer written.

## SDK churn in slice 2

Removed from `discovery.js`:

- `@google-cloud/compute`
- `@google-cloud/container`
- `googleapis` (only the `sqladmin` and `run` usages — the package
  itself stays as a transitive dependency of other tooling and is
  pruned from `api/package.json` in slice 5)

Added:

- `@google-cloud/asset` — the CAI client.

Retained:

- `@google-cloud/storage` — used by `iac-state-backend/backends/gcs.js`,
  not discovery.
- `@google-cloud/resource-manager` — already unused by any code path;
  removed from `api/package.json` in slice 5 along with the rest of
  the cleanup.
