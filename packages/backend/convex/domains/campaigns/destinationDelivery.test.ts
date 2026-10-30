import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import type { AnalyticsEvent } from '@repo/contract'

import schema from '../../schema'
import type { CampaignDefinition } from './config'
import { convertOnSignupAndPurchase } from './conversionFunctions'
import { completeConversionRun, routeConversionEvent } from './conversionModel'
import {
  completeDeliveryRun,
  failDeliveryRun,
  runConfiguredDelivery,
  settleDeliveryRun,
} from './destinationDelivery'

describe('delivery scheduling and terminal state', () => {
  test('an eligible result queues every destination independently with one stable ID', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const started: string[] = []

    await t.run(async ctx => {
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'organic',
        action: 'signup',
        signals: { gclid: 'click-1' },
        createdAt: 900,
        expiresAt: 10_000,
      })
      await routeConversionEvent(ctx, signupEvent(attributionId), {
        now: 2_000,
        campaignBySlug: deliveryFixtureCampaign,
        startRun: async () => 'conversion-run',
      })
      await completeConversionRun(
        ctx,
        'conversion-run',
        {
          state: {},
          eligible: true,
          done: true,
          id: 'stable-conversion-id',
          value: 12.34,
          currency: 'USD',
        },
        {
          now: 3_000,
          campaignBySlug: deliveryFixtureCampaign,
          emit: async () => {},
          scheduleWake: async () => {},
          startDelivery: async (_ctx, deliveryId) => {
            const row = await ctx.db.get(deliveryId)
            started.push(row!.destination)
            return `delivery-run-${row!.destination}`
          },
        },
      )

      const rows = await ctx.db.query('conversionDeliveries').collect()
      expect(rows.map(row => row.destination)).toEqual(['meta', 'google', 'reddit', 'openai'])
      expect(rows.map(row => row.conversionId)).toEqual([
        'stable-conversion-id',
        'stable-conversion-id',
        'stable-conversion-id',
        'stable-conversion-id',
      ])
      expect(rows.map(row => row.activeRunId)).toEqual([
        'delivery-run-meta',
        'delivery-run-google',
        'delivery-run-reddit',
        'delivery-run-openai',
      ])
      expect(started).toEqual(['meta', 'google', 'reddit', 'openai'])
      expect((await ctx.db.query('conversionInstances').unique())?.doneAt).toBe(3_000)
    })
  })

  test('one exhausted provider records its own error without changing the completed instance', async () => {
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
      for (const destination of ['meta', 'google'] as const) {
        await ctx.db.insert('conversionDeliveries', {
          instanceId,
          attributionId,
          campaignSlug: 'organic',
          destination,
          conversionId: 'stable-conversion-id',
          occurredAt: 1_500,
          result: { id: 'stable-conversion-id', properties: {} },
          activeRunId: `run-${destination}`,
          createdAt: 2_000,
          updatedAt: 2_000,
        })
      }

      await failDeliveryRun(ctx, 'run-meta', 'provider unavailable', 3_000)
      await completeDeliveryRun(ctx, 'run-google', 'sent', 3_001)

      const rows = await ctx.db.query('conversionDeliveries').collect()
      expect(rows[0]).toMatchObject({
        destination: 'meta',
        lastError: 'provider unavailable',
      })
      expect(rows[1]).toMatchObject({
        destination: 'google',
        sentAt: 3_001,
      })
      expect(rows[0]?.activeRunId).toBeUndefined()
      expect(rows[1]?.activeRunId).toBeUndefined()
      expect(rows[1]?.lastError).toBeUndefined()
      expect((await ctx.db.get(instanceId))?.doneAt).toBe(2_000)
    })
  })

  test('an invalid delivery outcome settles as a recorded failure, not a stranded row', async () => {
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
      const deliveryId = await ctx.db.insert('conversionDeliveries', {
        instanceId,
        attributionId,
        campaignSlug: 'organic',
        destination: 'meta',
        conversionId: 'stable-conversion-id',
        occurredAt: 1_500,
        result: { id: 'stable-conversion-id', properties: {} },
        activeRunId: 'run-settle',
        createdAt: 2_000,
        updatedAt: 2_000,
      })

      await settleDeliveryRun(ctx, 'run-settle', 'not-an-outcome', 3_000)

      const row = await ctx.db.get(deliveryId)
      expect(row?.activeRunId).toBeUndefined()
      expect(row?.sentAt).toBeUndefined()
      expect(row?.skippedAt).toBeUndefined()
      expect(row?.lastError).toContain('Delivery completion failed')
    })
  })

  test('a destination disabled between attempts is re-read and skipped without another request', async () => {
    let enabled = true
    let networkCalls = 0
    const campaignBySlug = (): CampaignDefinition => ({
      ...deliveryFixtureCampaign(),
      destinations: {
        ...deliveryFixtureCampaign().destinations,
        meta: enabled
          ? {
              enabled: true,
              apiVersion: 'v26.0',
              pixelId: 'pixel-123',
              eventName: 'CompleteRegistration',
            }
          : { enabled: false },
      },
    })
    const dependencies = {
      campaignBySlug,
      resolveIdentity: async () => ({ email: 'person@example.com' }),
      env: { META_CONVERSIONS_ACCESS_TOKEN: 'secret' },
      fetch: async () => {
        networkCalls += 1
        return Response.json({})
      },
    }

    expect(await runConfiguredDelivery('meta', deliveryView(), dependencies)).toBe('sent')
    enabled = false
    expect(await runConfiguredDelivery('meta', deliveryView(), dependencies)).toBe('skipped')
    expect(networkCalls).toBe(1)
  })

  test('retries preserve the provider dedupe request byte-for-byte', async () => {
    const requests: string[] = []
    const dependencies = {
      campaignBySlug: (): CampaignDefinition => ({
        ...deliveryFixtureCampaign(),
        destinations: {
          ...deliveryFixtureCampaign().destinations,
          meta: {
            enabled: true as const,
            apiVersion: 'v26.0',
            pixelId: 'pixel-123',
            eventName: 'CompleteRegistration',
          },
        },
      }),
      resolveIdentity: async () => ({ email: 'person@example.com', externalId: 'user-123' }),
      env: { META_CONVERSIONS_ACCESS_TOKEN: 'secret' },
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(String(init?.body))
        return Response.json({})
      },
    }

    await runConfiguredDelivery('meta', deliveryView(), dependencies)
    await runConfiguredDelivery('meta', deliveryView(), dependencies)

    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1])
    expect(JSON.parse(requests[0]!)).toMatchObject({
      data: [{ event_id: 'stable-conversion-id' }],
    })
  })
})

function deliveryFixtureCampaign(): CampaignDefinition {
  return {
    enabled: true,
    attributionWindowMs: 30_000,
    conversion: {
      on: ['user.signed_up'],
      run: convertOnSignupAndPurchase,
      config: {},
    },
    destinations: {
      meta: { enabled: false },
      google: { enabled: false },
      reddit: { enabled: false },
      openai: { enabled: false },
    },
  }
}

function deliveryView() {
  return {
    conversionId: 'stable-conversion-id',
    occurredAt: 1_773_892_800_000,
    attributionCreatedAt: 1_773_806_400_000,
    campaignSlug: 'organic',
    attributionSignals: {
      fbclid: 'meta-click-123',
      sourceUrl: 'https://lander.example/signup',
    },
    sourceUrl: 'https://lander.example/signup',
    userId: 'user-123',
    eventName: 'conversion',
    properties: {},
  }
}

function signupEvent(attributionId: string): AnalyticsEvent<'user.signed_up'> {
  return {
    id: 'signup:user-123',
    name: 'user.signed_up',
    version: 1,
    at: 1_000,
    origin: 'product_backend',
    userId: 'user-123',
    attributionId,
    properties: {},
  }
}
