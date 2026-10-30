import {
  makeFunctionReference,
  paginationOptsValidator,
  type FunctionReference,
} from 'convex/server'
import { ConvexError, v } from 'convex/values'

import {
  deriveListingSourceUrl,
  ListingDerivedMetadataSchema,
  ListingSourceUrlSchema,
  MAX_APPS_PER_WORKSPACE,
} from '@repo/contract'
import { OFFICIAL_AGENTS_WORKSPACE_SLUG } from '@repo/official-agents-seed/manifest'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { edgeHost, marketplacePublishingEnabled } from '../../config'
import { requireApiInternalKey } from '../apiKeys/model'
import { createPublishImpl, publishOriginRefusal } from '../publishes/model'
import { isSharedResourcePathWithinShareRoot } from '../replication/shared'
import { assertActorRole } from '../workspaces/authorization'
import { releaseMarketplaceAgentOwnership } from './ownership'
import { liveSubscriptionsByWorkspace } from './subscriptions'

/**
 * Listing rows: identity, lookup, and the one place a listing's source URL is
 * resolved.
 *
 * The row stores `publishId`, never a copied publish slug — `publishes:updateSlug`
 * patches the publish row on its own, so a cached slug would silently rot the
 * moment a publisher renamed their publish.
 */

export type AgentListing = Doc<'agentListings'>

export async function listingByPublisherAndAgent(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; agentName: string },
): Promise<AgentListing | null> {
  return await ctx.db
    .query('agentListings')
    .withIndex('by_publisher_and_agent', q =>
      q.eq('workspaceId', args.workspaceId).eq('agentName', args.agentName),
    )
    .unique()
}

export async function listingByAnchor(
  ctx: QueryCtx | MutationCtx,
  anchorId: Id<'anchors'>,
): Promise<AgentListing | null> {
  return await ctx.db
    .query('agentListings')
    .withIndex('by_anchor', q => q.eq('anchorId', anchorId))
    .unique()
}

/**
 * `override ?? derived` — the ONE place that precedence is computed. A metadata
 * refresh writes `derived` and never touches the override columns, so a
 * publisher's explicit title survives every refresh.
 */
export function resolveListingMetadata(listing: AgentListing): {
  title: string
  summary: string
} {
  return {
    title: listing.titleOverride ?? listing.derived?.title ?? listing.agentName,
    summary: listing.summaryOverride ?? listing.derived?.summary ?? '',
  }
}

/**
 * Where a subscriber's gateway pulls this listing's archive from, and whether
 * the listing's recorded revision may be trusted to gate that pull.
 *
 * One function for both because deciding the second needs the publish row the
 * first already loads, and this runs in the VM sync path for every workspace on
 * every tick — a second read here is a fleet-wide cost.
 *
 * `edgeHost()` is called HERE rather than by the caller, and only once a
 * listing is actually being resolved: it throws when `DUET_EDGE_HOST` is unset.
 * An eager call would break `vmSync` fleet-wide on a deployment whose env has
 * not received the value yet; a lazy one leaves such a deployment merely unable
 * to serve listings.
 *
 * Returns null when the agent, its publish or its publisher has gone — a
 * stranded listing must project nothing rather than a broken URL.
 */
export async function resolveListingOrigin(
  ctx: QueryCtx | MutationCtx,
  listing: AgentListing,
): Promise<{ sourceUrl: string; contentRevision?: string } | null> {
  // The agent row, not the publish, is what proves the listed FOLDER still
  // exists: a parent-folder publish — the official hub, one publish shared by
  // every official agent — outlives any one agent below it, so a retired
  // agent's listing would go on naming a subpath whose bytes are gone, and
  // its subscribers would re-probe that URL forever, never converging.
  if ((await ctx.db.get(listing.agentId)) === null) return null
  const publish = await ctx.db.get(listing.publishId)
  if (publish === null) return null
  const workspace = await ctx.db.get(listing.workspaceId)
  if (workspace === null) return null
  const url = deriveListingSourceUrl({
    edgeHost: edgeHost(),
    publisherWorkspaceSlug: workspace.slug,
    publishSlug: publish.slug,
    agentSubpath: listing.agentSubpath,
  })
  // Re-validated before it can reach a VM: a malformed listing row must never
  // become a URL a gateway is asked to fetch.
  if (!ListingSourceUrlSchema.safeParse(url).success) return null
  // A PAUSED publish serves frozen bytes, and the revision describes the live
  // tree — so claiming a subscriber is up to date would claim it holds bytes it
  // has never seen. Unknown is the honest answer, and it costs one ordinary
  // revalidation.
  return {
    sourceUrl: url,
    ...(listing.contentRevision === undefined || publish.pausedAt !== undefined
      ? {}
      : { contentRevision: listing.contentRevision }),
  }
}

