import {
  AGENT_INPUT_ATTACHMENT_MAX_COUNT,
  AGENT_INPUT_IMAGE_MAX_COUNT,
  AgentEventAttachmentSchema,
  AgentEventImageSchema,
  AgentSessionTimelineEventSchema,
  AgentTerminalStateSchema,
  BOUND_AGENT_ROOT_UNAVAILABLE,
  isRunnerDeliverableInputEvent,
  isTranscriptEvent,
  isSameInputSender,
  messagePreviewOf,
  SessionInputSenderSchema,
  STORAGE_FULL_ERROR,
  type AgentEventImage,
  type AgentEventAttachment,
  type AgentSessionStatus,
  type AgentSessionTimelineEvent,
  type AgentTurnEvent,
  type SessionInputSender,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { PRODUCT_BACKEND_ANALYTICS_ORIGIN, emitAnalyticsEvent } from '../analytics/model'
import { requireSessionPointFromDb } from './access'
import { throwSessionError } from './errors'
import type { SessionRequestIdentity } from './identity'
import type { DefaultSessionOwner } from './model'
import { sessionEventFitsStorageBudget } from './pageBudget'

export async function appendEvent(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    event: unknown
    submittingActorId?: Id<'users'>
    clientRequestId?: string
    clientRequestFingerprint?: string
    resolvedModelId?: string
    terminal?: true
    terminalAcceptedThroughSeq?: number
    now: number
  },
): Promise<number> {
  const session = await requireWritableSession(ctx, args.workspaceId, args.sessionId)
  const event = AgentSessionTimelineEventSchema.parse(args.event)
  if (!sessionEventFitsStorageBudget(event)) throwSessionError('invalid_request')
  const seq = session.lastEventSeq + 1
  await ctx.db.insert('agentSessionEvents', {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    seq,
    event,
    ...(args.submittingActorId === undefined ? {} : { submittingActorId: args.submittingActorId }),
    // A terminal row records the cwd frame it closed in: the session's cwd is
    // mutable (the agent can cd between turns), and wait callers resolving the
    // result's relative paths need the frame that authored it, not whatever
    // the session moved to by the time a delayed retry observes the terminal.
    ...(args.terminal === undefined || session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(args.clientRequestId === undefined ? {} : { clientRequestId: args.clientRequestId }),
    ...(args.clientRequestFingerprint === undefined
      ? {}
      : { clientRequestFingerprint: args.clientRequestFingerprint }),
    ...(args.resolvedModelId === undefined ? {} : { resolvedModelId: args.resolvedModelId }),
    ...(args.terminal === undefined ? {} : { terminal: args.terminal }),
    ...(isRunnerDeliverableInputEvent(event) || event.type === 'agent_message'
      ? { input: true as const }
      : {}),
    ...(isTranscriptEvent(event) ? { transcript: true as const } : {}),
    ...(args.terminalAcceptedThroughSeq === undefined
      ? {}
      : { terminalAcceptedThroughSeq: args.terminalAcceptedThroughSeq }),
    createdAt: args.now,
  })
  await registerEventImages(ctx, { ...args, event })
  /* The one write of `lastMessage`, because this is the one funnel every
     stored event comes through. Patched rather than folded into a caller's
     own patch: the callers that build one are relaying a runner's event and
     have no business knowing what a message is, and the callers that do not —
     an input arriving, a first message minted — would each need one.

     Only when the answer is non-null. An event that is not a message says
     nothing about what was last said, so it must not clear what was. */
  const preview = messagePreviewOf(event)
  if (preview !== null) await ctx.db.patch(args.sessionId, { lastMessage: preview })
  // Onboarding turns are product setup, not product usage. They must not reach
  // the analytics stream: the `grow` campaign's fit classifier counts
  // `message_sent` events, so counting a scripted onboarding exchange would
  // score every campaign signup as engaged before the user has done anything.
  if (event.type === 'prompt_submitted' && session.onboarding !== true) {
    await emitAnalyticsEvent(ctx, {
      id: `agent-session:${args.sessionId}:${seq}`,
      name: 'agent_session.message_sent',
      version: 1,
      at: args.now,
      origin: PRODUCT_BACKEND_ANALYTICS_ORIGIN,
      userId: session.userId,
      workspaceId: args.workspaceId,
      properties: {
        sessionId: args.sessionId,
        seq,
        inputKind: event.inputKind,
      },
    })
  }
  return seq
}

async function registerEventImages(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    event: AgentSessionTimelineEvent
  },
): Promise<void> {
  const images = (args.event as { images?: unknown }).images
  if (!Array.isArray(images)) return
  for (const candidate of images) {
    const parsed = AgentEventImageSchema.safeParse(candidate)
    if (!parsed.success) continue
    const existing = await ctx.db
      .query('agentSessionImages')
      .withIndex('by_session_storage', q =>
        q.eq('sessionId', args.sessionId).eq('storageId', parsed.data.storageId as Id<'_storage'>),
      )
      .unique()
    if (existing === null) {
      await ctx.db.insert('agentSessionImages', {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        storageId: parsed.data.storageId as Id<'_storage'>,
        mimeType: parsed.data.mimeType,
        bytes: parsed.data.bytes,
      })
    }
  }
}

