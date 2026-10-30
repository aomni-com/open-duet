import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { listStoreTolerant, readEntry, type StoredMemory } from '@repo/agent/memory-store'
import { z } from 'zod'

import {
  createBoundCursorCodec,
  MAX_AGENTS_PER_WORKSPACE,
  TrainRecordSummarySchema,
  type CollectionPage,
  type CollectionPageQuery,
  type TrainRecordSummary,
} from '@repo/contract'

import type { TrainScope } from './agent-scope'

type Key = { createdAt: number; mtimeMs: number; slug: string }
type Indexed = Key & { summary: TrainRecordSummary }
type SourcePosition = { scope: string; key?: Key }

const PositionSchema = z.object({
  sources: z.array(
    z.object({
      scope: z.string().min(1),
      key: z
        .object({ createdAt: z.number(), mtimeMs: z.number(), slug: z.string().min(1) })
        .optional(),
    }),
  ),
})
const cursorCodec = createBoundCursorCodec('train.records', PositionSchema)
const ORDER = 'created_at_desc_mtime_desc_slug_asc'

// A memory file the store cannot read is quarantined, not fatal: it leaves the
// index (so a stale row never outlives a broken file) and is reported here.
// One hand-written file must never take the whole scope — or, upstream, the
// VM sync cycle — down with it.
export interface TrainRecordSkipped {
  scope: string
  slug: string
  error: string
}
export type OnTrainRecordSkipped = (event: TrainRecordSkipped) => void

export class TrainRecordIndexError extends Error {
  override readonly name = 'TrainRecordIndexError'
  constructor(readonly code: 'index_unavailable') {
    super(code)
  }
}