/** Typed refusals a caller can act on, never a bare Error string. */
export type ListingRefusal =
  | 'publishing_disabled'
  | 'listing_anchor_subscribed'
  | 'listing_already_exists'
  | 'reserved_title'
  | 'listing_not_found'

// Reserved for the verified publisher, so an unverified listing cannot claim
// the word the badge means. Whole-word and case-insensitive: "Duet Helper" is
// refused, "Duetify" is not.
const RESERVED_TITLE_WORDS = ['official', 'duet']

export function titleIsReserved(title: string): boolean {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return words.some(word => RESERVED_TITLE_WORDS.includes(word))
}

/**
 * Create the listing row for an agent whose eligibility the caller has already
 * proved with the gateway inspector, and whose publish it has already created.
 *
 * Idempotent on (workspaceId, agentName): re-registering returns the existing
 * listing rather than a second row.
 */
export async function registerListingImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    agentId: Id<'agents'>
    anchorId: Id<'anchors'>
    publishId: Id<'publishes'>
    agentName: string
    agentSubpath: string
    derived: {
      title: string
      summary: string
      skills: string[]
      changelog: string
      tags?: string[]
    }
    titleOverride?: string
    summaryOverride?: string
    actorId: Id<'users'>
    now: number
    publishingEnabled: boolean
  },
): Promise<{ listing: AgentListing } | { error: ListingRefusal }> {
  const derived = ListingDerivedMetadataSchema.parse(args.derived)
  // Enforced here rather than only at the route, so internal-admin and harness
  // callers are gated on the same line as the SPA.
  if (!args.publishingEnabled) return { error: 'publishing_disabled' }

  // You cannot list an agent you are subscribed to: it is not yours to offer.
  // A cloned agent (clone_once, then detached) has no live subscription and is.
  const subscriptions = await liveSubscriptionsByWorkspace(ctx, args.workspaceId)
  if (subscriptions.some(row => row.anchorId === args.anchorId)) {
    return { error: 'listing_anchor_subscribed' }
  }

  const title = args.titleOverride ?? args.derived.title
  if (titleIsReserved(title)) return { error: 'reserved_title' }

  const existing = await listingByPublisherAndAgent(ctx, {
    workspaceId: args.workspaceId,
    agentName: args.agentName,
  })
  if (existing !== null) {
    // Re-registration REPLACES identity, not just metadata. Deleting an agent
    // and recreating it under the same slug produces new agent/anchor/publish
    // rows, and keeping the old ones would leave the catalog pointing at a
    // publish that no longer resolves. Overrides are patched to `undefined`
    // when absent so removing a title actually removes it.
    await ctx.db.patch(existing._id, {
      agentId: args.agentId,
      anchorId: args.anchorId,
      publishId: args.publishId,
      agentSubpath: args.agentSubpath,
      titleOverride: args.titleOverride,
      summaryOverride: args.summaryOverride,
      derived,
      metadataRefreshedAt: args.now,
      state: 'listed',
      // A re-registration walked the origin successfully to get here, so the
      // listing is available again by construction.
      availability: 'available',
      unavailableSince: undefined,
      updatedAt: args.now,
    })
    return { listing: (await ctx.db.get(existing._id))! }
  }

  const listingId = await ctx.db.insert('agentListings', {
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    anchorId: args.anchorId,
    publishId: args.publishId,
    agentName: args.agentName,
    agentSubpath: args.agentSubpath,
    state: 'listed',
    availability: 'available',
    derived,
    metadataRefreshedAt: args.now,
    installs: 0,
    ...(args.titleOverride === undefined ? {} : { titleOverride: args.titleOverride }),
    ...(args.summaryOverride === undefined ? {} : { summaryOverride: args.summaryOverride }),
    createdByUserId: args.actorId,
    createdAt: args.now,
    updatedAt: args.now,
  })
  return { listing: (await ctx.db.get(listingId))! }
}

/**
 * Unlisting is not takedown: the listing leaves the catalog and refuses new
 * installs, but existing subscribers keep pulling. Only deleting the publish
 * strands them.
 */
