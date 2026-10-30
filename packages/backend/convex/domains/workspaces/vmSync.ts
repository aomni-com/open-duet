import { v, type Infer } from 'convex/values'

import {
  AppApiScopesSchema,
  AppReconciliationReportSchema,
  MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
  ShareSyncReportSchema,
  VmVersionMetadataSchema,
  formatTunnelTokenParts,
  signTunnelToken,
  type VmAppCredentials,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { projectVmTopologyImpl } from '../anchors/model'
import {
  mintAppKeyForApp,
  mintVmModelKeyForWorkspace,
  requireApiInternalKey,
  rotateAppKeyForApp,
  supersedeVmModelKeyForWorkspace,
  vmModelKeyCapacityRetryAt,
  vmModelKeyDeliveryDue,
  vmModelScopeKey,
} from '../apiKeys/model'
import { applyVmReconciliationReports, runConfigForWorkspaceImpl } from '../apps/model'
import { writeAuditEvent } from '../audit/model'
import { disconnectDirectivesForWorkspace } from '../connectedProviders/model'
import { domainStatusValidator } from '../customDomains/validators'
import { projectMarketplaceAgentsForWorkspace } from '../marketplace/model'
import {
  MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC,
  activeSharesForWorkspace,
  loadShareSyncProjectionInput,
  projectDesiredShareSync,
  rotateExpiringShareSyncCredentials,
} from '../shares/syncProjection'
import { mirrorMachineIdsForWorkspace } from '../syncMachines/model'
import { finishRecovery } from './lifecycleState'
import { auditActor } from './provisioningShared'
import { isExistingWorkspace } from './vmToken'

export const VM_SYNC_PERSIST_INTERVAL_MS = 60_000

const vmSyncVersionsValidator = v.object({ runtime: v.string(), image: v.string() })

const shareSyncReportValidator = v.object({
  shareId: v.string(),
  generation: v.string(),
  state: v.union(
    v.literal('applying'),
    v.literal('ready'),
    v.literal('paused'),
    v.literal('error'),
  ),
  errorCode: v.optional(v.string()),
})

const gatewayAppConfigValidator = {
  appId: v.string(),
  slug: v.string(),
  command: v.string(),
  installCommand: v.optional(v.string()),
  name: v.optional(v.string()),
  port: v.number(),
  anchorPath: v.string(),
  apiScopes: v.array(v.string()),
  contentGeneration: v.optional(v.string()),
  // Gateways echo prompt metadata in reconciliation reports. Convex validators
  // are closed, so every optional config field must be declared here.
  visibility: v.optional(v.union(v.literal('folder'), v.literal('public'))),
  canonicalUrl: v.optional(v.string()),
  customDomain: v.optional(v.object({ hostname: v.string(), status: domainStatusValidator })),
}

const appReconciliationReportValidator = v.union(
  v.object({
    ...gatewayAppConfigValidator,
    status: v.literal('reconciled'),
  }),
  v.object({
    ...gatewayAppConfigValidator,
    status: v.literal('reconcile_failed'),
    error: v.string(),
  }),
)

export const vmSyncPlanningObservationValidator = v.object({
  syncthingDeviceId: v.optional(v.string()),
  needsModelCredentials: v.boolean(),
  needsAppCredentials: v.optional(v.array(v.string())),
  versions: vmSyncVersionsValidator,
})

export const vmSyncObservationValidator = v.object({
  syncthingDeviceId: v.optional(v.string()),
  shareSyncReports: v.optional(v.array(shareSyncReportValidator)),
  appReconciliationReports: v.optional(v.array(appReconciliationReportValidator)),
  needsModelCredentials: v.boolean(),
  needsAppCredentials: v.optional(v.array(v.string())),
  versions: vmSyncVersionsValidator,
})

export const readVmSyncStateArgs = v.object({
  internalKey: v.string(),
  vmTokenHash: v.string(),
  now: v.number(),
})

export const persistVmSyncObservationArgs = v.object({
  internalKey: v.string(),
  vmTokenHash: v.string(),
  observation: vmSyncObservationValidator,
  now: v.number(),
})

export const setUpdatesPausedArgs = v.object({
  internalKey: v.string(),
  paused: v.boolean(),
  reason: v.optional(v.string()),
  now: v.optional(v.number()),
})

export type VmSyncPersistenceSnapshot = Pick<
  Doc<'workspaces'>,
  'status' | 'lastHeartbeatAt' | 'runtimeVersion' | 'imageVersion' | 'syncthingDeviceId'
>

export type VmSyncPlanningObservation = Infer<typeof vmSyncPlanningObservationValidator>

export interface VmSyncPersistencePlan {
  persist: boolean
  reasons: string[]
}

export function planVmSyncPersistence(
  snapshot: VmSyncPersistenceSnapshot,
  observation: VmSyncPlanningObservation,
  now: number,
): VmSyncPersistencePlan {
  const reasons: string[] = []
  if (snapshot.lastHeartbeatAt === undefined) reasons.push('observation_missing')
  else if (now - snapshot.lastHeartbeatAt >= VM_SYNC_PERSIST_INTERVAL_MS) {
    reasons.push('observation_due')
  }
  if (snapshot.status === 'unhealthy') reasons.push('status_recovery')
  appendVersionChange(reasons, 'runtime', observation.versions.runtime, snapshot.runtimeVersion)
  appendVersionChange(reasons, 'image', observation.versions.image, snapshot.imageVersion)
  if (
    observation.syncthingDeviceId !== undefined &&
    observation.syncthingDeviceId !== snapshot.syncthingDeviceId
  ) {
    reasons.push('syncthing_device_id_changed')
  }
  if (
    observation.needsModelCredentials ||
    (observation.needsAppCredentials !== undefined && observation.needsAppCredentials.length > 0)
  ) {
    reasons.push('credentials_requested')
  }
  return { persist: reasons.length > 0, reasons }
}

// The projection is pure: time-sensitive sections use caller-supplied `now`,
// never `Date.now()` inside the query. The persistence decision still lives
// entirely in `persistVmSyncObservation`, which the API calls every poll with
// the same clock value and which no-ops when not due.
export async function readVmSyncStateImpl(
  ctx: QueryCtx | MutationCtx,
  args: Infer<typeof readVmSyncStateArgs>,
): Promise<{
  workspaceId: Id<'workspaces'>
  workspaceSlug: string
  anchors: Awaited<ReturnType<typeof projectVmTopologyImpl>>['anchors']
  agents: Awaited<ReturnType<typeof projectVmTopologyImpl>>['agents']
  apps: Awaited<ReturnType<typeof runConfigForWorkspaceImpl>>
  mirrorMachineIds: string[]
  shareSync: { shares: Awaited<ReturnType<typeof projectDesiredShareSync>>['shares'] }
  marketplace: Awaited<ReturnType<typeof projectMarketplaceAgentsForWorkspace>>
  disconnectConnectedProviders: Awaited<ReturnType<typeof disconnectDirectivesForWorkspace>>
  quiesce: boolean
  updatesPaused: boolean
  hasPendingRunnerInput: boolean
}> {
  requireApiInternalKey(args.internalKey)
  const workspace = await workspaceByVmTokenHash(ctx, args.vmTokenHash)
  const quiesce = workspace.servicingStatus === 'paused' || workspace.servicingStatus === 'banned'
  if (quiesce) {
    const [updateControl, disconnectConnectedProviders] = await Promise.all([
      readUpdatesControl(ctx),
      disconnectDirectivesForWorkspace(ctx, workspace._id),
    ])
    return {
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      quiesce: true,
      anchors: [],
      agents: [],
      apps: [],
      mirrorMachineIds: [],
      shareSync: { shares: [] },
      marketplace: undefined,
      disconnectConnectedProviders,
      // Missing singleton = updates flow; the row is an explicit brake a
      // human pulled, never an implicit stop (David, 2026-07-24).
      updatesPaused: updateControl?.paused ?? false,
      hasPendingRunnerInput: false,
    }
  }
  const [
    topology,
    apps,
    marketplace,
    disconnectConnectedProviders,
    updateControl,
    pendingInputSession,
    shareSync,
    mirrorMachineIds,
  ] = await Promise.all([
    projectVmTopologyImpl(ctx, args),
    runConfigForWorkspaceImpl(ctx, workspace._id),
    projectMarketplaceAgentsForWorkspace(ctx, workspace._id),
    disconnectDirectivesForWorkspace(ctx, workspace._id),
    readUpdatesControl(ctx),
    // Undelivered runner input (e.g. an initial prompt whose dispatch missed
    // a cold VM) must not wait for the 60s persistence heartbeat — its
    // presence makes every 5s poll a drain opportunity.
    ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_visible_pending_updated', q =>
        q.eq('workspaceId', workspace._id).eq('visible', true).eq('runnerInputPending', true),
      )
      .first(),
    // In the SAME query as the rest of the projection, deliberately: one Convex
    // query is one consistent snapshot, so a pause can never land between the
    // roster and the shares and hand the VM half of each. It also makes the
    // whole projection one function call per poll instead of two.
    desiredShareSyncForWorkspace(ctx, workspace._id, args.now),
    mirrorMachineIdsForWorkspace(ctx, workspace._id),
  ])
  return {
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    quiesce: false,
    anchors: topology.anchors,
    agents: topology.agents,
    apps,
    mirrorMachineIds,
    shareSync: { shares: shareSync.shares },
    marketplace,
    disconnectConnectedProviders,
    updatesPaused: updateControl?.paused ?? false,
    hasPendingRunnerInput: pendingInputSession !== null,
  }
}

