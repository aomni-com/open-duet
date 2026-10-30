import { makeFunctionReference } from 'convex/server'

import {
  FileEventBatchSchema,
  FOLD_DISTINCT_FILES,
  actorEmitsReadMarkers,
  isSameLogicalSave,
  parseActorContext,
  summaryCountsFiles,
  readBucketStart,
  type DriveFileEvent,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { draftFileAnalytics, scheduleFileAnalytics, type FileAnalyticsDraft } from './analytics'
import { applyNamespaceEvents, parentEntityAt, type NamespaceTransition } from './namespace'

export interface RecordBatchResult {
  // True when this batchId was already recorded for the workspace — the whole
  // delivery is a no-op (relay retries must not duplicate writes).
  deduped: boolean
  // fileEvents rows inserted by this delivery (deduped reads insert none).
  appended: number
  // Latest seq in the workspace after this delivery; 0 = no events yet.
  lastSeq: number
}

// The one durable recorder for file-attribution events. Validates against the
// contract batch schema, advances the stable namespace in sealed order, appends
// canonical events, dedupes read markers per (entity, actorContext, bucketStart),
// and keeps the entity-keyed fileAccess rollup in step. `now` stamps only server-side
// bookkeeping (the batch record); event rows carry the event's own `at`.
export async function recordBatch(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; batch: unknown; now: number },
): Promise<RecordBatchResult> {
  const batch = FileEventBatchSchema.parse(args.batch)
  const delivered = await ctx.db
    .query('fileEventBatches')
    .withIndex('by_workspace_batch', q =>
      q.eq('workspaceId', args.workspaceId).eq('batchId', batch.batchId),
    )
    .unique()
  if (delivered !== null) {
    return { deduped: true, appended: 0, lastSeq: await allocatedSeq(ctx, args.workspaceId) }
  }
  await ctx.db.insert('fileEventBatches', {
    workspaceId: args.workspaceId,
    batchId: batch.batchId,
    recordedAt: args.now,
    droppedReads: batch.droppedReads,
    overflow: batch.overflow,
  })
  const namespace = await applyNamespaceEvents(ctx, {
    workspaceId: args.workspaceId,
    events: batch.events,
  })
  let appended = 0
  const fold: FoldPlan = {
    groups: planFoldGroups(batch.events),
    written: new Set(),
    declined: new Set(),
  }
  // Attribution joins principal rows this transaction must not touch; the
  // drafts are finished off-transaction (see analytics.ts).
  const analytics: FileAnalyticsDraft[] = []
  for (const [index, event] of batch.events.entries()) {
    const transition = namespace.transitions[index]
    if (transition === undefined) throw new Error('namespace transition missing')
    const inserted = await recordEvent(ctx, args.workspaceId, event, transition, fold)
    if (inserted) {
      appended += 1
      analytics.push(draftFileAnalytics(args.workspaceId, event, transition.sequence))
    }
  }
  if (appended > 0) {
    await ctx.scheduler.runAfter(0, advanceScopeProjectionRef, { workspaceId: args.workspaceId })
  }
  await scheduleFileAnalytics(ctx, analytics)
  return {
    deduped: false,
    appended,
    lastSeq: namespace.transitions.at(-1)?.sequence ?? (await allocatedSeq(ctx, args.workspaceId)),
  }
}

async function allocatedSeq(ctx: MutationCtx, workspaceId: Id<'workspaces'>): Promise<number> {
  const namespace = await ctx.db
    .query('fileActivityNamespaces')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .unique()
  return (namespace?.nextSequence ?? 1) - 1
}

