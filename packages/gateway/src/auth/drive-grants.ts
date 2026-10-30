import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isDrivePathWithin, normalizeDrivePath, parseActorContext } from '@repo/contract'

import { readPrivateJson, writePrivateJson } from './private-state'

const DRIVE_GRANTS_DIR = 'drive-grants'
const DEFAULT_TTL_MS = 15 * 60 * 1000

interface PersistedUploadGrant {
  kind: 'upload'
  pathPrefix: string
  actor: string
  sha256: string
  expiresAt: number
}

interface PersistedDownloadGrant {
  kind: 'download'
  path: string
  actor: string
  sha256: string
  expiresAt: number
}

type PersistedDriveGrant = PersistedUploadGrant | PersistedDownloadGrant

export type DriveGrantPermit =
  | { kind: 'upload'; actor: string }
  | { kind: 'download'; actor: string }

export class InvalidDriveGrantError extends Error {
  constructor(message = 'Invalid drive grant') {
    super(message)
    this.name = 'InvalidDriveGrantError'
  }
}

export class DriveGrants {
  constructor(private readonly stateDir: string) {}

  async mintUpload(input: {
    pathPrefix: string
    actor: string
    now: number
    ttlMs?: number
  }): Promise<{ token: string; expiresAt: number }> {
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    /* The drive root is an ordinary upload destination — the files tab lands
       there whenever nobody has navigated into a folder. */
    const normalized = normalizeDrivePath(input.pathPrefix, { allowRoot: true })
    if (
      !normalized.ok ||
      parseActorContext(input.actor) === null ||
      !validLifetime(input.now, ttlMs)
    ) {
      throw new InvalidDriveGrantError()
    }
    const token = randomBytes(32).toString('base64url')
    const sha256 = hashToken(token)
    const expiresAt = input.now + ttlMs
    await pruneExpiredGrants(this.stateDir, input.now)
    await persistGrant(this.stateDir, sha256, {
      kind: 'upload',
      pathPrefix: normalized.relativePath,
      actor: input.actor,
      sha256,
      expiresAt,
    })
    return { token, expiresAt }
  }

  async mintDownload(input: {
    path: string
    actor: string
    now: number
    ttlMs?: number
  }): Promise<{ token: string; expiresAt: number }> {
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    const normalized = normalizeDrivePath(input.path)
    if (
      !normalized.ok ||
      parseActorContext(input.actor) === null ||
      !validLifetime(input.now, ttlMs)
    ) {
      throw new InvalidDriveGrantError()
    }
    const token = randomBytes(32).toString('base64url')
    const sha256 = hashToken(token)
    const expiresAt = input.now + ttlMs
    await pruneExpiredGrants(this.stateDir, input.now)
    await persistGrant(this.stateDir, sha256, {
      kind: 'download',
      path: normalized.relativePath,
      actor: input.actor,
      sha256,
      expiresAt,
    })
    return { token, expiresAt }
  }

  async authorize(
    token: string,
    method: string,
    driveRelativePath: string,
    now: number,
  ): Promise<DriveGrantPermit | null> {
    if (!Number.isFinite(now)) return null
    const normalized = normalizeDrivePath(driveRelativePath)
    if (!normalized.ok) return null
    const sha256 = hashToken(token)
    const persisted = await readGrant(this.stateDir, sha256)
    if (persisted === null) return null
    if (now >= persisted.expiresAt) {
      await unlink(grantPath(this.stateDir, sha256)).catch(() => undefined)
      return null
    }
    const actual = Buffer.from(sha256, 'hex')
    const expected = Buffer.from(persisted.sha256, 'hex')
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(actual, expected)) return null
    switch (persisted.kind) {
      case 'upload':
        return (method === 'PUT' || method === 'DELETE') &&
          (persisted.pathPrefix === '' ||
            isDrivePathWithin(persisted.pathPrefix, normalized.relativePath))
          ? { kind: 'upload', actor: persisted.actor }
          : null
      case 'download':
        return (method === 'GET' || method === 'HEAD') && normalized.relativePath === persisted.path
          ? { kind: 'download', actor: persisted.actor }
          : null
    }
  }
}

async function pruneExpiredGrants(stateDir: string, now: number): Promise<void> {
  const grantsDir = resolve(stateDir, DRIVE_GRANTS_DIR)
  let entries: string[]
  try {
    const info = await lstat(grantsDir)
    if (info.isSymbolicLink() || !info.isDirectory()) return
    entries = await readdir(grantsDir)
  } catch {
    return
  }
  await Promise.allSettled(
    entries
      .filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))
      .map(async entry => {
        const sha256 = entry.slice(0, -'.json'.length)
        const grant = await readGrant(stateDir, sha256)
        if (grant !== null && now >= grant.expiresAt) {
          await unlink(resolve(grantsDir, entry)).catch(() => undefined)
        }
      }),
  )
}

async function persistGrant(
  stateDir: string,
  sha256: string,
  grant: PersistedDriveGrant,
): Promise<void> {
  await writePrivateJson(
    resolve(stateDir, DRIVE_GRANTS_DIR),
    `${sha256}.json`,
    grant,
    'drive-grant',
  )
}

async function readGrant(stateDir: string, sha256: string): Promise<PersistedDriveGrant | null> {
  const parsed = (await readPrivateJson(grantPath(stateDir, sha256))) as Record<
    string,
    unknown
  > | null
  if (
    parsed === null ||
    typeof parsed.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
    typeof parsed.expiresAt !== 'number' ||
    !Number.isFinite(parsed.expiresAt)
  ) {
    return null
  }
  if (parsed.kind === 'upload') {
    if (
      typeof parsed.pathPrefix !== 'string' ||
      !normalizeDrivePath(parsed.pathPrefix, { allowRoot: true }).ok ||
      typeof parsed.actor !== 'string' ||
      parseActorContext(parsed.actor) === null
    ) {
      return null
    }
    return {
      kind: 'upload',
      pathPrefix: parsed.pathPrefix,
      actor: parsed.actor,
      sha256: parsed.sha256,
      expiresAt: parsed.expiresAt,
    }
  }
  if (
    parsed.kind === 'download' &&
    typeof parsed.path === 'string' &&
    normalizeDrivePath(parsed.path).ok &&
    typeof parsed.actor === 'string' &&
    parseActorContext(parsed.actor) !== null
  ) {
    return {
      kind: 'download',
      path: parsed.path,
      actor: parsed.actor,
      sha256: parsed.sha256,
      expiresAt: parsed.expiresAt,
    }
  }
  return null
}

function validLifetime(now: number, ttlMs: number): boolean {
  return Number.isFinite(now) && Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(now + ttlMs)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function grantPath(stateDir: string, sha256: string): string {
  return resolve(stateDir, DRIVE_GRANTS_DIR, `${sha256}.json`)
}
