import {
  AgentListResponseSchema,
  AgentListQuerySchema,
  AgentResponseSchema,
  DefaultAgentResponseSchema,
  DeleteAgentResponseSchema,
  isCollectionCursorError,
  OpenOnboardingSessionResponseSchema,
  RegisterAgentRequestSchema,
  RegisterAgentResponseSchema,
  SetAgentDisabledRequestSchema,
  SetAgentOnboardedRequestSchema,
  UpdateAgentRequestSchema,
  UpdateDefaultAgentRequestSchema,
} from '@repo/contract'

import { createMaterializedCollectionPage } from '../collection-page'
import type { GatewayClient } from '../gateway/client'
import { sessionErrorResponse } from '../session-errors'
import { sessionRequestIdentityForAuth } from '../session-principal'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'
import { appRowAnchorPath, settleAppRegistrations } from './apps'
import { pushAffectedRecipientAnchors } from './apps-fanout'

const agentPages = createMaterializedCollectionPage('agents.list')

export function registerAgentsRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/ws/:workspaceSlug/agents', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const query = AgentListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const rows = await runtime.convex.query(fnQuery('domains/agents/model:listByWorkspace'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      ...(query.data.id === undefined ? {} : { id: query.data.id }),
      ...(query.data.slug === undefined ? {} : { slug: query.data.slug }),
    })
    try {
      const page = await agentPages.response(
        query.data,
        {
          subject: `workspace:${workspace.id}`,
          filters: { id: query.data.id ?? null, slug: query.data.slug ?? null },
          order: 'slug asc, agent id asc',
        },
        rows as Array<{ id: string; slug: string }>,
        row => [row.slug, row.id],
      )
      return c.json(AgentListResponseSchema.parse(page))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.post('/v1/ws/:workspaceSlug/agents', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const body = RegisterAgentRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      // Rollback snapshots for any declared app being re-registered, captured
      // before the mutation rewrites them. Declarations must sit under the
      // agent's own path, so its subtree covers every candidate.
      const previousApps =
        body.data.apps === undefined || body.data.apps.length === 0
          ? []
          : ((await runtime.convex.query(fnQuery('domains/apps/model:listByWorkspace'), {
              internalKey: runtime.internalKey,
              workspaceId: workspace.id,
              path: body.data.path,
              scope: 'subtree',
            })) as unknown[])
      const { registeredApps, apps, ...agent } = (await runtime.convex.mutation(
        fn('domains/agents/model:registerAgent'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          ...body.data,
        },
      )) as {
        registeredApps: unknown[]
        apps: Array<{ path: string }>
      } & Record<string, unknown>
      const reconcile = await gatewayClient.pushAnchorsReconcile(workspace.slug)
      if (!reconcile.ok) return reconcile.response
      // Registering at a path IS the ownership proof the anchor rail's
      // anti-hijack refusal wants, so a register leaves no anchor it names
      // `broken` — the agent's own or a declared app's (a folder deleted and
      // recreated out from under either breaks it). The check runs AFTER the
      // reconcile push above because that push is synchronous end-to-end: a
      // break the gateway had not yet observed (the marker died within the
      // last poll cycle) is reported and recorded during it. Healing re-mints
      // the marker nonce — the fresh evidence that lets the gateway re-adopt
      // the folder on the second push instead of refusing the same claim.
      const healed = await healRegisteredAnchors(
        runtime,
        workspace.id,
        c.get('auth').user.id,
        new Set([agent.anchorPath as string, ...apps.map(app => app.path)]),
      )
      let responseAgent: unknown = agent
      if (healed.length > 0) {
        const reAdopt = await gatewayClient.pushAnchorsReconcile(workspace.slug)
        if (!reAdopt.ok) return reAdopt.response
        await pushAffectedRecipientAnchors(runtime, gatewayClient, ...healed)
        responseAgent = await runtime.convex.query(fnQuery('domains/agents/model:getBySlug'), {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          slug: agent.slug as string,
        })
      }
      await pushAffectedRecipientAnchors(runtime, gatewayClient, agent)
      // The apps this register materialised settle through the SAME wait/report
      // path as standalone registration: a 201 here means the whole agent —
      // its apps included — is running, not queued for a later sync poll.
      const settled = await settleAppRegistrations(
        c,
        runtime,
        gatewayClient,
        workspace,
        'register',
        registeredApps.map(row => ({
          row,
          previous: previousApps.find(
            previous => appRowAnchorPath(previous) === appRowAnchorPath(row),
          ),
        })),
      )
      if (!settled.ok) return settled.response
      // The response accounts for every DECLARED app — created, updated, or
      // unchanged — because a 201 that says nothing about them is
      // indistinguishable from a server that silently dropped them.
      return c.json(
        RegisterAgentResponseSchema.parse({
          agent: publicAgentMutationResult(responseAgent),
          apps,
        }),
        201,
      )
    } catch (error) {
      return agentMutationError(c, error)
    }
  })

  // Before the `:slug` route below, so the default agent's static segment wins.
  // `root` is a reserved slug, so this can never shadow a real agent. No anchor
  // reconcile either: `duetName` is neither anchor nor VM configuration.
  app.patch('/v1/ws/:workspaceSlug/agents/root', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const body = UpdateDefaultAgentRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const renamed = await runtime.convex.mutation(fn('domains/agents/model:updateDefaultAgent'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        ...body.data,
      })
      return c.json(DefaultAgentResponseSchema.parse(renamed))
    } catch (error) {
      return agentMutationError(c, error)
    }
  })

  app.patch('/v1/ws/:workspaceSlug/agents/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const body = UpdateAgentRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const agent = await runtime.convex.mutation(fn('domains/agents/model:updateAgent'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        ...body.data,
      })
      const reconcile = await gatewayClient.pushAnchorsReconcile(workspace.slug)
      if (!reconcile.ok) return reconcile.response
      await pushAffectedRecipientAnchors(runtime, gatewayClient, agent)
      return c.json(AgentResponseSchema.parse({ agent: publicAgentMutationResult(agent) }))
    } catch (error) {
      return agentMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/agents/:slug/disabled', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const body = SetAgentDisabledRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const agent = await runtime.convex.mutation(fn('domains/agents/model:setAgentDisabled'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        disabled: body.data.disabled,
        now: runtime.now(),
      })
      // Disablement removes the agent only from future launch resolution. Existing
      // sessions keep running, so this route intentionally performs anchor projection
      // reconciliation without calling the agent session-teardown endpoint.
      const reconcile = await gatewayClient.pushAnchorsReconcile(workspace.slug)
      if (!reconcile.ok) return reconcile.response
      return c.json(AgentResponseSchema.parse({ agent: publicAgentMutationResult(agent) }))
    } catch (error) {
      return agentMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/agents/:slug/onboarded', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const body = SetAgentOnboardedRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const agent = await runtime.convex.mutation(fn('domains/agents/model:setAgentOnboarded'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
        onboarded: body.data.onboarded,
        now: runtime.now(),
      })
      await gatewayClient.refreshAgentRoster(workspace.slug)
      return c.json(AgentResponseSchema.parse({ agent: publicAgentMutationResult(agent) }))
    } catch (error) {
      return agentMutationError(c, error)
    }
  })

  // The same completion for the other half of onboarding: an agent whose
  // `agent.json` names an app runs no interview, so the app is the only thing
  // present when the user finishes. It holds nothing but its own runtime key —
  // no session id, no agent slug, not even its own app slug — so the credential
  // is the address. Convex resolves the agent from the app's folder.
  app.post('/v1/ws/:workspaceSlug/app/onboarded', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents', { allowIncomplete: true })
    if ('response' in workspace) return workspace.response
    const callingApp = c.get('auth').app
    if (callingApp === undefined) return c.json({ error: 'app_credential_required' }, 403)
    const body = SetAgentOnboardedRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const agent = await runtime.convex.mutation(fn('domains/agents/model:setAppAgentOnboarded'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        appId: callingApp.id,
        onboarded: body.data.onboarded,
        now: runtime.now(),
      })
      await gatewayClient.refreshAgentRoster(workspace.slug)
      return c.json(AgentResponseSchema.parse({ agent: publicAgentMutationResult(agent) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // No agent resolved for the app's folder: it sits at the workspace root
      // rather than under an agent, or the agent it belongs to is disabled or
      // its anchor is not active. None of those is a missing row, and none is
      // something the app can retry into, so they share one honest answer.
      if (/no owning agent/i.test(message)) return c.json({ error: 'not_agent_app' }, 409)
      return agentMutationError(c, error)
    }
  })

  // The same completion, keyed by the onboarding conversation itself. The agent
  // running the interview knows only $DUET_SESSION_ID; the slug route above
  // forced it to first derive the workspace and agent slugs, and a live e2e
  // caught a real runner skipping that ceremony and stranding the user behind a
  // locked card. Registered here rather than in agent.ts because it mutates
  // agent state — the session id is merely how the agent names it.
  app.post('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/onboarded', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents', { allowIncomplete: true })
    if ('response' in workspace) return workspace.response
    const body = SetAgentOnboardedRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const agent = await runtime.convex.mutation(
        fn('domains/agents/model:setSessionAgentOnboarded'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          onboarded: body.data.onboarded,
          now: runtime.now(),
        },
      )
      await gatewayClient.refreshAgentRoster(workspace.slug)
      return c.json(AgentResponseSchema.parse({ agent: publicAgentMutationResult(agent) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not an onboarding session/i.test(message)) {
        return c.json({ error: 'not_onboarding_session' }, 409)
      }
      // A malformed session id fails the mutation's id validator before the
      // handler runs; to the caller that is indistinguishable from a session
      // that does not exist.
      if (/ArgumentValidationError|does not match validator/i.test(message)) {
        return c.json({ error: 'not_found' }, 404)
      }
      return agentMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/agents/:slug/onboarding-session', async c => {
    // Scoped to `sessions`, not `agents`: this starts a conversation and spends
    // model capacity, so it belongs to the capability that governs sessions.
    const workspace = requireAuthedWorkspace(c, 'sessions', { allowIncomplete: true })
    if ('response' in workspace) return workspace.response
    if ((await c.req.raw.text()).length !== 0) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const agent = (await runtime.convex.query(fnQuery('domains/agents/model:getBySlug'), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      slug: c.req.param('slug'),
    })) as { id: string } | null
    if (agent === null) return c.json({ error: 'not_found' }, 404)
    try {
      const opened = await runtime.convex.mutation(
        fn('domains/agentSessions/creation:openOnboardingSession'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          identity: sessionRequestIdentityForAuth(c.get('auth')),
          workspaceId: workspace.id,
          agentId: agent.id,
          now: runtime.now(),
        },
      )
      return c.json(OpenOnboardingSessionResponseSchema.parse(opened))
    } catch (error) {
      return agentMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/agents/:slug', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    // Runner-teardown half of D16, gateway-first and fail-closed like session delete:
    // stop the agent's live runners on the still-running VM before hiding the agent. If
    // the gateway is unreachable we delete nothing (502) rather than orphan live runners.
    let agent: {
      anchorId: string
      anchorPath: string
      sourceShareId?: string
      sourceAgentId?: string
    } | null
    try {
      agent = (await runtime.convex.query(fnQuery('domains/agents/model:preflightAgentDelete'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
      })) as typeof agent
    } catch (error) {
      return agentMutationError(c, error)
    }
    if (agent === null) return c.json(DeleteAgentResponseSchema.parse({ ok: true }))
    // Assert mutability BEFORE the teardown leg. A replica (shared-in) agent is
    // read-only — `deleteAgent` would throw and the route would 403 — but the
    // teardown runs first, so a direct-API replica delete used to kill the
    // recipient's runners and only THEN refuse (row intact, runners gone). The UI
    // never offers replica delete (D21), but the seam must fail closed on its own:
    // refuse before touching the gateway. Mirrors the backend guard's own check.
    if (agent.sourceShareId !== undefined || agent.sourceAgentId !== undefined) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const torndown = await gatewayClient
      .callAgent(c, workspace.slug, {
        path: `/v1/agent/agents/${encodeURIComponent(agent.anchorId)}/sessions`,
        method: 'DELETE',
        body: JSON.stringify({}),
        allowPaused: true,
        failureOperation: 'agent_delete',
      })
      .catch(() => null)
    if (torndown === null) return c.json({ error: 'agent_gateway_unavailable' }, 502)
    if ('response' in torndown) {
      if (torndown.response.status === 404 || torndown.response.status === 402) {
        return c.json({ error: 'agent_gateway_unavailable' }, 502)
      }
      return torndown.response
    }
    let result: unknown
    try {
      result = await runtime.convex.mutation(fn('domains/agents/model:deleteAgent'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        workspaceId: workspace.id,
        slug: c.req.param('slug'),
      })
    } catch (error) {
      if (error instanceof Error && /Agent not found/.test(error.message)) {
        result = { ok: true }
      } else {
        return agentMutationError(c, error)
      }
    }
    // Firing an agent takes its folder with it. An agent IS an anchored folder, so
    // leaving the folder behind would leave the filesystem still claiming an agent
    // the roster no longer has — the same residue, mirrored. Second leg on purpose:
    // the rows are already gone, so a failure here leaves an inert plain folder
    // rather than rows pointing at a folder that isn't there.
    const removed = await gatewayClient.deleteDriveFolder(workspace.slug, agent.anchorPath)
    if (!removed.ok) {
      console.error(
        `[agents] ${workspace.slug} folder delete for ${agent.anchorPath} -> ${removed.reason}`,
      )
    }
    // The control-plane deletion above is authoritative; the anchor reconcile push is
    // best-effort cleanup. A paused or unreachable gateway must not turn a completed
    // deletion into a 502 — the agent is already gone (slice 13 requires delete to work
    // while paused), and a retry would 404 on the missing agent and re-refuse forever.
    // The gateway re-syncs its anchor set on resume.
    await gatewayClient.pushAnchorsReconcile(workspace.slug)
    await pushAffectedRecipientAnchors(runtime, gatewayClient, result)
    return c.json(DeleteAgentResponseSchema.parse(publicAgentMutationResult(result)))
  })
}

/**
 * Reanchor — at its own path — every broken anchor among the ones a register
 * call just named. Scoped to exactly those paths: registration is evidence
 * for what it declares, not a blanket blessing of the folder tree. Returns
 * the reanchor results (each carries `affectedRecipientWorkspaceIds` for the
 * recipient fan-out); empty means nothing was broken and no second gateway
 * push is owed.
 */
async function healRegisteredAnchors(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  actorId: string,
  paths: ReadonlySet<string>,
): Promise<unknown[]> {
  const anchors = (await runtime.convex.query(fnQuery('domains/anchors/model:listByWorkspace'), {
    internalKey: runtime.internalKey,
    workspaceId,
  })) as Array<{ id: string; path: string; state: string }>
  const healed: unknown[] = []
  for (const anchor of anchors) {
    if (anchor.state !== 'broken' || !paths.has(anchor.path)) continue
    try {
      healed.push(
        await runtime.convex.mutation(fn('domains/anchors/model:reanchor'), {
          internalKey: runtime.internalKey,
          actorId,
          anchorId: anchor.id,
          path: anchor.path,
        }),
      )
    } catch (error) {
      // A concurrent repair between the list and this call already healed it;
      // anything else is a real failure.
      if (!(error instanceof Error && /not broken/i.test(error.message))) throw error
    }
  }
  return healed
}

function publicAgentMutationResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const { affectedRecipientWorkspaceIds: _, ...publicResult } = result as Record<string, unknown>
  return publicResult
}

function agentMutationError(c: ApiContext, error: unknown) {
  try {
    return sessionErrorResponse(c, error)
  } catch {
    // Agent-domain errors retain their existing typed route mapping below.
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/Requires editor access|read-only/.test(message)) return c.json({ error: 'forbidden' }, 403)
  if (/already exists/.test(message)) return c.json({ error: 'conflict' }, 409)
  if (/Invalid|No agent update fields|outside the agent folder/.test(message))
    return c.json({ error: 'invalid_request' }, 400)
  throw error
}
