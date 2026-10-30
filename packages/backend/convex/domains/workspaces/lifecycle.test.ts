import { afterEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import { vmDiskGbForPlan } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import schema from '../../schema'
import { retrier } from '../../utils'
import { ensureWorkspaceVmImpl, workspaceVmName } from './vmAttach'
import { resizeWorkspaceVmDiskImpl } from './vmDisk'
import { reconcileWorkspaceVmDisks } from './vmDiskPolicy'
import { scheduleWorkspaceVm } from './vmSchedule'

const saved = {
  key: process.env.DUET_API_INTERNAL_KEY,
  image: process.env.DUET_VM_IMAGE_REF,
  url: process.env.DUET_API_URL,
  fetch: globalThis.fetch,
}
const fixtures: Array<ReturnType<typeof convexTest>> = []
afterEach(async () => {
  for (const t of fixtures.splice(0)) {
    await t.run(async ctx => {
      for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
        if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
    })
    await t.finishInProgressScheduledFunctions()
  }
  if (saved.key === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = saved.key
  if (saved.url === undefined) delete process.env.DUET_API_URL
  else process.env.DUET_API_URL = saved.url
  if (saved.image === undefined) delete process.env.DUET_VM_IMAGE_REF
  else process.env.DUET_VM_IMAGE_REF = saved.image
  globalThis.fetch = saved.fetch
})
const call = (name: string) =>
  makeFunctionReference<'mutation'>(`domains/workspaces/lifecycle:${name}`)
const job = (name: string) =>
  makeFunctionReference<'mutation'>(`domains/workspaceBackups/jobs:${name}`)
async function fixture() {
  process.env.DUET_API_INTERNAL_KEY = 'lifecycle-key'
  process.env.DUET_VM_IMAGE_REF = 'ttl.sh/configured-current:1h'
  process.env.DUET_API_URL = 'https://callback.example'
  globalThis.fetch = Object.assign(async () => Response.json({ retryAfterMs: null }), {
    preconnect: saved.fetch.preconnect,
  })
  const t = convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/workspaces/vmTeardownSchedule.ts': () => import('./vmTeardownSchedule'),
    '../../domains/workspaces/vmSchedule.ts': () => import('./vmSchedule'),
    '../../domains/workspaces/vmConvergence.ts': () => import('./vmConvergence'),
    '../../domains/workspaces/vmDiskSchedule.ts': () => import('./vmDiskSchedule'),
    '../../domains/workspaces/vmDiskModel.ts': () => import('./vmDiskModel'),
    '../../domains/workspaces/vmDiskPolicy.ts': () => import('./vmDiskPolicy'),
    '../../domains/workspaces/vmSizeModel.ts': () => import('./vmSizeModel'),
    '../../domains/workspaces/provisioning.ts': () => import('./provisioning'),
    '../../domains/workspaces/vmAttachModel.ts': () => import('./vmAttachModel'),
    '../../domains/workspaces/lifecycle.ts': () => import('./lifecycle'),
    '../../domains/workspaces/vmTeardownModel.ts': () => import('./vmTeardownModel'),
    '../../domains/workspaceBackups/restore.ts': () => import('../workspaceBackups/restore'),
    '../../domains/workspaceBackups/jobs.ts': () => import('../workspaceBackups/jobs'),
    '../../domains/workspaceBackups/dispatch.ts': () => import('../workspaceBackups/dispatch'),
  })
  fixtures.push(t)
  const workspaceId = await t.run(async ctx => {
    const user = await ctx.db.insert('users', {
      email: 'lifecycle@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      billing: { subscriptionEverActivatedAt: 1 },
    })
    return ctx.db.insert('workspaces', {
      slug: 'lifecycle',
      name: 'Lifecycle',
      createdByUserId: user,
      billingUserId: user,
      status: 'active',
      servicingStatus: 'active',
      onboardedAt: 1,
      createdAt: 1,
      vmName: 'original-vm',
      httpsUrl: 'https://original-vm.exe.xyz',
      vmTokenNonce: 'original-generation',
      vmTokenHash: 'original-hash',
      vmTeardownRunId: 'existing-teardown',
    })
  })
  return { t, args: { internalKey: 'lifecycle-key', workspaceId } }
}

async function registerRetrier(t: ReturnType<typeof convexTest>) {
  const directory = dirname(
    fileURLToPath(import.meta.resolve('@convex-dev/action-retrier/package.json')),
  )
  const component = `${directory}/src/component`
  const { default: componentSchema } = await import(`${component}/schema.ts`)
  t.registerComponent('actionRetrier', componentSchema, {
    './_generated/api.ts': () => import(`${component}/_generated/api.js`),
    './public.ts': () => import(`${component}/public.ts`),
    './run.ts': () => import(`${component}/run.ts`),
  })
}

test('operator reprovision admits durable capture and keeps the original VM until a complete backup exists', async () => {
  const { t, args } = await fixture()
  const admitted = await t.mutation(call('requestReprovision'), {
    ...args,
    imageRef: 'ttl.sh/replacement:1h',
  })
  expect(admitted).toMatchObject({ status: 'backup_pending', workspaceId: args.workspaceId })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    status: 'active',
    vmName: 'original-vm',
    vmTokenNonce: 'original-generation',
    pendingBackupLifecycle: {
      backupId: admitted.backupId,
      kind: 'reprovision',
      phase: 'capturing',
      imageRef: 'ttl.sh/replacement:1h',
    },
  })
  const backup = await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))
  expect(backup).toMatchObject({
    status: 'queued',
    purpose: 'reprovision',
    pendingLifecycleOperation: expect.any(String),
    lifecycle: { kind: 'reprovision', status: 'capturing' },
  })
  expect(
    await t.mutation(call('requestReprovision'), { ...args, imageRef: 'ttl.sh/replacement:1h' }),
  ).toEqual(admitted)
})

