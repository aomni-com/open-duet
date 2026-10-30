import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
  MIRROR_FOLDER_ID,
  isDrivePathWithin,
  normalizeDrivePath,
  type ShareSyncReport,
  type VmDesiredShareSync,
} from '@repo/contract'

import type { TunnelAcceptRegistry } from '../routes/tunnel'
import { runSystemCommandOrThrow } from '../system-command'
import type { SyncBridgeRegistry } from './bridge-registry'
import { shareSyncthingFolderType } from './folder-mode'
import { readMirrorDevices, readMounts, writeMounts, type SyncedMount } from './mount-store'
import { assertSafeDirectory, safeDriveDirectory, writeStignore } from './mounts'
import {
  applyHardenedSyncthingOptions,
  createSyncthingConfigCoordinator,
  syncthingConnection,
  type FetchLike,
  type SyncthingConfigCoordinator,
  type SyncthingClientOptions,
  type SyncthingConfig,
} from './syncthing-client'

type DesiredShare = VmDesiredShareSync['shares'][number]
const RELOCATION_JOURNAL_FILE = 'sync-share-relocations.json'

interface PendingShareRelocation {
  shareId: string
  folderId: string
  fromPath: string
  toPath: string
}

export interface ShareConvergerOptions extends SyncthingClientOptions {
  driveDir: string
  fetch: FetchLike
  accepts: TunnelAcceptRegistry
  bridges: SyncBridgeRegistry
  configCoordinator?: SyncthingConfigCoordinator
  prepareFolder?: (share: DesiredShare, existing?: SyncedMount) => Promise<string>
  persistMounts?: typeof writeMounts
  relocation?: ShareRelocationOperations
}

export interface ShareRelocationOperations {
  oldPathHasSyncthingMarker(path: string): Promise<boolean>
  stop(): Promise<void>
  remove(folderId: string): Promise<void>
  repath(folderId: string, absolutePath: string): Promise<void>
  start(): Promise<void>
  rescan(folderId: string): Promise<void>
}

export interface ShareConvergeResult {
  reports: ShareSyncReport[]
  changes: number
}

export interface ShareConverger {
  converge(desired: VmDesiredShareSync): Promise<ShareConvergeResult>
  accept(desired: VmDesiredShareSync): void
  reports(): ShareSyncReport[]
  acknowledge(reports: ShareSyncReport[]): void
}

