import { describe, expect, test } from 'bun:test'

import type { OAuthConsentInspectResponse } from '@repo/contract'

import {
  approveOAuthConsent,
  autoSelectedOAuthWorkspaceSlug,
  denyOAuthConsent,
  oauthAuthorizationRequestId,
  oauthAuthorizationReturnTo,
} from './controller'

const inspection = {
  status: 'pending',
  client: { id: 'client_1', name: 'Example CLI' },
  redirect: { hostname: 'client.example', localhost: false },
  capabilities: ['files:read'],
  workspaces: [{ slug: 'personal', name: 'Personal', role: 'owner' }],
  expiresAt: 2_000_000_000_000,
} satisfies OAuthConsentInspectResponse

describe('OAuth consent controller', () => {
  test('reads only the opaque request handle from the browser URL', () => {
    const params = new URLSearchParams({
      request: 'opaque-request',
      redirect_uri: 'https://attacker.example/callback',
      client_name: 'Trusted-looking client',
      workspaceSlug: 'attacker-workspace',
    })

    expect(oauthAuthorizationRequestId(params)).toBe('opaque-request')
    expect(oauthAuthorizationReturnTo('opaque/request?attacker=true')).toBe(
      '/oauth/authorize?request=opaque%2Frequest%3Fattacker%3Dtrue',
    )
  })

  test('auto-selects only an exactly-one eligible workspace', () => {
    expect(autoSelectedOAuthWorkspaceSlug(inspection)).toBe('personal')
    expect(
      autoSelectedOAuthWorkspaceSlug({
        ...inspection,
        workspaces: [...inspection.workspaces, { slug: 'acme', name: 'Acme', role: 'editor' }],
      }),
    ).toBeUndefined()
  })

  test('approves the selected workspace and navigates only to the server completion URL', async () => {
    const approvals: Array<{ requestId: string; workspaceSlug: string }> = []
    const navigations: string[] = []
    const api = {
      approveOAuthAuthorization: async (requestId: string, workspaceSlug: string) => {
        approvals.push({ requestId, workspaceSlug })
        return { redirectUrl: 'https://client.example/callback?code=server-built&state=trusted' }
      },
    }

    await approveOAuthConsent(api, 'opaque-request', 'personal', url => navigations.push(url))

    expect(approvals).toEqual([{ requestId: 'opaque-request', workspaceSlug: 'personal' }])
    expect(navigations).toEqual(['https://client.example/callback?code=server-built&state=trusted'])
  })

  test('denies and navigates only to the server completion URL', async () => {
    const navigations: string[] = []
    const api = {
      denyOAuthAuthorization: async () => ({
        redirectUrl: 'https://client.example/callback?error=access_denied&state=trusted',
      }),
    }

    await denyOAuthConsent(api, 'opaque-request', url => navigations.push(url))

    expect(navigations).toEqual([
      'https://client.example/callback?error=access_denied&state=trusted',
    ])
  })
})
