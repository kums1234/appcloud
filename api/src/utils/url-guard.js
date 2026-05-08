// utils/url-guard.js
//
// URL validation for outbound HTTP from connectors. Connectors take
// caller-supplied URLs (Consul address, ServiceNow instance domain,
// Terraform Cloud hostname, the TFC pre-signed download link) and call
// fetch() with them; without validation an admin (or compromised
// admin key) can drive an HTTP request to any host the API process can
// reach — internal services, the cloud-provider metadata endpoint,
// loopback. This module is the single gate every connector funnels
// outbound URLs through.
//
// Three layers, applied in order:
//   1. URL parsing — reject anything `new URL()` can't parse, plus any
//      non-http/https scheme (file://, gopher://, javascript:, …).
//   2. Hostname denylist — reject loopback, link-local, RFC1918
//      private ranges, IPv6 link-local / loopback / unique-local,
//      and the AWS / GCP / Azure metadata service IPs.
//   3. Optional caller-supplied allowlist — when a connector knows
//      the legitimate set of hostnames (e.g. ServiceNow instances
//      must end `.service-now.com`), pass it in.
//
// Returns the parsed URL on success; throws SsrfError on rejection.
// The error message is operator-facing — it lands in connector audit
// rows so a misconfigured tenant gets a clear "I refused to fetch
// X because Y" instead of a confusing connection failure.

import { isIPv4, isIPv6 } from 'node:net'

export class SsrfError extends Error {
  constructor(message, { url, reason } = {}) {
    super(message)
    this.name   = 'SsrfError'
    this.url    = url
    this.reason = reason
  }
}

const DEFAULT_ALLOWED_SCHEMES = ['https:', 'http:']

// Hostnames that are never legitimate destinations for connector
// outbound traffic. The list is conservative — even "localhost" is
// blocked, since a connector pointing at localhost in a multi-tenant
// deployment is a data-exfil vector for any process on the same pod.
//
// `*.local` / `*.internal` / `.lan` / `.localdomain` cover the typical
// internal-DNS suffixes operators use for things they don't want
// strangers to reach.
const HOSTNAME_DENY_EXACT = new Set([
  'localhost',
  'localhost.localdomain',
  // AWS / GCP / Azure metadata service IP, in name form (rare but
  // possible on misconfigured DNS).
  'metadata.google.internal',
])
const HOSTNAME_DENY_SUFFIX = [
  '.local',
  '.internal',
  '.lan',
  '.localdomain',
]

function isPrivateIPv4(host) {
  if (!isIPv4(host)) return false
  const [a, b] = host.split('.').map(n => parseInt(n, 10))
  if (a === 10) return true
  if (a === 127) return true                   // loopback
  if (a === 169 && b === 254) return true      // link-local + AWS/Azure metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 0) return true                     // 0.0.0.0/8
  if (a >= 224) return true                    // multicast / reserved
  return false
}

function isPrivateIPv6(host) {
  // Strip surrounding brackets if present.
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (!isIPv6(h)) return false
  const lower = h.toLowerCase()
  if (lower === '::1') return true                              // loopback
  if (lower === '::') return true                               // unspecified
  if (lower.startsWith('fe80:'))         return true            // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true   // ULA fc00::/7
  if (lower.startsWith('::ffff:'))       return true            // IPv4-mapped — re-check in v4 form
  if (lower.startsWith('ff'))            return true            // multicast
  return false
}

function hostnameDenied(hostname) {
  const h = hostname.toLowerCase()
  if (HOSTNAME_DENY_EXACT.has(h)) return true
  for (const suf of HOSTNAME_DENY_SUFFIX) {
    if (h.endsWith(suf)) return true
  }
  return false
}

/**
 * Validate an outbound URL and return the parsed URL. Throws SsrfError
 * with a descriptive `reason` field if rejected.
 *
 * Options:
 *   - allowedSchemes: array of `protocol:` strings. Default ['https:', 'http:'].
 *   - allowedHostSuffixes: when set, the URL's hostname MUST end with
 *     one of these suffixes. Use this for connectors that target a
 *     known SaaS family (e.g. ['.service-now.com'] for ServiceNow,
 *     ['.terraform.io'] for HCP Terraform). Pass null/undefined to
 *     skip the allowlist (only the denylist applies).
 *   - allowPrivateHosts: when true, skip the private-IP / loopback
 *     denylist. ONLY for callers that explicitly opt out — used by
 *     local-dev test fixtures that point at 127.0.0.1.
 */
export function assertSafeUrl(rawUrl, opts = {}) {
  const allowedSchemes      = opts.allowedSchemes      ?? DEFAULT_ALLOWED_SCHEMES
  const allowedHostSuffixes = opts.allowedHostSuffixes ?? null
  const allowPrivateHosts   = opts.allowPrivateHosts   === true

  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SsrfError(`refusing to fetch malformed URL`, { url: rawUrl, reason: 'parse-error' })
  }

  if (!allowedSchemes.includes(url.protocol)) {
    throw new SsrfError(
      `refusing to fetch ${url.protocol}// — only [${allowedSchemes.join(', ')}] allowed`,
      { url: rawUrl, reason: 'scheme-denied' },
    )
  }

  // Strip surrounding brackets that node:url leaves on IPv6 hosts.
  const host = url.hostname

  if (!allowPrivateHosts) {
    if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
      throw new SsrfError(
        `refusing to fetch ${host} — IP is private / loopback / metadata`,
        { url: rawUrl, reason: 'private-ip' },
      )
    }
    if (hostnameDenied(host)) {
      throw new SsrfError(
        `refusing to fetch ${host} — hostname is on the SSRF denylist`,
        { url: rawUrl, reason: 'host-denied' },
      )
    }
  }

  if (allowedHostSuffixes) {
    const ok = allowedHostSuffixes.some(s => host.toLowerCase().endsWith(s.toLowerCase()))
    if (!ok) {
      throw new SsrfError(
        `refusing to fetch ${host} — hostname does not match any of [${allowedHostSuffixes.join(', ')}]`,
        { url: rawUrl, reason: 'host-not-in-allowlist' },
      )
    }
  }

  return url
}
