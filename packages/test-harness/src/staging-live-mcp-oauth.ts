import assert from 'node:assert/strict'

import type { Page } from '@playwright/test'
import type { ConvexHttpClient } from 'convex/browser'

import {
  AuthorizationServerMetadataSchema,
  CAPABILITIES,
  DynamicClientRegistrationResponseSchema,
  OAuthConsentInspectResponseSchema,
  OAuthTokenErrorResponseSchema,
  OAuthTokenResponseSchema,
  ProtectedResourceMetadataSchema,
  WhoamiResponseSchema,
  hashApiKey,
  serializeScope,
  type OAuthTokenResponse,
} from '@repo/contract'

import {
  assertNoCredentialArtifacts,
  type StagingArtifactCollector,
} from './staging-live-artifacts.ts'
import { waitForFinishedBrowserResponse } from './staging-live-browser-response.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { runHumanDeviceLogin } from './staging-live-device.ts'
import { fnMutation, fnQuery, type Workspace } from './staging-live-env.ts'
import { bearer, stagingFetch, timedFetch } from './staging-live-http.ts'
import { runMcpFileResourceAcceptance } from './staging-live-mcp-file-resources.ts'
import type { StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  readWorkspaceBrowserEnv,
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserEnv,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const BROWSER_TRANSITION_TIMEOUT_MS = 60_000

export const MCP_OAUTH_STAGING_LEGS = [
  'discovery',
  'dcr-authorization',
  'mcp-tools',
  'file-resources',
  'refresh-family',
  'settings-revoke',
  'audience-and-root',
] as const

type McpOAuthLeg = (typeof MCP_OAUTH_STAGING_LEGS)[number]

export interface McpOAuthJourneyEnv extends WorkspaceBrowserEnv {
  mcpUrl: string
}

export interface McpOAuthAcceptanceResult {
  passedLegs: McpOAuthLeg[]
  dcrClient: string
}

interface OAuthRunState {
  clientIds: string[]
  grants: Array<{ id: string; clientId: string }>
  keyIds: string[]
  refreshTokenIds: string[]
  requestIds: string[]
  codeIds: string[]
}

interface AuthorizedClient {
  clientId: string
  clientName: string
  redirectUri: string
  verifier: string
  code: string
}

interface McpOAuthContext {
  env: McpOAuthJourneyEnv
  page: Page
  workspace: Workspace
  email: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress(stage: string): void
}

export function readMcpOAuthJourneyEnv(
  source: NodeJS.ProcessEnv = process.env,
): McpOAuthJourneyEnv {
  const env = readWorkspaceBrowserEnv(source)
  const mcpUrl = requiredUrl(source, 'DUET_MCP_PUBLIC_URL')
  if (!mcpUrl.hostname.includes('staging')) {
    throw new Error('DUET_MCP_PUBLIC_URL must target a staging hostname')
  }
  if (
    mcpUrl.protocol !== 'https:' ||
    mcpUrl.username !== '' ||
    mcpUrl.password !== '' ||
    !['', '/'].includes(mcpUrl.pathname) ||
    mcpUrl.search !== '' ||
    mcpUrl.hash !== ''
  ) {
    throw new Error('DUET_MCP_PUBLIC_URL must be an HTTPS origin')
  }

  return {
    ...env,
    mcpUrl: `${mcpUrl.origin}/`,
  }
}

function requiredUrl(source: NodeJS.ProcessEnv, name: string): URL {
  const value = source[name]?.trim()
  if (!value) throw new Error(`Missing required MCP OAuth journey env: ${name}`)
  try {
    return new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }
}

export function parseBearerChallenge(value: string | null): Record<string, string> {
  if (value === null || !value.startsWith('Bearer ')) {
    throw new Error('Missing parseable Bearer challenge')
  }
  const parameters: Record<string, string> = {}
  for (const match of value
    .slice('Bearer '.length)
    .matchAll(/(?:^|,\s*)([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g)) {
    parameters[match[1]!] = match[2]!
  }
  if (Object.keys(parameters).length === 0) {
    throw new Error('Missing parseable Bearer challenge parameters')
  }
  return parameters
}

export function parseMcpJsonRpcResponse(text: string): {
  jsonrpc: '2.0'
  id: string | number | null
  result?: Record<string, unknown>
  error?: Record<string, unknown>
} {
  const candidates = [
    text.trim(),
    ...text
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice('data: '.length).trim()),
  ]
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>
      if (
        value.jsonrpc === '2.0' &&
        (typeof value.id === 'string' || typeof value.id === 'number' || value.id === null) &&
        (isRecord(value.result) || isRecord(value.error))
      ) {
        return {
          jsonrpc: '2.0',
          id: value.id,
          ...(isRecord(value.result) ? { result: value.result } : {}),
          ...(isRecord(value.error) ? { error: value.error } : {}),
        }
      }
    } catch {
      // Try the next JSON body or SSE data frame.
    }
  }
  throw new Error('MCP response did not contain a parseable JSON-RPC result')
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}

