import { paginationOptsValidator, type GenericMutationCtx } from 'convex/server'
import { v } from 'convex/values'

import {
  CapabilityListSchema,
  OAuthClientStorageSchema,
  OAuthGrantStorageMetadataSchema,
  OAuthAuthorizationStateSchema,
  assertSingleWorkspaceScopes,
  serializeScope,
  type Capability,
} from '@repo/contract'

import type { DataModel, Doc } from '../../_generated/dataModel'
import { mutation, query } from '../../_generated/server'
import {
  generateApiKey,
  grantableWorkspacesForCapabilities,
  hashSecret,
  keyPrefix,
  requireApiInternalKey,
} from '../apiKeys/model'
import { insertApiKey } from '../apiKeys/storage'
import { transitionRefreshFamily } from './refresh'

type MutationCtx = GenericMutationCtx<DataModel>

export const AUTHORIZATION_CODE_TTL_MS = 60_000
export const AUTHORIZATION_REQUEST_TTL_MS = 5 * 60 * 1000
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const registerDynamicClient = mutation({
  args: {
    internalKey: v.string(),
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.literal('none'),
    source: v.literal('dcr'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const client = OAuthClientStorageSchema.parse({
      clientId: args.clientId,
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      source: args.source,
    })
    const existing = await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', q => q.eq('clientId', args.clientId))
      .unique()
    if (existing !== null) throw new Error('OAuth client id already exists')
    await ctx.db.insert('oauthClients', {
      ...client,
      createdAt: args.now,
    })
    return client
  },
})

export const getCachedClient = query({
  args: {
    internalKey: v.string(),
    clientId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const client = await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', q => q.eq('clientId', args.clientId))
      .unique()
    if (client === null) return null
    return normalizedClient(client)
  },
})

export const createAuthorizationRequest = mutation({
  args: {
    internalKey: v.string(),
    clientId: v.string(),
    clientName: v.string(),
    redirectUri: v.string(),
    state: v.optional(v.string()),
    capabilities: v.array(v.string()),
    resource: v.string(),
    codeChallenge: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const capabilities = normalizeCapabilities(args.capabilities)

    return await ctx.db.insert('oauthAuthorizationRequests', {
      clientId: args.clientId,
      clientName: args.clientName,
      redirectUri: args.redirectUri,
      state: args.state === undefined ? undefined : OAuthAuthorizationStateSchema.parse(args.state),
      capabilities,
      resource: args.resource,
      codeChallenge: args.codeChallenge,
      status: 'pending',
      expiresAt: args.now + AUTHORIZATION_REQUEST_TTL_MS,
      createdAt: args.now,
    })
  },
})

export const inspectAuthorization = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    requestId: v.id('oauthAuthorizationRequests'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const request = await ctx.db.get(args.requestId)
    if (request === null) throw new Error('Authorization request not found')
    const capabilities = normalizeCapabilities(request.capabilities)
    const workspaces = await grantableWorkspacesForCapabilities(ctx, args.actorId, capabilities)
    const redirect = new URL(request.redirectUri)
    return {
      status: request.expiresAt <= args.now ? ('expired' as const) : request.status,
      client: { id: request.clientId, name: request.clientName },
      redirect: {
        hostname: redirect.hostname,
        localhost: isLocalhost(redirect.hostname),
      },
      capabilities,
      workspaces: workspaces.map(workspace => ({
        slug: workspace.slug,
        name: workspace.name,
        role: workspace.role,
      })),
      expiresAt: request.expiresAt,
    }
  },
})

