import { z } from 'zod'

import { noisyTreeRoot, normalizeDrivePath } from '../drive/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'

// One canonical vocabulary for file-attribution actors, events, read buckets,
// and the file-event cursor. No other module re-derives the string grammar,
// bucket math, or cursor shape.

export type FileActorContext =
  | { kind: 'session'; sessionId: string }
  | { kind: 'api-key'; keyId: string }
  | { kind: 'web'; userId: string }
  | { kind: 'sync'; shareId: string } // syncthing share peer — NOT a mirror device
  | { kind: 'mirror'; deviceId: string } // independent sync-machine identity
  | { kind: 'terminal' }
  | { kind: 'system' }

export type FileActorKind = FileActorContext['kind']

const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/

function encodeActorId(kind: string, id: string): string {
  if (!ACTOR_ID_PATTERN.test(id)) {
    throw new Error(`invalid ${kind} actor id: ${JSON.stringify(id)}`)
  }
  return `${kind}:${id}`
}

export function encodeActorContext(ctx: FileActorContext): string {
  switch (ctx.kind) {
    case 'session':
      return encodeActorId(ctx.kind, ctx.sessionId)
    case 'api-key':
      return encodeActorId(ctx.kind, ctx.keyId)
    case 'web':
      return encodeActorId(ctx.kind, ctx.userId)
    case 'sync':
      return encodeActorId(ctx.kind, ctx.shareId)
    case 'mirror':
      return encodeActorId(ctx.kind, ctx.deviceId)
    case 'terminal':
    case 'system':
      return ctx.kind
  }
}

export function parseActorContext(value: string): FileActorContext | null {
  if (value === 'terminal') return { kind: 'terminal' }
  if (value === 'system') return { kind: 'system' }
  const separator = value.indexOf(':')
  if (separator === -1) return null
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (!ACTOR_ID_PATTERN.test(id)) return null
  switch (kind) {
    case 'session':
      return { kind, sessionId: id }
    case 'api-key':
      return { kind, keyId: id }
    case 'web':
      return { kind, userId: id }
    case 'sync':
      return { kind, shareId: id }
    case 'mirror':
      return { kind, deviceId: id }
    default:
      return null
  }
}

// The ONE carve-out to uniform read semantics (MAP-SYNC Q10): mirror reads are
// mechanical mirroring, not attention — no read markers, no activity. Enforced
// only through this predicate; no module hardcodes 'mirror'.
export function actorEmitsReadMarkers(ctx: FileActorContext): boolean {
  return ctx.kind !== 'mirror'
}

export const DUET_ACTOR_CONTEXT_HEADER = 'x-duet-actor-context'

// The ONE tweakable read-bucket constant (MAP Q7). Reused as the fold bucket
// (D5): bucket size proved near-irrelevant to the outcome (1h/6h/24h all land
// within 2% of each other on production data), so a second time constant would
// be a knob with nothing to tune.
export const READ_BUCKET_MS = 6 * 60 * 60 * 1000

export function readBucketStart(at: number): number {
  return Math.floor(at / READ_BUCKET_MS) * READ_BUCKET_MS
}

/**
 * Folding policy (MAP D5, D7, D8). These three live together because they are
 * one decision — how much of the watcher's raw syscall stream reaches the audit
 * log — and splitting them across packages is how the policy drifts.
 *
 * The watcher reports one event per `write()` syscall, so a single 9 MB file
 * streaming to disk produces ~1,900 events for one path in 0.3s. Counting those
 * as edits makes the feed state a falsehood; on production data 96% of repeated
 * writes to one path are a stream, not repeated saves.
 */
export const WRITE_COALESCE_MS = 1_000

/**
 * Distinct FILES, never events — at 2.37 events per file, an event threshold
 * would fold ordinary work. Above this many distinct files from one actor in
 * one directory and delivery, the group collapses to a single folder summary.
 */
export const FOLD_DISTINCT_FILES = 10

/** Consecutive writes inside this window are one logical save. */
export function isSameLogicalSave(previousAt: number, nextAt: number): boolean {
  return nextAt - previousAt <= WRITE_COALESCE_MS
}

/**
 * How far back the audit log reaches (MAP D2). Folding bounds how many rows a
 * burst can produce; this bounds how long they live, so neither table grows
 * without end. It sits beside the folding policy because both answer the same
 * question — how much of the watcher's output the log keeps — and splitting
 * them across packages is how the two drift apart.
 */
export const FILE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const ActorContextStringSchema = z
  .string()
  .refine(value => parseActorContext(value) !== null, { message: 'invalid actor context' })

export const FILE_ACTIVITY_LIMITS = {
  maxPathBytes: 4_096,
  maxPathSegments: 128,
  maxEventsPerBatch: 500,
  maxBatchPathSegments: 16_384,
  maxProjectorOperations: 64,
} as const

const utf8 = new TextEncoder()

