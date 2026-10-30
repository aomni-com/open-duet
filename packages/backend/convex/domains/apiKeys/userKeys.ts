import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { DataModel, Id } from '../../_generated/dataModel'
import {
  generateApiKey,
  hashSecret,
  keyPrefix,
  liveWorkspaceMemberships,
  writeAuditForWorkspaceIds,
} from './model'
import { insertApiKey } from './storage'

export async function issueUserKey(
  ctx: GenericMutationCtx<DataModel>,
  args: {
    actorId: Id<'users'>
    name: string
    expiresAt?: number
    now?: number
  },
) {
  const workspaceIds = (await liveWorkspaceMemberships(ctx, args.actorId)).map(
    ({ workspace }) => workspace._id,
  )
  const key = generateApiKey()
  const prefix = keyPrefix(key)
  const id = await insertApiKey(ctx, {
    kind: 'user',
    userId: args.actorId,
    name: args.name.trim(),
    hashedKey: await hashSecret(key),
    prefix,
    ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
  })
  const stored = await ctx.db.get(id)
  if (stored === null) throw new Error('API key insert failed')
  await bindUserCredentialPagination(ctx, id, stored._creationTime)
  await writeAuditForWorkspaceIds(ctx, {
    workspaceIds,
    event: 'api_key.issued',
    actorId: args.actorId,
    provenance: { prefix, name: args.name.trim() },
    at: args.now,
  })
  return {
    key,
    record: {
      id,
      name: args.name.trim(),
      prefix,
      createdAt: stored._creationTime,
      expiresAt: args.expiresAt,
    },
  }
}

export async function listUserKeys(
  ctx: GenericQueryCtx<DataModel>,
  actorId: Id<'users'>,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  const result = await ctx.db
    .query('apiKeys')
    .withIndex('by_userId_kind_created_id', q => q.eq('userId', actorId).eq('kind', 'user'))
    .order('desc')
    .paginate(paginationOpts)
  return {
    ...result,
    page: result.page.map(key => ({
      id: key._id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key._creationTime,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
    })),
  }
}

export async function bindUserCredentialPagination(
  ctx: GenericMutationCtx<DataModel>,
  id: Id<'apiKeys'>,
  createdAt?: number,
) {
  const key = createdAt === undefined ? await ctx.db.get(id) : null
  const paginationCreatedAt = createdAt ?? key?._creationTime
  if (paginationCreatedAt === undefined) throw new Error('API key insert failed')
  await ctx.db.patch(id, { paginationCreatedAt, paginationId: id })
}

export async function revokeUserKey(
  ctx: GenericMutationCtx<DataModel>,
  args: { actorId: Id<'users'>; keyId: Id<'apiKeys'>; now?: number },
) {
  const key = await ctx.db.get(args.keyId)
  if (key === null || key.userId !== args.actorId || key.kind !== 'user') {
    throw new Error('API key not found')
  }
  if (key.revokedAt !== undefined) return { prefix: key.prefix, revokedAt: key.revokedAt }
  const revokedAt = args.now ?? Date.now()
  await ctx.db.patch(args.keyId, { revokedAt })
  await writeAuditForWorkspaceIds(ctx, {
    workspaceIds: (await liveWorkspaceMemberships(ctx, args.actorId)).map(
      ({ workspace }) => workspace._id,
    ),
    event: 'api_key.revoked',
    actorId: args.actorId,
    provenance: { prefix: key.prefix },
    at: revokedAt,
  })
  return { prefix: key.prefix, revokedAt }
}
