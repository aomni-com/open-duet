import { waitUntil as vercelWaitUntil } from '@vercel/functions'
import { ConvexError } from 'convex/values'
import { z } from 'zod'

import {
  AddMcpServerRequestSchema,
  McpServerAgentPolicyResponseSchema,
  McpServerListSchema,
  McpServerListQuerySchema,
  McpServerNameSchema,
  McpServerProbeRequestSchema,
  McpServerProbeSchema,
  McpServerSchema,
  isCollectionCursorError,
  RemoveMcpServerResponseSchema,
  SetMcpServerAgentPolicyRequestSchema,
  type McpServerRequestAuth,
} from '@repo/contract'

import { createMaterializedCollectionPage } from '../collection-page'
import { resolveApiUrl, resolveEdgeHost, resolveMcpToolResultBytes } from '../config'
import { customMcpUpstreamSource, type McpServerHealthSignal } from '../mcp/credentials'
import { disconnectMcpServer } from '../mcp/disconnect'
import {
  beginMcpOAuthConsent,
  completeMcpOAuthConsent,
  McpConsentFailedError,
  type McpOAuthDeps,
} from '../mcp/oauth'
import { McpProbeFailure, probeMcpServer, type McpProbeOutcome } from '../mcp/probe'
import { forwardMcpRequest, withUpstreamTimeout } from '../mcp/proxy'
import { McpReauthRequiredError, resolveMcpProxyCredential } from '../mcp/refresh'
import {
  duetMcpClientMetadataDocument,
  McpAuthorizationServerUnreachableError,
  McpClientRegistrationFailedError,
  McpOAuthUnsupportedError,
  MCP_CLIENT_METADATA_PATH,
  MCP_OAUTH_CALLBACK_PATH,
} from '../mcp/registration'
import { BlockedUpstreamUrlError, guardedFetch, type HostResolver } from '../mcp/ssrf'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  requireWorkspaceFromKey,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type WaitUntil,
} from '../shared'
import { consumePreAuthRateLimit, networkIdentity } from './pre-auth-rate-limit'

/**
 * Add, probe, list, scope and remove the remote MCP servers a workspace
 * attaches for itself.
 *
 * A separate endpoint family from `/integrations/*` on purpose. That route set
 * calls Composio on every list and turns any provider failure into a 502 for
 * the whole response, so serving a workspace's own servers from there would
 * hide them during someone else's outage — undoing D16's blast-radius
 * isolation one layer above where D16 operates. They share a capability
 * (`integrations`, D9) and a docs category, and nothing else.
 *
 * Every route here is guarded exactly as the Composio ones are: any workspace
 * member, no role check and no tier gate (D14), the same as connecting an app.
 */

const MODEL = 'domains/mcpServers/model'
const CREDENTIALS = 'domains/mcpServers/credentials'
const HEALTH = 'domains/mcpServers/health'
const mcpServerPages = createMaterializedCollectionPage('mcp-servers.list')

export interface McpServerRouteOptions {
  /** Injected by tests so the SSRF guard can be exercised without DNS. */
  resolveHost?: HostResolver
  /** Injected by tests so a hung upstream does not cost the suite real seconds. */
  upstreamTimeoutMs?: number
  /** This deployment's own origin: D24's document has to name itself. */
  apiUrl?: string
  /** Whether a forwarded-for header may be believed, for the callback's bucket. */
  trustProxyHeaders?: boolean
  waitUntil?: WaitUntil
}

/**
 * The consent return, which a third party redirects a browser to with no Duet
 * credential on it at all. Everything it needs to be safe is inside the signed
 * `state` and the row that state hashes to.
 */
export const MCP_SERVERS_AUTH_BYPASS_PATHS = [MCP_OAUTH_CALLBACK_PATH] as const

/**
 * A human clicking through a consent screen, not a machine polling. The bucket
 * is shared with `/oauth/authorize` because both are the same thing from the
 * limiter's point of view — an unauthenticated browser landing on an OAuth
 * endpoint — and the endpoint vocabulary is closed in `@repo/contract`.
 */
const MCP_OAUTH_CALLBACK_RATE_LIMIT = 60

/**
 * Where the human should land once consent is done. Validated here against
 * `allowedIntegrationRedirect` and again at the callback, so this is a hint
 * about which page, never a way to point Duet's redirect anywhere.
 *
 * Local rather than in `@repo/contract` because neither this route nor the
 * callback is a published endpoint: one answers a URL only a browser can act
 * on, and the other is a redirect target for a third party.
 */
