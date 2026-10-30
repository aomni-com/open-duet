import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'
import { ConvexError, v } from 'convex/values'

import { WORKSPACE_MEMBER_LIMIT } from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import { internalAction, internalMutation } from '../../_generated/server'
import schema from '../../schema'
import { resolveSessionPointFromDb } from './access'
import {
  advanceSessionDeletionFrontierImpl,
  beginOrResumeSessionSubtreeDeletion as beginOrResumeSessionSubtreeDeletionImpl,
  beginSessionSubtreeDeletionImpl as beginSessionSubtreeDeletionRaw,
  deleteSessionBatchImpl,
  SESSION_DELETION_CHILD_BATCH,
} from './deletion'
import { prepareRunnerInputDeliveryImpl } from './delivery'
import { reconcileSessionDiscovery } from './discovery'
import { setSessionArchiveImpl } from './lifecycle'
import { listSessionsImpl } from './queries'

const modules = {
  '../../_generated/api.ts': async () => ({}),
  '../../domains/agentSessions/model.ts': async () => ({
    deleteSessionBatch: internalMutation({
      args: { workId: v.id('agentSessionDeletionWork') },
      handler: deleteSessionBatchImpl,
    }),
    advanceSessionDeletionFrontier: internalMutation({
      args: { workId: v.id('agentSessionDeletionWork') },
      handler: () => ({ status: 'pending' as const }),
    }),
  }),
  '../../domains/agentSessions/titleGeneration.ts': async () => ({
    generateSessionTitle: internalAction({
      args: {
        workspaceId: v.id('workspaces'),
        sessionId: v.id('agentSessions'),
        prompt: v.string(),
        attemptId: v.string(),
      },
      handler: () => null,
    }),
  }),
}
type TestCtx = GenericMutationCtx<DataModel>
const frontierEffects = { async scheduleReadyWork() {} }

function advanceSessionDeletionFrontier(
  ctx: Parameters<typeof advanceSessionDeletionFrontierImpl>[0],
  args: Parameters<typeof advanceSessionDeletionFrontierImpl>[1],
) {
  return advanceSessionDeletionFrontierImpl(ctx, args, frontierEffects)
}

function beginOrResumeSessionSubtreeDeletion(
  ctx: Parameters<typeof beginOrResumeSessionSubtreeDeletionImpl>[0],
  args: Parameters<typeof beginOrResumeSessionSubtreeDeletionImpl>[1],
) {
  return beginOrResumeSessionSubtreeDeletionImpl(ctx, args, frontierEffects)
}

function beginSessionSubtreeDeletionImpl(
  ctx: Parameters<typeof beginSessionSubtreeDeletionRaw>[0],
  args: Parameters<typeof beginSessionSubtreeDeletionRaw>[1],
) {
  return beginSessionSubtreeDeletionRaw(ctx, args, frontierEffects)
}

test('bounded deletion work seals and queues a complete branching subtree', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'root' })
    const childA = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'child-a',
      parentId: root,
    })
    const childB = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'child-b',
      parentId: root,
    })
    const grandchild = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'grandchild',
      parentId: childA,
    })
    await ctx.db.patch(childA, { audienceKind: 'specific', specificGrantedParticipantCount: 1 })
    const anchorId = await ctx.db.insert('anchors', {
      workspaceId,
      path: 'agents/lineage-worker',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'lineage-worker-marker',
      createdAt: 1,
      updatedAt: 1,
    })
    const agentId = await ctx.db.insert('agents', {
      workspaceId,
      anchorId,
      slug: 'lineage-worker',
      createdByUserId: userId,
      createdAt: 1,
      updatedAt: 1,
    })
    await ctx.db.patch(childB, { agentId, agentName: 'lineage-worker' })

    return { workspaceId, root, childA, childB, grandchild }
  })
  await t.run(async ctx => {
    await beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      rootSessionId: ids.root,
      now: 100,
    })
  })
  await drainDeletionWork(t)

  await t.run(async ctx => {
    const sessions = await ctx.db.query('agentSessions').collect()
    expect(
      sessions
        .filter(session => [ids.root, ids.childA, ids.childB, ids.grandchild].includes(session._id))
        .map(session => [session.title, session.archiveState, session.visible])
        .sort(),
    ).toEqual([
      ['child-a', 'deleting', false],
      ['child-b', 'deleting', false],
      ['grandchild', 'deleting', false],
      ['root', 'deleting', false],
    ])
    const work = await ctx.db.query('agentSessionDeletionWork').collect()
    expect(
      work
        .map(row => [row.sessionId, row.rootSessionId, row.childScanComplete])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual(
      [ids.root, ids.childA, ids.childB, ids.grandchild]
        .map(sessionId => [sessionId, ids.root, true])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    )
  })
})

