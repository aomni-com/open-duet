import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import {
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  RUNTIME_RELEASE_MANIFEST_FILE,
  RuntimeReleaseManifestSchema,
  RuntimeReleaseDescriptorSchema,
  canonicalRuntimeReleaseIdentityInput,
  type RuntimeReleaseManifest,
  type RuntimeReleaseDescriptor,
} from '@repo/contract'

import { withFileLock } from './file-lock'

export const RUNTIME_RELEASE_LOCK_FILE = '.runtime-release.lock'
export const DEFAULT_RELEASES_DIR = '/opt/duet/releases'
export const DEFAULT_CURRENT_RELEASE_LINK = '/opt/duet/current'
export const DEFAULT_PREVIOUS_RELEASE_LINK = '/opt/duet/previous'

export interface ReleaseInspectionFailure {
  artifact: string
  reason: string
}

export type ReleaseInspection =
  | { ok: true; version: string }
  | { ok: false; failures: ReleaseInspectionFailure[] }

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface EnsureBootableCurrentInput {
  releasesDir: string
  currentReleaseLink: string
  previousReleaseLink: string
  apiUrl?: string
  token: string | null
  fetch: FetchLike
  extraHeaders?: Record<string, string>
  quarantinedVersion?: string
  adoptedVersionThisBoot?: string
  recordAdopted?: (version: string) => Promise<void>
  operations?: Partial<RuntimeReleaseOperations>
}

