import { afterAll, beforeAll, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'

import {
  SESSION_ACTIVITY_TEXT_MAX_SCALARS,
  SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES,
} from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import schema from '../../schema'
import { writeMemberDirectoryEntry } from '../workspaces/memberDirectory'
import {
  deleteSessionDiscovery,
  DELETE_DISCOVERY_BATCH,
  reconcileSessionDiscovery,
  sessionDiscoveryOrderKey,
} from './discovery'
import { listSessionsImpl, listChildSessionsImpl } from './queries'
import { finishTitleAttemptImpl } from './titles'

const modules = { '../../_generated/api.ts': async () => ({}) }
type TestCtx = GenericMutationCtx<DataModel>

test('discovery merges workspace and exact-generation lanes in canonical order', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'member@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'discovery',
      name: 'Discovery',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    const membershipId = await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId,
      role: 'editor',
    })
    await writeMemberDirectoryEntry(ctx, (await ctx.db.get(membershipId))!)
    const workspaceSession = await insertSession(ctx, { workspaceId, userId, updatedAt: 300 })
    const specificSession = await insertSession(ctx, {
      workspaceId,
      userId,
      updatedAt: 200,
      specific: true,
    })
    await ctx.db.insert('agentSessionMemberStates', {
      workspaceId,
      sessionId: specificSession,
      membershipId,
      audienceGranted: true,
    })
    await reconcileSessionDiscovery(ctx, workspaceSession)
    await reconcileSessionDiscovery(ctx, specificSession)

    const page = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      limit: 10,
    })

    expect(page.items.map(row => row.id)).toEqual([workspaceSession, specificSession])
    expect(page.nextCursor).toBeNull()
    expect(
      sessionDiscoveryOrderKey(200, specificSession) <
        sessionDiscoveryOrderKey(300, workspaceSession),
    ).toBe(true)
  })
})

test('discovery stores only bounded activity title and machine fields', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'activity-copy')
    const sessionId = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    await ctx.db.patch(sessionId, {
      title: '🚀'.repeat(SESSION_ACTIVITY_TEXT_MAX_SCALARS + 1),
      machine: {
        definitionName: 'ignored fallback',
        currentState: 's'.repeat(SESSION_ACTIVITY_TEXT_MAX_SCALARS + 1),
        progress: { completed: 2, total: 3 },
        orderedPath: [],
        activity: 'sleeping',
        nextWakeAt: 200,
        outcome: 'interrupted',
      },
    })
    await reconcileSessionDiscovery(ctx, sessionId)

    const row = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId).eq('laneKey', 'owner'))
      .unique()
    expect(row).toMatchObject({
      title: '🚀'.repeat(
        Math.min(
          SESSION_ACTIVITY_TEXT_MAX_SCALARS,
          Math.floor(SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES / 4),
        ),
      ),
      updatedAt: 100,
      lastEventSeq: 0,
      machine: {
        step: 's'.repeat(SESSION_ACTIVITY_TEXT_MAX_SCALARS),
        progress: { completed: 2, total: 3 },
        activity: 'sleeping',
        nextWakeAt: 200,
        outcome: 'interrupted',
      },
    })
    expect(new TextEncoder().encode(row!.title).byteLength).toBeLessThanOrEqual(
      SESSION_ACTIVITY_TEXT_MAX_UTF8_BYTES,
    )
  })
})

test('activity machine step falls back to the bounded definition name', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'activity-fallback')
    const sessionId = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    await ctx.db.patch(sessionId, {
      machine: {
        definitionName: 'definition'.repeat(SESSION_ACTIVITY_TEXT_MAX_SCALARS),
        progress: { completed: 0, total: 1 },
        orderedPath: [{ key: 'state:0', index: 0, name: 'wait', phase: 'current' }],
        activity: 'waiting',
      },
    })
    await reconcileSessionDiscovery(ctx, sessionId)

    const row = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId).eq('laneKey', 'owner'))
      .unique()
    expect(row?.machine).toEqual({
      step: 'definition'
        .repeat(SESSION_ACTIVITY_TEXT_MAX_SCALARS)
        .slice(0, SESSION_ACTIVITY_TEXT_MAX_SCALARS),
      progress: { completed: 0, total: 1 },
      activity: 'waiting',
    })
  })
})

test('generated title completion updates the activity projection atomically', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'activity-generated-title')
    const sessionId = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    await ctx.db.patch(sessionId, { titleAttemptId: 'title-attempt', titleStatus: 'generating' })
    await reconcileSessionDiscovery(ctx, sessionId)

    expect(
      await finishTitleAttemptImpl(ctx, {
        workspaceId,
        sessionId,
        attemptId: 'title-attempt',
        title: 'Generated activity title',
      }),
    ).toEqual({ applied: true })
    const row = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId).eq('laneKey', 'owner'))
      .unique()
    expect(row?.title).toBe('Generated activity title')
  })
})