async function recordEvent(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  event: DriveFileEvent,
  transition: NamespaceTransition,
  fold: FoldPlan,
): Promise<boolean> {
  if (event.kind === 'read') return await recordRead(ctx, workspaceId, event, transition)
  const entityId = transition.entityId
  // Restore is workspace-wide and carries no entity (MAP L6); everything else
  // must have one. Above every dedupe decision, always: the feed row may hide a
  // magnitude, fileAccess may never lose it (MAP L-C).
  if (event.kind !== 'restore') {
    if (entityId === null) throw new Error('event entity missing')
    await bumpRollup(ctx, workspaceId, {
      entityId,
      actor: event.actor,
      at: event.at,
      write: event.kind !== 'viewed-summary',
      count: event.kind === 'changed-summary' || event.kind === 'viewed-summary' ? event.count : 1,
    })
  }
  const foldKey = foldGroupKey(event)
  const foldSize = foldKey === null ? undefined : fold.groups.get(foldKey)
  if (
    foldKey !== null &&
    foldSize !== undefined &&
    entityId !== null &&
    !fold.declined.has(foldKey)
  ) {
    // One summary per group per delivery: the first event in the group writes
    // it with the group's whole distinct-file count, the rest are already
    // accounted for by that count and add no row.
    if (fold.written.has(foldKey)) return false
    const outcome = await recordFoldedGroup(ctx, workspaceId, event, transition, entityId, foldSize)
    if (outcome !== 'declined') {
      fold.written.add(foldKey)
      return outcome === 'inserted'
    }
    // Unfoldable. Remember it so the whole group falls through rather than
    // asking again per event, then record this one per-file below.
    fold.declined.add(foldKey)
  }
  const sharesBucketRow = mergesIntoBucketRow(event.kind)
  if (entityId !== null && sharesBucketRow) {
    if (await mergeIntoBucketRow(ctx, workspaceId, event, entityId)) return false
  }
  await ctx.db.insert('fileEvents', {
    workspaceId,
    seq: transition.sequence,
    kind: event.kind,
    ...(event.kind === 'restore' ? {} : { path: event.path }),
    ...(entityId === null ? {} : { entityId }),
    ...(event.kind === 'rename' ? { fromPath: event.fromPath } : {}),
    ...(event.kind === 'create' || event.kind === 'delete' || event.kind === 'rename'
      ? { entryKind: event.entryKind }
      : {}),
    ...(event.kind === 'changed-summary' || event.kind === 'viewed-summary'
      ? { count: event.count }
      : {}),
    actorContext: event.actor,
    at: event.at,
    isRead: event.kind === 'viewed-summary',
    ...(sharesBucketRow ? { bucketStart: readBucketStart(event.at), lastAt: event.at } : {}),
  })
  return true
}

interface FoldPlan {
  /** Group key to the delivery's distinct-file count, for folding groups only. */
  groups: Map<string, number>
  /** Groups whose summary this delivery has already written. */
  written: Set<string>
  /**
   * Groups that turned out to be unfoldable — no resolvable folder, or a
   * gateway summary already holding the bucket. Their events fall back to
   * per-file rows, so a group that cannot fold still gets recorded.
   */
  declined: Set<string>
}

/** Whether the fold wrote a row, joined one, or gave the group back. */
type FoldOutcome = 'inserted' | 'merged' | 'declined'

/** The one bucket-row lookup: both the per-file merge and the fold use it. */
async function bucketRow(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    entityId: Id<'fileActivityEntities'>
    actor: string
    at: number
    isRead: boolean
  },
) {
  return await ctx.db
    .query('fileEvents')
    .withIndex('by_workspace_entity_actor_bucket_read', q =>
      q
        .eq('workspaceId', args.workspaceId)
        .eq('entityId', args.entityId)
        .eq('actorContext', args.actor)
        .eq('bucketStart', readBucketStart(args.at))
        .eq('isRead', args.isRead),
    )
    .first()
}

/** The folder a drive-relative path sits in; '' for a top-level entry. */
function folderOf(path: string): string {
  const segments = path.split('/')
  segments.pop()
  return segments.join('/')
}

/**
 * Writes (or merges into) the folder summary standing in for a burst. The
 * summary sits on the folder's own entity, so its scope fan-out is the folder's
 * ancestors — one level shallower than any file inside it.
 *
 * Merging adds this delivery's distinct-file count to the row's, so a file
 * touched by two separate bursts in the same bucket is counted in both. That is
 * a deliberate approximation: tracking which files a summary has already seen
 * would mean storing the set, and a burst — the only thing that folds — writes
 * a given file once.
 */
