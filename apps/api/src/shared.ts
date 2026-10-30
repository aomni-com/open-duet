import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { type Context, type Hono } from 'hono'

import {
  API_VERSION,
  gatewayBlockResponse,
  scopeSetSatisfies,
  type ApiCredentialKind,
  type Capability,
  type CollectionPage,
  type ApprovedModelCatalog,
  type FetchLike,
  type GatewayBlock,
  type IntegrationProviderCatalogPage,
  type IntegrationProviderConnection,
  type SessionRequestIdentity,
  type WorkspaceRole,
  type WorkspaceSummary,
} from '@repo/contract'
import { type ExeClient } from '@repo/exe'
import type { FakeOAuthIssuer } from '@repo/fake-oauth-issuer'

// Type-only: erased at compile time, so no runtime cycle with the route module.
import type { BackupBlobStore } from './backups/blob'
import type { FileEventStreamOptions } from './routes/file-activity'
import type { VmRegistrationPostCommitTestHooks } from './routes/vm'
import { sessionErrorResponse } from './session-errors'
import { sessionRequestIdentityForAuth } from './session-principal'

export interface ApiAppOptions {
  convexUrl?: string
  backupBlobStore?: BackupBlobStore
  /** Inject the backend transport in route integration tests. */
  convexClient?: ConvexHttpClient
  internalKey?: string
  edgeSecret?: string
  programmaticLoginSecret?: string
  internalAdminExeClient?: Pick<ExeClient, 'getStatus' | 'restart'>
  fetch?: FetchLike
  agentRequestTimeoutMs?: number
  waitUntil?: WaitUntil
  now?: () => number
  trustProxyHeaders?: boolean
  modelGatewayUrl?: string
  appUrl?: string
  officialHubOwnerEmail?: string
  officialHubBaseUrl?: string
  integrationProvider?: IntegrationProvider
  composioMcpProvider?: ComposioMcpProvider
  firecrawlKey?: string
  firecrawlTimeoutMs?: number
  runtimeReleaseDir?: string
  vmSyncIntervalSeconds?: number
  vmIdleSyncIntervalSeconds?: number
  approvedModelCatalog?: ApprovedModelCatalog
  env?: NodeJS.ProcessEnv
  fakeOAuthIssuer?: FakeOAuthIssuer
  campaignStarterAgentsForUser?: (userId: string) => Promise<readonly string[]>
  // Timing knobs for the file-activity SSE feed; tests inject small values.
  fileActivityStream?: FileEventStreamOptions
  /** Test orchestration for revocation races at the public input boundary. */
  sessionInputTestHooks?: SessionInputTestHooks
  vmRegistrationPostCommitTestHooks?: VmRegistrationPostCommitTestHooks
}

export interface SessionInputTestHooks {
  beforePreflight?: () => Promise<void>
  afterImagesStored?: () => Promise<void>
}

export type WaitUntil = (promise: Promise<unknown>) => void

export interface IntegrationProvider {
  listCatalog(args: {
    workspaceId: string
    search?: string
    cursor?: string
    limit: number
  }): Promise<IntegrationProviderCatalogPage>
  listConnections(args: {
    workspaceId: string
    integration?: string
    cursor?: string
    limit: number
  }): Promise<CollectionPage<IntegrationProviderConnection>>
  /**
   * One of this workspace's connections, by id. Workspace-scoped like every
   * other read here: the provider decides whether the connection is the
   * workspace's, so a connection it lists is a connection it can remove.
   */
  getConnection(args: {
    workspaceId: string
    providerConnectionId: string
  }): Promise<IntegrationProviderConnection | undefined>
  beginConnection(args: {
    workspaceId: string
    integration: string
    callbackUrl: string
    /** Human-readable name for the account in the provider's own dashboard. */
    label: string
  }): Promise<{ authorizeUrl: string }>
  disconnect(args: { workspaceId: string; providerConnectionId: string }): Promise<void>
}

export type { IntegrationProviderConnection } from '@repo/contract'

export interface ComposioMcpSession {
  providerSessionId: string
  mcp: {
    type: 'http'
    url: string
    headers?: Record<string, string>
  }
}

