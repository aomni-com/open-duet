import { z, type ZodType } from 'zod'

import {
  AgentCwdSchema,
  AgentMessageRequestSchema,
  AgentSessionStatusSchema,
  AgentSessionTimelineEventReadSchema,
  AgentFollowUpQueueEntrySchema,
  AgentStateMachineDefinitionSchema,
  AgentStateMachineSessionSchema,
  AgentTodoSchema,
  RunnerDeliveryAttemptSchema,
  type SessionCreationAudienceInput,
  type AgentSessionStatus,
  type AgentStateMachineSession,
} from '../agent/index'
import { AGENT_FIRST_MESSAGE_MAX_LENGTH, AgentIdentitySchema } from '../agents/index'
import { ModelSelectionIdSchema } from '../model-tiers/index'
import {
  COLLECTION_PAGE_MAX_LIMIT,
  CollectionPageQuerySchema,
  collectionPageSchema,
  createBoundCursorCodec,
} from '../pagination/index'
import { WorkspaceRoleSchema } from '../workspaces/index'
import { WORKSPACE_MEMBER_LIMIT } from '../workspaces/limits'
import { excerpt, sentMediaLabel, type SentMedia } from './excerpt'
import { MessagePreviewSchema } from './message-preview'

export * from './message-preview'
export type { SentMedia } from './excerpt'

/**
 * The identity used for session authorization. Attribution travels beside it
 * because a workspace credential can carry a human-shaped billing actor
 * without becoming that human.
 */
export type SessionPrincipal = { kind: 'human'; userId: string } | { kind: 'workspace' }

export interface SessionRequestIdentity {
  principal: SessionPrincipal
  actorId: string
}

export type EffectiveSessionCreationAudience =
  | { kind: 'workspace' }
  | { kind: 'specific'; memberUserIds: string[] }

/** The effective audience persisted for a newly created session. */
export function effectiveSessionCreationAudience(
  principal: SessionPrincipal,
  audience: SessionCreationAudienceInput | { kind: 'workspace' } | undefined,
): EffectiveSessionCreationAudience | null {
  if (audience === undefined || audience.kind === 'workspace') return { kind: 'workspace' }
  const memberUserIds = new Set(audience.memberUserIds)
  if (principal.kind === 'human') memberUserIds.add(principal.userId)
  if (memberUserIds.size === 0) return null
  return { kind: 'specific', memberUserIds: [...memberUserIds].sort() }
}

export const SessionDeletionDisposalPlanSchema = z
  .object({
    workspaceSlug: z.string(),
    sessionId: z.string(),
    providerSessionId: z.string().optional(),
  })
  .nullable()
export type SessionDeletionDisposalPlan = z.infer<typeof SessionDeletionDisposalPlanSchema>

export const SessionDeletionDisposalResultSchema = z.union([
  z
    .object({
      status: z.literal('disposed'),
      runner: z.literal('absent'),
      providerAttempted: z.boolean(),
    })
    .loose(),
  z.object({ status: z.literal('noop') }).loose(),
])
export type SessionDeletionDisposalResult = z.infer<typeof SessionDeletionDisposalResultSchema>

const SESSION_TITLE_ORIGINS = ['excerpt', 'auto', 'manual'] as const
const SESSION_TITLE_STATUSES = ['generating', 'complete', 'failed'] as const

const SessionTitleOriginSchema = z.enum(SESSION_TITLE_ORIGINS)
const SessionTitleStatusSchema = z.enum(SESSION_TITLE_STATUSES)

// What a session is *doing*, as a reader asks it — the one dimension every
// list groups and pages by.
//
// It is not `status`. `status` is the last turn's terminal state, and for a
// session running a state machine the two diverge: a machine that finished one
// state and moved to the next reports `status: 'complete'` while it is very
// much still running. Grouping by `status` files live work under "finished".
//
// So the bucket reads the machine where there is one and the turn where there
// is not, and it is materialized on the row (see `bucketOf`) because Convex
// cannot index a derivation — the same reason the old `jobView` column existed,
// applied to the value the product actually groups by.
export const SESSION_BUCKETS = ['asking', 'running', 'scheduled', 'done'] as const
export const SessionBucketSchema = z.enum(SESSION_BUCKETS)
export type SessionBucket = z.infer<typeof SessionBucketSchema>

/**
 * Why the CONTROL PLANE ended a turn the VM could not end itself: a paused
 * workspace, a deleted agent, a VM that never came up, a stop no runner took.
 * The backend stamps one of these on the `interrupted` marker it appends and
 * the web app reads it back as prose, so it is their shared contract rather
 * than either side's private vocabulary. A runner's own `error` is free text
 * and is never one of these.
 */
