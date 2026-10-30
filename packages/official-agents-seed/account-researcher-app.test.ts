import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccountBoardApp } from './content/agents/account-researcher/apps/account-board/server'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(stop => stop()))
  const failures = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'App fixture cleanup failed')
})

describe('Account Board', () => {
  test('creates an account through HTTP and persists it across a restart', async () => {
    const fixture = await startFixture()

    const created = await request(fixture.url, '/api/accounts', 'POST', {
      name: 'Northstar Systems',
      domain: 'northstar.example',
    })
    expect(created.status).toBe(201)
    const account = (await created.json()) as {
      account: { id: string; name: string; status: string }
    }
    expect(account.account).toMatchObject({
      id: 'northstar-systems',
      name: 'Northstar Systems',
      status: 'queued',
    })

    fixture.stop()
    const restarted = createAccountBoardApp({ directory: fixture.directory, port: 0 })
    cleanup.push(async () => restarted.stop())
    const response = await fetch(new URL('/api/accounts', restarted.url))
    expect(await response.json()).toEqual({ accounts: [expect.objectContaining(account.account)] })
  })

  test('rejects unsupported dossier facts and preserves explicit unfound fields', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/accounts', 'POST', { name: 'Acme' })

    const unsupported = await request(fixture.url, '/api/accounts/acme/dossier', 'PUT', {
      facts: [{ label: 'Headcount', status: 'found', value: '1,200', retrievedAt: '2026-08-09' }],
    })
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toEqual({
      error: 'Every found fact requires a value, source URL, and retrieval date.',
    })

    const dossier = {
      facts: [
        {
          label: 'Headcount',
          status: 'unfound',
          retrievedAt: '2026-08-09',
          note: 'Crustdata and the company site returned no current figure.',
        },
        {
          label: 'Funding',
          status: 'found',
          value: '$20M Series B',
          retrievedAt: '2026-08-09',
          source: { title: 'Acme announces Series B', url: 'https://acme.example/news/series-b' },
        },
      ],
    }
    const accepted = await request(fixture.url, '/api/accounts/acme/dossier', 'PUT', dossier)
    expect(accepted.status).toBe(200)
    const body = (await accepted.json()) as { account: { dossier: typeof dossier } }
    expect(body.account.dossier).toEqual(dossier)

    const stored = JSON.parse(await readFile(join(fixture.directory, 'accounts.json'), 'utf8'))
    expect(stored.accounts[0].dossier.facts[0].status).toBe('unfound')
    expect(stored.accounts[0].dossier.facts[0]).not.toHaveProperty('value')
  })

  test('stores seller views and announces only committed changes over SSE', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/accounts', 'POST', { name: 'Acme' })
    const events = await fixture.fetch(new Request(new URL('/events', fixture.url).href))
    const reader = events.body!.getReader()
    const originalRename = filesystem.rename
    let releaseCommit!: () => void
    let enteredCommit!: () => void
    const commitReleased = new Promise<void>(resolve => {
      releaseCommit = resolve
    })
    const commitEntered = new Promise<void>(resolve => {
      enteredCommit = resolve
    })
    const rename = spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === join(fixture.directory, 'accounts.json')) {
        enteredCommit()
        await commitReleased
      }
      return originalRename(from, to)
    })
    let announced = false
    const nextFrame = readSseDataFrame(reader).then(frame => {
      announced = true
      return frame
    })
    let mutation: Promise<Response> | undefined
    try {
      mutation = fixture.fetch(
        new Request(new URL('/api/accounts/acme/views/battlecard', fixture.url).href, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'battlecard',
            title: 'Acme Battlecard',
            content: '## Key pain points\n\nUnfound — no supported pain point was retrieved.',
            generatedAt: '2026-08-09',
          }),
        }),
      )
      await commitEntered
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(announced).toBe(false)
      releaseCommit()
      const frame = await nextFrame
      const stored = JSON.parse(await readFile(join(fixture.directory, 'accounts.json'), 'utf8'))
      expect(stored.accounts[0].views).toEqual([
        expect.objectContaining({ id: 'battlecard', type: 'battlecard', title: 'Acme Battlecard' }),
      ])
      expect(frame).toContain('"accountId":"acme"')
      expect(frame).toContain('"resource":"view"')
      expect((await mutation).status).toBe(200)
    } finally {
      releaseCommit()
      try {
        if (mutation) await mutation
      } finally {
        rename.mockRestore()
        await reader.cancel()
        await nextFrame.catch(() => undefined)
      }
    }
  })

  test('refuses a recommended contact with no reason to be on the list', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/accounts', 'POST', { name: 'Acme' })

    const nameless = await request(fixture.url, '/api/accounts/acme/contacts', 'PUT', {
      contacts: [
        {
          id: 'jordan-hale',
          name: 'Jordan Hale',
          title: 'VP of Engineering',
          profileUrl: 'https://www.linkedin.com/in/jordan-hale',
        },
      ],
    })
    expect(nameless.status).toBe(400)
    expect(((await nameless.json()) as { error: string }).error).toContain(
      'why they are on the list',
    )

    const accepted = await request(fixture.url, '/api/accounts/acme/contacts', 'PUT', {
      contacts: [
        {
          id: 'jordan-hale',
          name: 'Jordan Hale',
          title: 'VP of Engineering',
          profileUrl: 'https://www.linkedin.com/in/jordan-hale',
          reason: 'Owns the platform team named in the Series B hiring plan [E-002].',
          email: {
            status: 'found',
            address: 'jordan.hale@acme.example',
            verification: 'DELIVERABLE',
            retrievedAt: '2026-08-13',
          },
        },
      ],
    })
    expect(accepted.status).toBe(200)
    const { account } = (await accepted.json()) as {
      account: { contacts: Array<{ id: string; phone: unknown }> }
    }
    expect(account.contacts).toHaveLength(1)
    expect(account.contacts[0]).toMatchObject({
      id: 'jordan-hale',
      email: { address: 'jordan.hale@acme.example', verification: 'DELIVERABLE' },
      phone: { state: 'idle' },
    })
  })

  test('looks up one contact’s phone on request and keeps it when the set is rewritten', async () => {
    const provider = createProvider('+14155559876')
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/accounts', 'POST', { name: 'Acme', domain: 'acme.example' })
    const contact = {
      id: 'jordan-hale',
      name: 'Jordan Hale',
      title: 'VP of Engineering',
      profileUrl: 'https://www.linkedin.com/in/jordan-hale',
      reason: 'Owns the platform team named in the hiring plan [E-002].',
    }
    await request(fixture.url, '/api/accounts/acme/contacts', 'PUT', { contacts: [contact] })

    const accepted = await fetch(
      new URL('/api/accounts/acme/contacts/jordan-hale/phone', fixture.url),
      { method: 'POST' },
    )
    expect(accepted.status).toBe(202)
    await fixture.settled()

    const enriched = await readContacts(fixture.url)
    expect(enriched[0]!.phone).toMatchObject({ state: 'found', number: '+14155559876' })
    expect(provider.started[0]!.data[0]!.enrich_fields).toEqual(['contact.phones'])

    // Re-ranking the buying group must not throw away the lookup the user
    // already paid for on somebody who is still on the list.
    await request(fixture.url, '/api/accounts/acme/contacts', 'PUT', {
      contacts: [
        { ...contact, reason: 'Still the platform owner, now with a dated quote [E-004].' },
      ],
    })
    const rewritten = await readContacts(fixture.url)
    expect(rewritten[0]!.phone).toMatchObject({ state: 'found', number: '+14155559876' })
    expect(rewritten[0]!.reason).toContain('dated quote')
    expect(provider.started).toHaveLength(1)
  })

  test('serves the board document with viewport metadata and API/event wiring', async () => {
    const fixture = await startFixture()
    const response = await fetch(fixture.url)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('name="viewport"')
    expect(html).toContain("fetch('/api/accounts')")
    expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
    expect(html).not.toContain('WebSocket')
  })
})

