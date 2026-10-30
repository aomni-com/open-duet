import { describe, expect, test } from 'bun:test'

import {
  readWorkspaceBrowserEnv,
  workspaceBrowserLoginRequest,
  workspaceBrowserJourneyEmail,
  workspaceBrowserOwnerName,
} from './staging-live-workspace-browser'
import { readWorkspaceJourneyEnv } from './staging-live-workspace-env'

describe('workspace-browser journey fixture', () => {
  test('workspace-agent configuration excludes browser-only settings', () => {
    const env = readWorkspaceJourneyEnv({
      DUET_API_URL: 'https://api-staging.duet.so',
      DUET_DOCS_URL: 'https://fixture-staging.example.test///',
      CONVEX_DEPLOYMENT: 'dev:fixture-deployment',
      DUET_API_INTERNAL_KEY: 'internal-key',
      DUET_PROGRAMMATIC_LOGIN_SECRET: 'login-secret',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      AGENTMAIL_API_KEY: 'agentmail-key',
      DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'Fixture@agentmail.to',
    })

    expect(env.apiUrl).toBe('https://api-staging.duet.so')
    expect(env.agentMailApiKey).toBe('agentmail-key')
    expect(env.agentMailInboxAddress).toBe('fixture@agentmail.to')
    expect(env.docsUrl).toBe('https://fixture-staging.example.test')
    expect(env).not.toHaveProperty('appUrl')
    expect(env).not.toHaveProperty('headless')
  })

  test('workspace-browser configuration adds only browser settings', () => {
    const env = readWorkspaceBrowserEnv({
      DUET_API_URL: 'https://api-staging.duet.so',
      DUET_DOCS_URL: 'https://fixture-staging.example.test///',
      DUET_APP_URL: 'https://app-staging.duet.so',
      DUET_E2E_HEADLESS: '0',
      CONVEX_DEPLOYMENT: 'dev:fixture-deployment',
      DUET_API_INTERNAL_KEY: 'internal-key',
      DUET_PROGRAMMATIC_LOGIN_SECRET: 'login-secret',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      AGENTMAIL_API_KEY: 'agentmail-key',
      DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'fixture@agentmail.to',
    })

    expect(env.appUrl).toBe('https://app-staging.duet.so')
    expect(env.docsUrl).toBe('https://fixture-staging.example.test')
    expect(env.headless).toBe(false)
  })

  test('uses the staging cleanup-safe synthetic admin identity shape', () => {
    expect(workspaceBrowserJourneyEmail('staging-e2e-drive-deep-links-run')).toBe(
      'staging-e2e-drive-deep-links-run-admin@duet.so',
    )
  })

  test('passes an explicitly selected workspace slug through the login-as contract', () => {
    const { ttlSeconds, ...request } = workspaceBrowserLoginRequest({
      email: 'fixture@agentmail.to',
      name: 'Fixture staging run',
      workspaceSlug: 'official-apps-abc123-s-workspace',
    })
    expect(ttlSeconds).toBeGreaterThan(0)
    expect(request).toEqual({
      email: 'fixture@agentmail.to',
      create: true,
      ephemeral: true,
      name: 'official-apps-abc123',
      workspaceSlug: 'official-apps-abc123-s-workspace',
    })
    expect(
      workspaceBrowserLoginRequest({
        email: 'fixture@agentmail.to',
        name: 'Fixture staging run',
      }),
    ).not.toHaveProperty('workspaceSlug')
    expect(() =>
      workspaceBrowserLoginRequest({
        email: 'fixture@agentmail.to',
        name: 'Fixture staging run',
        workspaceSlug: 'Not a workspace slug',
      }),
    ).toThrow(/Invalid slug: invalid_grammar/)
    expect(workspaceBrowserOwnerName('official-apps-abc123-s-workspace')).toBe(
      'official-apps-abc123',
    )
    expect(() => workspaceBrowserOwnerName('valid-but-not-bootstrap-derived')).toThrow(
      'must end in -s-workspace',
    )
  })
})
