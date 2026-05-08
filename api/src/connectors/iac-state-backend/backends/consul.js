// api/src/connectors/iac-state-backend/backends/consul.js
//
// Fetches Terraform / OpenTofu state from HashiCorp Consul's KV store. Config:
//   {
//     backend:       'consul',
//     engine:        'terraform' | 'opentofu',
//     address:       'https://consul.example.com:8500',
//     path:          'terraform/prod/state',           // KV key OR prefix (see recurse)
//     recurse:       false,                            // true => treat `path` as a prefix
//     consulToken:   '…',                              // encrypted at rest
//     scheme:        'https',                          // optional override
//     datacenter:    'dc1',                            // optional
//     caCert:        '-----BEGIN CERTIFICATE-----…',   // optional self-signed PEM
//   }
//
// Consul stores TF state as a raw JSON blob in a single KV entry; if you
// scope multiple workspaces under one prefix, set recurse:true.

import { assertSafeUrl } from '../../../utils/url-guard.js'

// Local-dev allowance: when APPCLOUD_CONSUL_ALLOW_LOCAL=true, the
// SSRF guard skips the private-IP / loopback denylist so a developer
// can point at a docker-compose Consul on 127.0.0.1. NEVER set this
// in production — an admin would be able to fetch the metadata
// service and any internal-network host.
const allowLocal = () => /^(true|1|yes)$/i.test(process.env.APPCLOUD_CONSUL_ALLOW_LOCAL || '')

function buildBaseUrl(cfg) {
  if (!cfg.address) throw new Error('consul: address is required')
  // SSRF guard: cfg.address comes from operator config, which means
  // an admin (or compromised admin key) can otherwise drive an HTTP
  // call to an arbitrary host. Validate once here; the parsed URL
  // becomes the base for every subsequent request.
  const parsed = assertSafeUrl(cfg.address.replace(/\/+$/, ''), {
    allowedSchemes:    ['https:', 'http:'],
    allowPrivateHosts: allowLocal(),
  })
  return parsed.toString().replace(/\/+$/, '')
}

function buildHeaders(cfg) {
  const h = { Accept: 'application/json' }
  if (cfg.consulToken) h['X-Consul-Token'] = cfg.consulToken
  return h
}

function buildSearchParams(cfg, { recurse = false } = {}) {
  const p = new URLSearchParams()
  if (cfg.datacenter) p.set('dc', cfg.datacenter)
  if (recurse)        p.set('recurse', 'true')
  return p.toString() ? `?${p}` : ''
}

function deriveWorkspaceId(path) {
  const segments = (path || '').split('/').filter(Boolean)
  return segments[segments.length - 1] || 'default'
}

export async function* listStateFiles(cfg) {
  const recurse = !!cfg.recurse
  if (!recurse) {
    yield { key: cfg.path, workspaceId: deriveWorkspaceId(cfg.path) }
    return
  }

  const url = `${buildBaseUrl(cfg)}/v1/kv/${encodeURIPath(cfg.path)}${buildSearchParams(cfg, { recurse: true })}`
  const resp = await fetch(url, { headers: buildHeaders(cfg) })
  if (!resp.ok) throw new Error(`consul list ${resp.status}: ${await resp.text()}`)
  const entries = await resp.json()
  for (const entry of entries || []) {
    if (!entry?.Key) continue
    yield { key: entry.Key, workspaceId: deriveWorkspaceId(entry.Key) }
  }
}

export async function fetchStateFile(cfg, key) {
  const url = `${buildBaseUrl(cfg)}/v1/kv/${encodeURIPath(key)}${buildSearchParams(cfg)}`
  const resp = await fetch(url, { headers: buildHeaders(cfg) })
  if (!resp.ok) throw new Error(`consul get ${resp.status}: ${await resp.text()}`)
  const arr = await resp.json()
  if (!Array.isArray(arr) || !arr.length) throw new Error(`consul: key not found: ${key}`)
  // Consul returns the value base64-encoded; a missing Value is a directory marker.
  const rawB64 = arr[0].Value
  if (!rawB64) throw new Error(`consul: empty value at ${key}`)
  const decoded = Buffer.from(rawB64, 'base64').toString('utf8')
  return JSON.parse(decoded)
}

export async function healthCheck(cfg) {
  try {
    const url = `${buildBaseUrl(cfg)}/v1/status/leader${buildSearchParams(cfg)}`
    const resp = await fetch(url, { headers: buildHeaders(cfg) })
    if (!resp.ok) return { ok: false, detail: `${resp.status} ${await resp.text()}` }
    const leader = (await resp.json()) || ''
    return { ok: !!leader, detail: leader ? `leader: ${leader}` : 'no Consul leader' }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

// Encode each path segment but keep the '/' separators so Consul sees the
// full hierarchical key.
function encodeURIPath(p) {
  return (p || '').split('/').map(encodeURIComponent).join('/')
}