test('starting from a child queues only that child subtree', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'root' })
    const child = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'child',
      parentId: root,
    })
    const sibling = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'sibling',
      parentId: root,
    })
    const grandchild = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'grandchild',
      parentId: child,
    })
    return { workspaceId, root, child, sibling, grandchild }
  })
  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.child,
      rootSessionId: ids.child,
      now: 100,
    }),
  )
  await drainDeletionWork(t)

  await t.run(async ctx => {
    const work = await ctx.db.query('agentSessionDeletionWork').collect()
    expect(work.map(row => row.sessionId).sort()).toEqual([ids.child, ids.grandchild].sort())
    expect((await ctx.db.get(ids.root))?.archiveState).toBe('active')
    expect((await ctx.db.get(ids.sibling))?.archiveState).toBe('active')
  })
})

test('archive stays local while subtree deletion includes archived descendants', async () => {
  const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'test-internal-key'
  const t = convexTest(schema, modules)
  try {
    const ids = await t.run(async ctx => {
      const { userId, workspaceId } = await seedWorkspace(ctx)
      const root = await insertSession(ctx, { workspaceId, userId, title: 'root' })
      const child = await insertSession(ctx, {
        workspaceId,
        userId,
        title: 'archived-child',
        parentId: root,
      })
      await setSessionArchiveImpl(ctx, {
        internalKey: 'test-internal-key',
        workspaceId,
        sessionId: child,
        actorId: userId,
        identity: { principal: { kind: 'human', userId }, actorId: userId },
        kind: 'global',
        archived: true,
        now: 50,
      })
      expect(await ctx.db.query('agentSessionDeletionWork').collect()).toEqual([])
      expect((await ctx.db.get(root))?.archiveState).toBe('active')
      return { userId, workspaceId, root, child }
    })
    await t.run(ctx =>
      beginOrResumeSessionSubtreeDeletion(ctx, {
        workspaceId: ids.workspaceId,
        sessionId: ids.root,
        rootSessionId: ids.root,
        now: 100,
      }),
    )
    await drainDeletionWork(t)
    await t.run(async ctx => {
      expect((await ctx.db.get(ids.child))?.archiveState).toBe('deleting')
      expect(
        (await ctx.db.query('agentSessionDeletionWork').collect()).map(row => row.sessionId).sort(),
      ).toEqual([ids.root, ids.child].sort())
    })
  } finally {
    if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
  }
})

test('relationship cursors cross child pages without gaps when a child is claimed mid-scan', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'root' })
    const children = []
    for (let index = 0; index < SESSION_DELETION_CHILD_BATCH + 2; index += 1) {
      children.push(
        await insertSession(ctx, {
          workspaceId,
          userId,
          title: `child-${index}`,
          parentId: root,
        }),
      )
    }
    return { workspaceId, root, children }
  })
  const rootWorkId = await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      rootSessionId: ids.root,
      now: 100,
    }),
  )
  expect(rootWorkId).not.toBeNull()
  // Between the parent's first and second child page, an independent delete
  // claims a child the scan has not reached yet. The frontier reads that
  // child's seal and existing work row when its page arrives.
  const claimedChildId = await t.run(async ctx => {
    const stillActive = (await Promise.all(ids.children.map(id => ctx.db.get(id)))).find(
      child => child?.archiveState === 'active',
    )
    expect(stillActive).toBeDefined()
    await beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: stillActive!._id,
      rootSessionId: stillActive!._id,
      now: 150,
    })
    return stillActive!._id
  })
  await t.run(ctx => advanceSessionDeletionFrontier(ctx, { workId: rootWorkId!, now: 200 }))
  await drainDeletionWork(t)

  await t.run(async ctx => {
    const work = await ctx.db.query('agentSessionDeletionWork').collect()
    expect(work.map(row => row.sessionId).sort()).toEqual([ids.root, ...ids.children].sort())
    expect(
      work
        .filter(row => row.sessionId !== ids.root && row.rootSessionId !== ids.root)
        .map(row => [row.sessionId, row.rootSessionId]),
    ).toEqual([[claimedChildId, claimedChildId]])
  })
})

