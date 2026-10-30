import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v, type Infer } from 'convex/values'

import { VM_USAGE_MAX_POINT_GAP_MS } from '@repo/contract'
import type { VmUsagePoint } from '@repo/exe'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole } from './authorization'

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const TELEMETRY_CHART_POINT_LIMIT = 120
export const TELEMETRY_PRUNE_BATCH_SIZE = 500
export const TELEMETRY_READ_LIMIT = 10_000

const BYTES_PER_MIB = 1024 * 1024
const BYTES_PER_GIB = 1024 ** 3

/**
 * THE writer. Every row in `vmTelemetrySamples` comes through here.
 *
 * Dedups on the provider's own timestamp, because `stat --range=24h` re-returns
 * the same points on every sweep — an hourly sampler sees each point about six
 * times. Getting this wrong does not look like a bug: it looks like a VM that
 * used six times more CPU than it did, and it is indistinguishable from real
 * usage after the fact.
 *
 * There is deliberately no watermark on the workspace row. The newest stored
 * `at` IS the watermark; a denormalized copy would be a second owner of "what
 * is stored" and could drift from it.
 */
export async function recordProviderTelemetrySamplesWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    expectedVmName?: string
    points: readonly VmUsagePoint[]
  },
): Promise<{ inserted: number; skipped: number }> {
  if (args.points.length === 0) return { inserted: 0, skipped: 0 }

  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return { inserted: 0, skipped: args.points.length }
  // A delayed action must not attribute a dead VM's usage to its replacement.
  if (args.expectedVmName !== undefined && workspace.vmName !== args.expectedVmName) {
    return { inserted: 0, skipped: args.points.length }
  }

  const sorted = [...args.points].sort((left, right) => left.at - right.at)
  const earliest = sorted[0]!.at
  const existing = await ctx.db
    .query('vmTelemetrySamples')
    .withIndex('by_workspace_at', q => q.eq('workspaceId', args.workspaceId).gte('at', earliest))
    .collect()
  const seen = new Set(existing.map(sample => sample.at))

  let inserted = 0
  for (const point of sorted) {
    if (seen.has(point.at)) continue
    seen.add(point.at)
    await ctx.db.insert('vmTelemetrySamples', {
      workspaceId: args.workspaceId,
      at: point.at,
      cpuCores: point.cpuCores,
      cpuNominalCores: point.cpuNominalCores,
      memUsedBytes: point.memUsedGb * BYTES_PER_GIB,
      memTotalBytes: point.memTotalGb * BYTES_PER_GIB,
      ...(point.fsUsedGb === undefined ? {} : { fsUsedGb: point.fsUsedGb }),
      ...(point.fsTotalGb === undefined ? {} : { fsTotalGb: point.fsTotalGb }),
    })
    inserted += 1
  }
  return { inserted, skipped: sorted.length - inserted }
}

/**
 * Stored rows in the units the fee bills in. The charge owner reads through here.
 *
 * Reads one gap-clamp EARLIER than the window on purpose. Each point owns the
 * interval behind it, so the first point inside a window has a predecessor that
 * sits outside it — drop that predecessor and the opening interval is lost, at
 * every window edge, forever. The integrator clips to the window; this just
 * makes sure it has the point it needs to clip against. The trailing bound is
 * inclusive for the same reason at the other edge.
 */
export async function listVmUsagePointsForWindow(
  ctx: QueryCtx,
  args: { workspaceId: Id<'workspaces'>; startAt: number; endAt: number },
): Promise<VmUsagePoint[]> {
  const rows = await ctx.db
    .query('vmTelemetrySamples')
    .withIndex('by_workspace_at', q =>
      q
        .eq('workspaceId', args.workspaceId)
        .gte('at', args.startAt - VM_USAGE_MAX_POINT_GAP_MS)
        .lte('at', args.endAt),
    )
    .collect()
  return rows.flatMap(row =>
    row.cpuCores === undefined ||
    row.cpuNominalCores === undefined ||
    row.memUsedBytes === undefined ||
    row.memTotalBytes === undefined
      ? []
      : [
          {
            at: row.at,
            cpuCores: row.cpuCores,
            cpuNominalCores: row.cpuNominalCores,
            memUsedGb: row.memUsedBytes / BYTES_PER_GIB,
            memTotalGb: row.memTotalBytes / BYTES_PER_GIB,
            ...(row.fsUsedGb === undefined ? {} : { fsUsedGb: row.fsUsedGb }),
            ...(row.fsTotalGb === undefined ? {} : { fsTotalGb: row.fsTotalGb }),
          },
        ],
  )
}

export const pruneTelemetrySamplesArgs = v.object({
  internalKey: v.string(),
  now: v.optional(v.number()),
  limit: v.optional(v.number()),
})

export async function pruneTelemetrySamplesImpl(
  ctx: MutationCtx,
  args: Infer<typeof pruneTelemetrySamplesArgs>,
): Promise<{ pruned: number; done: boolean }> {
  requireApiInternalKey(args.internalKey)
  const limit = args.limit ?? TELEMETRY_PRUNE_BATCH_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > TELEMETRY_PRUNE_BATCH_SIZE) {
    throw new Error(`limit must be an integer from 1 to ${TELEMETRY_PRUNE_BATCH_SIZE}`)
  }
  const now = args.now ?? Date.now()
  const candidates = await ctx.db
    .query('vmTelemetrySamples')
    .withIndex('by_at', q => q.lte('at', now - RETENTION_MS))
    .take(limit)
  for (const sample of candidates) {
    await ctx.db.delete(sample._id)
  }
  const done = candidates.length < limit
  if (!done) {
    await ctx.scheduler.runAfter(
      0,
      fnMutation('domains/workspaces/vmTelemetry:pruneTelemetrySamples'),
      {
        internalKey: args.internalKey,
        now,
        ...(args.limit === undefined ? {} : { limit }),
      },
    )
  }
  return { pruned: candidates.length, done }
}

