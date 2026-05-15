// api/src/schemas/openapi.js
//
// Reusable JSON schemas referenced from route `schema` blocks. Each export
// is a plain object that gets spread or referenced inline; we deliberately
// don't go through fastify.addSchema + $ref because the inline form keeps
// the OpenAPI export self-contained and the generated docs more readable.
//
// Naming: each schema is exported as `<Name>Schema` (the JSON Schema body)
// so call sites can use shape-first descriptions without name collisions.
//
// Conventions used by every route:
//   - tags          — set automatically by server.js's autoTagRoute
//   - security      — defaults to [{ ApiKey: [] }] from the global
//                     OpenAPI security; override with `security: []` for
//                     open routes (/health, /, /openapi.json)
//   - summary       — one-line; appears as the route title in Swagger UI
//   - description   — multi-line; markdown allowed
//
// For request validation Fastify uses Ajv; ensure every body schema we
// declare here either validates the production payload or is loose enough
// (`additionalProperties: true`) to not reject in-flight requests.

// ── Common error response ────────────────────────────────────────────────────
export const ErrorResponseSchema = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  additionalProperties: true,
  properties: {
    statusCode: { type: 'integer', example: 400 },
    error:      { type: 'string',  example: 'Bad Request' },
    message:    { type: 'string',  example: 'infraId required' },
  },
}

// Standard error envelope for routes that may 4xx/5xx. Keep the keys stable
// — clients pattern-match on these codes. Use as `response: { 4xx: ErrorResponseSchema, 5xx: ErrorResponseSchema }`.
export const StandardErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
  503: ErrorResponseSchema,
}

// ── ID-in-path param ─────────────────────────────────────────────────────────
export const IdParamSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', description: 'Resource UUID or unique name', minLength: 1 },
  },
}

// ── Application ──────────────────────────────────────────────────────────────
// Stored in Neo4j as :Application; referenced by Components via :CONTAINS.
export const ApplicationSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id:              { type: 'string', format: 'uuid', description: 'Stable Application UUID' },
    name:            { type: 'string',  example: 'Payments Platform' },
    tier:            { type: 'integer', minimum: 1, maximum: 3, description: '1 = critical, 3 = best-effort' },
    owner:           { type: 'string',  example: 'payments-team' },
    environment:     { type: 'string',  example: 'production' },
    availability:    { type: 'string',  example: '99.99' },
    confidentiality: { type: 'string',  example: 'confidential' },
    domain:          { type: 'string',  example: 'finance' },
  },
}

export const ApplicationCreateBodySchema = {
  type: 'object',
  required: ['name', 'tier'],
  // Body schemas are now strict — unknown fields are rejected (Ajv 400). The
  // previous `true` setting silently accepted (and then dropped) keys like
  // `__proto__` / `internal_admin_flag`, which is a small but real
  // mass-assignment / prototype-pollution surface. Response schemas
  // elsewhere in this file stay permissive; only request bodies tightened.
  additionalProperties: false,
  properties: {
    name:            { type: 'string', minLength: 1 },
    tier:            { type: 'integer', minimum: 1, maximum: 3 },
    owner:           { type: 'string' },
    environment:     { type: 'string' },
    availability:    { type: 'string' },
    confidentiality: { type: 'string' },
    domain:          { type: 'string' },
  },
  example: {
    name:        'Payments Platform',
    tier:        1,
    owner:       'payments-team',
    environment: 'production',
    domain:      'finance',
  },
}

export const ApplicationPatchBodySchema = {
  ...ApplicationCreateBodySchema,
  required: [],
}

// ── Component ────────────────────────────────────────────────────────────────
export const ComponentSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id:      { type: 'string', format: 'uuid' },
    name:    { type: 'string',  example: 'payment-api' },
    type:    { type: 'string',  example: 'api', description: 'service / api / worker / database / queue / cache / frontend / platform' },
    runtime: { type: ['string', 'null'], example: 'nodejs' },
    appId:   { type: ['string', 'null'], description: 'Containing Application id (or null if unattached)' },
    appName: { type: ['string', 'null'] },
  },
}

export const ComponentCreateBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name:          { type: 'string', minLength: 1 },
    type:          { type: 'string' },
    runtime:       { type: ['string', 'null'] },
    applicationId: { type: 'string', format: 'uuid', description: 'Optional parent Application id' },
    appId:         { type: 'string', format: 'uuid', description: 'Alias for applicationId' },
  },
  example: {
    name:          'payment-api',
    type:          'api',
    runtime:       'nodejs',
    applicationId: '00000000-0000-0000-0000-000000000000',
  },
}

export const ComponentConnectionBodySchema = {
  type: 'object',
  required: ['targetId'],
  additionalProperties: false,
  properties: {
    targetId: { type: 'string', format: 'uuid', description: 'The other Component to connect to' },
    protocol: { type: 'string', example: 'https' },
    port:     { type: ['integer', 'string', 'null'] },
  },
  example: {
    targetId: '00000000-0000-0000-0000-000000000000',
    protocol: 'https',
    port:     443,
  },
}

