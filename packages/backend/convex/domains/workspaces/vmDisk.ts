'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import type { ExeClient } from '@repo/exe'

import type { Id } from '../../_generated/dataModel'
import { internalAction } from '../../_generated/server'
import { workspaceVmExe } from './vmExe'

type MutationRef = FunctionReference<'mutation'>
type QueryRef = FunctionReference<'query'>

interface WorkspaceVmResizePlan {
  desiredDiskGb: number
  vmDiskGb?: number
  vmName?: string
}

export type WorkspaceVmDiskExe = Pick<ExeClient, 'list' | 'resize' | 'restart'>

interface DiskCtx {
  runQuery(ref: QueryRef, args: Record<string, unknown>): Promise<unknown>
  runMutation(ref: MutationRef, args: Record<string, unknown>): Promise<unknown>
}

export const resizeWorkspaceVmDisk = internalAction({
  args: { workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => await resizeWorkspaceVmDiskImpl(ctx, args),
})

export async function resizeWorkspaceVmDiskImpl(
  ctx: DiskCtx,
  args: {
    workspaceId: Id<'workspaces'>
    exe?: WorkspaceVmDiskExe
    env?: NodeJS.ProcessEnv
    now?: number
  },
): Promise<{ resized: boolean; restarted: boolean; recorded: boolean }> {
  const plan = (await ctx.runQuery(
    fnQuery('domains/workspaces/vmDiskModel:workspaceVmResizePlan'),
    { workspaceId: args.workspaceId },
  )) as WorkspaceVmResizePlan | null
  if (
    plan === null ||
    plan.vmName === undefined ||
    plan.vmDiskGb === undefined ||
    plan.vmDiskGb >= plan.desiredDiskGb
  ) {
    return { resized: false, restarted: false, recorded: false }
  }

  const exe = args.exe ?? workspaceVmExe(args.env ?? process.env)
  const vm = (await exe.list()).find(candidate => candidate.vm_name === plan.vmName)
  if (vm === undefined) return { resized: false, restarted: false, recorded: false }
  if (vm.disk_capacity_bytes === undefined) {
    throw new Error(`VM lobby omitted disk capacity for ${plan.vmName}`)
  }

  const desiredBytes = plan.desiredDiskGb * 1024 ** 3
  let resized = false
  if (vm.disk_capacity_bytes < desiredBytes) {
    await exe.resize(plan.vmName, { disk: `${plan.desiredDiskGb}GB` })
    resized = true
  }
  const realizedDiskGb = resized
    ? plan.desiredDiskGb
    : Math.round(vm.disk_capacity_bytes / 1024 ** 3)
  try {
    await exe.restart(plan.vmName)
  } catch (error) {
    if (resized) {
      await recordResize(ctx, args.workspaceId, plan.vmName, plan.desiredDiskGb, args.now)
    }
    throw error
  }
  const recorded = await recordResize(ctx, args.workspaceId, plan.vmName, realizedDiskGb, args.now)
  return { resized, restarted: true, recorded }
}

async function recordResize(
  ctx: DiskCtx,
  workspaceId: Id<'workspaces'>,
  expectedVmName: string,
  diskGb: number,
  now = Date.now(),
): Promise<boolean> {
  const result = (await ctx.runMutation(
    fnMutation('domains/workspaces/vmDiskModel:recordWorkspaceVmResize'),
    { workspaceId, expectedVmName, diskGb, now },
  )) as { recorded: boolean }
  return result.recorded
}

function fnMutation(name: string): MutationRef {
  return makeFunctionReference(name) as MutationRef
}

function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}
