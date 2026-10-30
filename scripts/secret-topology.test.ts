import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CONVEX_DEPLOYMENT_OWNED,
  KNOWN_TARGET_UNMANAGED,
  SECRETS,
  SOURCE_ONLY,
} from './secret-topology.mjs'

const REPO_ROOT = path.resolve(import.meta.dir, '..')

function vercelTargets(key: keyof typeof SECRETS): string[] {
  return [...SECRETS[key].vercel].sort()
}

function envKeys(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(line => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1] ?? [])
}

describe('secret topology', () => {
  test('shares one PostHog project across lander and product', () => {
    expect(vercelTargets('NEXT_PUBLIC_POSTHOG_KEY')).toEqual(['lander', 'web'])
    expect(vercelTargets('NEXT_PUBLIC_POSTHOG_HOST')).toEqual(['lander', 'web'])
  })

  test('the auth signing keypair is unpushable but still required on the deployment', () => {
    // Production once ran for weeks with no keypair at all: the rail never
    // pushes it (each deployment generates its own), so its absence looked
    // exactly like every other var the rail does not own. Convex signs every
    // session token with JWT_PRIVATE_KEY and publishes JWKS for verification --
    // a deployment missing them cannot sign anyone in, by any provider.
    for (const key of CONVEX_DEPLOYMENT_OWNED) {
      expect(key in SECRETS).toBeFalse()
      expect(KNOWN_TARGET_UNMANAGED.has(key)).toBeTrue()
    }
    expect([...CONVEX_DEPLOYMENT_OWNED].sort()).toEqual(['JWKS', 'JWT_PRIVATE_KEY'])
  })

  test('derives server-only PostHog names for the Convex sink', () => {
    expect(SECRETS.POSTHOG_API_KEY).toEqual({
      vercel: [],
      convex: true,
      valueFrom: 'NEXT_PUBLIC_POSTHOG_KEY',
    })
    expect(SECRETS.POSTHOG_HOST).toEqual({
      vercel: [],
      convex: true,
      valueFrom: 'NEXT_PUBLIC_POSTHOG_HOST',
    })
  })

  test('fans one canonical MCP public origin to every advertising and enforcing service', () => {
    expect(vercelTargets('DUET_MCP_PUBLIC_URL')).toEqual(['api', 'lander', 'mcp', 'web'])
  })

  test('fans one canonical API origin to every publisher and consumer', () => {
    expect('DUET_API_PUBLIC_URL' in SECRETS).toBeFalse()
    expect(vercelTargets('DUET_API_URL')).toEqual(['api', 'lander', 'mcp', 'web'])
  })

  test('the lander owns anonymous campaign actions end to end', () => {
    expect('NEXT_PUBLIC_GTM_CONTAINER_ID' in SECRETS).toBeFalse()
    // The API's train scraper and the lander still call Firecrawl directly;
    // catalogued proxy calls use the vault copy.
    expect(vercelTargets('FIRECRAWL_API_KEY')).toEqual(['api', 'lander'])
    expect(vercelTargets('AI_GATEWAY_API_KEY')).toEqual(['lander', 'model-gateway'])
    expect(vercelTargets('CONVEX_DEPLOYMENT')).toContain('lander')
    expect(vercelTargets('DUET_API_INTERNAL_KEY')).toContain('lander')
  })

  test('keeps catalog vendor credentials out of the API environment after vault cutover', () => {
    expect(vercelTargets('FIRECRAWL_API_KEY')).toEqual(['api', 'lander'])
    for (const key of [
      'CRUSTDATA_API_KEY',
      'FULLENRICH_API_KEY',
      'DATAFORSEO_BASE64_PASSWORD',
      'ELEVENLABS_API_KEY',
      'SOCIALAPI_API_KEY',
    ] as const) {
      expect(key in SECRETS).toBeFalse()
      expect(SOURCE_ONLY.get(key)).toEqual(new Set(['staging', 'production']))
    }
  })

  test('the campaign handoff carries no signing secret', () => {
    // The handoff value is the raw attribution row ID; the row's own state
    // authorizes it, so no per-env signing secret exists to fan out.
    expect('DUET_CAMPAIGN_HANDOFF_SECRET' in SECRETS).toBeFalse()
  })

  test('keeps optional advertising delivery credentials server-only', () => {
    for (const key of [
      'META_CONVERSIONS_ACCESS_TOKEN',
      'GOOGLE_DATA_MANAGER_CLIENT_ID',
      'GOOGLE_DATA_MANAGER_CLIENT_SECRET',
      'GOOGLE_DATA_MANAGER_REFRESH_TOKEN',
      'REDDIT_CONVERSIONS_ACCESS_TOKEN',
      'OPENAI_CONVERSIONS_API_KEY',
    ] as const) {
      expect(SECRETS[key]).toEqual({
        vercel: [],
        convex: true,
        optional: true,
      })
    }
  })

  test('never routes login, auth, or billing secrets to lander', () => {
    const forbidden = [
      'DUET_PROGRAMMATIC_LOGIN_SECRET',
      'DUET_EDGE_INTERNAL_KEY',
      'AUTH_GOOGLE_ID',
      'AUTH_GOOGLE_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'COMPOSIO_API_KEY',
    ] as const

    for (const key of forbidden) expect(vercelTargets(key)).not.toContain('lander')
  })

  test('shares the private app launch signing key between its API issuer and edge verifier', () => {
    expect(vercelTargets('DUET_EDGE_INTERNAL_KEY')).toEqual(['api', 'edge'])
  })

  test('keeps live acceptance credentials in the staging source only', () => {
    const production = envKeys(path.join(REPO_ROOT, '.env.production'))
    const staging = envKeys(path.join(REPO_ROOT, '.env.staging'))

    for (const key of [
      'AGENTMAIL_API_KEY',
      'DUET_E2E_AGENTMAIL_INBOX_ADDRESS',
      'DUET_E2E_AGENTMAIL_INBOX2_ADDRESS',
      'VERCEL_AUTOMATION_BYPASS_SECRET',
    ]) {
      const environments = SOURCE_ONLY.get(key)
      expect(environments).toEqual(new Set(['staging']))
      expect(production).not.toContain(key)
      expect(staging).toContain(key)
    }
  })

  test('declares production release probe configuration as source-only', () => {
    expect(SOURCE_ONLY.get('DUET_RELEASE_PROBE_WORKSPACE_SLUG')).toEqual(new Set(['production']))
    expect(SOURCE_ONLY.get('DUET_DOCS_URL')).toEqual(new Set(['production']))
  })

  test('splits the Fingerprint keys by who must not see the server key', () => {
    // The browser key identifies and cannot authorize, so it ships to the web
    // bundle. The server key resolves identification events and stays Convex-only
    // because the signup gate runs there, not in a Next route.
    expect(SECRETS.FINGERPRINT_API_KEY).toEqual({ vercel: [], convex: true })
    expect(SECRETS.NEXT_PUBLIC_FINGERPRINT_API_KEY).toEqual({
      vercel: ['web'],
      convex: false,
    })
  })

  test('keeps the signup gate exemption list out of production', () => {
    // Synthetic identities exist only for live acceptance; production has none,
    // so an exemption list there would be a hole with no purpose.
    expect(SECRETS.DUET_SIGNUP_TEST_IDENTITIES).toEqual({
      vercel: [],
      convex: true,
      environments: ['staging'],
    })
    expect(envKeys(path.join(REPO_ROOT, '.env.production'))).not.toContain(
      'DUET_SIGNUP_TEST_IDENTITIES',
    )
  })

  test('routes the fake issuer only through staging Convex and never production', () => {
    expect(SECRETS.DUET_CONNECT_FAKE_ISSUER_URL).toEqual({
      vercel: [],
      convex: true,
      environments: ['staging'],
    })
    expect(envKeys(path.join(REPO_ROOT, '.env.production'))).not.toContain(
      'DUET_CONNECT_FAKE_ISSUER_URL',
    )
  })

  test('the Convex deploy key reaches the API project; the manual-push creds fan nowhere', () => {
    // The rail's only in-build credential is the Convex deploy key.
    expect(SECRETS.CONVEX_DEPLOY_KEY).toEqual({
      vercel: ['api'],
      convex: false,
      optional: true,
    })
    // Vercel token + dotenvx keys authenticate the out-of-band `secrets:push`
    // only; they must never be fanned to any project.
    expect(SECRETS.VERCEL_TOKEN).toEqual({ vercel: [], convex: false, optional: true })
    expect(SECRETS.DOTENV_PRIVATE_KEY_STAGING).toEqual({
      vercel: [],
      convex: false,
      environments: ['staging'],
      optional: true,
    })
    expect(SECRETS.DOTENV_PRIVATE_KEY_PRODUCTION).toEqual({
      vercel: [],
      convex: false,
      environments: ['production'],
      optional: true,
    })
  })
})

test('delivers custom-domain authority only to the backend provider owner', () => {
  expect(SECRETS.DUET_VERCEL_DOMAINS_TOKEN).toEqual({
    vercel: [],
    convex: true,
    optional: true,
  })
  expect(SECRETS.VERCEL_TOKEN).toEqual({ vercel: [], convex: false, optional: true })
})
