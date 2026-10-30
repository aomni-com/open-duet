import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

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
const INTERNAL_KEY = 'test-api-internal-key'

let convex: ConvexDevFixture
let owner: SignedInUser
let recipient: SignedInUser
let sequence = 0

// Compatible consumers share a durable path identity; the last consumer's
// deletion orphans it, and recipient share mounts cannot become origins.
describe('publish anchor coexistence matrix', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('coexist-owner'),
      'Coexist Owner',
    )
    recipient = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('coexist-recipient'),
      'Coexist Recipient',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  // --- Group A: order-independent pair coexistence -------------------------
  // For every allowed {existing-kind × new-consumer} pair, in both creation
  // orders, the second creator adopts the first creator's anchor: same id, and
  // the anchor's kind/settings/updatedAt are untouched (no rewrite).

  test('app then publish share one anchor; the app kind and settings survive', async () => {
    const workspaceId = await createWorkspace('a-app-publish')
    const app = await registerAppAt(owner, workspaceId, 'project', 'project-app')
    const before = await getAnchor(owner, app.anchorId)

    const publish = await createPublishAt(owner, workspaceId, 'project')

    expect(publish.anchorId).toBe(app.anchorId)
    expect(await getAnchor(owner, app.anchorId)).toEqual(before)
    expect(before).toMatchObject({
      kind: 'app',
      settings: {},
      state: 'active',
    })
  })

  test('publish then app share one anchor; the publish kind and settings survive', async () => {
    const workspaceId = await createWorkspace('a-publish-app')
    const publish = await createPublishAt(owner, workspaceId, 'project')
    const before = await getAnchor(owner, publish.anchorId)

    const app = await registerAppAt(owner, workspaceId, 'project', 'project-app')

    expect(app.anchorId).toBe(publish.anchorId)
    expect(await getAnchor(owner, publish.anchorId)).toEqual(before)
    expect(before).toMatchObject({
      kind: 'publish',
      settings: { kind: 'folder' },
      state: 'active',
    })
  })

  test('agent then publish share one anchor; the agent kind and settings survive', async () => {
    const workspaceId = await createWorkspace('a-agent-publish')
    const agent = await registerAgentAt(owner, workspaceId, 'research', 'research-agent')
    const before = await getAnchor(owner, agent.anchorId)

    const publish = await createPublishAt(owner, workspaceId, 'research')

    expect(publish.anchorId).toBe(agent.anchorId)
    expect(await getAnchor(owner, agent.anchorId)).toEqual(before)
    expect(before).toMatchObject({ kind: 'agent', state: 'active' })
  })

  test('publish then agent share one anchor; the publish kind and settings survive', async () => {
    const workspaceId = await createWorkspace('a-publish-agent')
    const publish = await createPublishAt(owner, workspaceId, 'research')
    const before = await getAnchor(owner, publish.anchorId)

    const agent = await registerAgentAt(owner, workspaceId, 'research', 'research-agent')

    expect(agent.anchorId).toBe(publish.anchorId)
    expect(await getAnchor(owner, publish.anchorId)).toEqual(before)
    expect(before).toMatchObject({ kind: 'publish', settings: { kind: 'folder' } })
  })

  test('pending share-root then publish share one anchor; the share-root kind survives', async () => {
    const workspaceId = await createWorkspace('a-share-publish')
    const share = await createPendingShareAt(workspaceId, 'notes')
    const before = await getAnchor(owner, share.anchorId)

    const publish = await createPublishAt(owner, workspaceId, 'notes')

    expect(publish.anchorId).toBe(share.anchorId)
    expect(await getAnchor(owner, share.anchorId)).toEqual(before)
    expect(before).toMatchObject({ kind: 'share-root', settings: {}, state: 'active' })
  })

  test('publish then pending share-root share one anchor; the publish kind survives', async () => {
    const workspaceId = await createWorkspace('a-publish-share')
    const publish = await createPublishAt(owner, workspaceId, 'notes')
    const before = await getAnchor(owner, publish.anchorId)

    const share = await createPendingShareAt(workspaceId, 'notes')

    expect(share.anchorId).toBe(publish.anchorId)
    expect(await getAnchor(owner, publish.anchorId)).toEqual(before)
    expect(before).toMatchObject({ kind: 'publish', settings: { kind: 'folder' } })
  })

  test('app and pending share-root still coexist on one anchor (both orders)', async () => {
    const forward = await createWorkspace('a-app-share')
    const app = await registerAppAt(owner, forward, 'site', 'site-app')
    const share = await createPendingShareAt(forward, 'site')
    expect(share.anchorId).toBe(app.anchorId)
    expect(await getAnchor(owner, app.anchorId)).toMatchObject({ kind: 'app' })

    const reverse = await createWorkspace('a-share-app')
    const share2 = await createPendingShareAt(reverse, 'site')
    const app2 = await registerAppAt(owner, reverse, 'site', 'site-app')
    expect(app2.anchorId).toBe(share2.anchorId)
    expect(await getAnchor(owner, share2.anchorId)).toMatchObject({ kind: 'share-root' })
  })

  test('agent and pending share-root still coexist on one anchor (both orders)', async () => {
    const forward = await createWorkspace('a-agent-share')
    const agent = await registerAgentAt(owner, forward, 'team', 'team-agent')
    const share = await createPendingShareAt(forward, 'team')
    expect(share.anchorId).toBe(agent.anchorId)
    expect(await getAnchor(owner, agent.anchorId)).toMatchObject({ kind: 'agent' })

    const reverse = await createWorkspace('a-share-agent')
    const share2 = await createPendingShareAt(reverse, 'team')
    const agent2 = await registerAgentAt(owner, reverse, 'team', 'team-agent')
    expect(agent2.anchorId).toBe(share2.anchorId)
    expect(await getAnchor(owner, share2.anchorId)).toMatchObject({ kind: 'share-root' })
  })

  // --- Group B: idempotence ------------------------------------------------

  test('duplicate createPublish returns the same row and adds no second anchor', async () => {
    const workspaceId = await createWorkspace('b-publish-idem')
    const first = await createPublishAt(owner, workspaceId, 'project')
    const second = await createPublishAt(owner, workspaceId, 'project')

    expect(second.id).toBe(first.id)
    expect(second.anchorId).toBe(first.anchorId)
    const publishes = (await query(owner.client, 'domains/publishes/model:listByWorkspace', {
      workspaceId,
    })) as Array<{ id: string }>
    expect(publishes.map(p => p.id)).toEqual([first.id])
  })

  test('re-registering an app that shares a publish anchor keeps the one shared anchor', async () => {
    const workspaceId = await createWorkspace('b-app-idem')
    const publish = await createPublishAt(owner, workspaceId, 'project')
    const app = await registerAppAt(owner, workspaceId, 'project', 'project-app')
    const appAgain = await registerAppAt(owner, workspaceId, 'project', 'project-app')

    expect(app.anchorId).toBe(publish.anchorId)
    expect(appAgain.id).toBe(app.id)
    expect(appAgain.anchorId).toBe(publish.anchorId)
    const apps = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as Array<{ id: string; anchorId: string }>
    expect(apps.map(a => a.id)).toEqual([app.id])
  })

  // --- Group C: share-mount is rejected by every creator -------------------

  test('no creator can adopt a share-mount anchor', async () => {
    const originId = await createWorkspace('c-mount-origin')
    const recipientId = await createWorkspace('c-mount-recipient')
    // Both workspaces belong to `owner`; the share is accepted into the second
    // one to materialize a `share-mount` anchor there.
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'proj',
      mode: 'write',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipientId,
      mountPath: 'mounts/proj',
    })
    const mount = (await query(owner.client, 'domains/anchors/model:getByPath', {
      workspaceId: recipientId,
      path: 'mounts/proj',
    })) as AnchorRow
    expect(mount.kind).toBe('share-mount')

    await expectRejects(
      mutate(owner.client, 'domains/publishes/model:createPublish', {
        workspaceId: recipientId,
        path: 'mounts/proj',
        kind: 'folder',
      }),
    )
    await expectRejects(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId: recipientId,
        path: 'mounts/proj',
        command: 'bun run start',
        apiScopes: [],
        slug: 'mount-app',
      }),
    )
    await expectRejects(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: recipientId,
        path: 'mounts/proj',
        slug: 'mount-agent',
      }),
    )
    await expectRejects(
      mutate(owner.client, 'testing/shares:createShareForTest', {
        internalKey: INTERNAL_KEY,
        fromWorkspaceId: recipientId,
        toEmail: recipient.user.email,
        path: 'mounts/proj',
        mode: 'read',
      }),
    )

    // The mount anchor is untouched and no consumer leaked onto it.
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: mount.id }),
    ).toMatchObject({ id: mount.id, kind: 'share-mount', state: 'active' })
    expect(
      await query(owner.client, 'domains/publishes/model:listByWorkspace', {
        workspaceId: recipientId,
      }),
    ).toEqual([])
  })

  // --- Group D: orphan revival ---------------------------------------------

  test('deleting the last consumer orphans the anchor; re-registering reuses its id', async () => {
    const workspaceId = await createWorkspace('d-revive')
    const publish = await createPublishAt(owner, workspaceId, 'project')
    await mutate(owner.client, 'domains/publishes/model:deletePublish', {
      workspaceId,
      slug: publish.slug,
    })
    expect(await getAnchor(owner, publish.anchorId)).toMatchObject({ state: 'orphaned' })

    const revived = await createPublishAt(owner, workspaceId, 'project')
    expect(revived.anchorId).toBe(publish.anchorId)
    expect(await getAnchor(owner, publish.anchorId)).toMatchObject({
      state: 'active',
      kind: 'publish',
    })
  })

  test('an orphaned publish anchor can be revived by a different consumer kind', async () => {
    const workspaceId = await createWorkspace('d-revive-cross')
    const publish = await createPublishAt(owner, workspaceId, 'project')
    await mutate(owner.client, 'domains/publishes/model:deletePublish', {
      workspaceId,
      slug: publish.slug,
    })
    expect(await getAnchor(owner, publish.anchorId)).toMatchObject({ state: 'orphaned' })

    const app = await registerAppAt(owner, workspaceId, 'project', 'project-app')
    expect(app.anchorId).toBe(publish.anchorId)
    expect(await getAnchor(owner, publish.anchorId)).toMatchObject({ state: 'active', kind: 'app' })
  })

  // --- Group E: delete-order permutations vs anchorHasLiveConsumer ---------

  test('publish+app: the anchor stays active until the last consumer is deleted', async () => {
    // Delete the publish first, then the app.
    const wsA = await createWorkspace('e-order-pub-first')
    const pubA = await createPublishAt(owner, wsA, 'project')
    const appA = await registerAppAt(owner, wsA, 'project', 'project-app')
    expect(appA.anchorId).toBe(pubA.anchorId)
    await mutate(owner.client, 'domains/publishes/model:deletePublish', {
      workspaceId: wsA,
      slug: pubA.slug,
    })
    // The app still holds the anchor active; its kind stays the creator's (publish).
    expect(await getAnchor(owner, pubA.anchorId)).toMatchObject({
      state: 'active',
      kind: 'publish',
    })
    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: wsA,
      slug: 'project-app',
    })
    expect(await getAnchor(owner, pubA.anchorId)).toMatchObject({ state: 'orphaned' })

    // Reverse order: delete the app first, then the publish.
    const wsB = await createWorkspace('e-order-app-first')
    const pubB = await createPublishAt(owner, wsB, 'project')
    const appB = await registerAppAt(owner, wsB, 'project', 'project-app')
    expect(appB.anchorId).toBe(pubB.anchorId)
    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: wsB,
      slug: 'project-app',
    })
    expect(await getAnchor(owner, pubB.anchorId)).toMatchObject({
      state: 'active',
      kind: 'publish',
    })
    await mutate(owner.client, 'domains/publishes/model:deletePublish', {
      workspaceId: wsB,
      slug: pubB.slug,
    })
    expect(await getAnchor(owner, pubB.anchorId)).toMatchObject({ state: 'orphaned' })
  })

  test('publish + pending share coexist; the anchor survives until both are gone', async () => {
    const workspaceId = await createWorkspace('e-publish-pending-share')
    const publish = await createPublishAt(owner, workspaceId, 'notes')
    const share = await createPendingShareAt(workspaceId, 'notes')
    expect(share.anchorId).toBe(publish.anchorId)

    // Deleting the publish leaves the pending share holding the anchor active.
    await mutate(owner.client, 'domains/publishes/model:deletePublish', {
      workspaceId,
      slug: publish.slug,
    })
    // The pending share still holds the anchor active; kind stays the creator's (publish).
    expect(await getAnchor(owner, publish.anchorId)).toMatchObject({
      state: 'active',
      kind: 'publish',
    })

    // Revoking the last (pending) share finally orphans it.
    await mutate(owner.client, 'domains/shares/model:revokeShare', {
      shareId: share.id,
      fromWorkspaceId: workspaceId,
    })
    expect(await getAnchor(owner, publish.anchorId)).toMatchObject({ state: 'orphaned' })
  })
})

