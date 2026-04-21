import { describe, test, expect } from '@jest/globals'
import {
  componentKey, inferVia, inferProtocol, inferRoute, percentile, aggregateBatch,
} from '../otel-aggregator.js'

function span({
  serviceName, namespace = 'prod', env = 'prod',
  spanId, parentSpanId = null, startMs, endMs,
  statusCode = 1, attrs = {},
}) {
  return {
    service_name:           serviceName,
    service_namespace:      namespace,
    deployment_environment: env,
    span_id:                Buffer.from(spanId, 'hex'),
    parent_span_id:         parentSpanId ? Buffer.from(parentSpanId, 'hex') : null,
    start_time_ns:          String(startMs * 1_000_000),
    end_time_ns:            String(endMs   * 1_000_000),
    status_code:            statusCode,
    attributes:             attrs,
    resource_attributes:    { 'service.name': serviceName },
  }
}

describe('pure helpers', () => {
  test('componentKey groups by namespace/name/env', () => {
    expect(componentKey({ service_name: 'a', service_namespace: 'ns', deployment_environment: 'prod' }))
      .toBe('ns|a|prod')
  })

  test('inferVia picks db/messaging/rpc/http in priority order', () => {
    expect(inferVia({ 'db.system': 'postgres' })).toBe('otel-db')
    expect(inferVia({ 'messaging.system': 'kafka' })).toBe('otel-messaging')
    expect(inferVia({ 'rpc.system': 'grpc' })).toBe('otel-rpc')
    expect(inferVia({ 'http.method': 'GET' })).toBe('otel-http')
    expect(inferVia({})).toBe('otel-http')   // weak default
  })

  test('inferProtocol & inferRoute extract common attribute keys', () => {
    expect(inferProtocol({ 'http.scheme': 'https' })).toBe('https')
    expect(inferProtocol({ 'db.system': 'postgres' })).toBe('postgres')
    expect(inferProtocol({})).toBeNull()

    expect(inferRoute({ 'http.route': '/a' })).toBe('/a')
    expect(inferRoute({ 'http.target': '/b' })).toBe('/b')
    expect(inferRoute({})).toBeNull()
  })

  test('percentile picks the indexed value of a sorted array', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(sorted, 0.5)).toBe(6)
    expect(percentile(sorted, 0.95)).toBe(10)
    expect(percentile([], 0.5)).toBe(0)
  })
})

describe('aggregateBatch', () => {
  test('groups components by service and aggregates cross-service edges', () => {
    const rows = [
      span({ serviceName: 'frontend', spanId: 'aaaaaaaaaaaaaaaa',
             startMs: 1000, endMs: 1020 }),
      span({ serviceName: 'orders', spanId: 'bbbbbbbbbbbbbbbb',
             parentSpanId: 'aaaaaaaaaaaaaaaa',
             startMs: 1005, endMs: 1015, attrs: { 'http.method': 'POST', 'http.route': '/orders' } }),
      span({ serviceName: 'orders', spanId: 'cccccccccccccccc',
             parentSpanId: 'bbbbbbbbbbbbbbbb',
             startMs: 1008, endMs: 1012 }),
      span({ serviceName: 'payments', spanId: 'dddddddddddddddd',
             parentSpanId: 'cccccccccccccccc', statusCode: 2,
             startMs: 1009, endMs: 1011, attrs: { 'http.method': 'POST' } }),
    ]
    const { components, edges } = aggregateBatch(rows)

    const names = components.map(c => c.name).sort()
    expect(names).toEqual(['frontend', 'orders', 'payments'])

    const labelled = edges.map(e => `${e.srcName}→${e.dstName}`).sort()
    expect(labelled).toEqual(['frontend→orders', 'orders→payments'])

    const fOrders = edges.find(e => e.srcName === 'frontend')
    expect(fOrders.via).toBe('otel-http')
    expect(fOrders.route).toBe('/orders')
    expect(fOrders.errorRate).toBe(0)

    const oPayments = edges.find(e => e.srcName === 'orders')
    expect(oPayments.errorRate).toBe(1)   // the single span errored
  })

  test('within-service spans do not produce edges', () => {
    const rows = [
      span({ serviceName: 'orders', spanId: 'aaaaaaaaaaaaaaaa',
             startMs: 1000, endMs: 1010 }),
      span({ serviceName: 'orders', spanId: 'bbbbbbbbbbbbbbbb',
             parentSpanId: 'aaaaaaaaaaaaaaaa', startMs: 1002, endMs: 1008 }),
    ]
    const { components, edges } = aggregateBatch(rows)
    expect(components.map(c => c.name)).toEqual(['orders'])
    expect(edges).toEqual([])
  })

  test('spans whose parent is absent are silently skipped', () => {
    const rows = [
      span({ serviceName: 'orders', spanId: 'aaaaaaaaaaaaaaaa',
             parentSpanId: '0000000000000099', startMs: 1000, endMs: 1010 }),
    ]
    const { edges } = aggregateBatch(rows)
    expect(edges).toEqual([])
  })

  test('emits stable window start/end timestamps', () => {
    const rows = [
      span({ serviceName: 'a', spanId: 'aaaaaaaaaaaaaaaa',
             startMs: 1_745_230_000_000, endMs: 1_745_230_000_020 }),
      span({ serviceName: 'b', spanId: 'bbbbbbbbbbbbbbbb',
             parentSpanId: 'aaaaaaaaaaaaaaaa',
             startMs: 1_745_230_000_005, endMs: 1_745_230_000_015 }),
    ]
    const { edges } = aggregateBatch(rows)
    expect(edges[0].windowStart).toMatch(/^202[0-9]-\d{2}-\d{2}T/)
    expect(edges[0].windowEnd).toMatch(/^202[0-9]-\d{2}-\d{2}T/)
    expect(Date.parse(edges[0].windowEnd) >= Date.parse(edges[0].windowStart)).toBe(true)
  })
})
