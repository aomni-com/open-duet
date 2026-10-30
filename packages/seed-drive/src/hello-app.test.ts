import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHelloApp } from '../content/welcome/hello-app/server'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(stop => stop()))
  const failures = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'Hello app cleanup failed')
})

describe('seeded hello app', () => {
  test('the page owns task state through the API and one live event source', async () => {
    const fixture = await startFixture()

    const response = await fetch(fixture.url)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toMatch(
      /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"\s*\/?>/,
    )
    expect(html).not.toContain('<a ')
    expect(html).toContain('<script type="module">')
    expect(html).toContain("fetch('/api/tasks')")
    expect(html.match(/new EventSource\('\/events'\)/g)).toHaveLength(1)
    expect(html).not.toContain('WebSocket')
  })

  test('empty task reads create no store', async () => {
    const fixture = await startFixture()

    const response = await fetch(new URL('/api/tasks', fixture.url))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tasks: [] })
    expect(await Bun.file(join(fixture.directory, 'tasks.json')).exists()).toBe(false)
  })

  test('the first valid post creates and returns one persisted task', async () => {
    const fixture = await startFixture()

    const response = await fetch(new URL('/api/tasks', fixture.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Read the example' }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      task: { id: string; title: string; createdAt: number }
    }
    expect(body.task.title).toBe('Read the example')
    expect(body.task.id).not.toBe('')
    expect(body.task.createdAt).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(join(fixture.directory, 'tasks.json'), 'utf8'))).toEqual({
      tasks: [body.task],
    })
    expect(await readdir(fixture.directory)).toEqual(['tasks.json'])
  })

  test('a malformed post returns 400 without mutating persisted tasks', async () => {
    const fixture = await startFixture()
    await postTask(fixture.url, 'Keep this task')
    const before = await readFile(join(fixture.directory, 'tasks.json'), 'utf8')

    const response = await fetch(new URL('/api/tasks', fixture.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Title must be between 1 and 160 characters.' })
    expect(await readFile(join(fixture.directory, 'tasks.json'), 'utf8')).toBe(before)
  })

  test('task titles are trimmed and bounded at 160 characters', async () => {
    const fixture = await startFixture()

    const accepted = await postTask(fixture.url, `  ${'a'.repeat(160)}  `)
    const rejected = await postTask(fixture.url, 'b'.repeat(161))

    expect(accepted.status).toBe(201)
    expect(((await accepted.json()) as { task: { title: string } }).task.title).toBe(
      'a'.repeat(160),
    )
    expect(rejected.status).toBe(400)
    const stored = JSON.parse(await readFile(join(fixture.directory, 'tasks.json'), 'utf8')) as {
      tasks: Array<{ title: string }>
    }
    expect(stored.tasks.map(task => task.title)).toEqual(['a'.repeat(160)])
  })

  test('tasks survive a server restart and folder rename', async () => {
    const fixture = await startFixture()
    const created = (await (await postTask(fixture.url, 'Persist across restart')).json()) as {
      task: { id: string; title: string; createdAt: number }
    }
    fixture.stop()

    const renamedDirectory = `${fixture.directory}-renamed`
    await rename(fixture.directory, renamedDirectory)
    cleanup.push(async () => rm(renamedDirectory, { recursive: true, force: true }))
    const restarted = createHelloApp({ directory: renamedDirectory, port: 0 })
    cleanup.push(async () => restarted.stop())

    const response = await fetch(new URL('/api/tasks', restarted.url))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tasks: [created.task] })
  })

  test('concurrent posts preserve every committed task', async () => {
    const fixture = await startFixture()

    const responses = await Promise.all(
      ['Alpha', 'Beta', 'Gamma', 'Delta'].map(title => postTask(fixture.url, title)),
    )
    expect(responses.map(response => response.status)).toEqual([201, 201, 201, 201])

    const response = await fetch(new URL('/api/tasks', fixture.url))
    const body = (await response.json()) as { tasks: Array<{ title: string }> }
    expect(body.tasks.map(task => task.title).toSorted()).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ])
  })

  test('the event stream is uncacheable and emits only after a task commits', async () => {
    const fixture = await startFixture()
    const events = await fetch(new URL('/events', fixture.url))

    expect(events.status).toBe(200)
    expect(events.headers.get('content-type')).toBe('text/event-stream')
    expect(events.headers.get('cache-control')).toBe('no-cache')

    const reader = events.body!.getReader()
    try {
      const createRequest = postTask(fixture.url, 'Stream this task')
      const frame = await readSseDataFrame(reader)
      const announced = JSON.parse(
        frame
          .split('\n')
          .find(line => line.startsWith('data: '))!
          .slice('data: '.length),
      ) as { task: { id: string; title: string; createdAt: number } }
      const persisted = JSON.parse(
        await readFile(join(fixture.directory, 'tasks.json'), 'utf8'),
      ) as {
        tasks: Array<{ id: string }>
      }
      const created = (await (await createRequest).json()) as {
        task: { id: string; title: string; createdAt: number }
      }

      expect(announced).toEqual({ task: created.task })
      expect(frame.startsWith(`id: ${created.task.id}\n`)).toBe(true)
      expect(persisted.tasks.map(task => task.id)).toContain(announced.task.id)
      await reader.cancel()
    } finally {
      await reader.cancel()
    }
  })

  test('event-stream cancel and request abort release their watchers', async () => {
    const fixture = await startFixture()

    const canceledResponse = await fixture.fetch(new Request(new URL('/events', fixture.url).href))
    expect(fixture.watcherCount()).toBe(1)
    await canceledResponse.body!.cancel()
    await waitFor(() => fixture.watcherCount() === 0)

    const abortController = new AbortController()
    const abortedResponse = await fixture.fetch(
      new Request(new URL('/events', fixture.url).href, {
        signal: abortController.signal,
      }),
    )
    expect(fixture.watcherCount()).toBe(1)
    try {
      abortController.abort()
      await waitFor(() => fixture.watcherCount() === 0)
    } finally {
      await abortedResponse.body!.cancel().catch(() => undefined)
    }
  })
})

async function postTask(url: URL, title: string): Promise<Response> {
  return await fetch(new URL('/api/tasks', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
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
    const dataFrame = frames.find(frame => frame.includes('\ndata: '))
    if (dataFrame !== undefined) return `${dataFrame}\n\n`
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await Bun.sleep(5)
  }
}

async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'duet-hello-app-'))
  let app: ReturnType<typeof createHelloApp>
  try {
    app = createHelloApp({ directory, port: 0 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  cleanup.push(async () => {
    app.stop()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...app, directory }
}
