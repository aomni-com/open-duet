import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import {
  captureCampaignLead,
  mintOrReuseCampaignAttribution,
} from '../convex/domains/campaigns/model'
import schema from '../convex/schema'

const LIVE = { enabled: true, attributionWindowMs: 30_000 }
const DISABLED = { enabled: false, attributionWindowMs: 30_000 }

describe('campaign attribution journeys', () => {
  test('reuses only the same live campaign action without sliding expiry', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const first = await mintOrReuseCampaignAttribution(
        ctx,
        {
          campaignSlug: 'grow',
          action: 'scan',
          signals: { utm_source: ' newsletter ', unknown: 'drop' },
          now: 1_000,
        },
        LIVE,
      )
      const repeated = await mintOrReuseCampaignAttribution(
        ctx,
        {
          campaignSlug: 'grow',
          action: 'scan',
          currentJourneyToken: first.attributionId,
          signals: { utm_source: 'changed' },
          now: 2_000,
        },
        LIVE,
      )
      const otherAction = await mintOrReuseCampaignAttribution(
        ctx,
        {
          campaignSlug: 'grow',
          action: 'lead',
          currentJourneyToken: first.attributionId,
          signals: {},
          now: 2_000,
        },
        LIVE,
      )
      const otherCampaign = await mintOrReuseCampaignAttribution(
        ctx,
        {
          campaignSlug: 'organic',
          action: 'scan',
          currentJourneyToken: first.attributionId,
          signals: {},
          now: 2_000,
        },
        LIVE,
      )
      const expired = await mintOrReuseCampaignAttribution(
        ctx,
        {
          campaignSlug: 'grow',
          action: 'scan',
          currentJourneyToken: first.attributionId,
          signals: {},
          now: 31_000,
        },
        LIVE,
      )

      expect(repeated).toEqual(first)
      expect(repeated.expiresAt).toBe(31_000)
      expect(otherAction.attributionId).not.toBe(first.attributionId)
      expect(otherCampaign.attributionId).not.toBe(first.attributionId)
      expect(expired.attributionId).not.toBe(first.attributionId)
      const rows = await ctx.db.query('campaignAttributions').take(10)
      expect(rows).toHaveLength(4)
      expect(rows[0]?.signals).toEqual({ utm_source: 'newsletter' })
    })
  })

  test('a disabled campaign accepts a live matching journey but mints nothing new', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const first = await mintOrReuseCampaignAttribution(
        ctx,
        { campaignSlug: 'grow', action: 'lead', signals: {}, now: 1_000 },
        LIVE,
      )
      expect(
        await mintOrReuseCampaignAttribution(
          ctx,
          {
            campaignSlug: 'grow',
            action: 'lead',
            currentJourneyToken: first.attributionId,
            signals: {},
            now: 2_000,
          },
          DISABLED,
        ),
      ).toEqual(first)
      await expect(
        mintOrReuseCampaignAttribution(
          ctx,
          {
            campaignSlug: 'grow',
            action: 'lead',
            currentJourneyToken: 'tampered',
            signals: {},
            now: 2_000,
          },
          DISABLED,
        ),
      ).rejects.toThrow('Campaign is disabled')
      await expect(
        mintOrReuseCampaignAttribution(
          ctx,
          {
            campaignSlug: 'grow',
            action: 'lead',
            currentJourneyToken: first.attributionId,
            signals: {},
            now: 31_000,
          },
          DISABLED,
        ),
      ).rejects.toThrow('Campaign is disabled')
      expect(await ctx.db.query('campaignAttributions').take(10)).toHaveLength(1)
    })
  })
})

describe('campaign leads', () => {
  test('each accepted submission writes a distinct contact row and no journey', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const submit = () =>
        captureCampaignLead(
          ctx,
          {
            campaignSlug: 'organic',
            data: { email: 'owner@example.com', source: 'blog' },
            now: 1_000,
          },
          LIVE,
        )

      const first = await submit()
      const second = await submit()
      const rows = await ctx.db.query('campaignLeads').take(10)

      expect(rows.map(row => row._id)).toEqual([first.leadId, second.leadId])
      expect(first.leadId).not.toBe(second.leadId)
      expect(rows[0]).toEqual(
        expect.objectContaining({
          campaignSlug: 'organic',
          data: { email: 'owner@example.com', source: 'blog' },
        }),
      )
      expect(await ctx.db.query('campaignAttributions').take(10)).toEqual([])
    })
  })

  test('a disabled campaign captures nothing', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      await expect(
        captureCampaignLead(
          ctx,
          { campaignSlug: 'organic', data: { email: 'a@b.test' }, now: 1_000 },
          DISABLED,
        ),
      ).rejects.toThrow('Campaign is disabled')
      expect(await ctx.db.query('campaignLeads').take(10)).toEqual([])
    })
  })
})
