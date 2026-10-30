import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'

import { MAX_MCP_DROPPED_TOOL_NAMES, MAX_MCP_SERVERS_PER_WORKSPACE } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { normalizeAuthorizationServer } from '../convex/domains/mcpServers/credentials'

const INTERNAL_KEY = 'test-mcp-servers-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('custom MCP server rows', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(convex, uniqueEmail('mcp-servers-owner'), 'MCP Servers Owner')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('registers a no-auth server ready and an OAuth server awaiting consent', async () => {
    const workspaceId = await createWorkspace('states')

    expect(
      await register(workspaceId, { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }),
    ).toMatchObject({
      name: 'deepwiki',
      label: 'deepwiki',
      authKind: 'none',
      state: 'ready',
    })
    expect(
      await register(workspaceId, {
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        authKind: 'oauth',
        label: 'Linear',
      }),
    ).toMatchObject({ name: 'linear', label: 'Linear', authKind: 'oauth', state: 'needs_auth' })

    expect((await listServers(workspaceId)).map(server => server.name)).toEqual([
      'deepwiki',
      'linear',
    ])
  })

  test('refuses a name already taken in the workspace but not in another one', async () => {
    const workspaceId = await createWorkspace('unique')
    const otherWorkspaceId = await createWorkspace('unique-other')
    await register(workspaceId, { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' })

    await expect(
      register(workspaceId, { name: 'deepwiki', url: 'https://elsewhere.example.com/mcp' }),
    ).rejects.toThrow('duplicate_name')
    expect((await listServers(workspaceId)).map(server => server.url)).toEqual([
      'https://mcp.deepwiki.com/mcp',
    ])

    expect(
      await register(otherWorkspaceId, {
        name: 'deepwiki',
        url: 'https://elsewhere.example.com/mcp',
      }),
    ).toMatchObject({ name: 'deepwiki' })
  })

  test('refuses a name the runner could not decode and the reserved Composio key', async () => {
    const workspaceId = await createWorkspace('grammar')

    for (const name of ['my__server', 'integrations', 'has space', '']) {
      await expect(
        register(workspaceId, { name, url: 'https://example.com/mcp' }),
      ).rejects.toThrow()
    }
    await expect(
      register(workspaceId, { name: 'insecure', url: 'http://example.com/mcp' }),
    ).rejects.toThrow()
    expect(await listServers(workspaceId)).toEqual([])
  })

  test('internal registration refuses unbounded persisted probe metadata', async () => {
    const workspaceId = await createWorkspace('probe-bounds')
    await expect(
      mutate(owner.client, 'domains/mcpServers/model:registerMcpServer', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        actorId: owner.user._id,
        authKind: 'none',
        name: 'oversized_probe',
        url: 'https://example.com/mcp',
        droppedToolNames: Array.from(
          { length: MAX_MCP_DROPPED_TOOL_NAMES + 1 },
          (_, index) => `tool_${index}`,
        ),
      }),
    ).rejects.toThrow()
    expect(await listServers(workspaceId)).toEqual([])
  })

  test('stops registering at the workspace cap', async () => {
    const workspaceId = await createWorkspace('cap')
    for (let index = 0; index < MAX_MCP_SERVERS_PER_WORKSPACE; index += 1) {
      await register(workspaceId, {
        name: `server_${index}`,
        url: `https://example.com/${index}/mcp`,
      })
    }

    await expect(
      register(workspaceId, { name: 'one_too_many', url: 'https://example.com/extra/mcp' }),
    ).rejects.toThrow('server_limit')
    expect(await listServers(workspaceId)).toHaveLength(MAX_MCP_SERVERS_PER_WORKSPACE)

    // The cap is a ceiling on live rows, not a lifetime quota.
    await removeServer(workspaceId, 'server_0')
    expect(
      await register(workspaceId, { name: 'one_too_many', url: 'https://example.com/extra/mcp' }),
    ).toMatchObject({ name: 'one_too_many' })
  })

  test('keeps every agent, nobody, and exactly-those distinguishable', async () => {
    const workspaceId = await createWorkspace('policy')
    const firstAgentId = await createAgent(workspaceId, 'first')
    const secondAgentId = await createAgent(workspaceId, 'second')
    const sortedAgentIds = [firstAgentId, secondAgentId].sort()
    await register(workspaceId, { name: 'notion', url: 'https://mcp.notion.com/mcp' })

    expect((await listServers(workspaceId))[0]!.allowedAgentIds).toBeUndefined()

    expect(await setPolicy(workspaceId, 'notion', [])).toEqual({
      name: 'notion',
      allowedAgentIds: [],
    })
    expect((await listServers(workspaceId))[0]!.allowedAgentIds).toEqual([])

    expect(
      await setPolicy(workspaceId, 'notion', [secondAgentId, 'root', firstAgentId, secondAgentId]),
    ).toEqual({ name: 'notion', allowedAgentIds: ['root', ...sortedAgentIds] })
    expect((await listServers(workspaceId))[0]!.allowedAgentIds).toEqual([
      'root',
      ...sortedAgentIds,
    ])

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await mutate(owner.client, 'domains/mcpServers/model:clearMcpServerAgentPolicy', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          name: 'notion',
        }),
      ).toEqual({ name: 'notion' })
    }
    expect((await listServers(workspaceId))[0]!.allowedAgentIds).toBeUndefined()
  })

  test('refuses a principal from another workspace', async () => {
    const workspaceId = await createWorkspace('foreign-principal')
    const foreignWorkspaceId = await createWorkspace('foreign-owner')
    const foreignAgentId = await createAgent(foreignWorkspaceId, 'foreign')
    await register(workspaceId, { name: 'notion', url: 'https://mcp.notion.com/mcp' })

    await expect(setPolicy(workspaceId, 'notion', [foreignAgentId])).rejects.toThrow(
      'invalid_agent',
    )
    expect((await listServers(workspaceId))[0]!.allowedAgentIds).toBeUndefined()
  })

  test('takes the credential and the policy down with the server row', async () => {
    const workspaceId = await createWorkspace('cascade')
    const agentId = await createAgent(workspaceId, 'keeper')
    const kept = await register(workspaceId, { name: 'kept', url: 'https://example.com/kept/mcp' })
    const doomed = await register(workspaceId, {
      name: 'doomed',
      url: 'https://example.com/doomed/mcp',
      authKind: 'static',
    })
    await setPolicy(workspaceId, 'kept', [agentId])
    await setPolicy(workspaceId, 'doomed', [agentId])
    await storeCredential(workspaceId, doomed.id, 'doomed-token')
    await storeCredential(workspaceId, kept.id, 'kept-token')

    expect(await removeServer(workspaceId, 'doomed')).toEqual({ name: 'doomed', removed: true })

    expect((await rawRows(workspaceId, 'rawServersForTest')).map(row => row.name)).toEqual(['kept'])
    expect(
      (await rawRows(workspaceId, 'rawCredentialsForTest')).map(row => row.accessToken),
    ).toEqual(['kept-token'])
    expect((await rawRows(workspaceId, 'rawPoliciesForTest')).map(row => row.serverId)).toEqual([
      kept.id,
    ])
    // Removing something that is already gone is not an error; it is the same
    // answer told twice.
    expect(await removeServer(workspaceId, 'doomed')).toEqual({ name: 'doomed', removed: false })
  })

  test('rejects a credential write that raced another writer', async () => {
    const workspaceId = await createWorkspace('generation')
    const server = await register(workspaceId, {
      name: 'rotating',
      url: 'https://example.com/rotating/mcp',
      authKind: 'oauth',
    })

    expect(await storeCredential(workspaceId, server.id, 'first')).toEqual({
      status: 'stored',
      generation: 1,
    })
    expect(await storeCredential(workspaceId, server.id, 'second', 1)).toEqual({
      status: 'stored',
      generation: 2,
    })
    // The loser read generation 1 and is refused, so the winner's rotated
    // refresh token cannot be overwritten by a stale copy.
    expect(await storeCredential(workspaceId, server.id, 'stale', 1)).toEqual({
      status: 'stale',
      generation: 2,
    })
    expect(
      (await rawRows(workspaceId, 'rawCredentialsForTest')).map(row => row.accessToken),
    ).toEqual(['second'])
  })

  test('hands the refresh token to one claimant per generation and makes the rest wait', async () => {
    const workspaceId = await createWorkspace('lease')
    const server = await oauthServer(workspaceId, 'lease')

    // Both lambdas read generation 1 and both believe the token is expired.
    const winner = await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)
    const loser = await claimLease(workspaceId, server.id, 1, 'lambda-b', 10_000)

    // Handing out the refresh token and taking the lease are the SAME write, so
    // the token cannot be released twice under one generation.
    expect(winner).toMatchObject({
      status: 'claimed',
      generation: 1,
      refreshToken: 'refresh-1',
      resource: 'https://mcp.example.com/mcp',
      authorizationServer: 'https://auth.example.com/tenant',
    })
    expect(loser).toEqual({ status: 'busy', leaseUntil: 30_000, credential: expect.anything() })
    expect(JSON.stringify(loser)).not.toContain('refresh-1')

    // A lease nobody released is claimable once it lapses — the winner's lambda
    // may simply have died.
    expect(await claimLease(workspaceId, server.id, 1, 'lambda-c', 30_001)).toMatchObject({
      status: 'claimed',
      refreshToken: 'refresh-1',
    })
  })

  test('refuses to hand out a refresh token nobody needs', async () => {
    const workspaceId = await createWorkspace('lease-unneeded')
    const server = await oauthServer(workspaceId, 'unneeded', { accessExpiresAt: 500_000 })

    // Someone else refreshed between this caller's read and its claim.
    expect(await claimLease(workspaceId, server.id, 0, 'lambda-a', 10_000)).toMatchObject({
      status: 'refreshed',
      credential: { generation: 1, accessToken: 'access-1' },
    })
    // The token is still comfortably inside its life: a raced winner already
    // extended it, or it never needed extending.
    expect(await claimLease(workspaceId, server.id, 1, 'lambda-b', 10_000)).toMatchObject({
      status: 'refreshed',
    })
    // Neither branch took a lease, so a caller that really does need one is not
    // locked out.
    const rows = await rawRows(workspaceId, 'rawCredentialsForTest')
    expect(rows[0]).not.toHaveProperty('leaseOwner')
    expect(rows[0]).not.toHaveProperty('leaseUntil')
  })

  test('commits a refresh only on the generation it read', async () => {
    const workspaceId = await createWorkspace('commit')
    const server = await oauthServer(workspaceId, 'commit')
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)

    expect(
      await commitRefresh(workspaceId, server.id, {
        owner: 'lambda-a',
        expectedGeneration: 1,
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        accessExpiresAt: 3_610_000,
        now: 10_000,
      }),
    ).toMatchObject({
      status: 'committed',
      credential: { generation: 2, accessToken: 'access-2', accessExpiresAt: 3_610_000 },
    })

    // The lease is released with the commit, so the next expiry does not have
    // to wait it out.
    const committed = (await rawRows(workspaceId, 'rawCredentialsForTest'))[0]
    expect(committed).not.toHaveProperty('leaseOwner')
    expect(committed).not.toHaveProperty('leaseUntil')

    // A second commit from the same read is a caller whose fetch was overtaken.
    // Lease ownership governs who may FETCH; generation governs who may WRITE.
    expect(
      await commitRefresh(workspaceId, server.id, {
        owner: 'lambda-a',
        expectedGeneration: 1,
        accessToken: 'access-stale',
        now: 11_000,
      }),
    ).toMatchObject({ status: 'superseded', credential: { generation: 2 } })
    expect((await rawRows(workspaceId, 'rawCredentialsForTest'))[0]).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    })
  })

  test('keeps the refresh token an authorization server declined to rotate', async () => {
    const workspaceId = await createWorkspace('commit-no-rotation')
    const server = await oauthServer(workspaceId, 'norotate')
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)

    await commitRefresh(workspaceId, server.id, {
      owner: 'lambda-a',
      expectedGeneration: 1,
      accessToken: 'access-2',
      now: 10_000,
    })

    // Half of real refreshes look like this. The generation still advances,
    // which is why generation — never token equality — is the rotation signal.
    expect((await rawRows(workspaceId, 'rawCredentialsForTest'))[0]).toMatchObject({
      generation: 2,
      accessToken: 'access-2',
      refreshToken: 'refresh-1',
    })
  })

  test('a transient refresh failure releases the lease and keeps the grant', async () => {
    const workspaceId = await createWorkspace('fail-transient')
    const server = await oauthServer(workspaceId, 'transient')
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)

    expect(
      await failRefresh(workspaceId, server.id, {
        owner: 'lambda-a',
        expectedGeneration: 1,
        outcome: 'transient',
        now: 12_000,
      }),
    ).toMatchObject({ status: 'cleared' })

    const row = (await rawRows(workspaceId, 'rawCredentialsForTest'))[0]
    expect(row).toMatchObject({ generation: 1, refreshToken: 'refresh-1' })
    expect(row).not.toHaveProperty('invalidAt')
    expect(row).not.toHaveProperty('leaseOwner')
  })

  test('an invalid_grant kills the refresh token instead of leaving it to be refused again', async () => {
    const workspaceId = await createWorkspace('fail-grant')
    const server = await oauthServer(workspaceId, 'revoked')
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)

    expect(
      await failRefresh(workspaceId, server.id, {
        owner: 'lambda-a',
        expectedGeneration: 1,
        outcome: 'invalid_grant',
        now: 12_000,
      }),
    ).toMatchObject({ status: 'invalidated', generation: 2 })

    const row = (await rawRows(workspaceId, 'rawCredentialsForTest'))[0]
    // Provably dead: keeping it invites every other lambda to burn another
    // refusal on it. The row survives — the UI hangs "Reconnect" on it and
    // disconnect still needs the registration link.
    expect(row).not.toHaveProperty('refreshToken')
    expect(row).toMatchObject({ generation: 2, invalidAt: 12_000, invalidReason: 'invalid_grant' })
    expect(row).not.toHaveProperty('leaseOwner')

    // Every later claimant is turned away inside the transaction, so a
    // condemned grant costs the authorization server no further refusals no
    // matter how many lambdas arrive.
    expect(await claimLease(workspaceId, server.id, 2, 'lambda-b', 13_000)).toEqual({
      status: 'invalid',
    })
  })

  test('an invalid_client condemns the registration as well as the grant', async () => {
    const workspaceId = await createWorkspace('fail-client')
    const registration = await storeRegistration(
      workspaceId,
      'https://auth.example.com/tenant',
      'client-a',
    )
    const server = await oauthServer(workspaceId, 'badclient', { registrationId: registration.id })
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)

    await failRefresh(workspaceId, server.id, {
      owner: 'lambda-a',
      expectedGeneration: 1,
      outcome: 'invalid_client',
      now: 12_000,
    })

    // The next connect registers deliberately rather than reusing a client this
    // authorization server has stopped honouring.
    expect((await rawRows(workspaceId, 'rawRegistrationsForTest'))[0]).toMatchObject({
      invalidAt: 12_000,
      invalidReason: 'invalid_client',
    })
  })

  test('a failure whose generation moved does not undo the refresh that overtook it', async () => {
    const workspaceId = await createWorkspace('fail-superseded')
    const server = await oauthServer(workspaceId, 'overtaken')
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)
    // The winner's lease lapses, a second lambda refreshes successfully, and
    // only then does the first one come back with a refusal for a token that is
    // no longer the row's.
    await commitRefresh(workspaceId, server.id, {
      owner: 'lambda-b',
      expectedGeneration: 1,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      now: 40_000,
    })

    expect(
      await failRefresh(workspaceId, server.id, {
        owner: 'lambda-a',
        expectedGeneration: 1,
        outcome: 'invalid_grant',
        now: 41_000,
      }),
    ).toMatchObject({ status: 'superseded' })

    // The live grant survives a refusal that was about a token it replaced.
    const row = (await rawRows(workspaceId, 'rawCredentialsForTest'))[0]
    expect(row).toMatchObject({ generation: 2, refreshToken: 'refresh-2' })
    expect(row).not.toHaveProperty('invalidAt')
  })

  test('the per-request read reports the lease and the refresh token without returning it', async () => {
    const workspaceId = await createWorkspace('proxy-read')
    const server = await oauthServer(workspaceId, 'reader')
    await claimLease(workspaceId, server.id, 1, 'lambda-a', 10_000)

    const credential = await readCredential(workspaceId, server.id)

    expect(credential).toMatchObject({
      generation: 1,
      kind: 'oauth',
      accessToken: 'access-1',
      // What the caller needs to decide whether a refresh is even possible,
      // without the secret that would make a second copy of it.
      hasRefreshToken: true,
      leaseUntil: 30_000,
    })
    expect(JSON.stringify(credential)).not.toContain('refresh-1')
  })

  test('shares one registration across servers behind one authorization server', async () => {
    const workspaceId = await createWorkspace('registration')

    // Same authorization server, four spellings: trailing slash, query,
    // fragment, and default port.
    const first = await storeRegistration(
      workspaceId,
      'https://auth.example.com/tenant/',
      'client-a',
    )
    const second = await storeRegistration(
      workspaceId,
      'https://auth.example.com:443/tenant?x=1#frag',
      'client-b',
    )

    expect(first.authorizationServer).toBe('https://auth.example.com/tenant')
    expect(second.id).toBe(first.id)
    // The FIRST identity is defended, not replaced. Overwriting it would leave
    // client-a registered on the third party with nothing pointing at it —
    // the orphan D18 exists to prevent — and the caller would never learn it
    // had one to clean up.
    expect(second.clientId).toBe('client-a')
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toHaveLength(1)

    // A different path is a different authorization server, not the same one.
    await storeRegistration(workspaceId, 'https://auth.example.com/other', 'client-c')
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toHaveLength(2)
  })

  // D18 is one registration per (workspace, authorization server). A plain
  // upsert cannot enforce it: two connects racing the same server would both
  // patch, and the loser would never learn it had a client to clean up — which
  // is exactly the orphaned "Duet" registration D18 exists to prevent.
  test('a second registration for one authorization server loses, and is told so', async () => {
    const workspaceId = await createWorkspace('registration-cas')
    const first = await storeRegistrationResult(workspaceId, 'https://auth.example.com', 'client-1')
    const second = await storeRegistrationResult(
      workspaceId,
      'https://auth.example.com',
      'client-2',
    )

    expect(first.status).toBe('adopted')
    expect(second.status).toBe('exists')
    // The loser is handed the WINNER's identity, so it deletes its own upstream
    // client rather than assuming the row is now its.
    expect(second.registration.clientId).toBe('client-1')
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toHaveLength(1)
  })

  // A rejected client is the one case where replacing is right: the next
  // connect re-registers deliberately, once, instead of the SDK re-registering
  // on every rejection and littering the third party.
  test('an invalidated registration is replaced rather than defended', async () => {
    const workspaceId = await createWorkspace('registration-cas-recovery')
    const first = await storeRegistrationResult(workspaceId, 'https://auth.example.com', 'client-1')
    await mutate(owner.client, 'domains/mcpServers/credentials:invalidateMcpClientRegistration', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      registrationId: first.registration.id,
      reason: 'invalid_client',
      now: 1_000,
    })

    const replacement = await storeRegistrationResult(
      workspaceId,
      'https://auth.example.com',
      'client-2',
    )
    expect(replacement.status).toBe('adopted')
    expect(replacement.registration.clientId).toBe('client-2')
    // The mark clears with the identity it condemned, and no second row appears.
    const rows = await rawRows(workspaceId, 'rawRegistrationsForTest')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ clientId: 'client-2' })
    // Convex removes a field patched to undefined rather than storing it, so
    // the cleared mark is an absent key.
    expect(rows[0]).not.toHaveProperty('invalidAt')
  })

  test('never returns a client secret or the RFC 7592 access token', async () => {
    const workspaceId = await createWorkspace('registration-secrets')
    const stored = await storeRegistration(workspaceId, 'https://auth.example.com/s', 'client-s', {
      clientSecret: 'shhh',
      registrationAccessToken: 'rfc7592-token',
      registrationClientUri: 'https://auth.example.com/register/client-s',
    })

    expect(stored).toMatchObject({ clientId: 'client-s', hasClientSecret: true })
    expect(JSON.stringify(stored)).not.toContain('shhh')
    expect(JSON.stringify(stored)).not.toContain('rfc7592-token')
    // The row still keeps both — they are the only way to delete the client
    // upstream later.
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toMatchObject([
      { clientSecret: 'shhh', registrationAccessToken: 'rfc7592-token' },
    ])
  })

  test('coalesces a run of identical health observations into one write', async () => {
    const workspaceId = await createWorkspace('health')
    await register(workspaceId, { name: 'flaky', url: 'https://example.com/flaky/mcp' })

    expect(await recordHealth(workspaceId, 'flaky', 'success', undefined, 1_000)).toEqual({
      recorded: true,
    })
    expect(await recordHealth(workspaceId, 'flaky', 'success', undefined, 2_000)).toEqual({
      recorded: false,
    })
    expect((await getServer(workspaceId, 'flaky')).lastSuccessAt).toBe(1_000)

    // A failure after a success changes what the row says, so it lands at once.
    expect(await recordHealth(workspaceId, 'flaky', 'error', 'unauthorized', 3_000)).toEqual({
      recorded: true,
    })
    expect(await recordHealth(workspaceId, 'flaky', 'error', 'unauthorized', 4_000)).toEqual({
      recorded: false,
    })
    // A different code is a different problem to report.
    expect(await recordHealth(workspaceId, 'flaky', 'error', 'unreachable', 5_000)).toEqual({
      recorded: true,
    })
    // So is a recovery, even though the last success is inside the window.
    expect(await recordHealth(workspaceId, 'flaky', 'success', undefined, 6_000)).toEqual({
      recorded: true,
    })
    expect(await getServer(workspaceId, 'flaky')).toMatchObject({
      lastSuccessAt: 6_000,
      lastErrorAt: 5_000,
      lastErrorCode: 'unreachable',
    })

    // A steady failure eventually refreshes its timestamp so the row cannot
    // claim a problem stopped an hour ago while it is still happening.
    expect(await recordHealth(workspaceId, 'flaky', 'error', 'unreachable', 7_000)).toEqual({
      recorded: true,
    })
    expect(await recordHealth(workspaceId, 'flaky', 'error', 'unreachable', 8_000)).toEqual({
      recorded: false,
    })
    expect(await recordHealth(workspaceId, 'flaky', 'error', 'unreachable', 70_000)).toEqual({
      recorded: true,
    })
  })

  test('redeems a pending authorization exactly once, with what the callback needs', async () => {
    const workspaceId = await createWorkspace('consent')
    const server = await register(workspaceId, {
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      authKind: 'oauth',
    })
    await startAuthorization(workspaceId, server.id, { hashedState: 'hash-a', expiresAt: 60_000 })

    const claimed = await claimAuthorization('hash-a', server.id, 1_000)

    expect(claimed).toEqual({
      serverId: server.id,
      workspaceId,
      server: { name: 'linear', url: 'https://mcp.linear.app/mcp' },
      codeVerifier: 'verifier-hash-a',
      authorizationServer: 'https://auth.example.com/tenant',
      // Recorded from validated metadata BEFORE the redirect: RFC 9207 compares
      // against what discovery said then, not against whatever answers now.
      expectedIssuer: 'https://auth.example.com/tenant',
      resource: 'https://mcp.linear.app/mcp',
      redirectTo: 'https://app.duet.so/w/acme/integrations',
    })
    // The row is gone with the claim, so a callback replayed out of the
    // browser's history — or by anyone who watched the redirect — finds nothing.
    expect(await claimAuthorization('hash-a', server.id, 1_000)).toBeNull()
    expect(await rawAuthorizations(server.id)).toEqual([])
  })

  test('refuses an expired authorization and sweeps it, per server', async () => {
    const workspaceId = await createWorkspace('consent-expiry')
    const stale = await register(workspaceId, {
      name: 'stale',
      url: 'https://example.com/stale/mcp',
      authKind: 'oauth',
    })
    const other = await register(workspaceId, {
      name: 'other',
      url: 'https://example.com/other/mcp',
      authKind: 'oauth',
    })
    await startAuthorization(workspaceId, stale.id, { hashedState: 'old', expiresAt: 500 })
    await startAuthorization(workspaceId, other.id, { hashedState: 'other-old', expiresAt: 500 })

    expect(await claimAuthorization('old', stale.id, 1_000)).toBeNull()

    // A fresh press of Connect sweeps this server's dead rows...
    await startAuthorization(workspaceId, stale.id, { hashedState: 'new', expiresAt: 60_000 })
    expect((await rawAuthorizations(stale.id)).map(row => row.hashedState)).toEqual(['new'])
    // ...and only this server's: a table-wide sweep would make every
    // workspace's in-flight consent a read dependency of every connect.
    expect((await rawAuthorizations(other.id)).map(row => row.hashedState)).toEqual(['other-old'])
  })

  test('keeps concurrent attempts on one server apart, and refuses a foreign server', async () => {
    const workspaceId = await createWorkspace('consent-attempts')
    const server = await register(workspaceId, {
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      authKind: 'oauth',
    })
    const decoy = await register(workspaceId, {
      name: 'notion',
      url: 'https://mcp.notion.com/mcp',
      authKind: 'oauth',
    })
    // Two members pressing Connect on the same server: two verifiers, and each
    // response has to find its own.
    await startAuthorization(workspaceId, server.id, { hashedState: 'first', expiresAt: 60_000 })
    await startAuthorization(workspaceId, server.id, { hashedState: 'second', expiresAt: 60_000 })

    // A signed descriptor naming another server cannot spend this row.
    expect(await claimAuthorization('first', decoy.id, 1_000)).toBeNull()
    expect(await rawAuthorizations(server.id)).toHaveLength(2)

    expect(await claimAuthorization('second', server.id, 1_000)).toMatchObject({
      codeVerifier: 'verifier-second',
    })
    expect(await claimAuthorization('first', server.id, 1_000)).toMatchObject({
      codeVerifier: 'verifier-first',
    })
  })

  test('takes in-flight authorizations down with the server row', async () => {
    const workspaceId = await createWorkspace('consent-cascade')
    const server = await register(workspaceId, {
      name: 'doomed',
      url: 'https://example.com/doomed/mcp',
      authKind: 'oauth',
    })
    await startAuthorization(workspaceId, server.id, { hashedState: 'live', expiresAt: 60_000 })

    await removeServer(workspaceId, 'doomed')

    expect(await rawAuthorizations(server.id)).toEqual([])
    expect(await claimAuthorization('live', server.id, 1_000)).toBeNull()
  })

  test('lifts a consented server out of needs_auth, and only within its workspace', async () => {
    const workspaceId = await createWorkspace('consent-state')
    const foreignWorkspaceId = await createWorkspace('consent-state-foreign')
    const server = await register(workspaceId, {
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      authKind: 'oauth',
    })
    expect(server.state).toBe('needs_auth')

    await expect(setState(foreignWorkspaceId, server.id, 'ready')).rejects.toThrow(
      'server_not_found',
    )
    expect(await setState(workspaceId, server.id, 'ready')).toMatchObject({ state: 'ready' })
    expect((await getServer(workspaceId, 'linear')).state).toBe('ready')
  })

  test('deletes the credential before asking whether the registration is still used', async () => {
    const workspaceId = await createWorkspace('disconnect-order')
    const registration = await storeRegistration(
      workspaceId,
      'https://auth.example.com/tenant',
      'client-shared',
      {
        registrationClientUri: 'https://auth.example.com/register/client-shared',
        registrationAccessToken: 'rfc7592-token',
      },
    )
    const first = await oauthServer(workspaceId, 'first', { registrationId: registration.id })
    const second = await oauthServer(workspaceId, 'second', { registrationId: registration.id })

    const begun = (await beginDisconnect(workspaceId, 'first')) as {
      server: { id: string }
      credential: Record<string, unknown>
      registration: Record<string, unknown>
    }

    // The row says what is happening to it before anything leaves for the
    // third party, so a disconnect that dies mid-flight is visible rather than
    // looking like a healthy server.
    expect((await getServer(workspaceId, 'first')).state).toBe('disconnecting')
    // The one read that hands out a refresh token outside the lease, and the
    // one that hands out the RFC 7592 access token at all — both because this
    // is the call that spends them.
    expect(begun.credential).toMatchObject({ refreshToken: 'refresh-1' })
    expect(begun.registration).toMatchObject({ registrationAccessToken: 'rfc7592-token' })

    expect(await dropCredential(workspaceId, first.id)).toEqual({
      deleted: true,
      // `second` still holds it, so deleting the client upstream here would
      // break a server the user never touched.
      registration: 'shared',
    })
    expect((await rawRows(workspaceId, 'rawCredentialsForTest')).map(row => row.serverId)).toEqual([
      second.id,
    ])

    expect(await finishDisconnect(workspaceId, 'first', 'skipped')).toEqual({
      name: 'first',
      removed: true,
    })
    expect((await rawRows(workspaceId, 'rawServersForTest')).map(row => row.name)).toEqual([
      'second',
    ])
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toHaveLength(1)

    // The last server behind it: now the truth from `by_registration` changes,
    // and it changes because the credential is already gone.
    await beginDisconnect(workspaceId, 'second')
    expect(await dropCredential(workspaceId, second.id)).toEqual({
      deleted: true,
      registration: 'orphaned',
    })
    await finishDisconnect(workspaceId, 'second', 'deleted', registration.id)
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toEqual([])
  })

  test('a refused registration delete keeps the row reusable instead of tombstoning it', async () => {
    const workspaceId = await createWorkspace('disconnect-retained')
    const registration = await storeRegistration(
      workspaceId,
      'https://auth.example.com/tenant',
      'client-kept',
      { registrationClientUri: 'https://auth.example.com/register/client-kept' },
    )
    const server = await oauthServer(workspaceId, 'linear', { registrationId: registration.id })
    await beginDisconnect(workspaceId, 'linear')
    await dropCredential(workspaceId, server.id)

    await finishDisconnect(workspaceId, 'linear', 'failed', registration.id, 'http_503')

    const rows = await rawRows(workspaceId, 'rawRegistrationsForTest')
    expect(rows).toMatchObject([
      { clientId: 'client-kept', deleteFailedAt: 3_000, deleteFailedReason: 'http_503' },
    ])
    // NOT tombstoned, and that is the point: the next connect to this
    // authorization server reuses this client instead of minting a second
    // orphan beside the one that could not be deleted.
    expect(rows[0]).not.toHaveProperty('invalidAt')
    expect(
      await query(owner.client, 'domains/mcpServers/credentials:getMcpClientRegistration', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        authorizationServer: 'https://auth.example.com/tenant',
      }),
    ).toMatchObject({ id: registration.id, clientId: 'client-kept' })
  })

  test('a deleted workspace keeps no third-party token and no registration', async () => {
    const workspaceId = await createWorkspace('disconnect-reap')
    const registration = await storeRegistration(
      workspaceId,
      'https://auth.example.com/tenant',
      'client-reaped',
    )
    await oauthServer(workspaceId, 'linear', { registrationId: registration.id })
    const pasted = await register(workspaceId, {
      name: 'pasted',
      url: 'https://example.com/pasted/mcp',
    })
    await storeCredential(workspaceId, pasted.id, 'paste-me')

    await mutate(owner.client, 'testing/workspaces:deleteWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 5_000,
    })

    // Deleting the workspace is the last event that can ever reach these rows:
    // afterwards there is no member, no route and no server surface left
    // through which anyone could disconnect them.
    expect(await rawRows(workspaceId, 'rawCredentialsForTest')).toEqual([])
    expect(await rawRows(workspaceId, 'rawRegistrationsForTest')).toEqual([])
  })

  test('stores an unrecognized health code as a generic upstream error', async () => {
    const workspaceId = await createWorkspace('health-codes')
    await register(workspaceId, { name: 'noisy', url: 'https://example.com/noisy/mcp' })

    await recordHealth(workspaceId, 'noisy', 'error', 'Bearer sk-live-abcdef rejected', 1_000)

    expect((await getServer(workspaceId, 'noisy')).lastErrorCode).toBe('upstream_error')
  })
})