test('personal archive is a disjoint active-only lane and global archive dominates it', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId, membershipId } = await seedReader(ctx, 'archive')
    const sessionId = await insertSession(ctx, {
      workspaceId,
      userId,
      updatedAt: 100,
      specific: true,
    })
    const stateId = await ctx.db.insert('agentSessionMemberStates', {
      workspaceId,
      sessionId,
      membershipId,
      audienceGranted: true,
      personalArchivedAt: 90,
    })
    await reconcileSessionDiscovery(ctx, sessionId)

    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId },
          archiveState: 'active',
          limit: 10,
        })
      ).items,
    ).toEqual([])
    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId },
          archiveState: 'archived',
          limit: 10,
        })
      ).items.map(row => row.id),
    ).toEqual([sessionId])

    await ctx.db.patch(sessionId, { archiveState: 'archived', archivedAt: 110, updatedAt: 110 })
    await reconcileSessionDiscovery(ctx, sessionId)
    const lanes = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId))
      .collect()
    expect(lanes.map(row => row.laneKey).sort()).toEqual([`member:${membershipId}`, 'owner'])
    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId },
          archiveState: 'archived',
          limit: 10,
        })
      ).items.map(row => row.id),
    ).toEqual([sessionId])
    expect((await ctx.db.get(stateId))?.personalArchivedAt).toBe(90)
  })
})

test('search advances the authorized candidate boundary across empty pages', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId, membershipId } = await seedReader(ctx, 'search')
    const newest = await insertSession(ctx, { workspaceId, userId, updatedAt: 300 })
    const middle = await insertSession(ctx, { workspaceId, userId, updatedAt: 200 })
    const match = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    await ctx.db.patch(match, { searchText: 'needle in the original prompt' })
    for (const sessionId of [newest, middle, match]) await reconcileSessionDiscovery(ctx, sessionId)

    const first = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      limit: 1,
      search: '  NEEDLE unrelated  ',
    })
    expect(first.items).toEqual([])
    expect(first.nextCursor).not.toBeNull()
    const second = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      limit: 1,
      search: 'needle unrelated',
      cursor: first.nextCursor!,
    })
    expect(second.items).toEqual([])
    expect(second.nextCursor).not.toBeNull()
    const third = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      limit: 1,
      search: 'needle unrelated',
      cursor: second.nextCursor!,
    })
    expect(third.items.map(row => row.id)).toEqual([match])
    expect(third.nextCursor).toBeNull()
  })
})

test('audience removal and membership rejoin cannot reuse an old generation lane', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId, membershipId } = await seedReader(ctx, 'generation')
    const sessionId = await insertSession(ctx, {
      workspaceId,
      userId,
      updatedAt: 100,
      specific: true,
    })
    const stateId = await ctx.db.insert('agentSessionMemberStates', {
      workspaceId,
      sessionId,
      membershipId,
      audienceGranted: true,
    })
    await reconcileSessionDiscovery(ctx, sessionId)
    await ctx.db.patch(stateId, { audienceGranted: false })
    await reconcileSessionDiscovery(ctx, sessionId)
    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId },
          archiveState: 'active',
          limit: 10,
        })
      ).items,
    ).toEqual([])

    await ctx.db.delete(membershipId)
    const rejoinedId = await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId,
      role: 'editor',
    })
    await writeMemberDirectoryEntry(ctx, (await ctx.db.get(rejoinedId))!)
    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId: rejoinedId },
          archiveState: 'active',
          limit: 10,
        })
      ).items,
    ).toEqual([])
  })
})

test('agent and bucket index families preserve order and continuation', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId, membershipId } = await seedReader(ctx, 'filters')
    const anchorId = await ctx.db.insert('anchors', {
      workspaceId,
      path: 'agents/filter',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'filter-marker',
      createdAt: 1,
      updatedAt: 1,
    })
    const agentId = await ctx.db.insert('agents', {
      workspaceId,
      anchorId,
      slug: 'filter',
      createdByUserId: userId,
      onboardedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const first = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    const second = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    const attributed = await insertSession(ctx, { workspaceId, userId, updatedAt: 300 })
    await ctx.db.patch(attributed, { agentId, agentName: 'filter' })
    const done = await insertSession(ctx, { workspaceId, userId, updatedAt: 400 })
    await ctx.db.patch(done, { bucket: 'done' })
    for (const sessionId of [first, second, attributed, done]) {
      await reconcileSessionDiscovery(ctx, sessionId)
    }

    const expectedRoot = [first, second].sort().reverse()
    const rootPage = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      agentId: null,
      bucket: 'running',
      limit: 1,
    })
    expect(rootPage.items.map(row => row.id)).toEqual(expectedRoot.slice(0, 1))
    expect(rootPage.nextCursor).not.toBeNull()
    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId },
          archiveState: 'active',
          agentId: null,
          bucket: 'running',
          limit: 1,
          cursor: rootPage.nextCursor!,
        })
      ).items.map(row => row.id),
    ).toEqual(expectedRoot.slice(1))
    expect(
      (
        await listPage(ctx, {
          workspaceId,
          scope: { kind: 'membership', membershipId },
          archiveState: 'active',
          agentId,
          limit: 10,
        })
      ).items.map(row => row.id),
    ).toEqual([attributed])
  })
})

