import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import {
  hashApiKey,
  MAX_APP_COMMAND_UTF8_BYTES,
  MAX_APPS_PER_WORKSPACE,
  MAX_DRIVE_PATH_UTF8_BYTES,
  MAX_ICON_PATH_UTF8_BYTES,
  type App,
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
const IMAGE_REF = 'ttl.sh/duet-test-slice13:1h'

let convex: ConvexDevFixture
let owner: SignedInUser
let editor: SignedInUser
let viewer: SignedInUser
let sequence = 0

describe('apps backend domain', () => {
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
    owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('apps-owner'), 'Apps Owner')
    editor = await signInWithMagicLink<UserRow>(convex, uniqueEmail('apps-editor'), 'Apps Editor')
    viewer = await signInWithMagicLink<UserRow>(convex, uniqueEmail('apps-viewer'), 'Apps Viewer')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('register creates an app row, app-kind anchor, list/get rows, and deploy audit', async () => {
    const workspaceId = await createWorkspace('apps-register')
    const before = await auditEvents(owner.client, workspaceId)

    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: ['services', 'files:read'],
      port: 4173,
      name: 'Status Board',
      icon: 'assets/icon.png',
      now: 10_000,
    })) as AppRow

    expect(app).toMatchObject({
      workspaceId,
      anchorPath: 'apps/site',
      anchorState: 'active',
      command: 'bun run start',
      apiScopes: ['files:read', 'services'],
      port: 4173,
      slug: 'site',
      name: 'Status Board',
      icon: 'assets/icon.png',
      visibility: 'folder',
      runtimeStatus: 'reconciling',
      createdByUserId: owner.user._id,
      createdAt: 10_000,
      updatedAt: 10_000,
    })

    const anchor = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: app.anchorId,
    })) as AnchorRow
    expect(anchor).toMatchObject({ workspaceId, path: 'apps/site', kind: 'app', state: 'active' })

    const bySlug = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId,
      slug: 'site',
    })) as AppRow
    const listed = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as AppRow[]
    expect(bySlug).toMatchObject({
      id: app.id,
      anchorState: 'active',
      name: 'Status Board',
      icon: 'assets/icon.png',
    })
    expect(
      listed.map(row => ({
        slug: row.slug,
        anchorState: row.anchorState,
        name: row.name,
        icon: row.icon,
        apiScopes: row.apiScopes,
      })),
    ).toEqual([
      {
        slug: 'site',
        anchorState: 'active',
        name: 'Status Board',
        icon: 'assets/icon.png',
        apiScopes: ['files:read', 'services'],
      },
    ])

    const after = await auditEvents(owner.client, workspaceId)
    const newEventNames = newAuditEvents(before, after).map(event => event.event)
    expect(newEventNames).toHaveLength(2)
    expect(newEventNames).toEqual(expect.arrayContaining(['anchor.created', 'app.deployed']))
  })

  test('app register and update enforce the shared icon byte ceiling', async () => {
    const workspaceId = await createWorkspace('apps-icon-bound')
    const atLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 4)}🚀`
    const overLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 3)}🚀`
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/bounded-icon',
      command: 'bun run start',
      apiScopes: [],
      icon: atLimit,
    })) as AppRow

    expect(app.icon).toBe(atLimit)
    await expect(
      mutate(owner.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: app.slug,
        icon: overLimit,
      }),
    ).rejects.toThrow('Icon path exceeds 1024 UTF-8 bytes')
    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/oversized-icon',
        command: 'bun run start',
        apiScopes: [],
        icon: overLimit,
      }),
    ).rejects.toThrow('Icon path exceeds 1024 UTF-8 bytes')
  })

  test('internal app writes enforce command and anchor-path byte ceilings', async () => {
    const workspaceId = await createWorkspace('apps-runtime-bounds')
    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/oversized-command',
        command: `${'a'.repeat(MAX_APP_COMMAND_UTF8_BYTES - 3)}🚀`,
        apiScopes: [],
      }),
    ).rejects.toThrow(`App command exceeds ${MAX_APP_COMMAND_UTF8_BYTES} UTF-8 bytes`)
    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: `${'a'.repeat(MAX_DRIVE_PATH_UTF8_BYTES - 3)}🚀`,
        command: 'bun run start',
        apiScopes: [],
      }),
    ).rejects.toThrow('Invalid app path: too_long')
  })

  test('register preserves literal percent identities in app and anchor paths', async () => {
    const workspaceId = await createWorkspace('apps-percent-paths')
    const literalPercent = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/100%',
      command: 'bun run start',
      apiScopes: [],
      slug: 'literal-percent',
    })) as AppRow
    const percentLooking = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/a%2Fb',
      command: 'bun run start',
      apiScopes: [],
      slug: 'percent-looking',
    })) as AppRow

    expect([literalPercent.anchorPath, percentLooking.anchorPath]).toEqual([
      'apps/100%',
      'apps/a%2Fb',
    ])
    expect(literalPercent.anchorId).not.toBe(percentLooking.anchorId)
    expect(
      await Promise.all(
        [literalPercent.anchorId, percentLooking.anchorId].map(anchorId =>
          query(owner.client, 'domains/anchors/model:getById', { anchorId }),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'app', path: 'apps/100%' }),
      expect.objectContaining({ kind: 'app', path: 'apps/a%2Fb' }),
    ])
  })

  test('register without a port allocates, returns, and persists a reserved port', async () => {
    const workspaceId = await createWorkspace('apps-auto-port')

    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/auto-port',
      command: 'bun run start',
      apiScopes: [],
    })) as AppRow

    expect(registered.port).toBeGreaterThanOrEqual(41_000)
    expect(registered.port).toBeLessThanOrEqual(41_999)

    const persisted = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId,
      slug: 'auto-port',
    })) as AppRow
    expect(persisted.port).toBe(registered.port)

    const updated = (await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'auto-port',
      command: 'bun run preview',
    })) as AppRow
    expect(updated.port).toBe(registered.port)
  })

  test('install command persists through registration and update into workspace run config', async () => {
    const workspaceId = await createWorkspace('apps-install-command')

    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/installable',
      command: 'bun run start',
      apiScopes: [],
      installCommand: 'bun install',
      name: 'Installable App',
    })) as AppRow
    expect(registered.installCommand).toBe('bun install')

    const updated = (await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'installable',
      installCommand: 'bun install --frozen-lockfile',
    })) as AppRow
    expect(updated.installCommand).toBe('bun install --frozen-lockfile')

    expect(
      await query(owner.client, 'domains/apps/model:runConfigForWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toEqual([
      {
        appId: registered.id,
        slug: 'installable',
        command: 'bun run start',
        installCommand: 'bun install --frozen-lockfile',
        name: 'Installable App',
        port: registered.port,
        anchorPath: 'apps/installable',
        apiScopes: [],
        visibility: 'folder',
      },
    ])
  })

  test('app API scopes round-trip through registration, replacement, and run config', async () => {
    const workspaceId = await createWorkspace('apps-api-scopes')
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/scoped',
      command: 'bun run start',
      apiScopes: ['services', 'files:read', 'services'],
    })) as AppRow
    expect(registered.apiScopes).toEqual(['files:read', 'services'])

    const updated = (await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'scoped',
      apiScopes: ['members'],
    })) as AppRow
    expect(updated.apiScopes).toEqual(['members'])
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', { workspaceId, slug: 'scoped' }),
    ).toMatchObject({ id: registered.id, apiScopes: ['members'] })
    expect(
      await query(owner.client, 'domains/apps/model:runConfigForWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toEqual([
      {
        appId: registered.id,
        slug: 'scoped',
        command: 'bun run start',
        port: registered.port,
        anchorPath: 'apps/scoped',
        apiScopes: ['members'],
        visibility: 'folder',
      },
    ])
  })

  test('workspace run config emits visibility only for apps on active anchors', async () => {
    const workspaceId = await createWorkspace('apps-vis')
    const active = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/public',
      command: 'bun run start',
      apiScopes: [],
      slug: 'public',
    })) as AppRow
    const broken = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/broken',
      command: 'bun run start',
      apiScopes: [],
      slug: 'broken',
    })) as AppRow
    await mutate(owner.client, 'domains/apps/model:setVisibility', {
      workspaceId,
      slug: 'public',
      visibility: 'public',
    })
    await mutate(owner.client, 'testing/anchors:forceBrokenForTest', {
      internalKey: INTERNAL_KEY,
      anchorId: broken.anchorId,
    })

    expect(
      await query(owner.client, 'domains/apps/model:runConfigForWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toEqual([
      {
        appId: active.id,
        slug: 'public',
        command: 'bun run start',
        port: active.port,
        anchorPath: 'apps/public',
        apiScopes: [],
        visibility: 'public',
      },
    ])
  })

  test('metadata-only updates preserve runtime status', async () => {
    const workspaceId = await createWorkspace('apps-metadata-update')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/metadata',
      command: 'bun run start',
      apiScopes: [],
      name: 'Metadata App',
      icon: 'icon.png',
      now: 20_000,
    })
    await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      slug: 'metadata',
      status: 'reconciled',
      now: 21_000,
    })
    const auditBeforeUpdate = await auditEvents(owner.client, workspaceId)

    const updated = (await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'metadata',
      name: 'Renamed App',
      icon: 'assets/replaced.png',
      now: 22_000,
    })) as AppRow

    expect(updated).toMatchObject({
      name: 'Renamed App',
      icon: 'assets/replaced.png',
      runtimeStatus: 'reconciled',
      updatedAt: 22_000,
    })
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId,
        slug: 'metadata',
      }),
    ).toMatchObject({ name: 'Renamed App', icon: 'assets/replaced.png' })
    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', { workspaceId }),
    ).toEqual([expect.objectContaining({ name: 'Renamed App', icon: 'assets/replaced.png' })])
    expect(await auditEvents(owner.client, workspaceId)).toEqual(auditBeforeUpdate)
  })

  test('same-value icon update deliberately bumps updatedAt for cache busting', async () => {
    const workspaceId = await createWorkspace('apps-icon-cache-bust')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/icon-cache-bust',
      command: 'bun run start',
      apiScopes: [],
      icon: 'icon.png',
      now: 30_000,
    })
    const failed = (await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      slug: 'icon-cache-bust',
      status: 'reconcile_failed',
      error: 'gateway unavailable',
      now: 31_000,
    })) as AppRow

    const updated = (await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'icon-cache-bust',
      icon: 'icon.png',
      now: 31_000,
    })) as AppRow

    expect(updated).toMatchObject({
      icon: 'icon.png',
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'gateway unavailable',
      updatedAt: 31_001,
    })
    expect(updated.updatedAt).toBeGreaterThan(failed.updatedAt)
  })

  test('register rejects unsafe icon metadata at the durable boundary', async () => {
    const workspaceId = await createWorkspace('apps-invalid-icon')

    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/invalid-icon',
        command: 'bun run start',
        apiScopes: [],
        icon: '../secret.png',
      }),
    ).rejects.toThrow()
  })

  test('update rejects blank name metadata at the durable boundary', async () => {
    const workspaceId = await createWorkspace('apps-invalid-name')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/invalid-name',
      command: 'bun run start',
      apiScopes: [],
    })

    await expect(
      mutate(owner.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: 'invalid-name',
        name: '   ',
      }),
    ).rejects.toThrow()
  })

  test('register rejects explicit ports in the auto-assignment range', async () => {
    const workspaceId = await createWorkspace('apps-reserved-port')

    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/reserved-port',
        command: 'bun run start',
        apiScopes: [],
        port: 41_000,
      }),
    ).rejects.toThrow('Explicit app port must be outside the reserved range')
  })

  test('register rejects a port already used by another app in the workspace', async () => {
    const workspaceId = await createWorkspace('apps-port-collision')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/first',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })

    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/second',
        command: 'bun run start',
        apiScopes: [],
        port: 4_173,
      }),
    ).rejects.toThrow('App port already exists')
  })

  test('legacy duplicate ports produce a controlled collision error', async () => {
    const workspaceId = await createWorkspace('apps-legacy-port')
    const first = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/first',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })) as AppRow
    const second = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/second',
      command: 'bun run start',
      apiScopes: [],
      port: 4_999,
    })) as AppRow
    await mutate(owner.client, 'testing/apps:forcePortForTest', {
      internalKey: INTERNAL_KEY,
      appId: second.id,
      port: first.port,
    })

    await expect(
      mutate(owner.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: first.slug,
        port: first.port,
      }),
    ).rejects.toThrow('App port already exists')
  })

  test('auto-assignment avoids collisions within a workspace', async () => {
    const workspaceId = await createWorkspace('apps-two-auto-ports')
    const first = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/first-auto',
      command: 'bun run start',
      apiScopes: [],
    })) as AppRow
    const second = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/second-auto',
      command: 'bun run start',
      apiScopes: [],
    })) as AppRow

    expect(second.port).not.toBe(first.port)
  })

  test('the same explicit port is allowed in different workspaces', async () => {
    const firstWorkspaceId = await createWorkspace('apps-port-workspace-a')
    const secondWorkspaceId = await createWorkspace('apps-port-workspace-b')

    const first = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: firstWorkspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })) as AppRow
    const second = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: secondWorkspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })) as AppRow

    expect(first.port).toBe(4_173)
    expect(second.port).toBe(4_173)
  })

  test('update rejects reserved and workspace-colliding explicit ports', async () => {
    const workspaceId = await createWorkspace('apps-update-port')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/first',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/second',
      command: 'bun run start',
      apiScopes: [],
      port: 4_174,
    })

    await expect(
      mutate(owner.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: 'second',
        port: 41_001,
      }),
    ).rejects.toThrow('Explicit app port must be outside the reserved range')
    await expect(
      mutate(owner.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: 'second',
        port: 4_173,
      }),
    ).rejects.toThrow('App port already exists')
  })

  // Slug is creation-time identity, handled the same way for every caller: a
  // register copes with a taken slug by suffixing (the shared-replica rule)
  // rather than refusing, and re-registering an existing path keeps the slug
  // the app was born with — registration is not a rename.
  test('register suffixes a taken slug and never renames an app by reusing its path', async () => {
    const workspaceId = await createWorkspace('apps-duplicates')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
      slug: 'site',
    })
    const suffixed = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/other',
      command: 'bun run start',
      apiScopes: [],
      port: 4174,
      slug: 'site',
    })) as AppRow
    expect(suffixed).toMatchObject({ anchorPath: 'apps/other', slug: 'site-2' })
    const rebornPath = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
      slug: 'renamed',
    })) as AppRow
    expect(rebornPath).toMatchObject({ anchorPath: 'apps/site', slug: 'site' })
    const listed = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as AppRow[]
    expect(listed.map(row => ({ path: row.anchorPath, slug: row.slug }))).toEqual([
      { path: 'apps/site', slug: 'site' },
      { path: 'apps/other', slug: 'site-2' },
    ])
  })

  test('deleting an app leaves its anchor active while an accepted share consumes it', async () => {
    const sourceWorkspaceId = await createWorkspace('del-share-src')
    const recipientWorkspaceId = await createWorkspace('del-share-dst')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'shared/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'shared-site',
    })) as AppRow
    await shareWorkspacePath(
      sourceWorkspaceId,
      recipientWorkspaceId,
      'shared/site',
      'incoming/site',
    )

    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: sourceWorkspaceId,
      slug: 'shared-site',
      now: 15_000,
    })

    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: app.anchorId }),
    ).toMatchObject({ id: app.anchorId, state: 'active' })
  })

  test('list filters apps by normalized path and subtree, children, or self scope', async () => {
    const workspaceId = await createWorkspace('apps-path-filter')
    for (const [path, slug] of [
      ['top', 'top'],
      ['apps', 'app-root'],
      ['apps/alpha', 'alpha'],
      ['apps/beta', 'beta'],
      ['apps/nested/gamma', 'gamma'],
      ['other/delta', 'delta'],
    ] as const) {
      await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path,
        command: 'bun run start',
        apiScopes: [],
        slug,
      })
    }

    const list = async (path: string, scope: 'subtree' | 'children' | 'self') =>
      (
        (await query(owner.client, 'domains/apps/model:listByWorkspace', {
          workspaceId,
          path,
          scope,
        })) as AppRow[]
      ).map(app => app.slug)

    expect(await list('', 'subtree')).toEqual([
      'alpha',
      'app-root',
      'beta',
      'delta',
      'gamma',
      'top',
    ])
    expect(await list('', 'children')).toEqual(['app-root', 'top'])
    expect(await list('', 'self')).toEqual([])
    expect(await list('apps/', 'subtree')).toEqual(['alpha', 'app-root', 'beta', 'gamma'])
    expect(await list('apps', 'children')).toEqual(['alpha', 'beta'])
    expect(await list('apps', 'self')).toEqual(['app-root'])
    expect(
      (
        (await query(owner.client, 'domains/apps/model:listByWorkspace', {
          workspaceId,
          path: 'apps',
        })) as AppRow[]
      ).map(app => app.slug),
    ).toEqual(['alpha', 'app-root', 'beta', 'gamma'])
  })

  test('list rejects unsafe paths and scope without a path', async () => {
    const workspaceId = await createWorkspace('apps-path-validation')

    await expect(
      query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        path: '../outside',
      }),
    ).rejects.toThrow('Invalid app list path: traversal')
    await expect(
      query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        scope: 'children',
      }),
    ).rejects.toThrow('scope requires path')
  })

  test('list projects broken state from the current anchor', async () => {
    const workspaceId = await createWorkspace('apps-broken-anchor')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/broken',
      command: 'bun run start',
      apiScopes: [],
      slug: 'broken-app',
    })) as AppRow
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: app.anchorId,
      reason: 'folder_removed',
    })

    const listed = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as AppRow[]
    expect(listed.map(row => ({ slug: row.slug, anchorState: row.anchorState }))).toEqual([
      { slug: 'broken-app', anchorState: 'broken' },
    ])
  })

  test('targeted app lookups stay bounded at the app cap and choose the deepest cwd owner', async () => {
    const workspaceId = await createWorkspace('apps-targeted-lookup')
    await mutate(owner.client, 'testing/apps:seedWorkspaceAppsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      createdByUserId: owner.user._id,
      count: MAX_APPS_PER_WORKSPACE - 2,
      matchingPath: 'matching',
    })
    const seeded = (await query(owner.client, 'testing/apps:rawAppsForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; workspaceId: string; slug: string }>
    const targetSlug = `seed-${String(MAX_APPS_PER_WORKSPACE - 3).padStart(3, '0')}`
    const target = seeded.find(app => app.workspaceId === workspaceId && app.slug === targetSlug)!
    for (const [path, slug] of [
      ['projects/tool', 'tool'],
      ['projects/tool/packages/panel', 'panel'],
    ] as const) {
      await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path,
        command: 'bun run start',
        apiScopes: [],
        slug,
      })
    }

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        id: target._id,
      }),
    ).toMatchObject([{ id: target._id, slug: targetSlug }])
    const otherWorkspaceId = await createWorkspace('apps-targeted-other')
    const otherApp = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: otherWorkspaceId,
      path: 'private/tool',
      command: 'bun run start',
      apiScopes: [],
      slug: 'other-tool',
    })) as AppRow
    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        id: otherApp.id,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        id: 'not-an-app-id',
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        cwd: 'projects/tool/packages/panel/src/components',
      }),
    ).toMatchObject([{ slug: 'panel', anchorPath: 'projects/tool/packages/panel' }])
    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        cwd: 'projects/tool/docs',
      }),
    ).toMatchObject([{ slug: 'tool', anchorPath: 'projects/tool' }])
  })

  test('list rejects one app above the workspace cap before applying a narrowing path filter', async () => {
    const workspaceId = await createWorkspace('apps-overflow')
    await mutate(owner.client, 'testing/apps:seedWorkspaceAppsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      createdByUserId: owner.user._id,
      count: MAX_APPS_PER_WORKSPACE + 1,
      matchingPath: 'matching',
    })

    await expect(
      query(owner.client, 'domains/apps/model:listByWorkspace', { workspaceId }),
    ).rejects.toThrow('Workspace app limit exceeded')
    await expect(
      query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
        path: 'matching',
      }),
    ).rejects.toThrow('Workspace app limit exceeded')
  })

  test('enforces the owner, editor, and viewer app-management role matrix', async () => {
    const workspaceId = await createWorkspace('apps-update')
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: editor.user._id,
      role: 'editor',
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
    })

    await expectOneAudit(owner.client, workspaceId, 'app.deployed', () =>
      mutate(editor.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: 'site',
        command: 'bun run preview',
        port: 5173,
        now: 11_000,
      }),
    )
    await expect(
      mutate(editor.client, 'domains/apps/model:setVisibility', {
        workspaceId,
        slug: 'site',
        visibility: 'public',
      }),
    ).rejects.toThrow('Requires owner access')

    expect(
      (await query(viewer.client, 'domains/apps/model:listByWorkspace', {
        workspaceId,
      })) as AppRow[],
    ).toHaveLength(1)
    await expect(
      mutate(viewer.client, 'domains/apps/model:updateApp', {
        workspaceId,
        slug: 'site',
        port: 5174,
      }),
    ).rejects.toThrow('Requires editor access')
    await expect(
      mutate(viewer.client, 'domains/apps/model:setVisibility', {
        workspaceId,
        slug: 'site',
        visibility: 'folder',
      }),
    ).rejects.toThrow('Requires editor access')
    await expect(
      mutate(viewer.client, 'domains/apps/model:deleteApp', {
        workspaceId,
        slug: 'site',
      }),
    ).rejects.toThrow('Requires editor access')

    const visible = (await expectOneAudit(owner.client, workspaceId, 'app.visibility_changed', () =>
      mutate(owner.client, 'domains/apps/model:setVisibility', {
        workspaceId,
        slug: 'site',
        visibility: 'public',
        now: 12_000,
      }),
    )) as AppRow
    expect(visible.visibility).toBe('public')

    const privateApp = (await expectOneAudit(
      owner.client,
      workspaceId,
      'app.visibility_changed',
      () =>
        mutate(editor.client, 'domains/apps/model:setVisibility', {
          workspaceId,
          slug: 'site',
          visibility: 'folder',
          now: 13_000,
        }),
    )) as AppRow
    expect(privateApp.visibility).toBe('folder')
    await expectOneAudit(owner.client, workspaceId, 'app.deleted', () =>
      mutate(editor.client, 'domains/apps/model:deleteApp', {
        workspaceId,
        slug: 'site',
        now: 14_000,
      }),
    )
  })

  test('records gateway reconciliation status for API consumers', async () => {
    const workspaceId = await createWorkspace('apps-reconcile')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
    })
    const failed = (await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      slug: 'site',
      status: 'reconcile_failed',
      error: 'gateway_unavailable',
      now: 12_500,
    })) as AppRow
    expect(failed).toMatchObject({
      slug: 'site',
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'gateway_unavailable',
      updatedAt: 12_500,
    })
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'site',
      command: 'broken command',
      port: 4999,
      now: 12_600,
    })
    const restored = (await mutate(
      owner.client,
      'domains/apps/model:restoreRuntimeAfterFailedReconciliation',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        slug: 'site',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
        error: 'gateway_unavailable',
        now: 12_700,
      },
    )) as AppRow
    expect(restored).toMatchObject({
      command: 'bun run start',
      port: 4173,
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'gateway_unavailable',
      updatedAt: 12_700,
    })
  })

  test('failed reconciliation does not restore a port claimed by another app', async () => {
    const workspaceId = await createWorkspace('apps-port-rollback')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId,
      slug: 'site',
      command: 'broken command',
      port: 4_999,
    })
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'apps/other',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
    })

    const failed = (await mutate(
      owner.client,
      'domains/apps/model:restoreRuntimeAfterFailedReconciliation',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        slug: 'site',
        command: 'bun run start',
        apiScopes: [],
        port: 4_173,
        error: 'gateway_unavailable',
      },
    )) as AppRow

    expect(failed).toMatchObject({
      command: 'broken command',
      port: 4_999,
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'gateway_unavailable',
    })
  })

  test('viewer registration is rejected', async () => {
    const workspaceId = await createWorkspace('apps-readonly')
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })

    await expect(
      mutate(viewer.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/site',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
      }),
    ).rejects.toThrow('Requires editor access')
  })

  test('register ignores caller actorId spoofing unless the call is internal', async () => {
    const workspaceId = await createWorkspace('apps-actor-spoof')
    await expect(
      mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: 'apps/shared/site',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
        actorId: viewer.user._id,
      }),
    ).rejects.toThrow('actorId requires internalKey')
  })

  test('edge app resolution uses app visibility and origin workspace descriptor', async () => {
    const registered = await provisionRegisteredWorkspace('apps-edge')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
    })

    const folderDenied = await query(owner.client, 'domains/apps/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      appSlug: 'site',
    })
    expect(folderDenied).toEqual({ denied: true, visibility: 'folder', guestPrivate: true })

    const folderAllowed = (await query(owner.client, 'domains/apps/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      appSlug: 'site',
      viewerUserId: owner.user._id,
    })) as EdgeResolveRow
    expect(folderAllowed).toMatchObject({
      denied: false,
      visibility: 'folder',
      workspace: {
        id: registered.workspaceId,
        slug: registered.slug,
        httpsUrl: 'https://apps-edge.example.exe.xyz',
        vmName: 'apps-edge-vm',
      },
      origin: {
        httpsUrl: 'https://apps-edge.example.exe.xyz',
        gatewayAuthToken: expect.any(String),
        gatewayPathPrefix: '/public/app',
      },
    })

    await mutate(owner.client, 'domains/apps/model:setVisibility', {
      workspaceId: registered.workspaceId,
      slug: 'site',
      visibility: 'public',
    })
    const publicOpen = (await query(owner.client, 'domains/apps/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: registered.slug,
      appSlug: 'site',
    })) as EdgeResolveRow
    expect(publicOpen.denied).toBe(false)
    expect(publicOpen.visibility).toBe('public')
  })

  test('SUBS-IMPL-11 edge resolution identifies a paused workspace and names the app', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const registered = await provisionRegisteredWorkspace('apps-edge-paused')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/status',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
      name: 'Launch Status',
    })
    await mutate(owner.client, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })

    expect(
      await query(owner.client, 'domains/apps/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        appSlug: 'status',
      }),
    ).toEqual({ denied: true, visibility: 'folder', guestPrivate: true })

    expect(
      await query(owner.client, 'domains/apps/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        appSlug: 'status',
        viewerUserId: owner.user._id,
      }),
    ).toEqual({ paused: true, appName: 'Launch Status' })

    await mutate(owner.client, 'domains/workspaces/provisioning:markAdminArchived', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      now: Date.now(),
    })
    expect(
      await query(owner.client, 'domains/apps/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: registered.slug,
        appSlug: 'status',
        viewerUserId: owner.user._id,
      }),
    ).toEqual({ paused: true, appName: 'Launch Status' })
  })

  test('edge resolution treats a seeded replica like any recipient workspace app', async () => {
    const sourceWorkspaceId = await createWorkspace('edge-rep-src')
    const recipient = await provisionRegisteredWorkspace('edge-replica')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/apps/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'site',
    })
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: sourceWorkspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = createdShare.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })

    expect(
      await query(owner.client, 'domains/apps/model:resolveForEdge', {
        internalKey: INTERNAL_KEY,
        workspaceSlug: recipient.slug,
        appSlug: 'site',
        viewerUserId: owner.user._id,
      }),
    ).toMatchObject({
      denied: false,
      visibility: 'folder',
      workspace: { id: recipient.workspaceId, slug: recipient.slug },
      app: { slug: 'site', anchorPath: 'shared/project/apps/site' },
    })
  })

  test('accepting a share seeds replica name and icon without copying the origin port', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-meta-src')
    const recipientWorkspaceId = await createWorkspace('rep-meta-dst')
    const origin = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
      slug: 'site',
      name: 'Shared Status',
      icon: 'assets/status.png',
    })) as AppRow
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: sourceWorkspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }

    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: createdShare.share.id,
      toWorkspaceId: recipientWorkspaceId,
      mountPath: 'shared/project',
    })

    const [replica] = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: recipientWorkspaceId,
    })) as AppRow[]
    expect(replica).toMatchObject({
      name: 'Shared Status',
      icon: 'assets/status.png',
      sourceAppId: origin.id,
      sourceShareId: createdShare.share.id,
    })
    expect(replica?.port).not.toBe(origin.port)
  })

  test('origin name updates converge existing replicas without changing runtime status', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-name-src')
    const recipientWorkspaceId = await createWorkspace('rep-name-dst')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
      slug: 'site',
      name: 'Before',
    })
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: sourceWorkspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: createdShare.share.id,
      toWorkspaceId: recipientWorkspaceId,
      mountPath: 'shared/project',
    })
    await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId: recipientWorkspaceId,
      slug: 'site',
      status: 'reconciled',
      now: 20_000,
    })

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: sourceWorkspaceId,
      slug: 'site',
      name: 'After',
      now: 21_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: recipientWorkspaceId,
        slug: 'site',
      }),
    ).toMatchObject({ name: 'After', runtimeStatus: 'reconciled' })
  })

  test('origin icon updates converge existing replicas without changing runtime failure state', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-icon-src')
    const recipientWorkspaceId = await createWorkspace('rep-icon-dst')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'site',
      icon: 'before.png',
    })
    await shareWorkspacePath(sourceWorkspaceId, recipientWorkspaceId, 'project', 'shared/project')
    await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId: recipientWorkspaceId,
      slug: 'site',
      status: 'reconcile_failed',
      error: 'existing runtime failure',
      now: 30_000,
    })

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: sourceWorkspaceId,
      slug: 'site',
      icon: 'assets/after.png',
      now: 31_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: recipientWorkspaceId,
        slug: 'site',
      }),
    ).toMatchObject({
      icon: 'assets/after.png',
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'existing runtime failure',
    })
  })

  test('same-value origin icon updates advance replica cache versions without changing runtime', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-icon-ver-src')
    const recipientWorkspaceId = await createWorkspace('rep-icon-ver-dst')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'site',
      icon: 'icon.png',
    })
    await shareWorkspacePath(sourceWorkspaceId, recipientWorkspaceId, 'project', 'shared/project')
    await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId: recipientWorkspaceId,
      slug: 'site',
      status: 'reconciled',
    })
    const before = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId: recipientWorkspaceId,
      slug: 'site',
    })) as AppRow

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: sourceWorkspaceId,
      slug: 'site',
      icon: 'icon.png',
      now: before.updatedAt + 100,
    })

    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: recipientWorkspaceId,
        slug: 'site',
      }),
    ).toMatchObject({
      icon: 'icon.png',
      runtimeStatus: 'reconciled',
      updatedAt: before.updatedAt + 100,
    })
  })

  test('write-mode replica name edits converge to the origin and sibling replicas', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-write-src')
    const firstRecipientWorkspaceId = await createWorkspace('rep-write-a')
    const secondRecipientWorkspaceId = await createWorkspace('rep-write-b')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'site',
      name: 'Origin Name',
    })
    await shareWorkspacePath(
      sourceWorkspaceId,
      firstRecipientWorkspaceId,
      'project',
      'shared/project-a',
      'write',
    )
    await shareWorkspacePath(
      sourceWorkspaceId,
      secondRecipientWorkspaceId,
      'project',
      'shared/project-b',
      'write',
    )
    for (const [workspaceId, status, error] of [
      [sourceWorkspaceId, 'reconciled', undefined],
      [firstRecipientWorkspaceId, 'reconciled', undefined],
      [secondRecipientWorkspaceId, 'reconcile_failed', 'existing sibling failure'],
    ] as const) {
      await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        slug: 'site',
        status,
        error,
        now: 40_000,
      })
    }

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: firstRecipientWorkspaceId,
      slug: 'site',
      name: 'Edited From Replica',
      now: 41_000,
    })

    const [origin, firstReplica, secondReplica] = await Promise.all(
      [sourceWorkspaceId, firstRecipientWorkspaceId, secondRecipientWorkspaceId].map(workspaceId =>
        query(owner.client, 'domains/apps/model:getBySlug', { workspaceId, slug: 'site' }),
      ),
    )
    expect(origin).toMatchObject({ name: 'Edited From Replica', runtimeStatus: 'reconciled' })
    expect(firstReplica).toMatchObject({
      name: 'Edited From Replica',
      runtimeStatus: 'reconciled',
    })
    expect(secondReplica).toMatchObject({
      name: 'Edited From Replica',
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'existing sibling failure',
    })
  })

  test('write-share scope changes and rollback permanently revoke exports in every copy', async () => {
    const originWorkspaceId = await createWorkspace('export-origin')
    const firstWorkspaceId = await createWorkspace('export-first')
    const siblingWorkspaceId = await createWorkspace('export-sibling')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: originWorkspaceId,
      path: 'project/site',
      slug: 'site',
      command: 'bun run start',
      apiScopes: ['services'],
    })
    await shareWorkspacePath(originWorkspaceId, firstWorkspaceId, 'project', 'shared/a', 'write')
    await shareWorkspacePath(originWorkspaceId, siblingWorkspaceId, 'project', 'shared/b', 'write')
    const builder = async (workspaceId: string) => {
      const key = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        now: Date.now(),
      })) as { key: string; prefix: string }
      return { hashedKey: await hashApiKey(key.key), keyPrefix: key.prefix }
    }
    const workspaceIds = [originWorkspaceId, firstWorkspaceId, siblingWorkspaceId]
    const callers = await Promise.all(workspaceIds.map(builder))
    const exports = await Promise.all(
      workspaceIds.map(
        (workspaceId, index) =>
          mutate(convex, 'domains/apiKeys/appExports:exportCredential', {
            internalKey: INTERNAL_KEY,
            workspaceId,
            appSlug: 'site',
            caller: callers[index],
            expiration: 'never',
          }) as Promise<{ key: string; prefix: string }>,
      ),
    )
    const now = Date.now()
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: firstWorkspaceId,
      slug: 'site',
      apiScopes: ['members'],
      now,
    })
    const replica = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId: firstWorkspaceId,
      slug: 'site',
    })) as AppRow
    const midExport = (await mutate(convex, 'domains/apiKeys/appExports:exportCredential', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspaceId,
      appSlug: 'site',
      caller: callers[1],
      expiration: 'never',
    })) as { key: string; prefix: string }
    await mutate(owner.client, 'domains/apps/model:restoreRuntimeAfterFailedReconciliation', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspaceId,
      slug: 'site',
      command: replica.command,
      apiScopes: ['services'],
      port: replica.port,
      error: 'gateway_unavailable',
      now: now + 1,
    })
    for (const exported of [...exports, midExport]) {
      expect(
        await query(convex, 'domains/apiKeys/api:resolveCredential', {
          internalKey: INTERNAL_KEY,
          hashedKey: await hashApiKey(exported.key),
          keyPrefix: exported.prefix,
          now: now + 2,
        }),
      ).toEqual({ ok: false, reason: 'revoked' })
    }
    for (const workspaceId of workspaceIds) {
      expect(
        await query(owner.client, 'domains/apps/model:getBySlug', {
          workspaceId,
          slug: 'site',
        }),
      ).toMatchObject({ apiScopes: ['services'] })
    }
  })

  test('disabling a replica revokes its app key and keeps the row disabled', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-disabled-src')
    const recipientWorkspaceId = await createWorkspace('rep-disabled-dst')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'site',
      name: 'Before Disable',
      icon: 'before.png',
    })
    await shareWorkspacePath(sourceWorkspaceId, recipientWorkspaceId, 'project', 'shared/project')
    const replica = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId: recipientWorkspaceId,
      slug: 'site',
    })) as AppRow
    const minted = (await convex.mutation('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: replica.id,
      now: 49_000,
    })) as { key: string; prefix: string }
    const disabled = (await mutate(owner.client, 'domains/apps/model:setReplicaDisabled', {
      workspaceId: recipientWorkspaceId,
      slug: 'site',
      disabled: true,
      now: 50_000,
    })) as AppRow

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: sourceWorkspaceId,
      slug: 'site',
      name: 'After Disable',
      icon: 'after.png',
      now: 51_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: recipientWorkspaceId,
        slug: 'site',
      }),
    ).toMatchObject({
      id: disabled.id,
      name: 'Before Disable',
      icon: 'before.png',
      disabledAt: 50_000,
    })
    expect((await rawApiKeys()).find(key => key.prefix === minted.prefix)?.revokedAt).toBe(50_000)
    expect(
      await convex.query('domains/apiKeys/api:resolveCredential', {
        internalKey: INTERNAL_KEY,
        hashedKey: await hashApiKey(minted.key),
        keyPrefix: minted.prefix,
        now: 50_001,
      }),
    ).toEqual({ ok: false, reason: 'revoked' })
    await mutate(owner.client, 'domains/apps/model:setReplicaDisabled', {
      workspaceId: recipientWorkspaceId,
      slug: 'site',
      disabled: false,
      now: 52_000,
    })
    expect((await rawApiKeys()).find(key => key.prefix === minted.prefix)?.revokedAt).toBe(50_000)
  })

  test('share convergence removal revokes the replica app key', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-remove-src')
    const recipientWorkspaceId = await createWorkspace('rep-remove-dst')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'site',
    })
    const shareId = await shareWorkspacePath(
      sourceWorkspaceId,
      recipientWorkspaceId,
      'project',
      'shared/project',
    )
    const replica = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId: recipientWorkspaceId,
      slug: 'site',
    })) as AppRow
    const minted = (await convex.mutation('domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: replica.id,
      now: 55_000,
    })) as { prefix: string }

    await mutate(owner.client, 'domains/shares/model:revokeShare', {
      shareId,
      fromWorkspaceId: sourceWorkspaceId,
      now: 56_000,
    })

    expect((await rawApiKeys()).find(key => key.prefix === minted.prefix)?.revokedAt).toBe(56_000)
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: recipientWorkspaceId,
        slug: 'site',
      }),
    ).toBeNull()
  })

  test('origin runtime updates still mark enabled replicas for reconciliation', async () => {
    const sourceWorkspaceId = await createWorkspace('rep-runtime-src')
    const recipientWorkspaceId = await createWorkspace('rep-runtime-dst')
    const origin = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: sourceWorkspaceId,
      path: 'project/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4_173,
      slug: 'site',
      name: 'Runtime App',
      icon: 'icon.png',
    })) as AppRow
    await shareWorkspacePath(sourceWorkspaceId, recipientWorkspaceId, 'project', 'shared/project')
    await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId: recipientWorkspaceId,
      slug: 'site',
      status: 'reconciled',
      now: 60_000,
    })

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: sourceWorkspaceId,
      slug: 'site',
      command: 'bun run preview',
      apiScopes: ['members'],
      now: 61_000,
    })

    const replica = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId: recipientWorkspaceId,
      slug: 'site',
    })) as AppRow
    expect(replica).toMatchObject({
      command: 'bun run preview',
      apiScopes: ['members'],
      name: 'Runtime App',
      icon: 'icon.png',
      runtimeStatus: 'reconciling',
    })
    expect(replica.port).not.toBe(origin.port)
  })
})