// --- helpers ---------------------------------------------------------------

async function createPublishAt(
  user: SignedInUser,
  workspaceId: string,
  path: string,
): Promise<{ id: string; anchorId: string; slug: string }> {
  return (await mutate(user.client, 'domains/publishes/model:createPublish', {
    workspaceId,
    path,
    kind: 'folder',
  })) as { id: string; anchorId: string; slug: string }
}

async function registerAppAt(
  user: SignedInUser,
  workspaceId: string,
  path: string,
  slug: string,
): Promise<{ id: string; anchorId: string }> {
  return (await mutate(user.client, 'domains/apps/model:registerApp', {
    workspaceId,
    path,
    command: 'bun run start',
    apiScopes: [],
    slug,
  })) as { id: string; anchorId: string }
}

async function registerAgentAt(
  user: SignedInUser,
  workspaceId: string,
  path: string,
  slug: string,
): Promise<{ id: string; anchorId: string }> {
  return (await mutate(user.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path,
    slug,
  })) as { id: string; anchorId: string }
}

// A freshly created (un-accepted) share is 'pending', which `anchorHasLiveConsumer`
// counts as a live origin consumer on the share-root anchor.
async function createPendingShareAt(
  workspaceId: string,
  path: string,
): Promise<{ id: string; anchorId: string }> {
  const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
    internalKey: INTERNAL_KEY,
    fromWorkspaceId: workspaceId,
    toEmail: recipient.user.email,
    path,
    mode: 'read',
  })) as { share: { id: string; anchorId: string } }
  return created.share
}

async function getAnchor(user: SignedInUser, anchorId: string): Promise<AnchorRow> {
  const anchor = (await query(user.client, 'domains/anchors/model:getById', {
    anchorId,
  })) as AnchorRow | null
  if (anchor === null) throw new Error(`anchor ${anchorId} not found`)
  return anchor
}

async function expectRejects(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow('Anchor path is not')
}

async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} Workspace`,
  })) as string
  await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  return workspaceId
}

function uniqueSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
  name?: string
}

interface AnchorRow {
  id: string
  workspaceId: string
  path: string
  kind: 'app' | 'agent' | 'publish' | 'share-root' | 'share-mount'
  settings: unknown
  state: 'active' | 'broken' | 'orphaned'
  createdAt: number
  updatedAt: number
}
