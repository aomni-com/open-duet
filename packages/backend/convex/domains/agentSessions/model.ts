import { type Infer, v } from 'convex/values'

import { AGENT_INPUT_IMAGE_MIME_TYPES } from '@repo/contract'

import { action, internalMutation, mutation, query } from '../../_generated/server'
import {
  agentSessionStatusValidator,
  agentStateMachineDefinitionValidator,
  contractEnumValidator,
  runnerDeliveryAttemptValidator,
  sessionBucketValidator,
  sessionInputSenderValidator,
  sessionListPageValidator,
  sessionHistoryPageValidator,
  sessionSnapshotValidator,
  sessionTimelineEntryValidator,
  sessionActivityResponseValidator,
  sessionSummaryValidator,
  sessionAudiencePageValidator,
} from '../../validators'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireSessionPointFromDb, requireWorkspaceSessionPointFromDb } from './access'
import { sessionActivityImpl } from './activity'
import { applySessionAudienceDeltaImpl, listSessionAudienceImpl } from './audience'
import { setSessionCwdImpl } from './cwd'
import {
  advanceSessionDeletionFrontierImpl,
  beginSessionSubtreeDeletionImpl,
  deleteSessionBatchImpl,
} from './deletion'
import { sessionDeletionDisposalPlanImpl } from './deletionExternal'
import {
  abandonRunnerInputDeliveryImpl,
  markRunnerInputDeliveredImpl,
  prepareRunnerInputDeliveryImpl,
  preflightSessionSpendImpl,
  preflightDefaultSessionSpendImpl,
  preflightSessionCreationSpendImpl,
} from './delivery'
import {
  appendSessionNoteImpl,
  continueSessionTerminalizationForScope,
  finalizeDiscardedSessionImpl,
  finalizeUndeliverableInterruptImpl,
  relayRunnerEventImpl,
  reconcileInterruptedCheckpointImpl,
  requestInterruptImpl,
} from './events'
import { sessionRequestIdentityValidator } from './identity'
import {
  deleteStoredInputImagesImpl,
  findSessionImageMetadataImpl,
  findSessionImageMetadataForDeliveryImpl,
  resolveSessionImageUrlsImpl,
  sessionImageUrlImpl,
  storeInputImagesImpl,
} from './images'
import { setDefaultSessionImpl, setSessionArchiveImpl } from './lifecycle'
import { projectSessionSummary } from './projection'
import {
  findCoveringTerminalImpl,
  findWaitSubmissionImpl,
  getDefaultSessionImpl,
  getSessionImpl,
  getSessionPointImpl,
  listEventsImpl,
  listEventsForDeliveryImpl,
  listEventsForStreamContinuationImpl,
  listDefaultSessionHistoryPageImpl,
  listSessionHistoryPageImpl,
  listRunnerInputDrainCandidatesImpl,
  listSessionsImpl,
  unreadForSession,
  listChildSessionsImpl,
} from './queries'
import { markSessionReadImpl } from './reads'
import { finishTitleAttemptImpl, renameSessionImpl } from './titles'

const sessionStatusValidator = agentSessionStatusValidator
const imageMimeTypeValidator = contractEnumValidator(AGENT_INPUT_IMAGE_MIME_TYPES)

const inputImageValidator = v.object({
  data: v.string(),
  mimeType: imageMimeTypeValidator,
})

const eventImageValidator = v.object({
  storageId: v.id('_storage'),
  mimeType: imageMimeTypeValidator,
  bytes: v.number(),
})

const eventAttachmentValidator = v.object({
  path: v.string(),
  name: v.string(),
  bytes: v.number(),
  mimeType: v.optional(v.string()),
})

const dispatchImageValidator = v.object({
  storageId: v.id('_storage'),
  mimeType: imageMimeTypeValidator,
})

const integrationLaunchValidator = v.literal(true)

export const authorizeSessionPoint = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    identity: sessionRequestIdentityValidator,
    internalKey: v.string(),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await requireSessionPointFromDb(ctx, args)
    return { ok: true as const }
  },
})

