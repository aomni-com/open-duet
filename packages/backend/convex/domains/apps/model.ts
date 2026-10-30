import { v, type Infer } from 'convex/values'

import {
  APP_AUTO_PORT_RANGE_END,
  APP_AUTO_PORT_RANGE_START,
  AppIconSchema,
  AppApiScopesSchema,
  AppCommandSchema,
  AppContentGenerationSchema,
  AppInstallCommandSchema,
  AppNameSchema,
  AppReconciliationErrorSchema,
  AppReconciliationReportSchema,
  AppSlugSchema,
  AppVisibilitySchema,
  MAX_APPS_PER_WORKSPACE,
  appsUnderPath,
  assertValidSlug,
  canonicalAgentCwd,
  firstAvailableAutoAssignedPort,
  normalizeDrivePath,
  normalizeSlug,
  sameApiScopes,
  sameGatewayAppConfig,
  type Anchor,
  type AppReconciliationReport,
  type AppVisibility,
  type GatewayAppConfig,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { getOrCreateAnchorForPath, normalizeAnchorPath, requireAnchor } from '../anchors/model'
import {
  requireApiInternalKey,
  revokeAppKeysForApp,
  revokeExportedAppKeysForScopeChange,
} from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { domainSummaryForApp } from '../customDomains/model'
import { availableSharedReplicaSlug } from '../replication/shared'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { deriveVmToken } from '../workspaces/vmToken'
import {
  reconcileReplicasForOriginApp,
  replicaSourceShareMode,
  requireWriteModeReplicaOriginApp,
} from './replication'
import { deleteAppRow } from './teardown'

const visibilityValidator = v.union(v.literal('folder'), v.literal('public'))

/**
 * The Convex-side twin of the contract's `AppDeclarationSchema` — the closed
 * validator every mutation that accepts app declarations must share, so the
 * wire shape cannot drift per caller. A field added to the zod schema and not
 * here rejects a payload whose TypeScript is perfectly green.
 */
export const appDeclarationValidator = v.object({
  path: v.string(),
  slug: v.string(),
  command: v.string(),
  apiScopes: v.array(v.string()),
  installCommand: v.optional(v.string()),
  port: v.optional(v.number()),
  name: v.optional(v.string()),
  icon: v.optional(v.string()),
})
/** The declaration as the wire carries it — scopes still unvalidated strings;
 * `registerAppImpl` parses them through the real schema before writing. */
export type WireAppDeclaration = Infer<typeof appDeclarationValidator>

export interface RegisterAppImplArgs {
  workspaceId: Id<'workspaces'>
  path: string
  command: string
  apiScopes: string[]
  installCommand?: string
  port?: number
  slug?: string
  name?: string
  icon?: string
  /**
   * Present when a marketplace subscription owns this registration. This
   * linkage — `listingSubscriptionId` and `contentGeneration`, plus the
   * disabled-until-content-lands state `contentGeneration` implies — is the
   * ONLY way an installed app row may differ from a directly registered one.
   * Everything else (visibility, port assignment, slug handling, runtime
   * status) is shared behaviour with no caller-specific branching.
   */
  listingSubscription?: { id: Id<'agentSubscriptions'>; appliedEtag?: string }
  actorId: Id<'users'>
  now: number
}

export const registerApp = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    path: v.string(),
    command: v.string(),
    apiScopes: v.array(v.string()),
    installCommand: v.optional(v.string()),
    port: v.optional(v.number()),
    slug: v.optional(v.string()),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const { userId } = await appMutationActor(ctx, {
      workspaceId: args.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    return await registerAppImpl(ctx, {
      workspaceId: args.workspaceId,
      path: args.path,
      command: args.command,
      apiScopes: AppApiScopesSchema.parse(args.apiScopes),
      installCommand: args.installCommand,
      port: args.port,
      slug: args.slug,
      name: args.name,
      icon: args.icon,
      actorId: userId,
      now,
    })
  },
})

