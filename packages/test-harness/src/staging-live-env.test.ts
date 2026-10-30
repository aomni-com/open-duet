import { describe, expect, test } from 'bun:test'

import {
  CONNECTED_PROVIDERS_STAGING_LEGS,
  CONNECTED_PROVIDERS_PAGE_LEG,
  DRIVE_DEEP_LINKS_LEG,
  isUsableStagingCredential,
  readLiveEnv,
  REQUIRED_STAGING_LEGS,
  requiredStagingLegFailures,
  STORAGE_TIER_RESIZE_LEG,
} from './staging-live-env'

describe('staging credential readiness', () => {
  test('rejects missing and placeholder values', () => {
    expect(isUsableStagingCredential(undefined)).toBe(false)
    expect(isUsableStagingCredential('')).toBe(false)
    expect(isUsableStagingCredential('  REPLACE_ME  ')).toBe(false)
  })

  test('accepts a configured provider credential', () => {
    expect(isUsableStagingCredential('configured-client-id')).toBe(true)
  })

  test('rejects one mailbox reused for both staging identities', () => {
    const source = liveEnvFixture()
    source.DUET_E2E_AGENTMAIL_INBOX2_ADDRESS = source.DUET_E2E_AGENTMAIL_INBOX_ADDRESS

    expect(() => readLiveEnv(source)).toThrow(/staging identity inboxes must be distinct/i)
  })

  test('allows the proven plus-tag fallback when no second inbox is provisioned', () => {
    const source = liveEnvFixture()
    delete source.DUET_E2E_AGENTMAIL_INBOX2_ADDRESS

    expect(readLiveEnv(source).agentMailInbox2Address).toBe('')
  })

  test('fake issuer URL is optional until provisioned, staging-only when present', () => {
    const source = liveEnvFixture()
    expect(readLiveEnv(source).fakeOAuthIssuerUrl).toBe(
      'https://connected-provider-issuer-staging.duet.so',
    )
    expect(readLiveEnv(source).mcpUrl).toBe('https://mcp-staging.duet.so/')
    expect(
      CONNECTED_PROVIDERS_STAGING_LEGS.every(leg =>
        requiredStagingLegFailures(
          {},
          { fakeOAuthIssuerUrl: 'https://x-staging.duet.so' },
        ).includes(leg),
      ),
    ).toBe(true)

    // Absent: legs self-skip and env-read must not throw (slice 11b pending).
    delete source.DUET_CONNECT_FAKE_ISSUER_URL
    expect(readLiveEnv(source).fakeOAuthIssuerUrl).toBe('')
    expect(
      CONNECTED_PROVIDERS_STAGING_LEGS.some(leg =>
        requiredStagingLegFailures({}, { fakeOAuthIssuerUrl: '' }).includes(leg),
      ),
    ).toBe(false)

    source.DUET_CONNECT_FAKE_ISSUER_URL = 'https://issuer.example.com'
    expect(() => readLiveEnv(source)).toThrow('must target a staging hostname')
  })

  test('requires the connected-provider settings page even without the OAuth fixture', () => {
    expect(requiredStagingLegFailures({}, { fakeOAuthIssuerUrl: '' })).toContain(
      CONNECTED_PROVIDERS_PAGE_LEG,
    )
  })

  test('full staging requires Drive deep links and storage tier resize', () => {
    expect(REQUIRED_STAGING_LEGS).toContain(DRIVE_DEEP_LINKS_LEG)
    expect(REQUIRED_STAGING_LEGS).toContain(STORAGE_TIER_RESIZE_LEG)
    expect(requiredStagingLegFailures({})).toContain(DRIVE_DEEP_LINKS_LEG)
    expect(requiredStagingLegFailures({})).toContain(STORAGE_TIER_RESIZE_LEG)
  })
})

function liveEnvFixture(): NodeJS.ProcessEnv {
  return {
    DUET_API_URL: 'https://api-staging.duet.so',
    DUET_APP_URL: 'https://app-staging.duet.so',
    DUET_LANDER_URL: 'https://staging.duet.so',
    DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so/',
    CONVEX_DEPLOYMENT: 'dev:fixture-deployment',
    DUET_API_INTERNAL_KEY: 'internal-key',
    DUET_EDGE_INTERNAL_KEY: 'edge-key',
    DUET_PROGRAMMATIC_LOGIN_SECRET: 'login-secret',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
    AGENTMAIL_API_KEY: 'agentmail-key',
    DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'first@agentmail.to',
    DUET_E2E_AGENTMAIL_INBOX2_ADDRESS: 'second@agentmail.to',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_fixture',
    DUET_CONNECT_FAKE_ISSUER_URL: 'https://connected-provider-issuer-staging.duet.so',
  }
}
