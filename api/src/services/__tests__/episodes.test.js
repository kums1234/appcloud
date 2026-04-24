import { describe, test, expect, jest } from '@jest/globals'
import { startEpisode, finishEpisode } from '../episodes.js'

function mockNeo4j() {
  const writes = []
  const write = jest.fn(async (cypher, params) => {
    writes.push({ cypher, params })
    return []
  })
  return { write, query: jest.fn(), __writes: writes }
}

describe('startEpisode', () => {
  test('generates a uuid when none is supplied', async () => {
    const neo = mockNeo4j()
    const ep = await startEpisode(neo, 'test.source')
    expect(ep.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(ep.source).toBe('test.source')
    expect(ep.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(neo.write).toHaveBeenCalledTimes(1)
    expect(neo.__writes[0].params.id).toBe(ep.uuid)
    expect(neo.__writes[0].params.source).toBe('test.source')
  })

  test('honours caller-supplied uuid (idempotent resume)', async () => {
    const neo = mockNeo4j()
    const ep = await startEpisode(neo, 'test.source', 'caller-fixed-uuid')
    expect(ep.uuid).toBe('caller-fixed-uuid')
  })

  test('writes a MERGE on :IngestionEpisode — first run captures source + startedAt', async () => {
    const neo = mockNeo4j()
    await startEpisode(neo, 'test.source')
    const { cypher } = neo.__writes[0]
    expect(cypher).toMatch(/MERGE.*:IngestionEpisode/)
    expect(cypher).toMatch(/ON CREATE SET[\s\S]*source/)
  })

  test('rejects without a neo4j.write function', async () => {
    await expect(startEpisode(null, 'x')).rejects.toThrow(/neo4j write/)
    await expect(startEpisode({}, 'x')).rejects.toThrow(/neo4j write/)
  })
})

describe('finishEpisode', () => {
  test('stamps finishedAt + outcome + stats onto the matched episode', async () => {
    const neo = mockNeo4j()
    const ep  = await startEpisode(neo, 'test.source')
    await finishEpisode(neo, ep, 'ok', { foo: 1 })
    const finishCall = neo.__writes[1]
    expect(finishCall.cypher).toMatch(/MATCH.*:IngestionEpisode/)
    expect(finishCall.cypher).toMatch(/SET[\s\S]*finishedAt/)
    expect(finishCall.params.outcome).toBe('ok')
    expect(JSON.parse(finishCall.params.stats)).toEqual({ foo: 1 })
  })

  test('null stats is preserved as null (not the string "null")', async () => {
    const neo = mockNeo4j()
    const ep  = await startEpisode(neo, 'test.source')
    await finishEpisode(neo, ep)
    expect(neo.__writes[1].params.stats).toBeNull()
  })

  test('no-op when episode is null / missing uuid / missing write fn', async () => {
    const neo = mockNeo4j()
    await finishEpisode(neo, null)
    await finishEpisode(neo, {})
    await finishEpisode(null, { uuid: 'x' })
    expect(neo.write).not.toHaveBeenCalled()
  })

  test('swallows write errors so a failing finish never crashes the caller', async () => {
    const neo = {
      write: jest.fn(async () => { throw new Error('neo4j down') }),
      query: jest.fn(),
    }
    await expect(finishEpisode(neo, { uuid: 'x' }, 'error')).resolves.toBeUndefined()
  })
})
