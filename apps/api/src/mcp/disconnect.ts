import { selectClientAuthMethod } from '@modelcontextprotocol/sdk/client/auth.js'

import type { FetchLike, McpRegistrationCleanup, McpRevocationAttempt } from '@repo/contract'

import { fn, type ApiRouteRuntime } from '../shared'
import { withUpstreamTimeout } from './proxy'
import { fetchMcpAuthorizationServerMetadata, mcpClientMetadataUrl } from './registration'
import { guardedFetch, type HostResolver } from './ssrf'

/**
 * Removing a server: revoke what can be revoked, then forget everything.
 *
 * The order is the design, and it is Convex's order — three mutations in
 * `domains/mcpServers/disconnect.ts` with the two network attempts between
 * them. This module owns only the attempts, and one rule about them:
 *
 * **A `200` is not proof.** RFC 7009 §2.2 makes a `200` mandatory for a token
 * the authorization server does not recognize, so a success here says the
 * request was accepted and nothing about the grant. Slice 00 makes that worse
 * than the rule assumes: Linear, Notion and Sentry all advertise their **token
 * endpoint** as their revocation endpoint, which is almost certainly
 * boilerplate rather than a working RFC 7009 implementation. So the outcome is
 * reported as an attempt, and the credential row is deleted either way.
 *
 * There is no retry. The row is going regardless of the answer, a human is
 * waiting on the response, and a second POST to an endpoint that just refused
 * buys a slower delete rather than a revoked token.
 */

const DISCONNECT = 'domains/mcpServers/disconnect'

/**
 * The deadline over every hop a disconnect makes. Comfortably longer than an
 * honest answer, short enough that a black-holed endpoint does not hold a
 * human's delete open — the local rows go either way.
 */
export const MCP_DISCONNECT_TIMEOUT_MS = 5_000

export interface McpDisconnectDeps {
  convex: ApiRouteRuntime['convex']
  internalKey: string
  fetchImpl: FetchLike
  resolveHost?: HostResolver
  /** This deployment's origin: Duet's `client_id` when the grant used CIMD. */
  apiUrl: string
  now: () => number
}

export interface McpDisconnectResult {
  name: string
  removed: boolean
  revoked: McpRevocationAttempt
  registration: McpRegistrationCleanup
}

interface BegunDisconnect {
  server: { id: string; name: string; authKind: 'none' | 'oauth' | 'static' }
  credential: {
    kind: 'oauth' | 'static'
    accessToken: string
    refreshToken?: string
    authorizationServer?: string
  } | null
  registration: {
    id: string
    clientId: string
    clientSecret?: string
    tokenEndpointAuthMethod?: string
    registrationClientUri?: string
    registrationAccessToken?: string
  } | null
}

export async function disconnectMcpServer(
  deps: McpDisconnectDeps,
  input: { workspaceId: string; name: string },
): Promise<McpDisconnectResult> {
  const begun = (await deps.convex.mutation(fn(`${DISCONNECT}:beginMcpServerDisconnect`), {
    internalKey: deps.internalKey,
    workspaceId: input.workspaceId,
    name: input.name,
    now: deps.now(),
  })) as BegunDisconnect | null
  // Already gone. Removal is idempotent, and there is nothing left to attempt
  // on anybody's behalf.
  if (begun === null) {
    return {
      name: input.name,
      removed: false,
      revoked: 'not_supported',
      registration: 'not_supported',
    }
  }

  const revoked = await attemptRevocation(deps, begun)

  // Step 3, and the one step with no condition on it: whatever the
  // authorization server said, Duet does not keep a token it has been told to
  // forget. Everything after this point can fail without leaving a live
  // credential behind.
  const dropped = (await deps.convex.mutation(fn(`${DISCONNECT}:dropMcpServerCredential`), {
    internalKey: deps.internalKey,
    workspaceId: input.workspaceId,
    serverId: begun.server.id,
  })) as { deleted: boolean; registration: 'orphaned' | 'shared' | 'none' }

  const cleanup = await attemptRegistrationDelete(deps, begun.registration, dropped.registration)
  const finished = (await deps.convex.mutation(fn(`${DISCONNECT}:finishMcpServerDisconnect`), {
    internalKey: deps.internalKey,
    workspaceId: input.workspaceId,
    name: begun.server.name,
    ...(begun.registration === null ? {} : { registrationId: begun.registration.id }),
    registrationDelete: cleanup.verdict,
    ...(cleanup.reason === undefined ? {} : { reason: cleanup.reason }),
    now: deps.now(),
  })) as { name: string; removed: boolean }

  return { name: finished.name, removed: finished.removed, revoked, registration: cleanup.outcome }
}

