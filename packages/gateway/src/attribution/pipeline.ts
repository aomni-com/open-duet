import {
  actorEmitsReadMarkers,
  encodeActorContext,
  FILE_ACTIVITY_LIMITS,
  noisyTreeRoot,
  parseActorContext,
  readBucketStart,
  type DriveFileEvent,
  type FileEventBatch,
} from '@repo/contract'

// The gateway's one file-event pipeline (MAP Q5/Q6): every semantic file event
// funnels through emit() on its way to `POST {api}/v1/vm/file-events`. Sole
// owner of attribution policy at the emission boundary, read coalescing,
// buffering, flush cadence, retry, and loss counters. Buffers are in-memory
// only — a gateway restart loses them (accepted, MAP L7) — but every loss is
// counted and every batch carries a stable batchId, so "never drop writes"
// can never become "duplicate writes" (slice-02 ingestion dedupes on it).
//
// Policy at emit (routes forward the raw actor-context header; this is the
// one enforcement point, Convex backstops):
// - unattributed reads are dropped and counted; unattributed write-class
//   events are logged as `system` (MAP Q1)
// - reads from an actor that emits no read markers (a mirror device) are
//   skipped entirely — mechanical mirroring, not attention (MAP-SYNC Q10).
//   A policy skip, never loss: counted in `mirrorReadsSkipped` only.
// - operational taps observe every admitted raw event; the persistence copy
//   coalesces ordinary reads and folds noisy descendants into counted groups
// - within the active buffer, oldest reads are dropped before writes; the
//   whole retry queue has a terminal ceiling and counts anything beyond it

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const DEFAULT_FILE_EVENT_FLUSH_MS = 5_000
export const DEFAULT_FILE_EVENT_MAX_ENTRIES = 500
export const DEFAULT_FILE_EVENT_MAX_QUEUED_EVENTS = 2_000
export const FILE_EVENT_RETRY_BACKOFF_CAP_MS = 30_000
const FILE_EVENT_RETRY_BACKOFF_BASE_MS = 1_000

export function fileEventRetryBackoffMs(attempt: number): number {
  return Math.min(
    FILE_EVENT_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
    FILE_EVENT_RETRY_BACKOFF_CAP_MS,
  )
}

export interface FileEventPipelineOptions {
  apiUrl?: string
  getVmToken: () => Promise<string | null>
  fetch: FetchLike
  now: () => number
  flushMs?: number
  maxEntries?: number
  maxQueuedEvents?: number
  extraHeaders?: Record<string, string>
  /** Deterministic fixture seam; production uses a random UUID. */
  createBatchId?: () => string
  onQueueLimit?: (event: {
    action: 'events_dropped'
    droppedEvents: number
    maxQueuedEvents: number
  }) => void
}

export interface FileEventPipelineStats {
  /** Raw events admitted to operational listeners before persistence folding. */
  rawEventsObserved: number
  droppedReads: number
  overflow: number
  mirrorReadsSkipped: number
  /** Cumulative pid→cgroup resolution failures reported by the helper (L12). */
  cgroupMisses: number
  /** Cumulative helper restarts reported by the supervisor (L12). */
  helperRestarts: number
}

export interface FileEventPipeline {
  emit(event: DriveFileEvent): void
  flush(): Promise<void>
  suppress(on: boolean): void
  /**
   * Folds the privileged watcher's own loss counters into the one telemetry
   * surface (L12): the helper's FAN_Q_OVERFLOW is the same "silent event loss"
   * as buffer overflow, so its delta joins `overflow` (and rides the next batch
   * to the API); cgroupMisses and helperRestarts are cumulative gauges. Called
   * with the CUMULATIVE values (helper stats / supervisor stats); the pipeline
   * tracks the last overflow seen and folds only the increase, so a helper
   * restart resetting to 0 never subtracts.
   */
  mergeHelperStats(input: {
    overflow?: number
    cgroupMisses?: number
    helperRestarts?: number
  }): void
  stats(): FileEventPipelineStats
  /**
   * Post-admission tap: fires once per event the pipeline accepts (after
   * suppression, actor normalization, and read policy, before persistence
   * coalescing or noisy-tree folding). Purely observational — listeners cannot
   * reorder, mutate, or fail the pipeline (exceptions are swallowed). Returns
   * an unsubscribe function. Slice 18's scan nudge is the intended consumer.
   */
  onEvent(listener: (event: DriveFileEvent) => void): () => void
}