async function createWorkspace(prefix: string): Promise<string> {
  return await createWorkspaceFor(owner.client, prefix)
}

async function shareWorkspacePath(
  sourceWorkspaceId: string,
  recipientWorkspaceId: string,
  path: string,
  mountPath: string,
  mode: 'read' | 'write' = 'read',
): Promise<string> {
  const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
    internalKey: INTERNAL_KEY,
    fromWorkspaceId: sourceWorkspaceId,
    toEmail: owner.user.email,
    path,
    mode,
  })) as { share: { id: string } }
  await mutate(owner.client, 'domains/shares/model:acceptShare', {
    shareId: created.share.id,
    toWorkspaceId: recipientWorkspaceId,
    mountPath,
  })
  return created.share.id
}

async function createWorkspaceFor(client: ConvexHttpClient, prefix: string): Promise<string> {
  await mutate(client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const workspaceId = (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} Workspace`,
  })) as string
  await mutate(client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  return workspaceId
}

async function provisionRegisteredWorkspace(
  prefix: string,
): Promise<{ workspaceId: string; slug: string }> {
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
  await mutate(owner.client, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash: await sha256Hex(provisioningToken),
    workspaceHint: begun.workspaceId,
    vmName: 'apps-edge-vm',
    sshDest: 'exedev@apps-edge.example.exe.xyz',
    httpsUrl: 'https://apps-edge.example.exe.xyz',
    now: now + 1,
  })
  return { workspaceId: begun.workspaceId, slug }
}

async function expectOneAudit(
  client: ConvexHttpClient,
  workspaceId: string,
  eventName: string,
  mutateOnce: () => Promise<unknown>,
): Promise<unknown> {
  const before = await auditEvents(client, workspaceId)
  const result = await mutateOnce()
  const after = await auditEvents(client, workspaceId)
  expect(after).toHaveLength(before.length + 1)
  expect(newAuditEvents(before, after)).toEqual([expect.objectContaining({ event: eventName })])
  return result
}

async function auditEvents(client: ConvexHttpClient, workspaceId: string): Promise<AuditRow[]> {
  return (await query(client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as AuditRow[]
}

function newAuditEvents(before: AuditRow[], after: AuditRow[]): AuditRow[] {
  const existingIds = new Set(before.map(event => event.id))
  return after.filter(event => !existingIds.has(event.id))
}

async function rawApiKeys(): Promise<Array<{ prefix: string; revokedAt?: number }>> {
  return (await convex.query('testing/apiKeys:rawApiKeysForTest', {
    internalKey: INTERNAL_KEY,
  })) as Array<{ prefix: string; revokedAt?: number }>
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

type AppRow = Omit<App, 'canonicalUrl'>

interface AnchorRow {
  workspaceId: string
  path: string
  kind: 'app' | 'agent' | 'publish' | 'share-root'
  state: 'active' | 'broken' | 'orphaned'
}

interface AuditRow {
  id: string
  event: string
}

interface EdgeResolveRow {
  denied: false
  visibility: 'folder' | 'public'
  workspace: {
    id: string
    slug: string
    httpsUrl: string
    vmName: string
  }
  origin: {
    httpsUrl: string
    gatewayAuthToken: string
    gatewayPathPrefix: string
  }
}