export interface RuntimeReleaseOperations {
  writeSyncedFile(path: string, data: Uint8Array, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  fsyncDir(path: string): Promise<void>
  symlink(target: string, path: string): Promise<void>
  unlink(path: string): Promise<void>
}

export type EnsureBootableCurrentResult =
  | { status: 'healthy' | 'repaired' | 'adopted' | 'rolled_back'; version: string }
  | { status: 'retryable_failure'; error: string }

const releaseQueues = new Map<string, Promise<void>>()

export async function ensureBootableCurrent(
  input: EnsureBootableCurrentInput,
): Promise<EnsureBootableCurrentResult> {
  return await withReleaseLock(
    input.releasesDir,
    async () => await ensureBootableCurrentLocked(input),
  )
}

async function ensureBootableCurrentLocked(
  input: EnsureBootableCurrentInput,
): Promise<EnsureBootableCurrentResult> {
  const currentDir = await releaseLinkTarget(input.currentReleaseLink)
  let recoveryError = 'current runtime release is not bootable'
  let currentInspection: ReleaseInspection | null = null
  if (currentDir !== null) {
    currentInspection = await inspectRelease(currentDir)
    if (currentInspection.ok && currentInspection.version !== input.quarantinedVersion) {
      return { status: 'healthy', version: currentInspection.version }
    }
    if (currentInspection.ok) {
      recoveryError = `runtime release ${currentInspection.version} is quarantined`
    }
  }
  const mayFetch = input.apiUrl !== undefined && input.token !== null
  if (mayFetch) {
    try {
      const manifest = await fetchManifest(input)
      if (input.quarantinedVersion === manifest.version) {
        throw new Error(`runtime release ${manifest.version} is quarantined`)
      }
      const localVersion =
        currentDir === null
          ? null
          : ((await readLocalManifestVersion(currentDir)) ?? basename(currentDir))
      if (
        currentDir !== null &&
        currentInspection !== null &&
        !currentInspection.ok &&
        localVersion === manifest.version
      ) {
        await repairRelease(currentDir, manifest, currentInspection.failures, input)
        const repaired = await inspectRelease(currentDir)
        if (repaired.ok) return { status: 'repaired', version: repaired.version }
        throw new Error(formatInspectionFailure(repaired))
      }
      if (input.adoptedVersionThisBoot === manifest.version) {
        throw new Error(`runtime release ${manifest.version} is blocked for this boot`)
      }
      const verifiedPreviousDir = await verifiedReleaseLinkTarget(
        input.previousReleaseLink,
        input.quarantinedVersion,
      )
      const installedDir = await installRuntimeRelease({ ...input, manifest })
      await retainCurrentAndPreviousRelease({
        releasesDir: input.releasesDir,
        currentReleaseDir: installedDir,
        previousReleaseDir: verifiedPreviousDir,
      })
      await activateRelease({
        currentReleaseLink: input.currentReleaseLink,
        previousReleaseLink: input.previousReleaseLink,
        releaseDir: installedDir,
        previousReleaseDir: verifiedPreviousDir,
        operations: input.operations,
      })
      await input.recordAdopted?.(manifest.version)
      return { status: 'adopted', version: manifest.version }
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : String(error)
    }
  }
  const previousDir = await releaseLinkTarget(input.previousReleaseLink)
  if (previousDir !== null) {
    const previous = await inspectRelease(previousDir)
    if (previous.ok && previous.version !== input.quarantinedVersion) {
      await activateRelease({
        currentReleaseLink: input.currentReleaseLink,
        previousReleaseLink: input.previousReleaseLink,
        releaseDir: previousDir,
        previousReleaseDir: null,
        operations: input.operations,
      })
      return { status: 'rolled_back', version: previous.version }
    }
  }
  return { status: 'retryable_failure', error: recoveryError }
}

export async function applyRuntimeRelease(
  input: EnsureBootableCurrentInput & {
    desiredVersion: string
    descriptor?: RuntimeReleaseDescriptor
    activateIfCurrent?: (activate: () => Promise<void>) => Promise<boolean>
  },
): Promise<string | null> {
  return await withReleaseLock(input.releasesDir, async () => {
    const previousReleaseDir =
      (await verifiedReleaseLinkTarget(input.currentReleaseLink)) ??
      (await verifiedReleaseLinkTarget(input.previousReleaseLink))
    const installedReleaseDir = await installRuntimeRelease(input)
    const activate = async () => {
      await retainCurrentAndPreviousRelease({
        releasesDir: input.releasesDir,
        currentReleaseDir: installedReleaseDir,
        previousReleaseDir,
      })
      await activateRelease({
        currentReleaseLink: input.currentReleaseLink,
        previousReleaseLink: input.previousReleaseLink,
        releaseDir: installedReleaseDir,
        previousReleaseDir,
        operations: input.operations,
      })
    }
    if (input.activateIfCurrent === undefined) await activate()
    else if (!(await input.activateIfCurrent(activate))) return null
    return installedReleaseDir
  })
}

async function withReleaseLock<T>(releasesDir: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(releasesDir)
  const previous = releaseQueues.get(key) ?? Promise.resolve()
  let releaseQueue!: () => void
  const turn = new Promise<void>(resolveTurn => {
    releaseQueue = resolveTurn
  })
  const tail = previous.then(() => turn)
  releaseQueues.set(key, tail)
  await previous
  try {
    await mkdir(releasesDir, { recursive: true, mode: 0o755 })
    const lockPath = join(releasesDir, RUNTIME_RELEASE_LOCK_FILE)
    return await withFileLock(lockPath, action)
  } finally {
    releaseQueue()
    if (releaseQueues.get(key) === tail) releaseQueues.delete(key)
  }
}

async function installRuntimeRelease(
  input: EnsureBootableCurrentInput & {
    manifest?: RuntimeReleaseManifest
    desiredVersion?: string
    descriptor?: RuntimeReleaseDescriptor
  },
): Promise<string> {
  const manifest =
    input.manifest ??
    (input.descriptor === undefined
      ? await fetchManifest(input)
      : manifestFromDescriptor(input.descriptor))
  if (input.desiredVersion !== undefined && manifest.version !== input.desiredVersion) {
    throw new Error(
      `runtime release manifest version ${manifest.version} did not match desired ${input.desiredVersion}`,
    )
  }
  const releaseDir = releaseDirForVersion(input.releasesDir, manifest.version)
  const operations = releaseOperations(input.operations)
  await mkdir(releaseDir, { recursive: true, mode: 0o755 })
  await cleanupPartialFiles(releaseDir)
  const partials: string[] = []
  try {
    for (const artifact of manifest.artifacts) {
      const announcedArtifact = input.descriptor?.artifacts.find(
        item => item.name === artifact.name,
      )
      const response = await input.fetch(
        announcedArtifact?.href ?? artifactUrl(input, artifact.name),
        { headers: authenticatedHeaders(input) },
      )
      if (!response.ok) {
        throw new Error(`runtime release ${artifact.name} failed with HTTP ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      verifyArtifactBytes(bytes, artifact)
      const partial = join(releaseDir, `${artifact.name}.partial`)
      partials.push(partial)
      await operations.writeSyncedFile(partial, bytes, artifact.mode)
    }
    const manifestPartial = join(releaseDir, `${RUNTIME_RELEASE_MANIFEST_FILE}.partial`)
    partials.push(manifestPartial)
    await operations.writeSyncedFile(
      manifestPartial,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      0o644,
    )
    for (const artifact of manifest.artifacts) {
      await operations.rename(
        join(releaseDir, `${artifact.name}.partial`),
        join(releaseDir, artifact.name),
      )
      await operations.chmod(join(releaseDir, artifact.name), artifact.mode)
    }
    await operations.rename(manifestPartial, join(releaseDir, RUNTIME_RELEASE_MANIFEST_FILE))
    await operations.fsyncDir(releaseDir)
    const inspection = await inspectRelease(releaseDir)
    if (!inspection.ok) throw new Error(formatInspectionFailure(inspection))
    return releaseDir
  } catch (error) {
    await Promise.all(partials.map(path => rm(path, { force: true }).catch(() => undefined)))
    throw error
  }
}

function manifestFromDescriptor(descriptor: RuntimeReleaseDescriptor): RuntimeReleaseManifest {
  return parseManifest(RuntimeReleaseDescriptorSchema.parse(descriptor))
}

async function activateRelease(input: {
  currentReleaseLink: string
  previousReleaseLink: string
  releaseDir: string
  previousReleaseDir: string | null
  operations?: Partial<RuntimeReleaseOperations>
}): Promise<void> {
  if (
    input.previousReleaseDir !== null &&
    resolve(input.previousReleaseDir) !== resolve(input.releaseDir)
  ) {
    await repointReleaseLink(input.previousReleaseLink, input.previousReleaseDir, input.operations)
  }
  await repointReleaseLink(input.currentReleaseLink, input.releaseDir, input.operations)
}

async function repointReleaseLink(
  link: string,
  target: string,
  overrides?: Partial<RuntimeReleaseOperations>,
): Promise<void> {
  const operations = releaseOperations(overrides)
  await mkdir(dirname(link), { recursive: true, mode: 0o755 })
  const partial = resolve(dirname(link), `.${basename(link)}.partial-${process.pid}-${Date.now()}`)
  await operations.unlink(partial).catch(() => undefined)
  try {
    await operations.symlink(target, partial)
    await operations.rename(partial, link)
    await operations.fsyncDir(dirname(link))
  } catch (error) {
    await operations.unlink(partial).catch(() => undefined)
    throw error
  }
}

async function retainCurrentAndPreviousRelease(input: {
  releasesDir: string
  currentReleaseDir: string
  previousReleaseDir: string | null
}): Promise<void> {
  const keep = new Set([resolve(input.currentReleaseDir)])
  if (input.previousReleaseDir !== null) keep.add(resolve(input.previousReleaseDir))
  const entries = await readdir(input.releasesDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && entry.name !== RUNTIME_RELEASE_LOCK_FILE)
      .map(async entry => {
        const path = resolve(input.releasesDir, entry.name)
        if (!keep.has(path)) await rm(path, { recursive: true, force: true })
      }),
  )
}

function releaseDirForVersion(releasesDir: string, version: string): string {
  if (version.includes('/') || version.includes('\\') || version === '.' || version === '..') {
    throw new Error('invalid runtime release version')
  }
  const root = resolve(releasesDir)
  const releaseDir = resolve(root, version)
  if (releaseDir !== root && releaseDir.startsWith(`${root}${sep}`)) return releaseDir
  throw new Error('invalid runtime release version')
}

async function fetchManifest(input: EnsureBootableCurrentInput): Promise<RuntimeReleaseManifest> {
  const response = await input.fetch(
    `${input.apiUrl!.replace(/\/+$/g, '')}/v1/vm/runtime-release/manifest`,
    { headers: authenticatedHeaders(input) },
  )
  if (!response.ok) {
    throw new Error(`runtime release manifest failed with HTTP ${response.status}`)
  }
  return parseManifest(await response.json())
}

function authenticatedHeaders(input: EnsureBootableCurrentInput): Record<string, string> {
  return { ...input.extraHeaders, authorization: `Bearer ${input.token}` }
}

async function readLocalManifestVersion(dir: string): Promise<string | null> {
  try {
    return parseManifest(
      JSON.parse(await readFile(join(dir, RUNTIME_RELEASE_MANIFEST_FILE), 'utf8')),
    ).version
  } catch {
    return null
  }
}

async function repairRelease(
  dir: string,
  manifest: RuntimeReleaseManifest,
  failures: ReleaseInspectionFailure[],
  input: EnsureBootableCurrentInput,
): Promise<void> {
  const operations = releaseOperations(input.operations)
  await cleanupPartialFiles(dir)
  if (failures.some(failure => failure.artifact === RUNTIME_RELEASE_MANIFEST_FILE)) {
    const partial = join(dir, `${RUNTIME_RELEASE_MANIFEST_FILE}.partial`)
    try {
      await operations.writeSyncedFile(
        partial,
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        0o644,
      )
      await operations.rename(partial, join(dir, RUNTIME_RELEASE_MANIFEST_FILE))
      await operations.fsyncDir(dir)
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      throw error
    }
  }
  const artifactFailures: ReleaseInspectionFailure[] = []
  for (const artifact of manifest.artifacts) {
    await inspectArtifact(dir, artifact, artifactFailures)
  }
  for (const failure of artifactFailures) {
    const descriptor = manifest.artifacts.find(artifact => artifact.name === failure.artifact)!
    const response = await input.fetch(artifactUrl(input, descriptor.name), {
      headers: authenticatedHeaders(input),
    })
    if (!response.ok) {
      throw new Error(`runtime release ${failure.artifact} failed with HTTP ${response.status}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    verifyArtifactBytes(bytes, descriptor)
    const partial = join(dir, `${failure.artifact}.partial`)
    try {
      await operations.writeSyncedFile(partial, bytes, descriptor.mode)
      await operations.rename(partial, join(dir, failure.artifact))
      await operations.fsyncDir(dir)
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

async function cleanupPartialFiles(dir: string): Promise<void> {
  await Promise.all(
    [...RUNTIME_RELEASE_ARTIFACT_NAMES, RUNTIME_RELEASE_MANIFEST_FILE].map(
      async artifact => await rm(join(dir, `${artifact}.partial`), { force: true }),
    ),
  )
}

function artifactUrl(input: EnsureBootableCurrentInput, name: string): string {
  return `${input.apiUrl!.replace(/\/+$/g, '')}/v1/vm/runtime-release/artifacts/${encodeURIComponent(name)}`
}

function verifyArtifactBytes(
  bytes: Uint8Array,
  artifact: RuntimeReleaseManifest['artifacts'][number],
): void {
  if (bytes.byteLength !== artifact.byteLength) {
    throw new Error(
      `runtime release ${artifact.name} byte length mismatch: expected ${artifact.byteLength}, got ${bytes.byteLength}`,
    )
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `runtime release ${artifact.name} sha256 mismatch: expected ${artifact.sha256}, got ${actualSha256}`,
    )
  }
}

async function writeSyncedFile(path: string, data: Uint8Array, mode: number): Promise<void> {
  const file = await open(path, 'w', mode)
  try {
    await file.writeFile(data)
    await file.chmod(mode)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function fsyncDir(path: string): Promise<void> {
  const dir = await open(path, 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

function releaseOperations(
  overrides: Partial<RuntimeReleaseOperations> | undefined,
): RuntimeReleaseOperations {
  return {
    writeSyncedFile,
    rename,
    chmod,
    fsyncDir,
    symlink,
    unlink,
    ...overrides,
  }
}

function formatInspectionFailure(inspection: Extract<ReleaseInspection, { ok: false }>): string {
  return inspection.failures.map(failure => `${failure.artifact}: ${failure.reason}`).join('; ')
}

async function releaseLinkTarget(link: string): Promise<string | null> {
  try {
    return resolve(dirname(link), await readlink(link))
  } catch {
    return null
  }
}

async function verifiedReleaseLinkTarget(
  link: string,
  quarantinedVersion?: string,
): Promise<string | null> {
  const dir = await releaseLinkTarget(link)
  if (dir === null) return null
  const inspection = await inspectRelease(dir)
  return inspection.ok && inspection.version !== quarantinedVersion ? dir : null
}

export async function inspectRelease(dir: string): Promise<ReleaseInspection> {
  let manifest: RuntimeReleaseManifest
  try {
    manifest = parseManifest(
      JSON.parse(await readFile(join(dir, RUNTIME_RELEASE_MANIFEST_FILE), 'utf8')),
    )
  } catch (error) {
    return {
      ok: false,
      failures: [
        {
          artifact: RUNTIME_RELEASE_MANIFEST_FILE,
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }

  const failures: ReleaseInspectionFailure[] = []
  for (const artifact of manifest.artifacts) {
    await inspectArtifact(dir, artifact, failures)
  }
  return failures.length === 0 ? { ok: true, version: manifest.version } : { ok: false, failures }
}

async function inspectArtifact(
  dir: string,
  artifact: RuntimeReleaseManifest['artifacts'][number],
  failures: ReleaseInspectionFailure[],
): Promise<void> {
  try {
    const path = join(dir, artifact.name)
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a regular file')
    if ((info.mode & 0o777) !== artifact.mode) {
      throw new Error(
        `mode mismatch: expected ${artifact.mode.toString(8)}, got ${(info.mode & 0o777).toString(8)}`,
      )
    }
    verifyArtifactBytes(await readFile(path), artifact)
  } catch (error) {
    failures.push({
      artifact: artifact.name,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

function parseManifest(value: unknown): RuntimeReleaseManifest {
  const manifest = RuntimeReleaseManifestSchema.parse(value)
  const identity = createHash('sha256')
    .update(canonicalRuntimeReleaseIdentityInput(manifest.artifacts))
    .digest('hex')
  if (manifest.version !== `0.0.0+${identity}`) {
    throw new Error('runtime release manifest content identity mismatch')
  }
  return manifest
}
