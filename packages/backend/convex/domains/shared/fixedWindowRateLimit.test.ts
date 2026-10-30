import { describe, expect, test } from 'bun:test'

import { consumeFixedWindow } from './fixedWindowRateLimit'

describe('fixed window consumption', () => {
  test('admits exactly the budget, then refuses for the rest of the window', async () => {
    const row = { _id: 'row', windowStart: 1_000, count: 0 }
    const outcomes = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcomes.push(await consume(row, { limit: 3, now: 1_500 }))
    }
    expect(outcomes.map(o => o.ok)).toEqual([true, true, true, false])
    expect(outcomes[3]).toMatchObject({ retryAfterSeconds: 1 })
  })

  test('stops writing once the window is spent', async () => {
    // The counter row is the single hottest document in the system: every
    // authenticated request bumps its principal's row, inside a long read-heavy
    // mutation. A client already over its budget writes nothing new — the answer
    // is refusal either way — so it must stop touching the row, or its own flood
    // is what makes every retry lose the write race.
    const row = { _id: 'row', windowStart: 1_000, count: 3 }
    let writes = 0
    const refusal = await consume(row, {
      limit: 3,
      now: 1_500,
      onPatch: () => {
        writes += 1
      },
    })
    expect(refusal.ok).toBe(false)
    expect(writes).toBe(0)
    expect(row.count).toBe(3)
  })

  test('resets the counter when the clock crosses into a new window', async () => {
    const row = { _id: 'row', windowStart: 1_000, count: 9 }
    const admitted = await consume(row, { limit: 3, now: 2_100 })
    expect(admitted).toMatchObject({ ok: true, remaining: 2, resetAt: 3_000 })
    expect(row).toMatchObject({ windowStart: 2_000, count: 1 })
  })
})

type Row = { _id: string; windowStart: number; count: number }

async function consume(
  row: Row,
  args: { limit: number; now: number; onPatch?: () => void },
): ReturnType<typeof consumeFixedWindow> {
  return await consumeFixedWindow({
    limit: args.limit,
    windowMs: 1_000,
    now: args.now,
    load: async () => row,
    insert: async () => {
      throw new Error('row already exists')
    },
    patch: async (_row, state) => {
      args.onPatch?.()
      row.windowStart = state.windowStart
      row.count = state.count
    },
  })
}
