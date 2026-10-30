import { makeFunctionReference, paginationOptsValidator } from 'convex/server'
import { type Infer, v } from 'convex/values'

import {
  GATEWAY_TRAIN_JOB_PHASES,
  GatewayTrainJobReportBatchSchema,
  TrainIdentifierSchema,
  TrainJobStatusSchema,
  TrainSourceFailureSchema,
  redactText,
  truncateUtf8,
  MAX_TRAIN_ERROR_UTF8_BYTES,
  MAX_TRAIN_SOURCE_FAILURE_TEXT,
  type GatewayTrainJobReport,
  type TrainJobStatus,
  type TrainJobState,
  type TrainSourceFailure,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { duetAppHref } from '../../config'
import { requireApiInternalKey } from '../apiKeys/model'

const stateValidator = v.union(
  v.literal('queued'),
  v.literal('running'),
  v.literal('done'),
  v.literal('failed'),
)
const phaseValidator = v.union(
  v.literal(GATEWAY_TRAIN_JOB_PHASES[0]),
  v.literal(GATEWAY_TRAIN_JOB_PHASES[1]),
  v.literal(GATEWAY_TRAIN_JOB_PHASES[2]),
  v.literal(GATEWAY_TRAIN_JOB_PHASES[3]),
  v.literal(GATEWAY_TRAIN_JOB_PHASES[4]),
  v.literal(GATEWAY_TRAIN_JOB_PHASES[5]),
  v.literal(GATEWAY_TRAIN_JOB_PHASES[6]),
)
const sourceFailureValidator = v.object({
  source: v.string(),
  code: v.literal('source_fetch_failed'),
  message: v.string(),
})
const reportValidator = v.object({
  generation: v.string(),
  jobId: v.string(),
  creatorUserId: v.string(),
  agentId: v.optional(v.string()),
  anchorId: v.optional(v.string()),
  state: stateValidator,
  phase: phaseValidator,
  error: v.optional(v.string()),
  sourceFailures: v.optional(v.array(sourceFailureValidator)),
  createdAt: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
})

export const reconcileFromVmArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  trainReports: v.array(reportValidator),
})

const sendTransactional = makeFunctionReference<'action'>('services/email:sendTransactional')

export const createJob = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentId: v.optional(v.id('agents')),
    agentSlug: v.optional(v.string()),
    jobId: v.string(),
    userId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    if ((args.agentId === undefined) !== (args.agentSlug === undefined)) {
      throw new Error('Agent train identity is incomplete')
    }
    const jobId = TrainIdentifierSchema.parse(args.jobId)
    const userId = TrainIdentifierSchema.parse(args.userId)
    const existing = await jobByIdAnyScope(ctx, args.workspaceId, jobId)
    if (existing !== null) {
      // The VM's reconcile may have inserted the projection first. That is
      // fine exactly when it resolved the same scope; a mismatch is a bug.
      if ((existing.agentId ?? undefined) !== args.agentId || existing.userId !== userId) {
        throw new Error('Train job exists with different agent scope')
      }
      return await requireJobStatus(ctx, args.workspaceId, jobId, args.agentId)
    }
    await ctx.db.insert('trainJobs', {
      workspaceId: args.workspaceId,
      ...(args.agentId === undefined ? {} : { agentId: args.agentId, agentSlug: args.agentSlug }),
      jobId,
      userId,
      state: 'queued',
      phase: 'preparing',
      createdAt: args.now,
      updatedAt: args.now,
    })
    return await requireJobStatus(ctx, args.workspaceId, jobId, args.agentId)
  },
})

async function agentByAnchorId(ctx: MutationCtx, workspaceId: Id<'workspaces'>, anchorId: string) {
  const agent = await ctx.db
    .query('agents')
    .withIndex('by_anchor', q => q.eq('anchorId', anchorId as Id<'anchors'>))
    .unique()
    .catch(() => null)
  return agent !== null && agent.workspaceId === workspaceId ? agent : null
}

export const reconcileFromVm = mutation({
  args: reconcileFromVmArgs.fields,
  handler: async (ctx, args) => await reconcileFromVmImpl(ctx, args),
})

