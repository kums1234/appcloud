import { describe, test, expect, jest } from '@jest/globals'
import { __test__ } from '../discovery.azure.js'

const {
  ARM_TYPE_MAP,
  VIA_TO_CONFIDENCE,
  classifyResourceType,
  extractStatus,
  extractPublic,
  extractRaw,
  statsKeyFor,
  emitStructuralEdges,
  writeStructuralEdge,
} = __test__

// ─── classifyResourceType ─────────────────────────────────────────────────────

describe('classifyResourceType', () => {
  test('maps core ARM types to AppCloud resource types', () => {
    expect(classifyResourceType('microsoft.compute/virtualmachines', '')).toBe('vm')
    expect(classifyResourceType('microsoft.containerservice/managedclusters', '')).toBe('aks_cluster')
    expect(classifyResourceType('microsoft.sql/servers', '')).toBe('sql_server')
    expect(classifyResourceType('microsoft.cache/redis', '')).toBe('redis')
    expect(classifyResourceType('microsoft.network/virtualnetworks', '')).toBe('vnet')
    expect(classifyResourceType('microsoft.keyvault/vaults', '')).toBe('key_vault')
    expect(classifyResourceType('microsoft.documentdb/databaseaccounts', '')).toBe('cosmos_db')
  })

  test('refines microsoft.web/sites to function_app when kind contains "functionapp"', () => {
    expect(classifyResourceType('microsoft.web/sites', 'app,linux')).toBe('app_service')
    expect(classifyResourceType('microsoft.web/sites', 'functionapp,linux')).toBe('function_app')
    expect(classifyResourceType('microsoft.web/sites', 'functionapp')).toBe('function_app')
    expect(classifyResourceType('microsoft.web/sites', 'FunctionApp')).toBe('function_app')
  })

  test('returns null for unknown ARM types', () => {
    expect(classifyResourceType('microsoft.unknown/thing', '')).toBeNull()
    expect(classifyResourceType('', '')).toBeNull()
  })

  test('includes both classic and flexible DB servers', () => {
    expect(classifyResourceType('microsoft.dbforpostgresql/servers', '')).toBe('postgres_server')
    expect(classifyResourceType('microsoft.dbforpostgresql/flexibleservers', '')).toBe('postgres_server')
    expect(classifyResourceType('microsoft.dbformysql/flexibleservers', '')).toBe('mysql_server')
  })
})

// ─── extractStatus ────────────────────────────────────────────────────────────

describe('extractStatus', () => {
  test('returns provisioningState when present', () => {
    expect(extractStatus({ provisioningState: 'Succeeded' })).toBe('Succeeded')
  })
  test('falls back to state', () => {
    expect(extractStatus({ state: 'Ready' })).toBe('Ready')
  })
  test('defaults to unknown', () => {
    expect(extractStatus({})).toBe('unknown')
    expect(extractStatus()).toBe('unknown')
  })
})

// ─── extractPublic ────────────────────────────────────────────────────────────

describe('extractPublic', () => {
  test('sql_server/redis/postgres/mysql/cosmos — publicNetworkAccess gate', () => {
    expect(extractPublic('sql_server',     { publicNetworkAccess: 'Enabled' })).toBe(true)
    expect(extractPublic('sql_server',     { publicNetworkAccess: 'Disabled' })).toBe(false)
    expect(extractPublic('redis',          { publicNetworkAccess: 'Enabled' })).toBe(true)
    expect(extractPublic('postgres_server',{ publicNetworkAccess: 'Enabled' })).toBe(true)
    expect(extractPublic('cosmos_db',      { publicNetworkAccess: 'Disabled' })).toBe(false)
  })
  test('app_service is public by default, function_app is not', () => {
    expect(extractPublic('app_service', {})).toBe(true)
    expect(extractPublic('function_app', {})).toBe(false)
  })
  test('aks_cluster inverts enablePrivateCluster', () => {
    expect(extractPublic('aks_cluster', { apiServerAccessProfile: { enablePrivateCluster: true } })).toBe(false)
    expect(extractPublic('aks_cluster', { apiServerAccessProfile: { enablePrivateCluster: false } })).toBe(true)
    expect(extractPublic('aks_cluster', {})).toBe(true)
  })
  test('load_balancer public if any frontend has a public IP', () => {
    expect(extractPublic('load_balancer', {
      frontendIPConfigurations: [{ properties: { publicIPAddress: { id: '/subscriptions/…' } } }],
    })).toBe(true)
    expect(extractPublic('load_balancer', {
      frontendIPConfigurations: [{ properties: { privateIPAddress: '10.0.0.4' } }],
    })).toBe(false)
  })
  test('defaults to false', () => {
    expect(extractPublic('vnet', {})).toBe(false)
    expect(extractPublic('key_vault', {})).toBe(false)
  })
})

