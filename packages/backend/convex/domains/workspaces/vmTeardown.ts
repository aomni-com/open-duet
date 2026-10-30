'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { currentDayKey, vmUsageDayWindow } from '@repo/contract'
import { vmUsagePointsFromStat, type ExeClient, type VmUsagePoint } from '@repo/exe'

import type { Id } from '../../_generated/dataModel'
import { internalAction } from '../../_generated/server'
import { workspaceVmName } from './vmAttach'
import { workspaceVmExe } from './vmExe'

type MutationRef = FunctionReference<'mutation'>
type QueryRef = FunctionReference<'query'>

const DAY_MS = 24 * 60 * 60 * 1000

export type WorkspaceVmRemoveExe = Pick<ExeClient, 'list' | 'remove' | 'stat'>

export interface WorkspaceVmIdentity {
  vmName?: string
  vmTokenNonce?: string
}

interface TeardownCtx {
  runQuery(ref: QueryRef, args: Record<string, unknown>): Promise<unknown>
  runMutation(ref: MutationRef, args: Record<string, unknown>): Promise<unknown>
}

export const removeVmForWorkspace = internalAction({
  args: {
    workspaceId: v.id('workspaces'),
    expectedIdentity: v.optional(
      v.object({
        vmName: v.optional(v.string()),
        vmTokenNonce: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => await removeVmForWorkspaceImpl(ctx, args),
})

export async function removeVmForWorkspaceImpl(
  ctx: TeardownCtx,
  args: {
    workspaceId: Id<'workspaces'>
    expectedIdentity?: WorkspaceVmIdentity
    exe?: WorkspaceVmRemoveExe
    env?: NodeJS.ProcessEnv
    now?: number
  },
): Promise<{ removed: boolean; vmName?: string }> {
  const plan = (await ctx.runQuery(
    fnQuery('domains/workspaces/vmTeardownModel:workspaceVmTeardownPlan'),
    { workspaceId: args.workspaceId },
  )) as { vmName?: string; vmTokenNonce?: string; hasResidualVmState: boolean } | null
  if (plan === null || !plan.hasResidualVmState) {
    return { removed: false }
  }

  // New teardown runs carry the identity captured when they were scheduled.
  // The fallback keeps already-queued runs valid across deployment.
  const expectedIdentity = args.expectedIdentity ?? {
    vmName: plan.vmName,
    vmTokenNonce: plan.vmTokenNonce,
  }
  const identityWasSuperseded =
    args.expectedIdentity !== undefined &&
    ((plan.vmTokenNonce !== undefined && plan.vmTokenNonce !== expectedIdentity.vmTokenNonce) ||
      (plan.vmName !== undefined &&
        expectedIdentity.vmName !== undefined &&
        plan.vmName !== expectedIdentity.vmName))
  const env = args.env ?? process.env
  const exe = args.exe ?? workspaceVmExe(env)
  const providerVmNames = new Set((await exe.list()).map(vm => vm.vm_name))
  let vmName = identityWasSuperseded ? undefined : expectedIdentity.vmName
  if (
    !identityWasSuperseded &&
    vmName === undefined &&
    (args.expectedIdentity === undefined || expectedIdentity.vmTokenNonce !== undefined)
  ) {
    const deterministicName = workspaceVmName(args.workspaceId)
    if (providerVmNames.has(deterministicName)) vmName = deterministicName
  }
  let removedVmName: string | undefined
  if (vmName !== undefined && providerVmNames.has(vmName)) {
    await settleFinalVmComputeWindow(ctx, {
      workspaceId: args.workspaceId,
      vmName,
      exe,
      internalKey: env.DUET_API_INTERNAL_KEY ?? '',
      now: args.now ?? Date.now(),
    })
    await removeExeVm(exe, vmName)
    removedVmName = vmName
  }
  await ctx.runMutation(fnMutation('domains/workspaces/vmTeardownModel:clearWorkspaceVm'), {
    workspaceId: args.workspaceId,
    expectedVmName: expectedIdentity.vmName,
    expectedVmTokenNonce: expectedIdentity.vmTokenNonce,
  })
  return removedVmName === undefined ? { removed: false } : { removed: true, vmName: removedVmName }
}

export async function removeExeVm(exe: Pick<ExeClient, 'remove'>, vmName: string): Promise<void> {
  await exe.remove(vmName)
}

/**
 * Bill the day the VM dies in, before it dies.
 *
 * Order is the whole point, and two other orderings look reasonable:
 * `stat` after `exe.remove` returns nothing at all, and a charge after
 * `clearWorkspaceVm` no longer resolves the VM the ledger is meant to bill.
 *
 * Metering never holds removal hostage. A VM that survives its own teardown
 * keeps consuming the shared exe.dev pool, which costs more than an uncollected
 * partial fee — so every failure here logs and returns. Re-entry is harmless:
 * samples dedup on the provider timestamp and the fee dedups on its ledger
 * reference, so the action-retrier can run this block as often as it likes.
 *
 * This does NOT close create-and-destroy-within-a-day. A new VM emits no
 * metrics for roughly four to five minutes (measured in slice 00), so a
 * workspace destroyed inside that window has nothing to bill. Teardown narrows
 * the evasion to that window; it does not eliminate it.
 */
async function settleFinalVmComputeWindow(
  ctx: TeardownCtx,
  args: {
    workspaceId: Id<'workspaces'>
    vmName: string
    exe: Pick<ExeClient, 'stat'>
    internalKey: string
    now: number
  },
): Promise<void> {
  let points: VmUsagePoint[] = []
  try {
    points = vmUsagePointsFromStat(await args.exe.stat(args.vmName, '24h'))
    if (points.length > 0) {
      await ctx.runMutation(
        fnMutation('domains/workspaces/vmUsageModel:recordWorkspaceVmSamples'),
        {
          internalKey: args.internalKey,
          workspaceId: args.workspaceId,
          expectedVmName: args.vmName,
          points,
        },
      )
    }
  } catch (error) {
    // The final stat is a prefix, not a precondition: the charge below reads
    // stored rows, and the last fleet sweep is at most one interval old.
    console.error(
      `[vm-teardown-settlement] sampling ${args.vmName} for ${args.workspaceId} failed: ${String(error)}`,
    )
  }

  try {
    for (const dayKey of settlementDayKeys(points, args.now)) {
      await ctx.runMutation(
        fnMutation('domains/credits/vmComputeUsage:chargeWorkspaceVmComputeDay'),
        {
          internalKey: args.internalKey,
          workspaceId: args.workspaceId,
          dayKey,
          expectedVmName: args.vmName,
          now: args.now,
        },
      )
    }
  } catch (error) {
    console.error(
      `[vm-teardown-settlement] charging ${args.workspaceId} (${args.vmName}) failed: ${String(error)}`,
    )
  }
}

/**
 * At most two: today, plus yesterday when the final samples reach back into it.
 *
 * Yesterday matters for a teardown just after midnight, which lands before the
 * daily cron has closed that day — after which the VM is gone and no candidate
 * query will ever propose it again. Charging it twice is not a risk; both keys
 * are idempotent on their ledger reference.
 */
function settlementDayKeys(points: readonly VmUsagePoint[], now: number): string[] {
  const todayKey = currentDayKey(now)
  const reachesBack = points.some(point => point.at < vmUsageDayWindow(todayKey).startAt)
  return reachesBack ? [currentDayKey(now - DAY_MS), todayKey] : [todayKey]
}

function fnMutation(name: string): MutationRef {
  return makeFunctionReference(name) as MutationRef
}

function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}