export interface ComposioMcpProvider {
  createToolRouterSession(args: {
    workspaceId: string
    callbackUrl: string
    disabledToolkitSlugs: readonly string[]
  }): Promise<ComposioMcpSession>
  useToolRouterSession(args: { providerSessionId: string }): Promise<ComposioMcpSession>
  updateToolRouterSession(args: {
    providerSessionId: string
    disabledToolkitSlugs: readonly string[]
  }): Promise<void>
  deleteToolRouterSession(args: { providerSessionId: string }): Promise<void>
}

export class IntegrationProviderNotConfiguredError extends Error {}

export interface AuthPayload {
  credentialKind: ApiCredentialKind
  // Convex apiKeys document id; absent for browser sessions (they attribute
  // by user, not by credential).
  credentialId?: string
  app?: { id: string; slug: string }
  user: { id: string; email: string; name?: string }
  workspaces: WorkspaceSummary[]
  scopes: string[]
  audience?: string
  versions: typeof API_VERSION
}

// Product analytics stamps browser-origin events, so this gate identifies a tab.
export function requireBrowserSession(c: ApiContext): { userId: string } | { response: Response } {
  const auth = c.get('auth')
  if (auth.credentialKind !== 'browser_session' && auth.credentialKind !== 'impersonation') {
    return { response: c.json({ error: 'browser_session_required' }, 403) }
  }
  return { userId: auth.user.id }
}

/** Account operations act as the authenticated person, independent of client. */
export function requireHumanActor(c: ApiContext): { userId: string } | { response: Response } {
  const auth = c.get('auth')
  if (!['browser_session', 'impersonation', 'user'].includes(auth.credentialKind)) {
    return { response: c.json({ error: 'human_credential_required' }, 403) }
  }
  return { userId: auth.user.id }
}

export interface WorkspaceRef {
  id: string
  slug: string
  role: WorkspaceRole
}

export interface WorkspaceAdmissionOptions {
  /** Explicit onboarding/payment routes may reach an incomplete workspace. */
  allowIncomplete?: boolean
}

export type ApiVariables = {
  auth: AuthPayload
  credentialReference: { hashedKey: string; keyPrefix: string }
}

export type ApiApp = Hono<{ Variables: ApiVariables }>
export type ApiContext = Context<{ Variables: ApiVariables }>

export interface ApiRouteRuntime {
  convex: ConvexHttpClient
  internalKey: string
  apiInternalKey: string
  programmaticLoginSecret?: string
  fetchImpl: FetchLike
  now: () => number
  appUrl: string
  officialHubOwnerEmail: string
  officialHubBaseUrl: string
}

export function fn(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}

export function fnAction(name: string): FunctionReference<'action'> {
  return makeFunctionReference(name) as FunctionReference<'action'>
}

export function fnQuery(name: string): FunctionReference<'query'> {
  return makeFunctionReference(name) as FunctionReference<'query'>
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function normalizeOptionalUrl(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim().replace(/\/+$/g, '')
  return trimmed.length > 0 ? trimmed : null
}

export function appHref(appUrl: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Duet app destination must be an absolute path')
  }
  return new URL(path, `${appUrl.replace(/\/+$/, '')}/`).toString()
}

export function requireAuthedWorkspace(
  c: ApiContext,
  capability: Capability | readonly [Capability, ...Capability[]],
  options: WorkspaceAdmissionOptions = {},
): WorkspaceRef | { response: Response } {
  const workspaceSlug = c.req.param('workspaceSlug')
  const capabilities = typeof capability === 'string' ? [capability] : capability
  const requiredScopes = capabilities.map(candidate => `ws:${workspaceSlug}:${candidate}`)
  const auth = c.get('auth')
  if (!requiredScopes.some(requiredScope => scopeSetSatisfies(auth.scopes, requiredScope))) {
    return {
      response: c.json({ error: 'insufficient_scope', scope: requiredScopes[0]! }, 403),
    }
  }
  const workspace = auth.workspaces.find(candidate => candidate.slug === workspaceSlug)
  if (workspace === undefined) return { response: c.json({ error: 'not_found' }, 404) }
  const admission = requireOnboardedWorkspace(c, workspace, options)
  if ('response' in admission) return admission
  return { id: workspace.id, slug: workspace.slug, role: workspace.role }
}

