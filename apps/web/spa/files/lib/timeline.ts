import { readBucketStart, type FileActivityEvent, type FileFeedEvent } from '@repo/contract'

// The contract's event union already carries the summary variants, so there is
// no local shape to keep in step with it.
type ActivityEvent = FileActivityEvent
type ActivityFeedEvent = Omit<FileFeedEvent, 'event'> & { event: ActivityEvent }

// Pure grouping/ordering for the slice-12 history drawer and activity feed.
// No React, no i18n, no formatActor — this module only decides which server
// events collapse into one row and in what order, so the behavior is pinned
// by unit tests instead of a DOM harness (the slice-05 approach). The two
// surfaces share every ordering rule here and diverge only in wording.

// ---------------------------------------------------------------------------
// Pagination: cursor pages arrive as separate arrays. Dedupe on seq (a page
// boundary can re-list the cursor row) and re-sort ascending so equal `at`
// values never reorder — seq is the only total order.

export function mergeEventPages(pages: readonly (readonly FileFeedEvent[])[]): FileFeedEvent[] {
  const bySeq = new Map<number, FileFeedEvent>()
  for (const page of pages) {
    for (const row of page) bySeq.set(row.seq, row)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

// ---------------------------------------------------------------------------
// History drawer: one seq-ordered timeline. Every write/create/delete/rename/
// restore is its own row; consecutive reads by one actor inside one 6h bucket
// (MAP Q7) collapse into a single "seen during this period" marker. The marker
// carries firstAt/lastAt but NEVER a count — the honesty firewall forbids an
// exact read tally reaching the UI.

export type ReadBucketRow = {
  type: 'read-bucket'
  key: string
  seq: number
  actor: string
  userId?: string
  bucketStart: number
  firstAt: number
  lastAt: number
}

export type HistoryEventRow = {
  type: 'event'
  key: string
  seq: number
  event: FileActivityEvent
}

export type HistoryRow = HistoryEventRow | ReadBucketRow

export function buildHistoryRows(events: readonly FileFeedEvent[]): HistoryRow[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const rows: HistoryRow[] = []
  let bucket: ReadBucketRow | null = null
  const flush = () => {
    if (bucket !== null) {
      rows.push(bucket)
      bucket = null
    }
  }
  for (const { seq, event } of ordered) {
    if (event.kind === 'read') {
      const bucketStart = readBucketStart(event.at)
      if (
        bucket !== null &&
        bucket.actor === event.actor &&
        bucket.userId === event.userId &&
        bucket.bucketStart === bucketStart
      ) {
        bucket.firstAt = Math.min(bucket.firstAt, event.at)
        bucket.lastAt = Math.max(bucket.lastAt, event.at)
        continue
      }
      flush()
      bucket = {
        type: 'read-bucket',
        key: `read-${seq}`,
        seq,
        actor: event.actor,
        ...(event.userId === undefined ? {} : { userId: event.userId }),
        bucketStart,
        firstAt: event.at,
        lastAt: event.at,
      }
      continue
    }
    flush()
    rows.push({ type: 'event', key: `event-${seq}`, seq, event })
  }
  flush()
  return rows
}

// ---------------------------------------------------------------------------
// Activity feed: adjacent writes/creates (or reads) by one actor collapse into
// a single "edited N files" row — a 40-file agent sweep is one line. Renames,
// deletes and restores never group and are never hidden, so terminal and
// mirror writes always surface (the mirror-honesty firewall). Grouping only
// ever merges neighbors in the server's seq order; it never reorders.

export type FeedGroupCategory = 'write' | 'read'

export type FeedGroupRow = {
  type: 'group'
  key: string
  seq: number
  actor: string
  userId?: string
  category: FeedGroupCategory
  // 'created' only when every grouped event is a create, else 'edited'.
  allCreates: boolean
  latestAt: number
  events: ActivityFeedEvent[]
  paths: string[]
}

export type FeedSingleRow = {
  type: 'single'
  key: string
  seq: number
  event: ActivityEvent
}

export type FeedRow = FeedGroupRow | FeedSingleRow

function feedCategory(kind: ActivityEvent['kind']): FeedGroupCategory | null {
  if (kind === 'write' || kind === 'create') return 'write'
  if (kind === 'read') return 'read'
  return null
}

export function buildFeedRows(
  events: readonly ActivityFeedEvent[],
  order: 'asc' | 'desc' = 'asc',
): FeedRow[] {
  const ordered = [...events].sort((a, b) => (order === 'asc' ? a.seq - b.seq : b.seq - a.seq))
  const rows: FeedRow[] = []
  let group: FeedGroupRow | null = null
  const flush = () => {
    if (group !== null) {
      rows.push(group)
      group = null
    }
  }
  for (const feedEvent of ordered) {
    const { seq, event } = feedEvent
    const category = feedCategory(event.kind)
    if (category === null || event.kind === 'restore') {
      flush()
      rows.push({ type: 'single', key: `single-${seq}`, seq, event })
      continue
    }
    const path = 'path' in event ? event.path : ''
    if (
      group !== null &&
      group.actor === event.actor &&
      group.userId === event.userId &&
      group.category === category
    ) {
      group.events.push(feedEvent)
      group.allCreates &&= event.kind === 'create'
      group.latestAt = Math.max(group.latestAt, event.at)
      if (!group.paths.includes(path)) group.paths.push(path)
      continue
    }
    flush()
    group = {
      type: 'group',
      key: `group-${seq}`,
      seq,
      actor: event.actor,
      ...(event.userId === undefined ? {} : { userId: event.userId }),
      category,
      allCreates: event.kind === 'create',
      latestAt: event.at,
      events: [feedEvent],
      paths: [path],
    }
  }
  flush()
  return rows
}
