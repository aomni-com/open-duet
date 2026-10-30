import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { MAX_AGENTS_PER_WORKSPACE, type Agent } from '@repo/contract'
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

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-agent-replication-internal-key'
const NOW = 100_000

let convex: ConvexDevFixture
let owner: SignedInUser
let recipient: SignedInUser
let readRecipient: SignedInUser
let sequence = 0

describe('agent share replication', () => {
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
    owner = await signInWithMagicLink(convex, uniqueEmail('agent-replication-owner'), 'Owner')
    recipient = await signInWithMagicLink(
      convex,
      uniqueEmail('agent-replication-recipient'),
      'Recipient',
    )
    readRecipient = await signInWithMagicLink(
      convex,
      uniqueEmail('agent-replication-read-recipient'),
      'Read Recipient',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('accept seeds exact-root and nested agents at translated recipient anchors', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-seed-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'agent-seed-recipient')
    const root = await registerAgent(owner, originWorkspaceId, 'project', 'root-agent')
    const nested = await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const share = await createShare(owner, originWorkspaceId, recipient.user.email, 'project')

    await acceptShare(recipient, share.id, recipientWorkspaceId, 'shared/project')

    const replicas = await listAgents(recipient, recipientWorkspaceId)
    expect(replicas).toEqual([
      expect.objectContaining({
        slug: 'research',
        anchorPath: 'shared/project/research',
        sourceShareId: share.id,
        sourceAgentId: nested.id,
      }),
      expect.objectContaining({
        slug: 'root-agent',
        anchorPath: 'shared/project',
        sourceShareId: share.id,
        sourceAgentId: root.id,
      }),
    ])
    expect(
      await query(recipient.client, 'domains/anchors/model:getById', {
        anchorId: replicas.find(agent => agent.sourceAgentId === root.id)!.anchorId,
      }),
    ).toMatchObject({ kind: 'share-mount', path: 'shared/project' })
    expect(replicas.find(agent => agent.sourceAgentId === root.id)!.anchorId).not.toBe(
      root.anchorId,
    )
  })

  test('origin metadata fans out and only write-mode replica edits write through', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-metadata-origin')
    const writeWorkspaceId = await createWorkspace(recipient, 'agent-metadata-write')
    const readWorkspaceId = await createWorkspace(readRecipient, 'agent-metadata-read')
    await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const writeShare = await createShare(
      owner,
      originWorkspaceId,
      recipient.user.email,
      'project',
      'write',
    )
    const readShare = await createShare(
      owner,
      originWorkspaceId,
      readRecipient.user.email,
      'project',
      'read',
    )
    await acceptShare(recipient, writeShare.id, writeWorkspaceId, 'write/project')
    await acceptShare(readRecipient, readShare.id, readWorkspaceId, 'read/project')

    await mutate(owner.client, 'domains/agents/model:updateAgent', {
      workspaceId: originWorkspaceId,
      slug: 'research',
      name: 'Origin Rename',
      icon: 'icons/origin.png',
      now: NOW + 2,
    })
    expect((await listAgents(recipient, writeWorkspaceId))[0]).toMatchObject({
      name: 'Origin Rename',
      icon: 'icons/origin.png',
    })
    expect((await listAgents(readRecipient, readWorkspaceId))[0]).toMatchObject({
      name: 'Origin Rename',
      icon: 'icons/origin.png',
    })

    await mutate(recipient.client, 'domains/agents/model:updateAgent', {
      workspaceId: writeWorkspaceId,
      slug: 'research',
      name: 'Edited Through Replica',
      now: NOW + 3,
    })
    expect((await listAgents(owner, originWorkspaceId))[0]?.name).toBe('Edited Through Replica')
    expect((await listAgents(readRecipient, readWorkspaceId))[0]?.name).toBe(
      'Edited Through Replica',
    )
    await expect(
      mutate(readRecipient.client, 'domains/agents/model:updateAgent', {
        workspaceId: readWorkspaceId,
        slug: 'research',
        name: 'Forbidden',
      }),
    ).rejects.toThrow('Replica agents are read-only')
  })

  test('onboarding completion is per-workspace and never crosses the share', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'ao-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'ao-recip')
    await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const share = await createShare(
      owner,
      originWorkspaceId,
      recipient.user.email,
      'project',
      'write',
    )
    await acceptShare(recipient, share.id, recipientWorkspaceId, 'shared/project')

    // The origin completes its own onboarding. The recipient is a different
    // person in a different workspace who has not been onboarded by anyone.
    await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId: originWorkspaceId,
      slug: 'research',
      onboarded: true,
      now: NOW + 2,
    })
    expect((await listAgents(owner, originWorkspaceId))[0]?.onboardedAt).toBe(NOW + 2)
    expect((await listAgents(recipient, recipientWorkspaceId))[0]?.onboardedAt).toBeUndefined()

    // A replica IS onboardable by its recipient — unlike rename, which writes
    // through, and unlike delete, which a replica may not do at all.
    await mutate(recipient.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId: recipientWorkspaceId,
      slug: 'research',
      onboarded: true,
      now: NOW + 3,
    })
    expect((await listAgents(recipient, recipientWorkspaceId))[0]?.onboardedAt).toBe(NOW + 3)
    expect((await listAgents(owner, originWorkspaceId))[0]?.onboardedAt).toBe(NOW + 2)

    // An origin metadata edit fans out to the replica; it must not drag the
    // origin's onboarding state along with the fields it does own.
    await mutate(owner.client, 'domains/agents/model:updateAgent', {
      workspaceId: originWorkspaceId,
      slug: 'research',
      name: 'Origin Rename',
      now: NOW + 4,
    })
    expect((await listAgents(recipient, recipientWorkspaceId))[0]).toMatchObject({
      name: 'Origin Rename',
      onboardedAt: NOW + 3,
    })
  })

  test('disabled replicas stay pinned until re-enabled, then resume origin convergence', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-disabled-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'agent-disabled-recipient')
    await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const share = await createShare(
      owner,
      originWorkspaceId,
      recipient.user.email,
      'project',
      'read',
    )
    await acceptShare(recipient, share.id, recipientWorkspaceId, 'shared/project')

    const disabled = (await mutate(recipient.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId: recipientWorkspaceId,
      slug: 'research',
      disabled: true,
      now: NOW + 2,
    })) as Agent
    await mutate(owner.client, 'domains/agents/model:updateAgent', {
      workspaceId: originWorkspaceId,
      slug: 'research',
      name: 'Skipped While Disabled',
      now: NOW + 3,
    })

    expect((await listAgents(recipient, recipientWorkspaceId))[0]).toMatchObject({
      id: disabled.id,
      disabledAt: NOW + 2,
      name: 'research',
    })

    await mutate(recipient.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId: recipientWorkspaceId,
      slug: 'research',
      disabled: false,
      now: NOW + 4,
    })
    await mutate(owner.client, 'domains/agents/model:updateAgent', {
      workspaceId: originWorkspaceId,
      slug: 'research',
      name: 'Converged After Enable',
      now: NOW + 5,
    })

    expect((await listAgents(recipient, recipientWorkspaceId))[0]).toMatchObject({
      id: disabled.id,
      name: 'Converged After Enable',
    })
    expect((await listAgents(recipient, recipientWorkspaceId))[0]).not.toHaveProperty('disabledAt')
  })

  test('agent-at-root and nested app use distinct anchors; collision suffixes and unlink localizes the mount', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-unlink-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'agent-unlink-recipient')
    const origin = await registerAgent(owner, originWorkspaceId, 'project', 'research')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: originWorkspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
      now: NOW,
    })
    await registerAgent(recipient, recipientWorkspaceId, 'local/research', 'research')
    const share = await createShare(owner, originWorkspaceId, recipient.user.email, 'project')
    await acceptShare(recipient, share.id, recipientWorkspaceId, 'shared/project')

    const replica = (await listAgents(recipient, recipientWorkspaceId)).find(
      agent => agent.sourceAgentId === origin.id,
    )!
    expect(replica).toMatchObject({ slug: 'research-2', anchorPath: 'shared/project' })
    const apps = (await query(recipient.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: recipientWorkspaceId,
    })) as Array<{ anchorId: string; anchorPath: string; sourceShareId?: string }>
    const nestedApp = apps.find(app => app.sourceShareId === share.id)!
    expect(nestedApp).toMatchObject({ anchorPath: 'shared/project/web' })
    expect(nestedApp.anchorId).not.toBe(replica.anchorId)

    await mutate(recipient.client, 'domains/shares/model:unlinkShare', {
      shareId: share.id,
      toWorkspaceId: recipientWorkspaceId,
      now: NOW + 2,
    })
    const localized = (await listAgents(recipient, recipientWorkspaceId)).find(
      agent => agent.id === replica.id,
    )!
    expect(localized.sourceShareId).toBeUndefined()
    expect(localized.sourceAgentId).toBeUndefined()
    expect(
      await query(recipient.client, 'domains/anchors/model:getById', {
        anchorId: localized.anchorId,
      }),
    ).toMatchObject({ kind: 'agent', path: 'shared/project', settings: {} })
  })

  test('origin anchor break and reanchor delete then recreate the recipient replica', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-anchor-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'agent-anchor-recipient')
    const origin = await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const share = await createShare(owner, originWorkspaceId, recipient.user.email, 'project')
    await acceptShare(recipient, share.id, recipientWorkspaceId, 'shared/project')
    const firstReplica = (await listAgents(recipient, recipientWorkspaceId))[0]!

    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: origin.anchorId,
      now: NOW + 2,
    })
    expect(await listAgents(recipient, recipientWorkspaceId)).toEqual([])
    expect(
      await query(recipient.client, 'domains/anchors/model:getById', {
        anchorId: firstReplica.anchorId,
      }),
    ).toBeNull()

    await mutate(owner.client, 'domains/anchors/model:reanchor', {
      anchorId: origin.anchorId,
      path: 'project/research',
      now: NOW + 3,
    })
    const recreated = (await listAgents(recipient, recipientWorkspaceId))[0]!
    expect(recreated).toMatchObject({
      anchorPath: 'shared/project/research',
      sourceAgentId: origin.id,
    })
    expect(recreated.id).not.toBe(firstReplica.id)
  })

  test('reshare materializes once per share; revoke and origin delete remove replicas', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-delete-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'agent-delete-recipient')
    const childWorkspaceId = await createWorkspace(readRecipient, 'agent-delete-child')
    const origin = await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const root = await createShare(owner, originWorkspaceId, recipient.user.email, 'project')
    await acceptShare(recipient, root.id, recipientWorkspaceId, 'shared/project')
    const childResult = (await mutate(recipient.client, 'testing/shares:reshareForTest', {
      internalKey: INTERNAL_KEY,
      parentShareId: root.id,
      fromWorkspaceId: recipientWorkspaceId,
      toEmail: readRecipient.user.email,
      mode: 'read',
      now: NOW + 2,
    })) as { share: { id: string } }
    await acceptShare(readRecipient, childResult.share.id, childWorkspaceId, 'reshared/project')

    expect(await listAgents(recipient, recipientWorkspaceId)).toEqual([
      expect.objectContaining({
        sourceAgentId: origin.id,
        sourceShareId: root.id,
        slug: origin.slug,
        anchorPath: 'shared/project/research',
      }),
    ])
    expect(await listAgents(readRecipient, childWorkspaceId)).toEqual([
      expect.objectContaining({
        sourceAgentId: origin.id,
        sourceShareId: childResult.share.id,
        slug: origin.slug,
        anchorPath: 'reshared/project/research',
      }),
    ])

    await mutate(owner.client, 'domains/shares/model:revokeShare', {
      shareId: root.id,
      fromWorkspaceId: originWorkspaceId,
      now: NOW + 3,
    })
    expect(await listAgents(recipient, recipientWorkspaceId)).toEqual([])
    expect(await listAgents(readRecipient, childWorkspaceId)).toEqual([])

    const second = await registerAgent(owner, originWorkspaceId, 'other/research', 'other')
    const secondShare = await createShare(owner, originWorkspaceId, recipient.user.email, 'other')
    await acceptShare(recipient, secondShare.id, recipientWorkspaceId, 'shared/other')
    const secondReplica = (await listAgents(recipient, recipientWorkspaceId))[0]!
    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId: originWorkspaceId,
      slug: second.slug,
      now: NOW + 4,
    })
    expect(await listAgents(recipient, recipientWorkspaceId)).toEqual([])
    expect(
      await query(recipient.client, 'domains/anchors/model:getById', {
        anchorId: secondReplica.anchorId,
      }),
    ).toBeNull()
  })

  test('accept rejects replica fan-out at the recipient agent cap', async () => {
    const originWorkspaceId = await createWorkspace(owner, 'agent-cap-origin')
    const recipientWorkspaceId = await createWorkspace(recipient, 'agent-cap-recipient')
    await registerAgent(owner, originWorkspaceId, 'project/research', 'research')
    const fillerAnchor = await mutate(recipient.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: recipientWorkspaceId,
      path: 'local/filler',
      kind: 'agent',
      settings: {},
      now: NOW,
    })
    await mutate(convex, 'testing/agents:fillWorkspaceAgentsForLimitTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: recipientWorkspaceId,
      anchorId: (fillerAnchor as { id: string }).id,
      createdByUserId: recipient.user._id,
      count: MAX_AGENTS_PER_WORKSPACE,
      prefix: 'filler',
      now: NOW,
    })
    const share = await createShare(owner, originWorkspaceId, recipient.user.email, 'project')

    await expect(
      acceptShare(recipient, share.id, recipientWorkspaceId, 'shared/project'),
    ).rejects.toThrow('Workspace agent limit exceeded')
  })
})

