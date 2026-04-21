import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { TfcClient, extractRemoteStateRefs } from '../api.js'

// Mock the global fetch directly. Node 18+'s built-in fetch uses a bundled
// undici that is not the same instance as the npm `undici` package, so
// nock + MockAgent can't intercept reliably — replacing `globalThis.fetch`
// is portable and cheap.

const TOKEN = 'test-token-abc'

function mockResp({ status = 200, body = '', headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, { status, headers })
}

let fetchSpy
beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('unexpected fetch — test did not configure a response')
  })
})
afterEach(() => {
  fetchSpy.mockRestore()
})

function expectBearer(call) {
  const init = call[1] || {}
  const auth = init.headers?.Authorization || init.headers?.authorization
  expect(auth).toBe(`Bearer ${TOKEN}`)
}

describe('TfcClient.ping', () => {
  test('requests the org endpoint with Bearer auth', async () => {
    fetchSpy.mockResolvedValueOnce(mockResp({ body: { data: { id: 'my-org' } } }))
    const c = new TfcClient({ apiToken: TOKEN })
    await expect(c.ping('my-org')).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://app.terraform.io/api/v2/organizations/my-org')
    expectBearer(fetchSpy.mock.calls[0])
  })

  test('surfaces a non-200 response as an Error with the status code', async () => {
    fetchSpy.mockResolvedValueOnce(mockResp({ status: 403, body: 'forbidden' }))
    const c = new TfcClient({ apiToken: TOKEN })
    await expect(c.ping('bad')).rejects.toMatchObject({ status: 403 })
  })
})

describe('TfcClient.listWorkspaces', () => {
  test('walks JSON:API pagination via links.next', async () => {
    const HOST = 'https://app.terraform.io'
    fetchSpy
      .mockResolvedValueOnce(mockResp({ body: {
        data: [
          { id: 'ws-1', attributes: { name: 'prod-web',      'tag-names': ['prod'] } },
          { id: 'ws-2', attributes: { name: 'prod-payments', 'tag-names': ['prod'] } },
        ],
        links: { next: `${HOST}/api/v2/organizations/my-org/workspaces?page[number]=2` },
      }}))
      .mockResolvedValueOnce(mockResp({ body: {
        data: [{ id: 'ws-3', attributes: { name: 'staging-web', 'tag-names': ['staging'] } }],
        links: {},
      }}))

    const c = new TfcClient({ apiToken: TOKEN })
    const all = []
    for await (const ws of c.listWorkspaces({ organization: 'my-org' })) all.push(ws)
    expect(all.map(w => w.id)).toEqual(['ws-1', 'ws-2', 'ws-3'])
    expect(all[0].tags).toEqual(['prod'])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('passes tag + name filters in the query string', async () => {
    fetchSpy.mockResolvedValueOnce(mockResp({ body: { data: [], links: {} } }))

    const c = new TfcClient({ apiToken: TOKEN })
    for await (const _ of c.listWorkspaces({
      organization: 'my-org',
      filter: { tags: ['prod', 'web'], namePrefix: 'prod-' },
    })) {}

    const url = fetchSpy.mock.calls[0][0]
    expect(url).toContain('search%5Btags%5D=prod%2Cweb')
    expect(url).toContain('search%5Bname%5D=prod-')
  })
})

describe('TfcClient.getCurrentStateVersion + downloadStateJson', () => {
  test('returns null download url when workspace has no state yet (404)', async () => {
    fetchSpy.mockResolvedValueOnce(mockResp({ status: 404, body: '' }))
    const c = new TfcClient({ apiToken: TOKEN })
    const sv = await c.getCurrentStateVersion('ws-new')
    expect(sv).toEqual({ id: null, downloadUrl: null, createdAt: null })
  })

  test('downloadStateJson fetches the pre-signed URL without bearer auth', async () => {
    const signedUrl = 'https://tfc-state.s3.example.com/my-state.json?signature=abc'
    fetchSpy.mockResolvedValueOnce(mockResp({
      body: { resources: [], version: 4 },
      headers: { 'content-type': 'application/json' },
    }))

    const c = new TfcClient({ apiToken: TOKEN })
    const json = await c.downloadStateJson(signedUrl)

    expect(json.version).toBe(4)
    const init = fetchSpy.mock.calls[0][1] || {}
    expect(init.headers?.Authorization).toBeUndefined()
    expect(init.headers?.authorization).toBeUndefined()
    expect(fetchSpy.mock.calls[0][0]).toBe(signedUrl)
  })
})

describe('extractRemoteStateRefs', () => {
  test('pulls workspace + org out of a terraform_remote_state data source', () => {
    const state = {
      resources: [{
        mode: 'data', type: 'terraform_remote_state', name: 'net',
        instances: [{ attributes: {
          backend: 'remote',
          config: {
            organization: 'my-org',
            workspaces:   { name: 'shared-networking' },
          },
        }}],
      }],
    }
    expect(extractRemoteStateRefs(state)).toEqual([
      {
        toWorkspaceName:   'shared-networking',
        toWorkspacePrefix: null,
        toOrganization:    'my-org',
        backend:           'remote',
      },
    ])
  })

  test('returns [] when there are no remote_state data sources', () => {
    expect(extractRemoteStateRefs({ resources: [] })).toEqual([])
    expect(extractRemoteStateRefs(null)).toEqual([])
  })

  test('walks child_modules in `terraform show -json` output', () => {
    const state = {
      values: { root_module: {
        resources: [],
        child_modules: [{
          resources: [{
            mode: 'data', type: 'terraform_remote_state', name: 'x',
            instances: [{ attributes: { config: {
              workspaces:   { prefix: 'env-' },
              organization: 'o',
            }}}],
          }],
        }],
      }},
    }
    expect(extractRemoteStateRefs(state)).toEqual([
      { toWorkspaceName: null, toWorkspacePrefix: 'env-', toOrganization: 'o', backend: 'remote' },
    ])
  })
})