// Unlike requireAuthedWorkspace (scope-first: daemons get a typed
// insufficient_scope error even when auth pruned the workspace), these
// routes hide workspaces the caller cannot see: unknown slug is a 404
// before any scope detail leaks.
export function requireMemberWorkspaceWithScope(
  c: ApiContext,
  capability: Capability,
  options: WorkspaceAdmissionOptions = {},
): WorkspaceRef | { response: Response } {
  const workspaceSlug = c.req.param('workspaceSlug')
  const auth = c.get('auth')
  const workspace = auth.workspaces.find(candidate => candidate.slug === workspaceSlug)
  if (workspace === undefined) return { response: c.json({ error: 'not_found' }, 404) }
  const requiredScope = `ws:${workspaceSlug}:${capability}`
  if (!scopeSetSatisfies(auth.scopes, requiredScope)) {
    return { response: c.json({ error: 'insufficient_scope', scope: requiredScope }, 403) }
  }
  const admission = requireOnboardedWorkspace(c, workspace, options)
  if ('response' in admission) return admission
  return { id: workspace.id, slug: workspace.slug, role: workspace.role }
}

export function requireWorkspaceMember(
  c: ApiContext,
  options: WorkspaceAdmissionOptions = {},
): WorkspaceRef | { response: Response } {
  const workspaceSlug = c.req.param('workspaceSlug')
  const workspace = c.get('auth').workspaces.find(candidate => candidate.slug === workspaceSlug)
  if (workspace === undefined) return { response: c.json({ error: 'not_found' }, 404) }
  const admission = requireOnboardedWorkspace(c, workspace, options)
  if ('response' in admission) return admission
  return { id: workspace.id, slug: workspace.slug, role: workspace.role }
}

export function requireWorkspaceFromKey(
  c: ApiContext,
  capability: Capability,
  explicitSlug?: string,
  options: WorkspaceAdmissionOptions = {},
): WorkspaceRef | { response: Response } {
  const workspaces = c.get('auth').workspaces
  let selected: AuthPayload['workspaces'][number] | undefined
  if (explicitSlug !== undefined) {
    selected = workspaces.find(workspace => workspace.slug === explicitSlug)
  } else if (workspaces.length === 1) {
    selected = workspaces[0]
  }
  if (selected !== undefined) {
    const requiredScope = `ws:${selected.slug}:${capability}`
    if (!scopeSetSatisfies(c.get('auth').scopes, requiredScope)) {
      return { response: c.json({ error: 'insufficient_scope', scope: requiredScope }, 403) }
    }
    const admission = requireOnboardedWorkspace(c, selected, options)
    if ('response' in admission) return admission
    return workspaceRef(selected)
  }
  return {
    response: gatewayBlockResponse({
      status: 403,
      body: {
        error: 'Specify a workspace granted by this API key.',
        code: 'workspace_ambiguous',
      },
    }),
  }
}

/**
 * The single API projection for the workspace onboarding admission contract.
 * Scope and identity checks happen before this function, so incomplete
 * workspaces never turn an authorization failure or unknown slug into a
 * different answer.
 */
export function requireOnboardedWorkspace(
  c: ApiContext,
  workspace: WorkspaceSummary,
  options: WorkspaceAdmissionOptions = {},
): { ok: true } | { response: Response } {
  return requireWorkspaceAdmission(c, workspace, options)
}

export function requireWorkspaceAdmission(
  c: ApiContext,
  workspace: { slug?: string; workspaceSlug?: string; onboardedAt?: number },
  options: WorkspaceAdmissionOptions = {},
): { ok: true } | { response: Response } {
  if (options.allowIncomplete === true || workspace.onboardedAt !== undefined) return { ok: true }
  const slug = workspace.slug ?? workspace.workspaceSlug
  if (slug === undefined) throw new Error('Workspace admission requires a slug')
  return { response: onboardingRequiredResponse(c, slug) }
}