test("one optional-parent index pages top-level rows and one parent's children", async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'lineage-index')
    const parent = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    const otherRoot = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    const firstChild = await insertSession(ctx, {
      workspaceId,
      userId,
      updatedAt: 200,
      createdBySessionId: parent,
    })
    const secondChild = await insertSession(ctx, {
      workspaceId,
      userId,
      updatedAt: 200,
      createdBySessionId: parent,
    })
    const otherParent = await insertSession(ctx, { workspaceId, userId, updatedAt: 300 })
    const otherChild = await insertSession(ctx, {
      workspaceId,
      userId,
      updatedAt: 400,
      createdBySessionId: otherParent,
    })
    for (const sessionId of [parent, otherRoot, firstChild, secondChild, otherParent, otherChild]) {
      await reconcileSessionDiscovery(ctx, sessionId)
    }

    const roots = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'workspace' },
      archiveState: 'active',
      limit: 10,
      topLevel: true,
    })
    expect(roots.items.map(row => row.id)).toEqual([
      otherParent,
      ...[parent, otherRoot].sort().reverse(),
    ])
    const firstPage = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'workspace' },
      archiveState: 'active',
      limit: 1,
      parentSessionId: parent,
    })
    expect(firstPage.items.map(row => row.id)).toEqual([secondChild])
    expect(firstPage.nextCursor).not.toBeNull()
    const secondPage = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'workspace' },
      archiveState: 'active',
      limit: 1,
      parentSessionId: parent,
      cursor: firstPage.nextCursor!,
    })
    expect(secondPage.items.map(row => row.id)).toEqual([firstChild])
    expect(secondPage.nextCursor).toBeNull()
  })
})

test('a dangling authorized candidate fails closed without stalling continuation', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId, membershipId } = await seedReader(ctx, 'dangling')
    const dangling = await insertSession(ctx, { workspaceId, userId, updatedAt: 200 })
    const surviving = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    await reconcileSessionDiscovery(ctx, dangling)
    await reconcileSessionDiscovery(ctx, surviving)
    // Fault injection: canonical deletion without its production cascade.
    await ctx.db.delete(dangling)

    const first = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      limit: 1,
    })
    expect(first.items).toEqual([])
    expect(first.nextCursor).not.toBeNull()
    const second = await listPage(ctx, {
      workspaceId,
      scope: { kind: 'membership', membershipId },
      archiveState: 'active',
      limit: 1,
      cursor: first.nextCursor!,
    })
    expect(second.items.map(row => row.id)).toEqual([surviving])
    expect(second.nextCursor).toBeNull()
  })
})

test('final deletion drains historical generation lanes in bounded idempotent batches', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'delete-batch')
    const sessionId = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    for (let index = 0; index < DELETE_DISCOVERY_BATCH + 1; index += 1) {
      await ctx.db.insert('agentSessionDiscovery', {
        workspaceId,
        laneKey: `historical:${index}`,
        sessionId,
        archiveState: 'active',
        bucket: 'running',
        orderKey: sessionDiscoveryOrderKey(100, sessionId),
        title: 'Delete batch',
        updatedAt: 100,
        lastEventSeq: 0,
      })
    }
    expect(await deleteSessionDiscovery(ctx, sessionId)).toBe(DELETE_DISCOVERY_BATCH)
    expect(await deleteSessionDiscovery(ctx, sessionId)).toBe(1)
    expect(await deleteSessionDiscovery(ctx, sessionId)).toBe(0)
    expect(await ctx.db.query('agentSessionDiscovery').collect()).toEqual([])
  })
})

test('strict discovery schema refuses removal of required activity copies', async () => {
  const t = convexTest(schema, modules)
  const rowId = await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'initializer-activity')
    const sessionId = await insertSession(ctx, { workspaceId, userId, updatedAt: 100 })
    await ctx.db.patch(sessionId, { title: '🚀'.repeat(SESSION_ACTIVITY_TEXT_MAX_SCALARS + 1) })
    await reconcileSessionDiscovery(ctx, sessionId)
    const row = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId))
      .first()
    if (row === null) throw new Error('fixture discovery row missing')
    return row._id
  })
  await expect(t.run(async ctx => await ctx.db.patch(rowId, { title: undefined }))).rejects.toThrow(
    'Missing required field `title`',
  )
})

