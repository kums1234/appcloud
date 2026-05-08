import { describe, test, expect } from '@jest/globals'
import spec, { mapRelToVia } from '../index.js'

// Slice 5 collapsed the legacy CONNECTS_TO/DEPLOYED_ON edge-label split
// into a single :CONNECTS_TO edge with a `via` property capturing the
// ServiceNow relation flavour. The test surface mirrors that.

describe('mapRelToVia', () => {
  test('hosting relationships map to deployment-style via values', () => {
    expect(mapRelToVia('Hosted on::Hosts').via).toBe('hosted-on')
    expect(mapRelToVia('Runs on::Runs').via).toBe('runs-on')
    expect(mapRelToVia('Virtualised by::Virtualises').via).toBe('virtualised-by')
    // British vs American spelling collapse to the same via for graph consistency
    expect(mapRelToVia('Virtualized by::Virtualizes').via).toBe('virtualised-by')
    expect(mapRelToVia('Installed on::Installs').via).toBe('installed-on')
  })

  test('dependency relationships map to logical-coupling via values', () => {
    expect(mapRelToVia('Depends on::Used by').via).toBe('depends-on')
    expect(mapRelToVia('Uses::Used by').via).toBe('uses')
    expect(mapRelToVia('Provides::Receives').via).toBe('provides')
    expect(mapRelToVia('Receives data from::Sends data to').via).toBe('receives-data-from')
    expect(mapRelToVia('Connected to::Connected by').via).toBe('connected-to-cmdb')
  })

  test('preserves the forward-direction label as relType', () => {
    expect(mapRelToVia('Depends on::Used by').relType).toBe('Depends on')
    expect(mapRelToVia('Hosted on::Hosts').relType).toBe('Hosted on')
  })

  test('unknown relation types fall back to a `cmdb-other` via without throwing', () => {
    const r = mapRelToVia('Weird custom rel::Reverse label')
    expect(r.via).toBe('cmdb-other')
    expect(r.relType).toBe('Weird custom rel')
  })

  test('handles null / empty gracefully', () => {
    expect(mapRelToVia(null)).toEqual({ via: 'cmdb-unknown', relType: 'Unknown' })
    expect(mapRelToVia('').via).toBe('cmdb-unknown')
  })
})

describe('normalize rels batch', () => {
  test('extracts parent/child/via/relType from display_value=all payload', () => {
    const raw = {
      kind: 'rels',
      rows: [
        {
          sys_id:         { value: 'rel1', display_value: '' },
          parent:         { value: 'ci-app',  display_value: 'Payments API' },
          child:          { value: 'ci-host', display_value: 'prod-vm-01' },
          type:           { value: 'typeId1', display_value: 'Hosted on::Hosts' },
          sys_updated_on: { value: '2026-03-01 12:00:00', display_value: '…' },
        },
      ],
    }
    const out = spec.normalize(raw)
    expect(out.kind).toBe('cmdb-rels')
    expect(out.rels).toHaveLength(1)
    expect(out.rels[0]).toEqual(expect.objectContaining({
      rel_sys_id: 'rel1',
      parent:     'ci-app',
      child:      'ci-host',
      via:        'hosted-on',
      relType:    'Hosted on',
      relTypeRaw: 'Hosted on::Hosts',
    }))
  })

  test('skips rows missing parent or child', () => {
    const raw = {
      kind: 'rels',
      rows: [
        { sys_id: { value: 'r1' }, parent: { value: '' }, child: { value: 'c' }, type: { value: 't', display_value: 'Depends on::Used by' } },
        { sys_id: { value: 'r2' }, parent: { value: 'p' }, child: { value: '' }, type: { value: 't', display_value: 'Depends on::Used by' } },
        { sys_id: { value: 'r3' }, parent: { value: 'p' }, child: { value: 'c' }, type: { value: 't', display_value: 'Depends on::Used by' } },
      ],
    }
    const out = spec.normalize(raw)
    expect(out.rels).toHaveLength(1)
    expect(out.rels[0].rel_sys_id).toBe('r3')
  })

  test('propagates fetchError as a warning and empty rels', () => {
    const out = spec.normalize({ kind: 'rels', rows: [], fetchError: 'boom' })
    expect(out.kind).toBe('cmdb-rels')
    expect(out.rels).toEqual([])
    expect(out.warning).toMatch(/boom/)
  })
})
