import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { internalMutation, mutation, query } from '../../_generated/server'
import { deleteWorkspaceMembershipGeneration } from '../agentSessions/membershipRemoval'
import { normalizeEmail } from '../users/identity'
import { retireUserIdentity } from '../users/retire'
import { reassignWorkspacePayer } from '../workspaces/billingUser'
import { deleteWorkspaceImpl } from '../workspaces/mutations'
import { audit, adminRefusal, requireInternalAdmin } from './model'
import type { PlannerWorkspace } from './ownership'
import { planUserCleanup } from './planner'

const dispatchRef = makeFunctionReference(
  'domains/internalAdmin/cleanup:dispatch',
) as FunctionReference<'mutation'>

const MEMBER_CAP = 500
const USER_WORKSPACE_CAP = 100

type Access = { internalKey: string; actorId: Id<'users'> }

function validateCleanupProvenance(args: { requestId: string; reason: string }) {
  const reason = args.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw adminRefusal('invalid_request')
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId)) throw adminRefusal('invalid_request')
  return reason
}
async function findUser(ctx: QueryCtx, identifier: string) {
  const trimmed = identifier.trim()
  const normalized = trimmed.includes('@') ? normalizeEmail(trimmed) : trimmed
  const byId = ctx.db.normalizeId('users', normalized)
  if (byId !== null) return await ctx.db.get(byId)
  if (!trimmed.includes('@')) return null
  return await ctx.db
    .query('users')
    .withIndex('by_email', q => q.eq('email', normalized))
    .unique()
}

async function plannerInput(ctx: QueryCtx, targetUserId: Id<'users'>): Promise<PlannerWorkspace[]> {
  const memberships = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_user_and_workspace', q => q.eq('userId', targetUserId))
    .take(USER_WORKSPACE_CAP + 1)
  if (memberships.length > USER_WORKSPACE_CAP)
    return [
      {
        workspaceId: 'overflow',
        status: 'active',
        billingUserId: String(targetUserId),
        members: [],
        overflow: {
          table: 'workspaceMembers',
          cap: USER_WORKSPACE_CAP,
          observed: memberships.length,
        },
      },
    ]
  const billed = await ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', targetUserId))
    .take(USER_WORKSPACE_CAP + 1)
  if (billed.length > USER_WORKSPACE_CAP)
    return [
      {
        workspaceId: 'overflow',
        status: 'active',
        billingUserId: String(targetUserId),
        members: [],
        overflow: { table: 'workspaces', cap: USER_WORKSPACE_CAP, observed: billed.length },
      },
    ]
  const ids = new Set<string>(memberships.map(row => String(row.workspaceId)))
  for (const row of billed) ids.add(String(row._id))
  const result: PlannerWorkspace[] = []
  for (const id of ids) {
    const workspaceId = ctx.db.normalizeId('workspaces', id)
    if (workspaceId === null) continue
    const workspace = await ctx.db.get(workspaceId)
    if (workspace === null) continue
    const members = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspace._id))
      .take(MEMBER_CAP + 1)
    if (members.length > MEMBER_CAP) {
      result.push({
        workspaceId: String(workspace._id),
        status: workspace.status,
        billingUserId: String(workspace.billingUserId),
        members: [],
        overflow: { table: 'workspaceMembers', cap: MEMBER_CAP, observed: members.length },
      })
      continue
    }
    result.push({
      workspaceId: String(workspace._id),
      status: workspace.status,
      billingUserId: String(workspace.billingUserId),
      members: members.map(member => ({
        membershipId: String(member._id),
        userId: String(member.userId),
        role: member.role,
        generationId: String(member._id),
      })),
    })
  }
  return result
}