test('subscription resume protects its recovery backup through matching teardown', async () => {
  const { t, args } = await fixture()
  await registerRetrier(t)
  try {
    const backup = await t.mutation(job('create'), {
      ...args,
      requestId: 'archived-source',
      purpose: 'archive',
    })
    const userId = await t.run(async ctx => {
      await ctx.db.patch(backup._id, {
        status: 'ready',
        completeness: 'complete',
        bytes: 123,
        sha256: 'a'.repeat(64),
      })
      const workspace = (await ctx.db.get(args.workspaceId))!
      await ctx.db.patch(workspace._id, {
        status: 'archived',
        servicingStatus: 'paused',
        servicingExemptAt: 1,
        lifecycleBackupId: backup._id,
      })
      return workspace.billingUserId!
    })
    const { reconcileServicingStatus } = await import('../credits/subscriptions')
    await t.run(ctx => reconcileServicingStatus(ctx, userId, Date.now()))
    await expect(
      t.mutation(job('requestDelete'), { ...args, backupId: backup._id }),
    ).rejects.toThrow('backup_in_use')
    expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
      status: 'provisioning',
      lifecycleBackupId: backup._id,
      vmName: 'original-vm',
      vmTokenNonce: 'original-generation',
      pendingBackupLifecycle: { backupId: backup._id, phase: 'restoring' },
    })
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/workspaces/vmTeardownModel:clearWorkspaceVm'),
      {
        workspaceId: args.workspaceId,
        expectedVmName: 'original-vm',
        expectedVmTokenNonce: 'original-generation',
      },
    )
    await t.mutation(
      makeFunctionReference<'mutation'>(
        'domains/workspaces/vmTeardownSchedule:onWorkspaceVmTeardownComplete',
      ),
      {
        runId: 'existing-teardown',
        result: { type: 'success', returnValue: { removed: true } },
      },
    )
    await expect(
      t.mutation(job('requestDelete'), { ...args, backupId: backup._id }),
    ).rejects.toThrow('backup_in_use')
    expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
      status: 'provisioning',
      lifecycleBackupId: backup._id,
      pendingBackupLifecycle: { backupId: backup._id, phase: 'restoring' },
    })
  } finally {
    const workspace = await t.run(ctx => ctx.db.get(args.workspaceId))
    if (workspace?.vmAttachRunId)
      await t.run(ctx =>
        retrier.cancel(ctx, workspace.vmAttachRunId as Parameters<typeof retrier.cancel>[1]),
      )
  }
})

test('a new birth admits one attachment with the configured image', async () => {
  const { t, args } = await fixture()
  await registerRetrier(t)
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, {
      status: 'provisioning',
      vmName: undefined,
      vmTokenNonce: undefined,
      vmTokenHash: undefined,
      httpsUrl: undefined,
      vmTeardownRunId: undefined,
    }),
  )
  try {
    const runId = await t.run(ctx => scheduleWorkspaceVm(ctx, args.workspaceId))
    expect(runId).not.toBeNull()
    const workspace = await t.run(ctx => ctx.db.get(args.workspaceId))
    expect(workspace?.status).toBe('provisioning')
    expect(workspace?.nextVmImageRef).toBe('ttl.sh/configured-current:1h')
    expect(workspace?.vmAttachRunId).toBe(runId)
    expect(await t.run(ctx => scheduleWorkspaceVm(ctx, args.workspaceId))).toBe(runId)
  } finally {
    const workspace = await t.run(ctx => ctx.db.get(args.workspaceId))
    if (workspace?.vmAttachRunId) {
      const runId = workspace.vmAttachRunId as Parameters<typeof retrier.cancel>[1]
      await t.run(ctx => retrier.cancel(ctx, runId))
    }
  }
})

test('a subscription disk upgrade admits one resize while preserving desired and installed capacity', async () => {
  const { t, args } = await fixture()
  await registerRetrier(t)
  const userId = await t.run(async ctx => {
    const workspace = (await ctx.db.get(args.workspaceId))!
    await ctx.db.patch(workspace._id, { vmDiskGb: 28 })
    await ctx.db.patch(workspace.billingUserId!, {
      billing: {
        subscription: {
          plan: 'pro',
          status: 'active',
          stripeSubscriptionId: 'sub_cutover',
          stripePriceId: 'price_cutover',
          currentPeriodStart: 1,
          currentPeriodEnd: 100_000,
          cancelAtPeriodEnd: false,
          latestLifecycleEventCreatedAt: 1,
          latestLifecycleEventId: 'evt_cutover',
        },
      },
    })
    return workspace.billingUserId!
  })
  try {
    await t.run(ctx => reconcileWorkspaceVmDisks(ctx, userId, 10))
    const admitted = await t.run(ctx => ctx.db.get(args.workspaceId))
    expect(admitted?.vmResizeRunId).toBeDefined()
    expect(admitted?.vmDiskGb).toBe(28)
    expect((await t.run(ctx => ctx.db.get(userId)))?.billing?.subscription?.plan).toBe('pro')
    await t.run(ctx => reconcileWorkspaceVmDisks(ctx, userId, 11))
    expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.vmResizeRunId).toBe(
      admitted?.vmResizeRunId,
    )
  } finally {
    const workspace = await t.run(ctx => ctx.db.get(args.workspaceId))
    if (workspace?.vmResizeRunId) {
      await t.run(ctx =>
        retrier.cancel(ctx, workspace.vmResizeRunId as Parameters<typeof retrier.cancel>[1]),
      )
    }
  }
})

test('the normal CPU and memory sweep admits the active attached workspace', async () => {
  const { t, args } = await fixture()
  const query = makeFunctionReference<'query'>(
    'domains/workspaces/vmSizeModel:workspaceVmSizeCandidates',
  )
  const admitted = await t.query(query, { internalKey: args.internalKey, now: 10 })
  expect(admitted).toMatchObject([{ workspaceId: args.workspaceId, vmName: 'original-vm' }])
})

test('an admitted disk resize finishes its restart and records capacity before its run is drained', async () => {
  const { t, args } = await fixture()
  await t.run(async ctx => {
    const workspace = (await ctx.db.get(args.workspaceId))!
    await ctx.db.patch(workspace._id, { vmDiskGb: 28, vmResizeRunId: 'admitted-disk' })
    await ctx.db.patch(workspace.billingUserId!, {
      billing: {
        subscription: {
          plan: 'pro',
          status: 'active',
          stripeSubscriptionId: 'sub_cutover',
          stripePriceId: 'price_cutover',
          currentPeriodStart: 1,
          currentPeriodEnd: 100_000,
          cancelAtPeriodEnd: false,
          latestLifecycleEventCreatedAt: 1,
          latestLifecycleEventId: 'evt_cutover',
        },
      },
    })
  })
  let resizeEntered!: () => void
  let releaseResize!: () => void
  const entered = new Promise<void>(resolve => {
    resizeEntered = resolve
  })
  const release = new Promise<void>(resolve => {
    releaseResize = resolve
  })
  const restarted: string[] = []
  const action = t.action(ctx =>
    resizeWorkspaceVmDiskImpl(ctx, {
      workspaceId: args.workspaceId,
      exe: {
        list: async () => [
          {
            vm_name: 'original-vm',
            ssh_dest: 'original-vm.exe.xyz',
            status: 'running',
            disk_capacity_bytes: 28 * 1024 ** 3,
          },
        ],
        resize: async () => {
          resizeEntered()
          await release
          return {}
        },
        restart: async name => {
          restarted.push(name)
        },
      },
    }),
  )
  try {
    await Promise.race([
      entered,
      action.then(() => {
        throw new Error('Resize did not wait')
      }),
    ])
    releaseResize()
    expect(await action).toEqual({ resized: true, restarted: true, recorded: true })
    expect(restarted).toEqual(['original-vm'])
    expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
      vmDiskGb: vmDiskGbForPlan('pro'),
      vmResizeRunId: 'admitted-disk',
    })
    await t.mutation(
      makeFunctionReference<'mutation'>(
        'domains/workspaces/vmDiskSchedule:onWorkspaceVmResizeComplete',
      ),
      {
        runId: 'admitted-disk',
        result: {
          type: 'success',
          returnValue: { resized: true, restarted: true, recorded: true },
        },
      },
    )
    expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.vmResizeRunId).toBeUndefined()
  } finally {
    releaseResize()
    await action
  }
})

