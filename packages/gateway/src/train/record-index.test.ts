import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serializeMemoryFile } from '@repo/agent/memory-store'

import type { TrainScope } from './agent-scope'
import {
  countIndexedTrainRecords,
  indexTrainRecord,
  listIndexedTrainRecords,
  markTrainRecordRepair,
  rebuildTrainRecordIndex,
  removeTrainRecordFromIndex,
  TrainRecordIndexError,
} from './record-index'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-train-record-index-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('pages an inherited ordered merge without scanning memory directories after cutover', async () => {
  const stateDir = join(root, '.duet')
  const rootDir = join(root, 'drive', '.agents', 'memories')
  const childDir = join(root, 'drive', 'child', '.agents', 'memories')
  await Promise.all([mkdir(rootDir, { recursive: true }), mkdir(childDir, { recursive: true })])
  await record(rootDir, 'shared', 300, 1_000)
  await record(rootDir, 'root-only', 200, 1_000)
  await record(childDir, 'child-first', 400, 1_000)
  await record(childDir, 'shared', 100, 1_000)

  const rootScope = scope('root', rootDir)
  const childScope: TrainScope = {
    ...scope('child', childDir),
    inheritedDirs: [{ ownerScope: 'root', memoriesDir: rootDir }],
  }
  await rebuildTrainRecordIndex(rootScope, stateDir)
  await rebuildTrainRecordIndex(childScope, stateDir)
  await Promise.all([rm(rootDir, { recursive: true }), rm(childDir, { recursive: true })])

  const first = await listIndexedTrainRecords(childScope, stateDir, { limit: 2 })
  const second = await listIndexedTrainRecords(childScope, stateDir, {
    limit: 2,
    cursor: first.nextCursor!,
  })

  expect(first.items.map(item => [item.slug, item.ownerScope])).toEqual([
    ['child-first', undefined],
    ['root-only', 'root'],
  ])
  expect(second.items.map(item => item.slug)).toEqual(['shared'])
  expect(second.items[0]?.inherited).toBeUndefined()
  expect(second.nextCursor).toBeNull()
})

test('binds continuations to their scope and refuses a scope with pending repair', async () => {
  const stateDir = join(root, '.duet')
  const leftDir = join(root, 'left')
  const rightDir = join(root, 'right')
  await Promise.all([mkdir(leftDir), mkdir(rightDir)])
  await record(leftDir, 'one', 2, 1_000)
  await record(leftDir, 'two', 1, 1_000)
  const left = scope('left', leftDir)
  const right = scope('right', rightDir)
  await rebuildTrainRecordIndex(left, stateDir)
  await rebuildTrainRecordIndex(right, stateDir)
  const page = await listIndexedTrainRecords(left, stateDir, { limit: 1 })

  await expect(
    listIndexedTrainRecords(right, stateDir, { limit: 1, cursor: page.nextCursor! }),
  ).rejects.toThrow('invalid_cursor')
  await markTrainRecordRepair(left, stateDir, 'one')
  await expect(listIndexedTrainRecords(left, stateDir, { limit: 1 })).rejects.toBeInstanceOf(
    TrainRecordIndexError,
  )
})

test('keeps a same-record repair unavailable until every concurrent writer completes', async () => {
  const stateDir = join(root, '.duet')
  const storeDir = join(root, 'memories')
  await mkdir(storeDir)
  await record(storeDir, 'shared', 1, 1_000)
  const target = scope('root', storeDir)
  await rebuildTrainRecordIndex(target, stateDir)

  const first = await markTrainRecordRepair(target, stateDir, 'shared')
  const second = await markTrainRecordRepair(target, stateDir, 'shared')
  await indexTrainRecord(target, stateDir, 'shared', first)

  await expect(listIndexedTrainRecords(target, stateDir, { limit: 1 })).rejects.toBeInstanceOf(
    TrainRecordIndexError,
  )

  await indexTrainRecord(target, stateDir, 'shared', second)
  expect((await listIndexedTrainRecords(target, stateDir, { limit: 1 })).items[0]?.slug).toBe(
    'shared',
  )
})

test('a successful same-record retry supersedes the failed repair generation it observed', async () => {
  const stateDir = join(root, '.duet')
  const storeDir = join(root, 'memories')
  await mkdir(storeDir)
  await record(storeDir, 'retry', 1, 1_000)
  const target = scope('root', storeDir)
  await rebuildTrainRecordIndex(target, stateDir)

  const failed = await markTrainRecordRepair(target, stateDir, 'retry')
  await writeFile(join(storeDir, 'retry.md'), 'malformed')
  await expect(indexTrainRecord(target, stateDir, 'retry', failed)).rejects.toThrow()

  await record(storeDir, 'retry', 2, 2_000)
  const retry = await markTrainRecordRepair(target, stateDir, 'retry')
  await indexTrainRecord(target, stateDir, 'retry', retry)

  expect((await listIndexedTrainRecords(target, stateDir, { limit: 1 })).items[0]).toMatchObject({
    slug: 'retry',
    createdAt: '1970-01-01T00:00:00.002Z',
  })
})

