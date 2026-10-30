import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import type { GatewayAnchor } from '@repo/contract'

/** The durable memory an agent's folder owns: one markdown file per fact. */
export function memoryStoreDir(folder: string): string {
  return join(folder, '.agents', 'memories')
}

/** The skills an agent's folder owns, and carries when it is shared or installed. */
export function skillsDir(folder: string): string {
  return join(folder, '.agents', 'skills')
}

/**
 * Give a folder a memory store of its own.
 *
 * A flagless `duet memory add` writes to the nearest ancestor that owns an
 * `.agents` directory — the bare directory is the marker, and the CLI creates
 * `memories/` under it on demand. An agent that owns none is therefore not
 * writing to an empty store, it is writing to somebody else's: the walk climbs
 * out of its folder and lands on the drive root's, the store every agent in the
 * workspace inherits. The user asks one agent to remember something and teaches
 * all of them, with nothing to notice, because the write reports success either
 * way. Creating the folder is what makes "nearest" mean this agent.
 *
 * Existing stores are left exactly as they are, and a folder the drive has not
 * synced yet, or one that symlinks out of the drive, is skipped: this creates a
 * store inside an agent's folder, never the folder itself, and memories are
 * synced agent content, so the store has to be real content inside the drive.
 */
export function ensureMemoryStore(driveDir: string, folder: string): void {
  try {
    const realDrive = realpathSync(resolve(driveDir))
    const realFolder = realpathSync(folder)
    if (realFolder !== realDrive && !realFolder.startsWith(`${realDrive}${sep}`)) return
    if (!statSync(realFolder).isDirectory()) return
    mkdirSync(memoryStoreDir(realFolder), { recursive: true, mode: 0o700 })
  } catch {
    // Best effort: a session must still launch, and a reconcile must still
    // finish, on a drive that cannot take the write. The cost is the flagless
    // write walking up, which is where it went before this existed.
  }
}

/**
 * The whole workspace's stores, refreshed from the anchor set.
 *
 * Launch-time creation alone would leave a store missing until an agent's first
 * session — but the Train page installs into an agent that has never run, and
 * an agent registered on one device is expected to look the same on the next.
 * This runs on every anchor reconcile instead, so owning a store is a property
 * of being a registered agent rather than of having been talked to. The drive
 * root is included because it is the default agent's own folder. Launch keeps
 * its own call: a session can start on a folder that synced since the last
 * reconcile, and the first turn is exactly when the first note gets written.
 *
 * Only active agent anchors count. A broken or orphaned anchor's path is the
 * thing the reconciler has not settled yet, and planting a store down it is how
 * one ends up in a folder the agent never occupied.
 */
export function ensureAgentMemoryStores(driveDir: string, anchors: readonly GatewayAnchor[]): void {
  ensureMemoryStore(driveDir, driveDir)
  for (const anchor of anchors) {
    if (anchor.agentId === undefined || anchor.state !== 'active') continue
    ensureMemoryStore(driveDir, join(driveDir, anchor.path))
  }
}
