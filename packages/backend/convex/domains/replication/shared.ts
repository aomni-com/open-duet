import { AppSlugSchema, MAX_SLUG_LENGTH, isDrivePathWithin } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC } from '../shares/syncProjection'

export interface SharedReplicaAnchor {
  id: string
  path: string
  state: string
}

export interface SharedReplicaShare {
  id: string
  anchorId: string
  recipientWorkspaceId?: string
  mountPath?: string
}

export interface SharedReplicaGraph {
  loadAnchor(id: string): Promise<SharedReplicaAnchor | null>
  loadActiveSharesForOriginWorkspace(workspaceId: string): Promise<SharedReplicaShare[]>
}

export function convexSharedReplicaGraph(ctx: QueryCtx | MutationCtx): SharedReplicaGraph {
  return {
    loadAnchor: async id => {
      const anchor = await ctx.db.get(id as Id<'anchors'>)
      return anchor === null ? null : { id: anchor._id, path: anchor.path, state: anchor.state }
    },
    loadActiveSharesForOriginWorkspace: async workspaceId => {
      const shares = await ctx.db
        .query('shares')
        .withIndex('by_origin_workspace_state', q =>
          q.eq('originWorkspaceId', workspaceId as Id<'workspaces'>).eq('state', 'active'),
        )
        .take(MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC + 1)
      if (shares.length > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC) {
        throw new Error('Origin workspace active share limit exceeded')
      }
      return shares.map(share => ({
        id: share._id,
        anchorId: share.anchorId,
        recipientWorkspaceId: share.toWorkspaceId,
        mountPath: share.mountPath,
      }))
    },
  }
}

export interface SharedReplicaOrigin<Row> {
  row: Row
  id: string
  workspaceId: string
  anchorId: string
  actorId: string
  isReplica: boolean
}

export interface SharedReplicaProjection {
  shareId: string
  workspaceId: string
  disabled: boolean
}

export interface SharedReplicaCreateContext<Row> {
  origin: SharedReplicaOrigin<Row>
  originAnchor: SharedReplicaAnchor
  share: Required<Pick<SharedReplicaShare, 'id' | 'recipientWorkspaceId' | 'mountPath'>>
  shareRootPath: string
  replicaPath: string
  actorId: string
  now: number
}

export interface SharedReplicaUpdateContext {
  now: number
  metadataWasExplicitlyUpdated: boolean
}

export interface SharedReplicaAdapter<Row> {
  resourceName: string
  loadOrigin(id: string): Promise<Row | null>
  loadOriginsForWorkspace(workspaceId: string): Promise<Row[]>
  loadReplicas(originId: string): Promise<Row[]>
  loadReplicasForShare(shareId: string): Promise<Row[]>
  projectOrigin(row: Row): Omit<SharedReplicaOrigin<Row>, 'row'>
  projectReplica(row: Row): SharedReplicaProjection
  assertCanSeedReplicas(recipientWorkspaceId: string, replicaCount: number): Promise<void>
  createReplica(context: SharedReplicaCreateContext<Row>): Promise<void>
  updateReplica(replica: Row, origin: Row, context: SharedReplicaUpdateContext): Promise<boolean>
  deleteReplica(replica: Row, now: number): Promise<void>
  detachReplica(replica: Row, now: number): Promise<string | null>
}

export interface SharedReplicaShareContext {
  shareId: string
  originWorkspaceId: string
  recipientWorkspaceId: string
  shareRootPath: string
  mountPath: string
  actorId: string
  now: number
}

export function isSharedResourcePathWithinShareRoot(
  resourcePath: string,
  shareRootPath: string,
): boolean {
  return isDrivePathWithin(shareRootPath, resourcePath)
}

export function translateSharedResourcePathToMount(
  resourcePath: string,
  shareRootPath: string,
  mountPath: string,
): string {
  if (!isSharedResourcePathWithinShareRoot(resourcePath, shareRootPath)) {
    throw new Error('Resource path is outside the share root')
  }
  const relativePath =
    resourcePath === shareRootPath ? '' : resourcePath.slice(shareRootPath.length + 1)
  return relativePath.length === 0 ? mountPath : `${mountPath}/${relativePath}`
}

