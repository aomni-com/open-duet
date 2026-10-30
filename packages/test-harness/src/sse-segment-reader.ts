export interface SseChunkRecord {
  atMs: number
  bytes: number
  keepalives: number
  ids: number[]
  eventTypes: string[]
}

export interface SseSegmentRecord {
  startedAtIso: string
  status: number
  responseHeaders: Record<string, string>
  ttfbMs: number
  chunks: SseChunkRecord[]
  lifetimeMs: number
  endedBy: string
  terminalSeen: boolean
  lastId: number | undefined
}

export interface SseFrame {
  id: string | undefined
  event: string | undefined
  data: string | undefined
  comments: string[]
}

export class SseFrameParser {
  private buffer = ''

  push(fragment: string): SseFrame[] {
    this.buffer = `${this.buffer}${fragment}`.replaceAll('\r\n', '\n').replace(/\r(?!$)/g, '\n')
    const blocks = this.buffer.split('\n\n')
    this.buffer = blocks.pop() ?? ''
    return blocks.map(parseFrame)
  }
}

export interface ReadSseSegmentOptions {
  url: string
  headers?: HeadersInit
  lastEventId?: number
  capMs: number
  terminalEventTypes?: ReadonlySet<string>
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  onChunk?: (chunk: SseChunkRecord, index: number) => void
  onFrame?: (frame: SseFrame, atMs: number) => void
  onResponse?: (record: SseSegmentRecord) => void
  stopWhenFrame?: (frame: SseFrame) => boolean
  clock?: SseReaderClock
  signal?: AbortSignal
}

export interface SseReaderClock {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const RECORDED_RESPONSE_HEADERS = [
  'server',
  'x-vercel-id',
  'content-type',
  'cache-control',
  'transfer-encoding',
  'x-matched-path',
] as const

export async function readSseSegment(options: ReadSseSegmentOptions): Promise<SseSegmentRecord> {
  const clock: SseReaderClock = options.clock ?? {
    now: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const controller = new AbortController()
  let resolveStop!: (reason: 'probe_cap' | 'aborted') => void
  const stopReached = new Promise<'probe_cap' | 'aborted'>(resolve => {
    resolveStop = resolve
  })
  const capTimer = clock.setTimeout(() => {
    controller.abort(new Error('probe cap reached'))
    resolveStop('probe_cap')
  }, options.capMs)
  const abort = (): void => {
    controller.abort(options.signal?.reason)
    resolveStop('aborted')
  }
  if (options.signal?.aborted === true) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const requestedAt = clock.now()
  const requestHeaders = new Headers(options.headers)
  requestHeaders.set('accept', 'text/event-stream')
  if (options.lastEventId !== undefined) {
    requestHeaders.set('last-event-id', String(options.lastEventId))
  }
  const record: SseSegmentRecord = {
    startedAtIso: new Date(requestedAt).toISOString(),
    status: 0,
    responseHeaders: {},
    ttfbMs: -1,
    chunks: [],
    lifetimeMs: -1,
    endedBy: 'unknown',
    terminalSeen: false,
    lastId: options.lastEventId,
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      headers: requestHeaders,
      signal: controller.signal,
    })
    record.status = response.status
    for (const name of RECORDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value !== null) record.responseHeaders[name] = value
    }
    options.onResponse?.(record)
    if (response.status !== 200 || response.body === null) {
      record.endedBy = `http_${response.status}`
      return record
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseFrameParser()
    for (;;) {
      const outcome = await Promise.race([
        reader
          .read()
          .then(chunk => ({ kind: 'chunk' as const, chunk }))
          .catch(error => ({ kind: 'error' as const, error })),
        stopReached.then(reason => ({ kind: 'stop' as const, reason })),
      ])
      if (outcome.kind === 'stop') {
        record.endedBy = outcome.reason
        void reader.cancel().catch(() => undefined)
        break
      }
      if (outcome.kind === 'error') {
        record.endedBy = controller.signal.aborted
          ? options.signal?.aborted === true
            ? 'aborted'
            : 'probe_cap'
          : `read_error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
        break
      }
      const { chunk } = outcome
      const atMs = clock.now() - requestedAt
      if (record.ttfbMs === -1) record.ttfbMs = atMs
      if (chunk.done) {
        record.endedBy = 'clean_close'
        break
      }

      const frames = parser.push(decoder.decode(chunk.value, { stream: true }))
      const ids: number[] = []
      const eventTypes: string[] = []
      let keepalives = 0
      let matchedFrame = false
      for (const frame of frames) {
        options.onFrame?.(frame, atMs)
        if (options.stopWhenFrame?.(frame) === true) matchedFrame = true
        const id = Number(frame.id)
        if (frame.id !== undefined && Number.isFinite(id)) ids.push(id)
        if (frame.event !== undefined) eventTypes.push(frame.event)
        keepalives += frame.comments.filter(comment => comment.startsWith('keepalive')).length
      }
      if (ids.length > 0) record.lastId = ids.at(-1)
      if (eventTypes.some(type => options.terminalEventTypes?.has(type) === true)) {
        record.terminalSeen = true
      }
      const chunkRecord: SseChunkRecord = {
        atMs,
        bytes: chunk.value.byteLength,
        keepalives,
        ids,
        eventTypes,
      }
      record.chunks.push(chunkRecord)
      options.onChunk?.(chunkRecord, record.chunks.length - 1)
      if (matchedFrame) {
        record.endedBy = 'matched_frame'
        await reader.cancel().catch(() => undefined)
        break
      }
      if (record.terminalSeen) {
        record.endedBy = 'terminal_event'
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    record.lifetimeMs = clock.now() - requestedAt
    return record
  } finally {
    clock.clearTimeout(capTimer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function sseKeepaliveGaps(segment: SseSegmentRecord): number[] {
  const arrivals = segment.chunks.filter(chunk => chunk.keepalives > 0).map(chunk => chunk.atMs)
  const gaps: number[] = []
  for (let index = 1; index < arrivals.length; index += 1) {
    gaps.push(arrivals[index]! - arrivals[index - 1]!)
  }
  return gaps
}

function parseFrame(block: string): SseFrame {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []
  const comments: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).replace(/^ /, ''))
      continue
    }
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'id') id = value
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }
  return { id, event, data: data.length > 0 ? data.join('\n') : undefined, comments }
}
