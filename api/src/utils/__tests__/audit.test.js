import { describe, test, expect } from '@jest/globals'
import { actorFromReq, systemActor, SYSTEM_ACTORS } from '../audit.js'

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

describe('systemActor', () => {
  test('defaults to plain "system"', () => {
    expect(systemActor()).toEqual({ name: 'system', keyId: null, scope: null })
  })

  test('takes a custom name for distinguishing system jobs', () => {
    expect(systemActor('scheduler:cmdb-assessment')).toEqual({
      name:  'scheduler:cmdb-assessment',
      keyId: null,
      scope: null,
    })
  })

  test('always returns NULL key + scope (the absence is meaningful)', () => {
    // Calling systemActor must NEVER fabricate a key id — a NULL actor_key_id
    // in the audit_log is what tells an auditor "this was a system action,
    // not a user one". Lock that contract here.
    const out = systemActor('any-name-at-all')
    expect(out.keyId).toBeNull()
    expect(out.scope).toBeNull()
  })
})

describe('SYSTEM_ACTORS naming convention', () => {
  // These exact strings are written into the audit_log.actor column —
  // changing one is a data-migration concern (existing rows reference
  // the old name). Lock the wire format here so a casual rename in
  // utils/audit.js fails this test loudly.
  test('canonical names match the on-disk format', () => {
    expect(SYSTEM_ACTORS).toEqual({
      schedulerDiscoveryScan: 'scheduler:discovery-scan',
      schedulerAutoCreate:    'scheduler:auto-create',
      terraformImport:        'terraform-import',
    })
  })

  test('every value is lowercase-hyphenated and uses ":" only as the surface separator', () => {
    // The convention is documented in utils/audit.js. Enforce it as a
    // test so a future addition can't slip in a typo or stray uppercase.
    const VALID = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/
    for (const [key, value] of Object.entries(SYSTEM_ACTORS)) {
      expect({ key, value }).toEqual({ key, value: expect.stringMatching(VALID) })
    }
  })

  test('object is frozen so callers cannot mutate the canonical list at runtime', () => {
    expect(Object.isFrozen(SYSTEM_ACTORS)).toBe(true)
  })
})