describe('authorization server normalization', () => {
  test('is the sharing rule, so only origin and path survive', () => {
    expect(normalizeAuthorizationServer('https://auth.example.com/tenant/')).toBe(
      'https://auth.example.com/tenant',
    )
    expect(normalizeAuthorizationServer('https://AUTH.example.com:443/tenant?a=b#c')).toBe(
      'https://auth.example.com/tenant',
    )
    expect(normalizeAuthorizationServer('https://auth.example.com')).toBe(
      'https://auth.example.com',
    )
    expect(normalizeAuthorizationServer('https://auth.example.com:8443/x')).toBe(
      'https://auth.example.com:8443/x',
    )
    expect(() => normalizeAuthorizationServer('http://auth.example.com')).toThrow()
    expect(() => normalizeAuthorizationServer('not a url')).toThrow()
  })
})

type StoredRegistration = {
  id: string
  authorizationServer: string
  clientId: string
  hasClientSecret: boolean
}

type RegisteredServer = {
  id: string
  name: string
  label: string
  url: string
  authKind: string
  state: string
  lastSuccessAt?: number
  lastErrorAt?: number
  lastErrorCode?: string
  allowedAgentIds?: string[]
}

async function beginDisconnect(workspaceId: string, name: string): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/disconnect:beginMcpServerDisconnect', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
    now: 3_000,
  })
}

