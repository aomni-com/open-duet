import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { WORKSPACE_MEMBER_LIMIT } from '@repo/contract'

import type { Id } from '../_generated/dataModel'
import { action, mutation, query, type QueryCtx } from '../_generated/server'
import { resolvePreloadedSessionAccess } from '../domains/agentSessions/access'
import { applySessionAudienceDeltaImpl } from '../domains/agentSessions/audience'
import { createSessionForInitialDelivery } from '../domains/agentSessions/creation'
import { deleteSessionBatchImpl } from '../domains/agentSessions/deletion'
import {
  deleteSessionDiscovery,
  patchSessionAndReconcileDiscovery,
  reconcileSessionDiscovery,
} from '../domains/agentSessions/discovery'
import { appendSessionNoteImpl } from '../domains/agentSessions/events'
import { sessionMemberState, setSessionPersonalArchive } from '../domains/agentSessions/memberState'
import { listSessionsImpl } from '../domains/agentSessions/queries'
import { resolveSessionTier } from '../domains/agentSessions/tier'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { assertActorRole } from '../domains/workspaces/authorization'
import { workspaceTierEntitlement } from '../domains/workspaces/tierPolicy'

const membershipRemovalDispatchRef = makeFunctionReference<
  'action',
  {
    membershipId: Id<'workspaceMembers'>
    expectedAfterSessionId: Id<'agentSessions'> | null
  }
>('domains/agentSessions/membershipRemoval:dispatch')

export const createQueuedSessionForTest = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    prompt: v.string(),
    cwd: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')
    const now = args.now ?? Date.now()
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const entitlement = await workspaceTierEntitlement(ctx, workspace, now)
    const session = await createSessionForInitialDelivery(
      ctx,
      {
        workspaceId: args.workspaceId,
        actorId: args.actorId,
        audience: { kind: 'workspace' },
        now,
        input: {
          kind: 'initial_prompt',
          prompt: args.prompt,
          behavior: 'steer',
          cwd: args.cwd,
          sender: { kind: 'user', userId: args.actorId },
        },
        tier: resolveSessionTier({
          workspaceDefault: workspace.defaultModelId,
          ...entitlement,
        }),
      },
      new Date(now).toISOString(),
    )
    return {
      sessionId: session._id,
      status: session.turnStatus,
      lastEventSeq: session.lastEventSeq,
      lastDeliveredInputSeq: session.lastDeliveredInputSeq,
    }
  },
})

/**
 * Bulk-appends inert runner output to a session, the way a long tool run does,
 * so a test can grow a turn's journal past what one mutation may read without
 * relaying thousands of events one at a time.
 */
export const seedSessionOutputForTest = mutation({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    count: v.number(),
    chunkBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const session = await ctx.db.get(args.sessionId)
    if (session === null) throw new Error('Session not found')
    const chunk = 'x'.repeat(args.chunkBytes ?? 0)
    let seq = session.lastEventSeq
    for (let index = 0; index < args.count; index += 1) {
      seq += 1
      await ctx.db.insert('agentSessionEvents', {
        workspaceId: session.workspaceId,
        sessionId: session._id,
        seq,
        event: {
          type: 'task_output',
          taskId: 't1',
          chunk: args.chunkBytes === undefined ? `progress ${index}` : chunk,
        },
        createdAt: session.updatedAt + index,
      })
    }
    await ctx.db.patch(session._id, { lastEventSeq: seq })
    return { lastEventSeq: seq }
  },
})

export const rawSessionForTest = query({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.get(args.sessionId)
  },
})

export const discoveryLaneExistsForTest = query({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    laneKey: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return (
      (await ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_session_lane', q =>
          q.eq('sessionId', args.sessionId).eq('laneKey', args.laneKey),
        )
        .unique()) !== null
    )
  },
})

export const makeSpecificSessionForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    membershipIds: v.array(v.id('workspaceMembers')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.workspaceId !== args.workspaceId) {
      throw new Error('Session not found')
    }
    await ctx.db.patch(session._id, {
      audienceKind: 'specific',
      specificGrantedParticipantCount: 0,
    })
    await reconcileSessionDiscovery(ctx, {
      ...session,
      audienceKind: 'specific',
      specificGrantedParticipantCount: 0,
    })
    const members = await Promise.all(args.membershipIds.map(id => ctx.db.get(id)))
    const userIds = members.map(member => {
      if (member === null || member.workspaceId !== args.workspaceId) {
        throw new Error('Workspace member not found')
      }
      return String(member.userId)
    })
    if (userIds.length > 0) {
      await applySessionAudienceDeltaImpl(ctx, {
        workspaceId: args.workspaceId,
        sessionId: String(args.sessionId),
        identity: {
          principal: { kind: 'workspace' },
          actorId: members[0]!.userId,
        },
        add: userIds,
        remove: [],
        now: Date.now(),
      })
    }
  },
})

