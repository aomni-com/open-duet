import { describe, expect, test } from 'bun:test'

import {
  ACTION_KINDS,
  OWNERSHIP_MANIFEST,
  assertManifestPolicy,
  type CleanupPlannerFixture,
} from './ownership'
import { planUserCleanup } from './planner'

const fixturesUrl = new URL('./planner-fixtures.json', import.meta.url)

async function fixtures(): Promise<CleanupPlannerFixture[]> {
  return (await Bun.file(fixturesUrl).json()) as CleanupPlannerFixture[]
}

describe('cleanup ownership manifest', () => {
  test('is finite, assigns one outcome to every field, and covers planner owners', () => {
    expect(() => assertManifestPolicy(OWNERSHIP_MANIFEST)).not.toThrow()
    const fields = OWNERSHIP_MANIFEST.map(entry => `${entry.table}.${entry.field}`)
    expect(new Set(fields).size).toBe(fields.length)
    for (const kind of ACTION_KINDS) {
      expect(OWNERSHIP_MANIFEST.some(entry => entry.owner === kind)).toBe(true)
    }
  })

  test('overflow is a blocker rather than a truncated plan', () => {
    const result = planUserCleanup({
      targetUserId: 'user-target',
      workspaces: [
        {
          workspaceId: 'ws-overflow',
          status: 'active',
          billingUserId: 'user-target',
          members: [],
          overflow: { table: 'workspaceMembers', cap: 100, observed: 101 },
        },
      ],
    })
    expect(result.canStart).toBe(false)
    expect(result.blockers).toEqual([
      {
        code: 'bounded_read_overflow',
        workspaceId: 'ws-overflow',
        table: 'workspaceMembers',
        cap: 100,
        observed: 101,
      },
    ])
    expect(result.workspaceActions).toEqual([])
  })
})

describe('deterministic cleanup planner fixtures', async () => {
  for (const fixture of await fixtures()) {
    test(fixture.id, () => {
      const first = planUserCleanup(fixture.input)
      const second = planUserCleanup(fixture.input)
      expect(first).toEqual(fixture.expected)
      expect(second).toEqual(first)
    })
  }
})
