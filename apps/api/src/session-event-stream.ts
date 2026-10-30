import type { ConvexHttpClient } from 'convex/browser'

import { CONVEX_EVENT_BUDGET_BYTES } from '@repo/contract'

import { raceWithAbort } from './abort'
import type { GatewayClient } from './gateway/client'
import { fnQuery } from './shared'

const FALLBACK_POLL_MS = 15_000
const HINT_REFRESH_MS = 250
const MAX_HINT_FRAME_BYTES = CONVEX_EVENT_BUDGET_BYTES + 64 * 1024

type DurableEvent = { seq: number; event: unknown; createdAt: number }
type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<unknown>
}

export function createSessionEventStream(args: {
  convex: ConvexHttpClient
  internalKey: string
  gatewayClient: Pick<GatewayClient, 'openAgentSessionHints'>
  workspaceSlug: string
  workspaceId: string
  sessionId: string
  afterSeq: number
  pollMs?: number
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const abort = new AbortController()
  let cursor = args.afterSeq
  let cancelled = false
  let closed = false
  let durable: DurableEvent[] = []
  let hintReader: ByteReader | null = null
  // Whether the gateway hint channel may be opened. A connect that failed or a
  // body that ended waits out one fallback interval — the runner may simply
  // not have spawned yet — and is then retried. Only a frame the stream cannot
  // trust (oversized) turns hints off for the rest of this stream.
  let hints: 'open' | 'after_fallback' | 'off' = 'open'
  let hintBuffer = ''
  let pendingHint: Promise<string | null> | null = null
  let pendingEphemeral: string | null = null
  let pendingKeepalive = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let finishPoll: (() => void) | null = null
  let needsPage = true
  let refreshPending = false
  let lastReadAt = 0
  let hintedHead = args.afterSeq

  const refreshAt = () =>
    lastReadAt +
    (refreshPending || hintedHead > cursor
      ? Math.min(HINT_REFRESH_MS, args.pollMs ?? FALLBACK_POLL_MS)
      : (args.pollMs ?? FALLBACK_POLL_MS))

  const cancelAll = () => {
    if (cancelled) return
    cancelled = true
    abort.abort(new Error('session event stream cancelled'))
    finishPoll?.()
    void hintReader?.cancel().catch(() => undefined)
    hintReader = null
  }

  const nextHint = async (): Promise<string | null> => {
    if (hints === 'off') return null
    if (hintReader === null) {
      const response = await args.gatewayClient.openAgentSessionHints(
        args.workspaceSlug,
        args.sessionId,
        cursor,
        abort.signal,
      )
      if (cancelled || response?.body === null || response === null) {
        hints = 'after_fallback'
        return null
      }
      hintReader = response.body.getReader() as unknown as ByteReader
    }
    while (!cancelled) {
      const boundary = hintBuffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = hintBuffer.slice(0, boundary + 2)
        hintBuffer = hintBuffer.slice(boundary + 2)
        if (encoder.encode(frame).byteLength > MAX_HINT_FRAME_BYTES) {
          hints = 'off'
          const reader = hintReader
          hintReader = null
          await reader.cancel().catch(() => undefined)
          return null
        }
        return frame
      }
      const chunk = await hintReader.read()
      if (chunk.done) {
        hints = 'after_fallback'
        hintReader = null
        return null
      }
      hintBuffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n')
      if (encoder.encode(hintBuffer).byteLength > MAX_HINT_FRAME_BYTES) {
        hints = 'off'
        const reader = hintReader
        hintReader = null
        await reader.cancel().catch(() => undefined)
        return null
      }
    }
    return null
  }

  const waitForWake = async (): Promise<
    { kind: 'frame'; frame: string } | { kind: 'gateway_closed' } | { kind: 'fallback' }
  > => {
    // A delta after a durable hint belongs to the next block. Reading it
    // before that boundary commits would give it the browser's old cursor.
    if (hints === 'open' && hintedHead <= cursor) {
      pendingHint ??= nextHint()
    }
    const fallback = new Promise<{ kind: 'fallback' }>(resolve => {
      const finish = () => {
        if (finishPoll !== finish) return
        if (pollTimer !== null) clearTimeout(pollTimer)
        pollTimer = null
        finishPoll = null
        resolve({ kind: 'fallback' })
      }
      finishPoll = finish
      pollTimer = setTimeout(finish, Math.max(0, refreshAt() - Date.now()))
    })
    const hintWake = pendingHint?.then(
      (frame): { kind: 'frame'; frame: string } | { kind: 'gateway_closed' } =>
        frame === null ? { kind: 'gateway_closed' } : { kind: 'frame', frame },
    )
    const winner = await (hintWake === undefined ? fallback : Promise.race([hintWake, fallback]))
    if (winner.kind !== 'fallback') pendingHint = null
    finishPoll?.()
    if (winner.kind === 'fallback' && hints === 'after_fallback') hints = 'open'
    return winner
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!cancelled && !closed) {
          const row = durable.shift()
          if (row !== undefined) {
            cursor = row.seq
            controller.enqueue(encoder.encode(durableEventFrame(row)))
            return
          }

          const refreshDue = Date.now() >= refreshAt()
          if (needsPage || refreshDue) {
            const page = (await raceWithAbort(
              args.convex.query(
                fnQuery('domains/agentSessions/model:listEventsForStreamContinuation'),
                {
                  internalKey: args.internalKey,
                  workspaceId: args.workspaceId,
                  sessionId: args.sessionId,
                  afterSeq: cursor,
                },
              ),
              abort.signal,
            )) as { events: DurableEvent[]; headSeq: number; closed: boolean; terminal: boolean }
            if (cancelled) return
            if (page.closed) {
              closed = true
              controller.close()
              cancelAll()
              return
            }
            lastReadAt = Date.now()
            refreshPending = false
            durable = page.events
            needsPage = durable.length > 0
            if (durable.length > 0) continue
            if (page.terminal && cursor >= page.headSeq) {
              closed = true
              controller.close()
              cancelAll()
              return
            }
          }

          if (pendingEphemeral !== null) {
            const frame = pendingEphemeral
            pendingEphemeral = null
            controller.enqueue(encoder.encode(frame))
            return
          }
          if (pendingKeepalive) {
            pendingKeepalive = false
            controller.enqueue(encoder.encode(': keepalive\n\n'))
            return
          }

          const wake = await waitForWake()
          if (cancelled) return
          if (wake.kind === 'fallback') {
            needsPage = true
            pendingKeepalive = true
          } else if (wake.kind === 'frame') {
            if (isKeepalive(wake.frame)) {
              pendingKeepalive = true
            } else {
              const id = durableHintId(wake.frame)
              // Replayed hints at or behind the delivered cursor add no work.
              if (id === null || id > cursor) refreshPending = true
              if (id !== null) hintedHead = Math.max(hintedHead, id)
              if (id === null) pendingEphemeral = wake.frame
            }
          }
          // Hints coalesce into a timed durable refresh. Downstream pulls and
          // token frames alone never require another empty database read.
        }
      } catch (error) {
        const interrupted = cancelled
        cancelAll()
        if (!interrupted && !closed) controller.error(error)
      }
    },
    cancel() {
      cancelAll()
    },
  })
  return stream
}

function durableEventFrame(row: DurableEvent): string {
  return `id: ${row.seq}\nevent: ${eventName(row.event)}\ndata: ${JSON.stringify({
    seq: row.seq,
    createdAt: row.createdAt,
    event: row.event,
  })}\n\n`
}

function durableHintId(frame: string): number | null {
  const id = frame.split('\n').find(line => line.startsWith('id:'))
  if (id === undefined) return null
  const value = Number(id.slice(3).trim())
  return Number.isSafeInteger(value) && value >= 0 ? value : -1
}

function isKeepalive(frame: string): boolean {
  return frame.split('\n').every(line => line.length === 0 || line.startsWith(':'))
}

function eventName(event: unknown): string {
  return typeof event === 'object' &&
    event !== null &&
    typeof (event as { type?: unknown }).type === 'string'
    ? (event as { type: string }).type
    : 'message'
}
