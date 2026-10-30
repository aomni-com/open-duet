import { v } from 'convex/values'

import {
  AgentIconSchema,
  AgentNameSchema,
  AppSlugSchema,
  MAX_AGENTS_PER_WORKSPACE,
  WorkspaceDuetNameSchema,
  type RegisteredAgentAppResult,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { throwSessionError } from '../agentSessions/errors'
import {
  assertSessionIdentityAttribution,
  sessionRequestIdentityValidator,
  type SessionRequestIdentity,
} from '../agentSessions/identity'
import { getOrCreateAnchorForPath, normalizeAnchorPath, requireAnchor } from '../anchors/model'
import { deleteAgentSubtree } from '../anchors/subtree'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  appDeclarationValidator,
  appRegistrationDiff,
  registerAppImpl,
  type WireAppDeclaration,
} from '../apps/model'
import { writeAuditEvent } from '../audit/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { toAgent } from './display'
import {
  loadWorkspaceAgents,
  reconcileReplicasForOriginAgent,
  requireWriteModeReplicaOriginAgent,
} from './replication'
import { resolveAgentForPath } from './resolution'

export interface RegisterAgentImplArgs {
  workspaceId: Id<'workspaces'>
  path: string
  slug: string
  name?: string
  icon?: string
  /**
   * The apps that are part of the agent. Registering the agent registers them
   * too, atomically and wherever the register comes from — an agent whose apps
   * do not run is a bug, not a variant. Every path must sit strictly under the
   * agent's own path.
   */
  apps?: readonly WireAppDeclaration[]
  actorId: Id<'users'>
  now: number
}

export const registerAgent = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    path: v.string(),
    slug: v.string(),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    apps: v.optional(v.array(appDeclarationValidator)),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId } = await agentMutationActor(ctx, args)
    return await registerAgentImpl(ctx, {
      workspaceId: args.workspaceId,
      path: args.path,
      slug: args.slug,
      name: args.name,
      icon: args.icon,
      apps: args.apps,
      actorId: userId,
      now: args.now ?? Date.now(),
    })
  },
})