test('sealing a full child page clears every discovery lane at maximum workspace membership', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId, membershipId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'bounded-root' })
    const membershipIds = [membershipId]
    for (let index = 1; index < WORKSPACE_MEMBER_LIMIT; index += 1) {
      const memberUserId = await ctx.db.insert('users', {
        email: `lineage-viewer-${index}@example.test`,
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      membershipIds.push(
        await ctx.db.insert('workspaceMembers', {
          workspaceId,
          userId: memberUserId,
          role: 'viewer',
        }),
      )
    }
    const children = []
    for (let index = 0; index < SESSION_DELETION_CHILD_BATCH; index += 1) {
      const childId = await insertSession(ctx, {
        workspaceId,
        userId,
        title: `bounded-child-${index}`,
        parentId: root,
      })
      await ctx.db.patch(childId, {
        audienceKind: 'specific',
        specificGrantedParticipantCount: membershipIds.length,
      })
      for (const grantedMembershipId of membershipIds) {
        await ctx.db.insert('agentSessionMemberStates', {
          workspaceId,
          sessionId: childId,
          membershipId: grantedMembershipId,
          audienceGranted: true,
        })
      }
      await reconcileSessionDiscovery(ctx, childId)
      children.push(childId)
    }
    return { workspaceId, root, children }
  })
  const lanesPerChild = 1 + WORKSPACE_MEMBER_LIMIT
  expect(await t.run(ctx => discoveryRowCounts(ctx, ids.children))).toEqual(
    ids.children.map(() => lanesPerChild),
  )

  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      rootSessionId: ids.root,
      now: 100,
    }),
  )

  await t.run(async ctx => {
    const work = await ctx.db.query('agentSessionDeletionWork').collect()
    expect(work.map(row => row.sessionId).sort()).toEqual([ids.root, ...ids.children].sort())
    expect(await discoveryRowCounts(ctx, ids.children)).toEqual(ids.children.map(() => 0))
  })
}, 30_000)

test('duplicate and overlapping subtree work coalesces by session', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'root' })
    const child = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'child',
      parentId: root,
    })
    const grandchild = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'grandchild',
      parentId: child,
    })
    return { workspaceId, root, child, grandchild }
  })
  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.child,
      rootSessionId: ids.child,
      now: 100,
    }),
  )
  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.child,
      rootSessionId: ids.child,
      now: 101,
    }),
  )
  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      rootSessionId: ids.root,
      now: 102,
    }),
  )
  await drainDeletionWork(t)

  await t.run(async ctx => {
    const work = await ctx.db.query('agentSessionDeletionWork').collect()
    expect(work.map(row => row.sessionId).sort()).toEqual(
      [ids.root, ids.child, ids.grandchild].sort(),
    )
    const childWork = work.find(row => row.sessionId === ids.child)
    expect(childWork?.rootSessionId).toBe(ids.child)
    expect(await advanceSessionDeletionFrontier(ctx, { workId: childWork!._id, now: 300 })).toEqual(
      { status: 'scan_complete' },
    )
  })
})

test('sealing removes point and discovery reads without disturbing another default', async () => {
  const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'deletion-list-test'
  try {
    const t = convexTest(schema, modules)
    const ids = await t.run(async ctx => {
      const { userId, workspaceId } = await seedWorkspace(ctx)
      const root = await insertSession(ctx, { workspaceId, userId, title: 'root-searchable' })
      const other = await insertSession(ctx, { workspaceId, userId, title: 'other' })
      await ctx.db.patch(workspaceId, { rootDefaultSessionId: other })
      await reconcileSessionDiscovery(ctx, root)
      return { userId, workspaceId, root, other }
    })
    await t.run(ctx =>
      beginOrResumeSessionSubtreeDeletion(ctx, {
        workspaceId: ids.workspaceId,
        sessionId: ids.root,
        rootSessionId: ids.root,
        now: 100,
      }),
    )

    await t.run(async ctx => {
      expect((await ctx.db.get(ids.workspaceId))?.rootDefaultSessionId).toBe(ids.other)
      expect(
        await resolveSessionPointFromDb(ctx, {
          workspaceId: ids.workspaceId,
          sessionId: ids.root,
          identity: { principal: { kind: 'workspace' }, actorId: ids.userId },
        }),
      ).toBeNull()
      const listed = await listSessionsImpl(ctx, {
        workspaceId: ids.workspaceId,
        internalKey: 'deletion-list-test',
        identity: { principal: { kind: 'workspace' }, actorId: ids.userId },
        search: 'root-searchable',
        limit: 10,
      })
      expect(listed.items).toEqual([])
    })
  } finally {
    if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
  }
})

