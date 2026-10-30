import { type Infer, v } from 'convex/values'

import {
  normalizeAgentFirstMessage,
  bucketOf,
  initialSessionTitle,
  type AgentEventAttachment,
  type AgentEventImage,
  type AgentPromptBehavior,
  type ModelSelectionId,
  type SessionCreationAudienceInput,
  type SessionInputSender,
  WORKSPACE_MEMBER_LIMIT,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, type MutationCtx } from '../../_generated/server'
import type { agentStateMachineDefinitionValidator } from '../../validators'
import { resolveSessionAgent } from '../agents/resolution'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireCurrentUserId } from '../workspaces/authorization'
import { workspaceTierEntitlement } from '../workspaces/tierPolicy'
import { requireCurrentSessionMembership } from './access'
import { appendEvent } from './agentSessionsShared'
import { resolveFreshCreationAudience } from './audience'
import { reconcileSessionDiscovery } from './discovery'
import { throwSessionError } from './errors'
import {
  assertSessionIdentityAttribution,
  sessionRequestIdentityValidator,
  type SessionRequestIdentity,
} from './identity'
import { sessionSearchCorpus } from './search'
import { resolveSessionTier } from './tier'
import { scheduleTitleAttempt, titleCanBeGenerated } from './titles'

// The onboarding conversation's instructions are system-prompt layers supplied
// by the gateway: the agent's optional ONBOARDING.md, then the product-owned
// completion contract. This kickoff is only the first user turn that starts the
// exchange, deliberately inert so nothing here competes with those layers.
const ONBOARDING_KICKOFF_PROMPT = 'Begin onboarding.'

// A fixed title, because nothing lists or searches these sessions.
const ONBOARDING_SESSION_TITLE = 'Onboarding'

export type SessionCreationAudience =
  | { kind: 'workspace' }
  | { kind: 'specific'; membershipIds: Id<'workspaceMembers'>[] }

export type SessionCreationAudienceRequest = { kind: 'workspace' } | SessionCreationAudienceInput

export async function resolveFreshSessionCreation(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    identity: SessionRequestIdentity
    cwd?: string
    audience: SessionCreationAudienceRequest
  },
) {
  const resolvedAudience = await resolveFreshCreationAudience(ctx, {
    workspaceId: args.workspaceId,
    principal: args.identity.principal,
    audience: args.audience,
  })
  const agent = await resolveSessionAgent(ctx, { workspaceId: args.workspaceId, cwd: args.cwd })
  return { ...resolvedAudience, agent }
}

export async function copyableParentAudience(
  ctx: MutationCtx,
  parent: Doc<'agentSessions'>,
): Promise<SessionCreationAudience> {
  if (parent.audienceKind === 'workspace') return { kind: 'workspace' }
  if (parent.audienceKind !== 'specific') throwSessionError('not_found')

  // Read only current workspace generations. Historical member-state rows can
  // outlive membership churn until cleanup; scanning them would make nested
  // creation grow with workspace history instead of the membership cap.
  const memberships = (
    await Promise.all(
      (['owner', 'editor', 'viewer'] as const).map(role =>
        ctx.db
          .query('workspaceMembers')
          .withIndex('by_workspace_role', q =>
            q.eq('workspaceId', parent.workspaceId).eq('role', role),
          )
          .take(WORKSPACE_MEMBER_LIMIT),
      ),
    )
  ).flat()
  if (memberships.length > WORKSPACE_MEMBER_LIMIT) throwSessionError('invalid_request')
  const grants = await Promise.all(
    memberships.map(membership =>
      ctx.db
        .query('agentSessionMemberStates')
        .withIndex('by_session_membership', q =>
          q.eq('sessionId', parent._id).eq('membershipId', membership._id),
        )
        .unique(),
    ),
  )
  const membershipIds = memberships
    .filter((_membership, index) => grants[index]?.audienceGranted === true)
    .map(membership => membership._id)
  membershipIds.sort((left, right) => String(left).localeCompare(String(right)))
  if (membershipIds.length === 0) throwSessionError('not_found')
  return { kind: 'specific', membershipIds }
}

