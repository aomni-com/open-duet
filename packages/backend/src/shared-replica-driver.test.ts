import { describe, expect, test } from 'bun:test'

import {
  deleteSharedReplicasForShare,
  detachSharedReplicasForShare,
  reconcileSharedReplicasForOrigin,
  seedSharedReplicasForShare,
  type SharedReplicaAdapter,
  type SharedReplicaGraph,
} from '../convex/domains/replication/shared'

type Row = {
  id: string
  workspaceId: string
  anchorId: string
  sourceOriginId?: string
  sourceShareId?: string
  value: string
  disabled?: boolean
}

function fixture() {
  const anchors = new Map([
    ['root', { id: 'root', path: 'project', state: 'active' as const }],
    ['nested', { id: 'nested', path: 'project/tools', state: 'active' as const }],
    ['outside', { id: 'outside', path: 'other', state: 'active' as const }],
  ])
  const rows: Row[] = [
    { id: 'origin-root', workspaceId: 'origin', anchorId: 'root', value: 'root-v1' },
    { id: 'origin-nested', workspaceId: 'origin', anchorId: 'nested', value: 'nested-v1' },
    { id: 'origin-outside', workspaceId: 'origin', anchorId: 'outside', value: 'outside-v1' },
  ]
  const shares = [
    {
      id: 'share-a',
      originWorkspaceId: 'origin',
      anchorId: 'root',
      recipientWorkspaceId: 'recipient-a',
      mountPath: 'shared/a',
    },
    {
      id: 'share-b',
      originWorkspaceId: 'origin',
      anchorId: 'root',
      recipientWorkspaceId: 'recipient-b',
      mountPath: 'shared/b',
    },
  ]
  const graph: SharedReplicaGraph = {
    loadAnchor: async id => anchors.get(id) ?? null,
    loadActiveSharesForOriginWorkspace: async workspaceId =>
      shares.filter(share => share.originWorkspaceId === workspaceId),
  }
  const adapter: SharedReplicaAdapter<Row> = {
    resourceName: 'fixture',
    loadOrigin: async id =>
      rows.find(row => row.id === id && row.sourceOriginId === undefined) ?? null,
    loadOriginsForWorkspace: async workspaceId =>
      rows.filter(row => row.workspaceId === workspaceId && row.sourceOriginId === undefined),
    loadReplicas: async originId => rows.filter(row => row.sourceOriginId === originId),
    loadReplicasForShare: async shareId => rows.filter(row => row.sourceShareId === shareId),
    projectOrigin: row => ({
      id: row.id,
      workspaceId: row.workspaceId,
      anchorId: row.anchorId,
      actorId: 'actor',
      isReplica: row.sourceShareId !== undefined,
    }),
    projectReplica: row => ({
      shareId: row.sourceShareId!,
      workspaceId: row.workspaceId,
      disabled: row.disabled === true,
    }),
    assertCanSeedReplicas: async () => {},
    createReplica: async ({ origin, share, replicaPath }) => {
      rows.push({
        id: `replica-${origin.id}-${share.id}`,
        workspaceId: share.recipientWorkspaceId,
        anchorId: replicaPath,
        sourceOriginId: origin.id,
        sourceShareId: share.id,
        value: origin.row.value,
      })
    },
    updateReplica: async (replica, origin) => {
      if (replica.value === origin.value) return false
      replica.value = origin.value
      return true
    },
    deleteReplica: async replica => {
      rows.splice(rows.indexOf(replica), 1)
    },
    detachReplica: async replica => {
      replica.sourceOriginId = undefined
      replica.sourceShareId = undefined
      replica.disabled = false
      return replica.anchorId
    },
  }
  return { adapter, graph, rows }
}

describe('shared replica convergence driver', () => {
  test('seed creates replicas only for active origins within the share root', async () => {
    const { adapter, graph, rows } = fixture()

    await seedSharedReplicasForShare(graph, [adapter], {
      shareId: 'share',
      originWorkspaceId: 'origin',
      recipientWorkspaceId: 'recipient',
      shareRootPath: 'project',
      mountPath: 'shared/project',
      actorId: 'actor',
      now: 10,
    })

    expect(
      rows
        .filter(row => row.sourceShareId === 'share')
        .map(row => [row.sourceOriginId, row.anchorId, row.value]),
    ).toEqual([
      ['origin-root', 'shared/project', 'root-v1'],
      ['origin-nested', 'shared/project/tools', 'nested-v1'],
    ])
  })

  test('reconcile keeps one replica per desired share, updates it, creates missing, and deletes stale', async () => {
    const { adapter, graph, rows } = fixture()
    rows.push(
      {
        id: 'keep',
        workspaceId: 'recipient-a',
        anchorId: 'shared/a',
        sourceOriginId: 'origin-root',
        sourceShareId: 'share-a',
        value: 'stale',
      },
      {
        id: 'duplicate',
        workspaceId: 'recipient-a',
        anchorId: 'shared/a-copy',
        sourceOriginId: 'origin-root',
        sourceShareId: 'share-a',
        value: 'duplicate',
      },
      {
        id: 'stale-share',
        workspaceId: 'recipient-old',
        anchorId: 'shared/old',
        sourceOriginId: 'origin-root',
        sourceShareId: 'share-old',
        value: 'old',
      },
    )

    const result = await reconcileSharedReplicasForOrigin(graph, adapter, { id: 'origin-root' }, 20)

    expect(rows.filter(row => row.sourceOriginId === 'origin-root')).toEqual([
      expect.objectContaining({ id: 'keep', sourceShareId: 'share-a', value: 'root-v1' }),
      expect.objectContaining({
        id: 'replica-origin-root-share-b',
        sourceShareId: 'share-b',
        anchorId: 'shared/b',
        value: 'root-v1',
      }),
    ])
    expect(new Set(result.affectedRecipientWorkspaceIds)).toEqual(
      new Set(['recipient-a', 'recipient-old', 'recipient-b']),
    )
  })

  test('detach preserves rows as origins while delete removes replicas', async () => {
    const { adapter, rows } = fixture()
    rows.push(
      {
        id: 'detach-me',
        workspaceId: 'recipient',
        anchorId: 'preserved-anchor',
        sourceOriginId: 'origin-root',
        sourceShareId: 'detach-share',
        value: 'detached',
        disabled: true,
      },
      {
        id: 'delete-me',
        workspaceId: 'recipient',
        anchorId: 'deleted-anchor',
        sourceOriginId: 'origin-root',
        sourceShareId: 'delete-share',
        value: 'deleted',
      },
    )

    expect(await detachSharedReplicasForShare([adapter], 'detach-share', 30)).toEqual({
      preservedAnchorIds: ['preserved-anchor'],
    })
    expect(rows.find(row => row.id === 'detach-me')).toEqual(
      expect.objectContaining({
        sourceOriginId: undefined,
        sourceShareId: undefined,
        disabled: false,
      }),
    )

    await deleteSharedReplicasForShare([adapter], 'delete-share', 31)
    expect(rows.some(row => row.id === 'delete-me')).toBe(false)
  })
})
