import { ConvexError, v } from 'convex/values'

import {
  AgentNameSchema,
  AppSlugSchema,
  DriveRelativePathSchema,
  MAX_AGENTS_PER_WORKSPACE,
  MAX_APPS_PER_WORKSPACE,
  MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE,
  MarketplaceAgentPullReportSchema,
  MarketplaceAgentNameSchema,
  marketplaceAgentInstallPath,
  type MarketplaceAgentMutationError,
  type MarketplaceAgentPullReport,
  type MarketplaceAgentSubscription,
  type VmDesiredMarketplaceAgents,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { registerAgentImpl } from '../agents/model'
import { requireApiInternalKey } from '../apiKeys/model'
import { registerAppImpl } from '../apps/model'
import { deleteAppRow } from '../apps/teardown'
import { writeAuditEvent } from '../audit/model'
import {
  availableSharedReplicaSlug,
  translateSharedResourcePathToMount,
} from '../replication/shared'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { containedAppsForListing, resolveListingOrigin } from './listings'
import {
  adjustInstallCount,
  detachMarketplaceAgentSubscription,
  releaseMarketplaceAgentOwnership,
} from './ownership'
import { liveSubscriptionsByWorkspace } from './subscriptions'

export const marketplacePullReportValidator = v.union(
  v.object({
    subscriptionId: v.string(),
    state: v.literal('active'),
    appliedEtag: v.string(),
    lastAppliedAt: v.number(),
  }),
  v.object({
    subscriptionId: v.string(),
    state: v.literal('error'),
    lastErrorCode: v.string(),
    // Additive: a closed validator that omits a field the wire now carries
    // rejects the whole sync, so this must track the zod shape exactly.
    observedAt: v.optional(v.number()),
  }),
)

const actorArgs = {
  workspaceId: v.id('workspaces'),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
}

export const desiredForVm = query({
  args: { internalKey: v.string(), vmTokenHash: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_vmTokenHash', q => q.eq('vmTokenHash', args.vmTokenHash))
      .unique()
    if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
      throw new Error('Invalid VM token')
    }
    return (await projectMarketplaceAgentsForWorkspace(ctx, workspace._id)) ?? null
  },
})

export const install = mutation({
  args: {
    ...actorArgs,
    listingId: v.id('agentListings'),
    // What the installer calls this agent. Optional everywhere: the install
    // dialog always asks, but declining to type one is an answer, and a
    // campaign or starter-agent install has nobody to ask at all. Both land on
    // the listing's slug below — one fallback, owned here rather than by each
    // caller.
    name: v.optional(v.string()),
    // Rename-on-collision target: the canonical `agents/<name>` refused with
    // `path_exists`, and the user chose another path — still a subscription.
    path: v.optional(v.string()),
    // The surface that asked, for analytics only — it changes nothing about
    // the subscription. See `installSource` for what absence means.
    source: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actorId = await mutationActor(ctx, args)
    return await createSubscription(ctx, {
      workspaceId: args.workspaceId,
      listingId: args.listingId,
      ...(args.name === undefined ? {} : { name: AgentNameSchema.parse(args.name) }),
      ...(args.path === undefined ? {} : { path: DriveRelativePathSchema.parse(args.path) }),
      mode: 'subscribe',
      source: installSource(args.source),
      actorId,
      now: args.now ?? Date.now(),
    })
  },
})

export const clone = mutation({
  args: {
    ...actorArgs,
    listingId: v.id('agentListings'),
    path: v.string(),
    source: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actorId = await mutationActor(ctx, args)
    return await createSubscription(ctx, {
      workspaceId: args.workspaceId,
      listingId: args.listingId,
      path: DriveRelativePathSchema.parse(args.path),
      mode: 'clone_once',
      source: installSource(args.source),
      actorId,
      now: args.now ?? Date.now(),
    })
  },
})

export const uninstall = mutation({
  args: {
    ...actorArgs,
    subscriptionId: v.id('agentSubscriptions'),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await mutationActor(ctx, args)
    const subscription = await requireWorkspaceSubscription(
      ctx,
      args.workspaceId,
      args.subscriptionId,
    )
    const now = args.now ?? Date.now()
    await detachMarketplaceAgentSubscription(ctx, subscription, now)
    return { ok: true as const }
  },
})

