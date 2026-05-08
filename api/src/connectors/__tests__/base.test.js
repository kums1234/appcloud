import { describe, test, expect, jest } from '@jest/globals'
import { ConnectorError, withRetry, validateRequired, runPullScan } from '../base.js'

describe('ConnectorError', () => {
  test('carries connectorId, phase, and wraps the cause', () => {
    const inner = new Error('boom')
    const err = new ConnectorError('terraform-cloud', 'fetch', inner, 'page 3')
    expect(err.connectorId).toBe('terraform-cloud')
    expect(err.phase).toBe('fetch')
    expect(err.message).toMatch(/\[terraform-cloud\/fetch\]/)
    expect(err.message).toMatch(/boom/)
    expect(err.message).toMatch(/page 3/)
    expect(err.cause).toBe(inner)
  })

  test('accepts a plain string cause', () => {
    const err = new ConnectorError('x', 'y', 'string cause')
    expect(err.cause).toBeInstanceOf(Error)
    expect(err.cause.message).toBe('string cause')
  })
})

describe('validateRequired', () => {
  test('returns errors for missing required fields', () => {
    const schema = { required: ['a', 'b', 'c'] }
    expect(validateRequired(schema, { a: 1, c: 2 }))
      .toEqual(['Missing required field: b'])
  })

  test('treats empty strings as missing', () => {
    const schema = { required: ['token'] }
    expect(validateRequired(schema, { token: '' }))
      .toEqual(['Missing required field: token'])
  })

  test('no schema or no required → no errors', () => {
    expect(validateRequired(null, { any: 'thing' })).toEqual([])
    expect(validateRequired({}, { any: 'thing' })).toEqual([])
    expect(validateRequired({ required: [] }, {})).toEqual([])
  })
})

describe('withRetry', () => {
  test('returns the first successful attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const out = await withRetry(fn, { attempts: 3, baseMs: 1 })
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('retries after transient failures, then succeeds', async () => {
    let n = 0
    const fn = jest.fn(async () => {
      n++
      if (n < 3) throw new Error('transient')
      return 'ok'
    })
    const out = await withRetry(fn, { attempts: 5, baseMs: 1 })
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('throws the last error after attempts are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always'))
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toThrow('always')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('invokes onAttempt with the attempt index and error', async () => {
    const onAttempt = jest.fn()
    await withRetry(async () => { throw new Error('x') }, { attempts: 2, baseMs: 1, onAttempt }).catch(() => {})
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onAttempt.mock.calls[0][0]).toBe(0)
    expect(onAttempt.mock.calls[1][0]).toBe(1)
  })
})

describe('runPullScan', () => {
  function makeSpec(overrides = {}) {
    return {
      id: 'test-connector',
      fetch: overrides.fetch || (async function* () { yield {}; yield {} }),
      normalize: overrides.normalize || (raw => ({ kind: 'iac', raw })),
      ingest: overrides.ingest || (async () => ({
        resourcesFound: 1, resourcesCreated: 1, resourcesUpdated: 0,
        resourcesSkipped: 0, edgesCreated: 0, warnings: [],
      })),
    }
  }

  test('aggregates per-batch IngestResults', async () => {
    const spec = makeSpec()
    const result = await runPullScan(spec, {}, { log: { info() {}, warn() {} } })
    expect(result.resourcesFound).toBe(2)
    expect(result.resourcesCreated).toBe(2)
  })

  test('propagates a normalize error as ConnectorError with phase=normalize', async () => {
    const spec = makeSpec({ normalize: () => { throw new Error('bad-state') } })
    await expect(runPullScan(spec, {}, { log: { info() {}, warn() {} } }))
      .rejects.toMatchObject({ connectorId: 'test-connector', phase: 'normalize' })
  })

  test('propagates an ingest error as ConnectorError with phase=ingest', async () => {
    const spec = makeSpec({ ingest: async () => { throw new Error('neo4j-down') } })
    await expect(runPullScan(spec, {}, { log: { info() {}, warn() {} } }))
      .rejects.toMatchObject({ connectorId: 'test-connector', phase: 'ingest' })
  })

  test('throws a dispatch error when the connector is push-only', async () => {
    await expect(runPullScan({ id: 'x', receiver: {} }, {}, {}))
      .rejects.toMatchObject({ phase: 'run' })
  })

  test('respects AbortSignal mid-stream', async () => {
    const ctrl = new AbortController()
    const spec = makeSpec({
      fetch: async function* () {
        yield {}
        ctrl.abort()
        yield {}   // should not be ingested
      },
    })
    const ingest = jest.fn(async () => ({
      resourcesFound: 1, resourcesCreated: 1, resourcesUpdated: 0,
      resourcesSkipped: 0, warnings: [],
    }))
    spec.ingest = ingest
    const out = await runPullScan(spec, {}, { log: { info() {}, warn() {} }, signal: ctrl.signal })
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(out.warnings).toContain('aborted by scheduler')
  })
})
