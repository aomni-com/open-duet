import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serializeMemoryFile } from '@repo/agent/memory-store'

import { encodeActorContext } from '@repo/contract'

import type { TrainScope } from './agent-scope'
import { listIndexedTrainRecords, TrainRecordIndexError } from './record-index'
import { createTrainRecordIndexCoordinator } from './record-index-coordinator'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-train-index-coordinator-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('fails closed then reconciles an admitted atomic memory-file rename', async () => {
  const driveDir = join(root, 'drive')
  const stateDir = join(root, '.duet')
  const memoriesDir = join(driveDir, '.agents', 'memories')
  await mkdir(memoriesDir, { recursive: true })
  const scope = trainScope(memoriesDir)
  const coordinator = createTrainRecordIndexCoordinator({ driveDir, stateDir })
  await coordinator.syncScopes([scope])

  const temporary = join(memoriesDir, '.manual.tmp')
  await writeFile(temporary, memory('manual'))
  await rename(temporary, join(memoriesDir, 'manual.md'))
  coordinator.onFileEvent({
    kind: 'rename',
    entryKind: 'file',
    fromPath: '.agents/memories/.manual.tmp',
    path: '.agents/memories/manual.md',
    actor: encodeActorContext({ kind: 'system' }),
    at: 1,
  })

  await expect(listIndexedTrainRecords(scope, stateDir, { limit: 10 })).rejects.toBeInstanceOf(
    TrainRecordIndexError,
  )
  await coordinator.settled()
  expect((await listIndexedTrainRecords(scope, stateDir, { limit: 10 })).items).toMatchObject([
    { slug: 'manual', memoryId: 'mem_manual' },
  ])
})

test('rebuilds every current scope after the one workspace restore event', async () => {
  const driveDir = join(root, 'drive')
  const stateDir = join(root, '.duet')
  const memoriesDir = join(driveDir, '.agents', 'memories')
  await mkdir(memoriesDir, { recursive: true })
  await writeFile(join(memoriesDir, 'before.md'), memory('before'))
  const scope = trainScope(memoriesDir)
  const coordinator = createTrainRecordIndexCoordinator({ driveDir, stateDir })
  await coordinator.syncScopes([scope])

  await rm(join(memoriesDir, 'before.md'))
  await writeFile(join(memoriesDir, 'after.md'), memory('after'))
  coordinator.onFileEvent({
    kind: 'restore',
    actor: encodeActorContext({ kind: 'system' }),
    at: 2,
  })

  await expect(listIndexedTrainRecords(scope, stateDir, { limit: 10 })).rejects.toBeInstanceOf(
    TrainRecordIndexError,
  )
  await coordinator.settled()
  expect(
    (await listIndexedTrainRecords(scope, stateDir, { limit: 10 })).items.map(x => x.slug),
  ).toEqual(['after'])
})

test('a later valid event recovers a failed point reconciliation for the same record', async () => {
  const driveDir = join(root, 'drive')
  const stateDir = join(root, '.duet')
  const memoriesDir = join(driveDir, '.agents', 'memories')
  await mkdir(memoriesDir, { recursive: true })
  const scope = trainScope(memoriesDir)
  const coordinator = createTrainRecordIndexCoordinator({ driveDir, stateDir })
  await coordinator.syncScopes([scope])

  await writeFile(join(memoriesDir, 'retry.md'), 'malformed')
  coordinator.onFileEvent(fileWrite('retry.md', 3))
  await coordinator.settled()
  await expect(listIndexedTrainRecords(scope, stateDir, { limit: 10 })).rejects.toBeInstanceOf(
    TrainRecordIndexError,
  )

  await writeFile(join(memoriesDir, 'retry.md'), memory('retry'))
  coordinator.onFileEvent(fileWrite('retry.md', 4))
  await coordinator.settled()
  expect((await listIndexedTrainRecords(scope, stateDir, { limit: 10 })).items[0]?.slug).toBe(
    'retry',
  )
})

test('fails closed across watcher loss and rebuilds before recovery', async () => {
  const driveDir = join(root, 'drive')
  const stateDir = join(root, '.duet')
  const memoriesDir = join(driveDir, '.agents', 'memories')
  await mkdir(memoriesDir, { recursive: true })
  const scope = trainScope(memoriesDir)
  const coordinator = createTrainRecordIndexCoordinator({ driveDir, stateDir })
  await coordinator.syncScopes([scope])

  await writeFile(join(memoriesDir, 'missed.md'), memory('missed'))
  coordinator.onFileEventLoss()
  await expect(listIndexedTrainRecords(scope, stateDir, { limit: 10 })).rejects.toBeInstanceOf(
    TrainRecordIndexError,
  )

  await coordinator.recoverFileEventLoss()
  expect((await listIndexedTrainRecords(scope, stateDir, { limit: 10 })).items[0]?.slug).toBe(
    'missed',
  )
})

function trainScope(memoriesDir: string): TrainScope {
  return {
    key: 'root',
    agentRoot: join(root, 'drive'),
    memoriesDir,
    inheritedDirs: [],
    uploadsScope: { kind: 'root' },
    jobsDir: join(root, '.duet', 'train', 'jobs'),
  }
}

function memory(slug: string): string {
  return serializeMemoryFile({
    version: 1,
    id: `mem_${slug}`,
    kind: 'train',
    createdAt: 1,
    content: slug,
  })
}

function fileWrite(name: string, at: number) {
  return {
    kind: 'write' as const,
    path: `.agents/memories/${name}`,
    actor: encodeActorContext({ kind: 'system' }),
    at,
  }
}

test('quarantines an unparseable memory file instead of failing its scope', async () => {
  const driveDir = join(root, 'drive')
  const stateDir = join(root, '.duet')
  const memoriesDir = join(driveDir, '.agents', 'memories')
  await mkdir(memoriesDir, { recursive: true })
  await writeFile(join(memoriesDir, 'good.md'), memory('good'))
  // A record the store refuses under any frontmatter grammar: well-formed,
  // but naming a kind it does not have.
  await writeFile(
    join(memoriesDir, 'hand-written.md'),
    '---\nversion: 1\nid: "mem_dream"\nkind: "dream"\ncreatedAt: 1\n---\n# Facts\n',
  )
  const scope = trainScope(memoriesDir)
  const errors: unknown[] = []
  const skipped: Array<{ scope: string; slug: string; error: string }> = []
  const coordinator = createTrainRecordIndexCoordinator({
    driveDir,
    stateDir,
    onError: error => errors.push(error),
    onRecordSkipped: event => skipped.push(event),
  })

  await coordinator.syncScopes([scope])

  expect(errors).toEqual([])
  expect((await listIndexedTrainRecords(scope, stateDir, { limit: 10 })).items).toMatchObject([
    { slug: 'good', memoryId: 'mem_good' },
  ])
  expect(skipped).toEqual([
    {
      scope: scope.key,
      slug: 'hand-written',
      error: expect.stringContaining('Invalid memory kind: dream'),
    },
  ])

  // A later point event on the same bad file must not wedge the scope either.
  coordinator.onFileEvent(fileWrite('hand-written.md', 2))
  await coordinator.settled()
  expect(errors).toEqual([])
  expect((await listIndexedTrainRecords(scope, stateDir, { limit: 10 })).items).toMatchObject([
    { slug: 'good' },
  ])
  expect(skipped[1]).toEqual({
    scope: scope.key,
    slug: 'hand-written',
    error: expect.stringContaining('Invalid memory kind: dream'),
  })
})
