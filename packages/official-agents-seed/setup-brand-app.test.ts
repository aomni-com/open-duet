import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSetupBrandApp } from './content/agents/brand-designer/apps/setup-brand/server'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(stop => stop()))
  const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, 'Brand fixture cleanup failed')
})

const BRANDING = {
  colors: {
    primary: '#1c2b4a',
    accent: '#ff8b5c',
    background: '#fbf9f5',
    textPrimary: '#171520',
    link: '#3d5bd1',
  },
  typography: { fontFamilies: { heading: 'Fraunces', primary: 'Inter' } },
  images: { logo: 'https://cdn.acme.test/logo.svg' },
  personality: { tone: 'confident, plain-spoken' },
}

/**
 * The app's whole edge: the Firecrawl proxy, the model gateway, the files API,
 * the onboarded route, and the brand's own CDN for the logo. Everything the app
 * does to the outside world passes through here.
 */
function fakePlatform() {
  const state = {
    scrapeStatus: 200,
    branding: BRANDING as Record<string, unknown>,
    judgment:
      '## Voice\n- Short sentences.\n\n## Imagery\nWarm.\n\n## Exclusions\n- No recolouring.',
    modelStatus: 200,
    writeStatus: 200,
    onboardedStatus: 200,
    writes: [] as Array<{ path: string; contentType: string; body: string }>,
    onboardedCalls: [] as Array<{ onboarded: boolean }>,
    modelCalls: [] as Array<{ model: string; tier: string | null; authorization: string | null }>,
    scrapeCalls: [] as Array<{ url: string; formats: unknown }>,
  }
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init?.headers)
    if (url.hostname === 'cdn.acme.test') {
      return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
    }
    if (url.pathname === '/v1/whoami') {
      return Response.json({ workspaces: [{ slug: 'acme-hq' }] })
    }
    if (url.pathname === '/v1/services/firecrawl/v2/scrape') {
      const body = JSON.parse(String(init?.body)) as { url: string; formats: unknown }
      state.scrapeCalls.push(body)
      if (state.scrapeStatus !== 200) {
        return Response.json({ error: 'nope' }, { status: state.scrapeStatus })
      }
      return Response.json({
        success: true,
        data: { branding: state.branding, markdown: '# Acme' },
      })
    }
    if (url.pathname === '/v1/chat/completions') {
      const body = JSON.parse(String(init?.body)) as { model: string }
      state.modelCalls.push({
        model: body.model,
        tier: headers.get('x-duet-tier'),
        authorization: headers.get('authorization'),
      })
      if (state.modelStatus !== 200)
        return Response.json({ error: 'no' }, { status: state.modelStatus })
      return Response.json({ choices: [{ message: { content: state.judgment } }] })
    }
    if (url.pathname.startsWith('/v1/ws/acme-hq/files/')) {
      if (state.writeStatus !== 200)
        return Response.json({ error: 'no' }, { status: state.writeStatus })
      state.writes.push({
        path: decodeURIComponent(url.pathname.replace('/v1/ws/acme-hq/files/', '')),
        contentType: headers.get('content-type') ?? '',
        // The route takes a binary body; decode it the way the API does rather
        // than stringifying the byte array.
        body: await new Response(init?.body ?? null).text(),
      })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/v1/ws/acme-hq/app/onboarded') {
      if (state.onboardedStatus !== 200) {
        return Response.json({ error: 'no' }, { status: state.onboardedStatus })
      }
      state.onboardedCalls.push(JSON.parse(String(init?.body)) as { onboarded: boolean })
      return Response.json({ agent: { id: 'agent_1', slug: 'brand-designer' } })
    }
    throw new Error(`unexpected path ${url.pathname}`)
  }
  return { state, fetchImpl }
}

/**
 * Deliberately NOT `agents/brand-designer`: the user named this copy on install,
 * and the manifest's canonical path is right only for the official hub. A
 * regression to a hardcoded folder fails every path assertion below.
 */
const AGENT_DIR = 'agents/branding'

const env = {
  DUET_API_URL: 'https://duet.test',
  DUET_APP_API_KEY: 'app-key',
  DUET_GATEWAY_BASE_URL: 'https://gateway.test',
  DUET_AGENT_DIR: AGENT_DIR,
}

async function startApp(platform = fakePlatform(), overrides: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'duet-setup-brand-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const app = createSetupBrandApp({
    directory,
    port: 0,
    fetchImpl: platform.fetchImpl,
    env: { ...env, ...overrides },
  })
  cleanup.push(async () => {
    await app.stop()
  })
  return { ...app, directory, platform }
}