export async function unlistListingImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    listingId: Id<'agentListings'>
    now: number
  },
): Promise<{ ok: true } | { error: ListingRefusal }> {
  const listing = await ctx.db.get(args.listingId)
  if (listing === null || listing.workspaceId !== args.workspaceId) {
    return { error: 'listing_not_found' }
  }
  await ctx.db.patch(listing._id, { state: 'unlisted', updatedAt: args.now })
  return { ok: true }
}

/** Catalog reads: Convex rows only, never a fetch to a publisher's VM. */
export async function listedCatalogImpl(
  ctx: QueryCtx,
  args: { limit: number },
): Promise<AgentListing[]> {
  return await ctx.db
    .query('agentListings')
    .withIndex('by_state_and_installs', q => q.eq('state', 'listed'))
    .order('desc')
    .take(args.limit)
}

export const unlistListing = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    listingId: v.id('agentListings'),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')
    const result = await unlistListingImpl(ctx, {
      ...args,
      now: args.now ?? Date.now(),
    })
    if ('error' in result) throw new ConvexError({ error: result.error })
    return result
  },
})

/** Catalog + publish capability in one read: one fetch, one owner. */
export const catalog = query({
  args: { internalKey: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const listings = await listedCatalogImpl(ctx, { limit: args.limit ?? 100 })
    const projected = []
    for (const listing of listings) {
      const workspace = await ctx.db.get(listing.workspaceId)
      if (workspace === null) continue
      projected.push({
        id: listing._id,
        publisherSlug: workspace.slug,
        verifiedPublisher: workspace.verifiedPublisherAt !== undefined,
        agentName: listing.agentName,
        ...resolveListingMetadata(listing),
        skills: listing.derived?.skills ?? [],
        tags: listing.derived?.tags ?? [],
        // The stamped column, never a walk: the catalog is the whole-catalog
        // read and must stay O(listings). Unstamped reads as "no apps yet".
        appNames: listing.appNames ?? [],
        installs: listing.installs,
        availability: listing.availability,
      })
    }
    return {
      listings: projected,
      canPublishListings: marketplacePublishingEnabled(),
    }
  },
})

/** Bounded catalog source for the public API; its continuation is never exposed raw. */
export const catalogPage = query({
  args: { internalKey: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const result = await ctx.db
      .query('agentListings')
      .withIndex('by_state_and_installs', q => q.eq('state', 'listed'))
      .order('desc')
      .paginate(args.paginationOpts)
    const page = []
    for (const listing of result.page) {
      const workspace = await ctx.db.get(listing.workspaceId)
      if (workspace === null) continue
      page.push({
        id: listing._id,
        publisherSlug: workspace.slug,
        verifiedPublisher: workspace.verifiedPublisherAt !== undefined,
        agentName: listing.agentName,
        ...resolveListingMetadata(listing),
        skills: listing.derived?.skills ?? [],
        tags: listing.derived?.tags ?? [],
        appNames: listing.appNames ?? [],
        installs: listing.installs,
        availability: listing.availability,
      })
    }
    return {
      ...result,
      page,
      canPublishListings: marketplacePublishingEnabled(),
    }
  },
})

export const detail = query({
  args: {
    internalKey: v.string(),
    publisherSlug: v.string(),
    agentName: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', args.publisherSlug).eq('status', 'active'))
      .first()
    if (workspace === null) return null
    const listing = await listingByPublisherAndAgent(ctx, {
      workspaceId: workspace._id,
      agentName: args.agentName,
    })
    // An unlisted or removed listing is not browsable; existing subscribers
    // still poll it, but it has left the catalog.
    if (listing === null || listing.state !== 'listed') return null
    // One listing, so a live walk is affordable here — and it keeps the
    // declarations and the display names derived from the same app rows.
    const { apps } = await containedAppsForListing(ctx, listing)
    return {
      id: listing._id,
      publisherSlug: workspace.slug,
      verifiedPublisher: workspace.verifiedPublisherAt !== undefined,
      agentName: listing.agentName,
      ...resolveListingMetadata(listing),
      skills: listing.derived?.skills ?? [],
      tags: listing.derived?.tags ?? [],
      changelog: listing.derived?.changelog ?? '',
      appNames: appDisplayNames(apps),
      installs: listing.installs,
      availability: listing.availability,
      apps: projectAppDeclarations(apps),
    }
  },
})