test('sealing clears a default pointer that still names the session', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'default-root' })
    await ctx.db.patch(workspaceId, { rootDefaultSessionId: root })
    return { workspaceId, root }
  })
  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      rootSessionId: ids.root,
      now: 100,
    }),
  )
  expect(
    await t.run(async ctx => (await ctx.db.get(ids.workspaceId))?.rootDefaultSessionId ?? null),
  ).toBeNull()
})

test('a nested create after the parent seals is rejected', async () => {
  const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'test-internal-key'
  try {
    const t = convexTest(schema, modules)
    const ids = await t.run(async ctx => {
      const { userId, workspaceId } = await seedWorkspace(ctx)
      const root = await insertSession(ctx, { workspaceId, userId, title: 'sealed-root' })
      return { userId, workspaceId, root }
    })
    await t.run(ctx =>
      beginOrResumeSessionSubtreeDeletion(ctx, {
        workspaceId: ids.workspaceId,
        sessionId: ids.root,
        rootSessionId: ids.root,
        now: 100,
      }),
    )

    const rejection = await t
      .run(ctx =>
        prepareRunnerInputDeliveryImpl(ctx, {
          internalKey: 'test-internal-key',
          workspaceId: ids.workspaceId,
          actorId: ids.userId,
          identity: { principal: { kind: 'workspace' }, actorId: ids.userId },
          createdBySessionId: ids.root,
          attemptId: 'late-create',
          now: 101,
          input: {
            kind: 'initial_prompt',
            prompt: 'late child',
            behavior: 'steer',
            sender: { kind: 'session', sessionId: ids.root },
          },
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(rejection).toBeInstanceOf(ConvexError)
    expect(rejection).toMatchObject({ data: { error: 'not_found' } })

    await drainDeletionWork(t)
    await t.run(async ctx => {
      expect(
        await ctx.db
          .query('agentSessions')
          .withIndex('by_workspace_parent', q =>
            q.eq('workspaceId', ids.workspaceId).eq('createdBySessionId', ids.root),
          )
          .collect(),
      ).toEqual([])
      expect(
        (await ctx.db.query('agentSessionDeletionWork').collect()).map(row => row.sessionId),
      ).toEqual([ids.root])
    })
  } finally {
    if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
  }
})

test('a nested session committed before sealing is durably queued', async () => {
  const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'test-internal-key'
  try {
    const t = convexTest(schema, modules)
    const ids = await t.run(async ctx => {
      const { userId, workspaceId } = await seedWorkspace(ctx)
      const root = await insertSession(ctx, { workspaceId, userId, title: 'parent' })
      const created = await prepareRunnerInputDeliveryImpl(ctx, {
        internalKey: 'test-internal-key',
        workspaceId,
        actorId: userId,
        identity: { principal: { kind: 'workspace' }, actorId: userId },
        createdBySessionId: root,
        attemptId: 'committed-child',
        now: 50,
        input: {
          kind: 'initial_prompt',
          prompt: 'committed child',
          behavior: 'steer',
          sender: { kind: 'session', sessionId: root },
        },
      })
      if ('refused' in created) throw new Error('child session creation was refused')
      return { workspaceId, root, child: created.sessionId }
    })
    await t.run(ctx =>
      beginOrResumeSessionSubtreeDeletion(ctx, {
        workspaceId: ids.workspaceId,
        sessionId: ids.root,
        rootSessionId: ids.root,
        now: 100,
      }),
    )
    await drainDeletionWork(t)
    await t.run(async ctx => {
      expect((await ctx.db.get(ids.child))?.archiveState).toBe('deleting')
      expect(
        (await ctx.db.query('agentSessionDeletionWork').collect()).some(
          row => row.sessionId === ids.child,
        ),
      ).toBe(true)
    })
  } finally {
    if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
  }
})

test('sealing captures the provider session identity on durable work', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const root = await insertSession(ctx, { workspaceId, userId, title: 'provider-root' })
    await ctx.db.insert('composioToolRouterSessions', {
      workspaceId,
      duetSessionId: root,
      permissionFingerprint: 'permission-fingerprint',
      disabledToolkitSlugs: [],
      providerSessionId: 'provider-session',
      createdAt: 1,
    })
    return { workspaceId, root }
  })
  await t.run(ctx =>
    beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      rootSessionId: ids.root,
      now: 100,
    }),
  )
  expect(
    await t.run(
      async ctx =>
        (
          await ctx.db
            .query('agentSessionDeletionWork')
            .withIndex('by_session', q => q.eq('sessionId', ids.root))
            .unique()
        )?.providerSessionId,
    ),
  ).toBe('provider-session')
})

