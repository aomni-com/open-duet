import { expect, test } from 'bun:test'

import { VmSyncResponseSchema } from './index'

test('strict sync requires the authoritative machine set so removals cannot remain stale', () => {
  const response = { pollAfterMs: 5000, anchors: [], updates: { paused: false } }
  expect(VmSyncResponseSchema.safeParse(response).success).toBe(false)
  expect(
    VmSyncResponseSchema.parse({ ...response, mirrorMachineIds: [] }).mirrorMachineIds,
  ).toEqual([])
})
