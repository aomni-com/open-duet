import type { Infer } from 'convex/values'

import { currentDayKey, currentMonthKey, currentWeekKey, isoWeekMonday } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { usageRollupMaxJitterMs } from '../../config'
import { usageRollupGranularityValidator } from '../../validators'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { fnMutation, type UsageGroup } from './creditsShared'
import type {
  applyUsageRollupBatchArgs,
  listUsageReportArgs,
  pruneDailyUsageArgs,
} from './internal'

const USAGE_ROLLUP_JITTER_MS = 5_000
const DAY_MS = 24 * 60 * 60 * 1000
const DAILY_USAGE_RETENTION_MS = 397 * 24 * 60 * 60 * 1000
const USAGE_REPORT_READ_LIMIT = 1000

export type UsageRollupProjection = {
  appId?: Id<'apps'>
  appSlug?: string
  inputTokens?: number
  outputTokens?: number
}

export type UsageRollupGranularity = Infer<typeof usageRollupGranularityValidator>

// The granularities a settlement folds into. `key` maps the charge instant to
// that row's period; `upperBound` closes an open-ended report, since keys sort
// lexicographically and no real key of that shape reaches the sentinel. `start`
// is the UTC instant a period opens, and `shift` moves a period start by whole
// periods (months are not a fixed length, so this cannot be arithmetic on
// milliseconds). One entry per granularity, checked against the validator, so a
// new granularity cannot be half-added.
export const USAGE_PERIODS: Record<
  UsageRollupGranularity,
  {
    key: (ts: number) => string
    upperBound: string
    start: (ts: number) => number
    shift: (start: number, periods: number) => number
  }
> = {
  daily: {
    key: currentDayKey,
    upperBound: '9999-99-99',
    start: ts => ts - (ts % DAY_MS),
    shift: (start, periods) => start + periods * DAY_MS,
  },
  weekly: {
    key: currentWeekKey,
    upperBound: '9999-W99',
    start: isoWeekMonday,
    shift: (start, periods) => start + periods * 7 * DAY_MS,
  },
  monthly: {
    key: currentMonthKey,
    upperBound: '9999-99',
    start: ts => Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth(), 1),
    shift: (start, periods) =>
      Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + periods, 1),
  },
}

export async function listUsageReportImpl(ctx: QueryCtx, args: Infer<typeof listUsageReportArgs>) {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId !== undefined)
      await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
  } else {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    await assertRole(ctx, args.workspaceId, 'viewer')
  }
  const rows = await ctx.db
    .query('usageRollups')
    .withIndex('by_workspace_granularity_period', q =>
      q
        .eq('workspaceId', args.workspaceId)
        .eq('granularity', args.period)
        .gte('periodKey', args.start ?? '')
        .lte('periodKey', args.end ?? USAGE_PERIODS[args.period].upperBound),
    )
    .filter(q => usageGroupFilter(q, args.group))
    // Usage reports cap the already-filtered group for one workspace and range.
    .take(USAGE_REPORT_READ_LIMIT)
  return rows.sort((a, b) => a.periodKey.localeCompare(b.periodKey)).map(row => usageReportRow(row))
}

export async function applyUsageRollupBatchImpl(
  ctx: MutationCtx,
  args: Infer<typeof applyUsageRollupBatchArgs>,
) {
  requireApiInternalKey(args.internalKey)
  if (args.spendMicroUsd <= 0) return null
  const now = args.now ?? Date.now()
  const dimensions = usageRollupDimensions(args)
  for (const granularity of Object.keys(USAGE_PERIODS) as UsageRollupGranularity[]) {
    for (const dimension of dimensions) {
      await foldUsageRollup(ctx, {
        ...dimension,
        workspaceId: args.workspaceId,
        granularity,
        periodKey: args.periodKeys[granularity],
        spendMicroUsd: args.spendMicroUsd,
        // Daily rows carry spend only; token counts ride the retained
        // granularities, which outlive the 397-day daily prune.
        ...(granularity === 'daily'
          ? {}
          : { inputTokens: args.inputTokens, outputTokens: args.outputTokens }),
        now,
      })
    }
  }
  return null
}

export async function pruneDailyUsageImpl(
  ctx: MutationCtx,
  args: Infer<typeof pruneDailyUsageArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const cutoff = USAGE_PERIODS.daily.key((args.now ?? Date.now()) - DAILY_USAGE_RETENTION_MS)
  const limit = args.limit ?? 500
  const candidates = await ctx.db
    .query('usageRollups')
    .withIndex('by_granularity_period', q => q.eq('granularity', 'daily').lte('periodKey', cutoff))
    // Pruning deletes at most one scheduled batch, so the read cap matches the mutation limit.
    .take(limit)
  let pruned = 0
  for (const row of candidates) {
    await ctx.db.delete(row._id)
    pruned += 1
  }
  return { pruned }
}