/**
 * Resolve the agent a publisher is offering, and prepare the publish its
 * listing will be served from.
 *
 * The publish is created on the agent's OWN anchor (`createPublishImpl` accepts
 * an existing agent anchor and returns the attached publish idempotently), so
 * the archive sits at the publish root and the listing's `agentSubpath` is ''.
 * That is the layout slice 00 proved.
 */
export const registerListingFromAgent = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    agentSlug: v.string(),
    derived: v.object({
      title: v.string(),
      summary: v.string(),
      skills: v.array(v.string()),
      changelog: v.string(),
      tags: v.optional(v.array(v.string())),
    }),
    titleOverride: v.optional(v.string()),
    summaryOverride: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')
    const now = args.now ?? Date.now()

    // The gate is checked before anything is created, so a refused
    // registration cannot leave a public publish behind.
    if (!marketplacePublishingEnabled()) throw new ConvexError({ error: 'publishing_disabled' })

    const agent = await ctx.db
      .query('agents')
      .withIndex('by_workspace_and_slug', q =>
        q.eq('workspaceId', args.workspaceId).eq('slug', args.agentSlug),
      )
      .unique()
    if (agent === null || agent.disabledAt !== undefined) {
      throw new ConvexError({ error: 'listing_not_found' })
    }
    const anchor = await ctx.db.get(agent.anchorId)
    if (anchor === null || anchor.state !== 'active') {
      throw new ConvexError({ error: 'listing_not_found' })
    }

    const publish = await createPublishImpl(ctx, {
      workspaceId: args.workspaceId,
      path: anchor.path,
      kind: 'folder',
      actorId: args.actorId,
      now,
    })
    const result = await registerListingImpl(ctx, {
      workspaceId: args.workspaceId,
      agentId: agent._id,
      anchorId: agent.anchorId,
      publishId: publish.id as Id<'publishes'>,
      agentName: args.agentSlug,
      agentSubpath: '',
      derived: args.derived,
      ...(args.titleOverride === undefined ? {} : { titleOverride: args.titleOverride }),
      ...(args.summaryOverride === undefined ? {} : { summaryOverride: args.summaryOverride }),
      actorId: args.actorId,
      now,
      publishingEnabled: true,
    })
    if ('error' in result) throw new ConvexError({ error: result.error })
    return result.listing
  },
})

/**
 * The ONE resolver from an official agent's name to its listing.
 *
 * Onboarding and campaign mappings both pass bare names, and both must land in
 * the workspace with the fixed official slug. Community publishers may use the same agent
 * name, so verification alone is not identity.
 */
export const officialListingIdsByName = query({
  args: { internalKey: v.string(), names: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const hub = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q =>
        q.eq('slug', OFFICIAL_AGENTS_WORKSPACE_SLUG).eq('status', 'active'),
      )
      .first()
    const resolved: Array<{
      name: string
      listingId: Id<'agentListings'> | null
    }> = []
    for (const name of args.names) {
      const listing =
        hub === null
          ? null
          : await listingByPublisherAndAgent(ctx, {
              workspaceId: hub._id,
              agentName: name,
            })
      resolved.push({
        name,
        listingId: listing?.state === 'listed' ? listing._id : null,
      })
    }
    return resolved
  },
})

/**
 * THE contained-app owner. Every consumer — the consent sheet's projection,
 * the declaration-revision fingerprint, and the subscriber's app convergence —
 * derives from this one walk, so they can never disagree about which of a
 * publisher's apps belong to a listing.
 *
 * The workspace-wide scan reads one overflow witness and refuses a corrupt
 * over-cap workspace before joining anchors. Containment then selects the apps
 * under this listing; it needs no second capacity because a contained set cannot
 * exceed its workspace.
 */
