// api/src/connectors/servicenow/api.js
//
// Thin ServiceNow Table API client. Basic-auth only (per the refocus
// scoping). Pagination uses sysparm_limit + sysparm_offset; we stop when a
// page comes back shorter than the page size. The explicit sysparm_fields
// list keeps payloads small on tenants with very wide CMDB tables.
//
// No retries or concurrency here — runPullScan drives fetch one batch at a
// time and the framework's withRetry wrapper is opt-in at the caller.

import { assertSafeUrl } from '../../utils/url-guard.js'

const DEFAULT_PAGE_SIZE = 500

export class ServiceNowClient {
  /**
   * @param {object} opts
   * @param {string} opts.instance  Either 'mycompany' or 'mycompany.service-now.com'.
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {AbortSignal} [opts.signal]
   * @param {typeof fetch} [opts.fetchFn]  Injectable for tests.
   */
  constructor({ instance, username, password, signal, fetchFn } = {}) {
    if (!instance)  throw new Error('instance is required')
    if (!username)  throw new Error('username is required')
    if (!password)  throw new Error('password is required')
    const host = instance.includes('.') ? instance : `${instance}.service-now.com`
    // SSRF guard. ServiceNow customer instances live on
    // *.service-now.com (or *.servicenowservices.com for FedRAMP /
    // gov clouds). Pin to those suffixes so an admin who sets
    // `instance: 'attacker.com'` (or even a typoed shape) gets a
    // clear refusal at construction time instead of a confused 401
    // later. https-only — ServiceNow doesn't terminate HTTP.
    const baseUrl = `https://${host}`
    assertSafeUrl(baseUrl, {
      allowedSchemes:      ['https:'],
      allowedHostSuffixes: ['.service-now.com', '.servicenowservices.com'],
    })
    this.baseUrl    = baseUrl
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    this.signal     = signal
    this.fetch      = fetchFn || globalThis.fetch
  }

  async _get(path, params) {
    const url = new URL(`${this.baseUrl}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v))
      }
    }
    const res = await this.fetch(url.toString(), {
      method: 'GET',
      signal: this.signal,
      headers: {
        Accept:        'application/json',
        Authorization: this.authHeader,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ServiceNow ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
    }
    return res.json()
  }

  /**
   * Hit the shortest-possible table to confirm credentials + reachability.
   * sys_user exists on every tenant and the 1-row limit makes it cheap.
   */
  async ping() {
    await this._get('/api/now/table/sys_user', { sysparm_limit: 1, sysparm_fields: 'sys_id' })
  }

  /**
   * Async generator yielding arrays of rows from any Table-API endpoint, a
   * page at a time. Caller decides when to stop (e.g. via `max`).
   *
   * @param {string} tableName e.g. 'cmdb_ci_server'
   * @param {object} opts
   * @param {string[]} [opts.fields]   Whitelist of columns to request.
   * @param {number}   [opts.pageSize] Rows per page (default 500).
   * @param {number}   [opts.max]      Hard cap on total rows yielded.
   * @param {string}   [opts.query]    sysparm_query expression (optional).
   */
  async *listTable(tableName, { fields, pageSize = DEFAULT_PAGE_SIZE, max = Infinity, query } = {}) {
    let offset  = 0
    let yielded = 0
    const params = {
      sysparm_limit:          pageSize,
      sysparm_exclude_reference_link: true,
      sysparm_display_value:  false,
    }
    if (fields?.length) params.sysparm_fields = fields.join(',')
    if (query)          params.sysparm_query  = query

    while (yielded < max) {
      if (this.signal?.aborted) return
      const remaining = max - yielded
      const limit     = Math.min(pageSize, remaining)
      const { result } = await this._get(`/api/now/table/${encodeURIComponent(tableName)}`, {
        ...params,
        sysparm_limit:  limit,
        sysparm_offset: offset,
      })
      if (!Array.isArray(result) || result.length === 0) return
      // Defensive slice: enforce `max` even if the server returns more rows
      // than `sysparm_limit` requested. ServiceNow has been observed to
      // ignore `sysparm_limit` under specific query-builder paths; the
      // contract here is "yield at most `max` rows total".
      const page = result.length > remaining ? result.slice(0, remaining) : result
      yield page
      yielded += page.length
      // Short page (vs. what we asked for) ⇒ no more rows on the server.
      if (result.length < limit) return
      offset += page.length
    }
  }

  // Kept for call-site readability — listCis is just listTable for CI tables.
  listCis(tableName, opts) { return this.listTable(tableName, opts) }

  /**
   * Stream cmdb_rel_ci rows — one row per ServiceNow CI→CI relationship.
   * Columns we care about: sys_id (relation id), parent (CI sys_id),
   * child (CI sys_id), type (relationship type sys_id on cmdb_rel_type).
   * Display-value on `type` is enabled on this call so we get the readable
   * name ("Hosted on", "Depends on", ...) without a second fetch.
   */
  async *listRelations(opts = {}) {
    const fields = ['sys_id', 'parent', 'child', 'type', 'sys_updated_on']
    const params = {
      sysparm_limit:          opts.pageSize || DEFAULT_PAGE_SIZE,
      sysparm_exclude_reference_link: true,
      sysparm_display_value:  'all',   // returns { value, display_value } for `type`
      sysparm_fields:         fields.join(','),
    }

    let offset  = 0
    let yielded = 0
    const max = opts.max ?? Infinity
    const pageSize = opts.pageSize || DEFAULT_PAGE_SIZE

    while (yielded < max) {
      if (this.signal?.aborted) return
      const remaining = max - yielded
      const limit     = Math.min(pageSize, remaining)
      const { result } = await this._get('/api/now/table/cmdb_rel_ci', {
        ...params,
        sysparm_limit:  limit,
        sysparm_offset: offset,
      })
      if (!Array.isArray(result) || result.length === 0) return
      yield result
      yielded += result.length
      if (result.length < limit) return
      offset += result.length
    }
  }
}
