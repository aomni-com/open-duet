import { makeFunctionReference, paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'

import {
  AppDomainSchema,
  normalizeAppDomainHostname,
  type AppDomain,
  type AppDomainSummary,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from '../../_generated/server'
import { appDomainTarget } from '../../config'
import {
  sessionRequestIdentityValidator,
  type SessionRequestIdentity,
} from '../agentSessions/identity'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { assertActorRole, isLiveWorkspace } from '../workspaces/authorization'

const mutationArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  slug: v.string(),
  identity: sessionRequestIdentityValidator,
  now: v.optional(v.number()),
}
const readArgs = { internalKey: v.string(), workspaceId: v.id('workspaces') }
const dispatchRef = makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue')
const notifyRef = makeFunctionReference<'action'>(
  'domains/customDomains/actions:notifyWorkspaceApps',
)
const workspaceRemovalRef = makeFunctionReference<'mutation'>(
  'domains/customDomains/model:removeWorkspacePage',
)

type DbCtx = QueryCtx | MutationCtx
export function throwDomainError(error: string): never {
  throw new ConvexError({ error })
}

async function requireWorkspace(ctx: DbCtx, workspaceId: Id<'workspaces'>) {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null || !isLiveWorkspace(workspace.status)) throwDomainError('not_found')
  return workspace
}
async function requireApp(ctx: DbCtx, workspaceId: Id<'workspaces'>, slug: string) {
  const app = await ctx.db
    .query('apps')
    .withIndex('by_workspace_and_slug', q => q.eq('workspaceId', workspaceId).eq('slug', slug))
    .unique()
  if (app === null) throwDomainError('not_found')
  return app
}
async function authorize(
  ctx: DbCtx,
  args: { internalKey: string; workspaceId: Id<'workspaces'>; identity: SessionRequestIdentity },
) {
  requireApiInternalKey(args.internalKey)
  await requireWorkspace(ctx, args.workspaceId)
  const { principal, actorId } = args.identity
  if (principal.kind === 'human') {
    if (principal.userId !== actorId) throwDomainError('forbidden')
    try {
      await assertActorRole(ctx, args.workspaceId, principal.userId, 'editor')
    } catch {
      throwDomainError('forbidden')
    }
  }
}
function requireProviderConfig() {
  if (!process.env.DUET_VERCEL_DOMAINS_TOKEN) throwDomainError('domain_not_configured')
  try {
    return appDomainTarget()
  } catch {
    throwDomainError('domain_not_configured')
  }
}
export async function domainWire(ctx: DbCtx, row: Doc<'customDomains'>): Promise<AppDomain> {
  const diagnostics = (await ctx.db.get(row.diagnosticsId))!
  return AppDomainSchema.parse({
    ...row,
    ...diagnostics,
    id: row._id,
    ...(row.repairReason === 'uncertain' ? { operatorRepairRequired: true } : {}),
    ...(row.repairReason === 'exhausted' ? { retryRequired: true } : {}),
    ...((row.status === 'active' || row.status === 'failed') &&
    (row.workRunning || row.nextWorkAt !== undefined)
      ? { checking: true }
      : {}),
  })
}
export async function domainSummaryForApp(
  ctx: DbCtx,
  appId: Id<'apps'>,
): Promise<AppDomainSummary | undefined> {
  const row = await ctx.db
    .query('customDomains')
    .withIndex('by_app', q => q.eq('appId', appId))
    .unique()
  return row === null ? undefined : { hostname: row.hostname, status: row.status }
}

export const get = query({
  args: { ...readArgs, slug: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await requireWorkspace(ctx, args.workspaceId)
    const app = await requireApp(ctx, args.workspaceId, args.slug)
    const row = await ctx.db
      .query('customDomains')
      .withIndex('by_app', q => q.eq('appId', app._id))
      .unique()
    return row === null ? null : domainWire(ctx, row)
  },
})

export const listByWorkspace = query({
  args: { ...readArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await requireWorkspace(ctx, args.workspaceId)
    const page = await ctx.db
      .query('customDomains')
      .withIndex('by_workspace_listed', q =>
        q.eq('workspaceId', args.workspaceId).eq('listed', true),
      )
      .paginate({ ...args.paginationOpts, numItems: Math.min(5, args.paginationOpts.numItems) })
    const items = []
    for (const row of page.page) {
      const app = await ctx.db.get(row.appId)
      if (app !== null)
        items.push({
          domain: await domainWire(ctx, row),
          app: {
            id: app._id,
            slug: app.slug,
            ...(app.name === undefined ? {} : { name: app.name }),
          },
        })
    }
    return { ...page, page: items }
  },
})

