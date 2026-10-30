import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../../schema'
import {
  authorizedBrowserSessionPayload,
  grantableScopesForWorkspaceRole,
  vmModelScopes,
} from './model'
describe('workspace role capability matrix', () => {
  test('viewers can read files while editors and owners can also mutate them', () => {
    const viewer = grantableScopesForWorkspaceRole('acme', 'viewer')
    const editor = grantableScopesForWorkspaceRole('acme', 'editor')
    const owner = grantableScopesForWorkspaceRole('acme', 'owner')

    expect(viewer).toContain('ws:acme:files:read')
    expect(viewer).not.toContain('ws:acme:files:write')
    expect(editor).toContain('ws:acme:files:read')
    expect(editor).toContain('ws:acme:files:write')
    expect(owner).toContain('ws:acme:files:read')
    expect(owner).toContain('ws:acme:files:write')
  })

  test('only owners can grant invite management', () => {
    expect(grantableScopesForWorkspaceRole('acme', 'viewer')).not.toContain('ws:acme:members')
    expect(grantableScopesForWorkspaceRole('acme', 'editor')).not.toContain('ws:acme:members')
    expect(grantableScopesForWorkspaceRole('acme', 'owner')).toContain('ws:acme:members')
  })

  test('VM keys include workspace administration and runtime capabilities', () => {
    expect(vmModelScopes('acme')).toEqual([
      'ws:acme:admin',
      'ws:acme:services',
      'ws:acme:apps',
      'ws:acme:agents',
      'ws:acme:sessions',
      'ws:acme:integrations',
    ])
  })
})

describe('browser onboarding projection', () => {
  test('projects campaign official agents onto an incomplete owner workspace', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'campaign-owner@example.test',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'fixture-campaign',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 100,
        expiresAt: 200,
      })
      await ctx.db.patch(userId, { acquisitionAttributionId: attributionId })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'campaign-owner-workspace',
        name: 'Campaign owner workspace',
        status: 'active',
        billingUserId: userId,
        createdAt: 100,
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })

      const payload = await authorizedBrowserSessionPayload(ctx, userId, () => ({
        enabled: true,
        attributionWindowMs: 100,
        starterAgents: ['fixture-researcher'],
      }))

      expect(payload.workspaces[0]).toMatchObject({
        id: workspaceId,
        onboarding: { starterAgents: ['fixture-researcher'] },
      })
    })
  })

  test('omits campaign onboarding data from non-owners and completed owners', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'campaign-non-owner@example.test',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'fixture-campaign',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 100,
        expiresAt: 200,
      })
      await ctx.db.patch(userId, { acquisitionAttributionId: attributionId })
      for (const [slug, role, onboardedAt] of [
        ['viewer-workspace', 'viewer', undefined],
        ['invited-workspace', 'editor', undefined],
        ['completed-workspace', 'owner', 150],
      ] as const) {
        const workspaceId = await ctx.db.insert('workspaces', {
          slug,
          name: slug,
          status: 'active',
          billingUserId: userId,
          createdAt: 100,
          ...(onboardedAt === undefined ? {} : { onboardedAt }),
        })
        await ctx.db.insert('workspaceMembers', { workspaceId, userId, role })
      }

      const payload = await authorizedBrowserSessionPayload(ctx, userId, () => ({
        enabled: true,
        attributionWindowMs: 100,
        starterAgents: ['fixture-researcher'],
      }))

      expect(payload.workspaces).toHaveLength(3)
      for (const workspace of payload.workspaces) {
        expect(workspace).not.toHaveProperty('onboarding')
      }
    })
  })
})