async function dropCredential(workspaceId: string, serverId: string): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/disconnect:dropMcpServerCredential', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
  })
}

async function finishDisconnect(
  workspaceId: string,
  name: string,
  registrationDelete: 'deleted' | 'failed' | 'skipped',
  registrationId?: string,
  reason?: string,
): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/disconnect:finishMcpServerDisconnect', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
    registrationDelete,
    ...(registrationId === undefined ? {} : { registrationId }),
    ...(reason === undefined ? {} : { reason }),
    now: 3_000,
  })
}

async function removeServer(workspaceId: string, name: string): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/model:deleteMcpServer', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
  })
}

async function setPolicy(
  workspaceId: string,
  name: string,
  allowedAgentIds: string[],
): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/model:setMcpServerAgentPolicy', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
    allowedAgentIds,
  })
}

async function storeCredential(
  workspaceId: string,
  serverId: string,
  accessToken: string,
  expectedGeneration?: number,
): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/credentials:storeMcpServerCredential', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
    kind: 'static',
    accessToken,
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
  })
}

/**
 * A consented OAuth server: the row shape the refresh lease operates on, with
 * an access token already at the end of its life.
 */
async function oauthServer(
  workspaceId: string,
  name: string,
  options: { accessExpiresAt?: number; registrationId?: string } = {},
): Promise<RegisteredServer> {
  const server = await register(workspaceId, {
    name,
    url: `https://mcp.example.com/${name}/mcp`,
    authKind: 'oauth',
  })
  await mutate(owner.client, 'domains/mcpServers/credentials:storeMcpServerCredential', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId: server.id,
    kind: 'oauth',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: options.accessExpiresAt ?? 20_000,
    resource: 'https://mcp.example.com/mcp',
    authorizationServer: 'https://auth.example.com/tenant',
    ...(options.registrationId === undefined ? {} : { registrationId: options.registrationId }),
    now: 1_000,
  })
  return server
}

