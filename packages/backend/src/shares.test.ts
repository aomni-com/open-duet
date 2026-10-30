import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import {
  DEFAULT_SHARE_IGNORE_PATTERNS,
  MAX_ACTIVE_SHARES_PER_WORKSPACE,
  MAX_SHARE_USER_IGNORE_PATTERNS,
  type ShareRequest,
} from '@repo/contract'
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
const NOW = 100_000

let convex: ConvexDevFixture
let alice: SignedInUser
let bob: SignedInUser
let cara: SignedInUser
let sequence = 0

describe('email-addressed shares backend domain', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_EDGE_INTERNAL_KEY: 'edge-secret',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    alice = await signInWithMagicLink<UserRow>(convex, uniqueEmail('shares-alice'), 'Shares Alice')
    bob = await signInWithMagicLink<UserRow>(convex, uniqueEmail('shares-bob'), 'Shares Bob')
    cara = await signInWithMagicLink<UserRow>(convex, uniqueEmail('shares-cara'), 'Shares Cara')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('normalizes recipient email, returns the raw token only transiently, and dedupes an active root', async () => {
    const a = await createWorkspace(alice, 'dedupe-a')
    const created = await createShare(alice, a, `  ${bob.user.email.toUpperCase()}  `, 'project')

    expect(created).toMatchObject({
      toEmail: bob.user.email,
      fromWorkspaceId: a,
      state: 'pending',
    })
    expect(created.tokenPrefix).toStartWith('duet_share_')
    expect(created.invitationToken).toStartWith(created.tokenPrefix)
    expect(JSON.stringify(await rawShares())).not.toContain(created.invitationToken)

    await expect(createShare(alice, a, bob.user.email, 'project')).rejects.toThrow(
      'An active share already exists',
    )
  })

  test('creates a share for an explicit actor without Convex auth state', async () => {
    const a = await createWorkspace(alice, 'explicit-actor')
    const created = (await mutate(convex.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      actorId: alice.user._id,
      fromWorkspaceId: a,
      toEmail: bob.user.email,
      path: 'project',
      mode: 'read',
      now: NOW,
    })) as { share: ShareRow }

    expect(created.share).toMatchObject({
      createdByUserId: alice.user._id,
      fromWorkspaceId: a,
      toEmail: bob.user.email,
      state: 'pending',
    })
  })

  test('refuses the next activation when incoming and outgoing shares fill one workspace budget', async () => {
    const origin = await createWorkspace(alice, 'share-cap-origin')
    const full = await createWorkspace(bob, 'share-cap-full')
    const peer = await createWorkspace(cara, 'share-cap-peer')
    const existing = await createShare(bob, full, cara.user.email, 'capacity-root', NOW)
    const originPending = await createShare(alice, origin, bob.user.email, 'capacity-new', NOW)
    await acceptShare(cara, existing.id, peer, 'capacity/mount', NOW + 1)
    const accepted = (await rawShares()).find(share => share.id === existing.id)
    if (accepted?.mountAnchorId === undefined) throw new Error('Fixture share has no mount anchor')

    await mutate(convex.client, 'testing/shares:seedActiveShareCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: full,
      peerWorkspaceId: peer,
      anchorId: existing.anchorId,
      mountAnchorId: accepted.mountAnchorId,
      actorId: bob.user._id,
      outgoing: MAX_ACTIVE_SHARES_PER_WORKSPACE / 2 - 1,
      incoming: MAX_ACTIVE_SHARES_PER_WORKSPACE / 2,
      now: NOW + 2,
    })

    await expect(
      acceptShare(bob, originPending.id, full, 'capacity/next', NOW + 3),
    ).rejects.toThrow('Workspace active share limit exceeded')
    expect((await rawShares()).find(share => share.id === originPending.id)?.state).toBe('pending')
  })

  test('internal share creation refuses ignore lists that cannot fit a full page', async () => {
    const workspaceId = await createWorkspace(alice, 'ignore-bounds')
    const before = await rawShares()
    await expect(
      mutate(convex.client, 'testing/shares:createShareForTest', {
        internalKey: INTERNAL_KEY,
        actorId: alice.user._id,
        fromWorkspaceId: workspaceId,
        toEmail: bob.user.email,
        path: 'project',
        mode: 'read',
        ignorePatterns: Array.from(
          { length: MAX_SHARE_USER_IGNORE_PATTERNS + 1 },
          (_, index) => `pattern-${index}`,
        ),
        now: NOW,
      }),
    ).rejects.toThrow()
    expect(await rawShares()).toHaveLength(before.length)
  })

  test('a reshare inherits the complete bounded ignore list', async () => {
    const sourceWorkspaceId = await createWorkspace(alice, 'ignore-inherit-source')
    const recipientWorkspaceId = await createWorkspace(bob, 'ignore-inherit-recipient')
    const ignorePatterns = Array.from(
      { length: MAX_SHARE_USER_IGNORE_PATTERNS },
      (_, index) => `pattern-${index}`,
    )
    const created = (await mutate(alice.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: sourceWorkspaceId,
      toEmail: bob.user.email,
      path: 'project',
      mode: 'read',
      ignorePatterns,
      now: NOW,
    })) as { share: ShareRow }
    await acceptShare(bob, created.share.id, recipientWorkspaceId, 'shared/project', NOW + 1)

    const child = (await mutate(bob.client, 'testing/shares:reshareForTest', {
      internalKey: INTERNAL_KEY,
      parentShareId: created.share.id,
      fromWorkspaceId: recipientWorkspaceId,
      toEmail: cara.user.email,
      mode: 'read',
      now: NOW + 2,
    })) as { share: ShareRow }

    expect(child.share.ignorePatterns).toEqual([
      ...DEFAULT_SHARE_IGNORE_PATTERNS,
      ...ignorePatterns,
    ])
  })

  test('projects truthful source metadata and included apps to the recipient request', async () => {
    const a = await createWorkspace(alice, 'request-details')
    await mutate(alice.client, 'domains/apps/model:registerApp', {
      workspaceId: a,
      path: 'project/dashboard',
      command: 'bun run start',
      apiScopes: [],
      slug: 'dashboard',
    })
    await mutate(alice.client, 'domains/apps/model:registerApp', {
      workspaceId: a,
      path: 'elsewhere/notes',
      command: 'bun run start',
      apiScopes: [],
      slug: 'notes',
    })
    const share = await createShare(alice, a, bob.user.email, 'project')

    const pending = (await pendingSharePage(bob, NOW + 1)) as Array<{
      id: string
      source: {
        workspaceName: string
        path: string
        folderName: string
        sharerName: string
        originLive: boolean
        apps: Array<{ slug: string; path: string }>
      }
    }>
    expect(pending.find(candidate => candidate.id === share.id)?.source).toEqual({
      workspaceName: 'request-details',
      path: 'project',
      folderName: 'project',
      sharerName: alice.user.name ?? alice.user.email,
      originLive: true,
      apps: [{ slug: 'dashboard', path: 'project/dashboard' }],
    })
  })

  test('accept matches the signed-in email and chooses a live recipient workspace at consume time', async () => {
    const a = await createWorkspace(alice, 'accept-a')
    const b = await createWorkspace(bob, 'accept-b')
    const c = await createWorkspace(cara, 'accept-c')
    const share = await createShare(alice, a, bob.user.email, 'project')

    await expect(acceptShare(cara, share.id, c, 'shared/project')).rejects.toThrow(
      'Share recipient does not match',
    )

    const accepted = await acceptShare(bob, share.id, b, 'shared/project')
    expect(accepted).toMatchObject({
      toUserId: bob.user._id,
      toWorkspaceId: b,
      mountPath: 'shared/project',
      state: 'active',
    })
    const anchors = (await query(bob.client, 'domains/anchors/model:listByWorkspace', {
      workspaceId: b,
    })) as Array<{ kind: string; path: string }>
    expect(anchors).toContainEqual(
      expect.objectContaining({ kind: 'share-mount', path: 'shared/project' }),
    )
  })

  test('a mount path with an orphaned anchor accepts a new share', async () => {
    /* The tombstone rule, at the share door. An orphaned anchor claims
       nothing — a revoked share's old mount, a deleted agent, a reaped folder
       all leave one — and accept used to go through the bare anchor creator,
       which refuses ANY existing row with an untyped 500. Same defect that
       left an empty drive refusing its own install paths, one flow over. */
    const a = await createWorkspace(alice, 'remount-a')
    const b = await createWorkspace(bob, 'remount-b')
    await mutate(bob.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: b,
      path: 'shared/again',
      kind: 'agent',
      settings: {},
      state: 'orphaned',
    })

    const share = await createShare(alice, a, bob.user.email, 'project')
    const accepted = await acceptShare(bob, share.id, b, 'shared/again')

    expect(accepted).toMatchObject({ mountPath: 'shared/again', state: 'active' })
    const anchors = (await query(bob.client, 'domains/anchors/model:listByWorkspace', {
      workspaceId: b,
    })) as Array<{ kind: string; path: string; state: string }>
    expect(anchors).toContainEqual(
      expect.objectContaining({ kind: 'share-mount', path: 'shared/again', state: 'active' }),
    )
  })

  test('share roots and accepted mounts preserve literal percent identities', async () => {
    const sourceWorkspaceId = await createWorkspace(alice, 'percent-source')
    const recipientWorkspaceId = await createWorkspace(bob, 'percent-recipient')
    const share = await createShare(alice, sourceWorkspaceId, bob.user.email, 'projects/100%')

    const pending = (await pendingSharePage(bob, NOW + 1)) as ShareRequest[]
    expect(pending.find(candidate => candidate.id === share.id)?.source.path).toBe('projects/100%')

    const accepted = await acceptShare(bob, share.id, recipientWorkspaceId, 'shared/100%')
    expect(accepted.mountPath).toBe('shared/100%')
    expect(
      (await query(bob.client, 'domains/anchors/model:listByWorkspace', {
        workspaceId: recipientWorkspaceId,
      })) as Array<{ kind: string; path: string }>,
    ).toContainEqual(expect.objectContaining({ kind: 'share-mount', path: 'shared/100%' }))
  })

  test('share paths do not alias percent-looking filename bytes to separators', async () => {
    const sourceWorkspaceId = await createWorkspace(alice, 'encoded-source')
    const recipientWorkspaceId = await createWorkspace(bob, 'encoded-recipient')
    const share = await createShare(alice, sourceWorkspaceId, bob.user.email, 'projects/a%2Fb')

    const pending = (await pendingSharePage(bob, NOW + 1)) as ShareRequest[]
    expect(pending.find(candidate => candidate.id === share.id)?.source.path).toBe('projects/a%2Fb')

    const accepted = await acceptShare(bob, share.id, recipientWorkspaceId, 'shared/a%2Fb')
    expect(accepted.mountPath).toBe('shared/a%2Fb')
    expect(
      (await query(bob.client, 'domains/anchors/model:listByWorkspace', {
        workspaceId: recipientWorkspaceId,
      })) as Array<{ kind: string; path: string }>,
    ).toContainEqual(expect.objectContaining({ kind: 'share-mount', path: 'shared/a%2Fb' }))
  })

  test('either active participant pauses idempotently without changing share topology', async () => {
    const origin = await createWorkspace(alice, 'pause-origin')
    const recipient = await createWorkspace(bob, 'pause-recipient')
    const outsider = await createWorkspace(cara, 'pause-outsider')
    const pending = await createShare(alice, origin, bob.user.email, 'project')

    await expect(
      mutate(alice.client, 'domains/shares/model:setSharePaused', {
        shareId: pending.id,
        workspaceId: origin,
        paused: true,
        now: NOW + 1,
      }),
    ).rejects.toThrow('Share is not active')

    await acceptShare(bob, pending.id, recipient, 'shared/project')
    const before = (await rawShares()).find(share => share.id === pending.id)!
    const paused = (await mutate(alice.client, 'domains/shares/model:setSharePaused', {
      shareId: pending.id,
      workspaceId: origin,
      paused: true,
      now: NOW + 2,
    })) as ShareRow
    expect(paused.pausedAt).toBe(NOW + 2)

    const repeated = (await mutate(bob.client, 'domains/shares/model:setSharePaused', {
      shareId: pending.id,
      workspaceId: recipient,
      paused: true,
      now: NOW + 3,
    })) as ShareRow
    expect(repeated.pausedAt).toBe(NOW + 2)
    const afterRepeatedPause = (await rawShares()).find(share => share.id === pending.id)!
    expect(afterRepeatedPause).toMatchObject({
      state: 'active',
      anchorId: before.anchorId,
      fromWorkspaceId: before.fromWorkspaceId,
      toWorkspaceId: before.toWorkspaceId,
      mountPath: before.mountPath,
      mountAnchorId: before.mountAnchorId,
      sync: before.sync,
    })

    await expect(
      mutate(cara.client, 'domains/shares/model:setSharePaused', {
        shareId: pending.id,
        workspaceId: outsider,
        paused: false,
        now: NOW + 4,
      }),
    ).rejects.toThrow('Share workspace does not match')

    const resumed = (await mutate(bob.client, 'domains/shares/model:setSharePaused', {
      shareId: pending.id,
      workspaceId: recipient,
      paused: false,
      now: NOW + 5,
    })) as ShareRow
    expect(resumed.pausedAt).toBeUndefined()

    await mutate(alice.client, 'domains/shares/model:revokeShare', {
      shareId: pending.id,
      fromWorkspaceId: origin,
      now: NOW + 6,
    })
    await expect(
      mutate(bob.client, 'domains/shares/model:setSharePaused', {
        shareId: pending.id,
        workspaceId: recipient,
        paused: true,
        now: NOW + 7,
      }),
    ).rejects.toThrow('Share is not active')
  })

  test('the relocation probe seam patches the active share and its projection anchor', async () => {
    const a = await createWorkspace(alice, 'relocation-seam-a')
    const b = await createWorkspace(bob, 'relocation-seam-b')
    const share = await createShare(alice, a, bob.user.email, 'project')
    await acceptShare(bob, share.id, b, 'shared/old')

    await mutate(alice.client, 'testing/shares:patchShareMountPathForTest', {
      internalKey: INTERNAL_KEY,
      shareId: share.id,
      mountPath: 'shared/new',
    })

    expect((await rawShares()).find(candidate => candidate.id === share.id)).toMatchObject({
      state: 'active',
      mountPath: 'shared/new',
    })
    const anchors = (await query(bob.client, 'domains/anchors/model:listByWorkspace', {
      workspaceId: b,
    })) as Array<{ kind: string; path: string }>
    expect(anchors).toContainEqual(
      expect.objectContaining({ kind: 'share-mount', path: 'shared/new' }),
    )
    expect(anchors).not.toContainEqual(
      expect.objectContaining({ kind: 'share-mount', path: 'shared/old' }),
    )
  })

  test('lists management labels and paths without exposing the recipient mount path to the sharer', async () => {
    const a = await createWorkspace(alice, 'management-a')
    const b = await createWorkspace(bob, 'management-b')
    const share = await createShare(alice, a, bob.user.email, 'projects/launch')
    await acceptShare(bob, share.id, b, 'shared/launch')

    const sourceView = await workspaceSharePage(alice, a, NOW + 2)
    const outgoing = sourceView.filter(row => row.direction === 'outgoing')
    expect(outgoing).toContainEqual(
      expect.objectContaining({
        id: share.id,
        sourcePath: 'projects/launch',
      }),
    )
    expect(outgoing[0]).not.toHaveProperty('mountPath')

    const recipientView = await workspaceSharePage(bob, b, NOW + 2)
    expect(recipientView.filter(row => row.direction === 'incoming')).toContainEqual(
      expect.objectContaining({
        id: share.id,
        mountPath: 'shared/launch',
        sharerName: alice.user.name ?? alice.user.email,
        sourceWorkspaceName: 'management-a',
      }),
    )
  })

  test('projects both VM realizations against their private current generations', async () => {
    const a = await createWorkspace(alice, 'status-a')
    const b = await createWorkspace(bob, 'status-b')
    const share = await createShare(alice, a, bob.user.email, 'projects/status')
    await acceptShare(bob, share.id, b, 'shared/status')
    for (const [workspaceId, syncthingDeviceId] of [
      [a, 'device-origin'],
      [b, 'device-recipient'],
    ] as const) {
      await mutate(alice.client, 'testing/workspaces:setWorkspaceSyncthingDeviceIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        syncthingDeviceId,
      })
    }
    const generations = (await query(
      alice.client,
      'testing/shares:currentShareSyncGenerationsForTest',
      {
        internalKey: INTERNAL_KEY,
        shareId: share.id,
        now: NOW + 2,
      },
    )) as {
      origin: { generation: string }
      recipient: { generation: string }
    }
    await mutate(alice.client, 'testing/shares:upsertShareSyncRealizationForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: a,
      shareId: share.id,
      generation: 'stale-generation',
      state: 'ready',
      now: NOW + 3,
    })
    await mutate(alice.client, 'testing/shares:upsertShareSyncRealizationForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: b,
      shareId: share.id,
      generation: generations.recipient.generation,
      state: 'paused',
      now: NOW + 4,
    })

    const stale = await workspaceSharePage(alice, a, NOW + 5)
    expect(
      stale.find(row => row.id === share.id && row.direction === 'outgoing')?.syncStatus,
    ).toEqual({
      origin: {
        state: 'ready',
        matchesCurrentGeneration: false,
        updatedAt: NOW + 3,
      },
      recipient: {
        state: 'paused',
        matchesCurrentGeneration: true,
        updatedAt: NOW + 4,
      },
    })
    expect(JSON.stringify(stale)).not.toContain(generations.recipient.generation)

    await mutate(alice.client, 'testing/shares:upsertShareSyncRealizationForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: a,
      shareId: share.id,
      generation: generations.origin.generation,
      state: 'ready',
      now: NOW + 6,
    })
    const current = await workspaceSharePage(bob, b, NOW + 7)
    expect(
      current.find(row => row.id === share.id && row.direction === 'incoming')?.syncStatus,
    ).toEqual({
      origin: {
        state: 'ready',
        matchesCurrentGeneration: true,
        updatedAt: NOW + 6,
      },
      recipient: {
        state: 'paused',
        matchesCurrentGeneration: true,
        updatedAt: NOW + 4,
      },
    })
  })

  test('accept rejects a retired origin and nested linked roots', async () => {
    const a = await createWorkspace(alice, 'live-a')
    const b = await createWorkspace(bob, 'live-b')
    const first = await createShare(alice, a, bob.user.email, 'project-a')
    await acceptShare(bob, first.id, b, 'shared/project')
    const nested = await createShare(alice, a, bob.user.email, 'project-b')
    await expect(acceptShare(bob, nested.id, b, 'shared/project/nested')).rejects.toThrow(
      'Linked roots cannot contain each other',
    )

    await mutate(alice.client, 'domains/apps/model:registerApp', {
      workspaceId: a,
      path: 'app-root',
      command: 'bun run start',
      apiScopes: [],
      slug: 'root-app',
    })
    await createShare(alice, a, cara.user.email, 'app-root')
    await expect(createShare(alice, a, bob.user.email, 'app-root/nested')).rejects.toThrow(
      'Linked roots cannot contain each other',
    )

    const retired = await createShare(alice, a, cara.user.email, 'project-c')
    await mutate(alice.client, 'testing/workspaces:markWorkspaceVmTeardownLeakedForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: a,
      status: 'retired',
    })
    const c = await createWorkspace(cara, 'live-c')
    await expect(acceptShare(cara, retired.id, c, 'shared/retired')).rejects.toThrow(
      'Share origin is not live',
    )
  })

  test('decline is hidden from the recipient while outgoing remains pending for the sharer', async () => {
    const a = await createWorkspace(alice, 'decline-a')
    const share = await createShare(alice, a, bob.user.email, 'project')

    await mutate(bob.client, 'domains/shares/model:declineShare', {
      shareId: share.id,
      now: NOW + 1,
    })
    const pending = await pendingSharePage(bob, NOW + 2)
    expect(pending.some(candidate => candidate.id === share.id)).toBe(false)
    const listed = await workspaceSharePage(alice, a, NOW + 2)
    const outgoing = listed.filter(row => row.direction === 'outgoing')
    expect(outgoing).toContainEqual(expect.objectContaining({ id: share.id, state: 'pending' }))
    expect(outgoing[0]).not.toHaveProperty('mountPath')
  })

  test('expiry is derived from caller time and blocks consumption without a cron', async () => {
    const a = await createWorkspace(alice, 'expiry-a')
    const b = await createWorkspace(bob, 'expiry-b')
    const share = await createShare(alice, a, bob.user.email, 'project', NOW)

    const afterExpiry = share.expiresAt + 1
    const outgoing = await workspaceSharePage(alice, a, afterExpiry)
    expect(outgoing.find(row => row.direction === 'outgoing')?.state).toBe('expired')
    expect(await pendingSharePage(bob, afterExpiry)).toEqual([])
    await expect(acceptShare(bob, share.id, b, 'shared/project', afterExpiry)).rejects.toThrow(
      'Share request expired',
    )
  })

  test('workspace share pages traverse terminal history beyond the old management window', async () => {
    const outgoingWorkspace = await createWorkspace(alice, 'history-outgoing')
    const outgoingTemplate = await createShare(
      alice,
      outgoingWorkspace,
      cara.user.email,
      'historical',
      NOW,
    )
    const historicalIds = (await mutate(
      alice.client,
      'testing/shares:seedHistoricalSharesForTest',
      {
        internalKey: INTERNAL_KEY,
        templateShareId: outgoingTemplate.id,
        count: 501,
        state: 'revoked',
        expiresAt: NOW - 1,
      },
    )) as string[]
    const currentOutgoing = await createShare(
      alice,
      outgoingWorkspace,
      bob.user.email,
      'current',
      NOW,
    )
    expect(currentOutgoing).toMatchObject({ state: 'pending' })
    const recipientWorkspace = await createWorkspace(bob, 'history-recipient')
    await acceptShare(bob, currentOutgoing.id, recipientWorkspace, 'shared/current')
    const walked: Array<{ id: string; direction: string }> = []
    let cursor: string | null = null
    do {
      const page = (await query(alice.client, 'domains/shares/model:listForWorkspacePage', {
        workspaceId: outgoingWorkspace,
        now: NOW + 2,
        paginationOpts: { cursor, numItems: 100 },
      })) as {
        page: Array<{ id: string; direction: string }>
        continueCursor: string
        isDone: boolean
      }
      walked.push(...page.page)
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor !== null)

    expect(walked.map(row => row.id)).toEqual([
      ...historicalIds,
      ...[outgoingTemplate.id, currentOutgoing.id].sort(),
    ])
    expect(walked.every(row => row.direction === 'outgoing')).toBe(true)

    const inboxWorkspace = await createWorkspace(alice, 'history-inbox')
    const inboxTemplate = await createShare(
      alice,
      inboxWorkspace,
      bob.user.email,
      'expired',
      NOW - 8 * 24 * 60 * 60 * 1000,
    )
    await mutate(alice.client, 'testing/shares:seedHistoricalSharesForTest', {
      internalKey: INTERNAL_KEY,
      templateShareId: inboxTemplate.id,
      count: 501,
      state: 'pending',
      expiresAt: NOW - 1,
    })
    const current = await createShare(alice, inboxWorkspace, bob.user.email, 'visible', NOW)
    const pending = await pendingSharePage(bob, NOW + 1)
    expect(pending).toContainEqual(expect.objectContaining({ id: current.id }))
  })

  test('pending request pages traverse more than 500 live invitations', async () => {
    const pendingTemplate = await createShare(
      alice,
      await createWorkspace(alice, 'large-pending-source'),
      bob.user.email,
      'pending-template',
      NOW + 10_000,
    )
    const pendingIds = (await mutate(alice.client, 'testing/shares:seedPendingSharesForTest', {
      internalKey: INTERNAL_KEY,
      templateShareId: pendingTemplate.id,
      count: 501,
      createdAtStart: NOW + 20_000,
    })) as string[]
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const page = (await query(bob.client, 'domains/shares/model:listPendingForUserPage', {
        now: NOW + 1,
        paginationOpts: { cursor, numItems: 100 },
      })) as { page: Array<{ id: string }>; continueCursor: string; isDone: boolean }
      walked.push(...page.page.map(row => row.id))
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor !== null)
    const expected = [pendingTemplate.id, ...pendingIds]
    const expectedSet = new Set(expected)
    expect(walked.filter(id => expectedSet.has(id))).toEqual(expected)
  }, 120_000)

  test('pending request pages cap supporting app reads even when a larger page is requested', async () => {
    const pendingTemplate = await createShare(
      alice,
      await createWorkspace(alice, 'bounded-pending-source'),
      cara.user.email,
      'pending-template',
      NOW + 25_000,
    )
    await mutate(alice.client, 'testing/shares:seedPendingSharesForTest', {
      internalKey: INTERNAL_KEY,
      templateShareId: pendingTemplate.id,
      count: 10,
      createdAtStart: NOW + 26_000,
    })

    const page = (await query(cara.client, 'domains/shares/model:listPendingForUserPage', {
      now: NOW + 1,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: unknown[]; isDone: boolean }

    // One request can inspect the source workspace's full 100-app budget. The
    // page never multiplies that accepted per-workspace read across sources.
    expect(page.page).toHaveLength(1)
    expect(page.isDone).toBe(false)
  })

  test('pending request pages break equal creation times by share ID', async () => {
    const workspaceId = await createWorkspace(alice, 'pending-ties')
    const left = await createShare(alice, workspaceId, cara.user.email, 'left', NOW + 30_000)
    const right = await createShare(alice, workspaceId, cara.user.email, 'right', NOW + 30_000)
    const targetIds = new Set([left.id, right.id])
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const page = (await query(cara.client, 'domains/shares/model:listPendingForUserPage', {
        now: NOW + 1,
        paginationOpts: { cursor, numItems: 1 },
      })) as { page: Array<{ id: string }>; continueCursor: string; isDone: boolean }
      walked.push(...page.page.map(row => row.id).filter(id => targetIds.has(id)))
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor !== null)

    expect(walked).toEqual([left.id, right.id].sort())
  })

  test('a share accepted into its source workspace has two stable directory positions', async () => {
    const workspaceId = await createWorkspace(alice, 'same-workspace-share')
    const share = await createShare(alice, workspaceId, alice.user.email, 'source')
    await acceptShare(alice, share.id, workspaceId, 'received')

    const walked: Array<{ id: string; direction: string }> = []
    let cursor: string | null = null
    do {
      const page = (await query(alice.client, 'domains/shares/model:listForWorkspacePage', {
        workspaceId,
        now: NOW + 2,
        paginationOpts: { cursor, numItems: 1 },
      })) as {
        page: Array<{ id: string; direction: string }>
        continueCursor: string
        isDone: boolean
      }
      walked.push(...page.page)
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor !== null)

    expect(walked.map(row => [row.id, row.direction])).toEqual([
      [share.id, 'incoming'],
      [share.id, 'outgoing'],
    ])
  })

  test('mixed incoming and outgoing history walks past 500 rows without omissions', async () => {
    const workspaceId = await createWorkspace(alice, 'mixed-history')
    const template = await createShare(alice, workspaceId, alice.user.email, 'source')
    await acceptShare(alice, template.id, workspaceId, 'received')
    const historicalIds = (await mutate(
      alice.client,
      'testing/shares:seedHistoricalSharesForTest',
      {
        internalKey: INTERNAL_KEY,
        templateShareId: template.id,
        count: 501,
        state: 'revoked',
        expiresAt: NOW - 1,
      },
    )) as string[]

    const walked: Array<[string, string]> = []
    let cursor: string | null = null
    do {
      const page = (await query(alice.client, 'domains/shares/model:listForWorkspacePage', {
        workspaceId,
        now: NOW + 2,
        paginationOpts: { cursor, numItems: 100 },
      })) as {
        page: Array<{ id: string; direction: string }>
        continueCursor: string
        isDone: boolean
      }
      walked.push(...page.page.map(row => [row.id, row.direction] as [string, string]))
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor !== null)

    expect(walked).toEqual([
      ...historicalIds.flatMap(id => [
        [id, 'incoming'] as [string, string],
        [id, 'outgoing'] as [string, string],
      ]),
      [template.id, 'incoming'],
      [template.id, 'outgoing'],
    ])
  })

  test('share pagination backfill restores both directions and is idempotent', async () => {
    const workspaceId = await createWorkspace(alice, 'share-page-backfill')
    const share = await createShare(alice, workspaceId, alice.user.email, 'source')
    await acceptShare(alice, share.id, workspaceId, 'received')
    await mutate(alice.client, 'testing/shares:stripSharePaginationForTest', {
      internalKey: INTERNAL_KEY,
      shareId: share.id,
    })
    expect(await workspaceSharePage(alice, workspaceId, NOW + 2)).toEqual([])

    const firstPass = await runSharePaginationBackfill(alice.client)
    expect(firstPass.patched).toBeGreaterThanOrEqual(1)
    // The backfill is deployment-wide, so earlier fixtures may leave other
    // legitimate repairs. Pin this share's two directions below, not a global
    // count that depends on suite order.
    expect(firstPass.directoryEntriesCreated).toBeGreaterThanOrEqual(2)
    expect(
      (await workspaceSharePage(alice, workspaceId, NOW + 2)).map(row => [row.id, row.direction]),
    ).toEqual([
      [share.id, 'incoming'],
      [share.id, 'outgoing'],
    ])

    expect(await runSharePaginationBackfill(alice.client)).toEqual({
      patched: 0,
      directoryEntriesCreated: 0,
    })
  })

  test('unlink keeps app rows and anchors, makes replicas local, and revokes downstream reshares', async () => {
    const a = await createWorkspace(alice, 'unlink-a')
    const b = await createWorkspace(bob, 'unlink-b')
    const unrelated = await createWorkspace(cara, 'unlink-unrelated')
    await mutate(alice.client, 'domains/apps/model:registerApp', {
      workspaceId: a,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })
    const root = await createShare(alice, a, bob.user.email, 'project', NOW)
    await acceptShare(bob, root.id, b, 'shared/project', NOW + 1)
    for (const workspaceId of [a, b, unrelated]) {
      await mutate(alice.client, 'testing/shares:upsertShareSyncRealizationForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        shareId: root.id,
        generation: `generation-${workspaceId}`,
        state: 'ready',
        now: NOW + 2,
      })
    }
    const childResult = (await mutate(bob.client, 'testing/shares:reshareForTest', {
      internalKey: INTERNAL_KEY,
      parentShareId: root.id,
      fromWorkspaceId: b,
      toEmail: cara.user.email,
      mode: 'read',
      now: NOW + 2,
    })) as { share: ShareRow }
    const child = childResult.share
    const before = (await query(bob.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: b,
    })) as AppRow[]
    expect(before).toHaveLength(1)

    await expect(
      mutate(bob.client, 'domains/shares/model:unlinkShare', {
        shareId: root.id,
        toWorkspaceId: a,
        now: NOW + 3,
      }),
    ).rejects.toThrow('Share workspace does not match')
    await mutate(bob.client, 'domains/shares/model:unlinkShare', {
      shareId: root.id,
      toWorkspaceId: b,
      now: NOW + 3,
    })
    const after = (await query(bob.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: b,
    })) as AppRow[]
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: before[0]?.id, anchorId: before[0]?.anchorId })
    expect(after[0]?.sourceShareId).toBeUndefined()
    expect(after[0]?.sourceAppId).toBeUndefined()
    const rows = await rawShares()
    expect(rows.find(row => row.id === root.id)?.state).toBe('unlinked')
    expect(rows.find(row => row.id === child.id)?.state).toBe('revoked')
    expect(await rawShareSyncReports(a)).toEqual([])
    expect(await rawShareSyncReports(b)).toEqual([])
    expect(await rawShareSyncReports(unrelated)).toEqual([])
  })

  test('revoke deletes replicas transitively and a reshare cannot widen its parent mode', async () => {
    const a = await createWorkspace(alice, 'revoke-a')
    const b = await createWorkspace(bob, 'revoke-b')
    const root = await createShare(alice, a, bob.user.email, 'project', NOW, 'read')
    await acceptShare(bob, root.id, b, 'shared/project', NOW + 1)
    await expect(
      mutate(bob.client, 'testing/shares:reshareForTest', {
        internalKey: INTERNAL_KEY,
        parentShareId: root.id,
        fromWorkspaceId: b,
        toEmail: cara.user.email,
        mode: 'write',
      }),
    ).rejects.toThrow('Cannot grant a mode above the parent share mode')
    const childResult = (await mutate(bob.client, 'testing/shares:reshareForTest', {
      internalKey: INTERNAL_KEY,
      parentShareId: root.id,
      fromWorkspaceId: b,
      toEmail: cara.user.email,
      mode: 'read',
    })) as { share: ShareRow }
    const child = childResult.share
    for (const [workspaceId, shareId] of [
      [a, root.id],
      [b, root.id],
      [b, child.id],
    ] as const) {
      await mutate(alice.client, 'testing/shares:upsertShareSyncRealizationForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        shareId,
        generation: `generation-${workspaceId}-${shareId}`,
        state: 'ready',
        now: NOW + 2,
      })
    }

    await expect(
      mutate(alice.client, 'domains/shares/model:revokeShare', {
        shareId: root.id,
        fromWorkspaceId: b,
        now: NOW + 2,
      }),
    ).rejects.toThrow('Share workspace does not match')
    const result = (await mutate(alice.client, 'domains/shares/model:revokeShare', {
      shareId: root.id,
      fromWorkspaceId: a,
      now: NOW + 2,
    })) as { revokedShareIds: string[] }
    expect(new Set(result.revokedShareIds)).toEqual(new Set([root.id, child.id]))
    expect(await rawShareSyncReports(a)).toEqual([])
    expect(await rawShareSyncReports(b)).toEqual([])
  })

  test('revoking the last active share orphans an origin anchor with no entity consumer', async () => {
    const originWorkspaceId = await createWorkspace(alice, 'revoke-orphan-a')
    const recipientWorkspaceId = await createWorkspace(bob, 'revoke-orphan-b')
    const share = await createShare(
      alice,
      originWorkspaceId,
      bob.user.email,
      'standalone-folder',
      NOW,
    )
    const anchor = (await query(alice.client, 'domains/anchors/model:getByPath', {
      workspaceId: originWorkspaceId,
      path: 'standalone-folder',
    })) as { id: string }
    await acceptShare(bob, share.id, recipientWorkspaceId, 'incoming/standalone-folder', NOW + 1)

    await mutate(alice.client, 'domains/shares/model:revokeShare', {
      shareId: share.id,
      fromWorkspaceId: originWorkspaceId,
      now: NOW + 2,
    })

    expect(
      await query(alice.client, 'domains/anchors/model:getById', { anchorId: anchor.id }),
    ).toMatchObject({ id: anchor.id, state: 'orphaned', updatedAt: NOW + 2 })
  })

  test('a write-mode recipient can publish its own replica without exposing the origin app', async () => {
    const origin = await createWorkspace(alice, 'replica-publish-origin')
    const writer = await createWorkspace(bob, 'replica-publish-writer')
    const reader = await createWorkspace(cara, 'replica-publish-reader')
    await mutate(alice.client, 'domains/apps/model:registerApp', {
      workspaceId: origin,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })
    const writeShare = await createShare(alice, origin, bob.user.email, 'project', NOW, 'write')
    await acceptShare(bob, writeShare.id, writer, 'shared/project', NOW + 1)
    const readShare = await createShare(alice, origin, cara.user.email, 'project', NOW, 'read')
    await acceptShare(cara, readShare.id, reader, 'shared/project', NOW + 1)

    const writerApp = (await appsIn(bob, writer))[0]
    const readerApp = (await appsIn(cara, reader))[0]
    assertReplica(writerApp, writeShare.id, 'write')
    assertReplica(readerApp, readShare.id, 'read')
    // An origin app is nobody's replica, so it carries no share mode at all.
    expect((await appsIn(alice, origin))[0]?.sourceShareMode).toBeUndefined()

    // Sharing an app is sharing files: write access carries the right to publish
    // the recipient's own copy, which runs on the recipient's own VM.
    const published = (await mutate(bob.client, 'domains/apps/model:setVisibility', {
      workspaceId: writer,
      slug: writerApp!.slug,
      visibility: 'public',
      now: NOW + 2,
    })) as AppRow
    expect(published.visibility).toBe('public')
    // Read access carries no such right.
    await expect(
      mutate(cara.client, 'domains/apps/model:setVisibility', {
        workspaceId: reader,
        slug: readerApp!.slug,
        visibility: 'public',
        now: NOW + 2,
      }),
    ).rejects.toThrow('Replica apps are read-only')
    // Publishing a replica never publishes the owner's app.
    expect((await appsIn(alice, origin))[0]?.visibility).toBe('folder')
  })

  test('deleting an app does NOT orphan its anchor while a PENDING (unaccepted) share references it', async () => {
    const originWorkspaceId = await createWorkspace(alice, 'pending-share-consumer')
    const app = (await mutate(alice.client, 'domains/apps/model:registerApp', {
      workspaceId: originWorkspaceId,
      path: 'shared/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'shared-site',
    })) as { anchorId: string }
    // A pending (never-accepted) share reuses the app's anchor as its share source.
    await createShare(alice, originWorkspaceId, bob.user.email, 'shared/site', NOW)

    await mutate(alice.client, 'domains/apps/model:deleteApp', {
      workspaceId: originWorkspaceId,
      slug: 'shared-site',
      now: NOW + 2,
    })

    // The pending share is still a live consumer, so the anchor must stay active —
    // orphaning it would strand the invite (accept would succeed but never sync).
    expect(
      await query(alice.client, 'domains/anchors/model:getById', { anchorId: app.anchorId }),
    ).toMatchObject({ id: app.anchorId, state: 'active' })
  })
})

