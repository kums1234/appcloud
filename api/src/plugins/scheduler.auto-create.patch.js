export async function runAutoCreateIfEnabled(fastify) {
  if (!fastify.pg?.pool) return

  const rows = await fastify.pg.query(
    `SELECT auto_create FROM discovery_schedule WHERE scope = 'global' LIMIT 1`
  )

  const enabled = rows[0]?.auto_create

  if (!enabled) return

  await fetch(`http://localhost:${process.env.PORT || 4000}/api/discovery/bootstrap`, {
    method: 'POST'
  }).catch(() => {})
}