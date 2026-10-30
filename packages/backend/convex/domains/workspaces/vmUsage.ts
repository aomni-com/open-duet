'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { currentDayKey } from '@repo/contract'
import { vmUsagePointsFromStat, type ExeClient, type VmUsagePoint } from '@repo/exe'

import { internalAction } from '../../_generated/server'
import { workspaceVmExe } from './vmExe'
import type { VmUsageCandidate } from './vmUsageModel'

export type WorkspaceVmStatExe = Pick<ExeClient, 'stat'>

/**
 * How many `stat` calls are in flight at once.
 *
 * Measured, not guessed: a single call costs p50 3.4s and p95 5.5s against the
 * live fleet. Serially, 500 VMs is ~28 minutes — well past what one Convex
 * action survives, and the failure arrives as a partially-sampled day rather
 * than an error. At 8 concurrent the same fleet finishes in ~3.5 minutes.
 *
 * Kept modest on purpose: this is a shared production account and the rate
 * ceiling is unmeasured above this level.
 */
const STAT_CONCURRENCY = 8

interface VmUsageSweepCtx {
  runQuery(ref: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>
  runMutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>
}

export interface VmUsageSweepResult {
  sampled: number
  inserted: number
  failed: Array<{ vmName: string; error: string }>
  cursor?: string
}

export const sweepWorkspaceVmTelemetry = internalAction({
  args: {
    internalKey: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await sweepWorkspaceVmTelemetryImpl(ctx, args)
    // Chain rather than loop: each page is its own action with its own time
    // budget, so a large fleet cannot run one action past what Convex allows.
    // Re-running a page is harmless -- samples dedup on the provider timestamp.
    if (result.cursor !== undefined) {
      await ctx.scheduler.runAfter(
        0,
        fnAction('domains/workspaces/vmUsage:sweepWorkspaceVmTelemetry'),
        {
          internalKey: args.internalKey,
          cursor: result.cursor,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
      )
    }
    return result
  },
})

/**
 * Pull provider metrics for one page of workspaces and store them.
 *
 * The fleet's only sampler — teardown stats the one VM it is about to delete
 * (`vmTeardown.ts`), and nothing else stats at all. This knows nothing about
 * money: a revoked token or a rate limit produces missing samples, never a
 * partially-billed day. The charge reads stored rows, separately.
 */
export async function sweepWorkspaceVmTelemetryImpl(
  ctx: VmUsageSweepCtx,
  args: {
    internalKey: string
    cursor?: string
    limit?: number
    exe?: WorkspaceVmStatExe
    env?: NodeJS.ProcessEnv
  },
): Promise<VmUsageSweepResult> {
  const page = (await ctx.runQuery(
    fnQuery('domains/workspaces/vmUsageModel:workspaceVmUsageCandidates'),
    {
      internalKey: args.internalKey,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    },
  )) as { candidates: VmUsageCandidate[]; cursor?: string }

  const exe = args.exe ?? workspaceVmExe(args.env ?? process.env)
  const failed: VmUsageSweepResult['failed'] = []
  let sampled = 0
  let inserted = 0

  // One VM's failure must never stop the sweep reaching the rest: a single
  // wedged VM would otherwise become a permanent block on every workspace
  // behind it in the page.
  await mapWithConcurrency(page.candidates, STAT_CONCURRENCY, async candidate => {
    try {
      const points = vmUsagePointsFromStat(await exe.stat(candidate.vmName, '24h'))
      if (points.length === 0) return
      const result = (await ctx.runMutation(
        fnMutation('domains/workspaces/vmUsageModel:recordWorkspaceVmSamples'),
        {
          internalKey: args.internalKey,
          workspaceId: candidate.workspaceId,
          expectedVmName: candidate.vmName,
          points: points satisfies VmUsagePoint[],
        },
      )) as { inserted: number }
      sampled += 1
      inserted += result.inserted
    } catch (error) {
      console.error(`[vm-usage-sweep] stat failed for ${candidate.vmName}: ${String(error)}`)
      failed.push({ vmName: candidate.vmName, error: String(error) })
    }
  })

  return {
    sampled,
    inserted,
    failed,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  }
}

/** Bounded fan-out. Workers pull from a shared index so a slow VM cannot stall a lane. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

function fnAction(name: string): FunctionReference<'action'> {
  return makeFunctionReference(name) as FunctionReference<'action'>
}

function fnQuery(name: string): FunctionReference<'query'> {
  return makeFunctionReference(name) as FunctionReference<'query'>
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}

export interface VmComputeChargeSweepResult {
  charged: number
  skipped: number
  microUsd: number
  failed: Array<{ workspaceId: string; error: string }>
  cursor?: string
}

export const chargeWorkspaceVmCompute = internalAction({
  args: {
    internalKey: v.string(),
    dayKey: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await chargeWorkspaceVmComputeImpl(ctx, args)
    if (result.cursor !== undefined) {
      await ctx.scheduler.runAfter(
        0,
        fnAction('domains/workspaces/vmUsage:chargeWorkspaceVmCompute'),
        {
          internalKey: args.internalKey,
          cursor: result.cursor,
          ...(args.dayKey === undefined ? {} : { dayKey: args.dayKey }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.now === undefined ? {} : { now: args.now }),
        },
      )
    }
    return result
  },
})

/**
 * Bill one page of workspaces for a COMPLETED day.
 *
 * Needs no exe client at all: it reads stored samples. That separation is the
 * point — a revoked provider token or a rate limit shows up as missing samples
 * upstream, never as a half-billed day here.
 */
export async function chargeWorkspaceVmComputeImpl(
  ctx: VmUsageSweepCtx,
  args: { internalKey: string; dayKey?: string; cursor?: string; limit?: number; now?: number },
): Promise<VmComputeChargeSweepResult> {
  const now = args.now ?? Date.now()
  // Yesterday by default: a day is only billable once it is closed.
  const dayKey = args.dayKey ?? currentDayKey(now - 24 * 60 * 60 * 1000)

  const page = (await ctx.runQuery(
    fnQuery('domains/workspaces/vmUsageModel:workspaceVmUsageCandidates'),
    {
      internalKey: args.internalKey,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    },
  )) as { candidates: VmUsageCandidate[]; cursor?: string }

  const failed: VmComputeChargeSweepResult['failed'] = []
  let charged = 0
  let skipped = 0
  let microUsd = 0

  for (const candidate of page.candidates) {
    try {
      const result = (await ctx.runMutation(
        fnMutation('domains/credits/vmComputeUsage:chargeWorkspaceVmComputeDay'),
        {
          internalKey: args.internalKey,
          workspaceId: candidate.workspaceId,
          dayKey,
          expectedVmName: candidate.vmName,
          now,
        },
      )) as { status: string; amountMicroUsd?: number }
      if (result.status === 'applied') {
        charged += 1
        microUsd += result.amountMicroUsd ?? 0
      } else {
        skipped += 1
      }
    } catch (error) {
      console.error(`[vm-compute-charge] failed for ${candidate.workspaceId}: ${String(error)}`)
      failed.push({ workspaceId: candidate.workspaceId, error: String(error) })
    }
  }

  return {
    charged,
    skipped,
    microUsd,
    failed,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  }
}