export const authorizeWorkspaceSessionPoint = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    internalKey: v.string(),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await requireWorkspaceSessionPointFromDb(ctx, args)
    return { ok: true as const }
  },
})

// Objects rather than bare strings so a later per-server field can ride along
// without a second wire change, matching `McpServerTurnLaunchSchema`.
const mcpServerLaunchValidator = v.array(v.object({ name: v.string() }))

const imageUrlValidator = v.object({
  url: v.string(),
  mimeType: imageMimeTypeValidator,
})

const runnerInputDeliveryValidator = v.union(
  v.object({ kind: v.literal('drain') }),
  v.object({
    kind: v.literal('initial_prompt'),
    prompt: v.string(),
    behavior: v.union(v.literal('steer'), v.literal('follow_up')),
    clientRequestId: v.optional(v.string()),
    clientRequestFingerprint: v.optional(v.string()),
    cwd: v.optional(v.string()),
    // The agent's suggested first message, carried by the client that just
    // rendered it (map D3). Only the initial payload has it: a session that
    // already exists cannot gain a first message, and the default-owner
    // redirect drops it by construction.
    agentFirstMessage: v.optional(v.string()),
    images: v.optional(v.array(eventImageValidator)),
    attachments: v.optional(v.array(eventAttachmentValidator)),
    tier: v.optional(v.string()),
    mode: v.optional(agentStateMachineDefinitionValidator),
    audience: v.optional(
      v.union(
        v.object({ kind: v.literal('workspace') }),
        v.object({ kind: v.literal('specific'), memberUserIds: v.array(v.string()) }),
      ),
    ),
    sender: sessionInputSenderValidator,
  }),
  v.object({
    kind: v.literal('message'),
    prompt: v.string(),
    behavior: v.union(v.literal('steer'), v.literal('follow_up')),
    clientRequestId: v.optional(v.string()),
    clientRequestFingerprint: v.optional(v.string()),
    images: v.optional(v.array(eventImageValidator)),
    attachments: v.optional(v.array(eventAttachmentValidator)),
    tier: v.optional(v.string()),
    sender: sessionInputSenderValidator,
  }),
  v.object({
    kind: v.literal('answer'),
    answer: v.string(),
    clientRequestId: v.optional(v.string()),
    clientRequestFingerprint: v.optional(v.string()),
    images: v.optional(v.array(eventImageValidator)),
    attachments: v.optional(v.array(eventAttachmentValidator)),
    sender: sessionInputSenderValidator,
  }),
)

export const defaultSessionOwnerValidator = v.union(
  v.object({ kind: v.literal('root') }),
  v.object({ kind: v.literal('agent'), agentId: v.id('agents') }),
)
export type DefaultSessionOwner = Infer<typeof defaultSessionOwnerValidator>

/**
 * What a delivery hands the runner. Hoisted out of the return validator because
 * this shape has three readers — this mutation's own contract, the API route
 * that forwards it, and the tests that assert on it — and a field added to only
 * some of them is a runtime `ReturnsValidationError` that typechecks fine.
 */
export const runnerDispatchValidator = v.object({
  attemptId: v.string(),
  throughSeq: v.number(),
  inputKind: v.union(v.literal('initial_prompt'), v.literal('message'), v.literal('answer')),
  message: v.string(),
  behavior: v.union(v.literal('steer'), v.literal('follow_up')),
  resolvedModelId: v.string(),
  cwd: v.optional(v.string()),
  onboarding: v.optional(v.boolean()),
  mode: v.optional(agentStateMachineDefinitionValidator),
  createdBySessionId: v.optional(v.id('agentSessions')),
  defaultSession: v.optional(v.literal(true)),
  integrations: v.optional(integrationLaunchValidator),
  // Whether the provider session already reflects this turn's permissions —
  // read in the same transaction, so the API can skip its own readiness
  // round trip before dispatch when nothing is left to synchronize.
  integrationsReady: v.optional(v.boolean()),
  // A second, independent launch field rather than more shape on
  // `integrations` (D16): a Composio outage must not be able to take out a
  // workspace's own servers, and these carry no provider coupling at all.
  mcpServers: v.optional(mcpServerLaunchValidator),
  images: v.optional(v.array(dispatchImageValidator)),
})