async function createWorkspace(user: SignedInUser, prefix: string): Promise<string> {
  await mutate(user.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const workspaceId = (await mutate(user.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: prefix,
  })) as string
  await mutate(user.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: NOW,
  })
  return workspaceId
}

async function createShare(
  user: SignedInUser,
  fromWorkspaceId: string,
  toEmail: string,
  path: string,
  now = NOW,
  mode: 'read' | 'write' = 'write',
): Promise<ShareRow> {
  const created = (await mutate(user.client, 'testing/shares:createShareForTest', {
    internalKey: INTERNAL_KEY,
    fromWorkspaceId,
    toEmail,
    path,
    mode,
    now,
  })) as { share: ShareRow; invitationToken: string }
  return { ...created.share, invitationToken: created.invitationToken }
}

async function acceptShare(
  user: SignedInUser,
  shareId: string,
  toWorkspaceId: string,
  mountPath: string,
  now = NOW + 1,
): Promise<ShareRow> {
  return (await mutate(user.client, 'domains/shares/model:acceptShare', {
    shareId,
    toWorkspaceId,
    mountPath,
    now,
  })) as ShareRow
}

async function workspaceSharePage(
  user: SignedInUser,
  workspaceId: string,
  now: number,
): Promise<WorkspaceSharePageRow[]> {
  const result = (await query(user.client, 'domains/shares/model:listForWorkspacePage', {
    workspaceId,
    now,
    paginationOpts: { cursor: null, numItems: 100 },
  })) as { page: WorkspaceSharePageRow[] }
  return result.page
}

