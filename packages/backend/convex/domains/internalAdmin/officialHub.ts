import { v } from 'convex/values'

import { MAX_AGENTS_PER_WORKSPACE, MAX_APPS_PER_WORKSPACE } from '@repo/contract'
import {
  OFFICIAL_AGENTS_HUB_PATH,
  OFFICIAL_AGENTS_PUBLISH_SLUG,
  OFFICIAL_AGENTS_WORKSPACE_SLUG,
} from '@repo/official-agents-seed/manifest'

import type { Id } from '../../_generated/dataModel'
import { mutation, type MutationCtx } from '../../_generated/server'
import { registerAgentImpl } from '../agents/model'
import { deleteAgentSubtree } from '../anchors/subtree'
import { appDeclarationValidator, type WireAppDeclaration } from '../apps/model'
import { reconcileServicingStatus } from '../credits/subscriptions'
import { listingByPublisherAndAgent, registerListingImpl } from '../marketplace/listings'
import { createPublishImpl } from '../publishes/model'
import { isSharedResourcePathWithinShareRoot } from '../replication/shared'
import { createWorkspaceRow } from '../workspaces/birth'
import { scheduleWorkspaceVm } from '../workspaces/vmSchedule'
import { adminRefusal, audit, requireInternalAdmin } from './model'

const provenance = {
  internalKey: v.string(),
  actorId: v.id('users'),
  requestId: v.string(),
  reason: v.string(),
  now: v.number(),
}

// A CLOSED validator: every field the seed plan carries must be declared here
// or the mutation rejects a payload whose TypeScript is perfectly green. The
// seed package owns what an official agent is; this is the second schema that
// has to agree with it.
const seedAgent = v.object({
  slug: v.string(),
  name: v.string(),
  path: v.string(),
  icon: v.optional(v.string()),
  // Computed by the seed from the agent's own authored bytes through the same
  // `deriveListingMetadata` an ordinary publisher's listing goes through. This
  // mutation never reconstructs it: a second derivation is a second answer.
  derived: v.object({
    title: v.string(),
    summary: v.string(),
    skills: v.array(v.string()),
    changelog: v.string(),
    tags: v.array(v.string()),
  }),
  // A LIST, mirroring the seed manifest exactly. An agent with no apps
  // registers none -- not a null row, not a placeholder. An agent may need
  // both a working surface and an onboarding picker, which is why this is
  // plural; the marketplace rail already enumerated many. The entry grammar is
  // the shared app-declaration validator, so the seed cannot drift from what
  // `agents.register` itself accepts.
  apps: v.optional(v.array(appDeclarationValidator)),
})

type SeedAgentRegistration = {
  slug: string
  name: string
  path: string
  icon?: string
  derived: {
    title: string
    summary: string
    skills: string[]
    changelog: string
    tags: string[]
  }
  apps?: readonly WireAppDeclaration[]
}

/**
 * Resolve the hub, creating or adopting it, and hand the caller its slug so it
 * can converge the files. Callable any number of times: a sync that sometimes
 * silently declined to run would be a button that lies.
 *
 * There is deliberately no "already done" short-circuit and no content hash.
 * Whether the repo's bytes changed is not knowable here, and pressing the
 * button means "make the hub match the code" — the gateway decides per file
 * whether anything actually needs writing.
 */