async function buildPreview(ctx: QueryCtx, args: Access & { identifier: string }) {
  const actor = await requireInternalAdmin(ctx, args)
  const user = await findUser(ctx, args.identifier)
  if (user === null) throw adminRefusal('not_found')
  const workspaces = await plannerInput(ctx, user._id)
  const plan = planUserCleanup({
    targetUserId: String(user._id),
    selfTarget: actor._id === user._id,
    workspaces,
  })
  const operations = await ctx.db
    .query('internalAdminCleanupOperations')
    .withIndex('by_target', q => q.eq('targetUserId', user._id))
    .order('desc')
    .take(20)
  const active = operations.find(row => row.status === 'scheduled' || row.status === 'running')
  const terminal = operations.find(
    row => row.status === 'completed' || row.status === 'blocked' || row.status === 'failed',
  )
  const previewWorkspaces = []
  for (const action of plan.workspaceActions) {
    const source = workspaces.find(row => row.workspaceId === action.workspaceId)
    const classification =
      action.kind === 'delete_workspace'
        ? 'sole_member_delete'
        : action.kind === 'detach_membership'
          ? 'shared_membership_detach'
          : action.kind === 'transfer_billing_then_detach'
            ? 'shared_payer_transfer_then_detach'
            : 'blocked_billing_transfer'
    previewWorkspaces.push({
      workspaceId: action.workspaceId,
      ...(source === undefined
        ? { memberCount: 0 }
        : {
            memberCount: source.members.filter(member => member.live !== false).length,
            billingUserId: source.billingUserId,
          }),
      classification,
      ...(action.membershipId === undefined ? {} : { targetMembershipId: action.membershipId }),
      ...(action.membershipGenerationId === undefined
        ? {}
        : { targetMembershipGenerationId: action.membershipGenerationId }),
      ...(action.newBillingUserId === undefined
        ? {}
        : { newBillingUserId: action.newBillingUserId }),
    })
  }
  return {
    user: {
      userId: user._id,
      email: user.email,
      ...(user.name === undefined ? {} : { name: user.name }),
    },
    selfTarget: actor._id === user._id,
    alreadyRetired: user.email.endsWith('@duet-test.invalid'),
    canStart: plan.canStart && active === undefined && !user.email.endsWith('@duet-test.invalid'),
    workspaces: previewWorkspaces,
    blockers: plan.blockers,
    identity: { kind: 'retire_identity' as const, userId: user._id },
    retainedHistory: plan.retainedHistory,
    ...(active === undefined ? {} : { activeOperationId: active._id }),
    ...(terminal === undefined ? {} : { terminalOperationId: terminal._id }),
    auditId: undefined,
  }
}

export const previewUserCleanup = query({
  args: { internalKey: v.string(), actorId: v.id('users'), identifier: v.string() },
  handler: async (ctx, args) => buildPreview(ctx, args),
})

export const startUserCleanup = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    requestId: v.string(),
    reason: v.string(),
    now: v.number(),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const reason = validateCleanupProvenance(args)
    if (actor._id === args.userId) throw adminRefusal('self_target')
    const existing = await ctx.db
      .query('internalAdminCleanupOperations')
      .withIndex('by_target', q => q.eq('targetUserId', args.userId))
      .order('desc')
      .take(20)
    const reusable = existing.find(
      row => row.status === 'scheduled' || row.status === 'running' || row.status === 'completed',
    )
    if (reusable !== undefined) return { ...(await operationResult(ctx, reusable)), replayed: true }
    const terminal = existing.find(row => row.status === 'blocked' || row.status === 'failed')
    if (terminal !== undefined) return { ...(await operationResult(ctx, terminal)), replayed: true }
    const user = await ctx.db.get(args.userId)
    if (user === null) throw adminRefusal('not_found')
    if (user.email.endsWith('@duet-test.invalid')) throw adminRefusal('cleanup_blocked')
    const plan = planUserCleanup({
      targetUserId: String(user._id),
      workspaces: await plannerInput(ctx, user._id),
    })
    const status = plan.canStart ? 'scheduled' : 'blocked'
    const operationId = await ctx.db.insert('internalAdminCleanupOperations', {
      targetUserId: user._id,
      actorId: actor._id,
      actorEmail: actor.email,
      reason,
      requestId: args.requestId,
      status,
      plan,
      createdAt: args.now,
      updatedAt: args.now,
    })
    for (const action of plan.workspaceActions)
      await ctx.db.insert('internalAdminCleanupResources', {
        operationId,
        resourceKey: action.key,
        action: action.kind,
        status: status === 'blocked' ? 'blocked' : 'scheduled',
        workspaceId: ctx.db.normalizeId('workspaces', action.workspaceId) ?? undefined,
        membershipId: action.membershipId
          ? (ctx.db.normalizeId('workspaceMembers', action.membershipId) ?? undefined)
          : undefined,
        membershipGenerationId: action.membershipGenerationId,
        newBillingUserId: action.newBillingUserId
          ? (ctx.db.normalizeId('users', action.newBillingUserId) ?? undefined)
          : undefined,
        attempts: 0,
        updatedAt: args.now,
      })
    await ctx.db.insert('internalAdminCleanupResources', {
      operationId,
      resourceKey: plan.identity.key,
      action: 'retire_identity',
      status: status === 'blocked' ? 'blocked' : 'scheduled',
      attempts: 0,
      updatedAt: args.now,
    })
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      'admin.user_cleanup.start',
      String(user._id),
      undefined,
      undefined,
      'completed',
    )
    if (status === 'scheduled') await ctx.scheduler.runAfter(0, dispatchRef, { operationId })
    const inserted = await ctx.db.get(operationId)
    if (inserted === null) throw new Error('Cleanup operation disappeared')
    return { ...(await operationResult(ctx, inserted)), auditId }
  },
})