const sessionSpendPreflightReturnValidator = v.union(
  v.object({
    servicingStatus: v.union(v.literal('paused'), v.literal('banned')),
  }),
  v.object({
    proceed: v.boolean(),
    reason: v.optional(
      v.union(
        v.literal('subscription_required'),
        v.literal('insufficient_credits'),
        v.literal('monthly_cap'),
      ),
    ),
    tier: v.optional(v.union(v.literal('account'), v.literal('workspace'))),
    balanceMicroUsd: v.number(),
    monthlyCreditBalanceMicroUsd: v.number(),
    paidCreditBalanceMicroUsd: v.number(),
    accountMonthlySpendMicroUsd: v.number(),
    accountMonthlyCapMicroUsd: v.optional(v.number()),
    workspaceMonthlySpendMicroUsd: v.number(),
    workspaceMonthlyCapMicroUsd: v.optional(v.number()),
  }),
)

const runnerInputDeliveryReturnValidator = v.union(
  // The spend preflight the caller asked for refused; nothing was written.
  v.object({ refused: sessionSpendPreflightReturnValidator }),
  v.object({
    sessionId: v.id('agentSessions'),
    status: sessionStatusValidator,
    submittedThroughSeq: v.number(),
    dispatch: runnerDispatchValidator,
    created: v.optional(
      v.object({
        snapshot: sessionSnapshotValidator,
        history: v.object({ events: v.array(sessionTimelineEntryValidator) }),
      }),
    ),
    deduplicated: v.optional(v.literal(true)),
  }),
  v.object({
    sessionId: v.id('agentSessions'),
    status: sessionStatusValidator,
    submittedThroughSeq: v.number(),
    queued: v.literal(true),
    alreadyDelivered: v.optional(v.literal(true)),
    created: v.optional(
      v.object({
        snapshot: sessionSnapshotValidator,
        history: v.object({ events: v.array(sessionTimelineEntryValidator) }),
      }),
    ),
    deduplicated: v.optional(v.literal(true)),
  }),
)

// Repair is an observation, never authorization to execute. Both cursors fence
// the observation: timer turns can advance events without accepting new input.
export const interruptedCheckpointTarget = query({
  args: { workspaceId: v.id('workspaces'), sessionId: v.string(), internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const { session } = await requireWorkspaceSessionPointFromDb(ctx, args)
    if (
      session.turnStatus !== 'running' ||
      session.archiveState !== 'active' ||
      session.runnerInputPending
    )
      return null
    return {
      expectedLastEventSeq: session.lastEventSeq,
      acceptedThroughSeq: session.lastRunnerInputSeq,
    }
  },
})

export const reconcileInterruptedCheckpoint = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    internalKey: v.string(),
    expectedLastEventSeq: v.number(),
    acceptedThroughSeq: v.number(),
    now: v.optional(v.number()),
  },
  handler: reconcileInterruptedCheckpointImpl,
})

export const relayRunnerEventArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.string(),
  relayId: v.string(),
  event: v.any(),
  acceptedThroughSeq: v.optional(v.number()),
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const relayRunnerEvent = mutation({
  args: relayRunnerEventArgs,
  returns: v.object({
    status: sessionStatusValidator,
    lastEventSeq: v.number(),
    accepted: v.boolean(),
    seq: v.union(v.number(), v.null()),
  }),
  handler: relayRunnerEventImpl,
})

