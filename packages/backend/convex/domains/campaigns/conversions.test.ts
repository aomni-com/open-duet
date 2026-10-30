import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'

import { MAX_ANALYTICS_JSON_BYTES } from '@repo/contract'
import type {
  AnalyticsEvent,
  ConversionTriggerEventName,
  JsonObject,
  JsonValue,
} from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import schema from '../../schema'
import type { CampaignDefinition } from './config'
import { createConversionCheckpoint } from './conversionCheckpoint'
import { convertOnSignupAndPurchase } from './conversionFunctions'
import {
  completeConversionRun,
  fireConversionWake,
  failConversionRun,
  parseConversionResult,
  pumpConversionInstance,
  purgeConversionInputs,
  routeConversionEvent,
  settleConversionRun,
  type RouteConversionOptions,
} from './conversionModel'
import { runConfiguredConversion } from './conversionRuntime'
import type { ConversionFunctionContext } from './conversionTypes'

test('an attributed signup converts but leaves the journey open for a purchase', async () => {
  const result = await runSignupAndPurchase({
    id: 'signup:user-1',
    name: 'user.signed_up',
    version: 1,
    at: 1_000,
    origin: 'product_backend',
    userId: 'user-1',
    attributionId: 'attribution-1',
    properties: {},
  })

  expect(result).toEqual({
    state: {},
    eligible: true,
    done: false,
    id: 'signup:attribution-1',
  })
})

test('a first paid subscription converts with what was charged and ends the journey', async () => {
  const result = await runSignupAndPurchase({
    id: 'subscription-purchase:in_1',
    name: 'subscription.started',
    version: 1,
    at: 2_000,
    origin: 'product_backend',
    userId: 'user-1',
    properties: {
      plan: 'pro',
      priceId: 'price_pro',
      invoiceId: 'in_1',
      subscriptionId: 'sub_1',
      billingReason: 'subscription_create',
      monthlyPriceMicroUsd: 50_000_000,
    },
  })

  expect(result).toEqual({
    state: {},
    eligible: true,
    done: true,
    id: 'purchase:attribution-1',
    value: 50,
    currency: 'USD',
  })
})

test('a purchase with an unreadable amount still converts, without inventing a value', async () => {
  const result = await runSignupAndPurchase({
    id: 'subscription-purchase:in_2',
    name: 'subscription.started',
    version: 1,
    at: 2_000,
    origin: 'product_backend',
    userId: 'user-1',
    properties: { plan: 'pro' },
  })

  expect(result).toEqual({
    state: {},
    eligible: true,
    done: true,
    id: 'purchase:attribution-1',
  })
})

test('an unrelated trigger neither converts nor closes the journey, and keeps state', async () => {
  const result = await runSignupAndPurchase({
    id: 'renewal:in_9',
    name: 'subscription.renewed',
    version: 1,
    at: 3_000,
    origin: 'product_backend',
    userId: 'user-1',
    properties: { monthlyPriceMicroUsd: 50_000_000 },
  })

  expect(result).toEqual({ state: { ignored: true }, eligible: false, done: false })
})

async function runSignupAndPurchase(event: AnalyticsEvent<ConversionTriggerEventName>) {
  return await convertOnSignupAndPurchase({
    attribution: {
      attributionId: 'attribution-1',
      campaignSlug: 'organic',
      action: 'signup',
      signals: {},
      createdAt: 900,
      expiresAt: 10_000,
    },
    trigger: { kind: 'event', event },
    state: { ignored: true },
    config: {},
    now: event.at,
    checkpoint: async (_name, compute) =>
      await compute({
        query: async () => {
          throw new Error('the signup and purchase rule must not query')
        },
      }),
  })
}

