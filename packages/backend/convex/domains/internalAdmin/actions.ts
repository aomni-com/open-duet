import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { action } from '../../_generated/server'
import { adminRefusal, provenance } from './model'

const recordAudit = makeFunctionReference<'mutation'>('domains/internalAdmin/model:recordAudit')
const finalizeEffect = makeFunctionReference<'mutation'>(
  'domains/internalAdmin/model:finalizeEffect',
)
const freeCreditResetTargets = makeFunctionReference<'query'>(
  'domains/internalAdmin/model:freeCreditResetTargets',
)
const resetFreeCreditsForUser = makeFunctionReference<'mutation'>(
  'domains/internalAdmin/model:resetFreeCreditsForUser',
)

/**
 * Operator reset of every unpaid payer's free balance: an enumeration query,
 * then one mutation per payer reading only that payer's rows (the admin model
 * explains why a fleet-wide transaction cannot commit). The legs are not atomic
 * together, so the audit row opens as `started` before the first debit and
 * `finalizeEffect` closes it with the total: a reset that dies midway leaves a
 * `failed` row naming how far it got. A re-run finds finished payers at zero.
 */
export const resetFreeCredits = action({
  args: { ...provenance, confirmation: v.string() },
  handler: async (ctx, args) => {
    const { confirmation, ...access } = args
    if (confirmation !== 'RESET FREE CREDITS') throw adminRefusal('confirmation_mismatch')
    const { auditId } = (await ctx.runMutation(recordAudit, {
      ...access,
      action: 'admin.credits.reset',
      target: 'unpaid-users',
      status: 'started',
    })) as { auditId: Id<'adminAuditEvents'> }
    let targets: Id<'users'>[]
    try {
      targets = (await ctx.runQuery(freeCreditResetTargets, {
        internalKey: access.internalKey,
        actorId: access.actorId,
      })) as Id<'users'>[]
    } catch (error) {
      // Enumeration failing is batch-wide (nothing was debited), so it aborts.
      await ctx.runMutation(finalizeEffect, {
        ...access,
        auditId,
        success: false,
        detail: `removed=0 ${describe(error)}`,
      })
      throw error
    }
    // A leg failing is that payer's problem alone. Enumeration order is stable
    // and a failed payer keeps its balance, so aborting here would make one
    // payer with inconsistent billing data block every payer behind it on
    // every re-run. Record it, keep going, and report the pass as failed.
    let removed = 0
    const failed: string[] = []
    for (const userId of targets) {
      try {
        const leg = (await ctx.runMutation(resetFreeCreditsForUser, { ...access, userId })) as {
          removedMicroUsd: number
        }
        removed += leg.removedMicroUsd
      } catch (error) {
        failed.push(`${userId}: ${describe(error)}`)
      }
    }
    const detail =
      failed.length === 0
        ? `removed=${removed}`
        : `removed=${removed} failed=${failed.length} ${failed.join('; ')}`
    await ctx.runMutation(finalizeEffect, {
      ...access,
      auditId,
      success: failed.length === 0,
      detail,
    })
    if (failed.length > 0) throw new Error(`Free-credit reset: ${detail}`)
    return { ok: true as const, auditId, message: `Removed ${removed} micro-USD` }
  },
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
