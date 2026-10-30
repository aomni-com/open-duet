import path from 'node:path'

import { makeFunctionReference, type FunctionReference } from 'convex/server'

import { convexUrlsFromDeployment } from '@repo/contract'

const REQUIRED_ENV = [
  'DUET_API_URL',
  'DUET_APP_URL',
  'DUET_LANDER_URL',
  'DUET_MCP_PUBLIC_URL',
  'CONVEX_DEPLOYMENT',
  'DUET_API_INTERNAL_KEY',
  'DUET_EDGE_INTERNAL_KEY',
  'DUET_PROGRAMMATIC_LOGIN_SECRET',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'AGENTMAIL_API_KEY',
  'DUET_E2E_AGENTMAIL_INBOX_ADDRESS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
] as const

/**
 * Optional until the staging fake-issuer hosting lands (spec slice 11b):
 * absent, the connected-providers journey self-skips with a loud artifact
 * line instead of failing the whole staging run at env-read.
 */
export const OPTIONAL_LIVE_ENV_KEYS = ['DUET_CONNECT_FAKE_ISSUER_URL'] as const

type MutationRef = FunctionReference<'mutation'>
type QueryRef = FunctionReference<'query'>
type ActionRef = FunctionReference<'action'>

export interface LiveEnv {
  apiUrl: string
  appUrl: string
  landerUrl: string
  mcpUrl: string
  docsUrl: string
  convexUrl: string
  convexSiteUrl: string
  internalKey: string
  edgeInternalKey: string
  loginSecret: string
  vercelBypassSecret: string
  agentMailApiKey: string
  agentMailInboxId: string
  agentMailInboxAddress: string
  agentMailInbox2Id: string
  agentMailInbox2Address: string
  stripeSecretKey: string
  stripeWebhookSecret: string
  stripeBillingPortalConfigurationId: string
  fakeOAuthIssuerUrl: string
  composioApiKey: string | undefined
  firecrawlApiKey: string | undefined
  artifactRoot: string
  headless: boolean
}

export interface Workspace {
  _id: string
  slug: string
  status: string
  vmName?: string
  vmTokenNonce?: string
  archiveStorageId?: string
  runtimeVersion?: string
  lastHeartbeatAt?: number
  vmTeardownRunId?: string
  vmAttachRunId?: string
  attachAfterVmTeardown?: boolean
  servicingStatus?: 'active' | 'paused' | 'banned'
  servicingStatusChangedAt?: number
}

export interface LegResult {
  status: 'pass' | 'fail' | 'skipped'
  reason?: string
}

export const AGENT_CONTINUITY_LEG = 'agent-continuity'
export const AGENT_LIFECYCLE_LEG = 'agent-lifecycle'
export const APP_API_KEYS_LEG = 'app-api-keys'
export const SHARE_BYTE_ARRIVAL_LEG = 'share-byte-arrival'
export const APPS_IN_FILE_VIEW_LEG = 'apps-in-file-view'
export const BUILD_APP_LEG = 'build-app'
export const DRIVE_DEEP_LINKS_LEG = 'drive-deep-links'
export const STORAGE_TIER_RESIZE_LEG = 'storage-tier-resize'
export const CONNECTED_PROVIDERS_PAGE_LEG = 'connected-providers-page'
/**
 * The OAuth acceptance as a whole, so a failure part-way through it has a row
 * of its own carrying the reason. The individual legs below are required and
 * report themselves missing when they never run, which says what did not
 * happen but not why; this says why once.
 */
export const CONNECTED_PROVIDERS_OAUTH_LEG = 'connected-providers-oauth'
export const CONNECTED_PROVIDERS_STAGING_LEGS = [
  'card-connect',
  'device-code-shown',
  'connected-by-label',
  'plan-covered-session',
  'quota-fallback',
  'disconnect',
  'reprovision-preserves-connection',
] as const
export const SUBSCRIPTION_LIFECYCLE_LEGS = [
  'subscription-01-trial-generation',
  'subscription-02-exhaustion-wall-pause',
  'subscription-03-checkout',
  'subscription-04-activation-resume',
  'subscription-05-monthly-first-spend',
  'subscription-06-idempotency-and-topup-invoice',
  'subscription-07-upgrade-and-portal',
  'subscription-08-downgrade-scheduled',
  'subscription-09-cancel-at-period-end',
  'subscription-10-clock-lapse',
  'subscription-11-full-stop-archive-resume',
  'subscription-12-cleanup',
] as const
export const SHARE_JOURNEY_LEGS = [
  'share-request-email',
  'share-deep-link',
  'share-accept',
  'share-file-arrival',
  'share-app-viewer',
  'share-move',
  'share-transient-miss',
  'share-read-repair',
  'share-delete-auto-unlink',
  'share-explicit-unlink',
  'share-revoke',
  'share-cleanup',
] as const
export const REQUIRED_STAGING_LEGS = [
  AGENT_CONTINUITY_LEG,
  AGENT_LIFECYCLE_LEG,
  APP_API_KEYS_LEG,
  SHARE_BYTE_ARRIVAL_LEG,
  APPS_IN_FILE_VIEW_LEG,
  BUILD_APP_LEG,
  DRIVE_DEEP_LINKS_LEG,
  STORAGE_TIER_RESIZE_LEG,
  CONNECTED_PROVIDERS_PAGE_LEG,
  ...SUBSCRIPTION_LIFECYCLE_LEGS,
  ...SHARE_JOURNEY_LEGS,
] as const

/**
 * OAuth-dependent connected-provider legs join the required set only once the
 * fake issuer is provisioned. The settings-page smoke is always required.
 */
