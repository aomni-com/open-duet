import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import {
  MAX_SLUG_LENGTH,
  PublishKindSchema,
  PublishSnapshotComponentSchema,
  PublishResponseSchema,
  PublishSlugSchema,
  ViewerDescriptorSchema,
  assertValidSlug,
  isDrivePathWithin,
  isEnvLikeDrivePath,
  isPublishExcludedDrivePath,
  normalizeSlug,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { getOrCreateAnchorForPath, normalizeAnchorPath, requireAnchor } from '../anchors/model'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { deriveVmToken } from '../workspaces/vmToken'
import { deletePublishRow } from './teardown'

const publishKindValidator = v.union(v.literal('file'), v.literal('folder'))
const WORKSPACE_PUBLISH_READ_LIMIT = 500

export const createPublish = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    path: v.string(),
    kind: publishKindValidator,
    slug: v.optional(v.string()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const { userId } = await publishMutationActor(ctx, {
      workspaceId: args.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    return await createPublishImpl(ctx, { ...args, actorId: userId, now })
  },
})

export async function createPublishImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    path: string
    kind: 'file' | 'folder'
    slug?: string
    actorId: Id<'users'>
    now: number
  },
) {
  const path = normalizeAnchorPath(args.path, 'publish')
  if (isEnvLikeDrivePath(path)) throw new Error('Invalid publish path: env_file')
  const kind = PublishKindSchema.parse(args.kind)
  const anchor = await getOrCreateAnchorForPath(ctx, {
    workspaceId: args.workspaceId,
    path,
    kind: 'publish',
    settings: { kind },
    actorId: args.actorId,
    now: args.now,
    kindConflictError: 'Anchor path is not a publish, app, agent, or share-root anchor',
    compatibleExistingKinds: ['app', 'agent', 'share-root'],
  })
  const existing = await publishByAnchor(ctx, anchor.id as Id<'anchors'>)
  if (existing !== null) return await toPublishWithAnchor(ctx, existing)
  // A caller-named slug is a request and is answered: `publishSlug` refuses a
  // reserved or malformed one rather than quietly renaming it. Only the
  // path-derived fallback is a proposal the allocator may step over.
  const base = args.slug === undefined ? slugFromPath(path) : publishSlug(args.slug)
  const slug = await findAvailablePublishSlug(ctx, args.workspaceId, base)
  const publishId = await ctx.db.insert('publishes', {
    workspaceId: args.workspaceId,
    anchorId: anchor.id as Id<'anchors'>,
    slug,
    kind,
    createdByUserId: args.actorId,
    createdAt: args.now,
    updatedAt: args.now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'publish.created',
    actorId: args.actorId,
    at: args.now,
    provenance: { publishId, anchorId: anchor.id, path, slug, kind },
  })
  return await toPublishWithAnchor(ctx, await requirePublish(ctx, publishId))
}

export const updateSlug = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    newSlug: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const publish = await requirePublishBySlug(ctx, args.workspaceId, publishSlug(args.slug))
    const { userId } = await publishMutationActor(ctx, {
      workspaceId: publish.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    const nextSlug = publishSlug(args.newSlug)
    await assertSlugAvailable(ctx, publish.workspaceId, nextSlug, publish._id)
    const now = args.now ?? Date.now()
    await ctx.db.patch(publish._id, { slug: nextSlug, updatedAt: now })
    await writeAuditEvent(ctx, {
      workspaceId: publish.workspaceId,
      event: 'publish.slug_updated',
      actorId: userId,
      at: now,
      provenance: {
        publishId: publish._id,
        anchorId: publish.anchorId,
        oldSlug: publish.slug,
        newSlug: nextSlug,
      },
    })
    return await toPublishWithAnchor(ctx, await requirePublish(ctx, publish._id))
  },
})

