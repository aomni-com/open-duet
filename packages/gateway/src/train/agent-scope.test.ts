import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayAnchor } from '@repo/contract'

import { resolveTrainScope } from './agent-scope'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-train-agent-scope-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('train agent scope', () => {
  test('resolves nested agents with nearest-first parent and drive-root inheritance', async () => {
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    await mkdir(join(driveDir, 'agents', 'parent', 'children', 'child'), { recursive: true })
    const anchors = [
      gatewayAnchor('anchor-parent', 'agents/parent', 'agent-parent'),
      gatewayAnchor('anchor-child', 'agents/parent/children/child', 'agent-child'),
    ]

    const scope = resolveTrainScope({
      anchorId: 'anchor-child',
      anchors,
      driveDir,
      stateDir,
    })

    expect(scope).toEqual({
      key: 'anchor-child',
      agentRoot: join(driveDir, 'agents', 'parent', 'children', 'child'),
      memoriesDir: join(driveDir, 'agents', 'parent', 'children', 'child', '.agents', 'memories'),
      // Only stores some Train page can serve: each ancestor AGENT's root
      // store and the drive root's. Intermediate directories' hand-made
      // stores still inject at session runtime but are not listed — listing
      // them attributed records to owners whose pages 404 on the detail.
      inheritedDirs: [
        {
          ownerScope: 'anchor-parent',
          memoriesDir: join(driveDir, 'agents', 'parent', '.agents', 'memories'),
        },
        {
          ownerScope: 'root',
          memoriesDir: join(driveDir, '.agents', 'memories'),
        },
      ],
      uploadsScope: { kind: 'agent', anchorId: 'anchor-child' },
      jobsDir: join(stateDir, 'train', 'jobs'),
    })
  })

  test('rejects traversal anchor ids before lookup', async () => {
    const driveDir = join(root, 'drive')
    await mkdir(driveDir, { recursive: true })

    expect(() =>
      resolveTrainScope({
        anchorId: '../escape',
        anchors: [],
        driveDir,
        stateDir: join(root, '.duet'),
      }),
    ).toThrow('invalid_anchor_id')
  })

  test('reports a safe but unknown anchor as not found', async () => {
    const driveDir = join(root, 'drive')
    await mkdir(driveDir, { recursive: true })

    expect(() =>
      resolveTrainScope({
        anchorId: 'missing-anchor',
        anchors: [],
        driveDir,
        stateDir: join(root, '.duet'),
      }),
    ).toThrow('not_found')
  })

  test('treats a share mount with a projected agent id as an agent scope', async () => {
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    await mkdir(join(driveDir, 'shared', 'reviewer'), { recursive: true })
    const anchor = {
      ...gatewayAnchor('share-anchor', 'shared/reviewer', 'replica-agent'),
      kind: 'share-mount' as const,
    }

    const scope = resolveTrainScope({
      anchorId: anchor.id,
      anchors: [anchor],
      driveDir,
      stateDir,
    })

    expect(scope.agentRoot).toBe(join(driveDir, 'shared', 'reviewer'))
    expect(scope.uploadsScope).toEqual({ kind: 'agent', anchorId: 'share-anchor' })
  })
})

function gatewayAnchor(id: string, path: string, agentId: string): GatewayAnchor {
  return {
    id,
    agentId,
    workspaceId: 'workspace-1',
    path,
    kind: 'agent',
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}
