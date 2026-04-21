// api/src/compliance/form-evaluator.js
// Compiles a structured "form rule" into a safe, parameterised Cypher query.
// Used by custom controls (evaluator='form') so users can define compliance
// checks through a form builder in the UI without writing raw Cypher.
//
// Security model:
//   - Resource type must match one of RESOURCE_TYPE_WHITELIST (labels only,
//     no injection via arbitrary strings).
//   - Property names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.
//   - Operators come from a fixed whitelist; each maps to a specific Cypher
//     fragment. We never interpolate user text directly into the query.
//   - Values always flow through $params — no string concatenation.
//   - Output shape is always MATCH/OPTIONAL MATCH + WHERE + RETURN, no writes.

// ── Resource types allowed for custom controls ───────────────────────────────
// A curated subset of labels safe to query. Matches what the UI exposes in the
// form builder dropdown. Built-in controls can still reference any label via
// their hand-written Cypher.

export const RESOURCE_TYPE_WHITELIST = new Set([
  // Core application/graph types
  'Application',
  'Component',
  'Change',
  'Infra',
  'User',
  // Ontology categories (cross-provider)
  'ComputeInstance',
  'DatabaseInstance',
  'ContainerCluster',
  'WebService',
  'ServerlessFunction',
  'CacheInstance',
  'ObjectStorage',
  'NetworkDevice',
  'MessageBroker',
  'MonitoringService',
  'SecretsManager',
  'VirtualNetwork',
  'APIGateway',
  'HostingPlan',
  'ContainerService',
  'ContainerRegistry',
  'DNSService',
  // AWS-specific
  'EC2Instance', 'RDSInstance', 'LambdaFunction', 'EKSCluster', 'ECSCluster',
  'AWSLoadBalancer', 'ElastiCache', 'S3Bucket', 'DynamoDBTable',
  // Azure-specific
  'AzureVM', 'AzureAKS', 'AzureSQLServer', 'AzureSQLDatabase', 'AzureAppService',
  'AzureFunctionApp', 'AzureRedis', 'AzureVNet', 'AzureAppServicePlan',
  'AzureStorage', 'AzureKeyVault', 'AzureLoadBalancer', 'AzureAppGateway',
  'AzureFrontDoor', 'AzureContainerApp', 'AzureAPIM', 'AzureCosmosDB',
  'AzurePostgres', 'AzureMySQL', 'AzureACR', 'AzureNSG',
  // GCP-specific
  'GCPComputeInstance', 'GKECluster', 'GCPCloudSQL', 'GCPCloudRun',
  'GCPCloudFunction', 'GCSBucket',
])

// ── Operator catalogue ──────────────────────────────────────────────────────
// Each entry defines:
//   - arity: 'unary' (no value), 'binary' (single value), 'array' (list value),
//            'relationship' (needs {relationship, targetLabel?})
//   - toCypher(alias, prop, paramName): emits the WHERE fragment

