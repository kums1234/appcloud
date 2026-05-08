import { describe, test, expect } from '@jest/globals'
import {
  __test__,
  AWS_VIA_TO_AUTOLINK_SCORE,
  accountRegionFromCloudId,
} from '../discovery.aws.supplement.js'

const { autoLinkFromStructure } = __test__

// ─── accountRegionFromCloudId — co-location bucket extraction ────────────────

describe('accountRegionFromCloudId', () => {
  test('extracts <account>-<region> from a standard ARN', () => {
    expect(accountRegionFromCloudId('arn:aws:ec2:us-east-1:111111111111:instance/i-1'))
      .toBe('111111111111-us-east-1')
    expect(accountRegionFromCloudId('arn:aws:rds:eu-west-2:222222222222:db:mydb'))
      .toBe('222222222222-eu-west-2')
  })
  test('lowercases the result', () => {
    expect(accountRegionFromCloudId('arn:aws:lambda:US-EAST-1:111:function:foo'))
      .toBe('111-us-east-1')
  })
  test('returns empty for non-ARN cloud_ids (ec2 InstanceId, ElastiCache cluster id)', () => {
    expect(accountRegionFromCloudId('i-1234abcd')).toBe('')
    expect(accountRegionFromCloudId('my-redis-cluster')).toBe('')
  })
  test('S3-style ARNs (no account, no region) return "" — they cannot be bucket-co-located', () => {
    // arn:aws:s3:::my-bucket has empty region + account segments, so the
    // function falls through and returns ''. Effect: S3 buckets do not
    // contribute to Rule-1 co-location voting; Rules 2/3 still apply.
    expect(accountRegionFromCloudId('arn:aws:s3:::my-bucket')).toBe('')
    expect(accountRegionFromCloudId('')).toBe('')
    expect(accountRegionFromCloudId(null)).toBe('')
  })
})

// ─── AWS_VIA_TO_AUTOLINK_SCORE ───────────────────────────────────────────────

describe('AWS_VIA_TO_AUTOLINK_SCORE', () => {
  test('shared keys cross-cloud — same coupling weight as Azure/GCP', () => {
    expect(AWS_VIA_TO_AUTOLINK_SCORE['subnet']).toBe(65)
    expect(AWS_VIA_TO_AUTOLINK_SCORE['vpc']).toBe(65)
    expect(AWS_VIA_TO_AUTOLINK_SCORE['disk']).toBe(88)
    expect(AWS_VIA_TO_AUTOLINK_SCORE['iam-role']).toBe(60)
  })
  test('AWS-specific via (eni) gets a high score', () => {
    expect(AWS_VIA_TO_AUTOLINK_SCORE['eni']).toBe(90)
  })
})

// ─── autoLinkFromStructure — delegation contract ─────────────────────────────
//
// Lock the "AWS supplement just delegates to the shared helper with
// AWS-specific config" contract: provider='aws', label='account-region',
// enrichmentSource='aws-enrichment', viaToScore = AWS_VIA_TO_AUTOLINK_SCORE,
// coLocationFromCloudId = accountRegionFromCloudId.

import { jest } from '@jest/globals'

describe('autoLinkFromStructure delegates to shared helper with AWS config', () => {
  function recordingNeo4j(unmappedRows = [], colocMappedRows = [], directRows = []) {
    const writes = []
    let directConsumed = false
    const query = jest.fn(async (cypher) => {
      if (cypher.includes("NOT (:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i)") &&
          cypher.includes('RETURN i.id AS infraId')) return unmappedRows
      if (cypher.includes("MATCH (c:Component)-[:CONNECTS_TO {via: 'component-mapping'}]->(i:Infra)") &&
          cypher.includes('RETURN i.cloud_id AS cid')) return colocMappedRows
      if (cypher.includes('[r:CONNECTS_TO]-(mapped:Infra)') && !cypher.includes('*1..2')) {
        if (!directConsumed) { directConsumed = true; return directRows }
        return []
      }
      return []
    })
    const write = jest.fn(async (cypher, params) => { writes.push({ cypher, params }) })
    return { query, write, writes }
  }
  function row(map) { return { get: (k) => map[k] } }

  test('account+region co-location: unanimous → score 85, rule "account-region-unanimous", source "aws-enrichment"', async () => {
    const unmapped = [row({
      infraId: 'inf-new',
      name:    'new-instance',
      cloudId: 'arn:aws:ec2:us-east-1:111:instance/i-new',
      rtype:   'ec2_instance',
      raw:     '{}',
      tags:    '{}',
    })]
    const mapped = [
      row({ cid: 'arn:aws:ec2:us-east-1:111:instance/i-existing', compId: 'comp-app', compName: 'app', rtype: 'ec2_instance' }),
      row({ cid: 'arn:aws:rds:us-east-1:111:db:mydb',             compId: 'comp-app', compName: 'app', rtype: 'rds_instance' }),
    ]

    const { query, write, writes } = recordingNeo4j(unmapped, mapped, [])
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await autoLinkFromStructure({ write, query, log, minScore: 60 })

    expect(stats.linked).toBe(1)

    const linkWrites = writes.filter(w => w.cypher.includes('MERGE (c)-[rel:'))
    expect(linkWrites).toHaveLength(1)
    expect(linkWrites[0].cypher).toMatch(/:CONNECTS_TO \{via: 'component-mapping'\}/)
    expect(linkWrites[0].cypher).not.toMatch(/:DEPLOYED_ON/)
    expect(linkWrites[0].params.score).toBe(85)
    expect(linkWrites[0].params.rule).toBe('account-region-unanimous')
    expect(linkWrites[0].params.providerSource).toBe('aws-enrichment')
  })

  test('direct-eni rule (Rule 2) when account+region is mixed beyond majority', async () => {
    const unmapped = [row({
      infraId: 'inf-mixed',
      name:    'mixed',
      cloudId: 'arn:aws:ec2:us-east-1:111:instance/i-mixed',
      rtype:   'ec2_instance',
      raw:     '{}',
      tags:    '{}',
    })]
    // 3 components, 1 each → no majority
    const mapped = [
      row({ cid: 'arn:aws:ec2:us-east-1:111:instance/i-a', compId: 'comp-a', compName: 'A', rtype: 'ec2_instance' }),
      row({ cid: 'arn:aws:ec2:us-east-1:111:instance/i-b', compId: 'comp-b', compName: 'B', rtype: 'ec2_instance' }),
      row({ cid: 'arn:aws:ec2:us-east-1:111:instance/i-c', compId: 'comp-c', compName: 'C', rtype: 'ec2_instance' }),
    ]
    const direct = [row({ compId: 'comp-a', compName: 'A', via: 'eni' })] // score 90

    const { query, write, writes } = recordingNeo4j(unmapped, mapped, direct)
    const log = { info: () => {}, warn: () => {}, debug: () => {} }
    const stats = await autoLinkFromStructure({ write, query, log, minScore: 60 })

    expect(stats.linked).toBe(1)
    const linkWrites = writes.filter(w => w.cypher.includes('MERGE (c)-[rel:'))
    expect(linkWrites[0].params.score).toBe(90)
    expect(linkWrites[0].params.rule).toBe('direct-eni')
  })
})
