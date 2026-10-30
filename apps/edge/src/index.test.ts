import { describe, expect, spyOn, test } from 'bun:test'

import {
  DUET_APP_ACCESS_COOKIE,
  DUET_APP_ACCESS_QUERY,
  DUET_APP_SLUG_HEADER,
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  DUET_PUBLISH_FREEZE_HEADER,
  DUET_WORKSPACE_SLUG_HEADER,
  mintAppAccessGrant,
} from '@repo/contract'

import { createEdgeApp } from './index'

const resolved = {
  visibility: 'public',
  workspace: {
    id: 'workspace-id',
    slug: 'acme-drive',
    httpsUrl: 'https://vm.example.exe.xyz',
    vmName: 'vm-example',
  },
  origin: {
    httpsUrl: 'https://vm.example.exe.xyz',
    gatewayAuthToken: 'gateway-token',
    gatewayPathPrefix: '/public/app',
  },
}

const publishResolved = {
  visibility: 'public',
  workspace: {
    id: 'workspace-id',
    slug: 'acme-drive',
    httpsUrl: 'https://vm.example.exe.xyz',
    vmName: 'vm-example',
  },
  origin: {
    httpsUrl: 'https://vm.example.exe.xyz',
    gatewayAuthToken: 'gateway-token',
    gatewayPathPrefix: '/public/publish',
  },
  publish: {
    id: 'publish-id',
    kind: 'file',
    anchorPath: 'reports/q2.md',
    viewer: {
      workspaceName: 'Acme Drive',
      ownerName: 'Ada Lovelace',
      rootName: 'q2.md',
      kind: 'file',
    },
  },
}

const folderPublishResolved = {
  ...publishResolved,
  publish: {
    id: 'publish-folder-id',
    kind: 'folder',
    anchorPath: 'public',
    viewer: {
      workspaceName: 'Acme Drive',
      ownerName: 'Ada Lovelace',
      rootName: 'public',
      kind: 'folder',
    },
  },
}

describe('publish viewer transport (slice 00)', () => {
  test('bare publish page proxies to the viewer origin credential-free', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async (input, init) => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries())
        seen.push({ url: String(input), headers })
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return new Response('<!doctype html><div data-publish-viewer>ok</div>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2/a/b/c', {
        headers: {
          host: 'edge.duet.so',
          cookie: 'duet_session=hostile; other=keep',
          authorization: 'Bearer caller-token',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-publish-viewer')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30')

    const origin = seen.find(call => !call.url.endsWith('/v1/edge/resolve'))
    expect(origin?.url).toBe('https://web.example/publish/acme-drive/q2/a/b/c')
    expect(origin?.headers.cookie).toBeUndefined()
    expect(origin?.headers.authorization).toBeUndefined()
    expect(origin?.headers['x-duet-edge-secret']).toBeUndefined()
  })

  test('/_next assets relay to the viewer origin without resolving or misparsing as publish', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async (input, init) => {
        calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) })
        return new Response('chunk', { headers: { 'content-type': 'application/javascript' } })
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/_next/static/chunks/main.js?v=1', {
        headers: {
          host: 'edge.duet.so',
          cookie: 'duet_session=hostile',
          authorization: 'Bearer caller-token',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('chunk')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(calls.map(call => call.url)).toEqual([
      'https://web.example/_next/static/chunks/main.js?v=1',
    ])
    expect(calls[0]?.headers.cookie).toBeUndefined()
    expect(calls[0]?.headers.authorization).toBeUndefined()
    expect(calls.some(call => call.url.endsWith('/v1/edge/resolve'))).toBe(false)
  })

  test('favicon and manifest on the publish host relay to the viewer origin credential-free', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async (input, init) => {
        calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) })
        return new Response('icon', { headers: { 'content-type': 'image/x-icon' } })
      },
    })

    for (const path of ['/favicon.ico', '/manifest.json']) {
      const response = await app.fetch(
        new Request(`https://edge.duet.so${path}`, {
          headers: { host: 'edge.duet.so', cookie: 'duet_session=hostile' },
        }),
      )
      expect(response.status).toBe(200)
    }
    expect(calls.map(call => call.url)).toEqual([
      'https://web.example/favicon.ico',
      'https://web.example/manifest.json',
    ])
    expect(calls.every(call => call.headers.cookie === undefined)).toBe(true)
    expect(calls.some(call => call.url.endsWith('/v1/edge/resolve'))).toBe(false)
  })

  test('/_next on an app subdomain is not hijacked by the viewer relay', async () => {
    const targets: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async input => {
        targets.push(String(input))
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
        return new Response('app chunk')
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/_next/static/chunks/app.js', {
        headers: { host: 'todo--acme-drive.edge.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    expect(targets.some(url => url.startsWith('https://web.example'))).toBe(false)
    expect(targets).toContain('https://convex.example/v1/edge/resolve')
    expect(targets).toContain('https://vm.example.exe.xyz/public/app/_next/static/chunks/app.js')
  })

  test('?raw and ?list keep reaching the gateway origin unchanged', async () => {
    const targets: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async input => {
        targets.push(String(input))
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return new Response('bytes')
      },
    })

    await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?raw', { headers: { host: 'edge.duet.so' } }),
    )

    expect(targets.some(url => url.startsWith('https://web.example'))).toBe(false)
    expect(targets).toContain('https://vm.example.exe.xyz/public/publish/?raw')
  })

  // The origin streams a zip with no length and a 200 already committed, so a
  // stream that breaks mid-body used to reach the client as a short, well-formed
  // 200 — and the CDN cached that short body for everyone for 30 seconds. The
  // edge reads a zip to its end before answering: a broken stream is a 502
  // nobody caches, and a whole one carries its exact length.
  test('a ?zip whose origin stream breaks is a 502, never a short 200', async () => {
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async input => {
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('PK\u0003\u0004 partial'))
              controller.error(new Error('origin closed mid-archive'))
            },
          }),
          { headers: { 'content-type': 'application/zip', etag: '"zip-1"' } },
        )
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?zip', { headers: { host: 'edge.duet.so' } }),
    )

    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).not.toContain('public')
  })

  test('a whole ?zip carries its exact content-length', async () => {
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async input => {
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return new Response('zip bytes', {
          headers: { 'content-type': 'application/zip', etag: '"zip-1"' },
        })
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?zip', { headers: { host: 'edge.duet.so' } }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String('zip bytes'.length))
    expect(await response.text()).toBe('zip bytes')
    expect(response.headers.get('cache-control')).toContain('public')
  })

  test('?zip reaches the gateway origin, never the viewer, and combining it with raw is a 400', async () => {
    const targets: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async input => {
        targets.push(String(input))
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return new Response('zip bytes')
      },
    })

    await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2/sub?zip', {
        headers: { host: 'edge.duet.so' },
      }),
    )
    expect(targets.some(url => url.startsWith('https://web.example'))).toBe(false)
    expect(targets).toContain('https://vm.example.exe.xyz/public/publish/sub?zip')

    const invalid = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?zip&raw', {
        headers: { host: 'edge.duet.so' },
      }),
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_selector' })
  })
})

