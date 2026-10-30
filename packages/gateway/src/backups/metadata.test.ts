import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BackupCapturePage, BackupCaptureRequest, BackupWarning } from '@repo/contract'

import type { BackupRecord } from './archive'
import { workspaceMetadataEntries } from './metadata'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), 'metadata-test-'))
  roots.push(path)
  return path
}
async function consume(records: AsyncIterable<BackupRecord>) {
  const files = new Map<string, Uint8Array>()
  const warnings: BackupWarning[] = []
  for await (const record of records) {
    if ('code' in record) warnings.push(record)
    else {
      const chunks: Uint8Array[] = []
      for await (const chunk of record.body) chunks.push(chunk)
      files.set(record.path, Buffer.concat(chunks))
    }
  }
  return { files, warnings, text: (path: string) => new TextDecoder().decode(files.get(path)) }
}
const empty: BackupCapturePage = { records: [], warnings: [], nextCursor: null }
const defaultPage = (query: BackupCaptureRequest): BackupCapturePage =>
  query.collection === 'settings'
    ? { ...empty, records: [{ kind: 'settings', name: 'Source', slug: 'source' }] }
    : empty

test('portable category files page through all records, preserve policies and static tokens, and clean temporary state', async () => {
  const scratchDir = await scratch()
  const page = async (query: BackupCaptureRequest): Promise<BackupCapturePage> => {
    expect(query.cutoff).toBe(123)
    if (query.collection === 'settings')
      return {
        ...empty,
        records: [{ kind: 'settings', name: 'Source', slug: 'source', purpose: 'Build' }],
      }
    if (query.collection === 'agents')
      return {
        ...empty,
        records: [
          {
            kind: 'agent',
            key: query.cursor ?? 'first',
            path: 'agents/helper',
            slug: 'helper',
            disabled: false,
          },
        ],
        nextCursor: query.cursor ? null : 'second',
      }
    if (query.collection === 'toolkitPolicies')
      return {
        ...empty,
        records: [{ kind: 'toolkitPolicy', toolkitSlug: 'github', allowedAgentIds: [] }],
      }
    if (query.collection === 'mcpServers')
      return {
        ...empty,
        records: [
          {
            kind: 'mcpServer',
            key: 'server',
            name: 'server',
            label: 'Server',
            url: 'https://example.com/mcp',
            authKind: 'static',
            token: 'portable-secret',
            reconnectRequired: false,
          },
        ],
        warnings: [{ code: 'disappeared', recordKey: 'missing', detail: 'Unavailable source' }],
      }
    return defaultPage(query)
  }
  const result = await consume(workspaceMetadataEntries({ page, cutoff: 123, scratchDir }))
  expect(JSON.parse(result.text('workspace/settings.json'))).toMatchObject({
    name: 'Source',
    purpose: 'Build',
  })
  expect(
    result
      .text('workspace/agents.ndjson')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).key),
  ).toEqual(['first', 'second'])
  expect(result.text('workspace/apps.ndjson')).toBe('')
  const integrations = result
    .text('workspace/integrations.ndjson')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(integrations).toEqual([
    { kind: 'toolkitPolicy', toolkitSlug: 'github', allowedAgentIds: [] },
    {
      kind: 'mcpServer',
      key: 'server',
      name: 'server',
      label: 'Server',
      url: 'https://example.com/mcp',
      authKind: 'static',
      token: 'portable-secret',
      reconnectRequired: false,
    },
  ])
  expect(result.warnings).toEqual([
    { code: 'disappeared', recordKey: 'missing', detail: 'Unavailable source' },
  ])
  expect(await readdir(scratchDir)).toEqual([])
})

const sessionRecord = {
  kind: 'session' as const,
  key: '../hidden/child',
  title: 'Hidden child',
  prompt: 'Initial prompt',
  createdAt: 1,
  updatedAt: 2,
  agentKey: 'root',
  archived: true,
  visible: false,
  eventCeiling: 9,
  capturedAt: 222,
}
const sessionPath = `workspace/sessions/${Buffer.from(sessionRecord.key).toString('base64url')}`

