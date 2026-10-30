import assert from 'node:assert/strict'

import {
  AGENT_TERMINAL_STATES,
  isKnownTimelineEvent,
  McpServerAgentPolicyResponseSchema,
  McpServerListSchema,
  McpServerProbeSchema,
  McpServerSchema,
  namespacedToolName,
  RemoveMcpServerResponseSchema,
  SessionCreateResponseSchema,
  SessionInputResponseSchema,
  type McpServer,
  type RemoveMcpServerResponse,
} from '@repo/contract'
import {
  FAKE_MCP_OVERSIZED_BYTES,
  FAKE_MCP_OVERSIZED_TOOL,
  FAKE_OAUTH_ISSUER_MOUNT_PATH,
} from '@repo/fake-oauth-issuer'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  deleteStagingSession,
  loadSessionSnapshot,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { assertNoCredentialArtifacts } from './staging-live-artifacts.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { fnMutation, fnQuery } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, timedFetch } from './staging-live-http.ts'
import { INTEGRATION_AGENT_ACCESS_ALL_LABEL } from './staging-live-integration-agent-access.ts'
import { parseMcpJsonRpcResponse } from './staging-live-mcp-oauth.ts'
import type { ChronologicalSessionHistory } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

/**
 * Custom remote MCP servers, end to end on live staging.
 *
 * The target is the fake issuer mounted on the staging API itself
 * (`DUET_ENABLE_FAKE_OAUTH_ISSUER=1`), never a third party: D21 wants a gate
 * that cannot fail because somebody else had an outage or redesigned a consent
 * page. That choice also means every hop this journey exercises — discovery,
 * registration, consent, refresh, revocation and the tool byte path — is an
 * `apps/api` → `apps/api` fetch, so one reachability fact carries all of them.
 *
 * Two things the fixture deliberately cannot prove, and which this file
 * therefore asserts about DUET rather than about the authorization server:
 *
 * - **It cannot forget.** A stateless issuer accepts a revocation and a
 *   registration delete and keeps honouring the credential. So the disconnect
 *   leg asserts that Duet issued a well-formed request and that Duet's own rows
 *   are gone — never that the grant died upstream.
 * - **It rotates only every other refresh.** So nothing here compares token
 *   values. `generation` is the rotation signal, and it is the only one.
 */

/** Legs in the order they run; the slice's own numbering is noted on each. */
export const MCP_SERVERS_STAGING_LEGS = [
  /* Slice leg 2. First, not second, because it is what mints the only
     credential the fixture's MCP endpoint accepts — see `static-token`. */
  'oauth-consent-tools',
  /* Slice leg 1. */
  'static-token-tools',
  /* Slice leg 3. */
  'agent-policy',
  /* Slice leg 4 — the one this whole spec turns on. */
  'broken-url-degrades',
  /* Slice leg 5. */
  'oversized-result-capped',
  /* Slice leg 6. */
  'refresh-lease',
  /* Slice leg 7. */
  'disconnect-revokes',
  /* Slice leg 8. */
  'artifact-cleanup',
] as const

export type McpServersLeg = (typeof MCP_SERVERS_STAGING_LEGS)[number]

/** Names are identities here: tool-name prefix, proxy path segment, marker. */
const OAUTH_SERVER = 'fakeoauth'
const STATIC_SERVER = 'staticfake'
const BROKEN_SERVER = 'brokenmcp'

const HEALTH_WAIT_MS = 60_000
const TURN_TIMEOUT_MS = 300_000
const BROWSER_TRANSITION_TIMEOUT_MS = 60_000

export interface McpServersJourneyEvidence {
  passedLegs: McpServersLeg[]
  /** What the runner actually called, namespaced, per server. */
  calledTools: string[]
  /** D5: the same server, seen from two principals in the same workspace. */
  agentPolicy: {
    allowedAgentIds: string[]
    rootLaunchNames: string[]
    agentLaunchNames: string[]
    clearedToAll: true
  }
  /** D17. `dispatchRefused: false` is the whole point of the feature. */
  degraded: {
    dispatchRefused: false
    turnCompleted: true
    healthErrorCode: string
    everSucceeded: false
  }
  /** D20, measured off the wire rather than off a constant we do not own. */
  cap: { originalBytes: number; cappedResultBytes: number; markerInTimeline: true }
  /** D10. Generations, never token values — the fixture rotates every other refresh. */
  refresh: { forcedGeneration: number; generationAfterConcurrentCalls: number }
  /** D18, as an attempt. A stateless fixture can never prove more. */
  removal: RemoveMcpServerResponse
}

interface McpServerRow {
  _id: string
  name: string
  state: string
}