async function claimLease(
  workspaceId: string,
  serverId: string,
  expectedGeneration: number,
  leaseOwner: string,
  now: number,
): Promise<Record<string, unknown>> {
  return (await mutate(owner.client, 'domains/mcpServers/credentials:claimMcpRefreshLease', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
    expectedGeneration,
    owner: leaseOwner,
    skewMs: 60_000,
    leaseMs: 20_000,
    now,
  })) as Record<string, unknown>
}

async function commitRefresh(
  workspaceId: string,
  serverId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await mutate(owner.client, 'domains/mcpServers/credentials:commitMcpRefresh', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
    ...input,
  })) as Record<string, unknown>
}

async function failRefresh(
  workspaceId: string,
  serverId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await mutate(owner.client, 'domains/mcpServers/credentials:failMcpRefresh', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
    ...input,
  })) as Record<string, unknown>
}

async function readCredential(
  workspaceId: string,
  serverId: string,
): Promise<Record<string, unknown> | null> {
  return (await query(owner.client, 'domains/mcpServers/credentials:readMcpServerCredential', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
  })) as Record<string, unknown> | null
}

async function storeRegistration(
  workspaceId: string,
  authorizationServer: string,
  clientId: string,
  extra: Record<string, string> = {},
): Promise<StoredRegistration> {
  return (await storeRegistrationResult(workspaceId, authorizationServer, clientId, extra))
    .registration
}