export function createShareConverger(options: ShareConvergerOptions): ShareConverger {
  const outbox = new Map<string, ShareSyncReport>()
  const realizations = new Map<string, ShareSyncReport>()
  let tail = Promise.resolve()
  let pending: VmDesiredShareSync | undefined
  let running = false
  let lastSuccessful: { desiredJson: string; reports: ShareSyncReport[] } | undefined
  const prepareFolder = options.prepareFolder ?? defaultPrepareFolder
  const persistMounts = options.persistMounts ?? writeMounts
  const configCoordinator =
    options.configCoordinator ?? createSyncthingConfigCoordinator(options, options.fetch)
  const relocation = options.relocation ?? createDefaultRelocationOperations(options)

  async function converge(desired: VmDesiredShareSync): Promise<ShareConvergeResult> {
    const desiredJson = JSON.stringify(desired)

    for (const share of desired.shares) {
      if (realizations.get(share.shareId)?.generation !== share.generation) {
        publish({
          shareId: share.shareId,
          generation: share.generation,
          state: 'applying',
        })
      }
    }

    const existingMounts = await readMounts(options.stateDir)
    let pendingRelocations = await readPendingRelocations(options.stateDir)
    if (
      lastSuccessful?.desiredJson === desiredJson &&
      pendingRelocations.length === 0 &&
      sameMounts(
        existingMounts,
        desired.shares.map(share => mountForShare(share, share.folder.path)),
      ) &&
      (await allShareRootsRemainSafe(options.driveDir, desired.shares))
    ) {
      return { reports: lastSuccessful.reports, changes: 0 }
    }
    lastSuccessful = undefined
    const existingMountById = new Map(existingMounts.map(mount => [mount.id, mount]))
    const desiredFolderIds = new Set(desired.shares.map(share => share.folder.id))
    const obsoletePendingRelocations = pendingRelocations.filter(
      pending => !desiredFolderIds.has(pending.folderId),
    )
    const relevantPendingRelocations = pendingRelocations.filter(pending =>
      desiredFolderIds.has(pending.folderId),
    )
    if (obsoletePendingRelocations.length > 0) {
      const recovered = await configCoordinator.exclusive(
        async () => await recoverObsoleteRelocations(relocation, obsoletePendingRelocations),
      )
      if (!recovered) {
        return finishResult(
          desired,
          new Map(desired.shares.map(share => [share.shareId, 'syncthing_unavailable'])),
          0,
          desiredJson,
        )
      }
      try {
        await writePendingRelocations(options.stateDir, relevantPendingRelocations)
      } catch {
        return finishResult(
          desired,
          new Map(desired.shares.map(share => [share.shareId, 'relocation_journal_failed'])),
          0,
          desiredJson,
        )
      }
      pendingRelocations = relevantPendingRelocations
    }
    const pendingRelocationByFolder = new Map(
      pendingRelocations.map(relocation => [relocation.folderId, relocation]),
    )
    const errors = new Map<string, string>()
    for (const [index, left] of desired.shares.entries()) {
      for (const right of desired.shares.slice(index + 1)) {
        if (
          isDrivePathWithin(left.folder.path, right.folder.path) ||
          isDrivePathWithin(right.folder.path, left.folder.path)
        ) {
          errors.set(left.shareId, 'nested_share_path')
          errors.set(right.shareId, 'nested_share_path')
        }
      }
    }
    const preparedPaths = new Map<string, string>()
    const nextMounts: SyncedMount[] = []
    const relocations: Array<{
      share: DesiredShare
      existing: SyncedMount
      preparedPath: string
      guardPath: string
      pendingJournal?: PendingShareRelocation
    }> = []

    for (const share of desired.shares) {
      if (errors.has(share.shareId)) continue
      const storedMount = existingMountById.get(share.folder.id)
      const pendingRelocation = pendingRelocationByFolder.get(share.folder.id)
      const existing =
        pendingRelocation === undefined
          ? storedMount
          : {
              ...(storedMount ?? mountForShare(share, pendingRelocation.fromPath)),
              path: pendingRelocation.fromPath,
            }
      try {
        const path = await prepareFolder(share, existing)
        preparedPaths.set(share.shareId, path)
        nextMounts.push(mountForShare(share, share.folder.path))
        if (pendingRelocation !== undefined && existing !== undefined) {
          const cancellation = share.folder.path === pendingRelocation.fromPath
          const replay = cancellation || share.folder.path === pendingRelocation.toPath
          relocations.push({
            share,
            existing,
            preparedPath: path,
            guardPath: cancellation ? pendingRelocation.toPath : pendingRelocation.fromPath,
            ...(replay ? { pendingJournal: pendingRelocation } : {}),
          })
        } else if (existing !== undefined && existing.path !== share.folder.path) {
          relocations.push({
            share,
            existing,
            preparedPath: path,
            guardPath: existing.path,
          })
        }
      } catch {
        errors.set(share.shareId, 'mount_failed')
        if (existing !== undefined) nextMounts.push(existing)
      }
    }

    let persistedMounts = existingMounts
    for (const pending of pendingRelocations) {
      const share = desired.shares.find(candidate => candidate.folder.id === pending.folderId)
      const mount = persistedMounts.find(candidate => candidate.id === pending.folderId)
      const previousMount =
        mount ?? (share === undefined ? undefined : mountForShare(share, pending.fromPath))
      if (previousMount === undefined) continue
      persistedMounts = replaceMount(persistedMounts, { ...previousMount, path: pending.fromPath })
    }
    let mountChanges = 0
    let syncthingUnavailable = false
    const completedRelocations: Array<{
      move: (typeof relocations)[number]
      journalEntry: PendingShareRelocation
    }> = []
    for (const [index, move] of relocations.entries()) {
      if (errors.has(move.share.shareId)) continue
      const next = nextMounts.find(mount => mount.id === move.share.folder.id)
      if (next === undefined) continue
      const updatedMounts = replaceMount(persistedMounts, next)
      const journalEntry: PendingShareRelocation = move.pendingJournal ?? {
        shareId: move.share.shareId,
        folderId: move.share.folder.id,
        fromPath: move.existing.path,
        toPath: move.share.folder.path,
      }
      const journalAlreadyMatches = pendingRelocations.some(pending =>
        sameJson(pending, journalEntry),
      )
      if (!journalAlreadyMatches) {
        const nextPending = replacePendingRelocation(pendingRelocations, journalEntry)
        try {
          await writePendingRelocations(options.stateDir, nextPending)
          pendingRelocations = nextPending
        } catch {
          errors.set(move.share.shareId, 'relocation_journal_failed')
          replaceMount(nextMounts, move.existing, true)
          continue
        }
      }
      const relocationResult = await configCoordinator.exclusive(
        async () =>
          await relocateShare({
            operations: relocation,
            persistMounts,
            stateDir: options.stateDir,
            guardPath: move.guardPath,
            folderId: move.share.folder.id,
            preparedPath: move.preparedPath,
            previousMounts: persistedMounts,
            updatedMounts,
          }),
      )
      if (relocationResult.errorCode === undefined) {
        persistedMounts = updatedMounts
        mountChanges += 1
        completedRelocations.push({ move, journalEntry })
        continue
      }
      errors.set(move.share.shareId, relocationResult.errorCode)
      replaceMount(nextMounts, move.existing, true)
      if (relocationResult.syncthingUnavailable) {
        syncthingUnavailable = true
        for (const remaining of relocations.slice(index + 1)) {
          errors.set(remaining.share.shareId, 'syncthing_unavailable')
          replaceMount(nextMounts, remaining.existing, true)
        }
        break
      }
    }

    let changes =
      mountChanges +
      options.accepts.replace(
        desired.shares.filter(share => !errors.has(share.shareId)).map(share => share.accept),
      ).changed
    const bridgeResult = await options.bridges.reconcile(
      desired.shares.flatMap(share =>
        share.bridge === undefined || errors.has(share.shareId)
          ? []
          : [
              {
                id: bridgeId(share),
                listenPort: 0,
                peerUrl: share.bridge.peerUrl,
                tunnelToken: share.bridge.tunnelToken,
              },
            ],
      ),
    )
    changes += bridgeResult.changed
    for (const share of desired.shares) {
      if (bridgeResult.errors.has(bridgeId(share)) && !errors.has(share.shareId)) {
        errors.set(share.shareId, 'bridge_failed')
      }
    }

    if (!sameMounts(persistedMounts, nextMounts)) {
      await persistMounts(options.stateDir, nextMounts)
      changes += 1
    }

    if (syncthingUnavailable) {
      for (const share of desired.shares) {
        if (!errors.has(share.shareId)) errors.set(share.shareId, 'syncthing_unavailable')
      }
    } else {
      const configChanged = await configCoordinator.reconcile(
        async current => {
          const mirrorDevices = await readMirrorDevices(options.stateDir)
          return projectShareConfig({
            current,
            desired,
            preparedPaths,
            errors,
            bridgeAddresses: bridgeResult.addresses,
            mirrorDeviceIds: mirrorDevices.map(device => device.syncthingDeviceId),
          })
        },
        { waitForReady: true },
      )
      if (configChanged) changes += 1
      await configCoordinator.reconcile(
        current => {
          const folders = Array.isArray(current.folders) ? current.folders : []
          for (const share of desired.shares) {
            if (errors.has(share.shareId)) continue
            const folder = folders.find(candidate => candidate.id === share.folder.id)
            if (folder === undefined || Boolean(folder.paused) !== share.folder.paused) {
              errors.set(share.shareId, 'syncthing_config_readback_mismatch')
            }
          }
          return current
        },
        { waitForReady: true },
      )
      for (const { move, journalEntry } of completedRelocations) {
        try {
          await relocation.rescan(move.share.folder.id)
        } catch {
          errors.set(move.share.shareId, 'relocation_rescan_failed')
          continue
        }
        const nextPending = pendingRelocations.filter(pending => !sameJson(pending, journalEntry))
        try {
          await writePendingRelocations(options.stateDir, nextPending)
          pendingRelocations = nextPending
        } catch {
          errors.set(move.share.shareId, 'relocation_journal_clear_failed')
        }
      }
    }

    return finishResult(desired, errors, changes, desiredJson)
  }

  function finishResult(
    desired: VmDesiredShareSync,
    errors: Map<string, string>,
    changes: number,
    desiredJson: string,
  ): ShareConvergeResult {
    const reports = desired.shares
      .map(share => {
        const errorCode = errors.get(share.shareId)
        const report: ShareSyncReport =
          errorCode === undefined
            ? {
                shareId: share.shareId,
                generation: share.generation,
                state: share.folder.paused ? 'paused' : 'ready',
              }
            : {
                shareId: share.shareId,
                generation: share.generation,
                state: 'error',
                errorCode,
              }
        publish(report)
        return report
      })
      .sort((left, right) => left.shareId.localeCompare(right.shareId))
    for (const shareId of outbox.keys()) {
      if (desired.shares.some(share => share.shareId === shareId)) continue
      outbox.delete(shareId)
      realizations.delete(shareId)
    }
    const result = { reports, changes }
    if (errors.size === 0) lastSuccessful = { desiredJson, reports }
    return result
  }

  function accept(desired: VmDesiredShareSync): void {
    pending = desired
    if (running) return
    running = true
    tail = tail
      .then(async () => {
        while (pending !== undefined) {
          const next = pending
          pending = undefined
          try {
            await converge(next)
          } catch {
            for (const share of next.shares) {
              publish({
                shareId: share.shareId,
                generation: share.generation,
                state: 'error',
                errorCode: 'converge_failed',
              })
            }
          }
        }
      })
      .finally(() => {
        running = false
        if (pending !== undefined) accept(pending)
      })
  }

  return {
    converge,
    accept,
    reports: () =>
      [...outbox.values()]
        .sort((a, b) => a.shareId.localeCompare(b.shareId))
        .slice(0, MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE),
    acknowledge(reports) {
      for (const report of reports) {
        const current = outbox.get(report.shareId)
        if (
          current?.generation === report.generation &&
          current.state === report.state &&
          current.errorCode === report.errorCode
        ) {
          outbox.delete(report.shareId)
        }
      }
    },
  }

  async function defaultPrepareFolder(
    share: DesiredShare,
    existing?: SyncedMount,
  ): Promise<string> {
    const normalized = normalizeDrivePath(share.folder.path)
    if (!normalized.ok) throw new Error('Invalid share folder path')
    const path =
      existing === undefined
        ? await safeDriveDirectory(options.driveDir, normalized.relativePath)
        : join(options.driveDir, normalized.relativePath)
    if (path === null || !(await assertSafeDirectory(options.driveDir, path))) {
      throw new Error('Invalid share folder path')
    }
    const resolvedPath = await realpath(path)
    await writeStignore(resolvedPath, share.folder.ignorePatterns)
    if (!(await assertSafeDirectory(options.driveDir, resolvedPath))) {
      throw new Error('Invalid share folder path')
    }
    return resolvedPath
  }

  function publish(report: ShareSyncReport): void {
    const current = realizations.get(report.shareId)
    if (
      current?.generation === report.generation &&
      current.state === report.state &&
      current.errorCode === report.errorCode
    ) {
      return
    }
    realizations.set(report.shareId, report)
    outbox.set(report.shareId, report)
  }
}