test('an admitted provider create records its VM after the provider response is delayed', async () => {
  const { t, args } = await fixture()
  let releaseCreate!: () => void
  let createEntered!: () => void
  const created = new Promise<void>(resolve => {
    createEntered = resolve
  })
  const release = new Promise<void>(resolve => {
    releaseCreate = resolve
  })
  const removed: string[] = []
  const vmName = workspaceVmName(args.workspaceId)
  const action = t.action(ctx =>
    ensureWorkspaceVmImpl(ctx, {
      workspaceId: args.workspaceId,
      exe: {
        list: async () => [],
        create: async () => {
          createEntered()
          await release
          return { vm_name: vmName, ssh_dest: `${vmName}.exe.xyz`, status: 'running' }
        },
        setSharePublic: async () => {},
        remove: async name => {
          removed.push(name)
        },
      },
      env: { DUET_API_URL: 'https://callback.example', DUET_VM_IMAGE_REF: 'ttl.sh/admitted:1h' },
    }),
  )
  try {
    await Promise.race([
      created,
      action.then(() => {
        throw new Error('Create did not wait')
      }),
    ])
    releaseCreate()
    const result = await action
    expect(result.status).toBe('provisioning')
    expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
      vmName,
      imageRef: 'ttl.sh/admitted:1h',
      sshDest: `${vmName}.exe.xyz`,
    })
    expect(removed).toEqual([])
  } finally {
    releaseCreate()
    await action
  }
})

test('replacement teardown schedules attachment while keeping recovery pinned', async () => {
  const { t, args } = await fixture()
  await registerRetrier(t)
  try {
    const admitted = await t.mutation(call('requestReprovision'), args)
    await t.run(ctx =>
      ctx.db.patch(admitted.backupId as Id<'workspaceBackups'>, {
        status: 'ready',
        completeness: 'complete',
        bytes: 123,
        sha256: 'a'.repeat(64),
      }),
    )
    await t.mutation(call('advance'), { backupId: admitted.backupId })
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/workspaces/vmTeardownModel:clearWorkspaceVm'),
      {
        workspaceId: args.workspaceId,
        expectedVmName: 'original-vm',
        expectedVmTokenNonce: 'original-generation',
      },
    )
    await t.mutation(
      makeFunctionReference<'mutation'>(
        'domains/workspaces/vmTeardownSchedule:onWorkspaceVmTeardownComplete',
      ),
      {
        runId: 'existing-teardown',
        result: { type: 'success', returnValue: { removed: true } },
      },
    )
    const workspace = await t.run(ctx => ctx.db.get(args.workspaceId))
    expect(workspace).toMatchObject({
      status: 'provisioning',
      lifecycleBackupId: admitted.backupId,
      pendingBackupLifecycle: { backupId: admitted.backupId, phase: 'restoring' },
    })
    expect(workspace?.vmName).toBeUndefined()
    expect(workspace?.vmAttachRunId).toBeDefined()
    expect(workspace?.vmTeardownRunId).toBeUndefined()
    expect(workspace?.attachAfterVmTeardown).toBeUndefined()
    expect(
      (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
        ?.pendingLifecycleOperation,
    ).toBe(workspace?.pendingBackupLifecycle?.operationId)
  } finally {
    const workspace = await t.run(ctx => ctx.db.get(args.workspaceId))
    if (workspace?.vmAttachRunId)
      await t.run(ctx =>
        retrier.cancel(ctx, workspace.vmAttachRunId as Parameters<typeof retrier.cancel>[1]),
      )
  }
})

test('complete capture selects recovery and schedules replacement while retaining its restore pin', async () => {
  const { t, args } = await fixture()
  const request = await t.mutation(call('requestReprovision'), {
    ...args,
    imageRef: 'ttl.sh/replacement:1h',
  })
  const backup = await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>))
  const attempt = {
    ...args,
    backupId: request.backupId,
    attemptId: backup!.attemptId,
    sourceVmGeneration: 'original-generation',
  }
  await t.mutation(job('claim'), attempt)
  await t.mutation(job('complete'), {
    ...attempt,
    bytes: 120,
    sha256: 'a'.repeat(64),
    completeness: 'complete',
  })
  await t.mutation(call('advance'), { backupId: request.backupId })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    status: 'provisioning',
    lifecycleBackupId: request.backupId,
    nextVmImageRef: 'ttl.sh/replacement:1h',
    attachAfterVmTeardown: true,
    pendingBackupLifecycle: { phase: 'restoring', backupId: request.backupId },
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.vmTokenNonce).toBeUndefined()
  expect(await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>))).toMatchObject({
    status: 'ready',
    pendingLifecycleOperation: expect.any(String),
    lifecycle: { kind: 'reprovision', status: 'restoring' },
  })
})

test('partial and failed operator backups preserve the VM, expose the refusal and release deletion pins', async () => {
  for (const outcome of ['partial', 'failed'] as const) {
    const { t, args } = await fixture()
    const request = await t.mutation(call('requestReprovision'), args)
    const backup = await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>))
    const attempt = {
      ...args,
      backupId: request.backupId,
      attemptId: backup!.attemptId,
      sourceVmGeneration: 'original-generation',
    }
    await t.mutation(job('claim'), attempt)
    if (outcome === 'partial')
      await t.mutation(job('complete'), {
        ...attempt,
        bytes: 120,
        sha256: 'a'.repeat(64),
        completeness: 'partial',
      })
    else
      await t.mutation(job('fail'), {
        ...attempt,
        error: { code: 'capture_failed', message: 'Capture failed' },
      })
    await t.mutation(call('advance'), { backupId: request.backupId })
    expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
      status: 'active',
      vmName: 'original-vm',
      vmTokenNonce: 'original-generation',
    })
    expect(
      (await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle,
    ).toBeUndefined()
    const finished = await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>))
    expect(finished).toMatchObject({
      status: outcome === 'partial' ? 'ready' : 'failed',
      lifecycle: {
        kind: 'reprovision',
        status: 'failed',
        reason: outcome === 'partial' ? 'backup_partial' : 'backup_failed',
      },
    })
    expect(finished?.pendingLifecycleOperation).toBeUndefined()
    await expect(
      t.mutation(job('requestDelete'), { ...args, backupId: request.backupId }),
    ).resolves.toMatchObject({ deleted: false })
  }
})