async function desiredShareSyncForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
) {
  const projection = await loadShareSyncProjectionInput(
    ctx,
    await activeSharesForWorkspace(ctx, workspaceId),
  )

  return await projectDesiredShareSync({
    workspaceId,
    ...projection,
    now,
    signBearer: async ({ secret, claims, nonce, expiresAt }) =>
      formatTunnelTokenParts({
        expiresAt,
        nonce,
        signature: await signTunnelToken(secret, claims, expiresAt, nonce),
      }),
  })
}

export const readVmSyncState = query({
  args: readVmSyncStateArgs,
  handler: (ctx, args) => readVmSyncStateImpl(ctx, args),
})

export async function persistVmSyncObservationImpl(
  ctx: MutationCtx,
  args: Infer<typeof persistVmSyncObservationArgs>,
): Promise<{
  persisted: boolean
  reasons: string[]
  modelCredentials?: DeliveredModelCredentials
  modelCredentialsRetryAt?: number
  appCredentials?: DeliveredAppCredentials[]
}> {
  requireApiInternalKey(args.internalKey)
  const workspace = await workspaceByVmTokenHash(ctx, args.vmTokenHash)
  await finishRecovery(ctx, workspace, 'complete')
  const quiesced = workspace.servicingStatus === 'paused' || workspace.servicingStatus === 'banned'
  const currentModelScopeKey = vmModelScopeKey(workspace.slug)
  const credentialRetryBlocked =
    workspace.vmModelCredentialRetryAt !== undefined &&
    workspace.vmModelCredentialRetryAt > args.now &&
    workspace.vmModelCredentialRetryScopeKey === currentModelScopeKey
  if (!quiesced) {
    await rotateExpiringShareSyncCredentials(ctx, workspace._id, args.now)
    await persistShareSyncReports(
      ctx,
      workspace._id,
      args.observation.shareSyncReports ?? [],
      args.now,
    )
  }
  if (!quiesced) {
    const appReconciliationReports = (args.observation.appReconciliationReports ?? []).map(report =>
      AppReconciliationReportSchema.parse(report),
    )
    await applyVmReconciliationReports(ctx, {
      workspaceId: workspace._id,
      reports: appReconciliationReports,
      now: args.now,
    })
  }
  // Missing authority is server-detected. The VM only asks near its own copy's
  // expiry, which strands two cases it cannot see: a grown scope contract, and a
  // key that expired while the workspace was quiesced — a paused workspace is
  // refused credentials, so a pause outlasting a key lifetime leaves the VM
  // holding a dead one. Delivering unprompted heals both on the first poll the
  // workspace is servicing again, instead of a key lifetime later.
  const credentialDeliveryDue =
    !quiesced &&
    !credentialRetryBlocked &&
    !args.observation.needsModelCredentials &&
    (await vmModelKeyDeliveryDue(ctx, {
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      now: args.now,
    }))
  const plan = planVmSyncPersistence(persistenceSnapshot(workspace), args.observation, args.now)
  if (credentialDeliveryDue && !plan.persist) {
    plan.persist = true
    plan.reasons.push('credentials_delivery_due')
  }
  if (!plan.persist) {
    return {
      persisted: false,
      reasons: plan.reasons,
    }
  }

  const wasUnhealthy = workspace.status === 'unhealthy'
  await ctx.db.patch(workspace._id, {
    status: wasUnhealthy ? 'active' : workspace.status,
    updatedAt: args.now,
    lastHeartbeatAt: args.now,
    healthSweepRetryAt: undefined,
    ...reportedVersionPatch(args.observation.versions),
    ...(args.observation.syncthingDeviceId === undefined
      ? {}
      : { syncthingDeviceId: args.observation.syncthingDeviceId }),
  })
  if (wasUnhealthy) {
    await writeAuditEvent(ctx, {
      workspaceId: workspace._id,
      event: 'workspace.became_healthy',
      actorId: auditActor(workspace),
      at: args.now,
    })
  }
  const shouldAttemptModelCredential =
    !quiesced &&
    !credentialRetryBlocked &&
    (args.observation.needsModelCredentials || credentialDeliveryDue)
  const modelCredentials = shouldAttemptModelCredential
    ? await composeVmModelCredentials(ctx, {
        workspaceId: workspace._id,
        now: args.now,
        mode: 'mint-or-supersede',
      })
    : undefined
  const modelCredentialsRetryAt = credentialRetryBlocked
    ? workspace.vmModelCredentialRetryAt
    : shouldAttemptModelCredential && modelCredentials === undefined
      ? await vmModelKeyCapacityRetryAt(ctx, { workspaceId: workspace._id, now: args.now })
      : undefined
  if (
    modelCredentials !== undefined &&
    (workspace.vmModelCredentialRetryAt !== undefined ||
      workspace.vmModelCredentialRetryScopeKey !== undefined)
  ) {
    await ctx.db.patch(workspace._id, {
      vmModelCredentialRetryAt: undefined,
      vmModelCredentialRetryScopeKey: undefined,
    })
  } else if (
    modelCredentialsRetryAt !== undefined &&
    (modelCredentialsRetryAt !== workspace.vmModelCredentialRetryAt ||
      workspace.vmModelCredentialRetryScopeKey !== currentModelScopeKey)
  ) {
    await ctx.db.patch(workspace._id, {
      vmModelCredentialRetryAt: modelCredentialsRetryAt,
      vmModelCredentialRetryScopeKey: currentModelScopeKey,
    })
  }
  const appCredentials =
    !quiesced && (args.observation.needsAppCredentials?.length ?? 0) > 0
      ? await composeVmAppCredentials(ctx, {
          workspaceId: workspace._id,
          appIds: args.observation.needsAppCredentials ?? [],
          now: args.now,
        })
      : []
  return {
    persisted: true,
    reasons: plan.reasons,
    ...(modelCredentials === undefined ? {} : { modelCredentials }),
    ...(modelCredentialsRetryAt === undefined ? {} : { modelCredentialsRetryAt }),
    ...(appCredentials.length === 0 ? {} : { appCredentials }),
  }
}

