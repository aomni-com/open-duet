import { onCompleteValidator, type RunId } from '@convex-dev/action-retrier'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'

import { SessionDeletionDisposalResultSchema } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../../_generated/server'
import { retrier } from '../../utils'
import { requireApiInternalKey } from '../apiKeys/model'

export const SESSION_DELETION_EXTERNAL_SWEEP_LIMIT = 50

interface SessionDeletionExternalEffects {
  scheduleReadyWork(ctx: MutationCtx, workId: Id<'agentSessionDeletionWork'>): Promise<unknown>
}

const productionExternalEffects: SessionDeletionExternalEffects = {
  scheduleReadyWork: scheduleReadySessionDeletionWork,
}

/**
 * The one scheduling edge for deletion work whose prerequisites may complete
 * in either order. External disposal and physical cleanup meet at this shared
 * decision rather than scheduling cleanup independently.
 */
export async function scheduleReadySessionDeletionWork(
  ctx: MutationCtx,
  workId: Id<'agentSessionDeletionWork'>,
): Promise<'external_scheduled' | 'waiting' | 'ready_for_cleanup' | 'stale'> {
  const work = await ctx.db.get(workId)
  if (work === null) return 'stale'
  if (!work.childScanComplete) return 'waiting'
  if (work.externalState === 'complete') {
    await ctx.scheduler.runAfter(0, deleteSessionBatchRef, { workId })
    return 'ready_for_cleanup'
  }
  if (work.externalRunId !== undefined) return 'waiting'

  const runId = await retrier.run(
    ctx,
    disposeSessionDeletionWorkRef,
    { workId },
    {
      initialBackoffMs: 1_000,
      maxFailures: 6,
      onComplete: onSessionDeletionDisposalCompleteRef,
    },
  )
  await ctx.db.patch(work._id, {
    externalState: 'running',
    externalRunId: runId,
    updatedAt: Date.now(),
  })
  return 'external_scheduled'
}

export async function sessionDeletionDisposalPlanImpl(
  ctx: QueryCtx,
  args: { internalKey: string; workId: string },
) {
  requireApiInternalKey(args.internalKey)
  const workId = ctx.db.normalizeId('agentSessionDeletionWork', args.workId)
  if (workId === null) return null
  const work = await ctx.db.get(workId)
  if (
    work === null ||
    !work.childScanComplete ||
    work.externalState !== 'running' ||
    work.externalRunId === undefined
  ) {
    return null
  }
  const [workspace, session] = await Promise.all([
    ctx.db.get(work.workspaceId),
    ctx.db.get(work.sessionId),
  ])
  if (
    workspace === null ||
    session === null ||
    session.workspaceId !== work.workspaceId ||
    session.archiveState !== 'deleting'
  ) {
    return null
  }
  return {
    workspaceSlug: workspace.slug,
    sessionId: session._id,
    ...(work.providerSessionId === undefined ? {} : { providerSessionId: work.providerSessionId }),
  }
}

export async function settleSessionDeletionDisposalRun(
  ctx: MutationCtx,
  args: Infer<typeof onCompleteValidator>,
  effects: SessionDeletionExternalEffects = productionExternalEffects,
): Promise<void> {
  const work = await ctx.db
    .query('agentSessionDeletionWork')
    .withIndex('by_external_run', q => q.eq('externalRunId', args.runId))
    .unique()
  if (work === null) return

  const parsed =
    args.result.type === 'success'
      ? SessionDeletionDisposalResultSchema.safeParse(args.result.returnValue)
      : null
  const disposed = parsed?.success === true && parsed.data.status === 'disposed'
  await ctx.db.patch(work._id, {
    externalState: disposed ? 'complete' : 'pending',
    externalRunId: undefined,
    updatedAt: Date.now(),
  })
  await effects.scheduleReadyWork(ctx, work._id)
}

export async function resetMissingSessionDeletionRun(
  ctx: MutationCtx,
  args: { workId: Id<'agentSessionDeletionWork'>; runId: string },
  effects: SessionDeletionExternalEffects = productionExternalEffects,
): Promise<boolean> {
  const work = await ctx.db.get(args.workId)
  if (work === null || work.externalState !== 'running' || work.externalRunId !== args.runId) {
    return false
  }
  await ctx.db.patch(work._id, {
    externalState: 'pending',
    externalRunId: undefined,
    updatedAt: Date.now(),
  })
  await effects.scheduleReadyWork(ctx, work._id)
  return true
}

export const onSessionDeletionDisposalComplete = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    await settleSessionDeletionDisposalRun(ctx, args)
    return null
  },
})

