import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import {
  createBoundCursorCodec,
  MAX_TRAIN_URLS,
  sanitizeUploadFilename,
  isPathInside,
  type CollectionPageQuery,
  type TrainUploadEntry,
} from '@repo/contract'

import {
  agentUploadScope,
  ROOT_UPLOAD_SCOPE,
  uploadScopeKey,
  type UploadScope,
} from '../auth/upload-scope'
import { readScrapeProvenance } from './scrape-frontmatter'

export class UploadStoreError extends Error {
  constructor(
    readonly code:
      | 'invalid_filename'
      | 'path_is_symlink'
      | 'quota_exceeded'
      | 'too_many_files'
      | 'too_many_urls'
      | 'not_found'
      | 'upload_in_progress',
    readonly status: 400 | 404 | 409 | 413,
  ) {
    super(code)
    this.name = 'UploadStoreError'
  }
}

export interface UploadsStore {
  put(
    filename: string,
    body: ReadableStream<Uint8Array> | null,
    contentLength?: number,
  ): Promise<{ filename: string; size: number; uploadedAt: number }>
  putUrl(
    filename: string,
    body: ReadableStream<Uint8Array> | null,
    url: string,
    contentLength?: number,
  ): Promise<TrainUploadEntry>
  list(query?: CollectionPageQuery): Promise<{
    items: TrainUploadEntry[]
    nextCursor: string | null
    meta: { totalBytes: number; fileCount: number }
  }>
  remove(filename: string): Promise<void>
  /**
   * Replace the whole inbox with a set of files copied from elsewhere.
   *
   * Retrain's "start from what made this memory" gesture. Staged files are
   * scratch, so this clears without asking — but it validates the incoming set
   * against the caps first, so a refusal leaves the existing inbox intact
   * rather than destroying it on the way to failing.
   */
  restage(sources: { path: string; filename: string; size: number }[]): Promise<number>
  snapshotMove(destDir: string): Promise<void>
  sweepTemp(): Promise<void>
}

export interface UploadsStoreFactory {
  forScope(scope: UploadScope): UploadsStore
  sweepTemp(): Promise<void>
}

export function createUploadsStore(options: {
  trainDir: string
  capBytes: number
  maxFiles: number
}): UploadsStoreFactory {
  const trainDir = resolve(options.trainDir)
  const uploadsDir = join(trainDir, 'uploads')
  const tempDir = join(trainDir, 'temp')
  const stores = new Map<string, UploadsStore>()
  const scopes = new Map<string, UploadScope>([['root', ROOT_UPLOAD_SCOPE]])
  let initialized: Promise<void> | null = null

  async function ensureInitialized(): Promise<void> {
    initialized ??= (async () => {
      await mkdir(uploadsDir, { recursive: true, mode: 0o700 })
      await mkdir(tempDir, { recursive: true, mode: 0o700 })
      const [uploadsInfo, tempInfo] = await Promise.all([lstat(uploadsDir), lstat(tempDir)])
      if (uploadsInfo.isSymbolicLink() || tempInfo.isSymbolicLink()) {
        throw new UploadStoreError('path_is_symlink', 409)
      }
      if (!uploadsInfo.isDirectory() || !tempInfo.isDirectory()) {
        throw new UploadStoreError('path_is_symlink', 409)
      }
      if (uploadsInfo.dev !== tempInfo.dev) {
        throw new Error('upload inbox and temp directory must share a filesystem')
      }
    })()
    await initialized
  }

  function forScope(scope: UploadScope): UploadsStore {
    const key = uploadScopeKey(scope)
    scopes.set(key, scope)
    let store = stores.get(key)
    if (store === undefined) {
      store = createScopedUploadsStore({
        uploadsDir: join(uploadsDir, key),
        tempDir: join(tempDir, key),
        jobsDir: join(trainDir, 'jobs'),
        cursorSubject: key,
        ensureParentDirs: ensureInitialized,
        capBytes: options.capBytes,
        maxFiles: options.maxFiles,
      })
      stores.set(key, store)
    }
    return store
  }

  return {
    forScope,
    async sweepTemp() {
      await ensureInitialized()
      for (const entry of await readdir(tempDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'root') continue
        try {
          scopes.set(entry.name, agentUploadScope(entry.name))
        } catch {
          // Only directories created from validated scope keys belong to this store.
        }
      }
      await Promise.all([...scopes.values()].map(scope => forScope(scope).sweepTemp()))
    },
  }
}

