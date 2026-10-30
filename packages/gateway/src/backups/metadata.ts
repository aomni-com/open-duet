import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentEventImageSchema,
  AgentSessionTimelineEventSchema,
  isTranscriptEvent,
  BackupCapturePageSchema,
  type BackupCapturePage,
  type BackupCaptureRequest,
  type BackupWarning,
  type BackupCaptureRecord,
} from '@repo/contract'

import type { BackupRecord } from './archive'

type MetadataOptions = {
  page: (query: BackupCaptureRequest, signal: AbortSignal) => Promise<BackupCapturePage>
  cutoff: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  signal?: AbortSignal
  /** An existing temporary directory outside Drive. Defaults to the OS temp root. */
  scratchDir?: string
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

async function readPage(
  options: MetadataOptions,
  query: BackupCaptureRequest,
  signal: AbortSignal,
) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  requestSignal.throwIfAborted()
  return BackupCapturePageSchema.parse(
    await abortable(options.page(query, requestSignal), requestSignal),
  )
}

async function* responseBytes(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader()
  let done = false
  try {
    while (true) {
      const next = await abortable(reader.read(), signal)
      if (next.done) {
        done = true
        return
      }
      yield next.value
    }
  } finally {
    if (!done) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function* fileBody(path: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path, { signal })) yield chunk
}

async function* pages(
  options: MetadataOptions,
  base: Omit<BackupCaptureRequest, 'cursor'>,
  signal: AbortSignal,
) {
  let cursor: string | null = null
  do {
    signal.throwIfAborted()
    const query: BackupCaptureRequest = { ...base, cursor }
    const page = await readPage(options, query, signal)
    if (page.nextCursor !== null && page.nextCursor === cursor)
      throw new Error('Capture cursor did not advance')
    yield { query, page }
    cursor = page.nextCursor
  } while (cursor !== null)
}