interface McpCredentialRow {
  _id: string
  serverId: string
  kind: 'oauth' | 'static'
  accessToken: string
  tokenType: string
  refreshToken?: string
  scope?: string
  accessExpiresAt?: number
  registrationId?: string
  resource?: string
  authorizationServer?: string
  generation: number
}

interface McpRegistrationRow {
  _id: string
  clientId: string
  authorizationServer: string
  deleteFailedAt?: number
  deleteFailedReason?: string
}

export async function runMcpServersJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<McpServersJourneyEvidence>> {
  const result = await runWorkspaceBrowserJourney({
    journey: 'mcp-servers',
    label: 'Custom MCP servers',
    onProgress: options.onProgress,
    run: runMcpServersAcceptance,
  })
  await assertNoCredentialArtifacts(result.artifactDirectory)
  return result
}

export async function runMcpServersAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<McpServersJourneyEvidence> {
  const { env, page, workspace, apiToken, email, runId, ledger, convex, artifacts, progress } =
    context
  const issuerUrl = `${env.apiUrl}${FAKE_OAUTH_ISSUER_MOUNT_PATH}`
  const fakeMcpUrl = `${issuerUrl}/mcp`
  const passedLegs: McpServersLeg[] = []
  const calledTools: string[] = []

  // Fail on the fixture rather than on a confusing "server_unreachable" from a
  // probe: the whole journey targets an issuer that only exists when the
  // staging API was deployed with it switched on.
  progress('mcp-servers:preflight')
  const resourceMetadata = await timedFetch(
    `${issuerUrl}/.well-known/oauth-protected-resource`,
    {},
    artifacts,
  )
  assert.equal(
    resourceMetadata.status,
    200,
    'the fake OAuth issuer is not mounted on the staging API — ' +
      'redeploy it with DUET_ENABLE_FAKE_OAUTH_ISSUER=1 before running this journey',
  )
  const prm = (await resourceMetadata.json()) as { resource?: string }
  assert.equal(prm.resource, fakeMcpUrl, 'the fake issuer protects a different MCP resource')

  const agentName = `MCP Servers ${runId.slice(-6)}`
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: `mcp-servers-${runId.slice(-6)}`,
    name: agentName,
    description: 'Staging fixture for custom MCP servers.',
    ledger,
    convex,
    artifacts,
  })

  let agentSessionId = ''
  let rootSessionId = ''
  let agentPolicy: McpServersJourneyEvidence['agentPolicy'] | undefined
  let degraded: McpServersJourneyEvidence['degraded'] | undefined
  let cap: McpServersJourneyEvidence['cap'] | undefined
  let refresh: McpServersJourneyEvidence['refresh'] | undefined
  let removal: RemoveMcpServerResponse | undefined

  const actions: Record<McpServersLeg, () => Promise<void>> = {
    'oauth-consent-tools': async () => {
      progress('mcp-servers:oauth-consent')
      // D7: the probe says what the SERVER challenged with, and whether Duet
      // can obtain a client id at all. The fixture advertises no CIMD, so this
      // is the DCR branch — the one with cleanup to exercise later.
      const probe = McpServerProbeSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/ws/${workspace.slug}/mcp-servers/probe`,
          {
            method: 'POST',
            headers: bearerJson(apiToken),
            body: JSON.stringify({ name: OAUTH_SERVER, url: fakeMcpUrl }),
          },
          200,
          'mcp servers oauth probe',
          artifacts,
        ),
      )
      assert.equal(probe.auth, 'oauth', 'fake MCP endpoint did not challenge for OAuth')
      assert.equal(probe.registrationSupported, true, 'fake issuer offered Duet no client id')

      const added = await addServer({
        name: OAUTH_SERVER,
        url: fakeMcpUrl,
        auth: { kind: 'oauth' },
      })
      assert.equal(added.state, 'needs_auth', 'a consented-to-nothing server was not needs_auth')
      // Nothing is measurable before consent, and zeroes would read as free.
      assert.equal(added.toolCount, undefined, 'an unauthorized server reported a tool count')

      await approveConsentInBrowser()

      const connected = await serverByName(OAUTH_SERVER)
      assert.equal(connected.state, 'ready', 'consent did not leave the server ready')
      const credential = await credentialForServer(OAUTH_SERVER)
      assert.equal(credential.kind, 'oauth', 'consent stored the wrong credential kind')
      assert(credential.refreshToken !== undefined, 'consent stored no refresh token')
      assert(
        credential.authorizationServer !== undefined,
        'consent stored no authorization server, so disconnect could never revoke',
      )
      const registrations = await rawRegistrations()
      assert.equal(registrations.length, 1, 'DCR did not leave exactly one client registration')

      agentSessionId = await createSession('agent', agent.anchorPath, toolPrompt(OAUTH_SERVER))
      await assertEchoed(agentSessionId, OAUTH_SERVER)
    },

    'static-token-tools': async () => {
      progress('mcp-servers:static-token')
      // The fixture has exactly one MCP endpoint and it authenticates only
      // tokens it minted itself, so the pasted token is the access token the
      // consent above produced. That is the shape of the branch under test —
      // a credential the user brings, kept by Duet and attached per request —
      // and keeping it inside the fixture is what makes the leg hermetic.
      const borrowed = await credentialForServer(OAUTH_SERVER)
      const added = await addServer({
        name: STATIC_SERVER,
        url: fakeMcpUrl,
        auth: { kind: 'static', token: borrowed.accessToken },
      })
      assert.equal(added.state, 'ready', 'a static-token server was not immediately ready')
      assert(
        (added.toolCount ?? 0) >= 3,
        `static probe measured ${String(added.toolCount)} tools on the fake MCP endpoint`,
      )
      // The paste goes to the credential table and never comes back out.
      const listed = await listServers()
      assert(
        !JSON.stringify(listed).includes(borrowed.accessToken),
        'the servers list echoed a pasted token back',
      )
      const stored = await credentialForServer(STATIC_SERVER)
      assert.equal(stored.kind, 'static', 'a pasted token was not stored as a static credential')

      await sendTurn(agentSessionId, toolPrompt(STATIC_SERVER))
      await assertEchoed(agentSessionId, STATIC_SERVER)
    },

    'agent-policy': async () => {
      progress('mcp-servers:agent-policy')
      rootSessionId = await createSession(
        'root',
        undefined,
        'Reply exactly "root" and do not call tools.',
      )
      // Every agent, before anything is chosen: the third state is the absence
      // of a row, so both principals see the server.
      assert(
        (await launchNames(rootSessionId)).includes(OAUTH_SERVER),
        'an unscoped server was withheld from the default agent',
      )

      // Driven through the panel rather than the endpoint: the editor is the
      // only place a human expresses this, and a policy the UI cannot write is
      // a policy nobody sets.
      await openIntegrationsPanel()
      await setAgentAccessCheckbox(INTEGRATION_AGENT_ACCESS_ALL_LABEL, false)
      await setAgentAccessCheckbox(agentName, true)
      const scoped = await serverByName(OAUTH_SERVER)
      assert.deepEqual(scoped.allowedAgentIds, [agent.id], 'the panel did not save the policy')

      const rootLaunchNames = await launchNames(rootSessionId)
      const agentLaunchNames = await launchNames(agentSessionId)
      assert(
        !rootLaunchNames.includes(OAUTH_SERVER),
        'a denied principal still received the scoped server',
      )
      assert(
        agentLaunchNames.includes(OAUTH_SERVER),
        'the allowed agent lost the server it was granted',
      )
      // The unscoped server is the control: the policy must move one row, not
      // the workspace.
      assert(
        rootLaunchNames.includes(STATIC_SERVER),
        'scoping one server withheld an unrelated one',
      )

      await setAgentAccessCheckbox(INTEGRATION_AGENT_ACCESS_ALL_LABEL, true)
      const cleared = await serverByName(OAUTH_SERVER)
      assert.equal(
        cleared.allowedAgentIds,
        undefined,
        'clearing to All wrote an empty list, which means nobody',
      )
      agentPolicy = {
        allowedAgentIds: [agent.id],
        rootLaunchNames,
        agentLaunchNames,
        clearedToAll: true,
      }
    },

    /**
     * D17, and the difference between a typo costing a tool and a typo locking
     * a user out of their own agent.
     *
     * The row is seeded through Convex rather than added over HTTP on purpose:
     * `POST /mcp-servers` probes first and refuses a server it cannot reach, so
     * a broken row can only ever come from a server that WORKED once and later
     * moved, died, or was firewalled. That is exactly the state being
     * reproduced, and the assertions below are all about the turn path.
     */
    'broken-url-degrades': async () => {
      progress('mcp-servers:broken-url')
      const user = (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: env.internalKey,
        email,
      })) as { _id: string } | null
      assert(user !== null, 'journey owner disappeared before the degradation leg')
      await convex.mutation(fnMutation('domains/mcpServers/model:registerMcpServer'), {
        internalKey: env.internalKey,
        workspaceId: workspace._id,
        actorId: user._id,
        name: BROKEN_SERVER,
        // Inside the fixture's mount, so it resolves, is public, is HTTPS, and
        // answers — with a 404 that is not MCP. A server that moved.
        url: `${issuerUrl}/mcp-moved-away`,
        authKind: 'none',
        now: Date.now(),
      })
      recordServerCleanup(BROKEN_SERVER)
      assert(
        (await launchNames(agentSessionId)).includes(BROKEN_SERVER),
        'a broken server was filtered out before the runner could fail on it',
      )

      const before = await loadSessionSnapshot(env, workspace.slug, agentSessionId, apiToken)
      // Dispatch is not refused: this is a 202, not a readiness verdict, and no
      // `SessionSubmissionResult` kind exists for a custom server.
      const accepted = SessionInputResponseSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${agentSessionId}/messages`,
          {
            method: 'POST',
            headers: bearerJson(apiToken),
            body: JSON.stringify({
              behavior: 'steer',
              prompt: 'Reply exactly "degraded" and do not call tools.',
            }),
            signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
          },
          202,
          'mcp servers degraded turn',
          artifacts,
        ),
      )
      assert.equal(accepted.delivery, 'accepted', 'a broken MCP server queued the turn')
      await waitForTurn(agentSessionId, before.lastEventSeq, before.lastDeliveredInputSeq)

      // The only channel this failure has. Without it the server is invisible:
      // the runner warns it away and the turn goes on.
      const health = await waitForHealth(
        BROKEN_SERVER,
        server => server.lastErrorCode !== undefined,
        'a broken server recorded no health error',
      )
      const healthErrorCode = health.lastErrorCode
      assert(healthErrorCode !== undefined, 'a broken server recorded no health error')
      assert(health.lastSuccessAt === undefined, 'a server that never answered recorded a success')
      degraded = {
        dispatchRefused: false,
        turnCompleted: true,
        healthErrorCode,
        everSucceeded: false,
      }
    },

    'oversized-result-capped': async () => {
      progress('mcp-servers:oversized-result')
      const oversized = namespacedToolName(OAUTH_SERVER, FAKE_MCP_OVERSIZED_TOOL)
      // Straight down the byte path the runner uses, so the cap is measured
      // rather than inferred from a turn's rendering of it.
      const result = await proxyToolCall(OAUTH_SERVER, FAKE_MCP_OVERSIZED_TOOL, {})
      assert.equal(
        result.structuredContent,
        undefined,
        'the cap kept the duplicated half instead of dropping it first',
      )
      // Dropping the structured half is not free: a server sends it because it
      // declared an `outputSchema`, and an SDK client refuses a schema-bearing
      // result that arrives without one unless it is flagged. Unflagged, this
      // very call came back to the model as `MCP error -32600` and no document
      // at all.
      assert.equal(result.isError, true, 'a result missing its structured half was not flagged')
      const text = firstTextPart(result)
      assert(
        text.includes(`of ${FAKE_MCP_OVERSIZED_BYTES} bytes`),
        'the truncation marker did not name the original size',
      )
      const cappedResultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
      assert(
        cappedResultBytes < FAKE_MCP_OVERSIZED_BYTES,
        `capped result was ${cappedResultBytes} bytes, no smaller than the original`,
      )
      await waitForHealth(
        OAUTH_SERVER,
        server => server.lastErrorCode === 'result_too_large',
        'a capped result was not recorded as health',
      )

      await sendTurn(
        agentSessionId,
        `Call the ${oversized} tool with no arguments. Do not summarize its output. ` +
          'Then reply exactly "capped".',
      )
      // A successful call carrying a shortened document, which is the whole
      // point of capping. The wire result is flagged so a schema-bearing
      // client accepts it at all; the runner reports the call by whether it
      // answered, so the model reads the prose and the marker rather than a
      // protocol failure.
      const history = await assertToolCalled(agentSessionId, oversized)
      assert(
        toolOutputText(history, oversized).includes('truncated'),
        'the truncation marker never reached the timeline',
      )
      cap = { originalBytes: FAKE_MCP_OVERSIZED_BYTES, cappedResultBytes, markerInTimeline: true }
    },

    'refresh-lease': async () => {
      progress('mcp-servers:refresh-lease')
      const current = await credentialForServer(OAUTH_SERVER)
      // Expiry is forced through the credential's own owner under its own CAS,
      // so the row stays internally consistent and the lease is exercised for
      // the reason it exists rather than through a back door.
      const forced = (await convex.mutation(
        fnMutation('domains/mcpServers/credentials:storeMcpServerCredential'),
        {
          internalKey: env.internalKey,
          workspaceId: workspace._id,
          serverId: current.serverId,
          expectedGeneration: current.generation,
          kind: current.kind,
          accessToken: current.accessToken,
          tokenType: current.tokenType,
          accessExpiresAt: Date.now() - 1_000,
          ...(current.refreshToken === undefined ? {} : { refreshToken: current.refreshToken }),
          ...(current.scope === undefined ? {} : { scope: current.scope }),
          ...(current.registrationId === undefined
            ? {}
            : { registrationId: current.registrationId }),
          ...(current.resource === undefined ? {} : { resource: current.resource }),
          ...(current.authorizationServer === undefined
            ? {}
            : { authorizationServer: current.authorizationServer }),
          now: Date.now(),
        },
      )) as { status: string; generation: number }
      assert.equal(forced.status, 'stored', 'forcing expiry lost a compare-and-swap')

      const [first, second] = await Promise.all([
        proxyToolCall(OAUTH_SERVER, 'echo', { message: 'lease-a' }),
        proxyToolCall(OAUTH_SERVER, 'echo', { message: 'lease-b' }),
      ])
      assert(firstTextPart(first).includes('lease-a'), 'the first concurrent call lost its answer')
      assert(
        firstTextPart(second).includes('lease-b'),
        'the second concurrent call lost its answer',
      )

      const after = await credentialForServer(OAUTH_SERVER)
      // Generation, never token equality: the fixture rotates the refresh token
      // on every OTHER refresh, so an unchanged value proves nothing at all.
      assert.equal(
        after.generation,
        forced.generation + 1,
        `two concurrent calls refreshed ${after.generation - forced.generation} times`,
      )
      assert((after.accessExpiresAt ?? 0) > Date.now(), 'the refreshed credential is still expired')
      refresh = {
        forcedGeneration: forced.generation,
        generationAfterConcurrentCalls: after.generation,
      }
    },

    'disconnect-revokes': async () => {
      progress('mcp-servers:disconnect')
      const serverId = (await credentialForServer(OAUTH_SERVER)).serverId
      removal = RemoveMcpServerResponseSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/ws/${workspace.slug}/mcp-servers/${OAUTH_SERVER}`,
          { method: 'DELETE', headers: bearer(apiToken) },
          200,
          'mcp servers disconnect',
          artifacts,
        ),
      )
      assert.equal(removal.name, OAUTH_SERVER)
      assert.equal(removal.removed, true, 'disconnect left the server behind')
      // What Duet ATTEMPTED. RFC 7009 §2.2 makes a 200 mandatory for a token
      // the authorization server does not recognize, and this fixture is
      // stateless — so a `revoked` here means a well-formed request was issued
      // and accepted, and nothing whatever about the grant upstream.
      assert.equal(removal.revoked, 'revoked', 'disconnect issued no accepted revocation')

      assert(
        !(await rawServers()).some(row => row.name === OAUTH_SERVER),
        'the server row survived its own removal',
      )
      assert(
        !(await rawCredentials()).some(row => row.serverId === serverId),
        'the credential row survived, whatever the authorization server answered',
      )
      const registrations = await rawRegistrations()
      if (removal.registration === 'deleted') {
        assert.equal(registrations.length, 0, 'a deleted registration kept its row')
      } else {
        // Retained is one value for two situations, and in both the row must
        // survive WITH its reason: a later connect reuses it, a later
        // disconnect retries the delete.
        assert.equal(removal.registration, 'retained', 'unexpected registration cleanup verdict')
        assert.equal(registrations.length, 1, 'a retained registration lost its row')
        assert(
          registrations[0]?.deleteFailedAt !== undefined,
          'a registration was retained without recording why',
        )
      }
      // The static server borrowed a copy of the same grant, and a stateless
      // fixture forgets nothing: removal must not have reached across to it.
      assert(
        (await rawServers()).some(row => row.name === STATIC_SERVER),
        'removing one server removed another',
      )
    },

    'artifact-cleanup': async () => {
      progress('mcp-servers:artifact-cleanup')
      await artifacts.writeJson('mcp-servers.json', {
        passedLegs,
        servers: [OAUTH_SERVER, STATIC_SERVER, BROKEN_SERVER],
        calledTools,
        removal,
      })
      await artifacts.flushDiagnostics()
      await assertNoCredentialArtifacts(artifacts.directory)
    },
  }

  for (const leg of MCP_SERVERS_STAGING_LEGS) {
    await actions[leg]()
    passedLegs.push(leg)
  }

  assert(agentPolicy !== undefined, 'agent policy leg produced no evidence')
  assert(degraded !== undefined, 'degradation leg produced no evidence')
  assert(cap !== undefined, 'cap leg produced no evidence')
  assert(refresh !== undefined, 'refresh leg produced no evidence')
  assert(removal !== undefined, 'disconnect leg produced no evidence')
  return { passedLegs, calledTools, agentPolicy, degraded, cap, removal, refresh }

  // ---------------------------------------------------------------- servers

  async function addServer(input: {
    name: string
    url: string
    auth: { kind: 'none' } | { kind: 'oauth' } | { kind: 'static'; token: string }
  }): Promise<McpServer> {
    const added = McpServerSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/mcp-servers`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify(input),
        },
        201,
        `mcp servers add ${input.name}`,
        artifacts,
      ),
    )
    recordServerCleanup(input.name)
    return added
  }

  function recordServerCleanup(name: string): void {
    ledger.record({
      kind: 'integration',
      id: `mcp-server:${name}`,
      label: `${runId}:mcp-server:${name}`,
      cleanup: async () => {
        // Idempotent by construction: a name already removed answers
        // `removed: false` rather than failing.
        await apiJson(
          `${env.apiUrl}/v1/ws/${workspace.slug}/mcp-servers/${name}`,
          { method: 'DELETE', headers: bearer(apiToken) },
          200,
          `mcp servers cleanup ${name}`,
        )
      },
      verify: async () => {
        if (await workspaceIsDeleted(convex, env.internalKey, workspace._id)) return true
        return !(await rawServers()).some(row => row.name === name)
      },
    })
  }

  async function listServers(): Promise<McpServer[]> {
    return McpServerListSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/mcp-servers`,
        { headers: bearer(apiToken) },
        200,
        'mcp servers list',
        artifacts,
      ),
    ).items
  }

  async function serverByName(name: string): Promise<McpServer> {
    const server = (await listServers()).find(row => row.name === name)
    assert(server !== undefined, `custom MCP server ${name} was absent from the list`)
    return server
  }

  async function waitForHealth(
    name: string,
    predicate: (server: McpServer) => boolean,
    failure: string,
  ): Promise<McpServer> {
    const deadline = Date.now() + HEALTH_WAIT_MS
    for (;;) {
      const server = await serverByName(name)
      if (predicate(server)) return server
      if (Date.now() >= deadline) {
        throw new Error(
          `${failure}: ${JSON.stringify({
            state: server.state,
            lastErrorCode: server.lastErrorCode,
            lastErrorAt: server.lastErrorAt,
            lastSuccessAt: server.lastSuccessAt,
          })}`,
        )
      }
      await Bun.sleep(1_000)
    }
  }

  // ------------------------------------------------------------ convex rows

  async function rawServers(): Promise<McpServerRow[]> {
    return (await convex.query(fnQuery('testing/mcpServers:rawServersForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    })) as McpServerRow[]
  }

  async function rawCredentials(): Promise<McpCredentialRow[]> {
    return (await convex.query(fnQuery('testing/mcpServers:rawCredentialsForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    })) as McpCredentialRow[]
  }

  async function rawRegistrations(): Promise<McpRegistrationRow[]> {
    return (await convex.query(fnQuery('testing/mcpServers:rawRegistrationsForTest'), {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    })) as McpRegistrationRow[]
  }

  /**
   * The stored credential for one server.
   *
   * It carries live third-party token material, so it never reaches an
   * artifact, an evidence field, or an assertion message — only `generation`
   * and the shape do.
   */
  async function credentialForServer(name: string): Promise<McpCredentialRow> {
    const server = (await rawServers()).find(row => row.name === name)
    assert(server !== undefined, `custom MCP server ${name} had no row`)
    const credential = (await rawCredentials()).find(row => row.serverId === server._id)
    assert(credential !== undefined, `custom MCP server ${name} had no credential`)
    return credential
  }

  // -------------------------------------------------------------- byte path

  /**
   * The runner's own route, called with the workspace's own key. The upstream
   * URL and the third-party token stay on this side of it — which is the
   * property the whole proxy exists for.
   */
  async function proxyToolCall(
    name: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await timedFetch(
      `${env.apiUrl}/v1/ws/${workspace.slug}/mcp/${name}`,
      {
        method: 'POST',
        headers: bearer(apiToken, {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${name}-${tool}-${crypto.randomUUID().slice(0, 8)}`,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      },
      artifacts,
    )
    assert.equal(response.status, 200, `proxied ${name}/${tool} returned HTTP ${response.status}`)
    const rpc = parseMcpJsonRpcResponse(await response.text())
    assert(rpc.error === undefined, `proxied ${name}/${tool} returned a JSON-RPC error`)
    assert(rpc.result !== undefined, `proxied ${name}/${tool} omitted its result`)
    return rpc.result
  }

  // --------------------------------------------------------------- browser

  async function openIntegrationsPanel(): Promise<void> {
    markExpectedBrowserTransition(page)
    await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/integrations`)
    await page.locator('[data-mcp-servers-panel]').waitFor()
  }

  /**
   * D2 under a human's click, all the way through a third party's consent page.
   *
   * The Connect button only renders for a server waiting on a human, so exactly
   * one exists here — asserted rather than assumed, because a second would make
   * the click ambiguous.
   */
  async function approveConsentInBrowser(): Promise<void> {
    await openIntegrationsPanel()
    const panel = page.locator('[data-mcp-servers-panel]')
    const connect = panel.getByRole('button', { name: 'Connect', exact: true })
    try {
      await connect.first().waitFor()
    } catch (error) {
      // A locator that matched nothing and one that matched something
      // invisible time out with the same message, so record which it was
      // before rethrowing. Text present with no role behind it means the DOM
      // has the control and the accessibility tree does not — the signature of
      // an open modal, which the screenshot then names. Without this pair the
      // next run is another guess, and each guess costs real staging
      // resources.
      await page
        .screenshot({ path: `${artifacts.directory}/consent-panel.png`, fullPage: true })
        .catch(() => undefined)
      await artifacts.writeJson('consent-panel-diagnostic.json', {
        panelText: await panel.innerText().catch(() => '(panel not readable)'),
        connectByRole: await connect.count().catch(() => -1),
        connectByText: await panel
          .getByText('Connect', { exact: true })
          .count()
          .catch(() => -1),
        listedByApi: await listServers().catch(returned => `(list failed: ${String(returned)})`),
        url: page.url(),
      })
      throw error
    }
    assert.equal(await connect.count(), 1, 'more than one server was waiting to be connected')
    markExpectedBrowserTransition(page)
    await connect.click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS })

    await page.waitForURL(url => url.pathname.endsWith('/oauth-issuer/authorize'), {
      timeout: BROWSER_TRANSITION_TIMEOUT_MS,
    })
    markExpectedBrowserTransition(page)
    await page
      .locator('#fake-issuer-approve')
      .click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS })
    // Back through Duet's callback, which validates RFC 9207's `iss`, exchanges
    // the code, and only then sends the browser to a Duet path it re-derives.
    await page.waitForURL(url => url.pathname === `/w/${workspace.slug}/integrations`, {
      timeout: BROWSER_TRANSITION_TIMEOUT_MS,
    })
  }

  async function setAgentAccessCheckbox(label: string, checked: boolean): Promise<void> {
    const editor = page.locator(`[data-mcp-server-agent-access="${OAUTH_SERVER}"]`)
    const panel = page.locator(`[data-mcp-server-agent-access-panel="${OAUTH_SERVER}"]`)
    await openAgentAccessEditor(editor)
    const checkbox = panel.getByRole('checkbox', { name: label, exact: true })
    await waitForCheckboxEnabled(checkbox)
    assert.equal(
      await checkbox.isChecked(),
      !checked,
      `${label} was not in the state this toggle expects`,
    )
    const [response] = await Promise.all([
      page.waitForResponse(candidate => {
        const url = new URL(candidate.url())
        return (
          candidate.request().method() === 'PUT' &&
          url.pathname === `/api/duet/ws/${workspace.slug}/mcp-servers/${OAUTH_SERVER}/agent-policy`
        )
      }),
      checkbox.click(),
    ])
    assert.equal(response.status(), 200, `agent-access save returned ${response.status()}`)
    McpServerAgentPolicyResponseSchema.parse(await response.json())
    // The live query response can replace the popover's content underneath us.
    await openAgentAccessEditor(editor)
    await waitForCheckboxEnabled(checkbox)
    assert.equal(await checkbox.isChecked(), checked, `${label} did not settle as saved`)
  }

  async function openAgentAccessEditor(
    editor: ReturnType<WorkspaceBrowserJourneyContext['page']['locator']>,
  ): Promise<void> {
    await editor.waitFor()
    const trigger = editor.getByRole('button')
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click()
    }
  }

  async function waitForCheckboxEnabled(
    checkbox: ReturnType<WorkspaceBrowserJourneyContext['page']['getByRole']>,
  ): Promise<void> {
    const deadline = Date.now() + 30_000
    for (;;) {
      if (await checkbox.isEnabled()) return
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the agent-access editor')
      await Bun.sleep(100)
    }
  }

  // --------------------------------------------------------------- sessions

  /**
   * Which custom servers a session's next turn gets, from the one owner of that
   * question. The wake path asks this same query, so it is the projection
   * itself rather than a second derivation of it.
   */
  async function launchNames(sessionId: string): Promise<string[]> {
    const projected = (await convex.query(
      fnQuery('domains/mcpServers/turnConfig:projectMcpServersForSession'),
      {
        internalKey: env.internalKey,
        workspaceId: workspace._id,
        duetSessionId: sessionId,
      },
    )) as Array<{ name: string }> | null
    return (projected ?? []).map(entry => entry.name)
  }

  /**
   * What the fake server will echo back if the call really left the VM, went
   * through the proxy, and was answered by the third party — short on purpose,
   * because the model has to reproduce it exactly.
   */
  function echoSentinel(server: string): string {
    return `${server}-${runId.slice(-6)}`
  }

  function toolPrompt(server: string): string {
    return (
      `Call the ${namespacedToolName(server, 'echo')} tool with the message ` +
      `"${echoSentinel(server)}", then reply exactly "called".`
    )
  }

  async function createSession(
    label: string,
    cwd: string | undefined,
    prompt: string,
  ): Promise<string> {
    const response = SessionCreateResponseSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({ prompt, ...(cwd === undefined ? {} : { cwd }) }),
          signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        },
        201,
        `mcp servers ${label} session create`,
        artifacts,
      ),
    )
    assert.equal(response.delivery, 'accepted', `mcp servers ${label} session was queued`)
    const sessionId = response.session.sessionId
    ledger.record({
      kind: 'session',
      id: sessionId,
      label: `${runId}:mcp-servers-session:${label}:${sessionId}`,
      cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
    })
    await waitForSessionSnapshot(
      env,
      workspace.slug,
      sessionId,
      apiToken,
      snapshot =>
        snapshot.lastEventSeq > response.session.lastEventSeq &&
        isTerminalStatus(snapshot.turnStatus),
      TURN_TIMEOUT_MS,
    )
    return sessionId
  }

  async function sendTurn(sessionId: string, prompt: string): Promise<void> {
    const before = await loadSessionSnapshot(env, workspace.slug, sessionId, apiToken)
    const response = SessionInputResponseSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({ behavior: 'steer', prompt }),
          signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        },
        202,
        'mcp servers turn',
        artifacts,
      ),
    )
    assert.equal(response.delivery, 'accepted', 'mcp servers turn was queued')
    await waitForTurn(sessionId, before.lastEventSeq, before.lastDeliveredInputSeq)
  }

  async function waitForTurn(
    sessionId: string,
    afterEventSeq: number,
    afterInputSeq: number,
  ): Promise<void> {
    await waitForSessionSnapshot(
      env,
      workspace.slug,
      sessionId,
      apiToken,
      snapshot =>
        snapshot.lastEventSeq > afterEventSeq &&
        snapshot.lastDeliveredInputSeq > afterInputSeq &&
        isTerminalStatus(snapshot.turnStatus),
      TURN_TIMEOUT_MS,
    )
  }

  async function assertToolCalled(
    sessionId: string,
    toolName: string,
  ): Promise<ChronologicalSessionHistory> {
    const history = await waitForSessionHistory(
      env,
      workspace.slug,
      sessionId,
      apiToken,
      candidate => hasSuccessfulToolCall(candidate, toolName),
      TURN_TIMEOUT_MS,
    )
    calledTools.push(toolName)
    return history
  }

  /** The tool answered, and its answer is the third party's own bytes. */
  async function assertEchoed(sessionId: string, server: string): Promise<void> {
    const toolName = namespacedToolName(server, 'echo')
    const history = await assertToolCalled(sessionId, toolName)
    assert(
      toolOutputText(history, toolName).includes(`echo: ${echoSentinel(server)}`),
      `${toolName} answered without the message it was given`,
    )
  }
}

/**
 * A namespaced tool the model actually called, and that actually answered.
 *
 * The name is the whole assertion: the runner joins the SERVER's name to the
 * tool with `__`, so `fakeoauth__echo` in a turn's timeline is proof that the
 * launch marker carried that server, the gateway turned its name into a Duet
 * URL, the proxy attached a credential the VM never saw, and bytes came back.
 */
export function hasSuccessfulToolCall(
  history: ChronologicalSessionHistory,
  toolName: string,
): boolean {
  return history.events.some(row => {
    if (!isKnownTimelineEvent(row.event) || row.event.type !== 'step') return false
    const step = row.event.step
    return step.type === 'tool_call' && step.toolName === toolName && !step.isError
  })
}

function toolOutputText(history: ChronologicalSessionHistory, toolName: string): string {
  const texts: string[] = []
  for (const row of history.events) {
    if (!isKnownTimelineEvent(row.event) || row.event.type !== 'step') continue
    const step = row.event.step
    if (step.type !== 'tool_call' || step.toolName !== toolName) continue
    for (const item of step.output ?? []) {
      if (item.type === 'text') texts.push(item.text)
    }
  }
  return texts.join('\n')
}

function firstTextPart(result: Record<string, unknown>): string {
  const content = result.content
  assert(Array.isArray(content) && content.length > 0, 'MCP tool result carried no content')
  const part = content[0] as { type?: unknown; text?: unknown }
  assert(part.type === 'text' && typeof part.text === 'string', 'MCP tool result had no text part')
  return part.text
}

function isTerminalStatus(status: string): boolean {
  return AGENT_TERMINAL_STATES.some(terminal => terminal === status)
}
