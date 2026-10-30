import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayAppConfig } from '@repo/contract'

import {
  APP_CREDENTIAL_REFRESH_WINDOW_MS,
  appCredentialsPath,
  createAppCredentialStore,
} from './app-credentials'
import { REDACTION_MASK, redactText } from './redaction'

const scratchDirs = new Set<string>()
afterEach(async () => {
  await Promise.all([...scratchDirs].map(dir => rm(dir, { recursive: true, force: true })))
  scratchDirs.clear()
})

async function scratchStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
  scratchDirs.add(dir)
  return dir
}

test('app credentials persist with mode 0600 and reload by app id', async () => {
  const stateDir = await scratchStateDir()
  const store = createAppCredentialStore(stateDir)

  store.acceptResponse({
    appCredentials: [
      {
        appId: 'app-one',
        apiKey: 'duet_app_persisted_secret',
        scopes: ['files:read'],
        expiresAt: 200_000,
      },
    ],
  })

  expect((await stat(appCredentialsPath(stateDir))).mode & 0o777).toBe(0o600)
  expect(createAppCredentialStore(stateDir).envForApp('app-one')).toEqual({
    DUET_APP_API_KEY: 'duet_app_persisted_secret',
  })
})

test('neededAppIds asks only for missing, stale-scope, or refresh-window credentials', async () => {
  const stateDir = await scratchStateDir()
  const store = createAppCredentialStore(stateDir)
  const now = 1_000_000
  store.acceptResponse({
    appCredentials: [
      credential('fresh', ['files:read'], now + APP_CREDENTIAL_REFRESH_WINDOW_MS + 1),
      credential('refresh', ['files:read'], now + APP_CREDENTIAL_REFRESH_WINDOW_MS),
      credential('stale-scope', ['files:read'], now + 2 * APP_CREDENTIAL_REFRESH_WINDOW_MS),
    ],
  })

  expect(
    store.neededAppIds(
      [
        app('fresh', ['files:read']),
        app('refresh', ['files:read']),
        app('stale-scope', ['files:write']),
        app('missing', ['sessions']),
        app('empty', []),
      ],
      now,
    ),
  ).toEqual(['missing', 'refresh', 'stale-scope'])
  expect(store.envForApp('stale-scope')).toEqual({ DUET_APP_API_KEY: 'secret-stale-scope' })
})

test('authoritative app reconciliation prunes removed apps and changed scopes', async () => {
  const stateDir = await scratchStateDir()
  const store = createAppCredentialStore(stateDir)
  store.acceptResponse({
    appCredentials: [
      credential('kept', ['files:read'], 10_000_000),
      credential('removed', ['files:read'], 10_000_000),
      credential('changed', ['files:read'], 10_000_000),
    ],
  })

  store.reconcileDesiredApps([app('kept', ['files:read']), app('changed', ['files:write'])])

  const reloaded = createAppCredentialStore(stateDir)
  expect(reloaded.envForApp('kept')).toEqual({ DUET_APP_API_KEY: 'secret-kept' })
  expect(reloaded.envForApp('removed')).toBeNull()
  expect(reloaded.envForApp('changed')).toBeNull()
})

test('accepted and loaded app keys register as runtime redaction secrets', async () => {
  const stateDir = await scratchStateDir()
  const acceptedSecret = 'accepted-app-key-unique-for-redaction'
  createAppCredentialStore(stateDir).acceptResponse({
    appCredentials: [credential('accepted', ['files:read'], 10_000_000, acceptedSecret)],
  })
  expect(redactText(`value=${acceptedSecret}`)).toBe(`value=${REDACTION_MASK}`)

  const loadedSecret = 'loaded-app-key-unique-for-redaction'
  await writeFile(
    appCredentialsPath(stateDir),
    JSON.stringify({ loaded: credential('loaded', ['sessions'], 10_000_000, loadedSecret) }),
    { mode: 0o600 },
  )
  createAppCredentialStore(stateDir)
  expect(redactText(`value=${loadedSecret}`)).toBe(`value=${REDACTION_MASK}`)
})

test('onChange names only first-delivered and rotated app credentials', async () => {
  const stateDir = await scratchStateDir()
  const store = createAppCredentialStore(stateDir)
  const changed: string[] = []
  store.onChange(appId => changed.push(appId))

  store.acceptResponse({ appCredentials: [credential('one', ['files:read'], 10_000)] })
  store.acceptResponse({ appCredentials: [credential('two', ['sessions'], 10_000)] })
  store.acceptResponse({ appCredentials: [credential('one', ['files:read'], 20_000)] })
  store.acceptResponse({
    appCredentials: [credential('one', ['files:read'], 20_000, 'rotated-one')],
  })

  expect(changed).toEqual(['one', 'two', 'one'])
})

function credential(
  appId: string,
  scopes: string[],
  expiresAt: number,
  apiKey = `secret-${appId}`,
) {
  return { appId, apiKey, scopes, expiresAt }
}

function app(appId: string, apiScopes: GatewayAppConfig['apiScopes']): GatewayAppConfig {
  return {
    appId,
    slug: appId,
    command: 'bun app.ts',
    port: 4_000,
    anchorPath: `apps/${appId}`,
    apiScopes,
  }
}
