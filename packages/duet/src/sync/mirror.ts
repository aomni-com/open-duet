import { readFile, readdir } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { type MirrorTunnelGrant } from '@repo/contract'

import { CliError, EXIT_CODES } from '../exit-codes.js'
import type { ApiClient } from '../http.js'
import { startMirrorBridge, type MirrorBridge } from './bridge.js'
import { syncRoot } from './daemon-status.js'
import { macIdentityHome } from './machine.js'
import { configureLocalMirror, registerMirror } from './orchestrator.js'
import { listConflicts, readConvergence } from './status.js'
import { createSupervisor, type Supervisor } from './supervisor.js'
import { scanFolder, type FetchLike } from './syncthing-api.js'

// Each workspace has its own Syncthing config and DB because every VM uses
// the same whole-drive folder ID. All instances copy the Mac's certificate,
// so their peer ID and account machine identity stay the same across workspaces.

export interface MirrorSnapshot {
  connected: boolean
  converged: boolean
  localState?: string
  needBytes: number
  remoteCompletion: number
  conflicts: number
  conflictPaths?: string[]
  /** Top-level repos with a local `.git` but no remote — history can't reach the Mac (G1). */
  reposMissingRemote: string[]
}

export interface WorkspaceMirrorHandle {
  readonly slug: string
  readonly localDir: string
  /** Sample live state for the status snapshot. Never resolves conflicts (Q6). */
  poll(): Promise<MirrorSnapshot>
  stop(): Promise<void>
}

/**
 * Bring one workspace's mirror up and hand back a handle. Injected into the
 * daemon so its lifecycle logic is tested against a fake starter; the default
 * (`createRealMirrorStarter`) wires the real slice-21 modules.
 */
export type StartWorkspaceMirror = (input: {
  slug: string
  syncKey: string
  localDir: string
  log: (fields: Record<string, unknown>) => void
}) => Promise<WorkspaceMirrorHandle>

export interface RealMirrorStarterOptions {
  api: Pick<ApiClient, 'request'>
  machineId: string
  /** The user home (`~`); per-workspace Syncthing homes hang under `~/.duet/sync`. */
  home: string
  /** Verified Syncthing binary (resolved once by the daemon). */
  binaryPath: string
  fetch: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Allocate a fresh loopback GUI port per workspace instance. */
  allocatePort?: () => Promise<number>
}

export function workspaceSyncHome(home: string, syncKey: string): string {
  return join(syncRoot(home), 'workspaces', syncKey)
}

export function createRealMirrorStarter(options: RealMirrorStarterOptions): StartWorkspaceMirror {
  const allocatePort = options.allocatePort ?? freeLoopbackPort
  return async ({ slug, syncKey, localDir, log }) => {
    await mkdir(localDir, { recursive: true })
    const guiPort = await allocatePort()
    const supervisor: Supervisor = createSupervisor({
      home: workspaceSyncHome(options.home, syncKey),
      identityHome: macIdentityHome(options.home),
      binaryPath: options.binaryPath,
      guiPort,
      fetch: options.fetch,
      now: options.now,
      sleep: options.sleep,
      log,
    })
    let bridge: MirrorBridge | null = null
    try {
      const st = await supervisor.start()
      const localDeviceId = await supervisor.deviceId()
      log({ operation: 'mirror_local_ready', slug, localDeviceId, guiPort })

      // Register through the Duet API (never the VM Syncthing API — L14). The
      // bridge re-mints its own tunnel on every reconnect (L23), so re-registering
      // is the mint path.
      const registered = await registerMirror(options.api, slug, options.machineId, localDeviceId)
      const mintTunnel = async (): Promise<MirrorTunnelGrant> =>
        (await registerMirror(options.api, slug, options.machineId, localDeviceId)).tunnel

      bridge = await startMirrorBridge({
        mintTunnel,
        now: options.now,
        log,
        retryOnMintError: error => !isAdmissionRefusal(error),
      })
      log({ operation: 'mirror_bridge_ready', slug, port: bridge.port })
      await configureLocalMirror(st, {
        folderId: registered.folderId,
        localDeviceId,
        vmDeviceId: registered.vmSyncthingDeviceId,
        bridgePort: bridge.port,
        localDir,
      })
      await scanFolder(st, registered.folderId)
      log({ operation: 'mirror_configured', slug, folderId: registered.folderId, localDir })
      const activeBridge = bridge

      return {
        slug,
        localDir,
        async poll(): Promise<MirrorSnapshot> {
          const failure = activeBridge.failure()
          if (failure !== undefined) throw failure
          const [convergence, conflicts, reposMissingRemote] = await Promise.all([
            readConvergence(st, {
              folderId: registered.folderId,
              vmDeviceId: registered.vmSyncthingDeviceId,
            }),
            listConflicts(localDir),
            reposMissingRemoteUnder(localDir),
          ])
          return {
            connected: convergence.connected,
            converged: convergence.converged,
            localState: convergence.localState,
            needBytes: convergence.localNeedBytes,
            remoteCompletion: convergence.remoteCompletion,
            conflicts: conflicts.length,
            conflictPaths: conflicts,
            reposMissingRemote,
          }
        },
        async stop(): Promise<void> {
          await activeBridge.close()
          await supervisor.stop()
        },
      }
    } catch (error) {
      if (bridge !== null) await bridge.close()
      await supervisor.stop()
      throw error
    }
  }
}

export function isAdmissionRefusal(error: unknown): boolean {
  return (
    error instanceof CliError &&
    (error.exitCode === EXIT_CODES.auth ||
      error.exitCode === EXIT_CODES.scope ||
      error.exitCode === EXIT_CODES.notFound)
  )
}

/**
 * Read-only G1 nag (NOT the git concierge — G2 deferred): a repo whose history
 * can reach the Mac needs a real remote, since `.git` never mirrors. Because the
 * Mac keeps its own `.git`, we can see it locally. Scans the mirror root and its
 * immediate children (the common "repo at root" / "repos one level down"
 * layouts) for a `.git/config` with no `[remote …]` — never inits, fetches,
 * resets, or follows branches.
 */
export async function reposMissingRemoteUnder(dir: string): Promise<string[]> {
  const candidates = ['.', ...(await immediateSubdirs(dir))]
  const missing: string[] = []
  for (const rel of candidates) {
    const gitConfig = join(dir, rel, '.git', 'config')
    let text: string
    try {
      text = await readFile(gitConfig, 'utf8')
    } catch {
      continue
    }
    if (!/^\s*\[remote /m.test(text)) missing.push(rel === '.' ? '.' : rel)
  }
  return missing.sort()
}

async function immediateSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(
        entry => entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules',
      )
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Allocate a free loopback port. Shared with `duet sync run` (slice 21). */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}
