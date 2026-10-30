import {
  MAX_ACTIVE_SHARES_PER_WORKSPACE as CONTRACT_MAX_ACTIVE_SHARES_PER_WORKSPACE,
  tunnelTokenDigest,
  type TunnelTokenClaims,
  type VmDesiredShareSync,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { isLiveWorkspace, randomHex } from '../workspaces/vmToken'

const SYNCTHING_PORT = 22_000
export const MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC = CONTRACT_MAX_ACTIVE_SHARES_PER_WORKSPACE
export const MAX_SHARE_ROWS_PER_WORKSPACE_SYNC = MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC * 2
const MAX_SHARE_SYNC_REALIZATIONS_PER_SHARE = 2
export const SHARE_SYNC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
export const SHARE_SYNC_RENEWAL_WINDOW_MS = 60 * 60 * 1000

type PersistedShareProjectionFields = Pick<
  Doc<'shares'>,
  | 'state'
  | 'fromWorkspaceId'
  | 'toWorkspaceId'
  | 'anchorId'
  | 'mountAnchorId'
  | 'parentShareId'
  | 'mode'
  | 'ignorePatterns'
  | 'pausedAt'
  | 'sync'
>

export type ShareSyncProjectionShare = Omit<
  PersistedShareProjectionFields,
  'fromWorkspaceId' | 'toWorkspaceId' | 'anchorId' | 'mountAnchorId' | 'parentShareId'
> & {
  id: string
  fromWorkspaceId: string
  toWorkspaceId?: string
  anchorId: string
  mountAnchorId?: string
  parentShareId?: string
}

export type ShareSyncProjectionAnchor = Omit<
  Pick<Doc<'anchors'>, 'workspaceId' | 'path' | 'kind' | 'state'>,
  'workspaceId'
> & {
  id: string
  workspaceId: string
}

export type ShareSyncProjectionWorkspace = {
  id: string
  live: boolean
} & Pick<Doc<'workspaces'>, 'syncthingDeviceId' | 'httpsUrl'>

export type ShareTunnelBearerSigner = (input: {
  secret: string
  claims: TunnelTokenClaims
  nonce: string
  expiresAt: number
}) => Promise<string>

export type ShareSyncGenerationProjection = {
  shareId: string
  origin: { workspaceId: string; generation: string }
  recipient: { workspaceId: string; generation: string }
}

export async function projectDesiredShareSync(input: {
  workspaceId: string
  shares: readonly ShareSyncProjectionShare[]
  anchors: readonly ShareSyncProjectionAnchor[]
  workspaces: readonly ShareSyncProjectionWorkspace[]
  now: number
  signBearer: ShareTunnelBearerSigner
}): Promise<VmDesiredShareSync> {
  const projected = await Promise.all(
    (await resolveShareSyncMaterials(input)).map(async material => {
      const role =
        input.workspaceId === material.origin.workspaceId
          ? material.origin
          : input.workspaceId === material.recipient.workspaceId
            ? material.recipient
            : null
      if (role === null) return null
      const [incomingToken, outgoingToken] = await Promise.all([
        input.signBearer({
          secret: material.share.sync.tokenSecret,
          claims: role.incoming.claims,
          nonce: role.incoming.nonce,
          expiresAt: material.share.sync.tokenExpiresAt,
        }),
        input.signBearer({
          secret: material.share.sync.tokenSecret,
          claims: role.outgoing.claims,
          nonce: role.outgoing.nonce,
          expiresAt: material.share.sync.tokenExpiresAt,
        }),
      ])

      return {
        shareId: material.share.id,
        generation: role.generation,
        folder: {
          id: `share-${material.share.id}`,
          path: role.localPath,
          mode: material.share.mode,
          role: role.role,
          peerDeviceId: role.peer.syncthingDeviceId,
          ignorePatterns: [...material.share.ignorePatterns],
          paused: material.share.pausedAt !== undefined,
        },
        ...(role.role === 'recipient' ? { mount: { path: material.targetAnchor.path } } : {}),
        accept: {
          acceptId: role.incoming.acceptId,
          targetPort: SYNCTHING_PORT,
          tokenDigest: await tunnelTokenDigest(incomingToken),
          expiresAt: material.share.sync.tokenExpiresAt,
        },
        bridge: {
          peerDeviceId: role.peer.syncthingDeviceId,
          peerUrl: tunnelAcceptUrl(role.peer.httpsUrl, role.outgoing.acceptId),
          tunnelToken: outgoingToken,
          acceptId: role.outgoing.acceptId,
        },
      }
    }),
  )
  return {
    shares: projected
      .filter((share): share is NonNullable<typeof share> => share !== null)
      .sort((left, right) => left.shareId.localeCompare(right.shareId)),
  }
}

export async function projectShareSyncGenerations(input: {
  shares: readonly ShareSyncProjectionShare[]
  anchors: readonly ShareSyncProjectionAnchor[]
  workspaces: readonly ShareSyncProjectionWorkspace[]
  now: number
}): Promise<ShareSyncGenerationProjection[]> {
  return (await resolveShareSyncMaterials(input)).map(material => ({
    shareId: material.share.id,
    origin: {
      workspaceId: material.origin.workspaceId,
      generation: material.origin.generation,
    },
    recipient: {
      workspaceId: material.recipient.workspaceId,
      generation: material.recipient.generation,
    },
  }))
}

export async function loadShareSyncProjectionInput(
  ctx: QueryCtx | MutationCtx,
  relevantRows: readonly Doc<'shares'>[],
): Promise<{
  shares: ShareSyncProjectionShare[]
  anchors: ShareSyncProjectionAnchor[]
  workspaces: ShareSyncProjectionWorkspace[]
}> {
  const relevant = new Map(relevantRows.map(share => [share._id, share]))
  const shares = new Map(relevant)
  const parentIds = new Set(
    [...relevant.values()].flatMap(share =>
      share.parentShareId === undefined ? [] : [share.parentShareId],
    ),
  )
  for (const parentId of parentIds) {
    if (shares.has(parentId)) continue
    const parent = await ctx.db.get(parentId)
    if (parent !== null) shares.set(parent._id, parent)
  }
  if (shares.size > MAX_SHARE_ROWS_PER_WORKSPACE_SYNC) {
    throw new Error('Workspace share sync read limit exceeded')
  }

  const anchorIds = new Set<Id<'anchors'>>()
  const workspaceIds = new Set<Id<'workspaces'>>()
  for (const share of shares.values()) {
    anchorIds.add(share.anchorId)
    if (share.mountAnchorId !== undefined) anchorIds.add(share.mountAnchorId)
    workspaceIds.add(share.fromWorkspaceId)
    if (share.toWorkspaceId !== undefined) workspaceIds.add(share.toWorkspaceId)
  }
  const [anchorRows, workspaceRows] = await Promise.all([
    Promise.all([...anchorIds].map(id => ctx.db.get(id))),
    Promise.all([...workspaceIds].map(id => ctx.db.get(id))),
  ])
  return {
    shares: [...shares.values()].map(toShareSyncProjectionShare),
    anchors: anchorRows
      .filter((anchor): anchor is Doc<'anchors'> => anchor !== null)
      .map(toShareSyncProjectionAnchor),
    workspaces: workspaceRows
      .filter((workspace): workspace is Doc<'workspaces'> => workspace !== null)
      .map(toShareSyncProjectionWorkspace),
  }
}

export async function rotateExpiringShareSyncCredentials(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
): Promise<number> {
  const shares = await activeSharesForWorkspace(ctx, workspaceId)
  let rotated = 0
  for (const share of shares) {
    if (
      share.sync === undefined ||
      share.sync.tokenExpiresAt > now + SHARE_SYNC_RENEWAL_WINDOW_MS
    ) {
      continue
    }
    await ctx.db.patch(share._id, {
      sync: {
        ...share.sync,
        sourceToTargetNonce: randomHex(16),
        targetToSourceNonce: randomHex(16),
        tokenSecret: randomHex(32),
        tokenExpiresAt: now + SHARE_SYNC_TOKEN_TTL_MS,
        preparedAt: now,
      },
    })
    rotated += 1
  }
  return rotated
}

export async function activeSharesForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
) {
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query('shares')
      .withIndex('by_from_workspace_state_declinedAt_expiresAt', q =>
        q.eq('fromWorkspaceId', workspaceId).eq('state', 'active'),
      )
      .take(MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC + 1),
    ctx.db
      .query('shares')
      .withIndex('by_to_workspace_state', q =>
        q.eq('toWorkspaceId', workspaceId).eq('state', 'active'),
      )
      .take(MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC + 1),
  ])
  const shares = new Map([...outgoing, ...incoming].map(share => [share._id, share]))
  if (
    outgoing.length > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC ||
    incoming.length > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC ||
    shares.size > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC
  ) {
    throw new Error('Workspace active share limit exceeded')
  }
  return [...shares.values()]
}

