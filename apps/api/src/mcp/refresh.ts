import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationServerMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import type { FetchLike } from '@repo/contract'

import { retryConvexContention } from '../convex-contention'
import { fn, fnQuery, type ApiRouteRuntime } from '../shared'
import type { StoredMcpCredential } from './credentials'
import { fetchMcpAuthorizationServerMetadata, mcpClientMetadataUrl } from './registration'
import { guardedFetch, type HostResolver } from './ssrf'

/**
 * The refresh, owned by a lease instead of by the SDK.
 *
 * The SDK's `auth()` refreshes **unconditionally** — `client/auth.js:274-286`
 * has no expiry check anywhere — so calling it per request would rotate the
 * refresh token on every tool call, from every concurrent lambda at once. And
 * rotation is real: `specs/done/connected-providers` observed a new refresh
 * token on every live refresh it probed. Two lambdas presenting the same
 * refresh token means one of them stores a token the authorization server has
 * already retired, and the workspace silently loses its grant.
 *
 * So the proxy never calls `auth()`. It reads, decides expiry itself, and when
 * a refresh is due it takes a lease in the same transaction that hands out the
 * refresh token — which is what makes "at most one caller per generation may
 * present it" a property of the database rather than of this file's control
 * flow. The network call is the only thing that happens outside a transaction,
 * and every decision either side of it re-reads.
 *
 * Two rules do the work, and they are deliberately different rules:
 *
 * - **Lease ownership governs who may FETCH.** It is a hint with a deadline,
 *   because a lambda can die holding one.
 * - **Generation governs who may WRITE.** So a lease that expired mid-flight
 *   does not throw away a result nobody has superseded.
 */

/** How close to expiry counts as expired. Clock skew plus one round trip. */
export const MCP_REFRESH_SKEW_MS = 60_000

/**
 * How long a claim holds the refresh token. Comfortably longer than the fetch
 * it covers, so a live winner is never raced; short enough that a dead one's
 * lease is reclaimable inside a single tool call's patience.
 */
export const MCP_REFRESH_LEASE_MS = 20_000

/** The token call's own deadline, well inside the lease. */
export const MCP_REFRESH_TIMEOUT_MS = 10_000

/**
 * The loser's wait. Bounded in the tens of milliseconds because it sits in
 * front of a tool call: past this the request goes out with the token it has
 * and lets the upstream answer, which is a truer answer than a 502 from here.
 */
const POLL_ATTEMPTS = 5
const POLL_DELAY_MS = 20

/**
 * How many times one request re-enters the sequence. Every exit either has a
 * token or is terminal, so this bounds only the pathological case — a winner
 * that keeps dying, or a generation that keeps moving under us.
 */
const MAX_ROUNDS = 3

const CREDENTIALS = 'domains/mcpServers/credentials'
const MODEL = 'domains/mcpServers/model'

/**
 * A credential the authorization server has terminally refused. Only the
 * connect flow clears it, so nothing on the request path may retry: the
 * refusal has already been paid for once and every other lambda would pay for
 * it again.
 */
export class McpReauthRequiredError extends Error {
  readonly code = 'reauth_required'

  constructor(readonly server: string) {
    super(`mcp server needs to be reconnected (${server})`)
    this.name = 'McpReauthRequiredError'
  }
}

export interface McpRefreshDeps {
  convex: ApiRouteRuntime['convex']
  internalKey: string
  workspaceId: string
  server: { id: string; name: string }
  /** This deployment's origin: Duet's `client_id` when the grant used CIMD. */
  apiUrl: string
  fetchImpl: FetchLike
  resolveHost?: HostResolver
  now: () => number
  sleep?: (delayMs: number) => Promise<void>
  /** Injected by tests; every attempt otherwise takes a fresh random owner. */
  owner?: () => string
}

/** Step 0's read: the credential as everything but the claim may see it. */
interface ProxyCredential {
  generation: number
  kind: 'oauth' | 'static'
  accessToken: string
  tokenType?: string
  accessExpiresAt?: number
  hasRefreshToken: boolean
  leaseUntil?: number
  invalidAt?: number
}

