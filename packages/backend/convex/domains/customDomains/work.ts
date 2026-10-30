import { onCompleteValidator, type RunId } from '@convex-dev/action-retrier'
import { makeFunctionReference } from 'convex/server'
import { v, type Infer } from 'convex/values'
import { z } from 'zod'

import { DomainObservationSchema } from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../../_generated/server'
import { retrier } from '../../utils'
import { writeAuditEvent } from '../audit/model'
import { notifyWorkspaceApps } from './model'
import { domainOperationValidator } from './validators'

export const DomainWorkResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observed'), observation: DomainObservationSchema }),
  z.object({ kind: z.literal('removed') }),
  z.object({ kind: z.literal('stopped') }),
  z.object({
    kind: z.literal('failed'),
    error: z.string().max(2_000),
    retryable: z.boolean(),
    missing: z.boolean().optional(),
    definitive: z.boolean().optional(),
  }),
])
export type DomainWorkResult = z.infer<typeof DomainWorkResultSchema>
const workerRef = makeFunctionReference<'action'>('domains/customDomains/actions:perform')
const completionRef = makeFunctionReference<'mutation'>('domains/customDomains/work:onComplete')

export const dispatchDue = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const running = await ctx.db
      .query('customDomains')
      .withIndex('by_running', q => q.eq('workRunning', true))
      .take(5)
    for (const row of running) {
      if (row.runId === undefined) continue
      try {
        const status = await retrier.status(ctx, row.runId as RunId)
        if (status.type === 'completed')
          await settle(ctx, { runId: row.runId as RunId, result: status.result }, now)
      } catch (error) {
        if (error instanceof Error && error.message.includes(`Run ${row.runId} not found`)) {
          if (row.effectState === 'writing') {
            await quarantine(ctx, row, now)
            continue
          }
          await ctx.db.patch(row._id, {
            workRunning: false,
            runId: undefined,
            runOperation: undefined,
            runRevision: undefined,
            effectState: undefined,
            nextWorkAt: now,
            updatedAt: now,
          })
        } else console.error('Custom domain run recovery failed', row._id)
      }
    }
    const live = await ctx.db
      .query('customDomains')
      .withIndex('by_running', q => q.eq('workRunning', true))
      .take(5)
    if (live.length === 5) return { started: 0 }
    const candidates = await ctx.db
      .query('customDomains')
      .withIndex('by_due', q =>
        q.eq('workRunning', false).gt('nextWorkAt', undefined).lte('nextWorkAt', now),
      )
      .take(5 - live.length)
    let started = 0
    for (const row of candidates) {
      const operation =
        row.status === 'removing' ? 'remove' : row.status === 'pending' ? 'add' : 'check'
      const revision = row.revision + 1
      const runId = await retrier.run(
        ctx,
        workerRef,
        { domainId: row._id, revision, operation },
        {
          initialBackoffMs: 1_000,
          maxFailures: operation === 'remove' ? 5 : 1,
          onComplete: completionRef,
        },
      )
      await ctx.db.patch(row._id, {
        workRunning: true,
        runId,
        runOperation: operation,
        revision,
        runRevision: revision,
        effectState: 'admitted',
        nextWorkAt: now + 60_000,
        updatedAt: now,
      })
      started += 1
    }
    return { started }
  },
})

export const beginAttempt = internalMutation({
  args: {
    domainId: v.id('customDomains'),
    revision: v.number(),
    operation: domainOperationValidator,
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.domainId)
    if (
      row === null ||
      !row.workRunning ||
      row.effectState === 'writing' ||
      row.repairReason === 'uncertain' ||
      row.runRevision !== args.revision ||
      row.runOperation !== args.operation
    )
      return null
    if (row.status === 'removing' && args.operation !== 'remove') return null
    if (args.operation === 'remove' && row.cleanupAttempts >= 6) return null
    await ctx.db.patch(row._id, { effectState: 'executing' })
    if (args.operation === 'remove') {
      await ctx.db.patch(row._id, {
        cleanupAttempts: row.cleanupAttempts + 1,
        nextWorkAt: Date.now() + 60_000,
      })
    }
    return { hostname: row.hostname, target: row.target, providerAssigned: row.providerAssigned }
  },
})
export const markAliasWriteStarted = internalMutation({
  args: {
    domainId: v.id('customDomains'),
    revision: v.number(),
    operation: domainOperationValidator,
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.domainId)
    if (
      row === null ||
      !row.workRunning ||
      row.runRevision !== args.revision ||
      row.runOperation !== args.operation
    )
      return false
    await ctx.db.patch(row._id, { effectState: 'writing' })
    return true
  },
})
export const markEffectFinished = internalMutation({
  args: {
    domainId: v.id('customDomains'),
    revision: v.number(),
    operation: domainOperationValidator,
    uncertain: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.domainId)
    if (row?.runRevision !== args.revision || row.runOperation !== args.operation) return
    if (args.uncertain) {
      await quarantine(ctx, row, Date.now())
      return
    }
    await ctx.db.patch(row._id, { effectState: 'settled' })
  },
})

