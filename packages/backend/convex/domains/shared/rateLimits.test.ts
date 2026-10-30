import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../../schema'
import { consumeRateLimit, rateLimitShardCount } from './rateLimits'

describe('rate limit sharding', () => {
  test('splits a large budget and leaves a small one whole', () => {
    // A budget only shards while every shard still holds a usable slice. Five
    // sends a day cannot be divided: the split itself would become the limit.
    expect(rateLimitShardCount(600)).toBeGreaterThan(1)
    expect(rateLimitShardCount(5)).toBe(1)
  })

  test('spreads one principal across documents while still enforcing a ceiling', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const admitted = await t.run(async ctx => {
      let count = 0
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const result = await consumeRateLimit(ctx, {
          key: 'api:credential:hot',
          limit: 600,
          windowMs: 60_000,
          now: 1_200_000,
        })
        if (result.ok) count += 1
      }
      return count
    })
    const rows = await t.run(async ctx => await ctx.db.query('rateLimits').collect())

    // Concurrent writers to one counter document serialise, and the mutation
    // that owns this call is long and read-heavy — it loses every OCC retry
    // under a burst. More than one document is the whole point.
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) expect(row.key.startsWith('api:credential:hot')).toBe(true)
    // Shard placement is random, so the enforced ceiling is a band: never above
    // the budget, and close enough beneath it that ordinary traffic is not
    // refused early.
    expect(admitted).toBeLessThanOrEqual(600)
    expect(admitted).toBeGreaterThan(500)
  })

  /* 600 divides by its shard count, so it cannot tell an exact split from a
     rounded-up one. Every other budget here is operator-set at runtime — the
     model gateway's per-workspace ceilings and the share-email daily cap both
     read theirs from the environment — so a budget that does not divide is an
     ordinary configuration, not an edge case, and a limiter that rounds each
     slice UP hands back a ceiling above the number the operator typed. */
  test('a budget that does not divide is never rounded up past itself', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const admitted = await t.run(async ctx => {
      let count = 0
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const result = await consumeRateLimit(ctx, {
          key: 'api:credential:awkward',
          limit: 500,
          windowMs: 60_000,
          now: 1_200_000,
        })
        if (result.ok) count += 1
      }
      return count
    })
    expect(admitted).toBeLessThanOrEqual(500)
  })

  test('keeps an unsharded budget exact', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const admitted = await t.run(async ctx => {
      let count = 0
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await consumeRateLimit(ctx, {
          key: 'shareemail:user-1',
          limit: 5,
          windowMs: 86_400_000,
          now: 1_200_000,
        })
        if (result.ok) count += 1
      }
      return count
    })
    expect(admitted).toBe(5)
    const rows = await t.run(async ctx => await ctx.db.query('rateLimits').collect())
    expect(rows.map(row => row.key)).toEqual(['shareemail:user-1'])
  })
})