export async function containedAppsForListing(
  ctx: QueryCtx | MutationCtx,
  listing: AgentListing,
): Promise<{
  rootPath: string
  apps: Array<{ app: Doc<'apps'>; anchor: Doc<'anchors'> }>
  // Documents this walk actually read, so a batch caller can budget against the
  // transaction's read ceiling. It counts SCANNED rows, not contained ones: the
  // publisher's whole app list is read either way, and that is the cost.
  documentsRead: number
}> {
  const listingAnchor = await ctx.db.get(listing.anchorId)
  if (listingAnchor === null || listingAnchor.state !== 'active') {
    return { rootPath: '', apps: [], documentsRead: 1 }
  }
  const rootPath = listingAnchor.path
  const publisherApps = await ctx.db
    .query('apps')
    .withIndex('by_workspace', q => q.eq('workspaceId', listing.workspaceId))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  if (publisherApps.length > MAX_APPS_PER_WORKSPACE) {
    throw new Error('Workspace app limit exceeded')
  }
  const apps: Array<{ app: Doc<'apps'>; anchor: Doc<'anchors'> }> = []
  for (const app of publisherApps) {
    if (app.disabledAt !== undefined) continue
    const anchor = await ctx.db.get(app.anchorId)
    if (
      anchor !== null &&
      anchor.state === 'active' &&
      isSharedResourcePathWithinShareRoot(anchor.path, rootPath)
    ) {
      apps.push({ app, anchor })
    }
  }
  apps.sort((left, right) => left.anchor.path.localeCompare(right.anchor.path))
  // 1 listing anchor + every publisher app row scanned + one anchor per
  // non-disabled app.
  return {
    rootPath,
    apps,
    documentsRead: 1 + publisherApps.length + apps.length,
  }
}

/**
 * The app declarations a subscriber of this listing would run: the exact
 * commands and scopes the consent sheet has to show. A pure projection of the
 * walk's rows, so callers pay for `containedAppsForListing` exactly once.
 */
function projectAppDeclarations(apps: Array<{ app: Doc<'apps'>; anchor: Doc<'anchors'> }>): Array<{
  path: string
  command: string
  installCommand?: string
  apiScopes: string[]
}> {
  return apps.map(({ app, anchor }) => ({
    path: anchor.path,
    command: app.command,
    ...(app.installCommand === undefined ? {} : { installCommand: app.installCommand }),
    apiScopes: [...app.apiScopes].sort(),
  }))
}

/**
 * What the listing's apps are CALLED — browsing metadata, distinct from the
 * declarations above, which are what a subscriber would run. Derived from the
 * same walk, already path-ordered by `containedAppsForListing`.
 */
function appDisplayNames(apps: Array<{ app: Doc<'apps'> }>): string[] {
  return apps.map(({ app }) => app.name ?? app.slug)
}

/**
 * A stable fingerprint of a listing's app DECLARATIONS — the commands and
 * scopes a subscriber would run — independent of file content.
 *
 * Files are clocked by the stat-derived ETag; declarations live in the
 * publisher's Convex `apps` rows, which that ETag cannot see. Two clocks, one
 * convergence function.
 */