test('operator archive remains available to paused workspaces and retains only a complete backup for recovery', async () => {
  const { t, args } = await fixture()
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'paused', servicingStatusChangedAt: 1 }),
  )
  const request = await t.mutation(call('requestArchive'), args)
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.status).toBe('active')
  const backup = await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>))
  const attempt = {
    ...args,
    backupId: request.backupId,
    attemptId: backup!.attemptId,
    sourceVmGeneration: 'original-generation',
  }
  await t.mutation(job('claim'), attempt)
  await t.mutation(job('complete'), {
    ...attempt,
    bytes: 120,
    sha256: 'a'.repeat(64),
    completeness: 'complete',
  })
  await t.mutation(call('advance'), { backupId: request.backupId })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    status: 'archived',
    servicingStatus: 'paused',
    lifecycleBackupId: request.backupId,
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  expect(await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>))).toMatchObject({
    status: 'ready',
    purpose: 'archive',
    lifecycle: { kind: 'archive', status: 'complete' },
  })
  expect(
    (await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeUndefined()
})

test('subscriber servicing capture is durable and a stuck capture cannot extend the unpaid grace', async () => {
  const { t, args } = await fixture()
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'paused', servicingStatusChangedAt: 1 }),
  )
  const now = 30 * 24 * 60 * 60 * 1000
  const admitted = await t.mutation(call('requestServicing'), { ...args, now })
  expect(admitted).toMatchObject({ status: 'backup_pending' })
  await t.mutation(call('advance'), { backupId: admitted.backupId, now })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({ status: 'archived' })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  expect(await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))).toMatchObject(
    { status: 'failed', lifecycle: { kind: 'servicing', status: 'abandoned' } },
  )
})

test('restore reference prefers only a complete owned backup and fails closed for a broken recovery pointer', async () => {
  const { t, args } = await fixture()
  const { resolveRegistrationRestore } = await import('./seed')
  const request = await t.mutation(call('requestArchive'), args)
  await t.run(async ctx => {
    await ctx.db.patch(args.workspaceId, { lifecycleBackupId: request.backupId })
    await ctx.db.patch(request.backupId as Id<'workspaceBackups'>, {
      status: 'ready',
      completeness: 'complete',
      bytes: 123,
      sha256: 'a'.repeat(64),
    })
    const workspace = (await ctx.db.get(args.workspaceId))!
    expect(await resolveRegistrationRestore(ctx, workspace)).toMatchObject({
      kind: 'workspace-backup',
      backupId: request.backupId,
      bytes: 123,
      sha256: 'a'.repeat(64),
    })
    await ctx.db.patch(request.backupId as Id<'workspaceBackups'>, { completeness: 'partial' })
    await expect(resolveRegistrationRestore(ctx, workspace)).rejects.toThrow(
      'Recovery backup unavailable',
    )
  })
})

test('restore pin survives VM preparation and releases only on acknowledgement or terminal failure', async () => {
  const { t, args } = await fixture()
  const { finishRecovery } = await import('./lifecycleState')
  const { requestWorkspaceVmAttach } = await import('./vmConvergence')
  const request = await t.mutation(call('requestArchive'), args)
  await t.run(async ctx => {
    await ctx.db.patch(request.backupId as Id<'workspaceBackups'>, {
      status: 'ready',
      completeness: 'complete',
      bytes: 123,
      sha256: 'a'.repeat(64),
      pendingLifecycleOperation: undefined,
    })
    await ctx.db.patch(args.workspaceId, {
      lifecycleBackupId: request.backupId,
      pendingBackupLifecycle: undefined,
    })
    await requestWorkspaceVmAttach(ctx, args.workspaceId)
    expect(
      (await ctx.db.get(request.backupId as Id<'workspaceBackups'>))?.pendingLifecycleOperation,
    ).toBeString()
    await finishRecovery(
      ctx,
      (await ctx.db.get(args.workspaceId))!,
      'failed',
      'provisioning_failed',
    )
    expect(
      (await ctx.db.get(request.backupId as Id<'workspaceBackups'>))?.pendingLifecycleOperation,
    ).toBeUndefined()
    expect((await ctx.db.get(args.workspaceId))?.lifecycleBackupId).toBe(request.backupId)
  })
})

test('workspace backup deletion fans out bounded pages independently of object cleanup', async () => {
  const { t, args } = await fixture()
  const { deleteWorkspaceBackupPage } = await import('../workspaceBackups/deletion')
  await t.run(async ctx => {
    for (let i = 0; i < 103; i++)
      await ctx.db.insert('workspaceBackups', {
        workspaceId: args.workspaceId,
        requestId: `delete-${i}`,
        purpose: 'export',
        status: 'ready',
        attemptId: 'attempt',
        objectPath: `delete-${i}`,
        objectCleanupPending: false,
        pendingLifecycleOperation: 'stale-pin',
        createdAt: i,
        updatedAt: i,
        lastProgressAt: i,
        progress: {
          processedFiles: 0,
          processedRecords: 0,
          capturedBytes: 0,
          uploadedBytes: 0,
          warningCount: 0,
          warningSummary: [],
        },
      })
    await ctx.db.patch(args.workspaceId, { status: 'deleted' })
  })
  const page = await t.run(ctx =>
    deleteWorkspaceBackupPage(ctx, { workspaceId: args.workspaceId, cursor: null }),
  )
  expect(page!.isDone).toBe(false)
  await t.run(ctx =>
    deleteWorkspaceBackupPage(ctx, { workspaceId: args.workspaceId, cursor: page!.continueCursor }),
  )
  await t.run(async ctx => {
    const jobs = await ctx.db.query('workspaceBackups').collect()
    expect(
      jobs.every(job => job.status === 'deleting' && job.pendingLifecycleOperation === undefined),
    ).toBe(true)
  })
})

test('explicit state discard bypasses capture while cancelling an earlier lifecycle pin', async () => {
  const { t, args } = await fixture()
  const captured = await t.mutation(call('requestReprovision'), args)
  expect(
    await t.mutation(call('requestReprovision'), { ...args, discardState: true }),
  ).toMatchObject({ status: 'provisioning' })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    status: 'provisioning',
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.lifecycleBackupId).toBeUndefined()
  expect(
    (await t.run(ctx => ctx.db.get(captured.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeUndefined()
})

test('an existing export cannot postpone an overdue unpaid teardown', async () => {
  const { t, args } = await fixture()
  const exporting = await t.mutation(job('create'), { ...args, requestId: 'ordinary-export' })
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'paused', servicingStatusChangedAt: 1 }),
  )
  expect(
    await t.mutation(call('requestServicing'), { ...args, now: 30 * 24 * 60 * 60 * 1000 }),
  ).toMatchObject({ status: 'archived' })
  expect((await t.run(ctx => ctx.db.get(exporting._id as Id<'workspaceBackups'>)))?.status).toBe(
    'failed',
  )
})

