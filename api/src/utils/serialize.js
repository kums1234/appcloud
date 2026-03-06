import neo4j from 'neo4j-driver'

/**
 * Recursively convert Neo4j driver types to plain JS values.
 * - neo4j.Integer  → JS number
 * - neo4j.DateTime → ISO string
 * - Arrays         → recursed
 * - Plain objects  → recursed
 */
export function serialize(value) {
  if (value === null || value === undefined) return value
  if (neo4j.isInt(value)) return value.toNumber()
  if (
    value instanceof neo4j.types.DateTime ||
    value instanceof neo4j.types.Date ||
    value instanceof neo4j.types.Time ||
    value instanceof neo4j.types.LocalDateTime ||
    value instanceof neo4j.types.LocalTime ||
    value instanceof neo4j.types.Duration
  ) return value.toString()
  if (Array.isArray(value)) return value.map(serialize)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v)
    return out
  }
  return value
}

/** Serialize a Neo4j node's .properties bag */
export function props(node) {
  if (!node) return null
  return serialize(node.properties ?? node)
}