export const recordCleanupError = internalMutation({
  args: { domainId: v.id('customDomains'), revision: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.domainId)
    if (row?.runRevision === args.revision && row.runOperation === 'remove')
      await ctx.db.patch(row._id, { lastError: args.error, updatedAt: Date.now() })
  },
})

export const onComplete = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    await settle(ctx, args, Date.now())
    return null
  },
})
async function settle(ctx: MutationCtx, args: Infer<typeof onCompleteValidator>, now: number) {
  const row = await ctx.db
    .query('customDomains')
    .withIndex('by_run', q => q.eq('runId', args.runId))
    .unique()
  if (row === null) return
  if (row.effectState === 'writing') {
    await quarantine(ctx, row, now)
    return
  }
  const parsed =
    args.result.type === 'success'
      ? DomainWorkResultSchema.safeParse(args.result.returnValue)
      : null
  const result: DomainWorkResult = parsed?.success
    ? parsed.data
    : {
        kind: 'failed',
        retryable: true,
        error: row.lastError ?? 'Domain provider work did not complete',
      }
  const clearRun = {
    workRunning: false,
    runId: undefined,
    runOperation: undefined,
    runRevision: undefined,
    effectState: undefined,
    updatedAt: now,
  }
  if (row.status === 'removing') {
    if (row.runOperation === 'remove') {
      if (result.kind === 'removed') {
        await ctx.db.delete(row.diagnosticsId)
        await ctx.db.delete(row._id)
        return
      }
      await ctx.db.patch(row._id, {
        ...clearRun,
        nextWorkAt: undefined,
        repairReason: 'exhausted',
        lastError: result.kind === 'failed' ? result.error : 'Domain cleanup did not complete',
      })
    } else {
      await ctx.db.patch(row._id, { ...clearRun, nextWorkAt: now })
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'),
        {},
      )
    }
    return
  }
  if (result.kind === 'observed') {
    const active = result.observation.ownershipVerified && !result.observation.misconfigured
    await ctx.db.replace(row.diagnosticsId, {
      records: result.observation.records,
      conflicts: result.observation.conflicts,
    })
    await ctx.db.patch(row._id, {
      ...clearRun,
      status: active ? 'active' : 'verifying',
      providerAssigned: true,
      lastError: undefined,
      repairReason: undefined,
      lastCheckedAt: now,
      verifiedAt: active ? (row.verifiedAt ?? now) : undefined,
      nextWorkAt: active ? undefined : now + 60_000,
    })
    if (active !== (row.status === 'active')) {
      await notifyWorkspaceApps(ctx, row.workspaceId)
      if (active)
        await writeAuditEvent(ctx, {
          workspaceId: row.workspaceId,
          event: 'app.domain_activated',
          actorId: row.createdByUserId,
          at: now,
          provenance: { appId: row.appId, name: row.hostname },
        })
    }
  } else {
    const preserveBinding =
      result.kind === 'failed' &&
      !result.definitive &&
      !result.missing &&
      row.runOperation === 'check'
    await ctx.db.patch(row._id, {
      ...clearRun,
      status: preserveBinding ? row.status : 'failed',
      lastCheckedAt: now,
      lastError:
        result.kind === 'failed' ? result.error : 'Domain provider assignment is unavailable',
      nextWorkAt: preserveBinding && row.status === 'verifying' ? now + 60_000 : undefined,
      verifiedAt: preserveBinding ? row.verifiedAt : undefined,
    })
    if (row.status === 'active' && !preserveBinding) await notifyWorkspaceApps(ctx, row.workspaceId)
  }
}

async function quarantine(ctx: MutationCtx, row: Doc<'customDomains'>, now: number) {
  await ctx.db.patch(row._id, {
    status: 'removing',
    revision: row.revision + 1,
    workRunning: false,
    runId: undefined,
    runOperation: undefined,
    runRevision: undefined,
    effectState: undefined,
    nextWorkAt: undefined,
    repairReason: 'uncertain',
    lastError:
      'Remote domain write outcome is unknown. Operator confirmation is required before cleanup.',
    lastCheckedAt: now,
    updatedAt: now,
  })
  await notifyWorkspaceApps(ctx, row.workspaceId)
}
