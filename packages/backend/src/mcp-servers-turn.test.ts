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

const INTERNAL_KEY = 'test-mcp-servers-turn-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

type Prepared = {
  sessionId: string
  dispatch: { attemptId: string; throughSeq: number; mcpServers?: Array<{ name: string }> }
}

// Every case drives the real `prepareRunnerInputDelivery` mutation rather than
// the projection helper: the launch marker only exists if the dispatch path
// calls it, and the returns validator that would reject an unlisted field is
// only enforced by a live deployment.
describe('custom MCP servers on the turn launch marker', () => {
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
    owner = await signInWithMagicLink(convex, uniqueEmail('mcp-turn-owner'), 'MCP Turn Owner')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('omits the field for a workspace with no servers, without asking for it', async () => {
    const workspaceId = await createWorkspace('none')

    // No `projectIntegrations`, no flag of any kind: the projection has to run
    // anyway, and it has to say nothing when there is nothing to say.
    const prepared = await prepareInitial(workspaceId, 'no-servers')

    expect(prepared.dispatch.mcpServers).toBeUndefined()
  })

  test('carries ready servers by name, sorted, on an unflagged dispatch', async () => {
    const workspaceId = await createWorkspace('ready')
    await register(workspaceId, 'zulu')
    await register(workspaceId, 'alpha')

    const prepared = await prepareInitial(workspaceId, 'two-servers')

    expect(prepared.dispatch.mcpServers).toEqual([{ name: 'alpha' }, { name: 'zulu' }])
  })

  test('leaves a server still owed a consent click off the marker', async () => {
    const workspaceId = await createWorkspace('needs-auth')
    await register(workspaceId, 'ready_one')
    await register(workspaceId, 'awaiting', 'oauth')

    const prepared = await prepareInitial(workspaceId, 'needs-auth')

    expect(prepared.dispatch.mcpServers).toEqual([{ name: 'ready_one' }])
  })

  test('applies the three-state per-agent rule to each server independently', async () => {
    const workspaceId = await createWorkspace('policy')
    const agentId = await createAgent(workspaceId, 'researcher')
    await register(workspaceId, 'everyone')
    await register(workspaceId, 'nobody')
    await register(workspaceId, 'agent_only')
    await setPolicy(workspaceId, 'nobody', [])
    await setPolicy(workspaceId, 'agent_only', [agentId])

    const root = await prepareInitial(workspaceId, 'policy-root')
    expect(root.dispatch.mcpServers).toEqual([{ name: 'everyone' }])

    const agent = await prepareInitial(workspaceId, 'policy-agent', 'agents/researcher')
    expect(agent.dispatch.mcpServers).toEqual([{ name: 'agent_only' }, { name: 'everyone' }])
  })

  test('refuses dispatch for a session whose agent row is gone', async () => {
    const workspaceId = await createWorkspace('dangling')
    const agentId = await createAgent(workspaceId, 'temporary')
    await register(workspaceId, 'everyone')
    await register(workspaceId, 'agent_only')
    await setPolicy(workspaceId, 'agent_only', [agentId])

    const agent = await prepareInitial(workspaceId, 'dangling-agent', 'agents/temporary')
    expect(agent.dispatch.mcpServers).toEqual([{ name: 'agent_only' }, { name: 'everyone' }])
    await markDelivered(workspaceId, agent)

    await convex.mutation('testing/agents:deleteAgentRowWithoutSessionCleanupForTest', {
      internalKey: INTERNAL_KEY,
      agentId,
    })

    // A session attached to a deleted agent is no longer an addressable
    // dispatch target, so no MCP projection is allowed to resurrect it.
    await expect(prepareMessage(workspaceId, agent.sessionId, 'dangling-message')).rejects.toThrow(
      'not_found',
    )
  })

  test('stops carrying a server the moment its row is deleted', async () => {
    const workspaceId = await createWorkspace('deleted')
    await register(workspaceId, 'transient')
    const prepared = await prepareInitial(workspaceId, 'before-delete')
    expect(prepared.dispatch.mcpServers).toEqual([{ name: 'transient' }])
    await markDelivered(workspaceId, prepared)

    await mutate(owner.client, 'domains/mcpServers/model:deleteMcpServer', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      name: 'transient',
    })

    const after = await prepareMessage(workspaceId, prepared.sessionId, 'after-delete')
    expect(after.dispatch.mcpServers).toBeUndefined()
  })
})

async function register(
  workspaceId: string,
  name: string,
  authKind: 'none' | 'oauth' = 'none',
): Promise<void> {
  await mutate(owner.client, 'domains/mcpServers/model:registerMcpServer', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    actorId: owner.user._id,
    name,
    url: `https://example.com/${name}/mcp`,
    authKind,
  })
}

async function setPolicy(
  workspaceId: string,
  name: string,
  allowedAgentIds: string[],
): Promise<void> {
  await mutate(owner.client, 'domains/mcpServers/model:setMcpServerAgentPolicy', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
    allowedAgentIds,
  })
}

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
    input: {
      kind: 'initial_prompt',
      prompt: label,
      behavior: 'steer',
      sender: { kind: 'user', userId: owner.user._id },
      ...(cwd === undefined ? {} : { cwd }),
    },
  })) as Prepared
}

async function prepareMessage(
  workspaceId: string,
  sessionId: string,
  label: string,
): Promise<Prepared> {
  return (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId,
    attemptId: label,
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

async function createWorkspace(label: string): Promise<string> {
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `mcp-turn-${label}-${sequence++}`,
    name: `MCP turn ${label}`,
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