async function send(url: URL, path: string, body?: unknown): Promise<Response> {
  return await fetch(new URL(path, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('a bare domain is enough, and the scrape asks for branding', async () => {
  const app = await startApp()

  const response = await send(app.url, '/api/scan', { site: 'acme.com' })
  expect(response.status).toBe(200)
  expect(app.platform.state.scrapeCalls[0]).toMatchObject({
    url: 'https://acme.com',
    formats: ['branding', 'markdown'],
  })
})

test('every extracted colour arrives already named for what it is for', async () => {
  const app = await startApp()

  const status = (await (await send(app.url, '/api/scan', { site: 'acme.com' })).json()) as {
    kit: { colors: Array<{ role: string; hex: string; usedFor: string }>; fonts: unknown[] }
  }
  // A hex without a job gets used as a background by the next reader; the roles
  // are the whole point of a kit over a palette.
  expect(status.kit.colors).toEqual([
    { role: 'Primary', hex: '#1c2b4a', usedFor: 'The brand colour — headlines, key surfaces' },
    { role: 'Accent', hex: '#ff8b5c', usedFor: 'Buttons and highlights, never a page background' },
    { role: 'Surface', hex: '#fbf9f5', usedFor: 'Page and card backgrounds' },
    { role: 'Ink', hex: '#171520', usedFor: 'Body text' },
    { role: 'Link', hex: '#3d5bd1', usedFor: 'Inline links only' },
  ])
  expect(status.kit.fonts).toEqual([
    { role: 'Display', family: 'Fraunces' },
    { role: 'Text', family: 'Inter' },
  ])
})

test('the model call spends as the app, attributed to the services tier', async () => {
  const app = await startApp()

  await send(app.url, '/api/scan', { site: 'acme.com' })
  // `services` attributes the pinned model's actual cost to this app. The app
  // authenticates with its own key so the gateway attributes the spend to it
  // rather than to the workspace runner.
  expect(
    app.platform.state.modelCalls.map(({ tier, authorization }) => ({ tier, authorization })),
  ).toEqual([{ tier: 'services', authorization: 'Bearer app-key' }])
})

test('confirming writes the kit and the logo, then unlocks the agent', async () => {
  const app = await startApp()
  await send(app.url, '/api/scan', { site: 'acme.com' })

  const confirmed = await send(app.url, '/api/confirm')
  expect(confirmed.status).toBe(200)
  expect(((await confirmed.json()) as { complete: boolean }).complete).toBe(true)

  const paths = app.platform.state.writes.map(write => write.path)
  expect(paths).toEqual([`${AGENT_DIR}/brand/assets/logo.svg`, `${AGENT_DIR}/brand/brand-kit.md`])
  const kit = app.platform.state.writes[1]!.body
  expect(kit).toContain('# Acme — brand kit')
  expect(kit).toContain('| Accent | `#ff8b5c` | Buttons and highlights, never a page background |')
  // The logo row names the FILE, because a URL is not an asset a designer can place.
  expect(kit).toContain(`\`${AGENT_DIR}/brand/assets/logo.svg\``)
  expect(kit).toContain('## Exclusions')
  expect(app.platform.state.onboardedCalls).toEqual([{ onboarded: true }])
})

test('a kit is still written when the model is unreachable', async () => {
  const platform = fakePlatform()
  platform.state.modelStatus = 503
  const app = await startApp(platform)

  await send(app.url, '/api/scan', { site: 'acme.com' })
  expect((await send(app.url, '/api/confirm')).status).toBe(200)

  const kit = platform.state.writes.at(-1)!.body
  // The colours and type are real, so the seat is usable; the sections the model
  // would have written say they are open rather than inventing rules.
  expect(kit).toContain('| Accent | `#ff8b5c` |')
  expect(kit).toContain('_Not yet set — confirm with the user._')
  expect(platform.state.onboardedCalls).toEqual([{ onboarded: true }])
})

test('a site that cannot be read leaves the agent locked and says so', async () => {
  const platform = fakePlatform()
  platform.state.scrapeStatus = 422
  const app = await startApp(platform)

  const response = await send(app.url, '/api/scan', { site: 'acme.com' })
  expect(response.status).toBe(400)
  expect(((await response.json()) as { error: string }).error).toMatch(/could not be read/i)
  expect(platform.state.onboardedCalls).toEqual([])

  const status = (await (await fetch(new URL('/api/status', app.url))).json()) as {
    kit: unknown
    complete: boolean
  }
  expect(status.kit).toBeNull()
  expect(status.complete).toBe(false)
})

test('the agent stays locked when the kit cannot be saved', async () => {
  const platform = fakePlatform()
  platform.state.writeStatus = 500
  const app = await startApp(platform)
  await send(app.url, '/api/scan', { site: 'acme.com' })

  const confirmed = await send(app.url, '/api/confirm')
  expect(confirmed.status).toBe(502)
  // Unlocking a seat whose kit was never written is the one thing this app must
  // not do: the card would open onto an agent that refuses its first request.
  expect(platform.state.onboardedCalls).toEqual([])
})

test('the pick survives a restart', async () => {
  const app = await startApp()
  await send(app.url, '/api/scan', { site: 'acme.com' })
  await send(app.url, '/api/confirm')

  app.stop()
  const restarted = createSetupBrandApp({
    directory: app.directory,
    port: 0,
    fetchImpl: app.platform.fetchImpl,
    env,
  })
  cleanup.push(async () => restarted.stop())
  const status = (await (await fetch(new URL('/api/status', restarted.url))).json()) as {
    complete: boolean
    kit: { site: string }
  }
  expect(status.complete).toBe(true)
  expect(status.kit.site).toBe('https://acme.com')
})

test('an address with no host is refused before anything is spent', async () => {
  const app = await startApp()

  for (const site of ['', '   ', 'not a site', 'localhost']) {
    const response = await send(app.url, '/api/scan', { site })
    expect(response.status).toBe(400)
  }
  expect(app.platform.state.scrapeCalls).toEqual([])
})

test('site normalization accepts what a person types', async () => {
  const app = await startApp()
  for (const [site, normalized] of [
    ['acme.com', 'https://acme.com'],
    ['  www.acme.com  ', 'https://www.acme.com'],
    ['https://acme.com/brand', 'https://acme.com/brand'],
    ['http://acme.com/', 'http://acme.com'],
  ]) {
    expect((await send(app.url, '/api/scan', { site })).status).toBe(200)
    expect(app.platform.state.scrapeCalls.at(-1)?.url).toBe(normalized)
  }
  // Invalid hostname and empty input remain owned by the no-spend HTTP test.
})

test('the brand name comes off the domain, without the www', async () => {
  const app = await startApp()
  for (const [site, name] of [
    ['https://www.acme.com', 'Acme'],
    ['https://blog.acme.co.uk', 'Blog'],
  ]) {
    const scanned = await send(app.url, '/api/scan', { site })
    expect(scanned.status).toBe(200)
    expect(((await scanned.json()) as { kit: { brandName: string } }).kit.brandName).toBe(name!)
  }
})

test('serves one site field with viewport metadata and event wiring', async () => {
  const app = await startApp()
  const html = await (await fetch(app.url)).text()

  expect(html).toContain('name="viewport"')
  expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
  expect(html).not.toContain('WebSocket')
  // One input, and no connect button: nothing here opens an authorization tab.
  expect(html.match(/<input /g)).toHaveLength(1)
  expect(html).not.toContain('window.open')
})

// The platform tells an app which agent folder it is in. Before that arrives —
// a cold VM, or an app whose roster has not synced — there is no safe default:
// writing to a guessed folder and then unlocking the agent strands the user
// behind a card whose seat has nothing where it looks.
test('without a folder from the platform it writes nothing and unlocks nothing', async () => {
  const platform = fakePlatform()
  const directory = await mkdtemp(join(tmpdir(), 'duet-setup-brand-'))
  const { DUET_AGENT_DIR: _absent, ...withoutFolder } = env
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const app = createSetupBrandApp({
    directory,
    port: 0,
    fetchImpl: platform.fetchImpl,
    env: withoutFolder,
  })
  cleanup.push(async () => {
    await app.stop()
  })

  const status = (await (await fetch(new URL('/api/status', app.url))).json()) as {
    ready: boolean
  }
  expect(status.ready).toBe(false)

  await send(app.url, '/api/scan', { site: 'acme.com' })
  const confirmed = await send(app.url, '/api/confirm')
  expect(confirmed.status).toBe(503)
  expect(platform.state.writes).toEqual([])
  expect(platform.state.onboardedCalls).toEqual([])
})
