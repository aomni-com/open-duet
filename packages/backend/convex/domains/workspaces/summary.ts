import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { WorkspaceRole, WorkspaceSummary } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { workspaceCreditRecovery } from '../credits/creditsShared'
import { fundingOf } from '../credits/subscriptions'
import { workspaceDefaultTierProjection } from './tierPolicy'

type DbCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

/**
 * One payload build's memo of the payer rows its workspaces point at.
 *
 * Both `funding` and `defaultTier` are facts about the payer, and this
 * projection runs inside `apiKeys/api:resolveCredential` — on **every**
 * `/v1/*` request. A browser session spanning five workspaces funded by one person
 * must read that person once, not five times.
 *
 * Build one per payload and let it die with the request. A longer-lived memo
 * would serve an entitlement that lapsed while it was cached, which is exactly
 * the thing this projection exists to report truthfully.
 */
export type PayerMemo = Map<Id<'users'>, Doc<'users'>>

export function newPayerMemo(): PayerMemo {
  return new Map()
}

async function payerOf(
  ctx: DbCtx,
  memo: PayerMemo,
  billingUserId: Id<'users'>,
): Promise<Doc<'users'>> {
  const cached = memo.get(billingUserId)
  if (cached !== undefined) return cached
  const payer = await ctx.db.get(billingUserId)
  if (payer === null) throw new Error('Workspace billing user not found')
  memo.set(billingUserId, payer)
  return payer
}

/**
 * `WorkspaceSummary` as the backend builds it, before it crosses the wire.
 *
 * Structurally the contract type; it differs only where Convex is stricter
 * than JSON — branded document ids instead of bare strings, and a readonly
 * starter-agent list because that is what its producer hands over. Deriving
 * it with `Omit` is what makes a new field on the contract schema a compile
 * error here rather than a field that silently never ships.
 */
export type WorkspaceSummaryProjection = Omit<
  WorkspaceSummary,
  'id' | 'billingUserId' | 'onboarding'
> & {
  id: Id<'workspaces'>
  billingUserId: Id<'users'>
  onboarding?: { starterAgents: readonly string[] }
}

/**
 * The one place a workspace becomes a `WorkspaceSummary`.
 *
 * Every credential kind reports a workspace the same way, so the projection
 * belongs to the workspace, not to the auth payload that carries it. It was
 * hand-copied at four sites in `apiKeys/model.ts`; a field added to three of
 * them is an entitlement lie that no type check catches.
 *
 * `role` is an input because callers do not agree on where it comes from: a
 * membership row for human and OAuth credentials, and a
 * fixed `'editor'` for the system VM key, which has no membership at all.
 * `now` is an input because the tier projection reads a clock, and a
 * projection that reads its own is untestable. `payers` is an input because
 * the memo has to span the whole payload, not one workspace.
 */
export async function workspaceSummary(
  ctx: DbCtx,
  args: {
    workspace: Doc<'workspaces'>
    role: WorkspaceRole
    now: number
    payers: PayerMemo
    extras?: { onboarding?: { starterAgents: readonly string[] } }
  },
): Promise<WorkspaceSummaryProjection> {
  const { workspace, role, now, extras } = args
  const payer = await payerOf(ctx, args.payers, workspace.billingUserId)
  return {
    id: workspace._id,
    slug: workspace.slug,
    name: workspace.name,
    status: workspace.status,
    servicingStatus: workspace.servicingStatus ?? 'active',
    // The deadline the wall counts down to. Absent only on rows that predate
    // the field, where the wall says no date rather than inventing one.
    ...(workspace.servicingStatusChangedAt === undefined
      ? {}
      : { servicingStatusChangedAt: workspace.servicingStatusChangedAt }),
    role,
    billingUserId: workspace.billingUserId,
    // Computed from THIS workspace's payer, never from the credential's user:
    // a member of a workspace someone else funds is entitled through them.
    funding: fundingOf(payer, now),
    creditRecovery: workspaceCreditRecovery(payer, workspace.servicingStatus ?? 'active', now),
    defaultTier: workspaceDefaultTierProjection(workspace, payer, now),
    // Onboarding state is a property of the workspace, never of the credential
    // looking at it: the product routes owners into setup while `onboardedAt`
    // is absent, so a credential that withholds it re-runs onboarding forever
    // on a workspace that finished it. Every payload reports it the same way.
    ...(workspace.duetName === undefined ? {} : { duetName: workspace.duetName }),
    ...(workspace.purpose === undefined ? {} : { purpose: workspace.purpose }),
    ...(workspace.onboardedAt === undefined ? {} : { onboardedAt: workspace.onboardedAt }),
    // The starter-agent suggestion is the one part a caller supplies: only the
    // browser session knows the campaign the user arrived from.
    ...(extras?.onboarding === undefined ? {} : { onboarding: extras.onboarding }),
    ...(workspace.adminMessage === undefined ? {} : { adminMessage: workspace.adminMessage }),
  }
}
