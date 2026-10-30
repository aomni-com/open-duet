import assert from 'node:assert/strict'

import { readSseSegment, type SseReaderClock, type SseSegmentRecord } from './sse-segment-reader.ts'

const DEFAULT_SEGMENT_CAP_MS = 330_000
const DEFAULT_RECONNECT_CAP_MS = 30_000
const DEFAULT_REQUEST_CAP_MS = 30_000

export interface AppHttpContractEvidence {
  apiWriteStatus: number
  apiReadStatus: number
  eventsStatus: number
  eventsContentType: string | null
  firstFrameMs: number
  segmentLifetimeMs: number
  reconnectGapMs: number
}

export async function proveAppHttpContract(options: {
  appUrl: string
  taskTitle: string
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  clock?: SseReaderClock
  segmentCapMs?: number
  reconnectCapMs?: number
  requestCapMs?: number
}): Promise<AppHttpContractEvidence> {
  const fetchImpl = options.fetchImpl ?? fetch
  const segmentCapMs = options.segmentCapMs ?? DEFAULT_SEGMENT_CAP_MS
  const reconnectCapMs = options.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS
  const requestCapMs = options.requestCapMs ?? DEFAULT_REQUEST_CAP_MS
  const now = options.clock?.now ?? Date.now
  const eventsUrl = new URL('/events', withTrailingSlash(options.appUrl)).toString()
  const tasksUrl = new URL('/api/tasks', withTrailingSlash(options.appUrl)).toString()
  const abort = new AbortController()
  const responseReady = deferred<SseSegmentRecord>()
  const firstDataFrame = deferred<number>()
  let taskPostedAt: number | undefined
  let firstSegment: Promise<SseSegmentRecord> | undefined

  try {
    firstSegment = readSseSegment({
      url: eventsUrl,
      capMs: segmentCapMs,
      fetchImpl,
      clock: options.clock,
      signal: abort.signal,
      onResponse: responseReady.resolve,
      onFrame: frame => {
        if (taskPostedAt !== undefined && frame.data !== undefined) {
          firstDataFrame.resolve(now() - taskPostedAt)
        }
      },
    })
    void firstSegment.catch(responseReady.reject)

    const events = await within(responseReady.promise, requestCapMs, 'SSE response headers')
    const eventsContentType = events.responseHeaders['content-type'] ?? null
    assert.equal(events.status, 200, `events endpoint returned HTTP ${events.status}`)
    assert.equal(
      mediaType(eventsContentType),
      'text/event-stream',
      `events endpoint content-type was ${eventsContentType ?? '(unset)'}`,
    )

    taskPostedAt = now()
    const writeResponse = await fetchImpl(tasksUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: options.taskTitle }),
      signal: AbortSignal.timeout(requestCapMs),
    })
    assert.equal(writeResponse.status, 201, `task POST returned HTTP ${writeResponse.status}`)
    const firstFrameMs = await within(firstDataFrame.promise, requestCapMs, 'post-write SSE frame')

    const readResponse = await fetchImpl(tasksUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(requestCapMs),
    })
    assert.equal(readResponse.status, 200, `task GET returned HTTP ${readResponse.status}`)
    const tasks = (await readResponse.json()) as unknown
    assert(
      containsString(tasks, options.taskTitle),
      'task GET did not contain the unique task written through the public host',
    )

    const segment = await firstSegment
    assert.equal(
      segment.endedBy,
      'clean_close',
      `first SSE segment ended by ${segment.endedBy}, not the public edge clean close`,
    )

    const reconnected = await readSseSegment({
      url: eventsUrl,
      capMs: reconnectCapMs,
      fetchImpl,
      clock: options.clock,
      signal: abort.signal,
      stopWhenFrame: () => true,
    })
    assert.equal(
      reconnected.status,
      200,
      `reconnected events endpoint returned HTTP ${reconnected.status}`,
    )
    assert.equal(
      mediaType(reconnected.responseHeaders['content-type'] ?? null),
      'text/event-stream',
      'reconnected events endpoint stopped serving SSE',
    )
    assert(
      reconnected.ttfbMs >= 0 && reconnected.endedBy === 'matched_frame',
      `reconnected SSE produced no frame within ${reconnectCapMs}ms`,
    )

    return {
      apiWriteStatus: writeResponse.status,
      apiReadStatus: readResponse.status,
      eventsStatus: events.status,
      eventsContentType,
      firstFrameMs,
      segmentLifetimeMs: segment.lifetimeMs,
      reconnectGapMs: reconnected.ttfbMs,
    }
  } finally {
    abort.abort()
    await firstSegment?.catch(() => undefined)
  }
}

function mediaType(contentType: string | null): string | null {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? null
}

function containsString(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (Array.isArray(value)) return value.some(row => containsString(row, expected))
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(row => containsString(row, expected))
  }
  return false
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

async function within<T>(promise: Promise<T>, capMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${capMs}ms`)), capMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