export const appendSessionNoteArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.string(),
  actorId: v.id('users'),
  identity: sessionRequestIdentityValidator,
  note: v.string(),
  clientRequestId: v.optional(v.string()),
  clientRequestFingerprint: v.optional(v.string()),
  images: v.optional(v.array(eventImageValidator)),
  attachments: v.optional(v.array(eventAttachmentValidator)),
  sender: sessionInputSenderValidator,
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const appendSessionNote = mutation({
  args: appendSessionNoteArgs,
  returns: v.object({
    status: sessionStatusValidator,
    seq: v.number(),
    lastEventSeq: v.number(),
    deduplicated: v.optional(v.literal(true)),
  }),
  handler: appendSessionNoteImpl,
})

export const prepareRunnerInputDeliveryArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.optional(v.string()),
  defaultOwner: v.optional(defaultSessionOwnerValidator),
  createdBySessionId: v.optional(v.id('agentSessions')),
  actorId: v.optional(v.id('users')),
  identity: v.optional(sessionRequestIdentityValidator),
  attemptId: v.string(),
  projectIntegrations: v.optional(v.boolean()),
  // Run the session spend preflight in this same transaction, so a message
  // costs one round trip to decide and prepare rather than two. A refusal
  // comes back as `refused` with nothing written.
  preflight: v.optional(
    v.object({
      sourceSessionId: v.optional(v.string()),
      estimatedCostMicroUsd: v.optional(v.number()),
    }),
  ),
  input: runnerInputDeliveryValidator,
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const prepareRunnerInputDelivery = mutation({
  args: prepareRunnerInputDeliveryArgs,
  returns: runnerInputDeliveryReturnValidator,
  handler: prepareRunnerInputDeliveryImpl,
})

export const preflightSessionSpend = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    identity: sessionRequestIdentityValidator,
    sourceSessionId: v.optional(v.string()),
    estimatedCostMicroUsd: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: sessionSpendPreflightReturnValidator,
  handler: preflightSessionSpendImpl,
})

export const preflightSessionCreationSpend = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    identity: sessionRequestIdentityValidator,
    clientRequestId: v.optional(v.string()),
    clientRequestFingerprint: v.optional(v.string()),
    cwd: v.optional(v.string()),
    audience: v.union(
      v.object({ kind: v.literal('workspace') }),
      v.object({ kind: v.literal('specific'), memberUserIds: v.array(v.string()) }),
    ),
    estimatedCostMicroUsd: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: sessionSpendPreflightReturnValidator,
  handler: preflightSessionCreationSpendImpl,
})

export const preflightDefaultSessionSpend = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    owner: defaultSessionOwnerValidator,
    identity: sessionRequestIdentityValidator,
    sourceSessionId: v.optional(v.string()),
    estimatedCostMicroUsd: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: sessionSpendPreflightReturnValidator,
  handler: preflightDefaultSessionSpendImpl,
})

export const storeInputImagesArgs = v.object({
  internalKey: v.string(),
  images: v.array(inputImageValidator),
})

export const storeInputImages = action({
  args: storeInputImagesArgs,
  returns: v.array(eventImageValidator),
  handler: (ctx, args) => storeInputImagesImpl(ctx, args),
})

export const deleteStoredInputImagesArgs = v.object({
  internalKey: v.string(),
  storageIds: v.array(v.id('_storage')),
})

export const deleteStoredInputImages = action({
  args: deleteStoredInputImagesArgs,
  returns: v.object({ deleted: v.number() }),
  handler: (ctx, args) => deleteStoredInputImagesImpl(ctx, args),
})

export const resolveSessionImageUrlsArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  sessionId: v.id('agentSessions'),
  images: v.array(dispatchImageValidator),
})

export const resolveSessionImageUrls = action({
  args: resolveSessionImageUrlsArgs,
  returns: v.array(imageUrlValidator),
  handler: (ctx, args) => resolveSessionImageUrlsImpl(ctx, args),
})

export const sessionImageUrlArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  sessionId: v.string(),
  storageId: v.string(),
  identity: sessionRequestIdentityValidator,
})

export const sessionImageUrl = action({
  args: sessionImageUrlArgs,
  returns: v.union(v.null(), imageUrlValidator),
  handler: (ctx, args) => sessionImageUrlImpl(ctx, args),
})

export const markRunnerInputDeliveredArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.id('agentSessions'),
  attemptId: v.string(),
  throughSeq: v.number(),
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const markRunnerInputDelivered = mutation({
  args: markRunnerInputDeliveredArgs,
  returns: v.object({
    status: sessionStatusValidator,
    lastDeliveredInputSeq: v.number(),
    deliveryAttempt: v.optional(runnerDeliveryAttemptValidator),
  }),
  handler: markRunnerInputDeliveredImpl,
})

export const abandonRunnerInputDeliveryArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.id('agentSessions'),
  attemptId: v.string(),
  internalKey: v.string(),
})

export const abandonRunnerInputDelivery = mutation({
  args: abandonRunnerInputDeliveryArgs,
  returns: v.object({
    status: sessionStatusValidator,
    lastDeliveredInputSeq: v.number(),
    deliveryAttempt: v.optional(runnerDeliveryAttemptValidator),
  }),
  handler: abandonRunnerInputDeliveryImpl,
})

export const requestInterruptArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.string(),
  actorId: v.id('users'),
  identity: sessionRequestIdentityValidator,
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const finalizeUndeliverableInterruptArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.string(),
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const requestInterrupt = mutation({
  args: requestInterruptArgs,
  returns: v.object({ status: sessionStatusValidator, lastEventSeq: v.number() }),
  handler: requestInterruptImpl,
})

export const finalizeUndeliverableInterrupt = mutation({
  args: finalizeUndeliverableInterruptArgs,
  returns: v.object({ status: sessionStatusValidator, lastEventSeq: v.number() }),
  handler: finalizeUndeliverableInterruptImpl,
})

export const finalizeDiscardedSessionArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.id('agentSessions'),
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const finalizeDiscardedSession = mutation({
  args: finalizeDiscardedSessionArgs,
  returns: v.object({ status: sessionStatusValidator, lastEventSeq: v.number() }),
  handler: finalizeDiscardedSessionImpl,
})

export const getSession = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
  },
  returns: v.union(v.null(), sessionSnapshotValidator),
  handler: getSessionImpl,
})

export const getSessionPoint = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
  },
  returns: v.union(v.null(), sessionSnapshotValidator),
  handler: getSessionPointImpl,
})

export const getDefaultSession = query({
  args: {
    workspaceId: v.id('workspaces'),
    owner: defaultSessionOwnerValidator,
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
  },
  returns: v.union(v.null(), sessionSnapshotValidator),
  handler: getDefaultSessionImpl,
})

export const setDefaultSession = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    owner: defaultSessionOwnerValidator,
    // `null` is a value the caller sends, not an omission: clearing the slot is
    // the demote gesture, and the whole reason this mutation exists.
    sessionId: v.union(v.null(), v.string()),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
    internalKey: v.string(),
  },
  // Deliberately `getDefaultSession`'s validator: the caller reads back exactly
  // what the next alias read would answer, so a clear returns `null` — the
  // ordinary "no chat yet" state rather than an error.
  returns: v.union(v.null(), sessionSnapshotValidator),
  handler: setDefaultSessionImpl,
})

export const listEvents = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    afterSeq: v.optional(v.number()),
    beforeSeq: v.optional(v.number()),
    limit: v.optional(v.number()),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
  },
  // The envelope is ours; `event` is the stored timeline union, whose runner
  // arms bottom out in duet-agent-owned interiors. Pinning the envelope and
  // leaving the leaf open is the honest split — `AgentSessionTimelineEventSchema`
  // parses it one layer in.
  returns: v.array(sessionTimelineEntryValidator),
  handler: listEventsImpl,
})

export const listSessionHistoryPage = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
    afterSeq: v.optional(v.number()),
    view: v.optional(v.union(v.literal('all'), v.literal('transcript'))),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
  },
  returns: sessionHistoryPageValidator,
  handler: listSessionHistoryPageImpl,
})