export async function* workspaceMetadataEntries(
  options: MetadataOptions,
): AsyncGenerator<BackupRecord> {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), 'duet-backup-metadata-'))
  try {
    const groups: Array<{ path: string; collections: BackupCaptureRequest['collection'][] }> = [
      { path: 'settings.json', collections: ['settings'] },
      { path: 'agents.ndjson', collections: ['agents'] },
      { path: 'apps.ndjson', collections: ['apps'] },
      { path: 'integrations.ndjson', collections: ['toolkitPolicies', 'mcpServers', 'providers'] },
    ]
    for (const group of groups) {
      const path = join(scratch, 'category')
      const sink = await open(path, 'w', 0o600)
      let records = 0
      try {
        for (const collection of group.collections) {
          for await (const { page } of pages(
            options,
            { collection, cutoff: options.cutoff },
            signal,
          )) {
            yield* page.warnings
            for (const record of page.records) {
              if (group.path === 'settings.json' && records > 0)
                throw new Error('Multiple settings records')
              await sink.writeFile(JSON.stringify(record) + '\n', { signal })
              records++
            }
          }
        }
      } finally {
        await sink.close()
      }
      if (group.path === 'settings.json' && records === 0)
        yield {
          code: 'incomplete_collection',
          path: 'workspace/settings.json',
          detail: 'Workspace settings unavailable',
        }
      else yield { path: `workspace/${group.path}`, body: fileBody(path, signal), mode: 0o600 }
      await rm(path)
    }
    for await (const { page } of pages(
      options,
      { collection: 'sessions', cutoff: options.cutoff },
      signal,
    )) {
      yield* page.warnings
      for (const record of page.records) {
        if (record.kind !== 'session') throw new Error('Invalid session capture page')
        yield* sessionEntries(options, record, scratch, signal)
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function* textBody(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text)
}

function transcript(record: Extract<BackupCaptureRecord, { kind: 'event' }>): string {
  const parsed = AgentSessionTimelineEventSchema.safeParse(record.event)
  let title = typeof record.event.type === 'string' ? record.event.type : 'Event'
  let body = '```json\n' + JSON.stringify(record.event, null, 2) + '\n```'
  if (parsed.success) {
    const event = parsed.data
    if (!isTranscriptEvent(event) || event.type === 'session_created') return ''
    if (
      event.type === 'prompt_submitted' ||
      event.type === 'note_submitted' ||
      event.type === 'answer_submitted'
    ) {
      title =
        event.sender.kind === 'system'
          ? 'System'
          : `${event.sender.kind} (${Object.values(event.sender)[1]})`
      body =
        event.type === 'prompt_submitted'
          ? event.prompt
          : event.type === 'note_submitted'
            ? event.note
            : event.answer
    } else if (event.type === 'agent_message') {
      title = 'Assistant'
      body = event.message
    } else if (
      event.type === 'step' &&
      (event.step.type === 'text' || event.step.type === 'reasoning')
    ) {
      title = event.step.type === 'text' ? 'Assistant' : 'Reasoning'
      body = event.step.text
    }
  }
  if (Array.isArray(record.event.images)) {
    for (const image of record.event.images) {
      if (typeof image === 'object' && image !== null && typeof image.archivePath === 'string')
        body += `\n\n![Image](${image.archivePath})`
    }
  }
  return `## ${title} — event ${record.seq}\n\n${body}\n\n`
}

async function* sessionEntries(
  options: MetadataOptions,
  session: Extract<BackupCaptureRecord, { kind: 'session' }>,
  scratch: string,
  signal: AbortSignal,
): AsyncGenerator<BackupRecord> {
  const local = join(scratch, 'session')
  await mkdir(local)
  const path = `workspace/sessions/${Buffer.from(session.key).toString('base64url')}`
  try {
    yield {
      path: `${path}/session.json`,
      body: textBody(JSON.stringify(session) + '\n'),
      mode: 0o600,
      mtime: session.updatedAt,
    }
    for await (const { query, page } of pages(
      options,
      { collection: 'images', cutoff: session.capturedAt, sessionId: session.key },
      signal,
    )) {
      yield* page.warnings
      for (const record of page.records) {
        if (record.kind !== 'image' || record.sessionKey !== session.key)
          throw new Error('Invalid image capture page')
        yield* imageEntry(options, record, query, path, local, signal)
      }
    }
    const eventsPath = join(local, 'events')
    const transcriptPath = join(local, 'transcript')
    const events = await open(eventsPath, 'w', 0o600)
    try {
      const readable = await open(transcriptPath, 'w', 0o600)
      try {
        await readable.writeFile(
          `# ${session.title}\n\nCaptured through event ${session.eventCeiling}.\n\n`,
          { signal },
        )
        for await (const { page } of pages(
          options,
          {
            collection: 'events',
            cutoff: options.cutoff,
            sessionId: session.key,
            ceiling: session.eventCeiling,
          },
          signal,
        )) {
          yield* page.warnings
          for (const record of page.records) {
            if (record.kind !== 'event') throw new Error('Invalid event capture page')
            const annotated = await annotateImages(record, local)
            yield* annotated.warnings
            await events.writeFile(JSON.stringify(annotated.record) + '\n', { signal })
            await readable.writeFile(transcript(annotated.record), { signal })
          }
        }
      } finally {
        await readable.close()
      }
    } finally {
      await events.close()
    }
    yield { path: `${path}/events.ndjson`, body: fileBody(eventsPath, signal), mode: 0o600 }
    yield { path: `${path}/transcript.md`, body: fileBody(transcriptPath, signal), mode: 0o600 }
  } finally {
    await rm(local, { recursive: true, force: true })
  }
}

type ImageRecord = Extract<BackupCaptureRecord, { kind: 'image' }>
const imageExtensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const
const imageMarker = (local: string, storageId: string) =>
  join(local, `image-${Buffer.from(storageId).toString('base64url')}.json`)

async function* imageEntry(
  options: MetadataOptions,
  original: ImageRecord,
  query: BackupCaptureRequest,
  archiveDir: string,
  local: string,
  signal: AbortSignal,
): AsyncGenerator<BackupRecord> {
  const target = join(local, 'image-bytes')
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  try {
    let image = original
    let response = await abortable(
      (options.fetch ?? fetch)(image.sourceUrl, { signal: requestSignal }),
      requestSignal,
    )
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {})
      const refreshed = await readPage(options, query, requestSignal)
      yield* refreshed.warnings
      const replacement = refreshed.records.find(
        record =>
          record.kind === 'image' &&
          record.storageId === image.storageId &&
          record.sessionKey === image.sessionKey,
      )
      if (!replacement || replacement.kind !== 'image') throw new Error('Image unavailable')
      image = replacement
      response = await abortable(
        (options.fetch ?? fetch)(image.sourceUrl, { signal: requestSignal }),
        requestSignal,
      )
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Image unavailable')
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (mime && mime !== image.mimeType) {
      void response.body.cancel().catch(() => {})
      throw new Error('Image MIME changed')
    }
    const sink = await open(target, 'w', 0o600)
    let bytes = 0
    try {
      for await (const chunk of responseBytes(response.body, requestSignal)) {
        requestSignal.throwIfAborted()
        bytes += chunk.byteLength
        if (bytes > image.bytes) throw new Error('Image size changed')
        await sink.writeFile(chunk, { signal: requestSignal })
      }
    } finally {
      await sink.close()
    }
    if (bytes !== image.bytes) throw new Error('Image size changed')
    const relative = `images/${Buffer.from(image.storageId).toString('base64url')}.${imageExtensions[image.mimeType]}`
    yield { path: `${archiveDir}/${relative}`, body: fileBody(target, signal), mode: 0o600 }
    await writeFile(imageMarker(local, image.storageId), JSON.stringify(relative), {
      mode: 0o600,
      signal,
    })
  } catch {
    signal.throwIfAborted()
    yield {
      code: 'missing_image',
      recordKey: original.storageId,
      detail: 'Image bytes unavailable or changed during capture',
    }
  } finally {
    await rm(target, { force: true })
  }
}

async function annotateImages(
  record: Extract<BackupCaptureRecord, { kind: 'event' }>,
  local: string,
) {
  const warnings: BackupWarning[] = []
  if (!Array.isArray(record.event.images)) return { record, warnings }
  const images = []
  for (const image of record.event.images) {
    const parsed = AgentEventImageSchema.safeParse(image)
    if (!parsed.success) {
      images.push(image)
      continue
    }
    try {
      const archivePath = JSON.parse(
        await readFile(imageMarker(local, parsed.data.storageId), 'utf8'),
      ) as string
      images.push({ ...image, archivePath })
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      images.push(image)
      warnings.push({
        code: 'missing_image',
        recordKey: parsed.data.storageId,
        detail: 'Captured event image is unavailable',
      })
    }
  }
  return { record: { ...record, event: { ...record.event, images } }, warnings }
}