export const acknowledge = mutation({
  args: {
    ...actorArgs,
    subscriptionId: v.id('agentSubscriptions'),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await mutationActor(ctx, args)
    const subscription = await requireWorkspaceSubscription(
      ctx,
      args.workspaceId,
      args.subscriptionId,
    )
    await ctx.db.patch(subscription._id, {
      acknowledgedEtag: subscription.appliedEtag,
      updatedAt: args.now ?? Date.now(),
    })
    return toSubscription(await requireSubscription(ctx, subscription._id))
  },
})

export const listByWorkspace = query({
  args: { workspaceId: v.id('workspaces'), internalKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.internalKey === undefined) await assertRole(ctx, args.workspaceId, 'viewer')
    else requireApiInternalKey(args.internalKey)
    const subscriptions = await liveSubscriptionsByWorkspace(ctx, args.workspaceId)
    subscriptions.sort(compareSubscriptionOrder)
    return subscriptions.map(toSubscription)
  },
})

export const applyPullReports = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    reports: v.array(marketplacePullReportValidator),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const result = await applyPullReportsImpl(ctx, {
      workspaceId: args.workspaceId,
      reports: args.reports as MarketplaceAgentPullReport[],
      now: args.now ?? Date.now(),
    })
    const subscriptions: MarketplaceAgentSubscription[] = []
    for (const subscriptionId of new Set(args.reports.map(report => report.subscriptionId))) {
      const subscription = await ctx.db.get(subscriptionId as Id<'agentSubscriptions'>)
      if (subscription?.workspaceId === args.workspaceId) {
        subscriptions.push(toSubscription(subscription))
      }
    }
    return { ok: true as const, ...result, subscriptions }
  },
})

export async function applyPullReportsImpl(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; reports: MarketplaceAgentPullReport[]; now: number },
): Promise<{ rejectedStaleSubscriptionIds: string[] }> {
  if (args.reports.length > MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE) {
    throw new Error('Too many marketplace agent pull reports')
  }
  const reports = args.reports.map(report => MarketplaceAgentPullReportSchema.parse(report))
  const latest = new Map(reports.map(report => [report.subscriptionId, report]))
  const rejectedStaleSubscriptionIds: string[] = []
  for (const report of latest.values()) {
    const subscription = await ctx.db.get(report.subscriptionId as Id<'agentSubscriptions'>)
    if (subscription === null || subscription.workspaceId !== args.workspaceId) continue
    if (subscription.state === 'detached') continue
    if (report.state === 'error') {
      // Same stale-report rule the active branch gets: an error observed BEFORE
      // the last thing this subscription successfully applied is old news, and
      // applying it would move a healthy subscription to `error` until the next
      // poll corrected it. Install pushes a pull while the recurring VM sync is
      // in flight, so this overlap is arranged by design, not rare.
      if (
        report.observedAt !== undefined &&
        subscription.lastAppliedAt !== undefined &&
        report.observedAt < subscription.lastAppliedAt
      ) {
        rejectedStaleSubscriptionIds.push(report.subscriptionId)
        continue
      }
      await ctx.db.patch(subscription._id, {
        state: 'error',
        lastErrorCode: report.lastErrorCode,
        updatedAt: args.now,
      })
      // Retire on the failure path too, or a dropped app deadlocks the
      // subscription: the VM applies the tree (the app's files go), reconciles
      // apps from rows that still name it, and the install command fails
      // against a directory with no manifest. That failure is reported here —
      // and if retirement only ran on success, the row that caused it would
      // survive to cause it again on every poll, with no way out but
      // uninstalling.
      //
      // Only the DROP half runs here. Materialising an app from a pull that
      // did not land would be claiming content the VM never wrote; removing one
      // the publisher no longer ships is bookkeeping against the listing, which
      // a failed pull does not make less true.
      await retireDroppedApps(ctx, subscription, args.now)
      continue
    }
    if (
      subscription.lastAppliedAt !== undefined &&
      report.lastAppliedAt < subscription.lastAppliedAt
    ) {
      rejectedStaleSubscriptionIds.push(report.subscriptionId)
      continue
    }
    // TWO CLOCKS. `appliedEtag` covers files; `appliedAppRevision` covers the
    // publisher's app declarations, which the stat-derived ETag cannot see. A
    // publisher who changes only a command or a scope moves the second clock
    // and nothing else — before this, that change reached installers only if
    // some file happened to change too.
    const listing = await ctx.db.get(subscription.listingId)
    const desiredAppRevision = listing?.appDeclarationRevision
    const filesUnchanged = subscription.appliedEtag === report.appliedEtag
    const declarationsUnchanged =
      desiredAppRevision === undefined || desiredAppRevision === subscription.appliedAppRevision
    if (filesUnchanged && declarationsUnchanged) {
      if (subscription.state !== 'active') {
        await ctx.db.patch(subscription._id, {
          state: 'active',
          lastAppliedAt: report.lastAppliedAt,
          lastErrorCode: undefined,
          updatedAt: args.now,
        })
      }
      continue
    }
    // One subscription's apply failing is that subscription's problem alone.
    // These reports ride the workspace's recurring VM sync, so a throw escaping
    // this loop would 500 every poll and halt the whole sync loop — the error
    // lands on the subscription's own row instead, where the UI surfaces it,
    // and the rest of the batch still applies. (Convex has no savepoints: a
    // partial apply keeps its writes, and the idempotent re-register on the
    // next successful pull completes them.)
    try {
      await syncContainedApps(ctx, subscription, report.appliedEtag, args.now)
      await ctx.db.patch(subscription._id, {
        state: subscription.mode === 'clone_once' ? 'detached' : 'active',
        appliedEtag: report.appliedEtag,
        // The FIRST apply is the install itself: the user asked for exactly
        // this revision, so it arrives already read — without this, a card
        // install (which never lands on the self-acknowledging detail page)
        // shows "update available" the moment it finishes. Later applies
        // leave the receipt alone; that difference IS the unread badge.
        ...(subscription.appliedEtag === undefined ? { acknowledgedEtag: report.appliedEtag } : {}),
        ...(desiredAppRevision === undefined ? {} : { appliedAppRevision: desiredAppRevision }),
        lastAppliedAt: report.lastAppliedAt,
        lastErrorCode: undefined,
        updatedAt: args.now,
      })
      if (subscription.mode === 'clone_once') {
        await releaseMarketplaceAgentOwnership(ctx, subscription, args.now)
      }
    } catch (error) {
      console.error('marketplace subscription apply failed', {
        subscriptionId: subscription._id,
        error: error instanceof Error ? error.message : String(error),
      })
      await ctx.db.patch(subscription._id, {
        state: 'error',
        lastErrorCode: 'apply_failed',
        updatedAt: args.now,
      })
    }
  }
  return { rejectedStaleSubscriptionIds }
}

