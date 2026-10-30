import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

import {
  RESTORE_STALL_MS,
  isPathInside,
  type VmRestoreDescriptor,
  type VmRestoreCommand,
  VmRestoreClaimSchema,
} from '@repo/contract'

import type { FetchLike } from '../runner/process-runner'
import { runSystemCommand, type SystemCommandRunner } from '../system-command'
import { extractBirthSeed } from './birth-seed'
import decoder from './restore-zip.py' with { type: 'text' }

const PENDING_RESTORE_FILE = 'pending-restore.json'
const SYNCTHING_UNIT = 'duet-syncthing.service'
type PendingRestore = VmRestoreDescriptor & { attemptId?: string; installed?: boolean }
type Phase = Extract<VmRestoreCommand, { kind: 'progress' }>['phase']
type Progress = (phase: Phase, bytes: number, entries: number, flush?: boolean) => Promise<void>

export interface RestoreSuppression {
  begin(): void
  end(): void
  emitOne(): void
}

export async function persistPendingRestore(
  stateDir: string,
  descriptor: PendingRestore,
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = resolve(stateDir, PENDING_RESTORE_FILE)
  const previous = JSON.parse(
    await readFile(path, 'utf8').catch(() => 'null'),
  ) as PendingRestore | null
  if (
    previous?.kind === 'workspace-backup' &&
    descriptor.kind === 'workspace-backup' &&
    previous.backupId === descriptor.backupId &&
    previous.sha256 === descriptor.sha256
  ) {
    descriptor = {
      ...descriptor,
      attemptId: descriptor.attemptId ?? previous.attemptId,
      installed: descriptor.installed ?? previous.installed,
    }
  }
  await savePendingRestore(path, descriptor)
}

async function savePendingRestore(path: string, descriptor: PendingRestore): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(descriptor), { mode: 0o600 })
  await chmod(`${path}.tmp`, 0o600)
  await rename(`${path}.tmp`, path)
}