// ─── extractRaw ───────────────────────────────────────────────────────────────

describe('extractRaw', () => {
  test('VM: pulls hardware, OS, image, and zones', () => {
    const res = {
      type: 'microsoft.compute/virtualmachines',
      kind: undefined,
      resourceGroup: 'rg-prod',
      sku: null,
      identity: { type: 'SystemAssigned' },
      zones: ['1', '2'],
      properties: {
        hardwareProfile: { vmSize: 'Standard_D4s_v3' },
        storageProfile: {
          osDisk: { osType: 'Linux' },
          imageReference: { publisher: 'Canonical', offer: 'UbuntuServer', sku: '22_04-lts' },
        },
        osProfile: { adminUsername: 'azureuser' },
      },
    }
    const raw = extractRaw('vm', res)
    expect(raw.vmSize).toBe('Standard_D4s_v3')
    expect(raw.osType).toBe('Linux')
    expect(raw.imagePublisher).toBe('Canonical')
    expect(raw.imageOffer).toBe('UbuntuServer')
    expect(raw.imageSku).toBe('22_04-lts')
    expect(raw.availabilityZones).toEqual(['1', '2'])
    expect(raw.adminUsername).toBe('azureuser')
    expect(raw.resourceGroup).toBe('rg-prod')
    expect(raw.identity).toBe('SystemAssigned')
  })

  test('App Service: preserves serverFarmId and vnetSubnetId as promoted-field inputs', () => {
    const res = {
      type: 'microsoft.web/sites',
      kind: 'app,linux',
      resourceGroup: 'rg-web',
      properties: {
        defaultHostName: 'myapp.azurewebsites.net',
        httpsOnly: true,
        serverFarmId: '/subscriptions/…/serverfarms/plan-1',
        outboundIpAddresses: '1.2.3.4,5.6.7.8',
        clientAffinityEnabled: false,
        enabled: true,
        virtualNetworkSubnetId: '/subscriptions/…/subnets/apps',
      },
    }
    const raw = extractRaw('app_service', res)
    expect(raw.serverFarmId).toBe('/subscriptions/…/serverfarms/plan-1')
    expect(raw.vnetSubnetId).toBe('/subscriptions/…/subnets/apps')
    expect(raw.defaultHostName).toBe('myapp.azurewebsites.net')
    expect(raw.type).toBe('microsoft.web/sites')
  })

  test('SQL server: extracts admin and FQDN', () => {
    const raw = extractRaw('sql_server', {
      type: 'microsoft.sql/servers',
      resourceGroup: 'rg-data',
      properties: {
        version: '12.0',
        administratorLogin: 'sqladmin',
        fullyQualifiedDomainName: 'sql-prod.database.windows.net',
        publicNetworkAccess: 'Disabled',
        minimalTlsVersion: '1.2',
      },
    })
    expect(raw.administratorLogin).toBe('sqladmin')
    expect(raw.fullyQualifiedDomainName).toBe('sql-prod.database.windows.net')
    expect(raw.minimalTlsVersion).toBe('1.2')
  })

  test('Redis: builds combined sku string', () => {
    const raw = extractRaw('redis', {
      type: 'microsoft.cache/redis',
      resourceGroup: 'rg',
      sku: { name: 'Premium', family: 'P', capacity: 1 },
      properties: {
        hostName: 'x.redis.cache.windows.net',
        port: 6379,
        sslPort: 6380,
        redisVersion: '6.0',
        minimumTlsVersion: '1.2',
        subnetId: '/subscriptions/…/subnets/redis',
      },
    })
    expect(raw.sku).toBe('Premium P 1')
    expect(raw.subnetId).toBe('/subscriptions/…/subnets/redis')
    expect(raw.hostName).toBe('x.redis.cache.windows.net')
  })

  test('VNet: flattens subnets to {id, name, prefix}', () => {
    const raw = extractRaw('vnet', {
      type: 'microsoft.network/virtualnetworks',
      resourceGroup: 'rg-net',
      properties: {
        addressSpace: { addressPrefixes: ['10.0.0.0/16'] },
        subnets: [
          { id: '/.../subnets/s1', name: 's1', properties: { addressPrefix: '10.0.1.0/24' } },
          { id: '/.../subnets/s2', name: 's2', properties: { addressPrefix: '10.0.2.0/24' } },
        ],
        dhcpOptions: { dnsServers: ['8.8.8.8'] },
        enableDdosProtection: false,
      },
    })
    expect(raw.addressSpace).toEqual(['10.0.0.0/16'])
    expect(raw.subnetCount).toBe(2)
    expect(raw.subnets).toEqual([
      { id: '/.../subnets/s1', name: 's1', prefix: '10.0.1.0/24' },
      { id: '/.../subnets/s2', name: 's2', prefix: '10.0.2.0/24' },
    ])
  })

  test('generic fallback: keeps common fields only', () => {
    const raw = extractRaw('storage_account', {
      type: 'microsoft.storage/storageaccounts',
      resourceGroup: 'rg',
      sku: { name: 'Standard_LRS' },
      kind: 'StorageV2',
      identity: { type: 'None' },
      properties: { something: 'else' },
    })
    expect(raw).toEqual({
      type:          'microsoft.storage/storageaccounts',
      kind:          'StorageV2',
      sku:           'Standard_LRS',
      identity:      'None',
      resourceGroup: 'rg',
    })
  })
})

