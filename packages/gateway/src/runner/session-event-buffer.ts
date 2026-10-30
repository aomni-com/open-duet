import {
  classifyAgentTurnEvent,
  CONVEX_EVENT_BUDGET_BYTES,
  type AgentTurnEvent,
} from '@repo/contract'

export type LiveFrame = { event: AgentTurnEvent; seq: number | null }

export interface SessionEventSubscription extends AsyncIterable<LiveFrame> {
  close(): void
}

export interface SessionEventBuffer {
  push(frame: LiveFrame): void
  subscribe(sinceSeq: number): SessionEventSubscription
  resetForTurn(anchorSeq: number): void
  dropSession(): void
}

const DEFAULT_SESSION_EVENT_BUFFER_CAPACITY = 1_000
const DEFAULT_SESSION_EVENT_BUFFER_MAX_BYTES = 1024 * 1024
const DEFAULT_SUBSCRIBER_MAX_EVENTS = 256
const DEFAULT_SUBSCRIBER_MAX_BYTES = 1024 * 1024
export const SESSION_EVENT_MAX_FRAME_BYTES = CONVEX_EVENT_BUDGET_BYTES + 64 * 1024
const UTF8_ENCODER = new TextEncoder()

export interface SessionEventSubscriberLimits {
  maxEvents: number
  maxBytes: number
}

export interface SessionEventSubscriberLimitEvent {
  limit: 'events' | 'bytes' | 'frame_bytes'
  action: 'subscriber_disconnected'
  maxEvents: number
  maxBytes: number
  maxFrameBytes?: number
}

export class RingSessionEventBuffer implements SessionEventBuffer {
  private readonly frames: LiveFrame[] = []
  private readonly subscribers = new Set<LiveFrameQueue>()
  private anchorSeq = 0
  private readonly capacity: number
  private readonly retainedMaxBytes: number
  private retainedBytes = 0
  private readonly subscriberLimits: SessionEventSubscriberLimits
  private readonly onSubscriberLimit?: (event: SessionEventSubscriberLimitEvent) => void

  constructor(
    options: {
      capacity?: number
      retainedMaxBytes?: number
      subscriberLimits?: SessionEventSubscriberLimits
      onSubscriberLimit?: (event: SessionEventSubscriberLimitEvent) => void
    } = {},
  ) {
    this.capacity = options.capacity ?? DEFAULT_SESSION_EVENT_BUFFER_CAPACITY
    this.retainedMaxBytes = options.retainedMaxBytes ?? DEFAULT_SESSION_EVENT_BUFFER_MAX_BYTES
    this.subscriberLimits = options.subscriberLimits ?? {
      maxEvents: DEFAULT_SUBSCRIBER_MAX_EVENTS,
      maxBytes: DEFAULT_SUBSCRIBER_MAX_BYTES,
    }
    this.onSubscriberLimit = options.onSubscriberLimit
  }

  push(frame: LiveFrame): void {
    const byteLength = liveFrameByteLength(frame)
    if (byteLength > SESSION_EVENT_MAX_FRAME_BYTES) {
      this.onSubscriberLimit?.({
        limit: 'frame_bytes',
        action: 'subscriber_disconnected',
        maxEvents: this.subscriberLimits.maxEvents,
        maxBytes: this.subscriberLimits.maxBytes,
        maxFrameBytes: SESSION_EVENT_MAX_FRAME_BYTES,
      })
      for (const subscriber of this.subscribers) subscriber.detachAfterDrain()
      this.subscribers.clear()
      return
    }
    this.frames.push(frame)
    this.retainedBytes += byteLength
    this.enforceCapacity()
    for (const subscriber of this.subscribers) subscriber.push(frame, byteLength)
  }