export async function registerAppImpl(ctx: MutationCtx, args: RegisterAppImplArgs) {
  const path = normalizeAnchorPath(args.path, 'app')
  const command = AppCommandSchema.parse(args.command)
  const installCommand =
    args.installCommand === undefined
      ? undefined
      : AppInstallCommandSchema.parse(args.installCommand)
  const requestedSlug = appSlug(args.slug ?? slugFromPath(path))
  const name = args.name === undefined ? undefined : AppNameSchema.parse(args.name)
  const icon = args.icon === undefined ? undefined : AppIconSchema.parse(args.icon)
  const apiScopes = AppApiScopesSchema.parse(args.apiScopes)
  const anchor = await getOrCreateAnchorForPath(ctx, {
    workspaceId: args.workspaceId,
    path,
    kind: 'app',
    settings: {},
    actorId: args.actorId,
    now: args.now,
    kindConflictError: 'Anchor path is not an app, share-root, or publish anchor',
    compatibleExistingKinds: ['share-root', 'publish'],
  })
  const existing = await appByAnchor(ctx, args.workspaceId, anchor.id as Id<'anchors'>)
  if (existing?.sourceShareId !== undefined) throw new Error('Replica apps are read-only')
  // Slug is creation-time identity, handled the same way for EVERY caller: an
  // existing app keeps the slug it was born with (re-registration is not a
  // rename), and a new one takes the requested slug suffixed past whatever the
  // workspace already holds — the same collision rule shared replicas use, so
  // a register copes with a taken slug instead of refusing it.
  let slug: string
  if (existing === null) {
    const workspaceApps = await ctx.db
      .query('apps')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .take(MAX_APPS_PER_WORKSPACE + 1)
    if (workspaceApps.length >= MAX_APPS_PER_WORKSPACE) {
      throw new Error('Workspace app limit exceeded')
    }
    slug = availableSharedReplicaSlug(new Set(workspaceApps.map(app => app.slug)), requestedSlug)
  } else {
    slug = existing.slug
  }
  if (args.port !== undefined) assertExplicitAppPort(args.port)
  const port = args.port ?? existing?.port ?? (await allocateAppPort(ctx, args.workspaceId))
  await assertPortAvailable(ctx, args.workspaceId, port, existing?._id)
  const subscription = args.listingSubscription
  const contentGeneration =
    subscription?.appliedEtag === undefined
      ? undefined
      : AppContentGenerationSchema.parse(subscription.appliedEtag)
  let appId: Id<'apps'>
  if (existing === null) {
    appId = await ctx.db.insert('apps', {
      workspaceId: args.workspaceId,
      anchorId: anchor.id as Id<'anchors'>,
      command,
      apiScopes,
      installCommand,
      port,
      slug,
      name,
      icon,
      visibility: 'folder',
      runtimeStatus: 'reconciling',
      createdByUserId: args.actorId,
      createdAt: args.now,
      updatedAt: args.now,
      ...(subscription === undefined
        ? {}
        : {
            listingSubscriptionId: subscription.id,
            contentGeneration,
            // No content generation yet means the subscription's files have
            // not landed, so the app cannot run until the first pull applies.
            disabledAt: contentGeneration === undefined ? args.now : undefined,
            disabledByUserId: contentGeneration === undefined ? args.actorId : undefined,
          }),
    })
  } else {
    // Re-registration rewrites the publisher-owned runtime, so the managed-app
    // policy applies to it exactly as to update and delete: only the app's own
    // subscription sync — the caller carrying that subscription — may pass.
    if (existing.listingSubscriptionId !== subscription?.id) {
      assertNotMarketplaceManaged(existing)
    }
    appId = existing._id
    await revokeExportedAppKeysForScopeChange(ctx, { app: existing, apiScopes, now: args.now })
    await ctx.db.patch(existing._id, {
      command,
      apiScopes,
      installCommand,
      port,
      name,
      icon,
      runtimeStatus: 'reconciling',
      reconciliationError: undefined,
      updatedAt: args.now,
      ...(subscription === undefined
        ? {}
        : {
            listingSubscriptionId: subscription.id,
            contentGeneration,
            // Content landing re-enables an app the sync disabled; without it
            // the row keeps whatever disabled state it already carried.
            disabledAt: contentGeneration === undefined ? existing.disabledAt : undefined,
            disabledByUserId:
              contentGeneration === undefined ? existing.disabledByUserId : undefined,
          }),
    })
  }
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'app.deployed',
    actorId: args.actorId,
    at: args.now,
    provenance: {
      appId,
      anchorId: anchor.id,
      path,
      slug,
      action: existing === null ? 'register' : 'redeploy',
    },
  })
  const app = await requireApp(ctx, appId)
  const fanout = await reconcileReplicasForOriginApp(ctx, { originApp: app, now: args.now })
  return { ...(await toApp(ctx, app, anchor)), ...fanout }
}