export async function registerAgentImpl(ctx: MutationCtx, args: RegisterAgentImplArgs) {
  const path = normalizeAnchorPath(args.path, 'agent')
  const slug = AppSlugSchema.parse(args.slug)
  const name = args.name === undefined ? undefined : AgentNameSchema.parse(args.name)
  const icon = args.icon === undefined ? undefined : AgentIconSchema.parse(args.icon)
  // Containment is a real boundary, not a formality: the register call may
  // materialise apps only inside the agent's own folder, never elsewhere in
  // the workspace. Checked before any write so a refusal registers nothing —
  // and the mutation is one transaction, so a later throw unwinds it all.
  const declaredApps = (args.apps ?? []).map(declaration => ({
    ...declaration,
    path: normalizeAnchorPath(declaration.path, 'app'),
  }))
  for (const declaration of declaredApps) {
    if (!declaration.path.startsWith(`${path}/`)) {
      throw new Error('App path is outside the agent folder')
    }
  }
  const anchor = await getOrCreateAnchorForPath(ctx, {
    workspaceId: args.workspaceId,
    path,
    kind: 'agent',
    settings: {},
    actorId: args.actorId,
    now: args.now,
    kindConflictError: 'Anchor path is not an agent, share-root, or publish anchor',
    compatibleExistingKinds: ['share-root', 'publish'],
  })
  await assertSlugAvailable(ctx, args.workspaceId, slug, anchor.id as Id<'anchors'>)
  const existing = await agentByAnchor(ctx, anchor.id as Id<'anchors'>)
  if (existing !== null && existing.slug !== slug) throw new Error('Agent path already exists')
  if (existing !== null) assertMutableOriginAgent(existing)
  if (
    existing === null &&
    (await loadWorkspaceAgents(ctx, args.workspaceId)).length >= MAX_AGENTS_PER_WORKSPACE
  ) {
    throw new Error('Workspace agent limit exceeded')
  }

  let agentId: Id<'agents'>
  if (existing === null) {
    agentId = await ctx.db.insert('agents', {
      workspaceId: args.workspaceId,
      anchorId: anchor.id as Id<'anchors'>,
      slug,
      name,
      icon,
      createdByUserId: args.actorId,
      createdAt: args.now,
      updatedAt: args.now,
    })
  } else {
    agentId = existing._id
    // Omitted means preserve, not clear. Convex deletes a field patched to
    // `undefined`, so spreading these unconditionally would let a re-register
    // that mentions neither erase a rename the user made through `updateAgent`.
    // There is deliberately no way to clear a name back to the slug: nothing in
    // the product asks for one, and a sentinel would be a second grammar.
    //
    // And compare before writing: a repeat register with the same declaration
    // patches nothing — no updatedAt drift, no replica clock movement — which
    // is what lets the hub sync call this unconditionally on every press.
    // (`slug` needs no patch: the guard above proves it already matches.)
    const patch = {
      ...(name === undefined || existing.name === name ? {} : { name }),
      ...(icon === undefined || existing.icon === icon ? {} : { icon }),
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: args.now })
    }
  }
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: existing === null ? 'agent.registered' : 'agent.registered_again',
    actorId: args.actorId,
    at: args.now,
    provenance: { agentId, anchorId: anchor.id, path, slug },
  })
  // The agent's own apps, through the ONE registration owner — the same
  // `registerAppImpl` the standalone endpoint and the marketplace install
  // reach. Compare-before-write keeps the repeat register a no-op: an
  // unchanged declaration neither re-ports nor flips runtime status.
  // The rows this call actually (re-)registered ride back on the result so
  // the API route can settle their runtime reconciliation — they are the apps
  // now sitting in 'reconciling', which only that gateway push can resolve.
  // And EVERY declaration rides back in `apps` with its actual slug and what
  // this call did to it, so a 201 says what it registered rather than leaving
  // the caller to infer it from the request.
  const registeredApps: unknown[] = []
  const apps: RegisteredAgentAppResult[] = []
  for (const declaration of declaredApps) {
    const diff = await appRegistrationDiff(ctx, args.workspaceId, declaration)
    if (!diff.differs) {
      // `differs === false` implies an existing row was compared against.
      if (diff.existing === null) throw new Error('Unchanged app declaration has no row')
      apps.push({ slug: diff.existing.slug, path: declaration.path, status: 'unchanged' })
      continue
    }
    const row = await registerAppImpl(ctx, {
      workspaceId: args.workspaceId,
      path: declaration.path,
      slug: declaration.slug,
      command: declaration.command,
      apiScopes: declaration.apiScopes,
      installCommand: declaration.installCommand,
      port: declaration.port,
      name: declaration.name,
      icon: declaration.icon,
      actorId: args.actorId,
      now: args.now,
    })
    registeredApps.push(row)
    apps.push({
      slug: row.slug,
      path: declaration.path,
      status: diff.existing === null ? 'created' : 'updated',
    })
  }
  const agent = await requireAgent(ctx, agentId)
  const fanout = await reconcileReplicasForOriginAgent(ctx, { originAgent: agent, now: args.now })
  return { ...toAgent(agent, anchor), ...fanout, registeredApps, apps }
}

/**
 * Rename the default agent — the drive root, which has no `agents` row.
 *
 * It lives beside {@link updateAgent} rather than in the workspaces domain
 * because renaming an agent is one operation with two storage sites, and
 * splitting it across domains would give the product two answers to "who
 * renames an agent". It also inherits this module's editor-level actor rule,
 * so both kinds of rename authorize identically.
 *
 * Unconditional, unlike onboarding's `duetName ?? requested`: that one is a
 * first-write-wins default at workspace birth, and reusing it would make a
 * rename a silent no-op for anyone who had already onboarded.
 */
export const updateDefaultAgent = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    name: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId } = await agentMutationActor(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const name = WorkspaceDuetNameSchema.parse(args.name)
    const now = args.now ?? Date.now()
    await ctx.db.patch(args.workspaceId, { duetName: name, updatedAt: now })
    await writeAuditEvent(ctx, {
      workspaceId: args.workspaceId,
      // Deliberately not `workspace.renamed`: that one means the workspace's
      // ADDRESS changed and carries a public-URL break acknowledgement.
      event: 'workspace.duet_name_changed',
      actorId: userId,
      at: now,
      provenance: { name },
    })
    return { name }
  },
})

