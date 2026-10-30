import { createHash } from 'node:crypto'
import { constants, createWriteStream, type BigIntStats, type Dirent, type Stats } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { Zip, ZipDeflate } from 'fflate'
import { Hono, type Context } from 'hono'
import { z } from 'zod'

import {
  DRIVE_UPLOAD_MAX_BYTES,
  DUET_ACTOR_CONTEXT_HEADER,
  DUET_COLLECTION_SUBJECT_HEADER,
  InvalidCollectionCursorError,
  DUET_ANCHOR_MARKER_FILE,
  FILE_TOO_LARGE_ERROR,
  FileOperationRequestSchema,
  FileListQuerySchema,
  createBoundCursorCodec,
  exceedsDriveUploadLimit,
  MAX_RECURSIVE_FILE_BYTES,
  MAX_RECURSIVE_FILE_ENTRIES,
  STORAGE_FULL_ERROR,
  driveFileMimeType,
  isPathInside,
  isPublishExcludedDrivePath,
  normalizeDrivePath,
  normalizeDriveUrlPath,
  type DriveFileEvent,
  type FileEntry,
  type FileOperationRequest,
} from '@repo/contract'

import type { DiskGuard } from '../vm/disk-guard'
import { collectPublishSubtree } from './publish-subtree'

export interface FilesRouteOptions {
  driveDir: string
  tempDir: string
  /**
   * Attribution emission (spec file-attribution slice 04). Events carry the
   * raw actor-context header value; the pipeline is the one owner of
   * attribution policy (unattributed reads dropped, unattributed writes
   * logged as `system`, mirror reads skipped via the contract predicate).
   */
  emitFileEvent?: (event: DriveFileEvent) => void
  diskGuard: DiskGuard
  /** Stable workspace identity for tests; production receives it from the API header. */
  cursorSubject?: string
}

export interface FilesRouteVariables {
  driveGrantActor?: string
}

/**
 * Public-publish policy objects injected into the reused `serveDriveGet`
 * (spec publish-viewer slice 02). The authenticated `/v1/files` path passes
 * neither, so its listing and content-type mapping are untouched.
 */
export interface PublicListingPolicy {
  /**
   * Project each entry's drive-relative path into the publish-root namespace
   * (anchor prefix stripped) so the viewer never sees a workspace-absolute
   * prefix. Identity for the authenticated path (policy absent). Presence of
   * the policy also applies the publish serving floor
   * (`isPublishExcludedDrivePath`) to every listed entry.
   */
  projectPath: (driveRelativePath: string) => string
}

export interface ServeDriveGetOptions {
  driveDir: string
  emitFileEvent?: (event: DriveFileEvent) => void
  cacheVersionedReads?: boolean
  suppressImageReadActivity?: boolean
  relativePath: string
  listDirectories: 'query' | 'always'
  requireDirectory?: boolean
  /**
   * Pure content-type override for public `?raw` reads: receives the resolved
   * path and the mapper's detected type, returns the type to serve (text-like
   * forced to `text/plain`, media kept real). Authenticated reads omit it.
   */
  contentTypeOverride?: (path: string, detectedType: string) => string
  listingPolicy?: PublicListingPolicy
  /**
   * Public-publish anchor confinement: a symlink read-through must land
   * inside the resolved anchor subtree, and its target — not just the
   * request path — must clear the serving floor. Authenticated reads
   * omit this (a workspace member may follow links across their own drive).
   */
  publicConfinement?: { anchorRelativePath: string }
  /** Trusted actor captured when a headerless exact-path read grant was minted. */
  actorOverride?: string
  listingPage?: { cursor?: string; limit: number; subject: string; directory: string }
}

const fileListCursor = createBoundCursorCodec(
  'files.list',
  z.object({ name: z.string(), path: z.string() }).strict(),
)
const FILE_LIST_ORDER = 'name-asc-path-asc'

/**
 * The final path component resolved with link discipline (spec
 * file-attribution slice 16): intermediate directory links resolve through
 * the existing realpath walk while containment holds; the final component is
 * `lstat`ed, never followed. Link targets never influence containment.
 */
type FinalEntry =
  | { kind: 'missing' }
  | { kind: 'escape' }
  | { kind: 'entry'; path: string; info: Stats }
  | { kind: 'symlink'; path: string; target: string; linkInfo: Stats }