export async function assertActiveShareAdmission(
  ctx: QueryCtx | MutationCtx,
  workspaceIds: readonly Id<'workspaces'>[],
): Promise<void> {
  for (const workspaceId of new Set(workspaceIds)) {
    if (
      (await activeSharesForWorkspace(ctx, workspaceId)).length >=
      MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC
    ) {
      throw new Error('Workspace active share limit exceeded')
    }
  }
}

export async function shareSyncRealizationsForShare(
  ctx: QueryCtx | MutationCtx,
  shareId: Id<'shares'>,
) {
  const rows = await ctx.db
    .query('shareSyncRealizations')
    .withIndex('by_share', q => q.eq('shareId', shareId))
    .take(MAX_SHARE_SYNC_REALIZATIONS_PER_SHARE + 1)
  if (rows.length > MAX_SHARE_SYNC_REALIZATIONS_PER_SHARE) {
    throw new Error('Share has too many realization reports')
  }
  return rows
}

type ProjectableWorkspace = ShareSyncProjectionWorkspace & {
  syncthingDeviceId: string
  httpsUrl: string
}

type ShareSyncRoleMaterial = {
  role: 'origin' | 'recipient'
  workspaceId: string
  localPath: string
  local: ProjectableWorkspace
  peer: ProjectableWorkspace
  incoming: {
    acceptId: string
    nonce: string
    claims: TunnelTokenClaims
  }
  outgoing: {
    acceptId: string
    nonce: string
    claims: TunnelTokenClaims
  }
  generation: string
}