export const persistVmSyncObservation = mutation({
  args: persistVmSyncObservationArgs,
  handler: (ctx, args) => persistVmSyncObservationImpl(ctx, args),
})

export async function setUpdatesPausedImpl(
  ctx: MutationCtx,
  args: Infer<typeof setUpdatesPausedArgs>,
): Promise<Id<'vmUpdateControl'>> {
  requireApiInternalKey(args.internalKey)
  const existing = await readUpdatesControl(ctx)
  const value = {
    paused: args.paused,
    updatedAt: args.now ?? Date.now(),
  }
  if (existing === null) {
    return await ctx.db.insert('vmUpdateControl', {
      scope: 'global',
      ...value,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    })
  }
  await ctx.db.patch(existing._id, { ...value, reason: args.reason })
  return existing._id
}

export const setUpdatesPaused = mutation({
  args: setUpdatesPausedArgs,
  handler: (ctx, args) => setUpdatesPausedImpl(ctx, args),
})

export async function readUpdatesControl(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<'vmUpdateControl'> | null> {
  return await ctx.db
    .query('vmUpdateControl')
    .withIndex('by_scope', q => q.eq('scope', 'global'))
    .unique()
}

function persistenceSnapshot(workspace: Doc<'workspaces'>): VmSyncPersistenceSnapshot {
  return {
    status: workspace.status,
    ...(workspace.lastHeartbeatAt === undefined
      ? {}
      : { lastHeartbeatAt: workspace.lastHeartbeatAt }),
    ...(workspace.runtimeVersion === undefined ? {} : { runtimeVersion: workspace.runtimeVersion }),
    ...(workspace.imageVersion === undefined ? {} : { imageVersion: workspace.imageVersion }),
    ...(workspace.syncthingDeviceId === undefined
      ? {}
      : { syncthingDeviceId: workspace.syncthingDeviceId }),
  }
}

async function persistShareSyncReports(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  reports: Infer<typeof shareSyncReportValidator>[],
  now: number,
): Promise<void> {
  if (reports.length === 0) return
  if (reports.length > MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE) {
    throw new Error('Too many share sync reports')
  }
  const boundedReports = reports.map(report => ShareSyncReportSchema.parse(report))
  const byShareId = new Map<string, Infer<typeof shareSyncReportValidator>>()
  for (const report of boundedReports) {
    if (byShareId.has(report.shareId)) throw new Error('Duplicate share sync report')
    byShareId.set(report.shareId, report)
  }
  let existing = await ctx.db
    .query('shareSyncRealizations')
    .withIndex('by_workspace_share', q => q.eq('workspaceId', workspaceId))
    .take(MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC + 1)
  let existingByShareId = new Map(existing.map(report => [report.shareId, report]))
  let newCount = boundedReports.reduce(
    (count, report) => count + Number(!existingByShareId.has(report.shareId)),
    0,
  )
  if (existing.length + newCount > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC) {
    const activeShareIds = new Set(
      (await activeSharesForWorkspace(ctx, workspaceId)).map(share => share._id),
    )
    const obsolete = existing.filter(report => !activeShareIds.has(report.shareId as Id<'shares'>))
    for (const report of obsolete) await ctx.db.delete(report._id)
    existing = existing.filter(report => activeShareIds.has(report.shareId as Id<'shares'>))
    existingByShareId = new Map(existing.map(report => [report.shareId, report]))
    newCount = boundedReports.reduce(
      (count, report) => count + Number(!existingByShareId.has(report.shareId)),
      0,
    )
  }
  if (existing.length + newCount > MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC) {
    throw new Error('Too many share sync reports')
  }
  for (const report of boundedReports) {
    const previous = existingByShareId.get(report.shareId)
    if (previous === undefined) {
      await ctx.db.insert('shareSyncRealizations', {
        workspaceId,
        ...report,
        updatedAt: now,
      })
      continue
    }
    if (
      previous.generation === report.generation &&
      previous.state === report.state &&
      previous.errorCode === report.errorCode
    ) {
      continue
    }
    await ctx.db.patch(previous._id, {
      generation: report.generation,
      state: report.state,
      errorCode: report.errorCode,
      updatedAt: now,
    })
  }
}

async function workspaceByVmTokenHash(
  ctx: QueryCtx | MutationCtx,
  vmTokenHash: string,
): Promise<Doc<'workspaces'>> {
  const workspace = await ctx.db
    .query('workspaces')
    .withIndex('by_vmTokenHash', q => q.eq('vmTokenHash', vmTokenHash))
    .unique()
  if (workspace === null || !isExistingWorkspace(workspace)) {
    // The reason is part of the message because the two cases implicate
    // different actors: an unknown hash means the token itself was replaced
    // (registration/rotation), while a dead status means something ended the
    // workspace's life out from under a still-live VM.
    const reason = workspace === null ? 'unknown token' : `workspace ${workspace.status}`
    throw new Error(`Invalid VM token (${reason})`)
  }
  return workspace
}

export function reportedVersionPatch(args: {
  runtime?: string
  runtimeVersion?: string
  image?: string
  imageVersion?: string
}): { runtimeVersion?: string; imageVersion?: string } {
  const bounded = (value: string | undefined) =>
    value === undefined ? undefined : VmVersionMetadataSchema.parse(value)
  const runtimeVersion = bounded(args.runtime ?? args.runtimeVersion)
  const imageVersion = bounded(args.image ?? args.imageVersion)
  return {
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    ...(imageVersion === undefined ? {} : { imageVersion }),
  }
}

export interface DeliveredModelCredentials {
  apiKey: string
  expiresAt: number
}

export type DeliveredAppCredentials = Omit<VmAppCredentials, 'appId'> & {
  appId: Id<'apps'>
}

export async function composeVmAppCredentials(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; appIds: string[]; now: number },
): Promise<DeliveredAppCredentials[]> {
  const delivered: DeliveredAppCredentials[] = []
  for (const requestedAppId of new Set(args.appIds)) {
    const appId = ctx.db.normalizeId('apps', requestedAppId)
    if (appId === null) continue
    const app = await ctx.db.get(appId)
    const declaration = app === null ? null : AppApiScopesSchema.safeParse(app.apiScopes)
    if (
      app === null ||
      app.workspaceId !== args.workspaceId ||
      app.disabledAt !== undefined ||
      declaration?.success !== true ||
      declaration.data.length === 0
    ) {
      continue
    }
    const minted = await mintAppKeyForApp(ctx, { appId, now: args.now })
    const credential =
      minted?.key === null ? await rotateAppKeyForApp(ctx, { appId, now: args.now }) : minted
    if (credential?.key === null || credential === null) continue
    delivered.push({
      appId,
      apiKey: credential.key,
      // The envelope's scopes are the app's declared capabilities — the
      // vocabulary GatewayAppConfig.apiScopes uses for staleness checks —
      // not the key's ws-serialized scope strings.
      scopes: declaration.data,
      expiresAt: credential.expiresAt,
    })
  }
  return delivered
}

