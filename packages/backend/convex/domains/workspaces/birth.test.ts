import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'

import schema from '../../schema'

const INTERNAL_KEY = 'birth-onboarding-test'
const complete = makeFunctionReference<'mutation'>(
  'domains/workspaces/birth:completeWorkspaceOnboarding',
)

beforeEach(() => {
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
  process.env.DUET_VM_IMAGE_REF = 'ttl.sh/birth-test:1h'
})
afterEach(() => {
  delete process.env.DUET_API_INTERNAL_KEY
  delete process.env.DUET_VM_IMAGE_REF
})

async function harness() {
  const t = convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/workspaces/birth.ts': () => import('./birth'),
    '../../domains/workspaces/vmSchedule.ts': () => import('./vmSchedule'),
  })
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
  return t
}

async function fixture(t: Awaited<ReturnType<typeof harness>>, ready: boolean) {
  return await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'birth-onboarding@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 5_000_000,
      monthlyCreditBalanceMicroUsd: 0,
      ...(ready ? { billing: { paymentMethodReadyAt: 2 } } : {}),
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'birth-onboarding',
      name: 'Birth onboarding',
      status: 'active',
      billingUserId: userId,
      createdByUserId: userId,
      createdAt: 1,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    return { userId, workspaceId }
  })
}

test('completion refuses before payment readiness and leaves onboarding incomplete', async () => {
  const t = await harness()
  const ids = await fixture(t, false)

  let failure: unknown
  try {
    await t.mutation(complete, {
      internalKey: INTERNAL_KEY,
      actorId: ids.userId,
      workspaceId: ids.workspaceId,
      duetName: 'Duet',
      now: 3,
    })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(ConvexError)
  expect((failure as ConvexError<{ error?: string }>).data?.error).toBe('payment_method_required')
  expect(await t.run(ctx => ctx.db.get(ids.workspaceId))).not.toHaveProperty('onboardedAt')
})

test('completion stamps readiness once the billing user has a saved method', async () => {
  const t = await harness()
  const ids = await fixture(t, true)

  const result = await t.mutation(complete, {
    internalKey: INTERNAL_KEY,
    actorId: ids.userId,
    workspaceId: ids.workspaceId,
    duetName: 'Duet',
    now: 3,
  })

  expect(result).toMatchObject({ duetName: 'Duet', onboardedAt: 3 })
  expect(await t.run(ctx => ctx.db.get(ids.workspaceId))).toMatchObject({ onboardedAt: 3 })
})

test('completion schedules the VM after onboarding admission', async () => {
  const t = await harness()
  const ids = await fixture(t, true)

  await t.mutation(complete, {
    internalKey: INTERNAL_KEY,
    actorId: ids.userId,
    workspaceId: ids.workspaceId,
    duetName: 'Duet',
    now: 3,
  })

  expect(await t.run(ctx => ctx.db.get(ids.workspaceId))).toMatchObject({
    onboardedAt: 3,
    vmAttachRunId: expect.any(String),
  })
})