type ShareSyncMaterial = {
  share: ShareSyncProjectionShare & { sync: NonNullable<ShareSyncProjectionShare['sync']> }
  targetAnchor: ShareSyncProjectionAnchor
  origin: ShareSyncRoleMaterial
  recipient: ShareSyncRoleMaterial
}

async function resolveShareSyncMaterials(input: {
  shares: readonly ShareSyncProjectionShare[]
  anchors: readonly ShareSyncProjectionAnchor[]
  workspaces: readonly ShareSyncProjectionWorkspace[]
  now: number
}): Promise<ShareSyncMaterial[]> {
  const anchors = new Map(input.anchors.map(anchor => [anchor.id, anchor]))
  const shares = new Map(input.shares.map(share => [share.id, share]))
  const workspaces = new Map(input.workspaces.map(workspace => [workspace.id, workspace]))
  const materials = await Promise.all(
    input.shares.map(async share => {
      if (
        share.state !== 'active' ||
        share.sync === undefined ||
        share.sync.tokenExpiresAt <= input.now ||
        share.toWorkspaceId === undefined ||
        share.mountAnchorId === undefined
      ) {
        return null
      }
      const source = workspaces.get(share.fromWorkspaceId)
      const target = workspaces.get(share.toWorkspaceId)
      const parent = share.parentShareId === undefined ? undefined : shares.get(share.parentShareId)
      const sourceAnchorId =
        parent === undefined
          ? share.anchorId
          : sourceAnchorFromParent(parent, share.fromWorkspaceId)
      const sourceAnchor = sourceAnchorId === undefined ? undefined : anchors.get(sourceAnchorId)
      const targetAnchor = anchors.get(share.mountAnchorId)
      if (
        !projectableWorkspace(source) ||
        !projectableWorkspace(target) ||
        !projectableSourceAnchor(sourceAnchor, share.fromWorkspaceId, parent !== undefined) ||
        !projectableAnchor(targetAnchor, share.toWorkspaceId, 'share-mount')
      ) {
        return null
      }
      const projectableShare = { ...share, sync: share.sync }
      const [origin, recipient] = await Promise.all([
        roleMaterial(
          projectableShare,
          source,
          target,
          sourceAnchor.path,
          targetAnchor.path,
          'origin',
        ),
        roleMaterial(
          projectableShare,
          target,
          source,
          targetAnchor.path,
          sourceAnchor.path,
          'recipient',
        ),
      ])
      return { share: projectableShare, targetAnchor, origin, recipient }
    }),
  )
  return materials.filter((material): material is ShareSyncMaterial => material !== null)
}

