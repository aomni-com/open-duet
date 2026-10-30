import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DUET_APP_SLUG_HEADER, type GatewayAppConfig } from '@repo/contract'

import { AppSupervisor } from '../routes/apps'
import { trackAppProcesses } from '../testing/app-processes.test-helper'
import { cleanUpTestTimeouts } from '../testing/timeouts.test-helper'

const tempDirs: string[] = []
const supervisors: AppSupervisor[] = []
const appProcesses = trackAppProcesses()

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) supervisor.stop()
  await appProcesses.stopChildren()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
// Register last so shutdown-created timers are captured before timer cleanup.
cleanUpTestTimeouts()

describe('gateway building fallback', () => {
  test.each(['GET', 'HEAD'])(
    'serves building status and headers for a hot unavailable app HTML %s',
    async method => {
      const fixture = await unavailableFixture({ name: 'Weather Desk' })
      try {
        const response = await fixture.request('/', { method, headers: { accept: 'text/html' } })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        const body = await response.text()
        if (method === 'HEAD') expect(body).toBe('')
        else expect(body).toContain('Weather Desk</span> is being built')
      } finally {
        fixture.supervisor.stop()
      }
    },
  )

  test('keeps the unavailable JSON response for non-HTML requests and mutations', async () => {
    const fixture = await unavailableFixture()
    try {
      for (const init of [
        { headers: { accept: 'application/json' } },
        { headers: { accept: 'text/html;q=0, */*' } },
        { method: 'POST', headers: { accept: 'text/html' }, body: 'payload' },
      ]) {
        const response = await fixture.request('/', init)
        expect(response.status).toBe(502)
        expect(await response.text()).toBe('{"error":"app_unavailable"}')
      }
    } finally {
      fixture.supervisor.stop()
    }
  })

  test('keeps the unavailable JSON response when the app folder is cold', async () => {
    const fixture = await unavailableFixture()
    try {
      const old = new Date(Date.now() - 60_000)
      await utimes(join(fixture.appDir, 'server.ts'), old, old)
      await utimes(fixture.appDir, old, old)
      const response = await fixture.request('/', { headers: { accept: 'text/html' } })
      const expected = Response.json({ error: 'app_unavailable' }, { status: 502 })

      expect(response.status).toBe(expected.status)
      expect([...response.headers]).toEqual([...expected.headers])
      expect(await response.text()).toBe(await expected.text())
    } finally {
      fixture.supervisor.stop()
    }
  })

  test('passes a cold root 404 through byte-for-byte with its status and headers', async () => {
    const fixture = await servingFixture({
      status: 404,
      body: new Uint8Array([0, 1, 2, 254, 255]),
      headers: { 'content-type': 'application/octet-stream', 'x-upstream': 'cold-404' },
    })
    try {
      const old = new Date(Date.now() - 60_000)
      await utimes(fixture.appDir, old, old)
      const [direct, proxied] = await Promise.all([
        fetch(`http://127.0.0.1:${fixture.app.port}/`),
        fixture.request('/', { headers: { accept: 'text/html' } }),
      ])
      const directHeaders = [...direct.headers]
        .filter(([name]) => name !== 'content-encoding')
        .sort(([left], [right]) => left.localeCompare(right))
      const proxyHeaders = [...proxied.headers].sort(([left], [right]) => left.localeCompare(right))

      expect(proxied.status).toBe(direct.status)
      expect(proxyHeaders).toEqual(directHeaders)
      expect(new Uint8Array(await proxied.arrayBuffer())).toEqual(
        new Uint8Array(await direct.arrayBuffer()),
      )
    } finally {
      fixture.supervisor.stop()
    }
  })

  test.each([200, 500])(
    'leaves an upstream %s response untouched while the folder is hot',
    async status => {
      const fixture = await servingFixture({
        status,
        body: '<h1>ready</h1>',
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-upstream': 'live' },
      })
      try {
        const response = await fixture.request('/', { headers: { accept: 'text/html' } })

        expect(response.status).toBe(status)
        expect(response.headers.get('x-upstream')).toBe('live')
        expect(await response.text()).toBe('<h1>ready</h1>')
      } finally {
        fixture.supervisor.stop()
      }
    },
  )

  test('passes a hot non-root 404 through unchanged', async () => {
    const fixture = await servingFixture({
      status: 404,
      body: 'asset missing',
      headers: { 'x-upstream': 'asset-404' },
    })
    try {
      const response = await fixture.request('/missing.js', { headers: { accept: 'text/html' } })

      expect(response.status).toBe(404)
      expect(response.headers.get('x-upstream')).toBe('asset-404')
      expect(await response.text()).toBe('asset missing')
    } finally {
      fixture.supervisor.stop()
    }
  })

  test('replaces a hot root 404 with the building page and slug fallback', async () => {
    const fixture = await servingFixture({ status: 404, body: 'upstream missing' })
    try {
      const response = await fixture.request('/', { headers: { accept: 'text/html' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-store')
      const html = await response.text()
      expect(html).toContain(`${fixture.app.slug}</span> is being built`)
      expect(html).not.toContain('upstream missing')
      expect(html).toMatch(/<meta http-equiv="refresh" content="[0-9]+">/)
    } finally {
      fixture.supervisor.stop()
    }
  })

  test('HEAD mirrors building GET status and headers without a body', async () => {
    const fixture = await servingFixture({ status: 404, body: 'upstream missing' })
    try {
      const get = await fixture.request('/', { headers: { accept: 'text/html' } })
      const head = await fixture.request('/', { method: 'HEAD', headers: { accept: 'text/html' } })

      expect(head.status).toBe(get.status)
      expect([...head.headers]).toEqual([...get.headers])
      expect(await head.text()).toBe('')
    } finally {
      fixture.supervisor.stop()
    }
  })

  test('cancels an intercepted upstream response body', async () => {
    const fixture = await servingFixture({ status: 200, body: 'ready' })
    const realFetch = globalThis.fetch
    let cancelled = false
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('upstream missing'))
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 404 },
        ),
      )) as unknown as typeof fetch
    try {
      const response = await fixture.request('/', { headers: { accept: 'text/html' } })

      expect(response.status).toBe(200)
      expect(cancelled).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      fixture.supervisor.stop()
    }
  })

  test('publish-early crash state heals after the server file appears and a respawn fires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-building-fallback-'))
    tempDirs.push(root)
    const driveDir = join(root, 'drive')
    const appDir = join(driveDir, 'apps', 'publish-early')
    await mkdir(appDir, { recursive: true })
    const port = await freePort()
    const app: GatewayAppConfig = {
      slug: 'publish-early',
      name: 'Publish Early',
      command: 'bun server.ts',
      port,
      anchorPath: 'apps/publish-early',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({
      driveDir,
      startupBindTimeoutMs: 50,
      startupGraceMs: 5,
      respawnBaseDelayMs: 30,
      respawnMaxDelayMs: 30,
    })
    supervisors.push(supervisor)
    const request = () =>
      supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: app.slug, accept: 'text/html' },
        }),
      )
    try {
      await expect(supervisor.reconcile([app], { requiredReadySlugs: [app.slug] })).rejects.toThrow(
        'did not become ready',
      )
      const building = await request()
      expect(building.status).toBe(200)
      expect(await building.text()).toContain('Publish Early</span> is being built')

      await writeFile(
        join(appDir, 'server.ts'),
        "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('published')}); await new Promise(()=>{})",
      )
      expect(await waitForBody(request, 'published')).toBe('published')
    } finally {
      supervisor.stop()
    }
  })
})

