import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { SyncMachinePageSchema, SyncMachineSchema } from '@repo/contract'

import type { CommandContext } from '../cli-support.js'
import { loadConfig, saveConfig } from '../config.js'
import type { ApiClient } from '../http.js'
import { syncRoot } from './daemon-status.js'

export function macIdentityHome(home: string): string {
  return join(syncRoot(home), 'identity')
}

/** Publish a complete identity atomically, so concurrent first starts use one peer. */
export async function prepareMacIdentity(binaryPath: string, identityHome: string): Promise<void> {
  try {
    await readIdentity(identityHome)
    return
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) throw error
  }
  await mkdir(dirname(identityHome), { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(dirname(identityHome), 'identity-'))
  try {
    const proc = Bun.spawn([binaryPath, 'generate', `--home=${scratch}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    if ((await proc.exited) !== 0) throw new Error('Could not generate the Mac sync identity')
    await readIdentity(scratch)
    try {
      await rename(scratch, identityHome)
    } catch (error) {
      if (!isFileError(error, 'EEXIST') && !isFileError(error, 'ENOTEMPTY')) throw error
    }
    await readIdentity(identityHome)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function copyMacIdentity(identityHome: string, workspaceHome: string): Promise<void> {
  await Promise.all(
    ['cert.pem', 'key.pem'].map(name =>
      copyFile(join(identityHome, name), join(workspaceHome, name)),
    ),
  )
}

/** Explicit human activation; the daemon never calls this registration endpoint. */
export async function registerSyncMachine(
  ctx: CommandContext,
  binaryPath: string,
): Promise<string> {
  const identityHome = macIdentityHome(ctx.home)
  await prepareMacIdentity(binaryPath, identityHome)
  const proc = Bun.spawn([binaryPath, 'device-id', `--home=${identityHome}`], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const syncthingDeviceId = (await new Response(proc.stdout).text()).trim()
  if ((await proc.exited) !== 0) throw new Error('Could not read the Mac sync identity')
  const response = await ctx.api.request('/user/sync-machines', {
    method: 'POST',
    json: { name: hostname(), syncthingDeviceId },
  })
  const machine = SyncMachineSchema.parse(await response.json())
  await saveConfig(
    { ...(await loadConfig(ctx.configPath)), machineId: machine.machineId },
    ctx.configPath,
  )
  return machine.machineId
}

export async function isSyncMachineActive(
  api: Pick<ApiClient, 'request'>,
  machineId: string,
): Promise<boolean> {
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor !== undefined) params.set('cursor', cursor)
    const response = await api.request(`/user/sync-machines?${params}`)
    const page = SyncMachinePageSchema.parse(await response.json())
    const machine = page.items.find(item => item.machineId === machineId)
    if (machine !== undefined) return machine.removedAt === undefined
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return false
}

async function readIdentity(home: string): Promise<void> {
  await Promise.all(['cert.pem', 'key.pem'].map(name => readFile(join(home, name))))
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