export const updateApp = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    command: v.optional(v.string()),
    apiScopes: v.optional(v.array(v.string())),
    installCommand: v.optional(v.string()),
    port: v.optional(v.number()),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const app = await requireAppBySlug(ctx, args.workspaceId, appSlug(args.slug))
    const { userId } = await appMutationActor(ctx, {
      workspaceId: app.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    if (
      args.command === undefined &&
      args.apiScopes === undefined &&
      args.installCommand === undefined &&
      args.port === undefined &&
      args.name === undefined &&
      args.icon === undefined
    )
      throw new Error('No app update fields provided')
    assertNotMarketplaceManaged(app)
    if (app.disabledAt !== undefined) throw new Error('Disabled replica apps are read-only')
    if (args.port !== undefined) {
      assertExplicitAppPort(args.port)
      await assertPortAvailable(ctx, app.workspaceId, args.port, app._id)
    }
    const updatesRuntime =
      args.command !== undefined ||
      args.apiScopes !== undefined ||
      args.installCommand !== undefined ||
      args.port !== undefined
    const apiScopes =
      args.apiScopes === undefined ? undefined : AppApiScopesSchema.parse(args.apiScopes)
    const command = args.command === undefined ? undefined : AppCommandSchema.parse(args.command)
    const installCommand =
      args.installCommand === undefined
        ? undefined
        : AppInstallCommandSchema.parse(args.installCommand)
    const name = args.name === undefined ? undefined : AppNameSchema.parse(args.name)
    const icon = args.icon === undefined ? undefined : AppIconSchema.parse(args.icon)
    const updatesMetadata = name !== undefined || icon !== undefined
    const requestedNow = args.now ?? Date.now()
    const now = updatesRuntime ? requestedNow : Math.max(requestedNow, app.updatedAt + 1)
    const originApp =
      app.sourceShareId === undefined ? undefined : await requireWriteModeReplicaOriginApp(ctx, app)
    if (apiScopes !== undefined)
      await revokeExportedAppKeysForScopeChange(ctx, { app, apiScopes, now })
    await ctx.db.patch(app._id, {
      ...(command === undefined ? {} : { command }),
      ...(apiScopes === undefined ? {} : { apiScopes }),
      ...(installCommand === undefined ? {} : { installCommand }),
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(name === undefined ? {} : { name }),
      ...(icon === undefined ? {} : { icon }),
      ...(updatesRuntime
        ? { runtimeStatus: 'reconciling' as const, reconciliationError: undefined }
        : {}),
      updatedAt: now,
    })
    const updatesOriginRuntime =
      args.command !== undefined || apiScopes !== undefined || args.installCommand !== undefined
    const updatesOriginMetadata = updatesMetadata
    if (originApp !== undefined && (updatesOriginRuntime || updatesOriginMetadata)) {
      if (apiScopes !== undefined)
        await revokeExportedAppKeysForScopeChange(ctx, { app: originApp, apiScopes, now })
      await ctx.db.patch(originApp._id, {
        ...(command === undefined ? {} : { command }),
        ...(apiScopes === undefined ? {} : { apiScopes }),
        ...(installCommand === undefined ? {} : { installCommand }),
        ...(name === undefined ? {} : { name }),
        ...(icon === undefined ? {} : { icon }),
        ...(updatesOriginRuntime
          ? { runtimeStatus: 'reconciling' as const, reconciliationError: undefined }
          : {}),
        updatedAt: now,
      })
    }
    const anchor = await requireAnchor(ctx, app.anchorId)
    if (updatesRuntime) {
      await writeAuditEvent(ctx, {
        workspaceId: app.workspaceId,
        event: 'app.deployed',
        actorId: userId,
        at: now,
        provenance: {
          appId: app._id,
          anchorId: app.anchorId,
          path: anchor.path,
          slug: app.slug,
          action: 'redeploy',
        },
      })
    }
    const updated = await requireApp(ctx, app._id)
    if (originApp === undefined) {
      const fanout = await reconcileReplicasForOriginApp(ctx, {
        originApp: updated,
        now,
        metadataWasExplicitlyUpdated: updatesMetadata,
      })
      return { ...(await toApp(ctx, updated, anchor)), ...fanout }
    }
    if (!updatesOriginRuntime && !updatesOriginMetadata) {
      return { ...(await toApp(ctx, updated, anchor)), affectedRecipientWorkspaceIds: [] }
    }
    const fanout = await reconcileReplicasForOriginApp(ctx, {
      originAppId: originApp._id,
      now,
      metadataWasExplicitlyUpdated: updatesOriginMetadata,
    })
    return {
      ...(await toApp(ctx, await requireApp(ctx, app._id), anchor)),
      affectedRecipientWorkspaceIds: [
        ...new Set([originApp.workspaceId, ...fanout.affectedRecipientWorkspaceIds]),
      ],
    }
  },
})

