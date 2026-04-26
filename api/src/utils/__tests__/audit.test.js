import { describe, test, expect } from '@jest/globals'
import { actorFromReq } from '../audit.js'

describe('actorFromReq', () => {
  test('uses req.principal.name when present', () => {
    const req = {
      principal: { name: 'ci-deploy-bot', id: 'uuid-1', scopes: ['write'] },
      headers:   { 'x-actor': 'should-be-ignored' },
    }
    expect(actorFromReq(req)).toEqual({
      name:  'ci-deploy-bot',
      keyId: 'uuid-1',
      scope: 'write',
    })
  })

  test('records the highest scope at scopes[0]', () => {
    const req = {
      principal: { name: 'admin-key', id: 'uuid-2', scopes: ['admin', 'write', 'read'] },
      headers:   {},
    }
    expect(actorFromReq(req).scope).toBe('admin')
  })

  test("falls back to X-Actor when principal is the auth-disabled 'anonymous'", () => {
    // The auth plugin uses { name: 'anonymous' } when no env keys + no DB
    // rows exist (local-dev path). For audit purposes treat it as no
    // principal — the diagnostic X-Actor header takes over.
    const req = {
      principal: { name: 'anonymous', scopes: ['admin'] },
      headers:   { 'x-actor': 'kums' },
    }
    expect(actorFromReq(req)).toEqual({
      name:  'kums',
      keyId: null,
      scope: null,
    })
  })

  test("falls back to 'system' when neither principal nor X-Actor is present", () => {
    expect(actorFromReq({ headers: {} })).toEqual({
      name:  'system',
      keyId: null,
      scope: null,
    })
  })

  test('handles missing headers object gracefully', () => {
    expect(actorFromReq({})).toEqual({
      name:  'system',
      keyId: null,
      scope: null,
    })
  })
})