/** What every branch that is not `claimed` hands back. */
interface PublicCredential {
  generation: number
  kind: 'oauth' | 'static'
  accessToken: string
  tokenType?: string
  accessExpiresAt?: number
}

type ClaimResult =
  | {
      status: 'claimed'
      generation: number
      refreshToken: string
      resource?: string
      authorizationServer?: string
      registration: { clientId: string } | null
    }
  /** A raced winner's token, or one that never needed refreshing. */
  | { status: 'refreshed'; credential?: PublicCredential }
  /** Nothing to refresh with: no row, or a grant with no refresh token. */
  | { status: 'unavailable'; credential?: PublicCredential }
  | { status: 'busy'; leaseUntil?: number; credential?: PublicCredential }
  /** Terminally refused. Only a connect clears it. */
  | { status: 'invalid' }

type WriteResult = {
  status: 'committed' | 'superseded' | 'cleared' | 'invalidated' | 'gone'
  credential?: PublicCredential
}

type RefreshFailure = 'transient' | 'invalid_grant' | 'invalid_client'

/**
 * The credential the proxy should present, refreshing first if it must.
 *
 * Called per request and never cached: a cached copy is a second owner of a
 * token whose whole point is that one row holds it, and it would go stale
 * against exactly the rotation this function performs.
 */
export async function resolveMcpProxyCredential(
  deps: McpRefreshDeps,
): Promise<StoredMcpCredential | null> {
  const credential = await readCredential(deps)
  if (credential === null) return null
  // Step 1, the fast path: no write, and above all no token-endpoint call.
  if (credential.invalidAt !== undefined) throw new McpReauthRequiredError(deps.server.name)
  if (!needsRefresh(credential, deps.now())) return attach(credential)
  return await refreshUnderLease(deps, credential.generation)
}

function needsRefresh(credential: ProxyCredential, now: number): boolean {
  if (credential.kind !== 'oauth' || !credential.hasRefreshToken) return false
  // A grant with no recorded expiry is one the authorization server declined to
  // date. Refreshing it on a guess would rotate a working token on every
  // request; the upstream's own 401 is the only honest signal there.
  if (credential.accessExpiresAt === undefined) return false
  return credential.accessExpiresAt - now <= MCP_REFRESH_SKEW_MS
}

async function refreshUnderLease(
  deps: McpRefreshDeps,
  /**
   * The generation step 0 read. It never moves for the life of this call: if
   * anything else advances it, every branch below answers with that writer's
   * token instead of trying to keep up.
   */
  expectedGeneration: number,
): Promise<StoredMcpCredential | null> {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const owner = deps.owner?.() ?? crypto.randomUUID()
    // Step 2. Contention here is not a failure: `retryConvexContention` re-runs
    // the handler, which re-reads and takes whichever branch is now true.
    const claim = await retryConvexContention(
      async () => await claimLease(deps, expectedGeneration, owner),
    )
    if (claim.status === 'invalid') throw new McpReauthRequiredError(deps.server.name)
    if (claim.status === 'refreshed' || claim.status === 'unavailable') {
      return claim.credential === undefined ? null : attach(claim.credential)
    }
    if (claim.status === 'busy') {
      // Step 3. The loser never calls the token endpoint: it watches the
      // generation the winner will move, so there is exactly one call per
      // generation no matter how many lambdas arrive at once.
      const winner = await awaitWinner(deps, expectedGeneration, claim.leaseUntil ?? 0)
      if (winner === 'reauth') throw new McpReauthRequiredError(deps.server.name)
      if (winner !== null) return attach(winner)
      // The lease lapsed with nothing to show for it — the winner's lambda died
      // — and an expired lease is claimable.
      continue
    }

    // Step 4, outside every transaction.
    const outcome = await fetchTokens(deps, claim)
    if (outcome.kind === 'tokens') {
      // Step 5. Generation, not the lease, decides whether this write lands.
      const commit = await retryConvexContention(
        async () => await commitRefresh(deps, owner, claim.generation, outcome.tokens),
      )
      // Somebody else's refresh landed first, so theirs is the live grant —
      // which the commit hands back rather than making this caller read again.
      if (commit.credential !== undefined) return attach(commit.credential)
      // Only a row that vanished mid-flight gets here: a disconnect ran.
      return null
    }

    // Step 6.
    const failed = await retryConvexContention(
      async () => await failRefresh(deps, owner, claim.generation, outcome.failure),
    )
    if (failed.status === 'invalidated') {
      await markServerReauthRequired(deps)
      throw new McpReauthRequiredError(deps.server.name)
    }
    // A transient failure leaves the grant intact and the lease clear. The
    // stored token is at most `SKEW` from its expiry and may well still work,
    // so it goes out: the upstream's answer beats a refusal invented here.
    return failed.credential === undefined ? null : attach(failed.credential)
  }
  // Rounds exhausted. Whatever is on the row now is the best answer available.
  const latest = await readCredential(deps)
  if (latest !== null && latest.invalidAt !== undefined) {
    throw new McpReauthRequiredError(deps.server.name)
  }
  return latest === null ? null : attach(latest)
}