export async function completePendingRestore(args: {
  driveDir: string
  stateDir: string
  fetch: FetchLike
  getVmToken: () => string | null
  extraHeaders: Record<string, string>
  runCommand?: SystemCommandRunner
  suppression?: RestoreSuppression
}): Promise<void> {
  const pending = resolve(args.stateDir, PENDING_RESTORE_FILE)
  const raw = await readFile(pending, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return
  const descriptor = JSON.parse(raw) as PendingRestore
  if (descriptor.kind !== 'workspace-backup' && descriptor.kind !== 'birth-seed')
    throw new Error('Invalid restore descriptor')
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Invalid restore checksum')
  const control = async (kind: 'claim' | 'progress' | 'installed' | 'failed', progress = {}) => {
    if (descriptor.kind !== 'workspace-backup') throw new Error('Invalid restore control request')
    const token = args.getVmToken()
    if (!token) throw new Error('Restore requires VM credentials')
    const response = await args.fetch(descriptor.refreshUrl, {
      method: 'POST',
      headers: {
        ...args.extraHeaders,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind,
        backupId: descriptor.backupId,
        attemptId: descriptor.attemptId,
        ...progress,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Restore ${kind} failed: ${response.status}`)
    return response.json()
  }
  let processedBytes = 0
  let processedEntries = 0
  if (descriptor.kind === 'workspace-backup') {
    descriptor.attemptId ??= randomUUID()
    await persistPendingRestore(args.stateDir, descriptor)
    const claim = VmRestoreClaimSchema.parse(await control('claim'))
    if (claim.status === 'abandoned') {
      await unlink(pending)
      return
    }
    if (claim.status === 'failed') {
      // A lost failed acknowledgement leaves the old identity on disk. This
      // invocation retires it; the ordinary bootstrap retry makes a new claim.
      delete descriptor.attemptId
      await savePendingRestore(pending, descriptor)
      throw new Error('Restore attempt already failed; retry required')
    }
    if (claim.status === 'installed' || descriptor.installed) {
      if (claim.status !== 'installed') await control('installed')
      await unlink(pending)
      args.suppression?.emitOne()
      return
    }
    processedBytes = claim.processedBytes
    processedEntries = claim.processedEntries
  }
  const root = await mkdtemp(resolve(tmpdir(), 'duet-restore-'))
  const abort = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout>
  const advance = () => {
    clearTimeout(stallTimer)
    // Leave the control plane time to receive cleanup settlement before teardown.
    stallTimer = setTimeout(
      () => abort.abort(new Error('Restore made no progress')),
      RESTORE_STALL_MS / 3,
    )
  }
  advance()
  let lastPost = Date.now()
  let lastPhase: Phase | undefined
  const progress: Progress = async (phase, bytes, entries, flush = false) => {
    abort.signal.throwIfAborted()
    if (bytes > 0 || entries > 0) advance()
    processedBytes += bytes
    processedEntries += entries
    if (descriptor.kind !== 'workspace-backup') return
    if (!flush && lastPhase === phase && Date.now() - lastPost < 10_000) return
    await control('progress', { phase, processedBytes, processedEntries })
    lastPost = Date.now()
    lastPhase = phase
  }
  args.suppression?.begin()
  let failure: unknown
  try {
    const archive = resolve(root, 'download')
    let url: string
    if (descriptor.kind === 'birth-seed') url = descriptor.url
    else {
      if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0)
        throw new Error('Invalid restore size')
      const disk = await statfs(root)
      if (disk.bavail * disk.bsize < descriptor.bytes + 16 * 1024 * 1024)
        throw new Error('restore_insufficient_disk_space')
      let grant = descriptor.download
      if (!grant || grant.expiresAt <= Date.now()) {
        const token = args.getVmToken()
        if (!token) throw new Error('Restore requires VM credentials')
        const refreshed = await args.fetch(descriptor.refreshUrl, {
          headers: { ...args.extraHeaders, authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        })
        if (!refreshed.ok) throw new Error(`Restore grant refresh failed: ${refreshed.status}`)
        grant = (await refreshed.json()) as { url: string; expiresAt: number }
      }
      if (!grant.url || grant.expiresAt <= Date.now())
        throw new Error('Invalid restore download grant')
      url = grant.url
    }
    const response = await args.fetch(url, {
      redirect: 'error',
      signal: abort.signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Restore download failed: ${response.status}`)
    }
    const file = await open(archive, 'wx', 0o600).catch(async error => {
      await response.body!.cancel()
      throw error
    })
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let bytes = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        bytes += item.value.byteLength
        if (descriptor.kind === 'workspace-backup' && bytes > descriptor.bytes)
          throw new Error('Restore size mismatch')
        hash.update(item.value)
        let offset = 0
        while (offset < item.value.byteLength) {
          const written = await file.write(item.value.subarray(offset))
          if (written.bytesWritten === 0) throw new Error('Restore write made no progress')
          offset += written.bytesWritten
          await progress('download', written.bytesWritten, 0)
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      await file.close()
    }
    if (
      (descriptor.kind === 'workspace-backup' && bytes !== descriptor.bytes) ||
      hash.digest('hex') !== descriptor.sha256
    )
      throw new Error('Restore checksum or size mismatch')
    await progress('download', 0, 0, true)
    await mkdir(args.driveDir, { recursive: true })
    if (descriptor.kind === 'birth-seed')
      await extractBirthSeed(new Uint8Array(await readFile(archive)), root)
    else {
      const child = Bun.spawn(['python3', '-c', decoder, archive, root, args.driveDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const kill = () => child.kill()
      abort.signal.addEventListener('abort', kill, { once: true })
      const stderr = new Response(child.stderr).text()
      try {
        const reader = child.stdout.getReader()
        const text = new TextDecoder()
        let buffered = ''
        let previousBytes = 0
        let previousEntries = 0
        try {
          while (true) {
            const item = await reader.read()
            if (item.done) break
            buffered += text.decode(item.value, { stream: true })
            const lines = buffered.split('\n')
            buffered = lines.pop()!
            if (buffered.length > 4096) throw new Error('Invalid restore progress record')
            for (const line of lines) {
              if (line.length > 4096) throw new Error('Invalid restore progress record')
              const record = JSON.parse(line) as { phase: Phase; bytes: number; entries: number }
              if (
                !['index', 'extract'].includes(record.phase) ||
                !Number.isSafeInteger(record.bytes) ||
                record.bytes < previousBytes ||
                !Number.isSafeInteger(record.entries) ||
                record.entries < previousEntries
              )
                throw new Error('Invalid restore progress record')
              await progress(
                record.phase,
                record.bytes - previousBytes,
                record.entries - previousEntries,
                true,
              )
              previousBytes = record.bytes
              previousEntries = record.entries
            }
          }
        } finally {
          reader.releaseLock()
        }
        if ((await child.exited) !== 0) throw new Error((await stderr).trim())
        abort.signal.throwIfAborted()
      } finally {
        child.kill()
        await child.exited
        await stderr
        abort.signal.removeEventListener('abort', kill)
      }
    }
    const run = args.runCommand ?? runSystemCommand
    await run(['sudo', '-n', 'systemctl', 'stop', SYNCTHING_UNIT]).catch(() => undefined)
    try {
      await restoreExtractedEntry(root, 'drive', args.driveDir, progress, async () => {
        if (descriptor.kind === 'workspace-backup') {
          await persistPendingRestore(args.stateDir, { ...descriptor, installed: true })
          descriptor.installed = true
        }
      })
    } finally {
      await run(['sudo', '-n', 'systemctl', 'start', SYNCTHING_UNIT]).catch(() => undefined)
    }
  } catch (error) {
    failure = error
  } finally {
    await removeRestoreTree(root, failure ? undefined : progress).catch(error => {
      failure ??= error
    })
    clearTimeout(stallTimer!)
    abort.abort()
    args.suppression?.end()
  }
  if (failure) {
    if (descriptor.kind === 'workspace-backup' && !descriptor.installed) {
      try {
        await control('failed')
        delete descriptor.attemptId
        await savePendingRestore(pending, descriptor)
      } catch {
        /* Retain the identity until settlement can be retried. */
      }
    }
    throw failure
  }
  if (descriptor.kind === 'workspace-backup') await control('installed')
  await unlink(pending)
  args.suppression?.emitOne()
}
async function restoreExtractedEntry(
  restoreRoot: string,
  entryName: string,
  targetDir: string,
  progress: Progress,
  installed: () => Promise<void>,
): Promise<void> {
  const source = resolve(restoreRoot, entryName)
  const info = await lstat(source).catch(() => null)
  if (info === null) return
  if (info.isSymbolicLink()) {
    throw new Error(`archive restore rejected unsafe entry: ${entryName}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`archive restore rejected unsafe entry: ${entryName}`)
  }
  const sourceReal = await realpath(source)
  if (!isPathInside(await realpath(restoreRoot), sourceReal)) {
    throw new Error(`archive restore rejected unsafe entry: ${entryName}`)
  }
  await mkdir(dirname(targetDir), { recursive: true })
  const targetInfo = await lstat(targetDir).catch(() => null)
  if (targetInfo !== null && (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())) {
    throw new Error(`archive restore rejected unsafe target: ${entryName}`)
  }
  if (targetInfo === null) {
    await mkdir(targetDir, { mode: 0o700 })
  }

  // VM drives are mounted at the drive root, so replacing that directory
  // itself fails with EBUSY. The archive is extracted under /tmp, which can
  // also be a different filesystem from the mount. Stage a complete copy
  // inside the target filesystem before the destructive window, then preserve
  // the root inode and swap only same-filesystem children.
  const stagingDir = await mkdtemp(resolve(targetDir, '.duet-restore-stage-'))
  const stagingName = basename(stagingDir)
  const restoredDirectories: RestoredDirectoryMetadata[] = []
  try {
    await copyDirectoryContents(source, stagingDir, [], restoredDirectories, progress)
    // Keep old children on the same mount until every replacement rename has
    // succeeded. Roll back a failed swap rather than leaving a partial Drive.
    const rollbackDir = await mkdtemp(resolve(targetDir, '.duet-restore-old-'))
    const movedOld: string[] = []
    const movedNew: string[] = []
    try {
      for (const child of await readdir(targetDir)) {
        if (child === stagingName || child === basename(rollbackDir)) continue
        await rename(resolve(targetDir, child), resolve(rollbackDir, child))
        movedOld.push(child)
        await progress('install', 0, 1)
      }
      for (const child of await readdir(stagingDir)) {
        await rename(resolve(stagingDir, child), resolve(targetDir, child))
        movedNew.push(child)
        await progress('install', 0, 1)
      }
      for (const directory of restoredDirectories) {
        const path = resolve(targetDir, ...directory.pathSegments)
        await chmod(path, directory.mode)
        await utimes(path, directory.atime, directory.mtime)
      }
      await installed()
    } catch (error) {
      for (const child of movedNew.reverse()) {
        const path = resolve(targetDir, child)
        const info = await lstat(path)
        if (info.isDirectory()) await chmod(path, (info.mode & 0o7777) | 0o700)
        await rename(path, resolve(stagingDir, child))
      }
      for (const child of movedOld.reverse())
        await rename(resolve(rollbackDir, child), resolve(targetDir, child))
      throw error
    }
    await removeRestoreTree(rollbackDir, progress)
    await progress('install', 0, 0, true)
  } finally {
    await removeRestoreTree(stagingDir)
  }
  if (targetInfo === null) {
    await chmod(targetDir, info.mode & 0o7777)
    await utimes(targetDir, info.atime, info.mtime)
  }
}

interface RestoredDirectoryMetadata {
  pathSegments: string[]
  mode: number
  atime: Date
  mtime: Date
}

async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  pathSegments: string[],
  restoredDirectories: RestoredDirectoryMetadata[],
  progress: Progress,
): Promise<void> {
  await chmod(sourceDir, (await lstat(sourceDir)).mode | 0o700)
  for (const child of await readdir(sourceDir)) {
    await copyExtractedEntry(
      resolve(sourceDir, child),
      resolve(targetDir, child),
      [...pathSegments, child],
      restoredDirectories,
      progress,
    )
  }
}

async function copyExtractedEntry(
  source: string,
  target: string,
  pathSegments: string[],
  restoredDirectories: RestoredDirectoryMetadata[],
  progress: Progress,
): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    await lutimes(target, info.atime, info.mtime)
    await progress('install', 0, 1)
    return
  }
  if (info.isFile()) {
    await chmod(source, info.mode | 0o400)
    const input = await open(source, 'r')
    try {
      const output = await open(target, 'wx', 0o600)
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        while (true) {
          const { bytesRead } = await input.read(buffer)
          if (!bytesRead) break
          let offset = 0
          while (offset < bytesRead) {
            const { bytesWritten } = await output.write(buffer.subarray(offset, bytesRead))
            if (!bytesWritten) throw new Error('Restore install made no progress')
            offset += bytesWritten
            await progress('install', bytesWritten, 0)
          }
        }
      } finally {
        await output.close()
      }
    } finally {
      await input.close()
    }
    await chmod(target, info.mode & 0o7777)
    await utimes(target, info.atime, info.mtime)
    await progress('install', 0, 1)
    return
  }
  if (!info.isDirectory()) {
    throw new Error(`archive restore rejected unsafe entry: ${source}`)
  }

  // Populate with owner-write first; archived directories can be read-only.
  await mkdir(target, { mode: 0o700 })
  await copyDirectoryContents(source, target, pathSegments, restoredDirectories, progress)
  restoredDirectories.push({
    pathSegments,
    mode: info.mode & 0o7777,
    atime: info.atime,
    mtime: info.mtime,
  })
}

// Scratch trees can carry archived read-only permissions. Relax only disposable
// directories, without following archived links, so cleanup can remove children.
async function removeRestoreTree(path: string, progress?: Progress): Promise<void> {
  let reportError: unknown
  async function remove(path: string): Promise<void> {
    const info = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return
    if (info.isDirectory()) {
      await chmod(path, info.mode | 0o700)
      for (const child of await readdir(path)) await remove(resolve(path, child))
    }
    await rm(path, { recursive: true, force: true })
    try {
      await progress?.('install', 0, 1)
    } catch (error) {
      // Dispose the whole tree before surfacing a control-plane failure. Once
      // reporting fails, the remaining entries must not each retry the network.
      reportError = error
      progress = undefined
    }
  }
  await remove(path)
  if (reportError) throw reportError
}
