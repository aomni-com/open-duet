import { describe, expect, test } from 'bun:test'

import type { WorkspaceVmCaps } from '@repo/contract'
import type { ExeVm, ResizeVmOptions } from '@repo/exe'

import type { Id } from '../convex/_generated/dataModel'
import {
  reconcileWorkspaceVmSizesImpl,
  type WorkspaceVmSizeExe,
} from '../convex/domains/workspaces/vmSize'
import type { SizeCandidate } from '../convex/domains/workspaces/vmSizeModel'

// The sweep receives resource policy at its query boundary; fixed caps keep
// these provider behavior cases independent of changes to the plan catalog.
const standardCaps: WorkspaceVmCaps = { cpu: 4, memory: '8GB' }
const capCpu = standardCaps.cpu

function memoryBytes(caps: WorkspaceVmCaps): number {
  return Number(/^(\d+)GB$/.exec(caps.memory)![1]) * 1024 ** 3
}

const capMemoryBytes = memoryBytes(standardCaps)

function workspaceId(n: number): Id<'workspaces'> {
  return `workspace_${n}` as Id<'workspaces'>
}

describe('reconcileWorkspaceVmSizes', () => {
  test('applies each workspace tier resource floor in the same sweep', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-standard',
        cpu: 2,
        memoryGb: 8,
        vmCaps: { cpu: 4, memory: '8GB' },
      },
      {
        workspaceId: workspaceId(2),
        vmName: 'vm-large',
        cpu: 4,
        memoryGb: 8,
        vmCaps: { cpu: 8, memory: '16GB' },
      },
    ])

    await harness.run()

    expect(harness.calls).toEqual([
      { operation: 'resize', vmName: 'vm-standard', cpu: 4, memory: '8GB' },
      { operation: 'restart', vmName: 'vm-standard' },
      { operation: 'resize', vmName: 'vm-large', cpu: 8, memory: '16GB' },
      { operation: 'restart', vmName: 'vm-large' },
    ])
  })

  test('resizes and restarts a VM below the floor on either dimension', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-undersized',
        cpu: 1,
        memoryGb: 2,
      },
    ])

    const result = await harness.run()

    expect(harness.calls).toEqual([
      {
        operation: 'resize',
        vmName: 'vm-undersized',
        cpu: capCpu,
        memory: standardCaps.memory,
      },
      { operation: 'restart', vmName: 'vm-undersized' },
    ])
    expect(result).toEqual({
      checked: 1,
      resized: ['vm-undersized'],
      failed: [],
    })
    expect(harness.vms[0]!.allocated_cpus).toBe(capCpu)
    expect(harness.vms[0]!.memory_capacity_bytes).toBe(capMemoryBytes)
  })

  test('does nothing to a VM already at the floor', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-at-floor',
        cpu: standardCaps.cpu,
        memoryGb: Number(/^(\d+)GB$/.exec(standardCaps.memory)![1]),
      },
    ])

    const result = await harness.run()

    expect(harness.calls).toEqual([])
    expect(result).toEqual({ checked: 1, resized: [], failed: [] })
  })

  // Never shrinks: a bigger-than-floor VM (a different tier, or already
  // migrated by an earlier sweep) must be left exactly as it is.
  test('never shrinks a VM already bigger than the floor', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-oversized',
        cpu: 8,
        memoryGb: 16,
      },
    ])

    await harness.run()

    expect(harness.calls).toEqual([])
    expect(harness.vms[0]!.allocated_cpus).toBe(8)
  })

  // A new floor must reach already-large VMs as well as small ones.
  test('lifts an already large VM when its workspace resource floor increases', async () => {
    const maxCaps: WorkspaceVmCaps = { cpu: 10, memory: '24GB' }
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-upgraded-to-max',
        cpu: 8,
        memoryGb: 16,
        vmCaps: maxCaps,
      },
    ])

    const result = await harness.run()

    expect(harness.calls).toEqual([
      {
        operation: 'resize',
        vmName: 'vm-upgraded-to-max',
        cpu: maxCaps.cpu,
        memory: maxCaps.memory,
      },
      { operation: 'restart', vmName: 'vm-upgraded-to-max' },
    ])
    expect(result.resized).toEqual(['vm-upgraded-to-max'])
    expect(harness.vms[0]!.allocated_cpus).toBe(maxCaps.cpu)
    expect(harness.vms[0]!.memory_capacity_bytes).toBe(memoryBytes(maxCaps))
  })

  // A workspace record pointing at a VM the lobby has no knowledge of at all
  // is at least as reportable as one whose size fields are absent — either
  // the row is stale or the VM genuinely vanished, and silently treating it
  // as "nothing to do" would hide either case from an operator.
  test('reports a workspace whose recorded VM is entirely missing from the lobby as failed', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-undersized',
        cpu: 1,
        memoryGb: 2,
      },
    ])
    harness.vms.splice(0)

    const result = await harness.run()

    expect(harness.calls).toEqual([])
    expect(result.resized).toEqual([])
    expect(result.failed).toEqual([
      {
        vmName: 'vm-undersized',
        error: 'Error: lobby has no record of vm-undersized',
      },
    ])
  })

  // A resize that succeeds but whose restart fails is NOT safe to just leave
  // for next time: the lobby's own reported allocation can already show the
  // new size, so the next sweep would see "at or above floor" and never
  // revisit it — leaving the VM silently running on its old real resources
  // forever. A transient restart failure must not need a human to notice.
  test('retries a failed restart after a successful resize, and still resizes', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-flaky-restart',
        cpu: 1,
        memoryGb: 2,
      },
    ])
    harness.failRestartAttempts.set('vm-flaky-restart', 1)

    const result = await harness.run()

    expect(harness.calls.filter(call => call.operation === 'restart')).toHaveLength(2)
    expect(result).toEqual({
      checked: 1,
      resized: ['vm-flaky-restart'],
      failed: [],
    })
  })

  test('gives up and reports failed after restart keeps failing past the retry budget', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-dead-restart',
        cpu: 1,
        memoryGb: 2,
      },
    ])
    harness.failRestartAttempts.set('vm-dead-restart', Number.POSITIVE_INFINITY)

    const result = await harness.run()

    expect(result.resized).toEqual([])
    expect(result.failed).toEqual([
      { vmName: 'vm-dead-restart', error: 'Error: simulated restart failure' },
    ])
  })

  // The lobby omitting a size reading is an anomaly to report, not a green
  // light to resize on a guess and not a silent skip either — both would hide
  // the same fleet drift this cron exists to catch.
  test('reports a VM the lobby returns with no allocated size as failed, not skipped or resized', async () => {
    const harness = new SizeHarness([
      {
        workspaceId: workspaceId(1),
        vmName: 'vm-unknown',
        cpu: undefined,
        memoryGb: undefined,
      },
    ])

    const result = await harness.run()

    expect(harness.calls).toEqual([])
    expect(result.resized).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.vmName).toBe('vm-unknown')
    expect(result.failed[0]!.error).toContain('lobby omitted allocated size')
  })

  // Same shape of bug this repo shipped once already this week in the runner
  // input drain: a failure for one candidate must not stop the sweep from
  // reaching the ones behind it.
  test('a resize failure for one VM does not block the sweep from the rest', async () => {
    const harness = new SizeHarness([
      { workspaceId: workspaceId(1), vmName: 'vm-wedged', cpu: 1, memoryGb: 2 },
      {
        workspaceId: workspaceId(2),
        vmName: 'vm-healthy',
        cpu: 1,
        memoryGb: 2,
      },
    ])
    harness.failResizeFor.add('vm-wedged')

    const result = await harness.run()

    // vm-wedged never reaches the push: the fake throws before recording the
    // call, matching a real dispatch that fails before doing anything.
    expect(harness.calls.map(call => call.vmName)).toEqual(['vm-healthy', 'vm-healthy'])
    expect(result.checked).toBe(2)
    expect(result.resized).toEqual(['vm-healthy'])
    expect(result.failed).toEqual([
      { vmName: 'vm-wedged', error: 'Error: simulated resize failure' },
    ])
    // The healthy one still actually landed the resize, not just "was tried".
    expect(harness.vms.find(vm => vm.vm_name === 'vm-healthy')!.allocated_cpus).toBe(capCpu)
  })
})