export async function runMcpOAuthSequence(args: {
  actions: Record<McpOAuthLeg, () => Promise<void>>
  pass(leg: McpOAuthLeg): void
  cleanup(): Promise<void>
}): Promise<void> {
  try {
    for (const leg of MCP_OAUTH_STAGING_LEGS) {
      await args.actions[leg]()
      args.pass(leg)
    }
  } finally {
    await args.cleanup()
  }
}

export async function runMcpOAuthAcceptance(
  context: McpOAuthContext,
): Promise<McpOAuthAcceptanceResult> {
  const { env, page, workspace, email, runId, ledger, convex, artifacts, progress } = context
  const passedLegs: McpOAuthLeg[] = []
  const clientIds: string[] = []
  let dcr: AuthorizedClient | undefined
  let dcrInitial: OAuthTokenResponse | undefined

  const cleanupOauthRun = async () => {
    await convex.mutation(fnMutation('testing/stagingE2e:cleanupOauthRunForTest'), {
      internalKey: env.internalKey,
      email,
      clientIds,
    })
  }
  const loadOauthRun = async (): Promise<OAuthRunState> =>
    (await convex.query(fnQuery('testing/stagingE2e:oauthRunResourcesForTest'), {
      internalKey: env.internalKey,
      email,
      clientIds,
    })) as OAuthRunState
  ledger.record({
    kind: 'integration',
    id: `${runId}:oauth-graph`,
    label: `${runId}:oauth-graph`,
    cleanup: cleanupOauthRun,
    verify: async () => {
      const state = await loadOauthRun()
      return (
        state.clientIds.length === 0 &&
        state.grants.length === 0 &&
        state.keyIds.length === 0 &&
        state.refreshTokenIds.length === 0 &&
        state.requestIds.length === 0 &&
        state.codeIds.length === 0
      )
    },
  })

  await runMcpOAuthSequence({
    pass: leg => passedLegs.push(leg),
    cleanup: async () => {
      await artifacts.writeJson('mcp-oauth.json', {
        passedLegs,
        clients: { dcr: dcr?.clientId },
      })
      await artifacts.flushDiagnostics()
      await assertNoCredentialArtifacts(artifacts.directory)
    },
    actions: {
      discovery: async () => {
        progress('mcp-oauth:discovery')
        const root = await timedFetch(
          env.mcpUrl,
          {
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'duet-staging-e2e', version: '1' },
              },
            }),
          },
          artifacts,
        )
        assert.equal(root.status, 401, 'unauthenticated MCP root did not challenge')
        const challenge = parseBearerChallenge(root.headers.get('www-authenticate'))
        const prmUrl = challenge.resource_metadata
        assert(prmUrl !== undefined, 'MCP challenge omitted resource_metadata')
        const prmResponse = await timedFetch(prmUrl, {}, artifacts)
        assert.equal(prmResponse.status, 200, 'MCP protected-resource metadata failed')
        const prm = ProtectedResourceMetadataSchema.parse(await prmResponse.json())
        assert.equal(prm.resource, env.mcpUrl)
        const issuer = prm.authorization_servers[0]
        assert(issuer !== undefined, 'MCP PRM omitted its authorization server')
        const asResponse = await timedFetch(
          new URL('/.well-known/oauth-authorization-server', issuer).toString(),
          {},
          artifacts,
        )
        assert.equal(asResponse.status, 200, 'authorization-server metadata failed')
        const metadata = AuthorizationServerMetadataSchema.parse(await asResponse.json())
        assert.equal(metadata.issuer, env.apiUrl)
        assert(metadata.protected_resources.includes(env.mcpUrl))
      },

      'dcr-authorization': async () => {
        progress('mcp-oauth:dcr-authorization')
        const redirectUri = `${env.mcpUrl}oauth/callback/${encodeURIComponent(runId)}`
        const registration = await timedFetch(
          `${env.apiUrl}/oauth/register`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: 'none',
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              client_name: `Duet staging DCR ${runId}`,
              scope: CAPABILITIES.join(' '),
            }),
          },
          artifacts,
        )
        assert.equal(registration.status, 201, 'DCR client registration failed')
        const registered = DynamicClientRegistrationResponseSchema.parse(await registration.json())
        clientIds.push(registered.client_id)
        recordClientCleanup(registered.client_id, 'dcr')
        dcr = await authorizeClient({
          env,
          page,
          workspace,
          clientId: registered.client_id,
          expectedClientName: registered.client_name,
          redirectUri,
          runId,
          label: 'dcr',
          artifacts,
        })
        dcrInitial = await exchangeCode(env, dcr, artifacts)
        await assertOAuthAccess(env, dcrInitial, workspace, email, artifacts)
        await recordTokenPair(dcrInitial, registered.client_id)
        await recordGrant(registered.client_id)
      },

      'mcp-tools': async () => {
        progress('mcp-oauth:mcp-tools')
        assert(dcrInitial !== undefined, 'DCR token was not available for MCP tools')
        const restResult = await callMcpTool({
          env,
          token: dcrInitial.access_token,
          name: 'list_files',
          input: { workspace: workspace.slug },
          id: 10,
          artifacts,
        })
        assert.notEqual(restResult.isError, true, 'REST-backed MCP tool returned an error')
        const gatewayResult = await callMcpTool({
          env,
          token: dcrInitial.access_token,
          name: 'generate_media',
          input: {
            workspace: workspace.slug,
            kind: 'image',
            prompt: `A tiny monochrome circle, staging acceptance ${runId}`,
          },
          id: 11,
          artifacts,
        })
        assert.notEqual(gatewayResult.isError, true, 'gateway-backed MCP tool returned an error')
      },

      'file-resources': async () => {
        progress('mcp-oauth:file-resources')
        assert(dcrInitial !== undefined, 'DCR token was not available for file resources')
        const oauthRun = await loadOauthRun()
        assert.equal(oauthRun.keyIds.length, 1, 'file-resource leg did not have one OAuth key')
        const oauthKeyId = oauthRun.keyIds[0]
        assert(oauthKeyId !== undefined, 'file-resource leg omitted its OAuth key id')
        await runMcpFileResourceAcceptance({
          apiUrl: env.apiUrl,
          mcpUrl: env.mcpUrl,
          workspace: workspace.slug,
          token: dcrInitial.access_token,
          expectedActor: `api-key:${oauthKeyId}`,
          runId,
          artifacts,
        })
      },

      'refresh-family': async () => {
        progress('mcp-oauth:refresh-family')
        assert(dcr !== undefined && dcrInitial !== undefined, 'DCR grant was not initialized')
        const firstSuccessor = await rotateRefresh(env, dcr.clientId, dcrInitial.refresh_token)
        await recordTokenPair(firstSuccessor, dcr.clientId)
        const graceReplacement = await rotateRefresh(env, dcr.clientId, dcrInitial.refresh_token)
        await recordTokenPair(graceReplacement, dcr.clientId)
        await assertMcpRejected(env, firstSuccessor.access_token, artifacts)

        const generationThree = await rotateRefresh(
          env,
          dcr.clientId,
          graceReplacement.refresh_token,
        )
        await recordTokenPair(generationThree, dcr.clientId)
        await expectInvalidRefresh(env, dcr.clientId, dcrInitial.refresh_token)
        await assertMcpRejected(env, generationThree.access_token, artifacts)
        await expectInvalidRefresh(env, dcr.clientId, generationThree.refresh_token)
      },

      'settings-revoke': async () => {
        progress('mcp-oauth:settings-revoke')
        // Revocation must prove a LIVE grant dies at the user's hand. The DCR
        // grant from dcr-authorization is deliberately destroyed by the
        // refresh-family leg's reuse detection, so this leg mints its own fresh
        // DCR grant to revoke through the settings UI.
        const redirectUri = `${env.mcpUrl}oauth/callback/${encodeURIComponent(runId)}-revoke`
        const registration = await timedFetch(
          `${env.apiUrl}/oauth/register`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: 'none',
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              client_name: `Duet staging revoke ${runId}`,
              scope: CAPABILITIES.join(' '),
            }),
          },
          artifacts,
        )
        assert.equal(registration.status, 201, 'revoke client registration failed')
        const registered = DynamicClientRegistrationResponseSchema.parse(await registration.json())
        clientIds.push(registered.client_id)
        recordClientCleanup(registered.client_id, 'dcr')
        const revoke = await authorizeClient({
          env,
          page,
          workspace,
          clientId: registered.client_id,
          expectedClientName: registered.client_name,
          redirectUri,
          runId,
          label: 'revoke',
          artifacts,
        })
        const revokeInitial = await exchangeCode(env, revoke, artifacts)
        await assertOAuthAccess(env, revokeInitial, workspace, email, artifacts)
        await recordTokenPair(revokeInitial, registered.client_id)
        await recordGrant(registered.client_id)

        const state = await loadOauthRun()
        const grant = state.grants.find(candidate => candidate.clientId === revoke.clientId)
        assert(grant !== undefined, 'revoke grant was absent from the cleanup graph')
        markExpectedBrowserTransition(page)
        await navigateDeployedPage(page, `${env.appUrl}/settings/api-keys`)
        const row = page.locator(`[data-fixture-id="connected-app-${grant.id}"]`)
        await row.getByText(revoke.clientName, { exact: true }).waitFor()
        const revokeResponse = waitForFinishedBrowserResponse(
          page,
          'DELETE',
          `/api/duet/user/oauth-grants/${encodeURIComponent(grant.id)}`,
        )
        await row
          .getByRole('button', {
            name: `Revoke connected app ${revoke.clientName}`,
            exact: true,
          })
          .click({ timeout: BROWSER_TRANSITION_TIMEOUT_MS })
        await revokeResponse
        await row.getByText('Revoked', { exact: true }).waitFor()
        await assertMcpRejected(env, revokeInitial.access_token, artifacts)
        await expectInvalidRefresh(env, revoke.clientId, revokeInitial.refresh_token)
      },

      'audience-and-root': async () => {
        progress('mcp-oauth:audience-and-root')
        const user = (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
          internalKey: env.internalKey,
          email,
        })) as { _id: string } | null
        assert(user !== null, 'synthetic MCP OAuth user disappeared')
        const wrongAudienceToken = `duet_sk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
        const wrongAudiencePrefix = wrongAudienceToken.slice(0, 'duet_sk_'.length + 8)
        await convex.mutation(fnMutation('testing/apiKeys:insertOAuthApiKeyForTest'), {
          internalKey: env.internalKey,
          userId: user._id,
          workspaceId: workspace._id,
          hashedKey: await hashApiKey(wrongAudienceToken),
          prefix: wrongAudiencePrefix,
          scopes: materializedScopes(workspace.slug),
          audience: 'https://wrong-audience-staging.duet.so/',
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
        recordAccessKey(wrongAudienceToken, wrongAudiencePrefix)
        await recordGrant('fixture-client')
        await assertMcpRejected(env, wrongAudienceToken, artifacts)

        const device = await runHumanDeviceLogin({
          env,
          page,
          workspace,
          email,
          runId,
          ledger,
          convex,
          artifacts,
        })
        const pastedKeyResult = await callMcpTool({
          env,
          token: device.accessToken,
          name: 'list_files',
          input: { workspace: workspace.slug },
          id: 12,
          artifacts,
        })
        assert.notEqual(
          pastedKeyResult.isError,
          true,
          'pasted phase-1 key did not work at MCP root',
        )

        const retired = await timedFetch(
          new URL('/mcp', env.mcpUrl).toString(),
          { method: 'POST' },
          artifacts,
        )
        assert.equal(retired.status, 404, 'retired /mcp path did not stay deleted')
        assert.equal(retired.headers.get('location'), null, 'retired /mcp path redirected')
      },
    },
  })

  return { passedLegs, dcrClient: dcr!.clientId }

  function recordClientCleanup(clientId: string, source: 'dcr'): void {
    ledger.record({
      kind: 'oauth-client',
      id: clientId,
      label: `${runId}:oauth-client:${source}`,
      cleanup: cleanupOauthRun,
      verify: async () => !(await loadOauthRun()).clientIds.includes(clientId),
    })
  }

  async function recordGrant(clientId: string): Promise<void> {
    const grant = (await loadOauthRun()).grants.find(candidate => candidate.clientId === clientId)
    assert(grant !== undefined, `OAuth grant for ${clientId} was not persisted`)
    ledger.record({
      kind: 'oauth-grant',
      id: grant.id,
      label: `${runId}:oauth-grant:${grant.id}`,
      cleanup: cleanupOauthRun,
      verify: async () =>
        !(await loadOauthRun()).grants.some(candidate => candidate.id === grant.id),
    })
  }

  async function recordTokenPair(pair: OAuthTokenResponse, clientId: string): Promise<void> {
    recordAccessKey(pair.access_token, pair.access_token.slice(0, 'duet_sk_'.length + 8))
    const refreshHash = await hashApiKey(pair.refresh_token)
    ledger.record({
      kind: 'oauth-refresh',
      id: refreshHash,
      label: `${runId}:oauth-refresh:${refreshHash.slice(0, 12)}`,
      cleanup: cleanupOauthRun,
      verify: async () => {
        const response = await tokenRequest(env, {
          grant_type: 'refresh_token',
          refresh_token: pair.refresh_token,
          client_id: clientId,
          resource: env.mcpUrl,
        })
        return response.status === 400
      },
    })
  }

  function recordAccessKey(token: string, prefix: string): void {
    ledger.record({
      kind: 'api-key',
      id: prefix,
      label: `${runId}:oauth-key:${prefix}`,
      cleanup: cleanupOauthRun,
      verify: async () =>
        (await timedFetch(`${env.apiUrl}/v1/whoami`, { headers: bearer(token) }, artifacts))
          .status === 401,
    })
  }
}

async function authorizeClient(args: {
  env: McpOAuthJourneyEnv
  page: Page
  workspace: Workspace
  clientId: string
  expectedClientName?: string
  redirectUri: string
  runId: string
  label: string
  artifacts: StagingArtifactCollector
}): Promise<AuthorizedClient> {
  const verifier = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
  const state = `${args.runId}-${args.label}`
  const authorize = new URL('/oauth/authorize', args.env.apiUrl)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: CAPABILITIES.join(' '),
    state,
    resource: args.env.mcpUrl,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString()
  const authorization = await timedFetch(
    authorize.toString(),
    { redirect: 'manual' },
    args.artifacts,
  )
  assert.equal(authorization.status, 302, `${args.label} authorization did not hand off`)
  const handoff = authorization.headers.get('location')
  assert(handoff !== null, `${args.label} authorization omitted consent handoff`)
  const handoffUrl = new URL(handoff)
  assert.equal(handoffUrl.origin, args.env.appUrl)
  assert.deepEqual([...handoffUrl.searchParams.keys()], ['request'])
  const requestId = handoffUrl.searchParams.get('request')
  assert(requestId !== null, `${args.label} consent handoff omitted its opaque request`)

  markExpectedBrowserTransition(args.page)
  const inspectPromise = waitForFinishedBrowserResponse(
    args.page,
    'GET',
    `/api/duet/oauth/authorization/${encodeURIComponent(requestId)}`,
  )
  await navigateDeployedPage(args.page, handoffUrl.toString())
  const inspectResponse = await inspectPromise.catch(async error => {
    await args.page
      .screenshot({
        path: `${args.artifacts.directory}/${args.label}-consent-timeout.png`,
        fullPage: true,
      })
      .catch(() => {})
    throw new Error(
      `${args.label} consent inspect never fired; page at ${args.page.url()}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  })
  const inspection = OAuthConsentInspectResponseSchema.parse(await inspectResponse.json())
  assert.equal(inspection.status, 'pending')
  assert.equal(inspection.client.id, args.clientId)
  if (args.expectedClientName !== undefined) {
    assert.equal(inspection.client.name, args.expectedClientName)
  }
  assert.deepEqual([...inspection.capabilities].sort(), [...CAPABILITIES].sort())
  const target = inspection.workspaces.find(candidate => candidate.slug === args.workspace.slug)
  assert(target !== undefined, `${args.label} consent omitted the fixture workspace`)
  await args.page.getByText(inspection.client.name, { exact: true }).waitFor()
  // The consent card renders the host inside a sentence ("Redirects to <host>"),
  // so match it as a substring rather than as a standalone exact text node.
  await args.page.getByText(inspection.redirect.hostname, { exact: false }).waitFor()
  const radio = args.page.locator(`input[name="consent-workspace"][value="${args.workspace.slug}"]`)
  if ((await radio.count()) === 1) await radio.check()

  markExpectedBrowserTransition(args.page)
  await args.page
    .getByRole('button', { name: `Approve for ${target.name}`, exact: true })
    .click({ noWaitAfter: true, timeout: BROWSER_TRANSITION_TIMEOUT_MS })
  // The consent controller navigates the browser to the client's redirect_uri
  // (carrying ?code&state) immediately after approve, which evicts the approve
  // POST response body before it can be read. Read the grant off the navigation
  // URL instead — robust regardless of what the callback route itself returns.
  const redirectPathname = new URL(args.redirectUri).pathname
  await args.page.waitForURL(url => url.pathname === redirectPathname, {
    timeout: BROWSER_TRANSITION_TIMEOUT_MS,
  })
  const completion = new URL(args.page.url())
  assert.equal(completion.searchParams.get('state'), state)
  const code = completion.searchParams.get('code')
  assert(code !== null, `${args.label} approval omitted its authorization code`)
  return {
    clientId: args.clientId,
    clientName: inspection.client.name,
    redirectUri: args.redirectUri,
    verifier,
    code,
  }
}