export const beginSync = mutation({
  args: { ...provenance, ownerEmail: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const existing = await ctx.db.query('officialHub').unique()
    if (existing !== null) {
      await audit(
        ctx,
        args,
        actor.email,
        'admin.official_hub.sync.begin',
        existing.workspaceSlug,
        existing.workspaceId,
      )
      return { workspaceId: existing.workspaceId, workspaceSlug: existing.workspaceSlug }
    }
    const ownerEmail = args.ownerEmail.trim().toLowerCase()
    const owner = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', ownerEmail))
      .unique()
    if (owner === null) throw new Error(`Golden workspace owner account not found: ${ownerEmail}`)
    // ADOPT an existing hub workspace rather than always creating one. The
    // workspace, identified by the manifest slug, is the durable fact; the
    // `officialHub` row is bookkeeping. Keying creation solely on that row
    // stranded the hub forever once it was lost — `createWorkspaceRow` throws
    // "Workspace slug is already taken" on every subsequent attempt, with no
    // way back. Found by a live staging run after a cutover wiped the row
    // while the workspace survived.
    const existingWorkspace = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q =>
        q.eq('slug', OFFICIAL_AGENTS_WORKSPACE_SLUG).eq('status', 'active'),
      )
      .first()
    const created =
      existingWorkspace === null
        ? await createWorkspaceRow(ctx, {
            ownerUserId: owner._id,
            slug: OFFICIAL_AGENTS_WORKSPACE_SLUG,
            name: 'Official Agents Hub',
            bypassWorkspaceLimit: true,
            servicingExempt: true,
          })
        : { workspaceId: existingWorkspace._id, slug: existingWorkspace.slug }
    if (existingWorkspace === null) await scheduleWorkspaceVm(ctx, created.workspaceId)
    // ADOPTED hubs never run birth, so they would otherwise stay billable
    // forever — and both live environments' hubs already exist. Applying the
    // exemption here is what actually protects them; the birth flag above only
    // covers a hub created from scratch.
    if (existingWorkspace !== null && existingWorkspace.servicingExemptAt === undefined) {
      await ctx.db.patch(existingWorkspace._id, {
        servicingExemptAt: args.now,
        updatedAt: args.now,
      })
      // Through the one owner, so an already-paused hub reactivates by the same
      // rules that pause it rather than by a second status writer here.
      await reconcileServicingStatus(ctx, existingWorkspace.billingUserId, args.now)
    }
    await ctx.db.insert('officialHub', {
      workspaceId: created.workspaceId,
      workspaceSlug: created.slug,
      ownerUserId: owner._id,
    })
    await audit(
      ctx,
      args,
      actor.email,
      'admin.official_hub.sync.begin',
      created.slug,
      created.workspaceId,
    )
    return { workspaceId: created.workspaceId, workspaceSlug: created.slug }
  },
})

/**
 * Reconcile the hub's registrations to the manifest, after its files have been
 * converged. Idempotent and unconditional — the registration helpers each
 * compare before writing, so a sync that changed nothing patches nothing.
 */