test('an expired provisioning token settles the restore pin after VM creation succeeds', async () => {
  const { t, args } = await fixture()
  const { markUnhealthyWorkspacesImpl } = await import('./provisioningCore')
  const request = await t.mutation(call('requestReprovision'), args)
  await t.run(async ctx => {
    const workspace = (await ctx.db.get(args.workspaceId))!
    await ctx.db.patch(request.backupId as Id<'workspaceBackups'>, {
      status: 'ready',
      completeness: 'complete',
      bytes: 123,
      sha256: 'a'.repeat(64),
    })
    await ctx.db.patch(args.workspaceId, {
      status: 'provisioning',
      lifecycleBackupId: request.backupId,
      provisioningTokenExpiresAt: 10,
      pendingBackupLifecycle: { ...workspace.pendingBackupLifecycle!, phase: 'restoring' },
    })
    await markUnhealthyWorkspacesImpl(ctx, { internalKey: args.internalKey, now: 20 })
    expect(
      (await ctx.db.get(request.backupId as Id<'workspaceBackups'>))?.pendingLifecycleOperation,
    ).toBeUndefined()
    expect((await ctx.db.get(args.workspaceId))?.pendingBackupLifecycle).toBeUndefined()
  })
})

test('a pending reprovision is not accepted as an archive request', async () => {
  const { t, args } = await fixture()
  const admitted = await t.mutation(call('requestReprovision'), args)
  await expect(t.mutation(call('requestArchive'), args)).rejects.toThrow('backup_in_progress')
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toMatchObject({
    kind: 'reprovision',
    backupId: admitted.backupId,
  })
})

test('ordinary VM health expiry cannot release a backup while restore IO may still be running', async () => {
  const { t, args } = await fixture()
  const { markUnhealthyWorkspacesImpl } = await import('./provisioningCore')
  const { VM_SYNC_STALE_MS } = await import('@repo/contract')
  const admitted = await t.mutation(call('requestReprovision'), args)
  await t.run(async ctx => {
    const workspace = (await ctx.db.get(args.workspaceId))!
    await ctx.db.patch(admitted.backupId as Id<'workspaceBackups'>, {
      status: 'ready',
      completeness: 'complete',
      bytes: 123,
      sha256: 'a'.repeat(64),
    })
    await ctx.db.patch(args.workspaceId, {
      lifecycleBackupId: admitted.backupId,
      lastHeartbeatAt: 1,
      pendingBackupLifecycle: { ...workspace.pendingBackupLifecycle!, phase: 'restoring' },
    })
    await markUnhealthyWorkspacesImpl(ctx, {
      internalKey: args.internalKey,
      now: VM_SYNC_STALE_MS + 2,
    })
    expect(
      (await ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))?.pendingLifecycleOperation,
    ).toBeString()
    expect((await ctx.db.get(args.workspaceId))?.pendingBackupLifecycle?.phase).toBe('restoring')
  })
})

const restoreCall = makeFunctionReference<'mutation'>('domains/workspaceBackups/restore:report')
async function restoringFixture() {
  const { t, args } = await fixture()
  const admitted = await t.mutation(call('requestReprovision'), args)
  await t.run(async ctx => {
    const workspace = (await ctx.db.get(args.workspaceId))!
    await ctx.db.patch(admitted.backupId as Id<'workspaceBackups'>, {
      status: 'ready',
      completeness: 'complete',
      bytes: 123,
      sha256: 'a'.repeat(64),
    })
    await ctx.db.patch(args.workspaceId, {
      lifecycleBackupId: admitted.backupId,
      lastHeartbeatAt: 1,
      pendingBackupLifecycle: { ...workspace.pendingBackupLifecycle!, phase: 'restoring' },
    })
  })
  const report = (command: Record<string, unknown>) =>
    t.mutation(restoreCall, {
      ...args,
      vmTokenHash: 'original-hash',
      command: { backupId: admitted.backupId, attemptId: 'restore-attempt', ...command },
    })
  return { t, args, admitted, report }
}

test('restore claims and repeated counters do not renew the progress deadline; real IO does', async () => {
  const { t, admitted, report } = await restoringFixture()
  expect(await report({ kind: 'claim' })).toMatchObject({
    status: 'running',
    processedBytes: 0,
    processedEntries: 0,
  })
  await t.run(async ctx => {
    const backup = (await ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))!
    await ctx.db.patch(backup._id, { restoration: { ...backup.restoration!, lastProgressAt: 1 } })
  })
  await report({ kind: 'claim' })
  await report({ kind: 'progress', phase: 'extract', processedBytes: 0, processedEntries: 0 })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))?.restoration
      ?.lastProgressAt,
  ).toBe(1)
  await report({ kind: 'progress', phase: 'download', processedBytes: 12, processedEntries: 0 })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))?.restoration
      ?.lastProgressAt,
  ).toBeGreaterThan(1)
  await expect(
    report({ kind: 'progress', phase: 'download', processedBytes: 11, processedEntries: 0 }),
  ).rejects.toThrow('restore_progress_regressed')
})

test('restore acknowledgement fences old attempts and generations and keeps installed backup pinned until sync', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  const { finishRecovery } = await import('./lifecycleState')
  await report({ kind: 'claim' })
  await t.run(async ctx => {
    await finishRecovery(ctx, (await ctx.db.get(args.workspaceId))!, 'complete')
    await finishRecovery(
      ctx,
      (await ctx.db.get(args.workspaceId))!,
      'failed',
      'provisioning_failed',
    )
  })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeString()
  await expect(report({ kind: 'installed', attemptId: 'stale' })).rejects.toThrow(
    'restore_attempt_mismatch',
  )
  await report({ kind: 'installed' })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeString()
  await t.run(async ctx => finishRecovery(ctx, (await ctx.db.get(args.workspaceId))!, 'complete'))
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeUndefined()
})

test('failed restore can claim a fresh attempt atomically while stale claims cannot revive it', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await report({ kind: 'failed' })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeUndefined()
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.status).toBe('unhealthy')
  expect(await report({ kind: 'claim' })).toMatchObject({ status: 'failed' })
  await report({ kind: 'claim', attemptId: 'retry' })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeString()
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, {
      vmTokenNonce: 'replacement-generation',
      vmTokenHash: 'replacement-hash',
    }),
  )
  await expect(report({ kind: 'failed', attemptId: 'retry' })).rejects.toThrow('unauthorized')
})

