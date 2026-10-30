import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'

import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const INTERNAL_KEY = 'test-integration-policies-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('integration agent policies backend domain', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(
      convex,
      uniqueEmail('integration-policies-owner'),
      'Integration Policies Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('stores nobody distinctly from all and clears all idempotently', async () => {
    const workspaceId = await createWorkspace('states')

    expect(await policiesForToolkits(workspaceId, ['github'])).toEqual([])
    expect(
      await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        toolkitSlug: 'github',
        allowedAgentIds: [],
      }),
    ).toEqual({ integration: 'github', allowedAgentIds: [] })
    expect(await policiesForToolkits(workspaceId, ['github'])).toEqual([
      { integration: 'github', allowedAgentIds: [] },
    ])

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await mutate(owner.client, 'domains/integrations/model:clearIntegrationAgentPolicy', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          toolkitSlug: 'github',
        }),
      ).toEqual({ integration: 'github' })
    }
    expect(await policiesForToolkits(workspaceId, ['github'])).toEqual([])
  })

  test('deduplicates principals and stores root before stable agent IDs', async () => {
    const workspaceId = await createWorkspace('canonical')
    const firstAgentId = await createAgent(workspaceId, 'first')
    const secondAgentId = await createAgent(workspaceId, 'second')
    const sortedAgentIds = [firstAgentId, secondAgentId].sort()

    expect(
      await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        toolkitSlug: 'slack',
        allowedAgentIds: [secondAgentId, 'root', firstAgentId, secondAgentId],
      }),
    ).toEqual({ integration: 'slack', allowedAgentIds: ['root', ...sortedAgentIds] })
    expect(await policiesForToolkits(workspaceId, ['slack'])).toEqual([
      { integration: 'slack', allowedAgentIds: ['root', ...sortedAgentIds] },
    ])
  })

  test('rejects an agent owned by another workspace', async () => {
    const workspaceId = await createWorkspace('local')
    const foreignWorkspaceId = await createWorkspace('foreign')
    const foreignAgentId = await createAgent(foreignWorkspaceId, 'foreign')

    await expect(
      mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        toolkitSlug: 'notion',
        allowedAgentIds: [foreignAgentId],
      }),
    ).rejects.toThrow('invalid_agent')
    expect(await policiesForToolkits(workspaceId, ['notion'])).toEqual([])
  })

  test('keeps a deleted agent ID stale but rejects it on a later write', async () => {
    const workspaceId = await createWorkspace('deleted')
    const deletedAgentId = await createAgent(workspaceId, 'temporary')
    await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      toolkitSlug: 'linear',
      allowedAgentIds: [deletedAgentId],
    })

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'temporary',
    })
    expect(await policiesForToolkits(workspaceId, ['linear'])).toEqual([
      { integration: 'linear', allowedAgentIds: [deletedAgentId] },
    ])
    await expect(
      mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        toolkitSlug: 'linear',
        allowedAgentIds: [deletedAgentId],
      }),
    ).rejects.toThrow('invalid_agent')
    expect(await policiesForToolkits(workspaceId, ['linear'])).toEqual([
      { integration: 'linear', allowedAgentIds: [deletedAgentId] },
    ])
  })

  test('accepts policies beyond the former workspace cap', async () => {
    const workspaceId = await createWorkspace('capacity')
    await convex.mutation('testing/agentSessions:seedIntegrationAgentPoliciesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      count: 1000,
    })

    expect(
      await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        toolkitSlug: 'overflow-toolkit',
        allowedAgentIds: [],
      }),
    ).toEqual({ integration: 'overflow-toolkit', allowedAgentIds: [] })
    expect(
      await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        toolkitSlug: 'seed-toolkit-0000',
        allowedAgentIds: ['root'],
      }),
    ).toEqual({ integration: 'seed-toolkit-0000', allowedAgentIds: ['root'] })
    expect(
      await policiesForToolkits(workspaceId, [
        'overflow-toolkit',
        'seed-toolkit-0000',
        'missing-toolkit',
        'overflow-toolkit',
      ]),
    ).toEqual([
      { integration: 'overflow-toolkit', allowedAgentIds: [] },
      { integration: 'seed-toolkit-0000', allowedAgentIds: ['root'] },
    ])
  })
})

async function policiesForToolkits(workspaceId: string, toolkitSlugs: string[]): Promise<unknown> {
  return await query(
    owner.client,
    'domains/integrations/model:integrationAgentPoliciesForToolkits',
    {
      internalKey: INTERNAL_KEY,
      workspaceId,
      toolkitSlugs,
    },
  )
}

async function createWorkspace(label: string): Promise<string> {
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `integration-policy-${label}-${sequence++}`,
    name: `Integration policy ${label}`,
  })) as string
}

async function createAgent(workspaceId: string, slug: string): Promise<string> {
  const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path: `agents/${slug}`,
    slug,
  })) as { id: string }
  return agent.id
}
