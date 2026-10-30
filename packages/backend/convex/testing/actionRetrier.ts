import { onCompleteValidator, type RunId } from '@convex-dev/action-retrier'
import type { RegisteredAction, RegisteredMutation } from 'convex/server'
import { v, type Infer } from 'convex/values'

import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { retrier } from '../utils'

const ATTEMPT_EVENT = 'test.retrier_attempt'
const COMPLETION_EVENT = 'test.retrier_completed'
const FAILURE_PREFIX = 'Retrier fixture failure for '
const VM_RECORDED_EVENT = 'test.retrier_vm_recorded'

type FixtureActionArgs = {
  workspaceId: Id<'workspaces'>
  failuresBeforeSuccess: number
}

export const schedule: RegisteredMutation<
  'public',
  FixtureActionArgs & { internalKey: string },
  RunId
> = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    failuresBeforeSuccess: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await retrier.run(
      ctx,
      internal.testing.actionRetrier.flakyAttach,
      {
        workspaceId: args.workspaceId,
        failuresBeforeSuccess: args.failuresBeforeSuccess,
      },
      { onComplete: internal.testing.actionRetrier.onComplete },
    )
  },
})

export const flakyAttach: RegisteredAction<
  'internal',
  FixtureActionArgs,
  { attempt: number; workspaceId: Id<'workspaces'> }
> = internalAction({
  args: {
    workspaceId: v.id('workspaces'),
    failuresBeforeSuccess: v.number(),
  },
  handler: async (ctx, args) => {
    const attempt: number = await ctx.runMutation(internal.testing.actionRetrier.recordAttempt, {
      workspaceId: args.workspaceId,
    })
    if (attempt <= args.failuresBeforeSuccess) {
      throw new Error(`${FAILURE_PREFIX}${args.workspaceId} (attempt ${attempt})`)
    }
    await ctx.runMutation(internal.testing.actionRetrier.recordVm, {
      workspaceId: args.workspaceId,
    })
    return { attempt, workspaceId: args.workspaceId }
  },
})

export const recordAttempt: RegisteredMutation<
  'internal',
  { workspaceId: Id<'workspaces'> },
  number
> = internalMutation({
  args: { workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    const actorId = await fixtureActorId(ctx, args.workspaceId)
    const events = await workspaceEvents(ctx, args.workspaceId)
    const attempt = events.filter(event => event.event === ATTEMPT_EVENT).length + 1
    await insertAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      event: ATTEMPT_EVENT,
      actorId,
      at: Date.now(),
    })
    return attempt
  },
})

export const recordVm: RegisteredMutation<'internal', { workspaceId: Id<'workspaces'> }, null> =
  internalMutation({
    args: { workspaceId: v.id('workspaces') },
    handler: async (ctx, args) => {
      const actorId = await fixtureActorId(ctx, args.workspaceId)
      await ctx.db.patch(args.workspaceId, {
        status: 'active',
        vmCleanupPending: true,
        vmName: `retrier-fixture-${args.workspaceId}`,
      })
      await insertAuditEvent(ctx, {
        workspaceId: args.workspaceId,
        event: VM_RECORDED_EVENT,
        actorId,
        at: Date.now(),
      })
      return null
    },
  })

export const onComplete: RegisteredMutation<
  'internal',
  Infer<typeof onCompleteValidator>,
  null
> = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    const workspaceId = workspaceIdFromResult(args.result)
    const actorId = await fixtureActorId(ctx, workspaceId)
    if (args.result.type === 'failed') {
      await ctx.db.patch(workspaceId, { status: 'unhealthy' })
    }
    await insertAuditEvent(ctx, {
      workspaceId,
      event: COMPLETION_EVENT,
      actorId,
      provenance: {
        source: args.result.type,
        reason: args.result.type === 'failed' ? args.result.error : undefined,
      },
      at: Date.now(),
    })
    return null
  },
})

async function insertAuditEvent(
  ctx: MutationCtx,
  fields: Omit<Doc<'auditEvents'>, '_id' | '_creationTime' | 'sortId'>,
): Promise<void> {
  const id = await ctx.db.insert('auditEvents', { ...fields, sortId: '' })
  await ctx.db.patch(id, { sortId: id })
}

function workspaceIdFromResult(
  result: Infer<typeof onCompleteValidator>['result'],
): Id<'workspaces'> {
  if (result.type === 'success') {
    const value = result.returnValue
    if (
      typeof value !== 'object' ||
      value === null ||
      !('workspaceId' in value) ||
      typeof value.workspaceId !== 'string'
    ) {
      throw new Error('Retrier fixture success did not return a workspace ID')
    }
    return value.workspaceId as Id<'workspaces'>
  }
  if (result.type === 'failed') {
    const prefixAt = result.error.indexOf(FAILURE_PREFIX)
    if (prefixAt >= 0) {
      const workspaceAt = prefixAt + FAILURE_PREFIX.length
      return result.error.slice(workspaceAt).split(' ', 1)[0] as Id<'workspaces'>
    }
  }
  throw new Error('Retrier fixture completion did not identify a workspace')
}

export const state = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const events = await workspaceEvents(ctx, args.workspaceId)
    return {
      attempts: events.filter(event => event.event === ATTEMPT_EVENT).length,
      completions: events
        .filter(event => event.event === COMPLETION_EVENT)
        .map(event => ({
          result: event.provenance?.source,
          error: event.provenance?.reason,
        })),
      status: workspace.status,
      vmName: workspace.vmName,
      vmRecords: events.filter(event => event.event === VM_RECORDED_EVENT).length,
    }
  },
})

async function fixtureActorId(ctx: MutationCtx, workspaceId: Id<'workspaces'>) {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const owner = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_role', q => q.eq('workspaceId', workspaceId).eq('role', 'owner'))
    .first()
  if (owner === null) throw new Error('Retrier fixture requires an owned workspace')
  return owner.userId
}

async function workspaceEvents(
  ctx: Pick<QueryCtx, 'db'>,
  workspaceId: Id<'workspaces'>,
): Promise<Doc<'auditEvents'>[]> {
  return await ctx.db
    .query('auditEvents')
    .withIndex('by_workspace_at', q => q.eq('workspaceId', workspaceId))
    .take(1_000)
}