export async function composeVmModelCredentials(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    now: number
    mode: 'mint' | 'mint-or-supersede'
  },
): Promise<DeliveredModelCredentials | undefined> {
  const credentialArgs = { workspaceId: args.workspaceId, now: args.now }
  const minted = await mintVmModelKeyForWorkspace(ctx, credentialArgs)
  if (minted === null) return undefined
  if (minted.key !== null) return { apiKey: minted.key, expiresAt: minted.expiresAt }
  if (args.mode === 'mint') return undefined
  // Only the hash of a live key is stored, so a VM that asks for a credential
  // it no longer holds can only be answered with a new one. That is a handover,
  // not a revocation: `supersedeVmModelKeyForWorkspace` leaves the outgoing key
  // alive for the rest of its own lifetime so a turn already running does not
  // lose the key sitting in its env.
  const superseded = await supersedeVmModelKeyForWorkspace(ctx, credentialArgs)
  if (superseded === null) return undefined
  if (superseded.key === null) return undefined
  return { apiKey: superseded.key, expiresAt: superseded.expiresAt }
}

function appendVersionChange(
  reasons: string[],
  component: 'runtime' | 'image',
  reported: string | undefined,
  persisted: string | undefined,
): void {
  if (reported !== undefined && reported !== persisted) {
    reasons.push(`${component}_version_changed`)
  }
}