export async function computeAppDeclarationRevision(
  ctx: QueryCtx | MutationCtx,
  listing: AgentListing,
): Promise<{ revision: string; appNames: string[]; documentsRead: number }> {
  const { apps, documentsRead } = await containedAppsForListing(ctx, listing)
  const declarations = apps.map(({ app, anchor }) =>
    JSON.stringify([anchor.path, app.command, app.installCommand ?? '', [...app.apiScopes].sort()]),
  )
  const declarationBytes = new TextEncoder().encode(declarations.sort().join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', declarationBytes)
  const revision = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return {
    // Sorted so row order can never change the fingerprint.
    revision: declarations.length === 0 ? 'none' : revision,
    // Rides the walk the fingerprint already paid for, but stays OUT of the
    // fingerprint itself: the revision drives subscriber convergence, and a
    // display-name change is catalog copy, not a declaration change.
    appNames: appDisplayNames(apps),
    // What this listing COST, so a batch pass can stop before it exceeds the
    // transaction's read ceiling. Reported rather than inferred: only the walk
    // knows how large the publisher's app list actually was.
    documentsRead,
  }
}

/**
 * Availability has exactly ONE writer: this sweep. (The app-declaration
 * fingerprint has its own, `sweepListingAppDeclarations` below — same reasoning,
 * separate pass because its cost per listing is unbounded.)
 *
 * Both are derived from the publisher's own rows, so they need a server-side
 * pass on a schedule rather than an event on some writer's path. Having a
 * scheduled owner at all is what keeps them alive: a recompute helper called
 * only from tests moves the fingerprint function but never the stored column,
 * and the clock reads dead in production while its unit test passes.
 *
 * A subscriber's pull report moves its own subscription and NOTHING else —
 * otherwise a single hostile installer could grey out a rival's listing by
 * reporting failures. So availability is derived server-side, from facts the
 * backend already owns, on a schedule:
 *
 * - the publisher's workspace is no longer active (idle-retired, archived,
 *   deleted) — the edge has nothing to serve from;
 * - the listing's publish row is gone — the URL would 404;
 * - the listed anchor is gone or inactive — there is no agent folder left;
 * - the derived source URL fails its own schema — a malformed row.
 *
 * Recovery is automatic: a retired workspace that wakes flips straight back to
 * `available` on the next sweep, so nothing has to be re-listed by hand.
 *
 * Deliberately bounded and cursor-free: it re-scans the listed catalog, which
 * is small by construction (the `by_state_and_installs` index) and cheap
 * compared with carrying a cursor that could skip a dead listing for a cycle.
 */
export const sweepListingAvailability = mutation({
  args: {
    internalKey: v.string(),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const now = args.now ?? Date.now()
    // LEAST-RECENTLY-CHECKED FIRST, never a fixed prefix. Taking the first N of
    // a stable order re-scans the same rows every run, so past N listings the
    // rest never get a verdict at all: a dead publisher stays installable and a
    // recovered one stays greyed, both forever and both silently. Ordering by
    // the check stamp makes the window walk the whole catalog on its own —
    // absent stamps sort first, so a new listing is picked up on the next tick.
    const listings = await ctx.db
      .query('agentListings')
      .withIndex('by_state_and_availability_checked', q => q.eq('state', 'listed'))
      .order('asc')
      .take(args.limit ?? 500)
    let changed = 0
    for (const listing of listings) {
      const availability = (await listingIsServable(ctx, listing)) ? 'available' : 'unavailable'
      if (listing.availability === availability) {
        // Still stamp it, or an unchanged listing never advances and the window
        // cannot move past it.
        await ctx.db.patch(listing._id, { availabilityCheckedAt: now })
        continue
      }
      changed += 1
      await ctx.db.patch(listing._id, {
        availabilityCheckedAt: now,
        availability,
        ...(availability === 'unavailable'
          ? { unavailableSince: listing.unavailableSince ?? now }
          : { unavailableSince: undefined }),
        updatedAt: now,
      })
    }
    return { scanned: listings.length, changed }
  },
})

/**
 * The app-declaration fingerprint's own pass — deliberately NOT folded into the
 * availability sweep.
 *
 * Fingerprinting one listing reads its publisher's entire app list, so doing it
 * for the whole catalog in one go costs O(listings x publisher apps). A Convex
 * mutation is a single transaction with a document-read ceiling; exceed it and
 * the pass fails ENTIRELY, nothing is stamped, the least-recently-checked
 * ordering re-selects the same rows, and the catalog stalls silently forever.
 * So this pass spends a read BUDGET rather than a listing count — a fixed page
 * size cannot bound it, because one publisher with 100 apps can consume most of the
 * ceiling on its own.
 *
 * Rotation runs off `appDeclarationCheckedAt`, a stamp of its own. Sharing the
 * availability stamp would make a budgeted pass cut at the same relative
 * position every time and starve the tail of the catalog.
 */
export const sweepListingAppDeclarations = mutation({
  args: {
    internalKey: v.string(),
    limit: v.optional(v.number()),
    readBudget: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const now = args.now ?? Date.now()
    const budget = args.readBudget ?? 4_000
    const listings = await ctx.db
      .query('agentListings')
      .withIndex('by_state_and_declaration_checked', q => q.eq('state', 'listed'))
      .order('asc')
      .take(args.limit ?? 200)
    let spent = 0
    let scanned = 0
    let changed = 0
    for (const listing of listings) {
      // Checked BEFORE the walk, and never mid-walk: a listing is either paid
      // for in full or left for the next pass. Stopping halfway would stamp a
      // fingerprint computed from a partial app list.
      if (spent >= budget) break
      scanned += 1
      try {
        const { revision, appNames, documentsRead } = await computeAppDeclarationRevision(
          ctx,
          listing,
        )
        spent += documentsRead
        // Names are compared on their own: a display-name change moves no
        // declaration, so the revision cannot see it, and vice versa.
        const namesChanged =
          appNames.length !== (listing.appNames?.length ?? 0) ||
          appNames.some((name, index) => name !== listing.appNames?.[index])
        await ctx.db.patch(listing._id, {
          appDeclarationCheckedAt: now,
          ...(revision === listing.appDeclarationRevision && !namesChanged
            ? {}
            : { appDeclarationRevision: revision, appNames, updatedAt: now }),
        })
        if (revision !== listing.appDeclarationRevision || namesChanged) changed += 1
      } catch {
        // ISOLATED, like `listingIsServable`'s own catch: one malformed listing
        // must not abort the pass and strand every listing behind it. Stamp it
        // so rotation moves past it and the rest of the catalog still converges.
        await ctx.db.patch(listing._id, { appDeclarationCheckedAt: now })
      }
    }
    return { scanned, changed, documentsRead: spent }
  },
})

async function listingIsServable(
  ctx: QueryCtx | MutationCtx,
  listing: AgentListing,
): Promise<boolean> {
  const workspace = await ctx.db.get(listing.workspaceId)
  if (workspace === null || workspace.status !== 'active') return false
  const publish = await ctx.db.get(listing.publishId)
  if (publish === null) return false
  // ONE owner for "would this origin serve its archive?" — shared with the edge
  // resolver. A shorter local copy is how a paused or suspended publisher came
  // to read as `available` and admit installs that could never pull.
  if ((await publishOriginRefusal(ctx, workspace, publish)) !== null) return false
  const anchor = await ctx.db.get(listing.anchorId)
  if (anchor === null || anchor.state !== 'active') return false
  // `resolveListingOrigin` calls `edgeHost()`, which fails closed on a deployment
  // that has not received DUET_EDGE_HOST. That is a deployment fault, not a
  // publisher fault, so it must not grey the whole catalog: treat a throw as
  // "no verdict" and leave the listing as it is.
  try {
    return (await resolveListingOrigin(ctx, listing)) !== null
  } catch {
    return listing.availability === 'available'
  }
}

/**
 * Takedown: refusal is immediate, detachment is drained.
 *
 * `state: 'removed'` blocks projection and new installs on the next read, so
 * the listing is dead the moment this returns. Detaching its subscribers is
 * then drained through `by_listing_and_state` in bounded batches — a popular listing
 * could have thousands, and one unbounded mutation would blow Convex's limits
 * exactly when you most need the takedown to land.
 */
export const takedownListing = mutation({
  args: {
    internalKey: v.string(),
    listingId: v.id('agentListings'),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await takedownListingImpl(ctx, args)
  },
})

/**
 * Takedown: refusal is immediate, detachment drains itself.
 *
 * `state: 'removed'` blocks projection and new installs on the next read, so the
 * listing is dead the moment this returns. Detaching its subscribers is then
 * drained through `by_listing_and_state` in bounded batches — a popular listing could have
 * thousands, and one unbounded mutation would blow Convex's limits exactly when
 * you most need the takedown to land.
 *
 * The drain CONTINUES ITSELF rather than returning `remaining` to a caller that
 * has to loop. It previously did the latter and had no production caller at all,
 * so every subscriber past the first batch kept marketplace ownership of their
 * agent and contained apps indefinitely.
 */
export async function takedownListingImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    listingId: Id<'agentListings'>
    limit?: number
    now?: number
  },
): Promise<{ detached: number; remaining: boolean }> {
  const now = args.now ?? Date.now()
  const limit = args.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid takedown batch limit')
  }
  const listing = await ctx.db.get(args.listingId)
  if (listing === null) return { detached: 0, remaining: false }
  if (listing.state !== 'removed') {
    await ctx.db.patch(listing._id, {
      state: 'removed',
      installs: 0,
      updatedAt: now,
    })
  }
  const states = ['installing', 'active', 'error'] as const
  const draining: Doc<'agentSubscriptions'>[] = []
  let remaining = false
  for (const state of states) {
    const available = limit - draining.length
    const batch = await ctx.db
      .query('agentSubscriptions')
      .withIndex('by_listing_and_state', q => q.eq('listingId', args.listingId).eq('state', state))
      .take(available + 1)
    draining.push(...batch.slice(0, available))
    if (batch.length > available) {
      remaining = true
      break
    }
  }
  for (const subscription of draining) {
    // Files stay: takedown is a detach, never a remote delete.
    await releaseMarketplaceAgentOwnership(ctx, subscription, now)
    await ctx.db.patch(subscription._id, { state: 'detached', updatedAt: now })
  }
  if (remaining) {
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference(
        'domains/marketplace/listings:takedownListing',
      ) as FunctionReference<'mutation'>,
      { internalKey: args.internalKey, listingId: args.listingId, limit },
    )
  }
  return { detached: draining.length, remaining }
}
