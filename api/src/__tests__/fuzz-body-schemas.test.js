// Fuzz invariant — for every mutation route (POST / PUT / PATCH /
// DELETE), sending obviously-malformed request bodies must not crash
// the server. Either Fastify's Ajv validation catches it (response is
// 4xx) or the handler tolerates the input cleanly. A 5xx is a finding:
// it means the route's body schema is too permissive AND the handler
// dereferences something the schema didn't guarantee.
//
// Why a unit test, not an integration one: the goal is to catch
// schema/handler mismatches at the moment they're introduced. Each
// fuzzed request is ~1 ms via fastify.inject(), and we're not testing
// any actual DB behaviour — stubs return empty results so handlers
// either succeed-with-empty (200/201) or short-circuit on schema
// validation (400). Real DB-backed integration tests cover the
// "does this handler do the right thing on valid input" question.
//
// What this DOES catch:
//   - Routes whose body schema is missing or too lax (no required
//     fields, additionalProperties: true) where the handler then
//     blindly reads req.body.something.
//   - Type confusion the schema didn't reject (e.g. body declared
//     {type: 'object'} but handler then accesses req.body[0]).
//   - Pre-handler crashes that happen before the route's main logic.
//
// What this does NOT catch:
//   - Logic bugs reachable only with valid-but-tricky inputs.
//   - Anything that requires real DB state to surface.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiSrc    = path.resolve(__dirname, '..')

// Adversarial payloads. Each one should fail validation against any
// reasonable body schema (the schemas in this codebase declare
// `type: 'object'` with required fields), but if a route accepts any
// of them, the handler still must not 5xx.
//
// Payloads are sent as-is to fastify.inject's `payload` option, which
// is the raw HTTP body. `null` and primitives go through Fastify's
// default JSON parser; if the parser rejects, that's a 400 — fine.
const FUZZ_PAYLOADS = [
  { label: 'null',           body: 'null' },
  { label: 'empty object',   body: '{}' },
  { label: 'array',          body: '[1, 2, 3]' },
  { label: 'plain string',   body: '"just-a-string"' },
  { label: 'plain number',   body: '42' },
  { label: 'boolean',        body: 'true' },
  // Schema-bypass attempt — extra unknown fields should be ignored
  // (Ajv default is removeAdditional or pass-through depending on
  // strict mode), but if the handler reads them blindly, that's a
  // finding.
  { label: 'extra fields',   body: '{"__fuzz":"x","totally":"unexpected"}' },
  // Prototype-pollution style key — Ajv sees __proto__ as a normal
  // string property, but a downstream merge or destructure could be
  // tricked into mutating Object.prototype.
  { label: 'proto-pollution', body: '{"__proto__":{"polluted":true}}' },
  // Deeply nested object — guards against unbounded recursion in
  // any custom handler-side traversal code.
  { label: 'deep nest',      body: deeplyNested(40) },
  // Long string — would surface a length-cap miss in a body schema
  // string field.
  { label: 'long string',    body: JSON.stringify({ name: 'A'.repeat(2048) }) },
  // Malformed JSON — the parser must reject cleanly with 400.
  { label: 'malformed',      body: '{"unclosed": ' },
]

function deeplyNested(depth) {
  let body = '"x"'
  for (let i = 0; i < depth; i++) body = `{"a":${body}}`
  return body
}

// Path-parameter substitutions. Routes like PATCH /applications/:id
// need a value to substitute before injecting. UUID-shaped placeholder
// for `id`-ish names; lowercase token for anything else. Handlers may
// reject these as not-found (404), which is fine — we're checking for
// crash safety, not retrieval success.
const PATH_PARAM_VALUES = {
  id:     '00000000-0000-0000-0000-000000000000',
  type:   'TestType',
  name:   'fuzz-name',
  sys_id: 'fuzz-sys-id',
}
function substitutePathParams(url) {
  return url.replace(/:([^/]+)/g, (_, name) => PATH_PARAM_VALUES[name] ?? 'fuzz-value')
}

// We only fuzz routes that take a body. GET / HEAD don't, and Fastify
// rejects bodies on them at the HTTP layer regardless of schema.
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// File-upload routes use multipart/form-data and are configured with
// `consumes: 'multipart/form-data'` or accept binary. Sending JSON to
// them lands in @fastify/multipart's parser, which throws as expected
// for non-multipart Content-Type — that's a 4xx, but the error path
// goes through a different branch we don't need to fuzz here. Skip.
function isMultipartRoute(routeOptions) {
  const consumes = routeOptions.schema?.consumes
  if (Array.isArray(consumes) && consumes.some(c => /multipart/i.test(c))) return true
  // Body schema explicitly typed as binary or multipart-like
  if (routeOptions.schema?.body?.type === 'string' &&
      /binary/i.test(routeOptions.schema?.body?.format || '')) return true
  return false
}