export function createFilesRoutes(options: FilesRouteOptions): Hono<{
  Variables: FilesRouteVariables
}> {
  const app = new Hono<{ Variables: FilesRouteVariables }>()

  async function handleGet(c: Context<{ Variables: FilesRouteVariables }>) {
    const list = c.req.query('list') === '1'
    const relativePath = normalizeFilesUrlPath(c.req.raw.url, options.driveDir, list, true)
    if (relativePath === null) return c.json({ error: 'not_found' }, 404)
    if (c.req.query('stat') === '1') {
      return await serveDriveStat(c, options, relativePath)
    }
    let listingPage: ServeDriveGetOptions['listingPage']
    if (list) {
      const query = FileListQuerySchema.safeParse(
        Object.fromEntries(new URL(c.req.url).searchParams),
      )
      const subject = options.cursorSubject ?? c.req.header(DUET_COLLECTION_SUBJECT_HEADER)
      if (!query.success || subject === undefined) return c.json({ error: 'invalid_request' }, 400)
      listingPage = {
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        subject,
        directory: relativePath,
      }
    }
    return await serveDriveGet(c, {
      driveDir: options.driveDir,
      emitFileEvent: options.emitFileEvent,
      cacheVersionedReads: true,
      suppressImageReadActivity: true,
      relativePath,
      listDirectories: list ? 'always' : 'query',
      requireDirectory: list,
      actorOverride: c.get('driveGrantActor'),
      ...(listingPage === undefined ? {} : { listingPage }),
    })
  }

  app.on(['GET', 'HEAD'], '/', handleGet)
  app.on(['GET', 'HEAD'], '/*', handleGet)

  app.post('/actions', async c => {
    const parsed = FileOperationRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    if (
      parsed.data.operation !== 'delete' &&
      parsed.data.operation !== 'move' &&
      (await options.diskGuard.ensureWritable()) === 'full'
    ) {
      return c.json({ error: STORAGE_FULL_ERROR }, 507)
    }
    return await applyFileOperation(c, options, parsed.data)
  })

  app.put('/*', async c => {
    // Both limits are weighed before a byte is read, so an upload that cannot
    // land is refused while the caller can still be told why rather than after
    // it has spent minutes streaming. The cap goes first: a file no disk could
    // hold should hear the thing its owner can act on, not "storage full".
    const declared = declaredBodyBytes(c.req.raw)
    if (exceedsDriveUploadLimit(declared)) {
      return c.json({ error: FILE_TOO_LARGE_ERROR, limitBytes: DRIVE_UPLOAD_MAX_BYTES }, 413)
    }
    if ((await options.diskGuard.ensureWritable(declared)) === 'full') {
      return c.json({ error: STORAGE_FULL_ERROR }, 507)
    }
    const relativePath = normalizeFilesUrlPath(c.req.raw.url, options.driveDir, false)
    if (relativePath === null) return c.json({ error: 'not_found' }, 404)
    const resolved = { relativePath, absolutePath: join(options.driveDir, relativePath) }
    const existing = await resolveFinalEntry(resolved, options.driveDir)
    if (existing.kind === 'escape') return c.json({ error: 'not_found' }, 404)
    // PUT never acts through (or silently replaces) a link: replacing a link
    // with a file is an explicit delete followed by a create (slice-16 review
    // record #2).
    if (existing.kind === 'symlink') return c.json({ error: 'path_is_symlink' }, 409)

    const ifMatch = c.req.header('if-match')
    if (ifMatch !== undefined) {
      const current = existing.kind === 'entry' ? await currentEtag(existing.path) : null
      if (current === null || !matchesIfMatch(ifMatch, current)) {
        return c.json({ error: 'precondition_failed' }, 412)
      }
    }

    const parentPath = await ensureSafeWriteParent(options.driveDir, resolved.relativePath)
    if (parentPath === null) return c.json({ error: 'not_found' }, 404)
    const finalPath = join(parentPath, basename(resolved.relativePath))
    await mkdir(options.tempDir, { recursive: true, mode: 0o700 })
    const tempPath = join(options.tempDir, `upload-${crypto.randomUUID()}`)
    try {
      if (c.req.raw.body === null) {
        await Bun.write(tempPath, '')
      } else {
        await pipeline(
          Readable.fromWeb(c.req.raw.body as never),
          createWriteStream(tempPath, { flags: 'wx' }),
        )
      }
      await fsyncFile(tempPath)
      if (ifMatch !== undefined) {
        const refreshed = await resolveFinalEntry(resolved, options.driveDir)
        if (refreshed.kind !== 'entry') {
          await unlink(tempPath).catch(() => undefined)
          if (refreshed.kind === 'escape') return c.json({ error: 'not_found' }, 404)
          if (refreshed.kind === 'symlink') return c.json({ error: 'path_is_symlink' }, 409)
          return c.json({ error: 'precondition_failed' }, 412)
        }
        const current = await currentEtag(refreshed.path)
        if (current === null || !matchesIfMatch(ifMatch, current)) {
          await unlink(tempPath).catch(() => undefined)
          return c.json({ error: 'precondition_failed' }, 412)
        }
      }
      // Re-probed immediately before the rename so a link planted mid-request
      // fails typed instead of being replaced. The rename itself never
      // follows a link, so a write can never be clobbered *through* one —
      // this probe plus the temp+rename write path is the O_NOFOLLOW
      // discipline for PUT finals.
      if (await isSymlinkAt(finalPath)) {
        await unlink(tempPath).catch(() => undefined)
        return c.json({ error: 'path_is_symlink' }, 409)
      }
      await rename(tempPath, finalPath)
      await fsyncDirectories(dirname(finalPath), await realpath(options.driveDir))
      const info = await stat(finalPath)
      const etag = await fileEtag(finalPath)
      // Always the final drive path, never the .duet/uploads staging path
      // (structural, MAP L9).
      fireFileEvent(options.emitFileEvent, {
        kind: 'write',
        path: resolved.relativePath,
        actor: c.get('driveGrantActor') ?? actorContextHeader(c),
        at: Date.now(),
      })
      c.header('etag', etag)
      return c.json({ ok: true, etag, size: Number(info.size) })
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      if (isDirectoryError(error)) return c.json({ error: 'not_file' }, 409)
      // The declared size fit when the guard was asked; the drive filled while
      // the bytes were arriving. Same answer, just learned the hard way.
      if (isOutOfSpaceError(error)) return c.json({ error: STORAGE_FULL_ERROR }, 507)
      throw error
    }
  })

  app.delete('/*', async c => {
    const relativePath = normalizeFilesUrlPath(c.req.raw.url, options.driveDir, false)
    if (relativePath === null) return c.json({ error: 'not_found' }, 404)
    const result = await deleteDrivePath(options.driveDir, options.tempDir, relativePath, false)
    if (!result.ok) return c.json({ error: result.error }, result.status)
    const resolved = resolveRelativeDrivePath(relativePath, options.driveDir, false)
    if (resolved !== null) {
      fireFileEvent(options.emitFileEvent, {
        kind: 'delete',
        entryKind: result.entryKind,
        path: resolved.relativePath,
        actor: c.get('driveGrantActor') ?? actorContextHeader(c),
        at: Date.now(),
      })
    }
    return c.json({ ok: true })
  })

  return app
}

function actorContextHeader(c: Context): string {
  return c.req.header(DUET_ACTOR_CONTEXT_HEADER) ?? ''
}

// Attribution is fire-and-forget: it must never block, fail, or delay the
// file operation itself (a throwing emitter is contained here, test-pinned).
function fireFileEvent(
  emit: ((event: DriveFileEvent) => void) | undefined,
  event: DriveFileEvent,
): void {
  if (emit === undefined) return
  try {
    emit(event)
  } catch {
    // Swallowed by design: requests never observe attribution failures.
  }
}

async function serveDriveStat(
  c: Context,
  options: FilesRouteOptions,
  relativePath: string,
): Promise<Response> {
  const resolved = resolveRelativeDrivePath(relativePath, options.driveDir, false)
  if (resolved === null) return c.json({ error: 'not_found' }, 404)
  const entry = await resolveFinalEntry(resolved, options.driveDir)
  if (entry.kind === 'missing' || entry.kind === 'escape')
    return c.json({ error: 'not_found' }, 404)
  if (entry.kind === 'symlink') {
    // Stat reports the link itself, whether or not its target resolves.
    return c.json({
      entry: symlinkFileEntry(
        basename(resolved.relativePath),
        resolved.relativePath,
        entry.target,
        entry.linkInfo,
      ),
      etag: null,
    })
  }
  const info = entry.info
  if (!info.isFile() && !info.isDirectory()) return c.json({ error: 'not_file' }, 409)
  return c.json({
    entry: {
      name: basename(resolved.relativePath),
      path: resolved.relativePath,
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.isDirectory() ? 0 : Number(info.size),
      mtime: info.mtime.toISOString(),
    },
    etag: info.isFile() ? await fileEtag(entry.path) : null,
  })
}

// A link entry is the link itself, never its target: `target` verbatim,
// `size` = byte length of the target text, `mtime` = the link's own mtime
// (slice-16 review record #3).
function symlinkFileEntry(name: string, path: string, target: string, linkInfo: Stats): FileEntry {
  return {
    name,
    path,
    type: 'symlink',
    size: Buffer.byteLength(target),
    mtime: linkInfo.mtime.toISOString(),
    target,
  }
}