describe('publish classifier + credential firewall (slice 01)', () => {
  const viewerApp = (
    onNonResolve: (input: string, init?: RequestInit) => Response,
    calls: Array<{ url: string; headers: Record<string, string> }>,
  ) =>
    createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async (input, init) => {
        const url = String(input)
        calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) })
        if (url.endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return onNonResolve(url, init)
      },
    })

  test('both reserved selectors is a 400 that never touches an origin', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = viewerApp(() => new Response('should not be reached'), calls)

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?raw&list', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_selector' })
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    // Only the resolve happened — neither the viewer origin nor the gateway was hit.
    expect(calls.map(call => call.url)).toEqual(['https://convex.example/v1/edge/resolve'])
  })

  test('an unrelated query param keeps the request on the viewer branch', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = viewerApp(
      () =>
        new Response('<div data-publish-viewer></div>', {
          headers: { 'content-type': 'text/html' },
        }),
      calls,
    )

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?theme=dark', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    const origin = calls.find(call => !call.url.endsWith('/v1/edge/resolve'))
    expect(origin?.url).toBe('https://web.example/publish/acme-drive/q2?theme=dark')
  })

  test('an empty-valued selector still routes to the gateway, not the viewer', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = viewerApp(() => new Response('bytes'), calls)

    await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?raw=', { headers: { host: 'edge.duet.so' } }),
    )

    expect(calls.some(call => call.url.startsWith('https://web.example'))).toBe(false)
    expect(calls.map(call => call.url)).toContain('https://vm.example.exe.xyz/public/publish/?raw=')
  })

  test('a frozen publish forwards its generation and publish id in the owned freeze header', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      viewerOrigin: 'https://web.example',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        if (String(input).endsWith('/v1/edge/resolve')) {
          return Response.json({
            ...publishResolved,
            publish: { ...publishResolved.publish, freeze: { generation: 'gen-1' } },
          })
        }
        return new Response('frozen')
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?raw', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    const gateway = calls.find(call => call.url.includes('/public/publish'))
    expect(JSON.parse(gateway?.headers[DUET_PUBLISH_FREEZE_HEADER] ?? 'null')).toEqual({
      publishId: 'publish-id',
      generation: 'gen-1',
    })
  })

  test('the viewer page forwards the validated descriptor but no gateway bearer', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = viewerApp(
      () =>
        new Response('<div data-publish-viewer></div>', {
          headers: { 'content-type': 'text/html' },
        }),
      calls,
    )

    await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2', {
        headers: {
          host: 'edge.duet.so',
          cookie: 'duet_session=hostile',
          authorization: 'Bearer caller-token',
          'x-duet-publish-anchor-path': 'spoofed',
        },
      }),
    )

    const origin = calls.find(call => !call.url.endsWith('/v1/edge/resolve'))
    expect(origin?.headers.authorization).toBeUndefined()
    expect(origin?.headers.cookie).toBeUndefined()
    // The caller-supplied x-duet-* header is stripped; only the edge's own
    // validated descriptor survives.
    expect(origin?.headers['x-duet-publish-anchor-path']).toBeUndefined()
    expect(JSON.parse(origin?.headers['x-duet-viewer-descriptor'] ?? 'null')).toEqual({
      workspaceName: 'Acme Drive',
      ownerName: 'Ada Lovelace',
      rootName: 'q2.md',
      kind: 'file',
    })
  })

  test('a viewer HTML page never triggers served-path reporting', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const app = viewerApp(
      () =>
        new Response('<div data-publish-viewer></div>', {
          headers: { 'content-type': 'text/html' },
        }),
      calls,
    )

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2/deep/page', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    expect(calls.some(call => call.url.endsWith('/v1/edge/publishes/served'))).toBe(false)
  })
})