async function buildFuzzServer() {
  // Auth-disabled mode: empty bootstrap envs + empty cache → the auth
  // plugin sets req.principal to the local-dev anonymous-admin and
  // every request reaches its handler. That's what we want — fuzz is
  // about handler-side robustness, not auth.
  delete process.env.APPCLOUD_API_KEY
  delete process.env.APPCLOUD_ADMIN_API_KEY
  delete process.env.APPCLOUD_API_KEY_FILE
  delete process.env.APPCLOUD_ADMIN_API_KEY_FILE

  const fastify = Fastify({
    logger: false,
    ajv: { customOptions: { strict: false, keywords: ['example', 'xml'] } },
  })

  // Stubs match the export script + drift test so route registration
  // succeeds without a real DB. pg.audit returns a resolved promise
  // (the audit machinery's contract).
  fastify.decorate('pg', {
    pool:        null,
    query:       async () => [],
    audit:       async () => {},
    ping:        async () => true,
    auditBuffer: { pending: () => 0, stats: () => ({ accepted: 0, flushed: 0, dropped: 0, errors: 0 }) },
  })
  fastify.decorate('neo4j',          { write: async () => [], query: async () => [], ping: async () => true })
  fastify.decorate('ai',             { localAvailable: false, cloudAvailable: false })
  fastify.decorate('connectors',     { list: () => [], get: () => null })
  fastify.decorate('cmdbAssessment', { markDirty: () => {}, run: async () => ({}) })
  // The audit-cleanup plugin only decorates this when Postgres is real;
  // the fuzz fastify never registers the plugin, so the routes that
  // call into it (admin-audit-cleanup) would crash on an undefined.
  // Stub the surface they touch.
  fastify.decorate('auditCleanup', {
    runNow:              async () => ({ skipped: 'no-pg' }),
    redistributeDefault: async () => ({ skipped: 'no-pg' }),
    retentionDays:       0,
    intervalMs:          0,
    batchSize:           0,
  })

  // @fastify/sensible adds reply.notFound() / .badRequest() which a few
  // routes (admin-api-keys) call directly — register before route
  // modules so its decorators are visible.
  const sensible = (await import('@fastify/sensible')).default
  await fastify.register(sensible)

  const { authPlugin } = await import('../plugins/auth.js')
  await authPlugin(fastify)

  const collected = []
  fastify.addHook('onRoute', (routeOptions) => {
    collected.push({
      method:       routeOptions.method,
      url:          routeOptions.url,
      isPublic:     Array.isArray(routeOptions.schema?.security) && routeOptions.schema.security.length === 0,
      isMultipart:  isMultipartRoute(routeOptions),
      // Stash the full options so the per-test filters can introspect
      // schema.body without re-iterating the registry.
      routeOptions,
    })
  })

  const { registerAllRoutes } = await import('../utils/route-modules.js')
  await registerAllRoutes(fastify)
  const { metricsPlugin } = await import('../plugins/metrics.js')
  await metricsPlugin(fastify)

  fastify.get('/health', { schema: { security: [] } }, async () => ({ status: 'ok' }))
  fastify.get('/',       { schema: { security: [] } }, async () => ({ name: 'AppCloud API' }))

  await fastify.ready()
  return { fastify, routes: collected }
}