test('strict session schema requires the migrated audience discriminator and specific count', async () => {
  const t = convexTest(schema, modules)
  const { workspaceSessionId, specificSessionId } = await t.run(async ctx => {
    const { userId, workspaceId } = await seedReader(ctx, 'migration-anomaly')
    return {
      workspaceSessionId: await insertSession(ctx, { workspaceId, userId, updatedAt: 2 }),
      specificSessionId: await insertSession(ctx, {
        workspaceId,
        userId,
        updatedAt: 3,
        specific: true,
      }),
    }
  })
  await expect(
    t.run(async ctx => ctx.db.patch(workspaceSessionId, { audienceKind: undefined })),
  ).rejects.toThrow('Validator error')
  await expect(
    t.run(async ctx =>
      ctx.db.patch(specificSessionId, { specificGrantedParticipantCount: undefined }),
    ),
  ).rejects.toThrow('Validator error')
  await expect(
    t.run(async ctx => ctx.db.patch(workspaceSessionId, { audienceKind: 'invalid' as never })),
  ).rejects.toThrow('Validator error')
})

async function insertSession(
  ctx: TestCtx,
  args: {
    workspaceId: Id<'workspaces'>
    userId: Id<'users'>
    updatedAt: number
    specific?: boolean
    createdBySessionId?: Id<'agentSessions'>
  },
) {
  const audienceFields = args.specific
    ? { audienceKind: 'specific' as const, specificGrantedParticipantCount: 1 }
    : { audienceKind: 'workspace' as const }
  return await ctx.db.insert('agentSessions', {
    workspaceId: args.workspaceId,
    userId: args.userId,
    ...audienceFields,
    turnStatus: 'running',
    bucket: 'running',
    prompt: `prompt-${args.updatedAt}`,
    title: `title-${args.updatedAt}`,
    titleOrigin: 'excerpt',
    titleStatus: 'complete',
    searchText: `title-${args.updatedAt}\nprompt-${args.updatedAt}`,
    ...(args.createdBySessionId === undefined
      ? {}
      : { createdBySessionId: args.createdBySessionId }),
    archiveState: 'active',
    visible: true,
    lastEventSeq: 0,
    lastRunnerInputSeq: 0,
    runnerInputPending: false,
    lastDeliveredInputSeq: 0,
    createdAt: args.updatedAt,
    updatedAt: args.updatedAt,
  })
}

async function seedReader(ctx: TestCtx, slug: string) {
  const userId = await ctx.db.insert('users', {
    email: `${slug}@example.test`,
    memberDirectoryRevision: 0,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  const workspaceId = await ctx.db.insert('workspaces', {
    slug,
    name: slug,
    status: 'active',
    billingUserId: userId,
    createdAt: 1,
  })
  const membershipId = await ctx.db.insert('workspaceMembers', {
    workspaceId,
    userId,
    role: 'editor',
  })
  await writeMemberDirectoryEntry(ctx, (await ctx.db.get(membershipId))!)
  return { userId, workspaceId, membershipId }
}

const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
beforeAll(() => {
  process.env.DUET_API_INTERNAL_KEY = 'discovery-test'
})
afterAll(() => {
  if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
})

async function listPage(
  ctx: TestCtx,
  args: {
    workspaceId: Id<'workspaces'>
    scope: { kind: 'workspace' } | { kind: 'membership'; membershipId: Id<'workspaceMembers'> }
    archiveState: 'active' | 'archived'
    limit: number
    cursor?: string
    search?: string
    agentId?: Id<'agents'> | null
    bucket?: 'running' | 'done'
    topLevel?: true
    parentSessionId?: string
  },
) {
  const member = args.scope.kind === 'membership' ? await ctx.db.get(args.scope.membershipId) : null
  const workspace = (await ctx.db.get(args.workspaceId))!
  const { scope, archiveState, agentId, parentSessionId, ...pageArgs } = args
  const queryArgs = {
    ...pageArgs,
    internalKey: 'discovery-test',
    archived: archiveState === 'archived' ? ('only' as const) : ('exclude' as const),
    ...(agentId === undefined ? {} : { agentId: agentId ?? 'root' }),
    ...(member === null ? {} : { actorId: member.userId }),
    identity:
      member === null
        ? { principal: { kind: 'workspace' as const }, actorId: workspace.billingUserId }
        : { principal: { kind: 'human' as const, userId: member.userId }, actorId: member.userId },
  }
  return parentSessionId === undefined
    ? await listSessionsImpl(ctx, queryArgs)
    : await listChildSessionsImpl(ctx, { ...queryArgs, parentSessionId })
}
