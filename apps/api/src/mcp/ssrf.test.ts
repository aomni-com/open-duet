import { describe, expect, test } from 'bun:test'

import { BlockedUpstreamUrlError, guardedFetch, requirePublicHttpsUrl } from './ssrf'

/**
 * A resolver that answers from a table instead of DNS, so these tests exercise
 * the address rule rather than the network. Real hostnames never appear.
 */
function resolver(table: Record<string, string[]>) {
  return async (hostname: string) => {
    const addresses = table[hostname]
    if (addresses === undefined) throw new Error(`unmapped host in test: ${hostname}`)
    return addresses
  }
}

async function blockedReason(url: string, resolve = resolver({})): Promise<string> {
  return await reasonFor(async () => {
    await requirePublicHttpsUrl(url, resolve)
  })
}

async function reasonFor(act: () => Promise<unknown>): Promise<string> {
  try {
    await act()
  } catch (error) {
    if (error instanceof BlockedUpstreamUrlError) return error.reason
    throw error
  }
  return 'allowed'
}

describe('upstream URL guard', () => {
  test('admits only https, and only to a public address', async () => {
    const resolve = resolver({ 'mcp.example.test': ['203.0.113.10'] })
    expect((await requirePublicHttpsUrl('https://mcp.example.test/mcp', resolve)).host).toBe(
      'mcp.example.test',
    )

    expect(await blockedReason('http://mcp.example.test/mcp', resolve)).toBe('not_https')
    expect(await blockedReason('file:///etc/passwd')).toBe('not_https')
    expect(await blockedReason('not a url')).toBe('invalid_url')
  })

  test('rejects the addresses a control-plane fetch could otherwise reach', async () => {
    for (const host of [
      '127.0.0.1',
      '[::1]',
      'localhost',
      // The cloud metadata service — the single most valuable SSRF target for
      // a control plane, and reachable by IP literal with no DNS at all.
      '169.254.169.254',
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '[fd00::1]',
      '[fe80::1]',
      // IPv4-mapped IPv6 smuggles a loopback address past a naive v6 check.
      '[::ffff:127.0.0.1]',
    ]) {
      expect(
        await blockedReason(`https://${host}/mcp`, resolver({ localhost: ['127.0.0.1'] })),
        host,
      ).toBe('private_address')
    }

    // A public hostname that resolves inward is the same attack with a step of
    // indirection, so the verdict is the resolved address, not the name.
    expect(
      await blockedReason(
        'https://mcp.example.test/mcp',
        resolver({ 'mcp.example.test': ['169.254.169.254'] }),
      ),
    ).toBe('private_address')

    // Every answer must be public: one private address in the set is enough
    // for the connect to land there.
    expect(
      await blockedReason(
        'https://mcp.example.test/mcp',
        resolver({ 'mcp.example.test': ['203.0.113.10', '10.0.0.5'] }),
      ),
    ).toBe('private_address')

    expect(
      await blockedReason('https://mcp.example.test/mcp', resolver({ 'mcp.example.test': [] })),
    ).toBe('unresolvable')
  })
})

describe('guarded fetch', () => {
  const resolve = resolver({
    'mcp.example.test': ['203.0.113.10'],
    'evil.example.test': ['203.0.113.11'],
  })

  test('re-follows a same-origin redirect and re-checks the hop it lands on', async () => {
    const requested: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      return url.endsWith('/mcp')
        ? new Response(null, { status: 307, headers: { location: '/mcp/v2' } })
        : new Response('ok', { status: 200 })
    }

    const response = await guardedFetch(fetchImpl, resolve)('https://mcp.example.test/mcp')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(requested).toEqual(['https://mcp.example.test/mcp', 'https://mcp.example.test/mcp/v2'])
  })

  test('refuses a redirect that leaves the origin, without following it', async () => {
    const requested: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
      })
    }

    expect(
      await reasonFor(() => guardedFetch(fetchImpl, resolve)('https://mcp.example.test/mcp')),
    ).toBe('cross_origin_redirect')
    expect(requested).toEqual(['https://mcp.example.test/mcp'])
  })

  test('stops a redirect loop instead of chasing it', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: '/mcp' } })

    expect(
      await reasonFor(() => guardedFetch(fetchImpl, resolve)('https://mcp.example.test/mcp')),
    ).toBe('too_many_redirects')
  })

  test('passes the caller’s method, headers and body through to the upstream', async () => {
    let seen: Request | undefined
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init)
      return new Response('ok')
    }

    await guardedFetch(fetchImpl, resolve)('https://mcp.example.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pasted' },
      body: '{"jsonrpc":"2.0"}',
    })

    expect(seen?.method).toBe('POST')
    expect(seen?.headers.get('authorization')).toBe('Bearer pasted')
    expect(await seen?.text()).toBe('{"jsonrpc":"2.0"}')
  })
})