/**
 * Step 2: RFC 7009, for the refresh token and then the access token.
 *
 * The refresh token goes first because revoking one is defined to revoke the
 * access tokens issued under it; the access token is sent anyway, since
 * "defined to" is not "observed to" and this is the last chance to ask.
 */
async function attemptRevocation(
  deps: McpDisconnectDeps,
  begun: BegunDisconnect,
): Promise<McpRevocationAttempt> {
  const credential = begun.credential
  if (credential === null) return 'not_supported'
  // A statically pasted token has no discovered authorization server, and a PAT
  // is the user's to revoke at its source. Nothing is attempted.
  if (credential.kind !== 'oauth' || credential.authorizationServer === undefined) {
    return 'not_supported'
  }

  // One deadline over both hops. Neither is worth holding a human's delete open
  // for: the row is going either way.
  const deadlined = withUpstreamTimeout(deps.fetchImpl, MCP_DISCONNECT_TIMEOUT_MS)
  let metadata: Record<string, unknown>
  try {
    // The RAW document. `OpenIdProviderDiscoveryMetadataSchema` is strip-mode
    // and the OIDC branch does not declare it, so `revocation_endpoint` read off the
    // SDK's parsed object is `undefined` for every server on earth — and this
    // step would silently never run again.
    metadata = await fetchMcpAuthorizationServerMetadata({
      authorizationServerUrl: credential.authorizationServer,
      fetchImpl: deadlined,
      ...optional('resolveHost', deps.resolveHost),
    })
  } catch (error) {
    // Not `not_supported`: that would assert the authorization server offers no
    // revocation, and all this proves is that Duet could not find out.
    console.warn('[mcp-disconnect] could not read authorization server metadata', {
      server: begun.server.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'failed'
  }
  const revocationEndpoint = metadata.revocation_endpoint
  if (typeof revocationEndpoint !== 'string' || revocationEndpoint.length === 0) {
    return 'not_supported'
  }

  const client = {
    // Duet is a public client either way: a CIMD `client_id` is the URL of the
    // document this deployment publishes, and a registration this workspace
    // minted was requested with `token_endpoint_auth_method: none`.
    client_id: begun.registration?.clientId ?? mcpClientMetadataUrl(deps.apiUrl),
    ...optional('client_secret', begun.registration?.clientSecret),
    ...optional('token_endpoint_auth_method', begun.registration?.tokenEndpointAuthMethod),
  }
  // RFC 8414 gives the revocation endpoint its own auth-method list and makes
  // the token endpoint's the default, which is what the SDK's selector expects.
  const authMethod = selectClientAuthMethod(
    client,
    stringList(metadata.revocation_endpoint_auth_methods_supported) ??
      stringList(metadata.token_endpoint_auth_methods_supported) ??
      [],
  )

  const attempts: Array<{ token: string; hint: 'refresh_token' | 'access_token' }> = [
    ...(credential.refreshToken === undefined
      ? []
      : [{ token: credential.refreshToken, hint: 'refresh_token' as const }]),
    { token: credential.accessToken, hint: 'access_token' as const },
  ]
  // The revocation endpoint's address comes from a document a user-supplied
  // server pointed at, so it is guarded like every other hop this feature makes.
  const revocationFetch = guardedFetch(deadlined, deps.resolveHost)
  let outcome: McpRevocationAttempt = 'revoked'
  for (const attempt of attempts) {
    const accepted = await revokeMcpServerToken(revocationFetch, {
      revocationEndpoint,
      token: attempt.token,
      tokenTypeHint: attempt.hint,
      clientId: client.client_id,
      authMethod,
      ...optional('clientSecret', client.client_secret),
    })
    if (!accepted) outcome = 'failed'
  }
  return outcome
}

export interface RevokeMcpServerTokenOptions {
  revocationEndpoint: string
  token: string
  /** RFC 7009 §2.1: a hint, never a guarantee the server honours it. */
  tokenTypeHint?: 'refresh_token' | 'access_token'
  clientId: string
  clientSecret?: string
  authMethod?: 'client_secret_basic' | 'client_secret_post' | 'none'
}

/**
 * One RFC 7009 POST, hand-written because the SDK has no revocation helper —
 * it exports none, and `revocation_endpoint` appears in its metadata schema and
 * nowhere else.
 *
 * The answer is whether the request was ACCEPTED. Nothing more can be read out
 * of it: a `200` is mandatory for an unrecognized token, so this cannot
 * distinguish "revoked" from "never heard of it" from an endpoint that is
 * really the token endpoint wearing a different name.
 */
export async function revokeMcpServerToken(
  fetchImpl: FetchLike,
  options: RevokeMcpServerTokenOptions,
): Promise<boolean> {
  const body = new URLSearchParams({ token: options.token })
  if (options.tokenTypeHint !== undefined) body.set('token_type_hint', options.tokenTypeHint)
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' })
  const method =
    options.authMethod ?? (options.clientSecret === undefined ? 'none' : 'client_secret_basic')
  if (method === 'client_secret_basic' && options.clientSecret !== undefined) {
    headers.set('authorization', `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`)
  } else {
    body.set('client_id', options.clientId)
    if (method === 'client_secret_post' && options.clientSecret !== undefined) {
      body.set('client_secret', options.clientSecret)
    }
  }
  try {
    const response = await fetchImpl(options.revocationEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    })
    // Never read, and above all never logged: an error body from a revocation
    // endpoint can echo the token that was just sent to it.
    await response.body?.cancel()
    return response.ok
  } catch (error) {
    console.warn('[mcp-disconnect] revocation request failed', {
      error: error instanceof Error ? error.name : 'unknown',
    })
    return false
  }
}

/**
 * Step 4: RFC 7592, and only for a registration nothing else still holds.
 *
 * A refusal keeps the row. That is deliberate and it is the whole of D18's
 * remaining value once a delete has failed: the surviving row is what a later
 * connect to the same authorization server reuses instead of minting a second
 * orphan, and what a later disconnect retries the delete against.
 */
async function attemptRegistrationDelete(
  deps: McpDisconnectDeps,
  registration: BegunDisconnect['registration'],
  usage: 'orphaned' | 'shared' | 'none',
): Promise<{
  verdict: 'deleted' | 'failed' | 'skipped'
  outcome: McpRegistrationCleanup
  reason?: string
}> {
  // The CIMD branch's advantage, in code: a `client_id` that is a URL Duet
  // publishes leaves nothing on the third party, so there is no step 4 at all.
  if (registration === null || usage === 'none') {
    return { verdict: 'skipped', outcome: 'not_supported' }
  }
  // Another server in this workspace still authenticates with this client.
  if (usage === 'shared') return { verdict: 'skipped', outcome: 'retained' }
  const { registrationClientUri, registrationAccessToken } = registration
  if (registrationClientUri === undefined || registrationAccessToken === undefined) {
    // An authorization server that does DCR but not RFC 7592. Its "Duet" client
    // is permanent and nothing Duet can do will remove it.
    console.warn('[mcp-disconnect] registration cannot be deleted; no RFC 7592 fields', {
      clientId: registration.clientId,
    })
    return { verdict: 'skipped', outcome: 'not_supported' }
  }
  const fetchImpl = withUpstreamTimeout(
    guardedFetch(deps.fetchImpl, deps.resolveHost),
    MCP_DISCONNECT_TIMEOUT_MS,
  )
  try {
    // The management URI is the authorization server's own, so it is guarded
    // and deadlined exactly like the revocation POST.
    const response = await fetchImpl(registrationClientUri, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${registrationAccessToken}` },
    })
    await response.body?.cancel()
    // A 404 is the end state this call was asking for: whatever else is true,
    // that registration is not there.
    if (response.ok || response.status === 404) {
      return { verdict: 'deleted', outcome: 'deleted' }
    }
    return { verdict: 'failed', outcome: 'retained', reason: `http_${response.status}` }
  } catch (error) {
    return {
      verdict: 'failed',
      outcome: 'retained',
      // Duet's own reading. A third party's message is attacker-influenced text
      // and this one is stored on a row.
      reason: error instanceof Error ? `request_failed_${error.name}` : 'request_failed',
    }
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? (value as string[])
    : undefined
}

function optional<K extends string, T>(key: K, value: T | undefined): Record<K, T> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}