async function fsyncFile(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

async function fsyncDirectories(start: string, root: string): Promise<void> {
  let current = start
  for (;;) {
    const directory = await open(current, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    if (current === root) return
    const parent = dirname(current)
    if (parent === current) throw new Error(`drive parent escaped root while syncing ${start}`)
    current = parent
  }
}

export type ConvergeOutcome = 'written' | 'unchanged' | 'symlink' | 'rejected'

/**
 * Make one drive path hold exactly `bytes` — and DO NOTHING if it already does.
 *
 * The no-op case is the whole point. A publish's zip ETag is derived from each
 * entry's size and mtime, not its content, so rewriting a byte-identical file
 * rotates the ETag, forces every subscriber to re-download, and shows them an
 * update on content that did not change. Comparing here, on the VM that holds
 * the bytes, costs one read; comparing from the caller would cost a round trip
 * per file.
 *
 * Lives beside PUT so the symlink refusal, the containment check, and the
 * temp-plus-rename write stay one implementation rather than two that drift.
 */
export async function convergeDriveFile(options: {
  driveDir: string
  tempDir: string
  relativePath: string
  bytes: Uint8Array
}): Promise<ConvergeOutcome> {
  // The contract's grammar owner rejects traversal, absolute paths, NUL and
  // reserved names before anything touches the filesystem.
  const safe = normalizeDrivePath(options.relativePath)
  if (!safe.ok) return 'rejected'
  const relativePath = safe.relativePath
  const resolved = { relativePath, absolutePath: join(options.driveDir, relativePath) }
  const existing = await resolveFinalEntry(resolved, options.driveDir)
  if (existing.kind === 'escape') return 'rejected'
  // Same refusal PUT gives: a link is replaced by an explicit delete then a
  // create, never silently written through.
  if (existing.kind === 'symlink') return 'symlink'
  if (existing.kind === 'entry' && existing.info.isFile()) {
    const current = new Uint8Array(await readFile(existing.path))
    if (
      current.length === options.bytes.length &&
      current.every((b, i) => b === options.bytes[i])
    ) {
      return 'unchanged'
    }
  }

  const parentPath = await ensureSafeWriteParent(options.driveDir, relativePath)
  if (parentPath === null) return 'rejected'
  const finalPath = join(parentPath, basename(relativePath))
  await mkdir(options.tempDir, { recursive: true, mode: 0o700 })
  const tempPath = join(options.tempDir, `converge-${crypto.randomUUID()}`)
  try {
    await Bun.write(tempPath, options.bytes)
    await fsyncFile(tempPath)
    if (await isSymlinkAt(finalPath)) return 'symlink'
    await rename(tempPath, finalPath)
    await fsyncDirectories(dirname(finalPath), await realpath(options.driveDir))
    return 'written'
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

export async function serveDriveGet(c: Context, options: ServeDriveGetOptions): Promise<Response> {
  const resolved = resolveRelativeDrivePath(
    options.relativePath,
    options.driveDir,
    options.listDirectories === 'always',
  )
  if (resolved === null) return c.json({ error: 'not_found' }, 404)
  const entry = await resolveFinalEntry(resolved, options.driveDir)
  if (entry.kind === 'missing' || entry.kind === 'escape')
    return c.json({ error: 'not_found' }, 404)

  let servePath: string
  let info: Stats
  if (entry.kind === 'symlink') {
    // Listings never follow links (slice-16 review record #5): a listing
    // addressed at a link fails typed before the target is even resolved.
    if (options.requireDirectory === true) return c.json({ error: 'path_is_symlink' }, 409)
    // Read-through: a content GET serves the target's bytes only while the
    // existing realpath containment holds — the link's target text never
    // influences the decision, and there is no silent fallback.
    const followed = await safeExistingPath(entry.path, options.driveDir)
    if (!followed.ok) {
      return c.json({ error: 'symlink_unresolvable', target: entry.target }, 409)
    }
    servePath = followed.path
    info = await stat(servePath)
    if (info.isDirectory() && options.listDirectories === 'always') {
      // A publish folder listing addressed at a directory link would follow
      // it; listings never follow.
      return c.json({ error: 'path_is_symlink' }, 409)
    }
  } else {
    servePath = entry.path
    info = entry.info
  }

  // Public-publish confinement applies to the fully-resolved `servePath`, so it
  // catches every way the realpath can leave the anchor: a final-component
  // symlink read-through AND a regular file (or listed directory) reached
  // through an *intermediate* directory symlink, which `resolveFinalEntry`
  // realpaths against the whole drive, not the anchor. The request-path guards
  // (normalize, serving floor) never saw this resolved path, so it re-clears
  // both: inside the anchor subtree, not on the floor. 404, not 409 — a
  // public caller learns nothing about the target.
  if (options.publicConfinement !== undefined) {
    const anchorAbsolute = join(
      await realpath(options.driveDir),
      options.publicConfinement.anchorRelativePath,
    )
    if (!clearsPublicConfinement(anchorAbsolute, servePath)) {
      return c.json({ error: 'not_found' }, 404)
    }
  }

  if (info.isDirectory()) {
    if (options.listDirectories !== 'always') return c.json({ error: 'not_file' }, 409)
    // Listings and stats are not content reads (MAP Q7/L13): no event.
    if (options.listingPage === undefined) {
      const items = await listDirectory(servePath, options.driveDir, options.listingPolicy)
      return c.json({ items, nextCursor: null })
    }
    const binding = {
      subject: options.listingPage.subject,
      filters: { directory: options.listingPage.directory },
      order: FILE_LIST_ORDER,
    }
    let position: { name: string; path: string } | undefined
    if (options.listingPage.cursor !== undefined) {
      try {
        position = await fileListCursor.decode(options.listingPage.cursor, binding)
      } catch (error) {
        if (error instanceof InvalidCollectionCursorError) {
          return c.json({ error: error.code }, 400)
        }
        throw error
      }
    }
    const candidates = await listDirectoryPage(
      servePath,
      options.driveDir,
      position,
      options.listingPage.limit + 1,
    )
    const page = candidates.slice(0, options.listingPage.limit)
    const hasMore = candidates.length > options.listingPage.limit
    const last = page.at(-1)
    const nextCursor =
      hasMore && last !== undefined
        ? await fileListCursor.encode({
            ...binding,
            position: { name: last.name, path: last.path },
          })
        : null
    return c.json({ items: page, nextCursor })
  }

  if (options.requireDirectory === true) return c.json({ error: 'not_directory' }, 409)
  if (!info.isFile()) return c.json({ error: 'not_file' }, 409)
  const etag = await fileEtag(servePath)
  const size = Number(info.size)
  const isHead = c.req.method === 'HEAD'
  const range = isHead ? null : parseSingleRange(c.req.header('range') ?? null, size)
  if (range === 'invalid') return rangeNotSatisfiable(size)

  if (
    !isHead &&
    !(options.suppressImageReadActivity === true && c.req.header('sec-fetch-dest') === 'image')
  ) {
    fireFileEvent(options.emitFileEvent, {
      kind: 'read',
      path: resolved.relativePath,
      actor: options.actorOverride ?? actorContextHeader(c),
      at: Date.now(),
    })
  }
  const headers = fileHeaders(servePath, info, etag, options.contentTypeOverride)
  const versionSelector = c.req.query('v')
  if (
    options.cacheVersionedReads === true &&
    versionSelector !== undefined &&
    /^\d+$/.test(versionSelector)
  ) {
    headers.set('cache-control', 'private, max-age=31536000, immutable')
  }
  if (options.actorOverride !== undefined) {
    headers.set('cache-control', 'private, no-store')
  }
  if (range === null) {
    headers.set('content-length', String(size))
    if (isHead) return new Response(null, { headers })
    return new Response(Bun.file(servePath), { headers })
  }

  headers.set('content-length', String(range.end - range.start + 1))
  headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
  return new Response(Bun.file(servePath).slice(range.start, range.end + 1), {
    status: 206,
    headers,
  })
}

export interface ServeDriveZipOptions {
  driveDir: string
  emitFileEvent?: (event: DriveFileEvent) => void
  relativePath: string
  /**
   * Public-publish confinement, mandatory for zip: the archive walk applies
   * the publish serving floor (symlinks also omitted and never followed), and
   * the resolved root must clear the same anchor confinement as
   * `serveDriveGet`.
   */
  anchorRelativePath: string
  /** Basename for `content-disposition` (".zip" appended here). */
  archiveName: string
}

/**
 * `?zip` — the publish-served subtree as one `application/zip` stream. The
 * serving floor (`isPublishExcludedDrivePath`) is the only named-path policy;
 * ordinary dot-prefixed entries are included. Symlinks are omitted entirely
 * (never followed — a link can escape the anchor), and the walk is bounded by
 * the shared recursive-tree limits. The `ETag` is a digest of the included
 * entries' (path, size, mtime) stats, so a poller can `If-None-Match` for a 304
 * without the archive being built — the change-detection primitive the
 * hub/subscription pull rail relies on.
 */
export async function serveDriveZip(c: Context, options: ServeDriveZipOptions): Promise<Response> {
  const resolved = resolveRelativeDrivePath(options.relativePath, options.driveDir, true)
  if (resolved === null) return c.json({ error: 'not_found' }, 404)
  const entry = await resolveFinalEntry(resolved, options.driveDir)
  if (entry.kind === 'missing' || entry.kind === 'escape')
    return c.json({ error: 'not_found' }, 404)
  // Archives never act through a link, mirroring `?list` (path_is_symlink).
  if (entry.kind === 'symlink') return c.json({ error: 'path_is_symlink' }, 409)
  if (!entry.info.isDirectory()) return c.json({ error: 'not_directory' }, 409)

  // Same re-clear as serveDriveGet's publicConfinement: the resolved realpath
  // (which may have crossed an intermediate directory link) must stay inside
  // the anchor subtree and re-clear the serving floor, or the zip is a 404.
  const anchorAbsolute = join(await realpath(options.driveDir), options.anchorRelativePath)
  if (!clearsPublicConfinement(anchorAbsolute, entry.path)) {
    return c.json({ error: 'not_found' }, 404)
  }

  const collected = await collectPublishSubtree(entry.path)
  if (!collected.ok) return c.json({ error: collected.error }, 409)
  const files: ZipFileCandidate[] = collected.entries
    .filter(entry => entry.kind === 'file')
    .map(entry => ({
      absolutePath: entry.absolutePath,
      zipPath: entry.relativePath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      mtimeNs: entry.mtimeNs,
    }))

  const etag = zipTreeEtag(files)
  const headers = new Headers({
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${archiveFilename(options.archiveName)}.zip"`,
    etag,
    'x-content-type-options': 'nosniff',
  })
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch !== undefined && matchesIfMatch(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers })
  }
  // One read event on the archive root — a tree download is one operation,
  // not a per-file storm (the tree-copy precedent).
  fireFileEvent(options.emitFileEvent, {
    kind: 'read',
    path: resolved.relativePath,
    actor: actorContextHeader(c),
    at: Date.now(),
  })
  return new Response(zipStream(files) as unknown as RequestInit['body'], { headers })
}

interface ZipFileCandidate {
  absolutePath: string
  zipPath: string
  size: number
  mtimeMs: number
  mtimeNs: bigint
}

// Digest of the included entries' identity and stats — not of the archive
// bytes — so 304 short-circuits before any zip work. Same-stat different-bytes
// misses are accepted, exactly like the stat-derived file `ETag`.
function zipTreeEtag(files: readonly ZipFileCandidate[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.zipPath}\n${file.size}\n${file.mtimeNs}\n`)
  return `"zip-${hash.digest('hex').slice(0, 32)}"`
}

function archiveFilename(name: string): string {
  const sanitized = name.replace(/[^\p{L}\p{N} ._-]/gu, '_').trim()
  return sanitized.length === 0 ? 'download' : sanitized
}

// ZIP's DOS timestamp range; fflate throws on anything outside it, and a
// pre-1980 (or far-future) filesystem mtime is legal, so it clamps rather
// than failing the download mid-stream.
const ZIP_MTIME_MIN = Date.UTC(1980, 0, 1)
const ZIP_MTIME_MAX = Date.UTC(2099, 11, 31, 23, 59, 58)

function clampZipMtime(mtimeMs: number): number {
  return Math.min(ZIP_MTIME_MAX, Math.max(ZIP_MTIME_MIN, mtimeMs))
}

function zipStream(files: readonly ZipFileCandidate[]): ReadableStream<Uint8Array> {
  // Producer state shared with pull()/cancel(): the async producer pauses
  // whenever the consumer's queue is full (desiredSize <= 0) and resumes on
  // the next pull, so a slow anonymous client never forces the archive to
  // accumulate in memory. cancel() (client disconnect) stops all file reads.
  let cancelled = false
  let release: (() => void) | null = null
  const waitForDrain = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const zip = new Zip((error, chunk, final) => {
          if (cancelled) return
          if (error) {
            cancelled = true
            controller.error(error)
            return
          }
          controller.enqueue(chunk)
          if (final) controller.close()
        })
        try {
          for (const file of files) {
            if (cancelled) return
            // O_NOFOLLOW: a file swapped for a symlink between the collect
            // walk's lstat and this open fails typed instead of reading
            // through the link — the walk's no-symlink policy holds at open
            // time, not just at stat time.
            const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
            const reader = handle.createReadStream({ autoClose: false })
            try {
              const info = await handle.stat()
              if (!info.isFile())
                throw new Error(`zip entry is not a regular file: ${file.zipPath}`)
              const entry = new ZipDeflate(file.zipPath, { level: 6 })
              entry.mtime = clampZipMtime(file.mtimeMs)
              zip.add(entry)
              for await (const chunk of reader) {
                if (cancelled) return
                entry.push(chunk as Uint8Array, false)
                await waitForDrain(controller)
              }
              entry.push(new Uint8Array(0), true)
            } finally {
              reader.destroy()
              await handle.close().catch(() => undefined)
            }
          }
          if (!cancelled) zip.end()
        } catch (error) {
          if (!cancelled) {
            cancelled = true
            controller.error(error)
          }
        }
      })()
    },
    pull() {
      release?.()
      release = null
    },
    cancel() {
      cancelled = true
      release?.()
      release = null
    },
  })
}

// The one owner of the public-confinement re-clear, shared by `serveDriveGet`
// and `serveDriveZip`: a fully-resolved serve path must sit inside the anchor
// subtree and re-clear the serving floor the request-path guards never saw
// for this resolved form.
function clearsPublicConfinement(anchorAbsolute: string, servePath: string): boolean {
  const anchorRelative =
    servePath === anchorAbsolute ? '' : servePath.slice(anchorAbsolute.length + 1)
  return isPathInside(anchorAbsolute, servePath) && !isPublishExcludedDrivePath(anchorRelative)
}

async function resolveFinalEntry(
  resolved: { relativePath: string; absolutePath: string },
  driveDir: string,
): Promise<FinalEntry> {
  if (resolved.relativePath === '') {
    const root = await safeExistingPath(driveDir, driveDir)
    if (!root.ok) return { kind: 'missing' }
    return { kind: 'entry', path: root.path, info: await stat(root.path) }
  }
  const parent = await safeExistingPath(dirname(resolved.absolutePath), driveDir)
  if (!parent.ok) return parent.reason === 'escape' ? { kind: 'escape' } : { kind: 'missing' }
  const path = join(parent.path, basename(resolved.absolutePath))
  let info: Stats
  try {
    info = await lstat(path)
  } catch (error) {
    if (isNotFoundError(error) || isNotDirectoryError(error)) return { kind: 'missing' }
    throw error
  }
  if (!info.isSymbolicLink()) return { kind: 'entry', path, info }
  return { kind: 'symlink', path, target: await readlink(path), linkInfo: info }
}

async function isSymlinkAt(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

function resolveRelativeDrivePath(
  relativePath: string,
  driveDir: string,
  allowRoot: boolean,
): { relativePath: string; absolutePath: string } | null {
  const normalized = normalizeDrivePath(relativePath, { allowRoot })
  if (!normalized.ok) return null
  return {
    relativePath: normalized.relativePath,
    absolutePath: join(driveDir, normalized.relativePath),
  }
}

function normalizeFilesUrlPath(
  url: string,
  driveDir: string,
  allowRoot: boolean,
  allowAbsoluteRead = false,
): string | null {
  const rawPath = rawFilesPath(rawUrlPathname(url))
  const normalized = normalizeDriveUrlPath(rawPath, { allowRoot })
  if (normalized.ok) return normalized.relativePath
  if (!allowAbsoluteRead) return null

  // Media callers can carry the VM's absolute drive path, but only GET/HEAD
  // reaches this branch. Decode each URL segment once, strip the exact live
  // root, then validate the remainder as logical (already-decoded) identity.
  const decodedParts: string[] = []
  for (const rawPart of rawPath.split('/')) {
    let decodedPart: string
    try {
      decodedPart = decodeURIComponent(rawPart)
    } catch {
      return null
    }
    if (decodedPart.includes('\\') || decodedPart.includes('\0')) return null
    decodedParts.push(decodedPart)
  }
  const firstPart = decodedParts[0]
  if (firstPart === undefined || !firstPart.startsWith('/') || firstPart.slice(1).includes('/')) {
    return null
  }
  if (decodedParts.slice(1).some(part => part.includes('/'))) return null

  const absolutePath = decodedParts.join('/')
  const relativePath =
    absolutePath === driveDir
      ? ''
      : absolutePath.startsWith(`${driveDir}/`)
        ? absolutePath.slice(driveDir.length + 1)
        : null
  if (relativePath === null) return null
  const absoluteNormalized = normalizeDrivePath(relativePath, { allowRoot })
  return absoluteNormalized.ok ? absoluteNormalized.relativePath : null
}

// Shared by the files and public-publish route families: the raw pathname of
// a request URL without touching percent-encoding.
export function rawUrlPathname(url: string): string {
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]*/, '')
  const pathAndQuery = withoutScheme.length === 0 ? '/' : withoutScheme
  const queryStart = pathAndQuery.search(/[?#]/)
  return queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart)
}

function rawFilesPath(pathname: string): string {
  if (pathname === '/v1/files') return ''
  if (pathname.startsWith('/v1/files/')) return pathname.slice('/v1/files/'.length)
  return ''
}

async function listDirectory(
  path: string,
  driveDir: string,
  policy?: PublicListingPolicy,
): Promise<FileEntry[]> {
  const root = await realpath(driveDir)
  // Project the drive-relative entry path into the caller's namespace: the
  // public publish listing strips the anchor prefix so the viewer sees
  // publish-root-relative paths, never the workspace-absolute prefix. The
  // authenticated path keeps the drive-relative path (identity).
  const project = policy?.projectPath ?? ((driveRelativePath: string) => driveRelativePath)
  const entries = await readdir(path, { withFileTypes: true })
  const listed = (
    await Promise.all(entries.map(entry => directoryEntry(entry, path, root, project)))
  ).filter(entry => entry !== null)
  // Public listings apply the serving floor (never `.env*`/`.git`/
  // `node_modules`/`.duet-anchor`); ordinary dotfiles are listed — hiding
  // them is viewer presentation, not a serving policy. The authenticated
  // path lists everything.
  const filtered =
    policy === undefined ? listed : listed.filter(entry => !isPublishExcludedDrivePath(entry.path))
  filtered.sort(compareFileListPosition)
  return filtered
}

// No entry ceiling here, on purpose: the shipping bound
// (`MAX_RECURSIVE_FILE_ENTRIES`) caps what a folder can reproduce — a zip, a
// copy, a publish — and a listing reproduces nothing. Each page is one
// readdir plus one lstat per entry, kept in a page-sized window, so an
// agent that writes a thousand artifacts flat into its own folder stays
// browsable.
async function listDirectoryPage(
  path: string,
  driveDir: string,
  after: Pick<FileEntry, 'name' | 'path'> | undefined,
  count: number,
): Promise<FileEntry[]> {
  const root = await realpath(driveDir)
  const selected: FileEntry[] = []
  for await (const dirent of await opendir(path)) {
    const entry = await directoryEntry(dirent, path, root, driveRelativePath => driveRelativePath)
    if (entry === null || (after !== undefined && compareFileListPosition(entry, after) <= 0)) {
      continue
    }
    const index = selected.findIndex(candidate => compareFileListPosition(entry, candidate) < 0)
    if (index === -1) selected.push(entry)
    else selected.splice(index, 0, entry)
    if (selected.length > count) selected.pop()
  }
  return selected
}

async function directoryEntry(
  entry: Dirent,
  directoryPath: string,
  driveRoot: string,
  project: (driveRelativePath: string) => string,
): Promise<FileEntry | null> {
  const entryPath = join(directoryPath, entry.name)
  const relativeEntryPath = relative(driveRoot, entryPath)
  if (!normalizeDrivePath(relativeEntryPath).ok) return null
  const projectedPath = project(relativeEntryPath)
  // Links are entries even when dangling or escaping; following them here
  // would make a mirror observe a phantom deletion.
  let info: Stats
  try {
    info = await lstat(entryPath)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
  if (info.isSymbolicLink()) {
    return symlinkFileEntry(entry.name, projectedPath, await readlink(entryPath), info)
  }
  return {
    name: entry.name,
    path: projectedPath,
    type: info.isDirectory() ? 'directory' : 'file',
    size: info.isDirectory() ? 0 : Number(info.size),
    mtime: info.mtime.toISOString(),
  }
}

function compareFileListPosition(
  left: Pick<FileEntry, 'name' | 'path'>,
  right: Pick<FileEntry, 'name' | 'path'>,
): number {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
}

async function applyFileOperation(
  c: Context,
  options: FilesRouteOptions,
  operation: FileOperationRequest,
): Promise<Response> {
  if (operation.operation === 'mkdir') {
    await mkdir(options.driveDir, { recursive: true })
    const resolved = resolveRelativeDrivePath(operation.path, options.driveDir, false)
    if (resolved === null) return c.json({ error: 'not_found' }, 404)
    const existing = await resolveFinalEntry(resolved, options.driveDir)
    if (existing.kind === 'escape') return c.json({ error: 'not_found' }, 404)
    // mkdir never acts through a link — even a link to a directory is not
    // "already a directory" (slice-16 review record #1).
    if (existing.kind === 'symlink') return c.json({ error: 'path_is_symlink' }, 409)
    if (existing.kind === 'entry') {
      return existing.info.isDirectory()
        ? c.json({ ok: true, affectedEntries: 1 })
        : c.json({ error: 'path_exists' }, 409)
    }
    const parent = operation.recursive
      ? await ensureSafeWriteParent(options.driveDir, resolved.relativePath)
      : await safeExistingDirectory(dirname(resolved.absolutePath), options.driveDir)
    if (parent === null) return c.json({ error: 'parent_not_found' }, 409)
    try {
      await mkdir(join(parent, basename(resolved.relativePath)))
    } catch (error) {
      if (isAlreadyExistsError(error)) return c.json({ error: 'path_exists' }, 409)
      throw error
    }
    fireFileEvent(options.emitFileEvent, {
      kind: 'create',
      entryKind: 'folder',
      path: resolved.relativePath,
      actor: actorContextHeader(c),
      at: Date.now(),
    })
    return c.json({ ok: true, affectedEntries: 1 })
  }

  if (operation.operation === 'symlink') {
    await mkdir(options.driveDir, { recursive: true })
    const resolved = resolveRelativeDrivePath(operation.path, options.driveDir, false)
    if (resolved === null) return c.json({ error: 'not_found' }, 404)
    const existing = await resolveFinalEntry(resolved, options.driveDir)
    if (existing.kind === 'escape') return c.json({ error: 'not_found' }, 404)
    // Same-type upsert (slice-16 review record #2): retargets an existing
    // link, conflicts with any other entry type — cross-type replacement is
    // an explicit delete followed by a create.
    if (existing.kind === 'entry') return c.json({ error: 'path_exists' }, 409)
    const parent = await safeExistingDirectory(dirname(resolved.absolutePath), options.driveDir)
    if (parent === null) return c.json({ error: 'parent_not_found' }, 409)
    const finalPath = join(parent, basename(resolved.relativePath))
    // Staged and renamed so a retarget replaces the old link atomically. The
    // target text is stored verbatim and never resolved here — it does not
    // influence containment (a dangling or escaping target is legal to
    // store, just never readable through the link).
    await mkdir(options.tempDir, { recursive: true, mode: 0o700 })
    const stagedLink = join(options.tempDir, `symlink-${crypto.randomUUID()}`)
    await symlink(operation.target, stagedLink)
    try {
      await rename(stagedLink, finalPath)
    } catch (error) {
      await unlink(stagedLink).catch(() => undefined)
      throw error
    }
    await fsyncDirectories(parent, await realpath(options.driveDir))
    fireFileEvent(options.emitFileEvent, {
      kind: 'create',
      entryKind: 'file',
      path: resolved.relativePath,
      actor: actorContextHeader(c),
      at: Date.now(),
    })
    return c.json({ ok: true, affectedEntries: 1 })
  }

  if (operation.operation === 'delete') {
    const result = await deleteDrivePath(
      options.driveDir,
      options.tempDir,
      operation.path,
      operation.recursive,
    )
    if (!result.ok) return c.json({ error: result.error }, result.status)
    const resolved = resolveRelativeDrivePath(operation.path, options.driveDir, false)
    if (resolved !== null) {
      fireFileEvent(options.emitFileEvent, {
        kind: 'delete',
        entryKind: result.entryKind,
        path: resolved.relativePath,
        actor: actorContextHeader(c),
        at: Date.now(),
      })
    }
    return c.json(
      result.affectedEntries === undefined
        ? { ok: true }
        : { ok: true, affectedEntries: result.affectedEntries },
    )
  }

  const sourceResolved = resolveRelativeDrivePath(operation.source, options.driveDir, false)
  const destinationResolved = resolveRelativeDrivePath(
    operation.destination,
    options.driveDir,
    false,
  )
  if (sourceResolved === null || destinationResolved === null)
    return c.json({ error: 'not_found' }, 404)
  if (
    sourceResolved.relativePath === destinationResolved.relativePath ||
    destinationResolved.relativePath.startsWith(`${sourceResolved.relativePath}/`)
  ) {
    return c.json({ error: 'invalid_destination' }, 409)
  }
  // Links are ordinary entries in structural operations: moved and copied as
  // links with verbatim targets, never followed — a dangling or escaping
  // link is movable and copyable like anything else.
  const source = await resolveFinalEntry(sourceResolved, options.driveDir)
  if (source.kind === 'missing' || source.kind === 'escape')
    return c.json({ error: 'not_found' }, 404)
  const sourceIsDirectory = source.kind === 'entry' && source.info.isDirectory()
  if (sourceIsDirectory && operation.operation === 'copy' && !operation.recursive) {
    return c.json({ error: 'recursive_required' }, 409)
  }

  const destination = await resolveFinalEntry(destinationResolved, options.driveDir)
  if (destination.kind === 'escape') return c.json({ error: 'not_found' }, 404)
  if (destination.kind !== 'missing') {
    if (!operation.overwrite) return c.json({ error: 'path_exists' }, 409)
    if (sourceIsDirectory || (destination.kind === 'entry' && destination.info.isDirectory())) {
      return c.json({ error: 'directory_overwrite_not_supported' }, 409)
    }
  }
  const parent = await safeExistingDirectory(
    dirname(destinationResolved.absolutePath),
    options.driveDir,
  )
  if (parent === null) return c.json({ error: 'parent_not_found' }, 409)
  const destinationPath = join(parent, basename(destinationResolved.relativePath))

  if (operation.operation === 'move') {
    await rename(source.path, destinationPath)
    await fsyncDirectories(parent, await realpath(options.driveDir))
    fireFileEvent(options.emitFileEvent, {
      kind: 'rename',
      entryKind: sourceIsDirectory ? 'folder' : 'file',
      path: destinationResolved.relativePath,
      fromPath: sourceResolved.relativePath,
      actor: actorContextHeader(c),
      at: Date.now(),
    })
    return c.json({ ok: true, affectedEntries: 1 })
  }

  await mkdir(options.tempDir, { recursive: true, mode: 0o700 })
  const stagingPath = join(options.tempDir, `copy-${crypto.randomUUID()}`)
  const footprint = { entries: 0, bytes: 0 }
  try {
    await copyTree(source.path, stagingPath, footprint)
    await rename(stagingPath, destinationPath)
    await fsyncDirectories(parent, await realpath(options.driveDir))
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    if (error instanceof FileOperationError) return c.json({ error: error.code }, 409)
    throw error
  }
  // One event on the destination root (a tree copy is one operation, not a
  // per-file storm).
  fireFileEvent(options.emitFileEvent, {
    kind: 'create',
    entryKind: sourceIsDirectory ? 'folder' : 'file',
    path: destinationResolved.relativePath,
    actor: actorContextHeader(c),
    at: Date.now(),
  })
  return c.json({ ok: true, affectedEntries: footprint.entries })
}

async function deleteDrivePath(
  driveDir: string,
  tempDir: string,
  relativePath: string,
  recursive: boolean,
): Promise<
  | { ok: true; entryKind: 'file' | 'folder'; affectedEntries?: number }
  | {
      ok: false
      error: 'not_found' | 'directory_not_empty' | 'recursive_limit_exceeded'
      status: 404 | 409
    }
> {
  const resolved = resolveRelativeDrivePath(relativePath, driveDir, false)
  if (resolved === null) return { ok: false, error: 'not_found', status: 404 }
  const entry = await resolveFinalEntry(resolved, driveDir)
  if (entry.kind === 'missing' || entry.kind === 'escape') {
    return { ok: false, error: 'not_found', status: 404 }
  }
  try {
    // DELETE on a link removes the link itself, never a target tree
    // (slice-16 review record #5) — dangling and escaping links included.
    if (entry.kind === 'symlink' || !entry.info.isDirectory()) {
      await unlink(entry.path)
      return { ok: true, entryKind: 'file', affectedEntries: 1 }
    }
    if (!recursive && (await visibleDirectoryEntries(entry.path)).length > 0) {
      return { ok: false, error: 'directory_not_empty', status: 409 }
    }
    // No walk, and so no bound. A recursive delete used to count the whole tree
    // first, and the only thing that count ever fed was an `affectedEntries`
    // number nothing reads — while the bound it needed made a folder with
    // dependencies installed impossible to throw away. `rm -r` does not need to
    // be told the size of what it is removing.
    if (recursive) {
      await rm(entry.path, { recursive: true })
      return { ok: true, entryKind: 'folder' }
    }
    const footprint = await boundedTreeFootprint(entry.path)
    if (!footprint.ok) return { ok: false, error: footprint.error, status: 409 }
    await rmdirPreservingMarkerOnFailure(entry.path, tempDir)
    return { ok: true, entryKind: 'folder', affectedEntries: footprint.entries }
  } catch (error) {
    if (isNotFoundError(error)) return { ok: false, error: 'not_found', status: 404 }
    if (isDirectoryError(error)) return { ok: false, error: 'directory_not_empty', status: 409 }
    throw error
  }
}

/**
 * Remove one directory whose only remaining content may be its anchor marker
 * — without ever destroying that marker on a delete that FAILS. The marker is
 * the folder's anchor identity: unlinking it first and then failing the rmdir
 * (an app writing into its folder mid-delete) left a living folder whose
 * proof was gone, and the anchor rail then refused it as a hijack. So the
 * marker is set ASIDE (a rename within the same filesystem — tempDir is where
 * PUT stages its atomic renames), the rmdir decides the delete's fate, and
 * only success discards the marker; any failure renames it straight back.
 */
async function rmdirPreservingMarkerOnFailure(directory: string, tempDir: string): Promise<void> {
  const markerPath = join(directory, DUET_ANCHOR_MARKER_FILE)
  if (!(await isAnchorMarkerFile(markerPath))) {
    await rmdir(directory)
    return
  }
  await mkdir(tempDir, { recursive: true, mode: 0o700 })
  const asidePath = join(tempDir, `anchor-marker-${crypto.randomUUID()}`)
  await rename(markerPath, asidePath)
  try {
    await rmdir(directory)
  } catch (error) {
    await rename(asidePath, markerPath).catch(() => undefined)
    throw error
  }
  await unlink(asidePath).catch(() => undefined)
}

async function safeExistingDirectory(path: string, driveDir: string): Promise<string | null> {
  const safe = await safeExistingPath(path, driveDir)
  if (!safe.ok) return null
  return (await stat(safe.path)).isDirectory() ? safe.path : null
}

async function visibleDirectoryEntries(path: string): Promise<string[]> {
  const entries = await readdir(path)
  const visible: string[] = []
  for (const entry of entries) {
    if (
      entry === DUET_ANCHOR_MARKER_FILE &&
      (await isAnchorMarkerFile(join(path, DUET_ANCHOR_MARKER_FILE)))
    ) {
      continue
    }
    visible.push(entry)
  }
  return visible
}

async function boundedTreeFootprint(
  root: string,
): Promise<
  { ok: true; entries: number; bytes: number } | { ok: false; error: 'recursive_limit_exceeded' }
> {
  let entries = 0
  let bytes = 0
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    const info = await lstat(current)
    // A link is one entry of its own, never descended — an escaping link
    // must not pull an outside tree into the footprint (and the anchor
    // check below must never read through one).
    if (info.isSymbolicLink()) {
      entries += 1
      if (entries > MAX_RECURSIVE_FILE_ENTRIES)
        return { ok: false, error: 'recursive_limit_exceeded' }
      continue
    }
    if (basename(current) === DUET_ANCHOR_MARKER_FILE && (await isAnchorMarkerFile(current))) {
      continue
    }
    entries += 1
    if (info.isFile()) bytes += Number(info.size)
    if (entries > MAX_RECURSIVE_FILE_ENTRIES || bytes > MAX_RECURSIVE_FILE_BYTES) {
      return { ok: false, error: 'recursive_limit_exceeded' }
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(current)) pending.push(join(current, entry))
    }
  }
  return { ok: true, entries, bytes }
}

async function copyTree(
  source: string,
  destination: string,
  footprint: { entries: number; bytes: number },
): Promise<void> {
  const info = await lstat(source)
  // A copy reproduces a link as a link with the same verbatim target — it
  // never follows one (slice-16 review record #5): a relative target is
  // reinterpreted at the destination and may dangle there. Checked before
  // the anchor probe so that probe never reads through a link.
  if (info.isSymbolicLink()) {
    footprint.entries += 1
    if (footprint.entries > MAX_RECURSIVE_FILE_ENTRIES) {
      throw new FileOperationError('recursive_limit_exceeded')
    }
    await symlink(await readlink(source), destination)
    return
  }
  if (basename(source) === DUET_ANCHOR_MARKER_FILE && (await isAnchorMarkerFile(source))) return
  footprint.entries += 1
  if (info.isFile()) footprint.bytes += Number(info.size)
  if (
    footprint.entries > MAX_RECURSIVE_FILE_ENTRIES ||
    footprint.bytes > MAX_RECURSIVE_FILE_BYTES
  ) {
    throw new FileOperationError('recursive_limit_exceeded')
  }
  if (info.isDirectory()) {
    await mkdir(destination)
    for (const entry of await readdir(source)) {
      const sourceEntry = join(source, entry)
      await copyTree(sourceEntry, join(destination, entry), footprint)
    }
    return
  }
  await copyFile(source, destination)
}

class FileOperationError extends Error {
  constructor(readonly code: 'recursive_limit_exceeded') {
    super(code)
  }
}

async function safeExistingPath(
  path: string,
  driveDir: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: 'missing' | 'escape' }> {
  const root = await realpath(driveDir)
  let target: string
  try {
    target = await realpath(path)
  } catch (error) {
    if (isNotFoundError(error)) return { ok: false, reason: 'missing' }
    throw error
  }
  return isPathInside(root, target) ? { ok: true, path: target } : { ok: false, reason: 'escape' }
}

async function ensureSafeWriteParent(
  driveDir: string,
  relativePath: string,
): Promise<string | null> {
  await mkdir(driveDir, { recursive: true })
  const root = await realpath(driveDir)
  let current = root
  const parentParts = dirname(relativePath)
    .split('/')
    .filter(part => part.length > 0 && part !== '.')
  for (const part of parentParts) {
    const next = join(current, part)
    try {
      const resolved = await realpath(next)
      if (!isPathInside(root, resolved)) return null
      if (!(await stat(resolved)).isDirectory()) return null
      current = resolved
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      await mkdir(next).catch(mkdirError => {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError
      })
      const resolved = await realpath(next)
      if (!isPathInside(root, resolved)) return null
      current = resolved
    }
  }
  return current
}

function fileHeaders(
  path: string,
  info: Stats,
  etag: string,
  contentTypeOverride?: (path: string, detectedType: string) => string,
): Headers {
  const detected = driveFileMimeType(path)
  return new Headers({
    'accept-ranges': 'bytes',
    'content-security-policy': 'sandbox',
    etag,
    'last-modified': info.mtime.toUTCString(),
    'content-type':
      contentTypeOverride === undefined ? detected : contentTypeOverride(path, detected),
    'x-content-type-options': 'nosniff',
  })
}

async function currentEtag(path: string): Promise<string | null> {
  try {
    return await fileEtag(path)
  } catch {
    return null
  }
}

async function fileEtag(path: string): Promise<string> {
  const info = await stat(path, { bigint: true })
  return statEtag(info)
}

function statEtag(info: BigIntStats): string {
  return `"${info.dev.toString(16)}-${info.ino.toString(16)}-${info.size.toString(16)}-${info.mtimeNs.toString(16)}-${info.ctimeNs.toString(16)}"`
}

function matchesIfMatch(header: string, current: string): boolean {
  return header
    .split(',')
    .map(value => value.trim())
    .some(value => value === '*' || value === current)
}

async function isAnchorMarkerFile(path: string): Promise<boolean> {
  try {
    return /^duet-anchor:v1:[^:\n]+:[^:\n]+\n?$/.test(await readFile(path, 'utf8'))
  } catch {
    return false
  }
}

function parseSingleRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (header === null) return null
  if (!header.startsWith('bytes=') || header.includes(',')) return 'invalid'
  const spec = header.slice('bytes='.length)
  const match = spec.match(/^(\d*)-(\d*)$/)
  if (match === null) return 'invalid'
  const [, startRaw, endRaw] = match
  if (startRaw === undefined || endRaw === undefined) return 'invalid'
  if (startRaw === '' && endRaw === '') return 'invalid'
  if (size === 0) return 'invalid'
  if (startRaw === '') {
    const suffixLength = Number(endRaw)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    const start = Math.max(0, size - suffixLength)
    return { start, end: size - 1 }
  }
  const start = Number(startRaw)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  const requestedEnd = endRaw === '' ? size - 1 : Number(endRaw)
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return 'invalid'
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function rangeNotSatisfiable(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes */${size}`,
    },
  })
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isNotDirectoryError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOTDIR'
  )
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
  )
}

function isDirectoryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ['EISDIR', 'ENOTEMPTY', 'EPERM'].includes(String((error as { code?: unknown }).code))
  )
}

/**
 * The size the caller says it is about to send, or 0 when it will not say.
 *
 * A chunked upload declares nothing, and a declaration is only a promise — so
 * this decides nothing on its own. It lets an impossible upload be refused
 * early; a lying or silent one still meets the filesystem, which is the real
 * limit.
 */
function declaredBodyBytes(request: Request): number {
  const declared = Number(request.headers.get('content-length'))
  return Number.isFinite(declared) && declared > 0 ? declared : 0
}

function isOutOfSpaceError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    String((error as { code?: unknown }).code) === 'ENOSPC'
  )
}