async function createWorkspace(user: SignedInUser, prefix: string): Promise<string> {
  await mutate(user.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const workspaceId = (await mutate(user.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `${prefix}-${Date.now()}-${++sequence}`,
    name: prefix,
  })) as string
  await mutate(user.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: NOW,
  })
  return workspaceId
}

async function registerAgent(
  user: SignedInUser,
  workspaceId: string,
  path: string,
  slug: string,
): Promise<Agent> {
  return (await mutate(user.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path,
    slug,
    now: NOW,
  })) as Agent
}

async function createShare(
  user: SignedInUser,
  fromWorkspaceId: string,
  toEmail: string,
  path: string,
  mode: 'read' | 'write' = 'write',
): Promise<{ id: string }> {
  const result = (await mutate(user.client, 'testing/shares:createShareForTest', {
    internalKey: INTERNAL_KEY,
    fromWorkspaceId,
    toEmail,
    path,
    mode,
    now: NOW,
  })) as { share: { id: string } }
  return result.share
}

async function acceptShare(
  user: SignedInUser,
  shareId: string,
  toWorkspaceId: string,
  mountPath: string,
): Promise<void> {
  await mutate(user.client, 'domains/shares/model:acceptShare', {
    shareId,
    toWorkspaceId,
    mountPath,
    now: NOW + 1,
  })
}

async function listAgents(user: SignedInUser, workspaceId: string): Promise<Agent[]> {
  return (await query(user.client, 'domains/agents/model:listByWorkspace', {
    workspaceId,
  })) as Agent[]
}

interface SignedInUser {
  client: ConvexHttpClient
  user: { _id: string; email: string }
}