describe('publish viewer origin config default', () => {
  test('viewer origin falls back to the per-environment config default when unset', async () => {
    const savedWebOrigin = process.env.DUET_WEB_ORIGIN
    const savedVercelEnv = process.env.VERCEL_ENV
    delete process.env.DUET_WEB_ORIGIN
    try {
      const runViewer = async () => {
        const seen: string[] = []
        const app = createEdgeApp({
          convexSiteUrl: 'https://convex.example',
          edgeSecret: 'edge-secret',
          // no viewerOrigin option and no DUET_WEB_ORIGIN env — the typed
          // config default must carry the render (the missing-provisioning 502).
          fetch: async input => {
            seen.push(String(input))
            if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
            return new Response('<!doctype html><div data-publish-viewer>ok</div>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          },
        })
        const response = await app.fetch(
          new Request('https://edge.duet.so/acme-drive/q2/', { headers: { host: 'edge.duet.so' } }),
        )
        return { response, seen }
      }

      process.env.VERCEL_ENV = 'production'
      const production = await runViewer()
      expect(production.response.status).toBe(200)
      expect(production.seen.some(url => url.startsWith('https://app.duet.so/'))).toBe(true)

      process.env.VERCEL_ENV = 'preview'
      const staging = await runViewer()
      expect(staging.response.status).toBe(200)
      expect(staging.seen.some(url => url.startsWith('https://app-staging.duet.so/'))).toBe(true)
    } finally {
      if (savedWebOrigin === undefined) delete process.env.DUET_WEB_ORIGIN
      else process.env.DUET_WEB_ORIGIN = savedWebOrigin
      if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = savedVercelEnv
    }
  })
})

describe('edge proxy', () => {
  test('app responses cannot cache mutable pages or assets, even with upstream CDN overrides', async () => {
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input =>
        String(input).includes('/v1/edge/resolve')
          ? Response.json(resolved)
          : new Response('current app bytes', {
              headers: {
                'cache-control': 'public, max-age=31536000, immutable',
                'cdn-cache-control': 'public, max-age=31536000',
                'vercel-cdn-cache-control': 'public, max-age=31536000',
                expires: 'Thu, 01 Oct 2037 00:00:00 GMT',
              },
            }),
    })
    for (const path of ['/', '/index.html', '/app.js', '/style.css', '/data.json']) {
      const response = await app.fetch(
        new Request(`https://todo--acme-drive.edge.duet.so${path}`, {
          headers: { host: 'todo--acme-drive.edge.duet.so' },
        }),
      )
      expect(await response.text()).toBe('current app bytes')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('cdn-cache-control')).toBeNull()
      expect(response.headers.get('vercel-cdn-cache-control')).toBeNull()
      expect(response.headers.get('expires')).toBeNull()
    }
  })

  test('exchanges a signed launch grant for a clean host-only app cookie', async () => {
    const grant = await mintAppAccessGrant('edge-secret', {
      appId: 'app-id',
      userId: 'user_123',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      launchExpiresAt: 12_000,
      expiresAt: 12_000,
      nonce: '0123456789abcdef0123456789abcdef',
    })
    const calls: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      now: () => 10_000,
      fetch: async input => {
        calls.push(String(input))
        return Response.json(resolved)
      },
    })
    const url = new URL('https://todo--acme-drive.edge.duet.so/dashboard?tab=1')
    url.searchParams.set(DUET_APP_ACCESS_QUERY, grant)

    const response = await app.fetch(new Request(url.toString(), { headers: { host: url.host } }))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://todo--acme-drive.edge.duet.so/dashboard?tab=1',
    )
    expect(response.headers.get('clear-site-data')).toBe('"cache"')
    expect(response.headers.get('set-cookie')).toContain(`${DUET_APP_ACCESS_COOKIE}=`)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('Secure')
    expect(calls).toEqual(['https://convex.example/v1/edge/resolve'])
  })

  test('rejects a stale launch grant even while its app session remains valid', async () => {
    const grant = await mintAppAccessGrant('edge-secret', {
      appId: 'app-id',
      userId: 'user_123',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      launchExpiresAt: 10_000,
      expiresAt: 20_000,
      nonce: '0123456789abcdef0123456789abcdef',
    })
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      now: () => 10_001,
      fetch: async () => {
        throw new Error('stale launch grants must not reach resolve')
      },
    })
    const url = new URL('https://todo--acme-drive.edge.duet.so/')
    url.searchParams.set(DUET_APP_ACCESS_QUERY, grant)

    const response = await app.fetch(new Request(url.toString(), { headers: { host: url.host } }))

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('authenticates a folder app from its launch cookie without forwarding the grant', async () => {
    const grant = await mintAppAccessGrant('edge-secret', {
      appId: 'app-id',
      userId: 'user_123',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      launchExpiresAt: 12_000,
      expiresAt: 12_000,
      nonce: '0123456789abcdef0123456789abcdef',
    })
    const resolveBodies: unknown[] = []
    const originCookie: { value: string | null } = { value: null }
    const originHost: { value: string | null } = { value: null }
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      now: () => 10_000,
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/edge/resolve')) {
          resolveBodies.push(JSON.parse(String(init?.body)))
          return Response.json({ ...resolved, visibility: 'folder' })
        }
        originCookie.value = new Headers(init?.headers).get('cookie')
        originHost.value = new Headers(init?.headers).get('x-duet-original-host')
        return new Response('private app')
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/dashboard', {
        headers: {
          host: 'todo--acme-drive.edge.duet.so',
          cookie: `${DUET_APP_ACCESS_COOKIE}=${grant}; app_preference=compact`,
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('private app')
    expect(resolveBodies).toEqual([
      {
        kind: 'app',
        host: 'todo--acme-drive.edge.duet.so',
        workspaceSlug: 'acme-drive',
        appSlug: 'todo',
        viewerUserId: 'user_123',
        viewerAppId: 'app-id',
        viewerCredential: 'cookie',
      },
    ])
    expect(originCookie.value).toBe('app_preference=compact')
    expect(originHost.value).toBe('todo--acme-drive.edge.duet.so')
  })

  test('resolves a custom hostname before admission and preserves deep request bytes', async () => {
    const seen: Array<{ url: string; body: string; headers: Headers }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '')
        seen.push({ url: String(input), body, headers: new Headers(init?.headers) })
        if (String(input).endsWith('/v1/edge/resolve')) {
          if (JSON.parse(body).kind === 'app-host')
            return Response.json({
              appId: 'app-id',
              workspaceId: 'workspace-id',
              workspaceSlug: 'acme-drive',
              appSlug: 'todo',
            })
          return Response.json(resolved)
        }
        return new Response('todo-origin-marker')
      },
    })
    const response = await app.fetch(
      new Request('https://aomni.co/deep/items?q=a%2Fb', {
        method: 'POST',
        headers: {
          host: 'aomni.co',
          cookie: 'preference=compact',
          authorization: 'Bearer caller',
          'x-duet-original-host': 'caller.example',
          range: 'bytes=0-99',
        },
        body: 'opaque=request&bytes',
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('todo-origin-marker')
    expect(seen.map(call => call.url)).toEqual([
      'https://convex.example/v1/edge/resolve',
      'https://convex.example/v1/edge/resolve',
      'https://vm.example.exe.xyz/public/app/deep/items?q=a%2Fb',
    ])
    expect(JSON.parse(seen[0]!.body)).toEqual({ kind: 'app-host', hostname: 'aomni.co' })
    expect(JSON.parse(seen[1]!.body)).toEqual({
      kind: 'app',
      host: 'aomni.co',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      customBinding: { hostname: 'aomni.co', appId: 'app-id' },
    })
    expect(seen[2]!.body).toBe('opaque=request&bytes')
    expect(Object.fromEntries(seen[2]!.headers)).toMatchObject({
      authorization: 'Bearer gateway-token',
      cookie: 'preference=compact',
      'x-duet-app-slug': 'todo',
      'x-duet-workspace-slug': 'acme-drive',
      'x-forwarded-host': 'aomni.co',
      'x-duet-original-host': 'aomni.co',
      range: 'bytes=0-99',
    })
  })

  test('rejects unknown custom hosts after identity lookup without reaching an origin', async () => {
    const calls: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        calls.push(String(input))
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })

    const response = await app.fetch(
      new Request('https://unknown.example/path', { headers: { host: 'unknown.example' } }),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(calls).toEqual(['https://convex.example/v1/edge/resolve'])
  })

  test('resolves app hosts with the edge secret and streams origin bodies with robots headers', async () => {
    const seen: Array<{ url: string; body?: string; headers: Record<string, string> }> = []
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '))
        controller.enqueue(new TextEncoder().encode('world'))
        controller.close()
      },
    })
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries())
        seen.push({ url: String(input), headers })
        if (String(input).endsWith('/v1/edge/resolve')) {
          expect(headers['x-duet-edge-secret']).toBe('edge-secret')
          expect(JSON.parse(String(init?.body))).toMatchObject({
            kind: 'app',
            workspaceSlug: 'acme-drive',
            appSlug: 'todo',
          })
          return Response.json(resolved)
        }
        return new Response(bodyStream, {
          headers: {
            'content-type': 'text/plain',
            'content-encoding': 'gzip',
            'content-length': '999',
            'transfer-encoding': 'chunked',
          },
        })
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/live?tab=1', {
        headers: { host: 'todo--acme-drive.edge.duet.so' },
      }),
    )

    expect(await response.text()).toBe('hello world')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(seen[1]).toMatchObject({
      url: 'https://vm.example.exe.xyz/public/app/live?tab=1',
      headers: {
        authorization: 'Bearer gateway-token',
        [DUET_WORKSPACE_SLUG_HEADER]: 'acme-drive',
        [DUET_APP_SLUG_HEADER]: 'todo',
      },
    })
  })

  test('cancels the origin request when the downstream app request is aborted', async () => {
    const downstream = new AbortController()
    let originSignal: AbortSignal | undefined
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
        originSignal = init?.signal ?? undefined
        return new Response('streaming')
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/events', {
        headers: { host: 'todo--acme-drive.edge.duet.so' },
        signal: downstream.signal,
      }),
    )
    expect(await response.text()).toBe('streaming')

    downstream.abort()

    expect(originSignal?.aborted).toBeTrue()
  })

  test.each(['todo--acme-drive.edge.duet.so', 'aomni.co'])(
    'ends an app SSE segment on %s and cancels its origin before the function limit',
    async host => {
      let originCancelled = false
      let originSignal: AbortSignal | undefined
      const app = createEdgeApp({
        convexSiteUrl: 'https://convex.example',
        edgeSecret: 'edge-secret',
        appSseSegmentMs: 10,
        fetch: async (input, init) => {
          if (String(input).endsWith('/v1/edge/resolve')) {
            if (JSON.parse(String(init?.body)).kind === 'app-host')
              return Response.json({
                appId: 'app-id',
                workspaceId: 'workspace-id',
                workspaceSlug: 'acme-drive',
                appSlug: 'todo',
              })
            return Response.json(resolved)
          }
          originSignal = init?.signal ?? undefined
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('id: 1\ndata: ready\n\n'))
              },
              cancel() {
                originCancelled = true
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      })

      const response = await app.fetch(
        new Request(`https://${host}/events`, {
          headers: { host, accept: 'text/event-stream' },
        }),
      )
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('id: 1\ndata: ready\n\n')

      const ended = await Promise.race([
        reader.read(),
        Bun.sleep(100).then(() => ({ done: false as const, value: 'timed out' })),
      ])

      expect(ended).toEqual({ done: true, value: undefined })
      expect(originCancelled).toBeTrue()
      expect(originSignal?.aborted).toBeTrue()
    },
  )

  test('strips frame-blocking headers so an app cannot refuse the in-product viewer', async () => {
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
        return new Response('framed', {
          headers: {
            'content-type': 'text/html',
            'x-frame-options': 'DENY',
            'content-security-policy': "frame-ancestors 'none'; default-src 'self'",
          },
        })
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/', {
        headers: { host: 'todo--acme-drive.edge.duet.so' },
      }),
    )

    expect(await response.text()).toBe('framed')
    // The app runs re-fronted on our own origin inside our frame; its own
    // framing refusals would only break the viewer, never protect the user.
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('content-security-policy')).toBeNull()
  })

  test('forwards streamed mutation bodies with Node fetch duplex enabled', async () => {
    let originInit: RequestInit | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('payload'))
        controller.close()
      },
    })
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
        originInit = init
        return new Response('ok')
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/update', {
        method: 'POST',
        headers: { host: 'todo--acme-drive.edge.duet.so' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    )

    expect(response.status).toBe(200)
    expect(originInit?.body).not.toBeNull()
    expect((originInit as RequestInit & { duplex?: string })?.duplex).toBe('half')
  })

  test('forwards explicit WebSocket Upgrade headers to the origin proxy', async () => {
    let originHeaders: Record<string, string> | null = null
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
        originHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        return new Response('upgrade-forwarded')
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/socket', {
        headers: {
          host: 'todo--acme-drive.edge.duet.so',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'abc',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(originHeaders).toMatchObject({
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'abc',
      authorization: 'Bearer gateway-token',
    })
  })

  test('does not trust client viewer identity headers and preserves resolver 403', async () => {
    const resolveBodies: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (_input, init) => {
        resolveBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ error: 'forbidden' }, { status: 403 })
      },
    })

    const response = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/live', {
        headers: {
          host: 'todo--acme-drive.edge.duet.so',
          'x-duet-viewer-user-id': 'user_123',
        },
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    expect(resolveBodies).toEqual([
      {
        kind: 'app',
        host: 'todo--acme-drive.edge.duet.so',
        workspaceSlug: 'acme-drive',
        appSlug: 'todo',
      },
    ])
  })

  test('serves published file content with etag, short TTL, and Range passthrough', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries())
        seen.push({ url: String(input), headers })
        if (String(input).endsWith('/v1/edge/resolve')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            kind: 'publish',
            workspaceSlug: 'acme-drive',
            publishSlug: 'q2',
          })
          return Response.json(publishResolved)
        }
        return new Response('bc', {
          status: 206,
          headers: {
            etag: '"file-etag"',
            'content-range': 'bytes 1-2/4',
            'accept-ranges': 'bytes',
          },
        })
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?raw', {
        headers: { host: 'edge.duet.so', range: 'bytes=1-2' },
      }),
    )

    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bc')
    expect(response.headers.get('etag')).toBe('"file-etag"')
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4')
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(seen[1]).toMatchObject({
      url: 'https://vm.example.exe.xyz/public/publish/?raw',
      headers: {
        authorization: 'Bearer gateway-token',
        range: 'bytes=1-2',
        [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'reports/q2.md',
        [DUET_PUBLISH_KIND_HEADER]: 'file',
      },
    })
  })

  test('caller-forged actor context and cookies never reach the gateway on public reads', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        if (String(input).endsWith('/v1/edge/resolve')) return Response.json(publishResolved)
        return new Response('x')
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2?raw', {
        headers: {
          host: 'edge.duet.so',
          cookie: 'duet_session=hostile; other=1',
          'x-duet-actor-context': 'web:victim-user',
          'x-duet-forged': 'anything',
        },
      }),
    )

    expect(response.status).toBe(200)
    const gatewayCall = seen.find(call => call.url.includes('/public/publish'))
    expect(gatewayCall).toBeDefined()
    expect(gatewayCall!.headers.cookie).toBeUndefined()
    expect(gatewayCall!.headers['x-duet-actor-context']).toBeUndefined()
    expect(gatewayCall!.headers['x-duet-forged']).toBeUndefined()
    expect(gatewayCall!.headers.authorization).toBe('Bearer gateway-token')
    expect(gatewayCall!.headers[DUET_PUBLISH_KIND_HEADER]).toBe('file')
  })

  test('serves staging publishes on the request host without production Host spoofing', async () => {
    const resolveBodies: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/edge/resolve')) {
          resolveBodies.push(JSON.parse(String(init?.body)))
          return Response.json(publishResolved)
        }
        return new Response('published from staging')
      },
    })

    const response = await app.fetch(
      new Request('https://edge-staging.duet.so/acme-drive/q2/?raw', {
        headers: { host: 'edge-staging.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('published from staging')
    expect(resolveBodies).toEqual([
      {
        kind: 'publish',
        host: 'edge-staging.duet.so',
        workspaceSlug: 'acme-drive',
        publishSlug: 'q2',
      },
    ])
  })

  test('serves folder listing and nested files, auditing the first nested file serve', async () => {
    const reports: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/edge/resolve')) return Response.json(folderPublishResolved)
        if (url.endsWith('/v1/edge/publishes/served')) {
          reports.push(JSON.parse(String(init?.body)))
          return Response.json({ recorded: true })
        }
        if (url.endsWith('/public/publish/?list')) {
          return Response.json({ entries: [{ name: 'notes.md', type: 'file', size: 5 }] })
        }
        if (url.endsWith('/public/publish/notes.md?raw')) {
          return new Response('notes', {
            headers: { etag: '"notes-etag"', 'content-type': 'application/octet-stream' },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const listing = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public?list', {
        headers: { host: 'edge.duet.so' },
      }),
    )
    expect(listing.status).toBe(200)
    expect(await listing.json()).toEqual({ entries: [{ name: 'notes.md', type: 'file', size: 5 }] })

    const nested = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public/notes.md?raw', {
        headers: { host: 'edge.duet.so' },
      }),
    )
    expect(nested.status).toBe(200)
    expect(await nested.text()).toBe('notes')
    expect(reports).toEqual([
      { publishId: 'publish-folder-id', servedPath: 'public/notes.md', kind: 'raw' },
    ])
  })

  test('a successful root zip reports the zipped publish folder exactly once', async () => {
    const reports: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/edge/resolve')) return Response.json(folderPublishResolved)
        if (url.endsWith('/v1/edge/publishes/served')) {
          reports.push(JSON.parse(String(init?.body)))
          return Response.json({ recorded: true })
        }
        return new Response('zip bytes')
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public?zip', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('zip bytes')
    expect(reports).toEqual([{ publishId: 'publish-folder-id', servedPath: 'public', kind: 'zip' }])
  })

  test('a successful nested zip reports the requested folder, not its files', async () => {
    const reports: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/edge/resolve')) return Response.json(folderPublishResolved)
        if (url.endsWith('/v1/edge/publishes/served')) {
          reports.push(JSON.parse(String(init?.body)))
          return Response.json({ recorded: true })
        }
        return new Response('zip bytes')
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public/agents/research?zip', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(200)
    expect(reports).toEqual([
      { publishId: 'publish-folder-id', servedPath: 'public/agents/research', kind: 'zip' },
    ])
  })

  test('a 304 zip response does not report a served path', async () => {
    const reports: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        const url = String(input)
        if (url.endsWith('/v1/edge/resolve')) return Response.json(folderPublishResolved)
        if (url.endsWith('/v1/edge/publishes/served')) {
          reports.push(url)
          return Response.json({ recorded: true })
        }
        return new Response(null, { status: 304 })
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public?zip', {
        headers: { host: 'edge.duet.so', 'if-none-match': '"public-tree"' },
      }),
    )

    expect(response.status).toBe(304)
    expect(reports).toEqual([])
  })

  test('a failed zip response does not report a served path', async () => {
    const reports: unknown[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        const url = String(input)
        if (url.endsWith('/v1/edge/resolve')) return Response.json(folderPublishResolved)
        if (url.endsWith('/v1/edge/publishes/served')) {
          reports.push(url)
          return Response.json({ recorded: true })
        }
        return Response.json({ error: 'archive_failed' }, { status: 500 })
      },
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public?zip', {
        headers: { host: 'edge.duet.so' },
      }),
    )

    expect(response.status).toBe(500)
    expect(reports).toEqual([])
  })

  test('.env-like published paths are blocked at the edge before serving', async () => {
    const calls: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        calls.push(String(input))
        if (String(input).endsWith('/v1/edge/resolve')) {
          return Response.json({
            ...publishResolved,
            publish: {
              id: 'publish-id',
              kind: 'folder',
              anchorPath: 'public',
              viewer: {
                workspaceName: 'Acme Drive',
                ownerName: 'Ada Lovelace',
                rootName: 'public',
                kind: 'folder',
              },
            },
          })
        }
        return new Response('leak')
      },
    })

    const directEnv = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/public/.env.local', {
        headers: { host: 'edge.duet.so' },
      }),
    )
    expect(directEnv.status).toBe(404)
    expect(calls).toEqual([])

    const anchorEnv = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        calls.push(String(input))
        if (String(input).endsWith('/v1/edge/resolve')) {
          return Response.json({
            ...publishResolved,
            publish: {
              id: 'publish-id',
              kind: 'file',
              anchorPath: '.env',
              viewer: {
                workspaceName: 'Acme Drive',
                ownerName: 'Ada Lovelace',
                rootName: '.env',
                kind: 'file',
              },
            },
          })
        }
        return new Response('leak')
      },
    })
    const blockedAnchor = await anchorEnv.fetch(
      new Request('https://edge.duet.so/acme-drive/env', { headers: { host: 'edge.duet.so' } }),
    )
    expect(blockedAnchor.status).toBe(404)
  })

  test('unknown publish slugs preserve resolver 404', async () => {
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async () => Response.json({ error: 'not_found' }, { status: 404 }),
    })

    const response = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/missing', { headers: { host: 'edge.duet.so' } }),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  test('SUBS-IMPL-11 serves a branded app-named paused page without fetching the origin', async () => {
    const calls: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        calls.push(String(input))
        return Response.json({ paused: true, appName: 'Launch <Status>' })
      },
    })

    const response = await app.fetch(
      new Request('https://status--acme-drive.edge.duet.so/', {
        headers: { host: 'status--acme-drive.edge.duet.so' },
      }),
    )
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30')
    expect(response.headers.get('vary')).toBe('accept-language')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(body).toContain('Launch &lt;Status&gt; is paused')
    expect(body).toContain('Built with <strong>Duet</strong>')
    expect(body).toContain('<main data-edge-paused-page>')
    expect(body).toContain('data-edge-paused-title')
    expect(body).toContain('data-edge-paused-mark')
    expect(body).not.toContain('billing')
    expect(body).not.toContain('owner')
    expect(calls).toEqual(['https://convex.example/v1/edge/resolve'])
  })

  test('SUBS-IMPL-11 localizes the paused page for es-419 visitors', async () => {
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async () => Response.json({ paused: true, appName: 'Estado' }),
    })

    const response = await app.fetch(
      new Request('https://status--acme-drive.edge.duet.so/', {
        headers: {
          host: 'status--acme-drive.edge.duet.so',
          'accept-language': 'es-419,es;q=0.9,en;q=0.8',
        },
      }),
    )
    const body = await response.text()

    expect(body).toContain('<html lang="es-419">')
    expect(body).toContain('Estado está en pausa')
    expect(body).toContain('Creado con <strong>Duet</strong>')
  })

  test('suspended app and publish resolves return noindexed 403s without origin fetches', async () => {
    const calls: string[] = []
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async input => {
        calls.push(String(input))
        return Response.json({ error: 'suspended' }, { status: 403 })
      },
    })

    const appResponse = await app.fetch(
      new Request('https://todo--acme-drive.edge.duet.so/live', {
        headers: { host: 'todo--acme-drive.edge.duet.so' },
      }),
    )
    const publishResponse = await app.fetch(
      new Request('https://edge.duet.so/acme-drive/q2', { headers: { host: 'edge.duet.so' } }),
    )

    expect(appResponse.status).toBe(403)
    expect(appResponse.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(await appResponse.json()).toEqual({ error: 'forbidden' })
    expect(publishResponse.status).toBe(403)
    expect(publishResponse.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(await publishResponse.json()).toEqual({ error: 'forbidden' })
    expect(calls).toEqual([
      'https://convex.example/v1/edge/resolve',
      'https://convex.example/v1/edge/resolve',
    ])
  })
})