test('one bounded event capture produces full history and readable transcripts without child-task duplication', async () => {
  const scratchDir = await scratch()
  let firstRead = true
  const page = async (query: BackupCaptureRequest): Promise<BackupCapturePage> => {
    if (query.collection === 'sessions') return { ...empty, records: [sessionRecord] }
    if (query.collection === 'images') {
      expect(query.cutoff).toBe(222)
      expect(query.sessionId).toBe(sessionRecord.key)
      return empty
    }
    if (query.collection !== 'events') return empty
    expect(query.ceiling).toBe(9)
    expect(query.sessionId).toBe(sessionRecord.key)
    const initial = firstRead ? 'captured words' : 'changed live words'
    if (query.cursor === null) {
      firstRead = false
      return {
        ...empty,
        nextCursor: 'tail',
        records: [
          {
            kind: 'event',
            sessionKey: sessionRecord.key,
            seq: 1,
            createdAt: 1,
            event: {
              type: 'prompt_submitted',
              prompt: initial,
              inputKind: 'initial',
              behavior: 'steer',
              sender: { kind: 'user', userId: 'opaque-user' },
            },
          },
          {
            kind: 'event',
            sessionKey: sessionRecord.key,
            seq: 3,
            createdAt: 3,
            event: { type: 'task_output', taskId: 't1', chunk: 'task plumbing' },
          },
          {
            kind: 'event',
            sessionKey: sessionRecord.key,
            seq: 5,
            createdAt: 5,
            event: {
              type: 'step',
              origin: { taskId: 't1' },
              step: { type: 'text', text: 'child duplicate' },
            },
          },
        ],
      }
    }
    return {
      ...empty,
      records: [
        {
          kind: 'event',
          sessionKey: sessionRecord.key,
          seq: 7,
          createdAt: 7,
          event: {
            type: 'step',
            step: { type: 'text', text: 'A full response\n\nwith **Markdown**' },
          },
        },
        {
          kind: 'event',
          sessionKey: sessionRecord.key,
          seq: 9,
          createdAt: 9,
          event: { type: 'complete', status: 'completed' },
        },
      ],
    }
  }
  const result = await consume(workspaceMetadataEntries({ page, cutoff: 123, scratchDir }))
  expect(JSON.parse(result.text(`${sessionPath}/session.json`))).toMatchObject({
    key: sessionRecord.key,
    archived: true,
    visible: false,
    eventCeiling: 9,
  })
  const events = result
    .text(`${sessionPath}/events.ndjson`)
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(events.map(row => row.seq)).toEqual([1, 3, 5, 7, 9])
  expect(events[1].event.chunk).toBe('task plumbing')
  const transcript = result.text(`${sessionPath}/transcript.md`)
  expect(transcript).toContain('captured words')
  expect(transcript).toContain('opaque-user')
  expect(transcript).toContain('A full response\n\nwith **Markdown**')
  expect(transcript).not.toContain('task plumbing')
  expect(transcript).not.toContain('child duplicate')
  expect(transcript).not.toContain('changed live words')
  expect(await readdir(scratchDir)).toEqual([])
})

test('images contain fetched bytes, expired sources refresh once, and events link only to archive paths', async () => {
  const scratchDir = await scratch()
  let imagePage = 0
  const image = {
    kind: 'image' as const,
    sessionKey: sessionRecord.key,
    storageId: 'image/key',
    mimeType: 'image/png' as const,
    bytes: 4,
    sourceUrl: 'https://source.example/expired-secret',
  }
  const page = async (query: BackupCaptureRequest): Promise<BackupCapturePage> => {
    if (query.collection === 'sessions') return { ...empty, records: [sessionRecord] }
    if (query.collection === 'images') {
      imagePage++
      return {
        ...empty,
        records: [
          {
            ...image,
            sourceUrl: imagePage === 1 ? image.sourceUrl : 'https://source.example/fresh-secret',
          },
        ],
      }
    }
    if (query.collection === 'events')
      return {
        ...empty,
        records: [
          {
            kind: 'event',
            sessionKey: sessionRecord.key,
            seq: 1,
            createdAt: 1,
            event: {
              type: 'note_submitted',
              note: 'Look here',
              sender: { kind: 'system' },
              images: [
                { storageId: image.storageId, mimeType: image.mimeType, bytes: image.bytes },
              ],
            },
          },
        ],
      }
    return defaultPage(query)
  }
  const result = await consume(
    workspaceMetadataEntries({
      page,
      cutoff: 123,
      scratchDir,
      fetch: async url =>
        url.endsWith('expired-secret')
          ? new Response(null, { status: 403 })
          : new Response(new Uint8Array([0, 42, 255, 11]), {
              headers: { 'content-type': 'image/png' },
            }),
    }),
  )
  const relative = `images/${Buffer.from(image.storageId).toString('base64url')}.png`
  expect(result.files.get(`${sessionPath}/${relative}`)).toEqual(new Uint8Array([0, 42, 255, 11]))
  expect(JSON.parse(result.text(`${sessionPath}/events.ndjson`)).event.images[0]).toEqual({
    storageId: image.storageId,
    mimeType: 'image/png',
    bytes: 4,
    archivePath: relative,
  })
  expect(result.text(`${sessionPath}/transcript.md`)).toContain(`](${relative})`)
  expect(
    [...result.files.values()].map(value => new TextDecoder().decode(value)).join('\n'),
  ).not.toContain('source.example')
  expect(result.warnings).toEqual([])
  expect(await readdir(scratchDir)).toEqual([])
})

test('a non-advancing cursor fails explicitly and removes its spool', async () => {
  const scratchDir = await scratch()
  let pages = 0
  const records = workspaceMetadataEntries({
    cutoff: 123,
    scratchDir,
    page: async () => {
      if (++pages > 3) throw new Error('Fixture stopped an endless loop')
      return { ...empty, nextCursor: 'stuck' }
    },
  })
  await expect(consume(records)).rejects.toThrow('Capture cursor did not advance')
  expect(await readdir(scratchDir)).toEqual([])
})

