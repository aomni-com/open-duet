import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { SkillsBundleSchema, type VmSyncResponse } from '@repo/contract'

import { withFileLock } from './file-lock'

export type SkillsDescriptor = NonNullable<VmSyncResponse['skills']>
export type SkillsFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SkillsInstallOperations {
  writeSyncedFile(path: string, data: Uint8Array, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  symlink(target: string, path: string): Promise<void>
  unlink(path: string): Promise<void>
  fsyncDir(path: string): Promise<void>
}

export interface InstallSkillsInput {
  homeDir: string
  descriptor: SkillsDescriptor
  token: string
  fetch: SkillsFetch
  extraHeaders?: Record<string, string>
  operations?: Partial<SkillsInstallOperations>
  log?: (fields: Record<string, unknown>) => void
}

const installQueues = new Map<string, Promise<void>>()
const SKILLS_WRITE_CONCURRENCY = 8

export interface SkillsInstallGate {
  track(hash: string, start: () => Promise<void>): Promise<void>
  wait(): Promise<void>
}

export function createSkillsInstallGate(
  options: { waitForFirstTrack?: boolean } = {},
): SkillsInstallGate {
  let current: {
    hash: string
    operation: Promise<void>
    status: 'pending' | 'fulfilled' | 'rejected'
  } | null = null
  let releaseFirstTrack!: () => void
  const firstTrack =
    options.waitForFirstTrack === true
      ? new Promise<void>(resolve => {
          releaseFirstTrack = resolve
        })
      : Promise.resolve()
  let firstTracked = options.waitForFirstTrack !== true
  return {
    track(hash, start) {
      if (current?.hash === hash && current.status !== 'rejected') return current.operation
      const operation = start()
      const tracked: NonNullable<typeof current> = { hash, operation, status: 'pending' }
      current = tracked
      if (!firstTracked) {
        firstTracked = true
        releaseFirstTrack()
      }
      // Runner starts await the original promise so failures remain visible.
      // This observer prevents an unhandled rejection when no start is waiting
      // and marks a failure so the next sync carrying the same hash can retry.
      void operation.then(
        () => {
          tracked.status = 'fulfilled'
        },
        () => {
          tracked.status = 'rejected'
        },
      )
      return operation
    },
    async wait() {
      await firstTrack
      for (;;) {
        const observed = current
        if (observed === null) return
        await observed.operation
        if (current === observed) return
      }
    },
  }
}

export async function installSkills(input: InstallSkillsInput): Promise<void> {
  const stateDir = resolve(input.homeDir, '.duet')
  const lockPath = join(stateDir, '.skills-install.lock')
  await withInstallLock(lockPath, async () => await installSkillsLocked(input, stateDir))
}

async function installSkillsLocked(input: InstallSkillsInput, stateDir: string): Promise<void> {
  const hash = validateHash(input.descriptor.hash)
  const releasesDir = join(stateDir, 'skill-releases')
  const activeLink = join(stateDir, 'skills')
  const stampPath = join(stateDir, '.skills-hash')
  const stampedHash = await readStamp(stampPath)
  const releaseDir = releaseDirForHash(releasesDir, hash)
  const operations = installOperations(input.operations)

  // Archives omit reinstallable releases, so a stamp is current only while its
  // release directory exists. Otherwise the verified download rebuilds the tree.
  if (stampedHash === hash && (await isDirectory(releaseDir))) {
    if ((await symlinkTarget(activeLink)) !== resolve(releaseDir)) {
      await repointSymlink(activeLink, releaseDir, operations)
    }
    await repairLinkFarms(input, activeLink)
    return
  }

  const response = await input.fetch(input.descriptor.url, {
    headers: { ...input.extraHeaders, authorization: `Bearer ${input.token}` },
  })
  if (!response.ok) throw new Error(`skills bundle download failed with HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (actualHash !== hash) {
    throw new Error(`skills bundle sha256 mismatch: expected ${hash}, got ${actualHash}`)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new Error(`skills bundle is not valid JSON: ${errorMessage(error)}`)
  }
  const bundle = SkillsBundleSchema.parse(decoded)
  await mkdir(releasesDir, { recursive: true, mode: 0o700 })

  if (!(await isDirectory(releaseDir))) {
    const stagedDir = join(releasesDir, `.${hash}.partial-${process.pid}-${Date.now()}`)
    await rm(stagedDir, { recursive: true, force: true })
    try {
      await mkdir(stagedDir, { recursive: true, mode: 0o755 })
      await forEachBounded(bundle.files, SKILLS_WRITE_CONCURRENCY, async file => {
        const destination = safeBundleDestination(stagedDir, file.path)
        await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
        await operations.writeSyncedFile(destination, Buffer.from(file.content), 0o644)
      })
      await fsyncTreeDirectories(stagedDir, operations)
      await operations.rename(stagedDir, releaseDir)
      await operations.fsyncDir(releasesDir)
    } catch (error) {
      await rm(stagedDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  const previousTarget = await symlinkTarget(activeLink)
  const previousStamp = stampedHash
  let swapped = false
  try {
    await repointSymlink(activeLink, releaseDir, operations)
    swapped = true
    await writeStamp(stampPath, hash, operations)
    await repairLinkFarms(input, activeLink)
  } catch (error) {
    if (swapped) {
      if (previousTarget === null) await operations.unlink(activeLink).catch(() => undefined)
      else await repointSymlink(activeLink, previousTarget, operations).catch(() => undefined)
      if (previousStamp === null) await rm(stampPath, { force: true }).catch(() => undefined)
      else await writeStamp(stampPath, previousStamp, operations).catch(() => undefined)
    }
    throw error
  }
  await pruneReleases(releasesDir, releaseDir, previousTarget).catch(error =>
    input.log?.({
      operation: 'skills_prune',
      status: 'failed',
      error: errorMessage(error),
    }),
  )
}

async function repairLinkFarms(input: InstallSkillsInput, activeLink: string): Promise<void> {
  const entries = await readdir(activeLink, { withFileTypes: true })
  const skillNames = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  const operations = installOperations(input.operations)
  for (const root of ['.claude', '.agents']) {
    const farmDir = join(input.homeDir, root, 'skills')
    await mkdir(farmDir, { recursive: true, mode: 0o755 })
    for (const skillName of skillNames) {
      const linkPath = join(farmDir, skillName)
      const target = join(activeLink, skillName)
      const existing = await lstat(linkPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (existing === null) {
        await repointSymlink(linkPath, target, operations)
        continue
      }
      if (
        existing.isSymbolicLink() &&
        isManagedLinkTarget(linkPath, await readlink(linkPath), activeLink)
      ) {
        if (resolve(dirname(linkPath), await readlink(linkPath)) !== resolve(target)) {
          await repointSymlink(linkPath, target, operations)
        }
        continue
      }
      input.log?.({
        operation: 'skills_link_farm',
        status: 'preserved_user_path',
        path: linkPath,
      })
    }
  }
}

function isManagedLinkTarget(linkPath: string, target: string, activeLink: string): boolean {
  const resolvedTarget = resolve(dirname(linkPath), target)
  const managedRoot = resolve(activeLink)
  return resolvedTarget === managedRoot || resolvedTarget.startsWith(`${managedRoot}${sep}`)
}

async function repointSymlink(
  linkPath: string,
  target: string,
  operations: SkillsInstallOperations,
): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true, mode: 0o755 })
  const partial = join(
    dirname(linkPath),
    `.${basename(linkPath)}.partial-${process.pid}-${Date.now()}`,
  )
  await operations.unlink(partial).catch(() => undefined)
  try {
    await operations.symlink(target, partial)
    await operations.rename(partial, linkPath)
    await operations.fsyncDir(dirname(linkPath))
  } catch (error) {
    await operations.unlink(partial).catch(() => undefined)
    throw error
  }
}

async function writeStamp(
  stampPath: string,
  hash: string,
  operations: SkillsInstallOperations,
): Promise<void> {
  const partial = `${stampPath}.partial-${process.pid}-${Date.now()}`
  try {
    await operations.writeSyncedFile(partial, Buffer.from(`${hash}\n`), 0o600)
    await operations.rename(partial, stampPath)
    await operations.fsyncDir(dirname(stampPath))
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined)
    throw error
  }
}

async function pruneReleases(
  releasesDir: string,
  activeRelease: string,
  previousRelease: string | null,
): Promise<void> {
  const keep = new Set([resolve(activeRelease)])
  if (previousRelease !== null) keep.add(resolve(previousRelease))
  const entries = await readdir(releasesDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async entry => {
        const path = resolve(releasesDir, entry.name)
        if (!keep.has(path)) await rm(path, { recursive: true, force: true })
      }),
  )
}

async function withInstallLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(lockPath)
  const previous = installQueues.get(key) ?? Promise.resolve()
  let releaseTurn!: () => void
  const turn = new Promise<void>(resolveTurn => {
    releaseTurn = resolveTurn
  })
  const tail = previous.then(() => turn)
  installQueues.set(key, tail)
  await previous
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    return await withFileLock(lockPath, action)
  } finally {
    releaseTurn()
    if (installQueues.get(key) === tail) installQueues.delete(key)
  }
}

function validateHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid skills bundle hash')
  return hash
}

function releaseDirForHash(releasesDir: string, hash: string): string {
  const root = resolve(releasesDir)
  const releaseDir = resolve(root, validateHash(hash))
  if (releaseDir.startsWith(`${root}${sep}`)) return releaseDir
  throw new Error('invalid skills bundle hash')
}

function safeBundleDestination(stagedDir: string, path: string): string {
  const root = resolve(stagedDir)
  const destination = resolve(root, path)
  if (destination.startsWith(`${root}${sep}`)) return destination
  throw new Error(`unsafe skills bundle path: ${path}`)
}

async function readStamp(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function symlinkTarget(path: string): Promise<string | null> {
  try {
    return resolve(dirname(path), await readlink(path))
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'EINVAL'
    )
      return null
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return await lstat(path)
    .then(value => value.isDirectory())
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
}

async function fsyncTreeDirectories(
  root: string,
  operations: SkillsInstallOperations,
): Promise<void> {
  const directories: string[] = [root]
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(join(directory, entry.name))
    }
  }
  for (const directory of directories.reverse()) await operations.fsyncDir(directory)
}

async function forEachBounded<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed = false
  let failure: unknown
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed) {
      const index = next
      next += 1
      if (index >= values.length) return
      try {
        await action(values[index]!)
      } catch (error) {
        failed = true
        failure = error
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw failure
}

async function writeSyncedFile(path: string, data: Uint8Array, mode: number): Promise<void> {
  const file = await open(path, 'w', mode)
  try {
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function fsyncDir(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function installOperations(
  overrides: Partial<SkillsInstallOperations> | undefined,
): SkillsInstallOperations {
  return {
    writeSyncedFile,
    rename,
    symlink,
    unlink,
    fsyncDir,
    ...overrides,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
