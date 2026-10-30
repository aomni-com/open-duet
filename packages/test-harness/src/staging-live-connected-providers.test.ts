import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertConnectedProvidersStagingPreflight,
  assertNoOAuthTokenArtifacts,
  runConnectedProvidersSequence,
  runConnectedProvidersJourney,
} from './staging-live-connected-providers.ts'
import { CONNECTED_PROVIDERS_STAGING_LEGS } from './staging-live-env.ts'

describe('connected-provider staging journey units', () => {
  test('awaits each declared leg before reporting it and always cleans up', async () => {
    const calls: string[] = []
    const passed: string[] = []
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const actions = Object.fromEntries(
      CONNECTED_PROVIDERS_STAGING_LEGS.map(name => [
        name,
        async () => {
          calls.push(name)
          if (name === CONNECTED_PROVIDERS_STAGING_LEGS[0]) {
            firstStarted.resolve()
            await releaseFirst.promise
          }
        },
      ]),
    ) as Record<(typeof CONNECTED_PROVIDERS_STAGING_LEGS)[number], () => Promise<void>>

    const completed = runConnectedProvidersSequence({
      actions,
      pass: leg => passed.push(leg),
      cleanup: async () => {
        calls.push('cleanup')
      },
    })

    try {
      await firstStarted.promise
      expect(calls).toEqual([CONNECTED_PROVIDERS_STAGING_LEGS[0]])
      expect(passed).toEqual([])
    } finally {
      releaseFirst.resolve()
      await completed
    }
    expect(calls).toEqual([...CONNECTED_PROVIDERS_STAGING_LEGS, 'cleanup'])
    expect(passed).toEqual([...CONNECTED_PROVIDERS_STAGING_LEGS])
  })

  test('does not report later legs after a failure and still invokes cleanup', async () => {
    const calls: string[] = []
    const passed: string[] = []
    const actions = Object.fromEntries(
      CONNECTED_PROVIDERS_STAGING_LEGS.map(name => [
        name,
        async () => {
          calls.push(name)
          if (name === 'plan-covered-session') throw new Error('fixture failure')
        },
      ]),
    ) as Record<(typeof CONNECTED_PROVIDERS_STAGING_LEGS)[number], () => Promise<void>>

    await expect(
      runConnectedProvidersSequence({
        actions,
        pass: leg => passed.push(leg),
        cleanup: async () => {
          calls.push('cleanup')
        },
      }),
    ).rejects.toThrow('fixture failure')
    expect(passed).toEqual(['card-connect', 'device-code-shown', 'connected-by-label'])
    expect(calls).toEqual([
      'card-connect',
      'device-code-shown',
      'connected-by-label',
      'plan-covered-session',
      'cleanup',
    ])
  })

  test('rejects token-bearing journey artifacts while accepting redacted evidence', async () => {
    const directory = join('/tmp', `duet-connected-provider-artifacts-${crypto.randomUUID()}`)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(
        join(directory, 'evidence.json'),
        '{"provider":"openai-codex","access_token":"[REDACTED_CREDENTIAL]"}',
      )
      await assertNoOAuthTokenArtifacts(directory)
      await writeFile(join(directory, 'trace.txt'), '{"refresh_token":"fixture-refresh-token"}')
      await expect(assertNoOAuthTokenArtifacts(directory)).rejects.toThrow('trace.txt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('preflight rejects carrying the fake issuer beside production product origins', () => {
    expect(() =>
      assertConnectedProvidersStagingPreflight(
        {
          fakeOAuthIssuerUrl: 'https://connected-provider-issuer-staging.duet.so',
          apiUrl: 'https://api-staging.duet.so',
          appUrl: 'https://app-staging.duet.so',
        },
        {
          DUET_CONNECT_FAKE_ISSUER_URL: 'https://connected-provider-issuer-staging.duet.so',
          DUET_API_URL: 'https://api.duet.so',
          DUET_APP_URL: 'https://app.duet.so',
        },
      ),
    ).toThrow('must be absent from production')
  })
})

test('focused journey demands the fake issuer env instead of skipping', async () => {
  const saved = process.env.DUET_CONNECT_FAKE_ISSUER_URL
  delete process.env.DUET_CONNECT_FAKE_ISSUER_URL
  try {
    await expect(runConnectedProvidersJourney()).rejects.toThrow(
      /requires DUET_CONNECT_FAKE_ISSUER_URL/,
    )
  } finally {
    if (saved !== undefined) process.env.DUET_CONNECT_FAKE_ISSUER_URL = saved
  }
})
