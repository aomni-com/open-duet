import { afterEach, beforeEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import {
  makeFunctionReference,
  type ApiFromModules,
  type FunctionArgs,
  type FunctionReturnType,
} from 'convex/server'

import { BACKUP_STALL_MS } from '@repo/contract'

import type * as jobs from '../convex/domains/workspaceBackups/jobs'
import schema from '../convex/schema'
const originalInternalKey = process.env.DUET_API_INTERNAL_KEY
const originalApiUrl = process.env.DUET_API_URL
const originalFetch = globalThis.fetch
const fixtures: Array<ReturnType<typeof convexTest>> = []
beforeEach(() => {
  process.env.DUET_API_URL = 'https://backup-callback.example.test'
  globalThis.fetch = (async () => Response.json({ retryAfterMs: null })) as unknown as typeof fetch
})
afterEach(async () => {
  for (const t of fixtures.splice(0)) {
    await t.run(async ctx => {
      for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
        if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
    })
    await t.finishInProgressScheduledFunctions()
  }
  globalThis.fetch = originalFetch
  if (originalApiUrl === undefined) delete process.env.DUET_API_URL
  else process.env.DUET_API_URL = originalApiUrl
  if (originalInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = originalInternalKey
})
type JobsApi = ApiFromModules<{ jobs: typeof jobs }>['jobs']
const ref = <Name extends keyof JobsApi>(name: Name) =>
  makeFunctionReference<
    JobsApi[Name]['_type'],
    FunctionArgs<JobsApi[Name]>,
    FunctionReturnType<JobsApi[Name]>
  >(`domains/workspaceBackups/jobs:${name}`)
async function fixture() {
  process.env.DUET_API_INTERNAL_KEY = 'backup-test-key'
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/workspaceBackups/dispatch.ts': () =>
      import('../convex/domains/workspaceBackups/dispatch'),
    '../convex/domains/workspaces/lifecycle.ts': () =>
      import('../convex/domains/workspaces/lifecycle'),
    '../convex/domains/workspaceBackups/jobs.ts': () =>
      import('../convex/domains/workspaceBackups/jobs'),
  })
  fixtures.push(t)
  const workspaceId = await t.run(async ctx => {
    const billingUserId = await ctx.db.insert('users', {
      email: 'backup@example.test',
      memberDirectoryRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    return ctx.db.insert('workspaces', {
      billingUserId,
      createdByUserId: billingUserId,
      slug: 'backup',
      name: 'Backup',
      status: 'active',
      createdAt: 1,
      vmTokenNonce: 'generation-1',
    })
  })
  return { t, args: { internalKey: 'backup-test-key', workspaceId } }
}
test('create replays the original request and refuses a competing active capture', async () => {
  const { t, args } = await fixture()
  const first = await t.mutation(ref('create'), { ...args, requestId: 'request-1' })
  expect(await t.mutation(ref('create'), { ...args, requestId: 'request-1' })).toEqual(first)
  expect(first.objectPath).toContain(`/${first._id}/${first.attemptId}.zip`)
  await expect(
    t.mutation(ref('create'), { ...args, requestId: 'request-2' }),
  ).rejects.toMatchObject({ data: { code: 'backup_in_progress', backupId: first._id } })
})

test('VM replacement and deletion fence stale completion; terminal replay stays stable', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'race' })
  const attempt = {
    ...args,
    backupId: job._id,
    attemptId: job.attemptId,
    sourceVmGeneration: 'generation-1',
  }
  expect((await t.mutation(ref('claim'), attempt))?.status).toBe('running')
  const completion = {
    ...attempt,
    bytes: 200,
    sha256: 'a'.repeat(64),
    completeness: 'partial' as const,
  }
  await t.run(ctx => ctx.db.patch(args.workspaceId, { vmTokenNonce: 'generation-2' }))
  expect(await t.mutation(ref('complete'), completion)).toBe(false)
  await t.run(ctx => ctx.db.patch(args.workspaceId, { vmTokenNonce: 'generation-1' }))
  expect(await t.mutation(ref('complete'), completion)).toBe(true)
  const ready = await t.run(ctx => ctx.db.get(job._id))
  expect(await t.mutation(ref('complete'), completion)).toBe(true)
  expect(await t.run(ctx => ctx.db.get(job._id))).toEqual(ready)
  await t.mutation(ref('requestDelete'), { ...args, backupId: job._id })
  expect(await t.mutation(ref('complete'), completion)).toBe(false)
  await t.mutation(ref('finishDelete'), { ...args, backupId: job._id })
  expect(await t.run(ctx => ctx.db.get(job._id))).toBeNull()
})