export const updateAgent = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const agent = await requireAgentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
    const { userId } = await agentMutationActor(ctx, args)
    if (args.name === undefined && args.icon === undefined)
      throw new Error('No agent update fields provided')
    const originAgent =
      agent.sourceShareId === undefined
        ? undefined
        : await requireWriteModeReplicaOriginAgent(ctx, agent)
    const name = args.name === undefined ? undefined : AgentNameSchema.parse(args.name)
    const icon = args.icon === undefined ? undefined : AgentIconSchema.parse(args.icon)
    const now = Math.max(args.now ?? Date.now(), agent.updatedAt + 1)
    await ctx.db.patch(agent._id, {
      ...(name === undefined ? {} : { name }),
      ...(icon === undefined ? {} : { icon }),
      updatedAt: now,
    })
    if (originAgent !== undefined) {
      await ctx.db.patch(originAgent._id, {
        ...(name === undefined ? {} : { name }),
        ...(icon === undefined ? {} : { icon }),
        updatedAt: now,
      })
    }
    const anchor = await requireAnchor(ctx, agent.anchorId)
    await writeAuditEvent(ctx, {
      workspaceId: agent.workspaceId,
      event: 'agent.updated',
      actorId: userId,
      at: now,
      provenance: {
        agentId: agent._id,
        anchorId: agent.anchorId,
        path: anchor.path,
        slug: agent.slug,
      },
    })
    const updated = await requireAgent(ctx, agent._id)
    const fanout = await reconcileReplicasForOriginAgent(ctx, {
      originAgentId: originAgent?._id ?? updated._id,
      now,
      metadataWasExplicitlyUpdated: true,
    })
    return {
      ...toAgent(updated, anchor),
      affectedRecipientWorkspaceIds:
        originAgent === undefined
          ? fanout.affectedRecipientWorkspaceIds
          : [...new Set([originAgent.workspaceId, ...fanout.affectedRecipientWorkspaceIds])],
    }
  },
})

export const setAgentDisabled = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    disabled: v.boolean(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const agent = await requireAgentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
    const { userId } = await agentMutationActor(ctx, args)
    const now = args.now ?? Date.now()
    await ctx.db.patch(agent._id, {
      disabledAt: args.disabled ? now : undefined,
      disabledByUserId: args.disabled ? userId : undefined,
      updatedAt: now,
    })
    const anchor = await requireAnchor(ctx, agent.anchorId)
    await writeAuditEvent(ctx, {
      workspaceId: agent.workspaceId,
      event: args.disabled ? 'agent.disabled' : 'agent.enabled',
      actorId: userId,
      at: now,
      provenance: {
        agentId: agent._id,
        anchorId: agent.anchorId,
        path: anchor.path,
        slug: agent.slug,
      },
    })
    return toAgent(await requireAgent(ctx, agent._id), anchor)
  },
})

// Onboarding completion is per-workspace and replica-local: unlike rename or
// delete, a share recipient MAY toggle their own copy (they are the ones being
// onboarded), and nothing here writes through to the origin. Setting is
// idempotent so an onboarding app that retries its completion call does not
// look newly onboarded.
export const setAgentOnboarded = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    onboarded: v.boolean(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const agent = await requireAgentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
    const { userId } = await agentMutationActor(ctx, args)
    return await applyAgentOnboarded(ctx, {
      agent,
      onboarded: args.onboarded,
      userId,
      now: args.now ?? Date.now(),
    })
  },
})

/**
 * The same completion, keyed by the onboarding conversation instead of the
 * agent slug. The onboarding agent runs inside the session and knows only
 * `$DUET_SESSION_ID` — the slug route made it derive the workspace and agent
 * slugs through a whoami + list + filter pipeline, and the live e2e caught a
 * real runner finishing its interview and never attempting that ceremony,
 * stranding the user behind a locked card. The session already names its agent
 * (attributed from cwd at creation), so completion needs nothing the agent
 * doesn't have.
 *
 * Restricted to onboarding conversations: the completion prompt exists only in
 * those sessions, and an ordinary session that could flip onboarding state by
 * its own id would be a second, undocumented unlock path.
 */
export const setSessionAgentOnboarded = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    onboarded: v.boolean(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.workspaceId !== args.workspaceId) {
      throw new Error('Session not found')
    }
    if (session.onboarding !== true || session.agentId === undefined) {
      throw new Error('Not an onboarding session')
    }
    const agent = await ctx.db.get(session.agentId)
    if (agent === null || agent.workspaceId !== args.workspaceId) {
      throw new Error('Agent not found')
    }
    const { userId } = await agentMutationActor(ctx, args)
    return await applyAgentOnboarded(ctx, {
      agent,
      onboarded: args.onboarded,
      userId,
      now: args.now ?? Date.now(),
      sessionId: args.sessionId,
    })
  },
})

