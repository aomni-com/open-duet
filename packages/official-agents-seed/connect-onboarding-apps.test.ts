import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConnectReposApp } from './content/agents/code-reviewer/apps/connect-repos/server'
import { createConnectSearchConsoleApp } from './content/agents/seo-specialist/apps/connect-search-console/server'
import { createConnectAccountsApp } from './content/agents/social-media-manager/apps/connect-accounts/server'
import { createConnectHelpdeskApp } from './content/agents/support-agent/apps/connect-helpdesk/server'

const cleanup: Array<() => Promise<void>> = []

/** The shared status shape all three onboarding apps document in their READMEs. */
type StatusBody = {
  ready: boolean
  message?: string
  providers: Array<{ integration: string; name: string; connected: boolean; status: string }>
  options: Array<{ id: string; integration: string; label: string; detail?: string }>
  discovery: Array<{ integration: string; state: string; message?: string }>
  selection: Array<{ id: string; integration: string; label: string; detail?: string }>
  complete: boolean
  confirmedAt: string | null
  checkedAt: string
}

async function asStatus(response: Response): Promise<StatusBody> {
  return (await response.json()) as StatusBody
}

afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of cleanup.splice(0).reverse()) {
    try {
      await stop()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Connection fixture cleanup failed')
})

/**
 * A fake Duet API on the other side of the app's injected fetchImpl. The three
 * onboarding apps never call providers directly — every outbound request goes
 * to $DUET_API_URL (whoami, integration connections, connect, composio
 * execute), so this one seam is the system's whole edge.
 */
function fakeDuet() {
  const state = {
    connections: [] as Array<{ id: string; integration: string; status: string }>,
    executeResults: new Map<string, unknown>(),
    executeCalls: [] as Array<{ toolSlug: string; body: unknown }>,
    connectCalls: [] as Array<{ integration: string; redirectTo: string }>,
    authorizeUrl: 'https://connect.example/authorize',
    failWhoami: false,
  }
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== 'https://duet.test') throw new Error(`unexpected origin ${url.origin}`)
    if (url.pathname === '/v1/whoami') {
      if (state.failWhoami) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return Response.json({ workspaces: [{ slug: 'w1', id: 'ws_1' }] })
    }
    if (url.pathname === '/v1/ws/w1/integrations/connections') {
      return Response.json({ items: state.connections })
    }
    if (url.pathname === '/v1/ws/w1/integrations/connect') {
      const body = JSON.parse(String(init?.body)) as { integration: string; redirectTo: string }
      state.connectCalls.push(body)
      return Response.json({ integration: body.integration, authorizeUrl: state.authorizeUrl })
    }
    const execute = url.pathname.match(/^\/v1\/integrations\/composio\/execute\/(.+)$/)
    if (execute !== null) {
      const toolSlug = decodeURIComponent(execute[1]!)
      state.executeCalls.push({ toolSlug, body: JSON.parse(String(init?.body)) })
      const result = state.executeResults.get(toolSlug)
      if (result === undefined) {
        return Response.json({ successful: false, error: 'tool_not_stubbed', data: null })
      }
      return Response.json({ successful: true, error: null, data: result })
    }
    throw new Error(`unexpected path ${url.pathname}`)
  }
  return { state, fetchImpl }
}

const env = { DUET_API_URL: 'https://duet.test', DUET_APP_API_KEY: 'app-key' }

