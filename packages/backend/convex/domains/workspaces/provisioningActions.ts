'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { ExeClient } from '@repo/exe'

import type { Id } from '../../_generated/dataModel'
import { action } from '../../_generated/server'
import { removeExeVm } from './vmTeardown'

type MutationRef = FunctionReference<'mutation'>
type QueryRef = FunctionReference<'query'>

export const decommissionUnservicedWorkspaces = action({
  args: {
    internalKey: v.string(),
    now: v.optional(v.number()),
    // See the candidates args: a caller that is not the cron scopes itself.
    workspaceId: v.optional(v.id('workspaces')),
    budgetMs: v.optional(v.number()),
    // A continuation finishes the rows its pass deferred and nothing else: a
    // row that became due since belongs to the next cron, and a row the chain
    // already attempted is never retried within it.
    workspaceIds: v.optional(v.array(v.id('workspaces'))),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const startedAt = Date.now()
    const budgetMs = args.budgetMs ?? SWEEP_BUDGET_MS
    const candidates = (await ctx.runQuery(
      fnQuery('domains/workspaces/provisioning:servicingDecommissionCandidates'),
      {
        internalKey: args.internalKey,
        now,
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.workspaceIds === undefined ? {} : { workspaceIds: args.workspaceIds }),
      },
    )) as Array<{
      workspaceId: Id<'workspaces'>
      vmName?: string
      httpsUrl?: string
      vmTokenNonce?: string
      status: 'active' | 'unhealthy'
      servicingStatus: 'paused' | 'banned'
      servicingStatusChangedAt: number
      dueAt: number
      archive: boolean
      targetStatus: 'archived' | 'retired'
    }>
    const retired: Array<Id<'workspaces'>> = []
    const archived: Array<Id<'workspaces'>> = []
    const failed: Array<{ workspaceId: Id<'workspaces'>; error: string }> = []
    const attempted: Array<Id<'workspaces'>> = []
    for (const workspace of candidates) {
      // The budget is checked between rows, never mid-row: a pass always makes
      // at least one attempt, and a row it starts it finishes.
      if (attempted.length > 0 && Date.now() - startedAt >= budgetMs) break
      attempted.push(workspace.workspaceId)
      try {
        const result = (await ctx.runMutation(
          fnMutation('domains/workspaces/lifecycle:requestServicing'),
          { internalKey: args.internalKey, workspaceId: workspace.workspaceId, now },
        )) as { status: string }
        if (result.status === 'archived' || result.status === 'retired') {
          if (workspace.targetStatus === 'archived') archived.push(workspace.workspaceId)
          else retired.push(workspace.workspaceId)
        }
      } catch (error) {
        // One workspace's retryable failure (unreachable VM or malformed row)
        // must not starve the candidates behind it; the next sweep retries it.
        const message = error instanceof Error ? error.message : String(error)
        console.error(`servicing decommission failed for ${workspace.workspaceId}: ${message}`)
        failed.push({ workspaceId: workspace.workspaceId, error: message })
      }
    }
    // What the budget left behind is not the next hour's problem: the chain
    // continues at once with exactly those rows.
    const deferred = candidates.slice(attempted.length).map(workspace => workspace.workspaceId)
    if (deferred.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        fnAction('domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces'),
        { ...args, workspaceIds: deferred },
      )
    }
    return { retired, archived, failed, deferred: deferred.length }
  },
})

/**
 * UNSCHEDULED since 2026-08-10 and unsafe to schedule as written: an exe.dev
 * `cp` leaves behind a *running* clone that phones home under the source VM's
 * vm-token, and nothing collects the copies on teardown. `crons.ts` carries the
 * full defect list and the rework this needs before it runs again.
 */
export const snapshotActiveWorkspaces = action({
  args: {
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const rows = (await ctx.runQuery(
      fnQuery('domains/workspaces/provisioning:activeWorkspacesForSnapshot'),
      {
        internalKey: args.internalKey,
      },
    )) as Array<{ workspaceId: Id<'workspaces'>; vmName: string; snapshotVmNames?: string[] }>
    const exeToken = process.env.EXE_TOKEN
    if (!exeToken) throw new Error('EXE_TOKEN is required')
    const client = new ExeClient({ token: exeToken })
    const copied: string[] = []
    const failed: Array<{ workspaceId: Id<'workspaces'>; error: string }> = []
    for (const workspace of rows) {
      try {
        const snapshotName = `${workspace.vmName}-snapshot-${now.toString(36)}`
        // exe.dev cp is crash-consistent for fsync'd writes only; non-fsynced writes can roll back.
        await client.copy(workspace.vmName, snapshotName, { copyTags: true })
        await ctx.runMutation(fnMutation('domains/workspaces/provisioning:recordSnapshot'), {
          internalKey: args.internalKey,
          workspaceId: workspace.workspaceId,
          snapshotVmName: snapshotName,
          now,
        })
        copied.push(snapshotName)
        for (const stale of workspace.snapshotVmNames?.slice(1) ?? []) {
          await removeExeVm(client, stale).catch(() => undefined)
        }
      } catch (error) {
        // One workspace's snapshot failure must not skip the rest of the
        // weekly pass; it keeps its previous snapshot until the next run.
        const message = error instanceof Error ? error.message : String(error)
        console.error(`snapshot failed for ${workspace.workspaceId}: ${message}`)
        failed.push({ workspaceId: workspace.workspaceId, error: message })
      }
    }
    return { copied, failed }
  },
})

function fnMutation(name: string): MutationRef {
  return makeFunctionReference(name) as MutationRef
}

function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}

function fnAction(name: string) {
  return makeFunctionReference<'action'>(name)
}

const SWEEP_BUDGET_MS = 4 * 60 * 1000