export const SESSION_TURN_END_REASONS = [
  'workspace_paused',
  'agent_deleted',
  'workspace_provisioning_failed',
  'interrupt_undeliverable',
  'relay_backlog',
  'runner_exited',
  'relay_undeliverable',
  'session_discarded',
] as const
export type SessionTurnEndReason = (typeof SESSION_TURN_END_REASONS)[number]

/**
 * The reading order for a bounded activity list: work that needs a person,
 * work in motion, work waiting on a clock, then retained finished history.
 *
 * Unlike `SESSION_BUCKETS`, this order is semantic. The backend uses it to
 * choose which rows fit inside a limit and the web app uses it to seat and
 * group those rows, so it belongs to their shared contract rather than either
 * runtime.
 */
export const SESSION_ACTIVITY_PRIORITY = [
  'asking',
  'running',
  'scheduled',
  'done',
] as const satisfies readonly SessionBucket[]

/**
 * What a session is doing, from the two facts that can say.
 *
 * This lives in the contract rather than beside the column it stamps, because
 * two callers need the same answer: the backend, which materialises it onto the
 * row, and the SPA, which has to give a bucket to a row it is optimistically
 * authoring before the server has seen it. A second implementation of this rule
 * is a second definition of the product's central concept, and they would drift.
 *
 * Declared below `SessionBucketSchema` and above `MachineSchema` only because
 * the type it reads is declared there; the ordering carries no meaning.
 */
export function bucketOf(session: {
  turnStatus: AgentSessionStatus
  machine?: Pick<Machine, 'activity' | 'nextWakeAt' | 'outcome'>
}): SessionBucket {
  // Waiting on a person outranks everything else: it is the only state the
  // reader can clear, so it must never be filed under the machine's activity.
  if (session.turnStatus === 'ask') return 'asking'
  // Interruption stops execution; an unfinished machine is resumable history,
  // not evidence of an active runner or a scheduled wake.
  if (session.turnStatus === 'interrupted') return 'done'
  const machine = session.machine
  // A *live* machine outranks the turn, because it survives turn boundaries:
  // one state finishing reports `status: 'complete'` while the machine runs on.
  //
  // A machine that is over outranks nothing. Its `outcome` is a fact about the
  // past, and reading it as the present is how a follow-up message on a
  // finished job used to stay filed under "done" while its runner was working —
  // invisible to the reader *and* to the terminalization sweep, which only
  // walks the unfinished buckets.
  if (machine !== undefined && machine.outcome === undefined) {
    return machine.activity === 'sleeping' && machine.nextWakeAt !== undefined
      ? 'scheduled'
      : 'running'
  }
  if (session.turnStatus === 'running') return 'running'
  // A plain conversation that slept is on a clock exactly like a machine is.
  if (session.turnStatus === 'sleep') return 'scheduled'
  return 'done'
}

export const MachinePathItemSchema = z.object({
  key: z.string(),
  index: z.number().int().min(0),
  name: z.string(),
  kind: z.string().optional(),
  phase: z.enum(['past', 'current', 'future', 'outcome']),
  terminalStatus: z.enum(['completed', 'failed', 'cancelled', 'error']).optional(),
})

export type MachinePathItem = z.infer<typeof MachinePathItemSchema>

export const MachineSchema = z.object({
  definitionName: z.string().optional(),
  currentState: z.string().optional(),
  followingDefinitionState: z.string().optional(),
  progress: z
    .object({ completed: z.number().int().min(0), total: z.number().int().min(0) })

    .optional(),
  orderedPath: z.array(MachinePathItemSchema),
  activity: z.enum(['running', 'sleeping', 'waiting', 'idle']),
  nextWakeAt: z.number().optional(),
  outcome: z.enum(['interrupted', 'completed', 'failed', 'cancelled', 'error']).optional(),
})

export type Machine = z.infer<typeof MachineSchema>

export const SessionActivityMachineSchema = z.object({
  step: z.string().optional(),
  progress: MachineSchema.shape.progress,
  activity: MachineSchema.shape.activity,
  nextWakeAt: MachineSchema.shape.nextWakeAt,
  outcome: MachineSchema.shape.outcome,
})
export type SessionActivityMachine = z.infer<typeof SessionActivityMachineSchema>

export const SessionAudienceMemberPreviewSchema = z.object({
  memberId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.email(),
  role: WorkspaceRoleSchema,
})
export type SessionAudienceMemberPreview = z.infer<typeof SessionAudienceMemberPreviewSchema>

export const SESSION_AUDIENCE_PREVIEW_LIMIT = 5

export const SessionAudiencePageQuerySchema = CollectionPageQuerySchema
export const SessionAudiencePageSchema = collectionPageSchema(SessionAudienceMemberPreviewSchema)
export type SessionAudiencePage = z.infer<typeof SessionAudiencePageSchema>

export const SessionAudienceCursorPositionSchema = z
  .object({
    roleRank: z.number().int().min(0),
    normalizedName: z.string(),
    normalizedEmail: z.string(),
    membershipId: z.string(),
  })
  .strict()