test('authorized deletion preparation replays after the root is sealed', async () => {
  const previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'test-internal-key'
  try {
    const t = convexTest(schema, modules)
    const ids = await t.run(async ctx => {
      const { userId, workspaceId } = await seedWorkspace(ctx)
      const root = await insertSession(ctx, { workspaceId, userId, title: 'replay-root' })
      return { userId, workspaceId, root }
    })
    const args = {
      internalKey: 'test-internal-key',
      workspaceId: ids.workspaceId,
      sessionId: ids.root,
      actorId: ids.userId,
      identity: {
        principal: { kind: 'human' as const, userId: ids.userId },
        actorId: ids.userId,
      },
      now: 100,
    }
    expect(await t.run(ctx => beginSessionSubtreeDeletionImpl(ctx, args))).toEqual({
      accepted: true,
    })
    expect(await t.run(ctx => beginSessionSubtreeDeletionImpl(ctx, args))).toEqual({
      accepted: true,
    })
    expect(
      await t.run(async ctx =>
        ctx.db
          .query('agentSessionDeletionWork')
          .withIndex('by_session', q => q.eq('sessionId', ids.root))
          .unique(),
      ),
    ).toMatchObject({ sessionId: ids.root, rootSessionId: ids.root })
  } finally {
    if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
  }
})

test('physical cleanup waits for child scanning and external disposal', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const externalPendingSessionId = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'external pending',
    })
    const scanPendingSessionId = await insertSession(ctx, {
      workspaceId,
      userId,
      title: 'scan pending',
    })
    return { workspaceId, externalPendingSessionId, scanPendingSessionId }
  })
  const externalPendingWorkId = await t.run(async ctx => {
    await beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.externalPendingSessionId,
      rootSessionId: ids.externalPendingSessionId,
      now: 100,
    })
    const externalPendingWork = await ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_session', q => q.eq('sessionId', ids.externalPendingSessionId))
      .unique()
    return externalPendingWork!._id
  })
  const scanPendingWorkId = await t.run(async ctx => {
    await beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId: ids.workspaceId,
      sessionId: ids.scanPendingSessionId,
      rootSessionId: ids.scanPendingSessionId,
      now: 100,
    })
    const scanPendingWork = await ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_session', q => q.eq('sessionId', ids.scanPendingSessionId))
      .unique()
    await ctx.db.patch(scanPendingWork!._id, {
      childScanComplete: false,
      externalState: 'complete',
    })
    return scanPendingWork!._id
  })

  for (const workId of [externalPendingWorkId, scanPendingWorkId]) {
    expect(await t.run(ctx => deleteSessionBatchImpl(ctx, { workId }))).toEqual({ done: false })
  }
  await t.run(async ctx => {
    expect(await ctx.db.get(ids.externalPendingSessionId)).not.toBeNull()
    expect(await ctx.db.get(externalPendingWorkId)).not.toBeNull()
    expect(await ctx.db.get(ids.scanPendingSessionId)).not.toBeNull()
    expect(await ctx.db.get(scanPendingWorkId)).not.toBeNull()
  })
})

