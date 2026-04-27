// api/src/connectors/terraform-cloud/api.js
//
// Minimal Terraform Cloud / Enterprise REST API client. No SDK — TFC's
// JSON:API contract is stable and the endpoints we use are a small surface.
//
// Docs: https://developer.hashicorp.com/terraform/cloud-docs/api-docs
//
// Notes:
//   · Pagination follows JSON:API (`links.next` on each response).
//   · State downloads use a pre-signed URL (`hosted-state-download-url`)
//     that must be fetched WITHOUT the bearer token — adding it can break
//     the signature on some pre-sign implementations.
//   · TFC rate limits to ~30 req/s per token; we don't proactively throttle.
//     Back-off on 429 comes from withRetry at the connector level.

import { assertSafeUrl } from '../../utils/url-guard.js'

// Allowed TFC / TFE host suffixes. The two HCP-hosted suffixes cover
// every customer that uses Terraform Cloud / HCP Terraform; TFE
// (Terraform Enterprise) deployments are self-hosted and the suffix
// is whatever the operator picks — we accept those via the
// `APPCLOUD_TFE_HOST_SUFFIXES` env override (comma-separated, e.g.
// `.terraform.example.com`).
const HCP_TFC_HOST_SUFFIXES = ['.terraform.io', '.hashicorp.cloud']
function tfcAllowedSuffixes() {
  const extra = (process.env.APPCLOUD_TFE_HOST_SUFFIXES || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  return [...HCP_TFC_HOST_SUFFIXES, ...extra]
}

export class TfcClient {
  constructor({ hostname = 'app.terraform.io', apiToken, signal } = {}) {
    if (!apiToken) throw new Error('terraform-cloud: apiToken is required')
    const cleanHost = hostname.replace(/\/+$/, '')
    const baseUrl   = `https://${cleanHost}/api/v2`
    // SSRF guard. Operator-supplied hostname; without enforcement an
    // admin (or compromised admin key) could redirect every request +
    // bearer token to attacker.example. Pin to the HCP suffixes by
    // default; self-hosted TFE adds its suffix via env override.
    assertSafeUrl(baseUrl, {
      allowedSchemes:      ['https:'],
      allowedHostSuffixes: tfcAllowedSuffixes(),
    })
    this.baseUrl     = baseUrl
    this.allowedTfc  = tfcAllowedSuffixes()
    this.token       = apiToken
    this.signal      = signal
  }

  async #request(pathOrUrl, opts = {}) {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`
    const resp = await fetch(url, {
      signal: opts.signal ?? this.signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.api+json',
        ...opts.headers,
      },
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      const err  = new Error(`TFC ${resp.status} ${pathOrUrl}: ${body.slice(0, 500)}`)
      err.status = resp.status
      throw err
    }
    return resp
  }

  async #json(pathOrUrl, opts) {
    const resp = await this.#request(pathOrUrl, opts)
    return resp.json()
  }

  /** Verify auth + org visibility. */
  async ping(organization) {
    if (!organization) throw new Error('organization is required')
    await this.#json(`/organizations/${encodeURIComponent(organization)}`)
  }

  /**
   * List workspaces in an organisation, optionally filtered.
   * @param {{ organization:string, filter?:{ tags?:string[], namePrefix?:string } }} args
   * @returns {AsyncGenerator<{ id:string, name:string, environment?:string, tags:string[] }>}
   */
  async *listWorkspaces({ organization, filter }) {
    const params = new URLSearchParams()
    params.set('page[size]', '100')
    if (filter?.tags?.length)   params.set('search[tags]',    filter.tags.join(','))
    if (filter?.namePrefix)     params.set('search[name]',    filter.namePrefix)
    let url = `/organizations/${encodeURIComponent(organization)}/workspaces?${params}`

    while (url) {
      const resp = await this.#json(url)
      for (const ws of resp.data || []) {
        yield {
          id:          ws.id,
          name:        ws.attributes?.name,
          environment: ws.attributes?.environment,
          tags:        ws.attributes?.['tag-names'] || [],
        }
      }
      const next = resp.links?.next
      url = next ? next.replace(this.baseUrl, '') : null
    }
  }

  /** Look up workspaces by explicit IDs. Preserves input order; missing IDs are skipped. */
  async getWorkspacesById(ids = []) {
    const out = []
    for (const id of ids) {
      try {
        const resp = await this.#json(`/workspaces/${encodeURIComponent(id)}`)
        const ws = resp.data
        if (ws) {
          out.push({
            id:          ws.id,
            name:        ws.attributes?.name,
            environment: ws.attributes?.environment,
            tags:        ws.attributes?.['tag-names'] || [],
          })
        }
      } catch (err) {
        if (err.status !== 404) throw err
      }
    }
    return out
  }

  /**
   * Fetch the latest state version for a workspace.
   * @returns {Promise<{ id:string|null, downloadUrl:string|null, createdAt:string|null }>}
   */
  async getCurrentStateVersion(workspaceId) {
    try {
      const resp = await this.#json(`/workspaces/${encodeURIComponent(workspaceId)}/current-state-version`)
      const attrs = resp.data?.attributes || {}
      return {
        id:          resp.data?.id || null,
        downloadUrl: attrs['hosted-state-download-url'] || null,
        createdAt:   attrs['created-at'] || null,
      }
    } catch (err) {
      if (err.status === 404) return { id: null, downloadUrl: null, createdAt: null }
      throw err
    }
  }

  /** Download state JSON from the (pre-signed) URL returned by getCurrentStateVersion. */
  async downloadStateJson(downloadUrl) {
    // The pre-signed URL comes from the TFC API response, which is
    // signed by HCP Terraform's CDN — it should always live on a
    // hashicorp-controlled host. Validate before fetching: a
    // poisoned API response (man-in-the-middle, or a compromised
    // proxy) could otherwise redirect us to attacker-controlled
    // storage, and we'd fetch with default credentials.
    assertSafeUrl(downloadUrl, {
      allowedSchemes:      ['https:'],
      allowedHostSuffixes: this.allowedTfc.concat(['.amazonaws.com']),  // TFC stores on S3
    })
    const resp = await fetch(downloadUrl, { signal: this.signal })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`TFC state download ${resp.status}: ${body.slice(0, 500)}`)
    }
    return resp.json()
  }

  /**
   * Recent runs for a workspace, newest first. Used for change attribution in
   * the summary; not required for resource ingestion.
   */
  async getRecentRuns(workspaceId, { limit = 5 } = {}) {
    const resp = await this.#json(
      `/workspaces/${encodeURIComponent(workspaceId)}/runs?page[size]=${limit}`,
    )
    return (resp.data || []).map(r => ({
      id:         r.id,
      status:     r.attributes?.status,
      createdAt:  r.attributes?.['created-at'],
      message:    r.attributes?.message,
      isDestroy:  !!r.attributes?.['is-destroy'],
    }))
  }
}