/**
 * How long a subscriber may wait between revalidations once IT has decided its
 * cached snapshot is already at the projected revision.
 *
 * What this number really bounds is how stale a hub agent may be when its bytes
 * changed WITHOUT the sync press — a hand-edit on the hub drive — because a
 * press moves the revision and reaches every subscriber on the next 5s sync.
 * It is projected rather than compiled into the VM so that arguing about it
 * later is a deploy, not a fleet release — but the VM clamps whatever it is
 * handed into `[30 min, 24 h]` (`revalidateIntervalFor` in the gateway's
 * `marketplace/puller.ts`), so a value outside that range is silently pinned to
 * the bound rather than honoured. Widening the range is a gateway release.
 */
export const GATED_REVALIDATE_INTERVAL_MS = 12 * 60 * 60 * 1_000

export async function projectMarketplaceAgentsForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<VmDesiredMarketplaceAgents | undefined> {
  const subscriptions = await liveSubscriptionsByWorkspace(ctx, workspaceId)
  if (subscriptions.length === 0) return undefined

  const projected = []
  for (const subscription of subscriptions) {
    if (subscription.anchorId === undefined) continue
    const listing = await ctx.db.get(subscription.listingId)
    // A removed listing stops projecting immediately; an unlisted one keeps
    // flowing, because unlisting is not takedown.
    if (listing === null || listing.state === 'removed') continue
    // edgeHost() is only reached from in here — inside a loop that runs only
    // when a workspace actually has subscriptions — so a deployment without
    // DUET_EDGE_HOST cannot serve listings but also cannot break vmSync.
    const origin = await resolveListingOrigin(ctx, listing)
    if (origin === null) continue
    projected.push({
      subscriptionId: subscription._id as string,
      listingId: listing._id as string,
      agentName: MarketplaceAgentNameSchema.parse(listing.agentName),
      sourceUrl: origin.sourceUrl,
      path: subscription.path,
      anchorId: subscription.anchorId as string,
      mode: subscription.mode,
      // Absent is a state, not a default: the key is omitted rather than sent
      // as undefined, because absence is what tells the subscriber to
      // revalidate exactly as it does today.
      // BOTH OR NEITHER, and the gateway relies on it: without a revision the
      // subscriber can never decide it is in sync, and without an interval it
      // refuses to invent one, so either half alone gates nothing.
      ...(origin.contentRevision === undefined
        ? {}
        : {
            contentRevision: origin.contentRevision,
            revalidateAfterMs: GATED_REVALIDATE_INTERVAL_MS,
          }),
    })
  }
  return { subscriptions: projected }
}

