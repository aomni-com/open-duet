import {
  makeFunctionReference,
  type FunctionReference,
  type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from '../../_generated/server'
import { deleteMemberDirectoryEntry } from '../workspaces/memberDirectory'
import { deleteMembershipSessionDiscovery, patchSessionAndReconcileDiscovery } from './discovery'
import { requireSpecificParticipantCount } from './memberState'

type MutationCtx = GenericMutationCtx<DataModel>

export const MEMBERSHIP_REMOVAL_BATCH_SIZE = 20
// Invariant poison is not a hot-path outage. Keep it durable and visible
// without turning one bad row into a per-second action/mutation loop.
const RETRY_DELAY_MS = 60_000

type DispatchArgs = {
  membershipId: Id<'workspaceMembers'>
  expectedAfterSessionId: Id<'agentSessions'> | null
}

type PageResult =
  | { status: 'stale' | 'complete' | 'empty' }
  | {
      status: 'ready'
      sessionIds: Id<'agentSessions'>[]
      scannedThroughSessionId: Id<'agentSessions'>
      hasMore: boolean
    }

const dispatchRef = makeFunctionReference<'action', DispatchArgs>(
  'domains/agentSessions/membershipRemoval:dispatch',
)
const pageRef: FunctionReference<'query', 'internal', DispatchArgs, PageResult> =
  makeFunctionReference(
    'domains/agentSessions/membershipRemoval:page',
  ) as unknown as FunctionReference<'query', 'internal', DispatchArgs, PageResult>
const reconcileOneRef = makeFunctionReference<
  'mutation',
  {
    membershipId: Id<'workspaceMembers'>
    sessionId: Id<'agentSessions'>
    now: number
  }
>('domains/agentSessions/membershipRemoval:reconcileOne')
const advanceRef = makeFunctionReference<
  'mutation',
  {
    membershipId: Id<'workspaceMembers'>
    expectedAfterSessionId: Id<'agentSessions'> | null
    scannedThroughSessionId: Id<'agentSessions'>
    hasMore: boolean
  }
>('domains/agentSessions/membershipRemoval:advance')
const completeEmptyRef = makeFunctionReference<'mutation', DispatchArgs>(
  'domains/agentSessions/membershipRemoval:completeEmpty',
)

/**
 * Delete exactly one membership generation and enqueue its semantic cleanup.
 * Callers must pass the row they resolved before deletion; workspace/user
 * lookup here would let a fast rejoin redirect cleanup onto the new generation.
 */
export async function deleteWorkspaceMembershipGeneration(
  ctx: MutationCtx,
  membership: Doc<'workspaceMembers'>,
  now: number,
  options: { schedule?: boolean } = {},
): Promise<void> {
  await deleteMemberDirectoryEntry(ctx, membership._id)
  await ctx.db.delete(membership._id)
  let job = await ctx.db
    .query('agentSessionMembershipRemovalJobs')
    .withIndex('by_membership', q => q.eq('membershipId', membership._id))
    .unique()
  if (job === null) {
    const jobId = await ctx.db.insert('agentSessionMembershipRemovalJobs', {
      workspaceId: membership.workspaceId,
      membershipId: membership._id,
      updatedAt: now,
    })
    job = await ctx.db.get(jobId)
  }
  if (job === null) throw new Error('Membership removal job disappeared')
  if (options.schedule !== false) {
    await ctx.scheduler.runAfter(0, dispatchRef, {
      membershipId: membership._id,
      expectedAfterSessionId: job.afterSessionId ?? null,
    })
  }
}

/**
 * Read one immutable candidate window, reconcile each session in its own
 * transaction, then CAS the job checkpoint past the whole window. A poisoned
 * session is logged and left in place; after the forward scan reaches the end,
 * the checkpoint wraps and retries only rows that remain.
 */
export const dispatch = internalAction({
  args: {
    membershipId: v.id('workspaceMembers'),
    expectedAfterSessionId: v.union(v.id('agentSessions'), v.null()),
  },
  handler: dispatchMembershipRemoval,
})

export async function dispatchMembershipRemoval(
  ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'scheduler'>,
  args: DispatchArgs,
): Promise<void> {
  try {
    const candidatePage = await ctx.runQuery(pageRef, args)
    if (candidatePage.status === 'empty') {
      await ctx.runMutation(completeEmptyRef, args)
      return
    }
    if (candidatePage.status !== 'ready') return
    for (const sessionId of candidatePage.sessionIds) {
      try {
        await ctx.runMutation(reconcileOneRef, {
          membershipId: args.membershipId,
          sessionId,
          now: Date.now(),
        })
      } catch (error) {
        console.error('[session-membership-removal] session reconcile failed', {
          membershipId: args.membershipId,
          sessionId,
          error: String(error),
        })
      }
    }
    await ctx.runMutation(advanceRef, {
      ...args,
      scannedThroughSessionId: candidatePage.scannedThroughSessionId,
      hasMore: candidatePage.hasMore,
    })
  } catch (error) {
    console.error('[session-membership-removal] dispatcher failed; retrying checkpoint', {
      ...args,
      error: String(error),
    })
    await ctx.scheduler.runAfter(RETRY_DELAY_MS, dispatchRef, args)
  }
}

export const page = internalQuery({
  args: {
    membershipId: v.id('workspaceMembers'),
    expectedAfterSessionId: v.union(v.id('agentSessions'), v.null()),
  },
  handler: async (ctx, args): Promise<PageResult> => {
    const job = await ctx.db
      .query('agentSessionMembershipRemovalJobs')
      .withIndex('by_membership', q => q.eq('membershipId', args.membershipId))
      .unique()
    if (job === null) return { status: 'complete' }
    if ((job.afterSessionId ?? null) !== args.expectedAfterSessionId) return { status: 'stale' }
    const candidates = await ctx.db
      .query('agentSessionMemberStates')
      .withIndex('by_membership_session', q => {
        const lane = q.eq('membershipId', args.membershipId)
        return args.expectedAfterSessionId === null
          ? lane
          : lane.gt('sessionId', args.expectedAfterSessionId)
      })
      .take(MEMBERSHIP_REMOVAL_BATCH_SIZE + 1)
    const states = candidates.slice(0, MEMBERSHIP_REMOVAL_BATCH_SIZE)
    if (states.length === 0) {
      // The paired mutation owns completion because this query cannot delete
      // the durable job. Its checkpoint CAS makes a duplicate empty delivery
      // harmless after a concurrent page has already advanced.
      return { status: 'empty' }
    }
    return {
      status: 'ready',
      sessionIds: states.map(state => state.sessionId),
      scannedThroughSessionId: states.at(-1)!.sessionId,
      hasMore: candidates.length > MEMBERSHIP_REMOVAL_BATCH_SIZE,
    }
  },
})

export const completeEmpty = internalMutation({
  args: {
    membershipId: v.id('workspaceMembers'),
    expectedAfterSessionId: v.union(v.id('agentSessions'), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db
      .query('agentSessionMembershipRemovalJobs')
      .withIndex('by_membership', q => q.eq('membershipId', args.membershipId))
      .unique()
    if (job === null || (job.afterSessionId ?? null) !== args.expectedAfterSessionId) return
    await completeOrWrapRemovalJob(ctx, job)
  },
})

export const reconcileOne = internalMutation({
  args: {
    membershipId: v.id('workspaceMembers'),
    sessionId: v.id('agentSessions'),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const state = await ctx.db
      .query('agentSessionMemberStates')
      .withIndex('by_session_membership', q =>
        q.eq('sessionId', args.sessionId).eq('membershipId', args.membershipId),
      )
      .unique()
    if (state === null) return
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.archiveState === 'deleting') {
      await ctx.db.delete(state._id)
      await deleteMembershipSessionDiscovery(ctx, args.sessionId, args.membershipId)
      return
    }
    if (session.workspaceId !== state.workspaceId) {
      throw new Error('Session member state target is invalid')
    }
    if (session.audienceKind === 'workspace' || !state.audienceGranted) {
      await ctx.db.delete(state._id)
      await deleteMembershipSessionDiscovery(ctx, args.sessionId, args.membershipId)
      return
    }
    const count = requireSpecificParticipantCount(session)
    if (count === 0) throw new Error('Specific participant count is invalid')
    const nextCount = count - 1
    await ctx.db.delete(state._id)
    await deleteMembershipSessionDiscovery(ctx, args.sessionId, args.membershipId)
    await patchSessionAndReconcileDiscovery(ctx, session, {
      specificGrantedParticipantCount: nextCount,
      ...(nextCount === 0 && session.archiveState === 'active'
        ? { archiveState: 'archived' as const, archivedAt: args.now, updatedAt: args.now }
        : {}),
    })
  },
})

export const advance = internalMutation({
  args: {
    membershipId: v.id('workspaceMembers'),
    expectedAfterSessionId: v.union(v.id('agentSessions'), v.null()),
    scannedThroughSessionId: v.id('agentSessions'),
    hasMore: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db
      .query('agentSessionMembershipRemovalJobs')
      .withIndex('by_membership', q => q.eq('membershipId', args.membershipId))
      .unique()
    if (job === null || (job.afterSessionId ?? null) !== args.expectedAfterSessionId) return
    if (args.hasMore) {
      await ctx.db.patch(job._id, {
        afterSessionId: args.scannedThroughSessionId,
        updatedAt: Date.now(),
      })
      await ctx.scheduler.runAfter(0, dispatchRef, {
        membershipId: args.membershipId,
        expectedAfterSessionId: args.scannedThroughSessionId,
      })
      return
    }
    await completeOrWrapRemovalJob(ctx, job)
  },
})

async function completeOrWrapRemovalJob(
  ctx: MutationCtx,
  job: Doc<'agentSessionMembershipRemovalJobs'>,
): Promise<void> {
  const remaining = await ctx.db
    .query('agentSessionMemberStates')
    .withIndex('by_membership_session', q => q.eq('membershipId', job.membershipId))
    .first()
  if (remaining === null) {
    await ctx.db.delete(job._id)
    return
  }
  await ctx.db.patch(job._id, { afterSessionId: undefined, updatedAt: Date.now() })
  await ctx.scheduler.runAfter(RETRY_DELAY_MS, dispatchRef, {
    membershipId: job.membershipId,
    expectedAfterSessionId: null,
  })
}
