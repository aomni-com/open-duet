import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import schema from '../../schema'
import { relayRunnerEventImpl, reconcileInterruptedCheckpointImpl } from './events'
import { findCoveringTerminalImpl } from './queries'

const modules = { '../../_generated/api.ts': async () => ({}) }

async function withSession(
  run: (
    ctx: MutationCtx,
    point: {
      workspaceId: Id<'workspaces'>
      sessionId: Id<'agentSessions'>
    },
  ) => Promise<void>,
) {
  const saved = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'recovery-test'
  try {
    await convexTest(schema, modules).run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'recovery@example.test',
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'recovery',
        name: 'Recovery',
        status: 'active',
        billingUserId: userId,
        createdAt: 1,
      })
      const sessionId = await ctx.db.insert('agentSessions', {
        workspaceId,
        userId,
        audienceKind: 'workspace',
        turnStatus: 'running',
        bucket: 'running',
        prompt: 'continue',
        title: 'Recovery',
        titleOrigin: 'excerpt',
        titleStatus: 'complete',
        searchText: 'continue',
        archiveState: 'active',
        visible: true,
        lastEventSeq: 5,
        lastRunnerInputSeq: 5,
        runnerInputPending: true,
        lastDeliveredInputSeq: 2,
        createdAt: 1,
        updatedAt: 5,
      })
      await run(ctx, { workspaceId, sessionId })
    })
  } finally {
    if (saved === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = saved
  }
}

test('a delayed gateway stop cannot consume newer user input; matching stop is idempotent', async () => {
  await withSession(async (ctx, { workspaceId, sessionId }) => {
    await relayRunnerEventImpl(ctx, {
      internalKey: 'recovery-test',
      workspaceId,
      sessionId,
      relayId: 'old-stop',
      acceptedThroughSeq: 2,
      event: {
        type: 'system',
        level: 'info',
        message: 'Stopped absent runner',
        metadata: { code: 'interrupt_undeliverable' },
      },
      now: 10,
    })
    expect(await ctx.db.get(sessionId)).toMatchObject({
      turnStatus: 'running',
      bucket: 'running',
      lastRunnerInputSeq: 5,
      runnerInputPending: true,
      lastDeliveredInputSeq: 2,
    })
    const stop = {
      internalKey: 'recovery-test',
      workspaceId,
      sessionId,
      relayId: 'current-stop',
      acceptedThroughSeq: 5,
      event: {
        type: 'system',
        level: 'info',
        message: 'Stopped absent runner',
        metadata: { code: 'interrupt_undeliverable' },
      },
      now: 11,
    }
    const receipt = await relayRunnerEventImpl(ctx, stop)
    expect(await relayRunnerEventImpl(ctx, stop)).toEqual(receipt)
    expect(await ctx.db.get(sessionId)).toMatchObject({
      turnStatus: 'interrupted',
      bucket: 'done',
      lastRunnerInputSeq: 5,
      runnerInputPending: false,
      lastDeliveredInputSeq: 5,
    })
  })
})

test('a matching interrupted checkpoint repairs the projection exactly once', async () => {
  await withSession(async (ctx, point) => {
    await ctx.db.patch(point.sessionId, { runnerInputPending: false, lastDeliveredInputSeq: 5 })
    const repair = {
      internalKey: 'recovery-test',
      ...point,
      acceptedThroughSeq: 5,
      expectedLastEventSeq: 5,
      now: 9,
    }
    expect(await reconcileInterruptedCheckpointImpl(ctx, repair)).toBe(true)
    const repaired = await ctx.db.get(point.sessionId)
    expect(repaired).toMatchObject({ turnStatus: 'interrupted', bucket: 'done' })
    expect(
      await findCoveringTerminalImpl(ctx, { internalKey: 'recovery-test', ...point, inputSeq: 5 }),
    ).toMatchObject({ event: { type: 'interrupted' } })
    expect(await reconcileInterruptedCheckpointImpl(ctx, repair)).toBe(false)
    expect(await ctx.db.get(point.sessionId)).toEqual(repaired)
  })
})

test.each([
  ['newer user input', { lastRunnerInputSeq: 9, runnerInputPending: true }],
  ['autonomous turn with the same input cursor', { lastEventSeq: 8 }],
  ['unacknowledged input delivery', { runnerInputPending: true }],
  ['archived work', { archiveState: 'archived' as const }],
] as const)('checkpoint repair leaves %s untouched', async (_name, patch) => {
  await withSession(async (ctx, point) => {
    await ctx.db.patch(point.sessionId, {
      runnerInputPending: false,
      lastDeliveredInputSeq: 5,
      ...patch,
    })
    const before = await ctx.db.get(point.sessionId)
    expect(
      await reconcileInterruptedCheckpointImpl(ctx, {
        internalKey: 'recovery-test',
        ...point,
        acceptedThroughSeq: 5,
        expectedLastEventSeq: 5,
        now: 9,
      }),
    ).toBe(false)
    expect(await ctx.db.get(point.sessionId)).toEqual(before)
  })
})

test('an absent-runner stop closes waits for already delivered input', async () => {
  await withSession(async (ctx, point) => {
    await ctx.db.patch(point.sessionId, { runnerInputPending: false, lastDeliveredInputSeq: 5 })
    await relayRunnerEventImpl(ctx, {
      internalKey: 'recovery-test',
      ...point,
      relayId: 'delivered-stop',
      acceptedThroughSeq: 5,
      event: {
        type: 'system',
        level: 'info',
        message: 'Stopped absent runner',
        metadata: { code: 'interrupt_undeliverable' },
      },
      now: 10,
    })
    expect(
      await findCoveringTerminalImpl(ctx, { internalKey: 'recovery-test', ...point, inputSeq: 5 }),
    ).toMatchObject({ event: { type: 'interrupted' } })
  })
})