async function createSubscription(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    listingId: Id<'agentListings'>
    /** The installer's display name; absent for an install nobody is watching. */
    name?: string
    path?: string
    mode: 'subscribe' | 'clone_once'
    source: string
    actorId: Id<'users'>
    now: number
  },
): Promise<MarketplaceAgentSubscription> {
  const listing = await ctx.db.get(args.listingId)
  // "Removed" covers both a takedown and a listing that never existed: from
  // the installer's side those are the same fact, and distinguishing them
  // would tell a caller whether an id they guessed is real.
  if (listing === null || listing.state !== 'listed') refuse({ error: 'listing_removed' })
  if (listing.availability !== 'available') refuse({ error: 'listing_unavailable' })
  const agentName = MarketplaceAgentNameSchema.parse(listing.agentName)
  const path = args.path ?? marketplaceAgentInstallPath(agentName)
  const existing = (await liveSubscriptionsByWorkspace(ctx, args.workspaceId)).find(
    subscription => subscription.path === path,
  )
  // REPLAY IDENTITY IS (workspace, LISTING, canonical path, subscribe) — not
  // the agent's name. Two publishers may ship `research-assistant`; comparing
  // names would silently adopt the other publisher's subscription.
  if (args.mode === 'subscribe' && path === marketplaceAgentInstallPath(agentName)) {
    if (
      existing !== undefined &&
      existing.listingId === listing._id &&
      existing.mode === 'subscribe'
    ) {
      return toSubscription(existing)
    }
  }
  /* The collision check guards LIVE CLAIMS on the path, not drive contents —
     a plain folder with no rows at all sails through it, so a row without a
     claim must too, or the two states refuse differently for no one's
     protection. Two tombstones therefore do not hold a path:

     - an ORPHANED anchor is one nothing consumes any more — its agent or app
       was deleted, or the reaper confirmed the folder gone;
     - a DETACHED subscription is an uninstall, a takedown, or a VM that lost
       the files, and every other reader in this domain already excludes it.

     Counting them left a workspace whose VM was reset refusing its own
     canonical paths forever: eight orphaned anchors and four detached
     subscriptions on an empty drive, and the collision dialog offering a
     rename for folders that did not exist. */
  const anchor = await ctx.db
    .query('anchors')
    .withIndex('by_workspace_and_path', q => q.eq('workspaceId', args.workspaceId).eq('path', path))
    .unique()
  if ((anchor !== null && anchor.state !== 'orphaned') || existing !== undefined) {
    refuse({ error: 'path_exists', path, renameRequired: true })
  }
  const subscriptionId = await ctx.db.insert('agentSubscriptions', {
    workspaceId: args.workspaceId,
    listingId: listing._id,
    agentName,
    path,
    mode: args.mode,
    state: 'installing',
    createdByUserId: args.actorId,
    createdAt: args.now,
    updatedAt: args.now,
  })
  // The AGENT SLUG is workspace-unique, so it cannot simply be the listing's
  // agent name: two publishers ship `research-assistant`, the second install
  // lands at a renamed path, and reusing the name would throw an untyped
  // "Agent slug already exists" 500 instead of installing. The chosen folder is
  // the natural identity — it is already proven free by the path check above —
  // and the shared replica helper resolves the remaining case where that
  // folder name is taken as a slug by an agent living somewhere else.
  const slug = await availableAgentSlug(ctx, args.workspaceId, path, agentName)
  let registered: Awaited<ReturnType<typeof registerAgentImpl>>
  try {
    registered = await registerAgentImpl(ctx, {
      workspaceId: args.workspaceId,
      path,
      slug,
      // Display metadata, chosen per install. Absent means the installer did
      // not want to type one, so the agent wears the listing's slug — which is
      // also what an unattended install (a campaign link, a signup's starter
      // agents) gets, since there is nobody there to ask.
      //
      // The subscription's `agentName` above is that same slug but a DIFFERENT
      // field: it is the publisher's identity and what path and replay logic
      // key on, and it stays put when the installer renames their copy.
      name: args.name ?? agentName,
      actorId: args.actorId,
      now: args.now,
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Workspace agent limit exceeded')) {
      refuse({ error: 'agent_limit_exceeded' })
    }
    throw error
  }
  const agentId = registered.id as Id<'agents'>
  const anchorId = registered.anchorId as Id<'anchors'>
  await ctx.db.patch(agentId, { listingSubscriptionId: subscriptionId })
  await ctx.db.patch(subscriptionId, { agentId, anchorId })
  if (args.mode === 'subscribe') {
    await adjustInstallCount(ctx, listing._id, 1, args.now)
  }
  const subscription = await requireSubscription(ctx, subscriptionId)
  await syncContainedApps(ctx, subscription, undefined, args.now)
  // Only a subscription that was actually created is an install. The replay
  // above returns before reaching here, so adopting an existing subscription
  // stays silent rather than counting a second install.
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'agent.installed',
    actorId: args.actorId,
    at: args.now,
    provenance: {
      subscriptionId,
      listingId: listing._id,
      // The publisher's slug. The installer's `slug` below is their own copy's
      // name, which they may rename; this one identifies what was installed.
      listingSlug: agentName,
      agentId,
      anchorId,
      slug,
      path,
      installMode: args.mode,
      source: args.source,
    },
  })
  return toSubscription(await requireSubscription(ctx, subscriptionId))
}

