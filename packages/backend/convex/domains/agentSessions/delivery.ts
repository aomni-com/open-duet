import { ConvexError, type Infer } from 'convex/values'

import {
  AgentEventAttachmentSchema,
  bucketOf,
  collectRunnerImages,
  isRunnerDeliverableInputEvent,
  type AgentEventImage,
  type AgentEventAttachment,
  type AgentInputEvent,
  type AgentPromptBehavior,
  type AgentSessionStatus,
  type AgentSessionTimelineEvent,
  type RunnerDeliveryAttempt,
  type SessionInitialHistorySnapshot,
  type SessionInputSender,
  SessionSnapshotSchema,
  type SessionSnapshot,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import type { agentStateMachineDefinitionValidator } from '../../validators'
import { requireApiInternalKey } from '../apiKeys/model'
import { runPreflightWithDb } from '../credits/ledger'
import { projectIntegrationTurnConfig } from '../integrations/turnConfig'
import { projectMcpServerTurnLaunch } from '../mcpServers/turnConfig'
import { workspaceTierEntitlement } from '../workspaces/tierPolicy'
import {
  admittedWorkspaceSessionAccess,
  requireCurrentSessionMembership,
  requireSessionPointFromDb,
  requireWorkspaceSessionPointFromDb,
  type SessionPointAccess,
} from './access'
import {
  appendEvent,
  parseEventAttachments,
  parseEventImages,
  requireSenderSource,
  requireWritableSession,
  storedSenderMatches,
  writeDefaultSessionPointer,
} from './agentSessionsShared'
import {
  copyableParentAudience,
  createSessionForInitialDelivery,
  resolveFreshSessionCreation,
  type SessionCreationAudience,
  type SessionCreationAudienceRequest,
} from './creation'
import {
  defaultSessionIdForOwner,
  requireDefaultOwnerReady,
  requireDefaultSessionPoint,
  sessionMatchesDefaultOwner,
} from './defaultSession'
import { patchSessionAndReconcileDiscovery } from './discovery'
import { admitSessionId, throwSessionError } from './errors'
import { assertSessionIdentityAttribution, type SessionRequestIdentity } from './identity'
import type {
  abandonRunnerInputDeliveryArgs,
  DefaultSessionOwner,
  markRunnerInputDeliveredArgs,
  prepareRunnerInputDeliveryArgs,
} from './model'
import { projectSessionSnapshot } from './projection'
import {
  renderRunnerInput,
  resolveCurrentModelSender,
  type AttributedInputRow,
  type ResolvedModelSender,
} from './runnerEnvelope'
import { resolveSessionTier } from './tier'

const SESSION_EVENT_READ_LIMIT = 1000
const SESSION_EVENT_READ_PAGES = 5
const RUNNER_DELIVERY_LEASE_TIMEOUT_MS = 30_000

export async function preflightSessionSpendImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: string
    identity: SessionRequestIdentity
    sourceSessionId?: string
    estimatedCostMicroUsd?: number
    now?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  await requireSessionPointFromDb(ctx, args)
  if (args.sourceSessionId !== undefined) {
    await requireSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sourceSessionId,
      identity: args.identity,
    })
  }
  return await preflightWorkspaceSpend(ctx, args)
}

export async function preflightDefaultSessionSpendImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    owner: DefaultSessionOwner
    identity: SessionRequestIdentity
    sourceSessionId?: string
    estimatedCostMicroUsd?: number
    now?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  assertSessionIdentityAttribution(args.identity, args.identity.actorId)
  await requireDefaultOwnerReady(ctx, args.workspaceId, args.owner)
  const pointedSessionId = await defaultSessionIdForOwner(ctx, args.workspaceId, args.owner)
  if (pointedSessionId === undefined) {
    if (args.identity.principal.kind === 'human') {
      await requireCurrentSessionMembership(ctx, args.workspaceId, args.identity.principal.userId)
    }
  } else {
    await requireDefaultSessionPoint(ctx, args)
  }
  if (args.sourceSessionId !== undefined) {
    await requireSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sourceSessionId,
      identity: args.identity,
    })
  }
  return await preflightWorkspaceSpend(ctx, args)
}

async function preflightWorkspaceSpend(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    identity: SessionRequestIdentity
    estimatedCostMicroUsd?: number
    now?: number
  },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throwSessionError('not_found')
  const servicingStatus = workspace.servicingStatus ?? 'active'
  if (servicingStatus !== 'active') return { servicingStatus }
  return await runPreflightWithDb(ctx, {
    workspaceId: args.workspaceId,
    userId: args.identity.actorId,
    estimatedCostMicroUsd: args.estimatedCostMicroUsd,
    now: args.now,
  })
}

export async function preflightSessionCreationSpendImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    identity: SessionRequestIdentity
    clientRequestId?: string
    clientRequestFingerprint?: string
    cwd?: string
    audience: SessionCreationAudienceRequest
    estimatedCostMicroUsd?: number
    now?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  assertSessionIdentityAttribution(args.identity, args.identity.actorId)
  if (args.clientRequestId !== undefined) {
    const existing = await ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_user_client_request', q =>
        q
          .eq('workspaceId', args.workspaceId)
          .eq('userId', args.identity.actorId)
          .eq('clientRequestId', args.clientRequestId),
      )
      .unique()
    if (existing !== null) {
      if (existing.clientRequestFingerprint !== args.clientRequestFingerprint) {
        throwSessionError('invalid_request')
      }
      await requireSessionPointFromDb(ctx, {
        workspaceId: args.workspaceId,
        sessionId: existing._id,
        identity: args.identity,
      })
      return await preflightWorkspaceSpend(ctx, args)
    }
  }
  await resolveFreshSessionCreation(ctx, args)
  return await preflightWorkspaceSpend(ctx, args)
}

