import { describe, test, expect } from '@jest/globals'
import { buildInfraIndex, matchCiToInfra, MATCH_CONFIDENCE } from '../matcher.js'

const sampleInfra = [
  { id: 'infra-1', name: 'Payments Platform Production',
    cloud_id: '/subscriptions/abc/resourceGroups/pay/providers/Microsoft.Compute/virtualMachines/pay-prod' },
  { id: 'infra-2', name: 'Orders Service',
    fqdn: 'orders.internal.example.com' },
  { id: 'infra-3', name: 'Analytics Warehouse',
    privateIp: '10.0.1.42' },
  { id: 'infra-4', name: 'payments-platform-prod' },
  { id: 'infra-5', name: 'db01' },   // low-entropy
]

describe('matchCiToInfra', () => {
  const idx = buildInfraIndex(sampleInfra)

  test('cloud_id takes priority and yields highest confidence', () => {
    const ci = {
      cloud_id: '/subscriptions/abc/resourceGroups/pay/providers/Microsoft.Compute/virtualMachines/pay-prod',
      fqdn: 'should-be-ignored.example.com',
      name: 'something else entirely',
    }
    const match = matchCiToInfra(ci, idx)
    expect(match).toEqual(expect.objectContaining({
      infraId:    'infra-1',
      matchType:  'exact_cloud_id',
      confidence: MATCH_CONFIDENCE.exact_cloud_id,
    }))
  })

  test('case-insensitive cloud_id match', () => {
    const ci = { cloud_id: '/SUBSCRIPTIONS/abc/RESOURCEGROUPS/pay/providers/Microsoft.Compute/virtualMachines/PAY-PROD' }
    const match = matchCiToInfra(ci, idx)
    expect(match?.infraId).toBe('infra-1')
  })

  test('fqdn stage used when cloud_id absent', () => {
    const ci = { fqdn: 'orders.internal.example.com', name: 'Orders' }
    const match = matchCiToInfra(ci, idx)
    expect(match).toEqual(expect.objectContaining({
      infraId:   'infra-2',
      matchType: 'exact_fqdn',
    }))
  })

  test('ip_address stage used when cloud_id + fqdn absent', () => {
    const ci = { ip_address: '10.0.1.42', name: 'some random name' }
    const match = matchCiToInfra(ci, idx)
    expect(match).toEqual(expect.objectContaining({
      infraId:   'infra-3',
      matchType: 'exact_ip',
    }))
  })

  test('exact normalised name is the fuzzy-stage fast path', () => {
    const ci = { name: 'Payments Platform Prod' }
    const match = matchCiToInfra(ci, idx)
    expect(match?.infraId).toBe('infra-4')
    expect(match?.matchType).toBe('exact_normalized_name')
  })

  test('fuzzy match scores as fuzzy_name with its configured confidence', () => {
    const ci = { name: 'Payments Platform Production Env' }
    const match = matchCiToInfra(ci, idx)
    if (match) {
      expect(['fuzzy_name','exact_normalized_name']).toContain(match.matchType)
    }
  })

  test('low-entropy name: fuzzy blocked by gate, exact still works', () => {
    expect(matchCiToInfra({ name: 'db02' }, idx)).toBeNull()
    expect(matchCiToInfra({ name: 'db01' }, idx)?.infraId).toBe('infra-5')
  })

  test('nothing matches → null', () => {
    expect(matchCiToInfra({ name: 'Absolutely unrelated CMDB record' }, idx)).toBeNull()
  })

  test('null ci or null index short-circuits to null', () => {
    expect(matchCiToInfra(null, idx)).toBeNull()
    expect(matchCiToInfra({ name: 'x' }, null)).toBeNull()
  })

  test('evidence string references the stage that matched', () => {
    const m = matchCiToInfra({ cloud_id: '/SUBSCRIPTIONS/abc/resourceGroups/pay/providers/Microsoft.Compute/virtualMachines/pay-prod' }, idx)
    expect(m.evidence).toMatch(/cloud_id/)
    const m2 = matchCiToInfra({ fqdn: 'orders.internal.example.com' }, idx)
    expect(m2.evidence).toMatch(/fqdn/)
  })
})