async function startFixture(options: { provider?: ReturnType<typeof createProvider> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'duet-account-board-'))
  let app: ReturnType<typeof createAccountBoardApp> | undefined
  cleanup.push(async () => {
    app?.stop()
    await rm(directory, { recursive: true, force: true })
  })
  app = createAccountBoardApp({
    directory,
    port: 0,
    env: { DUET_API_URL: 'https://duet.test', DUET_APP_API_KEY: 'duet_app_test' },
    ...(options.provider === undefined ? {} : { fetchImpl: options.provider.fetch }),
    pollIntervalMs: 0,
    timeoutMs: 500,
  })
  return { ...app, directory }
}

/** The FullEnrich edge, controlled: one started enrichment, one number back. */
function createProvider(number: string) {
  const started: Array<{ data: Array<{ enrich_fields: string[] }> }> = []
  return {
    started,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname.endsWith('/contact/enrich/bulk') && init?.method === 'POST') {
        started.push(JSON.parse(String(init.body)) as { data: Array<{ enrich_fields: string[] }> })
        return Response.json({ enrichment_id: 'enrichment-1' })
      }
      if (!url.pathname.includes('/contact/enrich/bulk/'))
        throw new Error(`Unexpected provider request: ${url.pathname}`)
      return Response.json({
        status: 'FINISHED',
        data: [{ contact_info: { most_probable_phone: { number, region: 'US' } } }],
      })
    },
  }
}

async function readContacts(
  url: URL,
): Promise<Array<{ id: string; reason: string; phone: Record<string, unknown> }>> {
  const response = await fetch(new URL('/api/accounts/acme', url))
  const body = (await response.json()) as {
    account: { contacts: Array<{ id: string; reason: string; phone: Record<string, unknown> }> }
  }
  return body.account.contacts
}

async function request(url: URL, path: string, method: string, body: unknown): Promise<Response> {
  return await fetch(new URL(path, url), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

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
