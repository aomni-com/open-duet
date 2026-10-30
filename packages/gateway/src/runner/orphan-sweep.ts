import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const RUNNER_OWNER_ENV = 'DUET_GATEWAY_OWNER_PID'
export const RUNNER_RPC_FLAG = '--rpc'

export interface OrphanSweepOptions {
  procDir?: string
  isPidAlive?: (pid: number) => boolean
  killPid?: (pid: number) => void
}

export function sweepOrphanRunners({
  procDir = '/proc',
  isPidAlive = defaultIsPidAlive,
  killPid = defaultKillPid,
}: OrphanSweepOptions = {}): number[] {
  let entries: string[]
  try {
    entries = readdirSync(procDir)
  } catch {
    return []
  }

  const killed: number[] = []
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    let environ: string
    let cmdline: string
    try {
      environ = readFileSync(join(procDir, entry, 'environ'), 'utf8')
      cmdline = readFileSync(join(procDir, entry, 'cmdline'), 'utf8')
    } catch {
      continue
    }

    const marker = environ.split('\0').find(kv => kv.startsWith(`${RUNNER_OWNER_ENV}=`))
    if (marker === undefined) continue
    if (!cmdline.split('\0').includes(RUNNER_RPC_FLAG)) continue
    const ownerPid = Number(marker.slice(RUNNER_OWNER_ENV.length + 1))
    if (Number.isInteger(ownerPid) && ownerPid > 0 && isPidAlive(ownerPid)) continue
    killPid(pid)
    killed.push(pid)
  }
  if (killed.length > 0) console.warn('[gateway] orphan-runner sweep killed runners', { killed })
  return killed
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function defaultKillPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
