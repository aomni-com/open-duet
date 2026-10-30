import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayAnchor } from '@repo/contract'

import { createAnchorReconciler } from './anchors'

function anchor(path: string, id = 'anchor-1', markerNonce = 'nonce-1'): GatewayAnchor {
  return {
    id,
    workspaceId: 'workspace-1',
    path,
    kind: 'agent',
    settings: {},
    state: 'active',
    markerNonce,
    createdAt: 1,
    updatedAt: 1,
  }
}

test('present anchors reconcile without walking the drive, including derived paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-fast-path-'))
  const driveDir = join(root, 'drive')
  const anchorPath = 'node_modules/my-agent'
  try {
    await mkdir(join(driveDir, anchorPath), { recursive: true })
    await writeFile(join(driveDir, anchorPath, '.duet-anchor'), 'duet-anchor:v1:anchor-1:nonce-1\n')
    const telemetry: unknown[] = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(root, 'state'),
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })

    expect(await reconciler.reconcile([anchor(anchorPath)])).toEqual([])
    expect(telemetry).toEqual([
      expect.objectContaining({
        path: 'fast',
        anchorCount: 1,
        anchorProbes: 1,
        walkEntries: 0,
        excludedSubtrees: 0,
      }),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing anchor triggers one filtered mover search that finds an ordinary move', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-slow-path-'))
  const driveDir = join(root, 'drive')
  const stateDir = join(root, 'state')
  try {
    await mkdir(join(driveDir, 'agents', 'writer'), { recursive: true })
    await mkdir(join(driveDir, 'node_modules', 'large', 'nested'), { recursive: true })
    await mkdir(join(driveDir, '.git', 'objects', 'aa'), { recursive: true })
    const telemetry: Array<{ path: string; walkEntries: number; excludedSubtrees: number }> = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })
    const roster = [anchor('agents/writer')]
    await reconciler.reconcile(roster)
    await mkdir(join(driveDir, 'archive'), { recursive: true })
    await rename(join(driveDir, 'agents', 'writer'), join(driveDir, 'archive', 'writer'))

    expect(await reconciler.reconcile(roster)).toMatchObject([
      {
        anchorId: 'anchor-1',
        candidates: [expect.objectContaining({ toPath: 'archive/writer' })],
      },
    ])
    expect(telemetry.at(-1)).toMatchObject({
      path: 'slow',
      walkEntries: 6,
      excludedSubtrees: 2,
    })
    expect(await reconciler.reconcile([anchor('archive/writer')])).toEqual([])
    expect(telemetry.at(-1)).toMatchObject({ path: 'fast', walkEntries: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an exhausted mover search is conclusive instead of retrying the same walk forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-bounded-slow-path-'))
  const driveDir = join(root, 'drive')
  const stateDir = join(root, 'state')
  const originalPath = join(driveDir, 'agents', 'writer')
  try {
    await mkdir(originalPath, { recursive: true })
    const telemetry: Array<{
      path: string
      skipReason?: string
      walkEntries: number
      walkLimitReached?: boolean
    }> = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      walkEntryLimit: 4,
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })
    const roster = [anchor('agents/writer')]
    await reconciler.reconcile(roster)
    await rm(originalPath, { recursive: true })
    await Promise.all(
      Array.from({ length: 5 }, (_, index) => mkdir(join(driveDir, `clutter-${index}`))),
    )

    expect(await reconciler.reconcile(roster)).toMatchObject([
      {
        anchorId: 'anchor-1',
        candidates: [],
        missingIsConclusive: true,
      },
    ])
    expect(telemetry.at(-1)).toMatchObject({
      path: 'slow',
      walkLimitReached: true,
      walkEntries: 4,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a localized marker read failure never becomes conclusive deletion evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-uncertain-walk-'))
  const driveDir = join(root, 'drive')
  const originalPath = join(driveDir, 'agents', 'writer')
  const movedPath = join(driveDir, 'archive', 'writer')
  try {
    await mkdir(originalPath, { recursive: true })
    const skipped: string[] = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(root, 'state'),
      reportMoveCandidates: async () => undefined,
      onReconcileSkipped: reason => skipped.push(reason),
    })
    const roster = [anchor('agents/writer')]
    await reconciler.reconcile(roster)
    await mkdir(join(driveDir, 'archive'), { recursive: true })
    await rename(originalPath, movedPath)
    await rm(join(movedPath, '.duet-anchor'))
    await mkdir(join(movedPath, '.duet-anchor'))

    expect(await reconciler.reconcile(roster)).toEqual([])
    expect(skipped).toEqual(['drive_unreadable'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one mover index resolves marker matches for every missing anchor in linear work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-linear-slow-path-'))
  const driveDir = join(root, 'drive')
  try {
    await mkdir(join(driveDir, 'agents', 'writer'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'site'), { recursive: true })
    const telemetry: Array<{ walkEntries: number; markerResolutionOperations: number }> = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(root, 'state'),
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })
    const roster = [
      anchor('agents/writer', 'anchor-writer', 'nonce-writer'),
      anchor('apps/site', 'anchor-site', 'nonce-site'),
    ]
    await reconciler.reconcile(roster)
    await mkdir(join(driveDir, 'archive'), { recursive: true })
    await rename(join(driveDir, 'agents', 'writer'), join(driveDir, 'archive', 'writer'))
    await rename(join(driveDir, 'apps', 'site'), join(driveDir, 'archive', 'site'))

    expect(await reconciler.reconcile(roster)).toMatchObject([
      { anchorId: 'anchor-writer', markerMatches: ['archive/writer'] },
      { anchorId: 'anchor-site', markerMatches: ['archive/site'] },
    ])
    const slow = telemetry.at(-1)!
    expect(slow.markerResolutionOperations).toBeLessThanOrEqual(
      slow.walkEntries + 2 * roster.length,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore-in-flight skips before probing the drive or advancing missing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-restore-skip-'))
  let restoring = true
  const telemetry: unknown[] = []
  try {
    const reconciler = createAnchorReconciler({
      driveDir: join(root, 'missing-drive'),
      stateDir: join(root, 'missing-state'),
      restoreInFlight: () => restoring,
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })

    expect(await reconciler.reconcile([anchor('agents/writer')])).toEqual([])
    restoring = false
    await mkdir(join(root, 'missing-drive'), { recursive: true })
    expect(await reconciler.reconcile([anchor('agents/writer')])).toMatchObject([
      { consecutiveMissingPolls: 1 },
    ])
    expect(telemetry[0]).toEqual(
      expect.objectContaining({
        path: 'skipped',
        anchorProbes: 0,
        walkEntries: 0,
        skipReason: 'restore_in_flight',
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a replacement at an excluded anchor path stays present during mover search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-anchor-excluded-presence-'))
  const driveDir = join(root, 'drive')
  const anchorPath = 'node_modules/my-agent'
  try {
    await mkdir(join(driveDir, anchorPath), { recursive: true })
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(root, 'state'),
      reportMoveCandidates: async () => undefined,
    })
    await reconciler.reconcile([anchor(anchorPath)])
    await writeFile(join(driveDir, anchorPath, '.duet-anchor'), 'unexpected marker\n')

    expect(await reconciler.reconcile([anchor(anchorPath)])).toMatchObject([
      { anchorPathExists: true, consecutiveMissingPolls: 1 },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
