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
const IMAGE_REF = 'ttl.sh/duet-test-slice14:1h'

let convex: ConvexDevFixture
let owner: SignedInUser
let sequence = 0

describe('publishes backend domain', () => {
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
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('publishes-owner'),
      'Publishes Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('create writes a publish row, publish-kind anchor, and audit event', async () => {
    const workspaceId = await createWorkspace('publish-create')
    const before = await auditEvents(workspaceId)

    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      now: 10_000,
    })) as PublishRow

    expect(publish).toMatchObject({
      workspaceId,
      anchorPath: 'reports/q2.md',
      slug: 'q2-md',
      kind: 'file',
      createdByUserId: owner.user._id,
      createdAt: 10_000,
      updatedAt: 10_000,
    })
    const anchor = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: publish.anchorId,
    })) as AnchorRow
    expect(anchor).toMatchObject({
      workspaceId,
      path: 'reports/q2.md',
      kind: 'publish',
      state: 'active',
    })
    const after = await auditEvents(workspaceId)
    expect(
      newAuditEvents(before, after)
        .map(event => event.event)
        .sort(),
    ).toEqual(['anchor.created', 'publish.created'])
  })

  test('reserved publish slugs are rejected and slug edits leave old slug unresolved', async () => {
    const workspaceId = await createWorkspace('publish-slug')
    await expect(
      mutate(owner.client, 'domains/publishes/model:createPublish', {
        workspaceId,
        path: 'reports/q2.md',
        kind: 'file',
        slug: 'api',
      }),
    ).rejects.toThrow('Invalid publish slug: reserved')

    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'q2',
    })
    const updated = (await mutate(owner.client, 'domains/publishes/model:updateSlug', {
      workspaceId,
      slug: 'q2',
      newSlug: 'q2-live',
      now: 11_000,
    })) as PublishRow

    expect(updated.slug).toBe('q2-live')
    expect(
      await query(owner.client, 'domains/publishes/model:getBySlug', {
        workspaceId,
        slug: 'q2',
      }),
    ).toBeNull()
    expect((await auditEvents(workspaceId)).map(event => event.event)).toContain(
      'publish.slug_updated',
    )
  })

  // A slug the caller CHOSE may be refused (the test above) — that is a clear
  // answer to an explicit request. A slug the system DERIVES may not: the
  // allocator promises an available slug, so a reserved base has to advance to
  // the next candidate the way a taken one does. Publishing a folder called
  // `root` is the reachable case now that `root` names the default agent.
  test('derived publish slugs step over a reserved base instead of failing', async () => {
    const workspaceId = await createWorkspace('publish-derived')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'projects/root',
      kind: 'folder',
    })) as PublishRow

    expect(publish.slug).toBe('root-2')
  })

  test('anchor rename preserves the publish slug and changes edge anchor path', async () => {
    const registered = await provisionRegisteredWorkspace('publish-move')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: registered.workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'forecast',
    })) as PublishRow

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: publish.anchorId,
          candidates: [
            {
              fromPath: 'reports/q2.md',
              toPath: 'archive/q2.md',
              confidence: 0.9,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['archive/q2.md'],
        },
      ],
    })

    const resolved = (await query(owner.client, 'domains/publishes/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      publishSlug: 'forecast',
    })) as PublishEdgeResolveRow
    expect(resolved.publish).toMatchObject({
      kind: 'file',
      anchorPath: 'archive/q2.md',
    })
  })

  test('deleting the only publish consumer orphans its anchor', async () => {
    const workspaceId = await createWorkspace('publish-delete')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'reports/retired.md',
      kind: 'file',
      slug: 'retired',
    })) as PublishRow

    await mutate(owner.client, 'domains/publishes/model:deletePublish', {
      workspaceId,
      slug: 'retired',
      now: 15_000,
    })

    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: publish.anchorId }),
    ).toMatchObject({ id: publish.anchorId, state: 'orphaned', updatedAt: 15_000 })
  })

  test('SUBS-IMPL-11 edge resolution identifies a paused publish without minting an origin', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const registered = await provisionRegisteredWorkspace('publish-paused')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: registered.workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'forecast',
    })) as PublishRow
    await mutate(owner.client, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })

    expect(
      await query(owner.client, 'domains/publishes/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        publishSlug: 'forecast',
      }),
    ).toEqual({ paused: true, appName: 'forecast' })

    await mutate(owner.client, 'domains/workspaces/provisioning:markAdminArchived', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      now: Date.now(),
    })
    expect(
      await query(owner.client, 'domains/publishes/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        publishSlug: 'forecast',
      }),
    ).toEqual({ paused: true, appName: 'forecast' })

    await mutate(owner.client, 'testing/anchors:forceBrokenForTest', {
      internalKey: INTERNAL_KEY,
      anchorId: publish.anchorId,
    })
    expect(
      await query(owner.client, 'domains/publishes/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        publishSlug: 'forecast',
      }),
    ).toBeNull()
  })

  test('publish freeze projects its confirmed generation without pausing workspace serving', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const registered = await provisionRegisteredWorkspace('publish-freeze')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: registered.workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'frozen-forecast',
    })) as PublishRow

    const paused = (await mutate(owner.client, 'domains/publishes/model:setPublishPaused', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      publishId: publish.id,
      slug: publish.slug,
      paused: true,
      generation: 'gen-1',
      now: 20_000,
    })) as PublishRow
    expect(paused).toMatchObject({ pausedAt: 20_000, pauseGeneration: 'gen-1' })

    const resolved = (await query(owner.client, 'domains/publishes/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      publishSlug: publish.slug,
    })) as PublishEdgeResolveRow
    expect(resolved.publish.freeze).toEqual({ generation: 'gen-1' })

    const replaced = (await mutate(owner.client, 'domains/publishes/model:setPublishPaused', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      publishId: publish.id,
      slug: publish.slug,
      paused: true,
      generation: 'gen-2',
      now: 20_500,
    })) as PublishRow
    expect(replaced).toMatchObject({ pausedAt: 20_500, pauseGeneration: 'gen-2' })

    const resumed = (await mutate(owner.client, 'domains/publishes/model:setPublishPaused', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      publishId: publish.id,
      slug: publish.slug,
      paused: false,
      now: 21_000,
    })) as PublishRow
    expect(resumed.pausedAt).toBeUndefined()
    expect(resumed.pauseGeneration).toBeUndefined()
    const resumedAgain = (await mutate(owner.client, 'domains/publishes/model:setPublishPaused', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      publishId: publish.id,
      slug: publish.slug,
      paused: false,
      now: 22_000,
    })) as PublishRow
    expect(resumedAgain.pausedAt).toBeUndefined()
  })

  test('first served new file under a folder publish writes one forward-inclusive audit', async () => {
    const workspaceId = await createWorkspace('publish-folder')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'public',
      kind: 'folder',
      slug: 'public',
    })) as PublishRow
    const before = await auditEvents(workspaceId)

    const first = await mutate(owner.client, 'domains/publishes/model:recordServedPath', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      servedPath: 'public/new.md',
      kind: 'raw',
      now: 12_000,
    })
    const duplicate = await mutate(owner.client, 'domains/publishes/model:recordServedPath', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      servedPath: 'public/new.md',
      kind: 'raw',
      now: 13_000,
    })

    expect(first).toEqual({ recorded: true })
    expect(duplicate).toEqual({ recorded: false, reason: 'already_recorded' })
    const after = await auditEvents(workspaceId)
    expect(newAuditEvents(before, after).map(event => event.event)).toEqual([
      'publish.new_file_served',
    ])
  })

  test('a root zip records one served-path audit and repeated downloads deduplicate', async () => {
    const workspaceId = await createWorkspace('publish-root-zip')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'public',
      kind: 'folder',
      slug: 'public-zip',
    })) as PublishRow
    const before = await auditEvents(workspaceId)

    const first = await mutate(owner.client, 'domains/publishes/model:recordServedPath', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      servedPath: 'public',
      kind: 'zip',
      now: 14_000,
    })
    const duplicate = await mutate(owner.client, 'domains/publishes/model:recordServedPath', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      servedPath: 'public',
      kind: 'zip',
      now: 15_000,
    })

    expect(first).toEqual({ recorded: true })
    expect(duplicate).toEqual({ recorded: false, reason: 'already_recorded' })
    const recorded = newAuditEvents(before, await auditEvents(workspaceId))
    expect(recorded).toEqual([
      expect.objectContaining({
        event: 'publish.new_zip_served',
        provenance: expect.objectContaining({ path: 'public' }),
      }),
    ])
  })

  test('a nested zip records the requested folder path', async () => {
    const workspaceId = await createWorkspace('publish-nested-zip')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'public',
      kind: 'folder',
      slug: 'nested-zip',
    })) as PublishRow
    const before = await auditEvents(workspaceId)

    const result = await mutate(owner.client, 'domains/publishes/model:recordServedPath', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      servedPath: 'public/agents/research',
      kind: 'zip',
      now: 16_000,
    })

    expect(result).toEqual({ recorded: true })
    expect(newAuditEvents(before, await auditEvents(workspaceId))).toEqual([
      expect.objectContaining({
        event: 'publish.new_zip_served',
        provenance: expect.objectContaining({ path: 'public/agents/research' }),
      }),
    ])
  })

  test('raw reports remain nested-only and cannot record the publish root', async () => {
    const workspaceId = await createWorkspace('publish-root-raw')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'public',
      kind: 'folder',
      slug: 'root-raw',
    })) as PublishRow
    const before = await auditEvents(workspaceId)

    const result = await mutate(owner.client, 'domains/publishes/model:recordServedPath', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      servedPath: 'public',
      kind: 'raw',
      now: 17_000,
    })

    expect(result).toEqual({ recorded: false, reason: 'outside_publish' })
    expect(await auditEvents(workspaceId)).toEqual(before)
  })

  test('zip reports cannot record paths below the publish serving floor', async () => {
    const workspaceId = await createWorkspace('publish-floor-zip')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId,
      path: 'public',
      kind: 'folder',
      slug: 'floor-zip',
    })) as PublishRow
    const before = await auditEvents(workspaceId)

    await expect(
      mutate(owner.client, 'domains/publishes/model:recordServedPath', {
        internalKey: INTERNAL_KEY,
        publishId: publish.id,
        servedPath: 'public/node_modules/package',
        kind: 'zip',
        now: 18_000,
      }),
    ).rejects.toThrow('Invalid publish path: excluded')
    expect(await auditEvents(workspaceId)).toEqual(before)
  })

  test('resolveForEdge projects the public viewer descriptor with a non-email owner label', async () => {
    const registered = await provisionRegisteredWorkspace('publish-viewer')
    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: registered.workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'viewer-forecast',
    })
    // Give the creator a display name so the preferred label branch is exercised.
    await mutate(owner.client, 'testing/publishes:setUserNameForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      name: 'Ada Lovelace',
    })

    const resolved = (await query(owner.client, 'domains/publishes/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      publishSlug: 'viewer-forecast',
    })) as PublishEdgeResolveRow

    expect(resolved.publish.viewer).toEqual({
      workspaceName: 'publish-viewer Workspace',
      ownerName: 'Ada Lovelace',
      rootName: 'q2.md',
      kind: 'file',
    })
  })

  test('the owner label falls back to the workspace name when the creator has no display name', async () => {
    const registered = await provisionRegisteredWorkspace('publish-anon')
    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: registered.workspaceId,
      path: 'notes',
      kind: 'folder',
      slug: 'anon-notes',
    })
    await mutate(owner.client, 'testing/publishes:setUserNameForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
    })

    const resolved = (await query(owner.client, 'domains/publishes/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      publishSlug: 'anon-notes',
    })) as PublishEdgeResolveRow

    // Deterministic and non-email: the workspace display name, never the email.
    expect(resolved.publish.viewer).toEqual({
      workspaceName: 'publish-anon Workspace',
      ownerName: 'publish-anon Workspace',
      rootName: 'notes',
      kind: 'folder',
    })
    expect(resolved.publish.viewer!.ownerName).not.toContain('@')

    // Restore the shared owner's display name for the remaining tests.
    await mutate(owner.client, 'testing/publishes:setUserNameForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      name: 'Publishes Owner',
    })
  })

  test('resolveForEdge returns null when the publish creator no longer exists', async () => {
    const registered = await provisionRegisteredWorkspace('publish-ghost')
    const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: registered.workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'ghost-forecast',
    })) as PublishRow
    const ghost = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('publish-ghost-creator'),
      'Ghost Creator',
    )
    await mutate(owner.client, 'testing/publishes:setPublishCreatorForTest', {
      internalKey: INTERNAL_KEY,
      publishId: publish.id,
      userId: ghost.user._id,
    })
    await mutate(owner.client, 'testing/publishes:deleteUserForTest', {
      internalKey: INTERNAL_KEY,
      userId: ghost.user._id,
    })

    expect(
      await query(owner.client, 'domains/publishes/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        publishSlug: 'ghost-forecast',
      }),
    ).toBeNull()
  })

  test('resolveForEdge returns null for an unknown workspace', async () => {
    expect(
      await query(owner.client, 'domains/publishes/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: 'no-such-workspace-xyz',
        publishSlug: 'whatever',
      }),
    ).toBeNull()
  })

  test('workspace rename records that public URLs break', async () => {
    const workspaceId = await createWorkspace('publish-rename')
    await mutate(owner.client, 'domains/workspaces/mutations:rename', {
      workspaceId,
      slug: uniqueSlug('publish-renamed'),
      publicUrlBreakAcknowledged: true,
    })
    const event = (await auditEvents(workspaceId)).at(-1)!
    expect(event).toMatchObject({
      event: 'workspace.renamed',
      provenance: { breaksPublicUrls: true, acknowledged: true },
    })
  })
})