test('records a lost origin connection cause once and permits the next request', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  let fail = true
  const app = createEdgeApp({
    convexSiteUrl: 'https://convex.example',
    edgeSecret: 'edge-secret',
    fetch: async input => {
      if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
      if (fail)
        throw new TypeError('private upstream URL and token', {
          cause: Object.assign(new Error('private socket detail'), { code: 'ECONNREFUSED' }),
        })
      return new Response('recovered')
    },
  })
  try {
    const request = () =>
      new Request('https://notes--acme-drive.edge.duet.so/?secret=hidden', {
        headers: { host: 'notes--acme-drive.edge.duet.so', authorization: 'Bearer caller-secret' },
      })
    const response = await app.fetch(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'origin_unavailable',
      detail: 'private upstream URL and token',
    })
    expect(logged.mock.calls).toEqual([
      [
        'edge_origin_connection_failed',
        {
          routeKind: 'app',
          workspaceId: 'workspace-id',
          transportCode: 'ECONNREFUSED',
        },
      ],
    ])
    fail = false
    const recovered = await app.fetch(request())
    expect(await recovered.text()).toBe('recovered')
    expect(logged.mock.calls).toHaveLength(1)
  } finally {
    logged.mockRestore()
  }
})

test('origin diagnostics cannot replace the original response when the log sink fails', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {
    throw new Error('sink failed')
  })
  const app = createEdgeApp({
    convexSiteUrl: 'https://convex.example',
    edgeSecret: 'edge-secret',
    fetch: async input => {
      if (String(input).endsWith('/v1/edge/resolve')) return Response.json(resolved)
      throw Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })
    },
  })
  try {
    const response = await app.fetch(
      new Request('https://notes--acme-drive.edge.duet.so/', {
        headers: { host: 'notes--acme-drive.edge.duet.so' },
      }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'origin_unavailable',
      detail: 'connection timed out',
    })
  } finally {
    logged.mockRestore()
  }
})

