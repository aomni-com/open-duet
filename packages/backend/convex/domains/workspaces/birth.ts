import type { GenericMutationCtx } from 'convex/server'
import { ConvexError, v } from 'convex/values'

import {
  normalizeSlug,
  WORKSPACE_LIMIT_BY_PLAN,
  type WorkspaceCreateRefusal,
  WorkspaceDuetNameSchema,
  WorkspaceNameSchema,
  WorkspacePurposeSchema,
  WorkspaceSlugSchema,
} from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import { mutation } from '../../_generated/server'
import { PRODUCT_BACKEND_ANALYTICS_ORIGIN, emitAnalyticsEvent } from '../analytics/model'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { grantTrialCreditsForAccount } from '../credits/grants'
import { fundingOf, servicingStatusFor } from '../credits/subscriptions'
import { assertActorRole, isLiveWorkspace } from './authorization'
import { findAvailableWorkspaceSlug, requireAvailableWorkspaceSlug } from './internal'
import { insertWorkspaceMember } from './memberDirectory'
import { seedWorkspaceAtBirth } from './seed'
import { scheduleWorkspaceVm } from './vmSchedule'

type MutationCtx = GenericMutationCtx<DataModel>

export const createWorkspace = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    slug: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const created = await createWorkspaceRow(ctx, {
      ownerUserId: args.actorId,
      slug: args.slug,
      name: args.name,
    })
    await scheduleWorkspaceVm(ctx, created.workspaceId)
    return { ...created, status: 'provisioning' as const }
  },
})

export const completeWorkspaceOnboarding = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    duetName: v.string(),
    purpose: v.optional(v.string()),
    // Analytics-only goal id (`<goalId>` or 'custom') — never stored.
    goal: v.optional(v.string()),
    // The agents the user picked on the team step, also analytics-only and,
    // like `goal`, recorded as given: the subscriptions the installs create
    // are the durable record of what they ended up with, while this is the
    // record of what they asked for. The two differ whenever an install
    // fails, which is the whole reason to keep it.
    selectedAgentNames: v.optional(v.array(v.string())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    // Payment setup is the final onboarding prerequisite. Read the payer from
    // the workspace rather than assuming the actor funds it; a member may be
    // completing a workspace paid for by another account. Completed rows stay
    // idempotent even if their payer's current billing projection changes.
    if (workspace.onboardedAt === undefined) {
      const billingUser = await ctx.db.get(workspace.billingUserId)
      if (billingUser?.billing?.paymentMethodReadyAt === undefined) {
        throw new ConvexError({ error: 'payment_method_required' })
      }
    }
    const requestedDuetName = WorkspaceDuetNameSchema.parse(args.duetName)
    const duetName = workspace.duetName ?? requestedDuetName
    const requestedPurpose =
      args.purpose === undefined ? undefined : WorkspacePurposeSchema.parse(args.purpose)
    const purpose = workspace.purpose ?? requestedPurpose
    const onboardedAt = workspace.onboardedAt ?? args.now ?? Date.now()
    const completedNow = workspace.onboardedAt === undefined
    await ctx.db.patch(args.workspaceId, {
      duetName,
      ...(purpose === undefined ? {} : { purpose }),
      onboardedAt,
    })
    if (completedNow) {
      const selectedAgents = args.selectedAgentNames ?? []
      await emitAnalyticsEvent(ctx, {
        id: `onboarding:${args.workspaceId}:${onboardedAt}`,
        name: 'onboarding.completed',
        version: 1,
        at: onboardedAt,
        origin: PRODUCT_BACKEND_ANALYTICS_ORIGIN,
        userId: args.actorId,
        workspaceId: args.workspaceId,
        // The goal id may travel to analytics; the purpose text never does.
        // The count rides along because a bare array cannot be charted: it is
        // the answer to "how many agents does a new workspace start with", and
        // 0 is a skipped team step.
        properties: {
          duetName,
          goal: args.goal ?? 'none',
          selectedAgents,
          selectedAgentCount: selectedAgents.length,
        },
      })
      await scheduleWorkspaceVm(ctx, args.workspaceId)
    }
    return { duetName, onboardedAt }
  },
})

