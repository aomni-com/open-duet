import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { ExeClient, type CreateVmOptions, type ExeVm } from '@repo/exe'

export const DUET_TEST_VM_PREFIX = 'duet-test-'
export const DUET_TEST_VM_TAG = 'duet-test'

const DEFAULT_SWEEP_OLDER_THAN_MS = 60 * 60 * 1000

export interface ExeVmPoolOptions {
  client?: ExeClient
  token?: string
  connectTimeoutSec?: number
}

export interface ExeVmPool {
  client: ExeClient
  checkout(options?: Omit<CreateVmOptions, 'name' | 'comment'> & { name?: string }): Promise<ExeVm>
  return: (vm: ExeVm | string) => Promise<void>
  returnVm(vm: ExeVm | string): Promise<void>
  sweep(options?: { olderThanMs?: number; now?: Date }): Promise<string[]>
}

export function exeVmPool(options: ExeVmPoolOptions = {}): ExeVmPool {
  const client =
    options.client ??
    new ExeClient({
      token: options.token ?? process.env.EXE_TOKEN,
      connectTimeoutSec: options.connectTimeoutSec,
    })

  async function returnVm(vm: ExeVm | string): Promise<void> {
    const name = typeof vm === 'string' ? vm : vm.vm_name
    await client.remove(name)
  }

  return {
    client,
    async checkout(options = {}) {
      const name = options.name ?? makeDuetTestVmName()
      if (!name.startsWith(DUET_TEST_VM_PREFIX)) {
        throw new Error(`Test VM names must start with ${DUET_TEST_VM_PREFIX}`)
      }
      const vm = await client.create({
        ...options,
        name,
        comment: DUET_TEST_VM_TAG,
        tags: [...new Set([DUET_TEST_VM_TAG, ...(options.tags ?? [])])],
      })
      return vm
    },
    return: returnVm,
    returnVm,
    async sweep({ olderThanMs = DEFAULT_SWEEP_OLDER_THAN_MS, now = new Date() } = {}) {
      const removed: string[] = []
      for (const vm of await client.list()) {
        if (!isSweepCandidate(vm, now, olderThanMs)) continue
        await client.remove(vm.vm_name)
        removed.push(vm.vm_name)
      }
      return removed
    },
  }
}

export function makeDuetTestVmName(now = new Date()): string {
  return `${DUET_TEST_VM_PREFIX}${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`
}

export function exeSelfTestReady(): boolean {
  if (!process.env.EXE_TOKEN) return false
  try {
    execFileSync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'LogLevel=ERROR',
        'exe.dev',
        'whoami',
      ],
      { stdio: 'ignore', timeout: 20_000 },
    )
    return true
  } catch {
    return false
  }
}

function isSweepCandidate(vm: ExeVm, now: Date, olderThanMs: number): boolean {
  if (!vm.vm_name.startsWith(DUET_TEST_VM_PREFIX)) return false
  if (Array.isArray(vm.tags) && !vm.tags.includes(DUET_TEST_VM_TAG)) return false
  const createdAt = vmCreatedAt(vm)
  return createdAt === null || now.getTime() - createdAt.getTime() >= olderThanMs
}

function vmCreatedAt(vm: ExeVm): Date | null {
  const namedAt = vm.vm_name.match(/^duet-test-([0-9a-z]+)-/)?.[1]
  if (namedAt) {
    const timestampMs = Number.parseInt(namedAt, 36)
    if (Number.isFinite(timestampMs)) return new Date(timestampMs)
  }
  if (vm.created_at) {
    const timestampMs = Date.parse(vm.created_at)
    if (Number.isFinite(timestampMs)) return new Date(timestampMs)
  }
  return null
}