/** Maximum-width list candidate: every current membership has a live grant. */
export const makeMaximumSpecificSessionForBudgetTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.workspaceId !== args.workspaceId) {
      throw new Error('Session not found')
    }
    const memberships = (
      await Promise.all(
        (['owner', 'editor', 'viewer'] as const).map(role =>
          ctx.db
            .query('workspaceMembers')
            .withIndex('by_workspace_role', q =>
              q.eq('workspaceId', args.workspaceId).eq('role', role),
            )
            .take(WORKSPACE_MEMBER_LIMIT),
        ),
      )
    ).flat()
    if (memberships.length !== WORKSPACE_MEMBER_LIMIT)
      throw new Error('Maximum budget fixture requires the configured member capacity')
    for (const membership of memberships) {
      await ctx.db.insert('agentSessionMemberStates', {
        workspaceId: args.workspaceId,
        sessionId: session._id,
        membershipId: membership._id,
        audienceGranted: true,
      })
    }
    await ctx.db.patch(session._id, {
      audienceKind: 'specific',
      specificGrantedParticipantCount: memberships.length,
    })
    await reconcileSessionDiscovery(ctx, {
      ...session,
      audienceKind: 'specific',
      specificGrantedParticipantCount: memberships.length,
    })
  },
})

export const setSessionVisibleWithoutDiscoveryForTest = mutation({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    visible: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.sessionId, { visible: args.visible })
  },
})

export const setLargeSessionProjectionFieldsForBudgetTest = mutation({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    prompt: v.optional(v.string()),
    machinePathName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.sessionId, {
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
      ...(args.machinePathName === undefined
        ? {}
        : {
            machine: {
              definitionName: 'large-machine',
              currentState: 'large-state',
              orderedPath: [
                {
                  key: 'large-state',
                  index: 0,
                  name: args.machinePathName,
                  phase: 'current' as const,
                },
              ],
              activity: 'running' as const,
            },
          }),
    })
  },
})

export const listSessionsBudgetForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    actorId: v.id('users'),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    let budget: {
      reads: { ranges: number; documents: number; bytes: number }
      responseBytes: number
    } | null = null
    const page = await listSessionsImpl(ctx, {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      identity: {
        principal: { kind: 'human', userId: args.actorId },
        actorId: args.actorId,
      },
      actorId: args.actorId,
      limit: args.limit,
      onBudgetSnapshot: snapshot => {
        budget = snapshot
      },
    })
    if (budget === null) throw new Error('Session page budget evidence is missing')
    return { page, budget }
  },
})

export const applyAudienceGrantForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    membershipId: v.id('workspaceMembers'),
    granted: v.boolean(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const member = await ctx.db.get(args.membershipId)
    if (member === null || member.workspaceId !== args.workspaceId) {
      throw new Error('Workspace member not found')
    }
    await applySessionAudienceDeltaImpl(ctx, {
      workspaceId: args.workspaceId,
      sessionId: String(args.sessionId),
      identity: { principal: { kind: 'workspace' }, actorId: member.userId },
      add: args.granted ? [String(member.userId)] : [],
      remove: args.granted ? [] : [String(member.userId)],
      now: args.now ?? Date.now(),
    })
  },
})

export const applySessionAudienceDeltaBudgetForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    actorId: v.id('users'),
    add: v.array(v.string()),
    remove: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    let metrics:
      | Parameters<NonNullable<Parameters<typeof applySessionAudienceDeltaImpl>[1]['onMetrics']>>[0]
      | null = null
    await applySessionAudienceDeltaImpl(ctx, {
      workspaceId: args.workspaceId,
      sessionId: String(args.sessionId),
      identity: { principal: { kind: 'workspace' }, actorId: args.actorId },
      add: args.add,
      remove: args.remove,
      now: 10_000,
      onMetrics: snapshot => {
        metrics = snapshot
      },
    })
    if (metrics === null) throw new Error('Audience mutation metrics are missing')
    return metrics
  },
})

export const setPersonalArchiveForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    membershipId: v.id('workspaceMembers'),
    archivedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await setSessionPersonalArchive(ctx, args)
  },
})

export const memberStateForTest = query({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    membershipId: v.id('workspaceMembers'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await sessionMemberState(ctx, args.sessionId, args.membershipId)
  },
})