export const setVisibility = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    visibility: visibilityValidator,
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const visibility = AppVisibilitySchema.parse(args.visibility)
    const app = await requireAppBySlug(ctx, args.workspaceId, appSlug(args.slug))
    const { userId } = await appMutationActor(ctx, {
      workspaceId: app.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: visibility === 'public' ? 'owner' : 'editor',
    })
    // A replica runs on the recipient's own VM at the recipient's own URL, so
    // write access to the shared files carries the right to publish that copy.
    // Only the recipient's row moves; the origin app's visibility is the
    // owner's alone.
    if (app.sourceShareId !== undefined) {
      if (app.disabledAt !== undefined) throw new Error('Disabled replica apps are read-only')
      await requireWriteModeReplicaOriginApp(ctx, app)
    }
    const now = args.now ?? Date.now()
    await ctx.db.patch(app._id, { visibility, updatedAt: now })
    const anchor = await requireAnchor(ctx, app.anchorId)
    await writeAuditEvent(ctx, {
      workspaceId: app.workspaceId,
      event: 'app.visibility_changed',
      actorId: userId,
      at: now,
      provenance: {
        appId: app._id,
        anchorId: app.anchorId,
        path: anchor.path,
        slug: app.slug,
        visibility,
      },
    })
    return await toApp(ctx, await requireApp(ctx, app._id), anchor)
  },
})

export const deleteApp = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const app = await requireAppBySlug(ctx, args.workspaceId, appSlug(args.slug))
    const { userId } = await appMutationActor(ctx, {
      workspaceId: app.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    if (app.sourceShareId !== undefined) throw new Error('Replica apps are read-only')
    assertNotMarketplaceManaged(app)
    const fanout = await deleteAppRow(ctx, {
      app,
      anchor: await requireAnchor(ctx, app.anchorId),
      actorId: userId,
      now: args.now ?? Date.now(),
    })
    return { ok: true as const, ...fanout }
  },
})

export const setReplicaDisabled = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    disabled: v.boolean(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const app = await requireAppBySlug(ctx, args.workspaceId, appSlug(args.slug))
    const { userId } = await appMutationActor(ctx, {
      workspaceId: app.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    if (app.sourceShareId === undefined) throw new Error('Only replica apps can be disabled')
    const now = args.now ?? Date.now()
    if (args.disabled) await revokeAppKeysForApp(ctx, { app, now })
    await ctx.db.patch(app._id, {
      disabledAt: args.disabled ? now : undefined,
      disabledByUserId: args.disabled ? userId : undefined,
      updatedAt: now,
      ...(args.disabled ? {} : { runtimeStatus: 'reconciling', reconciliationError: undefined }),
    })
    return await toAppWithAnchor(ctx, await requireApp(ctx, app._id))
  },
})

export const setReconciliationStatus = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    status: v.union(
      v.literal('reconciling'),
      v.literal('reconciled'),
      v.literal('reconcile_failed'),
    ),
    error: v.optional(v.string()),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const app = await requireAppBySlug(ctx, args.workspaceId, appSlug(args.slug))
    const error =
      args.status === 'reconcile_failed' && args.error !== undefined
        ? AppReconciliationErrorSchema.parse(args.error)
        : undefined
    await ctx.db.patch(app._id, {
      runtimeStatus: args.status,
      reconciliationError: error,
      updatedAt: args.now ?? Date.now(),
    })
    return await toAppWithAnchor(ctx, await requireApp(ctx, app._id))
  },
})

