import { describe, expect, spyOn, test } from 'bun:test'

import type { BrowserSessionCredential } from '@repo/contract'

import { BrowserSessionAuthenticationError, createDuetProxy } from './duet-proxy'

const SESSION: BrowserSessionCredential = {
  token: 'duet_sk_browser_session_fixture',
  prefix: 'duet_sk_browser_',
  expiresAt: 10_000_000,
}

describe('Duet browser proxy', () => {
  test('decodes the deployed catch-all request path exactly once', async () => {
    let upstreamUrl = ''
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamUrl = request.url
        return new Response(null, { status: 204 })
      },
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/a%252Fb'),
    )

    expect(response.status).toBe(204)
    expect(upstreamUrl).toBe('https://ctl.example/v1/ws/demo/files/a%252Fb')
  })

  test('re-encodes decoded literal-percent file segments for the REST boundary', async () => {
    const upstreamUrls: string[] = []
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamUrls.push(request.url)
        return new Response(null, { status: 204 })
      },
    })

    await proxy.proxy(new Request('https://web.example/api/duet/ws/demo/files/100%25.pdf'), [
      'ws',
      'demo',
      'files',
      '100%.pdf',
    ])
    await proxy.proxy(new Request('https://web.example/api/duet/ws/demo/files/a%252Fb'), [
      'ws',
      'demo',
      'files',
      'a%2Fb',
    ])

    expect(upstreamUrls).toEqual([
      'https://ctl.example/v1/ws/demo/files/100%25.pdf',
      'https://ctl.example/v1/ws/demo/files/a%252Fb',
    ])
  })

  test('preserves upstream cache-control for a workspace file GET', async () => {
    let upstreamRequest: Request | undefined
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamRequest = request
        return new Response('icon bytes', {
          headers: { 'cache-control': 'private, max-age=31536000, immutable' },
        })
      },
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/apps/demo/icon.png?v=123', {
        headers: { 'sec-fetch-dest': 'image' },
      }),
      ['ws', 'demo', 'files', 'apps', 'demo', 'icon.png'],
    )

    expect(upstreamRequest?.headers.get('sec-fetch-dest')).toBe('image')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  test('preserves upstream cache-control for a workspace file HEAD', async () => {
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () =>
        new Response(null, {
          headers: { 'cache-control': 'private, max-age=31536000, immutable' },
        }),
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/icon.png?v=123', {
        method: 'HEAD',
      }),
      ['ws', 'demo', 'files', 'icon.png'],
    )

    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  test('overwrites upstream cache-control on a non-file API GET', async () => {
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () =>
        Response.json([], { headers: { 'cache-control': 'public, max-age=3600' } }),
    })

    const response = await proxy.proxy(new Request('https://web.example/api/duet/ws/demo/apps'), [
      'ws',
      'demo',
      'apps',
    ])

    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  test('stamps no-store on file responses without both a safe method and upstream directive', async () => {
    let cacheControl: string | undefined
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () =>
        new Response(null, {
          status: 204,
          headers: cacheControl === undefined ? undefined : { 'cache-control': cacheControl },
        }),
    })

    const withoutDirective = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/icon.png'),
      ['ws', 'demo', 'files', 'icon.png'],
    )
    expect(withoutDirective.headers.get('cache-control')).toBe('private, no-store')

    cacheControl = 'private, max-age=31536000, immutable'
    const unsafe = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/icon.png', {
        method: 'PUT',
        headers: { origin: 'https://web.example' },
      }),
      ['ws', 'demo', 'files', 'icon.png'],
    )
    expect(unsafe.headers.get('cache-control')).toBe('private, no-store')
  })

  test('preserves JSON method, query, body, status, and content headers while overwriting auth', async () => {
    let upstreamRequest: Request | undefined
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamRequest = request
        return Response.json(
          { accepted: true },
          {
            status: 202,
            headers: {
              'cache-control': 'public, max-age=3600',
              'cdn-cache-control': 'public, max-age=3600',
              'x-upstream': 'yes',
            },
          },
        )
      },
    })
    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/apps?cursor=next', {
        method: 'POST',
        headers: {
          authorization: 'Bearer caller-controlled',
          cookie: 'tracking=secret',
          origin: 'https://web.example',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'demo' }),
      }),
      ['ws', 'demo', 'apps'],
    )

    expect(upstreamRequest?.url).toBe('https://ctl.example/v1/ws/demo/apps?cursor=next')
    expect(upstreamRequest?.method).toBe('POST')
    expect(upstreamRequest?.headers.get('authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(upstreamRequest?.headers.get('cookie')).toBeNull()
    expect(await upstreamRequest?.json()).toEqual({ name: 'demo' })
    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('cdn-cache-control')).toBeNull()
    expect(response.headers.get('x-upstream')).toBe('yes')
    expect(await response.json()).toEqual({ accepted: true })
  })

  test('strips compression metadata from a supplied decoded upstream body', async () => {
    let upstreamRequest: Request | undefined
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamRequest = request
        return new Response(JSON.stringify({ decoded: true }), {
          headers: {
            'content-encoding': 'br',
            'content-length': '7',
            'content-type': 'application/json',
          },
        })
      },
    })

    const response = await proxy.proxy(new Request('https://web.example/api/duet/user/billing'), [
      'user',
      'billing',
    ])
    expect(upstreamRequest?.headers.get('accept-encoding')).toBe('identity')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.json()).toEqual({ decoded: true })
  })

  test('preserves representation metadata when a HEAD response has no body to decode', async () => {
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () =>
        new Response(null, {
          headers: { 'content-encoding': 'br', 'content-length': '42' },
        }),
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/report', { method: 'HEAD' }),
      ['ws', 'demo', 'files', 'report'],
    )
    expect(response.headers.get('content-encoding')).toBe('br')
    expect(response.headers.get('content-length')).toBe('42')
    expect(response.body).toBeNull()
  })

  test('requires same-origin evidence for unsafe requests', async () => {
    const upstreamRequests: Request[] = []
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamRequests.push(request)
        return new Response(null, { status: 204 })
      },
    })

    const rejected = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/apps', {
        method: 'DELETE',
        headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
      }),
      ['ws', 'demo', 'apps'],
    )
    expect(rejected.status).toBe(403)
    expect(upstreamRequests).toHaveLength(0)

    const missingOrigin = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/apps', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      ['ws', 'demo', 'apps'],
    )
    expect(missingOrigin.status).toBe(403)

    const crossSiteMetadata = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/apps', {
        method: 'PATCH',
        headers: { origin: 'https://web.example', 'sec-fetch-site': 'cross-site' },
      }),
      ['ws', 'demo', 'apps'],
    )
    expect(crossSiteMetadata.status).toBe(403)
    expect(upstreamRequests).toHaveLength(0)
  })

  test('strips caller credentials and hop-by-hop headers in both directions', async () => {
    const upstreamRequests: Request[] = []
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        upstreamRequests.push(request)
        return new Response(null, {
          status: 204,
          headers: {
            connection: 'x-upstream-hop',
            'set-cookie': 'upstream=private',
            'x-upstream-hop': 'private',
          },
        })
      },
    })

    const accepted = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/apps', {
        headers: {
          connection: 'keep-alive, x-remove-me',
          authorization: 'Bearer caller-controlled',
          cookie: 'analytics=private',
          'keep-alive': 'timeout=5',
          'x-remove-me': 'private',
          'x-api-key': 'caller-controlled',
          forwarded: 'for=203.0.113.1',
          'x-forwarded-for': '203.0.113.1',
          'x-forwarded-host': 'attacker.example',
          'x-real-ip': '203.0.113.1',
          'cf-connecting-ip': '203.0.113.1',
          'last-event-id': '41',
        },
      }),
      ['ws', 'demo', 'apps'],
    )
    expect(accepted.status).toBe(204)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.headers.get('connection')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('keep-alive')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('x-remove-me')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('x-api-key')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('forwarded')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('x-forwarded-for')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('x-forwarded-host')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('x-real-ip')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('cf-connecting-ip')).toBeNull()
    expect(upstreamRequests[0]?.headers.get('authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(upstreamRequests[0]?.headers.get('last-event-id')).toBe('41')
    expect(accepted.headers.get('connection')).toBeNull()
    expect(accepted.headers.get('set-cookie')).toInclude('duet_session=')
    expect(accepted.headers.get('set-cookie')).not.toInclude('upstream=private')
    expect(accepted.headers.get('x-upstream-hop')).toBeNull()
  })

  test('installs the golden-workspace impersonation credential at the web boundary', async () => {
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () =>
        Response.json({
          token: 'duet_sk_golden_owner_fixture',
          prefix: 'duet_sk_golden_',
          expiresAt: 4_600_000,
          userId: 'user_official',
          workspaceSlug: 'official-agents-hub',
          created: false,
        }),
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/internal-admin/official-hub/access', {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      }),
      ['internal-admin', 'official-hub', 'access'],
    )

    const cookieValue = response.headers.get('set-cookie')?.match(/^duet_session=([^;]+)/)?.[1]
    expect(cookieValue).toBeDefined()
    expect(JSON.parse(Buffer.from(cookieValue!, 'base64url').toString('utf8'))).toEqual({
      token: 'duet_sk_golden_owner_fixture',
      prefix: 'duet_sk_golden_',
      expiresAt: 4_600_000,
    })
  })

  test('clears a parked share token only after successful accept or decline', async () => {
    const statuses = [200, 400, 200]
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () => new Response('{}', { status: statuses.shift() }),
    })
    const request = (action: 'accept' | 'decline') =>
      new Request(`https://web.example/api/duet/share-requests/share_1/${action}`, {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      })

    const accepted = await proxy.proxy(request('accept'), ['share-requests', 'share_1', 'accept'])
    expect(accepted.headers.getSetCookie()).toContain(
      'duet_pending_share=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    )
    const rejected = await proxy.proxy(request('accept'), ['share-requests', 'share_1', 'accept'])
    expect(rejected.headers.getSetCookie()).not.toContain(
      'duet_pending_share=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    )
    const declined = await proxy.proxy(request('decline'), ['share-requests', 'share_1', 'decline'])
    expect(declined.headers.getSetCookie()).toContain(
      'duet_pending_share=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    )
  })

  test('preserves redirects without replaying the browser credential', async () => {
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        expect(request.redirect).toBe('manual')
        return new Response(null, {
          status: 307,
          headers: { location: 'https://downloads.example/fixture' },
        })
      },
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/download'),
      ['ws', 'demo', 'files', 'download'],
    )
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://downloads.example/fixture')
  })

  test('rejects dot-segment paths instead of letting URL normalization escape /v1', async () => {
    let fetched = false
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () => {
        fetched = true
        return new Response(null)
      },
    })

    const response = await proxy.proxy(new Request('https://web.example/api/duet/%2e%2e/private'), [
      '..',
      'private',
    ])
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_proxy_path' })
    expect(fetched).toBeFalse()
  })

  test('preserves binary range bytes, status, ETag, and content-range', async () => {
    const bytes = Uint8Array.from([0, 127, 128, 255])
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        expect(request.headers.get('range')).toBe('bytes=2-5')
        return new Response(bytes, {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-range': 'bytes 2-5/8',
            'content-type': 'application/octet-stream',
            etag: '"fixture-etag"',
          },
        })
      },
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/blob', {
        headers: { range: 'bytes=2-5' },
      }),
      ['ws', 'demo', 'files', 'blob'],
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/8')
    expect(response.headers.get('etag')).toBe('"fixture-etag"')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  test('preserves upload bytes and content headers without reshaping them', async () => {
    const upload = Uint8Array.from([255, 0, 42, 17, 128])
    let received = new Uint8Array()
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        expect(request.headers.get('content-type')).toBe('application/x-duet-fixture')
        received = new Uint8Array(await request.arrayBuffer())
        return new Response(null, { status: 201, headers: { location: '/v1/upload/fixture' } })
      },
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/files/upload', {
        method: 'PUT',
        headers: {
          origin: 'https://web.example',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/x-duet-fixture',
        },
        body: upload,
      }),
      ['ws', 'demo', 'files', 'upload'],
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe('/v1/upload/fixture')
    expect(received).toEqual(upload)
  })

  test('delivers the first SSE chunk before close and preserves reconnect cursor', async () => {
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let closed = false
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async request => {
        expect(request.headers.get('last-event-id')).toBe('9')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController
              streamController.enqueue(encoder.encode('id: 10\ndata: first\n\n'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/agent/sessions/one/events', {
        headers: { 'last-event-id': '9' },
      }),
      ['ws', 'demo', 'agent', 'sessions', 'one', 'events'],
    )
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('id: 10\ndata: first\n\n')
    expect(closed).toBeFalse()

    controller!.enqueue(encoder.encode('id: 11\ndata: second\n\n'))
    controller!.close()
    closed = true
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('id: 11\ndata: second\n\n')
    expect((await reader.read()).done).toBeTrue()
  })

  test('propagates browser cancellation to the upstream request', async () => {
    const abort = new AbortController()
    let upstreamSignal: AbortSignal | undefined
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: request => {
        upstreamSignal = request.signal
        return new Promise((_resolve, reject) => {
          if (request.signal.aborted) {
            reject(new DOMException('cancelled', 'AbortError'))
            return
          }
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          )
        })
      },
    })

    const pending = proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/slow', { signal: abort.signal }),
      ['ws', 'demo', 'slow'],
    )
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(upstreamSignal?.aborted).toBeTrue()
  })

  test('passes upstream error bodies through and maps only transport failures', async () => {
    let failTransport = false
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async () => {},
      },
      fetch: async () => {
        if (failTransport) throw new Error('socket fixture detail')
        return new Response('upstream conflict', {
          status: 409,
          headers: { 'content-type': 'text/plain', 'x-error-code': 'conflict' },
        })
      },
    })

    const upstreamError = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/conflict'),
      ['ws', 'demo', 'conflict'],
    )
    expect(upstreamError.status).toBe(409)
    expect(upstreamError.headers.get('x-error-code')).toBe('conflict')
    expect(await upstreamError.text()).toBe('upstream conflict')

    failTransport = true
    const transportError = await proxy.proxy(
      new Request('https://web.example/api/duet/ws/demo/unavailable'),
      ['ws', 'demo', 'unavailable'],
    )
    expect(transportError.status).toBe(502)
    expect(await transportError.json()).toEqual({ error: 'upstream_unavailable' })
  })

  test('exchanges and revokes through HttpOnly cookie responses without returning the key', async () => {
    const revoked: string[] = []
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => SESSION,
        rotate: async () => SESSION,
        revoke: async token => {
          revoked.push(token)
        },
      },
    })

    const exchange = await proxy.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { origin: 'https://web.example', 'sec-fetch-site': 'same-origin' },
      }),
    )
    expect(exchange.status).toBe(204)
    expect(await exchange.text()).toBe('')
    expect(exchange.headers.get('set-cookie')).toInclude('duet_session=')
    expect(exchange.headers.get('set-cookie')).toInclude('HttpOnly')
    expect(exchange.headers.get('set-cookie')).toInclude('Secure')
    expect(exchange.headers.get('set-cookie')).toInclude('SameSite=Lax')
    expect(exchange.headers.get('set-cookie')).not.toInclude(SESSION.token)

    const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!
    const logout = await proxy.logout(
      new Request('https://web.example/api/duet/session', {
        method: 'DELETE',
        headers: {
          cookie,
          origin: 'https://web.example',
          'sec-fetch-site': 'same-origin',
        },
      }),
    )
    expect(logout.status).toBe(204)
    expect(revoked).toEqual([SESSION.token])
    expect(logout.headers.get('set-cookie')).toInclude('Max-Age=0')
  })

  test('distinguishes missing auth and falls back to a valid cookie on transient rotation failure', async () => {
    const unauthenticated = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      browserSessions: {
        mint: async () => {
          throw new BrowserSessionAuthenticationError('identity missing')
        },
        rotate: async () => {
          throw new BrowserSessionAuthenticationError('identity missing')
        },
        revoke: async () => {},
      },
    })
    const unauthorized = await unauthenticated.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      }),
    )
    expect(unauthorized.status).toBe(401)

    const transient = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => ({ ...SESSION, expiresAt: 1_200_000 }),
        rotate: async () => {
          throw new Error('temporary Convex outage')
        },
        revoke: async () => {
          throw new Error('temporary Convex outage')
        },
      },
      fetch: async request => {
        expect(request.headers.get('authorization')).toBe(`Bearer ${SESSION.token}`)
        return Response.json({ usedCurrentSession: true })
      },
    })
    const exchange = await transient.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      }),
    )
    const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!
    const fallback = await transient.proxy(
      new Request('https://web.example/api/duet/ws/demo/apps', { headers: { cookie } }),
      ['ws', 'demo', 'apps'],
    )
    expect(fallback.status).toBe(200)
    expect(await fallback.json()).toEqual({ usedCurrentSession: true })
    expect(fallback.headers.get('set-cookie')).toBeNull()

    const unavailable = await transient.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { cookie, origin: 'https://web.example' },
      }),
    )
    expect(unavailable.status).toBe(502)
    expect(await unavailable.json()).toEqual({ error: 'session_exchange_failed' })
    expect(unavailable.headers.get('set-cookie')).toBeNull()

    const failedLogout = await transient.logout(
      new Request('https://web.example/api/duet/session', {
        method: 'DELETE',
        headers: { cookie, origin: 'https://web.example' },
      }),
    )
    expect(failedLogout.status).toBe(502)
    expect(failedLogout.headers.get('set-cookie')).toInclude('Max-Age=0')
  })

  test('rotates a near-expiry cookie before proxying and never exposes the raw key', async () => {
    const current: BrowserSessionCredential = {
      token: 'duet_sk_current_browser_session',
      prefix: 'duet_sk_current_',
      expiresAt: 1_200_000,
    }
    const rotated: BrowserSessionCredential = {
      token: 'duet_sk_rotated_browser_session',
      prefix: 'duet_sk_rotated_',
      expiresAt: 2_000_000,
    }
    const rotations: string[] = []
    const upstream = { authorization: null as string | null }
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => current,
        rotate: async previousToken => {
          rotations.push(previousToken)
          return rotated
        },
        revoke: async () => {},
      },
      fetch: async request => {
        upstream.authorization = request.headers.get('authorization')
        return Response.json({ ok: true })
      },
    })
    const exchange = await proxy.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      }),
    )
    const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/workbench/json', { headers: { cookie } }),
      ['workbench', 'json'],
    )

    expect(rotations).toEqual([current.token])
    expect(upstream.authorization).toBe(`Bearer ${rotated.token}`)
    expect(response.headers.get('set-cookie')).toInclude('duet_session=')
    expect(response.headers.get('set-cookie')).not.toInclude(rotated.token)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('keeps the current cookie when a sibling request already rotated it', async () => {
    // The backend collapses a rotation burst to one winner; the losers get
    // null and must proxy with the still-valid current token, leaving the
    // browser's cookie to the winner's response.
    const current: BrowserSessionCredential = {
      token: 'duet_sk_current_browser_session',
      prefix: 'duet_sk_current_',
      expiresAt: 1_200_000,
    }
    const rotations: string[] = []
    const upstream = { authorization: null as string | null }
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      now: () => 1_000_000,
      browserSessions: {
        mint: async () => current,
        rotate: async previousToken => {
          rotations.push(previousToken)
          return null
        },
        revoke: async () => {},
      },
      fetch: async request => {
        upstream.authorization = request.headers.get('authorization')
        return Response.json({ ok: true })
      },
    })
    const exchange = await proxy.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      }),
    )
    const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!

    const response = await proxy.proxy(
      new Request('https://web.example/api/duet/workbench/json', { headers: { cookie } }),
      ['workbench', 'json'],
    )
    expect(rotations).toEqual([current.token])
    expect(upstream.authorization).toBe(`Bearer ${current.token}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()

    const handedOff = await proxy.exchange(
      new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { cookie, origin: 'https://web.example' },
      }),
    )
    expect(handedOff.status).toBe(204)
    expect(handedOff.headers.get('set-cookie')).toBeNull()
  })
})

test('session exchange reports the underlying failure without returning it to the browser', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('Convex session mint failed [Request ID: backend-request-123]', {
    cause: new Error('database unavailable'),
  })
  try {
    const proxy = createDuetProxy({
      apiOrigin: 'https://ctl.example',
      browserSessions: {
        mint: async () => {
          throw failure
        },
        rotate: async () => {
          throw failure
        },
        revoke: async () => {},
      },
    })
    const response = await proxy.exchange(
      new Request('https://web.example/api/duet/session?code=secret-code', {
        method: 'POST',
        headers: {
          origin: 'https://web.example',
          'x-vercel-id': 'edge-request-123',
          cookie: 'private-cookie',
        },
      }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'session_exchange_failed' })
    const diagnostic = JSON.stringify(logged.mock.calls)
    expect(diagnostic).toContain('session_exchange_failed')
    expect(diagnostic).toContain('backend-request-123')
    expect(diagnostic).toContain('database unavailable')
    expect(diagnostic).toContain('edge-request-123')
    expect(diagnostic).toContain('/api/duet/session')
    expect(diagnostic).not.toContain('secret-code')
    expect(diagnostic).not.toContain('private-cookie')
  } finally {
    logged.mockRestore()
  }
})

test('proxy failures and degraded rotation retain server diagnostics', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('backend unavailable')
  let rotateFails = false
  const proxy = createDuetProxy({
    apiOrigin: 'https://ctl.example',
    now: () => SESSION.expiresAt - 1,
    browserSessions: {
      mint: async () => {
        throw failure
      },
      rotate: async () => {
        if (rotateFails) throw failure
        return SESSION
      },
      revoke: async () => {
        throw failure
      },
    },
    fetch: async () => {
      throw new Error('upstream socket closed')
    },
  })
  const cookie = `duet_session=${Buffer.from(JSON.stringify(SESSION)).toString('base64url')}`
  const request = (path: string, authenticated = true) =>
    new Request(`https://web.example/api/duet/${path}`, {
      method: 'POST',
      headers: { origin: 'https://web.example', ...(authenticated ? { cookie } : {}) },
    })
  try {
    await proxy.logout(request('session'))
    expect(JSON.stringify(logged.mock.calls)).toContain('session_revoke_failed')
    logged.mockClear()
    await proxy.proxy(request('ws/demo/apps', false))
    expect(JSON.stringify(logged.mock.calls)).toContain('session_exchange_failed')
    logged.mockClear()
    rotateFails = true
    const response = await proxy.proxy(request('ws/demo/apps'))
    expect(response.status).toBe(502)
    const diagnostic = JSON.stringify(logged.mock.calls)
    expect(diagnostic).toContain('session_rotation_failed')
    expect(diagnostic).toContain('upstream_unavailable')
    expect(diagnostic).toContain('upstream socket closed')
    expect(diagnostic).not.toContain(SESSION.token)
  } finally {
    logged.mockRestore()
  }
})

