import { describe, test, expect } from '@jest/globals'
import { isValidAwsRegion, parseAndValidateRegions } from '../aws-regions.js'

describe('AWS region validator', () => {
  test('accepts standard AWS regions', () => {
    for (const r of [
      'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
      'eu-west-1', 'eu-central-1', 'eu-north-1',
      'ap-southeast-1', 'ap-northeast-1', 'ap-northeast-3',
      'sa-east-1', 'ca-central-1',
      'us-gov-west-1', 'us-gov-east-1',
      'cn-north-1', 'cn-northwest-1',
    ]) {
      expect(isValidAwsRegion(r)).toBe(true)
    }
  })

  test('rejects non-region strings', () => {
    for (const r of [
      '',
      ' ',
      'us',
      'us-east',
      'us-east-1; DROP TABLE infra',     // injection attempt
      "us-east-1' OR 1=1; --",           // injection attempt
      'us-east-1\n',                      // newline / log injection
      'US-EAST-1',                        // uppercase
      '../etc/passwd',
      'us-east-1234567890',               // suspicious length
      'just-some-name',
      'a'.repeat(50),
    ]) {
      expect(isValidAwsRegion(r)).toBe(false)
    }
  })

  test('parseAndValidateRegions handles strings, arrays, and bad input', () => {
    expect(parseAndValidateRegions('us-east-1, us-west-2 ')).toEqual(['us-east-1', 'us-west-2'])
    expect(parseAndValidateRegions(['us-east-1', 'eu-west-1'])).toEqual(['us-east-1', 'eu-west-1'])
    expect(parseAndValidateRegions('')).toEqual([])
    expect(parseAndValidateRegions(null)).toEqual([])
    expect(parseAndValidateRegions(undefined)).toEqual([])
  })

  test('parseAndValidateRegions throws on injection payload', () => {
    expect(() => parseAndValidateRegions("us-east-1', 1=1; --")).toThrow(/invalid AWS region/)
    expect(() => parseAndValidateRegions(['us-east-1', '"; DROP TABLE infra'])).toThrow(/invalid AWS region/)
  })
})