export async function createWorkspaceRow(
  ctx: MutationCtx,
  args: {
    ownerUserId: Id<'users'>
    name?: string
    slug?: string
    // System workspaces (the official-agents golden workspace) are created by
    // audited internal-admin operations for accounts that never pay; the
    // creation limit is a user-facing rule, not a system one.
    bypassWorkspaceLimit?: boolean
    // Duet owns this workspace and pays for it. Distinct from the gate above:
    // that one waives a creation-time eligibility check, while this one waives
    // servicing for the workspace's whole life. Without it a system workspace
    // created for an unpaying account is born `paused` — the creation-limit
    // bypass says nothing about the servicing stamp below.
    servicingExempt?: boolean
    // Only the first interactive workspace omits onboardedAt. System and
    // later user-created workspaces preserve the historical no-gate behavior.
    requiresOnboarding?: boolean
  },
): Promise<{ workspaceId: Id<'workspaces'>; slug: string }> {
  const now = Date.now()
  if (args.bypassWorkspaceLimit !== true) {
    const user = await ctx.db.get(args.ownerUserId)
    if (user === null) throw new Error('Workspace owner not found')
    const plan = fundingOf(user, now).plan ?? 'starter'
    const limit = WORKSPACE_LIMIT_BY_PLAN[plan]
    let count = 0
    const memberships = ctx.db
      .query('workspaceMembers')
      .withIndex('by_user_and_workspace', q => q.eq('userId', args.ownerUserId))
    for await (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId)
      if (workspace === null || !isLiveWorkspace(workspace.status)) continue
      if (++count >= limit) {
        throw new ConvexError({
          error: 'workspace_limit_reached',
          plan,
          limit,
        } satisfies WorkspaceCreateRefusal)
      }
    }
  }

  const name = WorkspaceNameSchema.parse(args.name?.trim() || 'Workspace')
  const slug =
    args.slug === undefined
      ? await findAvailableWorkspaceSlug(ctx, normalizeSlug(name) || 'workspace')
      : await requireAvailableWorkspaceSlug(ctx, WorkspaceSlugSchema.parse(args.slug))
  // The ephemeral mark follows the OWNER: expiry deletion erases every
  // workspace an ephemeral user owns, so every one of them must carry the mark
  // (and with it the VM's `duet-ephemeral` tag) from birth — an unmarked
  // second workspace would be deleted at expiry yet invisible to the
  // provider-side sweep until then.
  const owner = await ctx.db.get(args.ownerUserId)
  const workspaceId = await ctx.db.insert('workspaces', {
    slug,
    name,
    status: 'provisioning',
    createdAt: now,
    updatedAt: now,
    createdByUserId: args.ownerUserId,
    billingUserId: args.ownerUserId,
    ...(args.requiresOnboarding === true ? {} : { onboardedAt: now }),
    ...(owner?.ephemeralExpiresAt === undefined ? {} : { ephemeral: true }),
  })
  await insertWorkspaceMember(ctx, {
    workspaceId,
    userId: args.ownerUserId,
    role: 'owner',
  })
  await writeAuditEvent(ctx, {
    workspaceId,
    event: 'workspace.created',
    actorId: args.ownerUserId,
    provenance: { source: 'workspace_birth' },
    at: now,
  })
  await grantTrialCreditsForAccount(ctx, {
    workspaceId,
    actorId: args.ownerUserId,
    now,
    source: 'workspace_create',
  })
  const billingUser = await ctx.db.get(args.ownerUserId)
  if (billingUser === null) throw new Error('Workspace owner disappeared during birth')
  const servicingExemptAt = args.servicingExempt === true ? now : undefined
  await ctx.db.patch(workspaceId, {
    ...(servicingExemptAt === undefined ? {} : { servicingExemptAt }),
    // Through the one verdict owner, so an exempt workspace is born active
    // rather than inheriting its payer's state and waiting for a reconcile.
    servicingStatus: servicingStatusFor({ servicingExemptAt }, billingUser, now),
    servicingStatusChangedAt: now,
  })
  await seedWorkspaceAtBirth(ctx, {
    workspaceId,
    actorId: args.ownerUserId,
    now,
  })
  return { workspaceId, slug }
}