test('stalled restore retains its pin through teardown failure and releases only on matching VM clearance', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  const { watchRestore } = await import('../workspaceBackups/restore')
  await report({ kind: 'claim' })
  await t.run(async ctx => {
    const backup = (await ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))!
    await ctx.db.patch(backup._id, { restoration: { ...backup.restoration!, lastProgressAt: 1 } })
    await watchRestore(ctx, {
      backupId: backup._id,
      attemptId: 'restore-attempt',
      vmGeneration: 'original-generation',
    })
    expect((await ctx.db.get(backup._id))?.pendingLifecycleOperation).toBeString()
    expect((await ctx.db.get(backup._id))?.restoration?.status).toBe('stopping')
    expect((await ctx.db.get(args.workspaceId))?.vmTokenHash).toBeUndefined()
    // A retry with the same provider teardown still pending must not settle.
    await watchRestore(ctx, {
      backupId: backup._id,
      attemptId: 'restore-attempt',
      vmGeneration: 'original-generation',
    })
    expect((await ctx.db.get(backup._id))?.pendingLifecycleOperation).toBeString()
  })
  const clear = makeFunctionReference<'mutation'>(
    'domains/workspaces/vmTeardownModel:clearWorkspaceVm',
  )
  expect(
    await t.mutation(clear, {
      workspaceId: args.workspaceId,
      expectedVmName: 'wrong-vm',
      expectedVmTokenNonce: 'original-generation',
    }),
  ).toEqual({ cleared: false })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeString()
  expect(
    await t.mutation(clear, {
      workspaceId: args.workspaceId,
      expectedVmName: 'original-vm',
      expectedVmTokenNonce: 'original-generation',
    }),
  ).toEqual({ cleared: true })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeUndefined()
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.lifecycleBackupId).toBe(
    admitted.backupId,
  )
})

test('late restore watchdog and teardown callbacks cannot release a replacement generation pin', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  const { watchRestore } = await import('../workspaceBackups/restore')
  await report({ kind: 'claim' })
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, {
      vmName: 'replacement-vm',
      vmTokenNonce: 'replacement-generation',
      vmTokenHash: 'replacement-hash',
    }),
  )
  await t.mutation(restoreCall, {
    ...args,
    vmTokenHash: 'replacement-hash',
    command: { backupId: admitted.backupId, attemptId: 'new-attempt', kind: 'claim' },
  })
  await t.run(ctx =>
    watchRestore(ctx, {
      backupId: admitted.backupId as Id<'workspaceBackups'>,
      attemptId: 'restore-attempt',
      vmGeneration: 'original-generation',
    }),
  )
  const clear = makeFunctionReference<'mutation'>(
    'domains/workspaces/vmTeardownModel:clearWorkspaceVm',
  )
  expect(
    await t.mutation(clear, {
      workspaceId: args.workspaceId,
      expectedVmName: 'original-vm',
      expectedVmTokenNonce: 'original-generation',
    }),
  ).toEqual({ cleared: false })
  expect(
    (await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>)))
      ?.pendingLifecycleOperation,
  ).toBeString()
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.vmTokenHash).toBe('replacement-hash')
})

test('healthy restore IO remains provisionally unavailable to public gateway access after ordinary heartbeat expiry', async () => {
  const { t, args, report } = await restoringFixture()
  const { gatewayConnectionBySlugImpl } = await import('./vmToken')
  const { markUnhealthyWorkspacesImpl } = await import('./provisioningCore')
  const { VM_SYNC_STALE_MS } = await import('@repo/contract')
  await report({ kind: 'claim' })
  await report({ kind: 'progress', phase: 'extract', processedBytes: 1, processedEntries: 1 })
  await t.run(async ctx => {
    await markUnhealthyWorkspacesImpl(ctx, {
      internalKey: args.internalKey,
      now: VM_SYNC_STALE_MS + 2,
    })
    expect((await ctx.db.get(args.workspaceId))?.status).toBe('active')
    expect(
      await gatewayConnectionBySlugImpl(ctx, { internalKey: args.internalKey, slug: 'lifecycle' }),
    ).toEqual({ refusal: 'provisioning' })
  })
})

test('reprovision retries the retained backup after failed restore and fences the old VM', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await report({ kind: 'failed' })
  const next = await t.mutation(call('requestReprovision'), args)
  expect(next).toMatchObject({ status: 'provisioning', scheduled: true })
  await expect(report({ kind: 'claim', attemptId: 'retry' })).rejects.toThrow('unauthorized')
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toMatchObject({
    backupId: admitted.backupId,
    phase: 'restoring',
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.lifecycleBackupId).toBe(
    admitted.backupId,
  )
  expect(
    (await t.run(ctx => ctx.db.query('workspaceBackups').collect())).map(backup => backup._id),
  ).toEqual([admitted.backupId])
  await expect(
    t.mutation(job('requestDelete'), { ...args, backupId: admitted.backupId }),
  ).rejects.toThrow('backup_in_use')
})

test('replacement failure before restore claim reuses the retained source backup', async () => {
  const { t, args, admitted } = await restoringFixture()
  await t.run(async ctx => {
    await ctx.db.patch(admitted.backupId as Id<'workspaceBackups'>, {
      sourceVmGeneration: 'source-generation',
    })
    await ctx.db.patch(args.workspaceId, { status: 'provisioning', vmAttachRunId: 'failed-attach' })
  })
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/workspaces/vmSchedule:onWorkspaceVmAttachComplete'),
    { runId: 'failed-attach', result: { type: 'failed', error: 'VM attach failed' } },
  )
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  expect(await t.mutation(call('requestReprovision'), args)).toMatchObject({
    status: 'provisioning',
    scheduled: true,
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toMatchObject({
    backupId: admitted.backupId,
    phase: 'restoring',
  })
  expect(
    (await t.run(ctx => ctx.db.query('workspaceBackups').collect())).map(backup => backup._id),
  ).toEqual([admitted.backupId])
})

test('an unhealthy VM that installed recovery captures its current Drive before replacement', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await report({ kind: 'installed' })
  const { finishRecovery } = await import('./lifecycleState')
  await t.run(async ctx => {
    await finishRecovery(ctx, (await ctx.db.get(args.workspaceId))!, 'complete')
    await ctx.db.patch(args.workspaceId, { status: 'unhealthy' })
    await ctx.db.patch(admitted.backupId as Id<'workspaceBackups'>, {
      sourceVmGeneration: 'older-source',
    })
  })
  const next = await t.mutation(call('requestReprovision'), args)
  expect(next.status).toBe('backup_pending')
  expect(next.backupId).not.toBe(admitted.backupId)
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toMatchObject({
    backupId: next.backupId,
    phase: 'capturing',
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.lifecycleBackupId).toBe(
    admitted.backupId,
  )
})

test('reprovision cannot replace an in-progress restore or release its backup pin', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await t.run(ctx => ctx.db.patch(args.workspaceId, { status: 'unhealthy' }))
  expect(await t.mutation(call('requestReprovision'), args)).toMatchObject({
    status: 'backup_pending',
    backupId: admitted.backupId,
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toMatchObject({
    backupId: admitted.backupId,
    phase: 'restoring',
  })
  await expect(
    t.mutation(job('requestDelete'), { ...args, backupId: admitted.backupId }),
  ).rejects.toThrow('backup_in_use')
  await expect(
    report({ kind: 'progress', phase: 'download', processedBytes: 1, processedEntries: 0 }),
  ).resolves.toEqual({ ok: true })
})

test('overdue servicing tears down a restoring VM without releasing its artifact early', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'paused', servicingStatusChangedAt: 1 }),
  )
  expect(
    await t.mutation(call('requestServicing'), { ...args, now: 30 * 24 * 60 * 60 * 1000 }),
  ).toMatchObject({ status: 'archived' })
  const backup = await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))
  expect(backup?.pendingLifecycleOperation).toBeString()
  expect(backup?.restoration?.status).toBe('stopping')
  const { watchRestore } = await import('../workspaceBackups/restore')
  await t.run(ctx =>
    watchRestore(ctx, {
      backupId: admitted.backupId as Id<'workspaceBackups'>,
      attemptId: 'restore-attempt',
      vmGeneration: 'original-generation',
    }),
  )
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.status).toBe('archived')
})