export const sessionAudienceCursorCodec = createBoundCursorCodec(
  'sessions.audience',
  SessionAudienceCursorPositionSchema,
)

export const SessionAudienceDeltaRequestSchema = z
  .object({
    add: z.array(z.string()).max(WORKSPACE_MEMBER_LIMIT).optional(),
    remove: z.array(z.string()).max(WORKSPACE_MEMBER_LIMIT).optional(),
  })
  .strict()
  .superRefine((delta, ctx) => {
    const add = delta.add ?? []
    const remove = delta.remove ?? []
    if (add.length + remove.length === 0 || add.length + remove.length > WORKSPACE_MEMBER_LIMIT) {
      ctx.addIssue({ code: 'custom', message: 'invalid_audience_delta' })
    }
    if (new Set(add).size !== add.length || new Set(remove).size !== remove.length) {
      ctx.addIssue({ code: 'custom', message: 'invalid_audience_delta' })
    }
    const removed = new Set(remove)
    if (add.some(userId => removed.has(userId))) {
      ctx.addIssue({ code: 'custom', message: 'invalid_audience_delta' })
    }
  })
export type SessionAudienceDeltaRequest = z.infer<typeof SessionAudienceDeltaRequestSchema>

export const SessionAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z
    .object({
      kind: z.literal('specific'),
      count: z.number().int().min(0),
      preview: z.array(SessionAudienceMemberPreviewSchema).max(SESSION_AUDIENCE_PREVIEW_LIMIT),
    })
    .refine(audience => audience.count >= audience.preview.length),
])
export type SessionAudience = z.infer<typeof SessionAudienceSchema>

export const SessionArchiveSchema = z
  .object({
    globalArchivedAt: z.number().nullable(),
    personalArchivedAt: z.number().nullable(),
    reason: z.enum(['global', 'personal']).nullable(),
  })
  .refine(archive => {
    const reason =
      archive.globalArchivedAt !== null
        ? 'global'
        : archive.personalArchivedAt !== null
          ? 'personal'
          : null
    return archive.reason === reason
  })
export type SessionArchive = z.infer<typeof SessionArchiveSchema>

export const SessionPermissionsSchema = z.object({
  send: z.boolean(),
  answer: z.boolean(),
  interrupt: z.boolean(),
  rename: z.boolean(),
  manageAudience: z.boolean(),
  personalArchive: z.boolean(),
  globalArchive: z.boolean(),
  delete: z.boolean(),
})
export type SessionPermissions = z.infer<typeof SessionPermissionsSchema>

// One full summary for every session. A "job" is not a second entity — it is a
// session whose state machine has started, and the only thing that makes it
// look different is that `machine` is present. Readers narrow on that field.
export const SessionSummarySchema = z.object({
  id: z.string(),
  turnStatus: AgentSessionStatusSchema,
  bucket: SessionBucketSchema,
  title: z.string(),
  titleOrigin: SessionTitleOriginSchema,
  titleStatus: SessionTitleStatusSchema,
  cwd: z.string().optional(),
  agent: AgentIdentitySchema.optional(),
  // An agent's onboarding conversation. It is a real session — resumable and
  // directly readable — but it is excluded from every list and search, so the
  // dimension has to travel on the summary the client caches, not just on the
  // row the server queries.
  onboarding: z.boolean().optional(),
  createdBySessionId: z.string().optional(),
  // Present exactly when a state machine has started. Its absence is what
  // "this is a plain conversation" means on the wire.
  machine: MachineSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastEventSeq: z.number().int().min(0),
  // Viewer-relative, and server-owned: the comparison behind it needs the
  // reader's floor (when they joined the workspace), and a floor the client had
  // to be told about is a second place for it to be wrong. `false` whenever
  // there is no reader to be unread *to* — an internal caller is not a person.
  unread: z.boolean(),
  audience: SessionAudienceSchema,
  archive: SessionArchiveSchema,
  permissions: SessionPermissionsSchema,
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>

/**
 * A summary of the conversation an owner *is*, with the last thing said in it.
 *
 * Only the chat carries a preview, and that is the shape rather than an
 * omission: `sessions[]` is work, and work is described by its title. Extending
 * the summary rather than sitting beside it as a `chatPreview` field is what
 * makes the two impossible to disagree — a preview without a session, or a
 * session whose preview is somebody else's, cannot be expressed.
 *
 * Absent when the conversation holds nothing anyone said: an owner nobody has
 * written to, or one whose whole history is work. That is an ordinary state,
 * not a missing backfill.
 */
export const SESSION_ACTIVITY_TEXT_MAX_SCALARS = 120
export const SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES = 480

export function normalizeSessionActivityText(value: string): string {
  const encoder = new TextEncoder()
  let result = ''
  let scalars = 0
  let bytes = 0
  for (const scalar of value) {
    const scalarBytes = encoder.encode(scalar).byteLength
    if (
      scalars === SESSION_ACTIVITY_TEXT_MAX_SCALARS ||
      bytes + scalarBytes > SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES
    ) {
      break
    }
    result += scalar
    scalars += 1
    bytes += scalarBytes
  }
  return result
}

export function projectSessionActivityMachine(
  machine: Machine | undefined,
): SessionActivityMachine | undefined {
  if (machine === undefined) return undefined
  const step = machine.currentState ?? machine.definitionName
  return {
    ...(step === undefined ? {} : { step: normalizeSessionActivityText(step) }),
    ...(machine.progress === undefined ? {} : { progress: machine.progress }),
    activity: machine.activity,
    ...(machine.nextWakeAt === undefined ? {} : { nextWakeAt: machine.nextWakeAt }),
    ...(machine.outcome === undefined ? {} : { outcome: machine.outcome }),
  }
}

/** The bounded row-local shape used by the grouped activity computation. */
export const ActivitySessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  bucket: SessionBucketSchema,
  updatedAt: z.number(),
  unread: z.boolean(),
  machine: SessionActivityMachineSchema.optional(),
})
export type ActivitySessionSummary = z.infer<typeof ActivitySessionSummarySchema>