export async function reconcileFromVmImpl(
  ctx: MutationCtx,
  args: Infer<typeof reconcileFromVmArgs>,
): Promise<string[]> {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const reports = GatewayTrainJobReportBatchSchema.parse(args.trainReports)
  const accepted: string[] = []
  for (const report of reports) {
    const existing = await jobByIdAnyScope(ctx, args.workspaceId, report.jobId)
    if (existing?.generation === report.generation) {
      accepted.push(report.generation)
      continue
    }
    // A job that finishes within one poll window emits its whole batch at once;
    // if the sync response is lost the gateway replays the entire outbox. Ack
    // the stale earlier reports so the outbox drains, but never roll a terminal
    // job back — and never throw, which would 500 the sync route and wedge the
    // VM's whole sync loop until the ledger is hand-edited.
    if (existing !== null && isTerminal(existing.state)) {
      accepted.push(report.generation)
      continue
    }
    const patch = reportFields(report)
    if (existing === null) {
      // VM-first race: the gateway's report can land before the API's
      // createJob. The report carries the VM's anchorId — resolve it to the
      // agent row so the projection is born with the right scope instead of
      // root, which the API's late createJob could never repair.
      const reportAgent =
        report.anchorId === undefined
          ? null
          : await agentByAnchorId(ctx, args.workspaceId, report.anchorId)
      if (report.anchorId !== undefined && reportAgent === null) {
        // The report names an agent scope this deployment cannot resolve
        // (agent deleted mid-job, or skew). Inserting it as root would
        // mis-scope the job and make the API's late createJob explode;
        // skip the projection — the gateway job itself fails closed at
        // finalize when its agent is gone.
        continue
      }
      await ctx.db.insert('trainJobs', {
        workspaceId: args.workspaceId,
        jobId: report.jobId,
        ...(reportAgent === null ? {} : { agentId: reportAgent._id, agentSlug: reportAgent.slug }),
        ...patch,
      })
    } else {
      await ctx.db.patch(existing._id, patch)
    }
    if (report.state === 'done') {
      // The projection is already persisted and this transition must be acked;
      // an unresolvable creator only means we can't address the email. Skip the
      // notification rather than throw — losing a terminal transition (or, via
      // the sync route, wedging the whole loop) is worse than a lost email.
      const userId = ctx.db.normalizeId('users', report.creatorUserId)
      const user = userId === null ? null : await ctx.db.get(userId)
      const agentStillExists =
        existing?.agentId === undefined ? true : (await ctx.db.get(existing.agentId)) !== null
      if (user !== null && agentStillExists) {
        const recipientName = user.firstName ?? user.name
        await ctx.scheduler.runAfter(0, sendTransactional, {
          to: user.email,
          email: {
            kind: 'train_complete',
            actionUrl: duetAppHref(trainCompletionPath(workspace.slug, existing?.agentSlug)),
            jobId: report.jobId,
            ...(recipientName === undefined ? {} : { recipientName }),
          },
          idempotencyKey: `train_complete:${report.jobId}`,
        })
      }
    }
    accepted.push(report.generation)
  }
  return accepted
}

export const getJob = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentId: v.optional(v.id('agents')),
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await jobStatus(ctx, args.workspaceId, args.jobId, args.agentId)
  },
})

export const listJobs = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentId: v.optional(v.id('agents')),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const jobs = await ctx.db
      .query('trainJobs')
      .withIndex('by_workspace_agent_created_job', q =>
        q.eq('workspaceId', args.workspaceId).eq('agentId', args.agentId),
      )
      .order('desc')
      .paginate(args.paginationOpts)
    return { ...jobs, page: jobs.page.map(toStatus) }
  },
})

function reportFields(report: GatewayTrainJobReport) {
  return {
    generation: report.generation,
    userId: report.creatorUserId,
    state: report.state,
    phase: report.phase,
    error:
      report.error === undefined
        ? undefined
        : truncateUtf8(redactText(report.error), MAX_TRAIN_ERROR_UTF8_BYTES),
    sourceFailures: report.sourceFailures?.map(failure =>
      TrainSourceFailureSchema.parse({
        ...failure,
        source: truncateUtf8(redactText(failure.source), MAX_TRAIN_SOURCE_FAILURE_TEXT),
        message: truncateUtf8(redactText(failure.message), MAX_TRAIN_SOURCE_FAILURE_TEXT),
      }),
    ),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
  }
}

function isTerminal(state: TrainJobState): boolean {
  return state === 'done' || state === 'failed'
}

async function jobStatus(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  jobId: string,
  agentId?: Id<'agents'>,
): Promise<TrainJobStatus | null> {
  const job = await jobByIdAnyScope(ctx, workspaceId, jobId)
  if (job?.agentId !== agentId) return null
  return job === null ? null : toStatus(job)
}

async function requireJobStatus(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  jobId: string,
  agentId?: Id<'agents'>,
): Promise<TrainJobStatus> {
  const status = await jobStatus(ctx, workspaceId, jobId, agentId)
  if (status === null) throw new Error('Train job not found')
  return status
}

async function jobByIdAnyScope(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  jobId: string,
): Promise<Doc<'trainJobs'> | null> {
  return await ctx.db
    .query('trainJobs')
    .withIndex('by_workspace_and_job', q => q.eq('workspaceId', workspaceId).eq('jobId', jobId))
    .unique()
}

function toStatus(job: {
  workspaceId: string
  agentId?: string
  jobId: string
  userId: string
  state: TrainJobState
  phase: GatewayTrainJobReport['phase']
  error?: string
  sourceFailures?: TrainSourceFailure[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
}): TrainJobStatus {
  return TrainJobStatusSchema.parse({
    workspaceId: job.workspaceId,
    ...(job.agentId === undefined ? {} : { agentId: job.agentId }),
    jobId: job.jobId,
    userId: job.userId,
    state: job.state,
    phase: job.phase,
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.sourceFailures === undefined ? {} : { sourceFailures: job.sourceFailures }),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
  })
}

export function trainCompletionPath(workspaceSlug: string, agentSlug?: string): string {
  const workspacePath = `/w/${encodeURIComponent(workspaceSlug)}`
  return agentSlug === undefined
    ? `${workspacePath}/train`
    : `${workspacePath}/train/agents/${encodeURIComponent(agentSlug)}`
}
