import { waitUntil as vercelWaitUntil } from '@vercel/functions'
import { ConvexHttpClient } from 'convex/browser'
import { Hono } from 'hono'

import {
  BackendDeploymentSchema,
  DUET_API_KEY_PREFIX,
  APPROVED_MODELS,
  ReleaseRevisionSchema,
  convexUrlsFromDeployment,
  extractApiKeyCredential,
  hashApiKey,
} from '@repo/contract'
import { ExeClient } from '@repo/exe'

import { drainRunnerInputQueue } from './agent-runner'
import { createBackupBlobStore } from './backups/blob'
import {
  resolveApiUrl,
  resolveAppUrl,
  resolveEdgeHost,
  resolveRuntimeReleaseDir,
  resolveModelGatewayUrl,
  resolveMcpPublicUrl,
  resolveOfficialHubBaseUrl,
  resolveOfficialHubOwnerEmail,
  resolveTrustProxyHeaders,
  resolveVmIdleSyncIntervalSeconds,
  resolveVmSyncIntervalSeconds,
} from './config'
import { retryConvexContention } from './convex-contention'
import { GatewayClient } from './gateway/client'
import { createComposioIntegrationProvider, createComposioMcpProvider } from './providers/composio'
import { ADMIN_AUTH_BYPASS_PATHS, registerAdminRoutes } from './routes/admin'
import { AGENT_AUTH_BYPASS_PATTERNS, registerAgentRoutes } from './routes/agent'
import { registerAgentRosterRoutes } from './routes/agent-roster'
import { registerAgentsRoutes } from './routes/agents'
import { registerAnalyticsRoutes } from './routes/analytics'
import { registerAppCredentialHeaders, registerAppCredentialRoutes } from './routes/app-credentials'
import {
  APP_DOMAIN_AUTH_BYPASS_PATHS,
  registerAppDomainInternalRoutes,
  registerAppDomainRoutes,
} from './routes/app-domains'
import { registerAppsRoutes } from './routes/apps'
import { AUTH_AUTH_BYPASS_PATHS, registerAuthRoutes } from './routes/auth'
import { registerBackupControlRoutes, BACKUP_AUTH_BYPASS_PATTERNS } from './routes/backup-control'
import { registerBackupRoutes } from './routes/backups'
import { registerBillingRoutes } from './routes/billing'
import { COMPOSIO_AUTH_BYPASS_PATHS, registerComposioRoutes } from './routes/composio'
import { registerConnectedProvidersRoutes } from './routes/connected-providers'
import { registerDesktopRoutes } from './routes/desktop'
import { DEVICE_AUTH_BYPASS_PATHS, registerDeviceRoutes } from './routes/device'
import {
  FAKE_OAUTH_ISSUER_PATH_PATTERN,
  registerFakeOAuthIssuerRoutes,
} from './routes/fake-oauth-issuer'
import { registerFileActivityRoutes } from './routes/file-activity'
import { registerIntegrationRoutes } from './routes/integrations'
import { registerInternalAdminRoutes } from './routes/internal-admin'
import { registerMarketplaceAgentsRoutes } from './routes/marketplace'
import { MCP_SERVERS_AUTH_BYPASS_PATHS, registerMcpServerRoutes } from './routes/mcp-servers'
import { registerMirrorRoutes } from './routes/mirror'
import { OAUTH_AUTH_BYPASS_PATHS, registerOAuthRoutes } from './routes/oauth'
import { registerOnboardingRoutes } from './routes/onboarding'
import { registerPublishesRoutes } from './routes/publishes'
import { registerServiceProxyRoutes } from './routes/services'
import {
  registerSessionDeletionInternalRoutes,
  registerSessionDeletionRoutes,
  SESSION_DELETION_AUTH_BYPASS_PATTERNS,
} from './routes/session-deletions'
import { registerSharesRoutes } from './routes/shares'
import { registerSkillsRoutes } from './routes/skills'
import { registerTelemetryRoutes } from './routes/telemetry'
import { registerTrainRoutes } from './routes/train'
import { registerUserRoutes } from './routes/users'
import { registerVmRoutes, VM_AUTH_BYPASS_PATHS, VM_AUTH_BYPASS_PATTERNS } from './routes/vm'
import { registerWorkspaceRoutes } from './routes/workspaces'
import { DEFAULT_RUNTIME_RELEASE_DIR, readRuntimeReleaseManifest } from './runtime/release'
import {
  fn,
  fnQuery,
  normalizeOptionalUrl,
  type ApiAppOptions,
  type ApiRouteRuntime,
  type ApiVariables,
} from './shared'
import { whoamiResponseForAuth } from './whoami'