const DriveRelativePathSchema = z.string().superRefine((value, ctx) => {
  const result = normalizeDrivePath(value)
  if (!result.ok || result.relativePath !== value) {
    ctx.addIssue({ code: 'custom', message: 'path must be drive-relative and normalized' })
    return
  }
  if (utf8.encode(value).byteLength > FILE_ACTIVITY_LIMITS.maxPathBytes) {
    ctx.addIssue({ code: 'custom', message: 'path exceeds byte limit' })
  }
  if (value.split('/').length > FILE_ACTIVITY_LIMITS.maxPathSegments) {
    ctx.addIssue({ code: 'custom', message: 'path exceeds segment limit' })
  }
})

const eventBase = {
  actor: ActorContextStringSchema,
  at: z.number().int().nonnegative(),
}

const EntryKindSchema = z.enum(['file', 'folder'])
const SummaryCountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const NoisyTreePathSchema = DriveRelativePathSchema.refine(path => noisyTreeRoot(path) === path, {
  message: 'summary path must be a noisy-tree root',
})

const eventShapes = {
  write: { kind: z.literal('write'), path: DriveRelativePathSchema },
  create: { kind: z.literal('create'), entryKind: EntryKindSchema, path: DriveRelativePathSchema },
  delete: { kind: z.literal('delete'), entryKind: EntryKindSchema, path: DriveRelativePathSchema },
  rename: {
    kind: z.literal('rename'),
    entryKind: EntryKindSchema,
    path: DriveRelativePathSchema,
    fromPath: DriveRelativePathSchema,
  },
  read: { kind: z.literal('read'), path: DriveRelativePathSchema },
  changedSummary: {
    kind: z.literal('changed-summary'),
    path: NoisyTreePathSchema,
    count: SummaryCountSchema,
  },
  viewedSummary: {
    kind: z.literal('viewed-summary'),
    path: NoisyTreePathSchema,
    count: SummaryCountSchema,
  },
  restore: { kind: z.literal('restore') },
}

/**
 * Strict on purpose, and the reason is identity: `userId` is resolved
 * server-side at read time (`resolvedEventBase` below), so an ingest that
 * tolerated one from the caller would accept a spoofed author. Strictness also
 * refuses the pre-cutover `size`/`mtimeMs` fields and wrong-variant keys, which
 * would otherwise leave an old producer silently half-working.
 */
export const DriveFileEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventShapes.write, ...eventBase }),
  z.strictObject({ ...eventShapes.create, ...eventBase }),
  z.strictObject({ ...eventShapes.delete, ...eventBase }),
  z.strictObject({ ...eventShapes.rename, ...eventBase }),
  z.strictObject({ ...eventShapes.read, ...eventBase }),
  z.strictObject({ ...eventShapes.changedSummary, ...eventBase }),
  z.strictObject({ ...eventShapes.viewedSummary, ...eventBase }),
  // restore is one workspace-wide event, never a per-file storm (MAP L6);
  // it covers every path, so it carries none (docs-first review: an empty-
  // string sentinel read as a real path).
  z.strictObject({ ...eventShapes.restore, ...eventBase }),
])
export type DriveFileEvent = z.infer<typeof DriveFileEventSchema>

// Read responses add resolved identity at the backend query seam. This is a
// different contract from gateway ingest: callers never supply userId, and
// accepted-and-ignored ingest fields never echo back out.
const resolvedEventBase = {
  ...eventBase,
  userId: z.string().min(1).optional(),
}

/**
 * Read-side only, and for the same reason `userId` is: the count is derived
 * server-side. It is the number of times the file was SAVED in the bucket —
 * consecutive writes within `WRITE_COALESCE_MS` are one save — never the number
 * of `write()` syscalls, which is what the watcher actually observes and which
 * runs to four figures for a single large file. Absent means one.
 *
 * Deliberately not on `DriveFileEventSchema`: the gateway reports events, it
 * does not get to assert how many saves they amount to.
 */
const derivedCount = { count: SummaryCountSchema.optional() }

/**
 * A summary the SERVER folded sits on an ordinary directory, so the read side
 * drops the noisy-tree constraint that ingest keeps. The constraint still means
 * something on the wire: a summary the gateway reports really is a noisy-tree
 * root, because that is the only folding the gateway does.
 */
const resolvedSummaryShapes = {
  changedSummary: {
    kind: z.literal('changed-summary'),
    path: DriveRelativePathSchema,
    count: SummaryCountSchema,
    entryKind: EntryKindSchema.optional(),
  },
  viewedSummary: {
    kind: z.literal('viewed-summary'),
    path: DriveRelativePathSchema,
    count: SummaryCountSchema,
    entryKind: EntryKindSchema.optional(),
  },
}

/**
 * `count` on a summary means two different things depending on who folded it,
 * and this is how a reader tells them apart.
 *
 * The gateway folds regenerable trees (`node_modules`, `.git`) and counts the
 * raw events it saw. The server folds an ordinary directory once too many
 * distinct files change in it, and counts those FILES — the whole point being
 * that an event count is inflated by the watcher's syscall stream. A server
 * fold is marked `entryKind: 'folder'`, so nothing has to infer the unit from
 * the path.
 */
export function summaryCountsFiles(event: { entryKind?: 'file' | 'folder' }): boolean {
  return event.entryKind === 'folder'
}

