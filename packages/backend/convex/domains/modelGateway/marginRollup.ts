import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { fnMutation } from '../credits/creditsShared'
import { USAGE_PERIODS, type UsageRollupGranularity } from '../credits/usageRollups'

// Small enough that a fold (read, stamp, upsert) stays a short transaction; a
// full batch chains the next one, so the first run backfills all history.
const FOLD_BATCH = 200
// Periods in one window: a month of days, a quarter of weeks, a year of months.
const WINDOW_PERIODS: Record<UsageRollupGranularity, number> = {
  daily: 30,
  weekly: 12,
  monthly: 12,
}
// Rows one window can hold: ~100 tier/model/provider combinations a day for 30
// days, with headroom. Past it the view says so instead of undercounting silently.
const READ_LIMIT = 8000

type Rollup = Doc<'inferenceMarginRollups'>
type Dimension = Pick<Rollup, 'tier' | 'model' | 'provider' | 'routeSource'>
type Amounts = Pick<Rollup, 'calls' | 'upstreamCostMicroUsd' | 'billedCostMicroUsd'>
type TierAmounts = Amounts & Pick<Rollup, 'tier'>

/**
 * Counts settled generations that no fold has counted yet. The to-do list is
 * the unstamped half of `by_status_margin_rolled_up`, and each counted row is
 * stamped in the same transaction as its rollup, so a concurrent fold conflicts
 * and retries rather than counting a row twice. Settled rows are terminal:
 * nothing unstamps one, so each settlement is counted exactly once.
 */
export async function foldInferenceMarginImpl(ctx: MutationCtx, args: { internalKey: string }) {
  requireApiInternalKey(args.internalKey)
  const now = Date.now()
  const pending = await ctx.db
    .query('gatewayGenerations')
    .withIndex('by_status_margin_rolled_up', q =>
      q.eq('status', 'settled').eq('marginRolledUpAt', undefined),
    )
    .take(FOLD_BATCH)

  const deltas = new Map<string, Dimension & Amounts & Pick<Rollup, 'granularity' | 'periodKey'>>()
  for (const generation of pending) {
    const dimension: Dimension = {
      tier: generation.tier,
      model: generation.model,
      provider: generation.upstreamMetadata?.provider,
      routeSource: generation.upstreamMetadata?.routeSource ?? 'vercel',
    }
    for (const granularity of Object.keys(USAGE_PERIODS) as UsageRollupGranularity[]) {
      const periodKey = USAGE_PERIODS[granularity].key(generation.createdAt)
      const key = JSON.stringify([
        granularity,
        periodKey,
        dimension.tier,
        dimension.model,
        dimension.provider,
        dimension.routeSource,
      ])
      const delta = deltas.get(key) ?? { granularity, periodKey, ...dimension, ...emptyAmounts() }
      addAmounts(delta, {
        calls: 1,
        upstreamCostMicroUsd: generation.upstreamCostMicroUsd ?? 0,
        billedCostMicroUsd: generation.billedCostMicroUsd ?? 0,
      })
      deltas.set(key, delta)
    }
    await ctx.db.patch(generation._id, { marginRolledUpAt: now })
  }

  for (const delta of deltas.values()) {
    let existing = await ctx.db
      .query('inferenceMarginRollups')
      .withIndex('by_granularity_period_dimension', q =>
        q
          .eq('granularity', delta.granularity)
          .eq('periodKey', delta.periodKey)
          .eq('tier', delta.tier)
          .eq('model', delta.model)
          .eq('provider', delta.provider)
          .eq('routeSource', delta.routeSource),
      )
      .first()
    // Rows folded before routeSource existed are Vercel rows. Promote one when
    // the new fold reaches the same dimension so old history does not split.
    if (existing === null && delta.routeSource === 'vercel') {
      existing = await ctx.db
        .query('inferenceMarginRollups')
        .withIndex('by_granularity_period_dimension', q =>
          q
            .eq('granularity', delta.granularity)
            .eq('periodKey', delta.periodKey)
            .eq('tier', delta.tier)
            .eq('model', delta.model)
            .eq('provider', delta.provider)
            .eq('routeSource', undefined),
        )
        .first()
    }
    if (existing === null) {
      await ctx.db.insert('inferenceMarginRollups', { ...delta, updatedAt: now })
    } else {
      addAmounts(existing, delta)
      await ctx.db.patch(existing._id, {
        calls: existing.calls,
        upstreamCostMicroUsd: existing.upstreamCostMicroUsd,
        billedCostMicroUsd: existing.billedCostMicroUsd,
        routeSource: delta.routeSource,
        updatedAt: now,
      })
    }
  }

  if (pending.length === FOLD_BATCH) {
    await ctx.scheduler.runAfter(0, fnMutation('domains/modelGateway/model:foldInferenceMargin'), {
      internalKey: args.internalKey,
    })
  }
  return { folded: pending.length }
}