export function requiredStagingLegs(env: { fakeOAuthIssuerUrl: string }): readonly string[] {
  return env.fakeOAuthIssuerUrl === ''
    ? REQUIRED_STAGING_LEGS
    : [...REQUIRED_STAGING_LEGS, ...CONNECTED_PROVIDERS_STAGING_LEGS]
}

export function stagingLiveLegsPassed(
  legs: Record<string, LegResult>,
  allowGoogleOAuthSkip = false,
): boolean {
  return (
    requiredStagingLegFailures(legs).length === 0 &&
    Object.entries(legs).every(
      ([name, leg]) =>
        leg.status === 'pass' ||
        (allowGoogleOAuthSkip && name === 'google-oauth' && leg.status === 'skipped'),
    )
  )
}

export function requiredStagingLegFailures(
  legs: Record<string, LegResult>,
  env?: { fakeOAuthIssuerUrl: string },
): string[] {
  const required = env ? requiredStagingLegs(env) : REQUIRED_STAGING_LEGS
  const missing = required.filter(name => legs[name] === undefined)
  return [
    ...missing,
    ...Object.entries(legs)
      .filter(
        ([name, leg]) =>
          name !== 'overall' &&
          leg.status !== 'pass' &&
          !(name === 'google-oauth' && leg.status === 'skipped'),
      )
      .map(([name]) => name),
  ]
}

export function readLiveEnv(source: NodeJS.ProcessEnv = process.env): LiveEnv {
  const missing = REQUIRED_ENV.filter(name => !source[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required staging live env: ${missing.join(', ')}`)
  }
  const agentMailInboxAddress = source.DUET_E2E_AGENTMAIL_INBOX_ADDRESS!.trim().toLowerCase()
  const agentMailInbox2Address =
    source.DUET_E2E_AGENTMAIL_INBOX2_ADDRESS?.trim().toLowerCase() ?? ''
  if (agentMailInbox2Address !== '' && agentMailInboxAddress === agentMailInbox2Address) {
    throw new Error('Staging identity inboxes must be distinct')
  }
  const appUrl = source.DUET_APP_URL!.trim()
  const landerUrl = source.DUET_LANDER_URL!.trim()
  const docsUrl = source.DUET_DOCS_URL?.trim() || 'https://docs-staging.duet.so'
  const mcpUrl = source.DUET_MCP_PUBLIC_URL!.trim()
  const fakeOAuthIssuerUrl = source.DUET_CONNECT_FAKE_ISSUER_URL?.trim() ?? ''
  for (const [name, value] of [
    ['DUET_API_URL', source.DUET_API_URL!],
    ['DUET_APP_URL', appUrl],
    ['DUET_LANDER_URL', landerUrl],
    ['DUET_DOCS_URL', docsUrl],
    ['DUET_MCP_PUBLIC_URL', mcpUrl],
    ['DUET_CONNECT_FAKE_ISSUER_URL', fakeOAuthIssuerUrl],
  ] as const) {
    // Optional until slice 11b provisions the issuer: empty means the
    // connected-providers legs self-skip, so there is nothing to validate.
    if (value === '') continue
    if (!new URL(value).hostname.includes('staging')) {
      throw new Error(`${name} must target a staging hostname`)
    }
  }
  if (!source.STRIPE_SECRET_KEY!.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe test-mode key')
  }
  return {
    apiUrl: source.DUET_API_URL!.replace(/\/+$/, ''),
    appUrl: appUrl.replace(/\/+$/, ''),
    landerUrl: landerUrl.replace(/\/+$/, ''),
    docsUrl: docsUrl.replace(/\/+$/, ''),
    mcpUrl: `${mcpUrl.replace(/\/+$/, '')}/`,
    convexUrl: convexUrlsFromDeployment(source.CONVEX_DEPLOYMENT!).cloudUrl,
    convexSiteUrl: convexUrlsFromDeployment(source.CONVEX_DEPLOYMENT!).siteUrl,
    internalKey: source.DUET_API_INTERNAL_KEY!,
    edgeInternalKey: source.DUET_EDGE_INTERNAL_KEY!,
    loginSecret: source.DUET_PROGRAMMATIC_LOGIN_SECRET!,
    vercelBypassSecret: source.VERCEL_AUTOMATION_BYPASS_SECRET!,
    agentMailApiKey: source.AGENTMAIL_API_KEY!,
    agentMailInboxId: '',
    agentMailInboxAddress,
    agentMailInbox2Id: '',
    agentMailInbox2Address,
    stripeSecretKey: source.STRIPE_SECRET_KEY!,
    stripeWebhookSecret: source.STRIPE_WEBHOOK_SECRET!,
    stripeBillingPortalConfigurationId: source.STRIPE_BILLING_PORTAL_CONFIGURATION_ID!,
    fakeOAuthIssuerUrl: fakeOAuthIssuerUrl.replace(/\/+$/, ''),
    composioApiKey: isUsableStagingCredential(source.COMPOSIO_API_KEY)
      ? source.COMPOSIO_API_KEY!.trim()
      : undefined,
    firecrawlApiKey: isUsableStagingCredential(source.FIRECRAWL_API_KEY)
      ? source.FIRECRAWL_API_KEY!.trim()
      : undefined,
    artifactRoot: source.DUET_E2E_ARTIFACT_DIR?.trim() || path.resolve('artifacts/staging-live'),
    headless: source.DUET_E2E_HEADLESS !== '0',
  }
}

export function isUsableStagingCredential(value: string | undefined): boolean {
  const normalized = value?.trim()
  return normalized !== undefined && normalized.length > 0 && normalized !== 'REPLACE_ME'
}

export function fnMutation(name: string): MutationRef {
  return makeFunctionReference(name) as MutationRef
}

export function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}

export function fnAction(name: string): ActionRef {
  return makeFunctionReference(name) as ActionRef
}