test('an old installed restore cannot pin a replacement whose provisioning fails before claim', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await report({ kind: 'installed' })
  const { finishRecovery, pinRecoveryBackup } = await import('./lifecycleState')
  await t.run(async ctx => {
    await finishRecovery(ctx, (await ctx.db.get(args.workspaceId))!, 'complete')
    await ctx.db.patch(args.workspaceId, { vmTokenNonce: 'new-generation', status: 'provisioning' })
    await pinRecoveryBackup(ctx, (await ctx.db.get(args.workspaceId))!)
    await finishRecovery(
      ctx,
      (await ctx.db.get(args.workspaceId))!,
      'failed',
      'provisioning_failed',
    )
    expect(
      (await ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))?.pendingLifecycleOperation,
    ).toBeUndefined()
  })
})

test('an operator archive cannot overwrite a ban issued while capture runs', async () => {
  const { t, args } = await fixture()
  const request = await t.mutation(call('requestArchive'), args)
  const backup = (await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>)))!
  const attempt = {
    ...args,
    backupId: backup._id,
    attemptId: backup.attemptId,
    sourceVmGeneration: 'original-generation',
  }
  await t.mutation(job('claim'), attempt)
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'banned', servicingStatusChangedAt: 2 }),
  )
  await t.mutation(job('complete'), {
    ...attempt,
    bytes: 120,
    sha256: 'a'.repeat(64),
    completeness: 'complete',
  })
  await t.mutation(call('advance'), { backupId: backup._id })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    status: 'active',
    servicingStatus: 'banned',
    vmName: 'original-vm',
    vmTokenNonce: 'original-generation',
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  expect(await t.run(ctx => ctx.db.get(backup._id))).toMatchObject({
    status: 'ready',
    lifecycle: { kind: 'archive', status: 'deferred', reason: 'workspace_changed' },
  })
  expect((await t.run(ctx => ctx.db.get(backup._id)))?.pendingLifecycleOperation).toBeUndefined()
})

test('an operator reprovision defers when billing pauses the workspace during capture', async () => {
  const { t, args } = await fixture()
  const request = await t.mutation(call('requestReprovision'), args)
  const backup = (await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>)))!
  const attempt = {
    ...args,
    backupId: backup._id,
    attemptId: backup.attemptId,
    sourceVmGeneration: 'original-generation',
  }
  await t.mutation(job('claim'), attempt)
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'paused', servicingStatusChangedAt: 2 }),
  )
  await t.mutation(job('complete'), {
    ...attempt,
    bytes: 120,
    sha256: 'a'.repeat(64),
    completeness: 'complete',
  })
  await t.mutation(call('advance'), { backupId: backup._id })
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    status: 'active',
    servicingStatus: 'paused',
    vmName: 'original-vm',
    vmTokenNonce: 'original-generation',
  })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  expect(await t.run(ctx => ctx.db.get(backup._id))).toMatchObject({
    status: 'ready',
    lifecycle: { kind: 'reprovision', status: 'deferred', reason: 'workspace_changed' },
  })
  expect((await t.run(ctx => ctx.db.get(backup._id)))?.pendingLifecycleOperation).toBeUndefined()
  // Resuming service admits a new operation; the completed export stays available.
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { servicingStatus: 'active', servicingStatusChangedAt: 3 }),
  )
  const retry = await t.mutation(call('requestReprovision'), args)
  expect(retry.backupId).not.toBe(backup._id)
  expect((await t.run(ctx => ctx.db.get(backup._id)))?.status).toBe('ready')
})

test('implicit reprovision selects the configured image while retaining the realized image', async () => {
  const { t, args } = await fixture()
  await t.run(ctx => ctx.db.patch(args.workspaceId, { imageRef: 'ttl.sh/old-reader:1h' }))
  await t.mutation(call('requestReprovision'), args)
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    imageRef: 'ttl.sh/old-reader:1h',
    pendingBackupLifecycle: { imageRef: 'ttl.sh/configured-current:1h' },
  })
})

test('reactivation pins the current image across a later configuration change', async () => {
  const { t, args } = await fixture()
  const { requestWorkspaceVmAttach } = await import('./vmConvergence')
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, { status: 'archived', imageRef: 'ttl.sh/old-reader:1h' }),
  )
  await t.run(ctx => requestWorkspaceVmAttach(ctx, args.workspaceId))
  process.env.DUET_VM_IMAGE_REF = 'ttl.sh/later-config:1h'
  await t.run(ctx => requestWorkspaceVmAttach(ctx, args.workspaceId))
  expect(await t.run(ctx => ctx.db.get(args.workspaceId))).toMatchObject({
    imageRef: 'ttl.sh/old-reader:1h',
    nextVmImageRef: 'ttl.sh/configured-current:1h',
    attachAfterVmTeardown: true,
  })
})

test('teardown abandonment releases the recovery and image pins after VM clearance', async () => {
  const { t, args, admitted } = await restoringFixture()
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, {
      status: 'provisioning',
      servicingStatus: 'paused',
      attachAfterVmTeardown: true,
      nextVmImageRef: 'ttl.sh/abandoned:1h',
    }),
  )
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/workspaces/vmTeardownModel:clearWorkspaceVm'),
    {
      workspaceId: args.workspaceId,
      expectedVmName: 'original-vm',
      expectedVmTokenNonce: 'original-generation',
    },
  )
  await t.mutation(
    makeFunctionReference<'mutation'>(
      'domains/workspaces/vmTeardownSchedule:onWorkspaceVmTeardownComplete',
    ),
    {
      runId: 'existing-teardown',
      result: { type: 'success', returnValue: { removed: true } },
    },
  )
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.nextVmImageRef).toBeUndefined()
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  expect(await t.run(ctx => ctx.db.get(admitted.backupId as Id<'workspaceBackups'>))).toMatchObject(
    {
      lifecycle: { kind: 'reprovision', status: 'failed', reason: 'provisioning_paused' },
    },
  )
  await expect(
    t.mutation(job('requestDelete'), { ...args, backupId: admitted.backupId }),
  ).resolves.toMatchObject({ deleted: false })
})