const ConnectMcpServerRequestSchema = z.object({ redirectTo: z.string().max(2_048).optional() })

export function registerMcpServerRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  options: McpServerRouteOptions = {},
): void {
  /**
   * D24's Client ID Metadata Document, and Duet's `client_id` for every
   * authorization server that supports one — which, per slice 00, is every
   * OAuth-capable server probed.
   *
   * Deliberately outside `/v1`: it is not a Duet capability, it is a document
   * third-party authorization servers fetch anonymously mid-authorization, and
   * the `/v1` guard would answer them 401. Its URL must stay stable and served
   * for as long as any workspace holds a grant obtained with it — moving it
   * breaks consent for every such server at once.
   */
  const apiUrl = options.apiUrl ?? resolveApiUrl()
  app.get(MCP_CLIENT_METADATA_PATH, c => {
    // Cacheable on purpose: an authorization server may resolve this on every
    // authorization request, and it changes only when the deployment does.
    c.header('cache-control', 'public, max-age=3600')
    return c.json(duetMcpClientMetadataDocument(apiUrl))
  })

  app.post('/v1/ws/:workspaceSlug/mcp-servers/probe', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const body = McpServerProbeRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      return c.json(probeResponse(await probe(runtime, options, body.data)))
    } catch (error) {
      return probeFailureResponse(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/mcp-servers', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const body = AddMcpServerRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const auth: McpServerRequestAuth = body.data.auth ?? { kind: 'none' }

    // The probe runs first and its failure is the whole answer: a server Duet
    // could not reach, or could not reach with the credential offered, never
    // becomes a row. A row that exists is a row that worked once.
    let probed: McpProbeOutcome
    try {
      probed = await probe(runtime, options, { ...body.data, auth })
    } catch (error) {
      return probeFailureResponse(c, error)
    }
    // The credential the caller brought must be the one the server asked for.
    // Registering an OAuth server as no-auth would produce a row that can never
    // work, and registering a no-auth server as OAuth would park it in
    // `needs_auth` waiting for a consent screen no server will ever show.
    if (auth.kind !== 'oauth' && probed.auth === 'oauth') {
      return c.json({ error: 'auth_required' }, 400)
    }
    if (auth.kind === 'oauth' && probed.auth === 'none') {
      return c.json({ error: 'auth_not_required' }, 400)
    }

    try {
      const server = (await runtime.convex.mutation(fn(`${MODEL}:registerMcpServer`), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        actorId: c.get('auth').user.id,
        name: body.data.name,
        url: body.data.url,
        ...(body.data.label === undefined ? {} : { label: body.data.label }),
        authKind: auth.kind,
        // Measured once, here, and never recomputed by a turn. An OAuth server
        // has nothing to measure until it is consented to, so it carries no
        // numbers rather than zeroes that would read as "free".
        ...(probed.auth === 'oauth'
          ? {}
          : {
              toolCount: probed.toolCount,
              estimatedPromptBytes: probed.estimatedPromptBytes,
              droppedToolNames: probed.droppedToolNames,
            }),
        now: runtime.now(),
      })) as { id: string }
      if (auth.kind === 'static') {
        await storeStaticToken(runtime, workspace.id, server.id, auth.token, body.data.name)
      }
      return c.json(McpServerSchema.parse(server), 201)
    } catch (error) {
      return convexFailureResponse(c, error)
    }
  })

  const oauthDeps = (): McpOAuthDeps => ({
    convex: runtime.convex,
    internalKey: runtime.internalKey,
    // The same secret the Composio callback signs its descriptor with: both are
    // Duet handing a blob to a third party and reading it back.
    secret: runtime.apiInternalKey,
    fetchImpl: runtime.fetchImpl,
    ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
    apiUrl,
    appUrl: runtime.appUrl,
    edgeHost: resolveEdgeHost(),
    now: runtime.now,
  })

  /**
   * D2's OAuth branch, under a human's click.
   *
   * The answer is a URL, not a redirect: the browser must reach the third
   * party's consent page by a **top-level navigation**, and a page that tried
   * to frame it would simply be refused by most of them.
   */
  app.post('/v1/ws/:workspaceSlug/mcp-servers/:name/connect', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const name = McpServerNameSchema.safeParse(c.req.param('name'))
    if (!name.success) return c.json({ error: 'invalid_request' }, 400)
    const body = ConnectMcpServerRequestSchema.safeParse((await readJson(c.req.raw)) ?? {})
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)

    const server = (await runtime.convex.query(fnQuery(`${MODEL}:getMcpServer`), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
      name: name.data,
    })) as { id: string; name: string; url: string; authKind: string } | null
    if (server === null) return c.json({ error: 'not_found' }, 404)
    // A no-auth or static server has no consent to give. Walking one through
    // this flow would park a working row in `needs_auth`.
    if (server.authKind !== 'oauth') return c.json({ error: 'auth_not_required' }, 400)

    try {
      return c.json(
        await beginMcpOAuthConsent(oauthDeps(), {
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          server: { id: server.id, name: server.name, url: server.url },
          destination: body.data.redirectTo ?? `/w/${workspace.slug}/integrations`,
        }),
      )
    } catch (error) {
      return connectFailureResponse(c, error)
    }
  })

  /**
   * The consent return. Auth-bypassed, because a third party sends the browser
   * here with no Duet credential; rate-limited for the same reason.
   *
   * A failure answers in Duet's own words. The authorization server's `error`,
   * `error_description` and `error_uri` are attacker-influenced text on a
   * response that may not even have come from the right issuer, so they are
   * never echoed and never shown.
   */
  app.get(MCP_OAUTH_CALLBACK_PATH, async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'oauth_authorize',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders ?? false),
      limit: MCP_OAUTH_CALLBACK_RATE_LIMIT,
    })
    if (limited !== null) return limited
    try {
      const { location } = await completeMcpOAuthConsent(oauthDeps(), {
        state: c.req.query('state'),
        code: c.req.query('code'),
        iss: c.req.query('iss'),
        error: c.req.query('error'),
      })
      return c.redirect(location, 302)
    } catch (error) {
      if (error instanceof McpConsentFailedError) return c.json({ error: error.failure }, 400)
      console.error('[mcp-oauth] callback failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'consent_failed' }, 502)
    }
  })

  app.get('/v1/ws/:workspaceSlug/mcp-servers', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const query = McpServerListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const rows = (await runtime.convex.query(fnQuery(`${MODEL}:listMcpServers`), {
      internalKey: runtime.internalKey,
      workspaceId: workspace.id,
    })) as unknown[]
    // Parsed through the wire schema rather than spread: the schema is what
    // keeps a future column — a token most of all — from reaching a response
    // just because someone added it to the row.
    try {
      const page = await mcpServerPages.response(
        query.data,
        {
          subject: `workspace:${workspace.id}`,
          filters: {},
          order: 'name asc (unique workspace identity)',
        },
        rows.map(row => McpServerSchema.parse(row)),
        row => [row.name],
      )
      return c.json(McpServerListSchema.parse(page))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  /**
   * D18's other half: removal revokes what it can before it forgets.
   *
   * The response says what was ATTEMPTED upstream, never what the third party
   * did — RFC 7009 makes a `200` mandatory for a token nobody recognizes — and
   * the local rows go regardless of both answers.
   */
  app.delete('/v1/ws/:workspaceSlug/mcp-servers/:name', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const name = McpServerNameSchema.safeParse(c.req.param('name'))
    if (!name.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await disconnectMcpServer(
        {
          convex: runtime.convex,
          internalKey: runtime.internalKey,
          fetchImpl: runtime.fetchImpl,
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          apiUrl,
          now: runtime.now,
        },
        { workspaceId: workspace.id, name: name.data },
      )
      return c.json(RemoveMcpServerResponseSchema.parse(result))
    } catch (error) {
      return convexFailureResponse(c, error)
    }
  })

  app.put('/v1/ws/:workspaceSlug/mcp-servers/:name/agent-policy', async c => {
    const workspace = requireAuthedWorkspace(c, 'integrations')
    if ('response' in workspace) return workspace.response
    const name = McpServerNameSchema.safeParse(c.req.param('name'))
    const body = SetMcpServerAgentPolicyRequestSchema.safeParse(await readJson(c.req.raw))
    if (!name.success || !body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      // Absent means every agent, and the third state is the ABSENCE of a row,
      // so clearing is its own mutation rather than a write of `[]` — which
      // means nobody.
      const result = await runtime.convex.mutation(
        fn(
          body.data.allowedAgentIds === undefined
            ? `${MODEL}:clearMcpServerAgentPolicy`
            : `${MODEL}:setMcpServerAgentPolicy`,
        ),
        {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          name: name.data,
          ...(body.data.allowedAgentIds === undefined
            ? {}
            : { allowedAgentIds: body.data.allowedAgentIds }),
        },
      )
      return c.json(McpServerAgentPolicyResponseSchema.parse(result))
    } catch (error) {
      return convexFailureResponse(c, error)
    }
  })

  // One deadline for the whole hop, redirects included, and the SSRF guard
  // inside it so no user-supplied address is ever fetched unchecked.
  const upstreamFetch = withUpstreamTimeout(
    guardedFetch(runtime.fetchImpl, options.resolveHost),
    options.upstreamTimeoutMs,
  )
  const waitUntil = options.waitUntil ?? vercelWaitUntil

  /**
   * D4's byte path: the runner's tool calls, forwarded with the workspace's
   * credential attached here rather than anywhere the VM can read it.
   *
   * Workspace-scoped, with no session segment — unlike the Composio transport
   * next door, whose URL names a session because the *provider session* is
   * conversation-scoped. A custom server has no such thing: the credential and
   * the policy belong to the workspace (D5, D12), and which servers an agent
   * gets at all is decided once, when the launch marker is projected. A session
   * id in the path would buy one ownership lookup per tool call and protect
   * nothing, and a URL another agent in the same workspace could guess is not a
   * boundary Duet defends — inside a workspace VM there is one trust domain.
   *
   * `mcp-session-id` isolation falls out of this shape for free: one Duet URL
   * maps to one upstream, the header is forwarded verbatim, and there is no
   * shared session-id store to get it wrong.
   */
  for (const method of ['post', 'get', 'delete'] as const) {
    app[method]('/v1/ws/:workspaceSlug/mcp/:name', async c => {
      // The gateway presents the workspace's own API key, so the guard is the
      // key-shaped one the Composio transport uses, not the browser-shaped one
      // the lifecycle routes above use.
      const workspace = requireWorkspaceFromKey(c, 'integrations', c.req.param('workspaceSlug'))
      if ('response' in workspace) return workspace.response
      const name = McpServerNameSchema.safeParse(c.req.param('name'))
      if (!name.success) return c.json({ error: 'not_found' }, 404)
      // A server that is not registered is a 404, never a 503: the runner is
      // asking for something that does not exist, not hitting an outage, and
      // conflating the two would have it retry forever.
      const server = (await runtime.convex.query(fnQuery(`${MODEL}:getMcpServer`), {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        name: name.data,
      })) as { id: string; name: string; url: string } | null
      if (server === null) return c.json({ error: 'not_found' }, 404)

      const recordHealth = async (signal: McpServerHealthSignal) =>
        await runtime.convex.mutation(fn(`${HEALTH}:recordMcpServerHealth`), {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          name: server.name,
          outcome: signal.outcome,
          ...(signal.errorCode === undefined ? {} : { errorCode: signal.errorCode }),
          now: runtime.now(),
        })
      const source = customMcpUpstreamSource({
        server,
        requestMethod: c.req.method,
        // Read per request, and refreshed here if it is at the end of its life.
        // The SDK's `auth()` is never called on this path: it refreshes with no
        // expiry check at all, which from N lambdas rotates the refresh token
        // once per tool call.
        readCredential: async () =>
          await resolveMcpProxyCredential({
            convex: runtime.convex,
            internalKey: runtime.internalKey,
            workspaceId: workspace.id,
            server,
            apiUrl,
            fetchImpl: runtime.fetchImpl,
            ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
            now: runtime.now,
          }),
        recordHealth,
        schedule: waitUntil,
      })
      try {
        return await forwardMcpRequest(upstreamFetch, c.req.raw, source, {
          maxToolResultBytes: resolveMcpToolResultBytes(),
        })
      } catch (error) {
        if (error instanceof McpReauthRequiredError) {
          // Nothing was sent upstream, so the forwarder never told the health
          // rail anything. This is the one failure a user can act on, so it is
          // the one the row must name.
          waitUntil(
            recordHealth({ outcome: 'error', errorCode: 'reauth_required' }).catch(() => undefined),
          )
          return c.json({ error: 'reauth_required' }, 401)
        }
        return upstreamFailureResponse(c, error)
      }
    })
  }
}

