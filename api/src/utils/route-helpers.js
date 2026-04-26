// Small helpers for Fastify route registration. Today this is just
// `withAuth` — a thin wrapper over `{ preHandler: fastify.authenticate, ... }`
// so route files can't accidentally register an authed route without the
// preHandler, or pin a schema without auth.
//
// Usage:
//   const { withAuth } = makeRouteHelpers(fastify)
//   fastify.post('/things', withAuth({ schema: { body: ... } }), handler)
//
// Naming: the desired name `protected` is a reserved word in JS strict mode
// (ES modules are always strict), so `withAuth` is used instead.

export function makeRouteHelpers(fastify) {
  return {
    withAuth: (opts = {}) => ({ preHandler: fastify.authenticate, ...opts }),
  }
}