async function unavailableFixture(overrides: Partial<GatewayAppConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'duet-building-fallback-'))
  tempDirs.push(root)
  const driveDir = join(root, 'drive')
  const appDir = join(driveDir, 'apps', 'weather')
  await mkdir(appDir, { recursive: true })
  await writeFile(join(appDir, 'server.ts'), '// being written')
  const app: GatewayAppConfig = {
    slug: 'weather',
    command: 'exit 1',
    port: await freePort(),
    anchorPath: 'apps/weather',
    appId: 'fixture-app',
    apiScopes: [],
    ...overrides,
  }
  const supervisor = new AppSupervisor({
    driveDir,
    startupBindTimeoutMs: 20,
    startupGraceMs: 5,
    respawnBaseDelayMs: 50,
    respawnMaxDelayMs: 50,
  })
  supervisors.push(supervisor)
  await expect(supervisor.reconcile([app])).rejects.toThrow('did not become ready')
  return {
    app,
    appDir,
    supervisor,
    request: (path: string, init: RequestInit = {}) =>
      supervisor.handleProxy(
        new Request(`http://gateway/public/app${path}`, {
          ...init,
          headers: { [DUET_APP_SLUG_HEADER]: app.slug, ...init.headers },
        }),
      ),
  }
}

async function servingFixture(options: {
  status: number
  body: string | Uint8Array
  headers?: Record<string, string>
}) {
  const root = await mkdtemp(join(tmpdir(), 'duet-building-fallback-'))
  tempDirs.push(root)
  const driveDir = join(root, 'drive')
  const appDir = join(driveDir, 'apps', 'upstream')
  await mkdir(appDir, { recursive: true })
  const port = await freePort()
  const body = typeof options.body === 'string' ? options.body : [...options.body]
  const command = [
    'bun',
    '-e',
    JSON.stringify(
      `const body=${JSON.stringify(body)}; Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(${typeof options.body === 'string' ? 'body' : 'new Uint8Array(body)'},{status:${options.status},headers:${JSON.stringify(options.headers ?? {})}})}); await new Promise(()=>{})`,
    ),
  ].join(' ')
  const app: GatewayAppConfig = {
    slug: 'upstream',
    command,
    port,
    anchorPath: 'apps/upstream',
    appId: 'fixture-app',
    apiScopes: [],
  }
  const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 10 })
  supervisors.push(supervisor)
  await supervisor.reconcile([app])
  return {
    app,
    appDir,
    supervisor,
    request: (path: string, init: RequestInit = {}) =>
      supervisor.handleProxy(
        new Request(`http://gateway/public/app${path}`, {
          ...init,
          headers: { [DUET_APP_SLUG_HEADER]: app.slug, ...init.headers },
        }),
      ),
  }
}

async function waitForBody(request: () => Promise<Response>, expected: string): Promise<string> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const response = await request()
    const body = await response.text()
    if (body === expected) return body
    if (Date.now() >= deadline) throw new Error('timed out waiting for response')
    await Bun.sleep(20)
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('port allocation failed')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}