test('a completed checkpoint is reused by a retried invocation', async () => {
  const stored = new Map<string, JsonValue>()
  let computes = 0
  const makeCheckpoint = () =>
    createConversionCheckpoint({
      load: async name => stored.get(name),
      save: async (name, value) => {
        stored.set(name, value)
        return value
      },
      runtime: {
        query: async () => {
          throw new Error('fixture query is unused')
        },
      },
    })

  const first = await makeCheckpoint()('classification', async () => {
    computes += 1
    return { score: 72 }
  })
  const retry = await makeCheckpoint()('classification', async () => {
    computes += 1
    return { score: 0 }
  })

  expect(first).toEqual({ score: 72 })
  expect(retry).toEqual({ score: 72 })
  expect(computes).toBe(1)
})

test('each invocation reads the current function config without a state migration', async () => {
  const checkpoint: ConversionFunctionContext['checkpoint'] = async (_name, compute) =>
    await compute({
      query: async () => {
        throw new Error('live config fixture does not query')
      },
    })
  const context = {
    attribution: {
      attributionId: 'attribution-1',
      campaignSlug: 'organic',
      action: 'signup',
      signals: {},
      createdAt: 900,
      expiresAt: 10_000,
    },
    trigger: {
      kind: 'wake' as const,
      at: 1_000,
    },
    state: {},
    now: 1_000,
    checkpoint,
  }

  let threshold = 40
  const lookup = () => ({
    enabled: true,
    attributionWindowMs: 30_000,
    conversion: {
      on: ['user.signed_up'] as const,
      run: async (conversionContext: ConversionFunctionContext<JsonObject>) => ({
        state: { observedThreshold: conversionContext.config.threshold ?? null },
        eligible: false,
        done: false,
      }),
      config: { threshold },
    },
  })
  const first = await runConfiguredConversion('fixture', context, lookup)
  threshold = 70
  const second = await runConfiguredConversion(
    'fixture',
    { ...context, state: first.result.state },
    lookup,
  )

  expect(first.result.state).toEqual({ observedThreshold: 40 })
  expect(second.result.state).toEqual({ observedThreshold: 70 })
})

test('conversion state stays bounded and monetary value is finite nonnegative major units', () => {
  expect(() =>
    parseConversionResult({
      state: {},
      eligible: true,
      done: true,
      value: -0.01,
      currency: 'USD',
    }),
  ).toThrow()
  expect(() =>
    parseConversionResult({
      state: {},
      eligible: true,
      done: true,
      value: Number.POSITIVE_INFINITY,
      currency: 'USD',
    }),
  ).toThrow()
  expect(() =>
    parseConversionResult({
      state: 'x'.repeat(MAX_ANALYTICS_JSON_BYTES),
      eligible: false,
      done: false,
    }),
  ).toThrow()
  expect(
    parseConversionResult({
      state: {},
      eligible: true,
      done: true,
      value: 12.5,
      currency: 'USD',
    }).value,
  ).toBe(12.5)
})

