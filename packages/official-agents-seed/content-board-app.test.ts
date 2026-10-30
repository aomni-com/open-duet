import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createContentBoard } from './content/agents/seo-specialist/apps/content-board/server'
import { officialSeedAgents } from './manifest'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const errors: unknown[] = []
  for (const stop of cleanup.splice(0).reverse()) {
    try {
      await stop()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Content Board fixture cleanup failed')
})

describe('Content Board', () => {
  test('serves the full recorded markdown artifact', async () => {
    const fixture = await startFixture()
    const artifact =
      '# Verdict: NEW\n\n| Signal | Value |\n| --- | --- |\n| Demand | **Strong** |\n'
    const artifactDirectory = join(fixture.directory, 'seo', 'answer-engine-optimization')
    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(join(artifactDirectory, 'opportunity.md'), artifact)

    const response = await fetch(
      new URL('/api/artifact?path=seo/answer-engine-optimization/opportunity.md', fixture.url),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await response.text()).toBe(artifact)
  })

  test('refuses paths that climb out of the artifact directory', async () => {
    const fixture = await startFixture()
    await writeFile(join(fixture.directory, 'outside.md'), 'not public')

    const response = await fetch(new URL('/api/artifact?path=seo/../outside.md', fixture.url))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({ error: 'invalid_path' }))
  })

  test('resolves the drive-relative agent folder provided by the platform', async () => {
    const packageDirectory = dirname(fileURLToPath(import.meta.url))
    const agentDirectory = await mkdtemp(join(packageDirectory, '.content-board-agent-'))
    cleanup.push(() => rm(agentDirectory, { recursive: true, force: true }))
    const artifactDirectory = join(agentDirectory, 'seo', 'example')
    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(join(artifactDirectory, 'opportunity.md'), '# Portable artifact\n')
    const directory = await mkdtemp(join(tmpdir(), 'duet-content-board-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const app = createContentBoard({
      directory,
      env: {
        DUET_APP_DIR: 'content/agents/seo-specialist/apps/content-board',
        DUET_AGENT_DIR: basename(agentDirectory),
      },
      port: 0,
    })
    cleanup.push(async () => {
      await app.stop()
    })

    const response = await fetch(new URL('/api/artifact?path=seo/example/opportunity.md', app.url))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('# Portable artifact\n')
  })

  test('refuses to guess an agent directory before the platform provides one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'duet-content-board-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const app = createContentBoard({ directory, env: {}, port: 0 })
    cleanup.push(async () => {
      await app.stop()
    })

    const response = await fetch(new URL('/api/artifact?path=seo/example/opportunity.md', app.url))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: 'agent_directory_unavailable' }),
    )
  })

  test('announces API changes over the event stream', async () => {
    const fixture = await startFixture()
    const events = await fetch(new URL('/events', fixture.url))
    expect(events.status).toBe(200)
    expect(events.headers.get('content-type')).toBe('text/event-stream')

    const reader = events.body!.getReader()
    try {
      const decoder = new TextDecoder()
      expect(decoder.decode((await reader.read()).value)).toContain(': connected')

      const created = await request(fixture.url, '/api/cards', 'POST', {
        slug: 'answer-engine-optimization',
        title: 'What is answer engine optimization?',
      })
      expect(created.status).toBe(201)

      const eventFrame = decoder.decode((await reader.read()).value)
      expect(eventFrame).toContain('"type":"card.created"')
      expect(eventFrame).toContain('"slug":"answer-engine-optimization"')
    } finally {
      await reader.cancel()
    }
  })

  test('requires a passing verdict before an opportunity advances and persists accepted work', async () => {
    const fixture = await startFixture()
    await request(fixture.url, '/api/cards', 'POST', {
      slug: 'answer-engine-optimization',
      title: 'What is answer engine optimization?',
    })

    const rejected = await request(fixture.url, '/api/cards/answer-engine-optimization', 'PATCH', {
      stage: 'keywords',
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual(expect.objectContaining({ error: 'verdict_required' }))

    const accepted = await request(fixture.url, '/api/cards/answer-engine-optimization', 'PATCH', {
      verdict: 'new',
      stage: 'keywords',
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      card: expect.objectContaining({
        slug: 'answer-engine-optimization',
        title: 'What is answer engine optimization?',
        stage: 'keywords',
        verdict: 'new',
      }),
    })

    const boardResponse = await fetch(new URL('/api/board', fixture.url))
    const board = (await boardResponse.json()) as { cards: unknown[] }
    expect(board.cards).toEqual([
      expect.objectContaining({
        slug: 'answer-engine-optimization',
        stage: 'keywords',
        verdict: 'new',
      }),
    ])

    await fixture.stop()
    const restarted = createContentBoard({ directory: fixture.directory, port: 0 })
    cleanup.push(async () => restarted.stop())
    const persistedResponse = await fetch(new URL('/api/board', restarted.url))
    const persisted = (await persistedResponse.json()) as { cards: unknown[] }
    expect(persisted.cards).toEqual([
      expect.objectContaining({
        slug: 'answer-engine-optimization',
        title: 'What is answer engine optimization?',
        stage: 'keywords',
        verdict: 'new',
      }),
    ])
  })

  test('declares the platform permissions its review actions require', () => {
    const contentBoard = officialSeedAgents
      .find(agent => agent.slug === 'seo-specialist')
      ?.apps?.find(app => app.slug === 'content-board')
    expect(contentBoard?.apiScopes).toEqual(expect.arrayContaining(['agents', 'sessions']))
  })

  test('sends review feedback to the owning agent default session', async () => {
    const platformRequests: Array<{ url: URL; init?: RequestInit }> = []
    const fixture = await startPlatformFixture(platformRequests)
    await createReviewCard(fixture.url)

    const response = await request(fixture.url, '/api/cards/article-one/feedback', 'POST', {
      message: 'Please tighten the opening and keep the table.',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const message = platformRequests.find(entry =>
      entry.url.pathname.endsWith('/sessions/default/messages'),
    )
    expect(message?.url.pathname).toBe(
      '/v1/ws/david-workspace/agents/seo-specialist/sessions/default/messages',
    )
    expect(message?.init?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer duet_app_test' }),
    )
    expect(JSON.parse(String(message?.init?.body))).toEqual({
      behavior: 'steer',
      prompt: expect.stringContaining('Please tighten the opening and keep the table.'),
    })
  })

  test('advances a review only after its approval reaches the owning agent', async () => {
    const platformRequests: Array<{ url: URL; init?: RequestInit }> = []
    const fixture = await startPlatformFixture(platformRequests)
    await createReviewCard(fixture.url)

    const response = await request(fixture.url, '/api/cards/article-one/advance', 'POST', {})

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      card: expect.objectContaining({ slug: 'article-one', stage: 'publish' }),
    })
    const message = platformRequests.find(entry =>
      entry.url.pathname.endsWith('/sessions/default/messages'),
    )
    expect(JSON.parse(String(message?.init?.body))).toEqual({
      behavior: 'steer',
      prompt: expect.stringContaining('Approved. Continue to publish preparation.'),
    })
  })

  test('keeps a review card in place when approval delivery fails', async () => {
    const fixture = await startPlatformFixture([], { failMessages: true })
    await createReviewCard(fixture.url)

    const response = await request(fixture.url, '/api/cards/article-one/advance', 'POST', {})

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual(expect.objectContaining({ error: 'feedback_failed' }))
    const card = await fetch(new URL('/api/cards/article-one', fixture.url)).then(value =>
      value.json(),
    )
    expect(card).toEqual({ card: expect.objectContaining({ stage: 'review' }) })
  })

  test('rejects board input outside the human review gate', async () => {
    const platformRequests: Array<{ url: URL; init?: RequestInit }> = []
    const fixture = await startPlatformFixture(platformRequests)
    await request(fixture.url, '/api/cards', 'POST', { slug: 'article-one', title: 'Article one' })

    const feedback = await request(fixture.url, '/api/cards/article-one/feedback', 'POST', {
      message: 'Continue.',
    })
    const advance = await request(fixture.url, '/api/cards/article-one/advance', 'POST', {})

    expect(feedback.status).toBe(409)
    expect(advance.status).toBe(409)
    expect(platformRequests).toHaveLength(0)
  })
})

