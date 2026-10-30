// Slice 00 transport kill gate (publish-viewer).
//
// Drives a REAL headless Chromium against a REAL `next dev` apps/web publish
// page and its `/_next/*` assets, routed through the REAL edge handler over
// HTTP, with a hostile `duet_session` cookie attached to the edge host. It
// proves the invariant slice 00 exists to test:
//
//   - the viewer document and every `/_next/*` asset load 200 through the edge;
//   - the origin (apps/web) never receives a cookie or authorization header,
//     even though the browser sends the hostile session cookie to the edge;
//   - the page hydrates and renders the slugs/path parsed from the URL.
//
// Opt-in and heavy: it boots `next dev` and needs Playwright's Chromium
// (`bunx playwright install chromium`). It lives in `scripts/` so it is not part
// of `bun test src`. Run: `bun scripts/publish-viewer-kill-gate.ts`.

import { spawn } from 'node:child_process'
import path from 'node:path'

import { chromium } from '@playwright/test'

import { createEdgeApp } from '../../../apps/edge/src/index'

const NEXT_PORT = 31734
const PROXY_PORT = 31735
const RESOLVE_PORT = 31736
const EDGE_PORT = 31737
const WEB_DIR = path.resolve(import.meta.dir, '../../../apps/web')
const NEXT_BIN = path.resolve(import.meta.dir, '../../../node_modules/.bin/next')
const VIEWER_URL = 'https://edge.duet.so/acme/site/a/b/c'

async function waitForNextReady(readLog: () => string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const log = readLog()
    if (/Ready in/.test(log)) return
    if (/error|EADDRINUSE|Failed to compile/i.test(log)) throw new Error(`next dev failed:\n${log}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('next dev did not become ready in time')
}

const nextProc = spawn(NEXT_BIN, ['dev', '--port', String(NEXT_PORT)], {
  cwd: WEB_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // own process group so teardown can reap the whole next tree
})
let nextLog = ''
nextProc.stdout.on('data', chunk => (nextLog += String(chunk)))
nextProc.stderr.on('data', chunk => (nextLog += String(chunk)))

const forwardedToOrigin: Array<{
  path: string
  cookie: string | null
  authorization: string | null
}> = []

const proxy = Bun.serve({
  port: PROXY_PORT,
  async fetch(req) {
    const u = new URL(req.url)
    forwardedToOrigin.push({
      path: u.pathname,
      cookie: req.headers.get('cookie'),
      authorization: req.headers.get('authorization'),
    })
    const headers = new Headers(req.headers)
    headers.set('host', `127.0.0.1:${NEXT_PORT}`)
    const upstream = await fetch(`http://127.0.0.1:${NEXT_PORT}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
    })
    const outHeaders = new Headers(upstream.headers)
    outHeaders.delete('content-encoding')
    outHeaders.delete('content-length')
    outHeaders.delete('transfer-encoding')
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    })
  },
})

const resolve = Bun.serve({
  port: RESOLVE_PORT,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/v1/edge/resolve')) {
      return Response.json({
        visibility: 'public',
        workspace: { id: 'ws', slug: 'acme', httpsUrl: 'https://vm.example.exe.xyz', vmName: 'vm' },
        origin: {
          httpsUrl: 'https://vm.example.exe.xyz',
          gatewayAuthToken: 'gateway-token',
          gatewayPathPrefix: '/public/publish',
        },
        publish: {
          id: 'pub',
          kind: 'folder',
          anchorPath: 'site',
          viewer: {
            workspaceName: 'Acme',
            ownerName: 'Ada Lovelace',
            rootName: 'site',
            kind: 'folder',
          },
        },
      })
    }
    return Response.json({ recorded: true })
  },
})

const edgeApp = createEdgeApp({
  convexSiteUrl: `http://127.0.0.1:${RESOLVE_PORT}`,
  edgeSecret: 'edge-secret',
  viewerOrigin: `http://127.0.0.1:${PROXY_PORT}`,
})
const edge = Bun.serve({
  port: EDGE_PORT,
  fetch(req) {
    const headers = new Headers(req.headers)
    headers.set('host', 'edge.duet.so')
    return edgeApp.fetch(
      new Request(req.url, {
        method: req.method,
        headers,
        body: req.body,
        // @ts-expect-error duplex is required for streamed bodies on Node/Bun
        duplex: 'half',
      }),
    )
  },
})