export function createFileEventPipeline(options: FileEventPipelineOptions): FileEventPipeline {
  const flushMs = options.flushMs ?? DEFAULT_FILE_EVENT_FLUSH_MS
  const maxEntries = options.maxEntries ?? DEFAULT_FILE_EVENT_MAX_ENTRIES
  const maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_FILE_EVENT_MAX_QUEUED_EVENTS
  const extraHeaders = options.extraHeaders ?? {}

  let buffer: DriveFileEvent[] = []
  let bufferedReadKeys = new Set<string>()
  let bufferedPathSegments = 0
  let summaryGroups = new Map<string, SummaryEvent>()
  // A hard contract boundary may be reached while an earlier batch is retrying.
  // Such batches are already sealed and cannot absorb later events.
  const sealedQueue: FileEventBatch[] = []
  let sealedQueueEvents = 0
  // The batch currently being relayed. It keeps its batchId (and its loss
  // counters) across retries; new events accumulate into the next batch.
  let pending: FileEventBatch | null = null
  let suppressed = false
  let draining: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failedAttempts = 0
  let nextRetryAtMs = 0
  let queueLimitReached = false
  const totals: FileEventPipelineStats = {
    rawEventsObserved: 0,
    droppedReads: 0,
    overflow: 0,
    mirrorReadsSkipped: 0,
    cgroupMisses: 0,
    helperRestarts: 0,
  }
  // The last cumulative FAN overflow the helper reported, to fold only the delta.
  let lastHelperOverflow = 0
  const listeners = new Set<(event: DriveFileEvent) => void>()
  // Loss not yet carried by a batch; captured into the next batch built.
  let unreported = { droppedReads: 0, overflow: 0 }

  function emit(event: DriveFileEvent): void {
    // Restore-time suppression (MAP L6, wired in slice 11): one workspace
    // `restore` event replaces the per-file storm — a policy skip, not loss.
    if (suppressed) return
    const actor = parseActorContext(event.actor)
    let admitted = event
    if (actor === null) {
      if (event.kind === 'read') {
        dropRead()
        return
      }
      admitted = { ...event, actor: encodeActorContext({ kind: 'system' }) }
    } else if (event.kind === 'read') {
      if (!actorEmitsReadMarkers(actor)) {
        totals.mirrorReadsSkipped += 1
        return
      }
    }
    totals.rawEventsObserved += 1
    notifyListeners(admitted)

    const persistence = persistenceEvent(admitted)
    if (persistence.event.kind === 'read' && bufferedReadKeys.has(readKey(persistence.event)))
      return
    const existingSummary =
      persistence.groupKey === null ? undefined : summaryGroups.get(persistence.groupKey)
    if (existingSummary !== undefined) {
      if (existingSummary.count < Number.MAX_SAFE_INTEGER) {
        existingSummary.count += 1
        existingSummary.at = Math.max(existingSummary.at, admitted.at)
        scheduleFlushTimer()
        return
      }
      sealBuffer()
      void flush()
    }

    const pathSegments = eventPathSegments(persistence.event)
    const queuedEvents = (pending?.events.length ?? 0) + sealedQueueEvents + buffer.length
    if (queuedEvents >= maxQueuedEvents) {
      recordQueueLimit(1)
      if (persistence.event.kind === 'read') dropRead()
      return
    }
    if (
      buffer.length >= FILE_ACTIVITY_LIMITS.maxEventsPerBatch ||
      bufferedPathSegments + pathSegments > FILE_ACTIVITY_LIMITS.maxBatchPathSegments
    ) {
      sealBuffer()
      void flush()
    }

    if (buffer.length >= maxEntries) {
      totals.overflow += 1
      unreported.overflow += 1
      const oldestRead = buffer.findIndex(buffered => buffered.kind === 'read')
      if (oldestRead !== -1) {
        const [evicted] = buffer.splice(oldestRead, 1)
        if (evicted?.kind === 'read') {
          bufferedReadKeys.delete(readKey(evicted))
          bufferedPathSegments -= eventPathSegments(evicted)
        }
        dropRead()
      } else if (admitted.kind === 'read') {
        dropRead()
        return
      }
    }
    buffer.push(persistence.event)
    bufferedPathSegments += pathSegments
    if (persistence.event.kind === 'read') bufferedReadKeys.add(readKey(persistence.event))
    if (persistence.groupKey !== null) {
      summaryGroups.set(persistence.groupKey, persistence.event as SummaryEvent)
    }
    if (buffer.length >= maxEntries) void flush()
    else scheduleFlushTimer()
  }

  function notifyListeners(event: DriveFileEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Taps are observational; a broken listener never affects the pipeline.
      }
    }
  }

  function sealBuffer(): void {
    if (buffer.length === 0) return
    const batch: FileEventBatch = {
      batchId: options.createBatchId?.() ?? crypto.randomUUID(),
      events: buffer,
      droppedReads: unreported.droppedReads,
      overflow: unreported.overflow,
    }
    buffer = []
    bufferedReadKeys = new Set()
    bufferedPathSegments = 0
    summaryGroups = new Map()
    const queuedEvents = (pending?.events.length ?? 0) + sealedQueueEvents
    if (queuedEvents + batch.events.length > maxQueuedEvents) {
      recordQueueLimit(batch.events.length)
      return
    }
    sealedQueue.push(batch)
    sealedQueueEvents += batch.events.length
    unreported = { droppedReads: 0, overflow: 0 }
  }

  // Guarantees a fresh drain pass: if one is already in flight, wait for it,
  // then run another (events emitted since the in-flight pass started must
  // not be stranded until the next timer).
  async function flush(): Promise<void> {
    for (;;) {
      if (draining === null) {
        draining = drain().finally(() => {
          draining = null
        })
        await draining
        return
      }
      await draining
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      if (pending === null) {
        if (sealedQueue.length === 0) sealBuffer()
        pending = sealedQueue.shift() ?? null
        if (pending !== null) sealedQueueEvents -= pending.events.length
        if (pending === null) return
      }
      if (options.apiUrl === undefined) {
        // No API to relay to (local gateways): discard instead of growing.
        pending = null
        clearQueueLimitIfRecovered()
        continue
      }
      if (failedAttempts > 0 && options.now() < nextRetryAtMs) return
      const outcome = await deliver(options.apiUrl, pending)
      if (outcome === 'delivered') {
        failedAttempts = 0
        pending = null
        clearQueueLimitIfRecovered()
        continue
      }
      if (outcome === 'terminal') {
        recordOverflow(pending.events.length)
        failedAttempts = 0
        pending = null
        clearQueueLimitIfRecovered()
        continue
      }
      failedAttempts += 1
      const backoffMs = fileEventRetryBackoffMs(failedAttempts)
      nextRetryAtMs = options.now() + backoffMs
      scheduleRetryTimer(backoffMs)
      return
    }
  }

  async function deliver(
    apiUrl: string,
    batch: FileEventBatch,
  ): Promise<'delivered' | 'retry' | 'terminal'> {
    try {
      const token = await options.getVmToken()
      if (token === null) return 'retry'
      const response = await options.fetch(`${apiUrl.replace(/\/+$/g, '')}/v1/vm/file-events`, {
        method: 'POST',
        headers: {
          ...extraHeaders,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
      })
      if (response.ok) return 'delivered'
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return 'retry'
      }
      return 'terminal'
    } catch {
      return 'retry'
    }
  }

  function scheduleFlushTimer(): void {
    if (flushTimer !== null || (buffer.length === 0 && sealedQueue.length === 0)) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, flushMs)
    flushTimer.unref?.()
  }

  function recordQueueLimit(droppedEvents: number): void {
    if (!queueLimitReached) {
      queueLimitReached = true
      options.onQueueLimit?.({ action: 'events_dropped', droppedEvents, maxQueuedEvents })
    }
    recordOverflow(droppedEvents)
  }

  function clearQueueLimitIfRecovered(): void {
    const queuedEvents = (pending?.events.length ?? 0) + sealedQueueEvents + buffer.length
    if (queuedEvents < maxQueuedEvents) queueLimitReached = false
  }

  function scheduleRetryTimer(delayMs: number): void {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void flush()
    }, delayMs)
    retryTimer.unref?.()
  }

  function dropRead(): void {
    totals.droppedReads += 1
    unreported.droppedReads += 1
  }

  function recordOverflow(count: number): void {
    totals.overflow += count
    const carrier = sealedQueue.at(-1)
    if (carrier === undefined) unreported.overflow += count
    else carrier.overflow += count
  }

  return {
    emit,
    flush,
    suppress(on: boolean): void {
      suppressed = on
    },
    mergeHelperStats(input): void {
      if (input.overflow !== undefined) {
        // Only the increase (a helper restart resets its cumulative to 0).
        const delta = Math.max(0, input.overflow - lastHelperOverflow)
        lastHelperOverflow = input.overflow
        totals.overflow += delta
        unreported.overflow += delta
      }
      if (input.cgroupMisses !== undefined) totals.cgroupMisses = input.cgroupMisses
      if (input.helperRestarts !== undefined) totals.helperRestarts = input.helperRestarts
    },
    stats(): FileEventPipelineStats {
      return { ...totals }
    },
    onEvent(listener: (event: DriveFileEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function readKey(event: DriveFileEvent & { kind: 'read' }): string {
  return `${readBucketStart(event.at)}\n${event.actor}\n${event.path}`
}

type SummaryEvent = Extract<DriveFileEvent, { kind: 'changed-summary' | 'viewed-summary' }>

function persistenceEvent(event: DriveFileEvent): {
  event: DriveFileEvent
  groupKey: string | null
} {
  let root: string | null = null
  let category: 'changed' | 'viewed' | null = null
  switch (event.kind) {
    case 'create':
    case 'write':
    case 'delete':
      root = noisyTreeRoot(event.path)
      category = 'changed'
      break
    case 'read':
      root = noisyTreeRoot(event.path)
      category = 'viewed'
      break
    case 'rename': {
      const fromRoot = noisyTreeRoot(event.fromPath)
      const toRoot = noisyTreeRoot(event.path)
      if (fromRoot !== null && fromRoot === toRoot) {
        root = fromRoot
        category = 'changed'
      }
      break
    }
    case 'changed-summary':
    case 'viewed-summary':
    case 'restore':
      break
  }
  if (root === null || category === null) return { event, groupKey: null }
  const summary: SummaryEvent = {
    kind: category === 'changed' ? 'changed-summary' : 'viewed-summary',
    path: root,
    actor: event.actor,
    at: event.at,
    count: 1,
  }
  return { event: summary, groupKey: `${event.actor}\n${root}\n${category}` }
}

function eventPathSegments(event: DriveFileEvent): number {
  if (event.kind === 'restore') return 0
  return (
    event.path.split('/').length + (event.kind === 'rename' ? event.fromPath.split('/').length : 0)
  )
}