/**
 * Watch for the winner's commit, never past its lease.
 *
 * Generation is the signal, never token equality: `refreshAuthorization`
 * preserves the old refresh token when the authorization server returns none
 * (`client/auth.js:829`), so "the value changed" proves nothing about who wrote
 * last.
 */
async function awaitWinner(
  deps: McpRefreshDeps,
  expectedGeneration: number,
  leaseUntil: number,
): Promise<ProxyCredential | 'reauth' | null> {
  const sleep = deps.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (deps.now() >= leaseUntil) return null
    await sleep(POLL_DELAY_MS)
    const fresh = await readCredential(deps)
    if (fresh === null) return null
    if (fresh.invalidAt !== undefined) return 'reauth'
    if (fresh.generation !== expectedGeneration) return fresh
  }
  return null
}

interface FetchedTokens {
  kind: 'tokens'
  tokens: OAuthTokens
}

async function fetchTokens(
  deps: McpRefreshDeps,
  claim: Extract<ClaimResult, { status: 'claimed' }>,
): Promise<FetchedTokens | { kind: 'failed'; failure: RefreshFailure }> {
  const authorizationServer = claim.authorizationServer
  if (authorizationServer === undefined) {
    // A row with a refresh token and no authorization server cannot be
    // refreshed by anyone; treating it as transient releases the lease and
    // leaves the stored token to answer for itself.
    return { kind: 'failed', failure: 'transient' }
  }
  // ONE deadline for discovery and the token call together, so the whole hop
  // stays comfortably inside the lease that covers it. Two independent
  // deadlines could add up to more than the lease and let a second caller start
  // fetching while this one is still out.
  const deadline = AbortSignal.timeout(MCP_REFRESH_TIMEOUT_MS)
  const deadlined: FetchLike = async (input, init) =>
    await deps.fetchImpl(input, { ...init, signal: deadline })
  try {
    const metadata = await fetchMcpAuthorizationServerMetadata({
      authorizationServerUrl: authorizationServer,
      fetchImpl: deadlined,
      ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
    })
    const tokens = await refreshAuthorization(authorizationServer, {
      metadata: metadata as unknown as AuthorizationServerMetadata,
      // Duet is a public client — CIMD's `client_id` is the URL of the document
      // it publishes, and a registration this workspace minted carries no
      // secret — so PKCE and the refresh token are the whole of the credential.
      clientInformation: {
        client_id: claim.registration?.clientId ?? mcpClientMetadataUrl(deps.apiUrl),
      },
      refreshToken: claim.refreshToken,
      // RFC 8707: the SAME audience recorded at mint. A refresh with a
      // different one is a request for a different grant.
      ...(claim.resource === undefined ? {} : { resource: new URL(claim.resource) }),
      // The token endpoint's address comes from a document a user-supplied
      // server pointed at, so it is guarded like every other hop this feature
      // makes.
      fetchFn: guardedFetch(deadlined, deps.resolveHost),
    })
    return { kind: 'tokens', tokens }
  } catch (error) {
    const failure = classifyFailure(error)
    console.warn('[mcp-refresh] refresh failed', {
      server: deps.server.name,
      failure,
      // Duet's own reading, never the authorization server's
      // `error_description`: that text is attacker-influenced and, on this
      // path, unread by design.
      error: error instanceof Error ? error.name : 'unknown',
    })
    return { kind: 'failed', failure }
  }
}