// ─── statsKeyFor ──────────────────────────────────────────────────────────────

describe('statsKeyFor', () => {
  test('maps known scanner types to existing counter keys', () => {
    expect(statsKeyFor('vm')).toBe('vms')
    expect(statsKeyFor('aks_cluster')).toBe('aks')
    expect(statsKeyFor('sql_server')).toBe('sql')
    expect(statsKeyFor('app_service')).toBe('appService')
    expect(statsKeyFor('function_app')).toBe('functionApp')
    expect(statsKeyFor('redis')).toBe('redis')
    expect(statsKeyFor('vnet')).toBe('vnet')
  })
  test('falls back to <typewithoutunderscores>Count pattern for generic types', () => {
    expect(statsKeyFor('storage_account')).toBe('storageaccountCount')
    expect(statsKeyFor('app_insights')).toBe('appinsightsCount')
    expect(statsKeyFor('key_vault')).toBe('keyvaultCount')
  })
})

// ─── VIA_TO_CONFIDENCE (score-locking) ────────────────────────────────────────

describe('VIA_TO_CONFIDENCE', () => {
  test('locks the structural scoring table', () => {
    // Any change to these numbers needs a PR-level justification — they
    // feed the autoLink scoring and have been tuned against real sub data.
    expect(VIA_TO_CONFIDENCE).toMatchObject({
      'nic':                  90,
      'disk':                 88,
      'app-service-plan':     85,
      'sql-server':           85,
      'redis-vnet-injection': 82,
      'vnet-integration':     80,
      'aks-node-subnet':      80,
      'lb-backend-nic':       75,
      'agw-subnet':           72,
      'private-endpoint':     70,
      'subnet':               65,
      'vnet':                 65,
      'nsg':                  55,
    })
  })
})

// ─── ARM_TYPE_MAP coverage ────────────────────────────────────────────────────

describe('ARM_TYPE_MAP', () => {
  test('covers the types the old per-SDK scanner handled', () => {
    for (const armType of [
      'microsoft.compute/virtualmachines',
      'microsoft.containerservice/managedclusters',
      'microsoft.sql/servers',
      'microsoft.web/sites',
      'microsoft.web/serverfarms',
      'microsoft.cache/redis',
      'microsoft.network/virtualnetworks',
    ]) {
      expect(ARM_TYPE_MAP[armType]).toBeDefined()
    }
  })
})

// ─── writeStructuralEdge (single :CONNECTS_TO write per logical edge) ────────