async function relocateShare(input: {
  operations: ShareRelocationOperations
  persistMounts: typeof writeMounts
  stateDir: string
  guardPath: string
  folderId: string
  preparedPath: string
  previousMounts: SyncedMount[]
  updatedMounts: SyncedMount[]
}): Promise<{ errorCode?: string; syncthingUnavailable: boolean }> {
  let stopped = false
  let safeToStart = true
  let syncthingUnavailable = false
  let mountStoreUpdated = false
  let errorCode: string | undefined
  try {
    await input.operations.stop()
    stopped = true
  } catch {
    return { errorCode: 'relocation_stop_failed', syncthingUnavailable: false }
  }

  try {
    let oldPathHasSyncthingMarker = false
    try {
      oldPathHasSyncthingMarker = await input.operations.oldPathHasSyncthingMarker(input.guardPath)
    } catch {
      errorCode = 'relocation_guard_failed'
    }
    if (oldPathHasSyncthingMarker) {
      errorCode = 'relocation_old_path_reappeared'
    }
    if (errorCode !== undefined) {
      try {
        await input.operations.remove(input.folderId)
      } catch {
        errorCode = 'relocation_quarantine_failed'
        safeToStart = false
      }
    } else {
      try {
        await input.persistMounts(input.stateDir, input.updatedMounts)
        mountStoreUpdated = true
      } catch {
        errorCode = 'relocation_mount_store_failed'
      }
      if (errorCode === undefined) {
        try {
          await input.operations.repath(input.folderId, input.preparedPath)
        } catch {
          errorCode = 'relocation_repath_failed'
        }
      }
    }
  } finally {
    if (stopped && safeToStart) {
      try {
        await input.operations.start()
      } catch {
        errorCode = 'relocation_start_failed'
        syncthingUnavailable = true
      }
    }
  }

  if (errorCode !== undefined && mountStoreUpdated) {
    await input.persistMounts(input.stateDir, input.previousMounts).catch(() => undefined)
  }
  return {
    ...(errorCode === undefined ? {} : { errorCode }),
    syncthingUnavailable: syncthingUnavailable || !safeToStart,
  }
}

