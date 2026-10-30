import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'

import {
  convexDev,
  generateAuthKeys,
  mutate,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { integrationPermissionFingerprint } from '../convex/domains/integrations/turnConfig'

const INTERNAL_KEY = 'test-integration-turn-config-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

type Prepared = {
  sessionId: string
  dispatch: { attemptId: string; throughSeq: number; integrations: true }
}
type StoredConfig = {
  configId: string
  permissionFingerprint: string
  disabledToolkitSlugs: string[]
  providerSessionId?: string
  appliedPermissionFingerprint?: string
}

describe('integration next-turn configuration', () => {
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
      uniqueEmail('integration-turn-config-owner'),
      'Integration Turn Config Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('keeps one config per conversation and updates its effective permissions', async () => {
    const workspaceId = await createWorkspace('root-cache')
    const first = await prepareInitial(workspaceId, 'first-root')
    const firstConfig = await storedConfigForSession(first.sessionId)
    expect(firstConfig.disabledToolkitSlugs).toEqual([])

    await abandon(workspaceId, first)
    const retried = await prepareDrain(workspaceId, first.sessionId, 'retry-root')
    expect(retried.dispatch.integrations).toEqual(first.dispatch.integrations)
    await markDelivered(workspaceId, retried)

    const secondConversation = await prepareInitial(workspaceId, 'second-root')
    const secondConfig = await storedConfigForSession(secondConversation.sessionId)
    expect(secondConfig.permissionFingerprint).toBe(firstConfig.permissionFingerprint)
    expect(secondConfig.configId).not.toBe(firstConfig.configId)

    await setPolicy(workspaceId, 'github', [])
    const denied = await prepareMessage(workspaceId, first.sessionId, 'deny-root')
    const deniedConfig = await storedConfigForSession(first.sessionId)
    expect(deniedConfig.disabledToolkitSlugs).toEqual(['github'])
    expect(deniedConfig.configId).toBe(firstConfig.configId)
    expect(deniedConfig.permissionFingerprint).not.toBe(firstConfig.permissionFingerprint)
    await markDelivered(workspaceId, denied)

    const agentId = await createAgent(workspaceId, 'irrelevant-agent')
    await setPolicy(workspaceId, 'github', [agentId])
    const stillDenied = await prepareMessage(workspaceId, first.sessionId, 'still-deny-root')
    expect((await storedConfigForSession(first.sessionId)).permissionFingerprint).toBe(
      deniedConfig.permissionFingerprint,
    )
    await markDelivered(workspaceId, stillDenied)

    await setPolicy(workspaceId, 'github', ['root'])
    await prepareMessage(workspaceId, first.sessionId, 'allow-root')
    expect((await storedConfigForSession(first.sessionId)).permissionFingerprint).toBe(
      firstConfig.permissionFingerprint,
    )
  })

  test('reprojects current policy for an autonomous wake without a user input', async () => {
    const workspaceId = await createWorkspace('wake-refresh')
    const prepared = await prepareInitial(workspaceId, 'wake-refresh')
    await setPolicy(workspaceId, 'github', [])

    const refreshed = (await convex.mutation(
      'domains/integrations/turnConfig:projectToolRouterConfigForSession',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        duetSessionId: prepared.sessionId,
      },
    )) as true

    expect(refreshed).toBe(true)
    expect((await storedConfigForSession(prepared.sessionId)).disabledToolkitSlugs).toEqual([
      'github',
    ])
  })

  test('distinguishes root, agents, nobody, and a deleted session principal', async () => {
    const workspaceId = await createWorkspace('principal-matrix')
    const agentId = await createAgent(workspaceId, 'researcher')
    await setPolicy(workspaceId, 'linear', ['root', agentId])
    await setPolicy(workspaceId, 'notion', [])

    const root = await prepareInitial(workspaceId, 'root-matrix')
    expect((await storedConfigForSession(root.sessionId)).disabledToolkitSlugs).toEqual(['notion'])

    const agent = await prepareInitial(workspaceId, 'agent-matrix', 'agents/researcher')
    expect((await storedConfigForSession(agent.sessionId)).disabledToolkitSlugs).toEqual(['notion'])
    await markDelivered(workspaceId, agent)

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'researcher',
    })
    const stale = await prepareMessage(workspaceId, agent.sessionId, 'stale-principal', true)
    expect((await storedConfigForSession(stale.sessionId)).disabledToolkitSlugs).toEqual([
      'linear',
      'notion',
    ])
  })

  test('hashes a versioned sorted set independent of row order and duplicate slugs', async () => {
    const left = await integrationPermissionFingerprint(['slack', 'github', 'slack'])
    const right = await integrationPermissionFingerprint(['github', 'slack'])
    const changed = await integrationPermissionFingerprint(['github'])

    expect(left).toEqual(right)
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(changed).not.toEqual(left)
  })

  test('deletes the conversation-owned provider session record with the session', async () => {
    const workspaceId = await createWorkspace('delete-configs')
    const prepared = await prepareInitial(workspaceId, 'delete-configs')
    const config = await storedConfigForSession(prepared.sessionId)
    await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      duetSessionId: prepared.sessionId,
      expectedProviderSessionId: null,
      providerSessionId: 'provider-delete-me',
      permissionFingerprint: config.permissionFingerprint,
    })

    await convex.mutation('testing/agentSessions:markDeletingForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: prepared.sessionId,
    })
    const workId = await convex.mutation(
      'testing/agentSessions:prepareSessionDeletionCleanupForTest',
      { internalKey: INTERNAL_KEY, sessionId: prepared.sessionId },
    )
    expect(
      await convex.mutation('testing/agentSessions:runSessionDeletionCleanupForTest', {
        internalKey: INTERNAL_KEY,
        workId,
      }),
    ).toEqual({ done: true })
    expect(await storedConfig(config.configId)).toBeNull()
  })

  test('stores one provider session and records in-place permission updates', async () => {
    const workspaceId = await createWorkspace('provider-owner')
    const foreignWorkspaceId = await createWorkspace('owner-foreign')
    const prepared = await prepareInitial(workspaceId, 'provider-owner')
    const config = await storedConfigForSession(prepared.sessionId)

    expect(
      await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        duetSessionId: prepared.sessionId,
        expectedProviderSessionId: null,
        providerSessionId: 'provider-session-1',
        permissionFingerprint: config.permissionFingerprint,
      }),
    ).toEqual({ status: 'adopted', applied: true })
    expect(await storedConfigForSession(prepared.sessionId)).toMatchObject({
      providerSessionId: 'provider-session-1',
      appliedPermissionFingerprint: config.permissionFingerprint,
    })

    await markDelivered(workspaceId, prepared)
    expect(
      await convex.query('domains/integrations/turnConfig:getToolRouterSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: foreignWorkspaceId,
        duetSessionId: prepared.sessionId,
      }),
    ).toEqual({ status: 'not_found' })

    await setPolicy(workspaceId, 'github', [])
    await prepareMessage(workspaceId, prepared.sessionId, 'permissions-changed')
    const changed = await storedConfigForSession(prepared.sessionId)
    expect(
      await convex.mutation(
        'domains/integrations/turnConfig:markToolRouterSessionPermissionsApplied',
        {
          internalKey: INTERNAL_KEY,
          workspaceId,
          duetSessionId: prepared.sessionId,
          providerSessionId: 'provider-session-1',
          permissionFingerprint: changed.permissionFingerprint,
        },
      ),
    ).toEqual({ applied: true })
    expect(await storedConfigForSession(prepared.sessionId)).toMatchObject({
      providerSessionId: 'provider-session-1',
      disabledToolkitSlugs: ['github'],
      appliedPermissionFingerprint: changed.permissionFingerprint,
    })

    expect(
      await convex.mutation(
        'domains/integrations/turnConfig:markToolRouterSessionPermissionsApplied',
        {
          internalKey: INTERNAL_KEY,
          workspaceId,
          duetSessionId: prepared.sessionId,
          providerSessionId: 'provider-session-1',
          permissionFingerprint: config.permissionFingerprint,
        },
      ),
    ).toEqual({ applied: false })
    const invalidated = await storedConfigForSession(prepared.sessionId)
    expect(invalidated).toMatchObject({
      providerSessionId: 'provider-session-1',
      disabledToolkitSlugs: ['github'],
    })
    expect(invalidated.appliedPermissionFingerprint).toBeUndefined()
  })

  test('replaces a vanished provider session only while its stored identity still matches', async () => {
    const workspaceId = await createWorkspace('provider-replacement')
    const prepared = await prepareInitial(workspaceId, 'provider-replacement')
    const config = await storedConfigForSession(prepared.sessionId)
    await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      duetSessionId: prepared.sessionId,
      expectedProviderSessionId: null,
      providerSessionId: 'provider-session-gone',
      permissionFingerprint: config.permissionFingerprint,
    })

    expect(
      await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        duetSessionId: prepared.sessionId,
        expectedProviderSessionId: 'provider-session-stale-observer',
        providerSessionId: 'provider-session-loser',
        permissionFingerprint: config.permissionFingerprint,
      }),
    ).toEqual({ status: 'changed' })
    expect((await storedConfigForSession(prepared.sessionId)).providerSessionId).toBe(
      'provider-session-gone',
    )

    expect(
      await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        duetSessionId: prepared.sessionId,
        expectedProviderSessionId: 'provider-session-gone',
        providerSessionId: 'provider-session-replacement',
        permissionFingerprint: config.permissionFingerprint,
      }),
    ).toEqual({ status: 'adopted', applied: true })
    expect(await storedConfigForSession(prepared.sessionId)).toMatchObject({
      providerSessionId: 'provider-session-replacement',
      appliedPermissionFingerprint: config.permissionFingerprint,
    })
  })

  test('a delete fence rejects a provider session adopted afterward', async () => {
    const workspaceId = await createWorkspace('delete-fence')
    const prepared = await prepareInitial(workspaceId, 'delete-fence-session')
    const begun = await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      workspaceId,
      sessionId: prepared.sessionId,
      now: 2_000,
    })
    expect(begun).toEqual({ accepted: true })
    expect(
      await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        duetSessionId: prepared.sessionId,
        expectedProviderSessionId: null,
        providerSessionId: 'provider-created-too-late',
        permissionFingerprint: 'permissions-too-late',
      }),
    ).toEqual({ status: 'not_found' })
  })
})