test('heartbeats and backward phases cannot keep an idle attempt alive', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'progress' })
  const attempt = {
    ...args,
    backupId: job._id,
    attemptId: job.attemptId,
    sourceVmGeneration: 'generation-1',
  }
  await t.mutation(ref('claim'), attempt)
  expect(
    await t.mutation(ref('progress'), {
      ...attempt,
      phase: 'upload',
      progress: { ...job.progress, processedFiles: 2, capturedBytes: 100 },
    }),
  ).toBe(true)
  expect(
    await t.mutation(ref('progress'), {
      ...attempt,
      phase: 'metadata',
      progress: { ...job.progress, processedFiles: 2, capturedBytes: 100 },
    }),
  ).toBe(false)
  await t.run(ctx => ctx.db.patch(job._id, { lastProgressAt: Date.now() - BACKUP_STALL_MS - 1 }))
  await t.mutation(ref('progress'), {
    ...attempt,
    phase: 'upload',
    progress: { ...job.progress, processedFiles: 2, capturedBytes: 100 },
  })
  expect(
    await t.mutation(ref('reconcile'), { internalKey: args.internalKey, backupId: job._id }),
  ).toMatchObject({ backup: { _id: job._id, status: 'failed', objectCleanupPending: true } })
  expect(await t.run(ctx => ctx.db.get(job._id))).toMatchObject({
    status: 'failed',
    error: { code: 'stalled' },
  })
  expect((await t.mutation(ref('create'), { ...args, requestId: 'retry' })).status).toBe('queued')
})

test('deleting a lifecycle recovery backup refuses pending work then clears the settled pointer', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), {
    ...args,
    requestId: 'lifecycle',
    purpose: 'archive',
    pendingLifecycleOperation: 'archive-1',
  })
  const identity = { ...args, backupId: job._id }
  await expect(t.mutation(ref('requestDelete'), identity)).rejects.toThrow('backup_in_use')
  const attempt = { ...identity, attemptId: job.attemptId, sourceVmGeneration: 'generation-1' }
  await t.mutation(ref('claim'), attempt)
  await t.mutation(ref('complete'), {
    ...attempt,
    bytes: 200,
    sha256: 'a'.repeat(64),
    completeness: 'complete',
  })
  await t.mutation(ref('settleLifecycle'), {
    ...identity,
    operationId: 'archive-1',
    retainForRecovery: true,
  })
  await t.run(ctx => ctx.db.patch(args.workspaceId, { status: 'archived' }))
  expect(await t.mutation(ref('requestDelete'), identity)).toMatchObject({
    deleted: false,
    emptyDriveOnNextStart: true,
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))!.lifecycleBackupId).toBeUndefined()
  expect(await t.mutation(ref('requestDelete'), identity)).toMatchObject({
    deleted: false,
    emptyDriveOnNextStart: true,
  })
})

test('ordinary VM credential gains admin and rotates a pre-backup key', async () => {
  const { mintVmModelKeyForWorkspace } = await import('../convex/domains/apiKeys/model')
  const { t, args } = await fixture()
  await t.run(async ctx => {
    const first = (await mintVmModelKeyForWorkspace(ctx, {
      workspaceId: args.workspaceId,
      now: 1000,
    }))!
    expect(first.scopes).toContain('ws:backup:admin')
    const key = (await ctx.db
      .query('apiKeys')
      .withIndex('by_prefix', q => q.eq('prefix', first.prefix))
      .first())!
    await ctx.db.patch(key._id, { scopes: first.scopes.filter(scope => !scope.endsWith(':admin')) })
    const rotated = (await mintVmModelKeyForWorkspace(ctx, {
      workspaceId: args.workspaceId,
      now: 1001,
    }))!
    expect(rotated.minted).toBe(true)
    expect(rotated.scopes).toContain('ws:backup:admin')
    expect((await ctx.db.get(key._id))!.revokedAt).toBe(1001)
  })
})