async function exchangeCode(
  env: McpOAuthJourneyEnv,
  authorization: AuthorizedClient,
  artifacts: StagingArtifactCollector,
): Promise<OAuthTokenResponse> {
  const response = await tokenRequest(
    env,
    {
      grant_type: 'authorization_code',
      code: authorization.code,
      redirect_uri: authorization.redirectUri,
      client_id: authorization.clientId,
      code_verifier: authorization.verifier,
      resource: env.mcpUrl,
    },
    artifacts,
  )
  assert.equal(response.status, 200, 'authorization-code exchange failed')
  const pair = OAuthTokenResponseSchema.parse(await response.json())
  assert(pair.access_token.startsWith('duet_sk_'), 'OAuth access token is not a Duet key')
  assert(
    pair.expires_in >= 3_500 && pair.expires_in <= 3_600,
    'OAuth access token did not receive the roughly one-hour lifetime',
  )
  return pair
}

async function assertOAuthAccess(
  env: McpOAuthJourneyEnv,
  pair: OAuthTokenResponse,
  workspace: Workspace,
  email: string,
  artifacts: StagingArtifactCollector,
): Promise<void> {
  const response = await timedFetch(
    `${env.apiUrl}/v1/whoami`,
    { headers: bearer(pair.access_token) },
    artifacts,
  )
  assert.equal(response.status, 200, 'OAuth access token failed whoami')
  const whoami = WhoamiResponseSchema.parse(await response.json())
  assert.equal(whoami.user.email, email)
  assert.deepEqual([...whoami.scopes].sort(), materializedScopes(workspace.slug).sort())
  assert(whoami.workspaces.some(candidate => candidate.slug === workspace.slug))
  assert.deepEqual(whoami.credential, { kind: 'oauth', audience: env.mcpUrl })
}