export async function createSessionForInitialDelivery(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    now: number
    input: {
      kind: 'initial_prompt'
      prompt: string
      behavior: AgentPromptBehavior
      clientRequestId?: string
      clientRequestFingerprint?: string
      cwd?: string
      images?: AgentEventImage[]
      attachments?: AgentEventAttachment[]
      mode?: Infer<typeof agentStateMachineDefinitionValidator>
      sender: SessionInputSender
      agentFirstMessage?: string
    }
    tier: ModelSelectionId
    onboarding?: boolean
    createdBySessionId?: Id<'agentSessions'>
    audience: SessionCreationAudience
    resolvedAgent?: Awaited<ReturnType<typeof resolveSessionAgent>>
  },
  createdAtIso: string,
): Promise<Doc<'agentSessions'>> {
  const status = 'running' as const
  const onboarding = args.onboarding === true
  // An onboarding session is never listed or searched, so generating a title
  // for it would spend a model call on text nothing can ever display. A first
  // message that is only files keeps the title its files give it.
  const generateTitle = !onboarding && titleCanBeGenerated(args.input.prompt)
  const title = onboarding ? ONBOARDING_SESSION_TITLE : initialSessionTitle(args.input)
  const agent =
    args.resolvedAgent ??
    (await resolveSessionAgent(ctx, {
      workspaceId: args.workspaceId,
      cwd: args.input.cwd,
    }))
  const audienceFields =
    args.audience.kind === 'specific'
      ? {
          audienceKind: 'specific' as const,
          specificGrantedParticipantCount: args.audience.membershipIds.length,
        }
      : { audienceKind: 'workspace' as const }
  const sessionId = await ctx.db.insert('agentSessions', {
    workspaceId: args.workspaceId,
    userId: args.actorId,
    ...audienceFields,
    ...(args.input.clientRequestId === undefined
      ? {}
      : { clientRequestId: args.input.clientRequestId }),
    ...(args.input.clientRequestFingerprint === undefined
      ? {}
      : { clientRequestFingerprint: args.input.clientRequestFingerprint }),
    turnStatus: status,
    // No machine has been observed yet, whatever was asked for — a requested
    // machine is not a running one, so the bucket reads the turn.
    bucket: bucketOf({ turnStatus: status, machine: undefined }),
    prompt: args.input.prompt,
    title,
    titleOrigin: 'excerpt',
    titleStatus: generateTitle ? 'generating' : 'complete',
    searchText: sessionSearchCorpus(title, args.input.prompt),
    ...(onboarding ? { onboarding: true } : {}),
    ...(args.createdBySessionId === undefined
      ? {}
      : { createdBySessionId: args.createdBySessionId }),
    archiveState: 'active',
    visible: true,
    cwd: args.input.cwd,
    ...(args.input.mode === undefined ? {} : { requestedMachine: args.input.mode }),
    ...(agent === null ? {} : agent),
    lastModelId: args.tier,
    lastEventSeq: 0,
    lastRunnerInputSeq: 0,
    runnerInputPending: false,
    lastDeliveredInputSeq: 0,
    createdAt: args.now,
    updatedAt: args.now,
  })
  if (args.audience.kind === 'specific') {
    for (const membershipId of args.audience.membershipIds) {
      await ctx.db.insert('agentSessionMemberStates', {
        workspaceId: args.workspaceId,
        sessionId,
        membershipId,
        audienceGranted: true,
      })
    }
  }
  const titleAttemptId = `title:${sessionId}`
  if (generateTitle) await ctx.db.patch(sessionId, { titleAttemptId })
  const createdSeq = await appendEvent(ctx, {
    workspaceId: args.workspaceId,
    sessionId,
    event: {
      type: 'session_created',
      prompt: args.input.prompt,
      createdAt: createdAtIso,
      ...(args.input.clientRequestId === undefined
        ? {}
        : { clientRequestId: args.input.clientRequestId }),
    },
    now: args.now,
  })
  await ctx.db.patch(sessionId, { lastEventSeq: createdSeq })
  // The agent's suggested first message lands ahead of the user's prompt so
  // the transcript opens in the agent's voice (map D1). Not deliverable
  // input: the runner-input cursor below tracks the prompt alone, and the
  // first envelope quotes this row instead of delivering it.
  const agentFirstMessage = normalizeAgentFirstMessage(args.input.agentFirstMessage)
  if (agentFirstMessage !== undefined) {
    const messageSeq = await appendEvent(ctx, {
      workspaceId: args.workspaceId,
      sessionId,
      event: { type: 'agent_message', message: agentFirstMessage, createdAt: createdAtIso },
      now: args.now,
    })
    await ctx.db.patch(sessionId, { lastEventSeq: messageSeq })
  }
  const promptSeq = await appendEvent(ctx, {
    workspaceId: args.workspaceId,
    sessionId,
    event: {
      type: 'prompt_submitted',
      prompt: args.input.prompt,
      inputKind: 'initial',
      behavior: args.input.behavior,
      sender: args.input.sender,
      ...(args.input.clientRequestId === undefined
        ? {}
        : { clientRequestId: args.input.clientRequestId }),
      ...(args.input.images === undefined ? {} : { images: args.input.images }),
      ...(args.input.attachments === undefined ? {} : { attachments: args.input.attachments }),
    },
    submittingActorId: args.actorId,
    resolvedModelId: args.tier,
    ...(args.input.clientRequestId === undefined
      ? {}
      : { clientRequestId: args.input.clientRequestId }),
    ...(args.input.clientRequestFingerprint === undefined
      ? {}
      : { clientRequestFingerprint: args.input.clientRequestFingerprint }),
    now: args.now,
  })
  await ctx.db.patch(sessionId, {
    lastEventSeq: promptSeq,
    lastRunnerInputSeq: promptSeq,
    runnerInputPending: true,
  })
  if (generateTitle) {
    await scheduleTitleAttempt(ctx, {
      workspaceId: args.workspaceId,
      sessionId,
      prompt: args.input.prompt,
      attemptId: titleAttemptId,
    })
  }
  const session = await ctx.db.get(sessionId)
  if (session === null) throw new Error('Session not found')
  await reconcileSessionDiscovery(ctx, session)
  return session
}