/**
 * Nothing answered. The health row already carries the reason — the forwarder
 * told the source before raising — so this only has to give the runner a fast,
 * unambiguous failure instead of an exception.
 */
function upstreamFailureResponse(c: ApiContext, error: unknown): Response {
  if (error instanceof BlockedUpstreamUrlError) {
    return c.json({ error: 'url_not_allowed' }, 502)
  }
  console.error('[mcp-proxy] upstream failed', {
    server: c.req.param('name'),
    error: error instanceof Error ? error.message : String(error),
  })
  return c.json({ error: 'upstream_unreachable' }, 502)
}

async function probe(
  runtime: ApiRouteRuntime,
  options: McpServerRouteOptions,
  request: { name: string; url: string; auth?: McpServerRequestAuth },
): Promise<McpProbeOutcome> {
  return await probeMcpServer({
    name: request.name,
    url: request.url,
    auth: request.auth ?? { kind: 'none' },
    fetchImpl: runtime.fetchImpl,
    ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
  })
}

function probeResponse(probed: McpProbeOutcome) {
  return McpServerProbeSchema.parse({
    auth: probed.auth,
    toolCount: probed.toolCount,
    estimatedPromptBytes: probed.estimatedPromptBytes,
    droppedToolNames: probed.droppedToolNames,
    ...(probed.registrationSupported === undefined
      ? {}
      : { registrationSupported: probed.registrationSupported }),
  })
}