async function applyAgentOnboarded(
  ctx: MutationCtx,
  args: {
    agent: Doc<'agents'>
    onboarded: boolean
    userId: Id<'users'>
    now: number
    /** Present when the agent completed onboarding from inside its own session,
     * so the audit trail distinguishes self-completion from a human's toggle. */
    sessionId?: Id<'agentSessions'>
    /** The same, for the app-onboarding half: the app that reported completion. */
    appId?: Id<'apps'>
  },
) {
  const { agent, onboarded, userId, now } = args
  const alreadyOnboarded = agent.onboardedAt !== undefined
  if (onboarded !== alreadyOnboarded) {
    await ctx.db.patch(agent._id, {
      onboardedAt: onboarded ? now : undefined,
      updatedAt: now,
    })
  }
  /* Redo means START OVER, so the interview it reopens must be a fresh one:
     the open-or-create lookup returns the newest ACTIVE onboarding session,
     and leaving the old conversation active hands the user the very session
     whose outcome they are redoing — wrong language, wrong answers and all.
     Archiving is only for the reset direction; completing onboarding happens
     INSIDE the session, and archiving it under a live runner would tear down
     the conversation that just succeeded. */
  if (!onboarded) {
    const stale = await ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_agent_archive_updated', q =>
        q
          .eq('workspaceId', agent.workspaceId)
          .eq('onboarding', true)
          .eq('agentId', agent._id)
          .eq('archiveState', 'active'),
      )
      .take(25)
    for (const session of stale) {
      await ctx.db.patch(session._id, {
        archiveState: 'archived',
        archivedAt: now,
        updatedAt: now,
      })
    }
  }
  const anchor = await requireAnchor(ctx, agent.anchorId)
  await writeAuditEvent(ctx, {
    workspaceId: agent.workspaceId,
    event: onboarded ? 'agent.onboarded' : 'agent.onboarding_reset',
    actorId: userId,
    at: now,
    provenance: {
      agentId: agent._id,
      anchorId: agent.anchorId,
      path: anchor.path,
      slug: agent.slug,
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(args.appId === undefined ? {} : { appId: args.appId }),
    },
  })
  return toAgent(await requireAgent(ctx, agent._id), anchor)
}

/**
 * The same completion, keyed by the app that is doing the onboarding. An
 * `onboarding: { kind: 'app' }` agent runs no interview, so nothing but the app
 * itself is present to say the user is finished — and the app holds only its own
 * runtime key: no session id, no agent slug, not even its own app slug. The
 * credential is therefore the address, and the app's folder names the agent.
 *
 * Ownership is the anchor tree rather than the `onboarding` block, because
 * `agent.json` lives on the drive and is never projected here. That is wider
 * than "the declared onboarding app" on purpose: any of an agent's own apps
 * marking its own agent onboarded is the same trust domain (SECURITY.md).
 */
export const setAppAgentOnboarded = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    appId: v.id('apps'),
    onboarded: v.boolean(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.appId)
    if (app === null || app.workspaceId !== args.workspaceId) throw new Error('App not found')
    const anchor = await requireAnchor(ctx, app.anchorId)
    const owner = await resolveAgentForPath(ctx, {
      workspaceId: args.workspaceId,
      path: anchor.path,
    })
    if (owner === null) throw new Error('App has no owning agent')
    const { userId } = await agentMutationActor(ctx, args)
    return await applyAgentOnboarded(ctx, {
      agent: owner.agent,
      onboarded: args.onboarded,
      userId,
      now: args.now ?? Date.now(),
      appId: app._id,
    })
  },
})

export const deleteAgent = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.optional(v.string()),
    actorId: v.optional(v.id('users')),
    identity: v.optional(sessionRequestIdentityValidator),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const agent = await requireAgentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
    const { userId } = await agentDeleteActor(ctx, args)
    assertMutableOriginAgent(agent)
    const fanout = await deleteAgentSubtree(ctx, {
      agent,
      anchor: await requireAnchor(ctx, agent.anchorId),
      actorId: userId,
      now: args.now ?? Date.now(),
    })
    return { ok: true as const, ...fanout }
  },
})

/**
 * Authorize the public agent-delete route before it stops every runner for the
 * agent. The delete mutation repeats this exact check after the gateway leg.
 */
export const preflightAgentDelete = query({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.string(),
    actorId: v.id('users'),
    identity: sessionRequestIdentityValidator,
  },
  handler: async (ctx, args) => {
    await agentDeleteActor(ctx, args)
    const agent = await agentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
    return agent === null ? null : await toAgentWithAnchor(ctx, agent)
  },
})

