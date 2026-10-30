import { describe, expect, test } from 'bun:test'

import type { ExeVm, ResizeVmOptions } from '@repo/exe'

import type { Id } from '../convex/_generated/dataModel'
import {
  resizeWorkspaceVmDiskImpl,
  type WorkspaceVmDiskExe,
} from '../convex/domains/workspaces/vmDisk'
import { scheduleWorkspaceVmResize } from '../convex/domains/workspaces/vmDiskSchedule'
import { workspaceVmExe } from '../convex/domains/workspaces/vmExe'

const WORKSPACE_ID = 'jh76k7c1g8y5et2ez9q8m3v7ac' as Id<'workspaces'>
const VM_NAME = 'duet-ws-disk-test'

describe('resizeWorkspaceVmDisk', () => {
  test('grows 28GB to 58GB, restarts in order, and records the realized size', async () => {
    const harness = new DiskHarness({ rowDiskGb: 28, desiredDiskGb: 58, lobbyDiskGb: 28 })

    await harness.resize()

    expect(harness.calls).toEqual([
      { operation: 'resize', vmName: VM_NAME, disk: '58GB' },
      { operation: 'restart', vmName: VM_NAME },
    ])
    expect(harness.rowDiskGb).toBe(58)
  })

  test('does not call exe when the recorded disk already equals the desired size', async () => {
    const harness = new DiskHarness({ rowDiskGb: 58, desiredDiskGb: 58, lobbyDiskGb: 58 })

    await harness.resize()

    expect(harness.calls).toEqual([])
    expect(harness.rowDiskGb).toBe(58)
  })

  test('does not shrink or restart a disk larger than the desired size', async () => {
    const harness = new DiskHarness({ rowDiskGb: 108, desiredDiskGb: 58, lobbyDiskGb: 108 })

    await harness.resize()

    expect(harness.calls).toEqual([])
    expect(harness.rowDiskGb).toBe(108)
  })

  test('does nothing when the recorded VM is missing from the lobby', async () => {
    const harness = new DiskHarness({ rowDiskGb: 28, desiredDiskGb: 58, lobbyDiskGb: 28 })
    harness.vms.splice(0)

    await harness.resize()

    expect(harness.calls).toEqual([])
    expect(harness.rowDiskGb).toBe(28)
  })

  test('after a crash following resize, the next run skips resize but restarts and records', async () => {
    const harness = new DiskHarness({ rowDiskGb: 28, desiredDiskGb: 58, lobbyDiskGb: 28 })
    harness.failResizeAfterApplying = true

    await expect(harness.resize()).rejects.toThrow('simulated crash after resize')
    expect(harness.rowDiskGb).toBe(28)
    await harness.resize()

    expect(harness.calls).toEqual([
      { operation: 'resize', vmName: VM_NAME, disk: '58GB' },
      { operation: 'restart', vmName: VM_NAME },
    ])
    expect(harness.rowDiskGb).toBe(58)
  })

  test('records the larger disk even when restart throws after resize', async () => {
    const harness = new DiskHarness({ rowDiskGb: 28, desiredDiskGb: 58, lobbyDiskGb: 28 })
    harness.failRestart = true

    await expect(harness.resize()).rejects.toThrow('simulated restart failure')

    expect(harness.calls).toEqual([
      { operation: 'resize', vmName: VM_NAME, disk: '58GB' },
      { operation: 'restart', vmName: VM_NAME },
    ])
    expect(harness.rowDiskGb).toBe(58)
  })

  test('records the realized lobby capacity when it already exceeds the desired size', async () => {
    const harness = new DiskHarness({ rowDiskGb: 28, desiredDiskGb: 58, lobbyDiskGb: 108 })

    await harness.resize()

    expect(harness.calls).toEqual([{ operation: 'restart', vmName: VM_NAME }])
    expect(harness.rowDiskGb).toBe(108)
  })

  test('a live resize run is single-flight and schedules nothing', async () => {
    const runId = 'resize-run-live' as Awaited<ReturnType<typeof scheduleWorkspaceVmResize>>
    let patchCalls = 0
    const ctx = {
      db: {
        get: async () => ({ _id: WORKSPACE_ID, vmResizeRunId: runId }),
        patch: async () => {
          patchCalls += 1
        },
      },
    }

    expect(
      await scheduleWorkspaceVmResize(
        ctx as unknown as Parameters<typeof scheduleWorkspaceVmResize>[0],
        WORKSPACE_ID,
      ),
    ).toBe(runId)
    expect(patchCalls).toBe(0)
  })

  test('the fake exe rejects an equal-size resize with a recognizable 422', async () => {
    const exe = workspaceVmExe({
      DUET_TEST_FAKE_EXE: '1',
      DUET_TEST_AUTH_EMAIL: '1',
      // Reading the test-auth flag now asserts the deployment is local, and a
      // synthetic env that cannot say where it lives fails closed. Real
      // fixtures get this from the local backend they boot.
      CONVEX_CLOUD_URL: 'http://127.0.0.1:51852',
    })
    const vmName = `disk-strict-grow-${crypto.randomUUID()}`
    await exe.create({ name: vmName, disk: '28GB' })
    try {
      await expect(exe.resize(vmName, { disk: '28GB' })).rejects.toThrow('422')
    } finally {
      await exe.remove(vmName)
    }
  })
})

class DiskHarness {
  readonly calls: Array<
    | { operation: 'resize'; vmName: string; disk: string | undefined }
    | { operation: 'restart'; vmName: string }
  > = []
  readonly desiredDiskGb: number
  readonly vms: ExeVm[]
  rowDiskGb: number
  failResizeAfterApplying = false
  failRestart = false

  readonly exe: WorkspaceVmDiskExe = {
    list: async () => [...this.vms],
    resize: async (vmName: string, options: ResizeVmOptions) => {
      this.calls.push({ operation: 'resize', vmName, disk: options.disk })
      const vm = this.vms.find(candidate => candidate.vm_name === vmName)
      if (vm === undefined) throw new Error('VM not found')
      vm.disk_capacity_bytes = Number(options.disk?.replace('GB', '')) * 1024 ** 3
      if (this.failResizeAfterApplying) {
        this.failResizeAfterApplying = false
        throw new Error('simulated crash after resize')
      }
      return {}
    },
    restart: async vmName => {
      this.calls.push({ operation: 'restart', vmName })
      if (this.failRestart) throw new Error('simulated restart failure')
    },
  }

  readonly ctx = {
    runQuery: async () => ({
      vmName: VM_NAME,
      vmDiskGb: this.rowDiskGb,
      desiredDiskGb: this.desiredDiskGb,
    }),
    runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.expectedVmName === VM_NAME && typeof args.diskGb === 'number') {
        this.rowDiskGb = args.diskGb
        return { recorded: true }
      }
      return { recorded: false }
    },
  }

  constructor(seed: { rowDiskGb: number; desiredDiskGb: number; lobbyDiskGb: number }) {
    this.rowDiskGb = seed.rowDiskGb
    this.desiredDiskGb = seed.desiredDiskGb
    this.vms = [
      {
        vm_name: VM_NAME,
        ssh_dest: `exedev@${VM_NAME}.exe.xyz`,
        status: 'running',
        disk_capacity_bytes: seed.lobbyDiskGb * 1024 ** 3,
      },
    ]
  }

  async resize(): Promise<void> {
    await resizeWorkspaceVmDiskImpl(this.ctx, {
      workspaceId: WORKSPACE_ID,
      exe: this.exe,
      now: 10_000,
    })
  }
}