async function recoverObsoleteRelocations(
  operations: ShareRelocationOperations,
  pending: PendingShareRelocation[],
): Promise<boolean> {
  try {
    await operations.stop()
  } catch {
    return false
  }
  try {
    for (const relocation of pending) await operations.remove(relocation.folderId)
  } catch {
    return false
  }
  try {
    await operations.start()
    return true
  } catch {
    return false
  }
}

function mountForShare(share: DesiredShare, path: string): SyncedMount {
  return {
    id: share.folder.id,
    shareId: share.shareId,
    path,
    mode: share.folder.mode,
    role: share.folder.role,
    ignorePatterns: [...share.folder.ignorePatterns],
  }
}

function replaceMount(
  mounts: SyncedMount[],
  replacement: SyncedMount,
  mutate = false,
): SyncedMount[] {
  const target = mutate ? mounts : [...mounts]
  const index = target.findIndex(mount => mount.id === replacement.id)
  if (index === -1) target.push(replacement)
  else target[index] = replacement
  return target
}

function replacePendingRelocation(
  pending: PendingShareRelocation[],
  replacement: PendingShareRelocation,
): PendingShareRelocation[] {
  const next = pending.filter(entry => entry.folderId !== replacement.folderId)
  next.push(replacement)
  return next.sort((left, right) => left.folderId.localeCompare(right.folderId))
}

