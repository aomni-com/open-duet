import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_ACTIVE_SHARES_PER_WORKSPACE,
  MAX_APPS_PER_WORKSPACE,
  MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
} from '@repo/contract'

import {
  assertWorkspaceCapacityCensusPasses,
  censusWorkspaceCapacities,
} from './workspace-capacity-census'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  )
})

test('workspace capacity census accepts each exact ceiling', async () => {
  const snapshot = await writeSnapshot({
    anchors: MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
    orphanedAnchors: 1,
    apps: MAX_APPS_PER_WORKSPACE,
    shares: MAX_ACTIVE_SHARES_PER_WORKSPACE,
  })
  try {
    const report = await censusWorkspaceCapacities(snapshot)
    expect(report).toMatchObject({
      workspacesChecked: MAX_ACTIVE_SHARES_PER_WORKSPACE,
      maximumObserved: {
        nonOrphanedAnchors: MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
        apps: MAX_APPS_PER_WORKSPACE,
        activeShares: MAX_ACTIVE_SHARES_PER_WORKSPACE,
      },
      violations: [],
    })
  } finally {
    await rm(snapshot, { force: true })
  }
})

test.each([
  ['nonOrphanedAnchors', { anchors: MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE + 1 }],
  ['apps', { apps: MAX_APPS_PER_WORKSPACE + 1 }],
  ['activeShares', { shares: MAX_ACTIVE_SHARES_PER_WORKSPACE + 1 }],
] as const)('workspace capacity census reports %s overflow', async (resource, overflow) => {
  const snapshot = await writeSnapshot(overflow)
  try {
    const report = await censusWorkspaceCapacities(snapshot)
    expect(report.violations).toEqual([
      expect.objectContaining({ workspaceId: 'workspace-main', resource }),
    ])
    expect(() => assertWorkspaceCapacityCensusPasses(report)).toThrow(
      'workspace capacity census failed',
    )
  } finally {
    await rm(snapshot, { force: true })
  }
})

async function writeSnapshot(
  counts: Partial<{ anchors: number; orphanedAnchors: number; apps: number; shares: number }>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'duet-capacity-census-test-'))
  directories.push(directory)
  const snapshot = join(directory, 'snapshot.zip')
  const rows = {
    anchors: [
      ...Array.from({ length: counts.anchors ?? 0 }, (_, index) => ({
        _id: `anchor-${index}`,
        workspaceId: 'workspace-main',
        state: index === 0 ? 'broken' : 'active',
      })),
      ...Array.from({ length: counts.orphanedAnchors ?? 0 }, (_, index) => ({
        _id: `orphaned-anchor-${index}`,
        workspaceId: 'workspace-main',
        state: 'orphaned',
      })),
    ],
    apps: Array.from({ length: counts.apps ?? 0 }, (_, index) => ({
      _id: `app-${index}`,
      workspaceId: 'workspace-main',
    })),
    shares: Array.from({ length: counts.shares ?? 0 }, (_, index) => ({
      _id: `share-${index}`,
      fromWorkspaceId: 'workspace-main',
      toWorkspaceId: index === 0 ? 'workspace-main' : `workspace-peer-${index}`,
      state: 'active',
    })),
  }
  for (const [table, documents] of Object.entries(rows)) {
    const tableDirectory = join(directory, table)
    await Bun.$`mkdir -p ${tableDirectory}`.quiet()
    await Bun.write(
      join(tableDirectory, 'documents.jsonl'),
      documents.map(document => JSON.stringify(document)).join('\n') +
        (documents.length > 0 ? '\n' : ''),
    )
  }
  await Bun.$`zip -q -r ${snapshot} anchors apps shares`.cwd(directory)
  await rm(join(directory, 'anchors'), { recursive: true })
  await rm(join(directory, 'apps'), { recursive: true })
  await rm(join(directory, 'shares'), { recursive: true })
  return snapshot
}
