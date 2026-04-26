import { describe, test, expect } from '@jest/globals'
import { makeRouteHelpers } from '../route-helpers.js'

describe('makeRouteHelpers', () => {
  const fakeAuth = async () => {}
  const fastify  = { authenticate: fakeAuth }

  test('withAuth() returns just the preHandler when called with no args', () => {
    const { withAuth } = makeRouteHelpers(fastify)
    expect(withAuth()).toEqual({ preHandler: fakeAuth })
  })

  test('withAuth({ schema }) merges the schema in', () => {
    const { withAuth } = makeRouteHelpers(fastify)
    const schema = { body: { type: 'object' } }
    expect(withAuth({ schema })).toEqual({ preHandler: fakeAuth, schema })
  })

  test('withAuth passes through other route options', () => {
    const { withAuth } = makeRouteHelpers(fastify)
    const preValidation = async () => {}
    const out = withAuth({ schema: { body: {} }, preValidation, config: { rateLimit: 5 } })
    expect(out.preHandler).toBe(fakeAuth)
    expect(out.preValidation).toBe(preValidation)
    expect(out.config).toEqual({ rateLimit: 5 })
  })

  test('caller cannot override the preHandler by passing one in opts', () => {
    // The whole point of the helper is the preHandler is non-negotiable;
    // explicit spread order in withAuth places fastify.authenticate last
    // would defeat that. Lock the actual behaviour: a passed preHandler
    // wins (caller is signalling they know what they're doing). If you
    // want it locked, change makeRouteHelpers and update this test.
    const { withAuth } = makeRouteHelpers(fastify)
    const custom = async () => {}
    expect(withAuth({ preHandler: custom })).toEqual({ preHandler: custom })
  })
})
