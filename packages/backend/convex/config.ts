// Backend config knobs. Defaults live here; env vars override per environment,
// read at call time. Values consumed on the workspace VM are still forwarded as
// env by the provisioner (systemd PassEnvironment) — this module owns the
// DEFAULTS, not the delivery. Secrets and required per-deploy inputs
// (DUET_API_URL, DUET_VM_IMAGE_REF) are not config and stay read inline.

import {
  AUTH_SIGN_IN_PATH,
  DUET_STAGING_EDGE_HOST,
  LOCAL_AUTH_ORIGIN,
  MAGIC_LINK_CALLBACK_PATH,
  isEdgeHost,
  type SubscriptionPlanId,
  type DomainTarget,
} from '@repo/contract'

export type Env = NodeJS.ProcessEnv

export const DEFAULT_DUET_APP_URL = 'https://app.duet.so'

export function resendUsersSegmentId(env: Env = process.env): string {
  return env.DUET_RESEND_USERS_SEGMENT_ID ?? '32ebbc90-83e3-408d-b074-b0f6695e9c8d'
}

export function duetAppUrl(env: Env = process.env): string {
  return (env.DUET_APP_URL ?? DEFAULT_DUET_APP_URL).replace(/\/+$/, '')
}

export function duetAppHref(path: string, env: Env = process.env): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Duet app destination must be an absolute path')
  }
  return new URL(path, `${duetAppUrl(env)}/`).toString()
}

export function authRedirectUrl(redirectTo: string, env: Env = process.env): string {
  const appUrl = duetAppUrl(env)
  if (redirectTo.startsWith('?')) return `${appUrl}${redirectTo}`
  if (redirectTo.startsWith('/')) return duetAppHref(redirectTo, env)

  const destination = new URL(redirectTo)
  const appOrigin = new URL(appUrl).origin
  const isConfiguredApp = destination.origin === appOrigin
  const isLocalAuthCallback =
    appOrigin !== new URL(DEFAULT_DUET_APP_URL).origin &&
    destination.origin === LOCAL_AUTH_ORIGIN &&
    (destination.pathname === MAGIC_LINK_CALLBACK_PATH ||
      destination.pathname === AUTH_SIGN_IN_PATH)
  if (!isConfiguredApp && !isLocalAuthCallback) {
    throw new Error(`Invalid auth redirect destination: ${redirectTo}`)
  }
  return destination.toString()
}

/**
 * Refuse to email a sign-in link a human cannot complete.
 *
 * `authRedirectUrl` already rejects a foreign origin, but it cannot see the
 * other half of the hazard: with no `redirectTo` at all, `@convex-dev/auth`
 * falls back to bare `SITE_URL` and emails `https://app.duet.so?code=…`, whose
 * origin is perfectly legal and whose path leads nowhere. Only two paths finish
 * a sign-in — the magic-link callback the browser flow builds, and the sign-in
 * page the agent rail points at — so a link at neither is a bug, not a variant.
 */
export function assertEmailedSignInLink(url: string, env: Env = process.env): void {
  const destination = new URL(authRedirectUrl(url, env))
  if (
    destination.pathname !== MAGIC_LINK_CALLBACK_PATH &&
    destination.pathname !== AUTH_SIGN_IN_PATH
  ) {
    throw new Error(`Emailed sign-in link does not reach a sign-in page: ${url}`)
  }
}

/**
 * The edge host this deployment's public publish URLs live under.
 *
 * Deliberately has NO default, unlike the API's `resolveEdgeHost`, which falls
 * back to the production constant. Convex derives marketplace source URLs, and
 * a default here would hand every staging VM `https://edge.duet.so/...` — the
 * production edge, where the real official hub lives — with no test able to
 * notice. Failing closed turns that silent cross-environment content bleed into
 * a loud misconfiguration.
 */
export function edgeHost(env: Env = process.env): string {
  const value = env.DUET_EDGE_HOST
  if (value === undefined || !isEdgeHost(value)) {
    throw new Error('DUET_EDGE_HOST must be set to a known Duet edge host')
  }
  return value
}

