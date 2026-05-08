// utils/pg-helpers.js
//
// The transactional building blocks fastify.pg.{forTenant, transaction}
// are built from. Lives in utils/ rather than inline in plugins/postgres.js
// so unit tests can exercise the live module instead of a duplicated mirror.
//
// ── Contract ─────────────────────────────────────────────────────────────────
// runInTransaction(pool, searchPathClause, fn):
//   - checks out a client from `pool`
//   - BEGIN
//   - if searchPathClause is non-null, runs it (single statement)
//   - awaits fn(client) — callers do their own queries on this client
//   - COMMIT on resolve, ROLLBACK on reject
//   - releases the client in both paths
//
// makeForTenant(pool, schemaName):
//   - validates schemaName eagerly (via quoteSchemaIdent) so an unsafe
//     value fails before any connection is checked out
//   - returns { schemaName, query, transaction } where each call goes
//     through runInTransaction with a pre-built `SET LOCAL search_path`
//
// makeControlTransaction(pool):
//   - returns a function that runs fn(client) in a BEGIN/COMMIT, with
//     no search_path change. Used by control-plane code (POST
//     /admin/tenants's row-insert + schema-provision pair).
//
// quoteSchemaIdent(name):
//   - exposes the same allowlist used by tenant-schema-runner.js
//     (`^[a-z_][a-z0-9_]{1,62}$`), wrapped in double quotes. Throws
//     on any name that doesn't match. Identical regex to the runner's
//     so a name accepted in one place is accepted in the other.

// PostgreSQL identifier safety: schema names go straight into a
// dynamic-SQL string (`SET LOCAL search_path` cannot be parameterized).
// Reject anything outside the conservative tenant-schema shape so a
// caller can't smuggle SQL through schemaName.
export function quoteSchemaIdent(name) {
  if (!/^[a-z_][a-z0-9_]{1,62}$/.test(name)) {
    throw new Error(`pg-helpers: refusing unsafe schema name '${name}'`)
  }
  return `"${name}"`
}

export async function runInTransaction(pool, searchPathClause, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (searchPathClause) {
      await client.query(searchPathClause)
    }
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

export function makeForTenant(pool, schemaName) {
  // Validate eagerly so an unsafe name fails before any connection
  // checkout. The pre-built clause is reused on every call.
  const ident = quoteSchemaIdent(schemaName)
  const searchPathClause = `SET LOCAL search_path = ${ident}, public`
  return {
    schemaName,
    query: async (sql, params = []) =>
      runInTransaction(pool, searchPathClause, async (client) =>
        (await client.query(sql, params)).rows,
      ),
    transaction: (fn) => runInTransaction(pool, searchPathClause, fn),
  }
}

export function makeControlTransaction(pool) {
  return (fn) => runInTransaction(pool, null, fn)
}