export const setPublishPaused = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    publishId: v.id('publishes'),
    slug: v.string(),
    paused: v.boolean(),
    generation: v.optional(v.string()),
    internalKey: v.string(),
    actorId: v.id('users'),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const publish = await requirePublish(ctx, args.publishId)
    if (publish.workspaceId !== args.workspaceId || publish.slug !== publishSlug(args.slug))
      throw new Error('Publish not found')
    const { userId } = await publishMutationActor(ctx, {
      workspaceId: publish.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    const generation =
      args.generation === undefined
        ? undefined
        : PublishSnapshotComponentSchema.parse(args.generation)
    if (args.paused && !generation) throw new Error('Pause generation is required')
    if (!args.paused && args.generation !== undefined)
      throw new Error('Pause generation is invalid while unpausing')
    const now = args.now ?? Date.now()
    await ctx.db.patch(publish._id, {
      pausedAt: args.paused ? now : undefined,
      pauseGeneration: args.paused ? generation : undefined,
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      workspaceId: publish.workspaceId,
      event: args.paused ? 'publish.paused' : 'publish.resumed',
      actorId: userId,
      at: now,
      provenance: {
        publishId: publish._id,
        anchorId: publish.anchorId,
        slug: publish.slug,
        ...(generation === undefined ? {} : { generation }),
      },
    })
    return await toPublishWithAnchor(ctx, await requirePublish(ctx, publish._id))
  },
})

export const deletePublish = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const publish = await requirePublishBySlug(ctx, args.workspaceId, publishSlug(args.slug))
    const { userId } = await publishMutationActor(ctx, {
      workspaceId: publish.workspaceId,
      internalKey: args.internalKey,
      actorId: args.actorId,
      minimumRole: 'editor',
    })
    await deletePublishRow(ctx, {
      publish,
      anchor: await requireAnchor(ctx, publish.anchorId),
      actorId: userId,
      now: args.now ?? Date.now(),
    })
    return { ok: true as const }
  },
})

export const listByWorkspace = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    const rows = await ctx.db
      .query('publishes')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      // Publish lists are workspace UI payloads; 500 is above the expected number of public surfaces.
      .take(WORKSPACE_PUBLISH_READ_LIMIT)
    return await Promise.all(
      rows.sort((a, b) => a.slug.localeCompare(b.slug)).map(row => toPublishWithAnchor(ctx, row)),
    )
  },
})

export async function listWorkspacePublishesPage(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  const result = await ctx.db
    .query('publishes')
    .withIndex('by_workspace_and_slug', q => q.eq('workspaceId', workspaceId))
    .order('asc')
    .paginate(paginationOpts)
  return {
    ...result,
    page: await Promise.all(result.page.map(row => toPublishWithAnchor(ctx, row))),
  }
}

export const listByWorkspacePage = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await listWorkspacePublishesPage(ctx, args.workspaceId, args.paginationOpts)
  },
})

export const getBySlug = query({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.internalKey !== undefined) requireApiInternalKey(args.internalKey)
    else await assertRole(ctx, args.workspaceId, 'viewer')
    const publish = await publishBySlug(ctx, args.workspaceId, publishSlug(args.slug))
    return publish === null ? null : await toPublishWithAnchor(ctx, publish)
  },
})

/**
 * Why a publish would NOT serve its archive, or null if it would.
 *
 * The ONE owner of origin eligibility. The edge resolver maps these to its
 * response shapes; the marketplace availability sweep treats any non-null as
 * unservable. They previously each kept their own list and the marketplace's was
 * shorter, so a paused or suspended publisher read as `available`, admitted
 * installs, and only failed at pull time — where a paused workspace serves its
 * paused page as a NON-archive 200 and is caught by content-type, if at all.
 */
export async function publishOriginRefusal(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<'workspaces'>,
  publish: Doc<'publishes'>,
): Promise<'suspended' | 'paused' | 'unresolvable' | null> {
  if (workspace.suspendedAt !== undefined) return 'suspended'
  const anchor = await ctx.db.get(publish.anchorId)
  if (anchor === null || anchor.state !== 'active' || isEnvLikeDrivePath(anchor.path)) {
    return 'unresolvable'
  }
  // A publish with no live creator cannot yield an owner label; treat it as
  // unresolvable rather than shipping a placeholder identity.
  if ((await ctx.db.get(publish.createdByUserId)) === null) return 'unresolvable'
  if (workspace.servicingStatus === 'paused') return 'paused'
  if (
    workspace.vmName === undefined ||
    workspace.httpsUrl === undefined ||
    workspace.vmTokenNonce === undefined
  ) {
    return 'unresolvable'
  }
  return null
}