export const ComponentDeployBodySchema = {
  type: 'object',
  required: ['infraId'],
  additionalProperties: false,
  properties: {
    infraId: { type: 'string', format: 'uuid', description: 'Infra node to MERGE a :CONNECTS_TO {via:component-mapping} edge to' },
  },
  example: {
    infraId: '00000000-0000-0000-0000-000000000000',
  },
}

// ── Infra ────────────────────────────────────────────────────────────────────
export const InfraSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id:            { type: 'string', format: 'uuid' },
    cloud_id:      { type: ['string', 'null'], description: 'Cloud-native identifier — ARN / ARM ID / GCP self-link' },
    name:          { type: 'string' },
    provider:      { type: 'string', enum: ['aws', 'azure', 'gcp'] },
    resource_type: { type: 'string', example: 'vm' },
    region:        { type: 'string', example: 'eastus' },
    public:        { type: 'boolean' },
    tags:          { type: ['object', 'string'], description: 'Free-form tag map (object) or stringified JSON (legacy)' },
    raw:           { type: ['object', 'string'], description: 'Provider-specific payload' },
  },
}

export const InfraCreateBodySchema = {
  type: 'object',
  required: ['name', 'provider', 'resource_type'],
  additionalProperties: false,
  properties: {
    name:          { type: 'string', minLength: 1 },
    provider:      { type: 'string', enum: ['aws', 'azure', 'gcp'] },
    resource_type: { type: 'string', minLength: 1 },
    region:        { type: 'string' },
    public:        { type: 'boolean' },
  },
  example: {
    name:          'web-server-01',
    provider:      'azure',
    resource_type: 'vm',
    region:        'eastus',
    public:        false,
  },
}

export const InfraPatchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name:   { type: 'string' },
    region: { type: 'string' },
    public: { type: 'boolean' },
  },
}

// ── Cloud account (under /integrations/cloud) ────────────────────────────────
export const CloudAccountSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id:               { type: 'string', format: 'uuid' },
    provider:         { type: 'string', enum: ['aws', 'azure', 'gcp'] },
    name:             { type: 'string' },
    config:           {
      type: 'object', additionalProperties: true,
      description: 'Provider-specific credentials. Secret fields (clientSecret, secretAccessKey, private_key) are AES-256-GCM encrypted at rest.',
    },
    enabled:          { type: 'boolean' },
    last_scan_at:     { type: ['string', 'null'], format: 'date-time' },
    last_scan_status: { type: ['string', 'null'] },
    last_scan_total:  { type: ['integer', 'null'] },
    last_scan_error:  { type: ['string', 'null'] },
    created_at:       { type: ['string', 'null'], format: 'date-time' },
    updated_at:       { type: ['string', 'null'], format: 'date-time' },
  },
}

export const CloudAccountCreateBodySchema = {
  type: 'object',
  required: ['provider', 'name'],
  // Outer envelope is strict; the nested `config` stays permissive because
  // it's polymorphic across providers (Azure SP, GCP service-account JSON,
  // AWS access keys + aggregator coords). Per-field validation happens in
  // the route handler (see integrations-cloud.js validateProviderConfig).
  additionalProperties: false,
  properties: {
    provider: { type: 'string', enum: ['aws', 'azure', 'gcp'] },
    name:     { type: 'string', minLength: 1 },
    config:   {
      type: 'object',
      additionalProperties: true,
      description: 'Azure: { subscriptionId, tenantId, clientId, clientSecret }. GCP: { projectId, serviceAccount: <JSON string> }. AWS: { accessKeyId, secretAccessKey, regions, aggregatorName, aggregatorRegion }.',
    },
    enabled:  { type: 'boolean' },
  },
  example: {
    provider: 'azure',
    name:     'azure-prod',
    config: {
      subscriptionId: '00000000-0000-0000-0000-000000000000',
      tenantId:       '00000000-0000-0000-0000-000000000000',
      clientId:       '00000000-0000-0000-0000-000000000000',
      clientSecret:   'REPLACE_ME',
    },
    enabled: true,
  },
}

// ── Discovery scan response ──────────────────────────────────────────────────
export const ScanBreakdownSchema = {
  type: 'object',
  additionalProperties: true,
  description: 'Per-resource-type counts plus diagnostics. Keys vary by provider: Azure=vms/aks/sql/appService/functionApp/redis/vnet, GCP=instances/gke/sql/cloudRun, AWS=ec2/rds/lambda/eks/ecs/alb/elasticache. Common: edges, errors[], skipped[], scanEpoch.',
}

