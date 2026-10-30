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

const INTERNAL_KEY = 'test-connected-providers-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let member: { client: ConvexHttpClient; user: { _id: string; email: string } }
let otherMember: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('connected providers backend domain', () => {
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
      uniqueEmail('connected-providers-owner'),
      'Connected Providers Owner',
    )
    member = await signInWithMagicLink(
      convex,
      uniqueEmail('connected-providers-member'),
      'Connected Providers Member',
    )
    otherMember = await signInWithMagicLink(
      convex,
      uniqueEmail('connected-providers-other-member'),
      'Connected Providers Other Member',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('a workspace member can connect and every member sees who connected it', async () => {
    const workspaceId = await workspaceFixture('member-connect')
    await addMember(workspaceId, otherMember.user._id)

    await mutate(member.client, 'domains/connectedProviders/model:authorizeConnect', {
      workspaceId,
      actorId: member.user._id,
      internalKey: INTERNAL_KEY,
      provider: 'openai-codex',
    })
    await mutate(member.client, 'domains/connectedProviders/model:completeConnect', {
      workspaceId,
      actorId: member.user._id,
      internalKey: INTERNAL_KEY,
      connection: {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 10_000,
        eligibilityCheckedAt: 10_100,
      },
    })

    expect(
      await query(otherMember.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId,
        actorId: otherMember.user._id,
        internalKey: INTERNAL_KEY,
      }),
    ).toEqual([
      {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 10_000,
        connectedByUserId: member.user._id,
        connectedByLabel: member.user.email,
        eligibilityCheckedAt: 10_100,
        canDisconnect: false,
      },
    ])
  })

  test('only the connector or workspace owner may disconnect', async () => {
    const workspaceId = await workspaceFixture('disconnect-authorization')
    await addMember(workspaceId, otherMember.user._id)
    await completeConnection(workspaceId, member, 'github-copilot', 20_000)

    await expect(
      mutate(otherMember.client, 'domains/connectedProviders/model:requestDisconnect', {
        workspaceId,
        actorId: otherMember.user._id,
        internalKey: INTERNAL_KEY,
        provider: 'github-copilot',
      }),
    ).rejects.toThrow('disconnect_forbidden')

    await expect(
      mutate(member.client, 'domains/connectedProviders/model:requestDisconnect', {
        workspaceId,
        actorId: member.user._id,
        internalKey: INTERNAL_KEY,
        provider: 'github-copilot',
      }),
    ).resolves.toEqual({ ok: true })

    expect(
      await query(member.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId,
        actorId: member.user._id,
        internalKey: INTERNAL_KEY,
      }),
    ).toEqual([])

    await completeConnection(workspaceId, member, 'github-copilot', 21_000)
    await expect(
      mutate(owner.client, 'domains/connectedProviders/model:requestDisconnect', {
        workspaceId,
        actorId: owner.user._id,
        internalKey: INTERNAL_KEY,
        provider: 'github-copilot',
      }),
    ).resolves.toEqual({ ok: true })
  })

  test('trial workspaces may connect without a tier gate', async () => {
    await mutate(owner.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: 30_000,
    })
    const workspaceId = await workspaceFixture('trial')

    await expect(
      mutate(owner.client, 'domains/connectedProviders/model:authorizeConnect', {
        workspaceId,
        actorId: owner.user._id,
        internalKey: INTERNAL_KEY,
        provider: 'openai-codex',
      }),
    ).resolves.toEqual({ ok: true })
    await completeConnection(workspaceId, owner, 'openai-codex', 30_100)
    expect(
      await query(owner.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId,
        actorId: owner.user._id,
        internalKey: INTERNAL_KEY,
      }),
    ).toContainEqual(expect.objectContaining({ provider: 'openai-codex', state: 'connected' }))
  })

  test('the durable row shape contains no token-named field', async () => {
    const workspaceId = await workspaceFixture('no-token-shape')
    await completeConnection(workspaceId, member, 'openai-codex', 40_000)

    const rows = (await query(convex, 'testing/connectedProviders:rawRowsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'openai-codex',
      connectedByUserId: member.user._id,
      state: 'connected',
    })
    expect(
      Object.keys(rows[0]!).some(key => /access|refresh|token|secret|credential/i.test(key)),
    ).toBe(false)
  })

  test('completion uses and consumes the initiating member attribution', async () => {
    const workspaceId = await workspaceFixture('pending-attribution')
    await mutate(member.client, 'domains/connectedProviders/model:authorizeConnect', {
      workspaceId,
      actorId: member.user._id,
      internalKey: INTERNAL_KEY,
      provider: 'github-copilot',
    })

    await completeConnection(workspaceId, owner, 'github-copilot', 50_000)
    expect(
      await query(owner.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId,
        actorId: owner.user._id,
        internalKey: INTERNAL_KEY,
      }),
    ).toContainEqual(
      expect.objectContaining({
        provider: 'github-copilot',
        connectedByUserId: member.user._id,
      }),
    )

    await completeConnection(workspaceId, owner, 'github-copilot', 50_100)
    expect(
      await query(owner.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId,
        actorId: owner.user._id,
        internalKey: INTERNAL_KEY,
      }),
    ).toContainEqual(
      expect.objectContaining({
        provider: 'github-copilot',
        connectedByUserId: owner.user._id,
      }),
    )
  })

  test('the next observation removes abandoned connect intents after their TTL', async () => {
    const workspaceId = await workspaceFixture('expired-intents')
    await mutate(member.client, 'domains/connectedProviders/model:authorizeConnect', {
      workspaceId,
      actorId: member.user._id,
      internalKey: INTERNAL_KEY,
      provider: 'github-copilot',
    })
    expect(
      await query(convex, 'testing/connectedProviders:rawConnectIntentsForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toHaveLength(1)

    await mutate(convex, 'domains/connectedProviders/model:applyObservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      connectedProviders: [],
      now: Date.now() + 2 * 60 * 60 * 1000,
    })

    expect(
      await query(convex, 'testing/connectedProviders:rawConnectIntentsForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toEqual([])
  })
})

async function workspaceFixture(label: string): Promise<string> {
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `cp-${label}-${sequence++}`,
    name: `Connected Providers ${label}`,
  })) as string
  await mutate(convex, 'testing/workspaces:addWorkspaceMemberForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    userId: member.user._id,
    role: 'viewer',
  })
  return workspaceId
}

async function addMember(workspaceId: string, userId: string): Promise<void> {
  await mutate(convex, 'testing/workspaces:addWorkspaceMemberForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    userId,
    role: 'viewer',
  })
}

async function completeConnection(
  workspaceId: string,
  actor: typeof owner,
  provider: 'openai-codex' | 'github-copilot',
  now: number,
) {
  return await mutate(actor.client, 'domains/connectedProviders/model:completeConnect', {
    workspaceId,
    actorId: actor.user._id,
    internalKey: INTERNAL_KEY,
    connection: {
      provider,
      state: 'connected',
      connectedAt: now,
      eligibilityCheckedAt: now,
    },
  })
}