export const listDefaultSessionHistoryPage = query({
  args: {
    workspaceId: v.id('workspaces'),
    owner: defaultSessionOwnerValidator,
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    order: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
    afterSeq: v.optional(v.number()),
    view: v.optional(v.union(v.literal('all'), v.literal('transcript'))),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
  },
  returns: sessionHistoryPageValidator,
  handler: listDefaultSessionHistoryPageImpl,
})

export const listEventsForDelivery = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    afterSeq: v.optional(v.number()),
    limit: v.optional(v.number()),
    internalKey: v.string(),
  },
  returns: v.array(sessionTimelineEntryValidator),
  handler: listEventsForDeliveryImpl,
})

export const listEventsForStreamContinuation = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    afterSeq: v.number(),
    internalKey: v.string(),
  },
  returns: v.object({
    events: v.array(sessionTimelineEntryValidator),
    headSeq: v.number(),
    closed: v.boolean(),
    terminal: v.boolean(),
  }),
  handler: listEventsForStreamContinuationImpl,
})

export const findCoveringTerminal = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    inputSeq: v.number(),
    internalKey: v.string(),
  },
  // The timeline entry plus the covered session's cwd: a terminal result's
  // relative file paths are relative to that cwd, and the wait caller lives in
  // a different one. Additive on the entry shape so an older API reader is
  // unaffected during deploy skew.
  returns: v.union(
    v.null(),
    v.object({ ...sessionTimelineEntryValidator.fields, cwd: v.optional(v.string()) }),
  ),
  handler: findCoveringTerminalImpl,
})

export const findWaitSubmission = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    identity: sessionRequestIdentityValidator,
    clientRequestId: v.string(),
    clientRequestFingerprint: v.string(),
    sessionId: v.optional(v.string()),
    parentSessionId: v.optional(v.string()),
    defaultOwner: v.optional(defaultSessionOwnerValidator),
    sourceSessionId: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.object({ sessionId: v.id('agentSessions'), inputSeq: v.number() })),
  handler: findWaitSubmissionImpl,
})

export const findSessionImageMetadataArgs = v.object({
  workspaceId: v.id('workspaces'),
  sessionId: v.string(),
  storageId: v.string(),
  identity: sessionRequestIdentityValidator,
  internalKey: v.string(),
})

export const findSessionImageMetadata = query({
  args: findSessionImageMetadataArgs,
  returns: v.union(v.null(), eventImageValidator),
  handler: findSessionImageMetadataImpl,
})

export const findSessionImageMetadataForDelivery = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    storageId: v.id('_storage'),
  },
  returns: v.union(v.null(), eventImageValidator),
  handler: findSessionImageMetadataForDeliveryImpl,
})

export const listSessions = query({
  args: {
    workspaceId: v.id('workspaces'),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    search: v.optional(v.string()),
    bucket: v.optional(sessionBucketValidator),
    archived: v.optional(v.union(v.literal('exclude'), v.literal('only'))),
    agentId: v.optional(v.string()),
    excludeDefault: v.optional(v.literal(true)),
    topLevel: v.optional(v.literal(true)),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
    actorId: v.optional(v.id('users')),
  },
  returns: sessionListPageValidator,
  handler: (ctx, args) => listSessionsImpl(ctx, args),
})

export const listChildSessions = query({
  args: {
    workspaceId: v.id('workspaces'),
    parentSessionId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    bucket: v.optional(sessionBucketValidator),
    archived: v.optional(v.union(v.literal('exclude'), v.literal('only'))),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
    actorId: v.optional(v.id('users')),
  },
  returns: sessionListPageValidator,
  handler: (ctx, args) => listChildSessionsImpl(ctx, args),
})

export const listSessionAudience = query({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    identity: sessionRequestIdentityValidator,
    cursor: v.optional(v.string()),
    limit: v.number(),
    internalKey: v.string(),
  },
  returns: sessionAudiencePageValidator,
  handler: (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return listSessionAudienceImpl(ctx, args)
  },
})

