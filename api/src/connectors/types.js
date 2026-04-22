// api/src/connectors/types.js
//
// JSDoc typedefs for the connector framework. Pure documentation — no runtime
// code is exported. Connector implementations should match these shapes.
//
// A connector is the unit of integration with an external source of truth
// (IaC state, cloud provider API, APM vendor, telemetry receiver). Each
// connector is a directory under api/src/connectors/ that exports a default
// ConnectorSpec object.
//
// Two flavours:
//   · PULL-style   (fetch + normalize + ingest)     — e.g. terraform-cloud,
//     iac-state-backend, apm vendors. The scheduler periodically invokes
//     fetch → normalize → ingest.
//   · PUSH-style   (receiver registers HTTP routes) — e.g. otel-ingest.
//     Customer pushes data in; the connector routes handle auth + staging.

/**
 * @typedef {'iac'|'apm'|'cloud'|'telemetry-ingest'|'upload'} ConnectorCategory
 */

/**
 * @typedef {Object} ConnectorSpec
 * @property {string} id                   Stable identifier (e.g. 'terraform-cloud').
 *                                         Used as the `type` column value in
 *                                         the integrations table.
 * @property {ConnectorCategory} category  Broad grouping for UI/filters.
 * @property {string} displayName          Human-readable name.
 * @property {string} [description]        Short description for the UI.
 * @property {object} authSchema           JSON Schema describing the auth/config
 *                                         fields the user supplies.
 * @property {object} [configSchema]       JSON Schema for non-secret config
 *                                         (polling window, scope filters, etc.).
 *                                         Merged with authSchema at POST time.
 * @property {(cfg: object, ctx: ConnectorCtx) => Promise<HealthResult>} [healthCheck]
 *                                         Lightweight credential probe.
 * @property {(cfg: object, ctx: ConnectorCtx) => AsyncIterable<RawBatch>} [fetch]
 *                                         PULL-style: yields raw payloads.
 * @property {(raw: RawBatch, cfg: object) => Normalized} [normalize]
 *                                         PULL-style: raw → canonical shape.
 * @property {(normalized: Normalized, ctx: ConnectorCtx) => Promise<IngestResult>} [ingest]
 *                                         PULL-style: writes to Neo4j.
 * @property {ReceiverSpec} [receiver]     PUSH-style: registers Fastify routes.
 * @property {(cfg: object, ctx: ConnectorCtx) => Promise<object>} [beforeUpsert]
 *                                         Called before a POST / PATCH persists
 *                                         config. May mutate and return the
 *                                         effective config (e.g. auto-generate
 *                                         secrets on first create, fill defaults).
 * @property {UiMetadata} [uiMetadata]     Presentation hints for the Integrations
 *                                         UI. When present, the generic card +
 *                                         config modal render from these
 *                                         without per-connector UI code.
 * @property {(row: object, ctx: ConnectorCtx) => Promise<void>} [afterUpsert]
 *                                         Called after a POST / PATCH commits.
 *                                         Lets push-style connectors sync
 *                                         derived rows (e.g. otel_tenants).
 */

/**
 * @typedef {Object} ReceiverSpec
 * @property {(fastify: import('fastify').FastifyInstance) => Promise<void>|void} register
 *          Called during server boot to attach routes. The connector is
 *          responsible for token lookup + tenant resolution.
 */

/**
 * @typedef {Object} HealthResult
 * @property {boolean} ok
 * @property {string}  [detail]
 */

/**
 * @typedef {Object} UiMetadata
 * @property {string}   [vendor]           e.g. 'HashiCorp', 'AWS'.
 * @property {string}   [tagline]          One-line description for the card.
 * @property {string}   [logo]             Short 2–4 char label rendered in the
 *                                         icon tile (e.g. 'TF', 'OTel').
 * @property {string}   [color]            Primary brand colour (hex).
 * @property {string}   [secondaryColor]   Gradient secondary (hex).
 * @property {string[]} [capabilities]     Short tags rendered as pills.
 * @property {string}   [badge]            'Discovery' | 'Telemetry' | 'ITSM' |
 *                                         'Notifications'. Unknown values fall
 *                                         back to Discovery styling.
 * @property {UiField[]} [fields]          Ordered presentation of config fields.
 *                                         authSchema is still the contract
 *                                         (required, enum, type); this supplies
 *                                         labels, placeholders, conditional
 *                                         visibility.
 */