/** A collection row keeps only the bounded machine state needed by Jobs. */
export const SessionListItemSchema = SessionSummarySchema.omit({ machine: true }).extend({
  machine: SessionActivityMachineSchema.optional(),
})
export type SessionListItem = z.infer<typeof SessionListItemSchema>

export function projectSessionListItem(summary: SessionSummary): SessionListItem {
  const { machine, ...row } = summary
  const projectedMachine = projectSessionActivityMachine(machine)
  return {
    ...row,
    ...(projectedMachine === undefined ? {} : { machine: projectedMachine }),
  }
}

export function projectActivitySessionSummary(
  summary: SessionSummary | SessionListItem,
): ActivitySessionSummary {
  const machine =
    summary.machine !== undefined && 'orderedPath' in summary.machine
      ? projectSessionActivityMachine(summary.machine)
      : summary.machine
  return {
    id: summary.id,
    title: normalizeSessionActivityText(summary.title),
    bucket: bucketOf(summary),
    updatedAt: summary.updatedAt,
    unread: summary.unread,
    ...(machine === undefined ? {} : { machine }),
  }
}
export const ChatActivitySchema = ActivitySessionSummarySchema.extend({
  preview: MessagePreviewSchema.optional(),
})
export type ChatActivity = z.infer<typeof ChatActivitySchema>

