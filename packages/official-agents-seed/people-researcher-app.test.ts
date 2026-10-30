import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDossierBoardApp } from './content/agents/people-researcher/apps/dossier-board/server'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(stop => stop()))
  const failures = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'App fixture cleanup failed')
})

const IDENTITY = {
  profileUrl: 'https://www.linkedin.com/in/jordan-hale',
  confirmedBy: 'profile-url',
}

describe('Dossier Board', () => {
  test('keeps a researched person, their roles, and their email verdict across a restart', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/people', 'POST', {
      name: 'Jordan Hale',
      company: 'Northstar Systems',
      domain: 'northstar.example',
    })

    const saved = await request(fixture.url, '/api/people/jordan-hale/dossier', 'PUT', {
      identity: IDENTITY,
      title: 'VP of Engineering',
      roles: [
        { title: 'VP of Engineering', company: 'Northstar Systems', start: '2022-03' },
        {
          title: 'Director of Platform',
          company: 'Previous Corp',
          start: '2019-07',
          end: '2022-02',
        },
      ],
      email: {
        status: 'found',
        address: 'jordan.hale@northstar.example',
        verification: 'DELIVERABLE',
        retrievedAt: '2026-08-13',
      },
    })
    expect(saved.status).toBe(200)

    fixture.stop()
    const restarted = createDossierBoardApp({ directory: fixture.directory, port: 0 })
    cleanup.push(async () => restarted.stop())
    const { people } = (await (await fetch(new URL('/api/people', restarted.url))).json()) as {
      people: Array<Record<string, unknown>>
    }
    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({
      id: 'jordan-hale',
      identity: IDENTITY,
      email: { address: 'jordan.hale@northstar.example', verification: 'DELIVERABLE' },
      phone: { state: 'idle' },
    })
    // Newest-first order is the reading order of the one-pager, so it is data,
    // not presentation: the board stores what it was given.
    expect((people[0]!.roles as Array<{ company: string }>).map(role => role.company)).toEqual([
      'Northstar Systems',
      'Previous Corp',
    ])
  })

  test('refuses a dossier with no confirmed identity and an email with no provider verdict', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/people', 'POST', { name: 'Jordan Hale' })

    const anonymous = await request(fixture.url, '/api/people/jordan-hale/dossier', 'PUT', {
      roles: [{ title: 'VP of Engineering', company: 'Northstar Systems' }],
    })
    expect(anonymous.status).toBe(400)
    expect(((await anonymous.json()) as { error: string }).error).toContain('profile URL')

    const unverified = await request(fixture.url, '/api/people/jordan-hale/dossier', 'PUT', {
      identity: IDENTITY,
      email: { status: 'found', address: 'jordan@northstar.example', retrievedAt: '2026-08-13' },
    })
    expect(unverified.status).toBe(400)
    expect(((await unverified.json()) as { error: string }).error).toContain(
      'provider verification',
    )

    const unfound = await request(fixture.url, '/api/people/jordan-hale/dossier', 'PUT', {
      identity: IDENTITY,
      email: { status: 'unfound', retrievedAt: '2026-08-13', note: 'FullEnrich returned nothing.' },
    })
    expect(unfound.status).toBe(200)
    expect((await unfound.json()) as { person: { email: unknown } }).toMatchObject({
      person: { email: { status: 'unfound', note: 'FullEnrich returned nothing.' } },
    })
  })

  test('spends one phone lookup on request and records the number it came back with', async () => {
    const provider = createProvider({ number: '+14155551234', region: 'US' })
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/people', 'POST', {
      name: 'Jordan Hale',
      company: 'Northstar Systems',
    })

    const accepted = await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
    expect(accepted.status).toBe(202)
    expect((await accepted.json()) as { person: { phone: unknown } }).toMatchObject({
      person: { phone: { state: 'enriching' } },
    })

    await fixture.app.settled()
    const person = await readPerson(fixture.url, 'jordan-hale')
    expect(person.phone).toMatchObject({ state: 'found', number: '+14155551234', region: 'US' })

    // The button's whole reason to exist is that a phone is the dear field:
    // it must be asked for alone, once, and never bundled with the rest.
    expect(provider.started).toHaveLength(1)
    expect(provider.started[0]!.data[0]!.enrich_fields).toEqual(['contact.phones'])
    expect(provider.started[0]!.data).toHaveLength(1)
  })

  test('a second click while a lookup is running is refused rather than paid for twice', async () => {
    const provider = createProvider({ number: '+14155551234' })
    let releaseProvider!: () => void
    const providerReleased = new Promise<void>(resolve => {
      releaseProvider = resolve
    })
    const fetchProvider = provider.fetch
    provider.fetch = async (input, init) => {
      await providerReleased
      return fetchProvider(input, init)
    }
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/people', 'POST', {
      name: 'Jordan Hale',
      company: 'Northstar Systems',
    })

    await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
    try {
      const second = await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
      expect(second.status).toBe(409)
    } finally {
      releaseProvider()
    }

    await fixture.app.settled()
    expect(provider.started).toHaveLength(1)
  })

  test('a finished lookup that returns no number is unfound, not failed', async () => {
    const provider = createProvider({})
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/people', 'POST', {
      name: 'Jordan Hale',
      company: 'Northstar Systems',
    })

    await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
    await fixture.app.settled()

    const person = await readPerson(fixture.url, 'jordan-hale')
    expect(person.phone).toMatchObject({ state: 'unfound' })
    expect(person.phone).not.toHaveProperty('reason')
  })

  test('an upstream refusal is reported as a failure in the user’s words', async () => {
    const provider = createProvider({ status: 'CREDITS_INSUFFICIENT' })
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/people', 'POST', {
      name: 'Jordan Hale',
      company: 'Northstar Systems',
    })

    await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
    await fixture.app.settled()

    const person = await readPerson(fixture.url, 'jordan-hale')
    expect(person.phone).toMatchObject({
      state: 'failed',
      reason: 'The phone lookup service is out of credit.',
    })
  })

  test('a person with neither a profile URL nor an employer never reaches the provider', async () => {
    const provider = createProvider({ number: '+14155551234' })
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/people', 'POST', { name: 'Jordan Hale' })

    const refused = await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
    expect(refused.status).toBe(409)
    expect(provider.started).toHaveLength(0)
    expect((await readPerson(fixture.url, 'jordan-hale')).phone).toEqual({ state: 'idle' })
  })

  test('a photo is stored with the profile it came from and served back as an image', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/people', 'POST', { name: 'Jordan Hale' })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const anonymous = await fetch(new URL('/api/people/jordan-hale/avatar?source=x', fixture.url), {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    })
    expect(anonymous.status).toBe(400)

    const stored = await fetch(
      new URL('/api/people/jordan-hale/avatar?source=x&from=https://x.com/jordanhale', fixture.url),
      { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes },
    )
    expect(stored.status).toBe(200)
    expect((await stored.json()) as { person: { avatar: unknown } }).toMatchObject({
      person: {
        avatar: { source: 'x', sourceUrl: 'https://x.com/jordanhale', contentType: 'image/png' },
      },
    })

    const served = await fetch(new URL('/api/people/jordan-hale/avatar', fixture.url))
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes)
  })

  test('rewriting the dossier keeps the photo and the phone number already paid for', async () => {
    const provider = createProvider({ number: '+14155551234' })
    const fixture = await startFixture({ provider })
    await request(fixture.url, '/api/people', 'POST', {
      name: 'Jordan Hale',
      company: 'Northstar Systems',
    })
    await fetch(
      new URL(
        '/api/people/jordan-hale/avatar?source=linkedin&from=https://www.linkedin.com/in/jordan-hale',
        fixture.url,
      ),
      { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([1, 2, 3]) },
    )
    await request(fixture.url, '/api/people/jordan-hale/phone', 'POST')
    await fixture.app.settled()

    // The paid fields travel with the person, not with the dossier, so a
    // rewrite that names them anyway must not be able to reach them.
    await request(fixture.url, '/api/people/jordan-hale/dossier', 'PUT', {
      identity: IDENTITY,
      summary: 'Owns platform engineering.',
      phone: { state: 'idle' },
      avatar: { source: 'x', sourceUrl: 'https://x.com/someone-else', contentType: 'image/png' },
    })

    const person = await readPerson(fixture.url, 'jordan-hale')
    expect(person.phone).toMatchObject({ state: 'found', number: '+14155551234' })
    expect(person.avatar).toMatchObject({ source: 'linkedin' })
    expect(person.summary).toBe('Owns platform engineering.')
  })
})