export const pruneTelemetrySamples = mutation({
  args: pruneTelemetrySamplesArgs,
  returns: v.object({ pruned: v.number(), done: v.boolean() }),
  handler: (ctx, args) => pruneTelemetrySamplesImpl(ctx, args),
})

export const listTelemetryHistoryArgs = v.object({
  workspaceId: v.id('workspaces'),
  sinceAt: v.optional(v.number()),
  now: v.number(),
  limit: v.optional(v.number()),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
})

/**
 * THE chart projection: provider units in, the chart's long-standing wire shape
 * out, so `apps/web` never learns the source changed.
 *
 * `cpuPct` is clamped to 100 for display. That clamp must never reach the fee —
 * raw `cpuCores` is the only number distinguishing a saturated 10-core VM from
 * a saturated 4-core one, and a percentage would undercharge the largest
 * consumers by 2.5x. The fee reads `listVmUsagePointsForWindow`, not this.
 *
 * `diskUsedMb` is the raw filesystem figure — what is actually on the disk,
 * image included. The storage *quota* bar answers a different question and
 * subtracts the image headroom; see `projectWorkspaceStorage`.
 */
export async function listTelemetryHistoryImpl(
  ctx: QueryCtx,
  args: Infer<typeof listTelemetryHistoryArgs>,
) {
  await authorizeTelemetryRead(ctx, args)
  const limit = args.limit ?? TELEMETRY_READ_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > TELEMETRY_READ_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${TELEMETRY_READ_LIMIT}`)
  }
  const rows = await ctx.db
    .query('vmTelemetrySamples')
    .withIndex('by_workspace_at', q =>
      q.eq('workspaceId', args.workspaceId).gte('at', args.sinceAt ?? args.now - RETENTION_MS),
    )
    .take(limit)
  return downsampleTelemetrySamples(rows.map(chartSampleFromRow), TELEMETRY_CHART_POINT_LIMIT)
}

export interface ChartTelemetrySample {
  at: number
  cpuPct?: number
  memUsedMb?: number
  memTotalMb?: number
  diskUsedMb?: number
  diskTotalMb?: number
}

/**
 * A VM's CPU as a percentage of the cores it was allocated, clamped to 0–100.
 * One owner so the chart and the fleet view read the same number; the provider
 * can briefly report cores slightly above nominal, hence the clamp.
 */
export function cpuPctFromCores(
  cpuCores: number | undefined,
  cpuNominalCores: number | undefined,
): number | undefined {
  if (cpuCores === undefined || cpuNominalCores === undefined || cpuNominalCores <= 0) {
    return undefined
  }
  return Math.max(0, Math.min(100, (cpuCores / cpuNominalCores) * 100))
}

function chartSampleFromRow(row: Doc<'vmTelemetrySamples'>): ChartTelemetrySample {
  const cpuPct = cpuPctFromCores(row.cpuCores, row.cpuNominalCores)
  return {
    at: row.at,
    ...(cpuPct === undefined ? {} : { cpuPct }),
    ...(row.memUsedBytes === undefined ? {} : { memUsedMb: row.memUsedBytes / BYTES_PER_MIB }),
    ...(row.memTotalBytes === undefined ? {} : { memTotalMb: row.memTotalBytes / BYTES_PER_MIB }),
    ...(row.fsUsedGb === undefined ? {} : { diskUsedMb: row.fsUsedGb * 1024 }),
    ...(row.fsTotalGb === undefined ? {} : { diskTotalMb: row.fsTotalGb * 1024 }),
  }
}

export const listTelemetryHistory = query({
  args: listTelemetryHistoryArgs,
  handler: (ctx, args) => listTelemetryHistoryImpl(ctx, args),
})

export function downsampleTelemetrySamples(
  samples: ChartTelemetrySample[],
  maxPoints: number,
): ChartTelemetrySample[] {
  if (samples.length <= maxPoints) return samples
  const downsampled: ChartTelemetrySample[] = []
  for (let index = 0; index < maxPoints; index += 1) {
    const start = Math.ceil((index * samples.length) / maxPoints)
    const end = Math.ceil(((index + 1) * samples.length) / maxPoints)
    const bucket = samples.slice(start, end)
    const at = bucket.at(-1)?.at
    if (at === undefined) continue
    downsampled.push({
      at,
      ...averageMetric(bucket, 'cpuPct'),
      ...averageMetric(bucket, 'memUsedMb'),
      ...averageMetric(bucket, 'memTotalMb'),
      ...averageMetric(bucket, 'diskUsedMb'),
      ...averageMetric(bucket, 'diskTotalMb'),
    })
  }
  return downsampled
}

function averageMetric(
  samples: ChartTelemetrySample[],
  metric: Exclude<keyof ChartTelemetrySample, 'at'>,
): Partial<ChartTelemetrySample> {
  const values = samples.flatMap(sample => {
    const value = sample[metric]
    return value === undefined ? [] : [value]
  })
  if (values.length === 0) return {}
  return { [metric]: values.reduce((sum, value) => sum + value, 0) / values.length }
}

async function authorizeTelemetryRead(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    internalKey?: string
    actorId?: Id<'users'>
  },
): Promise<void> {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined) throw new Error('actorId is required with internalKey')
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
    return
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  await assertRole(ctx, args.workspaceId, 'viewer')
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}