export const listByWorkspace = query({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.optional(v.string()),
    id: v.optional(v.string()),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await authorizeRead(ctx, args.workspaceId, args.internalKey)
    if (args.id !== undefined && args.slug !== undefined) {
      throw new Error('id and slug filters are mutually exclusive')
    }
    if (args.id !== undefined) {
      const id = ctx.db.normalizeId('agents', args.id)
      if (id === null) return []
      const agent = await ctx.db.get(id)
      return agent === null || agent.workspaceId !== args.workspaceId
        ? []
        : [await toAgentWithAnchor(ctx, agent)]
    }
    if (args.slug !== undefined) {
      const agent = await agentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
      return agent === null ? [] : [await toAgentWithAnchor(ctx, agent)]
    }
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .take(MAX_AGENTS_PER_WORKSPACE + 1)
    if (agents.length > MAX_AGENTS_PER_WORKSPACE) throw new Error('Workspace agent limit exceeded')
    return await Promise.all(
      agents
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .map(agent => toAgentWithAnchor(ctx, agent)),
    )
  },
})

export const getBySlug = query({
  args: {
    workspaceId: v.id('workspaces'),
    slug: v.string(),
    internalKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await authorizeRead(ctx, args.workspaceId, args.internalKey)
    const agent = await agentBySlug(ctx, args.workspaceId, AppSlugSchema.parse(args.slug))
    return agent === null ? null : await toAgentWithAnchor(ctx, agent)
  },
})

export async function toAgentWithAnchor(ctx: QueryCtx | MutationCtx, agent: Doc<'agents'>) {
  return toAgent(agent, await requireAnchor(ctx, agent.anchorId))
}

function assertMutableOriginAgent(
  agent: Pick<Doc<'agents'>, 'sourceShareId' | 'sourceAgentId'>,
): void {
  if (agent.sourceShareId !== undefined || agent.sourceAgentId !== undefined)
    throw new Error('Replica agents are read-only')
}

async function authorizeRead(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  internalKey?: string,
): Promise<void> {
  if (internalKey !== undefined) requireApiInternalKey(internalKey)
  else await assertRole(ctx, workspaceId, 'viewer')
}

async function agentMutationActor(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
) {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId === undefined)
      throw new Error('actorId is required for internal agent mutation')
    return await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  return await assertRole(ctx, args.workspaceId, 'editor')
}

async function agentDeleteActor(
  ctx: QueryCtx | MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    internalKey?: string
    actorId?: Id<'users'>
    identity?: SessionRequestIdentity
  },
) {
  if (args.internalKey === undefined) {
    if (args.actorId !== undefined || args.identity !== undefined) {
      throw new Error('Agent delete attribution requires internal key')
    }
    return await assertRole(ctx, args.workspaceId, 'editor')
  }
  requireApiInternalKey(args.internalKey)
  if (args.actorId === undefined || args.identity === undefined) {
    throw new Error('Internal agent delete requires identity and attribution')
  }
  assertSessionIdentityAttribution(args.identity, args.actorId)
  if (args.identity.principal.kind === 'workspace') {
    const user = await ctx.db.get(args.actorId)
    if (user === null) throw new Error('Agent delete attribution user not found')
    return { userId: user._id }
  }
  try {
    return await assertActorRole(ctx, args.workspaceId, args.identity.principal.userId, 'editor')
  } catch {
    throwSessionError('forbidden')
  }
}

async function assertSlugAvailable(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
  anchorId: Id<'anchors'>,
): Promise<void> {
  const existing = await agentBySlug(ctx, workspaceId, slug)
  if (existing !== null && existing.anchorId !== anchorId)
    throw new Error('Agent slug already exists')
}

async function requireAgent(ctx: QueryCtx | MutationCtx, agentId: Id<'agents'>) {
  const agent = await ctx.db.get(agentId)
  if (agent === null) throw new Error('Agent not found')
  return agent
}

async function requireAgentBySlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
) {
  const agent = await agentBySlug(ctx, workspaceId, slug)
  if (agent === null) throw new Error('Agent not found')
  return agent
}

async function agentBySlug(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  slug: string,
) {
  return await ctx.db
    .query('agents')
    .withIndex('by_workspace_and_slug', q => q.eq('workspaceId', workspaceId).eq('slug', slug))
    .unique()
}

async function agentByAnchor(ctx: QueryCtx | MutationCtx, anchorId: Id<'anchors'>) {
  return await ctx.db
    .query('agents')
    .withIndex('by_anchor', q => q.eq('anchorId', anchorId))
    .unique()
}
