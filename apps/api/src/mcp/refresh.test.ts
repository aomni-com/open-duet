import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { getFunctionName, type FunctionReference } from 'convex/server'

import type { FetchLike } from '@repo/contract'

import type { Doc } from '../../../../packages/backend/convex/_generated/dataModel'
import schema from '../../../../packages/backend/convex/schema'
import {
  MCP_REFRESH_SKEW_MS,
  McpReauthRequiredError,
  resolveMcpProxyCredential,
  type McpRefreshDeps,
} from './refresh'

const previousKey = process.env.DUET_API_INTERNAL_KEY
beforeEach(() => {
  process.env.DUET_API_INTERNAL_KEY = 'internal-secret'
})
afterEach(() => {
  if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousKey
})

const AUTHORIZATION_SERVER = 'https://auth.test'
const API_URL = 'https://api.duet.test'
const START = 1_700_000_000_000

describe('mcp credential resolution', () => {
  test('attaches a token that is not near expiry without writing or refreshing', async () => {
    const world = await refreshWorld({ accessExpiresAt: START + 60 * 60 * 1_000 })

    const credential = await resolveMcpProxyCredential(world.deps)

    expect(credential).toEqual({ kind: 'oauth', accessToken: 'access-1', tokenType: 'Bearer' })
    // The overwhelming majority of requests: one read, no mutation, and above
    // all no call to somebody else's token endpoint.
    expect(world.issuer.calls).toHaveLength(0)
    expect(world.convex.mutations).toEqual([])
    expect((await world.read()).credential?.generation).toBe(1)
  })

  test('refreshes a token inside the skew window, sending the audience it was minted with', async () => {
    // One millisecond inside the window. The skew is what makes "expired" start
    // early enough that a clock difference cannot hand a runner a dead token.
    const world = await refreshWorld({ accessExpiresAt: START + MCP_REFRESH_SKEW_MS })

    const credential = await resolveMcpProxyCredential(world.deps)

    expect(credential).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
    expect(world.issuer.calls).toHaveLength(1)
    expect(Object.fromEntries(world.issuer.calls[0]!)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      // RFC 8707: the same audience recorded at mint. A different one asks for
      // a different grant.
      resource: 'https://mcp.example.test/mcp',
      // No registration row, so the grant was minted under a Client ID Metadata
      // Document and its `client_id` is the URL Duet publishes.
      client_id: `${API_URL}/.well-known/duet-mcp-client.json`,
    })
    expect((await world.read()).credential).toMatchObject({
      generation: 2,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessExpiresAt: START + 3_600_000,
    })
    expect((await world.read()).credential?.leaseOwner).toBeUndefined()
    expect((await world.read()).credential?.leaseUntil).toBeUndefined()
  })

  test('two concurrent expired requests make exactly one token-endpoint call', async () => {
    const world = await refreshWorld({ accessExpiresAt: START - 1 })

    const [first, second] = await Promise.all([
      resolveMcpProxyCredential(world.deps),
      resolveMcpProxyCredential(world.deps),
    ])

    // The whole safety property, counted at the third party: the refresh token
    // is released to at most one caller per generation, so N lambdas produce
    // one call — not N rotations, N-1 of which store a retired token.
    expect(world.issuer.calls).toHaveLength(1)
    // The loser did not fail and did not use the dead token; it used the
    // winner's.
    expect(first).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
    expect(second).toEqual(first)
    // One bump, not two. Generation is the rotation signal — the token VALUE
    // proves nothing, because an authorization server that returns no new
    // refresh token leaves the old one in place.
    expect((await world.read()).credential?.generation).toBe(2)
    expect(world.convex.claims.filter(status => status === 'claimed')).toHaveLength(1)
  })

  test('the loser waits on the lease and leaves with the winner’s generation', async () => {
    // The interleaving the poll exists for, pinned rather than raced: the
    // winner is held at the token endpoint until the loser is already waiting.
    const held = Promise.withResolvers<void>()
    const world = await refreshWorld({ accessExpiresAt: START - 1, token: { gate: held.promise } })

    const winner = resolveMcpProxyCredential(world.deps)
    await tick()
    const loser = resolveMcpProxyCredential(world.deps)
    await tick()
    // The loser is parked on `busy` with no token endpoint call of its own.
    expect(world.convex.claims).toEqual(['claimed', 'busy'])
    expect(world.issuer.calls).toHaveLength(1)

    held.resolve()
    expect(await winner).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
    expect(await loser).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
    expect(world.issuer.calls).toHaveLength(1)
    expect((await world.read()).credential?.generation).toBe(2)
  })

  test('a lease still held when the wait runs out falls back to the stored token', async () => {
    const held = Promise.withResolvers<void>()
    const world = await refreshWorld({ accessExpiresAt: START - 1, token: { gate: held.promise } })

    const winner = resolveMcpProxyCredential(world.deps)
    await tick()
    const impatient = await resolveMcpProxyCredential(world.deps)

    // The wait is bounded in the tens of milliseconds because it sits in front
    // of a tool call. Past it the request goes out with the token it has —
    // still inside the skew window, so very often still good — and the upstream
    // gets to answer instead of Duet inventing a refusal.
    expect(impatient).toEqual({ kind: 'oauth', accessToken: 'access-1', tokenType: 'Bearer' })
    expect(world.issuer.calls).toHaveLength(1)

    held.resolve()
    expect(await winner).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
  })

  test('a lease its holder never released is claimable once it lapses', async () => {
    const world = await refreshWorld({
      accessExpiresAt: START - 1,
      // A lambda that took the lease and died: nothing will ever commit it.
      leaseOwner: 'dead-lambda',
      leaseUntil: START + 40,
    })

    const credential = await resolveMcpProxyCredential(world.deps)

    // Waited for the holder that never came back, then took the lease itself.
    expect(credential).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
    expect(world.issuer.calls).toHaveLength(1)
    expect((await world.read()).credential?.generation).toBe(2)
    expect(world.deps.now()).toBeGreaterThanOrEqual(START + 40)
  })

  test('a refresh token the authorization server refuses is discarded, not retried', async () => {
    const world = await refreshWorld({
      accessExpiresAt: START - 1,
      token: { status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } },
    })

    await expect(resolveMcpProxyCredential(world.deps)).rejects.toBeInstanceOf(
      McpReauthRequiredError,
    )

    expect((await world.read()).credential).toMatchObject({
      // Provably dead: keeping it invites every other lambda to burn another
      // refusal on it.
      invalidAt: START,
      invalidReason: 'invalid_grant',
      // Bumped, so a concurrent refresh still in flight is superseded rather
      // than resurrecting the grant.
      generation: 2,
    })
    expect((await world.read()).credential?.refreshToken).toBeUndefined()
    expect((await world.read()).credential?.leaseOwner).toBeUndefined()
    expect((await world.read()).serverState).toBe('reauth_required')

    // The next request short-circuits: no lease, no token endpoint, nothing but
    // the answer the row already holds.
    await expect(resolveMcpProxyCredential(world.deps)).rejects.toBeInstanceOf(
      McpReauthRequiredError,
    )
    expect(world.issuer.calls).toHaveLength(1)
    expect(world.convex.mutations).toEqual([
      'claimMcpRefreshLease',
      'failMcpRefresh',
      'setMcpServerState',
    ])
  })

  test('a client the authorization server refuses marks the registration too', async () => {
    const registration = { id: 'registration_1', clientId: 'client-a' }
    const world = await refreshWorld({
      accessExpiresAt: START - 1,
      registration,
      token: { status: 401, body: { error: 'invalid_client' } },
    })

    await expect(resolveMcpProxyCredential(world.deps)).rejects.toBeInstanceOf(
      McpReauthRequiredError,
    )

    // The grant is dead AND so is the client identity behind it, so the next
    // connect registers deliberately instead of reusing a client this
    // authorization server has stopped honouring.
    expect((await world.read()).credential?.invalidAt).toBe(START)
    expect((await world.read()).registration?.invalidAt).toBe(START)
    expect(Object.fromEntries(world.issuer.calls[0]!)).toMatchObject({ client_id: 'client-a' })
  })

  test('a transient failure keeps the grant and lets the stored token answer', async () => {
    const world = await refreshWorld({
      accessExpiresAt: START - 1,
      token: { status: 503, body: { error: 'temporarily_unavailable' } },
    })

    const credential = await resolveMcpProxyCredential(world.deps)

    // Nothing was learned about the grant, so nothing is thrown away. The
    // stored token goes out and the upstream's own answer decides.
    expect(credential).toEqual({ kind: 'oauth', accessToken: 'access-1', tokenType: 'Bearer' })
    expect((await world.read()).credential).toMatchObject({
      generation: 1,
      refreshToken: 'refresh-1',
    })
    expect((await world.read()).credential?.invalidAt).toBeUndefined()
    // Released, so the very next request re-claims instead of waiting out a
    // lease nobody is using.
    expect((await world.read()).credential?.leaseOwner).toBeUndefined()
    expect((await world.read()).credential?.leaseUntil).toBeUndefined()
  })

  test('a commit whose generation moved under it is refused, not applied', async () => {
    const world = await refreshWorld({
      accessExpiresAt: START - 1,
      token: {
        // Another lambda commits while this one is at the token endpoint —
        // the window a lease cannot cover, because the lease may have lapsed.
        before: async patch => {
          await patch({
            generation: 2,
            accessToken: 'access-from-elsewhere',
            refreshToken: 'refresh-from-elsewhere',
          })
        },
      },
    })

    const credential = await resolveMcpProxyCredential(world.deps)

    // Lease ownership governs who may FETCH; generation governs who may WRITE.
    // This caller fetched legitimately and still must not write.
    expect(credential).toEqual({
      kind: 'oauth',
      accessToken: 'access-from-elsewhere',
      tokenType: 'Bearer',
    })
    expect((await world.read()).credential).toMatchObject({
      generation: 2,
      refreshToken: 'refresh-from-elsewhere',
    })
  })

  test('a refresh the authorization server did not rotate still advances the generation', async () => {
    const world = await refreshWorld({
      accessExpiresAt: START - 1,
      // Half of real refreshes look like this. `refreshAuthorization` preserves
      // the old refresh token, so a test asserting the VALUE changed would pass
      // or fail by coin flip.
      token: { rotate: false },
    })

    const credential = await resolveMcpProxyCredential(world.deps)

    expect(credential).toEqual({ kind: 'oauth', accessToken: 'access-2', tokenType: 'Bearer' })
    expect((await world.read()).credential).toMatchObject({
      generation: 2,
      refreshToken: 'refresh-1',
    })
  })

  test('never refreshes a pasted token or a grant with nothing to refresh with', async () => {
    const pasted = await refreshWorld({ kind: 'static', accessExpiresAt: START - 1 })
    const noRefreshToken = await refreshWorld({ refreshToken: null, accessExpiresAt: START - 1 })
    const undated = await refreshWorld({})

    expect(await resolveMcpProxyCredential(pasted.deps)).toEqual({
      kind: 'static',
      accessToken: 'access-1',
      tokenType: 'Bearer',
    })
    expect(await resolveMcpProxyCredential(noRefreshToken.deps)).toMatchObject({
      accessToken: 'access-1',
    })
    // No recorded expiry: refreshing on a guess would rotate a working token on
    // every request.
    expect(await resolveMcpProxyCredential(undated.deps)).toMatchObject({
      accessToken: 'access-1',
    })
    for (const world of [pasted, noRefreshToken, undated]) {
      expect(world.issuer.calls).toHaveLength(0)
    }
  })

  test('a server with no credential at all is forwarded with no credential', async () => {
    const world = await refreshWorld({})
    await world.removeCredential()

    expect(await resolveMcpProxyCredential(world.deps)).toBeNull()
    expect(world.convex.mutations).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

/** One macrotask: everything already in flight gets to run to its next wait. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

type CredentialRow = Doc<'mcpServerCredentials'>

interface RegistrationRow {
  id: string
  clientId: string
  invalidAt?: number
}

interface WorldOptions {
  accessExpiresAt?: number
  refreshToken?: string | null
  kind?: 'oauth' | 'static'
  invalidAt?: number
  leaseOwner?: string
  leaseUntil?: number
  registration?: RegistrationRow
  /** What the authorization server answers the refresh with. */
  token?: TokenEndpointBehaviour
}

interface TokenEndpointBehaviour {
  rotate?: boolean
  status?: number
  body?: unknown
  /** Runs before the response, so a test can interleave another writer. */
  before?: (patch: (fields: Partial<CredentialRow>) => Promise<void>) => void | Promise<void>
  /** Held until released, so two callers can be in flight at once. */
  gate?: Promise<void>
}

async function refreshWorld(options: WorldOptions = {}) {
  const t = convexTest(schema, {
    '../../../../packages/backend/convex/_generated/api.ts': async () => ({}),
    '../../../../packages/backend/convex/domains/mcpServers/credentials.ts': () =>
      import('../../../../packages/backend/convex/domains/mcpServers/credentials'),
    '../../../../packages/backend/convex/domains/mcpServers/model.ts': () =>
      import('../../../../packages/backend/convex/domains/mcpServers/model'),
  })
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'refresh@example.test',
      createdAt: START,
      updatedAt: START,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'refresh-fixture',
      name: 'Refresh fixture',
      status: 'active',
      billingUserId: userId,
      createdAt: START,
    })
    const serverId = await ctx.db.insert('mcpServers', {
      workspaceId,
      name: 'linear',
      label: 'Linear',
      url: 'https://mcp.example.test/mcp',
      authKind: options.kind ?? 'oauth',
      state: 'ready',
      createdByUserId: userId,
      createdAt: START,
      updatedAt: START,
    })
    const registrationId =
      options.registration === undefined
        ? undefined
        : await ctx.db.insert('mcpClientRegistrations', {
            workspaceId,
            authorizationServer: AUTHORIZATION_SERVER,
            clientId: options.registration.clientId,
            createdAt: START,
            ...(options.registration.invalidAt === undefined
              ? {}
              : { invalidAt: options.registration.invalidAt }),
          })
    const credentialId = await ctx.db.insert('mcpServerCredentials', {
      workspaceId,
      serverId,
      generation: 1,
      kind: options.kind ?? 'oauth',
      accessToken: 'access-1',
      tokenType: 'Bearer',
      ...(options.refreshToken === null
        ? {}
        : { refreshToken: options.refreshToken ?? 'refresh-1' }),
      ...(options.accessExpiresAt === undefined
        ? {}
        : { accessExpiresAt: options.accessExpiresAt }),
      resource: 'https://mcp.example.test/mcp',
      authorizationServer: AUTHORIZATION_SERVER,
      ...(registrationId === undefined ? {} : { registrationId }),
      ...(options.leaseOwner === undefined ? {} : { leaseOwner: options.leaseOwner }),
      ...(options.leaseUntil === undefined ? {} : { leaseUntil: options.leaseUntil }),
      ...(options.invalidAt === undefined ? {} : { invalidAt: options.invalidAt }),
      createdAt: START,
      updatedAt: START,
    })
    return { workspaceId, serverId, credentialId, registrationId }
  })
  const patch = async (fields: Partial<CredentialRow>) => {
    await t.run(ctx => ctx.db.patch(ids.credentialId, fields))
  }
  const clock = { value: START }
  const mutations: string[] = []
  const claims: string[] = []
  const convex = {
    query: t.query.bind(t),
    mutation: async (reference: FunctionReference<'mutation'>, args: Record<string, unknown>) => {
      const operation = getFunctionName(reference)
      mutations.push(operation.split(':')[1] ?? operation)
      const result = await t.mutation(reference, args)
      if (operation.endsWith(':claimMcpRefreshLease')) claims.push(result.status)
      return result
    },
    mutations,
    claims,
  }
  const issuer = tokenEndpoint(patch, options.token ?? {})
  const deps: McpRefreshDeps = {
    convex: convex as never,
    internalKey: 'internal-secret',
    workspaceId: ids.workspaceId,
    server: { id: ids.serverId, name: 'linear' },
    apiUrl: API_URL,
    fetchImpl: issuer.fetchImpl,
    resolveHost: async () => ['203.0.113.10'],
    now: () => clock.value,
    sleep: async delayMs => {
      clock.value += delayMs
      await tick()
    },
  }
  return {
    convex,
    deps,
    clock,
    issuer,
    read: () =>
      t.run(async ctx => ({
        credential: await ctx.db.get(ids.credentialId),
        registration:
          ids.registrationId === undefined ? null : await ctx.db.get(ids.registrationId),
        serverState: (await ctx.db.get(ids.serverId))!.state,
      })),
    removeCredential: () => t.run(ctx => ctx.db.delete(ids.credentialId)),
  }
}

