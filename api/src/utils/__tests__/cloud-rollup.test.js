import { describe, test, expect } from '@jest/globals'
import { rollupForInfra } from '../cloud-rollup.js'

// Unit coverage for the rollup helper. The underlying parsers are
// covered in the per-cloud supplement test files; here we lock the
// provider routing and the normalised return shape, since that's the
// contract consumers (the graph walk, eventual UI rollups, the LLM
// blast-radius narrative) rely on.

describe('rollupForInfra — provider routing', () => {
  test('Azure → resource group (lowercased)', () => {
    expect(rollupForInfra({
      provider: 'azure',
      cloud_id: '/subscriptions/abc/resourceGroups/RG-Prod/providers/Microsoft.Compute/virtualMachines/vm-1',
    })).toEqual({ kind: 'azure-resource-group', key: 'rg-prod' })
  })

  test('GCP → project from self-link', () => {
    expect(rollupForInfra({
      provider: 'gcp',
      cloud_id: 'https://www.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/instances/inst-1',
    })).toEqual({ kind: 'gcp-project', key: 'my-project' })
  })

  test('GCP → project from CAI canonical name', () => {
    expect(rollupForInfra({
      provider: 'gcp',
      cloud_id: '//compute.googleapis.com/projects/another-project/zones/us-east1-a/instances/inst-2',
    })).toEqual({ kind: 'gcp-project', key: 'another-project' })
  })

  test('AWS → account-region from ARN', () => {
    expect(rollupForInfra({
      provider: 'aws',
      cloud_id: 'arn:aws:ec2:us-east-1:111111111111:instance/i-abc',
    })).toEqual({ kind: 'aws-account-region', key: '111111111111-us-east-1' })
  })

  test('returns null when cloud_id is missing (no rollup possible)', () => {
    expect(rollupForInfra({ provider: 'azure' })).toBeNull()
  })

  test('returns null when provider is unknown', () => {
    expect(rollupForInfra({
      provider: 'oracle',
      cloud_id: 'ocid1.instance.oc1..whatever',
    })).toBeNull()
  })

  test('returns null when cloud_id is shape-valid but parser cannot extract a bucket', () => {
    // Azure cloud_id without a resourceGroups segment → no rollup.
    expect(rollupForInfra({
      provider: 'azure',
      cloud_id: '/subscriptions/abc/providers/Microsoft.Subscription/aliases/foo',
    })).toBeNull()
  })

  test('provider matching is case-insensitive (some scanners write `Google`)', () => {
    expect(rollupForInfra({
      provider: 'Google',
      cloud_id: '//compute.googleapis.com/projects/p/regions/us/x',
    })).toEqual({ kind: 'gcp-project', key: 'p' })
  })

  test('safe on completely empty input', () => {
    expect(rollupForInfra()).toBeNull()
    expect(rollupForInfra({})).toBeNull()
  })
})
