import assert from 'node:assert/strict'

import type { Locator } from '@playwright/test'

import { AppResponseSchema } from '@repo/contract'

import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import type { LiveEnv, Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'

const APP_API_KEY_DIAGNOSTIC_KEYS = [
  'appApiKeyPresent',
  'apiUrlPresent',
  'provisioningTokenAbsent',
  'allowedCallSucceeded',
  'undeclaredCallRejected',
  'workspaceAuthorityLocal',
] as const

export type AppApiKeyDiagnostics = {
  [Key in (typeof APP_API_KEY_DIAGNOSTIC_KEYS)[number]]: boolean
}

export type AppApiKeyAcceptanceEvidence = AppApiKeyDiagnostics & {
  priorKeyRejected: boolean
}

export function parseAppApiKeyDiagnostics(value: unknown): AppApiKeyDiagnostics {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('app API-key diagnostics must be a boolean-only object')
  }
  const record = value as Record<string, unknown>
  if ('apiKey' in record) {
    throw new Error('app API-key diagnostics must never expose apiKey')
  }
  if (APP_API_KEY_DIAGNOSTIC_KEYS.some(key => typeof record[key] !== 'boolean')) {
    throw new Error('app API-key diagnostics must contain only the owned boolean-only fields')
  }
  return Object.fromEntries(
    APP_API_KEY_DIAGNOSTIC_KEYS.map(key => [key, record[key]]),
  ) as AppApiKeyDiagnostics
}

export function parseAppKeyRevocationDiagnostic(value: unknown): { priorKeyRejected: boolean } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).priorKeyRejected !== 'boolean'
  ) {
    throw new Error('app key revocation diagnostics must be a boolean-only object')
  }
  return { priorKeyRejected: (value as { priorKeyRejected: boolean }).priorKeyRejected }
}

export async function runAppApiKeyAcceptance(args: {
  frameBody: Locator
  env: LiveEnv
  workspace: Workspace
  apiToken: string
  appSlug: string
  appPath: string
  artifacts: StagingArtifactCollector
}): Promise<AppApiKeyAcceptanceEvidence> {
  const diagnostics = parseAppApiKeyDiagnostics(
    await readAppApiKeyDiagnostics(args.frameBody, args.workspace.slug),
  )
  assert.deepEqual(
    diagnostics,
    {
      appApiKeyPresent: true,
      apiUrlPresent: true,
      provisioningTokenAbsent: true,
      allowedCallSucceeded: true,
      undeclaredCallRejected: true,
      workspaceAuthorityLocal: true,
    },
    'app API-key fixture did not satisfy every boolean diagnostic',
  )

  const armed = await readFrameJson(args.frameBody, '/diagnostics/revocation')
  assert.deepEqual(
    armed,
    { revocationObserverReady: true },
    'app key revocation observer did not become ready',
  )
  const disabled = AppResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.workspace.slug)}/apps/${encodeURIComponent(args.appSlug)}/disabled`,
      {
        method: 'POST',
        headers: bearerJson(args.apiToken),
        body: JSON.stringify({ disabled: true }),
      },
      200,
      'app API-key fixture disable',
      args.artifacts,
    ),
  )
  const revocationDiagnostic = await waitForRevocationProof(args)
  assert(disabled.app.disabledAt !== undefined, 'app API-key fixture did not become disabled')
  assert(revocationDiagnostic.priorKeyRejected, 'the disabled app credential still authenticated')
  return { ...diagnostics, ...revocationDiagnostic }
}

async function waitForRevocationProof(args: {
  env: LiveEnv
  workspace: Workspace
  apiToken: string
  appPath: string
}): Promise<{ priorKeyRejected: boolean }> {
  const encodedPath = args.appPath.split('/').map(encodeURIComponent).join('/')
  const url = `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.workspace.slug)}/files/${encodedPath}/.app-api-key-revoked.json`
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await stagingFetch(url, { headers: bearer(args.apiToken) })
    if (response.status === 200) {
      return parseAppKeyRevocationDiagnostic(await response.json())
    }
    assert.equal(response.status, 404, 'app key revocation proof returned an unexpected status')
    await Bun.sleep(50)
  }
  throw new Error('app key revocation proof did not appear')
}

export async function readAppApiKeyDiagnostics(
  frameBody: Locator,
  expectedWorkspaceSlug: string,
): Promise<unknown> {
  return await frameBody.evaluate(async (_element, workspaceSlug) => {
    const response = await fetch('/diagnostics', {
      headers: { 'x-expected-workspace': workspaceSlug },
    })
    return await response.json()
  }, expectedWorkspaceSlug)
}

async function readFrameJson(frameBody: Locator, pathname: string): Promise<unknown> {
  return await frameBody.evaluate(async (_element, requestedPath) => {
    const response = await fetch(requestedPath)
    return await response.json()
  }, pathname)
}
