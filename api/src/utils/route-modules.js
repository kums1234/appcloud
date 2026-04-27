// Single source of truth for the API route registration list. Used by:
//   - server.js                        (live HTTP server)
//   - scripts/export-openapi.js        (committed OpenAPI + Postman)
//   - __tests__/openapi-drift.test.js  (drift assertion)
//
// Order is load-bearing: routes registered later don't shadow earlier
// static paths. Both `discovery.metadata.js` and `integrations.management.js`
// rely on this — see the `// register after …` comments at the call site
// for the historical reasoning.
//
// Adding a new route = one entry here; the export script, drift test,
// and live server pick it up the next time they boot.

import applicationRoutes              from '../routes/applications.js'
import componentRoutes                from '../routes/components.js'
import infraRoutes                    from '../routes/infra.js'
import graphRoutes                    from '../routes/graph.js'
import integrationRoutes              from '../routes/integrations.js'
import cloudAccountRoutes             from '../routes/integrations-cloud.js'
import aiConfigRoutes                 from '../routes/integrations-ai.js'
import integrationManagementRoutes, {
  connectorsRegistryRoutes,
}                                     from '../routes/integrations.management.js'
import discoveryRoutes                from '../routes/discovery.js'
import discoveryMetadataRoutes        from '../routes/discovery.metadata.js'
import auditRoutes                    from '../routes/audit.js'
import cmdbRoutes                     from '../routes/cmdb.js'
import aiRoutes                       from '../routes/ai.js'
import adminApiKeyRoutes              from '../routes/admin-api-keys.js'
import adminAuditCleanupRoutes        from '../routes/admin-audit-cleanup.js'

export const ROUTE_MODULES = [
  [applicationRoutes,            { prefix: '/applications' }],
  [componentRoutes,              { prefix: '/components'   }],
  [infraRoutes,                  { prefix: '/infra'        }],
  [graphRoutes,                  { prefix: '/graph'        }],
  [integrationRoutes,            { prefix: '/integrations' }],
  [cloudAccountRoutes,           { prefix: '/integrations' }],
  [aiConfigRoutes,               { prefix: '/integrations' }],
  // Generic integrations CRUD — registered after the static-prefix routes
  // above (/cloud, /ai) so they keep priority over its `:id` matcher.
  [integrationManagementRoutes,  { prefix: '/integrations' }],
  // Connectors registry listing — separate prefix because it's a sibling
  // surface, not a nested integration concept.
  [connectorsRegistryRoutes,     { prefix: '/connectors'   }],
  [discoveryRoutes,              { prefix: '/discovery'    }],
  // Read-only metadata. Register after discoveryRoutes so static paths
  // under /discovery don't shadow the dynamic ones.
  [discoveryMetadataRoutes,      { prefix: '/discovery'    }],
  [auditRoutes,                  { prefix: '/audit'        }],
  [cmdbRoutes,                   { prefix: '/cmdb'         }],
  [adminApiKeyRoutes,            { prefix: '/admin'        }],
  [adminAuditCleanupRoutes,      { prefix: '/admin'        }],
  // aiRoutes last — server.js registers them after the aiPlugin decorate
  // step; the registration list keeps the same relative order so the
  // exported spec matches the live server byte-for-byte.
  [aiRoutes,                     { prefix: '/ai'           }],
]

// Convenience for the script + test, which always want every route
// registered against a stub Fastify. server.js does this manually so it
// can interleave plugin registrations (e.g. aiPlugin) at the right
// moment in the boot sequence.
export async function registerAllRoutes(fastify) {
  for (const [mod, opts] of ROUTE_MODULES) {
    await fastify.register(mod, opts)
  }
}