async function rotateRefresh(
  env: McpOAuthJourneyEnv,
  clientId: string,
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  const response = await tokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource: env.mcpUrl,
  })
  assert.equal(response.status, 200, 'refresh rotation failed')
  return OAuthTokenResponseSchema.parse(await response.json())
}

async function expectInvalidRefresh(
  env: McpOAuthJourneyEnv,
  clientId: string,
  refreshToken: string,
): Promise<void> {
  const response = await tokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource: env.mcpUrl,
  })
  assert.equal(response.status, 400, 'invalid refresh credential survived')
  assert.deepEqual(OAuthTokenErrorResponseSchema.parse(await response.json()), {
    error: 'invalid_grant',
  })
}

async function tokenRequest(
  env: Pick<McpOAuthJourneyEnv, 'apiUrl'>,
  body: Record<string, string>,
  artifacts?: StagingArtifactCollector,
): Promise<Response> {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  }
  return artifacts === undefined
    ? await stagingFetch(`${env.apiUrl}/oauth/token`, init)
    : await timedFetch(`${env.apiUrl}/oauth/token`, init, artifacts)
}

async function callMcpTool(args: {
  env: McpOAuthJourneyEnv
  token: string
  name: string
  input: Record<string, unknown>
  id: number
  artifacts: StagingArtifactCollector
}): Promise<Record<string, unknown>> {
  const response = await timedFetch(
    args.env.mcpUrl,
    {
      method: 'POST',
      headers: bearer(args.token, {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: args.id,
        method: 'tools/call',
        params: { name: args.name, arguments: args.input },
      }),
    },
    args.artifacts,
  )
  assert.equal(response.status, 200, `MCP tool ${args.name} returned HTTP ${response.status}`)
  const rpc = parseMcpJsonRpcResponse(await response.text())
  assert(rpc.error === undefined, `MCP tool ${args.name} returned JSON-RPC error`)
  assert(rpc.result !== undefined, `MCP tool ${args.name} omitted its result`)
  return rpc.result
}

async function assertMcpRejected(
  env: McpOAuthJourneyEnv,
  token: string,
  artifacts: StagingArtifactCollector,
): Promise<void> {
  const response = await timedFetch(
    env.mcpUrl,
    { method: 'POST', headers: bearer(token) },
    artifacts,
  )
  assert.equal(response.status, 401, 'MCP accepted a dead or wrong-audience OAuth token')
  parseBearerChallenge(response.headers.get('www-authenticate'))
}

function materializedScopes(workspaceSlug: string): string[] {
  return CAPABILITIES.map(capability => serializeScope({ workspaceSlug, capability }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function runMcpOAuthJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<McpOAuthAcceptanceResult>> {
  const oauthEnv = readMcpOAuthJourneyEnv()
  const result = await runWorkspaceBrowserJourney({
    journey: 'mcp-oauth',
    label: 'MCP OAuth',
    onProgress: options.onProgress,
    run: async context =>
      await runMcpOAuthAcceptance({
        ...context,
        env: { ...context.env, ...oauthEnv },
      }),
  })
  await assertNoCredentialArtifacts(result.artifactDirectory)
  return result
}
