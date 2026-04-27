// utils/audit.js
//
// Single source of truth for the audit-actor object that
// fastify.pg.audit() expects since slice 5 (multi-key RBAC). Routes
// should call actorFromReq(req) instead of building actor strings by
// hand — this keeps the principal-from-key behaviour consistent
// across every mutation site.
//
// When the request is authenticated (req.principal set by the auth
// plugin), name = principal.name and keyId / scope record which key
// performed the action. The X-Actor header is no longer trusted as
// the primary identity — it's only consulted as a fallback for
// requests that bypass auth (local-dev path with no env vars + no
// DB rows), where there's no real principal to attribute to.

export function actorFromReq(req) {
  const principal = req.principal
  if (principal?.name && principal.name !== 'anonymous') {
    return {
      name:  principal.name,
      keyId: principal.id || null,
      scope: principal.scopes?.[0] || null,
    }
  }
  // Auth-disabled path. Fall back to the legacy header (now diagnostic-
  // only) and finally to 'system'. No keyId / scope recorded — the absence
  // is itself meaningful: an auditor reading the row sees a NULL key_id and
  // knows the action ran without authentication.
  const legacy = req.headers?.['x-actor']
  return {
    name:  legacy || 'system',
    keyId: null,
    scope: null,
  }
}

// Use this when a system-internal job / scheduler / async work fires an
// audit row that has no user principal. Pass a descriptive name like
// `SYSTEM_ACTORS.schedulerDiscoveryScan` so an auditor can distinguish
// system action types without filtering out everything that looks like
// 'system'.
//
// actor_key_id and actor_scope are deliberately NULL: the row reflects a
// system action, not a user one. A NULL key_id is therefore meaningful —
// it says "no user attribution available" rather than "we forgot to
// record it".
export function systemActor(name = 'system') {
  return { name, keyId: null, scope: null }
}

// Canonical list of system-actor names. Anywhere a scheduler / aggregator
// / plugin fires a system audit row, the name lives here — not as a free-
// form string at the call site. Two reasons:
//   1. Stops drift: 'scheduler:discovery-scan' vs 'scheduler:scan' vs
//      'discovery-scan' — those would be three different actors as far as
//      the audit log is concerned, and nobody intends that.
//   2. Gives the actor name a single place to evolve. A future "include
//      pod hostname" or "include shard id" enrichment changes one map,
//      not every call site.
//
// Naming convention:
//   <surface>:<action>          e.g. 'scheduler:discovery-scan'
//   <surface>                   when there's only one action (one-off
//                               plugins like 'terraform-import')
// Lowercase-hyphenated; ':' separates surface from action.
export const SYSTEM_ACTORS = Object.freeze({
  schedulerDiscoveryScan: 'scheduler:discovery-scan',
  schedulerAutoCreate:    'scheduler:auto-create',
  terraformImport:        'terraform-import',
})