// The onboarding conversation is opened, not created: the "Start setup" CTA
// is pressed repeatedly — after a reload, after a redo, after wandering away —
// and each press must land the user back in the same conversation rather than
// fork a new one. This lives at the creation boundary because onboarding
// sessions are deliberately absent from every list the client can read.
export const openOnboardingSession = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    agentId: v.id('agents'),
    actorId: v.optional(v.id('users')),
    identity: v.optional(sessionRequestIdentityValidator),
    internalKey: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let identity: SessionRequestIdentity
    if (args.internalKey !== undefined) {
      requireApiInternalKey(args.internalKey)
      if (args.actorId === undefined || args.identity === undefined) {
        throw new Error('Internal onboarding requires explicit identity and attribution')
      }
      assertSessionIdentityAttribution(args.identity, args.actorId)
      identity = args.identity
    } else {
      if (args.actorId !== undefined || args.identity !== undefined) {
        throw new Error('Browser onboarding derives its identity from authentication')
      }
      const actorId = await requireCurrentUserId(ctx)
      identity = { principal: { kind: 'human', userId: actorId }, actorId }
    }
    if (identity.principal.kind === 'human') {
      const membership = await requireCurrentSessionMembership(
        ctx,
        args.workspaceId,
        identity.principal.userId,
      )
      if (membership.role === 'viewer') throwSessionError('forbidden')
    }
    const now = args.now ?? Date.now()

    const existing = await ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_agent_archive_updated', q =>
        q
          .eq('workspaceId', args.workspaceId)
          .eq('onboarding', true)
          .eq('agentId', args.agentId)
          .eq('archiveState', 'active'),
      )
      .order('desc')
      .first()
    if (existing !== null) return { sessionId: existing._id }

    const agent = await ctx.db.get(args.agentId)
    if (agent === null || agent.workspaceId !== args.workspaceId) throwSessionError('not_found')
    const anchor = await ctx.db.get(agent.anchorId)
    if (anchor === null) throwSessionError('not_found')
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throwSessionError('not_found')
    const entitlement = await workspaceTierEntitlement(ctx, workspace, now)

    // Attribution still resolves from `cwd` like every other session — the
    // agent id is never sent on the wire — so onboarding cannot claim an agent
    // its working directory does not sit under.
    const session = await createSessionForInitialDelivery(
      ctx,
      {
        workspaceId: args.workspaceId,
        actorId: identity.actorId,
        now,
        input: {
          kind: 'initial_prompt',
          prompt: ONBOARDING_KICKOFF_PROMPT,
          behavior: 'steer',
          cwd: anchor.path,
          sender: { kind: 'system' },
        },
        tier: resolveSessionTier({
          workspaceDefault: workspace.defaultModelId,
          ...entitlement,
        }),
        onboarding: true,
        audience: { kind: 'workspace' },
      },
      new Date(now).toISOString(),
    )
    return { sessionId: session._id }
  },
})