export const resolveForEdge = query({
  args: {
    internalKey: v.string(),
    workspaceSlug: v.string(),
    publishSlug: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const activeWorkspace = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', args.workspaceSlug).eq('status', 'active'))
      .first()
    const workspace =
      activeWorkspace ??
      (await ctx.db
        .query('workspaces')
        .withIndex('by_slug_status', q => q.eq('slug', args.workspaceSlug).eq('status', 'archived'))
        .first())
    if (workspace === null) return null
    const publish = await publishBySlug(ctx, workspace._id, publishSlug(args.publishSlug))
    if (publish === null) return null
    const refusal = await publishOriginRefusal(ctx, workspace, publish)
    if (refusal === 'suspended') return { suspended: true as const }
    if (refusal === 'paused') return { paused: true as const, appName: publish.slug }
    if (refusal !== null) return null
    const anchor = await ctx.db.get(publish.anchorId)
    const creator = await ctx.db.get(publish.createdByUserId)
    // `publishOriginRefusal` already proved both resolve; re-reading keeps the
    // owner-label projection below honest rather than asserting non-null.
    if (anchor === null || creator === null) return null
    if (
      workspace.vmName === undefined ||
      workspace.httpsUrl === undefined ||
      workspace.vmTokenNonce === undefined
    ) {
      return null
    }
    return {
      visibility: 'public' as const,
      workspace: {
        id: workspace._id,
        slug: workspace.slug,
        httpsUrl: workspace.httpsUrl,
        vmName: workspace.vmName,
      },
      origin: {
        httpsUrl: workspace.httpsUrl,
        gatewayAuthToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce),
        gatewayPathPrefix: '/public/publish',
      },
      publish: {
        id: publish._id,
        kind: publish.kind,
        anchorPath: anchor.path,
        ...(publish.pausedAt === undefined || publish.pauseGeneration === undefined
          ? {}
          : { freeze: { generation: publish.pauseGeneration } }),
        // The minimum public bootstrap for the anonymous viewer. Built through
        // the shared schema so the wire shape (and its private-field stripping)
        // has one owner; no email, session id, VM address, or token is included.
        viewer: ViewerDescriptorSchema.parse({
          workspaceName: workspace.name,
          ownerName: projectViewerOwnerName(creator, workspace),
          rootName: anchorBasename(anchor.path),
          kind: publish.kind,
        }),
      },
    }
  },
})

export const recordServedPath = mutation({
  args: {
    internalKey: v.string(),
    publishId: v.id('publishes'),
    servedPath: v.string(),
    kind: v.union(v.literal('raw'), v.literal('zip')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const publish = await requirePublish(ctx, args.publishId)
    if (publish.kind !== 'folder')
      return { recorded: false as const, reason: 'not_folder' as const }
    const anchor = await requireAnchor(ctx, publish.anchorId)
    const servedPath = normalizeAnchorPath(args.servedPath, 'publish')
    if (isPublishExcludedDrivePath(servedPath)) throw new Error('Invalid publish path: excluded')
    const isPublishRoot = servedPath === anchor.path
    if (!isDrivePathWithin(anchor.path, servedPath) || (args.kind === 'raw' && isPublishRoot)) {
      return { recorded: false as const, reason: 'outside_publish' as const }
    }
    const existing = await ctx.db
      .query('publishServedPaths')
      .withIndex('by_publish_and_path', q => q.eq('publishId', publish._id).eq('path', servedPath))
      .unique()
    if (existing !== null) return { recorded: false as const, reason: 'already_recorded' as const }
    const now = args.now ?? Date.now()
    await ctx.db.insert('publishServedPaths', {
      publishId: publish._id,
      path: servedPath,
      kind: args.kind,
      firstServedAt: now,
    })
    await writeAuditEvent(ctx, {
      workspaceId: publish.workspaceId,
      event: args.kind === 'zip' ? 'publish.new_zip_served' : 'publish.new_file_served',
      actorId: publish.createdByUserId,
      at: now,
      provenance: {
        publishId: publish._id,
        anchorId: publish.anchorId,
        path: servedPath,
        slug: publish.slug,
      },
    })
    return { recorded: true as const }
  },
})

type MinimumRole = 'owner' | 'editor'

async function publishMutationActor(
  ctx: QueryCtx | MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    internalKey?: string
    actorId?: Id<'users'>
    minimumRole: MinimumRole
  },
): Promise<{ userId: Id<'users'> }> {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined)
      throw new Error('actorId is required for internal publish mutation')
    return await assertActorRole(ctx, args.workspaceId, args.actorId, args.minimumRole)
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  return await assertRole(ctx, args.workspaceId, args.minimumRole)
}

