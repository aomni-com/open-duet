import { describe, expect, test } from 'bun:test'

import { toJSONSchema } from 'zod'

import { AnchorStateSchema } from '../anchors/index'
import { COLLECTION_PAGE_DEFAULT_LIMIT } from '../pagination/index'
import { MAX_ICON_PATH_UTF8_BYTES } from '../relative-path/index'
import type { AppApiCapability } from '../scopes/index'
import {
  appForCwd,
  appControls,
  type AppControlsSubject,
  LaunchAppQuerySchema,
  AppListResponseSchema,
  AppResponseSchema,
  AppReconciliationFailureSchema,
  canonicalAppUrl,
  GatewayAppConfigSchema,
  GatewayAppsReconcileRequestSchema,
  MAX_APP_COMMAND_UTF8_BYTES,
  MAX_APP_CONTENT_GENERATION_UTF8_BYTES,
  MAX_APP_INSTALL_COMMAND_UTF8_BYTES,
  MAX_APP_PUBLIC_URL_UTF8_BYTES,
  ListAppsQuerySchema,
  RegisterAppRequestSchema,
  AppDeclarationSchema,
  AppIconSchema,
  sameGatewayAppConfig,
  sameGatewayAppRuntimeConfig,
  SetAppDisabledRequestSchema,
  UpdateAppRequestSchema,
} from './index'