/** The shared edge project uses branch aliases to keep staging off production. */
export function appDomainTarget(env: Env = process.env): DomainTarget {
  return {
    teamId: 'team_I18zdvAznXXwqq1PcIampT1t',
    projectId: 'prj_mPNx8yJ4JRlThnK3NMZOIpeenJjM',
    gitBranch: edgeHost(env) === DUET_STAGING_EDGE_HOST ? 'staging' : null,
  }
}

/**
 * Whether anyone may create a marketplace listing.
 *
 * Ships **closed**. "Hide the publish button" is not a gate: a hidden button
 * over a live mutation is one network-tab read away from being no gate at all,
 * so this is enforced in the Convex mutation itself — below the API route, so
 * internal-admin and harness callers are gated on the same line as the SPA.
 *
 * A code constant flipped by commit, following the convention the 2026-07-22
 * env audit settled: knobs that are the same in every environment live as
 * config defaults, not env vars.
 */
export const MARKETPLACE_PUBLISHING_ENABLED = false

export function marketplacePublishingEnabled(env: Env = process.env): boolean {
  // The env override exists for tests and for a staging soft-open; production
  // flips the constant above by commit.
  const override = env.DUET_MARKETPLACE_PUBLISHING_ENABLED
  if (override === '1') return true
  if (override === '0') return false
  return MARKETPLACE_PUBLISHING_ENABLED
}

export function useSshTransport(env: Env = process.env): boolean {
  return env.DUET_EXE_CREATE_TRANSPORT === 'ssh'
}

export function gatewayExtraHeadersJson(env: Env = process.env): string | undefined {
  return env.DUET_GATEWAY_EXTRA_HEADERS_JSON
}

// Model-gateway origin (paths owned by code). Forwarded to the VM so in-VM
// tooling reaches the same environment's gateway instead of the prod default.
export function modelGatewayUrl(env: Env = process.env): string | undefined {
  return env.DUET_MODEL_GATEWAY_URL
}

export function usageRollupMaxJitterMs(fallback: number, env: Env = process.env): number {
  return Number(env.DUET_USAGE_ROLLUP_MAX_JITTER_MS ?? fallback)
}

export function exeVmTags(env: Env = process.env): string[] {
  return (env.DUET_EXE_VM_TAGS ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0)
}

export function aiGatewayBaseUrl(env: Env = process.env): string | undefined {
  return env.AI_GATEWAY_BASE_URL
}

const STRIPE_SUBSCRIPTION_PRICE_ENV_KEYS = {
  starter: 'STRIPE_STARTER_RECURRING_PRICE_ID',
  pro: 'STRIPE_PRO_RECURRING_PRICE_ID',
  max: 'STRIPE_MAX_RECURRING_PRICE_ID',
} as const satisfies Record<SubscriptionPlanId, keyof Env>

export function stripeSubscriptionPriceIds(
  env: Env = process.env,
): Record<SubscriptionPlanId, string> {
  const entries = Object.entries(STRIPE_SUBSCRIPTION_PRICE_ENV_KEYS).map(([plan, key]) => {
    const value = env[key]
    if (value === undefined || !value.startsWith('price_')) {
      throw new Error(`${key} must be a Stripe price id`)
    }
    return [plan, value] as const
  })
  const uniqueIds = new Set(entries.map(([, priceId]) => priceId))
  if (uniqueIds.size !== entries.length) {
    throw new Error('Stripe subscription price ids must be unique')
  }
  return Object.fromEntries(entries) as Record<SubscriptionPlanId, string>
}

export function stripePlanForPriceId(
  priceId: string,
  env: Env = process.env,
): SubscriptionPlanId | undefined {
  const prices = stripeSubscriptionPriceIds(env)
  return (Object.entries(prices) as Array<[SubscriptionPlanId, string]>).find(
    ([, configuredPriceId]) => configuredPriceId === priceId,
  )?.[0]
}

export function stripeBillingPortalConfigurationId(env: Env = process.env): string {
  const value = env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
  if (value === undefined || !value.startsWith('bpc_')) {
    throw new Error(
      'STRIPE_BILLING_PORTAL_CONFIGURATION_ID must be a Stripe Billing Portal configuration id',
    )
  }
  return value
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/**
 * Whether this deployment is a local one — a harness fixture or a developer's
 * own backend — rather than a cloud deployment serving real people.
 *
 * A Convex function sees its own address: a local backend reports loopback
 * `http://` URLs, cloud reports `https://<name>.convex.{cloud,site}`. It does
 * NOT see `CONVEX_DEPLOYMENT`, which the harness deletes and the function
 * runtime never sets, so the URLs are the only usable signal.
 *
 * Fails closed. A deployment that cannot say where it lives is not local, and
 * the one caller below turns that into a refusal rather than a shrug.
 */
export function isLocalDeployment(env: Env = process.env): boolean {
  const address = env.CONVEX_CLOUD_URL ?? env.CONVEX_SITE_URL
  if (!address) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(address).hostname)
  } catch {
    return false
  }
}

