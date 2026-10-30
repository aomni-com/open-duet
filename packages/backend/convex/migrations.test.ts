import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { beforeHumanIdentityCutoverSchema } from './human-identity-schema.test-helper'
import {
  migrateHumanIdentityKeyRow,
  backfillSpecificPeopleSessionRow,
  backfillInterruptedSessionBucketRow,
  backfillTranscriptEventRow,
  legacyFileEventIsRead,
  specificPeopleSessionMigrationPatch,
} from './migrations'
import schema from './schema'

const modules = { './_generated/api.ts': async () => ({}) }

test('legacy file activity derives the indexed read discriminator from event kind', () => {
  expect(legacyFileEventIsRead('read')).toBeTrue()
  expect(legacyFileEventIsRead('viewed-summary')).toBeTrue()
  for (const kind of [
    'write',
    'create',
    'delete',
    'rename',
    'changed-summary',
    'restore',
  ] as const) {
    expect(legacyFileEventIsRead(kind)).toBeFalse()
  }
})

test('session migration defaults only legacy rows to workspace audience', () => {
  expect(specificPeopleSessionMigrationPatch({})).toEqual({ audienceKind: 'workspace' })
  expect(specificPeopleSessionMigrationPatch({ audienceKind: 'workspace' })).toBeUndefined()
  expect(specificPeopleSessionMigrationPatch({ audienceKind: 'specific' })).toBeUndefined()
})

test('session migration preserves canonical specific audience state', async () => {
  const t = convexTest(schema, modules)

  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'specific-session@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'specific-session-migration',
      name: 'Specific session migration',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    const sessionId = await ctx.db.insert('agentSessions', {
      workspaceId,
      userId,
      audienceKind: 'specific',
      specificGrantedParticipantCount: 0,
      turnStatus: 'complete',
      bucket: 'done',
      prompt: 'Prompt',
      title: 'Title',
      titleOrigin: 'excerpt',
      titleStatus: 'complete',
      searchText: 'title\nprompt',
      archiveState: 'active',
      visible: true,
      lastEventSeq: 0,
      lastRunnerInputSeq: 0,
      runnerInputPending: false,
      lastDeliveredInputSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    })

    const session = await ctx.db.get(sessionId)
    if (session === null) throw new Error('specific session disappeared')
    await backfillSpecificPeopleSessionRow(ctx, session)
    expect(await ctx.db.get(sessionId)).toMatchObject({
      audienceKind: 'specific',
      specificGrantedParticipantCount: 0,
    })
  })
})

/* Rows written before the transcript stamp existed must page under the
   transcript view exactly as rows written after it: the backfill applies the
   writer's predicate, leaves task rows unstamped, and does not rewrite a row
   that already carries the stamp. */
test('transcript backfill stamps legacy transcript rows and skips the task rail', async () => {
  const t = convexTest(schema, modules)

  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'transcript-backfill@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'transcript-backfill',
      name: 'Transcript backfill',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    const sessionId = await ctx.db.insert('agentSessions', {
      workspaceId,
      userId,
      audienceKind: 'specific',
      specificGrantedParticipantCount: 0,
      turnStatus: 'complete',
      bucket: 'done',
      prompt: 'Prompt',
      title: 'Title',
      titleOrigin: 'excerpt',
      titleStatus: 'complete',
      searchText: 'title\nprompt',
      archiveState: 'active',
      visible: true,
      lastEventSeq: 3,
      lastRunnerInputSeq: 0,
      runnerInputPending: false,
      lastDeliveredInputSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const rows = [
      { seq: 1, event: { type: 'step', step: { type: 'text', text: 'visible' } } },
      {
        seq: 2,
        event: { type: 'step', origin: { taskId: 't1' }, step: { type: 'text', text: 'child' } },
      },
      { seq: 3, event: { type: 'task_output', taskId: 't1', chunk: 'out' } },
    ]
    for (const row of rows) {
      await ctx.db.insert('agentSessionEvents', { workspaceId, sessionId, createdAt: 1, ...row })
    }
    for (const row of await ctx.db.query('agentSessionEvents').collect()) {
      await backfillTranscriptEventRow(ctx, row)
    }
    const stamped = (await ctx.db.query('agentSessionEvents').collect())
      .sort((left, right) => left.seq - right.seq)
      .map(row => [row.seq, row.transcript])
    expect(stamped).toEqual([
      [1, true],
      [2, undefined],
      [3, undefined],
    ])
  })
})

