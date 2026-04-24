import { describe, test, expect } from '@jest/globals'
import spec, { mapRelToEdge } from '../index.js'

describe('mapRelToEdge', () => {
  test('hosting relationships map to DEPLOYED_ON', () => {
    expect(mapRelToEdge('Hosted on::Hosts').edge).toBe('DEPLOYED_ON')
    expect(mapRelToEdge('Runs on::Runs').edge).toBe('DEPLOYED_ON')
    expect(mapRelToEdge('Virtualised by::Virtualises').edge).toBe('DEPLOYED_ON')
    expect(mapRelToEdge('Virtualized by::Virtualizes').edge).toBe('DEPLOYED_ON')
    expect(mapRelToEdge('Installed on::Installs').edge).toBe('DEPLOYED_ON')
  })

  test('dependency relationships map to CONNECTS_TO', () => {
    expect(mapRelToEdge('Depends on::Used by').edge).toBe('CONNECTS_TO')
    expect(mapRelToEdge('Uses::Used by').edge).toBe('CONNECTS_TO')
    expect(mapRelToEdge('Provides::Receives').edge).toBe('CONNECTS_TO')
    expect(mapRelToEdge('Receives data from::Sends data to').edge).toBe('CONNECTS_TO')
    expect(mapRelToEdge('Connected to::Connected by').edge).toBe('CONNECTS_TO')
  })

  test('preserves the forward-direction label as relType', () => {
    expect(mapRelToEdge('Depends on::Used by').relType).toBe('Depends on')
    expect(mapRelToEdge('Hosted on::Hosts').relType).toBe('Hosted on')
  })

  test('unknown relation types fall back to CONNECTS_TO without throwing', () => {
    const r = mapRelToEdge('Weird custom rel::Reverse label')
    expect(r.edge).toBe('CONNECTS_TO')
    expect(r.relType).toBe('Weird custom rel')
  })

  test('handles null / empty gracefully', () => {
    expect(mapRelToEdge(null)).toEqual({ edge: 'CONNECTS_TO', relType: 'Unknown' })
    expect(mapRelToEdge('').edge).toBe('CONNECTS_TO')
  })
})

describe('normalize rels batch', () => {
  test('extracts parent/child/edge/relType from display_value=all payload', () => {
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
      edge:       'DEPLOYED_ON',
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
