# Azure Resource Graph — coverage audit (slice 1)

This doc is the auditable record of what moves from per-type Azure SDK calls
to a single Azure Resource Graph (ARG) query, plus the decisions made for any
field that ARG does not surface directly.

Scope: the Azure scanner block in `api/src/routes/discovery.js` (the old
per-SDK loops plus the generic `ResourceManagementClient.resources.list()`
catch-all) and Layer A of `api/src/routes/discovery.azure.supplement.js`
(structural edges derived from ARM properties).

ARG is an ARM-wide projection: anything queryable via the `Resources` table
with `| project properties` is already present in the scanner output as
`raw.*`. The audit below is per-type; unless noted, every field is available
in ARG without a supplementary call.

## Resource types scanned today

| Type (AppCloud) | ARM type | Source today | ARG coverage | Decision |
|---|---|---|---|---|
| `vm` | `microsoft.compute/virtualmachines` | `@azure/arm-compute` | full (`properties.hardwareProfile.vmSize`, `properties.storageProfile.*`, `properties.osProfile.adminUsername`, top-level `zones`) | replace with ARG |
| `aks_cluster` | `microsoft.containerservice/managedclusters` | `@azure/arm-containerservice` | full (`properties.kubernetesVersion`, `properties.agentPoolProfiles[]`, `properties.dnsPrefix`, `properties.fqdn`, `properties.networkProfile.*`, `properties.apiServerAccessProfile.enablePrivateCluster`, `properties.enableRBAC`) | replace with ARG |
| `sql_server` | `microsoft.sql/servers` | `@azure/arm-sql` | full (`properties.version`, `properties.administratorLogin`, `properties.fullyQualifiedDomainName`, `properties.publicNetworkAccess`, `properties.minimalTlsVersion`) | replace with ARG |
| `app_service` / `function_app` | `microsoft.web/sites` | `@azure/arm-appservice` | full (`properties.defaultHostName`, `properties.httpsOnly`, `properties.serverFarmId`, `properties.outboundIpAddresses`, `properties.clientAffinityEnabled`, `properties.enabled`, `properties.virtualNetworkSubnetId`; top-level `kind` distinguishes function vs. site) | replace with ARG |
| `redis` | `microsoft.cache/redis` | `@azure/arm-rediscache` | full (`properties.hostName`, `properties.port`, `properties.sslPort`, `properties.redisVersion`, `properties.minimumTlsVersion`, `properties.enableNonSslPort`, `properties.subnetId`; top-level `sku`) | replace with ARG — also removes the per-RG iteration workaround |
| `vnet` | `microsoft.network/virtualnetworks` | `@azure/arm-network` | full (`properties.addressSpace.addressPrefixes`, `properties.subnets[]`, `properties.dhcpOptions.dnsServers`, `properties.enableDdosProtection`) | replace with ARG |
| `app_insights`, `storage_account`, `service_bus`, `key_vault`, `app_service_plan`, `cosmos_db`, `container_registry`, `event_hub`, `event_grid`, `logic_app`, `cdn`, `api_management`, `postgres_server`, `mysql_server`, `nsg`, `private_dns`, `log_analytics`, `static_web_app`, `load_balancer`, `application_gateway` | various `microsoft.*` | generic `@azure/arm-resources` list — shallow properties only | ARG returns full `properties` for all of these | replace with ARG — _gain_ rather than loss (current generic path drops `properties` entirely) |

## Resource types emitting structural edges today (Layer A of enrich)

These are the ARM reference properties the current scanner walks to MERGE
structural `:CONNECTED_TO` edges. All available under ARG's `properties`.