async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} Workspace`,
  })) as string
}

async function provisionRegisteredWorkspace(
  prefix: string,
): Promise<{ workspaceId: string; slug: string; vmToken: string }> {
  const slug = uniqueSlug(prefix)
  const provisioningToken = `token-${slug}`
  const now = Date.now()
  const begun = (await mutate(owner.client, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    slug,
    name: `${prefix} Workspace`,
    imageRef: IMAGE_REF,
    provisioningTokenHash: await sha256Hex(provisioningToken),
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })) as { workspaceId: string }
  const registered = (await mutate(owner.client, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash: await sha256Hex(provisioningToken),
    workspaceHint: begun.workspaceId,
    vmName: 'publish-edge-vm',
    sshDest: 'exedev@publish-edge.example.exe.xyz',
    httpsUrl: 'https://publish-edge.example.exe.xyz',
    now: now + 1,
  })) as { vmToken: string }
  return { workspaceId: begun.workspaceId, slug, vmToken: registered.vmToken }
}

async function auditEvents(workspaceId: string): Promise<AuditRow[]> {
  return (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as AuditRow[]
}

function newAuditEvents(before: AuditRow[], after: AuditRow[]): AuditRow[] {
  const existingIds = new Set(before.map(event => event.id))
  return after.filter(event => !existingIds.has(event.id))
}

async function sha256Hex(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
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

interface PublishRow {
  id: string
  workspaceId: string
  anchorId: string
  anchorPath: string
  slug: string
  kind: 'file' | 'folder'
  createdByUserId: string
  createdAt: number
  updatedAt: number
  pausedAt?: number
  pauseGeneration?: string
}

interface AnchorRow {
  workspaceId: string
  path: string
  kind: 'app' | 'agent' | 'publish' | 'share-root'
  state: 'active' | 'broken'
}

interface AuditRow {
  id: string
  event: string
  provenance?: unknown
}

interface PublishEdgeResolveRow {
  publish: {
    kind: 'file' | 'folder'
    anchorPath: string
    freeze?: { generation: string }
    viewer?: {
      workspaceName: string
      ownerName: string
      rootName: string
      kind: 'file' | 'folder'
    }
  }
}