export const ScanResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    provider:    { type: 'string', enum: ['aws', 'azure', 'gcp'] },
    accounts:    { type: 'integer' },
    duration:    { type: 'integer', description: 'Wall-clock ms' },
    total:       { type: 'integer', description: 'Sum of resource-type counts (excludes edges/errors/skipped/scanEpoch)' },
    breakdown:   ScanBreakdownSchema,
    stale:       {
      type: 'object', additionalProperties: true,
      properties: {
        removed:     { type: 'integer' },
        markedStale: { type: 'integer' },
        skipped:     { type: 'boolean' },
        errors:      { type: 'array', items: { type: 'string' } },
      },
    },
    bootstrap:   { type: ['object', 'null'], additionalProperties: true },
    enrichment:  { type: ['object', 'null'], additionalProperties: true },
    completedAt: { type: 'string', format: 'date-time' },
  },
}

// ── Discovery suggestion + apply-all action ──────────────────────────────────
export const SuggestionSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    infraId:     { type: 'string', format: 'uuid' },
    rtype:       { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          componentId:   { type: 'string', format: 'uuid' },
          componentName: { type: 'string' },
          score:         { type: 'integer' },
          rule:          { type: 'string' },
        },
      },
    },
  },
}

export const SuggestApplyAllBodySchema = {
  type: 'object',
  required: ['actions'],
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      // M3 — bound the bulk-action surface so a request can't pin the
      // server with a 100k-element array. 1000 mappings per call is far
      // beyond any realistic operator workflow and well below the JSON
      // body limit (~1 MB). Clients hitting this should batch.
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action:        { type: 'string', enum: ['link_component', 'create_component', 'create_application'] },
          infraId:       { type: 'string' },
          componentId:   { type: 'string' },
          applicationId: { type: 'string' },
          newAppName:    { type: 'string' },
          newCompName:   { type: 'string' },
          suggestedTier: { type: 'integer', minimum: 1, maximum: 3 },
          suggestedEnv:  { type: 'string' },
          suggestedOwner:{ type: 'string' },
          suggestedType: { type: 'string' },
          // Nested components array is polymorphic input — leave permissive.
          components:    { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  },
  example: {
    actions: [
      {
        action:      'link_component',
        infraId:     '00000000-0000-0000-0000-000000000000',
        componentId: '00000000-0000-0000-0000-000000000000',
      },
      {
        action:        'create_component',
        infraId:       '00000000-0000-0000-0000-000000000000',
        applicationId: '00000000-0000-0000-0000-000000000000',
        newCompName:   'payment-worker',
        suggestedType: 'worker',
      },
      {
        action:         'create_application',
        newAppName:     'Payments Platform',
        suggestedTier:  2,
        suggestedEnv:   'production',
        suggestedOwner: 'platform-team',
        components: [
          { infraId: '00000000-0000-0000-0000-000000000000' },
        ],
      },
    ],
  },
}

// ── Graph topology + walk (impact / dependencies) ───────────────────────────
export const GraphTopologyResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    apps:        { type: 'array', items: ApplicationSchema },
    components:  { type: 'array', items: ComponentSchema },
    connections: { type: 'array', items: { type: 'object', additionalProperties: true } },
    deployments: { type: 'array', items: { type: 'object', additionalProperties: true } },
    infra:       { type: 'array', items: InfraSchema },
  },
}

// Shared shape for /graph/impact (inbound walk) and /graph/dependencies
// (outbound walk). Both endpoints BFS over `:CONNECTS_TO`, dedup nodes
// + edges, annotate each node with `depth`, and return the full edge
// contract per traversed edge.
export const GraphWalkResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    root: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id:    { type: 'string' },
        label: { type: 'string', description: 'Application, Component, or Infra (Infra is only valid on /graph/impact).' },
        name:  { type: 'string' },
      },
    },
    seeds: {
      type: 'array',
      description: 'BFS seed nodes. Application root → contained Components; Component root → the Component itself; Infra root (impact only) → the Infra itself.',
      items: { type: 'object', additionalProperties: true },
    },
    nodes: {
      type: 'array',
      description: 'Every reachable node, deduped by id, annotated with `depth` (1 = direct neighbour of a seed).',
      items: { type: 'object', additionalProperties: true },
    },
    edges: {
      type: 'array',
      description: 'Every :CONNECTS_TO edge traversed during the walk. Always presented in the writer-emitted direction (`from` → `to`), regardless of BFS direction. Carries the full edge contract: source, via, confidence, evidence (plus any writer-specific extras like protocol/port/role).',
      items: { type: 'object', additionalProperties: true },
    },
    truncated: { type: 'boolean', description: 'True when the BFS hit `nodeCap` or `maxDepth` before exhausting the reachable subgraph.' },
    stats: {
      type: 'object',
      additionalProperties: true,
      properties: {
        nodesReturned: { type: 'integer' },
        edgesReturned: { type: 'integer' },
        reachedDepth:  { type: 'integer' },
        maxDepth:      { type: 'integer' },
        nodeCap:       { type: 'integer' },
      },
    },
  },
}

// ── Health ───────────────────────────────────────────────────────────────────
export const HealthResponseSchema = {
  type: 'object',
  required: ['status', 'timestamp'],
  properties: {
    status:    { type: 'string', enum: ['ok'] },
    timestamp: { type: 'string', format: 'date-time' },
  },
}