function throwCreationSpendBlocked(
  result: Awaited<ReturnType<typeof preflightWorkspaceSpend>>,
): never {
  throw new ConvexError({ error: 'session_creation_spend_blocked', result })
}

export async function prepareRunnerInputDeliveryImpl(
  ctx: MutationCtx,
  args: Infer<typeof prepareRunnerInputDeliveryArgs>,
) {
  requireApiInternalKey(args.internalKey)
  let identity: SessionRequestIdentity
  let actorId: Id<'users'>
  let sessionId: Id<'agentSessions'> | undefined
  if (args.input.kind === 'drain') {
    if (args.actorId !== undefined || args.identity !== undefined || args.sessionId === undefined) {
      throw new Error('Runner drain derives workspace identity internally')
    }
    const { session } = await requireWorkspaceSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
    })
    sessionId = session._id
    actorId = session.userId
    identity = { principal: { kind: 'workspace' }, actorId }
  } else {
    if (args.actorId === undefined || args.identity === undefined) {
      throw new Error('Session input identity is required')
    }
    actorId = args.actorId
    identity = args.identity
    assertSessionIdentityAttribution(identity, actorId)
    sessionId = args.sessionId === undefined ? undefined : admitSessionId(ctx, args.sessionId)
    if (args.preflight !== undefined && args.sessionId !== undefined) {
      const decision = await preflightSessionSpendImpl(ctx, {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        identity,
        ...args.preflight,
        now: args.now,
      })
      if ('servicingStatus' in decision || !decision.proceed) return { refused: decision }
    }
  }
  let creationAccess: Extract<SessionPointAccess, { ok: true }> | undefined
  if (args.sessionId === undefined) {
    if (identity.principal.kind === 'workspace') creationAccess = admittedWorkspaceSessionAccess()
    else if (args.defaultOwner !== undefined || args.createdBySessionId !== undefined) {
      const reader = await requireCurrentSessionMembership(ctx, args.workspaceId, actorId)
      creationAccess = admittedWorkspaceSessionAccess(reader)
    }
  }
  return prepareRunnerInputDeliveryInner(ctx, {
    workspaceId: args.workspaceId,
    actorId,
    identity,
    sessionId,
    defaultOwner: args.defaultOwner,
    createdBySessionId: args.createdBySessionId,
    projectIntegrations: args.projectIntegrations,
    attemptId: args.attemptId,
    input: args.input,
    now: args.now ?? Date.now(),
    projectionAccess: creationAccess,
  })
}

export async function markRunnerInputDeliveredImpl(
  ctx: MutationCtx,
  args: Infer<typeof markRunnerInputDeliveredArgs>,
) {
  requireApiInternalKey(args.internalKey)
  return markRunnerInputDeliveredInner(ctx, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    attemptId: args.attemptId,
    throughSeq: args.throughSeq,
    now: args.now ?? Date.now(),
  })
}

export async function abandonRunnerInputDeliveryImpl(
  ctx: MutationCtx,
  args: Infer<typeof abandonRunnerInputDeliveryArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const session = await requireWritableSession(ctx, args.workspaceId, args.sessionId)
  if (session.deliveryAttempt?.attemptId !== args.attemptId) {
    return {
      status: session.turnStatus,
      lastDeliveredInputSeq: session.lastDeliveredInputSeq,
      deliveryAttempt: session.deliveryAttempt,
    }
  }
  await ctx.db.patch(args.sessionId, { deliveryAttempt: undefined })
  return {
    status: session.turnStatus,
    lastDeliveredInputSeq: session.lastDeliveredInputSeq,
    deliveryAttempt: undefined,
  }
}