export const cleanupStatus = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    operationId: v.id('internalAdminCleanupOperations'),
  },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const op = await ctx.db.get(args.operationId)
    if (op === null) throw adminRefusal('not_found')
    return operationResult(ctx, op)
  },
})

export const retryCleanup = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    requestId: v.string(),
    reason: v.string(),
    now: v.number(),
    operationId: v.id('internalAdminCleanupOperations'),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const reason = validateCleanupProvenance(args)
    const op = await ctx.db.get(args.operationId)
    if (op === null) throw adminRefusal('not_found')
    if (op.status !== 'blocked' && op.status !== 'failed') return operationResult(ctx, op)
    const freshUser = await ctx.db.get(op.targetUserId)
    if (freshUser === null) throw adminRefusal('not_found')
    const freshPlan = planUserCleanup({
      targetUserId: String(op.targetUserId),
      workspaces: await plannerInput(ctx, op.targetUserId),
    })
    await ctx.db.patch(op._id, {
      status: freshPlan.canStart ? 'scheduled' : 'blocked',
      plan: freshPlan,
      updatedAt: args.now,
      actorId: actor._id,
      actorEmail: actor.email,
      reason,
      requestId: args.requestId,
      lastError: freshPlan.canStart ? undefined : 'preflight blockers remain',
    })
    const resources = await ctx.db
      .query('internalAdminCleanupResources')
      .withIndex('by_operation', q => q.eq('operationId', op._id))
      .take(USER_WORKSPACE_CAP + 2)
    for (const action of freshPlan.workspaceActions) {
      const prior = resources.find(resource => resource.resourceKey === action.key)
      if (prior !== undefined && (prior.status === 'blocked' || prior.status === 'failed'))
        await ctx.db.patch(prior._id, {
          action: action.kind,
          status: freshPlan.canStart ? 'scheduled' : 'blocked',
          updatedAt: args.now,
          lastError: undefined,
        })
      else if (prior === undefined)
        await ctx.db.insert('internalAdminCleanupResources', {
          operationId: op._id,
          resourceKey: action.key,
          action: action.kind,
          status: freshPlan.canStart ? 'scheduled' : 'blocked',
          workspaceId: ctx.db.normalizeId('workspaces', action.workspaceId) ?? undefined,
          membershipId: action.membershipId
            ? (ctx.db.normalizeId('workspaceMembers', action.membershipId) ?? undefined)
            : undefined,
          membershipGenerationId: action.membershipGenerationId,
          newBillingUserId: action.newBillingUserId
            ? (ctx.db.normalizeId('users', action.newBillingUserId) ?? undefined)
            : undefined,
          attempts: 0,
          updatedAt: args.now,
        })
    }
    const identityResource = resources.find(
      resource => resource.resourceKey === freshPlan.identity.key,
    )
    if (
      identityResource !== undefined &&
      (identityResource.status === 'blocked' || identityResource.status === 'failed')
    )
      await ctx.db.patch(identityResource._id, {
        status: freshPlan.canStart ? 'scheduled' : 'blocked',
        updatedAt: args.now,
        lastError: undefined,
      })
    else if (identityResource === undefined)
      await ctx.db.insert('internalAdminCleanupResources', {
        operationId: op._id,
        resourceKey: freshPlan.identity.key,
        action: 'retire_identity',
        status: freshPlan.canStart ? 'scheduled' : 'blocked',
        attempts: 0,
        updatedAt: args.now,
      })
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      'admin.user_cleanup.retry',
      String(op.targetUserId),
      undefined,
      undefined,
      'completed',
    )
    if (freshPlan.canStart) await ctx.scheduler.runAfter(0, dispatchRef, { operationId: op._id })
    return { ...(await operationResult(ctx, (await ctx.db.get(op._id))!)), auditId }
  },
})

async function operationResult(ctx: QueryCtx, op: Doc<'internalAdminCleanupOperations'>) {
  const resources = await ctx.db
    .query('internalAdminCleanupResources')
    .withIndex('by_operation', q => q.eq('operationId', op._id))
    .take(USER_WORKSPACE_CAP + 2)
  return {
    operationId: op._id,
    targetUserId: op.targetUserId,
    status: op.status,
    canRetry: op.status === 'blocked' || op.status === 'failed',
    resources: resources.map(resource => ({
      key: resource.resourceKey,
      kind: resource.action,
      status: resource.status,
      outcome:
        resource.status === 'provider_pending'
          ? 'provider_cleanup_pending'
          : resource.status === 'completed'
            ? resource.action === 'delete_workspace'
              ? 'workspace_cleanup_scheduled'
              : resource.action === 'retire_identity'
                ? 'identity_retired'
                : resource.action === 'transfer_billing_then_detach'
                  ? 'billing_transferred'
                  : resource.action === 'detach_membership'
                    ? 'membership_detached'
                    : 'retained_history'
            : resource.status === 'blocked'
              ? 'blocked'
              : resource.status === 'failed'
                ? 'failed'
                : undefined,
      ...(resource.workspaceId === undefined ? {} : { workspaceId: resource.workspaceId }),
      ...(resource.membershipGenerationId === undefined
        ? {}
        : { membershipGenerationId: resource.membershipGenerationId }),
      attempts: resource.attempts,
      ...(resource.lastError === undefined ? {} : { lastError: resource.lastError }),
      updatedAt: resource.updatedAt,
    })),
    auditId: undefined,
  }
}

