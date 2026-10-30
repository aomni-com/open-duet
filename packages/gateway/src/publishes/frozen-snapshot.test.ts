import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PUBLISH_SNAPSHOT_RESUME_GRACE_MS,
  PUBLISH_SNAPSHOT_RETENTION_GRACE_MS,
  createFrozenPublishSnapshot,
  pruneFrozenPublishSnapshots,
  resolveFrozenPublishRoot,
} from './frozen-snapshot'

let tempDir: string
let driveDir: string
let stateDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-publish-freeze-'))
  driveDir = join(tempDir, 'drive')
  stateDir = join(tempDir, '.duet')
  await mkdir(join(driveDir, 'hub', 'agent'), { recursive: true })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('snapshot copies the visible subtree with the same floor and symlink policy as zip', async () => {
  await writeFile(join(driveDir, 'hub', 'agent', 'AGENT.md'), 'frozen')
  await writeFile(join(driveDir, 'hub', '.notes'), 'public dotfile')
  await mkdir(join(driveDir, 'hub', '.git'), { recursive: true })
  await writeFile(join(driveDir, 'hub', '.git', 'config'), 'secret')
  await mkdir(join(driveDir, 'hub', 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(driveDir, 'hub', 'node_modules', 'pkg', 'index.js'), 'excluded')
  await symlink('agent/AGENT.md', join(driveDir, 'hub', 'alias.md'))

  await createFrozenPublishSnapshot({
    stateDir,
    driveDir,
    publishId: 'publish-1',
    generation: 'gen-1',
    anchorPath: 'hub',
    kind: 'folder',
  })

  const root = await resolveFrozenPublishRoot({
    stateDir,
    publishId: 'publish-1',
    generation: 'gen-1',
    anchorPath: 'hub',
    kind: 'folder',
  })
  expect(root).not.toBeNull()
  expect(await readFile(join(root!, 'hub', 'agent', 'AGENT.md'), 'utf8')).toBe('frozen')
  expect(await readFile(join(root!, 'hub', '.notes'), 'utf8')).toBe('public dotfile')
  await expect(readFile(join(root!, 'hub', '.git', 'config'), 'utf8')).rejects.toThrow()
  await expect(
    readFile(join(root!, 'hub', 'node_modules', 'pkg', 'index.js'), 'utf8'),
  ).rejects.toThrow()
  await expect(readFile(join(root!, 'hub', 'alias.md'), 'utf8')).rejects.toThrow()
})

test('confirmed-generation GC keeps the active shadow through a five-minute replacement grace', async () => {
  await writeFile(join(driveDir, 'hub', 'agent', 'AGENT.md'), 'snapshot')
  for (const generation of ['old', 'current']) {
    await createFrozenPublishSnapshot({
      stateDir,
      driveDir,
      publishId: 'publish-1',
      generation,
      anchorPath: 'hub',
      kind: 'folder',
    })
  }
  const now = Date.now()
  const oldDir = join(stateDir, 'publish-snapshots', 'publish-1', 'old')
  await utimes(
    oldDir,
    new Date(now - PUBLISH_SNAPSHOT_RETENTION_GRACE_MS - 1),
    new Date(now - PUBLISH_SNAPSHOT_RETENTION_GRACE_MS - 1),
  )

  await pruneFrozenPublishSnapshots({
    stateDir,
    publishId: 'publish-1',
    keepGeneration: 'current',
    now,
  })

  expect(
    await resolveFrozenPublishRoot({
      stateDir,
      publishId: 'publish-1',
      generation: 'old',
      anchorPath: 'hub',
      kind: 'folder',
    }),
  ).toBeNull()
  expect(
    await resolveFrozenPublishRoot({
      stateDir,
      publishId: 'publish-1',
      generation: 'current',
      anchorPath: 'hub',
      kind: 'folder',
    }),
  ).not.toBeNull()
})

test('resume/delete GC without a kept generation reaps everything past the edge-cache bound', async () => {
  await writeFile(join(driveDir, 'hub', 'agent', 'AGENT.md'), 'snapshot')
  for (const generation of ['gen-a', 'gen-b']) {
    await createFrozenPublishSnapshot({
      stateDir,
      driveDir,
      publishId: 'publish-1',
      generation,
      anchorPath: 'hub',
      kind: 'folder',
    })
  }
  const now = Date.now()
  const aged = join(stateDir, 'publish-snapshots', 'publish-1', 'gen-a')
  await utimes(
    aged,
    new Date(now - PUBLISH_SNAPSHOT_RESUME_GRACE_MS - 1),
    new Date(now - PUBLISH_SNAPSHOT_RESUME_GRACE_MS - 1),
  )

  await pruneFrozenPublishSnapshots({ stateDir, publishId: 'publish-1', now })

  expect(
    await resolveFrozenPublishRoot({
      stateDir,
      publishId: 'publish-1',
      generation: 'gen-a',
      anchorPath: 'hub',
      kind: 'folder',
    }),
  ).toBeNull()
  // Within the edge-cache bound the snapshot survives so a stale cached
  // freeze resolution stays servable; it is the accepted residual.
  expect(
    await resolveFrozenPublishRoot({
      stateDir,
      publishId: 'publish-1',
      generation: 'gen-b',
      anchorPath: 'hub',
      kind: 'folder',
    }),
  ).not.toBeNull()
})
