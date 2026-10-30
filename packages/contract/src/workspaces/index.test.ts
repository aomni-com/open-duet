import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'
import { API_VERSION } from '../scopes/index'
import {
  WhoamiResponseSchema,
  WorkspaceBillingCapRequestSchema,
  WorkspaceBillingCapResponseSchema,
  WorkspaceDefaultModelRequestSchema,
  WorkspaceDuetNameSchema,
  WorkspaceCreateRefusalSchema,
  WorkspacePurposeSchema,
  WorkspaceInviteListQuerySchema,
  WorkspaceInvitePageSchema,
  WorkspaceAuditPageSchema,
  WorkspaceAuditQuerySchema,
  WorkspaceMembersPageSchema,
  WorkspaceMembersQuerySchema,
  WORKSPACE_MEMBER_LIMIT,
  WORKSPACE_DUET_NAME_MAX_LENGTH,
  WORKSPACE_PURPOSE_MAX_LENGTH,
  WorkspaceMemberAdmissionRefusalSchema,
  normalizeWorkspaceMemberSearch,
} from './index'

describe('workspace API contract', () => {
  test('whoami cannot report a retired sync credential as a login identity', () => {
    const identity = {
      user: { id: 'user_1', email: 'owner@example.test' },
      workspaces: [],
      scopes: [],
      versions: API_VERSION,
      internalAdmin: false,
    }
    expect(
      WhoamiResponseSchema.safeParse({ ...identity, credential: { kind: 'sync_device' } }).success,
    ).toBe(false)
    expect(WhoamiResponseSchema.parse({ ...identity, credential: { kind: 'user' } })).toEqual({
      ...identity,
      credential: { kind: 'user' },
    })
  })

  test('pages workspace invites with strict universal queries', () => {
    expect(WorkspaceInviteListQuerySchema.parse({})).toEqual({
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(WorkspaceInvitePageSchema.parse({ items: [], nextCursor: null, invites: [] })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(WorkspaceInviteListQuerySchema.safeParse({ role: 'editor' }).success).toBe(false)
  })

  test('uses the universal collection page for members and audit', () => {
    expect(
      WorkspaceMembersQuerySchema.parse({
        search: ' Ada ',
        limit: String(COLLECTION_PAGE_MAX_LIMIT),
      }),
    ).toEqual({
      search: 'Ada',
      limit: COLLECTION_PAGE_MAX_LIMIT,
    })
    expect(WorkspaceMembersQuerySchema.safeParse({ unknown: 'field' }).success).toBe(false)
    expect(
      WorkspaceMembersPageSchema.parse({ items: [], nextCursor: null, additive: true }),
    ).toEqual({ items: [], nextCursor: null })
    expect(WorkspaceMembersPageSchema.safeParse({ members: [] }).success).toBe(false)

    expect(WorkspaceAuditQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(WorkspaceAuditPageSchema.safeParse({ events: [], done: true }).success).toBe(false)
  })

  test('normalizes member search once for server and cache identity', () => {
    expect(normalizeWorkspaceMemberSearch('  MAYA  ')).toBe('maya')
    expect(normalizeWorkspaceMemberSearch('  Ｍａｙａ  ')).toBe('maya')
    expect(normalizeWorkspaceMemberSearch('A'.repeat(40))).toBe('a'.repeat(32))
    expect(normalizeWorkspaceMemberSearch(undefined)).toBe('')
  })
  test('preserves actionable creation refusals from the backend', () => {
    expect(
      WorkspaceCreateRefusalSchema.parse({
        error: 'workspace_limit_reached',
        plan: 'pro',
        limit: 3,
      }),
    ).toEqual({ error: 'workspace_limit_reached', plan: 'pro', limit: 3 })
  })

  test('owns the typed workspace-member capacity refusal', () => {
    expect(
      WorkspaceMemberAdmissionRefusalSchema.parse({
        error: 'workspace_member_limit_reached',
        limit: WORKSPACE_MEMBER_LIMIT,
      }),
    ).toEqual({ error: 'workspace_member_limit_reached', limit: WORKSPACE_MEMBER_LIMIT })
    expect(
      WorkspaceMemberAdmissionRefusalSchema.safeParse({
        error: 'workspace_member_limit_reached',
        limit: WORKSPACE_MEMBER_LIMIT + 1,
      }).success,
    ).toBe(false)
  })

  test('normalizes the root Duet name within the product input limit', () => {
    expect(WorkspaceDuetNameSchema.parse('  Milo  ')).toBe('Milo')
    expect(
      WorkspaceDuetNameSchema.safeParse('x'.repeat(WORKSPACE_DUET_NAME_MAX_LENGTH + 1)).success,
    ).toBe(false)
  })

  // The root's name is an agent's name, so it obeys the agent rule — asserted
  // here rather than assumed, because an alias is a promise about behavior and
  // a future edit could quietly fork the two.
  test('holds the root Duet name to the same markup-safety rule as any agent name', () => {
    for (const name of ['Duet<script>', 'Duet[1]', 'Duet`x`', 'Duet\u0000name']) {
      expect(WorkspaceDuetNameSchema.safeParse(name).success).toBe(false)
    }
    expect(WorkspaceDuetNameSchema.parse('Milo & Co (EMEA) 🤖')).toBe('Milo & Co (EMEA) 🤖')
  })

  test('normalizes the workspace purpose within its one-paragraph clamp', () => {
    expect(WorkspacePurposeSchema.parse('  Grow my bakery online  ')).toBe('Grow my bakery online')
    expect(WorkspacePurposeSchema.safeParse('   ').success).toBe(false)
    expect(WorkspacePurposeSchema.parse('x'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH))).toBe(
      'x'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH),
    )
    expect(
      WorkspacePurposeSchema.safeParse('x'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH + 1)).success,
    ).toBe(false)
  })

  test('accepts setting and clearing a workspace monthly spend cap', () => {
    expect(WorkspaceBillingCapRequestSchema.parse({ monthlyCapMicroUsd: 2_000_000 })).toEqual({
      monthlyCapMicroUsd: 2_000_000,
    })
    expect(WorkspaceBillingCapResponseSchema.parse({ monthlyCapMicroUsd: null })).toEqual({
      monthlyCapMicroUsd: null,
    })
  })

  test('accepts tier defaults and rejects the retired default-model shape', () => {
    expect(WorkspaceDefaultModelRequestSchema.parse({ tier: 'balanced' })).toEqual({
      tier: 'balanced',
    })
    expect(
      WorkspaceDefaultModelRequestSchema.safeParse({ defaultModelId: 'recommended' }).success,
    ).toBe(false)
  })

  test('parses workspace summaries and the server-derived internal-admin decision', () => {
    expect(
      WhoamiResponseSchema.parse({
        user: { id: 'user_1', email: 'owner@example.com', name: 'Owner' },
        workspaces: [
          {
            id: 'workspace_1',
            slug: 'acme',
            name: 'Acme',
            status: 'active',
            servicingStatus: 'paused',
            role: 'owner',
            billingUserId: 'user_1',
            funding: { plan: 'max', active: true },
            creditRecovery: 'topup',
            defaultTier: {
              configured: 'frontier',
              effective: 'frontier',
            },
            purpose: 'Grow my bakery online',
            onboarding: { starterAgents: ['fixture-researcher'] },
          },
        ],
        scopes: ['ws:acme:admin'],
        versions: { api: 1 },
        internalAdmin: true,
      }),
    ).toMatchObject({
      internalAdmin: true,
      workspaces: [
        {
          slug: 'acme',
          role: 'owner',
          servicingStatus: 'paused',
          creditRecovery: 'topup',
          defaultTier: {
            configured: 'frontier',
            effective: 'frontier',
          },
          purpose: 'Grow my bakery online',
          onboarding: { starterAgents: ['fixture-researcher'] },
        },
      ],
    })
  })

  test('requires the billing-owner tier projection on every workspace summary', () => {
    expect(
      WhoamiResponseSchema.safeParse({
        user: { id: 'user_1', email: 'owner@example.com' },
        workspaces: [
          {
            id: 'workspace_1',
            slug: 'acme',
            name: 'Acme',
            status: 'active',
            servicingStatus: 'active',
            role: 'owner',
            billingUserId: 'user_1',
            funding: { plan: null, active: false },
            creditRecovery: null,
          },
        ],
        scopes: [],
        versions: { api: 1 },
        internalAdmin: false,
      }).success,
    ).toBe(false)
  })

  // Required, not optional: a workspace summary that could omit `funding`
  // makes "nobody is paying for this" indistinguishable from "this payload
  // kind forgot to say", and an agent reading the second asks its human to buy
  // a subscription they already have.
  test('requires funding on every workspace summary, per workspace and never per reader', () => {
    const parsed = WhoamiResponseSchema.parse({
      user: { id: 'user_b', email: 'member@example.com' },
      workspaces: [
        summary({ slug: 'acme', funding: { plan: 'pro', active: true } }),
        summary({
          slug: 'labs',
          funding: { plan: null, active: true, trialEndsAt: 1_800_000_000 },
        }),
        summary({ slug: 'ghost', funding: { plan: null, active: false } }),
      ],
      scopes: [],
      versions: { api: 1 },
      internalAdmin: false,
    })

    // One reader, three payers: whoami's `funding` cannot collapse to a single
    // fact about the signed-in user without losing two of these three answers.
    expect(parsed.workspaces.map(workspace => workspace.funding)).toEqual([
      { plan: 'pro', active: true },
      { plan: null, active: true, trialEndsAt: 1_800_000_000 },
      { plan: null, active: false },
    ])
    expect(
      WhoamiResponseSchema.safeParse({
        user: { id: 'user_b', email: 'member@example.com' },
        workspaces: [{ ...summary({ slug: 'acme' }), funding: undefined }],
        scopes: [],
        versions: { api: 1 },
        internalAdmin: false,
      }).success,
    ).toBe(false)
  })

  test('requires the payer-derived recovery verdict on every workspace summary', () => {
    const base = summary({ slug: 'acme' })
    const { creditRecovery: _creditRecovery, ...withoutRecovery } = base
    expect(
      WhoamiResponseSchema.parse({
        user: { id: 'user_b', email: 'member@example.com' },
        workspaces: [{ ...base, creditRecovery: 'subscribe' }],
        scopes: [],
        versions: { api: 1 },
        internalAdmin: false,
      }).workspaces[0]?.creditRecovery,
    ).toBe('subscribe')
    expect(
      WhoamiResponseSchema.safeParse({
        user: { id: 'user_b', email: 'member@example.com' },
        workspaces: [withoutRecovery],
        scopes: [],
        versions: { api: 1 },
        internalAdmin: false,
      }).success,
    ).toBe(false)
  })

  test('SUBS-IMPL-11 requires workspace servicing status in identity projections', () => {
    expect(
      WhoamiResponseSchema.safeParse({
        user: { id: 'user_1', email: 'owner@example.com' },
        workspaces: [
          {
            id: 'workspace_1',
            slug: 'acme',
            name: 'Acme',
            status: 'active',
            role: 'owner',
            billingUserId: 'user_1',
            funding: { plan: null, active: false },
            creditRecovery: null,
          },
        ],
        scopes: [],
        versions: { api: 1 },
        internalAdmin: false,
      }).success,
    ).toBe(false)
  })

  test('requires the server decision instead of letting clients infer admin from email', () => {
    expect(
      WhoamiResponseSchema.safeParse({
        user: { id: 'user_1', email: 'admin@duet.so' },
        workspaces: [],
        scopes: [],
        versions: { api: 1 },
      }).success,
    ).toBe(false)
  })

  test('accepts additive credential metadata including an OAuth audience', () => {
    expect(
      WhoamiResponseSchema.parse({
        user: { id: 'user_1', email: 'owner@example.com' },
        workspaces: [],
        scopes: [],
        versions: { api: 1 },
        internalAdmin: false,
        credential: { kind: 'oauth', audience: 'https://mcp.duet.so/' },
      }),
    ).toMatchObject({
      credential: { kind: 'oauth', audience: 'https://mcp.duet.so/' },
      versions: { api: 1 },
    })
  })
})

function summary(overrides: { slug: string; funding?: unknown }): Record<string, unknown> {
  return {
    id: `workspace_${overrides.slug}`,
    slug: overrides.slug,
    name: overrides.slug,
    status: 'active',
    servicingStatus: 'active',
    role: 'viewer',
    billingUserId: 'user_a',
    funding: overrides.funding ?? { plan: null, active: true },
    creditRecovery: null,
    defaultTier: { effective: 'balanced' },
  }
}

test('workspace default accepts a stable provider alias and rejects a concrete model', () => {
  expect(WorkspaceDefaultModelRequestSchema.parse({ tier: 'openai-frontier' })).toEqual({
    tier: 'openai-frontier',
  })
  expect(WorkspaceDefaultModelRequestSchema.safeParse({ tier: 'gpt-6-astra' }).success).toBe(false)
})