export const completeSync = mutation({
  args: {
    ...provenance,
    agents: v.array(seedAgent),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const run = await ctx.db.query('officialHub').unique()
    if (run === null) throw new Error('Official hub sync has not started')
    await reconcileRegistrations(ctx, {
      workspaceId: run.workspaceId,
      ownerId: run.ownerUserId,
      agents: args.agents,
      now: args.now,
    })
    const publish = await createPublishImpl(ctx, {
      workspaceId: run.workspaceId,
      path: OFFICIAL_AGENTS_HUB_PATH,
      kind: 'folder',
      slug: OFFICIAL_AGENTS_PUBLISH_SLUG,
      actorId: run.ownerUserId,
      now: args.now,
    })
    await ctx.db.patch(run.workspaceId, {
      // Duet is a verified publisher; every listing it seeds derives its badge
      // from this one workspace-scoped fact rather than carrying its own.
      verifiedPublisherAt: args.now,
      updatedAt: args.now,
    })
    // Each seeded agent becomes an ordinary marketplace listing on the shared
    // rail. They point at the hub publish with `agentSubpath` set to the agent's
    // folder name — the parent-folder layout slice 00 proved — rather than
    // getting a publish each: the hub is one trusted publisher, so per-agent
    // publishes would buy isolation nobody needs and would restructure a
    // prod-live seed for nothing.
    for (const agent of args.agents) {
      const registered = await ctx.db
        .query('agents')
        .withIndex('by_workspace_and_slug', q =>
          q.eq('workspaceId', run.workspaceId).eq('slug', agent.slug),
        )
        .unique()
      if (registered === null) continue
      // TAKEDOWN OUTRANKS THE SYNC. `registerListingImpl` patches a listing
      // back to `listed`/`available`, so a repeatable sync would silently undo
      // an operator's takedown of an official agent and put it back in front of
      // customers on the next press. Re-listing stays a deliberate admin
      // action; the sync declines to revive.
      //
      // The guard lives HERE and not inside `registerListingImpl`, because the
      // ordinary re-register path arguably should revive — bending shared
      // marketplace behaviour to serve the sync would make removal mean two
      // different things depending on who asked.
      const listing = await listingByPublisherAndAgent(ctx, {
        workspaceId: run.workspaceId,
        agentName: agent.slug,
      })
      if (listing?.state === 'removed') continue
      const result = await registerListingImpl(ctx, {
        workspaceId: run.workspaceId,
        agentId: registered._id,
        anchorId: registered.anchorId,
        publishId: publish.id as Id<'publishes'>,
        agentName: agent.slug,
        agentSubpath: agent.slug,
        derived: agent.derived,
        actorId: run.ownerUserId,
        now: args.now,
        // The seed is Duet publishing to its own hub behind internal-admin
        // auth; the launch gate governs ordinary users, not this path.
        publishingEnabled: true,
      })
      // THIS PRESS IS THE HUB'S CONTENT CLOCK. The hub's bytes arrive through
      // one door — the operator converging the repo onto the drive — so the
      // mutation that closes that door is the only place that can honestly say
      // "the files may have moved". Stamped unconditionally rather than per
      // changed agent: whether an individual agent's bytes moved is not
      // knowable here, and being wrong costs one conditional request per
      // subscriber, once.
      if ('listing' in result) {
        await ctx.db.patch(result.listing._id, { contentRevision: args.requestId })
      }
    }
    const retiredAgents = await retireAbsentAgents(ctx, {
      workspaceId: run.workspaceId,
      ownerId: run.ownerUserId,
      keep: new Set(args.agents.map(agent => agent.slug)),
      now: args.now,
    })
    await audit(
      ctx,
      args,
      actor.email,
      'admin.official_hub.sync.complete',
      run.workspaceSlug,
      run.workspaceId,
    )
    return { workspaceSlug: run.workspaceSlug, retiredAgents }
  },
})

/**
 * Absent from the manifest means gone from the hub. Retirement used to be
 * demotion — a dropped agent kept its row and kept serving what it last had —
 * which turned every retirement into a hand-run data operation per
 * environment: delete the row, delete the folder, unlist the listing. The
 * manifest is the whole truth for the hub, so the sync deletes what the plan
 * no longer claims, the same press that registers what it does.
 *
 * Scoped like the file reap: only agents whose anchor sits under the hub's
 * managed root are candidates, and replicas are never touched. The listing is
 * unlisted rather than deleted — subscribers' installed copies stay working,
 * and an operator takedown (`removed`) still outranks everything, including
 * this.
 *
 * The folders are the API leg's job: rows are transactional here, files are
 * the gateway's, and the sync route already owns that split.
 */
async function retireAbsentAgents(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    ownerId: Id<'users'>
    keep: ReadonlySet<string>
    now: number
  },
): Promise<Array<{ slug: string; path: string }>> {
  const rows = await ctx.db
    .query('agents')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
    .take(MAX_AGENTS_PER_WORKSPACE + 1)
  const retired: Array<{ slug: string; path: string }> = []
  for (const agent of rows) {
    if (args.keep.has(agent.slug)) continue
    if (agent.sourceShareId !== undefined || agent.sourceAgentId !== undefined) continue
    const anchor = await ctx.db.get(agent.anchorId)
    if (anchor === null) continue
    if (!isSharedResourcePathWithinShareRoot(anchor.path, OFFICIAL_AGENTS_HUB_PATH)) continue
    await deleteAgentSubtree(ctx, { agent, anchor, actorId: args.ownerId, now: args.now })
    const listing = await listingByPublisherAndAgent(ctx, {
      workspaceId: args.workspaceId,
      agentName: agent.slug,
    })
    if (listing !== null && listing.state === 'listed') {
      await ctx.db.patch(listing._id, { state: 'unlisted', updatedAt: args.now })
    }
    retired.push({ slug: agent.slug, path: anchor.path })
  }
  return retired.sort((a, b) => a.slug.localeCompare(b.slug))
}

