'use node'

import { ExeClient, type ExeVm } from '@repo/exe'

import { testAuthEmailEnabled, useSshTransport } from '../../config'

export type WorkspaceVmExe = Pick<
  ExeClient,
  'create' | 'list' | 'remove' | 'resize' | 'restart' | 'setSharePublic' | 'stat'
>

export function workspaceVmExe(env: NodeJS.ProcessEnv): WorkspaceVmExe {
  const fake = testWorkspaceVmExe(env)
  if (fake !== null) return fake
  const useSshCreate = useSshTransport(env)
  const exeToken = env.EXE_TOKEN
  if (!useSshCreate && !exeToken) throw new Error('EXE_TOKEN is required')
  return new ExeClient({ token: useSshCreate ? undefined : exeToken })
}

export function workspaceVmApiExe(env: NodeJS.ProcessEnv): WorkspaceVmExe {
  const fake = testWorkspaceVmExe(env)
  if (fake !== null) return fake
  const exeToken = env.EXE_TOKEN
  if (!exeToken) throw new Error('EXE_TOKEN is required')
  return new ExeClient({ token: exeToken })
}

function testWorkspaceVmExe(env: NodeJS.ProcessEnv): WorkspaceVmExe | null {
  if (env.DUET_TEST_FAKE_EXE !== '1' && env.DUET_TEST_FAKE_EXE !== 'always-fail') return null
  if (!testAuthEmailEnabled(env)) {
    throw new Error('DUET_TEST_FAKE_EXE requires the test auth environment')
  }
  return env.DUET_TEST_FAKE_EXE === 'always-fail' ? alwaysFailingTestExe : testExe
}

/** Fixed so a test can assert an exact fee. One tenth of a core, half a GiB. */
export const TEST_EXE_CPU_CORES = 0.1
export const TEST_EXE_MEM_USED_BYTES = 0.5 * 1024 ** 3
export const TEST_EXE_FS_USED_GB = 7.5

const testVms = new Map<string, ExeVm>()
const testExe: WorkspaceVmExe = {
  list: async () => [...testVms.values()],
  create: async (options = {}) => {
    if (options.name === undefined) throw new Error('Test exe requires a VM name')
    const vm = {
      vm_name: options.name,
      ssh_dest: `exedev@${options.name}.exe.xyz`,
      https_url: `https://${options.name}.exe.xyz`,
      status: 'running',
      disk_capacity_bytes: diskCapacityBytes(options.disk),
      allocated_cpus: options.cpu,
      memory_capacity_bytes: memoryCapacityBytes(options.memory),
    }
    testVms.set(vm.vm_name, vm)
    return vm
  },
  remove: async vmName => {
    testVms.delete(vmName)
  },
  /* Deterministic metrics so an integration test can assert an exact fee rather
     than a range. Ten-minute cadence matching the real provider, ending at a
     stable epoch multiple so the points do not drift between runs. `cpu_cores`
     is an interval AVERAGE upstream (measured in slice 00), which is what makes
     step integration correct -- the fake must not model it as instantaneous. */
  stat: async (vmName, range = '24h') => {
    const vm = testVms.get(vmName)
    if (vm === undefined) throw new Error(`Test exe VM not found: ${vmName}`)
    const cadenceMs = 10 * 60 * 1000
    const spanMs = range === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
    const end = Math.floor(Date.now() / cadenceMs) * cadenceMs
    const points = []
    for (let at = end - spanMs + cadenceMs; at <= end; at += cadenceMs) {
      points.push({
        timestamp: new Date(at).toISOString(),
        cpu_cores: TEST_EXE_CPU_CORES,
        cpu_nominal: vm.allocated_cpus ?? 4,
        mem_used_bytes: TEST_EXE_MEM_USED_BYTES,
        mem_total_bytes: vm.memory_capacity_bytes ?? 8 * 1024 ** 3,
        fs_used_gb: TEST_EXE_FS_USED_GB,
        fs_total_gb: (vm.disk_capacity_bytes ?? 30 * 1024 ** 3) / 1024 ** 3,
      })
    }
    return { vm_name: vmName, points }
  },
  resize: async (vmName, options) => {
    const vm = testVms.get(vmName)
    if (vm === undefined) throw new Error(`Test exe VM not found: ${vmName}`)
    // cpu/memory apply independently of disk: a cap-floor resize never
    // touches disk, and a disk grow (the only other caller) never sets these.
    if (options.cpu !== undefined) vm.allocated_cpus = options.cpu
    const desiredMemoryBytes = memoryCapacityBytes(options.memory)
    if (desiredMemoryBytes !== undefined) vm.memory_capacity_bytes = desiredMemoryBytes
    if (options.disk === undefined) return {}
    const desiredBytes = diskCapacityBytes(options.disk)
    if (desiredBytes === undefined) throw new Error('Test exe resize requires a disk')
    const currentBytes = vm.disk_capacity_bytes ?? 0
    if (desiredBytes <= currentBytes) {
      throw new Error(
        `exe resize 422: desired disk must be larger than current (${desiredBytes} <= ${currentBytes})`,
      )
    }
    vm.disk_capacity_bytes = desiredBytes
    return {}
  },
  restart: async () => {},
  setSharePublic: async () => {},
}

function diskCapacityBytes(disk: string | undefined): number | undefined {
  if (disk === undefined) return undefined
  const match = /^(\d+)GB$/.exec(disk)
  if (match === null) throw new Error(`Test exe requires disk in GB, received ${disk}`)
  return Number(match[1]) * 1024 ** 3
}

function memoryCapacityBytes(memory: string | undefined): number | undefined {
  if (memory === undefined) return undefined
  const match = /^(\d+)GB$/.exec(memory)
  if (match === null) throw new Error(`Test exe requires memory in GB, received ${memory}`)
  return Number(match[1]) * 1024 ** 3
}

const alwaysFailingTestExe: WorkspaceVmExe = {
  list: async () => {
    throw new Error('always-failing fake exe')
  },
  create: async () => {
    throw new Error('always-failing fake exe')
  },
  remove: async () => {
    throw new Error('always-failing fake exe')
  },
  resize: async () => {
    throw new Error('always-failing fake exe')
  },
  stat: async () => {
    throw new Error('always-failing fake exe')
  },
  restart: async () => {
    throw new Error('always-failing fake exe')
  },
  setSharePublic: async () => {
    throw new Error('always-failing fake exe')
  },
}
