// Small helpers for Fastify route registration. Today this is:
//
//   - `withAuth`: thin wrapper over { preHandler: fastify.authenticate, ... }
//     so route files can't accidentally register an authed route without
//     the preHandler.
//   - `requireTenantPg`: standard 400 when a tenant-scoped route is
//     reached without a resolved tenant (super-admin without
//     X-Tenant-Slug, or a misconfigured route bypass). Returns a
//     boolean — `false` means the helper has already replied; the
//     caller should `return` immediately.
//
// Naming: the desired name `protected` is a reserved word in JS strict mode
// (ES modules are always strict), so `withAuth` is used instead.

export function makeRouteHelpers(fastify) {
  return {
    withAuth: (opts = {}) => ({ preHandler: fastify.authenticate, ...opts }),
  }
}

// Standard "tenant-scoped route reached without req.pg" guard. Use at
// the top of every tenant-scoped route handler:
//
//   fastify.get('/foo', async (req, reply) => {
//     if (!requireTenantPg(req, reply)) return
//     const rows = await req.pg.query('SELECT …')
//   })
//
// req.pg is attached by plugins/tenant-context.js when the request
// resolves to an active tenant. The two scenarios where it isn't set:
//   - super-admin key with no X-Tenant-Slug (control-plane only)
//   - a route registered before tenant-context's onRoute hook runs (bug)
export function requireTenantPg(req, reply) {
  if (!req.pg) {
    reply.code(400).send({
      error:   'Bad Request',
      message: 'this route is tenant-scoped — provide an X-API-Key bound to a tenant (or X-Tenant-Slug for super-admin keys)',
    })
    return false
  }
  return true
}