export const sessionAccessForMemberForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const [session, membership] = await Promise.all([
      ctx.db.get(args.sessionId),
      ctx.db
        .query('workspaceMembers')
        .withIndex('by_workspace_and_user', q =>
          q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
        )
        .unique(),
    ])
    const state =
      session?.audienceKind === 'specific' && membership !== null
        ? await sessionMemberState(ctx, session._id, membership._id)
        : null
    return resolvePreloadedSessionAccess({
      identity: {
        principal: { kind: 'human', userId: args.userId },
        actorId: args.userId,
      },
      membership:
        membership === null
          ? null
          : {
              membershipId: membership._id,
              userId: membership.userId,
              role: membership.role,
            },
      session:
        session === null || session.workspaceId !== args.workspaceId
          ? null
          : {
              audience:
                session.audienceKind === 'specific'
                  ? {
                      kind: 'specific',
                      membershipGrant:
                        state?.audienceGranted === true
                          ? { membershipId: state.membershipId }
                          : null,
                    }
                  : { kind: 'workspace' },
              agentState: 'root',
            },
    })
  },
})

export const memberStatesForMembershipForTest = query({
  args: { internalKey: v.string(), membershipId: v.id('workspaceMembers') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('agentSessionMemberStates')
      .withIndex('by_membership_session', q => q.eq('membershipId', args.membershipId))
      .collect()
  },
})

export const membershipRemovalJobForTest = query({
  args: { internalKey: v.string(), membershipId: v.id('workspaceMembers') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('agentSessionMembershipRemovalJobs')
      .withIndex('by_membership', q => q.eq('membershipId', args.membershipId))
      .unique()
  },
})

export const setMembershipRemovalCheckpointForTest = mutation({
  args: {
    internalKey: v.string(),
    membershipId: v.id('workspaceMembers'),
    afterSessionId: v.id('agentSessions'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const job = await ctx.db
      .query('agentSessionMembershipRemovalJobs')
      .withIndex('by_membership', q => q.eq('membershipId', args.membershipId))
      .unique()
    if (job === null) throw new Error('Membership removal job not found')
    await ctx.db.patch(job._id, { afterSessionId: args.afterSessionId })
  },
})

export const setSpecificParticipantCountForTest = mutation({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.sessionId, {
      specificGrantedParticipantCount: args.count,
    })
  },
})

export const deleteSessionRowForMembershipCleanupTest = mutation({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await deleteSessionDiscovery(ctx, args.sessionId)
    await ctx.db.delete(args.sessionId)
  },
})

export const runMembershipRemovalCoordinatorForTest = action({
  args: {
    internalKey: v.string(),
    membershipId: v.id('workspaceMembers'),
    expectedAfterSessionId: v.union(v.id('agentSessions'), v.null()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.runAction(membershipRemovalDispatchRef, {
      membershipId: args.membershipId,
      expectedAfterSessionId: args.expectedAfterSessionId,
    })
  },
})

// Every session row in a workspace, unprojected. The bucket invariant has to
// look at rows the product deliberately hides — onboarding, archived, deleting —
// because a stale bucket on a hidden row is exactly the one nobody would notice.
export const rawSessionsForWorkspaceForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('agentSessions')
      .filter(q => q.eq(q.field('workspaceId'), args.workspaceId))
      .collect()
  },
})

export const rawToolRouterConfigForTest = query({
  args: {
    internalKey: v.string(),
    configId: v.id('composioToolRouterSessions'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db.get(args.configId)
    if (row === null) return null
    return {
      configId: row._id,
      permissionFingerprint: row.permissionFingerprint,
      disabledToolkitSlugs: row.disabledToolkitSlugs,
      providerSessionId: row.providerSessionId,
      appliedPermissionFingerprint: row.appliedPermissionFingerprint,
    }
  },
})

export const seedIntegrationAgentPoliciesForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (!Number.isInteger(args.count) || args.count < 0) {
      throw new Error('Invalid policy seed count')
    }
    for (let index = 0; index < args.count; index += 1) {
      await ctx.db.insert('integrationAgentPolicies', {
        workspaceId: args.workspaceId,
        toolkitSlug: `seed-toolkit-${index.toString().padStart(4, '0')}`,
        allowedAgentIds: [],
        createdAt: index,
        updatedAt: index,
      })
    }
  },
})

export const toolRouterConfigsForSessionForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const rows = await ctx.db
      .query('composioToolRouterSessions')
      .withIndex('by_duet_session', q => q.eq('duetSessionId', args.sessionId))
      .collect()
    if (rows.some(row => row.workspaceId !== args.workspaceId)) return []
    return rows.map(row => ({
      configId: row._id,
      permissionFingerprint: row.permissionFingerprint,
      disabledToolkitSlugs: row.disabledToolkitSlugs,
      providerSessionId: row.providerSessionId,
      appliedPermissionFingerprint: row.appliedPermissionFingerprint,
    }))
  },
})

export const markDeletingForTest = mutation({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const session = await ctx.db.get(args.sessionId)
    if (session === null) return null
    await patchSessionAndReconcileDiscovery(ctx, session, {
      archiveState: 'deleting',
      visible: false,
    })
    return null
  },
})

export const setLastModelIdRawForTest = mutation({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    value: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.sessionId, { lastModelId: args.value })
  },
})

export const clearSubmittingActorForTest = mutation({
  args: {
    internalKey: v.string(),
    sessionId: v.id('agentSessions'),
    clientRequestId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const event = await ctx.db
      .query('agentSessionEvents')
      .withIndex('by_session_client_request', q =>
        q.eq('sessionId', args.sessionId).eq('clientRequestId', args.clientRequestId),
      )
      .unique()
    if (event === null) throw new Error('Input event not found')
    await ctx.db.patch(event._id, { submittingActorId: undefined })
  },
})

/**
 * Stamp `count` distinct readers' cursors on one session, in one transaction.
 *
 * Deleting a session has to walk these rows by `by_session`, and its batch
 * boundary needs more readers than a batch holds. The users are bare rows —
 * nothing here signs in, and no membership is needed, because that cascade is
 * keyed on the session rather than on who may see it.
 */
export const seedSessionReadersForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    count: v.number(),
    now: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let index = 0; index < args.count; index += 1) {
      const userId = await ctx.db.insert('users', {
        email: `seeded-reader-${args.sessionId}-${index}@example.test`,
        memberDirectoryRevision: 0,
        createdAt: args.now,
        updatedAt: args.now,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
      })
      await ctx.db.insert('sessionReads', {
        workspaceId: args.workspaceId,
        userId,
        sessionId: args.sessionId,
        lastReadSeq: 1,
        updatedAt: args.now,
      })
    }
    return args.count
  },
})

export const memberReadCursorsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
  },
  returns: v.array(v.object({ sessionId: v.id('agentSessions'), lastReadSeq: v.number() })),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const rows = await ctx.db
      .query('sessionReads')
      .withIndex('by_workspace_user_session', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
      )
      .collect()
    return rows.map(row => ({
      sessionId: row.sessionId,
      lastReadSeq: row.lastReadSeq,
    }))
  },
})

async function sessionDependentRowCounts(ctx: QueryCtx, sessionId: Id<'agentSessions'>) {
  const [events, relayReceipts, images, reads, memberStates, discovery, toolRouter] =
    await Promise.all([
      ctx.db
        .query('agentSessionEvents')
        .withIndex('by_session_seq', q => q.eq('sessionId', sessionId))
        .take(1),
      ctx.db
        .query('agentSessionRelayReceipts')
        .withIndex('by_session_relay', q => q.eq('sessionId', sessionId))
        .take(1),
      ctx.db
        .query('agentSessionImages')
        .withIndex('by_session_storage', q => q.eq('sessionId', sessionId))
        .take(1),
      /* Not a presence probe like its neighbours: the leak this guards is one
         row per *member*, so a cascade that dropped all but one would read as
         healthy under `take(1)`. */
      ctx.db
        .query('sessionReads')
        .withIndex('by_session', q => q.eq('sessionId', sessionId))
        .take(1_000),
      ctx.db
        .query('agentSessionMemberStates')
        .withIndex('by_session_membership', q => q.eq('sessionId', sessionId))
        .take(1_000),
      ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_session_lane', q => q.eq('sessionId', sessionId))
        .take(1_000),
      ctx.db
        .query('composioToolRouterSessions')
        .withIndex('by_duet_session', q => q.eq('duetSessionId', sessionId))
        .take(1),
    ])

  return {
    events: events.length,
    relayReceipts: relayReceipts.length,
    images: images.length,
    reads: reads.length,
    memberStates: memberStates.length,
    discovery: discovery.length,
    toolRouter: toolRouter.length,
  }
}

export const childRowCountsForTest = query({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await sessionDependentRowCounts(ctx, args.sessionId)
  },
})