function createScopedUploadsStore(options: {
  uploadsDir: string
  tempDir: string
  jobsDir: string
  cursorSubject: string
  ensureParentDirs: () => Promise<void>
  capBytes: number
  maxFiles: number
}): UploadsStore {
  const uploadsDir = resolve(options.uploadsDir)
  const tempDir = resolve(options.tempDir)
  const jobsDir = resolve(options.jobsDir)
  const cursorCodec = createBoundCursorCodec(
    'train.uploads.list',
    z.object({ filename: z.string().min(1) }).strict(),
  )
  const cursorBinding = {
    subject: options.cursorSubject,
    filters: {},
    order: 'filename_asc',
  } as const
  let committed = new Map<string, number>()
  let initialized: Promise<void> | null = null
  let mutex = Promise.resolve()
  let urlTail = Promise.resolve()
  const reservations = new Map<string, { filename: string; reserved: number; credit: number }>()
  const filenameTails = new Map<string, Promise<void>>()

  function withMutex<T>(work: () => Promise<T> | T): Promise<T> {
    const result = mutex.then(work, work)
    mutex = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function withFilenameLock<T>(filename: string, work: () => Promise<T>): Promise<T> {
    const previous = filenameTails.get(filename) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolveTail => {
      release = resolveTail
    })
    filenameTails.set(filename, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (filenameTails.get(filename) === tail) filenameTails.delete(filename)
    }
  }

  async function withUrlLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = urlTail
    let release!: () => void
    urlTail = new Promise<void>(resolveTail => {
      release = resolveTail
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }

  async function ensureInitialized(): Promise<void> {
    initialized ??= (async () => {
      await options.ensureParentDirs()
      await mkdir(uploadsDir, { recursive: true, mode: 0o700 })
      await mkdir(tempDir, { recursive: true, mode: 0o700 })
      const [uploadsInfo, tempInfo] = await Promise.all([lstat(uploadsDir), lstat(tempDir)])
      if (uploadsInfo.isSymbolicLink() || tempInfo.isSymbolicLink()) {
        throw new UploadStoreError('path_is_symlink', 409)
      }
      if (uploadsInfo.dev !== tempInfo.dev) {
        throw new Error('upload inbox and temp directory must share a filesystem')
      }
      const next = new Map<string, number>()
      for (const entry of await readdir(uploadsDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        if (!entry.isFile()) continue
        next.set(entry.name, Number((await stat(join(uploadsDir, entry.name))).size))
      }
      committed = next
    })()
    await initialized
  }

  function safeFilename(value: string): string {
    try {
      return sanitizeUploadFilename(value)
    } catch {
      throw new UploadStoreError('invalid_filename', 400)
    }
  }

  function usedBytes(): number {
    let total = 0
    for (const size of committed.values()) total += size
    for (const reservation of reservations.values()) {
      total += reservation.reserved - reservation.credit
    }
    return total
  }

  async function reserve(filename: string, contentLength: number | undefined): Promise<string> {
    return await withMutex(async () => {
      const existing = committed.get(filename) ?? 0
      const hinted = validContentLength(contentLength) ? contentLength : 0
      const id = crypto.randomUUID()
      const reservation = { filename, reserved: hinted, credit: existing }
      reservations.set(id, reservation)
      const fileNames = new Set(committed.keys())
      for (const active of reservations.values()) fileNames.add(active.filename)
      if (fileNames.size > options.maxFiles) {
        reservations.delete(id)
        throw new UploadStoreError('too_many_files', 413)
      }
      if (usedBytes() > options.capBytes) {
        reservations.delete(id)
        throw new UploadStoreError('quota_exceeded', 413)
      }
      return id
    })
  }

  async function accountReceived(id: string, received: number): Promise<void> {
    await withMutex(() => {
      const reservation = reservations.get(id)
      if (reservation === undefined) throw new Error('upload reservation was released')
      if (received <= reservation.reserved) return
      const previous = reservation.reserved
      reservation.reserved = received
      if (usedBytes() > options.capBytes) {
        reservation.reserved = previous
        throw new UploadStoreError('quota_exceeded', 413)
      }
    })
  }

  async function releaseReservation(id: string): Promise<void> {
    await withMutex(() => {
      reservations.delete(id)
    })
  }

  async function assertCommitPath(filename: string): Promise<string> {
    if ((await lstat(uploadsDir)).isSymbolicLink()) {
      throw new UploadStoreError('path_is_symlink', 409)
    }
    const root = await realpath(uploadsDir)
    const finalPath = join(root, filename)
    if (dirname(finalPath) !== root) throw new UploadStoreError('invalid_filename', 400)
    const info = await lstat(finalPath).catch(() => null)
    if (info?.isSymbolicLink()) throw new UploadStoreError('path_is_symlink', 409)
    if (info !== null && !info.isFile()) throw new UploadStoreError('path_is_symlink', 409)
    return finalPath
  }

  async function safeTempRoot(): Promise<string> {
    if ((await lstat(tempDir)).isSymbolicLink()) {
      throw new UploadStoreError('path_is_symlink', 409)
    }
    return await realpath(tempDir)
  }

  async function put(
    filenameValue: string,
    body: ReadableStream<Uint8Array> | null,
    contentLength?: number,
  ): Promise<{ filename: string; size: number; uploadedAt: number }> {
    const filename = safeFilename(filenameValue)
    return await withFilenameLock(filename, async () => {
      await ensureInitialized()
      const tempRoot = await safeTempRoot()
      const reservationId = await reserve(filename, contentLength)
      const tempPath = join(tempRoot, `upload-${crypto.randomUUID()}`)
      let received = 0
      let tempFile: Awaited<ReturnType<typeof open>> | null = null
      try {
        tempFile = await open(tempPath, 'wx', 0o600)
        const reader = body?.getReader()
        if (reader !== undefined) {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            received += chunk.value.byteLength
            await accountReceived(reservationId, received)
            await tempFile.write(chunk.value)
          }
        }
        await accountReceived(reservationId, received)
        await tempFile.sync()
        await tempFile.close()
        tempFile = null
        const finalPath = await assertCommitPath(filename)
        await rename(tempPath, finalPath)
        await withMutex(() => {
          committed.set(filename, received)
          reservations.delete(reservationId)
        })
        await fsyncDirectory(uploadsDir)
        const info = await stat(finalPath)
        return { filename, size: received, uploadedAt: info.mtimeMs }
      } catch (error) {
        await tempFile?.close().catch(() => undefined)
        await unlink(tempPath).catch(() => undefined)
        await releaseReservation(reservationId)
        throw error
      }
    })
  }

  return {
    put,

    async putUrl(filenameValue, body, url, contentLength) {
      const filename = safeFilename(filenameValue)
      return await withUrlLock(async () => {
        await ensureInitialized()
        let urlCount = 0
        let replacingUrl = false
        for (const [committedFilename, size] of committed) {
          if (!committedFilename.endsWith('.md')) continue
          const existingUrl = (
            await readScrapeProvenance(join(uploadsDir, committedFilename), size)
          )?.url
          if (existingUrl === undefined) continue
          urlCount += 1
          if (committedFilename === filename) replacingUrl = true
        }
        if (!replacingUrl && urlCount >= MAX_TRAIN_URLS) {
          throw new UploadStoreError('too_many_urls', 413)
        }
        return { ...(await put(filename, body, contentLength)), url }
      })
    },

    async list(query = { limit: 100 }) {
      await ensureInitialized()
      const after =
        query.cursor === undefined
          ? undefined
          : (await cursorCodec.decode(query.cursor, cursorBinding)).filename
      const filenames = [...committed.keys()]
        .filter(filename => after === undefined || filename > after)
        .sort()
      const pageFilenames = filenames.slice(0, query.limit)
      const items: TrainUploadEntry[] = []
      for (const filename of pageFilenames) {
        const path = join(uploadsDir, filename)
        const info = await stat(path)
        const size = Number(info.size)
        const url = filename.endsWith('.md')
          ? (await readScrapeProvenance(path, size))?.url
          : undefined
        items.push({
          filename,
          size,
          uploadedAt: info.mtimeMs,
          ...(url === undefined ? {} : { url }),
        })
      }
      const last = pageFilenames.at(-1)
      const nextCursor =
        filenames.length <= query.limit || last === undefined
          ? null
          : await cursorCodec.encode({ ...cursorBinding, position: { filename: last } })
      return {
        items,
        nextCursor,
        meta: { totalBytes: committedBytes(committed), fileCount: committed.size },
      }
    },

    async remove(filenameValue) {
      const filename = safeFilename(filenameValue)
      await withFilenameLock(filename, async () => {
        await ensureInitialized()
        const path = await assertCommitPath(filename)
        const info = await lstat(path).catch(() => null)
        if (info === null) throw new UploadStoreError('not_found', 404)
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new UploadStoreError('path_is_symlink', 409)
        }
        await unlink(path)
        await withMutex(() => {
          committed.delete(filename)
        })
        await fsyncDirectory(uploadsDir)
      })
    },

    async restage(sources) {
      await ensureInitialized()
      return await withMutex(async () => {
        if (reservations.size > 0) throw new UploadStoreError('upload_in_progress', 409)
        // Validate before destroying: an archive came out of an inbox so it
        // should fit back into one, but "should" is not a guarantee, and a
        // half-restaged inbox is worse than a refused one.
        const staged = new Map<string, number>()
        let totalBytes = 0
        for (const source of sources) {
          const filename = safeFilename(source.filename)
          staged.set(filename, source.size)
          totalBytes += source.size
        }
        if (staged.size > options.maxFiles) throw new UploadStoreError('too_many_files', 413)
        if (totalBytes > options.capBytes) throw new UploadStoreError('quota_exceeded', 413)

        for (const entry of await readdir(uploadsDir, { withFileTypes: true })) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue
          await unlink(join(uploadsDir, entry.name))
        }
        committed.clear()
        for (const source of sources) {
          const filename = safeFilename(source.filename)
          await copyFile(source.path, join(uploadsDir, filename))
          committed.set(filename, source.size)
        }
        await fsyncDirectory(uploadsDir)
        return committed.size
      })
    },

    async snapshotMove(destDir) {
      await ensureInitialized()
      await withMutex(async () => {
        if (reservations.size > 0) throw new UploadStoreError('upload_in_progress', 409)
        const requestedDestination = resolve(destDir)
        if (!isPathInside(jobsDir, requestedDestination)) {
          throw new Error('upload snapshot destination must be inside the train jobs directory')
        }
        const [realJobsDir, realDestinationParent] = await Promise.all([
          realpath(jobsDir),
          realpath(dirname(requestedDestination)),
        ])
        if (!isPathInside(realJobsDir, realDestinationParent)) {
          throw new Error('upload snapshot destination escaped the train jobs directory')
        }
        const destination = join(realDestinationParent, basename(requestedDestination))
        const [sourceInfo, destinationParentInfo] = await Promise.all([
          stat(uploadsDir),
          stat(dirname(destination)),
        ])
        if (sourceInfo.dev !== destinationParentInfo.dev) {
          throw new Error('upload inbox and snapshot directory must share a filesystem')
        }
        await fsyncDirectory(uploadsDir)
        await rename(uploadsDir, destination)
        await fsyncDirectory(dirname(uploadsDir))
        if (dirname(destination) !== dirname(uploadsDir)) {
          await fsyncDirectory(dirname(destination))
        }
        await mkdir(uploadsDir, { mode: 0o700 })
        await fsyncDirectory(dirname(uploadsDir))
        committed.clear()
      })
    },

    async sweepTemp() {
      await ensureInitialized()
      for (const entry of await readdir(tempDir)) {
        await rm(join(tempDir, basename(entry)), { recursive: true, force: true })
      }
      await fsyncDirectory(tempDir)
    },
  }
}

function committedBytes(committed: ReadonlyMap<string, number>): number {
  let total = 0
  for (const size of committed.values()) total += size
  return total
}

function validContentLength(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