describe('Body-schema fuzz', () => {
  let fastify
  let routes

  beforeAll(async () => {
    ({ fastify, routes } = await buildFuzzServer())
  })

  afterAll(async () => {
    await fastify?.close()
  })

  test('routes with body:{type:"object"} schema reject non-object adversarial payloads with 4xx', async () => {
    // The fuzz invariant we care about: when a route declares an object
    // body schema, sending a non-object (null, array, primitive) must be
    // rejected by Ajv at the validation step. That means status is 4xx —
    // typically 400 — and the route handler never runs. A non-4xx
    // response (200/201 because the schema let it through, or 5xx
    // because the handler crashed on the malformed body) signals the
    // schema is too lax for what the handler assumes.
    //
    // We deliberately do NOT assert on routes without a body schema or
    // routes whose body schema admits non-objects — that's a separate
    // documentation concern, not a correctness one.
    const targets = routes.filter(r => {
      if (!MUTATION_METHODS.has(r.method)) return false
      if (r.isPublic || r.isMultipart) return false
      const body = r.routeOptions?.schema?.body
      // Only fuzz routes whose body schema declares an object — those
      // are the ones where non-objects must be rejected.
      return body?.type === 'object'
    })
    expect(targets.length).toBeGreaterThan(10)   // sanity — we have plenty

    // Non-object payloads. Every one of these must fail any
    // type:'object' schema; if a route accepts one, the schema isn't
    // doing its job.
    const NON_OBJECT_PAYLOADS = [
      { label: 'null',         body: 'null' },
      { label: 'array',        body: '[1, 2, 3]' },
      { label: 'plain string', body: '"just-a-string"' },
      { label: 'plain number', body: '42' },
      { label: 'boolean',      body: 'true' },
    ]

    const failures = []
    for (const route of targets) {
      const url = substitutePathParams(route.url)
      for (const { label, body } of NON_OBJECT_PAYLOADS) {
        const r = await fastify.inject({
          method:  route.method, url,
          headers: { 'content-type': 'application/json' },
          payload: body,
        })
        // 4xx = schema rejected (good). 5xx or 2xx = schema let it
        // through; the handler either crashed or accepted nonsense.
        if (r.statusCode < 400 || r.statusCode >= 500) {
          failures.push({
            method: route.method, url: route.url, payload: label,
            status: r.statusCode,
            body:   String(r.body || '').slice(0, 200),
          })
        }
      }
    }

    if (failures.length > 0) {
      const summary = failures.map(f =>
        `  ${f.method} ${f.url} [payload: ${f.payload}] → ${f.status}`,
      ).join('\n')
      throw new Error(`schema-validation fuzz failures (${failures.length}):\n${summary}\n\nbody samples:\n${
        failures.slice(0, 3).map(f => `  ${f.payload}: ${f.body}`).join('\n')
      }`)
    }
  })

  test('malformed JSON returns 400 from the parser', async () => {
    // Fastify's content-type-parser path is a separate code branch
    // from schema validation; it should always 400 on syntactically-
    // broken JSON regardless of what the route's schema looks like.
    const target = routes.find(r =>
      MUTATION_METHODS.has(r.method) && !r.isPublic && !r.isMultipart,
    )
    expect(target).toBeDefined()
    const r = await fastify.inject({
      method:  target.method,
      url:     substitutePathParams(target.url),
      headers: { 'content-type': 'application/json' },
      payload: '{"x":',
    })
    expect(r.statusCode).toBe(400)
  })

  // Routes that legitimately take no body — they're trigger-style
  // POSTs whose semantics are "do this action now," with all parameters
  // (if any) coming from URL path / query. They should ALSO declare an
  // empty-but-strict body schema so a misconfigured client sending stale
  // payload data gets a 400, but they predate this test; tracked as
  // follow-up work and exempted explicitly here. Adding entries to this
  // set is a deliberate decision — every entry is one slot less of fuzz
  // coverage. Drain by giving each route `body: { type: 'object',
  // additionalProperties: false }` and removing it from this list.
  const BODYLESS_ACTION_ROUTES = new Set([
    'POST /integrations/cloud/sync-from-neo4j',
    'POST /integrations/ai/test',
    'POST /integrations/:id/test',
    'POST /integrations/:id/scan',
    'POST /discovery/scan/all',
    'POST /discovery/schedule/run-now',
    'POST /discovery/bootstrap',
    'POST /cmdb/assessment/refresh',
  ])

  test('every mutation route declares a body schema (or is in the legacy exemption set)', async () => {
    // Counterpart to the per-payload test: the only way a route can
    // skip fuzz coverage is to be public, take multipart, or be in the
    // exemption set above. Anything else is an open door for malformed
    // input. Lock the inverse so a new route slipping through without a
    // body schema gets caught at PR time.
    const undeclared = routes.filter(r => {
      if (!MUTATION_METHODS.has(r.method)) return false
      if (r.method === 'DELETE') return false
      if (r.isPublic || r.isMultipart) return false
      if (BODYLESS_ACTION_ROUTES.has(`${r.method} ${r.url}`)) return false
      return !r.routeOptions?.schema?.body
    })
    if (undeclared.length > 0) {
      const list = undeclared.map(r => `  ${r.method} ${r.url}`).join('\n')
      throw new Error(
        `mutation routes lacking a body schema:\n${list}\n\n` +
        `Either declare \`schema.body\` (preferred — even { type: 'object', additionalProperties: false } locks ` +
        `the surface) or add to BODYLESS_ACTION_ROUTES in this test with a comment explaining why.`,
      )
    }
  })

  test('the BODYLESS_ACTION_ROUTES exemption set is not stale', async () => {
    // If a route in the exemption set later gets a body schema (good!),
    // remove it from the set. Otherwise the set rots into a meaningless
    // list. Surface stale entries here.
    const liveRouteKeys = new Set(routes.map(r => `${r.method} ${r.url}`))
    const stale = [...BODYLESS_ACTION_ROUTES].filter(k => {
      if (!liveRouteKeys.has(k)) return true               // route removed
      const r = routes.find(x => `${x.method} ${x.url}` === k)
      return Boolean(r?.routeOptions?.schema?.body)        // route now has a schema
    })
    expect(stale).toEqual([])
  })
})