export const sessionDeletionExternalSweepCandidates = internalQuery({
  args: {},
  handler: async ctx => await sessionDeletionExternalSweepCandidatesImpl(ctx),
})

export async function sessionDeletionExternalSweepCandidatesImpl(ctx: QueryCtx) {
  const [pending, running] = await Promise.all([
    ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_external_state_child_scan_updated', q =>
        q.eq('externalState', 'pending').eq('childScanComplete', true),
      )
      .take(SESSION_DELETION_EXTERNAL_SWEEP_LIMIT),
    ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_external_state_child_scan_updated', q =>
        q.eq('externalState', 'running').eq('childScanComplete', true),
      )
      .take(SESSION_DELETION_EXTERNAL_SWEEP_LIMIT),
  ])
  return [...pending, ...running]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(0, SESSION_DELETION_EXTERNAL_SWEEP_LIMIT)
    .map(work => ({ workId: work._id, externalRunId: work.externalRunId }))
}

export const recoverSessionDeletionExternalRuns = action({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const candidates = (await ctx.runQuery(
      sessionDeletionExternalSweepCandidatesRef,
      {},
    )) as Array<{
      workId: Id<'agentSessionDeletionWork'>
      externalRunId?: string
    }>
    let repaired = 0
    const failed: Array<{ workId: Id<'agentSessionDeletionWork'>; error: string }> = []
    for (const candidate of candidates) {
      try {
        if (candidate.externalRunId === undefined) {
          await ctx.runMutation(scheduleReadySessionDeletionWorkRef, { workId: candidate.workId })
          repaired += 1
          continue
        }
        const runId = candidate.externalRunId as RunId
        const status = await retrier.status(ctx, runId)
        if (status.type !== 'completed') continue
        await ctx.runMutation(onSessionDeletionDisposalCompleteRef, {
          runId,
          result: status.result,
        })
        repaired += 1
      } catch (error) {
        if (
          candidate.externalRunId !== undefined &&
          actionRetrierRunIsMissing(error, candidate.externalRunId)
        ) {
          try {
            const reset = (await ctx.runMutation(resetMissingSessionDeletionRunRef, {
              workId: candidate.workId,
              runId: candidate.externalRunId,
            })) as boolean
            if (reset) repaired += 1
          } catch (resetError) {
            failed.push({
              workId: candidate.workId,
              error: resetError instanceof Error ? resetError.message : String(resetError),
            })
          }
          continue
        }
        failed.push({
          workId: candidate.workId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { repaired, failed }
  },
})

export const scheduleReadySessionDeletionWorkMutation = internalMutation({
  args: { workId: v.id('agentSessionDeletionWork') },
  handler: (ctx, args) => scheduleReadySessionDeletionWork(ctx, args.workId),
})

export const resetMissingSessionDeletionRunMutation = internalMutation({
  args: { workId: v.id('agentSessionDeletionWork'), runId: v.string() },
  handler: (ctx, args) => resetMissingSessionDeletionRun(ctx, args),
})

// Action Retrier prunes a completed run after seven days and then reports it
// only by throwing with this message; there is no typed status for an aged-out
// run, so the message is the one signal that separates it from a real failure.
function actionRetrierRunIsMissing(error: unknown, runId: string): boolean {
  return error instanceof Error && error.message.includes(`Run ${runId} not found`)
}

const disposeSessionDeletionWorkRef = makeFunctionReference(
  'domains/agentSessions/deletionExternalAction:disposeSessionDeletionWork',
) as unknown as FunctionReference<
  'action',
  'internal',
  { workId: Id<'agentSessionDeletionWork'> },
  unknown
>

const onSessionDeletionDisposalCompleteRef = makeFunctionReference(
  'domains/agentSessions/deletionExternal:onSessionDeletionDisposalComplete',
) as unknown as FunctionReference<'mutation', 'internal', Infer<typeof onCompleteValidator>, null>

const sessionDeletionExternalSweepCandidatesRef = makeFunctionReference(
  'domains/agentSessions/deletionExternal:sessionDeletionExternalSweepCandidates',
) as FunctionReference<'query'>

const scheduleReadySessionDeletionWorkRef = makeFunctionReference(
  'domains/agentSessions/deletionExternal:scheduleReadySessionDeletionWorkMutation',
) as FunctionReference<'mutation'>

const resetMissingSessionDeletionRunRef = makeFunctionReference(
  'domains/agentSessions/deletionExternal:resetMissingSessionDeletionRunMutation',
) as FunctionReference<'mutation'>

const deleteSessionBatchRef = makeFunctionReference(
  'domains/agentSessions/model:deleteSessionBatch',
) as FunctionReference<'mutation'>