/**
 * The three classes the row reacts to differently.
 *
 * `invalid_grant` is the only one that is provably terminal: the authorization
 * server has told us this refresh token is dead, and keeping it invites every
 * other lambda to burn another refusal on it. `invalid_client` says the same
 * about the client itself, which is a fact about the registration rather than
 * the grant. Everything else — a 5xx, a timeout, a refused connection — leaves
 * the grant untouched and is retried by the next request.
 */
function classifyFailure(error: unknown): RefreshFailure {
  if (error instanceof InvalidGrantError) return 'invalid_grant'
  if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
    return 'invalid_client'
  }
  return 'transient'
}

function attach(credential: {
  kind: 'oauth' | 'static'
  accessToken: string
  tokenType?: string
}): StoredMcpCredential {
  return {
    kind: credential.kind,
    accessToken: credential.accessToken,
    ...(credential.tokenType === undefined ? {} : { tokenType: credential.tokenType }),
  }
}

async function readCredential(deps: McpRefreshDeps): Promise<ProxyCredential | null> {
  return (await deps.convex.query(fnQuery(`${CREDENTIALS}:readMcpServerCredential`), {
    internalKey: deps.internalKey,
    workspaceId: deps.workspaceId,
    serverId: deps.server.id,
  })) as ProxyCredential | null
}

async function claimLease(
  deps: McpRefreshDeps,
  expectedGeneration: number,
  owner: string,
): Promise<ClaimResult> {
  return (await deps.convex.mutation(fn(`${CREDENTIALS}:claimMcpRefreshLease`), {
    internalKey: deps.internalKey,
    workspaceId: deps.workspaceId,
    serverId: deps.server.id,
    expectedGeneration,
    owner,
    // The two windows the mutation compares against are this module's to
    // choose: one bounds the fetch it is about to make, the other decides how
    // early "expired" starts. A second copy in Convex would be a second answer.
    skewMs: MCP_REFRESH_SKEW_MS,
    leaseMs: MCP_REFRESH_LEASE_MS,
    now: deps.now(),
  })) as ClaimResult
}

async function commitRefresh(
  deps: McpRefreshDeps,
  owner: string,
  expectedGeneration: number,
  tokens: OAuthTokens,
): Promise<WriteResult> {
  const now = deps.now()
  return (await deps.convex.mutation(fn(`${CREDENTIALS}:commitMcpRefresh`), {
    internalKey: deps.internalKey,
    workspaceId: deps.workspaceId,
    serverId: deps.server.id,
    owner,
    expectedGeneration,
    accessToken: tokens.access_token,
    tokenType: tokens.token_type ?? 'Bearer',
    // `refreshAuthorization` echoes the old refresh token when the
    // authorization server returns none, so this is always the live one.
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    ...(tokens.expires_in === undefined
      ? {}
      : { accessExpiresAt: now + tokens.expires_in * 1_000 }),
    now,
  })) as WriteResult
}

async function failRefresh(
  deps: McpRefreshDeps,
  owner: string,
  expectedGeneration: number,
  outcome: RefreshFailure,
): Promise<WriteResult> {
  return (await deps.convex.mutation(fn(`${CREDENTIALS}:failMcpRefresh`), {
    internalKey: deps.internalKey,
    workspaceId: deps.workspaceId,
    serverId: deps.server.id,
    owner,
    expectedGeneration,
    outcome,
    now: deps.now(),
  })) as WriteResult
}

/**
 * The row the human looks at, told what the credential row already knows.
 *
 * A separate call rather than a patch inside `failMcpRefresh` because
 * `setMcpServerState` is the one writer of `state`. Losing it costs a stale
 * chip, never a wrong decision: the proxy reads `invalidAt`, not the state.
 */
async function markServerReauthRequired(deps: McpRefreshDeps): Promise<void> {
  try {
    await deps.convex.mutation(fn(`${MODEL}:setMcpServerState`), {
      internalKey: deps.internalKey,
      workspaceId: deps.workspaceId,
      serverId: deps.server.id,
      state: 'reauth_required',
      now: deps.now(),
    })
  } catch (error) {
    console.warn('[mcp-refresh] could not mark the server for reconnection', {
      server: deps.server.name,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