/**
 * @typedef {Object} UiField
 * @property {string} key                 Config field name; must match a
 *                                        property in authSchema.
 * @property {string} label
 * @property {'text'|'password'|'select'|'textarea'|'number'|'boolean'} type
 * @property {string[]} [options]         Enum options for `select` type.
 * @property {string} [placeholder]
 * @property {string} [help]
 * @property {boolean} [readonly]         Rendered non-editable (e.g. auto-
 *                                        generated tokens shown after save).
 * @property {Record<string, string|string[]>} [visibleWhen]
 *                                        Show this field only when every key
 *                                        in this map matches the current form
 *                                        value. String → equals; array →
 *                                        includes.
 */

/**
 * @typedef {Object} ConnectorCtx
 * @property {import('fastify').FastifyBaseLogger} log
 * @property {{ pool: any, query: (sql:string, params?:any[])=>Promise<any[]>, audit: Function }} pg
 * @property {{ query: Function, write: Function }} neo4j
 * @property {string} integrationId   UUID of the owning integrations row (absent for ad-hoc runs).
 * @property {AbortSignal} [signal]   Scheduler may cancel long-running fetches.
 */

/**
 * A raw batch yielded by a connector's fetch(). Opaque to the framework —
 * the connector's normalize() is the only thing that looks inside.
 * @typedef {any} RawBatch
 */

// ── Canonical IaC shape ──────────────────────────────────────────────────────
// Emitted by IaC connectors (Terraform, OpenTofu, Pulumi, …). Framework code
// in common ingest helpers maps this into :Infra / :CONNECTED_TO nodes.
/**
 * @typedef {Object} NormalizedIac
 * @property {'iac'} kind
 * @property {{ connectorId: string, fetchedAt: string, scope?: { type: string, id: string } }} source
 * @property {IacResource[]} resources
 * @property {IacEdge[]}    [edges]              Inter-resource dependsOn / references.
 * @property {IacWorkspace[]} [workspaces]       Orchestrator mode (TFC/TFE).
 * @property {IacCrossWorkspaceRef[]} [crossWorkspaceRefs]
 */

/**
 * @typedef {Object} IacResource
 * @property {string} id              Canonical identifier (terraformId or cloud_id).
 * @property {string} type            AppCloud resource type (e.g. 'vm', 'sql_database').
 * @property {string} provider        'aws'|'azure'|'gcp'|'kubernetes'|...
 * @property {string} name
 * @property {string} [region]
 * @property {boolean} [public]
 * @property {object} [tags]
 * @property {object} [rawAttrs]
 * @property {string} [workspaceId]   For orchestrator-sourced resources.
 * @property {string} [iacEngine]     'terraform'|'opentofu'|'pulumi'|'bicep'.
 */

/**
 * @typedef {Object} IacEdge
 * @property {string} srcId
 * @property {string} dstId
 * @property {string} via             Maps to VIA_TO_REL_TYPE in discovery.schema.js.
 * @property {object} [attrs]
 */

/**
 * @typedef {Object} IacWorkspace
 * @property {string} id
 * @property {string} name
 * @property {string} [orgId]
 * @property {string} [environment]
 */

/**
 * @typedef {Object} IacCrossWorkspaceRef
 * @property {string} fromWorkspaceId
 * @property {string} toWorkspaceId
 * @property {string} [via]           e.g. 'terraform_remote_state'.
 */

// ── Canonical Telemetry shape ────────────────────────────────────────────────
// Emitted by APM / mesh / OTel aggregators.
/**
 * @typedef {Object} NormalizedTelemetry
 * @property {'telemetry'} kind
 * @property {{ connectorId: string, fetchedAt: string }} source
 * @property {{ from: string, to: string }} window
 * @property {TelemetryService[]} services
 * @property {TelemetryEdge[]}    edges
 */

/**
 * @typedef {Object} TelemetryService
 * @property {string} id                  Stable (connector-scoped) id.
 * @property {string} name                Usually `service.name`.
 * @property {string} [namespace]         `service.namespace`.
 * @property {string} [environment]       `deployment.environment`.
 * @property {object} [resourceAttrs]     Raw OTel resource attributes — used
 *                                        for auto-link to :Infra.
 */

/**
 * @typedef {Object} TelemetryEdge
 * @property {string} srcId
 * @property {string} dstId
 * @property {string} [protocol]         'http'|'grpc'|'tcp'|'messaging'|…
 * @property {string} [route]            HTTP route or RPC method.
 * @property {number} [rps]
 * @property {number} [errorRate]
 * @property {number} [p50Ms]
 * @property {number} [p95Ms]
 * @property {string} [windowStart]
 * @property {string} [windowEnd]
 */

/**
 * @typedef {Object} IngestResult
 * @property {number} resourcesFound
 * @property {number} resourcesCreated
 * @property {number} resourcesUpdated
 * @property {number} resourcesSkipped
 * @property {number} [edgesCreated]
 * @property {string[]} [warnings]
 */

export {}