export async function scheduleUsageRollup(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    spendMicroUsd: number
    createdAt: number
    userId?: Id<'users'>
    dimensions: UsageRollupProjection
  },
): Promise<void> {
  const jitterMax = usageRollupMaxJitterMs(USAGE_ROLLUP_JITTER_MS)
  const jitterMs = Math.floor(Math.random() * Math.max(0, jitterMax))
  const shared = {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
    workspaceId: args.workspaceId,
    spendMicroUsd: args.spendMicroUsd,
    ...(args.userId === undefined ? {} : { userId: args.userId }),
    ...(args.dimensions.appId === undefined ? {} : { appId: args.dimensions.appId }),
    ...(args.dimensions.appSlug === undefined ? {} : { appSlug: args.dimensions.appSlug }),
  }
  const tokens = {
    ...(args.dimensions.inputTokens === undefined
      ? {}
      : { inputTokens: args.dimensions.inputTokens }),
    ...(args.dimensions.outputTokens === undefined
      ? {}
      : { outputTokens: args.dimensions.outputTokens }),
  }
  // One settlement folds into every granularity in one mutation, so the same
  // spend is counted once per period.
  await ctx.scheduler.runAfter(
    jitterMs,
    fnMutation('domains/credits/internal:applyUsageRollupBatch'),
    {
      ...shared,
      periodKeys: {
        daily: USAGE_PERIODS.daily.key(args.createdAt),
        weekly: USAGE_PERIODS.weekly.key(args.createdAt),
        monthly: USAGE_PERIODS.monthly.key(args.createdAt),
      },
      ...tokens,
    },
  )
}

function usageRollupDimensions(args: {
  userId?: Id<'users'>
  appId?: Id<'apps'>
  appSlug?: string
}): Array<{
  userId?: Id<'users'>
  appId?: Id<'apps'>
  appSlug?: string
}> {
  const rows: Array<{
    userId?: Id<'users'>
    appId?: Id<'apps'>
    appSlug?: string
  }> = [{}]
  if (args.userId !== undefined) rows.push({ userId: args.userId })
  if (args.appId !== undefined || args.appSlug !== undefined) {
    rows.push({ appId: args.appId, appSlug: args.appSlug })
  }
  return rows
}

async function foldUsageRollup(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    granularity: UsageRollupGranularity
    periodKey: string
    spendMicroUsd: number
    inputTokens?: number
    outputTokens?: number
    userId?: Id<'users'>
    appId?: Id<'apps'>
    appSlug?: string
    now: number
  },
): Promise<void> {
  const existing = await ctx.db
    .query('usageRollups')
    .withIndex('by_workspace_granularity_period_dimension', q =>
      q
        .eq('workspaceId', args.workspaceId)
        .eq('granularity', args.granularity)
        .eq('periodKey', args.periodKey)
        .eq('userId', args.userId)
        .eq('appId', args.appId)
        .eq('appSlug', args.appSlug),
    )
    .first()
  if (existing !== null) {
    await ctx.db.patch(existing._id, {
      spendMicroUsd: existing.spendMicroUsd + args.spendMicroUsd,
      inputTokens: sumOptional(existing.inputTokens, args.inputTokens),
      outputTokens: sumOptional(existing.outputTokens, args.outputTokens),
      updatedAt: Math.max(existing.updatedAt, args.now),
    })
    return
  }
  await ctx.db.insert('usageRollups', {
    workspaceId: args.workspaceId,
    granularity: args.granularity,
    periodKey: args.periodKey,
    spendMicroUsd: args.spendMicroUsd,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    userId: args.userId,
    appId: args.appId,
    appSlug: args.appSlug,
    updatedAt: args.now,
  })
}

function usageGroupFilter(
  q: Parameters<Parameters<ReturnType<QueryCtx['db']['query']>['filter']>[0]>[0],
  group: UsageGroup,
) {
  if (group === 'workspace') {
    return q.and(
      q.eq(q.field('userId'), undefined),
      q.eq(q.field('appId'), undefined),
      q.eq(q.field('appSlug'), undefined),
    )
  }
  if (group === 'user') {
    return q.and(
      q.neq(q.field('userId'), undefined),
      q.eq(q.field('appId'), undefined),
      q.eq(q.field('appSlug'), undefined),
    )
  }
  return q.or(q.neq(q.field('appId'), undefined), q.neq(q.field('appSlug'), undefined))
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
}

function usageReportRow(row: {
  workspaceId: Id<'workspaces'>
  periodKey: string
  spendMicroUsd: number
  userId?: Id<'users'>
  appId?: Id<'apps'>
  appSlug?: string
  inputTokens?: number
  outputTokens?: number
}) {
  return {
    workspaceId: row.workspaceId,
    period: row.periodKey,
    spendMicroUsd: row.spendMicroUsd,
    ...(row.userId === undefined ? {} : { userId: row.userId }),
    ...(row.appId === undefined ? {} : { appId: row.appId }),
    ...(row.appSlug === undefined ? {} : { appSlug: row.appSlug }),
    ...(row.inputTokens === undefined ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === undefined ? {} : { outputTokens: row.outputTokens }),
  }
}
