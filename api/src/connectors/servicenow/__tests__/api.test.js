import { describe, test, expect, jest } from '@jest/globals'
import { ServiceNowClient } from '../api.js'

// ── Helper: build a fake fetch that returns scripted pages ──────────────────
function makeFakeFetch(pages) {
  const calls = []
  const fn = jest.fn(async (url) => {
    calls.push(url)
    const u = new URL(url)
    const offset = parseInt(u.searchParams.get('sysparm_offset') || '0', 10)
    const page = pages.find(p => p.offset === offset)
    if (!page) return new Response(JSON.stringify({ result: [] }), { status: 200 })
    if (page.status && page.status >= 400) {
      return new Response(page.body || 'error', { status: page.status, statusText: 'Err' })
    }
    return new Response(JSON.stringify({ result: page.rows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  fn.__calls = calls
  return fn
}

describe('ServiceNowClient', () => {
  test('constructor validates required fields', () => {
    expect(() => new ServiceNowClient({ username: 'u', password: 'p' })).toThrow(/instance/)
    expect(() => new ServiceNowClient({ instance: 'x', password: 'p' })).toThrow(/username/)
    expect(() => new ServiceNowClient({ instance: 'x', username: 'u' })).toThrow(/password/)
  })

  test('constructor expands short instance to full .service-now.com host', async () => {
    const fake = makeFakeFetch([{ offset: 0, rows: [{ sys_id: '1' }] }])
    const c = new ServiceNowClient({ instance: 'mycompany', username: 'u', password: 'p', fetchFn: fake })
    await c.ping()
    expect(new URL(fake.__calls[0]).host).toBe('mycompany.service-now.com')
  })

  test('constructor preserves full hostname when already qualified', async () => {
    const fake = makeFakeFetch([{ offset: 0, rows: [{ sys_id: '1' }] }])
    const c = new ServiceNowClient({ instance: 'mycompany.service-now.com', username: 'u', password: 'p', fetchFn: fake })
    await c.ping()
    expect(new URL(fake.__calls[0]).host).toBe('mycompany.service-now.com')
  })

  test('rejects an instance that escapes the .service-now.com host suffix (SSRF guard)', () => {
    expect(() =>
      new ServiceNowClient({ instance: 'attacker.example.com', username: 'u', password: 'p' }),
    ).toThrow(/refusing to fetch/)
  })

  test('sends a Basic Authorization header', async () => {
    const fake = jest.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200 }))
    const c = new ServiceNowClient({ instance: 'x', username: 'alice', password: 's3cret', fetchFn: fake })
    await c.ping()
    const [, opts] = fake.mock.calls[0]
    expect(opts.headers.Authorization).toBe('Basic ' + Buffer.from('alice:s3cret').toString('base64'))
  })

  test('non-2xx response throws with status and body prefix', async () => {
    const fake = jest.fn(async () =>
      new Response('Invalid credentials', { status: 401, statusText: 'Unauthorized' }))
    const c = new ServiceNowClient({ instance: 'x', username: 'u', password: 'p', fetchFn: fake })
    await expect(c.ping()).rejects.toThrow(/401/)
  })

  test('listCis paginates until a short page arrives', async () => {
    const fake = makeFakeFetch([
      { offset: 0,   rows: Array.from({ length: 500 }, (_, i) => ({ sys_id: `a${i}` })) },
      { offset: 500, rows: Array.from({ length: 500 }, (_, i) => ({ sys_id: `b${i}` })) },
      { offset: 1000, rows: [{ sys_id: 'last' }] },  // short page — stop after this
    ])
    const c = new ServiceNowClient({ instance: 'x', username: 'u', password: 'p', fetchFn: fake })

    const all = []
    for await (const page of c.listCis('cmdb_ci_server', { fields: ['sys_id'] })) all.push(...page)

    expect(all).toHaveLength(1001)
    expect(fake.__calls).toHaveLength(3)
    // Explicit sysparm_fields honoured
    expect(fake.__calls[0]).toContain('sysparm_fields=sys_id')
  })

  test('listCis honours the `max` cap', async () => {
    const fake = makeFakeFetch([
      { offset: 0, rows: Array.from({ length: 500 }, (_, i) => ({ sys_id: `a${i}` })) },
    ])
    const c = new ServiceNowClient({ instance: 'x', username: 'u', password: 'p', fetchFn: fake })

    const all = []
    for await (const page of c.listCis('cmdb_ci_server', { pageSize: 500, max: 50 })) all.push(...page)

    expect(all).toHaveLength(50)
    // Only one request — the page size was clamped to the remaining cap (50).
    expect(fake.__calls).toHaveLength(1)
    expect(fake.__calls[0]).toContain('sysparm_limit=50')
  })

  test('listCis returns cleanly on empty first page', async () => {
    const fake = makeFakeFetch([{ offset: 0, rows: [] }])
    const c = new ServiceNowClient({ instance: 'x', username: 'u', password: 'p', fetchFn: fake })
    const all = []
    for await (const page of c.listCis('cmdb_ci_server')) all.push(...page)
    expect(all).toEqual([])
  })
})