/**
 * Scan a parsed state for `data "terraform_remote_state"` references.
 * Returns an array of { toWorkspaceName, toOrganization }. The caller
 * resolves these to workspace IDs as needed.
 */
export function extractRemoteStateRefs(stateJson) {
  const out = []
  if (!stateJson) return out
  // Support both tfstate v4 (resources[]) and `terraform show -json`
  // (values.root_module.resources[], recursive child_modules).
  const all = []
  if (Array.isArray(stateJson.resources)) all.push(...stateJson.resources)
  const walk = (mod) => {
    if (!mod) return
    if (Array.isArray(mod.resources)) all.push(...mod.resources)
    if (Array.isArray(mod.child_modules)) mod.child_modules.forEach(walk)
  }
  walk(stateJson.values?.root_module)

  for (const res of all) {
    if (res.mode !== 'data' || res.type !== 'terraform_remote_state') continue
    // v4 stores config under instances[].attributes.config (map of objects)
    const instances = res.instances?.length
      ? res.instances
      : (res.primary ? [{ attributes: res.primary.attributes }] : [])
    for (const inst of instances) {
      const attrs  = inst?.attributes || {}
      const config = attrs.config || {}
      // remote backend
      const wsCfg = config.workspaces
      if (wsCfg?.name || wsCfg?.prefix) {
        out.push({
          toWorkspaceName: wsCfg.name || null,
          toWorkspacePrefix: wsCfg.prefix || null,
          toOrganization:  config.organization || null,
          backend:         attrs.backend || 'remote',
        })
      }
    }
  }
  return out
}