export function onboardingRequiredResponse(c: ApiContext, workspaceSlug: string): Response {
  return c.json(
    {
      error: 'onboarding_required',
      code: 'onboarding_required',
      onboardingUrl: `/w/${encodeURIComponent(workspaceSlug)}/onboarding`,
    },
    409,
  )
}

export async function requirePreflightedSpendWorkspace(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  estimatedCostMicroUsd?: number,
): Promise<WorkspaceRef | { response: Response }> {
  const servicingBlock = await servicingStatusBlock(runtime, workspace.id)
  if (servicingBlock !== null) return { response: gatewayBlockResponse(servicingBlock) }
  const decision = (await runtime.convex.mutation(fn('domains/credits/internal:runPreflight'), {
    internalKey: runtime.internalKey,
    actorId: c.get('auth').user.id,
    workspaceId: workspace.id,
    ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }),
    now: runtime.now(),
  })) as {
    proceed: boolean
    reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
    tier?: 'account' | 'workspace'
    balanceMicroUsd: number
  }
  return preflightDecisionResponse(c, runtime, workspace, decision)
}

export async function requirePreflightedSessionSpendWorkspace(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  sessionId: string,
  identity: SessionRequestIdentity,
  estimatedCostMicroUsd?: number,
  sourceSessionId?: string,
): Promise<WorkspaceRef | { response: Response }> {
  let result:
    | { servicingStatus: 'paused' | 'banned' }
    | {
        proceed: boolean
        reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
        tier?: 'account' | 'workspace'
        balanceMicroUsd: number
      }
  try {
    result = (await runtime.convex.mutation(
      fn('domains/agentSessions/model:preflightSessionSpend'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        sessionId,
        identity,
        ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
        ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }),
        now: runtime.now(),
      },
    )) as typeof result
  } catch (error) {
    return { response: sessionErrorResponse(c, error) }
  }
  const refusal = preflightRefusalResponse(runtime, result)
  return refusal === null ? workspace : { response: refusal }
}

export type SessionSpendPreflightOutcome =
  | { servicingStatus: 'paused' | 'banned' }
  | {
      proceed: boolean
      reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
      tier?: 'account' | 'workspace'
      balanceMicroUsd: number
    }

/** The response a session spend preflight's answer earns, or null when the request may proceed. */
export function preflightRefusalResponse(
  runtime: ApiRouteRuntime,
  result: SessionSpendPreflightOutcome,
): Response | null {
  if ('servicingStatus' in result) {
    return gatewayBlockResponse(servicingStatusGatewayBlock(runtime, result.servicingStatus))
  }
  return spendDecisionBlockResponse(runtime, result)
}

export async function requirePreflightedSessionCreationWorkspace(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  args: {
    clientRequestId?: string
    clientRequestFingerprint?: string
    cwd?: string
    audience: { kind: 'workspace' } | { kind: 'specific'; memberUserIds: string[] }
  },
): Promise<WorkspaceRef | { response: Response }> {
  try {
    const result = (await runtime.convex.mutation(
      fn('domains/agentSessions/model:preflightSessionCreationSpend'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        identity: sessionRequestIdentityForAuth(c.get('auth')),
        ...args,
        now: runtime.now(),
      },
    )) as { servicingStatus: 'paused' | 'banned' } | Parameters<typeof preflightDecisionResponse>[3]
    if ('servicingStatus' in result) {
      return {
        response: gatewayBlockResponse(
          servicingStatusGatewayBlock(runtime, result.servicingStatus),
        ),
      }
    }
    return preflightDecisionResponse(c, runtime, workspace, result)
  } catch (error) {
    return { response: sessionErrorResponse(c, error) }
  }
}

export async function requirePreflightedDefaultSessionSpendWorkspace(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  owner: { kind: 'root' } | { kind: 'agent'; agentId: string },
  identity: SessionRequestIdentity,
  sourceSessionId?: string,
): Promise<WorkspaceRef | { response: Response }> {
  let result:
    | { servicingStatus: 'paused' | 'banned' }
    | {
        proceed: boolean
        reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
        tier?: 'account' | 'workspace'
        balanceMicroUsd: number
      }
  try {
    result = (await runtime.convex.mutation(
      fn('domains/agentSessions/model:preflightDefaultSessionSpend'),
      {
        internalKey: runtime.internalKey,
        workspaceId: workspace.id,
        owner,
        identity,
        ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
        now: runtime.now(),
      },
    )) as typeof result
  } catch (error) {
    return { response: sessionErrorResponse(c, error) }
  }
  if ('servicingStatus' in result) {
    return {
      response: gatewayBlockResponse(servicingStatusGatewayBlock(runtime, result.servicingStatus)),
    }
  }
  return preflightDecisionResponse(c, runtime, workspace, result)
}