async function prepareRunnerInputDeliveryInner(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    identity: SessionRequestIdentity
    sessionId?: Id<'agentSessions'>
    defaultOwner?: DefaultSessionOwner
    createdBySessionId?: Id<'agentSessions'>
    attemptId: string
    now: number
    projectIntegrations?: boolean
    projectionAccess?: Extract<SessionPointAccess, { ok: true }>
    input:
      | { kind: 'drain' }
      | {
          kind: 'initial_prompt'
          prompt: string
          behavior: AgentPromptBehavior
          clientRequestId?: string
          clientRequestFingerprint?: string
          cwd?: string
          images?: AgentEventImage[]
          attachments?: AgentEventAttachment[]
          tier?: string
          mode?: Infer<typeof agentStateMachineDefinitionValidator>
          audience?: SessionCreationAudienceRequest
          sender: SessionInputSender
        }
      | {
          kind: 'message'
          prompt: string
          behavior: AgentPromptBehavior
          clientRequestId?: string
          clientRequestFingerprint?: string
          images?: AgentEventImage[]
          attachments?: AgentEventAttachment[]
          tier?: string
          sender: SessionInputSender
        }
      | {
          kind: 'answer'
          answer: string
          clientRequestId?: string
          clientRequestFingerprint?: string
          images?: AgentEventImage[]
          attachments?: AgentEventAttachment[]
          sender: SessionInputSender
        }
  },
): Promise<
  | {
      sessionId: Id<'agentSessions'>
      status: AgentSessionStatus
      submittedThroughSeq: number
      dispatch: {
        attemptId: string
        throughSeq: number
        inputKind: 'initial_prompt' | 'message' | 'answer'
        message: string
        behavior: AgentPromptBehavior
        resolvedModelId: string
        cwd?: string
        onboarding?: boolean
        mode?: Infer<typeof agentStateMachineDefinitionValidator>
        createdBySessionId?: Id<'agentSessions'>
        defaultSession?: true
        integrations?: true
        mcpServers?: Array<{ name: string }>
        images?: Array<{ storageId: Id<'_storage'>; mimeType: AgentEventImage['mimeType'] }>
      }
      created?: { snapshot: SessionSnapshot; history: SessionInitialHistorySnapshot }
      deduplicated?: true
    }
  | {
      sessionId: Id<'agentSessions'>
      status: AgentSessionStatus
      submittedThroughSeq: number
      queued: true
      alreadyDelivered?: true
      created?: { snapshot: SessionSnapshot; history: SessionInitialHistorySnapshot }
      deduplicated?: true
    }