async function pendingSharePage(user: SignedInUser, now: number): Promise<ShareRequest[]> {
  const rows: ShareRequest[] = []
  let cursor: string | null = null
  do {
    const result = (await query(user.client, 'domains/shares/model:listPendingForUserPage', {
      now,
      paginationOpts: { cursor, numItems: 100 },
    })) as { page: ShareRequest[]; continueCursor: string; isDone: boolean }
    rows.push(...result.page)
    cursor = result.isDone ? null : result.continueCursor
  } while (cursor !== null)
  return rows
}

async function runSharePaginationBackfill(client: ConvexHttpClient): Promise<{
  patched: number
  directoryEntriesCreated: number
}> {
  let cursor: string | null = null
  let patched = 0
  let directoryEntriesCreated = 0
  do {
    const page = (await mutate(client, 'domains/internalAdmin/paginationOrder:backfill', {
      internalKey: INTERNAL_KEY,
      table: 'shares',
      cursor,
    })) as {
      continueCursor: string
      isDone: boolean
      patched: number
      directoryEntriesCreated: number
    }
    patched += page.patched
    directoryEntriesCreated += page.directoryEntriesCreated
    cursor = page.isDone ? null : page.continueCursor
  } while (cursor !== null)
  return { patched, directoryEntriesCreated }
}