export const approveAuthorization = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    requestId: v.id('oauthAuthorizationRequests'),
    workspaceSlug: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const request = await ctx.db.get(args.requestId)
    if (request === null) throw new Error('Authorization request not found')
    if (request.expiresAt <= args.now) throw new Error('Authorization request expired')
    if (request.status !== 'pending') throw new Error('Authorization request is not pending')

    const capabilities = normalizeCapabilities(request.capabilities)
    const eligible = await grantableWorkspacesForCapabilities(ctx, args.actorId, capabilities)
    const workspace = eligible.find(candidate => candidate.slug === args.workspaceSlug)
    if (workspace === undefined) throw new Error('Workspace is not eligible for authorization')
    const scopes = capabilities.map(capability =>
      serializeScope({ workspaceSlug: workspace.slug, capability }),
    )
    assertSingleWorkspaceScopes(scopes)

    const code = opaqueSecret('duet_ac_')
    await ctx.db.insert('oauthAuthorizationCodes', {
      hashedCode: await hashSecret(code),
      requestId: request._id,
      userId: args.actorId,
      workspaceId: workspace.workspaceId,
      scopes,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      challenge: request.codeChallenge,
      expiresAt: args.now + AUTHORIZATION_CODE_TTL_MS,
    })
    await ctx.db.patch(request._id, {
      status: 'approved',
      userId: args.actorId,
      workspaceId: workspace.workspaceId,
    })

    const redirect = new URL(request.redirectUri)
    redirect.searchParams.set('code', code)
    if (request.state !== undefined) redirect.searchParams.set('state', request.state)
    return { redirectUrl: redirect.toString() }
  },
})

export const denyAuthorization = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    requestId: v.id('oauthAuthorizationRequests'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const request = await ctx.db.get(args.requestId)
    if (request === null) throw new Error('Authorization request not found')
    if (request.expiresAt <= args.now) throw new Error('Authorization request expired')
    if (request.status !== 'pending') throw new Error('Authorization request is not pending')
    await ctx.db.patch(request._id, {
      status: 'denied',
      userId: args.actorId,
    })
    const redirect = new URL(request.redirectUri)
    redirect.searchParams.set('error', 'access_denied')
    if (request.state !== undefined) redirect.searchParams.set('state', request.state)
    return { redirectUrl: redirect.toString() }
  },
})

export const exchangeAuthorizationCode = mutation({
  args: {
    internalKey: v.string(),
    code: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    resource: v.string(),
    codeVerifier: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const hashedCode = await hashSecret(args.code)
    const code = await ctx.db
      .query('oauthAuthorizationCodes')
      .withIndex('by_hashedCode', q => q.eq('hashedCode', hashedCode))
      .unique()
    return await exchangeCode(ctx, code, args)
  },
})

export const rotateRefreshToken = mutation({
  args: {
    internalKey: v.string(),
    refreshToken: v.string(),
    clientId: v.string(),
    resource: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const hashedToken = await hashSecret(args.refreshToken)
    const presented = await ctx.db
      .query('oauthRefreshTokens')
      .withIndex('by_hashedToken', q => q.eq('hashedToken', hashedToken))
      .unique()
    if (presented === null) return invalidRefresh()
    const grant = await ctx.db.get(presented.grantId)
    if (
      grant === null ||
      grant.revokedAt !== undefined ||
      grant.clientId !== args.clientId ||
      grant.audience !== args.resource
    ) {
      return invalidRefresh()
    }
    const head = await ctx.db
      .query('oauthRefreshTokens')
      .withIndex('by_grantId_supersededAt', q =>
        q.eq('grantId', grant._id).eq('supersededAt', undefined),
      )
      .unique()
    if (head === null) {
      await revokeFamily(ctx, grant, args.now)
      return invalidRefresh()
    }
    // Grace re-rotation retains the discarded successor hash only so it
    // remains invalid. The 05B state machine removed it from lineage, so
    // presenting that same-generation row is not ancestor reuse and must not
    // revoke the replacement family.
    if (presented.generation === grant.generation && presented._id !== head._id) {
      return invalidRefresh()
    }
    if (presented.expiresAt <= args.now) {
      await revokeFamily(ctx, grant, args.now)
      return invalidRefresh()
    }
    const transition = transitionRefreshFamily(
      {
        generation: grant.generation,
        headHash: head.hashedToken,
        predecessorHash:
          presented.generation === grant.generation - 1 ? presented.hashedToken : undefined,
        predecessorGraceUntil:
          presented.generation === grant.generation - 1 ? presented.graceUntil : undefined,
      },
      hashedToken,
      args.now,
    )
    if (transition.outcome === 'familyRevoked') {
      await revokeFamily(ctx, grant, args.now)
      return invalidRefresh()
    }

    if (transition.outcome === 'rotated') {
      await ctx.db.patch(head._id, {
        supersededAt: args.now,
        graceUntil: transition.predecessorGraceUntil,
      })
      await ctx.db.patch(grant._id, { generation: transition.generation })
      return await mintPair(ctx, grant, transition.generation, args.now)
    }

    const replacedAccess = await ctx.db.get(head.accessKeyId)
    await ctx.db.patch(head._id, { supersededAt: args.now })
    if (replacedAccess !== null && replacedAccess.revokedAt === undefined) {
      await ctx.db.patch(replacedAccess._id, { revokedAt: args.now })
    }
    return await mintPair(ctx, grant, grant.generation, args.now, {
      accessExpiresAt: replacedAccess?.expiresAt ?? args.now + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: head.expiresAt,
    })
  },
})

