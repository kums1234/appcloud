import { describe, test, expect } from '@jest/globals'
import { parseTerraformState, TF_RESOURCE_MAP } from '../terraform-state-parser.js'

const V4_STATE = {
  version: 4,
  terraform_version: '1.5.0',
  serial: 42,
  resources: [
    {
      mode: 'managed', type: 'aws_instance', name: 'web',
      instances: [{ attributes: { id: 'i-abc', region: 'us-east-1', tags: { env: 'prod' } } }],
    },
    {
      mode: 'managed', type: 'azurerm_linux_virtual_machine', name: 'db',
      instances: [{ attributes: { id: '/subscriptions/1/rg/x/vm/db', location: 'eastus' } }],
    },
    {
      // Unmapped — must be skipped silently
      mode: 'managed', type: 'aws_iam_role', name: 'svc',
      instances: [{ attributes: { id: 'role-1' } }],
    },
    {
      // Data sources skipped
      mode: 'data', type: 'terraform_remote_state', name: 'net',
      instances: [{ attributes: { config: { bucket: 'tf' } } }],
    },
  ],
}

const SHOW_JSON_STATE = {
  format_version: '1.0',
  values: {
    root_module: {
      resources: [
        { mode: 'managed', type: 'google_compute_instance', name: 'api',
          values: { name: 'api-1', zone: 'us-central1-a' },
          // show-json uses `values` but parseTerraformState treats it as primary for v3 compat
        },
      ],
      child_modules: [
        { address: 'module.data',
          resources: [
            { mode: 'managed', type: 'google_sql_database_instance', name: 'main',
              instances: [{ attributes: { id: 'main-db', region: 'us-central1' } }] },
          ],
        },
      ],
    },
  },
}

describe('parseTerraformState', () => {
  test('parses v4 tfstate and maps AWS + Azure resources', () => {
    const r = parseTerraformState(V4_STATE)
    expect(r.version).toBe('1.5.0')
    expect(r.workspace).toBe('serial-42')
    expect(r.engine).toBe('terraform')
    expect(r.errors).toEqual([])

    const names = r.resources.map(x => `${x.provider}:${x.resourceType}`).sort()
    expect(names).toEqual(['aws:ec2_instance', 'azure:vm'])

    const aws = r.resources.find(x => x.provider === 'aws')
    expect(aws.region).toBe('us-east-1')
    expect(aws.tags).toEqual({ env: 'prod' })
    expect(aws.terraformId).toBe('i-abc')
  })

  test('skips data sources and unmapped resource types silently', () => {
    const r = parseTerraformState(V4_STATE)
    expect(r.resources.find(x => x.terraformType === 'terraform_remote_state')).toBeUndefined()
    expect(r.resources.find(x => x.terraformType === 'aws_iam_role')).toBeUndefined()
  })

  test('walks child modules from `terraform show -json` output', () => {
    const r = parseTerraformState(SHOW_JSON_STATE)
    const names = r.resources.map(x => x.provider + ':' + x.resourceType).sort()
    // The root module's google_compute_instance has no instances/primary so
    // it is skipped; the child module's google_sql_database_instance lands.
    expect(names).toContain('gcp:cloud_sql')
  })

  test('honours iacEngine + workspaceId options', () => {
    const r = parseTerraformState(V4_STATE, { iacEngine: 'opentofu', workspaceId: 'prod' })
    expect(r.engine).toBe('opentofu')
    expect(r.workspace).toBe('prod')
    expect(r.resources.every(x => x.iacEngine === 'opentofu')).toBe(true)
    expect(r.resources.every(x => x.workspaceId === 'prod')).toBe(true)
  })

  test('reports an error on a non-state object and returns empty resources', () => {
    const r = parseTerraformState({ not: 'a state file' })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.resources).toEqual([])
  })

  test('TF_RESOURCE_MAP covers all four providers', () => {
    const providers = new Set(Object.values(TF_RESOURCE_MAP).map(v => v.provider))
    expect(providers).toEqual(new Set(['aws', 'azure', 'gcp']))
  })
})