/**
 * Absent means the ordinary marketplace surface — the one a direct caller of
 * this mutation is standing in for. Every endpoint states its own.
 *
 * Recorded as given rather than parsed against the vocabulary: `source` is one
 * analytics property, and its callers are our own routes, so the enum belongs
 * at their compile-time surface. Rejecting an unknown one here would fail the
 * install itself — a mislabeled event is not worth a refused agent.
 */
function installSource(source: string | undefined): string {
  return source ?? 'marketplace'
}

/**
 * A workspace-unique agent slug for a marketplace install.
 *
 * Prefers the install folder's own name — the user picked it, and the path
 * collision check already proved that folder free — falling back to the
 * listing's agent name when the folder name is not slug-shaped, then to the
 * shared suffixing rule when either is claimed by an agent elsewhere in the
 * workspace.
 */
async function availableAgentSlug(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  path: string,
  agentName: string,
): Promise<string> {
  const folderName = path.split('/').at(-1) ?? ''
  const preferred = AppSlugSchema.safeParse(folderName)
  const base = preferred.success ? preferred.data : agentName
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .take(MAX_AGENTS_PER_WORKSPACE + 1)
  return availableSharedReplicaSlug(new Set(agents.map(agent => agent.slug)), base)
}

async function syncContainedApps(
  ctx: MutationCtx,
  subscription: Doc<'agentSubscriptions'>,
  appliedEtag: string | undefined,
  now: number,
): Promise<void> {
  const { apps: origins, rootPath } = await goldenAppsForSubscription(ctx, subscription)
  const existingApps = await ctx.db
    .query('apps')
    .withIndex('by_listing_subscription', q => q.eq('listingSubscriptionId', subscription._id))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  if (existingApps.length > MAX_APPS_PER_WORKSPACE) {
    throw new Error('Marketplace subscription app limit exceeded')
  }
  for (const { app: origin, anchor } of origins) {
    const targetPath = translateSharedResourcePathToMount(anchor.path, rootPath, subscription.path)
    // The ONE registration owner. An installed app must be indistinguishable
    // from the same app registered directly — same visibility, ports, slug
    // handling, runtime status — so install adds nothing beyond the
    // subscription linkage `registerAppImpl` accepts for it.
    await registerAppImpl(ctx, {
      workspaceId: subscription.workspaceId,
      path: targetPath,
      slug: origin.slug,
      command: origin.command,
      apiScopes: origin.apiScopes,
      installCommand: origin.installCommand,
      name: origin.name,
      icon: origin.icon,
      listingSubscription: { id: subscription._id, appliedEtag },
      actorId: subscription.createdByUserId,
      now,
    })
  }
  // Removing what the publisher no longer ships is subscription bookkeeping,
  // not registration: registration only ever materialises what is declared.
  await retireDroppedApps(ctx, subscription, now)
}

