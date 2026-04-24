// api/src/connectors/servicenow/api.js
//
// Thin ServiceNow Table API client. Basic-auth only (per the refocus
// scoping). Pagination uses sysparm_limit + sysparm_offset; we stop when a
// page comes back shorter than the page size. The explicit sysparm_fields
// list keeps payloads small on tenants with very wide CMDB tables.
//
// No retries or concurrency here — runPullScan drives fetch one batch at a
// time and the framework's withRetry wrapper is opt-in at the caller.

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
    this.baseUrl  = `https://${host}`
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    this.signal  = signal
    this.fetch   = fetchFn || globalThis.fetch
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
   * Async generator yielding arrays of CI rows for one table, a page at a
   * time. Caller decides when to stop (e.g. maxPerTable).
   *
   * @param {string} tableName e.g. 'cmdb_ci_server'
   * @param {object} opts
   * @param {string[]} [opts.fields]   Whitelist of columns to request.
   * @param {number}   [opts.pageSize] Rows per page (default 500).
   * @param {number}   [opts.max]      Hard cap on total rows yielded.
   */
  async *listCis(tableName, { fields, pageSize = DEFAULT_PAGE_SIZE, max = Infinity } = {}) {
    let offset  = 0
    let yielded = 0
    const params = {
      sysparm_limit:          pageSize,
      sysparm_exclude_reference_link: true,
      sysparm_display_value:  false,
    }
    if (fields?.length) params.sysparm_fields = fields.join(',')

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
      yield result
      yielded += result.length
      // Short page ⇒ no more rows on the server.
      if (result.length < limit) return
      offset += result.length
    }
  }
}