export const restoreRuntimeAfterFailedReconciliation = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    command: v.string(),
    apiScopes: v.array(v.string()),
    installCommand: v.optional(v.string()),
    port: v.number(),
    error: v.string(),
    internalKey: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const app = await requireAppBySlug(ctx, args.workspaceId, appSlug(args.slug))
    const command = AppCommandSchema.parse(args.command)
    const installCommand =
      args.installCommand === undefined
        ? undefined
        : AppInstallCommandSchema.parse(args.installCommand)
    const error = AppReconciliationErrorSchema.parse(args.error)
    const canRestoreRuntime = await isPortAvailable(ctx, app.workspaceId, args.port, app._id)
    const apiScopes = AppApiScopesSchema.parse(args.apiScopes)
    const originApp =
      app.sourceShareId === undefined ? undefined : await requireWriteModeReplicaOriginApp(ctx, app)
    const restoreSharedConfig =
      canRestoreRuntime &&
      originApp !== undefined &&
      (app.command !== command ||
        app.installCommand !== installCommand ||
        !arraysEqual(app.apiScopes, apiScopes))
    const now = args.now ?? Date.now()
    if (canRestoreRuntime) await revokeExportedAppKeysForScopeChange(ctx, { app, apiScopes, now })
    await ctx.db.patch(app._id, {
      ...(canRestoreRuntime
        ? {
            command,
            apiScopes,
            installCommand,
            port: args.port,
          }
        : {}),
      runtimeStatus: 'reconcile_failed',
      reconciliationError: error,
      updatedAt: now,
    })
    if (restoreSharedConfig) {
      await revokeExportedAppKeysForScopeChange(ctx, { app: originApp, apiScopes, now })
      await ctx.db.patch(originApp._id, {
        command,
        apiScopes,
        installCommand,
        runtimeStatus: 'reconciling',
        reconciliationError: undefined,
        updatedAt: now,
      })
    }
    const updated = await requireApp(ctx, app._id)
    if (originApp === undefined) {
      const fanout = await reconcileReplicasForOriginApp(ctx, { originApp: updated, now })
      return { ...(await toAppWithAnchor(ctx, updated)), ...fanout }
    }
    if (!restoreSharedConfig) {
      return { ...(await toAppWithAnchor(ctx, updated)), affectedRecipientWorkspaceIds: [] }
    }
    const fanout = await reconcileReplicasForOriginApp(ctx, { originAppId: originApp._id, now })
    return {
      ...(await toAppWithAnchor(ctx, updated)),
      affectedRecipientWorkspaceIds: [
        ...new Set([originApp.workspaceId, ...fanout.affectedRecipientWorkspaceIds]),
      ],
    }
  },
})

export const listByWorkspace = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
    id: v.optional(v.string()),
    cwd: v.optional(v.string()),
    path: v.optional(v.string()),
    scope: v.optional(v.union(v.literal('subtree'), v.literal('children'), v.literal('self'))),
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    if (args.scope !== undefined && args.path === undefined) throw new Error('scope requires path')
    if ([args.id, args.cwd, args.path].filter(value => value !== undefined).length > 1) {
      throw new Error('id, cwd, and path filters are mutually exclusive')
    }
    if (args.id !== undefined) {
      const appId = ctx.db.normalizeId('apps', args.id)
      if (appId === null) return []
      const app = await ctx.db.get(appId)
      return app === null || app.workspaceId !== args.workspaceId
        ? []
        : [await toAppWithAnchor(ctx, app)]
    }
    if (args.cwd !== undefined) {
      const cwd = canonicalAgentCwd(args.cwd)
      if (cwd === undefined) throw new Error('Invalid app lookup cwd')
      const parts = cwd.split('/')
      // Exact ancestor reads make lookup cost follow path depth instead of the
      // number of apps in the workspace.
      for (let depth = parts.length; depth > 0; depth -= 1) {
        const path = parts.slice(0, depth).join('/')
        const anchor = await ctx.db
          .query('anchors')
          .withIndex('by_workspace_and_path', q =>
            q.eq('workspaceId', args.workspaceId).eq('path', path),
          )
          .unique()
        if (anchor === null) continue
        const containingApp = await appByAnchor(ctx, args.workspaceId, anchor._id)
        if (containingApp !== null) return [await toApp(ctx, containingApp, anchor)]
      }
      return []
    }
    const normalizedPath =
      args.path === undefined ? undefined : normalizeDrivePath(args.path, { allowRoot: true })
    if (normalizedPath !== undefined && !normalizedPath.ok)
      throw new Error(`Invalid app list path: ${normalizedPath.reason}`)
    const path = normalizedPath?.relativePath
    const apps = await ctx.db
      .query('apps')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      // The shared workspace cap is a safety ceiling above the expected deployed app count.
      .take(MAX_APPS_PER_WORKSPACE + 1)
    if (apps.length > MAX_APPS_PER_WORKSPACE) throw new Error('Workspace app limit exceeded')
    const projected = await Promise.all(
      apps.sort((a, b) => a.slug.localeCompare(b.slug)).map(app => toAppWithAnchor(ctx, app)),
    )
    return path === undefined ? projected : appsUnderPath(projected, path, args.scope ?? 'subtree')
  },
})