async function readPendingRelocations(stateDir: string): Promise<PendingShareRelocation[]> {
  const path = join(stateDir, RELOCATION_JOURNAL_FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return []
    }
    throw new Error('Share relocation journal is unreadable', { cause: error })
  }
  if (!Array.isArray(parsed) || !parsed.every(isPendingShareRelocation)) {
    throw new Error('Share relocation journal is invalid')
  }
  return parsed
}

async function writePendingRelocations(
  stateDir: string,
  pending: PendingShareRelocation[],
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, RELOCATION_JOURNAL_FILE)
  const temporary = `${path}.write-${crypto.randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function isPendingShareRelocation(value: unknown): value is PendingShareRelocation {
  if (typeof value !== 'object' || value === null) return false
  const pending = value as Record<string, unknown>
  return (
    typeof pending.shareId === 'string' &&
    typeof pending.folderId === 'string' &&
    typeof pending.fromPath === 'string' &&
    typeof pending.toPath === 'string'
  )
}

function createDefaultRelocationOperations(
  options: ShareConvergerOptions,
): ShareRelocationOperations {
  return {
    oldPathHasSyncthingMarker: path => oldPathHasSyncthingMarker(options.driveDir, path),
    async stop() {
      await runSystemCommandOrThrow(['sudo', '-n', 'systemctl', 'stop', 'duet-syncthing.service'])
    },
    async remove(folderId) {
      await removeSyncthingConfigFolder(options.stateDir, folderId)
    },
    async repath(folderId, absolutePath) {
      await repathSyncthingConfigFile(options.stateDir, folderId, absolutePath)
    },
    async start() {
      await runSystemCommandOrThrow(['sudo', '-n', 'systemctl', 'start', 'duet-syncthing.service'])
    },
    async rescan(folderId) {
      const { base, headers } = await syncthingConnection(options)
      let lastStatus = 0
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await options.fetch(
            `${base}/rest/db/scan?folder=${encodeURIComponent(folderId)}`,
            { method: 'POST', headers },
          )
          lastStatus = response.status
          if (response.ok) return
        } catch {
          // systemd reports start before the local REST listener always accepts.
        }
        await Bun.sleep(250)
      }
      throw new Error(`Syncthing rescan failed with HTTP ${lastStatus}`)
    },
  }
}

export async function oldPathHasSyncthingMarker(driveDir: string, path: string): Promise<boolean> {
  const normalized = normalizeDrivePath(path)
  if (!normalized.ok) return true
  try {
    return (await stat(join(driveDir, normalized.relativePath, '.stfolder'))).isDirectory()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

async function repathSyncthingConfigFile(
  stateDir: string,
  folderId: string,
  absolutePath: string,
): Promise<void> {
  await rewriteSyncthingConfigFile(stateDir, contents =>
    repathSyncthingFolderXml(contents, folderId, absolutePath),
  )
}

async function removeSyncthingConfigFolder(stateDir: string, folderId: string): Promise<void> {
  await rewriteSyncthingConfigFile(stateDir, contents =>
    removeSyncthingFolderXml(contents, folderId),
  )
}

async function rewriteSyncthingConfigFile(
  stateDir: string,
  project: (contents: string) => string,
): Promise<void> {
  const path = join(stateDir, 'syncthing', 'config.xml')
  const contents = await readFile(path, 'utf8')
  const updated = project(contents)
  const info = await stat(path)
  const temporary = `${path}.relocate-${crypto.randomUUID()}`
  try {
    await writeFile(temporary, updated, { mode: info.mode & 0o777 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export function repathSyncthingFolderXml(
  contents: string,
  folderId: string,
  absolutePath: string,
): string {
  for (const match of contents.matchAll(/<folder\b[^>]*>/g)) {
    const tag = match[0]
    const id = readXmlAttribute(tag, 'id')
    if (id !== folderId) continue
    const escapedPath = escapeXmlAttribute(absolutePath)
    const pathPattern = /\bpath=(["'])(.*?)\1/
    const replacement = pathPattern.test(tag)
      ? tag.replace(pathPattern, () => `path="${escapedPath}"`)
      : tag.replace(/>$/, () => ` path="${escapedPath}">`)
    return `${contents.slice(0, match.index)}${replacement}${contents.slice(match.index + tag.length)}`
  }
  return contents
}

export function removeSyncthingFolderXml(contents: string, folderId: string): string {
  for (const match of contents.matchAll(/<folder\b[^>]*>/g)) {
    const tag = match[0]
    if (readXmlAttribute(tag, 'id') !== folderId) continue
    const start = match.index
    if (tag.endsWith('/>')) {
      return `${contents.slice(0, start)}${contents.slice(start + tag.length)}`
    }
    const closingTag = '</folder>'
    const end = contents.indexOf(closingTag, start + tag.length)
    if (end === -1) throw new Error(`Syncthing folder ${folderId} XML is malformed`)
    return `${contents.slice(0, start)}${contents.slice(end + closingTag.length)}`
  }
  return contents
}

function readXmlAttribute(tag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = tag.match(new RegExp(`\\b${escapedName}=(["'])(.*?)\\1`))
  return match === null ? undefined : decodeXmlAttribute(match[2]!)
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function projectShareConfig(input: {
  current: SyncthingConfig
  desired: VmDesiredShareSync
  preparedPaths: Map<string, string>
  errors: Map<string, string>
  bridgeAddresses: Map<string, string>
  mirrorDeviceIds: string[]
}): SyncthingConfig {
  const config = structuredClone(input.current)
  applyHardenedSyncthingOptions(config)
  const mirrorIds = new Set(input.mirrorDeviceIds)
  const existingFolders = Array.isArray(input.current.folders) ? input.current.folders : []
  const desiredPeerIds = new Set<string>()
  const peerAddresses = new Map<string, Set<string>>()
  const folders = input.desired.shares.flatMap(share => {
    if (input.errors.has(share.shareId)) {
      const existing = existingFolders.find(folder => folder.id === share.folder.id)
      if (existing !== undefined) {
        for (const device of existing.devices ?? []) desiredPeerIds.add(device.deviceID)
        return [existing]
      }
      return []
    }
    desiredPeerIds.add(share.folder.peerDeviceId)
    const address = input.bridgeAddresses.get(bridgeId(share))
    if (address !== undefined) {
      const addresses = peerAddresses.get(share.folder.peerDeviceId) ?? new Set<string>()
      addresses.add(address)
      peerAddresses.set(share.folder.peerDeviceId, addresses)
    }
    return [
      {
        id: share.folder.id,
        paused: share.folder.paused,
        label: share.folder.id,
        path: input.preparedPaths.get(share.shareId) ?? share.folder.path,
        type: shareSyncthingFolderType(share.folder.mode, share.folder.role),
        devices: [{ deviceID: share.folder.peerDeviceId }],
        rescanIntervalS: 5,
      },
    ]
  })
  config.folders = [...existingFolders.filter(folder => folder.id === MIRROR_FOLDER_ID), ...folders]
  const existingDevices = Array.isArray(input.current.devices) ? input.current.devices : []
  config.devices = [
    ...existingDevices.filter(device => mirrorIds.has(device.deviceID)),
    ...[...desiredPeerIds].sort().map(deviceID => ({
      deviceID,
      name: deviceID,
      addresses: [...(peerAddresses.get(deviceID) ?? new Set(['dynamic']))],
    })),
  ]
  return config
}

function bridgeId(share: DesiredShare): string {
  return `${share.shareId}:${share.folder.role}:${share.bridge?.acceptId ?? 'none'}`
}

async function allShareRootsRemainSafe(
  driveDir: string,
  shares: readonly DesiredShare[],
): Promise<boolean> {
  const results = await Promise.all(
    shares.map(async share => {
      const normalized = normalizeDrivePath(share.folder.path)
      if (!normalized.ok) return false
      return await assertSafeDirectory(driveDir, join(driveDir, normalized.relativePath)).catch(
        () => false,
      )
    }),
  )
  return results.every(Boolean)
}

function sameMounts(left: SyncedMount[], right: SyncedMount[]): boolean {
  return sameJson(
    [...left].sort((a, b) => a.id.localeCompare(b.id)),
    [...right].sort((a, b) => a.id.localeCompare(b.id)),
  )
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