| From type | `via` | Target reference property | ARG coverage |
|---|---|---|---|
| VM | `nic` | `properties.networkProfile.networkInterfaces[].id` | full |
| VM | `disk` | `properties.storageProfile.dataDisks[].managedDisk.id` | full |
| NIC | `subnet` | `properties.ipConfigurations[].properties.subnet.id` | full |
| NIC | `public-ip` | `properties.ipConfigurations[].properties.publicIPAddress.id` | full |
| NIC | `nsg` | `properties.networkSecurityGroup.id` | full |
| VNet (reverse) | `vnet` | `properties.subnets[].id` (each subnet → vnet) | full |
| Subnet | `nsg` | `properties.subnets[].properties.networkSecurityGroup.id` | full |
| Subnet | `route-table` | `properties.subnets[].properties.routeTable.id` | full |
| App Service | `app-service-plan` | `properties.serverFarmId` | full |
| App Service | `vnet-integration` | `properties.virtualNetworkSubnetId` | full |
| App Service | `app-insights` | `properties.appInsightsInstrumentationKey` | full (note: this is an instrumentation key string, not an ARM id — Layer A already handles it as-is) |
| AKS | `aks-node-subnet` | `properties.agentPoolProfiles[0].vnetSubnetID` | full |
| SQL DB | `sql-server` | derived from own ARM id | n/a — computed, not a field lookup |
| Redis | `redis-vnet-injection` | `properties.subnetId` | full |
| Service Bus / Event Hub | `private-endpoint` | `properties.privateEndpointConnections[].properties.privateEndpoint.id` | full |
| App Insights | `monitors` | `properties.ApplicationId` | full |
| Key Vault | `keyvault-vnet-rule` | `properties.networkAcls.virtualNetworkRules[].id` | full |
| Load Balancer | `lb-backend-nic` | `properties.backendAddressPools[].properties.backendIPConfigurations[].id` (parent NIC) | full |
| App Gateway | `agw-subnet` | `properties.gatewayIPConfigurations[0].properties.subnet.id` | full |

## Known ARG gaps (deliberately not covered by slice 1)

The following fidelity layers already exist as separate scanner stages and
remain as **named supplement layers** per the primary + supplement
architecture (see `feedback_supplement_model.md` in memory, and
`discovery.azure.supplement.js`):

| Supplement layer | What it adds | Why ARG can't replace it |
|---|---|---|
| Network Watcher topology (Layer B) | Runtime `Contains` / `Associated` links between resources in a VNet — reflects Azure's own topology view, not just ARM properties | ARG is a property projection; it does not evaluate Azure's runtime topology graph |
| VM Insights / Log Analytics (Layer C) | Observed TCP connections between VMs with connection count, ports, process | ARG has no visibility into observed network traffic |
| Auto-link (Phase 2) | Component → Infra ownership inferred from structural + RG co-location | Not a scanner concern — consumes the graph after the scanner + supplements run |

## Fields consciously dropped

None for slice 1. Every field currently extracted by either the per-SDK
scanner or the generic catch-all is available under ARG's `properties`.

## Pagination

The current Layer A query reads `res.data` in one shot — fine for
subscriptions under the default ARG page size (1000 rows), broken for
larger ones. The new scanner must iterate `$skipToken` until exhausted.

## Edge-write policy during slice 1 (Option A dual-write)

- **Structural edges** (VM→NIC, Web→ASP, …): dual-write `:CONNECTED_TO`
  (legacy reader-compat) and `:CONNECTS_TO` (new canonical). Both carry the
  same properties: `source`, `via`, `confidence`, `evidence`,
  `discovered_at`, `last_seen`. **Typed relationships**
  (`NETWORK_INTERFACE`, `HOSTED_ON_PLAN`, …) are no longer written — grep
  confirmed no readers outside `discovery.azure.supplement.js` itself and the
  migration file.
- **Auto-link edges** (Component → Infra): dual-write `:DEPLOYED_ON` (legacy)
  and `:CONNECTS_TO` with `source: 'auto-link'`, `confidence: <ruleScore>`,
  `via: 'component-mapping'`. Readers in routes/agents/compliance/UI (26
  files) continue to read `:DEPLOYED_ON` and are migrated across slices 2–5.

Slice 5 drops the dual writes and runs a one-shot Cypher migration to
remove orphaned `:CONNECTED_TO`, `:DEPLOYED_ON`, and typed-rel edges.

## SDKs removed in slice 1

Only per-type Azure inventory SDKs consumed by the old scanner body go:

- `@azure/arm-compute`
- `@azure/arm-containerservice`
- `@azure/arm-sql`
- `@azure/arm-appservice`
- `@azure/arm-rediscache`
- `@azure/arm-resources` (the generic catch-all — ARG covers it)

## SDKs retained

- `@azure/identity` — auth for ARG, Network Watcher, VM Insights
- `@azure/arm-resourcegraph` — the new primary query
- `@azure/arm-network` — Network Watcher supplement (Layer B)
- `@azure/monitor-query` — VM Insights supplement (Layer C)

Per-package removal from `api/package.json` is deferred to slice 5 (after
GCP and AWS supplements ship) so each slice remains independently revertable.