async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'duet-content-board-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const app = createContentBoard({ directory, agentDirectory: directory, port: 0 })
  cleanup.push(async () => {
    await app.stop()
  })
  return { ...app, directory }
}

async function startPlatformFixture(
  requests: Array<{ url: URL; init?: RequestInit }>,
  options: { failMessages?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'duet-content-board-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const app = createContentBoard({
    directory,
    agentDirectory: directory,
    port: 0,
    env: {
      DUET_API_URL: 'https://duet.test',
      DUET_APP_API_KEY: 'duet_app_test',
      DUET_AGENT_DIR: 'agents/seo-specialist',
    },
    fetchImpl: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      requests.push({ url, init })
      if (url.pathname === '/v1/whoami') {
        return Response.json({ workspaces: [{ slug: 'david-workspace' }] })
      }
      if (url.pathname === '/v1/ws/david-workspace/agents') {
        return Response.json({
          items: [{ slug: 'seo-specialist', anchorPath: 'agents/seo-specialist' }],
          nextCursor: null,
        })
      }
      if (url.pathname.endsWith('/sessions/default/messages')) {
        return options.failMessages
          ? Response.json({ message: 'The agent is unavailable.' }, { status: 502 })
          : Response.json({ sessionId: 'session-default', inputSeq: 1 }, { status: 202 })
      }
      throw new Error(`Unexpected platform request: ${url.pathname}`)
    },
  })
  cleanup.push(async () => {
    await app.stop()
  })
  return { ...app, directory }
}

async function createReviewCard(url: URL): Promise<void> {
  await request(url, '/api/cards', 'POST', {
    slug: 'article-one',
    title: 'Article one',
    verdict: 'new',
  })
  await request(url, '/api/cards/article-one', 'PATCH', { stage: 'review' })
}

async function request(url: URL, path: string, method: string, body: unknown): Promise<Response> {
  return await fetch(new URL(path, url), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