test('origin diagnostics exclude cancellation, reconnects, unknown causes and upstream responses', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const mode of ['cancelled', 'sse', 'websocket', 'unknown', 'http', 'resolver']) {
      const controller = new AbortController()
      const app = createEdgeApp({
        convexSiteUrl: 'https://convex.example',
        edgeSecret: 'edge-secret',
        fetch: async input => {
          if (String(input).endsWith('/v1/edge/resolve') && mode !== 'resolver')
            return Response.json(resolved)
          if (mode === 'http') return new Response('upstream failure', { status: 503 })
          if (mode === 'cancelled') controller.abort()
          throw Object.assign(new Error('private upstream detail'), {
            code: mode === 'unknown' ? 'private-code' : 'ECONNREFUSED',
          })
        },
      })
      const response = await app.fetch(
        new Request('https://notes--acme-drive.edge.duet.so/', {
          signal: controller.signal,
          headers: {
            host: 'notes--acme-drive.edge.duet.so',
            ...(mode === 'sse' ? { accept: 'text/event-stream' } : {}),
            ...(mode === 'websocket' ? { upgrade: 'websocket', connection: 'upgrade' } : {}),
          },
        }),
      )
      expect(response.status).toBe(mode === 'http' ? 503 : 502)
      expect(logged.mock.calls).toEqual([])
    }
  } finally {
    logged.mockRestore()
  }
})

