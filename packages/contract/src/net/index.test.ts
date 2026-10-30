import { describe, expect, test } from 'bun:test'

import {
  PRE_AUTH_RATE_LIMIT_ENDPOINTS,
  assertPublicHttpUrl,
  isPreAuthRateLimitEndpoint,
  isPrivateOrReservedIp,
} from './index'

describe('pre-auth rate-limit vocabulary', () => {
  test('names every unauthenticated endpoint exactly once', () => {
    expect(new Set(PRE_AUTH_RATE_LIMIT_ENDPOINTS).size).toBe(PRE_AUTH_RATE_LIMIT_ENDPOINTS.length)
    expect([...PRE_AUTH_RATE_LIMIT_ENDPOINTS]).toEqual([
      'device_code',
      'device_token',
      'feedback',
      'oauth_metadata',
      'oauth_register',
      'oauth_authorize',
      'oauth_token',
      'auth_email_start',
      'auth_email_verify',
    ])
  })

  test('admits the vocabulary and turns away everything else', () => {
    for (const endpoint of PRE_AUTH_RATE_LIMIT_ENDPOINTS) {
      expect(isPreAuthRateLimitEndpoint(endpoint), endpoint).toBe(true)
    }
    for (const rejected of ['', 'auth_email', 'AUTH_EMAIL_START', 'whoami', 'toString']) {
      expect(isPreAuthRateLimitEndpoint(rejected), rejected).toBe(false)
    }
  })
})

describe('network URL contract', () => {
  test('classifies representative private and reserved IPs', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true)
    }
  })

  test('leaves public IPs and non-IP hostnames public', () => {
    for (const ip of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '2001:4860:4860::8888',
      'example.com',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false)
    }
  })

  test('normalizes public http URLs and rejects local hosts', () => {
    const url = assertPublicHttpUrl('https://user:pass@example.com/path')
    expect(url.toString()).toBe('https://example.com/path')

    for (const raw of [
      'file:///tmp/page.html',
      'http://localhost/page',
      'http://app.localhost/page',
      'http://127.0.0.1/page',
      'http://[::1]/page',
    ]) {
      expect(() => assertPublicHttpUrl(raw), raw).toThrow()
    }
  })
})