const OPERATORS = {
  IS_NULL:          { arity: 'unary',        toCypher: (a, p) => `${a}.${p} IS NULL` },
  IS_NOT_NULL:      { arity: 'unary',        toCypher: (a, p) => `${a}.${p} IS NOT NULL` },
  EQUALS:           { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} = ${v}` },
  NOT_EQUALS:       { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} <> ${v}` },
  CONTAINS:         { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} CONTAINS ${v}` },
  NOT_CONTAINS:     { arity: 'binary',       toCypher: (a, p, v) => `NOT (${a}.${p} CONTAINS ${v})` },
  STARTS_WITH:      { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} STARTS WITH ${v}` },
  ENDS_WITH:        { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} ENDS WITH ${v}` },
  IN:               { arity: 'array',        toCypher: (a, p, v) => `${a}.${p} IN ${v}` },
  NOT_IN:           { arity: 'array',        toCypher: (a, p, v) => `NOT (${a}.${p} IN ${v})` },
  GREATER_THAN:     { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} > ${v}` },
  GREATER_OR_EQUAL: { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} >= ${v}` },
  LESS_THAN:        { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} < ${v}` },
  LESS_OR_EQUAL:    { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} <= ${v}` },
  MATCHES_REGEX:    { arity: 'binary',       toCypher: (a, p, v) => `${a}.${p} =~ ${v}` },
  EXISTS_RELATIONSHIP: { arity: 'relationship', toCypher: () => null }, // handled below
  MISSING_RELATIONSHIP: { arity: 'relationship', toCypher: () => null }, // handled below
}

export const OPERATOR_LIST = Object.entries(OPERATORS).map(([id, v]) => ({ id, arity: v.arity }))

// ── Validation helpers ──────────────────────────────────────────────────────

const PROP_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const RELATIONSHIP_RE = /^[A-Z][A-Z0-9_]*$/

function assertValidProp(name) {
  if (!PROP_NAME_RE.test(String(name || ''))) {
    throw new Error(`Invalid property name: ${name}`)
  }
}

function assertValidRelationship(name) {
  if (!RELATIONSHIP_RE.test(String(name || ''))) {
    throw new Error(`Invalid relationship type: ${name} (must be UPPER_SNAKE_CASE)`)
  }
}

function assertValidLabel(label) {
  if (!RESOURCE_TYPE_WHITELIST.has(String(label || ''))) {
    throw new Error(`Resource type not in whitelist: ${label}`)
  }
}

// ── Compiler ────────────────────────────────────────────────────────────────
// Input shape:
//   {
//     resourceType: 'Application',        // required, must be whitelisted
//     combineWith:  'AND' | 'OR',         // defaults to AND
//     conditions:   [
//       { property: 'owner', operator: 'IS_NULL' },
//       { property: 'owner', operator: 'EQUALS', value: '' },
//       { operator: 'MISSING_RELATIONSHIP', relationship: 'DEPLOYED_ON', targetLabel: 'Infra' },
//     ],
//     evidenceTemplate: 'No owner assigned'   // optional; can reference ${property} placeholders later
//   }
//
// Output:
//   { query, params, error? }

export function compileFormRule(formRule) {
  if (!formRule || typeof formRule !== 'object') {
    return { error: 'formRule is required' }
  }
  const { resourceType, conditions = [], evidenceTemplate = '' } = formRule
  const combineWith = (formRule.combineWith || 'AND').toUpperCase()

  if (combineWith !== 'AND' && combineWith !== 'OR') {
    return { error: `combineWith must be AND or OR, got ${combineWith}` }
  }

  try {
    assertValidLabel(resourceType)
  } catch (err) {
    return { error: err.message }
  }

  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { error: 'At least one condition is required' }
  }

  const params = {}
  const whereFragments = []
  const optionalMatches = []
  let paramIndex = 0

  for (const cond of conditions) {
    const opDef = OPERATORS[cond.operator]
    if (!opDef) {
      return { error: `Unknown operator: ${cond.operator}` }
    }

    if (opDef.arity === 'relationship') {
      // EXISTS_RELATIONSHIP / MISSING_RELATIONSHIP
      try {
        assertValidRelationship(cond.relationship)
      } catch (err) {
        return { error: err.message }
      }
      let targetLabel = ''
      if (cond.targetLabel) {
        try {
          assertValidLabel(cond.targetLabel)
        } catch (err) {
          return { error: err.message }
        }
        targetLabel = `:${cond.targetLabel}`
      }
      const patternAlias = `rel${paramIndex++}`
      const fragment =
        `EXISTS { MATCH (n)-[:${cond.relationship}]->(${patternAlias}${targetLabel}) }`
      whereFragments.push(cond.operator === 'EXISTS_RELATIONSHIP' ? fragment : `NOT ${fragment}`)
      continue
    }

    try {
      assertValidProp(cond.property)
    } catch (err) {
      return { error: err.message }
    }

    if (opDef.arity === 'unary') {
      whereFragments.push(opDef.toCypher('n', cond.property))
    } else {
      // binary or array — parameterise the value
      const paramName = `p${paramIndex++}`
      params[paramName] = cond.value
      whereFragments.push(opDef.toCypher('n', cond.property, `$${paramName}`))
    }
  }

  // Evidence text: keep it simple — static string passed as a param so we
  // don't risk Cypher injection via user-entered text.
  const evidenceParam = `_evidence`
  params[evidenceParam] = String(evidenceTemplate || 'Custom rule violation')

  const combinator = combineWith === 'OR' ? ' OR ' : ' AND '
  const whereClause = whereFragments.join(combinator)

  const query = [
    ...optionalMatches,
    `MATCH (n:${resourceType})`,
    `WHERE ${whereClause}`,
    `RETURN n.id AS resourceId,`,
    `       coalesce(n.name, n.title, toString(id(n))) AS resourceName,`,
    `       '${resourceType}' AS resourceType,`,
    `       $${evidenceParam} AS evidence`,
  ].join('\n')

  return { query, params }
}

// ── Schema for the UI form builder ──────────────────────────────────────────
// Curated per-type property lists. Keeps the form builder responsive (no graph
// scan on every keystroke) and guards against users selecting properties that
// don't exist. Admins can still type a property name manually (validated by
// PROP_NAME_RE) even if it isn't in this list.

export const PROPERTIES_BY_TYPE = {
  Application: [
    { name: 'name', type: 'string' },
    { name: 'tier', type: 'number' },
    { name: 'owner', type: 'string' },
    { name: 'environment', type: 'string' },
    { name: 'domain', type: 'string' },
    { name: 'confidentiality', type: 'string' },
  ],
  Component: [
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
  ],
  Change: [
    { name: 'title', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'riskScore', type: 'number' },
    { name: 'type', type: 'string' },
    { name: 'submittedBy', type: 'string' },
    { name: 'noRisk', type: 'boolean' },
  ],
  User: [
    { name: 'name', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'role', type: 'string' },
  ],
  // All Infra-like types share a common set of useful properties. The UI can
  // fall back to this set when a specific typed label isn't listed separately.
  Infra: [
    { name: 'name', type: 'string' },
    { name: 'provider', type: 'string' },
    { name: 'resource_type', type: 'string' },
    { name: 'region', type: 'string' },
    { name: 'public', type: 'boolean' },
    { name: 'status', type: 'string' },
    { name: 'resource_group', type: 'string' },
  ],
}

export function getSchema() {
  return {
    resourceTypes: [...RESOURCE_TYPE_WHITELIST].sort(),
    operators: OPERATOR_LIST,
    propertiesByType: PROPERTIES_BY_TYPE,
    defaults: {
      combineWith: 'AND',
      severity: 'MEDIUM',
      rating: 5,
    },
  }
}
