import {
  AppApiScopesSchema,
  AppCommandSchema,
  AppIconSchema,
  AppInstallCommandSchema,
  AppNameSchema,
  MAX_APPS_PER_WORKSPACE,
  firstAvailableAutoAssignedPort,
  sameApiScopes,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { getOrCreateAnchorForPath } from '../anchors/model'
import { revokeAppKeysForApp, revokeExportedAppKeysForScopeChange } from '../apiKeys/model'
import { beginDomainRemovalForApp } from '../customDomains/model'
import {
  availableSharedReplicaSlug,
  convexSharedReplicaGraph,
  isSharedResourcePathWithinShareRoot,
  reconcileSharedReplicasForOrigin,
  translateSharedResourcePathToMount,
  type SharedReplicaAdapter,
} from '../replication/shared'
import { MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC } from '../shares/syncProjection'

export function isAppPathWithinShareRoot(appPath: string, shareRootPath: string): boolean {
  return isSharedResourcePathWithinShareRoot(appPath, shareRootPath)
}

export function translateAppPathToShareMount(
  appPath: string,
  shareRootPath: string,
  mountPath: string,
): string {
  if (!isAppPathWithinShareRoot(appPath, shareRootPath)) {
    throw new Error('App path is outside the share root')
  }
  return translateSharedResourcePathToMount(appPath, shareRootPath, mountPath)
}

export function activeAppsWithinShareRoot<T extends { anchor: { path: string; state: string } }>(
  apps: readonly T[],
  shareRootPath: string,
): T[] {
  return apps.filter(
    ({ anchor }) =>
      anchor.state === 'active' && isAppPathWithinShareRoot(anchor.path, shareRootPath),
  )
}

export async function loadWorkspaceAppsWithAnchors(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<Array<{ app: Doc<'apps'>; anchor: Doc<'anchors'> }>> {
  const apps = await ctx.db
    .query('apps')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  if (apps.length > MAX_APPS_PER_WORKSPACE) throw new Error('Workspace app limit exceeded')
  const candidates: Array<{ app: Doc<'apps'>; anchor: Doc<'anchors'> }> = []
  for (const app of apps) {
    const anchor = await ctx.db.get(app.anchorId)
    if (anchor !== null) candidates.push({ app, anchor })
  }
  return candidates
}

/**
 * Converges every materialized replica of one origin app to the active accepted-share graph.
 * Passing the pre-delete row lets deletion reconcile after the origin document is gone.
 */
export async function reconcileReplicasForOriginApp(
  ctx: MutationCtx,
  args: (
    | { originApp: Doc<'apps'>; originAppId?: never }
    | { originAppId: Id<'apps'>; originApp?: never }
  ) & { now: number; metadataWasExplicitlyUpdated?: boolean },
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[] }> {
  const originAppId = args.originApp?._id ?? args.originAppId
  if (originAppId === undefined) throw new Error('originApp or originAppId is required')
  const adapter = appSharedReplicaAdapter(ctx)
  const result = await reconcileSharedReplicasForOrigin(
    convexSharedReplicaGraph(ctx),
    adapter,
    args.originApp === undefined ? { id: originAppId } : { row: args.originApp },
    args.now,
    { metadataWasExplicitlyUpdated: args.metadataWasExplicitlyUpdated },
  )
  return {
    affectedRecipientWorkspaceIds: result.affectedRecipientWorkspaceIds as Id<'workspaces'>[],
  }
}

/**
 * The access a replica actually has, narrowed across its whole share chain: a
 * revoked or read-only link anywhere above it makes the replica read-only no
 * matter what the leaf share says. `undefined` means "not a replica".
 */
export async function replicaSourceShareMode(
  ctx: QueryCtx | MutationCtx,
  replica: Doc<'apps'>,
): Promise<'read' | 'write' | undefined> {
  if (replica.sourceShareId === undefined) return undefined
  let shareId: Id<'shares'> | undefined = replica.sourceShareId
  while (shareId !== undefined) {
    const share: Doc<'shares'> | null = await ctx.db.get(shareId)
    if (share === null || share.state !== 'active' || share.mode !== 'write') return 'read'
    shareId = share.parentShareId
  }
  return 'write'
}

export async function requireWriteModeReplicaOriginApp(
  ctx: MutationCtx,
  replica: Doc<'apps'>,
): Promise<Doc<'apps'>> {
  if (replica.sourceShareId === undefined || replica.sourceAppId === undefined) {
    throw new Error('Replica app source is missing')
  }
  if ((await replicaSourceShareMode(ctx, replica)) !== 'write') {
    throw new Error('Replica apps are read-only')
  }
  const originApp = await ctx.db.get(replica.sourceAppId)
  if (originApp === null || originApp.sourceShareId !== undefined) {
    throw new Error('Replica app source is missing')
  }
  return originApp
}

export function appSharedReplicaAdapter(ctx: MutationCtx): SharedReplicaAdapter<Doc<'apps'>> {
  return {
    resourceName: 'app',
    loadOrigin: async id => await ctx.db.get(id as Id<'apps'>),
    loadOriginsForWorkspace: async workspaceId =>
      (await loadWorkspaceAppsWithAnchors(ctx, workspaceId as Id<'workspaces'>)).map(
        ({ app }) => app,
      ),
    loadReplicas: async originId => {
      const replicas = await ctx.db
        .query('apps')
        .withIndex('by_source_app', q => q.eq('sourceAppId', originId as Id<'apps'>))
        .take(MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC + 1)
      if (replicas.length > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC) {
        throw new Error('Origin app replica limit exceeded')
      }
      return replicas
    },
    loadReplicasForShare: async shareId => {
      const replicas = await ctx.db
        .query('apps')
        .withIndex('by_source_share', q => q.eq('sourceShareId', shareId as Id<'shares'>))
        .take(MAX_APPS_PER_WORKSPACE + 1)
      if (replicas.length > MAX_APPS_PER_WORKSPACE) throw new Error('Share replica limit exceeded')
      return replicas
    },
    projectOrigin: app => ({
      id: app._id,
      workspaceId: app.workspaceId,
      anchorId: app.anchorId,
      actorId: app.createdByUserId,
      isReplica: app.sourceShareId !== undefined,
    }),
    projectReplica: app => ({
      shareId: app.sourceShareId ?? '',
      workspaceId: app.workspaceId,
      disabled: app.disabledAt !== undefined,
    }),
    assertCanSeedReplicas: async (recipientWorkspaceId, replicaCount) => {
      const recipientApps = await ctx.db
        .query('apps')
        .withIndex('by_workspace', q =>
          q.eq('workspaceId', recipientWorkspaceId as Id<'workspaces'>),
        )
        .take(MAX_APPS_PER_WORKSPACE + 1)
      if (
        recipientApps.length > MAX_APPS_PER_WORKSPACE ||
        recipientApps.length + replicaCount > MAX_APPS_PER_WORKSPACE
      ) {
        throw new Error('Workspace app limit exceeded')
      }
    },
    createReplica: async context => {
      await createReplica(ctx, {
        originApp: context.origin.row,
        originAnchor: context.originAnchor,
        shareId: context.share.id as Id<'shares'>,
        recipientWorkspaceId: context.share.recipientWorkspaceId as Id<'workspaces'>,
        shareRootPath: context.shareRootPath,
        mountPath: context.share.mountPath,
        actorId: context.actorId as Id<'users'>,
        now: context.now,
      })
    },
    updateReplica: async (replica, origin, context) => {
      const command = AppCommandSchema.parse(origin.command)
      const apiScopes = AppApiScopesSchema.parse(origin.apiScopes)
      const installCommand =
        origin.installCommand === undefined
          ? undefined
          : AppInstallCommandSchema.parse(origin.installCommand)
      const name = origin.name === undefined ? undefined : AppNameSchema.parse(origin.name)
      const icon = origin.icon === undefined ? undefined : AppIconSchema.parse(origin.icon)
      const runtimeChanged =
        replica.command !== command ||
        replica.installCommand !== installCommand ||
        !sameApiScopes(replica.apiScopes, apiScopes)
      const metadataChanged =
        context.metadataWasExplicitlyUpdated || replica.name !== name || replica.icon !== icon
      if (!runtimeChanged && !metadataChanged) return false
      await revokeExportedAppKeysForScopeChange(ctx, { app: replica, apiScopes, now: context.now })
      await ctx.db.patch(replica._id, {
        command,
        apiScopes,
        installCommand,
        name,
        icon,
        ...(runtimeChanged
          ? { runtimeStatus: 'reconciling' as const, reconciliationError: undefined }
          : {}),
        updatedAt: context.now,
      })
      return true
    },
    deleteReplica: async (replica, now) => await deleteReplica(ctx, replica, now),
    detachReplica: async (replica, now) => {
      const anchor = await ctx.db.get(replica.anchorId)
      let preservedAnchorId: Id<'anchors'> | null = null
      if (anchor?.kind === 'share-mount') {
        await ctx.db.patch(anchor._id, {
          kind: 'app',
          settings: {},
          updatedAt: now,
        })
        preservedAnchorId = anchor._id
      }
      await ctx.db.patch(replica._id, {
        sourceShareId: undefined,
        sourceAppId: undefined,
        disabledAt: undefined,
        disabledByUserId: undefined,
        updatedAt: now,
      })
      return preservedAnchorId
    },
  }
}

async function createReplica(
  ctx: MutationCtx,
  args: {
    originApp: Doc<'apps'>
    originAnchor: { path: string }
    shareId: Id<'shares'>
    recipientWorkspaceId: Id<'workspaces'>
    shareRootPath: string
    mountPath: string
    actorId: Id<'users'>
    now: number
  },
): Promise<void> {
  const recipientApps = await ctx.db
    .query('apps')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.recipientWorkspaceId))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  if (recipientApps.length >= MAX_APPS_PER_WORKSPACE)
    throw new Error('Workspace app limit exceeded')
  const slug = availableSharedReplicaSlug(
    new Set(recipientApps.map(app => app.slug)),
    args.originApp.slug,
  )
  const port = firstAvailableAutoAssignedPort(new Set(recipientApps.map(app => app.port)))
  const replicaPath = translateAppPathToShareMount(
    args.originAnchor.path,
    args.shareRootPath,
    args.mountPath,
  )
  /* Same rule as the agent replica above: adopt the mount root, revive an
     orphaned tombstone, refuse live claims with a typed error. */
  const anchor = await getOrCreateAnchorForPath(ctx, {
    workspaceId: args.recipientWorkspaceId,
    path: replicaPath,
    kind: 'app',
    compatibleExistingKinds: ['share-mount'],
    kindConflictError: 'Replica path is already claimed by something else',
    settings: {},
    actorId: args.actorId,
    now: args.now,
  })
  await ctx.db.insert('apps', {
    workspaceId: args.recipientWorkspaceId,
    anchorId: anchor.id as Id<'anchors'>,
    command: AppCommandSchema.parse(args.originApp.command),
    apiScopes: AppApiScopesSchema.parse(args.originApp.apiScopes),
    installCommand:
      args.originApp.installCommand === undefined
        ? undefined
        : AppInstallCommandSchema.parse(args.originApp.installCommand),
    name: args.originApp.name === undefined ? undefined : AppNameSchema.parse(args.originApp.name),
    icon: args.originApp.icon === undefined ? undefined : AppIconSchema.parse(args.originApp.icon),
    port,
    slug,
    visibility: 'folder',
    runtimeStatus: 'reconciling',
    sourceShareId: args.shareId,
    sourceAppId: args.originApp._id,
    createdByUserId: args.actorId,
    createdAt: args.now,
    updatedAt: args.now,
  })
}

async function deleteReplica(ctx: MutationCtx, replica: Doc<'apps'>, now: number): Promise<void> {
  await revokeAppKeysForApp(ctx, { app: replica, now })
  await beginDomainRemovalForApp(ctx, replica._id, now, { orphan: true })
  await ctx.db.delete(replica._id)
  const anchor = await ctx.db.get(replica.anchorId)
  if (anchor?.kind !== 'share-mount') await ctx.db.delete(replica.anchorId)
}