describe('writeStructuralEdge', () => {
  test('writes a single :CONNECTS_TO edge with traceability properties', async () => {
    const write = jest.fn(async () => [])
    const n = await writeStructuralEdge(write, {
      from: 'node-from', to: 'node-to', via: 'nic',
      source: 'azure-resource-graph',
      evidence: 'ARG: microsoft.compute/virtualmachines nic',
    })
    expect(n).toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toContain(':CONNECTS_TO')
    expect(write.mock.calls[0][0]).not.toContain(':CONNECTED_TO')
    expect(write.mock.calls[0][1]).toMatchObject({
      from:       'node-from',
      to:         'node-to',
      via:        'nic',
      source:     'azure-resource-graph',
      confidence: 90,
      evidence:   expect.stringContaining('ARG'),
    })
  })

  test('skips self-loops and missing endpoints', async () => {
    const write = jest.fn()
    expect(await writeStructuralEdge(write, { from: 'a', to: 'a', via: 'nic', source: 's', evidence: '' })).toBe(0)
    expect(await writeStructuralEdge(write, { from: null, to: 'b', via: 'nic', source: 's', evidence: '' })).toBe(0)
    expect(await writeStructuralEdge(write, { from: 'a', to: null, via: 'nic', source: 's', evidence: '' })).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  test('uses default confidence 60 for unknown via', async () => {
    const write = jest.fn(async () => [])
    await writeStructuralEdge(write, {
      from: 'a', to: 'b', via: 'not-in-table', source: 'x', evidence: '',
    })
    expect(write.mock.calls[0][1].confidence).toBe(60)
  })
})

// ─── emitStructuralEdges ──────────────────────────────────────────────────────

describe('emitStructuralEdges', () => {
  function makeHarness(cidToNid) {
    const write = jest.fn(async () => [])
    const stats = { edges: 0, errors: [] }
    const resolve = (armId) => armId ? cidToNid[(armId || '').toLowerCase()] : undefined
    return { write, stats, resolve }
  }

  test('VM → NIC emits one :CONNECTS_TO edge (one MERGE)', async () => {
    const { write, stats, resolve } = makeHarness({
      '/sub/vm1': 'node-vm',
      '/sub/nic1': 'node-nic',
    })
    await emitStructuralEdges({
      res: {
        id: '/sub/vm1',
        type: 'microsoft.compute/virtualmachines',
        properties: {
          networkProfile: { networkInterfaces: [{ id: '/sub/nic1' }] },
        },
      },
      resolve, write, stats,
    })
    expect(stats.edges).toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][1].via).toBe('nic')
  })

  test('App Service → App Service Plan fires with confidence 85', async () => {
    const { write, stats, resolve } = makeHarness({
      '/sub/site1': 'node-site',
      '/sub/plan1': 'node-plan',
    })
    await emitStructuralEdges({
      res: {
        id: '/sub/site1',
        type: 'microsoft.web/sites',
        properties: { serverFarmId: '/sub/plan1' },
      },
      resolve, write, stats,
    })
    expect(stats.edges).toBe(1)
    expect(write.mock.calls[0][1]).toMatchObject({
      via:        'app-service-plan',
      confidence: 85,
    })
  })

  test('skips edges whose target was not upserted in this scan', async () => {
    const { write, stats, resolve } = makeHarness({ '/sub/vm1': 'node-vm' })
    await emitStructuralEdges({
      res: {
        id: '/sub/vm1',
        type: 'microsoft.compute/virtualmachines',
        properties: {
          networkProfile: { networkInterfaces: [{ id: '/sub/missing-nic' }] },
        },
      },
      resolve, write, stats,
    })
    expect(stats.edges).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  test('VNet emits subnet → vnet, subnet → nsg, subnet → route-table edges', async () => {
    const { write, stats, resolve } = makeHarness({
      '/sub/vnet1': 'node-vnet',
      '/sub/subnet1': 'node-subnet',
      '/sub/nsg1': 'node-nsg',
      '/sub/rt1': 'node-rt',
    })
    await emitStructuralEdges({
      res: {
        id: '/sub/vnet1',
        type: 'microsoft.network/virtualnetworks',
        properties: {
          subnets: [{
            id: '/sub/subnet1',
            name: 'apps',
            properties: {
              networkSecurityGroup: { id: '/sub/nsg1' },
              routeTable:           { id: '/sub/rt1' },
            },
          }],
        },
      },
      resolve, write, stats,
    })
    expect(stats.edges).toBe(3) // subnet→vnet, subnet→nsg, subnet→route-table
  })
})
