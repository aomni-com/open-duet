import { ConvexError, v } from 'convex/values'

import {
  AppApiScopesSchema,
  AppCredentialExpirationSchema,
  MAX_EXPORTED_APP_CREDENTIALS,
  scopeSetSatisfies,
  serializeScope,
  type AppCredentialExpiration,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { resolveCredential } from './authenticate'
import {
  issueWorkspaceCredential,
  liveExportedAppKeys,
  requireApiInternalKey,
  revokeExportedAppKey,
} from './model'

const targetArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  appSlug: v.string(),
  caller: v.object({ hashedKey: v.string(), keyPrefix: v.string() }),
}
type TargetArgs = {
  workspaceId: Id<'workspaces'>
  appSlug: string
  caller: { hashedKey: string; keyPrefix: string }
  now: number
}

function refuse(status: number, code: string, extra = {}): never {
  throw new ConvexError({ status, code, ...extra })
}

async function authorize(ctx: QueryCtx, args: TargetArgs, manages: boolean) {
  const resolved = await resolveCredential(ctx, { ...args.caller, now: args.now })
  if (!resolved.ok) refuse(401, 'unauthorized')
  const workspace = resolved.auth.workspaces.find(row => row.id === args.workspaceId)
  if (workspace === undefined) refuse(404, 'not_found')
  const scope = `ws:${workspace.slug}:apps`
  if (!scopeSetSatisfies(resolved.auth.scopes, scope) || (manages && workspace.role === 'viewer')) {
    refuse(403, 'insufficient_scope', { scope })
  }
  const app = await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_slug', q =>
      q.eq('workspaceId', args.workspaceId).eq('slug', args.appSlug),
    )
    .unique()
  if (app === null) refuse(404, 'not_found')
  return { app, actorId: resolved.auth.user.id }
}

function metadata(key: Doc<'apiKeys'>) {
  return {
    credentialId: key._id,
    prefix: key.prefix,
    createdAt: key._creationTime,
    expiresAt: key.expiresAt ?? null,
  }
}

export async function exportCredentialImpl(
  ctx: MutationCtx,
  args: TargetArgs & { expiration: AppCredentialExpiration },
) {
  const { app, actorId } = await authorize(ctx, args, true)
  const parsed = AppCredentialExpirationSchema.safeParse(args.expiration)
  if (!parsed.success) refuse(400, 'invalid_request')
  const expiresAt = parsed.data === 'never' ? undefined : args.now + parsed.data.seconds * 1000
  if (expiresAt !== undefined && !Number.isSafeInteger(expiresAt)) refuse(400, 'invalid_request')
  if (app.disabledAt !== undefined) refuse(409, 'app_disabled')
  const declarations = AppApiScopesSchema.safeParse(app.apiScopes)
  if (!declarations.success || declarations.data.length === 0) refuse(409, 'app_has_no_api_scopes')
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) refuse(404, 'not_found')
  if ((await liveExportedAppKeys(ctx, app._id, args.now)).length >= MAX_EXPORTED_APP_CREDENTIALS) {
    refuse(409, 'app_credential_limit', { limit: MAX_EXPORTED_APP_CREDENTIALS })
  }
  const issued = await issueWorkspaceCredential(ctx, {
    kind: 'app',
    app,
    workspace,
    appKeyPurpose: 'exported',
    auditActorId: actorId,
    scopes: declarations.data.map(capability =>
      serializeScope({ workspaceSlug: workspace.slug, capability }),
    ),
    expiresAt,
    now: args.now,
    event: 'api_key.app_key_minted',
  })
  return { ...metadata((await ctx.db.get(issued.keyId))!), key: issued.key }
}

export async function listCredentialsImpl(ctx: QueryCtx, args: TargetArgs) {
  const { app } = await authorize(ctx, args, false)
  const keys = await liveExportedAppKeys(ctx, app._id, args.now)
  keys.sort((a, b) => b._creationTime - a._creationTime || b._id.localeCompare(a._id))
  return { items: keys.map(metadata), nextCursor: null }
}

export async function revokeCredentialImpl(
  ctx: MutationCtx,
  args: TargetArgs & { credentialId: string },
) {
  const { app, actorId } = await authorize(ctx, args, true)
  const id = ctx.db.normalizeId('apiKeys', args.credentialId)
  const key = id === null ? null : await ctx.db.get(id)
  if (key === null) return { ok: true as const }
  if (
    key.kind !== 'app' ||
    key.appKeyPurpose !== 'exported' ||
    key.appId !== app._id ||
    key.workspaceIds.length !== 1 ||
    key.workspaceIds[0] !== args.workspaceId
  )
    refuse(404, 'not_found')
  await revokeExportedAppKey(ctx, { app, key, actorId, now: args.now })
  return { ok: true as const }
}

export const exportCredential = mutation({
  args: {
    ...targetArgs,
    expiration: v.union(v.literal('never'), v.object({ seconds: v.number() })),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await exportCredentialImpl(ctx, { ...args, now: Date.now() })
  },
})
export const listCredentials = query({
  args: targetArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await listCredentialsImpl(ctx, { ...args, now: Date.now() })
  },
})
export const revokeCredential = mutation({
  args: { ...targetArgs, credentialId: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await revokeCredentialImpl(ctx, { ...args, now: Date.now() })
  },
})
