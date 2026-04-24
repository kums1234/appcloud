import { describe, test, expect } from '@jest/globals'
import { loadConnectors, getConnector, listConnectors, serializeSpec } from '../index.js'

// Minimal silent logger
const log = { info() {}, warn() {}, error() {} }

describe('connector registry', () => {
  test('loads the real connectors from the filesystem', async () => {
    const reg = await loadConnectors(log)
    const ids = Array.from(reg.keys()).sort()
    expect(ids).toEqual(expect.arrayContaining([
      'iac-state-backend',
      'otel-ingest',
      'servicenow',
      'terraform-cloud',
    ]))
  })

  test('every registered spec has the required shape', async () => {
    await loadConnectors(log)
    for (const spec of listConnectors()) {
      expect(typeof spec.id).toBe('string')
      expect(typeof spec.displayName).toBe('string')
      expect(['iac', 'apm', 'cloud', 'cmdb', 'telemetry-ingest', 'upload']).toContain(spec.category)
      expect(typeof spec.authSchema).toBe('object')

      // Must be either pull-style (fetch) or push-style (receiver), not neither.
      const isPull = typeof spec.fetch === 'function'
      const isPush = !!spec.receiver?.register
      expect(isPull || isPush).toBe(true)

      if (isPull) {
        expect(typeof spec.normalize).toBe('function')
        expect(typeof spec.ingest).toBe('function')
      }
    }
  })

  test('getConnector returns the cached spec, serializeSpec strips functions', async () => {
    await loadConnectors(log)
    const tfc = getConnector('terraform-cloud')
    expect(tfc).toBeTruthy()
    expect(tfc.id).toBe('terraform-cloud')

    const serialised = serializeSpec(tfc)
    expect(serialised.id).toBe('terraform-cloud')
    expect(serialised.style).toBe('pull')
    expect(serialised).not.toHaveProperty('fetch')
    expect(serialised).not.toHaveProperty('normalize')
  })

  test('otel-ingest is surfaced as push style', async () => {
    await loadConnectors(log)
    const s = serializeSpec(getConnector('otel-ingest'))
    expect(s.style).toBe('push')
  })

  test('iac-state-backend declares required backend + engine', async () => {
    await loadConnectors(log)
    const spec = getConnector('iac-state-backend')
    expect(spec.authSchema.required).toEqual(expect.arrayContaining(['backend', 'engine']))
  })

  test('terraform-cloud requires organization + apiToken', async () => {
    await loadConnectors(log)
    const spec = getConnector('terraform-cloud')
    expect(spec.authSchema.required).toEqual(expect.arrayContaining(['organization', 'apiToken']))
  })

  test('servicenow is a cmdb pull connector requiring instance + creds', async () => {
    await loadConnectors(log)
    const spec = getConnector('servicenow')
    expect(spec).toBeTruthy()
    expect(spec.category).toBe('cmdb')
    expect(spec.authSchema.required).toEqual(expect.arrayContaining(['instance', 'username', 'password']))
    expect(typeof spec.fetch).toBe('function')
    expect(typeof spec.normalize).toBe('function')
    expect(typeof spec.ingest).toBe('function')
    expect(spec.receiver).toBeUndefined()
  })
})
