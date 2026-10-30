import { expect, test } from 'bun:test'

import {
  collectAppApiKeyDiagnostics,
  observeAppKeyRevocation,
} from '../fixtures/staging-app-api-key-service.ts'
import {
  parseAppApiKeyDiagnostics,
  parseAppKeyRevocationDiagnostic,
} from './staging-live-app-api-keys.ts'
import { APP_API_KEYS_LEG, requiredStagingLegFailures } from './staging-live-env.ts'

test('validates app API-key diagnostics, strips unknowns, and rejects exposed secrets', () => {
  expect(
    parseAppApiKeyDiagnostics({
      appApiKeyPresent: true,
      apiUrlPresent: true,
      provisioningTokenAbsent: true,
      allowedCallSucceeded: true,
      undeclaredCallRejected: true,
      workspaceAuthorityLocal: true,
    }),
  ).toEqual({
    appApiKeyPresent: true,
    apiUrlPresent: true,
    provisioningTokenAbsent: true,
    allowedCallSucceeded: true,
    undeclaredCallRejected: true,
    workspaceAuthorityLocal: true,
  })
  expect(
    parseAppApiKeyDiagnostics({
      appApiKeyPresent: true,
      apiUrlPresent: true,
      provisioningTokenAbsent: true,
      allowedCallSucceeded: true,
      undeclaredCallRejected: true,
      workspaceAuthorityLocal: true,
      futureDiagnostic: 'ignored',
    }),
  ).toEqual({
    appApiKeyPresent: true,
    apiUrlPresent: true,
    provisioningTokenAbsent: true,
    allowedCallSucceeded: true,
    undeclaredCallRejected: true,
    workspaceAuthorityLocal: true,
  })
  expect(() =>
    parseAppApiKeyDiagnostics({
      appApiKeyPresent: true,
      apiUrlPresent: true,
      provisioningTokenAbsent: true,
      allowedCallSucceeded: true,
      undeclaredCallRejected: true,
      workspaceAuthorityLocal: true,
      apiKey: 'must-not-cross-the-seam',
    }),
  ).toThrow('must never expose apiKey')
  expect(() =>
    parseAppApiKeyDiagnostics({
      appApiKeyPresent: 'true',
      apiUrlPresent: true,
      provisioningTokenAbsent: true,
      allowedCallSucceeded: true,
      undeclaredCallRejected: true,
      workspaceAuthorityLocal: true,
    }),
  ).toThrow('owned boolean-only fields')
})

test('the fixture proves authentication and an undeclared capability without exposing values', async () => {
  const requests: Array<{ url: string; authorizationPresent: boolean }> = []
  const diagnostics = await collectAppApiKeyDiagnostics(
    {
      DUET_APP_API_KEY: 'fixture-app-key',
      DUET_API_URL: 'https://ctl-staging.duet.so/',
      DUET_PROVISIONING_TOKEN: undefined,
    },
    'fixture-workspace',
    async (input, init) => {
      const url = String(input)
      requests.push({
        url,
        authorizationPresent:
          new Headers(init?.headers).get('authorization') === 'Bearer fixture-app-key',
      })
      if (url.endsWith('/v1/whoami')) {
        return Response.json({ workspaces: [{ slug: 'fixture-workspace' }] })
      }
      return Response.json({ error: 'insufficient_scope' }, { status: 403 })
    },
  )

  expect(diagnostics).toEqual({
    appApiKeyPresent: true,
    apiUrlPresent: true,
    provisioningTokenAbsent: true,
    allowedCallSucceeded: true,
    undeclaredCallRejected: true,
    workspaceAuthorityLocal: true,
  })
  expect(requests).toEqual([
    {
      url: 'https://ctl-staging.duet.so/v1/whoami',
      authorizationPresent: true,
    },
    {
      url: 'https://ctl-staging.duet.so/v1/ws/fixture-workspace/apps',
      authorizationPresent: true,
    },
  ])
})

test('the app API-key journey is a required staging leg', () => {
  expect(requiredStagingLegFailures({})).toContain(APP_API_KEYS_LEG)
})

test('the revocation probe retains its boolean and strips unknowns', () => {
  expect(parseAppKeyRevocationDiagnostic({ priorKeyRejected: true })).toEqual({
    priorKeyRejected: true,
  })
  expect(parseAppKeyRevocationDiagnostic({ priorKeyRejected: true, status: 401 })).toEqual({
    priorKeyRejected: true,
  })
})

test('the fixture accepts revocation only after the prior key authenticated', async () => {
  const statuses = [200, 401]
  const sleeps: number[] = []
  let recorded = false

  await expect(
    observeAppKeyRevocation(
      {
        DUET_APP_API_KEY: 'fixture-app-key',
        DUET_API_URL: 'https://ctl-staging.duet.so',
      },
      {
        fetchImpl: async () => new Response(null, { status: statuses.shift() ?? 401 }),
        sleep: async milliseconds => {
          sleeps.push(milliseconds)
        },
        attempts: 2,
        recordRevoked: async () => {
          recorded = true
        },
      },
    ),
  ).resolves.toBe(true)
  expect(sleeps).toHaveLength(1)
  expect(sleeps[0]).toBeGreaterThan(0)
  expect(recorded).toBe(true)

  await expect(
    observeAppKeyRevocation(
      {
        DUET_APP_API_KEY: 'fixture-app-key',
        DUET_API_URL: 'https://ctl-staging.duet.so',
      },
      {
        fetchImpl: async () => new Response(null, { status: 401 }),
        sleep: async () => undefined,
        attempts: 1,
      },
    ),
  ).resolves.toBe(false)
})
