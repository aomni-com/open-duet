'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import type { ExeClient, ExeVm } from '@repo/exe'

import { internalAction } from '../../_generated/server'
import { workspaceVmExe } from './vmExe'
import type { SizeCandidate } from './vmSizeModel'

export type WorkspaceVmSizeExe = Pick<ExeClient, 'list' | 'resize' | 'restart'>

export const reconcileWorkspaceVmSizes = internalAction({
  args: { internalKey: v.string(), now: v.optional(v.number()) },
  handler: (ctx, args) => reconcileWorkspaceVmSizesImpl(ctx, args),
})

interface SizeSweepCtx {
  runQuery(ref: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>
  runMutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>
}

export async function reconcileWorkspaceVmSizesImpl(
  ctx: SizeSweepCtx,
  args: { internalKey: string; exe?: WorkspaceVmSizeExe; env?: NodeJS.ProcessEnv; now?: number },
): Promise<{
  checked: number
  resized: string[]
  failed: Array<{ vmName: string; error: string }>
}> {
  const now = args.now ?? Date.now()
  const candidates = (await ctx.runQuery(
    fnQuery('domains/workspaces/vmSizeModel:workspaceVmSizeCandidates'),
    {
      internalKey: args.internalKey,
      now,
    },
  )) as SizeCandidate[]
  if (candidates.length === 0) return { checked: 0, resized: [], failed: [] }

  const exe = args.exe ?? workspaceVmExe(args.env ?? process.env)
  const live = await exe.list()
  const byName = new Map(live.map(vm => [vm.vm_name, vm]))
  const resized: string[] = []
  const failed: Array<{ vmName: string; error: string }> = []
  // One VM per iteration, isolated: a resize that fails for one workspace must
  // never stop the sweep from reaching the rest, or a single wedged VM becomes
  // a permanent block on every workspace behind it in the candidate list — the
  // exact shape of bug this repo shipped once already this week in the runner
  // input drain.
  for (const candidate of candidates) {
    try {
      const vm = byName.get(candidate.vmName)
      if (vm === undefined) {
        // An active workspace whose VM the lobby doesn't know about at all is
        // at least as reportable as one whose size fields are absent — either
        // the workspace row is stale or the VM genuinely vanished, and silently
        // treating it as "nothing to do" was inconsistent with that case.
        throw new Error(`lobby has no record of ${candidate.vmName}`)
      }
      const desiredMemoryBytes = gbStringToBytes(candidate.vmCaps.memory)
      const floor = sizeFloorCheck(vm, candidate.vmCaps.cpu, desiredMemoryBytes)
      if (floor === 'unknown') {
        throw new Error(`lobby omitted allocated size for ${candidate.vmName}`)
      }
      if (floor === 'at-or-above-floor') continue
      await exe.resize(candidate.vmName, {
        cpu: candidate.vmCaps.cpu,
        memory: candidate.vmCaps.memory,
      })
      // The provider requires a restart for a resize to take effect (the same
      // contract the disk-resize path already depends on), so this
      // interrupts any turn running on the VM at the moment it fires.
      //
      // The lobby's OWN reported allocation can update the moment resize
      // succeeds, before the guest ever reboots to actually use it — so a
      // restart that fails here is not safe to just retry next tick: the next
      // sweep would read the lobby, see the size already at the floor, and
      // skip it forever, leaving the VM silently running on its OLD real
      // resources. Retry inline a bounded number of times before giving up.
      await withRestartRetries(() => exe.restart(candidate.vmName), candidate.vmName)
      resized.push(candidate.vmName)
      await ctx.runMutation(
        fnMutation('domains/workspaces/vmSizeModel:recordWorkspaceVmSizeResize'),
        {
          workspaceId: candidate.workspaceId,
          vmName: candidate.vmName,
          cpu: candidate.vmCaps.cpu,
          memory: candidate.vmCaps.memory,
          now,
        },
      )
    } catch (error) {
      console.error(`[vm-size-sweep] resize failed for ${candidate.vmName}: ${String(error)}`)
      failed.push({ vmName: candidate.vmName, error: String(error) })
    }
  }
  return { checked: candidates.length, resized, failed }
}

const RESTART_RETRY_ATTEMPTS = 2

async function withRestartRetries(restart: () => Promise<unknown>, vmName: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await restart()
      return
    } catch (error) {
      if (attempt >= RESTART_RETRY_ATTEMPTS) throw error
      console.error(
        `[vm-size-sweep] restart attempt ${attempt + 1} failed for ${vmName}, retrying: ${String(error)}`,
      )
    }
  }
}

// Never shrinks: a VM already at or above the floor (bigger, or already
// migrated) is left alone. A missing field is its own outcome, distinct from
// both — it is a lobby anomaly to surface, never silently treated as "fine".
function sizeFloorCheck(
  vm: ExeVm,
  desiredCpu: number,
  desiredMemoryBytes: number,
): 'unknown' | 'at-or-above-floor' | 'needs-resize' {
  if (vm.allocated_cpus === undefined || vm.memory_capacity_bytes === undefined) return 'unknown'
  return vm.allocated_cpus >= desiredCpu && vm.memory_capacity_bytes >= desiredMemoryBytes
    ? 'at-or-above-floor'
    : 'needs-resize'
}

function gbStringToBytes(value: string): number {
  const match = /^(\d+)GB$/.exec(value)
  if (match === null) throw new Error(`Expected a whole-GB size, received ${value}`)
  return Number(match[1]) * 1024 ** 3
}

function fnQuery(name: string): FunctionReference<'query'> {
  return makeFunctionReference(name) as FunctionReference<'query'>
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}
