import type { Infer } from 'convex/values'

import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { hashSecret, requireApiInternalKey } from '../apiKeys/model'
import type {
  restoreForVmArgs,
  gatewayConnectionBySlugArgs,
  gatewayConnectionByVmTokenArgs,
} from './provisioning'
import { resolveRegistrationRestore } from './seed'

export const VM_TOKEN_PREFIX = 'duet_vm_'

export async function restoreForVmImpl(ctx: QueryCtx, args: Infer<typeof restoreForVmArgs>) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.vmTokenHash !== args.vmTokenHash) {
    throw new Error('Archive not found')
  }
  const restore = await resolveRegistrationRestore(ctx, workspace)
  if (restore === null) throw new Error('Restore not found')
  return restore
}

// Backup dispatch must reach a VM whose normal sync rail is unhealthy. Its
// job identity supplies the workspace; this connection never serves user traffic.
export async function gatewayConnectionForBackupImpl(
  ctx: QueryCtx,
  args: { internalKey: string; backupId: Id<'workspaceBackups'>; attemptId: string },
) {
  requireApiInternalKey(args.internalKey)
  const backup = await ctx.db.get(args.backupId)
  if (!backup || backup.attemptId !== args.attemptId) return null
  const workspace = await ctx.db.get(backup.workspaceId)
  if (
    !workspace ||
    (workspace.status !== 'active' && workspace.status !== 'unhealthy') ||
    workspace.servicingStatus === 'banned' ||
    workspace.suspendedAt !== undefined ||
    workspace.pendingBackupLifecycle?.phase === 'restoring' ||
    !workspace.vmName ||
    !workspace.httpsUrl ||
    !workspace.vmTokenNonce ||
    !workspace.vmTokenHash
  )
    return null
  return {
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    vmName: workspace.vmName,
    httpsUrl: workspace.httpsUrl,
    vmToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce),
    runtimeVersion: workspace.runtimeVersion,
  }
}

export async function gatewayConnectionBySlugImpl(
  ctx: QueryCtx,
  args: Infer<typeof gatewayConnectionBySlugArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db
    .query('workspaces')
    .withIndex('by_slug_status', q => q.eq('slug', args.slug))
    .filter(q => q.and(q.neq(q.field('status'), 'deleted'), q.neq(q.field('status'), 'retired')))
    .unique()
  if (workspace === null || workspace.suspendedAt !== undefined) return null
  if (workspace.servicingStatus === 'paused' && args.allowPaused !== true) {
    return { refusal: 'paused' as const }
  }
  if (workspace.servicingStatus === 'banned') return null
  if (workspace.pendingBackupLifecycle?.phase === 'restoring')
    return { refusal: 'provisioning' as const }
  if (!isLiveWorkspace(workspace)) {
    // Everything terminal is already `null` above: deleted and retired are
    // filtered by the query, suspended and banned return early. What is left
    // here is a real workspace with no gateway, and the caller needs to know
    // whether waiting helps.
    //
    // Archived reclaimed the VM: the row survives and can be recommissioned,
    // but only by an explicit action, so waiting never resolves it. It is its
    // own refusal rather than `null` (which claims the workspace does not
    // exist) or `provisioning` (which promises a wait that never ends).
    if (workspace.status === 'archived') return { refusal: 'archived' as const }
    if (workspace.status === 'unhealthy') return { refusal: 'unhealthy' as const }
    // Provisioning, or active with its VM fields not yet written, is cleared by
    // the gateway registering. An unhealthy workspace needs operator recovery,
    // so callers must not promise that this wait will end by itself.
    return { refusal: 'provisioning' as const }
  }
  return {
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    vmName: workspace.vmName,
    httpsUrl: workspace.httpsUrl,
    vmToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce),
    runtimeVersion: workspace.runtimeVersion,
  }
}

type LiveWorkspace = Doc<'workspaces'> & {
  vmName: string
  httpsUrl: string
  vmTokenNonce: string
}

export function isLiveWorkspace(workspace: Doc<'workspaces'>): workspace is LiveWorkspace {
  return (
    workspace.status === 'active' &&
    workspace.suspendedAt === undefined &&
    workspace.vmName !== undefined &&
    workspace.httpsUrl !== undefined &&
    workspace.vmTokenNonce !== undefined
  )
}

export async function gatewayConnectionByVmTokenImpl(
  ctx: QueryCtx,
  args: Infer<typeof gatewayConnectionByVmTokenArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db
    .query('workspaces')
    .withIndex('by_vmTokenHash', q => q.eq('vmTokenHash', args.vmTokenHash))
    .unique()
  // Every caller is the VM pulling its own artifacts (gateway release, skills
  // bundle) or reporting its own activity — never user traffic. A paused or
  // suspended workspace keeps its VM and keeps syncing, so it must stay
  // updatable; whether it may serve users is the sync payload's concern
  // (quiesce), not this lookup's.
  if (
    workspace === null ||
    !isExistingWorkspace(workspace) ||
    workspace.vmTokenNonce === undefined ||
    workspace.vmName === undefined ||
    workspace.httpsUrl === undefined
  ) {
    return null
  }
  return {
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    vmName: workspace.vmName,
    httpsUrl: workspace.httpsUrl,
    vmToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce),
    ...(workspace.onboardedAt === undefined ? {} : { onboardedAt: workspace.onboardedAt }),
  }
}

export async function workspaceForVmTerminalRelayImpl(
  ctx: QueryCtx,
  args: { internalKey: string; vmTokenHash: string },
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db
    .query('workspaces')
    .withIndex('by_vmTokenHash', q => q.eq('vmTokenHash', args.vmTokenHash))
    .unique()
  if (
    workspace === null ||
    workspace.status === 'deleted' ||
    workspace.status === 'retired' ||
    workspace.status === 'archived'
  ) {
    return null
  }
  return {
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    servicingStatus: workspace.servicingStatus ?? 'active',
    ...(workspace.onboardedAt === undefined ? {} : { onboardedAt: workspace.onboardedAt }),
  }
}

/**
 * The row still represents a workspace with a lifetime — anything short of
 * deleted or retired. Weaker than `isLiveWorkspace`: a paused, suspended, or
 * still-provisioning workspace is not serviceable, but its VM is still its own.
 */
export function isExistingWorkspace(workspace: Doc<'workspaces'>): boolean {
  return workspace.status !== 'deleted' && workspace.status !== 'retired'
}

export async function hashProvisioningToken(token: string): Promise<string> {
  return await hashSecret(token)
}

export function generateProvisioningToken(): string {
  return randomHex(32)
}

export async function deriveVmToken(workspaceId: Id<'workspaces'>, nonce: string): Promise<string> {
  const secret = process.env.DUET_VM_TOKEN_DERIVE_SECRET ?? process.env.DUET_API_INTERNAL_KEY
  if (!secret) throw new Error('DUET_VM_TOKEN_DERIVE_SECRET is required')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${workspaceId}:${nonce}`),
  )
  const digest = Array.from(new Uint8Array(signature), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return `${VM_TOKEN_PREFIX}${digest}`
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('')
}