> {
  const sourceSession =
    args.input.kind === 'drain'
      ? null
      : await requireSenderSource(ctx, args.workspaceId, args.input.sender, args.identity)
  if (args.defaultOwner !== undefined) {
    if (args.sessionId !== undefined)
      throw new Error('Default owner cannot be combined with a session id')
    if (args.input.kind !== 'initial_prompt')
      throw new Error('Default delivery requires an initial prompt payload')
    if (args.createdBySessionId !== undefined)
      throw new Error('Default owner cannot be combined with a parent session')
    await requireDefaultOwnerReady(ctx, args.workspaceId, args.defaultOwner)
    const pointedSessionId = await defaultSessionIdForOwner(
      ctx,
      args.workspaceId,
      args.defaultOwner,
    )
    if (pointedSessionId !== undefined) {
      const pointedSession = await ctx.db.get(pointedSessionId)
      if (
        pointedSession !== null &&
        sessionMatchesDefaultOwner(pointedSession, args.defaultOwner)
      ) {
        return prepareRunnerInputDeliveryInner(ctx, {
          ...args,
          sessionId: pointedSessionId,
          defaultOwner: undefined,
          input: {
            kind: 'message',
            prompt: args.input.prompt,
            behavior: args.input.behavior,
            clientRequestId: args.input.clientRequestId,
            clientRequestFingerprint: args.input.clientRequestFingerprint,
            images: args.input.images,
            attachments: args.input.attachments,
            tier: args.input.tier,
            sender: args.input.sender,
          },
        })
      }
      throwSessionError('not_found')
    }
  }
  if (args.input.kind === 'drain' && args.sessionId === undefined)
    throw new Error('Session id is required to drain runner input')
  let admittedSession: Doc<'agentSessions'> | undefined
  if (args.sessionId !== undefined) {
    const admitted = await requireSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      identity: args.identity,
    })
    admittedSession = admitted.session
    args.projectionAccess = admitted.access
  }
  const createdAtIso = new Date(args.now).toISOString()
  const inputImages = parseEventImages('images' in args.input ? args.input.images : undefined)
  const inputAttachments = parseEventAttachments(
    'attachments' in args.input ? args.input.attachments : undefined,
  )
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  let creationAudience: SessionCreationAudience = { kind: 'workspace' }
  let creationAgent: Awaited<ReturnType<typeof resolveFreshSessionCreation>>['agent'] | undefined
  if (args.createdBySessionId !== undefined) {
    if (args.sessionId !== undefined || args.input.kind !== 'initial_prompt')
      throw new Error('Parent session can only create a new session')
    if (
      args.input.sender.kind !== 'session' ||
      args.input.sender.sessionId !== args.createdBySessionId ||
      sourceSession === null ||
      sourceSession._id !== args.createdBySessionId
    ) {
      throwSessionError('invalid_request')
    }
    const parent = sourceSession
    creationAudience = await copyableParentAudience(ctx, parent)
    args.input = {
      ...args.input,
      cwd: args.input.cwd ?? parent.cwd,
      tier: args.input.tier ?? parent.lastModelId,
    }
  }
  const entitlement = await workspaceTierEntitlement(ctx, workspace, args.now)
  let session: Doc<'agentSessions'>
  let createdSession: Doc<'agentSessions'> | undefined
  let duplicateCreate = false
  let duplicateCreateInputSeq: number | undefined
  if (args.sessionId === undefined) {
    if (args.input.kind !== 'initial_prompt')
      throw new Error('Session id is required for runner input delivery')
    assertSessionIdentityAttribution(args.identity, args.actorId)
    const tier = resolveSessionTier({
      requested: args.input.tier,
      workspaceDefault: workspace.defaultModelId,
      ...entitlement,
    })
    const clientRequestId = args.input.clientRequestId
    const existing =
      clientRequestId === undefined
        ? null
        : await ctx.db
            .query('agentSessions')
            .withIndex('by_workspace_user_client_request', q =>
              q
                .eq('workspaceId', args.workspaceId)
                .eq('userId', args.actorId)
                .eq('clientRequestId', clientRequestId),
            )
            .unique()
    if (existing !== null) {
      if (args.defaultOwner !== undefined) throw new Error('Client request id conflict')
      if (!existing.visible || existing.archiveState === 'deleting')
        throw new Error('Client request id conflict')
      // Creation idempotency returns the row that first claimed the request id.
      // requestedMachine is frozen on that row, so a retry cannot replace it
      // even if the caller sends a different definition with the same
      // fingerprint.
      const fingerprintsMatch = requestFingerprintsMatch(
        args.input.clientRequestFingerprint,
        existing.clientRequestFingerprint,
      )
      const existingInput = await ctx.db
        .query('agentSessionEvents')
        .withIndex('by_session_client_request', q =>
          q.eq('sessionId', existing._id).eq('clientRequestId', clientRequestId),
        )
        .unique()
      if (existingInput !== null && existingInput.submittingActorId === undefined) {
        throwSessionError('idempotency_conflict')
      }
      if (
        fingerprintsMatch === false ||
        existing.lastModelId !== tier ||
        (existingInput !== null && existingInput.submittingActorId !== args.actorId) ||
        (existingInput !== null && !storedSenderMatches(existingInput.event, args.input.sender)) ||
        (fingerprintsMatch === undefined &&
          (existing.prompt !== args.input.prompt || existing.cwd !== args.input.cwd))
      )
        throwSessionError('invalid_request')
      const admitted = await requireSessionPointFromDb(ctx, {
        workspaceId: args.workspaceId,
        sessionId: existing._id,
        identity: args.identity,
      })
      session = admitted.session
      args.projectionAccess = admitted.access
      createdSession = existing
      duplicateCreate = true
      duplicateCreateInputSeq = existingInput?.seq
    } else {
      if (args.createdBySessionId === undefined && args.defaultOwner === undefined) {
        const fresh = await resolveFreshSessionCreation(ctx, {
          workspaceId: args.workspaceId,
          identity: args.identity,
          cwd: args.input.cwd,
          audience: args.input.audience ?? { kind: 'workspace' },
        })
        creationAudience = fresh.audience
        creationAgent = fresh.agent
        args.projectionAccess = fresh.access
        const spend = await preflightWorkspaceSpend(ctx, {
          workspaceId: args.workspaceId,
          identity: args.identity,
          now: args.now,
        })
        if ('servicingStatus' in spend || !spend.proceed) throwCreationSpendBlocked(spend)
      }
      session = await createSessionForInitialDelivery(
        ctx,
        {
          workspaceId: args.workspaceId,
          actorId: args.actorId,
          now: args.now,
          input: { ...args.input, images: inputImages, attachments: inputAttachments },
          tier,
          createdBySessionId: args.createdBySessionId,
          audience: creationAudience,
          resolvedAgent: creationAgent,
        },
        createdAtIso,
      )
      createdSession = session
    }
    if (args.defaultOwner !== undefined) {
      if (
        (args.defaultOwner.kind === 'root' && session.agentId !== undefined) ||
        (args.defaultOwner.kind === 'agent' && session.agentId !== args.defaultOwner.agentId)
      )
        throw new Error('Default session owner mismatch')
      await writeDefaultSessionPointer(ctx, args.workspaceId, args.defaultOwner, session._id)
    }
  } else {
    session =
      admittedSession ?? (await requireWritableSession(ctx, args.workspaceId, args.sessionId))
  }

  const clientRequestId = 'clientRequestId' in args.input ? args.input.clientRequestId : undefined
  const duplicateInput =
    args.input.kind === 'initial_prompt' || clientRequestId === undefined
      ? null
      : await ctx.db
          .query('agentSessionEvents')
          .withIndex('by_session_client_request', q =>
            q.eq('sessionId', session._id).eq('clientRequestId', clientRequestId),
          )
          .unique()

  const resolvedExistingInputModelId =
    args.input.kind === 'initial_prompt' || args.input.kind === 'drain'
      ? session.lastModelId
      : resolveSessionTier({
          ...(args.input.kind === 'message' ? { requested: args.input.tier } : {}),
          sessionLast: session.lastModelId,
          workspaceDefault: workspace.defaultModelId,
          ...entitlement,
        })

  if (duplicateInput !== null && args.input.kind !== 'drain') {
    if (duplicateInput.submittingActorId === undefined) {
      throwSessionError('idempotency_conflict')
    }
    if (
      duplicateInput.submittingActorId !== args.actorId ||
      !runnerInputMatchesEvent(args.input, duplicateInput.event, {
        fingerprint: duplicateInput.clientRequestFingerprint,
        resolvedModelId: duplicateInput.resolvedModelId,
        expectedResolvedModelId: resolvedExistingInputModelId,
      })
    ) {
      throwSessionError('invalid_request')
    }
  }

  if (args.input.kind === 'answer' && duplicateInput === null && session.turnStatus !== 'ask')
    throwSessionError('invalid_request')

  const staleDeliveryAttempt =
    session.deliveryAttempt !== undefined &&
    args.now - session.deliveryAttempt.createdAt >= RUNNER_DELIVERY_LEASE_TIMEOUT_MS
      ? session.deliveryAttempt
      : undefined
  const activeDeliveryAttempt =
    staleDeliveryAttempt === undefined ? session.deliveryAttempt : undefined
  const submittedThroughSeq = duplicateCreateInputSeq ?? duplicateInput?.seq

  if (
    duplicateInput !== null &&
    duplicateInput.seq <= session.lastDeliveredInputSeq &&
    createdSession === undefined
  ) {
    return {
      sessionId: session._id,
      status: session.turnStatus,
      submittedThroughSeq: duplicateInput.seq,
      queued: true,
      alreadyDelivered: true,
      deduplicated: true,
    }
  }

  if (duplicateCreate && (activeDeliveryAttempt !== undefined || !session.runnerInputPending)) {
    return {
      sessionId: session._id,
      status: session.turnStatus,
      submittedThroughSeq: submittedThroughSeq ?? session.lastRunnerInputSeq,
      queued: true,
      ...(!session.runnerInputPending && activeDeliveryAttempt === undefined
        ? { alreadyDelivered: true as const }
        : {}),
      deduplicated: true,
      created: await createdSessionState(ctx, session, args.projectionAccess),
    }
  }

  let lastEventSeq = session.lastEventSeq
  let queuedModelId: string | undefined
  if (args.input.kind === 'message' && duplicateInput === null) {
    const tier = resolveSessionTier({
      requested: args.input.tier,
      sessionLast: session.lastModelId,
      workspaceDefault: workspace.defaultModelId,
      ...entitlement,
    })
    lastEventSeq = await appendEvent(ctx, {
      workspaceId: args.workspaceId,
      sessionId: session._id,
      event: {
        type: 'prompt_submitted',
        prompt: args.input.prompt,
        inputKind: 'message',
        behavior: args.input.behavior,
        sender: args.input.sender,
        ...(args.input.clientRequestId === undefined
          ? {}
          : { clientRequestId: args.input.clientRequestId }),
        ...(args.input.clientRequestFingerprint === undefined
          ? {}
          : { clientRequestFingerprint: args.input.clientRequestFingerprint }),
        ...(inputImages === undefined ? {} : { images: inputImages }),
        ...(inputAttachments === undefined ? {} : { attachments: inputAttachments }),
      },
      submittingActorId: args.actorId,
      resolvedModelId: tier,
      ...(args.input.clientRequestId === undefined
        ? {}
        : { clientRequestId: args.input.clientRequestId }),
      ...(args.input.clientRequestFingerprint === undefined
        ? {}
        : { clientRequestFingerprint: args.input.clientRequestFingerprint }),
      now: args.now,
    })
    queuedModelId = tier
  } else if (args.input.kind === 'answer' && duplicateInput === null) {
    const tier = resolveSessionTier({
      sessionLast: session.lastModelId,
      workspaceDefault: workspace.defaultModelId,
      ...entitlement,
    })
    lastEventSeq = await appendEvent(ctx, {
      workspaceId: args.workspaceId,
      sessionId: session._id,
      event: {
        type: 'answer_submitted',
        answer: args.input.answer,
        sender: args.input.sender,
        ...(args.input.clientRequestId === undefined
          ? {}
          : { clientRequestId: args.input.clientRequestId }),
        ...(args.input.clientRequestFingerprint === undefined
          ? {}
          : { clientRequestFingerprint: args.input.clientRequestFingerprint }),
        ...(inputImages === undefined ? {} : { images: inputImages }),
        ...(inputAttachments === undefined ? {} : { attachments: inputAttachments }),
      },
      submittingActorId: args.actorId,
      resolvedModelId: tier,
      ...(args.input.clientRequestId === undefined
        ? {}
        : { clientRequestId: args.input.clientRequestId }),
      ...(args.input.clientRequestFingerprint === undefined
        ? {}
        : { clientRequestFingerprint: args.input.clientRequestFingerprint }),
      now: args.now,
    })
    queuedModelId = tier
  } else if (duplicateInput !== null) {
    queuedModelId = duplicateInput.resolvedModelId
  }
  const acceptedRunnerInput = args.input.kind === 'message' || args.input.kind === 'answer'
  const effectiveStatus = acceptedRunnerInput ? ('running' as const) : session.turnStatus

  // The current delivery attempt owns the input cursor until it is marked or
  // abandoned. A later input may queue behind that lease, but replacing it can
  // skip an initial prompt while still advancing the delivered cursor.
  if (activeDeliveryAttempt !== undefined) {
    await patchSessionAndReconcileDiscovery(ctx, session, {
      lastEventSeq,
      ...(args.input.kind === 'message' || args.input.kind === 'answer'
        ? { lastRunnerInputSeq: lastEventSeq, runnerInputPending: true }
        : {}),
      ...(effectiveStatus === session.turnStatus ? {} : { turnStatus: effectiveStatus }),
      bucket: bucketOf({ ...session, turnStatus: effectiveStatus }),
      updatedAt: args.now,
      ...(queuedModelId === undefined ? {} : { lastModelId: queuedModelId }),
    })
    return {
      sessionId: session._id,
      status: effectiveStatus,
      submittedThroughSeq: submittedThroughSeq ?? lastEventSeq,
      queued: true,
      ...(duplicateCreate || duplicateInput !== null ? { deduplicated: true as const } : {}),
      ...(createdSession === undefined
        ? {}
        : { created: await createdSessionState(ctx, createdSession, args.projectionAccess) }),
    }
  }

  const rows = await readPendingInputRows(ctx, session._id, session.lastDeliveredInputSeq)
  const deliverableRows = rows
    .filter((row): row is typeof row & { event: AgentInputEvent } =>
      isRunnerDeliverableInputEvent(row.event as AgentSessionTimelineEvent),
    )
    .filter(row => staleDeliveryAttempt === undefined || row.seq <= staleDeliveryAttempt.throughSeq)
  if (deliverableRows.length === 0) {
    if (args.input.kind !== 'drain') throw new Error('No runner input to deliver')
    return {
      sessionId: session._id,
      status: session.turnStatus,
      submittedThroughSeq: session.lastDeliveredInputSeq ?? 0,
      queued: true,
      alreadyDelivered: true,
    }
  }

  // Only the first delivery reads a tail that can hold an agent_message row
  // (it lands before the first prompt, and the cursor never rewinds), so the
  // agent's first message is quoted to the runner exactly once.
  const agentMessageEvent = rows
    .map(row => row.event as AgentSessionTimelineEvent)
    .find(event => event.type === 'agent_message')
  const delivery = await composeDelivery(
    ctx,
    args.workspaceId,
    deliverableRows,
    agentMessageEvent?.message,
  )
  const defaultSession =
    session.agentId === undefined
      ? (await ctx.db.get(args.workspaceId))?.rootDefaultSessionId === session._id
      : (await ctx.db.get(session.agentId))?.defaultSessionId === session._id
  const deliveryAttempt = {
    attemptId: args.attemptId,
    throughSeq: delivery.throughSeq,
    kind: delivery.kind,
    createdAt: args.now,
  }
  await patchSessionAndReconcileDiscovery(ctx, session, {
    lastEventSeq,
    ...(args.input.kind === 'message' || args.input.kind === 'answer'
      ? { lastRunnerInputSeq: lastEventSeq, runnerInputPending: true }
      : {}),
    ...(effectiveStatus === session.turnStatus ? {} : { turnStatus: effectiveStatus }),
    bucket: bucketOf({ ...session, turnStatus: effectiveStatus }),
    updatedAt: args.now,
    ...(queuedModelId === undefined ? {} : { lastModelId: queuedModelId }),
    deliveryAttempt,
  })
  // Unconditional, above the Composio branch and independent of it. There is no
  // flag to thread because there is nothing to configure: this is a read of
  // durable rows with no network I/O, and D17 forbids it from ever gating
  // dispatch, so a caller that "did not ask for" custom servers is a caller
  // whose agent silently loses its own tools. A workspace with none pays one
  // empty index read.
  const mcpServers = await projectMcpServerTurnLaunch(ctx, {
    workspaceId: args.workspaceId,
    agentId: session.agentId,
  })
  const integrations =
    args.projectIntegrations === true
      ? await projectIntegrationTurnConfig(ctx, {
          workspaceId: args.workspaceId,
          duetSessionId: session._id,
          agentId: session.agentId,
          now: args.now,
        })
      : null
  return {
    sessionId: session._id,
    status: effectiveStatus,
    submittedThroughSeq: submittedThroughSeq ?? lastEventSeq,
    ...(duplicateCreate || duplicateInput !== null ? { deduplicated: true as const } : {}),
    dispatch: {
      attemptId: args.attemptId,
      throughSeq: delivery.throughSeq,
      inputKind: delivery.kind,
      message: delivery.message,
      behavior: delivery.behavior,
      resolvedModelId: delivery.resolvedModelId,
      cwd: session.cwd,
      // Projected from the durable row on EVERY dispatch, never taken from the
      // request: the gateway rebuilds its launch from whatever arrives, so a
      // later turn that omitted this would relaunch the session under the
      // agent's ordinary prompt instead of its onboarding one.
      ...(session.onboarding === true ? { onboarding: true } : {}),
      ...(session.requestedMachine === undefined ? {} : { mode: session.requestedMachine }),
      ...(session.createdBySessionId === undefined
        ? {}
        : { createdBySessionId: session.createdBySessionId }),
      ...(defaultSession ? { defaultSession: true as const } : {}),
      ...(integrations === null
        ? {}
        : { integrations: true as const, integrationsReady: integrations.ready }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(delivery.images.length === 0 ? {} : { images: delivery.images }),
    },
    ...(createdSession === undefined
      ? {}
      : {
          created: await createdSessionState(
            ctx,
            { ...createdSession, deliveryAttempt },
            args.projectionAccess,
          ),
        }),
  }
}