describe('serialized conversion executor', () => {
  test('a matching explicit attribution creates one instance and starts its first input', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      await routeConversionEvent(
        ctx,
        {
          id: 'signup:user-1',
          name: 'user.signed_up',
          version: 1,
          at: 1_000,
          origin: 'product_backend',
          userId: 'user-1',
          attributionId,
          properties: {},
        },
        {
          now: 1_000,
          campaignBySlug: () => ({
            enabled: true,
            attributionWindowMs: 30_000,
            conversion: {
              on: ['user.signed_up'],
              run: convertOnSignupAndPurchase,
              config: {},
            },
          }),
          startRun: async () => 'run-1',
        },
      )

      const instances = await ctx.db.query('conversionInstances').collect()
      const inputs = await ctx.db.query('conversionInputs').collect()
      expect(instances).toHaveLength(1)
      expect(instances[0]).toMatchObject({
        attributionId,
        campaignSlug: 'organic',
        state: {},
        activeRunId: 'run-1',
        activeInputId: inputs[0]!._id,
      })
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        instanceId: instances[0]!._id,
        inputKey: 'event:signup:user-1',
        trigger: { kind: 'event', event: { id: 'signup:user-1' } },
      })
    })
  })

  test('the four eligible and done outcomes persist state, deliver, and terminate independently', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const evaluations: AnalyticsEvent<'conversion.evaluated'>[] = []

    await t.run(async ctx => {
      const userId = await insertConversionUser(ctx, 'outcomes@example.com')
      const cases = [
        { label: 'continue', eligible: false, done: false },
        { label: 'deliver-and-continue', eligible: true, done: false },
        { label: 'terminate', eligible: false, done: true },
        { label: 'deliver-and-terminate', eligible: true, done: true },
      ] as const

      for (const [index, outcome] of cases.entries()) {
        const attributionId = await ctx.db.insert('campaignAttributions', {
          campaignSlug: 'organic',
          action: 'signup',
          acquiredByUserId: userId,
          signals: {},
          createdAt: 900,
          expiresAt: 10_000,
        })
        await routeConversionEvent(
          ctx,
          {
            id: `event-${outcome.label}`,
            name: 'user.signed_up',
            version: 1,
            at: 1_000 + index,
            origin: 'product_backend',
            userId,
            attributionId,
            properties: {},
          },
          {
            now: 2_000 + index,
            campaignBySlug: conversionFixtureCampaign,
            startRun: async () => `run-${outcome.label}`,
          },
        )
        await completeConversionRun(
          ctx,
          `run-${outcome.label}`,
          {
            state: { outcome: outcome.label },
            eligible: outcome.eligible,
            done: outcome.done,
            properties: { outcome: outcome.label },
          },
          {
            now: 3_000 + index,
            campaignBySlug: conversionFixtureCampaign,
            emit: async (_ctx, event) => {
              evaluations.push(event)
            },
            scheduleWake: async () => {},
          },
        )
      }

      const instances = await ctx.db.query('conversionInstances').collect()
      const deliveries = await ctx.db.query('conversionDeliveries').collect()
      expect(
        instances.map(instance => ({
          state: instance.state,
          done: instance.doneAt !== undefined,
          active: instance.activeRunId,
        })),
      ).toEqual([
        { state: { outcome: 'continue' }, done: false, active: undefined },
        { state: { outcome: 'deliver-and-continue' }, done: false, active: undefined },
        { state: { outcome: 'terminate' }, done: true, active: undefined },
        { state: { outcome: 'deliver-and-terminate' }, done: true, active: undefined },
      ])
      expect(deliveries.map(delivery => delivery.result.properties.outcome)).toEqual([
        'deliver-and-continue',
        'deliver-and-terminate',
      ])
      expect(await ctx.db.query('conversionInputs').collect()).toEqual([])
      expect(evaluations.map(event => event.properties)).toEqual([
        expect.objectContaining({ eligible: true, done: false }),
        expect.objectContaining({ eligible: false, done: true }),
        expect.objectContaining({ eligible: true, done: true }),
      ])
    })
  })

  test('done journeys purge their queued inputs', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const instanceId = await ctx.db.insert('conversionInstances', {
        attributionId,
        campaignSlug: 'organic',
        state: {},
        doneAt: 2_000,
        createdAt: 1_000,
        updatedAt: 2_000,
      })
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert('conversionInputs', {
          instanceId,
          inputKey: `queued:${index}`,
          trigger: { kind: 'wake', at: index },
          enqueuedAt: index,
        })
      }

      await purgeConversionInputs(ctx, instanceId)
      expect(await ctx.db.query('conversionInputs').collect()).toEqual([])
    })
  })

  test('two queued inputs keep one active run and advance in enqueue order', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const started: string[] = []

    await t.run(async ctx => {
      const userId = await insertConversionUser(ctx, 'queued@example.com')
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const startRun: RouteConversionOptions['startRun'] = async (_ctx, instanceId, inputId) => {
        const input = await ctx.db.get(inputId)
        started.push(input!.inputKey)
        return `run-${started.length}`
      }
      for (const id of ['first', 'second']) {
        await routeConversionEvent(
          ctx,
          {
            id,
            name: 'user.signed_up',
            version: 1,
            at: 1_000,
            origin: 'product_backend',
            userId,
            attributionId,
            properties: {},
          },
          {
            now: id === 'first' ? 2_000 : 2_001,
            campaignBySlug: conversionFixtureCampaign,
            startRun,
          },
        )
      }

      const instance = (await ctx.db.query('conversionInstances').unique())!
      expect(started).toEqual(['event:first'])
      expect(await ctx.db.query('conversionInputs').collect()).toHaveLength(2)
      await completeConversionRun(
        ctx,
        'run-1',
        { state: { first: true }, eligible: false, done: false },
        {
          now: 3_000,
          campaignBySlug: conversionFixtureCampaign,
          emit: async () => {},
          scheduleWake: async () => {},
        },
      )
      await pumpConversionInstance(ctx, instance._id, { now: 3_001, startRun })

      expect(started).toEqual(['event:first', 'event:second'])
      expect(await ctx.db.get(instance._id)).toMatchObject({
        activeRunId: 'run-2',
        state: { first: true },
      })
    })
  })

  test('a completion-processing failure records the error and advances the journey', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const started: string[] = []

    await t.run(async ctx => {
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const instanceId = await ctx.db.insert('conversionInstances', {
        attributionId,
        campaignSlug: 'organic',
        state: {},
        activeRunId: 'run-settle',
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      const activeInputId = await ctx.db.insert('conversionInputs', {
        instanceId,
        inputKey: 'event:first',
        trigger: { kind: 'wake', at: 2_000 },
        enqueuedAt: 2_000,
      })
      await ctx.db.patch(instanceId, { activeInputId })
      const queuedInputId = await ctx.db.insert('conversionInputs', {
        instanceId,
        inputKey: 'event:second',
        trigger: { kind: 'wake', at: 2_500 },
        enqueuedAt: 2_500,
      })
      // Deleting the attribution makes completion processing itself throw.
      await ctx.db.delete(attributionId)

      const settled = await settleConversionRun(
        ctx,
        'run-settle',
        {
          functionName: 'convertOnSignupAndPurchase',
          result: { state: {}, eligible: true, done: false },
        },
        {
          now: 3_000,
          campaignBySlug: conversionFixtureCampaign,
          emit: async () => {},
          scheduleWake: async () => {},
        },
      )

      expect(settled).toBe(instanceId)
      const instance = await ctx.db.get(instanceId)
      expect(instance?.activeRunId).toBeUndefined()
      expect(instance?.activeInputId).toBeUndefined()
      expect(instance?.doneAt).toBeUndefined()
      expect(instance?.lastError).toContain('Conversion attribution not found')
      expect(await ctx.db.get(activeInputId)).toBeNull()

      await pumpConversionInstance(ctx, instanceId, {
        now: 3_001,
        startRun: async (_ctx, _instanceId, inputId) => {
          started.push((await ctx.db.get(inputId))!.inputKey)
          return 'run-next'
        },
      })
      expect(started).toEqual(['event:second'])
      expect(await ctx.db.get(queuedInputId)).not.toBeNull()
    })
  })

  test('a failure after the instance has advanced never rewinds or stalls the journey', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await insertConversionUser(ctx, 'late-throw@example.com')
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const instanceId = await ctx.db.insert('conversionInstances', {
        attributionId,
        campaignSlug: 'organic',
        state: {},
        activeRunId: 'run-late-throw',
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      const activeInputId = await ctx.db.insert('conversionInputs', {
        instanceId,
        inputKey: 'event:first',
        trigger: { kind: 'wake', at: 2_000 },
        enqueuedAt: 2_000,
      })
      await ctx.db.patch(instanceId, { activeInputId })

      // The emitter throws only after completion has already persisted the
      // advanced instance, so the caught writes stay committed: the accepted
      // degradation is a lost analytics event, never a rewound journey.
      const settled = await settleConversionRun(
        ctx,
        'run-late-throw',
        {
          functionName: 'convertOnSignupAndPurchase',
          result: { state: { advanced: true }, eligible: true, done: true },
        },
        {
          now: 3_000,
          campaignBySlug: conversionFixtureCampaign,
          emit: async () => {
            throw new Error('sink unavailable')
          },
          scheduleWake: async () => {},
        },
      )

      // failConversionRun no-ops because the instance already released the
      // run, so settle reports null rather than inventing a second outcome.
      expect(settled).toBeNull()
      const instance = await ctx.db.get(instanceId)
      expect(instance?.activeRunId).toBeUndefined()
      expect(instance?.state).toEqual({ advanced: true })
      expect(instance?.doneAt).toBe(3_000)
      expect(instance?.lastError).toBeUndefined()
      expect(await ctx.db.get(activeInputId)).toBeNull()
      expect(await ctx.db.query('conversionDeliveries').unique()).toMatchObject({
        attributionId,
        destination: 'meta',
        userId,
      })
    })
  })

  test('a malformed run output settles as a recorded failure, not a stranded instance', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const instanceId = await ctx.db.insert('conversionInstances', {
        attributionId,
        campaignSlug: 'organic',
        state: {},
        activeRunId: 'run-malformed',
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      const activeInputId = await ctx.db.insert('conversionInputs', {
        instanceId,
        inputKey: 'event:first',
        trigger: { kind: 'wake', at: 2_000 },
        enqueuedAt: 2_000,
      })
      await ctx.db.patch(instanceId, { activeInputId })

      const settled = await settleConversionRun(ctx, 'run-malformed', 'not-a-run-output', {
        now: 3_000,
        campaignBySlug: conversionFixtureCampaign,
        emit: async () => {},
        scheduleWake: async () => {},
      })

      expect(settled).toBe(instanceId)
      const instance = await ctx.db.get(instanceId)
      expect(instance?.activeRunId).toBeUndefined()
      expect(instance?.lastError).toContain('Conversion completion failed')
      expect(await ctx.db.get(activeInputId)).toBeNull()
    })
  })

  test('an exhausted input is deleted and the next queued input can continue', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const started: string[] = []

    await t.run(async ctx => {
      const userId = await insertConversionUser(ctx, 'queued@example.com')
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const startRun: RouteConversionOptions['startRun'] = async (_ctx, instanceId, inputId) => {
        started.push((await ctx.db.get(inputId))!.inputKey)
        return `run-${started.length}`
      }
      for (const id of ['fails', 'survives']) {
        await routeConversionEvent(
          ctx,
          {
            id,
            name: 'user.signed_up',
            version: 1,
            at: 1_000,
            origin: 'product_backend',
            userId,
            attributionId,
            properties: {},
          },
          {
            now: id === 'fails' ? 2_000 : 2_001,
            campaignBySlug: conversionFixtureCampaign,
            startRun,
          },
        )
      }

      const instance = (await ctx.db.query('conversionInstances').unique())!
      await failConversionRun(ctx, 'run-1', 'fixture terminal failure', 3_000)
      expect((await ctx.db.get(instance._id))?.lastError).toBe('fixture terminal failure')
      expect(
        (await ctx.db.query('conversionInputs').collect()).map(input => input.inputKey),
      ).toEqual(['event:survives'])

      await pumpConversionInstance(ctx, instance._id, { now: 3_001, startRun })
      expect(started).toEqual(['event:fails', 'event:survives'])
    })
  })

  test('wake callbacks accept only the current live timestamp and ignore stale duplicates', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const started: string[] = []

    await t.run(async ctx => {
      const makeInstance = async (expiresAt: number, doneAt?: number) => {
        const attributionId = await ctx.db.insert('campaignAttributions', {
          campaignSlug: 'organic',
          action: 'signup',
          signals: {},
          createdAt: 900,
          expiresAt,
        })
        return await ctx.db.insert('conversionInstances', {
          attributionId,
          campaignSlug: 'organic',
          state: {},
          wakeAt: 5_000,
          ...(doneAt === undefined ? {} : { doneAt }),
          createdAt: 1_000,
          updatedAt: 1_000,
        })
      }
      const live = await makeInstance(10_000)
      const done = await makeInstance(10_000, 2_000)
      const expired = await makeInstance(2_500)
      const startRun: RouteConversionOptions['startRun'] = async (_ctx, instanceId, inputId) => {
        started.push((await ctx.db.get(inputId))!.inputKey)
        return `run-${started.length}`
      }

      await fireConversionWake(ctx, live, 4_000, { now: 3_000, startRun })
      await fireConversionWake(ctx, live, 5_000, { now: 3_000, startRun })
      await fireConversionWake(ctx, live, 5_000, { now: 3_000, startRun })
      await fireConversionWake(ctx, done, 5_000, { now: 3_000, startRun })
      await fireConversionWake(ctx, expired, 5_000, { now: 3_000, startRun })

      expect(started).toEqual(['wake:5000'])
      expect(
        (await ctx.db.query('conversionInputs').collect()).map(input => input.trigger),
      ).toEqual([{ kind: 'wake', at: 5_000 }])
      expect((await ctx.db.get(live))?.wakeAt).toBeUndefined()
      expect((await ctx.db.get(done))?.wakeAt).toBe(5_000)
      // An expired journey consumes the fired wake: nothing can revive the
      // instance, so a retained wakeAt would falsely advertise pending work.
      expect((await ctx.db.get(expired))?.wakeAt).toBeUndefined()
    })
  })

  test('an eligible wake carries the attribution owner into delivery and evaluation', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const evaluations: AnalyticsEvent<'conversion.evaluated'>[] = []

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'wake-owner@example.com',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const instanceId = await ctx.db.insert('conversionInstances', {
        attributionId,
        campaignSlug: 'organic',
        state: {},
        activeRunId: 'run-wake-owner',
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      const inputId = await ctx.db.insert('conversionInputs', {
        instanceId,
        inputKey: 'wake:2000',
        trigger: { kind: 'wake', at: 2_000 },
        enqueuedAt: 2_000,
      })
      await ctx.db.patch(instanceId, { activeInputId: inputId })

      await completeConversionRun(
        ctx,
        'run-wake-owner',
        { state: {}, eligible: true, done: true },
        {
          now: 3_000,
          campaignBySlug: conversionFixtureCampaign,
          emit: async (_ctx, event) => {
            evaluations.push(event)
          },
          scheduleWake: async () => {},
        },
      )

      expect((await ctx.db.query('conversionDeliveries').unique())?.userId).toBe(userId)
      expect(evaluations[0]?.userId).toBe(userId)
    })
  })

  test('routing targets explicit attribution first, then immutable acquisition, and never broadcasts', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'route@example.com',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const acquisitionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      const explicitId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'main',
        action: 'signup',
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      await ctx.db.patch(userId, { acquisitionAttributionId: acquisitionId })
      const startRun: RouteConversionOptions['startRun'] = async (_ctx, instanceId) =>
        `run:${instanceId}`

      await routeConversionEvent(ctx, signupEvent('acquisition-event', { userId }), {
        now: 2_000,
        campaignBySlug: conversionFixtureCampaign,
        startRun,
      })
      await routeConversionEvent(
        ctx,
        signupEvent('explicit-event', { userId, attributionId: explicitId }),
        { now: 2_001, campaignBySlug: conversionFixtureCampaign, startRun },
      )
      await routeConversionEvent(
        ctx,
        signupEvent('unattributed-event', { userId: 'user-without-acquisition' }),
        {
          now: 2_002,
          campaignBySlug: conversionFixtureCampaign,
          startRun,
        },
      )
      await routeConversionEvent(
        ctx,
        signupEvent('explicit-event', { userId, attributionId: explicitId }),
        { now: 2_003, campaignBySlug: conversionFixtureCampaign, startRun },
      )

      const instances = await ctx.db.query('conversionInstances').collect()
      expect(instances.map(instance => instance.attributionId)).toEqual([acquisitionId, explicitId])
      expect(
        (await ctx.db.query('conversionInputs').collect()).map(input => input.inputKey),
      ).toEqual(['event:acquisition-event', 'event:explicit-event'])
    })
  })

  test('a disabled campaign continues its live journey and queues a disabled destination to skip', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const campaign: CampaignDefinition = {
      ...conversionFixtureCampaign(),
      enabled: false,
      destinations: {
        meta: { enabled: false },
      },
    }

    await t.run(async ctx => {
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        signals: {},
        createdAt: 900,
        expiresAt: 10_000,
      })
      await routeConversionEvent(
        ctx,
        signupEvent('disabled-campaign', { userId: 'user-1', attributionId }),
        {
          now: 2_000,
          campaignBySlug: () => campaign,
          startRun: async () => 'run-disabled',
        },
      )
      await completeConversionRun(
        ctx,
        'run-disabled',
        { state: {}, eligible: true, done: true },
        {
          now: 3_000,
          campaignBySlug: () => campaign,
          emit: async () => {},
          scheduleWake: async () => {},
        },
      )

      expect((await ctx.db.query('conversionInstances').unique())?.doneAt).toBe(3_000)
      expect(await ctx.db.query('conversionDeliveries').unique()).toMatchObject({
        destination: 'meta',
      })
    })
  })

  test('the same function conversion ID remains independent across journey instances', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const attributionIds = []
      for (const index of [1, 2]) {
        const attributionId = await ctx.db.insert('campaignAttributions', {
          campaignSlug: 'organic',
          action: 'signup',
          signals: {},
          createdAt: 900,
          expiresAt: 10_000,
        })
        attributionIds.push(attributionId)
        await routeConversionEvent(
          ctx,
          signupEvent(`shared-id-${index}`, { userId: 'user-1', attributionId }),
          {
            now: 2_000 + index,
            campaignBySlug: conversionFixtureCampaign,
            startRun: async () => `run-shared-${index}`,
          },
        )
        await completeConversionRun(
          ctx,
          `run-shared-${index}`,
          { state: {}, eligible: true, done: true, id: 'shared-function-id' },
          {
            now: 3_000 + index,
            campaignBySlug: conversionFixtureCampaign,
            emit: async () => {},
            scheduleWake: async () => {},
          },
        )
      }

      expect(
        (await ctx.db.query('conversionDeliveries').collect()).map(delivery => ({
          attributionId: delivery.attributionId,
          conversionId: delivery.conversionId,
        })),
      ).toEqual([
        { attributionId: attributionIds[0]!, conversionId: 'shared-function-id' },
        { attributionId: attributionIds[1]!, conversionId: 'shared-function-id' },
      ])
    })
  })
})

function conversionFixtureCampaign() {
  return {
    enabled: true,
    attributionWindowMs: 30_000,
    conversion: {
      on: ['user.signed_up'] as const,
      run: convertOnSignupAndPurchase,
      config: {},
    },
    destinations: {
      meta: {
        enabled: true,
        apiVersion: 'v26.0',
        pixelId: 'fixture-pixel',
        eventName: 'CompleteRegistration',
      },
    },
  }
}

function signupEvent(
  id: string,
  identity: Pick<AnalyticsEvent, 'userId' | 'attributionId'>,
): AnalyticsEvent<'user.signed_up'> {
  return {
    id,
    name: 'user.signed_up',
    version: 1,
    at: 1_000,
    origin: 'product_backend',
    ...identity,
    properties: {},
  }
}

async function insertConversionUser(
  ctx: GenericMutationCtx<DataModel>,
  email: string,
): Promise<Id<'users'>> {
  return await ctx.db.insert('users', {
    email,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
    createdAt: 900,
    updatedAt: 900,
  })
}
