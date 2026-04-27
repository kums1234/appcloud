import { describe, test, expect } from '@jest/globals'
import { assertSafeUrl, SsrfError } from '../url-guard.js'

describe('assertSafeUrl', () => {
  test('accepts a normal HTTPS public URL', () => {
    const u = assertSafeUrl('https://app.example.com/path?q=1')
    expect(u.hostname).toBe('app.example.com')
    expect(u.protocol).toBe('https:')
  })

  test('rejects malformed URLs with parse-error reason', () => {
    expect(() => assertSafeUrl('not a url')).toThrow(SsrfError)
    try { assertSafeUrl('') } catch (e) { expect(e.reason).toBe('parse-error') }
  })

  test('rejects non-http/https schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://bad.example.com/', 'javascript:alert(1)', 'ftp://files.example.com/']) {
      try {
        assertSafeUrl(url)
        throw new Error(`should have rejected ${url}`)
      } catch (e) {
        expect(e).toBeInstanceOf(SsrfError)
        expect(e.reason).toBe('scheme-denied')
      }
    }
  })

  test('rejects loopback IPv4', () => {
    try { assertSafeUrl('http://127.0.0.1/') } catch (e) { expect(e.reason).toBe('private-ip') }
    try { assertSafeUrl('http://127.255.255.255/') } catch (e) { expect(e.reason).toBe('private-ip') }
  })

  test('rejects RFC1918 ranges', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
      try { assertSafeUrl(`http://${ip}/`) } catch (e) { expect(e.reason).toBe('private-ip') }
    }
  })

  test('rejects link-local + the AWS / Azure metadata IP', () => {
    try { assertSafeUrl('http://169.254.169.254/latest/meta-data/') }
    catch (e) { expect(e.reason).toBe('private-ip') }
  })

  test('rejects 0.0.0.0/8 + multicast / reserved', () => {
    try { assertSafeUrl('http://0.0.0.0/') }   catch (e) { expect(e.reason).toBe('private-ip') }
    try { assertSafeUrl('http://239.0.0.1/') } catch (e) { expect(e.reason).toBe('private-ip') }
  })

  test('rejects IPv6 loopback / link-local / ULA / multicast', () => {
    for (const url of [
      'http://[::1]/',                        // loopback
      'http://[::]/',                         // unspecified
      'http://[fe80::1]/',                    // link-local
      'http://[fc00::1]/',                    // ULA
      'http://[fd12:3456:789a::1]/',          // ULA
      'http://[ff02::1]/',                    // multicast
    ]) {
      try { assertSafeUrl(url) } catch (e) { expect(e.reason).toBe('private-ip') }
    }
  })

  test('rejects "localhost" and *.local / *.internal hostnames', () => {
    for (const url of [
      'http://localhost/',
      'http://localhost.localdomain/',
      'http://app.local/',
      'http://something.internal/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      try { assertSafeUrl(url) } catch (e) {
        expect(['host-denied', 'private-ip']).toContain(e.reason)
      }
    }
  })

  test('respects allowedSchemes override', () => {
    expect(() => assertSafeUrl('http://example.com/', { allowedSchemes: ['https:'] }))
      .toThrow(/only.*https:.*allowed/)
  })

  test('respects allowedHostSuffixes — accepts matching, rejects others', () => {
    expect(() =>
      assertSafeUrl('https://my-tenant.service-now.com/', { allowedHostSuffixes: ['.service-now.com'] }),
    ).not.toThrow()
    try {
      assertSafeUrl('https://attacker.example.com/', { allowedHostSuffixes: ['.service-now.com'] })
    } catch (e) {
      expect(e.reason).toBe('host-not-in-allowlist')
    }
  })

  test('allowPrivateHosts: true bypasses the denylist (test/local-dev escape hatch)', () => {
    const u = assertSafeUrl('http://127.0.0.1:9000/', { allowPrivateHosts: true })
    expect(u.hostname).toBe('127.0.0.1')
  })

  test('SsrfError carries the url + reason for audit metadata', () => {
    try {
      assertSafeUrl('http://10.0.0.5/')
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfError)
      expect(e.url).toBe('http://10.0.0.5/')
      expect(e.reason).toBe('private-ip')
      expect(e.message).toMatch(/private/)
    }
  })
})