export const accessTarget = mutation({
  args: { ...provenance },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    // Resolved by the slug the manifest already owns, never by the
    // `officialHub` row: the workspace's identity is the durable fact, and it
    // exists whether or not anything has been recorded about it.
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q =>
        q.eq('slug', OFFICIAL_AGENTS_WORKSPACE_SLUG).eq('status', 'active'),
      )
      .first()
    if (workspace === null) throw adminRefusal('not_found')
    const owner = await ctx.db.get(workspace.createdByUserId ?? workspace.billingUserId)
    if (owner === null) throw new Error('Official hub owner not found')
    await audit(ctx, args, actor.email, 'admin.official_hub.access', workspace.slug, workspace._id)
    return { ownerEmail: owner.email, workspaceSlug: workspace.slug }
  },
})

/**
 * One register call per agent, apps included. `registerAgentImpl` owns the
 * whole materialisation — agent row, contained app rows, and the
 * compare-before-write that makes an unchanged press patch nothing — so the
 * sync no longer hand-rolls a second copy of "install this agent's apps".
 */
async function reconcileRegistrations(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    ownerId: Id<'users'>
    agents: readonly SeedAgentRegistration[]
    now: number
  },
): Promise<void> {
  for (const agent of args.agents) {
    await registerAgentImpl(ctx, {
      workspaceId: args.workspaceId,
      path: agent.path,
      slug: agent.slug,
      name: agent.name,
      icon: agent.icon,
      apps: agent.apps,
      actorId: args.ownerId,
      now: args.now,
    })
  }
  await reconcileManagedApps(ctx, args)
}

/**
 * Make the hub's app rows say what the manifest says, in both directions.
 *
 * The manifest decides which roots are managed; inside a managed root the repo
 * is the whole truth. Files already work that way — a converge reaps what the
 * plan no longer claims — but registrations did not, so a deleted app kept its
 * row, kept appearing in its listing's contained apps, and kept being installed
 * by subscribers into a folder whose files the reap had just removed.
 *
 * Scoped to the roots this plan names, exactly like the file reap. An app under
 * a root the manifest dropped is left for `retireAbsentAgents`, which deletes
 * the whole subtree — rows included — one phase later.
 *
 * Both directions, because a plain re-register does not clear `disabledAt` —
 * without the revive half, an app removed and later restored would stay dead.
 */
async function reconcileManagedApps(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    ownerId: Id<'users'>
    agents: readonly SeedAgentRegistration[]
    now: number
  },
): Promise<void> {
  const managedRoots = args.agents.map(agent => agent.path)
  const declaredPaths = new Set(
    args.agents.flatMap(agent => (agent.apps ?? []).map(app => app.path)),
  )
  const rows = await ctx.db
    .query('apps')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
    .take(MAX_APPS_PER_WORKSPACE + 1)
  for (const app of rows) {
    const anchor = await ctx.db.get(app.anchorId)
    if (anchor === null) continue
    const managed = managedRoots.some(root =>
      isSharedResourcePathWithinShareRoot(anchor.path, root),
    )
    if (!managed) continue
    const declared = declaredPaths.has(anchor.path)
    if (declared && app.disabledAt !== undefined) {
      await ctx.db.patch(app._id, {
        disabledAt: undefined,
        disabledByUserId: undefined,
        updatedAt: args.now,
      })
      continue
    }
    if (!declared && app.disabledAt === undefined) {
      await ctx.db.patch(app._id, {
        disabledAt: args.now,
        disabledByUserId: args.ownerId,
        updatedAt: args.now,
      })
    }
  }
}
