import {
  VM_MODEL_CREDENTIAL_REFRESH_WINDOW_MS,
  VmModelCredentialsSchema,
  type VmModelCredentials,
} from '@repo/contract'

import { createPersistedJsonStore, persistedStorePath } from './persisted-store'
import { registerRedactionSecret } from './redaction'

export const MODEL_CREDENTIALS_FILE = 'model-credentials.json'

export type ModelCredentialEnv = {
  DUET_API_KEY: string
  DUET_GATEWAY_BASE_URL: string
}

export interface ModelCredentialStore {
  acceptResponse(body: unknown): void
  shouldRequestCredentials(now?: number): boolean
  currentModelEnv(now?: number): ModelCredentialEnv | null
}

export function createModelCredentialStore(stateDir: string): ModelCredentialStore {
  const store = createPersistedJsonStore<VmModelCredentials | null>({
    stateDir,
    fileName: MODEL_CREDENTIALS_FILE,
    initial: null,
    parseResponse: parseModelCredentials,
    parsePersisted: parsePersistedCredentials,
    onLoad: credentials => {
      if (credentials !== null) registerRedactionSecret(credentials.apiKey)
    },
    onAccept: credentials => {
      if (credentials !== null) registerRedactionSecret(credentials.apiKey)
    },
  })

  return {
    acceptResponse(body: unknown): void {
      store.acceptResponse(body)
    },

    shouldRequestCredentials(now = Date.now()): boolean {
      const current = store.current()
      if (current === null) return true
      return current.expiresAt <= now + VM_MODEL_CREDENTIAL_REFRESH_WINDOW_MS
    },

    currentModelEnv(now = Date.now()): ModelCredentialEnv | null {
      const current = store.current()
      if (current === null || current.expiresAt <= now) return null
      return {
        DUET_API_KEY: current.apiKey,
        DUET_GATEWAY_BASE_URL: current.gatewayBaseUrl,
      }
    },
  }
}

export function modelCredentialsPath(stateDir: string): string {
  return persistedStorePath(stateDir, MODEL_CREDENTIALS_FILE)
}

export function parseModelCredentials(body: unknown): VmModelCredentials | null {
  if (typeof body !== 'object' || body === null) return null
  const credentials = (body as { modelCredentials?: unknown }).modelCredentials
  const parsed = VmModelCredentialsSchema.safeParse(credentials)
  return parsed.success ? parsed.data : null
}

function parsePersistedCredentials(value: unknown): VmModelCredentials | null {
  const parsed = parseModelCredentials({ modelCredentials: value })
  return parsed
}
