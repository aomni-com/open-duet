import { v } from 'convex/values'

import type { VmRestoreReference } from '@repo/contract'
import { seedAppRegistrations } from '@repo/seed-drive/manifest'

import type { Doc, Id } from '../../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../../_generated/server'
import { registerAppImpl } from '../apps/model'

const seedBundleResult = v.object({
  sha256: v.string(),
  storageId: v.id('_storage'),
  created: v.boolean(),
  activated: v.boolean(),
})

export const generateSeedBundleUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: generateSeedBundleUploadUrlImpl,
})

export const recordSeedBundle = internalMutation({
  args: {
    sha256: v.string(),
    storageId: v.id('_storage'),
  },
  returns: seedBundleResult,
  handler: recordSeedBundleImpl,
})

export async function recordSeedBundleImpl(
  ctx: MutationCtx,
  args: { sha256: string; storageId: Id<'_storage'> },
) {
  assertSha256(args.sha256)

  const existing = await uniqueBundleByHash(ctx, args.sha256)
  const current = await uniqueCurrentSeedBundle(ctx)
  if (existing !== null && existing._id === current?._id) {
    await deleteUnusedUpload(ctx, args.storageId, existing.storageId)
    return {
      sha256: existing.sha256,
      storageId: existing.storageId,
      created: false,
      activated: false,
    }
  }

  if (current !== null) await ctx.db.patch(current._id, { current: false })
  if (existing !== null) {
    await ctx.db.patch(existing._id, { current: true })
    await deleteUnusedUpload(ctx, args.storageId, existing.storageId)
    return {
      sha256: existing.sha256,
      storageId: existing.storageId,
      created: false,
      activated: true,
    }
  }

  await ctx.db.insert('seedDriveBundles', {
    sha256: args.sha256,
    storageId: args.storageId,
    createdAt: Date.now(),
    current: true,
  })
  return {
    sha256: args.sha256,
    storageId: args.storageId,
    created: true,
    activated: true,
  }
}

export const currentSeedBundle = internalQuery({
  args: {},
  returns: v.union(v.object({ storageId: v.id('_storage'), sha256: v.string() }), v.null()),
  handler: currentSeedBundleImpl,
})

export const currentSeedBundleDownloadUrl = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async ctx => {
    const current = await currentSeedBundleImpl(ctx)
    return current === null ? null : await ctx.storage.getUrl(current.storageId)
  },
})

export async function currentSeedBundleImpl(
  ctx: QueryCtx | MutationCtx,
): Promise<{ storageId: Id<'_storage'>; sha256: string } | null> {
  const current = await uniqueCurrentSeedBundle(ctx)
  return current === null ? null : { storageId: current.storageId, sha256: current.sha256 }
}

export async function seedWorkspaceAtBirth(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; actorId: Id<'users'>; now: number },
): Promise<void> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  if (workspace.birthSeedStorageId !== undefined && workspace.birthSeedSha256 !== undefined) {
    return
  }
  if (workspace.birthSeedStorageId !== undefined || workspace.birthSeedSha256 !== undefined) {
    throw new Error('Workspace birth seed pin is incomplete')
  }
  const bundle = await currentSeedBundleImpl(ctx)
  if (bundle === null) {
    console.warn(`Workspace ${args.workspaceId} created without a current seed drive bundle`)
    return
  }
  await ctx.db.patch(args.workspaceId, {
    birthSeedStorageId: bundle.storageId,
    birthSeedSha256: bundle.sha256,
  })
  for (const registration of seedAppRegistrations) {
    await registerAppImpl(ctx, {
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      now: args.now,
      ...registration,
    })
  }
}

/** Registration replay must offer the same seed until the VM acknowledges its first sync. */
export async function resolveRegistrationRestore(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<'workspaces'>,
): Promise<VmRestoreReference | null> {
  if (workspace.lifecycleBackupId !== undefined) {
    const backup = await ctx.db.get(workspace.lifecycleBackupId)
    if (
      !backup ||
      backup.workspaceId !== workspace._id ||
      backup.status !== 'ready' ||
      backup.completeness !== 'complete' ||
      backup.bytes === undefined ||
      !backup.sha256
    )
      throw new Error('Recovery backup unavailable')
    return {
      kind: 'workspace-backup',
      backupId: backup._id,
      objectPath: backup.objectPath,
      bytes: backup.bytes,
      sha256: backup.sha256,
    }
  }
  if (
    workspace.birthSeedStorageId !== undefined &&
    (workspace.birthSeedDeliveredAt === undefined ||
      workspace.birthSeedDeliveredAt === workspace.provisioningTokenUsedAt)
  ) {
    const url = await ctx.storage.getUrl(workspace.birthSeedStorageId)
    if (!url) return null
    if (!workspace.birthSeedSha256) throw new Error('Birth seed hash unavailable')
    return { kind: 'birth-seed', url, sha256: workspace.birthSeedSha256 }
  }
  return null
}

export function generateSeedBundleUploadUrlImpl(ctx: MutationCtx): Promise<string> {
  return ctx.storage.generateUploadUrl()
}

async function uniqueBundleByHash(ctx: QueryCtx | MutationCtx, sha256: string) {
  const rows = await ctx.db
    .query('seedDriveBundles')
    .withIndex('by_sha256', q => q.eq('sha256', sha256))
    .take(2)
  if (rows.length > 1) throw new Error(`Duplicate seed drive bundle hash: ${sha256}`)
  return rows[0] ?? null
}

async function uniqueCurrentSeedBundle(ctx: QueryCtx | MutationCtx) {
  const rows = await ctx.db
    .query('seedDriveBundles')
    .withIndex('by_current', q => q.eq('current', true))
    .take(2)
  if (rows.length > 1) throw new Error('Multiple current seed drive bundles')
  return rows[0] ?? null
}

async function deleteUnusedUpload(
  ctx: MutationCtx,
  uploadedStorageId: Id<'_storage'>,
  canonicalStorageId: Id<'_storage'>,
): Promise<void> {
  if (uploadedStorageId !== canonicalStorageId) await ctx.storage.delete(uploadedStorageId)
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid seed drive SHA-256')
}