/**
 * A pasted token goes to the credential table, never onto the server row.
 *
 * If the write fails the server is removed again rather than left behind: a
 * static server with no credential is a row that can only ever 401, and the
 * add the user just made would have quietly half-succeeded.
 */
async function storeStaticToken(
  runtime: ApiRouteRuntime,
  workspaceId: string,
  serverId: string,
  token: string,
  name: string,
): Promise<void> {
  try {
    await runtime.convex.mutation(fn(`${CREDENTIALS}:storeMcpServerCredential`), {
      internalKey: runtime.internalKey,
      workspaceId,
      serverId,
      kind: 'static',
      accessToken: token,
      tokenType: 'Bearer',
      now: runtime.now(),
    })
  } catch (error) {
    await runtime.convex
      .mutation(fn(`${MODEL}:deleteMcpServer`), {
        internalKey: runtime.internalKey,
        workspaceId,
        name,
      })
      .catch(() => undefined)
    throw error
  }
}

/**
 * Where a consent flow can refuse before a human ever sees a consent page.
 *
 * All of these are the caller's to fix — a server that cannot do OAuth at all,
 * one Duet may not reach, a redirect target outside the workspace — so they are
 * 4xx like the probe's, not a 502 that would read as "Duet is broken".
 */
function connectFailureResponse(c: ApiContext, error: unknown): Response {
  if (error instanceof McpConsentFailedError) return c.json({ error: error.failure }, 400)
  if (error instanceof McpOAuthUnsupportedError) return c.json({ error: 'oauth_unsupported' }, 400)
  if (error instanceof BlockedUpstreamUrlError) return c.json({ error: 'url_not_allowed' }, 400)
  if (error instanceof McpAuthorizationServerUnreachableError) {
    return c.json({ error: 'server_unreachable' }, 400)
  }
  if (error instanceof McpClientRegistrationFailedError) {
    return c.json({ error: 'registration_failed' }, 400)
  }
  console.error('[mcp-oauth] connect failed', {
    server: c.req.param('name'),
    error: error instanceof Error ? error.message : String(error),
  })
  return c.json({ error: 'consent_failed' }, 502)
}

/**
 * A probe failure is always the caller's to fix — a wrong URL, a rejected
 * token, an address Duet may not reach — so it is a 4xx and never a 502. A 502
 * would read as "Duet is broken" for a server the user typed wrong.
 */
function probeFailureResponse(c: ApiContext, error: unknown): Response {
  if (!(error instanceof McpProbeFailure)) throw error
  if (error.code === 'blocked') return c.json({ error: 'url_not_allowed' }, 400)
  if (error.code === 'unauthorized') return c.json({ error: 'server_unauthorized' }, 400)
  return c.json({ error: 'server_unreachable' }, 400)
}

function convexFailureResponse(c: ApiContext, error: unknown): Response {
  const code = convexErrorCode(error)
  if (code === 'duplicate_name' || code === 'server_limit') return c.json({ error: code }, 409)
  if (code === 'server_not_found') return c.json({ error: 'not_found' }, 404)
  if (code === 'invalid_agent') return c.json({ error: 'invalid_request' }, 400)
  throw error
}

function convexErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return undefined
  const data = error.data as { error?: unknown } | null
  return typeof data?.error === 'string' ? data.error : undefined
}