/** Fence every OAuth artifact owned by an identity before anonymization. */
export async function fenceUserOAuth(
  ctx: MutationCtx,
  args: { userId: Doc<'users'>['_id']; now: number },
): Promise<void> {
  const requests = await ctx.db.query('oauthAuthorizationRequests').take(1001)
  if (requests.length > 1000) throw new Error('Too many OAuth authorization requests to retire')
  for (const request of requests) {
    if (request.userId === args.userId && request.status !== 'denied')
      await ctx.db.patch(request._id, { status: 'denied' })
  }
  const codes = await ctx.db.query('oauthAuthorizationCodes').take(1001)
  if (codes.length > 1000) throw new Error('Too many OAuth authorization codes to retire')
  for (const code of codes) {
    if (code.userId === args.userId && code.consumedAt === undefined)
      await ctx.db.patch(code._id, { consumedAt: args.now })
  }
  const grants = await ctx.db
    .query('oauthGrants')
    .withIndex('by_user_created', q => q.eq('userId', args.userId))
    .take(1001)
  if (grants.length > 1000) throw new Error('Too many OAuth grants to retire')
  for (const grant of grants) {
    if (grant.revokedAt === undefined) await ctx.db.patch(grant._id, { revokedAt: args.now })
    const accessKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_oauthGrantId', q => q.eq('oauthGrantId', grant._id))
      .take(1001)
    if (accessKeys.length > 1000) throw new Error('OAuth grant has too many access keys to retire')
    for (const key of accessKeys) {
      if (key.revokedAt === undefined) await ctx.db.patch(key._id, { revokedAt: args.now })
    }
  }
}

export const revokeGrant = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    grantId: v.id('oauthGrants'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const grant = await ctx.db.get(args.grantId)
    if (grant === null || grant.userId !== args.actorId) throw new Error('OAuth grant not found')
    if (grant.revokedAt === undefined) await ctx.db.patch(grant._id, { revokedAt: args.now })
    return { grantId: grant._id, revokedAt: grant.revokedAt ?? args.now }
  },
})

export const listGrants = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const grants = await ctx.db
      .query('oauthGrants')
      .withIndex('by_user_created_id', q => q.eq('userId', args.actorId))
      .order('desc')
      .paginate(args.paginationOpts)
    return {
      ...grants,
      page: grants.page.map(grant => ({
        id: grant._id,
        client: { id: grant.clientId, name: grant.clientName },
        redirectHost: grant.redirectHost,
        workspace: {
          id: grant.workspaceId,
          slug: grant.workspaceSlug,
          name: grant.workspaceName,
        },
        capabilities: grant.capabilities,
        scopes: grant.scopes,
        audience: grant.audience,
        generation: grant.generation,
        createdAt: grant.createdAt,
        revokedAt: grant.revokedAt,
      })),
    }
  },
})