async function roleMaterial(
  share: ShareSyncProjectionShare & { sync: NonNullable<ShareSyncProjectionShare['sync']> },
  local: ProjectableWorkspace,
  peer: ProjectableWorkspace,
  localPath: string,
  peerPath: string,
  role: 'origin' | 'recipient',
): Promise<ShareSyncRoleMaterial> {
  const toWorkspaceId = share.toWorkspaceId
  if (toWorkspaceId === undefined) throw new Error('Active share recipient is missing')
  const incoming =
    role === 'origin'
      ? {
          acceptId: share.sync.targetToSourceAcceptId,
          nonce: share.sync.targetToSourceNonce,
          claims: tunnelClaims(share, toWorkspaceId, 'target-to-source'),
        }
      : {
          acceptId: share.sync.sourceToTargetAcceptId,
          nonce: share.sync.sourceToTargetNonce,
          claims: tunnelClaims(share, toWorkspaceId, 'source-to-target'),
        }
  const outgoing =
    role === 'origin'
      ? {
          acceptId: share.sync.sourceToTargetAcceptId,
          nonce: share.sync.sourceToTargetNonce,
          claims: tunnelClaims(share, toWorkspaceId, 'source-to-target'),
        }
      : {
          acceptId: share.sync.targetToSourceAcceptId,
          nonce: share.sync.targetToSourceNonce,
          claims: tunnelClaims(share, toWorkspaceId, 'target-to-source'),
        }
  return {
    role,
    workspaceId: local.id,
    localPath,
    local,
    peer,
    incoming,
    outgoing,
    generation: await structuralGeneration({
      shareId: share.id,
      sourcePath: role === 'origin' ? localPath : peerPath,
      targetPath: role === 'origin' ? peerPath : localPath,
      mode: share.mode,
      role,
      localDeviceId: local.syncthingDeviceId,
      peerDeviceId: peer.syncthingDeviceId,
      incomingAcceptId: incoming.acceptId,
      outgoingAcceptId: outgoing.acceptId,
      ignorePatterns: share.ignorePatterns,
      paused: share.pausedAt !== undefined,
    }),
  }
}

function sourceAnchorFromParent(
  parent: ShareSyncProjectionShare,
  workspaceId: string,
): string | undefined {
  if (
    parent.state !== 'active' ||
    parent.toWorkspaceId !== workspaceId ||
    parent.mountAnchorId === undefined
  ) {
    return undefined
  }
  return parent.mountAnchorId
}