test('refuses a ready row when the same scope key resolves to another memory store', async () => {
  const stateDir = join(root, '.duet')
  const oldDir = join(root, 'old')
  const movedDir = join(root, 'moved')
  await Promise.all([mkdir(oldDir), mkdir(movedDir)])
  await record(oldDir, 'old-record', 1, 1_000)
  await record(movedDir, 'moved-record', 2, 1_000)
  await rebuildTrainRecordIndex(scope('agent', oldDir), stateDir)

  await expect(
    listIndexedTrainRecords(scope('agent', movedDir), stateDir, { limit: 10 }),
  ).rejects.toBeInstanceOf(TrainRecordIndexError)
})

test('keeps the dedicated count projection exact across point writes and deletes', async () => {
  const stateDir = join(root, '.duet')
  const storeDir = join(root, 'memories')
  await mkdir(storeDir)
  const target = scope('root', storeDir)
  await rebuildTrainRecordIndex(target, stateDir)
  expect(await countIndexedTrainRecords(target, stateDir)).toBe(0)

  await record(storeDir, 'added', 1, 1_000)
  const writeGeneration = await markTrainRecordRepair(target, stateDir, 'added')
  await indexTrainRecord(target, stateDir, 'added', writeGeneration)
  expect(await countIndexedTrainRecords(target, stateDir)).toBe(1)

  const deleteGeneration = await markTrainRecordRepair(target, stateDir, 'added')
  await rm(join(storeDir, 'added.md'))
  await removeTrainRecordFromIndex(target, stateDir, 'added', deleteGeneration)
  expect(await countIndexedTrainRecords(target, stateDir)).toBe(0)
})

test('promotes the pre-generation index schema through the startup rebuild', async () => {
  const stateDir = join(root, '.duet')
  const trainDir = join(stateDir, 'train')
  const storeDir = join(root, 'memories')
  await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(storeDir)])
  const db = new Database(join(trainDir, 'record-index.sqlite'), { create: true })
  db.exec(`
    CREATE TABLE train_record_summaries (
      scope TEXT NOT NULL, slug TEXT NOT NULL, created_at REAL NOT NULL,
      mtime_ms REAL NOT NULL, summary_json TEXT NOT NULL, PRIMARY KEY (scope, slug)
    );
    CREATE TABLE train_record_repairs (
      scope TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (scope, slug)
    );
    CREATE TABLE train_record_ready (
      scope TEXT PRIMARY KEY, record_count INTEGER NOT NULL
    );
  `)
  db.close()
  await record(storeDir, 'promoted', 1, 1_000)
  const target = scope('root', storeDir)

  await rebuildTrainRecordIndex(target, stateDir)

  expect((await listIndexedTrainRecords(target, stateDir, { limit: 10 })).items[0]?.slug).toBe(
    'promoted',
  )
})

test('uses the same binary slug tie-break inside SQLite and across inherited sources', async () => {
  const stateDir = join(root, '.duet')
  const rootDir = join(root, 'root')
  const childDir = join(root, 'child')
  await Promise.all([mkdir(rootDir), mkdir(childDir)])
  await record(rootDir, 'a1', 1, 1_000)
  await record(childDir, 'a-2', 1, 1_000)
  const rootScope = scope('root', rootDir)
  const childScope: TrainScope = {
    ...scope('child', childDir),
    inheritedDirs: [{ ownerScope: 'root', memoriesDir: rootDir }],
  }
  await rebuildTrainRecordIndex(rootScope, stateDir)
  await rebuildTrainRecordIndex(childScope, stateDir)

  const page = await listIndexedTrainRecords(childScope, stateDir, { limit: 2 })

  expect(page.items.map(item => item.slug)).toEqual(['a-2', 'a1'])
})

function scope(key: string, memoriesDir: string): TrainScope {
  return {
    key,
    agentRoot: root,
    memoriesDir,
    inheritedDirs: [],
    uploadsScope: { kind: 'root' },
    jobsDir: join(root, 'jobs'),
  }
}

async function record(dir: string, slug: string, createdAt: number, mtime: number): Promise<void> {
  const path = join(dir, `${slug}.md`)
  await writeFile(
    path,
    serializeMemoryFile({ version: 1, id: `mem_${slug}`, kind: 'train', createdAt, content: slug }),
  )
  await utimes(path, new Date(mtime), new Date(mtime))
}