/**
 * A bounded, read-only physical census for the deployed deletion journey.
 *
 * Public 404 means a sealed row is no longer readable, not that Convex cleanup
 * has finished. The journey supplies only ids it created; this query observes
 * their canonical row, durable work row, and the dependent families owned by
 * the existing cleanup batch without exposing a workspace-wide enumerator.
 */
export const sessionDeletionCensusForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionIds: v.array(v.id('agentSessions')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (args.sessionIds.length > 16) throw new Error('Deletion census accepts at most 16 sessions')
    return await Promise.all(
      args.sessionIds.map(async sessionId => {
        const [canonical, work, dependents] = await Promise.all([
          ctx.db.get(sessionId),
          ctx.db
            .query('agentSessionDeletionWork')
            .withIndex('by_session', q => q.eq('sessionId', sessionId))
            .unique(),
          sessionDependentRowCounts(ctx, sessionId),
        ])
        if (canonical !== null && canonical.workspaceId !== args.workspaceId) {
          throw new Error('Deletion census session belongs to another workspace')
        }
        if (work !== null && work.workspaceId !== args.workspaceId) {
          throw new Error('Deletion census work belongs to another workspace')
        }
        return {
          sessionId,
          canonical: canonical === null ? 0 : 1,
          deletionWork: work === null ? 0 : 1,
          dependents,
        }
      }),
    )
  },
})

export const sessionDeletionWorkForTest = query({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_session', q => q.eq('sessionId', args.sessionId))
      .unique()
  },
})

export const prepareSessionDeletionCleanupForTest = mutation({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  returns: v.id('agentSessionDeletionWork'),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.archiveState !== 'deleting') {
      throw new Error('Deleting session fixture not found')
    }
    const existing = await ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_session', q => q.eq('sessionId', session._id))
      .unique()
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        childScanComplete: true,
        externalState: 'complete',
        externalRunId: undefined,
        updatedAt: Date.now(),
      })
      return existing._id
    }
    return await ctx.db.insert('agentSessionDeletionWork', {
      workspaceId: session.workspaceId,
      sessionId: session._id,
      rootSessionId: session._id,
      childScanComplete: true,
      externalState: 'complete',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const runSessionDeletionCleanupForTest = mutation({
  args: { internalKey: v.string(), workId: v.id('agentSessionDeletionWork') },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await deleteSessionBatchImpl(ctx, { workId: args.workId })
  },
})

export const sessionExistsForTest = query({
  args: { internalKey: v.string(), sessionId: v.id('agentSessions') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return (await ctx.db.get(args.sessionId)) !== null
  },
})

export const seedDeleteChildrenForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const session = await ctx.db.get(args.sessionId)
    const workspace = await ctx.db.get(args.workspaceId)
    if (session === null || workspace === null) throw new Error('Fixture target not found')
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', workspace.billingUserId),
      )
      .unique()
    if (membership === null) throw new Error('Fixture membership not found')
    for (let index = 0; index < args.count; index += 1) {
      await ctx.db.insert('agentSessionMemberStates', {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        membershipId: membership._id,
        audienceGranted: false,
        personalArchivedAt: index + 1,
      })
      await ctx.db.insert('agentSessionDiscovery', {
        workspaceId: args.workspaceId,
        laneKey: `delete-fixture:${membership._id}:${index}`,
        sessionId: args.sessionId,
        archiveState: 'archived',
        bucket: session.bucket,
        orderKey: `fixture:${String(index).padStart(4, '0')}`,
        title: session.title,
        updatedAt: session.updatedAt,
        lastEventSeq: session.lastEventSeq,
      })
    }
  },
})

/**
 * Appends a run of notes in ONE transaction, through the exact per-note impl
 * the public mutation uses. Tests that need a long tail as a FIXTURE (the
 * long-undelivered-tail delivery contract needs a thousand of them) were
 * paying one awaited client round trip per note — ~40ms of real indexed
 * write commit each, which made a single fixture cost ~39 of a file's ~100
 * seconds. The tail's existence is the fixture; the round trips were not.
 */
export const appendSessionNoteRunForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    actorId: v.id('users'),
    notePrefix: v.string(),
    count: v.number(),
    startIndex: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const start = args.startIndex ?? 0
    for (let index = 0; index < args.count; index += 1) {
      await appendSessionNoteImpl(ctx, {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        actorId: args.actorId,
        identity: {
          principal: { kind: 'human', userId: args.actorId },
          actorId: args.actorId,
        },
        note: `${args.notePrefix}${start + index}`,
        sender: { kind: 'user', userId: args.actorId },
        internalKey: args.internalKey,
      })
    }
    return null
  },
})