async function storeRegistrationResult(
  workspaceId: string,
  authorizationServer: string,
  clientId: string,
  extra: Record<string, string> = {},
): Promise<{ status: 'adopted' | 'exists'; registration: StoredRegistration }> {
  return (await mutate(owner.client, 'domains/mcpServers/credentials:storeMcpClientRegistration', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    authorizationServer,
    clientId,
    ...extra,
  })) as { status: 'adopted' | 'exists'; registration: StoredRegistration }
}

async function startAuthorization(
  workspaceId: string,
  serverId: string,
  input: { hashedState: string; expiresAt: number },
): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/oauth:startMcpOAuthAuthorization', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
    hashedState: input.hashedState,
    codeVerifier: `verifier-${input.hashedState}`,
    authorizationServer: 'https://auth.example.com/tenant',
    expectedIssuer: 'https://auth.example.com/tenant',
    resource: 'https://mcp.linear.app/mcp',
    redirectTo: 'https://app.duet.so/w/acme/integrations',
    expiresAt: input.expiresAt,
    now: 1_000,
  })
}

async function claimAuthorization(
  hashedState: string,
  serverId: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  return (await mutate(owner.client, 'domains/mcpServers/oauth:claimMcpOAuthAuthorization', {
    internalKey: INTERNAL_KEY,
    hashedState,
    serverId,
    now,
  })) as Record<string, unknown> | null
}