export const getBySlug = query({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    const app = await appBySlug(ctx, args.workspaceId, appSlug(args.slug))
    return app === null ? null : await toAppWithAnchor(ctx, app)
  },
})

export const runConfigForWorkspace = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await runConfigForWorkspaceImpl(ctx, args.workspaceId)
  },
})

export async function runConfigForWorkspaceImpl(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<GatewayAppConfig[]> {
  const apps = await ctx.db
    .query('apps')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    // VM run config consumes every registered app, bounded per workspace by user-created apps.
    .take(MAX_APPS_PER_WORKSPACE + 1)
  if (apps.length > MAX_APPS_PER_WORKSPACE) throw new Error('Workspace app limit exceeded')
  const configs: GatewayAppConfig[] = []
  for (const app of apps) {
    if (app.disabledAt !== undefined) continue
    const anchor = await ctx.db.get(app.anchorId)
    if (anchor === null || anchor.state !== 'active') continue
    if (app.port === undefined) throw new Error(`App "${app.slug}" has no runtime port`)
    const customDomain = await domainSummaryForApp(ctx, app._id)
    configs.push({
      appId: app._id,
      ...(customDomain === undefined ? {} : { customDomain }),
      slug: app.slug,
      command: app.command,
      installCommand: app.installCommand,
      name: app.name,
      port: app.port,
      anchorPath: anchor.path,
      apiScopes: AppApiScopesSchema.parse(app.apiScopes),
      visibility: app.visibility,
      ...(app.contentGeneration === undefined ? {} : { contentGeneration: app.contentGeneration }),
    })
  }
  return configs.sort((a, b) => a.slug.localeCompare(b.slug))
}

export async function applyVmReconciliationReports(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    reports: AppReconciliationReport[]
    now: number
  },
): Promise<void> {
  if (args.reports.length > MAX_APPS_PER_WORKSPACE) {
    throw new Error('Too many app reconciliation reports')
  }
  if (args.reports.length === 0) return
  const currentConfigs = new Map(
    (await runConfigForWorkspaceImpl(ctx, args.workspaceId)).map(config => [config.slug, config]),
  )
  const boundedReports = args.reports.map(report => AppReconciliationReportSchema.parse(report))
  const latestBySlug = new Map(boundedReports.map(report => [report.slug, report]))
  for (const report of latestBySlug.values()) {
    const currentConfig = currentConfigs.get(report.slug)
    if (currentConfig === undefined || !sameGatewayAppConfig(currentConfig, report)) continue
    const app = await appBySlug(ctx, args.workspaceId, report.slug)
    if (app === null) continue
    const reconciliationError = report.status === 'reconcile_failed' ? report.error : undefined
    if (app.runtimeStatus === report.status && app.reconciliationError === reconciliationError) {
      continue
    }
    await ctx.db.patch(app._id, {
      runtimeStatus: report.status,
      reconciliationError,
      updatedAt: args.now,
    })
  }
}

export const resolveForEdge = query({
  args: {
    internalKey: v.string(),
    workspaceSlug: v.string(),
    appSlug: v.string(),
    viewerUserId: v.optional(v.id('users')),
    viewerAppId: v.optional(v.string()),
    viewerCredential: v.optional(v.union(v.literal('cookie'), v.literal('grant'))),
    customBinding: v.optional(v.object({ hostname: v.string(), appId: v.string() })),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const activeWorkspace = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', args.workspaceSlug).eq('status', 'active'))
      .first()
    const workspace =
      activeWorkspace ??
      (await ctx.db
        .query('workspaces')
        .withIndex('by_slug_status', q => q.eq('slug', args.workspaceSlug).eq('status', 'archived'))
        .first())
    if (workspace === null) return null
    if (workspace.suspendedAt !== undefined) return { suspended: true as const }
    const app = await appBySlug(ctx, workspace._id, appSlug(args.appSlug))
    if (app === null) return null
    const customBinding = args.customBinding
    if (customBinding !== undefined) {
      const binding = await ctx.db
        .query('customDomains')
        .withIndex('by_hostname', q => q.eq('hostname', customBinding.hostname))
        .unique()
      if (
        binding?.status !== 'active' ||
        binding.appId !== app._id ||
        binding.workspaceId !== workspace._id ||
        customBinding.appId !== app._id
      )
        return null
    }
    const staleViewer = args.viewerAppId !== undefined && args.viewerAppId !== app._id
    if (staleViewer && args.viewerCredential !== 'cookie')
      return { denied: true as const, visibility: app.visibility }
    // A cookie for a former app loses identity; it cannot block public access
    // or prevent a private replacement from using the ordinary guest return.
    const viewerUserId = staleViewer ? undefined : args.viewerUserId
    const anchor = await ctx.db.get(app.anchorId)
    if (anchor === null || anchor.state !== 'active') return null
    const allowed =
      app.visibility === 'public' ||
      (viewerUserId !== undefined &&
        (await canReadAnchorFolder(ctx, workspace._id, viewerUserId, anchor.path)))
    if (!allowed)
      return {
        denied: true as const,
        visibility: app.visibility,
        guestPrivate: viewerUserId === undefined,
      }
    if (workspace.servicingStatus === 'paused') {
      return { paused: true as const, appName: app.name ?? app.slug }
    }
    if (
      workspace.vmName === undefined ||
      workspace.httpsUrl === undefined ||
      workspace.vmTokenNonce === undefined
    ) {
      return null
    }
    return {
      denied: false as const,
      visibility: app.visibility,
      workspace: {
        id: workspace._id,
        slug: workspace.slug,
        httpsUrl: workspace.httpsUrl,
        vmName: workspace.vmName,
      },
      origin: {
        httpsUrl: workspace.httpsUrl,
        gatewayAuthToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce),
        gatewayPathPrefix: '/public/app',
      },
      app: {
        id: app._id,
        slug: app.slug,
        anchorId: app.anchorId,
        anchorPath: anchor.path,
      },
    }
  },
})