test('expected missing identity and cancelled proxy requests do not emit failure logs', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const controller = new AbortController()
  controller.abort()
  const proxy = createDuetProxy({
    apiOrigin: 'https://ctl.example',
    browserSessions: {
      mint: async () => {
        throw new BrowserSessionAuthenticationError('sign in required')
      },
      rotate: async () => SESSION,
      revoke: async () => {},
    },
    fetch: async () => {
      throw controller.signal.reason
    },
  })
  try {
    expect(
      (
        await proxy.exchange(
          new Request('https://web.example/api/duet/session', {
            method: 'POST',
            headers: { origin: 'https://web.example' },
          }),
        )
      ).status,
    ).toBe(401)
    const cookie = `duet_session=${Buffer.from(JSON.stringify(SESSION)).toString('base64url')}`
    await expect(
      proxy.proxy(
        new Request('https://web.example/api/duet/ws/demo/apps', {
          headers: { cookie },
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow()
    expect(logged.mock.calls).toEqual([])
  } finally {
    logged.mockRestore()
  }
})

test('logout clears a stale cookie without reporting expected missing identity', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const proxy = createDuetProxy({
    apiOrigin: 'https://ctl.example',
    browserSessions: {
      mint: async () => SESSION,
      rotate: async () => SESSION,
      revoke: async () => {
        throw new BrowserSessionAuthenticationError('sign in required')
      },
    },
  })
  try {
    const cookie = `duet_session=${Buffer.from(JSON.stringify(SESSION)).toString('base64url')}`
    const response = await proxy.logout(
      new Request('https://web.example/api/duet/session', {
        method: 'DELETE',
        headers: { origin: 'https://web.example', cookie },
      }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'session_revoke_failed' })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(logged.mock.calls).toEqual([])
  } finally {
    logged.mockRestore()
  }
})