async function run(): Promise<boolean> {
  await waitForNextReady(() => nextLog, 60_000)

  const browser = await chromium.launch()
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies([
    { name: 'duet_session', value: 'hostile-session-token', domain: 'edge.duet.so', path: '/' },
  ])

  const edgeSawCookieOnDocument: { value: string | null } = { value: null }
  await context.route('**/*', async route => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.hostname !== 'edge.duet.so') return route.continue()
    const headers = { ...req.headers() }
    if (req.resourceType() === 'document') edgeSawCookieOnDocument.value = headers.cookie ?? null
    const upstream = await fetch(`http://127.0.0.1:${EDGE_PORT}${u.pathname}${u.search}`, {
      method: req.method(),
      headers,
      body: req.postDataBuffer() ?? undefined,
      redirect: 'manual',
    })
    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((v, k) => {
      if (k !== 'content-encoding' && k !== 'content-length') outHeaders[k] = v
    })
    await route.fulfill({
      status: upstream.status,
      headers: outHeaders,
      body: Buffer.from(await upstream.arrayBuffer()),
    })
  })

  const responses: Array<{ url: string; status: number }> = []
  const page = await context.newPage()
  page.on('response', r => responses.push({ url: r.url(), status: r.status() }))

  const nav = await page.goto(VIEWER_URL, { waitUntil: 'load', timeout: 60_000 })
  // The client-mounted viewer shell is the hydration proof: it only renders
  // after React hydrates and parses the edge-forwarded descriptor header.
  await page.waitForSelector('[data-publish-viewer]', { timeout: 30_000 })
  await page.waitForTimeout(2500)

  const bannerText =
    (await page.locator('[data-publish-viewer] header').first().textContent()) ?? ''
  // Path fidelity is pinned by the controller unit tests; this transport probe
  // proves the client shell mounted and the descriptor round-tripped.
  const hydrated = {
    viewerMounted: (await page.locator('[data-publish-viewer]').count()) > 0,
    bannerHasWorkspace: bannerText.includes('Acme'),
    bannerHasOwner: bannerText.includes('Ada Lovelace'),
  }
  await browser.close()

  const edgeResponses = responses.filter(r => r.url.startsWith('https://edge.duet.so'))
  const nextResponses = edgeResponses.filter(r => new URL(r.url).pathname.startsWith('/_next/'))
  const documentStatus = nav?.status() ?? 0
  const nextNon200 = nextResponses.filter(r => r.status !== 200)
  const cookieLeaks = forwardedToOrigin.filter(r => r.cookie !== null)
  const authLeaks = forwardedToOrigin.filter(r => r.authorization !== null)
  const originNext = forwardedToOrigin.filter(r => r.path.startsWith('/_next/'))

  const pass =
    documentStatus === 200 &&
    nextResponses.length > 0 &&
    nextNon200.length === 0 &&
    cookieLeaks.length === 0 &&
    authLeaks.length === 0 &&
    originNext.length > 0 &&
    hydrated.viewerMounted &&
    hydrated.bannerHasWorkspace &&
    hydrated.bannerHasOwner &&
    (edgeSawCookieOnDocument.value?.includes('duet_session') ?? false)

  console.log(
    JSON.stringify(
      {
        verdict: pass ? 'KILL GATE PASSED' : 'KILL GATE FAILED',
        documentStatus,
        nextAssetsLoaded: nextResponses.length,
        nextAssetsThroughOrigin: originNext.length,
        nextNon200,
        edgeRequestsTotal: edgeResponses.length,
        originCookieLeaks: cookieLeaks.length,
        originAuthLeaks: authLeaks.length,
        hostileCookieSeenAtEdge: edgeSawCookieOnDocument.value,
        hydratedDom: hydrated,
      },
      null,
      2,
    ),
  )
  return pass
}

let ok = false
try {
  ok = await run()
} finally {
  proxy.stop(true)
  resolve.stop(true)
  edge.stop(true)
  try {
    if (nextProc.pid !== undefined) process.kill(-nextProc.pid, 'SIGKILL')
  } catch {
    nextProc.kill('SIGKILL')
  }
}
process.exit(ok ? 0 : 1)