export const SessionSnapshotSchema = SessionSummarySchema.extend({
  workspaceId: z.string(),
  tier: ModelSelectionIdSchema.optional(),
  lastDeliveredInputSeq: z.number().int().min(0),
  deliveryAttempt: RunnerDeliveryAttemptSchema.optional(),
  todos: z.array(AgentTodoSchema).optional(),
  followUpQueue: z.array(AgentFollowUpQueueEntrySchema).optional(),
  requestedMachine: AgentStateMachineDefinitionSchema.optional(),
  machineState: AgentStateMachineSessionSchema.optional(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>

/**
 * The default-chat alias read. `session: null` is an ANSWER, not an error:
 * the owner simply has no default chat yet, which is the ordinary state of an
 * agent nobody has written to (the pointer is stamped by the first message,
 * never by opening anything). It used to be a 404, which was semantically
 * right and practically wrong — browsers log every 4xx to the console, so a
 * fresh drive's map painted a wall of phantom errors on every load.
 */
export const DefaultSessionResponseSchema = z.object({
  session: SessionSnapshotSchema.nullable(),
})
export type DefaultSessionResponse = z.infer<typeof DefaultSessionResponseSchema>

/* `event` is the tolerant READ union (map D10): an event type minted after
   this bundle shipped parses opaquely instead of failing the response, and
   readers gate on `isKnownTimelineEvent`. */
export const SessionTimelineEntrySchema = z.object({
  seq: z.number().int().positive(),
  event: AgentSessionTimelineEventReadSchema,
  createdAt: z.number(),
})
export type SessionTimelineEntry = z.infer<typeof SessionTimelineEntrySchema>

export const SessionListPageSchema = collectionPageSchema(SessionListItemSchema)
export type SessionListPage = z.infer<typeof SessionListPageSchema>

/**
 * One owner's sessions for an activity summary.
 *
 * `agentId` is an agent's id, or `ROOT_AGENT_SCOPE` for sessions no agent owns —
 * the same vocabulary `SessionListQuerySchema.agentId` filters by, so the value
 * you read here is the value you can send back.
 */
export const AgentActivitySchema = z.object({
  agentId: z.string(),
  /**
   * Ordered `asking` → `running` → `scheduled` → `done`, then most
   * recently updated inside each bucket. Unfinished work always takes the
   * limited seats before completed history fills what remains.
   *
   * The owner's own chat is **not** among them — it is `chat` below. It is work
   * that competes for these seats, and the conversation you have with an owner
   * is not work.
   */
  sessions: z.array(ActivitySessionSummarySchema),
  /** this owner has more sessions than `limitPerAgent` returned */
  truncated: z.boolean(),
  /**
   * The conversation this owner *is* — what `…/sessions/default` resolves to,
   * read from the pointer on the owner's row (`agents.defaultSessionId`,
   * `workspaces.rootDefaultSessionId`). Absent when the pointer is unset:
   * nobody has written to this owner yet, or the chat was demoted back into
   * ordinary work.
   *
   * Filtered by the pointer alone, so unlike `sessions` it can carry an
   * *archived* row — the alias answers the same way, and the panel opens on it.
   * A reader filtering work on effective archive state should not expect the two halves to
   * agree; they answer different questions.
   *
   * Here rather than left in `sessions` because every reader has to tell the
   * two apart and only the pointer can. A client that could not would have to
   * ask one alias per owner to find out — which is what this field replaced,
   * and which had a window on every cold load where the chat was drawn as work
   * because the answer had not arrived yet.
   *
   * Separating it is also what makes the numbers beside it mean anything:
   * `sessions` spends its seats on work alone, `truncated` counts work alone,
   * and the recency this response is ordered by moves when an owner *does*
   * something rather than when somebody talks to it.
   */
  chat: ChatActivitySchema.optional(),
})
export type AgentActivity = z.infer<typeof AgentActivitySchema>

/**
 * Every owner's prioritized activity in one round trip.
 *
 * The capability is the fan-out: one request instead of one per agent, which is
 * what makes a whole-workspace overview affordable. It is otherwise the same
 * question `GET /agent/sessions?agentId=…&bucket=…` answers per agent — so it
 * pages nothing and filters nothing; ask the list endpoint when you need either.
 */
export const SessionActivityResponseSchema = z.object({
  /**
   * Most recently active owner first, where "active" is a question about work:
   * an owner sorts by its newest *session*, never by its `chat`, so talking to
   * one does not seat it above one that is working.
   *
   * An owner is here when it has either. `sessions` may be empty — an owner
   * nobody has given work to still has a face to draw and a conversation behind
   * it — so a reader looking for owners must not filter on `sessions.length`.
   */
  owners: z.array(AgentActivitySchema),
})
export type SessionActivityResponse = z.infer<typeof SessionActivityResponseSchema>

/** The fixed per-owner budget for the grouped activity computation. */
export const SESSION_ACTIVITY_DEFAULT_LIMIT = 20
export const SESSION_ACTIVITY_MAX_LIMIT = 20
export const SessionActivityQuerySchema = z.object({
  limitPerAgent: z.coerce
    .number()
    .int()
    .min(1)
    .max(SESSION_ACTIVITY_MAX_LIMIT)
    .optional()
    .default(SESSION_ACTIVITY_DEFAULT_LIMIT),
})

export const SessionInitialHistorySnapshotSchema = z.object({
  events: z.array(SessionTimelineEntrySchema),
})
export type SessionInitialHistorySnapshot = z.infer<typeof SessionInitialHistorySnapshotSchema>

export const SessionHistoryPageSchema = collectionPageSchema(SessionTimelineEntrySchema)
export type SessionHistoryPage = z.infer<typeof SessionHistoryPageSchema>

export const SessionListCursorCodec = createBoundCursorCodec(
  'sessions.list',
  z.object({ scannedThroughOrderKey: z.string().min(1) }).strict(),
)
export const SessionChildrenCursorCodec = createBoundCursorCodec(
  'sessions.children',
  z.object({ scannedThroughOrderKey: z.string().min(1) }).strict(),
)
export const SessionHistoryCursorCodec = createBoundCursorCodec(
  'sessions.history',
  z.object({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
)
export const DefaultSessionHistoryCursorCodec = createBoundCursorCodec(
  'agents.defaultSession.history',
  z
    .object({
      sessionId: z.string().min(1),
      seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
)

// Agent scope of a session list query. Omitting `agentId` is unscoped;
// `ROOT_AGENT_SCOPE` (owned by the slug module — it is the reserved slug)
// selects rows with no agent; any other value is an agent id. The wire type is
// a bare string either way — the backend narrows `'root'` to
// `q.eq('agentId', undefined)` and everything else to an agent id.

// One list, one query. `bucket` is the paged dimension: every group a reader
// sees is a bucket, and each pages independently and completely, so a group is
// never missing rows that happened to fall past someone else's page boundary.
export const SESSION_LIST_MAX_LIMIT = Math.min(WORKSPACE_MEMBER_LIMIT, COLLECTION_PAGE_MAX_LIMIT)

/**
 * The page every session collection shares: one bucket, one archive mode, and
 * one list budget. The list layers its search and scope filters on top; the
 * direct-children read is exactly this shape under a parent.
 */
const SessionCollectionQuerySchema = CollectionPageQuerySchema.extend({
  bucket: SessionBucketSchema.optional(),
  archived: z.enum(['exclude', 'only']).default('exclude'),
}).refine(query => query.limit <= SESSION_LIST_MAX_LIMIT, {
  message: 'limit exceeds the session list budget',
  path: ['limit'],
})

export const SessionListQuerySchema = SessionCollectionQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
  agentId: z.string().min(1).optional(),
  /**
   * Leave out the owner's own chat — the session its `…/sessions/default` alias
   * resolves to.
   *
   * For the jobs dialog, which lists everything an agent has done *beside* a
   * panel already holding that one thread; a row for it there is the same
   * conversation offered twice, once under a heading calling it work.
   *
   * Only meaningful with `agentId`, and rejected without it: every owner has its
   * own default, so "leave out the default" over a whole drive would mean one
   * row per face. The wire refuses rather than guessing — a filter that
   * silently does nothing is worse than one that is not offered.
   *
   * Deliberately a query argument rather than a field on the summary. The fact
   * lives on the owner's row (`agents.defaultSessionId`,
   * `workspaces.rootDefaultSessionId`) and stays there; a column on the session
   * would be a second owner of one fact.
   */
  excludeDefault: z
    .union([z.literal(true), z.literal('true')])
    .transform(() => true as const)
    .optional(),
  /** Only sessions with no parent — the roots of the lineage tree. */
  topLevel: z
    .union([z.literal(true), z.literal('true')])
    .transform(() => true as const)
    .optional(),
}).refine(query => query.excludeDefault !== true || query.agentId !== undefined, {
  message: 'excludeDefault requires agentId',
  path: ['excludeDefault'],
})

export const SessionChildrenQuerySchema = SessionCollectionQuerySchema
export type SessionChildrenQuery = z.infer<typeof SessionChildrenQuerySchema>

export const SESSION_HISTORY_VIEWS = ['all', 'transcript'] as const
export type SessionHistoryView = (typeof SESSION_HISTORY_VIEWS)[number]

export const SessionHistoryQuerySchema = CollectionPageQuerySchema.extend({
  order: z.enum(['asc', 'desc']).default('desc'),
  /**
   * `transcript` pages only the rows a reader sees (see `isTranscriptEvent`);
   * `all` is the full timeline the runner and wait callers replay. A cursor is
   * bound to its view.
   */
  view: z.enum(SESSION_HISTORY_VIEWS).default('all'),
  /** Begin an ascending replay strictly after this durable event sequence. */
  afterSeq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).refine(query => query.afterSeq === undefined || query.order === 'asc', {
  message: 'afterSeq requires ascending order',
  path: ['afterSeq'],
})

/** Session reconnect state lives exclusively in the standard Last-Event-ID header. */
export const SessionEventResumeQuerySchema = z.object({}).strict()

export function parseSessionLastEventId(
  raw: string | null | undefined,
): { ok: true; afterSeq: number } | { ok: false; error: 'invalid_last_event_id' } {
  if (raw === null || raw === undefined) return { ok: true, afterSeq: 0 }
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || raw.length > 16) {
    return { ok: false, error: 'invalid_last_event_id' }
  }
  const afterSeq = Number(raw)
  return Number.isSafeInteger(afterSeq)
    ? { ok: true, afterSeq }
    : { ok: false, error: 'invalid_last_event_id' }
}

export const SessionRenameRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
})

export const SessionCwdRequestSchema = z.object({ cwd: AgentCwdSchema })

export const SessionCwdResponseSchema = z.object({
  session: z.object({ id: z.string(), cwd: AgentCwdSchema }),
})

export const SessionCwdErrorSchema = z.object({
  error: z.literal('invalid_cwd'),
  reason: z.enum(['missing', 'not_a_directory', 'outside_drive', 'outside_agent_anchor']),
})

const SESSION_ERROR_OPTIONS = {
  not_found: z
    .object({ error: z.literal('not_found') })
    .describe('The session is unavailable to this caller (404)'),
  no_default_session: z
    .object({ error: z.literal('no_default_session') })
    .describe('The selected owner has no default session (404)'),
  audience_kind_immutable: z
    .object({ error: z.literal('audience_kind_immutable') })
    .describe('This session does not have a specific-people audience (409)'),
  invalid_audience_member: z.object({ error: z.literal('invalid_audience_member') }),
  invalid_audience_delta: z.object({ error: z.literal('invalid_audience_delta') }),
  forbidden: z.object({ error: z.literal('forbidden') }),
  invalid_request: z.object({ error: z.literal('invalid_request') }),
  idempotency_conflict: z.object({ error: z.literal('idempotency_conflict') }),
} as const

type SessionErrorCode = keyof typeof SESSION_ERROR_OPTIONS

/** Compose the exact session-error subset an operation can return. */
export function sessionErrorSchema(...codes: [SessionErrorCode, ...SessionErrorCode[]]): ZodType {
  const schemas = codes.map(code => SESSION_ERROR_OPTIONS[code])
  return schemas.slice(1).reduce<ZodType>((schema, next) => schema.or(next), schemas[0]!)
}

export const SessionErrorSchema = z.discriminatedUnion('error', [
  SESSION_ERROR_OPTIONS.not_found,
  SESSION_ERROR_OPTIONS.no_default_session,
  SESSION_ERROR_OPTIONS.audience_kind_immutable,
  SESSION_ERROR_OPTIONS.invalid_audience_member,
  SESSION_ERROR_OPTIONS.invalid_audience_delta,
  SESSION_ERROR_OPTIONS.forbidden,
  SESSION_ERROR_OPTIONS.invalid_request,
  SESSION_ERROR_OPTIONS.idempotency_conflict,
])
export type SessionError = z.infer<typeof SessionErrorSchema>

export const SessionArchiveRequestSchema = z
  .object({
    kind: z.enum(['personal', 'global']),
    archived: z.boolean(),
  })
  .strict()

/**
 * How far the caller has read this session.
 *
 * `seq` is an event sequence number, the same one `lastEventSeq` reports — not a
 * timestamp. Clock skew between a laptop and the backend would otherwise decide
 * what counts as unread.
 */
export const SessionReadRequestSchema = z.object({ seq: z.number().int().min(0) })

/**
 * The cursor after the write, which may be *ahead* of what was sent: the stamp
 * is a maximum, so a late flush is answered with the value that won.
 */
export const SessionReadResponseSchema = z.object({ lastReadSeq: z.number().int().min(0) })

export type SessionReadResponse = z.infer<typeof SessionReadResponseSchema>

export const SessionCreateResponseSchema = z.object({
  session: z.object({
    sessionId: z.string(),
    status: AgentSessionStatusSchema,
    lastEventSeq: z.number().int().min(0),
    lastDeliveredInputSeq: z.number().int().min(0),
  }),
  snapshot: SessionSnapshotSchema,
  history: SessionInitialHistorySnapshotSchema,
  dispatched: z.literal(false),
  delivery: z.enum(['accepted', 'queued']),
})
export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>

export const SessionInputResponseSchema = z.object({
  ok: z.literal(true),
  delivery: z.enum(['accepted', 'queued']),
})
export type SessionInputResponse = z.infer<typeof SessionInputResponseSchema>

export const SessionWaitCompletedResponseSchema = z.object({
  sessionId: z.string().min(1),
  inputSeq: z.number().int().positive(),
  // The awaited session's working directory (absent for root sessions).
  // Relative file paths quoted from `terminal.event.result` are relative to
  // THIS cwd, not the caller's — a caller in a different cwd must rewrite
  // them before repeating them in its own messages.
  cwd: AgentCwdSchema.optional(),
  terminal: SessionTimelineEntrySchema,
})
export type SessionWaitCompletedResponse = z.infer<typeof SessionWaitCompletedResponseSchema>

export const SessionWaitPendingResponseSchema = z.object({
  sessionId: z.string().min(1),
  inputSeq: z.number().int().positive(),
  status: z.literal('pending'),
})
export type SessionWaitPendingResponse = z.infer<typeof SessionWaitPendingResponseSchema>

export const SessionWaitResponseSchema = z.union([
  SessionWaitCompletedResponseSchema,
  SessionWaitPendingResponseSchema,
])
export type SessionWaitResponse = z.infer<typeof SessionWaitResponseSchema>

// `default` chooses launch mode server-side. A `mode` in this body is unknown
// key noise like it is on the ordinary message route and is never forwarded.
//
// `agentFirstMessage` is a default-route affordance only (map D2/D6): the
// client that just rendered an agent's suggested first message sends the same
// text here, and creation materializes it as the session's `agent_message`
// event. Optional by design — a client that never implements it loses
// nothing. On the ordinary message route the key is unknown noise, which is
// exactly the redirect semantics: a session that already exists cannot gain
// a first message.
export type DefaultSessionMessageRequestInput = z.input<typeof DefaultSessionMessageRequestSchema>
export const DefaultSessionMessageRequestSchema = AgentMessageRequestSchema.safeExtend({
  // Raw on the wire (no transform — these schemas render as JSON Schema for
  // the endpoint docs); the create path trims and drops blanks server-side.
  agentFirstMessage: z.string().max(AGENT_FIRST_MESSAGE_MAX_LENGTH).optional(),
}).strict()

export const DefaultSessionMessageWaitRequestSchema = DefaultSessionMessageRequestSchema.safeExtend(
  {
    clientRequestId: z.string().uuid(),
  },
)
export type DefaultSessionMessageWaitRequest = z.infer<
  typeof DefaultSessionMessageWaitRequestSchema
>

export const DefaultSessionInputResponseSchema = SessionInputResponseSchema.extend({
  sessionId: z.string().min(1),
})

export const DefaultSessionMessageResponseSchema = z.union([
  SessionCreateResponseSchema,
  DefaultSessionInputResponseSchema,
])

/**
 * Point an owner's default-chat alias at a session, or at nothing.
 *
 * `null` is the whole reason this exists: it demotes the current default chat
 * to an ordinary session — it leaves `listSessions` under `excludeDefault` and
 * enters it, and the owner's next message mints a fresh default through the
 * ordinary create path. Nothing is archived and nothing is deleted; the only
 * durable change is the pointer on the owner's row.
 *
 * Raw on the wire (no transform — these schemas render as JSON Schema for the
 * endpoint docs).
 */
export const SetDefaultSessionRequestSchema = z.object({
  sessionId: z.string().min(1).nullable(),
})
export type SetDefaultSessionRequestInput = z.input<typeof SetDefaultSessionRequestSchema>

export const SessionInterruptResponseSchema = z.object({ ok: z.literal(true) })
export const SessionNoteResponseSchema = z.object({ seq: z.number().int().positive() })

export const SessionEventStreamFrameSchema = z.object({
  seq: z.number().int().positive().optional(),
  // The durable row's own clock, so a turn's span reads the same live as it
  // does from a later history load. Absent on ephemeral frames and on frames
  // from an API that predates it.
  createdAt: z.number().optional(),
  event: AgentSessionTimelineEventReadSchema,
})

/**
 * A session's title, when it is derived from the prompt that opened it.
 *
 * The width is the title's own fact, not the cut's: `excerpt` is shared with
 * the chat preview, which is twice as wide because it lives on a wider surface.
 */
export function sessionTitleExcerpt(prompt: string, maxLength = 72): string {
  return excerpt(prompt, maxLength)
}

/**
 * What a new session is called until a generated title replaces it — on the
 * server and on any surface drawing the session before the server answers.
 * The prompt's own words when it has any; a first message that is only files
 * is named by them, because they are all the sender said.
 */
export function initialSessionTitle(input: SentMedia & { prompt: string }): string {
  if (input.prompt.trim().length > 0) return sessionTitleExcerpt(input.prompt)
  return sessionTitleExcerpt(sentMediaLabel(input))
}

export function normalizeGeneratedSessionTitle(value: string): string | null {
  const normalized = value
    .replace(/^\s*["“”']+|["“”']+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length === 0) return null
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119).trimEnd()}…`
}

export function projectMachine(
  stateMachine: AgentStateMachineSession,
  observation: Pick<Machine, 'activity' | 'nextWakeAt' | 'outcome'>,
): Machine {
  const currentIndex = stateMachine.definition.states.findIndex(
    state => state.name === stateMachine.currentState,
  )
  const orderedPath = stateMachine.definition.states.map((state, index): MachinePathItem => {
    const progress = stateMachine.progress?.states[state.name]
    const terminalStatus = terminalStateStatus(state)
    const phase: MachinePathItem['phase'] =
      index === currentIndex
        ? 'current'
        : terminalStatus !== undefined
          ? 'outcome'
          : (progress?.runs ?? 0) > 0
            ? 'past'
            : 'future'
    return {
      key: `state:${index}`,
      index,
      name: state.name,
      ...(typeof state.kind === 'string' ? { kind: state.kind } : {}),
      phase,
      ...(terminalStatus === undefined ? {} : { terminalStatus }),
    }
  })
  const progressStates = stateMachine.definition.states.filter(
    state => terminalStateStatus(state) === undefined,
  )
  const outcome =
    observation.outcome ??
    (stateMachine.currentState === 'interrupted'
      ? ('interrupted' as const)
      : stateMachine.terminal?.status)

  return MachineSchema.parse({
    definitionName: stateMachine.definition.name,
    ...(stateMachine.currentState === undefined ? {} : { currentState: stateMachine.currentState }),
    ...(currentIndex < 0 || currentIndex + 1 >= stateMachine.definition.states.length
      ? {}
      : { followingDefinitionState: stateMachine.definition.states[currentIndex + 1]!.name }),
    progress: {
      completed: orderedPath.filter(item => item.phase === 'past').length,
      total: progressStates.length,
    },
    orderedPath,
    activity: observation.activity,
    ...(observation.nextWakeAt === undefined ? {} : { nextWakeAt: observation.nextWakeAt }),
    ...(outcome === undefined ? {} : { outcome }),
  })
}

function terminalStateStatus(
  state: AgentStateMachineSession['definition']['states'][number],
): MachinePathItem['terminalStatus'] | undefined {
  if (state.kind !== 'terminal') return undefined
  return state.status
}