async function exchangeCode(
  ctx: MutationCtx,
  code: Doc<'oauthAuthorizationCodes'> | null,
  args: {
    clientId: string
    redirectUri: string
    resource: string
    codeVerifier: string
    now: number
  },
) {
  if (
    code === null ||
    code.consumedAt !== undefined ||
    code.expiresAt <= args.now ||
    code.clientId !== args.clientId ||
    code.redirectUri !== args.redirectUri ||
    code.resource !== args.resource ||
    code.challenge !== (await pkceChallenge(args.codeVerifier))
  ) {
    throw new Error('Invalid authorization code')
  }
  await ctx.db.patch(code._id, { consumedAt: args.now })
  const request = await ctx.db.get(code.requestId)
  if (request === null) throw new Error('Invalid authorization code')
  const workspace = await ctx.db.get(code.workspaceId)
  if (workspace === null) throw new Error('Invalid authorization code')
  const grantMetadata = OAuthGrantStorageMetadataSchema.parse({
    clientId: code.clientId,
    clientName: request.clientName,
    redirectHost: new URL(request.redirectUri).hostname,
    capabilities: request.capabilities,
    scopes: code.scopes,
    audience: code.resource,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
  })
  const grantId = await ctx.db.insert('oauthGrants', {
    userId: code.userId,
    workspaceId: code.workspaceId,
    ...grantMetadata,
    generation: 1,
    createdAt: args.now,
  })
  await ctx.db.patch(grantId, { paginationId: grantId })
  const grant = await ctx.db.get(grantId)
  if (grant === null) throw new Error('Failed to create OAuth grant')
  return await mintPair(ctx, grant, 1, args.now)
}

async function mintPair(
  ctx: MutationCtx,
  grant: Doc<'oauthGrants'>,
  generation: number,
  now: number,
  deadlines?: { accessExpiresAt: number; refreshExpiresAt: number },
) {
  const accessToken = generateApiKey()
  const refreshToken = opaqueSecret('duet_rt_')
  const accessExpiresAt = deadlines?.accessExpiresAt ?? now + ACCESS_TOKEN_TTL_MS
  const refreshExpiresAt = deadlines?.refreshExpiresAt ?? now + REFRESH_TOKEN_TTL_MS
  const accessKeyId = await insertApiKey(ctx, {
    kind: 'oauth',
    userId: grant.userId,
    hashedKey: await hashSecret(accessToken),
    prefix: keyPrefix(accessToken),
    scopes: grant.scopes,
    workspaceIds: [grant.workspaceId],
    oauthGrantId: grant._id,
    audience: grant.audience,
    expiresAt: accessExpiresAt,
  })
  await ctx.db.insert('oauthRefreshTokens', {
    hashedToken: await hashSecret(refreshToken),
    grantId: grant._id,
    accessKeyId,
    generation,
    expiresAt: refreshExpiresAt,
  })
  return {
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: Math.max(1, Math.ceil((accessExpiresAt - now) / 1000)),
    refresh_token: refreshToken,
    scope: grant.capabilities.join(' '),
  }
}

async function revokeFamily(
  ctx: MutationCtx,
  grant: Doc<'oauthGrants'>,
  now: number,
): Promise<void> {
  if (grant.revokedAt === undefined) await ctx.db.patch(grant._id, { revokedAt: now })
}

// OAuth grants are membership-backed, so the whole capability vocabulary is
// requestable here and `roleCanGrant` (through grantableWorkspacesForCapabilities)
// is the ceiling: only an owner ever gets a workspace back for `members` or
// `admin`. The app-declaration grammar (AppApiScopesSchema) is a different
// vocabulary and is deliberately not borrowed.
function normalizeCapabilities(values: string[]): Capability[] {
  const capabilities = CapabilityListSchema.parse(values)
  if (capabilities.length === 0) throw new Error('Invalid OAuth capabilities')
  return capabilities
}

function normalizedClient(client: {
  clientId: string
  clientName: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none'
  source: 'dcr'
}) {
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    source: client.source,
  }
}

function opaqueSecret(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
}

function invalidRefresh() {
  return { ok: false as const, reason: 'invalid_grant' as const }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  )
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let result = ''
  for (let index = 0; index < digest.length; index += 3) {
    const value =
      (digest[index]! << 16) | ((digest[index + 1] ?? 0) << 8) | (digest[index + 2] ?? 0)
    result += alphabet[(value >> 18) & 63]
    result += alphabet[(value >> 12) & 63]
    if (index + 1 < digest.length) result += alphabet[(value >> 6) & 63]
    if (index + 2 < digest.length) result += alphabet[value & 63]
  }
  return result
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.startsWith('127.') ||
    normalized === '::1'
  )
}
