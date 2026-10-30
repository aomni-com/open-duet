import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  deleteEntry,
  readEntry,
  slugFromFilename,
  updateEntry,
  type StoredMemory,
} from '@repo/agent/memory-store'

import {
  isPathInside,
  MAX_TRAIN_FILES,
  TrainRecordSchema,
  TrainRecordSourceSchema,
  TrainRecordSummarySchema,
} from '@repo/contract'
import type {
  TrainRecord,
  TrainRecordDeleteResult,
  TrainRecordSource,
  TrainRecordSummary,
} from '@repo/contract'

import type { TrainScope } from './agent-scope'
import { readScrapeProvenance } from './scrape-frontmatter'

/**
 * An archive id becomes a path segment under `~/.duet/train`, and both the
 * recursive delete and the source reader depend on it never traversing out.
 */
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export class MemoryStoreError extends Error {
  override readonly name = 'MemoryStoreError'

  constructor(
    readonly code: 'invalid_slug' | 'invalid_content' | 'not_found',
    message: string,
  ) {
    super(message)
  }
}

export interface MemoryStoreOptions {
  storeDir: string
  stateDir: string
}

export type ScopedTrainRecord = TrainRecord & { ownerScope?: string }

export async function readMemoryRecord(
  slug: string,
  options: MemoryStoreOptions,
): Promise<TrainRecord> {
  assertSlug(slug)
  try {
    return await toTrainRecord(await readEntry(options.storeDir, slug), options.stateDir)
  } catch (error) {
    throw mapReadError(error)
  }
}