describe('custom hostname indexing', () => {
  test('preserves upstream indexing only for public custom origin content', async () => {
    let visibility: 'folder' | 'public' = 'public'
    let status = 200
    let robots: string | undefined
    const app = createEdgeApp({
      convexSiteUrl: 'https://convex.example',
      edgeSecret: 'edge-secret',
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/edge/resolve')) {
          if (JSON.parse(String(init?.body)).kind === 'app-host')
            return Response.json({
              appId: 'app-id',
              workspaceId: 'workspace-id',
              workspaceSlug: 'acme-drive',
              appSlug: 'todo',
            })
          return Response.json({ ...resolved, visibility })
        }
        return new Response('origin content', {
          status,
          headers: robots === undefined ? {} : { 'x-robots-tag': robots },
        })
      },
    })
    const visit = (host = 'aomni.co') =>
      app.fetch(new Request(`https://${host}/`, { headers: { host } }))
    expect((await visit()).headers.get('x-robots-tag')).toBeNull()
    robots = 'noindex, noarchive'
    expect((await visit()).headers.get('x-robots-tag')).toBe(robots)
    robots = 'index, follow'
    expect((await visit()).headers.get('x-robots-tag')).toBe(robots)
    expect((await visit('todo--acme-drive.edge.duet.so')).headers.get('x-robots-tag')).toBe(
      'noindex, nofollow',
    )
    visibility = 'folder'
    expect((await visit()).headers.get('x-robots-tag')).toBe('noindex, nofollow')
    visibility = 'public'
    status = 404
    expect((await visit()).headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })
})