export const applySessionAudienceDelta = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    identity: sessionRequestIdentityValidator,
    add: v.array(v.string()),
    remove: v.array(v.string()),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.union(sessionSummaryValidator, v.null()),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const result = await applySessionAudienceDeltaImpl(ctx, {
      ...args,
      now: args.now ?? Date.now(),
    })
    if (result === null) return null
    return await projectSessionSummary(
      ctx,
      result.session,
      {
        access: result.access,
        unread: await unreadForSession(
          ctx,
          args.workspaceId,
          args.identity.principal.kind === 'human' ? args.identity.principal.userId : undefined,
          result.session,
        ),
      },
      result.audienceSupport,
    )
  },
})

export const renameSession = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
    title: v.string(),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: sessionSummaryValidator,
  handler: renameSessionImpl,
})

export const setSessionCwd = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
    expectedCwd: v.optional(v.string()),
    cwd: v.string(),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({ id: v.id('agentSessions'), cwd: v.string() }),
  handler: setSessionCwdImpl,
})

export const finishTitleAttempt = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    attemptId: v.string(),
    title: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  returns: v.object({ applied: v.boolean() }),
  handler: finishTitleAttemptImpl,
})

export const continueSessionTerminalization = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    now: v.number(),
    // Absent on legacy workspace-pause continuations scheduled before this field existed.
    reason: v.optional(
      v.union(
        v.literal('workspace_paused'),
        v.literal('agent_deleted'),
        v.literal('workspace_provisioning_failed'),
      ),
    ),
    agentId: v.optional(v.id('agents')),
  },
  returns: v.object({ done: v.boolean(), processed: v.number() }),
  handler: (ctx, args) =>
    continueSessionTerminalizationForScope(
      ctx,
      {
        workspaceId: args.workspaceId,
        reason: args.reason ?? 'workspace_paused',
        ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
      },
      args.now,
    ),
})

export const setSessionArchive = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
    kind: v.union(v.literal('personal'), v.literal('global')),
    archived: v.boolean(),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: sessionSummaryValidator,
  handler: setSessionArchiveImpl,
})

export const sessionActivity = query({
  args: {
    workspaceId: v.id('workspaces'),
    limitPerAgent: v.number(),
    internalKey: v.string(),
    identity: sessionRequestIdentityValidator,
  },
  returns: sessionActivityResponseValidator,
  handler: (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return sessionActivityImpl(ctx, args)
  },
})

export const markSessionRead = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
    seq: v.number(),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({ lastReadSeq: v.number() }),
  handler: markSessionReadImpl,
})

export const beginSessionSubtreeDeletion = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.string(),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({ accepted: v.literal(true) }),
  handler: (ctx, args) => beginSessionSubtreeDeletionImpl(ctx, args),
})

export const advanceSessionDeletionFrontier = internalMutation({
  args: { workId: v.id('agentSessionDeletionWork') },
  returns: v.object({
    status: v.union(v.literal('pending'), v.literal('scan_complete'), v.literal('stale')),
  }),
  handler: (ctx, args) => advanceSessionDeletionFrontierImpl(ctx, args),
})

export const sessionDeletionDisposalPlan = query({
  args: { internalKey: v.string(), workId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workspaceSlug: v.string(),
      sessionId: v.id('agentSessions'),
      providerSessionId: v.optional(v.string()),
    }),
  ),
  handler: (ctx, args) => sessionDeletionDisposalPlanImpl(ctx, args),
})

export const deleteSessionBatch = internalMutation({
  args: { workId: v.id('agentSessionDeletionWork') },
  returns: v.object({ done: v.boolean() }),
  handler: deleteSessionBatchImpl,
})

export const listRunnerInputDrainCandidates = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    limit: v.number(),
  },
  returns: v.object({
    workspaceSlug: v.string(),
    sessions: v.array(
      v.object({
        sessionId: v.id('agentSessions'),
      }),
    ),
  }),
  handler: listRunnerInputDrainCandidatesImpl,
})