function runnerInputMatchesEvent(
  input:
    | {
        kind: 'initial_prompt'
        prompt: string
        clientRequestFingerprint?: string
        images?: AgentEventImage[]
        attachments?: AgentEventAttachment[]
        sender: SessionInputSender
      }
    | {
        kind: 'message'
        prompt: string
        clientRequestFingerprint?: string
        images?: AgentEventImage[]
        attachments?: AgentEventAttachment[]
        sender: SessionInputSender
      }
    | {
        kind: 'answer'
        answer: string
        clientRequestFingerprint?: string
        images?: AgentEventImage[]
        attachments?: AgentEventAttachment[]
        sender: SessionInputSender
      },
  event: unknown,
  metadata: {
    fingerprint?: string
    resolvedModelId?: string
    expectedResolvedModelId?: string
  },
): boolean {
  const fingerprintsMatch = requestFingerprintsMatch(
    input.clientRequestFingerprint,
    metadata.fingerprint,
  )
  if (fingerprintsMatch === false) return false
  // The author is part of the request's identity even when a fingerprint
  // already matched, so a replay under a different sender conflicts instead of
  // re-attributing the stored input.
  if (!storedSenderMatches(event, input.sender)) return false
  if (fingerprintsMatch === true && metadata.resolvedModelId !== metadata.expectedResolvedModelId) {
    return false
  }
  if (fingerprintsMatch === true) return true
  if (typeof event !== 'object' || event === null || !('type' in event)) return false
  const eventImages = 'images' in event && Array.isArray(event.images) ? event.images : undefined
  if (!sameInputImages(input.images, eventImages)) return false
  const eventAttachments =
    'attachments' in event && Array.isArray(event.attachments) ? event.attachments : undefined
  if (!sameInputAttachments(input.attachments, eventAttachments)) return false
  if (metadata.resolvedModelId !== metadata.expectedResolvedModelId) return false
  if (input.kind === 'answer') {
    return event.type === 'answer_submitted' && 'answer' in event && event.answer === input.answer
  }
  return (
    event.type === 'prompt_submitted' &&
    'prompt' in event &&
    event.prompt === input.prompt &&
    'inputKind' in event &&
    event.inputKind === (input.kind === 'initial_prompt' ? 'initial' : 'message')
  )
}