test('custom host mapping is read before grant exchange and again on each visit', async () => {
  let live = true
  let appSlug = 'todo'
  let origins = 0
  const app = createEdgeApp({
    convexSiteUrl: 'https://convex.example',
    edgeSecret: 'edge-secret',
    now: () => 10_000,
    fetch: async (input, init) => {
      if (String(input).endsWith('/v1/edge/resolve')) {
        if (JSON.parse(String(init?.body)).kind === 'app-host')
          return live
            ? Response.json({
                appId: 'app-id',
                workspaceId: 'workspace-id',
                workspaceSlug: 'acme-drive',
                appSlug,
              })
            : Response.json({ error: 'not_found' }, { status: 404 })
        return Response.json(resolved)
      }
      origins += 1
      return new Response('todo-origin')
    },
  })
  const grant = await mintAppAccessGrant('edge-secret', {
    appId: 'app-id',
    userId: 'user_123',
    workspaceSlug: 'acme-drive',
    appSlug: 'todo',
    launchExpiresAt: 12_000,
    expiresAt: 20_000,
    nonce: '0123456789abcdef0123456789abcdef',
  })
  const url = new URL('https://aomni.co/deep?theme=dark')
  url.searchParams.set(DUET_APP_ACCESS_QUERY, grant)
  const visit = () => app.fetch(new Request(url.toString(), { headers: { host: 'aomni.co' } }))
  const exchange = await visit()
  expect(exchange.status).toBe(302)
  expect(exchange.headers.get('location')).toBe('https://aomni.co/deep?theme=dark')
  expect(exchange.headers.get('set-cookie')).toContain('Secure; SameSite=Lax')
  expect(exchange.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  appSlug = 'other'
  const changed = await visit()
  expect(changed.status).toBe(403)
  expect(changed.headers.get('set-cookie')).toBeNull()
  live = false
  expect((await visit()).status).toBe(404)
  live = true
  appSlug = 'todo'
  expect((await visit()).status).toBe(302)
  expect(origins).toBe(0)
})

test('private browser documents return through Duet while non-documents and signed denials stay forbidden', async () => {
  let denial = 'guest_private'
  const app = createEdgeApp({
    convexSiteUrl: 'https://convex.example',
    edgeSecret: 'edge-secret',
    viewerOrigin: 'https://web.example',
    fetch: async (_input, init) =>
      JSON.parse(String(init?.body)).kind === 'app-host'
        ? Response.json({
            appId: 'app-id',
            workspaceId: 'workspace-id',
            workspaceSlug: 'acme-drive',
            appSlug: 'todo',
          })
        : Response.json({ error: denial }, { status: 403 }),
  })
  for (const host of ['todo--acme-drive.edge.duet.so', 'aomni.co']) {
    const visit = (headers: Record<string, string>, method = 'GET', path = '/deep?q=a%2Fb') =>
      app.fetch(new Request(`https://${host}${path}`, { method, headers: { host, ...headers } }))
    const response = await visit({ 'sec-fetch-dest': 'document' })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://web.example')
    expect(location.pathname).toBe('/w/acme-drive/apps/todo/open')
    expect(Object.fromEntries(location.searchParams)).toEqual({ host, path: '/deep?q=a%2Fb' })
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect((await visit({ accept: 'text/html' })).status).toBe(302)
    const nonDocuments: Array<Record<string, string>> = [
      { 'sec-fetch-dest': 'iframe', accept: 'text/html' },
      { 'sec-fetch-dest': 'empty', accept: 'text/html' },
      { accept: 'application/json' },
      { 'x-requested-with': 'XMLHttpRequest', accept: 'text/html' },
      { 'sec-fetch-mode': 'cors', accept: 'text/html' },
    ]
    for (const headers of nonDocuments) expect((await visit(headers)).status).toBe(403)
    expect((await visit({ 'sec-fetch-dest': 'document' }, 'POST')).status).toBe(403)
    expect((await visit({ accept: 'application/json' }, 'GET', '/api/data')).status).toBe(403)
    expect((await visit({ 'sec-fetch-dest': 'document' }, 'GET', '/api')).status).toBe(302)
    denial = 'forbidden'
    expect((await visit({ 'sec-fetch-dest': 'document' })).status).toBe(403)
    denial = 'suspended'
    expect((await visit({ 'sec-fetch-dest': 'document' })).status).toBe(403)
    denial = 'guest_private'
  }
})