async function appsIn(user: SignedInUser, workspaceId: string): Promise<AppRow[]> {
  return (await query(user.client, 'domains/apps/model:listByWorkspace', {
    workspaceId,
  })) as AppRow[]
}

function assertReplica(app: AppRow | undefined, shareId: string, mode: 'read' | 'write'): void {
  expect(app).toMatchObject({
    sourceShareId: shareId,
    sourceShareMode: mode,
    visibility: 'folder',
  })
}

async function rawShares(): Promise<ShareRow[]> {
  return (await query(alice.client, 'testing/shares:rawSharesForTest', {
    internalKey: INTERNAL_KEY,
  })) as ShareRow[]
}

async function rawShareSyncReports(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(alice.client, 'testing/workspaces:rawShareSyncReportsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
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

interface ShareRow {
  id: string
  anchorId: string
  invitationToken: string
  tokenPrefix: string
  fromWorkspaceId: string
  toEmail: string
  toUserId?: string
  toWorkspaceId?: string
  mountPath?: string
  mountAnchorId?: string
  ignorePatterns: string[]
  pausedAt?: number
  sync?: Record<string, unknown>
  expiresAt: number
  state: 'pending' | 'active' | 'revoked' | 'unlinked'
}

type WorkspaceSharePageRow = Record<string, unknown> & {
  id: string
  direction: 'incoming' | 'outgoing'
  state: string
  syncStatus?: unknown
}

interface AppRow {
  id: string
  slug: string
  anchorId: string
  visibility: 'folder' | 'public'
  sourceShareId?: string
  sourceShareMode?: 'read' | 'write'
  sourceAppId?: string
}
