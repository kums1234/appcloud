import { describe, test, expect } from '@jest/globals'
import { unwrapAnyValue, kvListToObject, hexToBuffer, flattenResourceSpans } from '../parse.js'

describe('unwrapAnyValue', () => {
  test.each([
    [{ stringValue: 'hi' }, 'hi'],
    [{ intValue: 42 }, 42],
    [{ intValue: '42' }, 42],                      // some collectors serialise ints as strings
    [{ boolValue: true }, true],
    [{ doubleValue: 3.14 }, 3.14],
    [null, null],
    [undefined, null],
    [{ bytesValue: 'base64==' }, 'base64=='],
  ])('unwraps %o → %o', (input, expected) => {
    expect(unwrapAnyValue(input)).toEqual(expected)
  })

  test('recurses into arrayValue and kvlistValue', () => {
    const arr = { arrayValue: { values: [{ stringValue: 'a' }, { intValue: 2 }] } }
    expect(unwrapAnyValue(arr)).toEqual(['a', 2])

    const obj = { kvlistValue: { values: [
      { key: 'k1', value: { stringValue: 'v1' } },
      { key: 'k2', value: { intValue: 9 } },
    ]}}
    expect(unwrapAnyValue(obj)).toEqual({ k1: 'v1', k2: 9 })
  })
})

describe('kvListToObject', () => {
  test('flattens a KeyValue[] into a plain object', () => {
    const list = [
      { key: 'service.name',      value: { stringValue: 'frontend' } },
      { key: 'http.status_code',  value: { intValue: 200 } },
      { key: 'verified',          value: { boolValue: false } },
    ]
    expect(kvListToObject(list)).toEqual({
      'service.name': 'frontend',
      'http.status_code': 200,
      verified: false,
    })
  })

  test('ignores non-array / empty input', () => {
    expect(kvListToObject(null)).toEqual({})
    expect(kvListToObject(undefined)).toEqual({})
    expect(kvListToObject([])).toEqual({})
  })

  test('ignores malformed entries', () => {
    expect(kvListToObject([{ key: 'ok', value: { stringValue: 'v' } }, null, { notKey: 'x' }]))
      .toEqual({ ok: 'v' })
  })
})

describe('hexToBuffer', () => {
  test('parses a 32-char trace id', () => {
    const b = hexToBuffer('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(b).toBeInstanceOf(Buffer)
    expect(b.length).toBe(16)
  })

  test('left-pads odd-length hex instead of dropping nibbles', () => {
    const b = hexToBuffer('abc')   // odd length; treated as "0abc"
    expect(b.length).toBe(2)
    expect(b[0]).toBe(0x0a)
    expect(b[1]).toBe(0xbc)
  })

  test('null / empty input → null', () => {
    expect(hexToBuffer(null)).toBeNull()
    expect(hexToBuffer('')).toBeNull()
    expect(hexToBuffer(123)).toBeNull()
  })
})

describe('flattenResourceSpans', () => {
  const payload = {
    resourceSpans: [{
      resource: { attributes: [
        { key: 'service.name',           value: { stringValue: 'orders' } },
        { key: 'service.namespace',      value: { stringValue: 'prod' } },
        { key: 'deployment.environment', value: { stringValue: 'prod' } },
      ]},
      scopeSpans: [{
        scope: { name: 'lib' },
        spans: [
          {
            traceId:           '11111111111111111111111111111111',
            spanId:            'aaaaaaaaaaaaaaaa',
            parentSpanId:      '',
            name:              'POST /orders',
            kind:              2,
            startTimeUnixNano: '1745230000000000000',
            endTimeUnixNano:   '1745230000015000000',
            status: { code: 1 },
            attributes: [
              { key: 'http.method', value: { stringValue: 'POST' } },
            ],
          },
          {
            traceId:           '11111111111111111111111111111111',
            spanId:            'bbbbbbbbbbbbbbbb',
            parentSpanId:      'aaaaaaaaaaaaaaaa',
            name:              'GET /inventory',
            kind:              3,
            startTimeUnixNano: '1745230000005000000',
            endTimeUnixNano:   '1745230000010000000',
            status: { code: 2 },
            attributes: [],
          },
        ],
      }],
    }],
  }

  test('produces one row per span with service/resource attributes attached', () => {
    const rows = flattenResourceSpans(payload)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.service_name).toBe('orders')
      expect(r.service_namespace).toBe('prod')
      expect(r.deployment_environment).toBe('prod')
      expect(r.resource_attributes['service.name']).toBe('orders')
      expect(r.trace_id).toBeInstanceOf(Buffer)
      expect(r.span_id).toBeInstanceOf(Buffer)
    }
    expect(rows[0].parent_span_id).toBeNull()
    expect(rows[1].parent_span_id).toBeInstanceOf(Buffer)
    expect(rows[1].status_code).toBe(2)
  })

  test('preserves BigInt nanos as strings', () => {
    const rows = flattenResourceSpans(payload)
    expect(typeof rows[0].start_time_ns).toBe('string')
    expect(rows[0].start_time_ns).toBe('1745230000000000000')
  })

  test('accepts legacy instrumentationLibrarySpans shape', () => {
    const legacy = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'legacy' } }] },
        instrumentationLibrarySpans: [{ spans: [{
          traceId: '11111111111111111111111111111111',
          spanId:  'cccccccccccccccc',
          startTimeUnixNano: '1',
          endTimeUnixNano:   '2',
        }]}],
      }],
    }
    const rows = flattenResourceSpans(legacy)
    expect(rows).toHaveLength(1)
    expect(rows[0].service_name).toBe('legacy')
  })

  test('returns an empty array for a payload with no resourceSpans', () => {
    expect(flattenResourceSpans({})).toEqual([])
    expect(flattenResourceSpans({ resourceSpans: [] })).toEqual([])
  })
})
