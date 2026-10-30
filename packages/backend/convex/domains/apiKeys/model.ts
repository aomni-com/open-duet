import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import {
  API_VERSION,
  AppApiScopesSchema,
  MAX_EXPORTED_APP_CREDENTIALS,
  CAPABILITIES,
  DUET_API_KEY_PREFIX,
  type Capability,
  type AuditEventName,
  type WorkspaceScope,
  assertSingleWorkspaceScopes,
  generateHumanEntryCode,
  hashApiKey,
  parseScope,
  serializeScope,
  type WorkspaceRole,
  canonicalizeApiKeyScopes,
} from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { writeAuditEvent } from '../audit/model'
import { starterAgentsForUserImpl, type CampaignLookup } from '../campaigns/starterAgents'
import { isLiveWorkspace } from '../workspaces/authorization'
import {
  newPayerMemo,
  workspaceSummary,
  type WorkspaceSummaryProjection,
} from '../workspaces/summary'
import { insertApiKey } from './storage'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type ScopedApiKey = Extract<Doc<'apiKeys'>, { scopes: string[] }>

export const KEY_PREFIX = DUET_API_KEY_PREFIX
export const KEY_DISPLAY_RANDOM_CHARS = 8
export const VM_MODEL_KEY_EXPIRES_MS = 24 * 60 * 60 * 1000
export const MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE = 100
export const APP_KEY_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000
export const APP_KEY_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000
export const DEVICE_CODE_EXPIRES_IN_SECONDS = 15 * 60
export const DEVICE_POLL_INTERVAL_SECONDS = 5
const VIEWER_CAPABILITIES = ['files:read', 'memory', 'sessions', 'apps', 'agents'] as const
const EDITOR_CAPABILITIES = ['files:write', 'services', 'integrations', 'share', 'publish'] as const
const HUMAN_WORKSPACE_LIMIT = 100
const HUMAN_MEMBERSHIP_SCAN_LIMIT = 1000

export interface AuthorizedApiKey {
  user: { id: Id<'users'>; email: string; name?: string }
  workspaces: WorkspaceSummaryProjection[]
  scopes: string[]
  versions: typeof API_VERSION
}

export interface VmModelKeyResult {
  key: string | null
  keyId: Id<'apiKeys'>
  prefix: string
  scopes: string[]
  expiresAt: number
  minted: boolean
}

export interface AppKeyResult extends VmModelKeyResult {}

export function requireApiInternalKey(provided: string): void {
  const expected = process.env.DUET_API_INTERNAL_KEY
  if (!expected || provided !== expected) throw new Error('Unauthorized API internal key')
}

export async function hashSecret(secret: string): Promise<string> {
  return await hashApiKey(secret)
}

export function keyPrefix(fullKey: string): string {
  return fullKey.slice(0, KEY_PREFIX.length + KEY_DISPLAY_RANDOM_CHARS)
}