export function preflightDecisionResponse(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  workspace: WorkspaceRef,
  decision: {
    proceed: boolean
    reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
    tier?: 'account' | 'workspace'
    balanceMicroUsd: number
  },
): WorkspaceRef | { response: Response } {
  const response = spendDecisionBlockResponse(runtime, decision)
  return response === null ? workspace : { response }
}

function spendDecisionBlockResponse(
  runtime: ApiRouteRuntime,
  decision: {
    proceed: boolean
    reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
    tier?: 'account' | 'workspace'
    balanceMicroUsd: number
  },
): Response | null {
  if (decision.proceed) return null
  const billingUrl = appHref(runtime.appUrl, '/settings/billing')
  const block: GatewayBlock =
    decision.reason === 'subscription_required'
      ? {
          status: 402,
          body: {
            error: 'subscription_required',
            code: 'subscription_required',
            billingUrl,
          },
        }
      : decision.reason === 'monthly_cap'
        ? {
            status: 402,
            body: {
              error: 'monthly_cap',
              code: 'monthly_cap',
              tier: decision.tier ?? 'account',
              balanceMicroUsd: decision.balanceMicroUsd,
              autoTopupScheduled: false,
              billingUrl,
            },
          }
        : {
            status: 402,
            body: {
              error: 'insufficient_credits',
              code: 'insufficient_credits',
              tier: 'account',
              balanceMicroUsd: decision.balanceMicroUsd,
              autoTopupScheduled: false,
              billingUrl,
            },
          }
  return gatewayBlockResponse(block)
}

export function sessionCreationSpendErrorResponse(
  runtime: ApiRouteRuntime,
  error: unknown,
): Response | null {
  if (!(error instanceof ConvexError)) return null
  const data = error.data as {
    error?: string
    result?:
      | { servicingStatus: 'paused' | 'banned' }
      | {
          proceed: boolean
          reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
          tier?: 'account' | 'workspace'
          balanceMicroUsd: number
        }
  }
  if (data.error !== 'session_creation_spend_blocked' || data.result === undefined) return null
  if ('servicingStatus' in data.result) {
    return gatewayBlockResponse(servicingStatusGatewayBlock(runtime, data.result.servicingStatus))
  }
  return spendDecisionBlockResponse(runtime, data.result)
}

async function servicingStatusBlock(
  runtime: ApiRouteRuntime,
  workspaceId: string,
): Promise<GatewayBlock | null> {
  const status = (await runtime.convex.query(
    fnQuery('domains/workspaces/queries:servicingStatus'),
    {
      internalKey: runtime.internalKey,
      workspaceId,
    },
  )) as { servicingStatus: 'active' | 'paused' | 'banned' }
  if (status.servicingStatus === 'paused') {
    return servicingStatusGatewayBlock(runtime, status.servicingStatus)
  }
  if (status.servicingStatus === 'banned') {
    return servicingStatusGatewayBlock(runtime, status.servicingStatus)
  }
  return null
}

function servicingStatusGatewayBlock(
  runtime: ApiRouteRuntime,
  status: 'paused' | 'banned',
): GatewayBlock {
  return status === 'paused'
    ? {
        status: 402,
        body: {
          error: 'subscription_inactive',
          code: 'subscription_inactive',
          billingUrl: appHref(runtime.appUrl, '/settings/billing'),
        },
      }
    : {
        status: 402,
        body: {
          error: 'payment_required',
          code: 'payment_required',
          billingUrl: appHref(runtime.appUrl, '/settings/billing'),
        },
      }
}

function workspaceRef(workspace: WorkspaceSummary): WorkspaceRef {
  return { id: workspace.id, slug: workspace.slug, role: workspace.role }
}