export function availableSharedReplicaSlug(
  usedSlugs: ReadonlySet<string>,
  sourceSlug: string,
): string {
  if (!usedSlugs.has(sourceSlug)) return sourceSlug
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`
    const base = sourceSlug.slice(0, MAX_SLUG_LENGTH - suffixText.length).replace(/-+$/g, '')
    const candidate = AppSlugSchema.parse(`${base}${suffixText}`)
    if (!usedSlugs.has(candidate)) return candidate
  }
}

export async function seedSharedReplicasForShare(
  graph: SharedReplicaGraph,
  adapters: readonly SharedReplicaAdapter<unknown>[],
  context: SharedReplicaShareContext,
): Promise<void> {
  for (const adapter of adapters) {
    const origins = await adapter.loadOriginsForWorkspace(context.originWorkspaceId)
    const candidates: Array<{
      origin: SharedReplicaOrigin<unknown>
      anchor: SharedReplicaAnchor
    }> = []
    for (const row of origins) {
      const origin = { row, ...adapter.projectOrigin(row) }
      const anchor = await graph.loadAnchor(origin.anchorId)
      if (
        anchor?.state !== 'active' ||
        !isSharedResourcePathWithinShareRoot(anchor.path, context.shareRootPath)
      ) {
        continue
      }
      candidates.push({ origin, anchor })
    }
    await adapter.assertCanSeedReplicas(context.recipientWorkspaceId, candidates.length)
    for (const { origin, anchor } of candidates) {
      await adapter.createReplica({
        origin,
        originAnchor: anchor,
        share: {
          id: context.shareId,
          recipientWorkspaceId: context.recipientWorkspaceId,
          mountPath: context.mountPath,
        },
        shareRootPath: context.shareRootPath,
        replicaPath: translateSharedResourcePathToMount(
          anchor.path,
          context.shareRootPath,
          context.mountPath,
        ),
        actorId: context.actorId,
        now: context.now,
      })
    }
  }
}

export async function reconcileSharedReplicasForOrigin<Row>(
  graph: SharedReplicaGraph,
  adapter: SharedReplicaAdapter<Row>,
  originRef: { row: Row } | { id: string },
  now: number,
  options: { metadataWasExplicitlyUpdated?: boolean } = {},
): Promise<{ affectedRecipientWorkspaceIds: string[] }> {
  const suppliedOrigin = 'row' in originRef ? originRef.row : undefined
  const originId = 'id' in originRef ? originRef.id : adapter.projectOrigin(originRef.row).id
  const storedOrigin = await adapter.loadOrigin(originId)
  const originRow = storedOrigin ?? suppliedOrigin
  if (originRow === undefined) throw new Error(`Origin ${adapter.resourceName} not found`)
  const origin = { row: originRow, ...adapter.projectOrigin(originRow) }
  if (origin.isReplica) {
    throw new Error(`Replica ${adapter.resourceName} is not an origin ${adapter.resourceName}`)
  }

  const desiredShares = new Map<
    string,
    { share: SharedReplicaShare; shareRoot: SharedReplicaAnchor }
  >()
  let originAnchor: SharedReplicaAnchor | null = null
  if (storedOrigin !== null) {
    originAnchor = await graph.loadAnchor(origin.anchorId)
    if (originAnchor?.state === 'active') {
      const shares = await graph.loadActiveSharesForOriginWorkspace(origin.workspaceId)
      for (const share of shares) {
        const shareRoot = await graph.loadAnchor(share.anchorId)
        if (
          share.recipientWorkspaceId !== undefined &&
          share.mountPath !== undefined &&
          shareRoot?.state === 'active' &&
          isSharedResourcePathWithinShareRoot(originAnchor.path, shareRoot.path)
        ) {
          desiredShares.set(share.id, { share, shareRoot })
        }
      }
    }
  }

  const affected = new Set<string>()
  const survivingShareIds = new Set<string>()
  for (const replica of await adapter.loadReplicas(originId)) {
    const projection = adapter.projectReplica(replica)
    const desired = desiredShares.get(projection.shareId)
    if (desired === undefined || survivingShareIds.has(desired.share.id)) {
      await adapter.deleteReplica(replica, now)
      affected.add(projection.workspaceId)
      continue
    }
    survivingShareIds.add(desired.share.id)
    if (projection.disabled || storedOrigin === null) continue
    if (
      await adapter.updateReplica(replica, storedOrigin, {
        now,
        metadataWasExplicitlyUpdated: options.metadataWasExplicitlyUpdated === true,
      })
    ) {
      affected.add(projection.workspaceId)
    }
  }

  if (storedOrigin !== null && originAnchor?.state === 'active') {
    for (const { share, shareRoot } of desiredShares.values()) {
      if (
        survivingShareIds.has(share.id) ||
        share.recipientWorkspaceId === undefined ||
        share.mountPath === undefined
      ) {
        continue
      }
      await adapter.createReplica({
        origin,
        originAnchor,
        share: {
          id: share.id,
          recipientWorkspaceId: share.recipientWorkspaceId,
          mountPath: share.mountPath,
        },
        shareRootPath: shareRoot.path,
        replicaPath: translateSharedResourcePathToMount(
          originAnchor.path,
          shareRoot.path,
          share.mountPath,
        ),
        actorId: origin.actorId,
        now,
      })
      affected.add(share.recipientWorkspaceId)
    }
  }

  return { affectedRecipientWorkspaceIds: [...affected] }
}

export async function deleteSharedReplicasForShare(
  adapters: readonly SharedReplicaAdapter<unknown>[],
  shareId: string,
  now: number,
): Promise<void> {
  for (const adapter of adapters) {
    for (const replica of await adapter.loadReplicasForShare(shareId)) {
      await adapter.deleteReplica(replica, now)
    }
  }
}

export async function detachSharedReplicasForShare(
  adapters: readonly SharedReplicaAdapter<unknown>[],
  shareId: string,
  now: number,
): Promise<{ preservedAnchorIds: string[] }> {
  const preservedAnchorIds: string[] = []
  for (const adapter of adapters) {
    for (const replica of await adapter.loadReplicasForShare(shareId)) {
      const preservedAnchorId = await adapter.detachReplica(replica, now)
      if (preservedAnchorId !== null) preservedAnchorIds.push(preservedAnchorId)
    }
  }
  return { preservedAnchorIds }
}