export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomHex(32)}`
}

export function grantableScopesForWorkspaceRole(
  workspaceSlug: string,
  role: WorkspaceRole,
): string[] {
  return CAPABILITIES.filter(capability => roleCanGrant(role, capability)).map(capability =>
    serializeScope({ workspaceSlug, capability }),
  )
}

export async function grantableWorkspacesForCapabilities(
  ctx: QueryCtx | MutationCtx,
  actorId: Id<'users'>,
  capabilities: readonly Capability[],
): Promise<
  Array<{
    workspaceId: Id<'workspaces'>
    slug: string
    name: string
    role: WorkspaceRole
  }>
> {
  return (await liveWorkspaceMemberships(ctx, actorId))
    .filter(({ membership }) =>
      capabilities.every(capability => roleCanGrant(membership.role, capability)),
    )
    .map(({ membership, workspace }) => ({
      workspaceId: workspace._id,
      slug: workspace.slug,
      name: workspace.name,
      role: membership.role,
    }))
}

export function generateDeviceCode(): string {
  return randomHex(32)
}

export function generateUserCode(): string {
  return generateHumanEntryCode()
}

export function normalizeUserCode(code: string): string {
  return code.trim().toUpperCase()
}

export function parseScopeList(scopes: string[]): WorkspaceScope[] {
  assertSingleWorkspaceScopes(scopes)
  const parsed = scopes.map(scope => {
    const result = parseScope(scope)
    if (result === null) throw new Error(`Invalid scope: ${scope}`)
    return result
  })
  return parsed
}

export async function workspaceIdsForScopes(
  ctx: QueryCtx | MutationCtx,
  scopes: string[],
): Promise<Array<Id<'workspaces'>>> {
  const parsed = parseScopeList(scopes)
  const ids: Array<Id<'workspaces'>> = []
  const seen = new Set<string>()
  for (const scope of parsed) {
    const workspace = await liveWorkspaceBySlug(ctx, scope.workspaceSlug)
    if (workspace === null) throw new Error(`Unknown workspace: ${scope.workspaceSlug}`)
    if (seen.has(workspace._id)) continue
    seen.add(workspace._id)
    ids.push(workspace._id)
  }
  return ids
}

export async function writeAuditForWorkspaceIds(
  ctx: MutationCtx,
  args: {
    workspaceIds: Array<Id<'workspaces'>>
    event: AuditEventName
    actorId: Id<'users'>
    provenance?: unknown
    at?: number
  },
): Promise<void> {
  for (const workspaceId of args.workspaceIds) {
    await writeAuditEvent(ctx, {
      workspaceId,
      event: args.event,
      actorId: args.actorId,
      provenance: args.provenance,
      at: args.at,
    })
  }
}

export async function authorizedApiKeyPayload(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  scopes: string[],
  workspaceIds?: Array<Id<'workspaces'>>,
): Promise<AuthorizedApiKey> {
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('User not found')
  const now = Date.now()
  const payers = newPayerMemo()
  const originalWorkspaceIds = workspaceIds === undefined ? null : new Set<string>(workspaceIds)
  const validScopes: string[] = []
  const workspaces: AuthorizedApiKey['workspaces'] = []
  const seenWorkspaces = new Set<string>()
  for (const scope of parseScopeList(scopes)) {
    const workspace = await liveWorkspaceBySlug(ctx, scope.workspaceSlug)
    if (workspace === null) continue
    if (originalWorkspaceIds !== null && !originalWorkspaceIds.has(workspace._id)) continue
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', workspace._id).eq('userId', userId),
      )
      .unique()
    if (membership === null) continue
    if (!roleCanGrant(membership.role, scope.capability)) continue
    validScopes.push(
      serializeScope({ workspaceSlug: workspace.slug, capability: scope.capability }),
    )
    if (seenWorkspaces.has(workspace._id)) continue
    seenWorkspaces.add(workspace._id)
    workspaces.push(await workspaceSummary(ctx, { workspace, role: membership.role, now, payers }))
  }
  return {
    user: {
      id: user._id,
      email: user.email,
      ...(user.name === undefined ? {} : { name: user.name }),
    },
    workspaces,
    scopes: validScopes,
    versions: API_VERSION,
  }
}

export async function authorizedSystemVmKeyPayload(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  scopes: string[],
  workspaceIds: Array<Id<'workspaces'>>,
): Promise<AuthorizedApiKey> {
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('User not found')
  const now = Date.now()
  const payers = newPayerMemo()
  const allowedWorkspaceIds = new Set<string>(workspaceIds)
  const validScopes: string[] = []
  const workspaces: AuthorizedApiKey['workspaces'] = []
  const seenWorkspaces = new Set<string>()
  for (const scope of parseScopeList(scopes)) {
    const workspace = await liveWorkspaceBySlug(ctx, scope.workspaceSlug)
    if (workspace === null || !allowedWorkspaceIds.has(workspace._id)) continue
    validScopes.push(
      serializeScope({ workspaceSlug: workspace.slug, capability: scope.capability }),
    )
    if (seenWorkspaces.has(workspace._id)) continue
    seenWorkspaces.add(workspace._id)
    // A system VM key has no membership row to read a role from; it acts for
    // the workspace itself, at editor's ceiling.
    workspaces.push(await workspaceSummary(ctx, { workspace, role: 'editor', now, payers }))
  }
  return {
    user: {
      id: user._id,
      email: user.email,
      ...(user.name === undefined ? {} : { name: user.name }),
    },
    workspaces,
    scopes: validScopes,
    versions: API_VERSION,
  }
}

export async function authorizedAppKeyPayload(
  ctx: QueryCtx | MutationCtx,
  key: Pick<
    Extract<Doc<'apiKeys'>, { scopes: string[] }>,
    'appId' | 'userId' | 'scopes' | 'workspaceIds'
  >,
): Promise<(AuthorizedApiKey & { app: { id: Id<'apps'>; slug: string } }) | null> {
  if (key.appId === undefined || key.workspaceIds.length !== 1) return null
  const app = await ctx.db.get(key.appId)
  if (app === null || app.disabledAt !== undefined || app.workspaceId !== key.workspaceIds[0]) {
    return null
  }
  const workspace = await ctx.db.get(app.workspaceId)
  if (workspace === null) return null
  if (key.userId !== vmModelKeyActor(workspace)) return null
  const declaration = AppApiScopesSchema.safeParse(app.apiScopes)
  if (!declaration.success) return null
  const declaredScopes = declaration.data.map(capability =>
    serializeScope({ workspaceSlug: workspace.slug, capability }),
  )
  if (!sameScopeSet(key.scopes, declaredScopes)) return null
  return {
    ...(await authorizedSystemVmKeyPayload(ctx, key.userId, key.scopes, key.workspaceIds)),
    app: { id: app._id, slug: app.slug },
  }
}

export async function authorizedHumanPayload(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  extras?: { starterAgents: Awaited<ReturnType<typeof starterAgentsForUserImpl>> },
): Promise<AuthorizedApiKey> {
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('User not found')
  const now = Date.now()
  const payers = newPayerMemo()
  const workspaces: AuthorizedApiKey['workspaces'] = []
  const scopes: string[] = []
  const memberships = await liveWorkspaceMemberships(ctx, userId)
  for (const { membership, workspace } of memberships) {
    workspaces.push(
      await workspaceSummary(ctx, {
        workspace,
        role: membership.role,
        now,
        payers,
        extras:
          extras !== undefined && membership.role === 'owner' && workspace.onboardedAt === undefined
            ? { onboarding: { starterAgents: extras.starterAgents } }
            : undefined,
      }),
    )
    scopes.push(...grantableScopesForWorkspaceRole(workspace.slug, membership.role))
  }
  return {
    user: {
      id: user._id,
      email: user.email,
      ...(user.name === undefined ? {} : { name: user.name }),
    },
    workspaces,
    scopes,
    versions: API_VERSION,
  }
}

export async function authorizedBrowserSessionPayload(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  campaignLookup?: CampaignLookup,
): Promise<AuthorizedApiKey> {
  return await authorizedHumanPayload(ctx, userId, {
    starterAgents: await starterAgentsForUserImpl(ctx, userId, campaignLookup),
  })
}

export async function liveWorkspaceMemberships(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
): Promise<
  Array<{
    membership: Doc<'workspaceMembers'>
    workspace: Doc<'workspaces'>
  }>
> {
  const memberships = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_user_and_workspace', q => q.eq('userId', userId))
    .take(HUMAN_MEMBERSHIP_SCAN_LIMIT + 1)
  if (memberships.length > HUMAN_MEMBERSHIP_SCAN_LIMIT) {
    throw new Error(
      `Human authentication supports at most ${HUMAN_MEMBERSHIP_SCAN_LIMIT} historical memberships`,
    )
  }
  const joined = await Promise.all(
    memberships.map(async membership => ({
      membership,
      workspace: await ctx.db.get(membership.workspaceId),
    })),
  )
  const live = joined.flatMap(({ membership, workspace }) =>
    workspace !== null && isLiveWorkspace(workspace.status) ? [{ membership, workspace }] : [],
  )
  if (live.length > HUMAN_WORKSPACE_LIMIT) {
    throw new Error(
      `Human authentication supports at most ${HUMAN_WORKSPACE_LIMIT} live workspaces`,
    )
  }
  return live
}

export async function mintVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
): Promise<VmModelKeyResult | null> {
  const workspace = await requireVmModelKeyWorkspace(ctx, args.workspaceId)
  const existing = await liveVmModelKeyForWorkspace(ctx, args.workspaceId, args.now)
  const currentScopes = vmModelScopes(workspace.slug)
  const reusable = reusableManagedKey(existing, currentScopes, args.now)
  if (reusable !== null) return reusable
  // A live key with a stale scope set must not be reused: the VM would keep a
  // credential the current product contract has outgrown until natural expiry.
  if (existing !== null) {
    return await rotateVmModelKeyForWorkspace(ctx, {
      workspaceId: args.workspaceId,
      now: args.now,
    })
  }

  return await reissueVmModelKeyForWorkspace(ctx, {
    workspaceId: args.workspaceId,
    now: args.now,
    event: 'api_key.vm_model_key_minted',
    preservesLiveKeys: true,
  })
}

/**
 * Issue the workspace's next VM model key, retiring the keys it replaces.
 *
 * `preservesLiveKeys` is the entire difference between the two callers below, and
 * it is a trust decision rather than a detail. A rotation treats the outgoing
 * credential as no longer trustworthy and kills it now. A refresh treats it as
 * still trusted and lets it run out its own clock, because the VM asks
 * `VM_MODEL_CREDENTIAL_REFRESH_WINDOW_MS` early precisely so the handover can
 * overlap: an agent runner bakes `DUET_API_KEY` into its env at spawn and holds
 * it for the whole turn. Revoking on delivery collapsed that overlap to zero
 * and 401'd every model call of a turn already in flight — the end-of-turn
 * memory pass was the only caller that reported it out loud.
 *
 * A refresh response can be lost, so every still-live key remains plausible:
 * the VM may hold an older one while a running agent holds another in its env.
 * Refresh therefore retires only naturally expired keys. Issuance stops at a
 * hard per-workspace ceiling, keeping the indexed set bounded without guessing
 * which live credential is safe to revoke. Reaching that ceiling is a normal
 * retry outcome, not an exception: returning `null` lets the enclosing VM sync
 * commit its heartbeat and reconciliation reports while natural expiry makes
 * room for a later delivery.
 */
async function reissueVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    now: number
    event: AuditEventName
    preservesLiveKeys: false
  },
): Promise<VmModelKeyResult>
async function reissueVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    now: number
    event: AuditEventName
    preservesLiveKeys: true
  },
): Promise<VmModelKeyResult | null>
async function reissueVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    now: number
    event: AuditEventName
    preservesLiveKeys: boolean
  },
): Promise<VmModelKeyResult | null> {
  const workspace = await requireVmModelKeyWorkspace(ctx, args.workspaceId)
  const unrevoked = await unrevokedVmModelKeysForWorkspace(ctx, args.workspaceId)
  const live = unrevoked.filter(key => (key.expiresAt ?? 0) > args.now)
  const retired = args.preservesLiveKeys
    ? unrevoked.filter(key => (key.expiresAt ?? 0) <= args.now)
    : unrevoked
  await revokeManagedKeys(ctx, retired, args.now)

  if (args.preservesLiveKeys && live.length >= MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE) {
    return null
  }

  return await issueManagedWorkspaceKey(ctx, {
    kind: 'system_vm',
    workspace,
    scopes: vmModelScopes(workspace.slug),
    expiresMs: VM_MODEL_KEY_EXPIRES_MS,
    now: args.now,
    event: args.event,
    oldPrefixes: retired.map(key => key.prefix),
  })
}

/** Replace the workspace's VM model keys, trusting none of them afterwards. */
export async function rotateVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
): Promise<VmModelKeyResult> {
  const rotated = await reissueVmModelKeyForWorkspace(ctx, {
    ...args,
    event: 'api_key.vm_model_key_rotated',
    preservesLiveKeys: false,
  })
  const workspace = await ctx.db.get(args.workspaceId)
  if (
    workspace?.vmModelCredentialRetryAt !== undefined ||
    workspace?.vmModelCredentialRetryScopeKey !== undefined
  ) {
    await ctx.db.patch(args.workspaceId, {
      vmModelCredentialRetryAt: undefined,
      vmModelCredentialRetryScopeKey: undefined,
    })
  }
  return rotated
}

/** Hand the VM a fresh key without killing the one it is still using. */
export async function supersedeVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
): Promise<VmModelKeyResult | null> {
  return await reissueVmModelKeyForWorkspace(ctx, {
    ...args,
    event: 'api_key.vm_model_key_superseded',
    preservesLiveKeys: true,
  })
}

export async function mintAppKeyForApp(
  ctx: MutationCtx,
  args: { appId: Id<'apps'>; now: number },
): Promise<AppKeyResult | null> {
  const { app, workspace, scopes } = await requireAppKeyTarget(ctx, args.appId)
  const unrevoked = await unrevokedManagedAppKeysForApp(ctx, app._id)
  const existing =
    unrevoked.find(key => key.expiresAt !== undefined && key.expiresAt > args.now) ?? null
  if (scopes.length === 0) {
    await revokeAppKeysForApp(ctx, { app, now: args.now })
    return null
  }
  const reusable = reusableManagedKey(existing, scopes, args.now, APP_KEY_REFRESH_WINDOW_MS)
  if (reusable !== null) return reusable
  if (existing !== null) return await rotateAppKeyForApp(ctx, args)
  if (unrevoked.length > 0) return await rotateAppKeyForApp(ctx, args)
  return await issueManagedWorkspaceKey(ctx, {
    kind: 'app',
    app,
    workspace,
    scopes,
    expiresMs: APP_KEY_EXPIRES_MS,
    now: args.now,
    event: 'api_key.app_key_minted',
  })
}

export async function rotateAppKeyForApp(
  ctx: MutationCtx,
  args: { appId: Id<'apps'>; now: number },
): Promise<AppKeyResult | null> {
  const { app, workspace, scopes } = await requireAppKeyTarget(ctx, args.appId)
  const oldKeys = await unrevokedManagedAppKeysForApp(ctx, app._id)
  await revokeManagedKeys(ctx, oldKeys, args.now)
  if (scopes.length === 0) return null
  return await issueManagedWorkspaceKey(ctx, {
    kind: 'app',
    app,
    workspace,
    scopes,
    expiresMs: APP_KEY_EXPIRES_MS,
    now: args.now,
    event: 'api_key.app_key_rotated',
    oldPrefixes: oldKeys.map(key => key.prefix),
  })
}

export async function revokeAppKeysForApp(
  ctx: MutationCtx,
  args: { app: Doc<'apps'>; now: number },
): Promise<{ revoked: number; prefixes: string[] }> {
  const keys = [
    ...(await unrevokedManagedAppKeysForApp(ctx, args.app._id)),
    ...(await liveExportedAppKeys(ctx, args.app._id, args.now)),
  ]
  const workspace = await ctx.db.get(args.app.workspaceId)
  if (workspace === null) return { revoked: 0, prefixes: [] }
  const actorId = vmModelKeyActor(workspace)
  await revokeManagedKeys(ctx, keys, args.now)
  for (const key of keys) {
    await writeAuditEvent(ctx, {
      workspaceId: args.app.workspaceId,
      event: 'api_key.app_key_revoked',
      actorId,
      at: args.now,
      provenance: {
        appId: args.app._id,
        appSlug: args.app.slug,
        credentialId: key._id,
        purpose: key.appKeyPurpose ?? 'managed',
        prefix: key.prefix,
        scopes: key.scopes,
        expiresAt: key.expiresAt,
      },
    })
  }
  return { revoked: keys.length, prefixes: keys.map(key => key.prefix) }
}

async function issueManagedWorkspaceKey(
  ctx: MutationCtx,
  args: {
    kind: 'system_vm' | 'app'
    workspace: Doc<'workspaces'>
    app?: Doc<'apps'>
    scopes: string[]
    expiresMs: number
    now: number
    event: AuditEventName
    oldPrefixes?: string[]
  },
): Promise<VmModelKeyResult> {
  const expiresAt = args.now + args.expiresMs
  const issued = await issueWorkspaceCredential(ctx, { ...args, expiresAt })
  return { ...issued, expiresAt, minted: true }
}

export async function issueWorkspaceCredential(
  ctx: MutationCtx,
  args: {
    kind: 'system_vm' | 'app'
    workspace: Doc<'workspaces'>
    app?: Doc<'apps'>
    scopes: string[]
    expiresAt?: number
    appKeyPurpose?: 'exported'
    auditActorId?: Id<'users'>
    now: number
    event: AuditEventName
    oldPrefixes?: string[]
  },
) {
  const key = generateApiKey()
  const prefix = keyPrefix(key)
  const scopes = canonicalizeApiKeyScopes(args.scopes)
  const keyId = await insertApiKey(ctx, {
    kind: args.kind,
    workspaceId: args.workspace._id,
    ...(args.app === undefined ? {} : { appId: args.app._id }),
    ...(args.appKeyPurpose === undefined ? {} : { appKeyPurpose: args.appKeyPurpose }),
    userId: vmModelKeyActor(args.workspace),
    hashedKey: await hashSecret(key),
    prefix,
    scopes,
    workspaceIds: [args.workspace._id],
    ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspace._id,
    event: args.event,
    actorId: args.auditActorId ?? vmModelKeyActor(args.workspace),
    at: args.now,
    provenance: {
      ...(args.app === undefined ? {} : { appId: args.app._id, appSlug: args.app.slug }),
      ...(args.oldPrefixes === undefined ? {} : { oldPrefixes: args.oldPrefixes }),
      ...(args.appKeyPurpose === undefined
        ? {}
        : { purpose: args.appKeyPurpose, credentialId: keyId }),
      prefix,
      scopes,
      ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
    },
  })
  return { key, keyId, prefix, scopes }
}

function reusableManagedKey(
  existing: ScopedApiKey | null,
  scopes: string[],
  now: number,
  refreshWindowMs = 0,
): VmModelKeyResult | null {
  if (
    existing === null ||
    existing.expiresAt === undefined ||
    existing.expiresAt - now <= refreshWindowMs ||
    !sameScopeSet(existing.scopes, scopes)
  ) {
    return null
  }
  return {
    key: null,
    keyId: existing._id,
    prefix: existing.prefix,
    scopes: existing.scopes,
    expiresAt: existing.expiresAt,
    minted: false,
  }
}

async function revokeManagedKeys(
  ctx: MutationCtx,
  keys: Doc<'apiKeys'>[],
  now: number,
): Promise<void> {
  for (const key of keys) await ctx.db.patch(key._id, { revokedAt: now })
}

export async function revokeVmModelKeyForWorkspace(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
): Promise<{ revoked: number; prefixes: string[] }> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return { revoked: 0, prefixes: [] }
  if (
    workspace.vmModelCredentialRetryAt !== undefined ||
    workspace.vmModelCredentialRetryScopeKey !== undefined
  ) {
    await ctx.db.patch(workspace._id, {
      vmModelCredentialRetryAt: undefined,
      vmModelCredentialRetryScopeKey: undefined,
    })
  }
  const oldKeys = await unrevokedVmModelKeysForWorkspace(ctx, args.workspaceId)
  if (oldKeys.length === 0) return { revoked: 0, prefixes: [] }
  await revokeManagedKeys(ctx, oldKeys, args.now)
  const prefixes = oldKeys.map(oldKey => oldKey.prefix)
  await writeAuditEvent(ctx, {
    workspaceId: workspace._id,
    event: 'api_key.vm_model_key_revoked',
    actorId: vmModelKeyActor(workspace),
    at: args.now,
    provenance: {
      prefixes,
      scopes: canonicalizeApiKeyScopes([...new Set(oldKeys.flatMap(oldKey => oldKey.scopes))]),
    },
  })
  return { revoked: oldKeys.length, prefixes }
}

export function roleCanGrant(role: WorkspaceRole, capability: Capability): boolean {
  if (VIEWER_CAPABILITIES.includes(capability as (typeof VIEWER_CAPABILITIES)[number])) return true
  if (role === 'viewer') return false
  if (EDITOR_CAPABILITIES.includes(capability as (typeof EDITOR_CAPABILITIES)[number])) return true
  return role === 'owner' && (capability === 'members' || capability === 'admin')
}

export async function liveWorkspaceBySlug(ctx: QueryCtx | MutationCtx, slug: string) {
  // Slug uniqueness is only enforced among live rows — a deleted row may share
  // the slug, so pick the live row rather than the newest.
  const rows = await ctx.db
    .query('workspaces')
    .withIndex('by_slug_status', q => q.eq('slug', slug))
    .take(100)
  return rows.find(workspace => isLiveWorkspace(workspace.status)) ?? null
}

async function requireVmModelKeyWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
) {
  const workspace = await ctx.db.get(workspaceId)
  if (
    workspace === null ||
    !isLiveWorkspace(workspace.status) ||
    (workspace.servicingStatus !== undefined && workspace.servicingStatus !== 'active')
  ) {
    throw new Error('Workspace not found')
  }
  return workspace
}

async function liveVmModelKeyForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
) {
  return (await liveVmModelKeysForWorkspace(ctx, workspaceId, now))[0] ?? null
}

// True when the workspace holds no live VM key carrying the current scope set —
// it expired, was never minted, or predates the current scope contract. vm-sync
// delivers unprompted on this, so a scope change and a workspace whose key died
// during a servicing pause both heal within one poll rather than waiting for the
// VM to notice and ask.
export async function vmModelKeyDeliveryDue(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; workspaceSlug: string; now: number },
): Promise<boolean> {
  const existing = await liveVmModelKeyForWorkspace(ctx, args.workspaceId, args.now)
  if (existing === null) return true
  return !sameScopeSet(existing.scopes, vmModelScopes(args.workspaceSlug))
}

export async function vmModelKeyCapacityRetryAt(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
): Promise<number | undefined> {
  const live = (await unrevokedVmModelKeysForWorkspace(ctx, args.workspaceId)).filter(
    key => (key.expiresAt ?? 0) > args.now,
  )
  if (live.length < MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE) return undefined
  return Math.min(...live.map(key => key.expiresAt!))
}

async function liveVmModelKeysForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
) {
  const keys = await unrevokedVmModelKeysForWorkspace(ctx, workspaceId)
  return keys.filter(key => key.expiresAt !== undefined && key.expiresAt > now)
}

async function unrevokedVmModelKeysForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
) {
  const keys = await ctx.db
    .query('apiKeys')
    .withIndex('by_kind_workspace_revokedAt', q =>
      q.eq('kind', 'system_vm').eq('workspaceId', workspaceId).eq('revokedAt', undefined),
    )
    .take(MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE + 1)
  if (keys.length > MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE) {
    throw new Error('Workspace has too many unrevoked VM model credentials')
  }
  return keys as ScopedApiKey[]
}

async function requireAppKeyTarget(ctx: QueryCtx | MutationCtx, appId: Id<'apps'>) {
  const app = await ctx.db.get(appId)
  if (app === null || app.disabledAt !== undefined) throw new Error('App not found')
  const workspace = await requireAppKeyWorkspace(ctx, app.workspaceId)
  const declarations = AppApiScopesSchema.parse(app.apiScopes)
  const scopes = declarations.map(capability =>
    serializeScope({ workspaceSlug: workspace.slug, capability }),
  )
  return { app, workspace, scopes }
}

async function requireAppKeyWorkspace(ctx: QueryCtx | MutationCtx, workspaceId: Id<'workspaces'>) {
  return await requireVmModelKeyWorkspace(ctx, workspaceId)
}

async function unrevokedManagedAppKeysForApp(ctx: QueryCtx | MutationCtx, appId: Id<'apps'>) {
  const keys = await ctx.db
    .query('apiKeys')
    .withIndex('by_kind_app_purpose_revokedAt_expiresAt', q =>
      q
        .eq('kind', 'app')
        .eq('appId', appId)
        .eq('appKeyPurpose', undefined)
        .eq('revokedAt', undefined),
    )
    // Rotation should keep this bucket at one; the cap prevents corrupted
    // historical state from turning a lifecycle mutation into an unbounded read.
    .take(101)
  if (keys.length > 100) throw new Error('App has too many unrevoked credentials')
  return keys as ScopedApiKey[]
}

export async function liveExportedAppKeys(
  ctx: QueryCtx | MutationCtx,
  appId: Id<'apps'>,
  now: number,
) {
  const never = await ctx.db
    .query('apiKeys')
    .withIndex('by_kind_app_purpose_revokedAt_expiresAt', q =>
      q
        .eq('kind', 'app')
        .eq('appId', appId)
        .eq('appKeyPurpose', 'exported')
        .eq('revokedAt', undefined)
        .eq('expiresAt', undefined),
    )
    .take(MAX_EXPORTED_APP_CREDENTIALS + 1)
  const finite = await ctx.db
    .query('apiKeys')
    .withIndex('by_kind_app_purpose_revokedAt_expiresAt', q =>
      q
        .eq('kind', 'app')
        .eq('appId', appId)
        .eq('appKeyPurpose', 'exported')
        .eq('revokedAt', undefined)
        .gt('expiresAt', now),
    )
    .take(MAX_EXPORTED_APP_CREDENTIALS + 1)
  const keys = [...never, ...finite]
  if (keys.length > MAX_EXPORTED_APP_CREDENTIALS)
    throw new Error('App has too many live exported credentials')
  return keys as ScopedApiKey[]
}

export async function revokeExportedAppKeysForScopeChange(
  ctx: MutationCtx,
  args: { app: Doc<'apps'>; apiScopes: string[]; now: number },
) {
  if (sameScopeSet(args.app.apiScopes, args.apiScopes)) return
  const workspace = await ctx.db.get(args.app.workspaceId)
  if (workspace === null) return
  for (const key of await liveExportedAppKeys(ctx, args.app._id, args.now)) {
    await revokeExportedAppKey(ctx, {
      app: args.app,
      key,
      now: args.now,
      actorId: vmModelKeyActor(workspace),
    })
  }
}

export async function revokeExportedAppKey(
  ctx: MutationCtx,
  args: { app: Doc<'apps'>; key: Doc<'apiKeys'>; now: number; actorId: Id<'users'> },
) {
  if (args.key.revokedAt !== undefined) return
  await ctx.db.patch(args.key._id, { revokedAt: args.now })
  await writeAuditEvent(ctx, {
    workspaceId: args.app.workspaceId,
    event: 'api_key.app_key_revoked',
    actorId: args.actorId,
    at: args.now,
    provenance: {
      appId: args.app._id,
      appSlug: args.app.slug,
      purpose: 'exported',
      credentialId: args.key._id,
      prefix: args.key.prefix,
      ...(args.key.expiresAt === undefined ? {} : { expiresAt: args.key.expiresAt }),
    },
  })
}

// The VM system key is the workspace agent's own credential: model access
// plus workspace control, including full-workspace backups. Scope changes
// rotate stale credentials through the same managed-key owner.
export function vmModelScopes(workspaceSlug: string): string[] {
  return [
    serializeScope({ workspaceSlug, capability: 'admin' }),
    serializeScope({ workspaceSlug, capability: 'services' }),
    serializeScope({ workspaceSlug, capability: 'apps' }),
    serializeScope({ workspaceSlug, capability: 'agents' }),
    serializeScope({ workspaceSlug, capability: 'sessions' }),
    // The runner's integrations MCP server authenticates with this key
    // against the session integrations MCP route; without the scope every spawn
    // stalls turn_started behind insufficient_scope retries (@duetso/agent
    // 0.3.8), wedging cold VMs past the 300s ceiling. One trust domain: the
    // VM already reaches integrations through the API by other means.
    serializeScope({ workspaceSlug, capability: 'integrations' }),
  ]
}

export function vmModelScopeKey(workspaceSlug: string): string {
  return JSON.stringify(vmModelScopes(workspaceSlug))
}

function sameScopeSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const sorted = [...right].sort()
  return [...left].sort().every((scope, index) => scope === sorted[index])
}

function vmModelKeyActor(workspace: { createdByUserId?: Id<'users'> }): Id<'users'> {
  if (workspace.createdByUserId === undefined) throw new Error('Workspace missing createdByUserId')
  return workspace.createdByUserId
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('')
}