// Convex is the authority on a session sender: the API derives it, but only
// this transaction can prove the named session lives in the addressed
// workspace. One error for missing, deleting, and other-workspace sources so a
// caller cannot probe another workspace's ids.
export async function requireSenderSource(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  sender: SessionInputSender,
  identity: SessionRequestIdentity,
): Promise<Doc<'agentSessions'> | null> {
  if (sender.kind !== 'session') return null
  const admitted = await requireSessionPointFromDb(ctx, {
    workspaceId,
    sessionId: sender.sessionId,
    identity,
  })
  return admitted.session
}

export function storedSenderMatches(event: unknown, sender: SessionInputSender): boolean {
  if (typeof event !== 'object' || event === null || !('sender' in event)) return false
  const stored = SessionInputSenderSchema.safeParse((event as { sender: unknown }).sender)
  return stored.success && isSameInputSender(stored.data, sender)
}

export async function requireSession(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  sessionId: Id<'agentSessions'>,
): Promise<Doc<'agentSessions'>> {
  const session = await ctx.db.get(sessionId)
  if (session === null || session.workspaceId !== workspaceId) throw new Error('Session not found')
  return session
}

export async function requireWritableSession(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  sessionId: Id<'agentSessions'>,
): Promise<Doc<'agentSessions'>> {
  const session = await requireSession(ctx, workspaceId, sessionId)
  if (!session.visible || session.archiveState === 'deleting') throw new Error('Session not found')
  return session
}

/**
 * The only writer of a default-session pointer.
 *
 * "Default" is a slot on the OWNER row — `workspaces.rootDefaultSessionId` for
 * the drive root, `agents.defaultSessionId` for an agent — and three callers
 * move it: delivery stamps it on the first message, delete clears it, and the
 * demote mutation both points and clears. Knowing which column belongs to which
 * owner kind in three places is how the two halves of one fact drift apart.
 *
 * `undefined` clears the slot; Convex patches an absent field away rather than
 * storing a null, which is what every reader's `=== undefined` miss expects.
 */
export async function writeDefaultSessionPointer(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  owner: DefaultSessionOwner,
  sessionId: Id<'agentSessions'> | undefined,
): Promise<void> {
  if (owner.kind === 'root') await ctx.db.patch(workspaceId, { rootDefaultSessionId: sessionId })
  else await ctx.db.patch(owner.agentId, { defaultSessionId: sessionId })
}

export function sessionAgentIdentity(session: Doc<'agentSessions'>) {
  if (session.agentId === undefined && session.agentName === undefined) return {}
  if (session.agentId === undefined || session.agentName === undefined)
    throw new Error('Invalid partial session agent attribution')
  return { agent: { id: session.agentId, name: session.agentName } }
}

export function terminalStatus(event: AgentTurnEvent): AgentSessionStatus | null {
  // A storage-full refusal never launched a runner, so no turn event will
  // ever settle the session — the typed code is the terminal signal
  // (recognized by code, never by copy). Interrupted keeps the session
  // retryable after the user frees space.
  if (
    event.type === 'system' &&
    (event.metadata?.code === STORAGE_FULL_ERROR ||
      event.metadata?.code === BOUND_AGENT_ROOT_UNAVAILABLE)
  ) {
    return 'interrupted'
  }
  return AgentTerminalStateSchema.safeParse(event.type).success
    ? (event.type as AgentSessionStatus)
    : null
}

export function parseEventImages(
  images: AgentEventImage[] | undefined,
): AgentEventImage[] | undefined {
  if (images === undefined) return undefined
  if (images.length > AGENT_INPUT_IMAGE_MAX_COUNT) throw new Error('Too many images')
  return images.map(image => AgentEventImageSchema.parse(image))
}

export function parseEventAttachments(
  attachments: AgentEventAttachment[] | undefined,
): AgentEventAttachment[] | undefined {
  if (attachments === undefined) return undefined
  if (attachments.length > AGENT_INPUT_ATTACHMENT_MAX_COUNT) throw new Error('Too many attachments')
  return attachments.map(attachment => AgentEventAttachmentSchema.parse(attachment))
}