async function startHelpdesk(duet = fakeDuet()) {
  const directory = await mkdtemp(join(tmpdir(), 'duet-connect-helpdesk-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const app = createConnectHelpdeskApp({ directory, port: 0, fetchImpl: duet.fetchImpl, env })
  cleanup.push(async () => {
    await app.stop()
  })
  return { ...app, directory, duet }
}

async function getJson(url: URL, path: string): Promise<StatusBody> {
  const response = await fetch(new URL(path, url))
  expect(response.status).toBe(200)
  return await asStatus(response)
}

async function send(url: URL, path: string, method: string, body?: unknown): Promise<Response> {
  return await fetch(new URL(path, url), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('Connect Helpdesk', () => {
  test('shows nothing connected and incomplete before any grant', async () => {
    const app = await startHelpdesk()

    const status = await getJson(app.url, '/api/status')
    expect(status.ready).toBe(true)
    expect(status.complete).toBe(false)
    expect(status.options).toEqual([])
    expect(status.selection).toEqual([])
    const zendesk = status.providers.find(p => p.integration === 'zendesk')
    expect(zendesk).toMatchObject({ connected: false })
  })

  // These pages ran a Connect button that opened a stray tab: the provider's
  // authorization page refuses to render in Duet's app frame, so the app had to
  // pop a real one, and its `returnTo` was the app's OWN edge URL — the user
  // landed back on a bare app tab instead of in the product. Connecting moved to
  // the onboarding chat, which passes a `redirectTo` path inside Duet. The route
  // and the button are gone, and neither may come back.
  test('offers no in-frame connect path of its own', async () => {
    const app = await startHelpdesk()

    const attempted = await send(app.url, '/api/connect', 'POST', {
      integration: 'zendesk',
      returnTo: 'https://connect-helpdesk--w1.edge-staging.duet.so/',
    })
    expect(attempted.status).toBe(404)
    expect(app.duet.state.connectCalls).toEqual([])

    const html = await (await fetch(app.url)).text()
    expect(html).not.toContain('/api/connect')
    expect(html).not.toContain('window.open')
    expect(html).toMatch(/ask your agent/i)
  })

  test('lists real inboxes for a connected helpdesk and stays pending when a list fails', async () => {
    const duet = fakeDuet()
    duet.state.connections = [
      { id: 'c1', integration: 'help_scout', status: 'active' },
      { id: 'c2', integration: 'zendesk', status: 'active' },
      { id: 'c3', integration: 'gmail', status: 'active' },
    ]
    duet.state.executeResults.set('HELP_SCOUT_LIST_INBOXES', {
      _embedded: { mailboxes: [{ id: 121, name: 'Support', email: 'help@acme.example' }] },
    })
    // GMAIL_LIST_LABELS deliberately not stubbed: its discovery must report
    // failure rather than pretend an empty inbox list is an answer.
    const app = await startHelpdesk(duet)

    const status = await getJson(app.url, '/api/status')
    expect(status.options).toContainEqual({
      id: 'help_scout:inbox:121',
      integration: 'help_scout',
      label: 'Support',
      detail: 'Help Scout · help@acme.example',
    })
    // Zendesk exposes no queue partition through the connection: the honest
    // option is the whole queue, not an invented list.
    expect(status.options).toContainEqual(
      expect.objectContaining({ id: 'zendesk:all', integration: 'zendesk' }),
    )
    expect(status.discovery).toContainEqual(
      expect.objectContaining({ integration: 'gmail', state: 'failed' }),
    )
    expect(status.complete).toBe(false)
  })

  test('records a selection, survives a restart, and completes only while connected', async () => {
    const duet = fakeDuet()
    duet.state.connections = [{ id: 'c1', integration: 'help_scout', status: 'active' }]
    duet.state.executeResults.set('HELP_SCOUT_LIST_INBOXES', {
      _embedded: { mailboxes: [{ id: 121, name: 'Support', email: 'help@acme.example' }] },
    })
    const app = await startHelpdesk(duet)

    const rejected = await send(app.url, '/api/selection', 'PUT', { ids: ['help_scout:inbox:999'] })
    expect(rejected.status).toBe(409)

    const events = await fetch(new URL('/events', app.url))
    const reader = events.body!.getReader()
    try {
      const saved = await send(app.url, '/api/selection', 'PUT', { ids: ['help_scout:inbox:121'] })
      expect(saved.status).toBe(200)
      const savedStatus = await asStatus(saved)
      expect(savedStatus.complete).toBe(true)
      expect(savedStatus.selection).toEqual([
        {
          id: 'help_scout:inbox:121',
          integration: 'help_scout',
          label: 'Support',
          detail: 'Help Scout · help@acme.example',
        },
      ])
      expect(await readSseDataFrame(reader)).toContain('changed')
    } finally {
      await reader.cancel()
    }

    const stored = JSON.parse(await readFile(join(app.directory, 'state.json'), 'utf8'))
    expect(stored.selection[0].id).toBe('help_scout:inbox:121')

    app.stop()
    const restarted = createConnectHelpdeskApp({
      directory: app.directory,
      port: 0,
      fetchImpl: duet.fetchImpl,
      env,
    })
    cleanup.push(async () => restarted.stop())
    const status = await asStatus(await fetch(new URL('/api/status', restarted.url)))
    expect(status.complete).toBe(true)
    expect(status.selection[0]!.label).toBe('Support')

    // The grant disappearing must un-complete the app rather than stay green.
    duet.state.connections = []
    const after = await asStatus(
      await fetch(new URL('/api/refresh', restarted.url), { method: 'POST' }),
    )
    expect(after.complete).toBe(false)
    expect(after.selection[0]!.id).toBe('help_scout:inbox:121')
  })

  test('stays honest when the workspace is unreachable', async () => {
    const duet = fakeDuet()
    duet.state.failWhoami = true
    const app = await startHelpdesk(duet)

    const status = await getJson(app.url, '/api/status')
    expect(status.ready).toBe(false)
    expect(status.complete).toBe(false)
  })

  test('serves viewport metadata and event wiring without an in-frame connect control', async () => {
    const app = await startHelpdesk()
    const html = await (await fetch(app.url)).text()
    expect(html).toContain('name="viewport"')
    expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
    expect(html).not.toContain('WebSocket')
    // Connecting lives in the onboarding chat; a button here can only open a
    // stray tab that returns to the app instead of the product.
    expect(html).not.toContain('/api/connect')
    expect(html).not.toContain('window.open')
  })
})

describe('Connect Accounts', () => {
  async function startAccounts(duet = fakeDuet()) {
    const directory = await mkdtemp(join(tmpdir(), 'duet-connect-accounts-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const app = createConnectAccountsApp({ directory, port: 0, fetchImpl: duet.fetchImpl, env })
    cleanup.push(async () => {
      await app.stop()
    })
    return { ...app, directory, duet }
  }

  test('each connected account is one choice, named by its real handle when reachable', async () => {
    const duet = fakeDuet()
    duet.state.connections = [
      { id: 'tw1', integration: 'twitter', status: 'active' },
      { id: 'li1', integration: 'linkedin', status: 'active' },
      { id: 'fb1', integration: 'facebook', status: 'pending' },
    ]
    duet.state.executeResults.set('TWITTER_USER_LOOKUP_ME', {
      data: { id: '99', name: 'Acme', username: 'acmesocial' },
    })
    // LINKEDIN_GET_MY_INFO deliberately not stubbed: the account is still real
    // (the connection exists), so it must be listed under the platform name
    // rather than dropped or given an invented handle.
    const app = await startAccounts(duet)

    const status = await getJson(app.url, '/api/status')
    expect(status.options).toContainEqual({
      id: 'twitter:account:tw1',
      integration: 'twitter',
      label: '@acmesocial',
      detail: 'X (Twitter)',
    })
    expect(status.options).toContainEqual(
      expect.objectContaining({ id: 'linkedin:account:li1', label: 'LinkedIn account' }),
    )
    // A pending connection is not yet an account the agent may post to.
    expect(status.options.some(option => option.id.includes('fb1'))).toBe(false)
    const facebook = status.providers.find(p => p.integration === 'facebook')
    expect(facebook).toMatchObject({ connected: false, status: 'pending' })
  })

  test('completion tracks the chosen account itself, not just the platform', async () => {
    const duet = fakeDuet()
    duet.state.connections = [{ id: 'tw1', integration: 'twitter', status: 'active' }]
    duet.state.executeResults.set('TWITTER_USER_LOOKUP_ME', {
      data: { id: '99', name: 'Acme', username: 'acmesocial' },
    })
    const app = await startAccounts(duet)

    const saved = await send(app.url, '/api/selection', 'PUT', { ids: ['twitter:account:tw1'] })
    expect(saved.status).toBe(200)
    expect((await asStatus(saved)).complete).toBe(true)

    // The chosen account is replaced by a different one on the same platform:
    // the old choice is gone, so the app must not stay green.
    duet.state.connections = [{ id: 'tw2', integration: 'twitter', status: 'active' }]
    const after = await asStatus(await fetch(new URL('/api/refresh', app.url), { method: 'POST' }))
    expect(after.complete).toBe(false)
    expect(after.options).toContainEqual(expect.objectContaining({ id: 'twitter:account:tw2' }))
  })

  test('serves viewport metadata and event wiring without an in-frame connect control', async () => {
    const app = await startAccounts()
    const html = await (await fetch(app.url)).text()
    expect(html).toContain('name="viewport"')
    expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
    expect(html).not.toContain('WebSocket')
    // Connecting lives in the onboarding chat; a button here can only open a
    // stray tab that returns to the app instead of the product.
    expect(html).not.toContain('/api/connect')
    expect(html).not.toContain('window.open')
  })
})

describe('Connect Search Console', () => {
  async function startSearchConsole(duet = fakeDuet()) {
    const directory = await mkdtemp(join(tmpdir(), 'duet-connect-gsc-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const app = createConnectSearchConsoleApp({
      directory,
      port: 0,
      fetchImpl: duet.fetchImpl,
      env,
    })
    cleanup.push(async () => {
      await app.stop()
    })
    return { ...app, directory, duet }
  }

  function connectedDuet() {
    const duet = fakeDuet()
    duet.state.connections = [{ id: 'g1', integration: 'google_search_console', status: 'active' }]
    duet.state.executeResults.set('GOOGLE_SEARCH_CONSOLE_LIST_SITES', {
      siteEntry: [
        { siteUrl: 'sc-domain:acme.example', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://blog.acme.example/', permissionLevel: 'siteFullUser' },
      ],
    })
    return duet
  }

  test('lists the real site properties in plain words once connected', async () => {
    const app = await startSearchConsole(connectedDuet())

    const status = await getJson(app.url, '/api/status')
    expect(status.options).toEqual([
      {
        id: 'google_search_console:site:sc-domain:acme.example',
        integration: 'google_search_console',
        label: 'acme.example',
        detail: 'The whole domain, every page on it',
      },
      {
        id: 'google_search_console:site:https://blog.acme.example/',
        integration: 'google_search_console',
        label: 'https://blog.acme.example/',
        detail: 'Just this address',
      },
    ])
    expect(status.complete).toBe(false)
  })

  test('accepts exactly one property, never several', async () => {
    const app = await startSearchConsole(connectedDuet())

    const both = await send(app.url, '/api/selection', 'PUT', {
      ids: [
        'google_search_console:site:sc-domain:acme.example',
        'google_search_console:site:https://blog.acme.example/',
      ],
    })
    expect(both.status).toBe(400)

    const one = await send(app.url, '/api/selection', 'PUT', {
      ids: ['google_search_console:site:sc-domain:acme.example'],
    })
    expect(one.status).toBe(200)
    const status = await asStatus(one)
    expect(status.complete).toBe(true)
    expect(status.selection).toEqual([
      expect.objectContaining({ id: 'google_search_console:site:sc-domain:acme.example' }),
    ])
  })

  test('a connection whose site list cannot be read stays visibly pending', async () => {
    const duet = fakeDuet()
    duet.state.connections = [{ id: 'g1', integration: 'google_search_console', status: 'active' }]
    // GOOGLE_SEARCH_CONSOLE_LIST_SITES not stubbed: the tool fails upstream.
    const app = await startSearchConsole(duet)

    const status = await getJson(app.url, '/api/status')
    expect(status.providers[0]).toMatchObject({
      integration: 'google_search_console',
      connected: true,
    })
    expect(status.options).toEqual([])
    expect(status.discovery).toContainEqual(
      expect.objectContaining({ integration: 'google_search_console', state: 'failed' }),
    )
    expect(status.complete).toBe(false)
  })

  test('serves viewport metadata and event wiring without an in-frame connect control', async () => {
    const app = await startSearchConsole()
    const html = await (await fetch(app.url)).text()
    expect(html).toContain('name="viewport"')
    expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
    expect(html).not.toContain('WebSocket')
    // Connecting lives in the onboarding chat; a button here can only open a
    // stray tab that returns to the app instead of the product.
    expect(html).not.toContain('/api/connect')
    expect(html).not.toContain('window.open')
  })
})

async function readSseDataFrame(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>,
): Promise<string> {
  const decoder = new TextDecoder()
  let buffered = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('Event stream closed before a data frame arrived')
    buffered += decoder.decode(chunk.value, { stream: true })
    const frames = buffered.split('\n\n')
    buffered = frames.pop() ?? ''
    const data = frames.find(frame => frame.startsWith('data: ') || frame.includes('\ndata: '))
    if (data !== undefined) return `${data}\n\n`
  }
}

type ReposProbe =
  | {
      ok: true
      account?: string
      repos: Array<{ id: string; description?: string; private: boolean; updatedAt?: string }>
    }
  | { ok: false; reason: string }

async function startRepos(probe: () => Promise<ReposProbe>, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'duet-connect-repos-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const calls = { count: 0 }
  const app = createConnectReposApp({
    directory,
    port: 0,
    ...(now === undefined ? {} : { now }),
    probe: async () => {
      calls.count += 1
      return await probe()
    },
  })
  cleanup.push(async () => {
    await app.stop()
  })
  return { ...app, directory, calls }
}

describe('Connect Repos', () => {
  // Its three siblings compute live status on GET, so opening the page tells
  // the truth. This one read stored state only, so a user whose code host was
  // already authorized still met "Not connected yet" and had to press a button
  // to discover the page was wrong about them.
  test('the first read probes the code host instead of reporting stored disconnection', async () => {
    const app = await startRepos(async () => ({
      ok: true,
      account: 'acme-hq',
      repos: [{ id: 'acme/web', private: false }],
    }))

    const state = (await (await fetch(new URL('/api/setup', app.url))).json()) as {
      connection: { status: string; account?: string }
      repos: Array<{ id: string }>
    }
    expect(app.calls.count).toBe(1)
    expect(state.connection).toMatchObject({ status: 'connected', account: 'acme-hq' })
    expect(state.repos.map(repo => repo.id)).toEqual(['acme/web'])
  })

  test('a failed probe is bounded by elapsed time, not latched forever', async () => {
    // The page re-reads on every broadcast, so an unbounded probe would spawn a
    // pair of `gh` subprocesses per ticked checkbox. But a once-ever latch is
    // worse than the storm: a user who authorizes after a failed probe would
    // sit on a stale "Not connected yet" until they pressed a button. The
    // window bounds the subprocesses AND still converges on its own.
    let authorized = false
    let clock = 1_000
    const app = await startRepos(
      async () =>
        authorized
          ? { ok: true, account: 'acme-hq', repos: [{ id: 'acme/web', private: false }] }
          : { ok: false, reason: 'gh_not_authenticated' },
      () => clock,
    )

    await fetch(new URL('/api/setup', app.url))
    expect(app.calls.count).toBe(1)
    clock += 2_000
    await fetch(new URL('/api/setup', app.url))
    expect(app.calls.count).toBe(1)

    // The user authorizes in chat and touches nothing on the page.
    authorized = true
    clock += 15_000
    const state = (await (await fetch(new URL('/api/setup', app.url))).json()) as {
      connection: { status: string }
    }
    expect(app.calls.count).toBe(2)
    expect(state.connection.status).toBe('connected')
  })

  test('a revoked code-host grant clears a previously completed setup', async () => {
    let connected = true
    const app = await startRepos(async () =>
      connected
        ? { ok: true, account: 'acme-hq', repos: [{ id: 'acme/web', private: false }] }
        : { ok: false, reason: 'grant_revoked' },
    )
    await fetch(new URL('/api/setup', app.url))
    await send(app.url, '/api/selection', 'PUT', { repoIds: ['acme/web'] })
    const completed = await send(app.url, '/api/complete', 'POST')
    expect((await completed.json()) as { setup: { complete: boolean } }).toMatchObject({
      setup: { complete: true },
    })

    connected = false
    const refreshed = await send(app.url, '/api/connection/check', 'POST')
    expect((await refreshed.json()) as { setup: { complete: boolean } }).toMatchObject({
      setup: { complete: false },
    })
  })

  test('the page names why the finish button is disabled and what it will not do', async () => {
    const app = await startRepos(async () => ({ ok: false, reason: 'gh_not_authenticated' }))
    const html = await (await fetch(app.url)).text()

    // Its siblings all pair the disabled primary with a reason and close with a
    // read-only promise; the page about source code had neither.
    expect(html).toMatch(/finish-reason|Authorize GitHub first/i)
    expect(html).toMatch(/only read your code|never push/i)
  })
})