async function rawAuthorizations(serverId: string): Promise<Array<Record<string, string>>> {
  return (await query(owner.client, 'testing/mcpServers:rawAuthorizationsForTest', {
    internalKey: INTERNAL_KEY,
    serverId,
  })) as Array<Record<string, string>>
}

async function setState(
  workspaceId: string,
  serverId: string,
  state: string,
): Promise<RegisteredServer> {
  return (await mutate(owner.client, 'domains/mcpServers/model:setMcpServerState', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    serverId,
    state,
    now: 2_000,
  })) as RegisteredServer
}

async function recordHealth(
  workspaceId: string,
  name: string,
  outcome: 'success' | 'error',
  errorCode: string | undefined,
  now: number,
): Promise<unknown> {
  return await mutate(owner.client, 'domains/mcpServers/health:recordMcpServerHealth', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
    outcome,
    now,
    ...(errorCode === undefined ? {} : { errorCode }),
  })
}

async function getServer(workspaceId: string, name: string): Promise<RegisteredServer> {
  return (await query(owner.client, 'domains/mcpServers/model:getMcpServer', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    name,
  })) as RegisteredServer
}

async function rawRows(
  workspaceId: string,
  name:
    | 'rawServersForTest'
    | 'rawCredentialsForTest'
    | 'rawPoliciesForTest'
    | 'rawRegistrationsForTest',
): Promise<Array<Record<string, string>>> {
  return (await query(owner.client, `testing/mcpServers:${name}`, {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, string>>
}

async function createAgent(workspaceId: string, slug: string): Promise<string> {
  const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path: `agents/${slug}`,
    slug,
  })) as { id: string }
  return agent.id
}

async function register(
  workspaceId: string,
  input: { name: string; url: string; authKind?: string; label?: string },
): Promise<RegisteredServer> {
  return (await mutate(owner.client, 'domains/mcpServers/model:registerMcpServer', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    actorId: owner.user._id,
    authKind: 'none',
    ...input,
  })) as RegisteredServer
}

async function listServers(workspaceId: string): Promise<RegisteredServer[]> {
  return (await query(owner.client, 'domains/mcpServers/model:listMcpServers', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as RegisteredServer[]
}

async function createWorkspace(label: string): Promise<string> {
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `mcp-servers-${label}-${sequence++}`,
    name: `MCP servers ${label}`,
  })) as string
}