  subscribe(sinceSeq: number): SessionEventSubscription {
    // Newest durable frame the client already holds (from backfill up to sinceSeq).
    // Ephemeral deltas buffered before it belong to already-finalized steps — the
    // client rendered those from their canonical rows — so replaying them would
    // re-stream seen content. Only the in-flight step's deltas (buffered after this
    // boundary) are still unseen and worth replaying.
    let lastSeenDurableIndex = -1
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]
      if (frame !== undefined && frame.seq !== null && frame.seq <= sinceSeq) {
        lastSeenDurableIndex = index
        break
      }
    }
    const eligible = this.frames.filter((frame, index) => {
      if (frame.seq !== null) return frame.seq > sinceSeq
      return index > lastSeenDurableIndex && classifyAgentTurnEvent(frame.event) === 'ephemeral'
    })
    const retained: LiveFrame[] = []
    let retainedBytes = 0
    for (let index = eligible.length - 1; index >= 0; index -= 1) {
      const frame = eligible[index]!
      const bytes = liveFrameByteLength(frame)
      if (
        retained.length >= this.subscriberLimits.maxEvents ||
        retainedBytes + bytes > this.subscriberLimits.maxBytes
      )
        break
      retained.unshift(frame)
      retainedBytes += bytes
    }
    const queue = new LiveFrameQueue(
      retained,
      this.subscriberLimits,
      () => {
        this.subscribers.delete(queue)
      },
      this.onSubscriberLimit,
    )
    this.subscribers.add(queue)
    return queue
  }

  resetForTurn(anchorSeq: number): void {
    this.anchorSeq = anchorSeq
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]
      if (frame === undefined) continue
      if (frame.seq === null || frame.seq <= anchorSeq) {
        this.retainedBytes -= liveFrameByteLength(frame)
        this.frames.splice(index, 1)
      }
    }
    this.enforceCapacity()
  }

  dropSession(): void {
    this.frames.length = 0
    this.retainedBytes = 0
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
  }

  private enforceCapacity(): void {
    while (this.frames.length > this.capacity || this.retainedBytes > this.retainedMaxBytes) {
      const evicted = this.frames.shift()
      if (evicted === undefined) return
      this.retainedBytes -= liveFrameByteLength(evicted)
    }
  }
}

class LiveFrameQueue implements AsyncIterator<LiveFrame>, SessionEventSubscription {
  private replayIndex = 0
  private replayBytes: number
  private readonly queued: Array<{ frame: LiveFrame; byteLength: number }> = []
  private queuedBytes = 0
  private waiting: ((result: IteratorResult<LiveFrame>) => void) | null = null
  private accepting = true
  private closed = false
  private detached = false

  constructor(
    private readonly replay: LiveFrame[],
    private readonly limits: SessionEventSubscriberLimits,
    private readonly onDetach: () => void,
    private readonly onLimit?: (event: SessionEventSubscriberLimitEvent) => void,
  ) {
    this.replayBytes = replay.reduce((total, frame) => total + liveFrameByteLength(frame), 0)
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveFrame> {
    return this
  }

  next(): Promise<IteratorResult<LiveFrame>> {
    const replay = this.replay[this.replayIndex]
    if (replay !== undefined) {
      this.replayIndex += 1
      this.replayBytes -= liveFrameByteLength(replay)
      return Promise.resolve({ done: false, value: replay })
    }
    const queued = this.queued.shift()
    if (queued !== undefined) {
      this.queuedBytes -= queued.byteLength
      return Promise.resolve({ done: false, value: queued.frame })
    }
    if (this.closed || !this.accepting) {
      this.detach()
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise(resolve => {
      this.waiting = resolve
    })
  }

  push(frame: LiveFrame, byteLength: number): boolean {
    if (this.closed || !this.accepting) return false
    const waiting = this.waiting
    if (waiting !== null) {
      this.waiting = null
      waiting({ done: false, value: frame })
      return true
    }
    if (
      this.replay.length - this.replayIndex + this.queued.length >= this.limits.maxEvents ||
      this.replayBytes + this.queuedBytes + byteLength > this.limits.maxBytes
    ) {
      this.onLimit?.({
        limit:
          this.replay.length - this.replayIndex + this.queued.length >= this.limits.maxEvents
            ? 'events'
            : 'bytes',
        action: 'subscriber_disconnected',
        maxEvents: this.limits.maxEvents,
        maxBytes: this.limits.maxBytes,
      })
      this.accepting = false
      this.detach()
      return false
    }
    this.queued.push({ frame, byteLength })
    this.queuedBytes += byteLength
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.accepting = false
    const waiting = this.waiting
    this.waiting = null
    this.queued.length = 0
    this.queuedBytes = 0
    if (waiting !== null) waiting({ done: true, value: undefined })
    this.detach()
  }

  detachAfterDrain(): void {
    if (!this.accepting) return
    this.accepting = false
    const waiting = this.waiting
    this.waiting = null
    if (waiting !== null) waiting({ done: true, value: undefined })
    this.detach()
  }

  private detach(): void {
    if (this.detached) return
    this.detached = true
    this.onDetach()
  }
}

function liveFrameByteLength(frame: LiveFrame): number {
  return UTF8_ENCODER.encode(formatSessionEventSseFrame(frame)).byteLength
}

export function formatSessionEventSseFrame(frame: LiveFrame): string {
  const eventName = frame.event.type
  if (frame.seq !== null) {
    return `id: ${frame.seq}\nevent: ${eventName}\ndata: ${JSON.stringify({
      seq: frame.seq,
      event: frame.event,
    })}\n\n`
  }
  return `event: ${eventName}\ndata: ${JSON.stringify({ event: frame.event })}\n\n`
}