/**
 * Delete this subscription's app rows that the publisher no longer ships.
 *
 * The publisher dropping an app is them deleting it, so it is deleted here too
 * — it used to be switched off instead, which left it on every subscriber's map
 * forever with no way to remove it: a marketplace-managed app refuses direct
 * deletion, so the row outlived the listing that justified it.
 *
 * The FOLDER stays. Deleting the row un-registers the app; the files under it
 * are whatever the user has since made of them, and an install going away is no
 * reason to take someone's work with it. What is left is an ordinary folder,
 * which is exactly what it would be if they had deleted the app themselves.
 *
 * Runs on BOTH report paths. On success it follows registration; on failure it
 * runs alone, which is what breaks the deadlock — the VM cannot apply a tree
 * whose app it must install from a directory the same tree just emptied, and
 * the row causing that is only clearable here.
 */
async function retireDroppedApps(
  ctx: MutationCtx,
  subscription: Doc<'agentSubscriptions'>,
  now: number,
): Promise<void> {
  const { apps: origins, rootPath } = await goldenAppsForSubscription(ctx, subscription)
  // Mounted PATH is the identity, not slug: `registerAppImpl` collision-suffixes
  // a slug that is already taken in the installing workspace, so a still-shipped
  // app can carry a slug the publisher never used. Path is what both halves of
  // this file already resolve rows by.
  const shipped = new Set(
    origins.map(({ anchor }) =>
      translateSharedResourcePathToMount(anchor.path, rootPath, subscription.path),
    ),
  )
  const existingApps = await ctx.db
    .query('apps')
    .withIndex('by_listing_subscription', q => q.eq('listingSubscriptionId', subscription._id))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  for (const app of existingApps) {
    const anchor = await ctx.db.get(app.anchorId)
    if (anchor === null || shipped.has(anchor.path)) continue
    await deleteAppRow(ctx, { app, anchor, actorId: subscription.createdByUserId, now })
  }
}

/**
 * The publisher's apps this subscription mirrors. Delegates to the ONE
 * contained-app owner so the consent sheet, the declaration revision and what
 * actually gets copied are all the same walk.
 */
async function goldenAppsForSubscription(
  ctx: QueryCtx | MutationCtx,
  subscription: Pick<Doc<'agentSubscriptions'>, 'listingId'>,
) {
  const listing = await ctx.db.get(subscription.listingId)
  if (listing === null) return { apps: [], rootPath: '' }
  return await containedAppsForListing(ctx, listing)
}

async function mutationActor(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
): Promise<Id<'users'>> {
  if (args.internalKey === undefined) {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    return (await assertRole(ctx, args.workspaceId, 'editor')).userId
  }
  requireApiInternalKey(args.internalKey)
  if (args.actorId === undefined) throw new Error('actorId is required for internal mutation')
  return (await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')).userId
}

async function requireWorkspaceSubscription(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  subscriptionId: Id<'agentSubscriptions'>,
) {
  const subscription = await requireSubscription(ctx, subscriptionId)
  if (subscription.workspaceId !== workspaceId)
    throw new Error('Marketplace agent subscription not found')
  return subscription
}

async function requireSubscription(
  ctx: QueryCtx | MutationCtx,
  subscriptionId: Id<'agentSubscriptions'>,
) {
  const subscription = await ctx.db.get(subscriptionId)
  if (subscription === null) throw new Error('Marketplace agent subscription not found')
  return subscription
}

function toSubscription(subscription: Doc<'agentSubscriptions'>): MarketplaceAgentSubscription {
  return {
    id: subscription._id,
    ...(subscription.agentId === undefined ? {} : { agentId: subscription.agentId }),
    ...(subscription.anchorId === undefined ? {} : { anchorId: subscription.anchorId }),
    listingId: subscription.listingId,
    agentName: MarketplaceAgentNameSchema.parse(subscription.agentName),
    path: subscription.path,
    mode: subscription.mode,
    state: subscription.state,
    ...(subscription.appliedEtag === undefined ? {} : { appliedEtag: subscription.appliedEtag }),
    ...(subscription.acknowledgedEtag === undefined
      ? {}
      : { acknowledgedEtag: subscription.acknowledgedEtag }),
    ...(subscription.lastAppliedAt === undefined
      ? {}
      : { lastAppliedAt: subscription.lastAppliedAt }),
    ...(subscription.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: subscription.lastErrorCode }),
  }
}

function compareSubscriptionOrder(
  left: Doc<'agentSubscriptions'>,
  right: Doc<'agentSubscriptions'>,
): number {
  return (
    left.agentName.localeCompare(right.agentName) ||
    left.path.localeCompare(right.path) ||
    left._id.localeCompare(right._id)
  )
}

function refuse(error: MarketplaceAgentMutationError): never {
  throw new ConvexError(error)
}