test('a delayed pre-claim VM failure cannot cancel work for its replacement', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'queued-generation' })
  await t.run(ctx => ctx.db.patch(args.workspaceId, { vmTokenNonce: 'generation-2' }))
  expect(
    await t.mutation(ref('fail'), {
      ...args,
      backupId: job._id,
      attemptId: job.attemptId,
      sourceVmGeneration: 'generation-1',
      error: { code: 'interrupted', message: 'Restart' },
    }),
  ).toBe(false)
  expect(
    (
      await t.mutation(ref('claim'), {
        ...args,
        backupId: job._id,
        attemptId: job.attemptId,
        sourceVmGeneration: 'generation-2',
      })
    )?.status,
  ).toBe('running')
})

test('partial downloads cannot become automatic lifecycle recovery artifacts', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), {
    ...args,
    requestId: 'partial-lifecycle',
    purpose: 'archive',
    pendingLifecycleOperation: 'archive-partial',
  })
  const identity = { ...args, backupId: job._id }
  const attempt = { ...identity, attemptId: job.attemptId, sourceVmGeneration: 'generation-1' }
  await t.mutation(ref('claim'), attempt)
  await t.mutation(ref('complete'), {
    ...attempt,
    bytes: 200,
    sha256: 'a'.repeat(64),
    completeness: 'partial',
  })
  await expect(
    t.mutation(ref('settleLifecycle'), {
      ...identity,
      operationId: 'archive-partial',
      retainForRecovery: true,
    }),
  ).rejects.toThrow('backup_incomplete')
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))!.lifecycleBackupId).toBeUndefined()
  expect(
    await t.mutation(ref('settleLifecycle'), {
      ...identity,
      operationId: 'archive-partial',
      retainForRecovery: false,
    }),
  ).toBe(true)
})

test('failed artifact cleanup remains discoverable across request loss and settles once', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'cleanup' })
  const identity = { ...args, backupId: job._id }
  await t.mutation(ref('fail'), {
    ...identity,
    attemptId: job.attemptId,
    sourceVmGeneration: 'generation-1',
    error: { code: 'upload_failed', message: 'Upload stopped' },
  })
  expect(await t.query(ref('get'), identity)).toMatchObject({
    _id: job._id,
    objectPath: job.objectPath,
    objectCleanupPending: true,
  })
  expect(await t.mutation(ref('markObjectRemoved'), identity)).toBe(true)
  expect(await t.query(ref('get'), identity)).toMatchObject({
    status: 'failed',
    objectCleanupPending: false,
  })
  await t.mutation(ref('requestDelete'), identity)
  expect(await t.query(ref('get'), identity)).toMatchObject({
    status: 'deleting',
    objectCleanupPending: true,
  })
})

test('workspace boundary and bounded progress are enforced at the durable owner', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'boundary' })
  const otherWorkspaceId = await t.run(async ctx => {
    const source = (await ctx.db.get(args.workspaceId))!
    return ctx.db.insert('workspaces', {
      billingUserId: source.billingUserId,
      slug: 'other',
      name: 'Other',
      status: 'active',
      createdAt: 1,
    })
  })
  const get = ref('get')
  expect(
    await t.query(get, { ...args, workspaceId: otherWorkspaceId, backupId: job._id }),
  ).toBeNull()
  await expect(t.query(get, { ...args, internalKey: 'wrong', backupId: job._id })).rejects.toThrow()
  expect(
    await t.mutation(ref('requestDelete'), {
      ...args,
      workspaceId: otherWorkspaceId,
      backupId: job._id,
    }),
  ).toMatchObject({ deleted: true })
  const attempt = {
    ...args,
    backupId: job._id,
    attemptId: job.attemptId,
    sourceVmGeneration: 'generation-1',
  }
  await t.mutation(ref('claim'), attempt)
  await expect(
    t.mutation(ref('progress'), {
      ...attempt,
      phase: 'files',
      progress: {
        ...job.progress,
        warningSummary: Array.from({ length: 32 + 1 }, () => ({ code: 'changed', count: 1 })),
      },
    }),
  ).rejects.toThrow()
  expect((await t.query(get, { ...args, backupId: job._id }))?.progress.warningSummary).toEqual([])
})