/**
 * One window of periods ending at the period holding `through` (never past
 * `now`). The response names its own bounds and an instant inside each
 * neighbouring window, so a reader pages through history without period math.
 */
export async function readInferenceMargin(
  ctx: QueryCtx,
  args: { granularity: UsageRollupGranularity; now: number; through?: number },
) {
  const periods = USAGE_PERIODS[args.granularity]
  const span = WINDOW_PERIODS[args.granularity]
  const endStart = periods.start(Math.min(args.through ?? args.now, args.now))
  const windowStart = periods.shift(endStart, 1 - span)
  const window = { start: periods.key(windowStart), end: periods.key(endStart) }
  const rows = await ctx.db
    .query('inferenceMarginRollups')
    .withIndex('by_granularity_period_dimension', q =>
      q
        .eq('granularity', args.granularity)
        .gte('periodKey', window.start)
        .lte('periodKey', window.end),
    )
    .take(READ_LIMIT + 1)
  const truncated = rows.length > READ_LIMIT
  if (truncated) rows.length = READ_LIMIT

  const totals = emptyAmounts()
  const byPeriod = new Map<string, Amounts & { period: string; tiers: Map<string, TierAmounts> }>()
  const byModel = new Map<string, Dimension & Amounts>()
  let updatedAt: number | undefined
  for (const row of rows) {
    addAmounts(totals, row)
    const period = byPeriod.get(row.periodKey) ?? {
      period: row.periodKey,
      ...emptyAmounts(),
      tiers: new Map<string, TierAmounts>(),
    }
    addAmounts(period, row)
    const tier = period.tiers.get(row.tier ?? '') ?? { tier: row.tier, ...emptyAmounts() }
    addAmounts(tier, row)
    period.tiers.set(row.tier ?? '', tier)
    byPeriod.set(row.periodKey, period)

    const routeSource = row.routeSource ?? 'vercel'
    const modelKey = JSON.stringify([row.tier, row.model, row.provider, routeSource])
    const model = byModel.get(modelKey) ?? {
      tier: row.tier,
      model: row.model,
      provider: row.provider,
      routeSource,
      ...emptyAmounts(),
    }
    addAmounts(model, row)
    byModel.set(modelKey, model)
    updatedAt = Math.max(updatedAt ?? 0, row.updatedAt)
  }

  const byCost = (left: Amounts, right: Amounts) =>
    right.upstreamCostMicroUsd - left.upstreamCostMicroUsd
  return {
    granularity: args.granularity,
    window,
    olderThrough: windowStart - 1,
    ...(endStart < periods.start(args.now)
      ? { newerThrough: Math.min(periods.shift(endStart, span), args.now) }
      : {}),
    totals,
    periods: [...byPeriod.values()]
      .sort((left, right) => right.period.localeCompare(left.period))
      .map(({ tiers, ...period }) => ({
        ...period,
        tiers: [...tiers.values()].sort(byCost).map(({ tier, ...amounts }) => ({
          ...(tier === undefined ? {} : { tier }),
          ...amounts,
        })),
      })),
    models: [...byModel.values()].sort(byCost).map(({ tier, provider, routeSource, ...model }) => ({
      ...(tier === undefined ? {} : { tier }),
      ...(provider === undefined ? {} : { provider }),
      ...(routeSource === undefined ? {} : { routeSource }),
      ...model,
    })),
    truncated,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function emptyAmounts(): Amounts {
  return { calls: 0, upstreamCostMicroUsd: 0, billedCostMicroUsd: 0 }
}

function addAmounts(target: Amounts, row: Amounts) {
  target.calls += row.calls
  target.upstreamCostMicroUsd += row.upstreamCostMicroUsd
  target.billedCostMicroUsd += row.billedCostMicroUsd
}