/**
 * The one reader of the test-auth switch, and its guard.
 *
 * `DUET_TEST_AUTH_EMAIL=1` makes `generateVerificationToken` return a fixed
 * constant AND suppresses every outbound email. On a real deployment that is
 * not a test convenience, it is an unauthenticated account takeover of anyone
 * whose address you know, and the victim is never told — the same flag ate the
 * warning. Nothing in `scripts/secret-topology.mjs` pushes it, so the only way
 * it reaches a cloud deployment is a human setting it by hand, which is exactly
 * what this catches.
 *
 * Deliberately NOT a module-scope assertion. `config.ts` is imported by
 * `convex/auth.ts` and the deploy rail runs `convex deploy`; a throw during
 * push-time module analysis would break every deploy for every app on the rail.
 * Reading it here means the check runs when the flag is actually consulted, and
 * a flag nobody consults cannot do harm.
 */
export function testAuthEmailEnabled(env: Env = process.env): boolean {
  if (env.DUET_TEST_AUTH_EMAIL !== '1') return false
  if (!isLocalDeployment(env)) {
    throw new Error(
      'DUET_TEST_AUTH_EMAIL is set on a deployment that is not local. It pins the ' +
        'sign-in code to a constant and silences the emails that would warn anyone. ' +
        'Unset it.',
    )
  }
  return true
}

/**
 * The test-Google credentials provider (`DUET_TEST_AUTH_GOOGLE=1`) mints an
 * account from a profile the caller typed, so it is the same class of door as
 * test-auth email and gets the same guard: loopback only, fail closed.
 */
export function testAuthGoogleEnabled(env: Env = process.env): boolean {
  if (env.DUET_TEST_AUTH_GOOGLE !== '1') return false
  if (!isLocalDeployment(env)) {
    throw new Error(
      'DUET_TEST_AUTH_GOOGLE is set on a deployment that is not local. It mints accounts ' +
        'from a profile the caller typed. Unset it.',
    )
  }
  return true
}

export function useTestFakeStripe(env: Env = process.env): boolean {
  if (env.DUET_TEST_FAKE_STRIPE !== '1') return false
  if (!testAuthEmailEnabled(env)) {
    throw new Error('DUET_TEST_FAKE_STRIPE requires the test auth environment')
  }
  return true
}

/**
 * Whether the signup gate may resolve MX records — its only outbound DNS call.
 *
 * Off in a test-auth environment, which is not a real one (see
 * `useTestFakeStripe`): fixtures sign up as `@example.com`, which publishes a
 * Null MX and would therefore be denied as a non-functional mail domain, and no
 * test should depend on live DNS anyway. `DUET_SIGNUP_MX_LOOKUP=off` is the
 * operational override for a real environment, should DoH ever misbehave.
 *
 * Disabling it denies nobody: the MX rule simply reports nothing, matching the
 * fail-open posture the rest of the gate's evidence takes.
 */
export function signupMxLookupEnabled(env: Env = process.env): boolean {
  if (env.DUET_SIGNUP_MX_LOOKUP === 'off') return false
  return !testAuthEmailEnabled(env)
}

// lastUsedAt on an apiKeys row is a coarse activity indicator, not an audit log.
// authenticate runs on every API request, so patching it each time turns the
// credential doc into a per-request mutation hot row; instead it advances at
// most once per window (staleness bound = this window; minutes, not hours).
export const DEFAULT_API_KEY_LAST_USED_WINDOW_MS = 5 * 60 * 1000

export function apiKeyLastUsedWindowMs(env: Env = process.env): number {
  return Number(env.DUET_API_KEY_LAST_USED_WINDOW_MS ?? DEFAULT_API_KEY_LAST_USED_WINDOW_MS)
}