function requestFingerprintsMatch(
  expected: string | undefined,
  stored: string | undefined,
): boolean | undefined {
  return expected === undefined || stored === undefined ? undefined : expected === stored
}

function sameInputImages(expected: AgentEventImage[] | undefined, stored: unknown[] | undefined) {
  if (expected === undefined && stored === undefined) return true
  if (expected === undefined || stored === undefined || expected.length !== stored.length)
    return false
  return expected.every((image, index) => {
    const candidate = stored[index]
    return (
      typeof candidate === 'object' &&
      candidate !== null &&
      'storageId' in candidate &&
      candidate.storageId === image.storageId &&
      'mimeType' in candidate &&
      candidate.mimeType === image.mimeType &&
      'bytes' in candidate &&
      candidate.bytes === image.bytes
    )
  })
}

function sameInputAttachments(
  expected: AgentEventAttachment[] | undefined,
  stored: unknown[] | undefined,
) {
  if (expected === undefined && stored === undefined) return true
  if (expected === undefined || stored === undefined || expected.length !== stored.length)
    return false
  return expected.every((attachment, index) => {
    const parsed = AgentEventAttachmentSchema.safeParse(stored[index])
    return (
      parsed.success &&
      parsed.data.path === attachment.path &&
      parsed.data.name === attachment.name &&
      parsed.data.bytes === attachment.bytes &&
      parsed.data.mimeType === attachment.mimeType
    )
  })
}