export async function readScopedMemoryRecord(
  slug: string,
  scope: TrainScope,
  stateDir: string,
): Promise<ScopedTrainRecord> {
  try {
    return await readMemoryRecord(slug, { stateDir, storeDir: scope.memoriesDir })
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  for (const inherited of scope.inheritedDirs) {
    try {
      return {
        ...(await readMemoryRecord(slug, { stateDir, storeDir: inherited.memoriesDir })),
        inherited: true,
        ownerScope: inherited.ownerScope,
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  throw new MemoryStoreError('not_found', 'Training record was not found.')
}

export async function updateMemoryRecord(
  slug: string,
  content: string,
  options: MemoryStoreOptions,
): Promise<TrainRecord> {
  assertSlug(slug)
  try {
    return await toTrainRecord(await updateEntry(options.storeDir, slug, content), options.stateDir)
  } catch (error) {
    if (error instanceof Error && /blank|exceeds .*UTF-8 bytes/.test(error.message)) {
      throw new MemoryStoreError('invalid_content', 'Training content is empty or too large.')
    }
    throw mapReadError(error)
  }
}

export async function deleteMemoryRecord(
  slug: string,
  options: MemoryStoreOptions,
): Promise<TrainRecordDeleteResult> {
  assertSlug(slug)
  try {
    const deleted = await deleteEntry(options.storeDir, slug)
    if (deleted.archiveId !== undefined) {
      await removeMemoryArchive(options.stateDir, deleted.archiveId)
    }
    return { deleted: true, slug, memoryId: deleted.id }
  } catch (error) {
    throw mapReadError(error)
  }
}

/**
 * One archived source, opened for reading, or null for anything that is not a
 * real file inside this archive.
 *
 * `relPath` arrives from a URL, so the confinement is resolved rather than
 * lexical: a symlink planted under `files/` passes a string comparison and is
 * caught only by comparing real paths. Null covers every miss — absent,
 * escaped, symlinked, or never archived — because the route answers all of
 * them identically and must not become a probe for what exists outside.
 */
export async function openArchivedSource(
  stateDir: string,
  archiveId: string | undefined,
  relPath: string,
): Promise<{ relPath: string; path: string; size: number } | null> {
  if (archiveId === undefined || !ARCHIVE_ID_PATTERN.test(archiveId)) return null
  const filesRoot = await realpath(join(stateDir, 'train', archiveId, 'files')).catch(() => null)
  if (filesRoot === null) return null
  const candidate = resolve(filesRoot, relPath)
  if (!isPathInside(filesRoot, candidate)) return null
  const status = await lstat(candidate).catch(() => null)
  if (status === null || status.isSymbolicLink() || !status.isFile()) return null
  const resolved = await realpath(candidate).catch(() => null)
  if (resolved === null || !isPathInside(filesRoot, resolved)) return null
  return { relPath, path: resolved, size: status.size }
}

/**
 * Every archived source, confined. Retrain copies these back into the inbox,
 * so each one goes through the same resolution as a single served source
 * rather than being trusted because a manifest named it.
 */
export async function listArchivedSources(
  stateDir: string,
  archiveId: string | undefined,
): Promise<{ relPath: string; path: string; size: number; url?: string }[]> {
  const manifest = await readArchiveManifest(stateDir, archiveId)
  const sources = await projectArchiveSources(stateDir, archiveId, manifest)
  if (sources === null) return []
  const opened = await Promise.all(
    sources.map(async source => {
      const openedSource = await openArchivedSource(stateDir, archiveId, source.relPath)
      return openedSource === null
        ? null
        : { ...openedSource, ...(source.url === undefined ? {} : { url: source.url }) }
    }),
  )
  return opened.filter(
    (source): source is { relPath: string; path: string; size: number; url?: string } =>
      source !== null,
  )
}

export async function removeMemoryArchive(stateDir: string, archiveId: string): Promise<void> {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    throw new Error('Training archive id is invalid.')
  }
  await rm(join(stateDir, 'train', archiveId), { recursive: true, force: true })
}

async function toTrainRecord(entry: StoredMemory, stateDir: string): Promise<TrainRecord> {
  // One manifest read serves both the boolean and the source list.
  const manifest = await readArchiveManifest(stateDir, entry.archiveId)
  const sources = await projectArchiveSources(stateDir, entry.archiveId, manifest)
  return TrainRecordSchema.parse({
    ...toTrainRecordSummary(entry, manifest !== null),
    content: entry.content,
    ...(sources === null ? {} : { sources }),
  })
}

/**
 * What a memory was trained from, as the archive kept it.
 *
 * Only the single-record read calls this. The summary path deliberately does
 * not: resolving a scrape's URL means opening the archived copy, and on the
 * record list that would be one extra read per archived markdown file, per
 * memory in the store, on every render.
 *
 * Returns null when there is no readable manifest — the record still reports
 * `hasArchive: false` and the page shows its "sources are gone" state.
 */
async function projectArchiveSources(
  stateDir: string,
  archiveId: string | undefined,
  manifest: Record<string, unknown> | null,
): Promise<TrainRecordSource[] | null> {
  if (manifest === null || archiveId === undefined) return null
  // A manifest written by a different agent version may not carry `files` at
  // all; an empty source list is the honest projection, not a failed read.
  const files = Array.isArray(manifest.files) ? manifest.files : []
  if (files.length > MAX_TRAIN_FILES) return null
  const filesDir = join(stateDir, 'train', archiveId, 'files')
  const sources = await Promise.all(
    files.map(file => toSource(filesDir, file as Record<string, unknown>)),
  )
  return sources
    .filter((source): source is TrainRecordSource => source !== null)
    .map(source => TrainRecordSourceSchema.parse(source))
}

async function toSource(
  filesDir: string,
  file: Record<string, unknown>,
): Promise<TrainRecordSource | null> {
  const relPath = file.relPath
  if (typeof relPath !== 'string' || relPath.length === 0) return null
  const path = join(filesDir, relPath)
  // The manifest is a record of what was archived, not proof it is still
  // there: archives are pruned out of band, and a named-but-absent file drops
  // out of the list rather than failing the whole read.
  const status = await lstat(path).catch(() => null)
  if (status === null || !status.isFile()) return null
  const scrape = relPath.endsWith('.md')
    ? ((await readScrapeProvenance(path, status.size)) ?? null)
    : null
  return TrainRecordSourceSchema.parse({
    relPath,
    bytes: status.size,
    ...(scrape === null
      ? {}
      : { url: scrape.url, title: scrape.title, scrapedAt: scrape.scrapedAt }),
  })
}

function toTrainRecordSummary(entry: StoredMemory, hasArchive: boolean): TrainRecordSummary {
  const createdAt = new Date(entry.createdAt).toISOString()
  return TrainRecordSummarySchema.parse({
    slug: entry.slug,
    memoryId: entry.id,
    ...(entry.archiveId === undefined ? {} : { archiveId: entry.archiveId }),
    createdAt,
    observedDate: createdAt.slice(0, 10),
    ...(entry.headline === undefined ? {} : { headline: entry.headline }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.fileCount === undefined ? {} : { fileCount: entry.fileCount }),
    hasArchive,
  })
}

/**
 * The archive's manifest, or null when there isn't a readable one.
 *
 * Null is the whole meaning of `hasArchive: false` — the archive is a
 * `~/.duet` sibling of the drive, written by a separately released binary and
 * prunable out of band, so an unreadable manifest is an ordinary state rather
 * than an error.
 */
async function readArchiveManifest(
  stateDir: string,
  archiveId: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (archiveId === undefined) return null
  try {
    const value: unknown = JSON.parse(
      await readFile(join(stateDir, 'train', archiveId, 'manifest.json'), 'utf8'),
    )
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function assertSlug(slug: string): void {
  try {
    slugFromFilename(`${slug}.md`)
  } catch {
    throw new MemoryStoreError('invalid_slug', 'Training slug is invalid.')
  }
}

function mapReadError(error: unknown): unknown {
  if (error instanceof MemoryStoreError) return error
  if (
    (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
    (error instanceof Error && /Memory store does not exist/.test(error.message))
  ) {
    return new MemoryStoreError('not_found', 'Training record was not found.')
  }
  return error
}

function isNotFound(error: unknown): error is MemoryStoreError {
  return error instanceof MemoryStoreError && error.code === 'not_found'
}
