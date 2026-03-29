// __tests__/serialize.test.js
import { jest } from '@jest/globals'

// Mock neo4j before importing serialize
jest.doMock('neo4j-driver', () => ({
  isInt: (value) => value && typeof value.toNumber === 'function',
  types: {
    DateTime: class MockDateTime {
      constructor() {}
      toString() { return 'mock-datetime-string' }
    }
  }
}))

import { serialize, props } from '../src/utils/serialize.js'

describe('serialize utility', () => {
  test('handles null and undefined', () => {
    expect(serialize(null)).toBe(null)
    expect(serialize(undefined)).toBe(undefined)
  })

  test('handles arrays recursively', () => {
    const input = ['string', 42, null, true]
    const result = serialize(input)
    expect(result).toEqual(['string', 42, null, true])
  })

  test('handles objects recursively', () => {
    const input = { id: 100, name: 'test', nested: { value: 200 } }
    const result = serialize(input)
    expect(result).toEqual({ id: 100, name: 'test', nested: { value: 200 } })
  })

  test('handles plain values', () => {
    expect(serialize('string')).toBe('string')
    expect(serialize(42)).toBe(42)
    expect(serialize(true)).toBe(true)
  })
})

describe('props utility', () => {
  test('extracts properties from neo4j node', () => {
    const mockNode = {
      properties: {
        id: 123,
        name: 'test-node',
        created: '2023-01-01T00:00:00.000Z'
      }
    }
    const result = props(mockNode)
    expect(result.id).toBe(123)
    expect(result.name).toBe('test-node')
    expect(result.created).toBe('2023-01-01T00:00:00.000Z')
  })

  test('handles null node', () => {
    expect(props(null)).toBe(null)
  })

  test('handles node without properties', () => {
    const mockNode = {}
    expect(props(mockNode)).toEqual({})
  })

  test('handles node with empty properties', () => {
    const mockNode = { properties: {} }
    const result = props(mockNode)
    expect(result).toEqual({})
  })
})