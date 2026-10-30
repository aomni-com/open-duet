import {
  makeFunctionReference,
  type FunctionReference,
  type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { internalAction, internalMutation } from '../../_generated/server'
import {
  deleteMemberDirectoryEntry,
  writeMemberDirectoryEntry,
} from '../workspaces/memberDirectory'
import { cleanDisplayName, normalizeEmail } from './identity'

type MutationCtx = GenericMutationCtx<DataModel>

export const MEMBER_DIRECTORY_REFRESH_BATCH_SIZE = 20
const RETRY_DELAY_MS = 1_000

type DispatchArgs = {
  userId: Id<'users'>
  revision: number
  afterMembershipId: Id<'workspaceMembers'> | null
}

type BatchResult =
  | { status: 'stale' | 'complete' }
  | { status: 'pending'; afterMembershipId: Id<'workspaceMembers'> }

const dispatchRef = makeFunctionReference<'action', DispatchArgs>(
  'domains/users/directoryRefresh:dispatch',
)
const refreshBatchRef: FunctionReference<'mutation', 'internal', DispatchArgs, BatchResult> =
  makeFunctionReference(
    'domains/users/directoryRefresh:refreshBatch',
  ) as unknown as FunctionReference<'mutation', 'internal', DispatchArgs, BatchResult>

type CanonicalIdentityPatch = Partial<
  Pick<Doc<'users'>, 'image' | 'firstName' | 'lastName' | 'emailVerificationTime'>
>

/** The sole existing-user writer for canonical name/email identity. */
export async function updateCanonicalUserIdentity(
  ctx: MutationCtx,
  args: {
    user: Doc<'users'>
    email: string
    name?: string
    now: number
    patch?: CanonicalIdentityPatch
  },
): Promise<{ email: string; name?: string; revision: number; changed: boolean }> {
  const email = normalizeEmail(args.email)
  const name = cleanDisplayName(args.name)
  const changed = email !== args.user.email || name !== args.user.name
  const revision = changed
    ? args.user.memberDirectoryRevision + 1
    : args.user.memberDirectoryRevision
  await ctx.db.patch(args.user._id, {
    ...args.patch,
    email,
    name,
    memberDirectoryRevision: revision,
    updatedAt: args.now,
  })
  if (changed) {
    await enqueueMemberDirectoryRefresh(ctx, { userId: args.user._id, revision, now: args.now })
  }
  return { email, ...(name === undefined ? {} : { name }), revision, changed }
}

/**
 * Coalesce profile propagation into the one durable row for this user.
 * The caller has already patched the canonical user in this same transaction.
 */
export async function enqueueMemberDirectoryRefresh(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; revision: number; now: number },
): Promise<void> {
  const existing = await ctx.db
    .query('memberDirectoryRefreshJobs')
    .withIndex('by_user', q => q.eq('userId', args.userId))
    .unique()
  if (existing === null) {
    await ctx.db.insert('memberDirectoryRefreshJobs', {
      userId: args.userId,
      revision: args.revision,
      updatedAt: args.now,
    })
  } else {
    await ctx.db.patch(existing._id, {
      revision: args.revision,
      afterMembershipId: undefined,
      updatedAt: args.now,
    })
  }
  await ctx.scheduler.runAfter(0, dispatchRef, {
    userId: args.userId,
    revision: args.revision,
    afterMembershipId: null,
  })
}

/**
 * One dispatcher invocation owns one atomic page. A failed mutation leaves its
 * checkpoint untouched, so the retry names the exact same page. Carrying the
 * expected checkpoint also makes duplicate action delivery harmless.
 */
export const dispatch = internalAction({
  args: {
    userId: v.id('users'),
    revision: v.number(),
    afterMembershipId: v.union(v.id('workspaceMembers'), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    let result: BatchResult
    try {
      result = await ctx.runMutation(refreshBatchRef, args)
    } catch (error) {
      console.error('[member-directory-refresh] batch failed; retrying checkpoint', {
        userId: args.userId,
        revision: args.revision,
        afterMembershipId: args.afterMembershipId,
        error: String(error),
      })
      await ctx.scheduler.runAfter(RETRY_DELAY_MS, dispatchRef, args)
      return
    }
    if (result.status === 'pending') {
      await ctx.scheduler.runAfter(0, dispatchRef, {
        userId: args.userId,
        revision: args.revision,
        afterMembershipId: result.afterMembershipId,
      })
    }
  },
})

export const refreshBatch = internalMutation({
  args: {
    userId: v.id('users'),
    revision: v.number(),
    afterMembershipId: v.union(v.id('workspaceMembers'), v.null()),
  },
  handler: async (ctx, args): Promise<BatchResult> => await refreshMemberDirectoryBatch(ctx, args),
})

export async function refreshMemberDirectoryBatch(
  ctx: MutationCtx,
  args: DispatchArgs,
): Promise<BatchResult> {
  const job = await ctx.db
    .query('memberDirectoryRefreshJobs')
    .withIndex('by_user', q => q.eq('userId', args.userId))
    .unique()
  if (
    job === null ||
    job.revision !== args.revision ||
    (job.afterMembershipId ?? null) !== args.afterMembershipId
  ) {
    return { status: 'stale' }
  }

  const user = await ctx.db.get(args.userId)
  if (user === null) {
    await ctx.db.delete(job._id)
    return { status: 'complete' }
  }
  const identity = boundedStoredIdentity(user)
  const candidates = await ctx.db
    .query('workspaceMemberDirectory')
    .withIndex('by_user_and_membership', q => {
      const lane = q.eq('userId', args.userId)
      return args.afterMembershipId === null
        ? lane
        : lane.gt('membershipId', args.afterMembershipId)
    })
    .take(MEMBER_DIRECTORY_REFRESH_BATCH_SIZE + 1)
  const page = candidates.slice(0, MEMBER_DIRECTORY_REFRESH_BATCH_SIZE)

  for (const row of page) {
    const membership = await ctx.db.get(row.membershipId)
    if (!isMatchingMembership(row, membership, args.userId)) {
      // A deleted or mismatched membership is a stale projection, not a reason
      // to retry this page forever and starve valid memberships after it.
      await deleteMemberDirectoryEntry(ctx, row.membershipId)
      continue
    }
    await writeMemberDirectoryEntry(ctx, membership, identity)
  }

  if (candidates.length <= MEMBER_DIRECTORY_REFRESH_BATCH_SIZE) {
    await ctx.db.delete(job._id)
    return { status: 'complete' }
  }
  const afterMembershipId = page.at(-1)?.membershipId
  if (afterMembershipId === undefined) throw new Error('Directory refresh page made no progress')
  await ctx.db.patch(job._id, { afterMembershipId, updatedAt: Date.now() })
  return { status: 'pending', afterMembershipId }
}

function boundedStoredIdentity(user: Doc<'users'>): { email: string; name?: string } {
  const email = normalizeEmail(user.email)
  if (email !== user.email) throw new Error('Canonical user email is not normalized')
  const name = cleanDisplayName(user.name)
  if (name !== user.name) throw new Error('Canonical user display name is not normalized')
  return { email, ...(name === undefined ? {} : { name }) }
}

function isMatchingMembership(
  row: Doc<'workspaceMemberDirectory'>,
  membership: Doc<'workspaceMembers'> | null,
  userId: Id<'users'>,
): membership is Doc<'workspaceMembers'> {
  return (
    membership !== null &&
    membership.userId === userId &&
    membership.workspaceId === row.workspaceId
  )
}
