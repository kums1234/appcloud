import { describe, test, expect, jest } from '@jest/globals'
import {
  autoLinkFromStructure,
  AZURE_VIA_TO_AUTOLINK_SCORE,
  GCP_VIA_TO_AUTOLINK_SCORE,
} from '../discovery.autolink.js'

// Behavioural coverage of the cross-cloud autoLink helper. Provider-specific
// integration paths are exercised by discovery.azure.supplement.test.js and
// discovery.gcp.supplement.test.js — the tests here focus on input
// validation, the rule-name templating, and the score-locking invariant.

describe('autoLinkFromStructure — input validation', () => {
  const noopLog = { info: () => {}, warn: () => {}, debug: () => {} }
  const baseOpts = {
    coLocationFromCloudId: () => '',
    coLocationLabel:       'project',
    viaToScore:            {},
    enrichmentSource:      'auto-link',
    write:                 jest.fn(),
    query:                 jest.fn(async () => []),
    log:                   noopLog,
  }

  test('throws when provider is missing', async () => {
    await expect(autoLinkFromStructure({ ...baseOpts })).rejects.toThrow(/provider/)
  })
  test('throws when coLocationFromCloudId is missing', async () => {
    await expect(autoLinkFromStructure({ ...baseOpts, provider: 'aws', coLocationFromCloudId: undefined }))
      .rejects.toThrow(/coLocationFromCloudId/)
  })
  test('throws when coLocationLabel is missing', async () => {
    await expect(autoLinkFromStructure({ ...baseOpts, provider: 'aws', coLocationLabel: '' }))
      .rejects.toThrow(/coLocationLabel/)
  })
  test('throws when viaToScore is missing', async () => {
    await expect(autoLinkFromStructure({ ...baseOpts, provider: 'aws', viaToScore: undefined }))
      .rejects.toThrow(/viaToScore/)
  })
  test('throws when enrichmentSource is missing', async () => {
    await expect(autoLinkFromStructure({ ...baseOpts, provider: 'aws', enrichmentSource: '' }))
      .rejects.toThrow(/enrichmentSource/)
  })
})

describe('autoLinkFromStructure — rule names interpolate coLocationLabel', () => {
  test('aws-style label produces aws-specific rule strings', async () => {
    const writes = []
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })

    const unmappedRow = { get: (k) => ({
      infraId: 'inf-x',
      name:    'x',
      cloudId: 'arn:aws:ec2:us-east-1:111111111111:instance/i-1',
      rtype:   'ec2_instance',
      raw:     '{}',
      tags:    '{}',
    })[k] }
    const mappedRow = { get: (k) => ({
      cid:      'arn:aws:ec2:us-east-1:111111111111:instance/i-existing',
      compId:   'comp-z',
      compName: 'Z',
      rtype:    'ec2_instance',
    })[k] }

    const query = jest.fn(async (cypher) => {
      if (cypher.includes('RETURN i.id AS infraId')) return [unmappedRow]
      if (cypher.includes('RETURN i.cloud_id AS cid')) return [mappedRow]
      return []
    })

    await autoLinkFromStructure({
      provider:              'aws',
      coLocationFromCloudId: (cid) => {
        // account+region bucket from an ARN
        const m = (cid || '').match(/^arn:aws:[^:]*:([^:]*):([^:]*):/)
        return m ? `${m[2]}-${m[1]}`.toLowerCase() : ''
      },
      coLocationLabel:  'account-region',
      viaToScore:       { eni: 90 },
      enrichmentSource: 'aws-enrichment',
      write,
      query,
      log:              { info: () => {}, warn: () => {}, debug: () => {} },
      minScore:         60,
    })

    const linkWrites = writes.filter(w => w.cypher.includes('MERGE (c)-[rel:'))
    expect(linkWrites).toHaveLength(1) // single :CONNECTS_TO write, no :DEPLOYED_ON
    expect(linkWrites[0].cypher).toMatch(/:CONNECTS_TO \{via: 'component-mapping'\}/)
    expect(linkWrites[0].cypher).not.toMatch(/:DEPLOYED_ON/)
    expect(linkWrites[0].params.rule).toBe('account-region-unanimous')
    expect(linkWrites[0].params.providerSource).toBe('aws-enrichment')
  })
})

describe('VIA→score tables — cross-cloud invariants', () => {
  test('shared keys hold the same coupling weight across cloud-specific tables', () => {
    // `subnet`/`network`/`disk`/`service-account` should be consistent so a
    // VM→Subnet edge scores the same regardless of which cloud emitted it.
    expect(AZURE_VIA_TO_AUTOLINK_SCORE['subnet']).toBe(GCP_VIA_TO_AUTOLINK_SCORE['subnet'])
    expect(AZURE_VIA_TO_AUTOLINK_SCORE['disk']).toBe(GCP_VIA_TO_AUTOLINK_SCORE['disk'])
  })
  test('Azure-specific vias have non-default weights', () => {
    expect(AZURE_VIA_TO_AUTOLINK_SCORE['nic']).toBe(90)
    expect(AZURE_VIA_TO_AUTOLINK_SCORE['app-service-plan']).toBe(85)
    expect(AZURE_VIA_TO_AUTOLINK_SCORE['observed-tcp']).toBe(75)
  })
  test('GCP-specific vias are present', () => {
    expect(GCP_VIA_TO_AUTOLINK_SCORE['service-account']).toBe(60)
    expect(GCP_VIA_TO_AUTOLINK_SCORE['iam-binding']).toBe(60)
  })
})