/**
 * The rows waiting for the runner, and nothing else. Inputs carry their own
 * index marker so this read is the size of what is waiting, never the size of
 * the work that happened since: scanning the journal for them instead breaks
 * the moment one turn streams more than a mutation may read, and the session
 * then refuses every later message.
 */
async function readPendingInputRows(
  ctx: MutationCtx,
  sessionId: Id<'agentSessions'>,
  afterSeq: number,
): Promise<Doc<'agentSessionEvents'>[]> {
  // The same budget the journal scan has: inputs are small, and this many
  // waiting at once is a runner that stopped draining, not a long queue.
  const limit = SESSION_EVENT_READ_LIMIT * SESSION_EVENT_READ_PAGES
  const rows = await ctx.db
    .query('agentSessionEvents')
    .withIndex('by_session_input_seq', q =>
      q.eq('sessionId', sessionId).eq('input', true).gt('seq', afterSeq),
    )
    .order('asc')
    .take(limit)
  if (rows.length === limit) throw new Error('Too many pending session events')
  return rows
}

async function readEventTail(
  ctx: MutationCtx,
  sessionId: Id<'agentSessions'>,
  afterSeq: number,
): Promise<Doc<'agentSessionEvents'>[]> {
  const rows: Doc<'agentSessionEvents'>[] = []
  let cursor = afterSeq
  for (let page = 0; page < SESSION_EVENT_READ_PAGES; page += 1) {
    const batch = await ctx.db
      .query('agentSessionEvents')
      .withIndex('by_session_seq', q => q.eq('sessionId', sessionId).gt('seq', cursor))
      .order('asc')
      .take(SESSION_EVENT_READ_LIMIT)
    rows.push(...batch)
    if (batch.length < SESSION_EVENT_READ_LIMIT) return rows
    cursor = batch.at(-1)!.seq
  }
  throw new Error('Too many pending session events')
}

async function createdSessionState(
  ctx: MutationCtx,
  session: Doc<'agentSessions'>,
  access?: Extract<SessionPointAccess, { ok: true }>,
): Promise<{ snapshot: SessionSnapshot; history: SessionInitialHistorySnapshot }> {
  const rows = await readEventTail(ctx, session._id, 0)
  return {
    /* Never unread: this is the session the caller just created. */
    snapshot: SessionSnapshotSchema.parse(
      await projectSessionSnapshot(ctx, session, {
        access: requireCreationProjectionAccess(access),
        unread: false,
      }),
    ),
    history: {
      events: rows.map(row => ({
        seq: row.seq,
        event: row.event as AgentSessionTimelineEvent,
        createdAt: row.createdAt,
      })),
    },
  }
}