test('frontier completion schedules work whose external disposal finished first', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const sessionId = await insertSession(ctx, { workspaceId, userId, title: 'scan finishes last' })
    await ctx.db.patch(sessionId, { archiveState: 'deleting', visible: false })
    const workId = await ctx.db.insert('agentSessionDeletionWork', {
      workspaceId,
      sessionId,
      rootSessionId: sessionId,
      childScanComplete: false,
      externalState: 'complete',
      createdAt: 100,
      updatedAt: 100,
    })
    return { workId, sessionId }
  })

  expect(
    await t.run(ctx => advanceSessionDeletionFrontierImpl(ctx, { workId: ids.workId, now: 200 })),
  ).toEqual({ status: 'scan_complete' })
  await Bun.sleep(1)
  await t.finishInProgressScheduledFunctions()
  expect(await t.run(ctx => ctx.db.get(ids.sessionId))).toBeNull()
  expect(await t.run(ctx => ctx.db.get(ids.workId))).toBeNull()
})

test('final physical cleanup removes the canonical session and work atomically', async () => {
  const t = convexTest(schema, modules)
  const ids = await t.run(async ctx => {
    const { userId, workspaceId } = await seedWorkspace(ctx)
    const sessionId = await insertSession(ctx, { workspaceId, userId, title: 'finished cleanup' })
    await beginOrResumeSessionSubtreeDeletion(ctx, {
      workspaceId,
      sessionId,
      rootSessionId: sessionId,
      now: 100,
    })
    const work = await ctx.db
      .query('agentSessionDeletionWork')
      .withIndex('by_session', q => q.eq('sessionId', sessionId))
      .unique()
    await ctx.db.patch(work!._id, { externalState: 'complete' })
    return { sessionId, workId: work!._id }
  })

  expect(await t.run(ctx => deleteSessionBatchImpl(ctx, { workId: ids.workId }))).toEqual({
    done: true,
  })
  await t.run(async ctx => {
    expect(await ctx.db.get(ids.sessionId)).toBeNull()
    expect(await ctx.db.get(ids.workId)).toBeNull()
  })
})

async function drainDeletionWork(t: ReturnType<typeof convexTest>) {
  const sessionCount = await t.run(
    async ctx => (await ctx.db.query('agentSessions').collect()).length,
  )
  for (let attempt = 0; attempt <= 2 * sessionCount; attempt++) {
    const pending = await t.run(async ctx => {
      const work = await ctx.db.query('agentSessionDeletionWork').collect()
      return work.find(row => !row.childScanComplete)?._id ?? null
    })
    if (pending === null) return
    await t.run(ctx => advanceSessionDeletionFrontier(ctx, { workId: pending, now: 200 }))
  }
  throw new Error('Deletion frontier did not drain its finite subtree')
}

async function seedWorkspace(ctx: TestCtx) {
  const userId = await ctx.db.insert('users', {
    email: 'lineage@example.test',
    memberDirectoryRevision: 0,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  const workspaceId = await ctx.db.insert('workspaces', {
    slug: 'lineage',
    name: 'Lineage',
    status: 'active',
    billingUserId: userId,
    createdAt: 1,
  })
  const membershipId = await ctx.db.insert('workspaceMembers', {
    workspaceId,
    userId,
    role: 'owner',
  })
  return { userId, workspaceId, membershipId }
}

async function discoveryRowCounts(ctx: TestCtx, sessionIds: Array<Id<'agentSessions'>>) {
  return await Promise.all(
    sessionIds.map(
      async sessionId =>
        (
          await ctx.db
            .query('agentSessionDiscovery')
            .withIndex('by_session_lane', q => q.eq('sessionId', sessionId))
            .collect()
        ).length,
    ),
  )
}

async function insertSession(
  ctx: TestCtx,
  args: {
    workspaceId: Id<'workspaces'>
    userId: Id<'users'>
    title: string
    parentId?: Id<'agentSessions'>
  },
) {
  return await ctx.db.insert('agentSessions', {
    workspaceId: args.workspaceId,
    userId: args.userId,
    audienceKind: 'workspace',
    turnStatus: 'complete',
    bucket: 'done',
    prompt: args.title,
    title: args.title,
    titleOrigin: 'excerpt',
    titleStatus: 'complete',
    searchText: args.title,
    archiveState: 'active',
    visible: true,
    ...(args.parentId === undefined ? {} : { createdBySessionId: args.parentId }),
    lastEventSeq: 0,
    lastRunnerInputSeq: 0,
    runnerInputPending: false,
    lastDeliveredInputSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  })
}