type MinimumRole = 'owner' | 'editor'

async function appMutationActor(
  ctx: QueryCtx | MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    internalKey?: string
    actorId?: Id<'users'>
    minimumRole: MinimumRole
  },
): Promise<{ userId: Id<'users'> }> {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined) throw new Error('actorId is required for internal app mutation')
    return await assertActorRole(ctx, args.workspaceId, args.actorId, args.minimumRole)
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  return await assertRole(ctx, args.workspaceId, args.minimumRole)
}

/**
 * How a declared app relates to what the workspace already holds at its path —
 * the compare-before-write half of idempotent agent registration. A repeat
 * register with the same declarations patches nothing: no reconcile churn, no
 * port movement, no updatedAt drift. The existing row rides along so the
 * register can report the app's actual slug even when it writes nothing.
 *
 * Slug is deliberately NOT compared: it is creation-time identity (it may be
 * collision-suffixed away from the declared value), and `registerAppImpl`
 * never renames an existing app, so a slug difference is not something a
 * re-register could act on.
 *
 * Expects a declaration whose path is already normalized.
 */
export async function appRegistrationDiff(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  declaration: WireAppDeclaration,
): Promise<{ differs: boolean; existing: Doc<'apps'> | null }> {
  const anchor = await ctx.db
    .query('anchors')
    .withIndex('by_workspace_and_path', q =>
      q.eq('workspaceId', workspaceId).eq('path', declaration.path),
    )
    .unique()
  const app = anchor === null ? null : await appByAnchor(ctx, workspaceId, anchor._id)
  const differs =
    app === null ||
    app.command !== declaration.command ||
    !sameApiScopes(app.apiScopes, declaration.apiScopes) ||
    app.installCommand !== declaration.installCommand ||
    app.name !== declaration.name ||
    app.icon !== declaration.icon ||
    // Compared ONLY when the declaration names a port. An absent port means
    // "assign one", not "have none": a declaration that omits it gets an
    // auto-assigned value, so comparing unconditionally would report a
    // difference forever and re-register the app on every repeat.
    (declaration.port !== undefined && app.port !== declaration.port)
  return { differs, existing: app }
}

/**
 * A marketplace-managed app is the publisher's declaration materialised, so its
 * runtime rows refuse direct edits and deletes: an edit would be clobbered by
 * the next publisher sync, and a delete used to orphan the anchor out from
 * under it — the whole workspace's sync poll then 500ed on the revive.
 * The row leaves through its subscription (uninstall, or deleting the agent,
 * which detaches) — the same shape as `deleteAgent`'s handling and the replica
 * rule above. Visibility stays the installer's and is deliberately not guarded.
 */
function assertNotMarketplaceManaged(app: Doc<'apps'>): void {
  if (app.listingSubscriptionId !== undefined) {
    throw new Error('Marketplace-managed apps are read-only; uninstall their subscription instead')
  }
}