async function prepareInitial(workspaceId: string, label: string, cwd?: string): Promise<Prepared> {
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    attemptId: `initial-${label}`,
    projectIntegrations: true,
    input: {
      kind: 'initial_prompt',
      prompt: label,
      behavior: 'steer',
      sender: { kind: 'user', userId: owner.user._id },
      ...(cwd === undefined ? {} : { cwd }),
    },
  })) as Prepared
}

async function prepareDrain(
  workspaceId: string,
  sessionId: string,
  attemptId: string,
): Promise<Prepared> {
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId,
    attemptId,
    projectIntegrations: true,
    input: { kind: 'drain' },
  })) as Prepared
}

async function prepareMessage(
  workspaceId: string,
  sessionId: string,
  label: string,
  workspacePrincipal = false,
): Promise<Prepared> {
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: workspacePrincipal
        ? { kind: 'workspace' as const }
        : { kind: 'human' as const, userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId,
    attemptId: label,
    projectIntegrations: true,
    input: {
      kind: 'message',
      prompt: label,
      behavior: 'steer',
      sender: { kind: 'user', userId: owner.user._id },
    },
  })) as Prepared
}

async function markDelivered(workspaceId: string, prepared: Prepared): Promise<void> {
  await convex.mutation('domains/agentSessions/model:markRunnerInputDelivered', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId: prepared.sessionId,
    attemptId: prepared.dispatch.attemptId,
    throughSeq: prepared.dispatch.throughSeq,
  })
}