export const FileActivityEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventShapes.write, ...derivedCount, ...resolvedEventBase }),
  z.strictObject({ ...eventShapes.create, ...derivedCount, ...resolvedEventBase }),
  z.strictObject({ ...eventShapes.delete, ...derivedCount, ...resolvedEventBase }),
  z.strictObject({ ...eventShapes.rename, ...resolvedEventBase }),
  z.strictObject({ ...eventShapes.read, ...resolvedEventBase }),
  z.strictObject({ ...resolvedSummaryShapes.changedSummary, ...resolvedEventBase }),
  z.strictObject({ ...resolvedSummaryShapes.viewedSummary, ...resolvedEventBase }),
  z.strictObject({ ...eventShapes.restore, ...resolvedEventBase }),
])
export type FileActivityEvent = z.infer<typeof FileActivityEventSchema>

/**
 * The envelope is tolerant while its events are strict, and the split is
 * deliberate. The VM gateway that posts this updates on its own schedule, so a
 * strict envelope turns any field a newer producer adds into a rejected batch
 * until the API catches up — and an unknown key here changes nothing, because
 * the workspace is derived from the VM's token and never read from the body.
 * The events themselves stay strict for a different reason: see
 * `DriveFileEventSchema`, which refuses a caller-supplied `userId`.
 */
export const FileEventBatchSchema = z
  .object({
    // Stable across relay retries — ingestion dedupes on it.
    batchId: z.string().min(1).max(128),
    events: z.array(DriveFileEventSchema).max(FILE_ACTIVITY_LIMITS.maxEventsPerBatch),
    droppedReads: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    overflow: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((batch, ctx) => {
    const pathSegments = batch.events.reduce((total, event) => {
      if (event.kind === 'restore') return total
      return (
        total +
        event.path.split('/').length +
        (event.kind === 'rename' ? event.fromPath.split('/').length : 0)
      )
    }, 0)
    if (pathSegments > FILE_ACTIVITY_LIMITS.maxBatchPathSegments) {
      ctx.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'batch exceeds path-segment limit',
      })
    }
  })
export type FileEventBatch = z.infer<typeof FileEventBatchSchema>

// Wire flag for read markers on history and feed. The parameter is symmetric;
// the defaults are not: history includes reads (attention), feed omits them
// (change) — docs-first review, slice 06.
const ReadsFlagSchema = z.enum(['1', '0'])

export const FileHistoryQuerySchema = CollectionPageQuerySchema.extend({
  path: DriveRelativePathSchema,
  reads: ReadsFlagSchema.optional(),
}).strict()

export const FileActivityFeedQuerySchema = z
  .object({
    ...CollectionPageQuerySchema.shape,
    reads: ReadsFlagSchema.optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
    path: DriveRelativePathSchema.optional(),
    scope: z.enum(['exact', 'subtree']).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.scope !== undefined && query.path === undefined) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'scope requires path' })
    }
  })

// The SSE stream is the feed without pagination: the server pages internally,
// so the client names only a resume point (the same cursor grammar the
// Last-Event-ID header carries) and the feed's reads opt-in.
export const FileEventsStreamQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    reads: ReadsFlagSchema.optional(),
  })
  .strict()

export const FileSeenByQuerySchema = CollectionPageQuerySchema.extend({
  path: DriveRelativePathSchema,
}).strict()

// One exact-path rollup lookup per entry, so the batch is bounded, not paged.
export const LATEST_WRITERS_MAX_PATHS = 500

export const LatestWritersQuerySchema = z.object({
  // '' names the drive root; anything else is a normalized drive-relative dir.
  dir: z.union([z.literal(''), DriveRelativePathSchema]),
  // Repeated `path` query parameters, one per directory entry.
  path: z.array(DriveRelativePathSchema).max(LATEST_WRITERS_MAX_PATHS),
})

// The SSE wire shape ({ seq, event }) and the REST history/feed row.
export const FileFeedEventSchema = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  event: FileActivityEventSchema,
})
export type FileFeedEvent = z.infer<typeof FileFeedEventSchema>

export const FileHistoryResponseSchema = collectionPageSchema(FileFeedEventSchema)
export type FileHistoryResponse = z.infer<typeof FileHistoryResponseSchema>

export const LatestWritersResponseSchema = z.object({
  writers: z.array(
    z.object({
      path: z.string(),
      actor: z.string(),
      userId: z.string().optional(),
      lastWriteAt: z.number(),
    }),
  ),
})
export type LatestWritersResponse = z.infer<typeof LatestWritersResponseSchema>

const SeenByEntrySchema = z.object({
  actor: ActorContextStringSchema,
  userId: z.string().min(1).optional(),
  firstAt: z.number().int().nonnegative(),
  lastAt: z.number().int().nonnegative(),
  lastWriteAt: z.number().int().nonnegative().optional(),
  readCount: z.number().int().nonnegative(),
  writeCount: z.number().int().nonnegative(),
})
export type SeenByEntry = z.infer<typeof SeenByEntrySchema>

export const SeenByResponseSchema = collectionPageSchema(SeenByEntrySchema)
export type SeenByResponse = z.infer<typeof SeenByResponseSchema>