async function requireApp(ctx: QueryCtx | MutationCtx, appId: Id<'apps'>): Promise<Doc<'apps'>> {
  const app = await ctx.db.get(appId)
  if (app === null) throw new Error('App not found')
  return app
}

async function requireAppBySlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
): Promise<Doc<'apps'>> {
  const app = await appBySlug(ctx, workspaceId, slug)
  if (app === null) throw new Error('App not found')
  return app
}

async function appBySlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
): Promise<Doc<'apps'> | null> {
  return await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_slug', q => q.eq('workspaceId', workspaceId).eq('slug', slug))
    .unique()
}

async function appByAnchor(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  anchorId: Id<'anchors'>,
): Promise<Doc<'apps'> | null> {
  return await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_anchor', q =>
      q.eq('workspaceId', workspaceId).eq('anchorId', anchorId),
    )
    .unique()
}

async function allocateAppPort(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<number> {
  const apps = await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_port', q =>
      q
        .eq('workspaceId', workspaceId)
        .gte('port', APP_AUTO_PORT_RANGE_START)
        .lte('port', APP_AUTO_PORT_RANGE_END),
    )
    .take(APP_AUTO_PORT_RANGE_END - APP_AUTO_PORT_RANGE_START + 1)
  const usedPorts = new Set(apps.map(app => app.port))
  return firstAvailableAutoAssignedPort(usedPorts)
}

async function assertPortAvailable(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  port: number,
  appId?: Id<'apps'>,
): Promise<void> {
  if (!(await isPortAvailable(ctx, workspaceId, port, appId))) {
    throw new Error('App port already exists')
  }
}

async function isPortAvailable(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  port: number,
  appId?: Id<'apps'>,
): Promise<boolean> {
  const matches = await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_port', q => q.eq('workspaceId', workspaceId).eq('port', port))
    .take(appId === undefined ? 1 : 2)
  return matches.every(app => app._id === appId)
}

function assertExplicitAppPort(port: number): void {
  if (port >= APP_AUTO_PORT_RANGE_START && port <= APP_AUTO_PORT_RANGE_END) {
    throw new Error('Explicit app port must be outside the reserved range')
  }
}

async function toAppWithAnchor(ctx: QueryCtx | MutationCtx, app: Doc<'apps'>) {
  const anchor = await requireAnchor(ctx, app.anchorId)
  return await toApp(ctx, app, anchor)
}

async function toApp(
  ctx: QueryCtx | MutationCtx,
  app: Doc<'apps'>,
  anchor: Pick<Anchor, 'path' | 'state'>,
) {
  const sourceShareMode = await replicaSourceShareMode(ctx, app)
  const customDomain = await domainSummaryForApp(ctx, app._id)
  return {
    ...(customDomain === undefined ? {} : { customDomain }),
    id: app._id,
    workspaceId: app.workspaceId,
    anchorId: app.anchorId,
    anchorPath: anchor.path,
    anchorState: anchor.state,
    command: app.command,
    apiScopes: AppApiScopesSchema.parse(app.apiScopes),
    ...(app.installCommand === undefined ? {} : { installCommand: app.installCommand }),
    port: app.port,
    slug: app.slug,
    ...(app.name === undefined ? {} : { name: app.name }),
    ...(app.icon === undefined ? {} : { icon: app.icon }),
    visibility: app.visibility as AppVisibility,
    runtimeStatus: app.runtimeStatus,
    ...(app.reconciliationError === undefined
      ? {}
      : { reconciliationError: app.reconciliationError }),
    ...(app.sourceShareId === undefined ? {} : { sourceShareId: app.sourceShareId }),
    ...(sourceShareMode === undefined ? {} : { sourceShareMode }),
    ...(app.sourceAppId === undefined ? {} : { sourceAppId: app.sourceAppId }),
    ...(app.listingSubscriptionId === undefined
      ? {}
      : { listingSubscriptionId: app.listingSubscriptionId }),
    ...(app.disabledAt === undefined ? {} : { disabledAt: app.disabledAt }),
    ...(app.disabledByUserId === undefined ? {} : { disabledByUserId: app.disabledByUserId }),
    createdByUserId: app.createdByUserId,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  }
}

function slugFromPath(path: string): string {
  const lastPart = path.split('/').filter(Boolean).at(-1) ?? ''
  return normalizeSlug(lastPart)
}

function appSlug(slug: string): string {
  return AppSlugSchema.parse(assertValidSlug(slug, 'app'))
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function canReadAnchorFolder(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  _anchorPath: string,
): Promise<boolean> {
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique()
  return membership !== null
}