test('a paused attach without a VM releases recovery so the backup can be deleted', async () => {
  const { t, args, admitted } = await restoringFixture()
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/workspaces/vmTeardownModel:clearWorkspaceVm'),
    {
      workspaceId: args.workspaceId,
      expectedVmName: 'original-vm',
      expectedVmTokenNonce: 'original-generation',
    },
  )
  await t.run(ctx =>
    ctx.db.patch(args.workspaceId, {
      status: 'provisioning',
      servicingStatus: 'paused',
      vmTeardownRunId: undefined,
      vmAttachRunId: 'paused-attach',
      nextVmImageRef: 'ttl.sh/abandoned:1h',
    }),
  )
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/workspaces/vmSchedule:onWorkspaceVmAttachComplete'),
    {
      runId: 'paused-attach',
      result: {
        type: 'success',
        returnValue: {
          workspaceId: args.workspaceId,
          status: 'paused',
          restoredFromArchive: false,
        },
      },
    },
  )
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle).toBeUndefined()
  await expect(
    t.mutation(job('requestDelete'), { ...args, backupId: admitted.backupId }),
  ).resolves.toMatchObject({ deleted: false })
})

test.each(['teardown', 'attach'] as const)(
  'a paused %s callback cannot release recovery while VM state remains',
  async path => {
    const { t, args, admitted } = await restoringFixture()
    await t.run(ctx =>
      ctx.db.patch(args.workspaceId, {
        status: 'provisioning',
        servicingStatus: 'paused',
        attachAfterVmTeardown: true,
        vmAttachRunId: 'paused-attach',
      }),
    )
    await t.mutation(
      makeFunctionReference<'mutation'>(
        path === 'teardown'
          ? 'domains/workspaces/vmTeardownSchedule:onWorkspaceVmTeardownComplete'
          : 'domains/workspaces/vmSchedule:onWorkspaceVmAttachComplete',
      ),
      {
        runId: path === 'teardown' ? 'existing-teardown' : 'paused-attach',
        result: {
          type: 'success',
          returnValue: path === 'teardown' ? { removed: false } : { status: 'paused' },
        },
      },
    )
    expect(
      (await t.run(ctx => ctx.db.get(args.workspaceId)))?.pendingBackupLifecycle?.backupId,
    ).toBe(admitted.backupId)
    await expect(
      t.mutation(job('requestDelete'), { ...args, backupId: admitted.backupId }),
    ).rejects.toThrow('backup_in_use')
  },
)

test('deleting a failed recovery explicitly retires the current VM restore claim after the backup row is gone', async () => {
  const { t, args, admitted, report } = await restoringFixture()
  await report({ kind: 'claim' })
  await report({ kind: 'failed' })
  await t.mutation(job('requestDelete'), { ...args, backupId: admitted.backupId })
  expect((await t.run(ctx => ctx.db.get(args.workspaceId)))?.lifecycleBackupId).toBeUndefined()
  expect(await t.mutation(job('finishDelete'), { ...args, backupId: admitted.backupId })).toBe(true)
  expect(await report({ kind: 'claim', attemptId: 'retry-after-deletion' })).toEqual({
    status: 'abandoned',
    processedBytes: 0,
    processedEntries: 0,
  })
  await expect(
    t.mutation(restoreCall, {
      ...args,
      vmTokenHash: 'stale-vm',
      command: { kind: 'claim', backupId: admitted.backupId, attemptId: 'retry-after-deletion' },
    }),
  ).rejects.toThrow('unauthorized')
})

test('backup control can resolve an unhealthy VM without opening ordinary gateway traffic', async () => {
  const { t, args } = await fixture()
  const { gatewayConnectionForBackupImpl, gatewayConnectionBySlugImpl } = await import('./vmToken')
  await t.run(ctx => ctx.db.patch(args.workspaceId, { status: 'unhealthy' }))
  const request = await t.mutation(call('requestReprovision'), args)
  const backup = (await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>)))!
  await t.run(async ctx => {
    const control = {
      internalKey: args.internalKey,
      backupId: backup._id,
      attemptId: backup.attemptId,
    }
    expect(await gatewayConnectionForBackupImpl(ctx, control)).toMatchObject({
      workspaceId: args.workspaceId,
      vmName: 'original-vm',
      httpsUrl: 'https://original-vm.exe.xyz',
      vmToken: expect.stringContaining('duet_vm_'),
    })
    expect(
      await gatewayConnectionBySlugImpl(ctx, {
        internalKey: args.internalKey,
        slug: 'lifecycle',
        allowPaused: true,
      }),
    ).toEqual({ refusal: 'unhealthy' })
    expect(
      await gatewayConnectionForBackupImpl(ctx, { ...control, attemptId: 'retired-attempt' }),
    ).toBeNull()
    await ctx.db.patch(args.workspaceId, { vmTokenHash: undefined })
    expect(await gatewayConnectionForBackupImpl(ctx, control)).toBeNull()
  })
})

test('backup control preserves ban, suspension and active restore barriers', async () => {
  const { t, args } = await fixture()
  const { gatewayConnectionForBackupImpl } = await import('./vmToken')
  const request = await t.mutation(call('requestReprovision'), args)
  const backup = (await t.run(ctx => ctx.db.get(request.backupId as Id<'workspaceBackups'>)))!
  await t.run(async ctx => {
    const control = {
      internalKey: args.internalKey,
      backupId: backup._id,
      attemptId: backup.attemptId,
    }
    await ctx.db.patch(args.workspaceId, { servicingStatus: 'banned' })
    expect(await gatewayConnectionForBackupImpl(ctx, control)).toBeNull()
    await ctx.db.patch(args.workspaceId, { servicingStatus: 'active', suspendedAt: 1 })
    expect(await gatewayConnectionForBackupImpl(ctx, control)).toBeNull()
    const workspace = (await ctx.db.get(args.workspaceId))!
    await ctx.db.patch(args.workspaceId, {
      suspendedAt: undefined,
      pendingBackupLifecycle: { ...workspace.pendingBackupLifecycle!, phase: 'restoring' },
    })
    expect(await gatewayConnectionForBackupImpl(ctx, control)).toBeNull()
  })
})