async function abandon(workspaceId: string, prepared: Prepared): Promise<void> {
  await convex.mutation('domains/agentSessions/model:abandonRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    sessionId: prepared.sessionId,
    attemptId: prepared.dispatch.attemptId,
  })
}

async function setPolicy(
  workspaceId: string,
  toolkitSlug: string,
  allowedAgentIds: string[],
): Promise<void> {
  await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    toolkitSlug,
    allowedAgentIds,
  })
}

async function storedConfig(configId: string): Promise<StoredConfig> {
  return (await convex.query('testing/agentSessions:rawToolRouterConfigForTest', {
    internalKey: INTERNAL_KEY,
    configId,
  })) as StoredConfig
}

async function storedConfigForSession(sessionId: string): Promise<StoredConfig> {
  const rows = (await convex.query('testing/agentSessions:toolRouterConfigsForSessionForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: (
      (await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId,
      })) as { workspaceId: string }
    ).workspaceId,
    sessionId,
  })) as StoredConfig[]
  expect(rows).toHaveLength(1)
  return rows[0]!
}

async function createWorkspace(label: string): Promise<string> {
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `integration-turn-${label}-${sequence++}`,
    name: `Integration turn ${label}`,
  })) as string
}

async function createAgent(workspaceId: string, slug: string): Promise<string> {
  const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path: `agents/${slug}`,
    slug,
  })) as { id: string }
  await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
    workspaceId,
    slug,
    onboarded: true,
  })
  return agent.id
}
