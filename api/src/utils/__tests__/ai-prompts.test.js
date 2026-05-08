// Locks the prompt-template contracts. These templates are passed
// verbatim to LLM providers; a typo in a variable interpolation
// (`${infra.name}` vs `${infraName}`) produces silently degraded
// output with no test catch. The invariants here are:
//
//   - Required input fields land in the prompt body verbatim.
//   - JSON-mode prompts include the response-shape skeleton so the
//     LLM has the canonical empty object to fill in.
//   - System prompts are non-empty and provider-appropriate.

import { describe, test, expect } from '@jest/globals'
import {
  LOCAL_SYSTEM,
  CLOUD_SYSTEM,
  promptTagNormalise,
  promptInferMapping,
  promptExplainBlastRadius,
  promptPlanDecommission,
} from '../ai-prompts.js'

describe('system prompts', () => {
  test('LOCAL system prompt enforces JSON-only output', () => {
    expect(LOCAL_SYSTEM).toMatch(/JSON/i)
    expect(LOCAL_SYSTEM).toMatch(/no commentary|never add commentary/i)
  })

  test('CLOUD system prompt frames the model as an architect', () => {
    expect(CLOUD_SYSTEM).toMatch(/architect/i)
    expect(CLOUD_SYSTEM.length).toBeGreaterThan(50)
  })

  test('LOCAL and CLOUD system prompts are distinct', () => {
    expect(LOCAL_SYSTEM).not.toBe(CLOUD_SYSTEM)
  })
})

describe('promptTagNormalise', () => {
  test('embeds resource name + provider + tags into the prompt', () => {
    const out = promptTagNormalise({
      tags: { Owner: 'platform', Env: 'prod' },
      name: 'pay-api-prod',
      provider: 'aws',
    })
    expect(out.system).toBe(LOCAL_SYSTEM)
    expect(out.json).toBe(true)
    expect(out.temperature).toBe(0)
    expect(out.prompt).toContain('pay-api-prod')
    expect(out.prompt).toContain('aws')
    expect(out.prompt).toContain('"Owner"')
    expect(out.prompt).toContain('"Env"')
    // Response-shape skeleton must be present so the model has the
    // exact JSON keys to fill.
    expect(out.prompt).toContain('"app":null')
    expect(out.prompt).toContain('"environment":null')
  })

  test('handles missing / empty tags without throwing', () => {
    const out = promptTagNormalise({ tags: {}, name: 'x', provider: 'gcp' })
    expect(out.prompt).toContain('Raw tags')
    expect(out.prompt).toContain('{}')
  })
})

describe('promptInferMapping', () => {
  const infra = { name: 'pay-api-prod', provider: 'aws', resource_type: 'function', region: 'us-east-1' }
  const normalisedTags = { app: 'Payments', environment: 'production' }

  test('lists existing apps when present', () => {
    const out = promptInferMapping({
      infra,
      normalisedTags,
      existingApps: [
        { name: 'Payments Platform', tier: 1, environment: 'production' },
        { name: 'Reporting',          tier: 3, environment: 'staging' },
      ],
    })
    expect(out.system).toBe(LOCAL_SYSTEM)
    expect(out.json).toBe(true)
    expect(out.prompt).toContain('Payments Platform')
    expect(out.prompt).toContain('Reporting')
    expect(out.prompt).toContain('tier 3')
    // Skeleton present.
    expect(out.prompt).toContain('"action":"create_application"')
  })

  test('renders a "(none)" placeholder when no apps exist', () => {
    const out = promptInferMapping({ infra, normalisedTags, existingApps: [] })
    expect(out.prompt).toContain('(none - no applications exist yet)')
  })

  test('surfaces resource_type + region in the prompt', () => {
    const out = promptInferMapping({ infra, normalisedTags, existingApps: [] })
    expect(out.prompt).toContain('function')
    expect(out.prompt).toContain('us-east-1')
  })
})

describe('promptExplainBlastRadius', () => {
  test('embeds the risk-score variables and asks for plain English', () => {
    const out = promptExplainBlastRadius({
      application:    'Payments Platform',
      riskScore:      82,
      tier:           1,
      components:     7,
      connectedApps:  ['Reporting', 'Notifications'],
      infraCount:     38,
    })
    expect(out.system).toBe(LOCAL_SYSTEM)
    expect(out.json).toBe(false)              // free-text response
    expect(out.prompt).toContain('Payments Platform')
    expect(out.prompt).toContain('82/100')
    expect(out.prompt).toContain('38 infrastructure resource')
    expect(out.prompt).toContain('Reporting, Notifications')
  })

  test('handles empty connected-apps list with the documented "none" placeholder', () => {
    const out = promptExplainBlastRadius({
      application:    'Solo App',
      riskScore:      10,
      tier:           4,
      components:     1,
      connectedApps:  [],
      infraCount:     2,
    })
    expect(out.prompt).toContain('Connected apps: none')
  })
})

describe('promptPlanDecommission', () => {
  test('uses CLOUD system prompt and embeds inputs', () => {
    const out = promptPlanDecommission({
      application: { name: 'Legacy', tier: 4, environment: 'production', owner: 'platform' },
      components: [{ name: 'old-api', type: 'api' }, { name: 'old-worker', type: 'worker' }],
      connectedApps: [{ name: 'Newer', direction: 'upstream' }],
      infraNodes: [
        { name: 'old-vm-1', resource_type: 'vm', provider: 'aws' },
        { name: 'old-rds-1', resource_type: 'rds_instance', provider: 'aws' },
      ],
      owner: 'platform',
    })
    expect(out.system).toBe(CLOUD_SYSTEM)
    expect(out.prompt).toContain('Legacy')
    expect(out.prompt).toContain('platform')
    expect(out.prompt).toContain('old-api (api)')
    expect(out.prompt).toContain('old-worker (worker)')
    expect(out.prompt).toContain('Newer [upstream]')
    expect(out.prompt).toContain('old-vm-1 (vm, aws)')
  })

  test('truncates infra-node list past 20 entries with an "and N more" footer', () => {
    const infraNodes = Array.from({ length: 25 }, (_, i) => ({
      name: `n-${i}`, resource_type: 'vm', provider: 'aws',
    }))
    const out = promptPlanDecommission({
      application: { name: 'X', tier: 2 },
      components:  [],
      connectedApps: [],
      infraNodes,
      owner: undefined,
    })
    expect(out.prompt).toContain('and 5 more')
    // First 20 should appear, the 21st should not (use a name unlikely
    // to appear in any prompt scaffolding).
    expect(out.prompt).toContain('n-0 (vm')
    expect(out.prompt).toContain('n-19 (vm')
    expect(out.prompt).not.toContain('n-20 (vm')
  })

  test('falls back to application.owner when owner arg is undefined', () => {
    const out = promptPlanDecommission({
      application:    { name: 'X', tier: 2, owner: 'fallback-owner' },
      components:     [],
      connectedApps:  [],
      infraNodes:     [],
      owner:          undefined,
    })
    expect(out.prompt).toContain('fallback-owner')
  })
})