export async function rebuildTrainRecordIndex(
  scope: TrainScope,
  stateDir: string,
  repairGenerations?: string | readonly string[],
  onRecordSkipped?: OnTrainRecordSkipped,
): Promise<void> {
  const rows = await scan(scope, stateDir, onRecordSkipped)
  const db = await openIndex(stateDir)
  try {
    db.transaction(() => {
      db.query('DELETE FROM train_record_summaries WHERE scope = ?').run(scope.key)
      const insert = db.query(`
        INSERT INTO train_record_summaries
          (scope, slug, created_at, mtime_ms, summary_json)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const row of rows) {
        insert.run(scope.key, row.slug, row.createdAt, row.mtimeMs, JSON.stringify(row.summary))
      }
      if (repairGenerations === undefined) {
        db.query('DELETE FROM train_record_repairs WHERE scope = ?').run(scope.key)
      } else {
        const remove = db.query('DELETE FROM train_record_repairs WHERE generation = ?')
        for (const generation of typeof repairGenerations === 'string'
          ? [repairGenerations]
          : repairGenerations) {
          remove.run(generation)
        }
      }
      db.query(`
        INSERT INTO train_record_ready (scope, record_count, source_fingerprint)
        VALUES (?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          record_count = excluded.record_count,
          source_fingerprint = excluded.source_fingerprint
      `).run(scope.key, rows.length, sourceFingerprint(scope.memoriesDir))
    })()
  } finally {
    db.close()
  }
}

export async function markTrainRecordRepair(
  scope: TrainScope,
  stateDir: string,
  slug: string,
): Promise<string> {
  return markTrainRecordRepairNow(scope, stateDir, slug)
}

export function markTrainRecordRepairNow(
  scope: TrainScope,
  stateDir: string,
  slug: string,
): string {
  const generation = crypto.randomUUID()
  const db = openIndex(stateDir)
  try {
    db.transaction(() => {
      // A new attempt supersedes failures it observed for the same record. The
      // replacement is atomic, so an older in-flight attempt can only clear its
      // retired generation and can never make the newer attempt look ready.
      db.query('DELETE FROM train_record_repairs WHERE scope = ? AND slug = ?').run(scope.key, slug)
      db.query(`
        INSERT INTO train_record_repairs (scope, slug, generation) VALUES (?, ?, ?)
      `).run(scope.key, slug, generation)
    })()
  } finally {
    db.close()
  }
  return generation
}

export function resetTrainRecordIndexNow(scope: TrainScope, stateDir: string): void {
  const db = openIndex(stateDir)
  try {
    db.transaction(() => {
      db.query('DELETE FROM train_record_repairs WHERE scope = ?').run(scope.key)
      db.query('DELETE FROM train_record_ready WHERE scope = ?').run(scope.key)
    })()
  } finally {
    db.close()
  }
}

export async function indexTrainRecord(
  scope: TrainScope,
  stateDir: string,
  slug: string,
  generation: string,
): Promise<void> {
  const rows = await scanRecord(scope, stateDir, slug)
  if (rows === null) throw new TrainRecordIndexError('index_unavailable')
  const db = await openIndex(stateDir)
  try {
    db.transaction(() => {
      db.query(`
        INSERT INTO train_record_summaries (scope, slug, created_at, mtime_ms, summary_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, slug) DO UPDATE SET
          created_at = excluded.created_at,
          mtime_ms = excluded.mtime_ms,
          summary_json = excluded.summary_json
      `).run(scope.key, slug, rows.createdAt, rows.mtimeMs, JSON.stringify(rows.summary))
      refreshRecordCount(db, scope.key)
      db.query(
        'DELETE FROM train_record_repairs WHERE scope = ? AND slug = ? AND generation = ?',
      ).run(scope.key, slug, generation)
    })()
  } finally {
    db.close()
  }
}

export async function reconcileTrainRecordIndex(
  scope: TrainScope,
  stateDir: string,
  slug: string,
  repairGenerations: readonly string[],
  onRecordSkipped?: OnTrainRecordSkipped,
): Promise<void> {
  const row = await scanRecord(scope, stateDir, slug, onRecordSkipped)
  const db = openIndex(stateDir)
  try {
    db.transaction(() => {
      if (row === null) {
        db.query('DELETE FROM train_record_summaries WHERE scope = ? AND slug = ?').run(
          scope.key,
          slug,
        )
      } else {
        db.query(`
          INSERT INTO train_record_summaries (scope, slug, created_at, mtime_ms, summary_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(scope, slug) DO UPDATE SET
            created_at = excluded.created_at,
            mtime_ms = excluded.mtime_ms,
            summary_json = excluded.summary_json
        `).run(scope.key, slug, row.createdAt, row.mtimeMs, JSON.stringify(row.summary))
      }
      refreshRecordCount(db, scope.key)
      const removeRepair = db.query('DELETE FROM train_record_repairs WHERE generation = ?')
      for (const generation of repairGenerations) removeRepair.run(generation)
    })()
  } finally {
    db.close()
  }
}

export async function removeTrainRecordFromIndex(
  scope: TrainScope,
  stateDir: string,
  slug: string,
  generation: string,
): Promise<void> {
  const db = await openIndex(stateDir)
  try {
    db.transaction(() => {
      db.query('DELETE FROM train_record_summaries WHERE scope = ? AND slug = ?').run(
        scope.key,
        slug,
      )
      refreshRecordCount(db, scope.key)
      db.query(
        'DELETE FROM train_record_repairs WHERE scope = ? AND slug = ? AND generation = ?',
      ).run(scope.key, slug, generation)
    })()
  } finally {
    db.close()
  }
}

function refreshRecordCount(db: Database, scope: string): void {
  db.query(`
    UPDATE train_record_ready
    SET record_count = (
      SELECT COUNT(*) FROM train_record_summaries WHERE scope = ?
    )
    WHERE scope = ?
  `).run(scope, scope)
}

export async function listIndexedTrainRecords(
  scope: TrainScope,
  stateDir: string,
  query: CollectionPageQuery,
): Promise<CollectionPage<TrainRecordSummary & { ownerScope?: string }>> {
  const sources = [
    { scope: scope.key, inherited: false },
    ...scope.inheritedDirs.map(source => ({ scope: source.ownerScope, inherited: true })),
  ]
  if (sources.length > MAX_AGENTS_PER_WORKSPACE + 1) {
    throw new TrainRecordIndexError('index_unavailable')
  }
  const binding = { subject: scope.key, filters: {}, order: ORDER } as const
  const decoded =
    query.cursor === undefined
      ? { sources: sources.map(source => ({ scope: source.scope })) }
      : await cursorCodec.decode(query.cursor, binding)
  if (
    decoded.sources.length !== sources.length ||
    decoded.sources.some((position, index) => position.scope !== sources[index]?.scope)
  ) {
    const { InvalidCollectionCursorError } = await import('@repo/contract')
    throw new InvalidCollectionCursorError()
  }

  const db = await openIndex(stateDir)
  try {
    assertReady(db, [
      { scope: scope.key, fingerprint: sourceFingerprint(scope.memoriesDir) },
      ...scope.inheritedDirs.map(source => ({
        scope: source.ownerScope,
        fingerprint: sourceFingerprint(source.memoriesDir),
      })),
    ])
    const positions: SourcePosition[] = decoded.sources.map(position => ({ ...position }))
    // One head row per source is enough for a k-way merge. Refilling only the
    // selected source avoids the old `(limit + 1) * sourceCount` prefetch; a
    // deeply nested agent can inherit many bounded stores, but one page still
    // inspects at most one source head plus one row per output/skip attempt.
    const buffers = sources.map((source, index) =>
      readPage(db, source.scope, positions[index]?.key, 1),
    )
    let rowsRead = buffers.reduce((total, buffer) => total + buffer.length, 0)
    const readBudget = sources.length + query.limit
    const items: Array<TrainRecordSummary & { ownerScope?: string }> = []
    while (items.length < query.limit) {
      let selected = -1
      for (let index = 0; index < buffers.length; index += 1) {
        if (buffers[index]?.length === 0) continue
        if (selected === -1 || compare(buffers[index]![0]!, buffers[selected]![0]!) < 0) {
          selected = index
        }
      }
      if (selected === -1) break
      const row = buffers[selected]!.shift()!
      positions[selected] = { scope: sources[selected]!.scope, key: keyOf(row) }
      if (rowsRead < readBudget) {
        const next = readPage(db, sources[selected]!.scope, positions[selected]!.key, 1)[0]
        rowsRead += Number(next !== undefined)
        if (next !== undefined) buffers[selected]!.push(next)
      }
      if (shadowed(db, sources, selected, row.slug)) continue
      items.push({
        ...row.summary,
        ...(sources[selected]!.inherited
          ? { inherited: true, ownerScope: sources[selected]!.scope }
          : {}),
      })
    }
    const hasMore = rowsRead >= readBudget || buffers.some(buffer => buffer.length > 0)
    return {
      items,
      nextCursor: hasMore
        ? await cursorCodec.encode({ ...binding, position: { sources: positions } })
        : null,
    }
  } finally {
    db.close()
  }
}

function readyRecordCount(db: Database, scope: string, fingerprint: string): number {
  const ready = db.query<{ record_count: number; source_fingerprint: string | null }, [string]>(
    'SELECT record_count, source_fingerprint FROM train_record_ready WHERE scope = ?',
  )
  const repair = db.query<{ present: number }, [string]>(
    'SELECT 1 AS present FROM train_record_repairs WHERE scope = ? LIMIT 1',
  )
  const row = ready.get(scope)
  if (row?.source_fingerprint !== fingerprint || repair.get(scope) !== null) {
    throw new TrainRecordIndexError('index_unavailable')
  }
  return row.record_count
}

function assertReady(db: Database, sources: Array<{ scope: string; fingerprint: string }>): void {
  for (const source of sources) readyRecordCount(db, source.scope, source.fingerprint)
}

export async function countIndexedTrainRecords(
  scope: TrainScope,
  stateDir: string,
): Promise<number> {
  const db = await openIndex(stateDir)
  try {
    return readyRecordCount(db, scope.key, sourceFingerprint(scope.memoriesDir))
  } finally {
    db.close()
  }
}

export function trainScopeFingerprint(scope: TrainScope): string {
  return JSON.stringify({
    key: scope.key,
    memoriesDir: sourceFingerprint(scope.memoriesDir),
    inherited: scope.inheritedDirs.map(source => ({
      ownerScope: source.ownerScope,
      memoriesDir: sourceFingerprint(source.memoriesDir),
    })),
  })
}

function sourceFingerprint(memoriesDir: string): string {
  return resolve(memoriesDir)
}

function readPage(db: Database, scope: string, key: Key | undefined, limit: number): Indexed[] {
  const rows =
    key === undefined
      ? db
          .query<RecordRow, [string, number]>(`${SELECT} WHERE scope = ? ${ORDER_BY} LIMIT ?`)
          .all(scope, limit)
      : db
          .query<
            RecordRow,
            [string, number, number, number, number, number, string, number]
          >(`${SELECT}
        WHERE scope = ? AND (
          created_at < ? OR
          (created_at = ? AND mtime_ms < ?) OR
          (created_at = ? AND mtime_ms = ? AND slug > ?)
        ) ${ORDER_BY} LIMIT ?`)
          .all(
            scope,
            key.createdAt,
            key.createdAt,
            key.mtimeMs,
            key.createdAt,
            key.mtimeMs,
            key.slug,
            limit,
          )
  return rows.map(row => ({
    createdAt: row.created_at,
    mtimeMs: row.mtime_ms,
    slug: row.slug,
    summary: TrainRecordSummarySchema.parse(JSON.parse(row.summary_json)),
  }))
}

function shadowed(
  db: Database,
  sources: Array<{ scope: string }>,
  sourceIndex: number,
  slug: string,
): boolean {
  for (let index = 0; index < sourceIndex; index += 1) {
    if (
      db
        .query('SELECT 1 FROM train_record_summaries WHERE scope = ? AND slug = ?')
        .get(sources[index]!.scope, slug) !== null
    )
      return true
  }
  return false
}

type RecordRow = { slug: string; created_at: number; mtime_ms: number; summary_json: string }
const SELECT = 'SELECT slug, created_at, mtime_ms, summary_json FROM train_record_summaries'
const ORDER_BY = 'ORDER BY created_at DESC, mtime_ms DESC, slug ASC'

function compare(left: Indexed, right: Indexed): number {
  return (
    right.createdAt - left.createdAt ||
    right.mtimeMs - left.mtimeMs ||
    (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0)
  )
}

function keyOf(row: Indexed): Key {
  return { createdAt: row.createdAt, mtimeMs: row.mtimeMs, slug: row.slug }
}

async function scan(
  scope: TrainScope,
  stateDir: string,
  onRecordSkipped?: OnTrainRecordSkipped,
): Promise<Indexed[]> {
  const skip = (slug: string, error: unknown) =>
    onRecordSkipped?.({ scope: scope.key, slug, error: errorMessage(error) })
  const entries = await listStoreTolerant(scope.memoriesDir, (path, error) =>
    skip(basename(path, '.md'), error),
  )
  const rows = await Promise.all(
    entries.map(entry =>
      scanEntry(scope.memoriesDir, stateDir, entry).catch((error: unknown) => {
        skip(entry.slug, error)
        return null
      }),
    ),
  )
  return rows.filter((row): row is Indexed => row !== null)
}

async function scanRecord(
  scope: TrainScope,
  stateDir: string,
  slug: string,
  onRecordSkipped?: OnTrainRecordSkipped,
): Promise<Indexed | null> {
  try {
    const entry = await readEntry(scope.memoriesDir, slug).catch(error => {
      if (error instanceof Error && /does not exist|not found/i.test(error.message)) return null
      throw error
    })
    return entry === null ? null : await scanEntry(scope.memoriesDir, stateDir, entry)
  } catch (error) {
    // Without a skip channel the caller is the writer of this record (the
    // train pipeline indexing its own output) and needs the failure.
    if (onRecordSkipped === undefined) throw error
    onRecordSkipped({ scope: scope.key, slug, error: errorMessage(error) })
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function scanEntry(
  storeDir: string,
  stateDir: string,
  entry: StoredMemory,
): Promise<Indexed> {
  const status = await lstat(join(storeDir, `${entry.slug}.md`))
  const createdAt = Number(entry.createdAt)
  const createdIso = new Date(createdAt).toISOString()
  const hasArchive =
    entry.archiveId === undefined
      ? false
      : await readFile(join(stateDir, 'train', entry.archiveId, 'manifest.json'), 'utf8').then(
          () => true,
          () => false,
        )
  return {
    createdAt,
    mtimeMs: status.mtimeMs,
    slug: entry.slug,
    summary: TrainRecordSummarySchema.parse({
      slug: entry.slug,
      memoryId: entry.id,
      ...(entry.archiveId === undefined ? {} : { archiveId: entry.archiveId }),
      createdAt: createdIso,
      observedDate: createdIso.slice(0, 10),
      ...(entry.headline === undefined ? {} : { headline: entry.headline }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.fileCount === undefined ? {} : { fileCount: entry.fileCount }),
      hasArchive,
    }),
  }
}

function openIndex(stateDir: string): Database {
  const path = join(stateDir, 'train', 'record-index.sqlite')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { create: true })
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS train_record_summaries (
      scope TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at REAL NOT NULL,
      mtime_ms REAL NOT NULL,
      summary_json TEXT NOT NULL,
      PRIMARY KEY (scope, slug)
    );
    CREATE INDEX IF NOT EXISTS train_record_order
      ON train_record_summaries (scope, created_at DESC, mtime_ms DESC, slug ASC);
    CREATE TABLE IF NOT EXISTS train_record_repairs (
      scope TEXT NOT NULL,
      slug TEXT NOT NULL,
      generation TEXT NOT NULL PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS train_record_repairs_scope
      ON train_record_repairs (scope, slug);
    CREATE TABLE IF NOT EXISTS train_record_ready (
      scope TEXT PRIMARY KEY,
      record_count INTEGER NOT NULL,
      source_fingerprint TEXT
    );
  `)
  const repairColumns = db
    .query<{ name: string }, []>('PRAGMA table_info(train_record_repairs)')
    .all()
  if (!repairColumns.some(column => column.name === 'generation')) {
    db.exec(`
      DROP TABLE train_record_repairs;
      CREATE TABLE train_record_repairs (
        scope TEXT NOT NULL,
        slug TEXT NOT NULL,
        generation TEXT NOT NULL PRIMARY KEY
      );
      CREATE INDEX train_record_repairs_scope ON train_record_repairs (scope, slug);
    `)
  }
  const readyColumns = db.query<{ name: string }, []>('PRAGMA table_info(train_record_ready)').all()
  if (!readyColumns.some(column => column.name === 'source_fingerprint')) {
    db.exec('ALTER TABLE train_record_ready ADD COLUMN source_fingerprint TEXT')
  }
  return db
}