describe('apps wire contract', () => {
  const app = {
    id: 'app_1',
    workspaceId: 'workspace_1',
    anchorId: 'anchor_1',
    anchorPath: 'apps/reporting',
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [] as AppApiCapability[],
    port: 4173,
    slug: 'reporting',
    visibility: 'folder',
    canonicalUrl: 'https://reporting--acme.edge.duet.so/',
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_1',
    createdAt: 100,
    updatedAt: 200,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  } as const

  test('registration requires an explicit app API scope declaration', () => {
    expect(
      RegisterAppRequestSchema.safeParse({
        path: 'apps/reporting',
        command: 'bun run start',
        slug: 'reporting',
      }).success,
    ).toBe(false)
    expect(
      AppDeclarationSchema.safeParse({
        path: 'welcome/hello-app',
        command: 'bun run server.ts',
        slug: 'hello',
      }).success,
    ).toBe(false)
  })

  test('registration accepts an omitted port for backend allocation', () => {
    expect(
      RegisterAppRequestSchema.parse({
        path: 'apps/reporting',
        command: 'bun run start',
        apiScopes: [],
        slug: 'reporting',
      }),
    ).toEqual({
      path: 'apps/reporting',
      command: 'bun run start',
      apiScopes: [],
      slug: 'reporting',
    })
  })

  test('bounds every variable-width runtime field before an app can be stored', () => {
    const registration = {
      path: 'apps/reporting',
      command: 'x'.repeat(MAX_APP_COMMAND_UTF8_BYTES),
      installCommand: 'x'.repeat(MAX_APP_INSTALL_COMMAND_UTF8_BYTES),
      apiScopes: [],
      slug: 'reporting',
    }
    expect(RegisterAppRequestSchema.parse(registration)).toEqual(registration)
    expect(
      RegisterAppRequestSchema.safeParse({
        ...registration,
        command: `${'x'.repeat(MAX_APP_COMMAND_UTF8_BYTES - 3)}🚀`,
      }).success,
    ).toBe(false)
    expect(
      RegisterAppRequestSchema.safeParse({
        ...registration,
        installCommand: `${'x'.repeat(MAX_APP_INSTALL_COMMAND_UTF8_BYTES - 3)}🚀`,
      }).success,
    ).toBe(false)

    const config = {
      appId: 'app_1',
      slug: 'reporting',
      command: 'bun run start',
      port: 4173,
      anchorPath: 'apps/reporting',
      apiScopes: [],
      contentGeneration: 'x'.repeat(MAX_APP_CONTENT_GENERATION_UTF8_BYTES),
    }
    expect(GatewayAppConfigSchema.parse(config)).toEqual(config)
    expect(
      GatewayAppConfigSchema.safeParse({
        ...config,
        contentGeneration: `${'x'.repeat(MAX_APP_CONTENT_GENERATION_UTF8_BYTES - 3)}🚀`,
      }).success,
    ).toBe(false)
  })

  test('bounds the public URL generated into app list and VM rows', () => {
    const config = {
      appId: 'app_1',
      slug: 'reporting',
      command: 'bun run start',
      port: 4173,
      anchorPath: 'apps/reporting',
      apiScopes: [],
    }
    expect(
      GatewayAppConfigSchema.safeParse({
        ...config,
        canonicalUrl: `https://x.test/${'u'.repeat(MAX_APP_PUBLIC_URL_UTF8_BYTES)}`,
      }).success,
    ).toBe(false)
  })

  test('registration and PATCH normalize app API scopes as whole-set values', () => {
    const registration = RegisterAppRequestSchema.parse({
      path: 'apps/reporting',
      command: 'bun run start',
      apiScopes: ['services', 'files:read', 'services'],
      slug: 'reporting',
    })
    const replacement = UpdateAppRequestSchema.parse({ apiScopes: ['members'] })

    expect(registration.apiScopes).toEqual(['files:read', 'services'])
    expect(replacement).toEqual({ apiScopes: ['members'] })
  })

  test('rejects unsafe relative icon paths', () => {
    const unsafePaths = [
      '/icon.png',
      'C:/icon.png',
      'icons\\icon.png',
      'icons/\u0000icon.png',
      'icons//icon.png',
      './icon.png',
      'icons/../icon.png',
    ]

    for (const icon of unsafePaths) {
      expect(
        RegisterAppRequestSchema.safeParse({
          path: 'apps/reporting',
          command: 'bun run start',
          apiScopes: [],
          slug: 'reporting',
          icon,
        }).success,
      ).toBe(false)
    }
  })

  test('trims app names and enforces the 1..64 character boundary', () => {
    const registration = {
      path: 'apps/reporting',
      command: 'bun run start',
      apiScopes: [],
      slug: 'reporting',
    }

    expect(RegisterAppRequestSchema.parse({ ...registration, name: '  Reporting  ' }).name).toBe(
      'Reporting',
    )
    expect(RegisterAppRequestSchema.parse({ ...registration, name: 'a'.repeat(64) }).name).toBe(
      'a'.repeat(64),
    )
    expect(RegisterAppRequestSchema.safeParse({ ...registration, name: '   ' }).success).toBe(false)
    expect(
      RegisterAppRequestSchema.safeParse({ ...registration, name: 'a'.repeat(65) }).success,
    ).toBe(false)
  })

  test('accepts name-only and icon-only app updates', () => {
    expect(UpdateAppRequestSchema.parse({ name: '  Reporting  ' })).toEqual({ name: 'Reporting' })
    expect(UpdateAppRequestSchema.parse({ icon: '  assets/icon.png  ' })).toEqual({
      icon: 'assets/icon.png',
    })
  })

  test('app icon paths share the product icon UTF-8 byte ceiling', () => {
    const atLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 4)}🚀`
    const overLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 3)}🚀`

    expect(AppIconSchema.parse(atLimit)).toBe(atLimit)
    expect(AppIconSchema.safeParse(overLimit).success).toBe(false)
  })

  test('keeps app identity request schemas renderable for generated API docs', () => {
    expect(() => toJSONSchema(RegisterAppRequestSchema)).not.toThrow()
    expect(() => toJSONSchema(UpdateAppRequestSchema)).not.toThrow()
  })

  test('distinguishes an omitted app path from the drive root', () => {
    expect(ListAppsQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(ListAppsQuerySchema.parse({ path: '' })).toEqual({
      path: '',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(ListAppsQuerySchema.parse({ path: '', scope: 'children' })).toEqual({
      path: '',
      scope: 'children',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(ListAppsQuerySchema.safeParse({ scope: 'children' }).success).toBe(false)
  })

  test('keeps exact-id, containing-cwd, and path app filters mutually exclusive', () => {
    expect(ListAppsQuerySchema.parse({ id: 'app_1' })).toEqual({
      id: 'app_1',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(ListAppsQuerySchema.parse({ cwd: 'projects/demo/../app/src' })).toEqual({
      cwd: 'projects/demo/../app/src',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    for (const query of [
      { id: 'app_1', cwd: 'projects/app' },
      { id: 'app_1', path: 'projects' },
      { cwd: 'projects/app', path: 'projects' },
      { cwd: 'projects/app', scope: 'self' },
    ]) {
      expect(ListAppsQuerySchema.safeParse(query).success).toBe(false)
    }
    expect(ListAppsQuerySchema.safeParse({ id: '' }).success).toBe(false)
    expect(ListAppsQuerySchema.safeParse({ cwd: '../outside' }).success).toBe(false)
  })

  test('keeps the app list query schema renderable for generated API docs', () => {
    expect(() => toJSONSchema(ListAppsQuerySchema)).not.toThrow()
  })

  test('exports the anchor state enum used by app wire values', () => {
    expect(AnchorStateSchema.options).toEqual(['active', 'broken', 'orphaned'])
  })

  test('requires anchor state on every app wire value', () => {
    const capabilities = { register: true }
    const appWithoutAnchorState = Object.fromEntries(
      Object.entries(app).filter(([key]) => key !== 'anchorState'),
    )
    expect(
      AppListResponseSchema.safeParse({
        items: [appWithoutAnchorState],
        nextCursor: null,
        meta: { capabilities },
      }).success,
    ).toBe(false)
    expect(
      AppListResponseSchema.parse({
        items: [{ ...app, anchorState: 'broken' }],
        nextCursor: null,
        meta: { capabilities },
      }).items[0]?.anchorState,
    ).toBe('broken')
  })

  test('seed app registrations share the runtime registration grammar', () => {
    expect(
      AppDeclarationSchema.parse({
        path: 'welcome/hello-app',
        slug: 'hello',
        command: 'bun run server.ts',
        apiScopes: [],
        installCommand: '  bun install  ',
        port: 3000,
      }),
    ).toEqual({
      path: 'welcome/hello-app',
      slug: 'hello',
      command: 'bun run server.ts',
      apiScopes: [],
      installCommand: 'bun install',
      port: 3000,
    })
    expect(
      AppDeclarationSchema.safeParse({
        path: '../outside',
        slug: 'hello',
        command: 'bun run server.ts',
        apiScopes: [],
      }).success,
    ).toBe(false)
  })

  test('seed app registrations carry app name and icon identity', () => {
    expect(
      AppDeclarationSchema.parse({
        path: 'welcome/hello-app',
        slug: 'hello',
        command: 'bun run server.ts',
        apiScopes: [],
        name: '  Hello  ',
        icon: '  assets/icon.png  ',
      }),
    ).toMatchObject({ name: 'Hello', icon: 'assets/icon.png' })
  })

  test('install commands round-trip across app requests, responses, and gateway config', () => {
    expect(
      RegisterAppRequestSchema.parse({
        path: 'apps/reporting',
        command: 'bun run start',
        apiScopes: [],
        installCommand: '  bun install  ',
        slug: 'reporting',
      }).installCommand,
    ).toBe('bun install')
    expect(
      UpdateAppRequestSchema.parse({ installCommand: '  bun install --frozen-lockfile  ' }),
    ).toEqual({ installCommand: 'bun install --frozen-lockfile' })
    expect(
      AppListResponseSchema.parse({
        items: [{ ...app, installCommand: 'bun install' }],
        nextCursor: null,
        meta: { capabilities: { register: true } },
      }).items[0]?.installCommand,
    ).toBe('bun install')
    expect(
      GatewayAppsReconcileRequestSchema.parse({
        apps: [
          {
            slug: 'reporting',
            appId: 'app_1',
            command: 'bun run start',
            installCommand: 'bun install',
            port: 4173,
            anchorPath: 'apps/reporting',
            apiScopes: [],
          },
        ],
        requiredReadySlugs: ['reporting'],
      }),
    ).toMatchObject({
      apps: [expect.objectContaining({ installCommand: 'bun install' })],
      requiredReadySlugs: ['reporting'],
    })
    expect(
      GatewayAppsReconcileRequestSchema.safeParse({
        apps: [
          {
            appId: 'app_1',
            slug: 'reporting',
            command: 'bun run start',
            port: 4173,
            anchorPath: 'apps/reporting',
            apiScopes: [],
          },
        ],
        requiredReadySlugs: ['missing'],
      }).success,
    ).toBe(false)
    expect(
      RegisterAppRequestSchema.safeParse({
        path: 'apps/reporting',
        command: 'bun run start',
        apiScopes: [],
        installCommand: '   ',
        slug: 'reporting',
      }).success,
    ).toBe(false)
    expect(UpdateAppRequestSchema.safeParse({ installCommand: '   ' }).success).toBe(false)
  })

  test('gateway config equality distinguishes identity from process changes only by name', () => {
    const config = GatewayAppConfigSchema.parse({
      slug: 'reporting',
      appId: 'app_1',
      name: 'Reporting',
      command: 'bun run start',
      installCommand: 'bun install',
      port: 4173,
      anchorPath: 'apps/reporting',
      apiScopes: [],
    })
    const renamed = { ...config, name: 'Analytics' }

    expect(config.name).toBe('Reporting')
    expect(sameGatewayAppRuntimeConfig(config, config)).toBe(true)
    expect(sameGatewayAppConfig(config, config)).toBe(true)
    expect(sameGatewayAppRuntimeConfig(config, renamed)).toBe(true)
    expect(sameGatewayAppConfig(config, renamed)).toBe(false)
    expect(config.contentGeneration).toBeUndefined()

    const regenerated = { ...config, contentGeneration: 'etag-2' }
    expect(sameGatewayAppRuntimeConfig(config, regenerated)).toBe(false)
    expect(sameGatewayAppConfig(config, regenerated)).toBe(false)

    for (const changed of [
      { ...config, slug: 'analytics' },
      { ...config, command: 'bun run other' },
      { ...config, installCommand: 'bun install --production' },
      { ...config, port: 4174 },
      { ...config, anchorPath: 'apps/analytics' },
      { ...config, appId: 'app_2' },
      { ...config, apiScopes: ['members'] as AppApiCapability[] },
    ]) {
      expect(sameGatewayAppRuntimeConfig(config, changed)).toBe(false)
      expect(sameGatewayAppConfig(config, changed)).toBe(false)
    }
  })

  test('gateway app config tolerates skew by stripping, never rejecting', () => {
    const oldPayload = {
      slug: 'reporting',
      appId: 'app_1',
      command: 'bun run start',
      port: 4173,
      anchorPath: 'apps/reporting',
      apiScopes: [] as AppApiCapability[],
    }
    const currentPayload = {
      ...oldPayload,
      visibility: 'public' as const,
      canonicalUrl: 'https://reporting--acme.edge.duet.so/',
    }

    expect(GatewayAppConfigSchema.parse(oldPayload)).toEqual(oldPayload)
    expect(GatewayAppConfigSchema.parse(currentPayload)).toEqual(currentPayload)
    // Unknown fields are dropped, not preserved and never rejected: report
    // schemas extend this one, and stripping is what keeps credential fields
    // from echoing through reconciliation reports.
    expect(
      GatewayAppConfigSchema.parse({ ...currentPayload, futureField: { generation: 2 } }),
    ).toEqual(currentPayload)
  })

  test('gateway config comparators exclude visibility metadata', () => {
    const privateConfig = GatewayAppConfigSchema.parse({
      slug: 'reporting',
      appId: 'app_1',
      command: 'bun run start',
      port: 4173,
      anchorPath: 'apps/reporting',
      apiScopes: [],
      visibility: 'folder',
    })
    const publicConfig = {
      ...privateConfig,
      visibility: 'public' as const,
      canonicalUrl: 'https://reporting--acme.edge.duet.so/',
    }

    expect(sameGatewayAppRuntimeConfig(privateConfig, publicConfig)).toBe(true)
    expect(sameGatewayAppConfig(privateConfig, publicConfig)).toBe(true)
  })

  test('selects the deepest app containing a canonical cwd', () => {
    const apps = [
      { slug: 'workspace', anchorPath: 'apps/workspace' },
      { slug: 'editor', anchorPath: 'apps/workspace/editor' },
    ]

    expect(appForCwd('apps/workspace/editor', apps)).toBe(apps[1])
    expect(appForCwd('apps/workspace/editor/src', apps)).toBe(apps[1])
  })

  test('selects apps segment-wise with slug tie-breaking and rejects invalid cwd values', () => {
    const sibling = { slug: 'foo', anchorPath: 'apps/foo' }
    const zeta = { slug: 'zeta', anchorPath: 'apps/shared' }
    const alpha = { slug: 'alpha', anchorPath: 'apps/shared' }
    const apps = [sibling, zeta, alpha]

    expect(appForCwd('apps/./shared/src', apps)).toBe(alpha)
    expect(appForCwd('apps/foo-bar', apps)).toBeUndefined()
    expect(appForCwd(undefined, apps)).toBeUndefined()
    expect(appForCwd('', apps)).toBeUndefined()
    expect(appForCwd('../apps/foo', apps)).toBeUndefined()
  })

  test('app controls answer to the workspace role and to the share the app came from', () => {
    const origin: AppControlsSubject = {}
    const writeReplica: AppControlsSubject = { sourceShareId: 's', sourceShareMode: 'write' }
    const readReplica: AppControlsSubject = { sourceShareId: 's', sourceShareMode: 'read' }

    expect(appControls('owner', origin)).toEqual({
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    })
    // Only an owner publishes; an editor still owns the runtime and can unpublish.
    expect(appControls('editor', origin)).toMatchObject({ updateRuntime: true, makePublic: false })
    expect(appControls('viewer', origin)).toEqual({
      manageDomain: false,
      updateRuntime: false,
      makePublic: false,
      makePrivate: false,
      delete: false,
    })

    // Sharing an app is sharing files: write access carries the runtime and the
    // right to publish the recipient's own copy. Read access carries neither.
    expect(appControls('owner', writeReplica)).toMatchObject({
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
    })
    expect(appControls('owner', readReplica)).toMatchObject({
      updateRuntime: false,
      makePublic: false,
      makePrivate: false,
    })
    // A replica is removed by dropping the share, never by deleting the app.
    expect(appControls('owner', writeReplica).delete).toBe(false)
    // A recipient who switched their copy off cannot publish it while it is dark.
    expect(appControls('owner', { ...writeReplica, disabledAt: 300 })).toMatchObject({
      updateRuntime: false,
      makePublic: false,
    })
    // An app with no folder can only be repaired or removed; a public link for
    // it would answer nothing.
    expect(appControls('owner', { anchorState: 'broken' })).toEqual({
      manageDomain: true,
      updateRuntime: true,
      makePublic: false,
      makePrivate: false,
      delete: true,
    })
  })

  test('domain management belongs to local editors even for broken, disabled and read-only shared apps', () => {
    for (const subject of [
      {},
      { anchorState: 'broken' as const },
      { disabledAt: 300 },
      { sourceShareId: 'share_1', sourceShareMode: 'read' as const },
      { listingSubscriptionId: 'subscription_1', disabledAt: 300 },
    ]) {
      expect(appControls('owner', subject)).toMatchObject({ manageDomain: true })
      expect(appControls('editor', subject)).toMatchObject({ manageDomain: true })
      expect(appControls('viewer', subject)).toMatchObject({ manageDomain: false })
    }
  })

  test('a marketplace-managed app keeps visibility local but refuses edit and delete', () => {
    const managed: AppControlsSubject = { listingSubscriptionId: 'sub_1' }
    // The publisher's declaration owns the runtime, and the row leaves by
    // uninstalling the subscription — never by deleting the app.
    expect(appControls('owner', managed)).toEqual({
      manageDomain: true,
      updateRuntime: false,
      makePublic: true,
      makePrivate: true,
      delete: false,
    })
    expect(appControls('viewer', managed)).toEqual({
      manageDomain: false,
      updateRuntime: false,
      makePublic: false,
      makePrivate: false,
      delete: false,
    })
  })

  test('a managed app that is switched off is installing, and is nobody to delete', () => {
    /* The only way a subscription's app row is both managed and switched off:
       it was just registered and its first pull has not landed
       (`registerAppImpl` disables until `appliedEtag` exists). The publisher
       DROPPING an app deletes the row outright, so "managed, disabled and
       permanent" is not a state a subscriber can reach.

       Deleting one mid-install is therefore never the way out — the install
       either lands or the subscription is uninstalled — and a delete offered
       here races the pull that is about to enable it. */
    const installing: AppControlsSubject = { listingSubscriptionId: 'sub_1', disabledAt: 300 }

    expect(appControls('owner', installing)).toEqual({
      manageDomain: true,
      updateRuntime: false,
      makePublic: false,
      makePrivate: false,
      delete: false,
    })
  })

  test('an app that is switched off offers no visibility switch', () => {
    // It cannot serve, so publishing it hands out an address with nothing
    // behind it. True whatever kind of app it is.
    expect(appControls('owner', { disabledAt: 300 })).toMatchObject({
      makePublic: false,
      makePrivate: false,
    })
  })

  test('subscription linkage rides the app contract', () => {
    const parsed = AppListResponseSchema.parse({
      items: [{ ...app, listingSubscriptionId: 'sub_1' }],
      nextCursor: null,
      meta: { capabilities: { register: true } },
    })
    expect(parsed.items[0]?.listingSubscriptionId).toBe('sub_1')
  })

  test('replica linkage and durable disable round-trip through the app contract', () => {
    const replica = {
      ...app,
      sourceShareId: 'share_1',
      sourceAppId: 'app_origin',
      disabledAt: 300,
      disabledByUserId: 'user_2',
    }
    expect(
      AppListResponseSchema.parse({
        items: [replica],
        nextCursor: null,
        meta: { capabilities: { register: true } },
      }).items[0],
    ).toEqual(replica)
    expect(SetAppDisabledRequestSchema.parse({ disabled: true })).toEqual({ disabled: true })
  })

  test('parses every app, including apps without custom domains', () => {
    expect(
      AppListResponseSchema.parse({
        items: [app],
        nextCursor: null,
        meta: { capabilities: { register: true } },
      }).items[0],
    ).toEqual(app)
  })

  test('app responses carry app name and icon identity', () => {
    const identifiedApp = { ...app, name: 'Reporting', icon: 'assets/icon.png' }

    expect(
      AppListResponseSchema.parse({
        items: [identifiedApp],
        nextCursor: null,
        meta: { capabilities: { register: true } },
      }).items[0],
    ).toEqual(identifiedApp)
  })

  test('pins reconciliation failures to the operation and resulting app', () => {
    expect(
      AppReconciliationFailureSchema.parse({
        error: 'app_reconcile_failed',
        operation: 'update',
        reason: 'gateway_failed',
        app: { ...app, runtimeStatus: 'reconcile_failed', reconciliationError: 'gateway_failed' },
      }),
    ).toMatchObject({ operation: 'update', app: { slug: 'reporting' } })
  })

  test('derives the canonical launch URL from validated slugs', () => {
    expect(canonicalAppUrl('acme', 'reporting', 'edge.duet.so')).toBe(
      'https://reporting--acme.edge.duet.so/',
    )
    expect(canonicalAppUrl('acme', 'reporting', 'edge-staging.duet.so')).toBe(
      'https://reporting--acme.edge-staging.duet.so/',
    )
    expect(() => canonicalAppUrl('acme', 'api', 'edge.duet.so')).toThrow()
  })

  test('uses the active domain for standalone links while retaining the standard launch address', async () => {
    const { primaryAppUrl } = await import('./index')
    const active = { hostname: 'tools.example.com', status: 'active' as const }
    expect(primaryAppUrl('acme', 'reporting', 'edge.duet.so', active)).toBe(
      'https://tools.example.com/',
    )
    expect(canonicalAppUrl('acme', 'reporting', 'edge.duet.so')).toBe(
      'https://reporting--acme.edge.duet.so/',
    )
  })

  test('keeps standalone links on Duet while a domain is absent, waiting, failed or removing', async () => {
    const { primaryAppUrl } = await import('./index')
    const standard = 'https://reporting--acme.edge-staging.duet.so/'
    expect(primaryAppUrl('acme', 'reporting', 'edge-staging.duet.so')).toBe(standard)
    for (const status of ['pending', 'verifying', 'failed', 'removing'] as const) {
      expect(
        primaryAppUrl('acme', 'reporting', 'edge-staging.duet.so', {
          hostname: 'tools.example.com',
          status,
        }),
      ).toBe(standard)
    }
  })

  test('carries domain metadata through app and gateway responses without treating it as process configuration', () => {
    const customDomain = { hostname: 'tools.example.com', status: 'active' as const }
    expect(AppResponseSchema.parse({ app: { ...app, customDomain } }).app).toEqual({
      ...app,
      customDomain,
    })
    const config = {
      appId: app.id,
      slug: app.slug,
      command: app.command,
      port: app.port,
      anchorPath: app.anchorPath,
      apiScopes: app.apiScopes,
    }
    const domainConfig = GatewayAppConfigSchema.parse({ ...config, customDomain })
    expect(domainConfig).toEqual({ ...config, customDomain })
    expect(sameGatewayAppRuntimeConfig(config, domainConfig)).toBe(true)
    expect(sameGatewayAppConfig(config, domainConfig)).toBe(true)
  })

  test('rejects blank runtime fields and reserved app hostnames at the API boundary', () => {
    expect(
      RegisterAppRequestSchema.safeParse({
        path: '   ',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
        slug: 'reporting',
      }).success,
    ).toBe(false)
    expect(
      RegisterAppRequestSchema.safeParse({
        path: 'apps/reporting',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
        slug: 'api',
      }).success,
    ).toBe(false)
    expect(UpdateAppRequestSchema.safeParse({ command: '   ' }).success).toBe(false)
  })
})

test('launch return targets require a paired normalized hostname and relative bounded path', () => {
  const schema = LaunchAppQuerySchema
  expect(schema.parse({})).toEqual({})
  expect(schema.parse({ host: 'aomni.co', path: '/deep?q=a%2Fb' })).toEqual({
    host: 'aomni.co',
    path: '/deep?q=a%2Fb',
  })
  expect(schema.safeParse({ host: 'todo--acme.edge.duet.so', path: '/' }).success).toBe(true)
  for (const value of [
    { host: 'aomni.co' },
    { path: '/' },
    { host: 'https://aomni.co', path: '/' },
    { host: 'aomni.co:443', path: '/' },
    { host: 'aomni.co', path: '//evil.test/x' },
    { host: 'aomni.co', path: '/\\evil.test' },
    { host: 'aomni.co', path: '/x#fragment' },
    { host: 'aomni.co', path: '/\n/evil.test' },
    { host: 'aomni.co', path: `/x?${'a'.repeat(8192)}` },
  ])
    expect(schema.safeParse(value).success).toBe(false)
})