const API_KEY_DISPLAY_PREFIX_LENGTH = DUET_API_KEY_PREFIX.length + 8

export type { ApiAppOptions, IntegrationProvider } from './shared'
export { drainRunnerInputQueue }

export function createApiApp(options: ApiAppOptions = {}) {
  const convexUrl =
    options.convexUrl ?? convexUrlsFromDeployment(process.env.CONVEX_DEPLOYMENT ?? '').cloudUrl
  const internalKey = options.internalKey ?? process.env.DUET_API_INTERNAL_KEY
  if (!internalKey) throw new Error('DUET_API_INTERNAL_KEY is required')
  const apiInternalKey: string = internalKey

  const convex =
    options.convexClient ??
    new ConvexHttpClient(convexUrl, {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
    })
  const app = new Hono<{ Variables: ApiVariables }>()
  const fetchImpl = options.fetch ?? fetch
  const waitUntil = options.waitUntil ?? vercelWaitUntil
  const now = options.now ?? Date.now
  const env = options.env ?? process.env
  const trustProxyHeaders = resolveTrustProxyHeaders(options.trustProxyHeaders)
  const integrationProvider =
    options.integrationProvider ?? createComposioIntegrationProvider(fetchImpl)
  const composioMcpProvider = options.composioMcpProvider ?? createComposioMcpProvider()
  const sessionComposioProvider =
    options.composioMcpProvider ?? (env.COMPOSIO_API_KEY ? composioMcpProvider : undefined)
  const modelGatewayUrl = normalizeOptionalUrl(resolveModelGatewayUrl(options.modelGatewayUrl))
  const runtimeReleaseDir = resolveRuntimeReleaseDir(
    options.runtimeReleaseDir,
    DEFAULT_RUNTIME_RELEASE_DIR,
  )
  const vmSyncIntervalSeconds = resolveVmSyncIntervalSeconds(options.vmSyncIntervalSeconds)
  const vmIdleSyncIntervalSeconds = resolveVmIdleSyncIntervalSeconds(
    options.vmIdleSyncIntervalSeconds,
  )
  const apiUrl = resolveApiUrl(env)
  const mcpPublicUrl = resolveMcpPublicUrl(env)
  const internalAdminExeClient =
    options.internalAdminExeClient ??
    (process.env.EXE_TOKEN ? new ExeClient({ token: process.env.EXE_TOKEN }) : null)
  const runtime: ApiRouteRuntime = {
    convex,
    internalKey,
    apiInternalKey,
    programmaticLoginSecret:
      options.programmaticLoginSecret ?? process.env.DUET_PROGRAMMATIC_LOGIN_SECRET,
    fetchImpl,
    now,
    appUrl: resolveAppUrl(options.appUrl),
    officialHubOwnerEmail: options.officialHubOwnerEmail ?? resolveOfficialHubOwnerEmail(),
    officialHubBaseUrl: options.officialHubBaseUrl ?? resolveOfficialHubBaseUrl(),
  }
  const gatewayClient = new GatewayClient({
    convex,
    internalKey,
    edgeHost: resolveEdgeHost(env),
    fetchImpl,
    now,
    agentRequestTimeoutMs: options.agentRequestTimeoutMs,
  })

  // Root health: the whole app rides one Vercel function routed at "/", so
  // monitors and platform anomaly detection probe here. Everything real
  // lives under /v1.
  app.get('/', c => c.json({ ok: true, service: 'duet-api' }))
  app.get('/deployment', async c => {
    const revision = ReleaseRevisionSchema.safeParse(env.VERCEL_GIT_COMMIT_SHA?.trim())
    const [backend, runtimeManifest] = await Promise.all([
      convex
        .query(fnQuery('deployment:identity'), {})
        .then(value => BackendDeploymentSchema.parse(value)),
      readRuntimeReleaseManifest(runtimeReleaseDir),
    ])
    return c.json(
      {
        revision: revision.success ? revision.data : null,
        backend,
        runtime: { version: runtimeManifest?.version ?? null },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
  registerFakeOAuthIssuerRoutes(app, {
    enabled: env.DUET_ENABLE_FAKE_OAUTH_ISSUER === '1',
    issuer: options.fakeOAuthIssuer,
  })

  registerAppCredentialHeaders(app)
  app.use('/v1/*', async (c, next) => {
    if (isAuthBypassedPath(c.req.path)) {
      await next()
      return
    }
    const apiKeyHeaders = new Headers()
    const authorization = c.req.header('authorization')
    if (authorization !== undefined) apiKeyHeaders.set('authorization', authorization)
    const apiKey = c.req.header('x-api-key')
    if (apiKey !== undefined) apiKeyHeaders.set('x-api-key', apiKey)
    const credential = extractApiKeyCredential(apiKeyHeaders)
    if (credential === null) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const hashedKey = await hashApiKey(credential.token)
    const requestNow = now()
    // Who the caller is (a query: reads only, no write contention) and the
    // spend against their budget (a mutation over one key row and one counter
    // shard) are asked together, so a page load's parallel requests neither
    // wait on each other nor re-run the whole resolution when the counter
    // conflicts. A dead credential spends nothing, so the order of the two
    // answers below is the order of the refusals: 401 before 429.
    const [resolved, recorded] = await Promise.all([
      convex.query(fnQuery('domains/apiKeys/api:resolveCredential'), {
        internalKey,
        hashedKey,
        keyPrefix: credential.token.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
        now: requestNow,
      }),
      retryConvexContention(
        async () =>
          await convex.mutation(fn('domains/apiKeys/api:recordCredentialUse'), {
            internalKey,
            hashedKey,
            now: requestNow,
          }),
        {
          // The budget is a ceiling on abuse, not an allowance: a counter too
          // hot to take this tick refuses nothing. Serve the request and drop
          // the tick instead of 500ing a legitimate caller.
          fallback: error => {
            console.error(
              '[auth] credential-use tick dropped after contention retries:',
              error.message,
            )
            return { ok: true }
          },
        },
      ),
    ])
    if (!isAuthenticatedResult(resolved)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (isRateLimitedResult(recorded)) {
      return c.json(
        { error: 'rate_limited' as const, retryAfterSeconds: recorded.retryAfterSeconds },
        { status: 429, headers: { 'retry-after': String(recorded.retryAfterSeconds) } },
      )
    }
    c.set('auth', resolved.auth)
    c.set('credentialReference', {
      hashedKey,
      keyPrefix: credential.token.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
    })
    await next()
  })

  app.get('/v1/whoami', c => {
    return c.json(whoamiResponseForAuth(c.get('auth')))
  })

  registerWorkspaceRoutes(app, runtime, gatewayClient)
  registerAppCredentialRoutes(app, runtime, { apiUrl, gatewayBaseUrl: modelGatewayUrl })
  registerAnalyticsRoutes(app, runtime)
  registerTelemetryRoutes(app, runtime)
  registerFileActivityRoutes(app, runtime, options.fileActivityStream)
  registerComposioRoutes(app, runtime, composioMcpProvider)
  registerIntegrationRoutes(app, runtime, integrationProvider)
  registerMcpServerRoutes(app, runtime, { waitUntil, apiUrl, trustProxyHeaders })
  registerServiceProxyRoutes(app, runtime, { fetchImpl, waitUntil })
  registerTrainRoutes(app, runtime, gatewayClient, options)
  registerBillingRoutes(app, runtime)
  registerUserRoutes(app, runtime, gatewayClient)
  registerMirrorRoutes(app, runtime, gatewayClient)
  const backupBlob =
    options.backupBlobStore ?? createBackupBlobStore({ token: env.BLOB_READ_WRITE_TOKEN })
  registerBackupRoutes(app, runtime, backupBlob)
  registerBackupControlRoutes(app, runtime, gatewayClient, backupBlob)
  registerDesktopRoutes(app, gatewayClient, {
    async idBySlug(workspaceId, slug) {
      const agent = (await runtime.convex.query(fnQuery('domains/agents/model:getBySlug'), {
        internalKey: runtime.internalKey,
        workspaceId,
        slug,
      })) as { id?: string } | null
      return agent?.id ?? null
    },
    async list(workspaceId) {
      return (await runtime.convex.query(fnQuery('domains/agents/model:listByWorkspace'), {
        internalKey: runtime.internalKey,
        workspaceId,
      })) as Array<{ id: string; slug: string; name: string }>
    },
  })
  registerMarketplaceAgentsRoutes(app, runtime, gatewayClient, {
    campaignAgentNamesForUser: options.campaignStarterAgentsForUser,
  })
  registerOnboardingRoutes(app, runtime)
  registerAgentRoutes(app, runtime, gatewayClient, {
    waitUntil,
    composioMcpProvider: sessionComposioProvider,
    sessionInputTestHooks: options.sessionInputTestHooks,
  })
  registerSessionDeletionRoutes(app, runtime)
  registerAppDomainRoutes(app, runtime)
  registerAppDomainInternalRoutes(app, runtime, gatewayClient)
  registerSessionDeletionInternalRoutes(app, runtime, gatewayClient, sessionComposioProvider)
  registerAgentsRoutes(app, runtime, gatewayClient)
  registerAgentRosterRoutes(app, runtime, gatewayClient)
  registerAppsRoutes(app, runtime, gatewayClient, {
    edgeSecret: options.edgeSecret ?? process.env.DUET_EDGE_INTERNAL_KEY,
  })
  registerSharesRoutes(app, runtime, gatewayClient)
  registerConnectedProvidersRoutes(app, runtime, gatewayClient)
  registerSkillsRoutes(app, runtime, gatewayClient)
  registerPublishesRoutes(app, runtime, gatewayClient)
  registerAuthRoutes(app, runtime, { trustProxyHeaders })
  registerDeviceRoutes(app, runtime, { trustProxyHeaders })
  registerOAuthRoutes(app, runtime, { trustProxyHeaders, apiUrl, mcpPublicUrl })
  registerAdminRoutes(app, runtime)
  registerInternalAdminRoutes(app, runtime, gatewayClient, internalAdminExeClient)
  registerVmRoutes(app, runtime, gatewayClient, {
    modelGatewayUrl,
    runtimeReleaseDir,
    vmSyncIntervalSeconds,
    vmIdleSyncIntervalSeconds,
    edgeHost: resolveEdgeHost(env),
    approvedModelCatalog: options.approvedModelCatalog ?? APPROVED_MODELS,
    composioMcpProvider: sessionComposioProvider,
    registrationPostCommitTestHooks: options.vmRegistrationPostCommitTestHooks,
    backupBlob,
  })

  return app
}

function isRateLimitedResult(
  result: unknown,
): result is { ok: false; reason: 'rate_limited'; retryAfterSeconds: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    (result as { reason?: unknown }).reason === 'rate_limited' &&
    typeof (result as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
  )
}

function isAuthBypassedPath(path: string): boolean {
  return (
    ADMIN_AUTH_BYPASS_PATHS.includes(path as (typeof ADMIN_AUTH_BYPASS_PATHS)[number]) ||
    APP_DOMAIN_AUTH_BYPASS_PATHS.includes(path as (typeof APP_DOMAIN_AUTH_BYPASS_PATHS)[number]) ||
    AUTH_AUTH_BYPASS_PATHS.includes(path as (typeof AUTH_AUTH_BYPASS_PATHS)[number]) ||
    COMPOSIO_AUTH_BYPASS_PATHS.includes(path as (typeof COMPOSIO_AUTH_BYPASS_PATHS)[number]) ||
    DEVICE_AUTH_BYPASS_PATHS.includes(path as (typeof DEVICE_AUTH_BYPASS_PATHS)[number]) ||
    MCP_SERVERS_AUTH_BYPASS_PATHS.includes(
      path as (typeof MCP_SERVERS_AUTH_BYPASS_PATHS)[number],
    ) ||
    OAUTH_AUTH_BYPASS_PATHS.includes(path as (typeof OAUTH_AUTH_BYPASS_PATHS)[number]) ||
    VM_AUTH_BYPASS_PATHS.includes(path as (typeof VM_AUTH_BYPASS_PATHS)[number]) ||
    BACKUP_AUTH_BYPASS_PATTERNS.some(pattern => pattern.test(path)) ||
    VM_AUTH_BYPASS_PATTERNS.some(pattern => pattern.test(path)) ||
    AGENT_AUTH_BYPASS_PATTERNS.some(pattern => pattern.test(path)) ||
    SESSION_DELETION_AUTH_BYPASS_PATTERNS.some(pattern => pattern.test(path)) ||
    FAKE_OAUTH_ISSUER_PATH_PATTERN.test(path)
  )
}

function isAuthenticatedResult(
  result: unknown,
): result is { ok: true; auth: ApiVariables['auth'] } {
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true
}

// Vercel function config: opt into response streaming (SSE endpoints buffer otherwise).
export const config = { supportsResponseStreaming: true }

export default {
  fetch(request: Request) {
    return createApiApp().fetch(request)
  },
}