function resourcePriority(action: string): number {
  if (action === 'delete_workspace') return 0
  if (action === 'transfer_billing_then_detach' || action === 'detach_membership') return 1
  if (action === 'retire_identity') return 2
  return 3
}

export const dispatch = internalMutation({
  args: { operationId: v.id('internalAdminCleanupOperations') },
  handler: async (ctx, args) => {
    const op = await ctx.db.get(args.operationId)
    if (op === null || (op.status !== 'scheduled' && op.status !== 'running')) return
    await ctx.db.patch(op._id, { status: 'running', updatedAt: Date.now() })
    const scheduled = await ctx.db
      .query('internalAdminCleanupResources')
      .withIndex('by_operation', q => q.eq('operationId', op._id))
      .filter(q => q.eq(q.field('status'), 'scheduled'))
      .take(USER_WORKSPACE_CAP + 2)
    const next = scheduled.sort(
      (a, b) => resourcePriority(a.action) - resourcePriority(b.action),
    )[0]
    if (next === undefined) {
      const remaining = await ctx.db
        .query('internalAdminCleanupResources')
        .withIndex('by_operation_status', q => q.eq('operationId', op._id).eq('status', 'running'))
        .first()
      if (remaining === null)
        await ctx.db.patch(op._id, { status: 'completed', updatedAt: Date.now() })
      return
    }
    await ctx.db.patch(next._id, {
      status: 'running',
      attempts: next.attempts + 1,
      updatedAt: Date.now(),
    })
    try {
      if (next.action === 'delete_workspace') {
        const workspace = next.workspaceId === undefined ? null : await ctx.db.get(next.workspaceId)
        if (workspace === null || workspace.status === 'deleted')
          await ctx.db.patch(next._id, { status: 'completed', updatedAt: Date.now() })
        else {
          const members = await ctx.db
            .query('workspaceMembers')
            .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspace._id))
            .take(2)
          if (members.length !== 1 || String(members[0]?._id) !== next.membershipGenerationId)
            throw new Error('workspace membership changed; retry required')
          await deleteWorkspaceImpl(ctx, {
            workspaceId: workspace._id,
            actorId: op.actorId,
            now: Date.now(),
          })
          await ctx.db.patch(next._id, { status: 'provider_pending', updatedAt: Date.now() })
        }
      } else if (
        next.action === 'detach_membership' ||
        next.action === 'transfer_billing_then_detach'
      ) {
        const membership =
          next.membershipId === undefined ? null : await ctx.db.get(next.membershipId)
        if (membership === null || String(membership._id) !== next.membershipGenerationId)
          throw new Error('membership generation changed; retry required')
        if (
          next.action === 'transfer_billing_then_detach' &&
          next.workspaceId &&
          next.newBillingUserId
        )
          await reassignWorkspacePayer(ctx, {
            workspaceId: next.workspaceId,
            newBillingUserId: next.newBillingUserId,
            actorId: op.actorId,
            now: Date.now(),
          })
        await deleteWorkspaceMembershipGeneration(ctx, membership, Date.now())
        await ctx.db.patch(next._id, { status: 'completed', updatedAt: Date.now() })
      } else if (next.action === 'retire_identity') {
        await retireUserIdentity(ctx, { userId: op.targetUserId, now: Date.now() })
        await ctx.db.patch(next._id, { status: 'completed', updatedAt: Date.now() })
      } else {
        await ctx.db.patch(next._id, {
          status: 'blocked',
          lastError: 'billing transfer blocked',
          updatedAt: Date.now(),
        })
        await ctx.db.patch(op._id, {
          status: 'blocked',
          lastError: 'billing transfer blocked',
          updatedAt: Date.now(),
        })
        return
      }
    } catch (error) {
      await ctx.db.patch(next._id, {
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
      await ctx.db.patch(op._id, {
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
      return
    }
    await ctx.scheduler.runAfter(0, dispatchRef, { operationId: op._id })
  },
})