async function recordFoldedGroup(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  event: DriveFileEvent,
  transition: NamespaceTransition,
  entityId: Id<'fileActivityEntities'>,
  distinctFiles: number,
): Promise<FoldOutcome> {
  if (event.kind !== 'write' && event.kind !== 'create') return 'declined'
  const folderEntityId = await parentEntityAt(ctx, {
    workspaceId,
    childEntityId: entityId,
    atSequence: transition.sequence,
  })
  // No resolvable folder means no fold target, so the group goes back and is
  // recorded per-file. Returning "done" here would drop the burst entirely.
  if (folderEntityId === null) return 'declined'
  const folderPath = folderOf(event.path)
  const existing = await bucketRow(ctx, {
    workspaceId,
    entityId: folderEntityId,
    actor: event.actor,
    at: event.at,
    isRead: false,
  })
  // Only ever merge into another SERVER fold. A gateway summary can occupy this
  // same bucket key, and its count is raw events — adding distinct files into it
  // would produce a row whose number means neither thing, still labelled as the
  // gateway's. Today the gateway rewrites every write under a noisy tree into
  // its own summary, so a raw write should never reach here with a gateway row
  // already in place; that is the gateway's behaviour, though, not this
  // function's guarantee, and `recordBatchFromApi` is reachable without it.
  if (existing !== null && summaryCountsFiles(existing)) {
    await ctx.db.patch(existing._id, {
      count: (existing.count ?? 1) + distinctFiles,
      ...(event.at > (existing.lastAt ?? existing.at) ? { lastAt: event.at } : {}),
    })
    return 'merged'
  }
  // A gateway summary already holds this bucket. Leaving the burst per-file
  // costs rows; adding files into an events-unit count costs the truth.
  if (existing !== null) return 'declined'
  await ctx.db.insert('fileEvents', {
    workspaceId,
    seq: transition.sequence,
    kind: 'changed-summary',
    path: folderPath,
    entityId: folderEntityId,
    // Marks this as a SERVER fold, whose count is distinct files rather than
    // the raw event count a gateway summary carries.
    entryKind: 'folder',
    count: distinctFiles,
    actorContext: event.actor,
    at: event.at,
    isRead: false,
    bucketStart: readBucketStart(event.at),
    lastAt: event.at,
  })
  return 'inserted'
}

/**
 * Groups a delivery's change events by actor and containing folder, keeping
 * only those over the distinct-file threshold.
 *
 * Burstiness is measured per delivery rather than per bucket, and that is the
 * point: a build writing a whole directory arrives together, while eleven files
 * edited across an afternoon arrive apart and stay per-file. Counting distinct
 * files (not events) is what keeps repeated saves from ever crossing it.
 */
function planFoldGroups(events: readonly DriveFileEvent[]): Map<string, number> {
  const distinctPaths = new Map<string, Set<string>>()
  for (const event of events) {
    const key = foldGroupKey(event)
    if (key === null || event.kind === 'restore') continue
    const paths = distinctPaths.get(key) ?? new Set<string>()
    paths.add(event.path)
    distinctPaths.set(key, paths)
  }
  const folding = new Map<string, number>()
  for (const [key, paths] of distinctPaths) {
    if (paths.size > FOLD_DISTINCT_FILES) folding.set(key, paths.size)
  }
  return folding
}

function foldGroupKey(event: DriveFileEvent): string | null {
  if (event.kind !== 'write' && event.kind !== 'create') return null
  return `${event.actor}\n${folderOf(event.path)}`
}

/**
 * Which kinds share a bucket row. `write` and `create` do, because they are
 * repeated observations of one file being saved. `delete` and `rename` do not:
 * each is a distinct terminal fact about the entry, not another sighting of the
 * same one. The gateway's own noisy-tree summaries merge too, which is what
 * collapses its per-flush-window duplicates (MAP D6).
 */
function mergesIntoBucketRow(kind: DriveFileEvent['kind']): boolean {
  return (
    kind === 'write' || kind === 'create' || kind === 'changed-summary' || kind === 'viewed-summary'
  )
}

/**
 * Folds an event into the bucket's existing row, returning whether it did.
 *
 * `at` deliberately stays at the first event (MAP L-D) so the feed's seq order
 * and timestamp order agree; `lastAt` carries the newest so coalescing can tell
 * a continuing save from a new one across deliveries. `count` is written only
 * once it exceeds one — absent means a single save.
 */