test('cancellation interrupts an outstanding capture request and removes its open spool', async () => {
  const scratchDir = await scratch()
  const controller = new AbortController()
  let release: (() => void) | undefined
  const entered = new Promise<void>(resolve => {
    release = resolve
  })
  const stopped = new Error('User cancelled capture')
  let finish: ((page: BackupCapturePage) => void) | undefined
  const pending = consume(
    workspaceMetadataEntries({
      cutoff: 123,
      scratchDir,
      signal: controller.signal,
      page: () => {
        release!()
        return new Promise<BackupCapturePage>(resolve => {
          finish = resolve
        })
      },
    }),
  )
  await entered
  controller.abort(stopped)
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    pending.then(
      () => 'completed',
      error => error,
    ),
    new Promise<string>(resolve => {
      timer = setTimeout(() => resolve('still pending'), 500)
    }),
  ])
  clearTimeout(timer)
  finish!(empty)
  await pending.catch(() => {})
  expect(result).toBe(stopped)
  expect(await readdir(scratchDir)).toEqual([])
})

test('truncated or unregistered image references remain explicit omissions, never successful image files', async () => {
  const scratchDir = await scratch()
  const image = {
    kind: 'image' as const,
    sessionKey: sessionRecord.key,
    storageId: 'truncated',
    mimeType: 'image/png' as const,
    bytes: 4,
    sourceUrl: 'https://source.example/image',
  }
  const page = async (query: BackupCaptureRequest): Promise<BackupCapturePage> => {
    if (query.collection === 'sessions') return { ...empty, records: [sessionRecord] }
    if (query.collection === 'images') return { ...empty, records: [image] }
    if (query.collection === 'events')
      return {
        ...empty,
        records: [
          {
            kind: 'event',
            sessionKey: sessionRecord.key,
            seq: 1,
            createdAt: 1,
            event: {
              type: 'note_submitted',
              note: 'Source content survives',
              sender: { kind: 'system' },
              images: ['truncated', 'unregistered'].map(storageId => ({
                storageId,
                mimeType: 'image/png',
                bytes: 4,
              })),
            },
          },
        ],
      }
    return defaultPage(query)
  }
  const result = await consume(
    workspaceMetadataEntries({
      page,
      cutoff: 123,
      scratchDir,
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }),
    }),
  )
  expect(
    result.files.has(`${sessionPath}/images/${Buffer.from('truncated').toString('base64url')}.png`),
  ).toBeFalse()
  expect(result.warnings.map(warning => warning.recordKey)).toContain('truncated')
  expect(result.warnings.map(warning => warning.recordKey)).toContain('unregistered')
  expect(JSON.parse(result.text(`${sessionPath}/events.ndjson`)).event.images).toEqual(
    ['truncated', 'unregistered'].map(storageId => ({
      storageId,
      mimeType: 'image/png',
      bytes: 4,
    })),
  )
  expect(result.text(`${sessionPath}/transcript.md`)).toContain('Source content survives')
  expect(await readdir(scratchDir)).toEqual([])
})

test('an unavailable settings record yields a warning instead of invalid settings JSON', async () => {
  const scratchDir = await scratch()
  const result = await consume(
    workspaceMetadataEntries({ cutoff: 123, scratchDir, page: async () => empty }),
  )
  expect(result.files.has('workspace/settings.json')).toBeFalse()
  expect(result.warnings).toEqual([
    {
      code: 'incomplete_collection',
      path: 'workspace/settings.json',
      detail: 'Workspace settings unavailable',
    },
  ])
})

test('an expired image URL that remains denied is omitted after one refresh', async () => {
  const scratchDir = await scratch()
  let fetches = 0
  const page = async (query: BackupCaptureRequest): Promise<BackupCapturePage> => {
    if (query.collection === 'sessions') return { ...empty, records: [sessionRecord] }
    if (query.collection === 'images')
      return {
        ...empty,
        records: [
          {
            kind: 'image',
            sessionKey: sessionRecord.key,
            storageId: 'denied',
            mimeType: 'image/png',
            bytes: 4,
            sourceUrl: 'https://source.example/denied',
          },
        ],
      }
    return defaultPage(query)
  }
  const result = await consume(
    workspaceMetadataEntries({
      cutoff: 123,
      scratchDir,
      page,
      fetch: async () => {
        if (++fetches > 3) throw new Error('Fixture stopped repeated refresh')
        return new Response(null, { status: 403 })
      },
    }),
  )
  expect(result.warnings).toEqual([
    {
      code: 'missing_image',
      recordKey: 'denied',
      detail: 'Image bytes unavailable or changed during capture',
    },
  ])
  expect(fetches).toBe(2)
  expect(await readdir(scratchDir)).toEqual([])
})