async function findAvailablePublishSlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  rawBase: string,
): Promise<string> {
  const base = trimSlugBase(normalizeSlug(rawBase) || 'publish')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`.replace(
      /-+$/g,
      '',
    )
    // A candidate here is a proposal: reserved is one more reason it is
    // unavailable, exactly like already-taken below, so both step to the next
    // suffix. A slug the CALLER named never reaches this loop unvalidated —
    // `createPublishImpl` parses that one first, so it is refused, not renamed.
    if (!PublishSlugSchema.safeParse(candidate).success) continue
    const existing = await publishBySlug(ctx, workspaceId, candidate)
    if (existing === null) return candidate
  }
  throw new Error('Could not allocate publish slug')
}

async function assertSlugAvailable(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
  publishId: Id<'publishes'>,
): Promise<void> {
  const existing = await publishBySlug(ctx, workspaceId, slug)
  if (existing !== null && existing._id !== publishId)
    throw new Error('Publish slug already exists')
}

async function requirePublish(
  ctx: QueryCtx | MutationCtx,
  publishId: Id<'publishes'>,
): Promise<Doc<'publishes'>> {
  const publish = await ctx.db.get(publishId)
  if (publish === null) throw new Error('Publish not found')
  return publish
}

async function requirePublishBySlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
): Promise<Doc<'publishes'>> {
  const publish = await publishBySlug(ctx, workspaceId, slug)
  if (publish === null) throw new Error('Publish not found')
  return publish
}

async function publishBySlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
): Promise<Doc<'publishes'> | null> {
  return await ctx.db
    .query('publishes')
    .withIndex('by_workspace_and_slug', q => q.eq('workspaceId', workspaceId).eq('slug', slug))
    .unique()
}

async function publishByAnchor(
  ctx: QueryCtx | MutationCtx,
  anchorId: Id<'anchors'>,
): Promise<Doc<'publishes'> | null> {
  return await ctx.db
    .query('publishes')
    .withIndex('by_anchor', q => q.eq('anchorId', anchorId))
    .unique()
}

async function toPublishWithAnchor(ctx: QueryCtx | MutationCtx, publish: Doc<'publishes'>) {
  const anchor = await requireAnchor(ctx, publish.anchorId)
  return PublishResponseSchema.shape.publish.parse({
    id: publish._id,
    workspaceId: publish.workspaceId,
    anchorId: publish.anchorId,
    anchorPath: anchor.path,
    slug: publish.slug,
    kind: publish.kind,
    pausedAt: publish.pausedAt,
    pauseGeneration: publish.pauseGeneration,
    createdByUserId: publish.createdByUserId,
    createdAt: publish.createdAt,
    updatedAt: publish.updatedAt,
  })
}

function slugFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'publish'
}

// The published file/folder basename shown as the viewer root.
function anchorBasename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

// A non-email display label for the publish owner. Prefers the creator's display
// name, then first+last, then the workspace name — skipping any candidate that
// looks like an email — and ends on a deterministic generic label. The owner
// label must never be an email, so an '@' disqualifies a candidate outright.
function projectViewerOwnerName(creator: Doc<'users'>, workspace: Doc<'workspaces'>): string {
  const candidates = [
    creator.name,
    [creator.firstName, creator.lastName]
      .map(part => part?.trim() ?? '')
      .filter(Boolean)
      .join(' '),
    workspace.name,
  ]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed !== undefined && trimmed.length > 0 && !trimmed.includes('@')) return trimmed
  }
  return 'Duet workspace'
}

function publishSlug(slug: string): string {
  return PublishSlugSchema.parse(assertValidSlug(slug, 'publish'))
}

function trimSlugBase(rawBase: string): string {
  const base = rawBase.replace(/-+$/g, '') || 'publish'
  return base.length > MAX_SLUG_LENGTH ? base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') : base
}
