import type { GenericMutationCtx } from 'convex/server'

import { DEFAULT_TRIAL_GRANT_MICRO_USD, TRIAL_WINDOW_MS } from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import { writeAuditEvent } from '../audit/model'
import { classifySignupIdentity } from '../users/signupIdentity'
import { applyLedgerEntryWithDb } from './ledger'

type MutationCtx = GenericMutationCtx<DataModel>

export async function grantTrialCreditsForAccount(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    now?: number
    source: 'signup' | 'workspace_create' | 'vm_register'
  },
): Promise<{ granted: boolean }> {
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('Grant actor not found')
  // The withhold is enforced here rather than at any single caller, so both
  // grant sites — workspace birth and VM registration — are covered by
  // construction. A withhold that only guarded birth would leak the moment a
  // VM registered.
  if (user.trialGrantWithheldAt !== undefined) return { granted: false }
  const identity = classifySignupIdentity(user.email)
  const result = await applyLedgerEntryWithDb(ctx, {
    workspaceId: args.workspaceId,
    amountMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    type: 'grant',
    reference: `signup_grant:canonical:${identity.grantKey}`,
    userId: args.actorId,
    metadata: { grant: 'trial', canonicalEmail: identity.canonicalEmail, source: args.source },
    now: args.now,
    idempotencyScope: 'global',
  })
  if (result.applied) {
    const grantedAt = args.now ?? Date.now()
    await ctx.db.patch(args.actorId, {
      billing: { ...user.billing, trialExpiresAt: grantedAt + TRIAL_WINDOW_MS },
    })
    await writeAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      event: 'credits.trial_granted',
      actorId: args.actorId,
      at: grantedAt,
      provenance: { canonicalEmail: identity.canonicalEmail, source: args.source },
    })
  }
  return { granted: result.applied }
}
