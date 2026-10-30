import { describe, expect, test } from 'bun:test'

import type { GatewayAnchor } from '@repo/contract'

import { createAnchorRegistry } from './anchor-registry'

const anchor = (id: string, path: string): GatewayAnchor => ({
  id,
  workspaceId: 'workspace_1',
  path,
  kind: 'app',
  settings: {},
  state: 'active',
  createdAt: 1,
  updatedAt: 1,
  markerNonce: `nonce-${id}`,
})

describe('anchor registry', () => {
  test('replaces the complete snapshot after marker reconciliation', async () => {
    const reconciled: GatewayAnchor[][] = []
    const registry = createAnchorRegistry({
      reconcileMarkers: async anchors => {
        reconciled.push(anchors)
        return []
      },
    })
    const first = [anchor('anchor_1', 'apps/one')]
    const second = [anchor('anchor_2', 'apps/two')]

    await registry.reconcile(first)
    await registry.reconcile(second)

    expect(registry.snapshot()).toEqual(second)
    expect(reconciled).toEqual([first, second])
  })

  test('serializes racing complete sets so readers observe only committed snapshots', async () => {
    const releases: Array<() => void> = []
    let closing = false
    const registry = createAnchorRegistry({
      reconcileMarkers: () =>
        closing
          ? Promise.resolve([])
          : new Promise(resolve => {
              releases.push(() => resolve([]))
            }),
    })
    const first = [anchor('anchor_1', 'apps/one')]
    const second = [anchor('anchor_2', 'apps/two'), anchor('anchor_3', 'apps/three')]

    const firstReconcile = registry.reconcile(first)
    const secondReconcile = registry.reconcile(second)
    try {
      await Promise.resolve()
      expect(registry.snapshot()).toEqual([])
      expect(releases).toHaveLength(1)
      releases[0]!()
      await firstReconcile
      await Promise.resolve()
      expect(registry.snapshot()).toEqual(first)
      expect(releases).toHaveLength(2)
      releases[1]!()
      await secondReconcile
      expect(registry.snapshot()).toEqual(second)
    } finally {
      closing = true
      releases.forEach(release => release())
      await Promise.allSettled([firstReconcile, secondReconcile])
    }
  })

  test('collapses sync requests arriving during a pass to one newest follow-up', async () => {
    const releases: Array<() => void> = []
    let closing = false
    const reconciled: GatewayAnchor[][] = []
    const registry = createAnchorRegistry({
      reconcileMarkers: anchors => {
        reconciled.push(anchors)
        return closing
          ? Promise.resolve([])
          : new Promise(resolve => releases.push(() => resolve([])))
      },
    })
    const first = [anchor('anchor_1', 'apps/one')]
    const stale = [anchor('anchor_2', 'apps/two')]
    const newest = [anchor('anchor_3', 'apps/three')]

    const requests = [registry.reconcileSync(first)]
    try {
      await Promise.resolve()
      requests.push(registry.reconcileSync(stale), registry.reconcileSync(newest))
      releases[0]!()
      await requests[0]
      await Promise.resolve()
      expect(reconciled).toEqual([first, newest])
      releases[1]!()
      await Promise.all(requests.slice(1))
      expect(registry.snapshot()).toEqual(newest)
    } finally {
      closing = true
      releases.forEach(release => release())
      await Promise.allSettled(requests)
    }
  })
})