export const attach = mutation({
  args: { ...mutationArgs, hostname: v.string() },
  handler: async (ctx, args) => {
    await authorize(ctx, args)
    let hostname: string
    try {
      hostname = normalizeAppDomainHostname(args.hostname)
    } catch {
      throwDomainError('invalid_request')
    }
    const app = await requireApp(ctx, args.workspaceId, args.slug)
    const existing = await ctx.db
      .query('customDomains')
      .withIndex('by_app', q => q.eq('appId', app._id))
      .unique()
    if (existing !== null) {
      if (existing.status === 'removing') throwDomainError('domain_cleanup_pending')
      if (existing.hostname !== hostname) throwDomainError('domain_occupied')
      return domainWire(ctx, existing)
    }
    const target = requireProviderConfig()
    const occupied = await ctx.db
      .query('customDomains')
      .withIndex('by_hostname', q => q.eq('hostname', hostname))
      .unique()
    if (occupied !== null) throwDomainError('hostname_in_use')
    const now = args.now ?? Date.now()
    const diagnosticsId = await ctx.db.insert('customDomainDiagnostics', {
      records: [],
      conflicts: [],
    })
    const id = await ctx.db.insert('customDomains', {
      workspaceId: app.workspaceId,
      appId: app._id,
      hostname,
      listed: true,
      target,
      status: 'pending',
      diagnosticsId,
      revision: 1,
      providerAssigned: false,
      nextWorkAt: now,
      workRunning: false,
      cleanupAttempts: 0,
      createdByUserId: args.identity.actorId,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.scheduler.runAfter(0, dispatchRef, {})
    await writeAuditEvent(ctx, {
      workspaceId: app.workspaceId,
      event: 'app.domain_attached',
      actorId: args.identity.actorId,
      at: now,
      provenance: { appId: app._id, name: hostname },
    })
    return domainWire(ctx, (await ctx.db.get(id))!)
  },
})

export const recheck = mutation({
  args: mutationArgs,
  handler: async (ctx, args) => {
    await authorize(ctx, args)
    requireProviderConfig()
    const app = await requireApp(ctx, args.workspaceId, args.slug)
    const row = await ctx.db
      .query('customDomains')
      .withIndex('by_app', q => q.eq('appId', app._id))
      .unique()
    if (row === null) throwDomainError('not_found')
    if (row.repairReason === 'uncertain') return domainWire(ctx, row)
    const now = args.now ?? Date.now()
    if (!row.workRunning) {
      await ctx.db.patch(row._id, {
        nextWorkAt: now,
        cleanupAttempts: row.status === 'removing' ? 0 : row.cleanupAttempts,
        repairReason: undefined,
        updatedAt: now,
      })
      await ctx.scheduler.runAfter(0, dispatchRef, {})
    }
    return domainWire(ctx, (await ctx.db.get(row._id))!)
  },
})

export const remove = mutation({
  args: mutationArgs,
  handler: async (ctx, args) => {
    await authorize(ctx, args)
    const app = await requireApp(ctx, args.workspaceId, args.slug)
    const now = args.now ?? Date.now()
    const existing = await ctx.db
      .query('customDomains')
      .withIndex('by_app', q => q.eq('appId', app._id))
      .unique()
    const row = await beginDomainRemovalForApp(ctx, app._id, now)
    if (existing !== null && existing.status !== 'removing' && row !== null)
      await writeAuditEvent(ctx, {
        workspaceId: app.workspaceId,
        event: 'app.domain_removed',
        actorId: args.identity.actorId,
        at: now,
        provenance: { appId: app._id, name: row.hostname },
      })
    return row === null ? null : domainWire(ctx, row)
  },
})

export async function beginDomainRemovalForApp(
  ctx: MutationCtx,
  appId: Id<'apps'>,
  now: number,
  options: { orphan?: boolean } = {},
) {
  const row = await ctx.db
    .query('customDomains')
    .withIndex('by_app', q => q.eq('appId', appId))
    .unique()
  if (row === null) return null
  if (options.orphan && row.listed) await ctx.db.patch(row._id, { listed: false })
  if (row.status === 'removing') return (await ctx.db.get(row._id))!
  await ctx.db.patch(row._id, {
    status: 'removing',
    revision: row.revision + 1,
    nextWorkAt: now,
    cleanupAttempts: 0,
    repairReason: undefined,
    updatedAt: now,
  })
  await ctx.scheduler.runAfter(0, dispatchRef, {})
  await notifyWorkspaceApps(ctx, row.workspaceId)
  return (await ctx.db.get(row._id))!
}
export async function beginDomainRemovalForWorkspace(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  now: number,
) {
  // Parent deletion can compose several paged owners or workspaces. Convex
  // permits one continuation query per transaction, so every domain page,
  // including the first, runs independently after the parent's durable seal.
  await ctx.scheduler.runAfter(0, workspaceRemovalRef, { workspaceId, cursor: null, now })
}
export const removeWorkspacePage = internalMutation({
  args: { workspaceId: v.id('workspaces'), cursor: v.union(v.string(), v.null()), now: v.number() },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace?.status !== 'deleted') return
    const page = await ctx.db
      .query('customDomains')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .paginate({ cursor: args.cursor, numItems: 20 })
    for (const row of page.page)
      await beginDomainRemovalForApp(ctx, row.appId, args.now, { orphan: true })
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, workspaceRemovalRef, {
        workspaceId: args.workspaceId,
        cursor: page.continueCursor,
        now: args.now,
      })
  },
})

export const resolveHostname = query({
  args: { internalKey: v.string(), hostname: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('customDomains')
      .withIndex('by_hostname', q => q.eq('hostname', args.hostname))
      .unique()
    if (row?.status !== 'active') return null
    const [app, workspace] = await Promise.all([ctx.db.get(row.appId), ctx.db.get(row.workspaceId)])
    if (app === null || workspace === null || !isLiveWorkspace(workspace.status)) return null
    return {
      appId: app._id,
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      appSlug: app.slug,
    }
  },
})

export async function notifyWorkspaceApps(ctx: MutationCtx, workspaceId: Id<'workspaces'>) {
  await ctx.scheduler.runAfter(0, notifyRef, { workspaceId })
}
