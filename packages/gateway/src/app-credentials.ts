import {
  VmAppCredentialsSchema,
  sameApiScopes,
  type GatewayAppConfig,
  type VmAppCredentials,
} from '@repo/contract'

import { createPersistedJsonStore, persistedStorePath } from './persisted-store'
import { registerRedactionSecret } from './redaction'

export const APP_CREDENTIALS_FILE = 'app-credentials.json'
export const APP_CREDENTIAL_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000

export type AppCredentialEnv = { DUET_APP_API_KEY: string }

export interface AppCredentialStore {
  acceptResponse(body: unknown): void
  reconcileDesiredApps(desiredApps: readonly GatewayAppConfig[]): void
  neededAppIds(desiredApps: readonly GatewayAppConfig[], now?: number): string[]
  envForApp(appId: string): AppCredentialEnv | null
  onChange(listener: (appId: string) => void): () => void
}

type StoredAppCredentials = Record<string, VmAppCredentials>

export function createAppCredentialStore(stateDir: string): AppCredentialStore {
  const listeners = new Set<(appId: string) => void>()
  const store = createPersistedJsonStore<StoredAppCredentials>({
    stateDir,
    fileName: APP_CREDENTIALS_FILE,
    initial: {},
    parseResponse: parseCredentialEnvelope,
    parsePersisted: parsePersistedCredentials,
    snapshot: credentials => ({ ...credentials }),
    onLoad: registerCredentialSecrets,
    onAccept: registerCredentialSecrets,
  })

  return {
    acceptResponse(body: unknown): void {
      const accepted = parseCredentialEnvelope(body)
      if (accepted === null) return
      const previous = store.current()
      store.acceptResponse({ appCredentials: Object.values({ ...previous, ...accepted }) })
      for (const [appId, credential] of Object.entries(accepted)) {
        if (previous[appId]?.apiKey === credential.apiKey) continue
        for (const listener of listeners) listener(appId)
      }
    },

    reconcileDesiredApps(desiredApps: readonly GatewayAppConfig[]): void {
      const current = store.current()
      const desiredById = new Map(desiredApps.map(app => [app.appId, app]))
      const retained = Object.fromEntries(
        Object.entries(current).filter(([appId, credential]) => {
          const desired = desiredById.get(appId)
          return (
            desired !== undefined &&
            desired.apiScopes.length > 0 &&
            sameApiScopes(credential.scopes, desired.apiScopes)
          )
        }),
      )
      if (Object.keys(retained).length !== Object.keys(current).length) {
        store.acceptResponse({ appCredentials: Object.values(retained) })
      }
    },

    neededAppIds(desiredApps: readonly GatewayAppConfig[], now = Date.now()): string[] {
      const current = store.current()
      return desiredApps
        .filter(app => {
          if (app.apiScopes.length === 0) return false
          const credential = current[app.appId]
          return (
            credential === undefined ||
            !sameApiScopes(credential.scopes, app.apiScopes) ||
            credential.expiresAt <= now + APP_CREDENTIAL_REFRESH_WINDOW_MS
          )
        })
        .map(app => app.appId)
        .sort()
    },

    envForApp(appId: string): AppCredentialEnv | null {
      const credential = store.current()[appId]
      return credential === undefined ? null : { DUET_APP_API_KEY: credential.apiKey }
    },

    onChange(listener: (appId: string) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function appCredentialsPath(stateDir: string): string {
  return persistedStorePath(stateDir, APP_CREDENTIALS_FILE)
}

function parseCredentialEnvelope(body: unknown): StoredAppCredentials | null {
  if (typeof body !== 'object' || body === null || !('appCredentials' in body)) return null
  const value = (body as { appCredentials?: unknown }).appCredentials
  if (!Array.isArray(value)) return null
  const credentials: StoredAppCredentials = {}
  for (const candidate of value) {
    const parsed = VmAppCredentialsSchema.safeParse(candidate)
    if (!parsed.success || credentials[parsed.data.appId] !== undefined) return null
    credentials[parsed.data.appId] = parsed.data
  }
  return credentials
}

function parsePersistedCredentials(value: unknown): StoredAppCredentials | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const credentials: StoredAppCredentials = {}
  for (const [appId, candidate] of Object.entries(value)) {
    const parsed = VmAppCredentialsSchema.safeParse(candidate)
    if (!parsed.success || parsed.data.appId !== appId) return null
    credentials[appId] = parsed.data
  }
  return credentials
}

function registerCredentialSecrets(credentials: StoredAppCredentials): void {
  for (const credential of Object.values(credentials)) registerRedactionSecret(credential.apiKey)
}