function requireCreationProjectionAccess(
  access: Extract<SessionPointAccess, { ok: true }> | undefined,
): Extract<SessionPointAccess, { ok: true }> {
  if (access === undefined) throw new Error('Created session projection access is missing')
  return access
}

async function markRunnerInputDeliveredInner(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    attemptId: string
    throughSeq: number
    now: number
  },
): Promise<{
  status: AgentSessionStatus
  lastDeliveredInputSeq: number
  deliveryAttempt?: RunnerDeliveryAttempt
}> {
  const session = await requireWritableSession(ctx, args.workspaceId, args.sessionId)
  const cursor = Math.max(session.lastDeliveredInputSeq, args.throughSeq)
  const patch: Partial<Doc<'agentSessions'>> = {
    lastDeliveredInputSeq: cursor,
    runnerInputPending: cursor < session.lastRunnerInputSeq,
    updatedAt: args.now,
  }
  // A lease the cursor now passes is released whoever holds it. When a stale
  // lease is re-leased by a drain and the original attempt's mark lands later,
  // the drain's lease would otherwise outlive its input: nothing marks or
  // abandons it by id, and a stale lease clips every later delivery's tail to
  // its throughSeq, leaving nothing to deliver.
  const currentAttempt = session.deliveryAttempt
  const releasesCurrentAttempt =
    currentAttempt !== undefined &&
    (currentAttempt.attemptId === args.attemptId || currentAttempt.throughSeq <= cursor)
  if (releasesCurrentAttempt) {
    patch.deliveryAttempt = undefined
  }
  await patchSessionAndReconcileDiscovery(ctx, session, patch)
  return {
    status: patch.turnStatus ?? session.turnStatus,
    lastDeliveredInputSeq: cursor,
    deliveryAttempt: releasesCurrentAttempt ? undefined : currentAttempt,
  }
}

type DeliverableInputRow = Doc<'agentSessionEvents'> & { event: AgentInputEvent }

async function composeDelivery(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  deliverableRows: DeliverableInputRow[],
  agentFirstMessage?: string,
): Promise<{
  message: string
  throughSeq: number
  kind: 'initial_prompt' | 'message' | 'answer'
  images: Array<{ storageId: Id<'_storage'>; mimeType: AgentEventImage['mimeType'] }>
  resolvedModelId: string
  behavior: AgentPromptBehavior
}> {
  const inputIndex = deliverableRows.findIndex(row => row.event.type !== 'note_submitted')
  if (inputIndex === -1) throw new Error('No runner input to deliver')
  const nextInputIndex = deliverableRows.findIndex(
    (row, index) => index > inputIndex && row.event.type !== 'note_submitted',
  )
  const includedRows =
    nextInputIndex === -1 ? deliverableRows : deliverableRows.slice(0, nextInputIndex)
  const inputRow = deliverableRows[inputIndex]!
  if (inputRow.resolvedModelId === undefined) throw new Error('Runner input has no resolved model')
  const noteRows = includedRows.filter(row => row.event.type === 'note_submitted')
  const images = collectRunnerImages({
    notes: noteRows.map(row => ({ images: row.event.images })),
    input: { images: inputRow.event.images },
  }).map(image => ({ storageId: image.storageId as Id<'_storage'>, mimeType: image.mimeType }))
  // Identity is read once per distinct author for this composition only. The
  // whole row travels into the renderer so the model sees the durable sequence
  // and the row's own clock rather than dispatch time.
  const resolved = new Map<string, ResolvedModelSender>()
  const attribute = async (row: DeliverableInputRow): Promise<AttributedInputRow> => {
    const key = senderCacheKey(row.event.sender)
    let sender = resolved.get(key)
    if (sender === undefined) {
      sender = await resolveCurrentModelSender(ctx, workspaceId, row.event.sender)
      resolved.set(key, sender)
    }
    return { seq: row.seq, createdAt: row.createdAt, event: row.event, sender }
  }
  const notes: AttributedInputRow[] = []
  for (const row of noteRows) notes.push(await attribute(row))
  return {
    message: renderRunnerInput({ notes, input: await attribute(inputRow), agentFirstMessage }),
    throughSeq: Math.max(...includedRows.map(row => row.seq)),
    kind: deliveryKindForEvent(inputRow.event),
    resolvedModelId: inputRow.resolvedModelId,
    behavior: inputRow.event.type === 'prompt_submitted' ? inputRow.event.behavior : 'follow_up',
    images,
  }
}

function senderCacheKey(sender: SessionInputSender): string {
  switch (sender.kind) {
    case 'user':
      return `user:${sender.userId}`
    case 'app':
      return `app:${sender.appId}`
    case 'session':
      return `session:${sender.sessionId}`
    case 'system':
      return 'system'
  }
}

function deliveryKindForEvent(event: AgentInputEvent): 'initial_prompt' | 'message' | 'answer' {
  if (event.type === 'answer_submitted') return 'answer'
  if (event.type !== 'prompt_submitted') throw new Error('No runner input to deliver')
  return event.inputKind === 'initial' ? 'initial_prompt' : 'message'
}