test('deletion fences new grants and retains cleanup until already-issued authority expires', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'grant-race' })
  const identity = { ...args, backupId: job._id }
  const attempt = { ...identity, attemptId: job.attemptId, sourceVmGeneration: 'generation-1' }
  await t.mutation(ref('claim'), attempt)
  const grant = await t.mutation(ref('authorizeUpload'), attempt)
  expect(grant!.expiresAt).toBeGreaterThan(Date.now())
  await t.mutation(ref('requestDelete'), identity)
  expect(await t.mutation(ref('authorizeUpload'), attempt)).toBeNull()
  expect(await t.mutation(ref('finishDelete'), identity)).toBe(false)
  expect((await t.query(ref('get'), identity))?.status).toBe('deleting')
  await t.run(ctx => ctx.db.patch(job._id, { uploadGrantExpiresAt: 1 }))
  expect(await t.mutation(ref('finishDelete'), identity)).toBe(true)
})

test('creation durably schedules dispatch even when the accepting request disappears', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'durable-dispatch' })
  const pending = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())
  expect(pending).toMatchObject([{ args: [{ backupId: job._id }], state: { kind: 'pending' } }])
})

test('verified completion releases the upload cleanup delay before an ordinary delete', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'ready-delete' })
  const identity = { ...args, backupId: job._id }
  const attempt = { ...identity, attemptId: job.attemptId, sourceVmGeneration: 'generation-1' }
  await t.mutation(ref('claim'), attempt)
  await t.mutation(ref('authorizeUpload'), attempt)
  await t.mutation(ref('complete'), {
    ...attempt,
    bytes: 42,
    sha256: 'a'.repeat(64),
    completeness: 'complete',
  })
  await t.mutation(ref('requestDelete'), identity)
  expect(await t.mutation(ref('finishDelete'), identity)).toBe(true)
})

test.each(['queued', 'running'] as const)(
  '%s capture expires and settles lifecycle while control HTTP remains unavailable',
  async status => {
    const { t, args } = await fixture()
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), {
      preconnect: originalFetch.preconnect,
    })
    const job = await t.mutation(ref('create'), {
      ...args,
      requestId: 'offline-lifecycle',
      purpose: 'reprovision',
      pendingLifecycleOperation: 'operation',
    })
    if (status === 'running')
      await t.mutation(ref('claim'), {
        ...args,
        backupId: job._id,
        attemptId: job.attemptId,
        sourceVmGeneration: 'generation-1',
      })
    await t.run(async ctx => {
      await ctx.db.patch(job._id, {
        lastProgressAt: 1,
        lifecycle: { kind: 'reprovision', status: 'capturing' },
      })
      await ctx.db.patch(args.workspaceId, {
        pendingBackupLifecycle: {
          operationId: 'operation',
          kind: 'reprovision',
          backupId: job._id,
          phase: 'capturing',
          expectedVmTokenNonce: 'generation-1',
        },
      })
    })
    await t.action(makeFunctionReference<'action'>('domains/workspaceBackups/dispatch:tick'), {
      backupId: job._id,
    })
    expect(await t.query(ref('get'), { ...args, backupId: job._id })).toMatchObject({
      status: 'failed',
      error: { code: 'stalled' },
      objectCleanupPending: true,
      lifecycle: { kind: 'reprovision', status: 'failed', reason: 'backup_failed' },
    })
    expect(
      (await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle,
    ).toBeUndefined()
    const retries = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect())
    expect(
      retries.some(
        retry =>
          retry.state.kind === 'pending' &&
          retry.scheduledTime > Date.now() &&
          retry.args[0]?.backupId === job._id,
      ),
    ).toBe(true)
  },
)

test('an authenticated VM can retire a deleted backup attempt without reviving it', async () => {
  const { t, args } = await fixture()
  const job = await t.mutation(ref('create'), { ...args, requestId: 'deleted-worker-journal' })
  await t.run(async ctx => {
    await ctx.db.patch(args.workspaceId, { vmTokenHash: 'current-vm-token' })
    await ctx.db.delete(job._id)
  })
  const lookup = { internalKey: args.internalKey, backupId: job._id }
  expect(
    await t.query(ref('authenticateVm'), { ...lookup, vmTokenHash: 'current-vm-token' }),
  ).toMatchObject({ backup: null, workspace: { _id: args.workspaceId } })
  expect(await t.query(ref('authenticateVm'), { ...lookup, vmTokenHash: 'wrong-token' })).toBeNull()
})