interface FakeVmSpec {
  workspaceId: Id<'workspaces'>
  vmName: string
  cpu: number | undefined
  memoryGb: number | undefined
  vmCaps?: WorkspaceVmCaps
}

class SizeHarness {
  readonly calls: Array<
    | { operation: 'resize'; vmName: string; cpu?: number; memory?: string }
    | { operation: 'restart'; vmName: string }
  > = []
  readonly vms: ExeVm[]
  readonly failResizeFor = new Set<string>()
  readonly failRestartAttempts = new Map<string, number>()
  private readonly candidates: SizeCandidate[]

  constructor(specs: FakeVmSpec[]) {
    this.candidates = specs.map(spec => ({
      workspaceId: spec.workspaceId,
      vmName: spec.vmName,
      vmCaps: spec.vmCaps ?? standardCaps,
    }))
    this.vms = specs.map(spec => ({
      vm_name: spec.vmName,
      ssh_dest: `exedev@${spec.vmName}.exe.xyz`,
      allocated_cpus: spec.cpu,
      memory_capacity_bytes: spec.memoryGb === undefined ? undefined : spec.memoryGb * 1024 ** 3,
    }))
  }

  readonly exe: WorkspaceVmSizeExe = {
    list: async () => [...this.vms],
    resize: async (vmName: string, options: ResizeVmOptions) => {
      if (this.failResizeFor.has(vmName)) throw new Error('simulated resize failure')
      this.calls.push({
        operation: 'resize',
        vmName,
        cpu: options.cpu,
        memory: options.memory,
      })
      const vm = this.vms.find(candidate => candidate.vm_name === vmName)
      if (vm === undefined) throw new Error('VM not found')
      if (options.cpu !== undefined) vm.allocated_cpus = options.cpu
      if (options.memory !== undefined) {
        vm.memory_capacity_bytes = Number(/^(\d+)GB$/.exec(options.memory)![1]) * 1024 ** 3
      }
      return {}
    },
    restart: async vmName => {
      this.calls.push({ operation: 'restart', vmName })
      const remaining = this.failRestartAttempts.get(vmName) ?? 0
      if (remaining > 0) {
        this.failRestartAttempts.set(vmName, remaining - 1)
        throw new Error('simulated restart failure')
      }
    },
  }

  readonly ctx = {
    runQuery: async () => this.candidates,
    runMutation: async () => undefined,
  }

  async run() {
    return await reconcileWorkspaceVmSizesImpl(this.ctx, {
      internalKey: 'internal',
      exe: this.exe,
    })
  }
}
