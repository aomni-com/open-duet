import {
  AGENT_SESSION_EVENT_TYPES,
  SessionEventStreamFrameSchema,
  type SessionSnapshot,
} from '@repo/contract'

export type SessionStreamHandle = { close(): void }
type SessionStreamFetch = (input: string, init: RequestInit) => Promise<Response>

export function openSessionEventStream(args: {
  workspaceSlug: string
  sessionId: SessionSnapshot['id']
  afterSeq?: number
  onFrame: (frame: ReturnType<typeof SessionEventStreamFrameSchema.parse>) => void
  onError: (event: Event) => void
  fetchImpl?: SessionStreamFetch
}): SessionStreamHandle {
  const abort = new AbortController()
  let closed = false
  const path = `/api/duet/ws/${encodeURIComponent(args.workspaceSlug)}/agent/sessions/${encodeURIComponent(args.sessionId)}/events`
  const headers = new Headers({ accept: 'text/event-stream' })
  if (args.afterSeq !== undefined) headers.set('last-event-id', String(args.afterSeq))

  void consumeSessionEventStream(args.fetchImpl ?? fetch, path, headers, abort.signal, args.onFrame)
    .then(() => {
      if (!closed) args.onError(new Event('error'))
    })
    .catch(() => {
      if (!closed) args.onError(new Event('error'))
    })

  return {
    close() {
      if (closed) return
      closed = true
      abort.abort()
    },
  }
}

async function consumeSessionEventStream(
  fetchImpl: SessionStreamFetch,
  path: string,
  headers: Headers,
  signal: AbortSignal,
  onFrame: (frame: ReturnType<typeof SessionEventStreamFrameSchema.parse>) => void,
): Promise<void> {
  const response = await fetchImpl(path, { headers, signal })
  if (!response.ok || response.body === null)
    throw new Error(`session stream HTTP ${response.status}`)
  const reader = response.body.getReader()
  const cancelReader = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', cancelReader, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      while (true) {
        const boundary = nextEventBoundary(buffer)
        if (boundary === null) break
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        receiveEventBlock(block, onFrame)
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader)
    void reader.cancel().catch(() => undefined)
  }
}

function nextEventBoundary(buffer: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
  return match === null ? null : { index: match.index, length: match[0].length }
}

function receiveEventBlock(
  block: string,
  onFrame: (frame: ReturnType<typeof SessionEventStreamFrameSchema.parse>) => void,
): void {
  let eventType = 'message'
  const data: string[] = []
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const rawValue = separator < 0 ? '' : line.slice(separator + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') eventType = value
    else if (field === 'data') data.push(value)
  }
  if (!(AGENT_SESSION_EVENT_TYPES as readonly string[]).includes(eventType) || data.length === 0)
    return
  try {
    const parsed = SessionEventStreamFrameSchema.safeParse(JSON.parse(data.join('\n')))
    if (parsed.success) onFrame(parsed.data)
  } catch {
    // A malformed optional frame cannot poison the durable reconnect stream.
  }
}