type StartedEnrichment = {
  data: Array<{ enrich_fields: string[]; linkedin_url?: string; company_name?: string }>
}

type ProviderScript = {
  number?: string
  region?: string
  /** Upstream enrichment status; defaults to FINISHED. */
  status?: string
}

function createProvider(script: ProviderScript) {
  const started: StartedEnrichment[] = []
  return {
    started,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const path = url.pathname
      if (path.endsWith('/contact/enrich/bulk') && init?.method === 'POST') {
        started.push(JSON.parse(String(init.body)) as StartedEnrichment)
        return Response.json({ enrichment_id: 'enrichment-1' })
      }
      if (path.includes('/contact/enrich/bulk/')) {
        return Response.json({
          status: script.status ?? 'FINISHED',
          data: [
            {
              contact_info:
                script.number === undefined
                  ? {}
                  : { most_probable_phone: { number: script.number, region: script.region } },
            },
          ],
        })
      }
      throw new Error(`Unexpected provider request: ${path}`)
    },
  }
}

async function startFixture(options: { provider?: ReturnType<typeof createProvider> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dossier-board-'))
  let app: ReturnType<typeof createDossierBoardApp> | undefined
  cleanup.push(async () => {
    app?.stop()
    await rm(directory, { recursive: true, force: true })
  })
  app = createDossierBoardApp({
    directory,
    port: 0,
    env: { DUET_API_URL: 'https://duet.test', DUET_APP_API_KEY: 'duet_app_test' },
    ...(options.provider === undefined ? {} : { fetchImpl: options.provider.fetch }),
    pollIntervalMs: 0,
    timeoutMs: 500,
  })
  const running = app
  return { app: running, url: running.url, directory, stop: () => running.stop() }
}

async function readPerson(url: URL, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/api/people/${id}`, url))
  return ((await response.json()) as { person: Record<string, unknown> }).person
}

async function request(url: URL, pathname: string, method: string, body?: unknown) {
  return await fetch(new URL(pathname, url), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