/**
 * An authorization server, on the wire the SDK's `refreshAuthorization` really
 * speaks: a discovery document and a `/token` endpoint that answers a
 * `refresh_token` grant.
 */
function tokenEndpoint(
  patch: (fields: Partial<CredentialRow>) => Promise<void>,
  behaviour: TokenEndpointBehaviour,
) {
  const calls: URLSearchParams[] = []
  let issued = 0
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.includes('.well-known')) {
      return Response.json({
        issuer: AUTHORIZATION_SERVER,
        token_endpoint: `${AUTHORIZATION_SERVER}/token`,
        authorization_endpoint: `${AUTHORIZATION_SERVER}/authorize`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      })
    }
    if (url.pathname !== '/token') return new Response(null, { status: 404 })
    const body = new URLSearchParams(await new Request('https://token.test', init).text())
    calls.push(body)
    if (behaviour.gate !== undefined) await behaviour.gate
    await behaviour.before?.(patch)
    if (behaviour.status !== undefined) {
      return Response.json(behaviour.body ?? {}, { status: behaviour.status })
    }
    issued += 1
    return Response.json({
      access_token: `access-${issued + 1}`,
      token_type: 'Bearer',
      expires_in: 3_600,
      ...(behaviour.rotate === false ? {} : { refresh_token: `refresh-${issued + 1}` }),
    })
  }
  return { fetchImpl, calls }
}