function projectableWorkspace(
  workspace: ShareSyncProjectionWorkspace | undefined,
): workspace is ProjectableWorkspace {
  return (
    workspace !== undefined &&
    workspace.live &&
    workspace.syncthingDeviceId !== undefined &&
    workspace.httpsUrl !== undefined
  )
}

function toShareSyncProjectionShare(share: Doc<'shares'>): ShareSyncProjectionShare {
  return {
    id: share._id,
    state: share.state,
    fromWorkspaceId: share.fromWorkspaceId,
    ...(share.toWorkspaceId === undefined ? {} : { toWorkspaceId: share.toWorkspaceId }),
    anchorId: share.anchorId,
    ...(share.mountAnchorId === undefined ? {} : { mountAnchorId: share.mountAnchorId }),
    ...(share.parentShareId === undefined ? {} : { parentShareId: share.parentShareId }),
    mode: share.mode,
    ignorePatterns: share.ignorePatterns,
    ...(share.pausedAt === undefined ? {} : { pausedAt: share.pausedAt }),
    ...(share.sync === undefined ? {} : { sync: share.sync }),
  }
}

function toShareSyncProjectionAnchor(anchor: Doc<'anchors'>): ShareSyncProjectionAnchor {
  return {
    id: anchor._id,
    workspaceId: anchor.workspaceId,
    path: anchor.path,
    kind: anchor.kind,
    state: anchor.state,
  }
}

function toShareSyncProjectionWorkspace(
  workspace: Doc<'workspaces'>,
): ShareSyncProjectionWorkspace {
  return {
    id: workspace._id,
    live: isLiveWorkspace(workspace),
    ...(workspace.syncthingDeviceId === undefined
      ? {}
      : { syncthingDeviceId: workspace.syncthingDeviceId }),
    ...(workspace.httpsUrl === undefined ? {} : { httpsUrl: workspace.httpsUrl }),
  }
}

function projectableAnchor(
  anchor: ShareSyncProjectionAnchor | undefined,
  workspaceId: string,
  kind: ShareSyncProjectionAnchor['kind'],
): anchor is ShareSyncProjectionAnchor {
  return (
    anchor !== undefined &&
    anchor.workspaceId === workspaceId &&
    anchor.kind === kind &&
    anchor.state === 'active'
  )
}

function projectableSourceAnchor(
  anchor: ShareSyncProjectionAnchor | undefined,
  workspaceId: string,
  isReshare: boolean,
): anchor is ShareSyncProjectionAnchor {
  return (
    anchor !== undefined &&
    anchor.workspaceId === workspaceId &&
    anchor.state === 'active' &&
    (isReshare
      ? anchor.kind === 'share-mount'
      : anchor.kind === 'share-root' || anchor.kind === 'app' || anchor.kind === 'agent')
  )
}

function tunnelClaims(
  share: ShareSyncProjectionShare,
  toWorkspaceId: string,
  direction: TunnelTokenClaims['direction'],
): TunnelTokenClaims {
  return {
    sourceWorkspaceId: direction === 'source-to-target' ? share.fromWorkspaceId : toWorkspaceId,
    targetWorkspaceId: direction === 'source-to-target' ? toWorkspaceId : share.fromWorkspaceId,
    direction,
  }
}

async function structuralGeneration(value: {
  shareId: string
  sourcePath: string
  targetPath: string
  mode: 'read' | 'write'
  role: 'origin' | 'recipient'
  localDeviceId: string
  peerDeviceId: string
  incomingAcceptId: string
  outgoingAcceptId: string
  ignorePatterns: string[]
  paused: boolean
}): Promise<string> {
  return await sha256Hex(JSON.stringify(value))
}

function tunnelAcceptUrl(peerUrl: string, acceptId: string): string {
  const url = new URL(peerUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = `/v1/tunnel/accept/${encodeURIComponent(acceptId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
