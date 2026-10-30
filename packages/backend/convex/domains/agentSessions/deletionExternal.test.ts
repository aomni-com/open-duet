import { expect, test } from 'bun:test'

import type { RunId } from '@convex-dev/action-retrier'
import { convexTest } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'

import type { DataModel, Id } from '../../_generated/dataModel'
import schema from '../../schema'
import {
  SESSION_DELETION_EXTERNAL_SWEEP_LIMIT,
  resetMissingSessionDeletionRun,
  sessionDeletionExternalSweepCandidatesImpl,
  sessionDeletionDisposalPlanImpl,
  settleSessionDeletionDisposalRun,
} from './deletionExternal'

type TestCtx = GenericMutationCtx<DataModel>
const modules = { '../../_generated/api.ts': async () => ({}) }

test('a forged disposal work id returns the same empty plan as stale work', async () => {
  const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'test-internal-key'
  try {
    const t = convexTest(schema, modules)
    await expect(
      t.run(ctx =>
        sessionDeletionDisposalPlanImpl(ctx, {
          internalKey: 'test-internal-key',
          workId: 'forged-work-id',
        }),
      ),
    ).resolves.toBeNull()
  } finally {
    if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
  }
})

test('only the active disposal generation can complete its work row', async () => {
  const t = convexTest(schema, modules)
  const workId = await t.run(async ctx => {
    const { workspaceId, sessionId } = await seedDeletingSession(ctx)
    return await ctx.db.insert('agentSessionDeletionWork', {
      workspaceId,
      sessionId,
      rootSessionId: sessionId,
      childScanComplete: true,
      externalState: 'running',
      externalRunId: 'current-run',
      createdAt: 1,
      updatedAt: 1,
    })
  })
  const scheduled: string[] = []
  const effects = {
    async scheduleReadyWork(_ctx: TestCtx, readyWorkId: Id<'agentSessionDeletionWork'>) {
      scheduled.push(readyWorkId)
    },
  }

  await t.run(ctx =>
    settleSessionDeletionDisposalRun(
      ctx,
      {
        runId: 'stale-run' as RunId,
        result: {
          type: 'success',
          returnValue: { status: 'disposed', runner: 'absent', providerAttempted: false },
        },
      },
      effects,
    ),
  )
  expect(await t.run(ctx => ctx.db.get(workId))).toMatchObject({
    externalState: 'running',
    externalRunId: 'current-run',
  })

  await t.run(ctx =>
    settleSessionDeletionDisposalRun(
      ctx,
      {
        runId: 'current-run' as RunId,
        result: {
          type: 'success',
          returnValue: { status: 'disposed', runner: 'absent', providerAttempted: false },
        },
      },
      effects,
    ),
  )
  expect(await t.run(ctx => ctx.db.get(workId))).toMatchObject({
    externalState: 'complete',
  })
  expect((await t.run(ctx => ctx.db.get(workId)))?.externalRunId).toBeUndefined()
  expect(scheduled).toEqual([workId])
})

test('only the named expired retrier generation can return running work to the scheduler', async () => {
  const t = convexTest(schema, modules)
  const workId = await t.run(async ctx => {
    const { workspaceId, sessionId } = await seedDeletingSession(ctx)
    return await ctx.db.insert('agentSessionDeletionWork', {
      workspaceId,
      sessionId,
      rootSessionId: sessionId,
      childScanComplete: true,
      externalState: 'running',
      externalRunId: 'expired-run',
      createdAt: 1,
      updatedAt: 1,
    })
  })
  const scheduled: string[] = []
  const effects = {
    async scheduleReadyWork(_ctx: TestCtx, readyWorkId: Id<'agentSessionDeletionWork'>) {
      scheduled.push(readyWorkId)
    },
  }

  expect(
    await t.run(ctx =>
      resetMissingSessionDeletionRun(ctx, { workId, runId: 'stale-run' }, effects),
    ),
  ).toBe(false)
  expect(await t.run(ctx => ctx.db.get(workId))).toMatchObject({
    externalState: 'running',
    externalRunId: 'expired-run',
  })

  expect(
    await t.run(ctx =>
      resetMissingSessionDeletionRun(ctx, { workId, runId: 'expired-run' }, effects),
    ),
  ).toBe(true)
  expect(await t.run(ctx => ctx.db.get(workId))).toMatchObject({ externalState: 'pending' })
  expect((await t.run(ctx => ctx.db.get(workId)))?.externalRunId).toBeUndefined()
  expect(scheduled).toEqual([workId])
})

test('the orphan recovery census is oldest-first and bounded across pending and running work', async () => {
  const t = convexTest(schema, modules)
  const oldestIds = await t.run(async ctx => {
    const { workspaceId, sessionId } = await seedDeletingSession(ctx)
    const inserted: Array<Id<'agentSessionDeletionWork'>> = []
    for (let index = 0; index < SESSION_DELETION_EXTERNAL_SWEEP_LIMIT + 5; index += 1) {
      inserted.push(
        await ctx.db.insert('agentSessionDeletionWork', {
          workspaceId,
          sessionId,
          rootSessionId: sessionId,
          childScanComplete: true,
          externalState: index % 2 === 0 ? 'pending' : 'running',
          ...(index % 2 === 0 ? {} : { externalRunId: `run-${index}` }),
          createdAt: index,
          updatedAt: index,
        }),
      )
    }
    return inserted.slice(0, SESSION_DELETION_EXTERNAL_SWEEP_LIMIT)
  })

  const candidates = await t.run(ctx => sessionDeletionExternalSweepCandidatesImpl(ctx))
  expect(candidates.map(candidate => candidate.workId)).toEqual(oldestIds)
})

async function seedDeletingSession(ctx: TestCtx) {
  const userId = await ctx.db.insert('users', {
    email: 'deletion-external@example.test',
    memberDirectoryRevision: 0,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  const workspaceId = await ctx.db.insert('workspaces', {
    slug: 'deletion-external',
    name: 'Deletion external',
    status: 'active',
    billingUserId: userId,
    createdAt: 1,
  })
  const sessionId = await ctx.db.insert('agentSessions', {
    workspaceId,
    userId,
    audienceKind: 'workspace',
    turnStatus: 'complete',
    bucket: 'done',
    prompt: 'Delete me',
    title: 'Delete me',
    titleOrigin: 'excerpt',
    titleStatus: 'complete',
    searchText: 'delete me',
    archiveState: 'deleting',
    visible: false,
    lastEventSeq: 0,
    lastRunnerInputSeq: 0,
    runnerInputPending: false,
    lastDeliveredInputSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  return { workspaceId, sessionId }
}