test('interrupted bucket repair updates discovery without resuming or completing the machine', async () => {
  const t = convexTest(schema, modules)
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'interrupted-bucket@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'interrupted-bucket',
      name: 'Interrupted bucket',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    const sessionId = await ctx.db.insert('agentSessions', {
      workspaceId,
      userId,
      audienceKind: 'workspace',
      turnStatus: 'interrupted',
      bucket: 'running',
      prompt: 'Prompt',
      title: 'Title',
      titleOrigin: 'excerpt',
      titleStatus: 'complete',
      searchText: 'title',
      archiveState: 'active',
      visible: true,
      lastEventSeq: 7,
      lastRunnerInputSeq: 3,
      runnerInputPending: false,
      lastDeliveredInputSeq: 3,
      createdAt: 1,
      updatedAt: 2,
      machine: { orderedPath: [], activity: 'idle' },
    })
    const before = (await ctx.db.get(sessionId))!
    await backfillSpecificPeopleSessionRow(ctx, before)
    await backfillInterruptedSessionBucketRow(ctx, before)
    const repaired = (await ctx.db.get(sessionId))!
    expect(repaired).toEqual({ ...before, bucket: 'done' })
    const lanes = await ctx.db
      .query('agentSessionDiscovery')
      .withIndex('by_session_lane', q => q.eq('sessionId', sessionId))
      .collect()
    expect(lanes.map(row => [row.laneKey, row.bucket]).sort()).toEqual([
      ['owner', 'done'],
      ['workspace', 'done'],
    ])
    await backfillInterruptedSessionBucketRow(ctx, repaired)
    expect(await ctx.db.get(sessionId)).toEqual(repaired)
    expect(await ctx.db.query('agentSessionDiscovery').collect()).toEqual(lanes)

    // A later user prompt is authoritative. Migration sees that current row,
    // not the interrupted evidence from before the prompt was accepted.
    await ctx.db.patch(sessionId, {
      turnStatus: 'running',
      bucket: 'running',
      lastRunnerInputSeq: 8,
      runnerInputPending: true,
    })
    const resumed = (await ctx.db.get(sessionId))!
    await backfillSpecificPeopleSessionRow(ctx, resumed)
    await backfillInterruptedSessionBucketRow(ctx, resumed)
    expect(await ctx.db.get(sessionId)).toEqual(resumed)
    expect((await ctx.db.query('agentSessionDiscovery').collect()).map(row => row.bucket)).toEqual([
      'running',
      'running',
    ])
  })
})

test('human-key migration removes grants without changing the bearer or nonhuman keys', async () => {
  const strictRows = convexTest(schema, modules)
  await convexTest(beforeHumanIdentityCutoverSchema, modules).run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'migrate@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'migration',
      name: 'Migration',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    const row = {
      userId,
      hashedKey: 'a'.repeat(64),
      prefix: 'duet_sk_existing',
      scopes: ['ws:migration:admin'],
      workspaceIds: [workspaceId],
      workspaceId,
    }
    const humanId = await ctx.db.insert('apiKeys', { ...row, kind: 'user' })
    const machineId = await ctx.db.insert('apiKeys', {
      ...row,
      kind: 'system_vm',
      hashedKey: 'b'.repeat(64),
    })
    const before = await ctx.db.get(machineId)
    await migrateHumanIdentityKeyRow(ctx, (await ctx.db.get(humanId))!)
    await migrateHumanIdentityKeyRow(ctx, (await ctx.db.get(machineId))!)
    await migrateHumanIdentityKeyRow(ctx, (await ctx.db.get(humanId))!)
    const after = await ctx.db.get(humanId)
    expect(after).toMatchObject({ userId, hashedKey: row.hashedKey, prefix: row.prefix })
    expect(after).not.toHaveProperty('scopes')
    expect(after).not.toHaveProperty('workspaceIds')
    expect(after).not.toHaveProperty('workspaceId')
    expect(await ctx.db.get(machineId)).toEqual(before)
    const { _id, _creationTime, ...strictFields } = after!
    await strictRows.run(async strict => {
      const accepted = await strict.db.insert('apiKeys', strictFields)
      expect(await strict.db.get(accepted)).toMatchObject(strictFields)
    })
  })
})