async function mergeIntoBucketRow(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  event: DriveFileEvent,
  entityId: Id<'fileActivityEntities'>,
): Promise<boolean> {
  if (event.kind === 'restore' || event.kind === 'read') return false
  const existing = await bucketRow(ctx, {
    workspaceId,
    entityId,
    actor: event.actor,
    at: event.at,
    isRead: event.kind === 'viewed-summary',
  })
  if (existing === null) return false
  // An entity keeps its identity across a rename, so the bucket row can outlive
  // the path it describes. A row states "this path was saved"; once the path
  // differs the run is over, and merging would leave the feed naming a location
  // the file no longer has.
  if (existing.path !== event.path) return false
  const previousAt = existing.lastAt ?? existing.at
  const added =
    event.kind === 'changed-summary' || event.kind === 'viewed-summary'
      ? event.count
      : isSameLogicalSave(previousAt, event.at)
        ? 0
        : 1
  await ctx.db.patch(existing._id, {
    ...(event.at > previousAt ? { lastAt: event.at } : {}),
    ...(added === 0 ? {} : { count: (existing.count ?? 1) + added }),
  })
  return true
}

async function recordRead(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  event: Extract<DriveFileEvent, { kind: 'read' }>,
  transition: NamespaceTransition,
): Promise<boolean> {
  const actor = parseActorContext(event.actor)
  // The schema already validated the string; parse only to feed the predicate.
  if (actor === null) throw new Error(`Invalid actor context: ${event.actor}`)
  // The durable backstop behind the pipeline's emission drop (MAP-SYNC Q10):
  // actors that emit no read markers leave no attention trace — no row or rollup.
  if (!actorEmitsReadMarkers(actor)) return false
  if (transition.entityId === null) throw new Error('read entity missing')
  await bumpRollup(ctx, workspaceId, {
    entityId: transition.entityId,
    actor: event.actor,
    at: event.at,
    write: false,
    count: 1,
  })
  const bucketStart = readBucketStart(event.at)
  // Scoped to the read side: a change row shares this bucket key and must
  // never answer this query (MAP L-A).
  const marker = await ctx.db
    .query('fileEvents')
    .withIndex('by_workspace_entity_actor_bucket_read', q =>
      q
        .eq('workspaceId', workspaceId)
        .eq('entityId', transition.entityId!)
        .eq('actorContext', event.actor)
        .eq('bucketStart', bucketStart)
        .eq('isRead', true),
    )
    .first()
  if (marker !== null) return false
  await ctx.db.insert('fileEvents', {
    workspaceId,
    seq: transition.sequence,
    kind: 'read',
    path: event.path,
    entityId: transition.entityId,
    actorContext: event.actor,
    bucketStart,
    at: event.at,
    isRead: true,
  })
  return true
}

const advanceScopeProjectionRef = makeFunctionReference<
  'mutation',
  { workspaceId: Id<'workspaces'> }
>('domains/fileActivity/projection:advanceProjection')

async function bumpRollup(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  touch: {
    entityId: Id<'fileActivityEntities'>
    actor: string
    at: number
    write: boolean
    count: number
  },
): Promise<void> {
  const row = await ctx.db
    .query('fileAccess')
    .withIndex('by_workspace_entity', q =>
      q
        .eq('workspaceId', workspaceId)
        .eq('entityId', touch.entityId)
        .eq('actorContext', touch.actor),
    )
    .unique()
  if (row === null) {
    await ctx.db.insert('fileAccess', {
      workspaceId,
      entityId: touch.entityId,
      actorContext: touch.actor,
      firstAt: touch.at,
      lastAt: touch.at,
      seenByAt: -touch.at,
      ...(touch.write ? { lastWriteAt: touch.at } : {}),
      readCount: touch.write ? 0 : touch.count,
      writeCount: touch.write ? touch.count : 0,
    })
    return
  }
  const lastAt = Math.max(row.lastAt, touch.at)
  await ctx.db.patch(row._id, {
    firstAt: Math.min(row.firstAt, touch.at),
    lastAt,
    seenByAt: -lastAt,
    ...(touch.write ? { lastWriteAt: Math.max(row.lastWriteAt ?? 0, touch.at) } : {}),
    readCount: row.readCount + (touch.write ? 0 : touch.count),
    writeCount: row.writeCount + (touch.write ? touch.count : 0),
  })
}
