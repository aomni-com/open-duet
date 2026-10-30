import { expect, test } from 'bun:test'

import {
  BrowserCapacityErrorSchema,
  BrowserOwnerSchema,
  DESKTOP_KASM_AUTH_PATH,
  DESKTOP_SCREEN,
  DesktopBrowserBatchSchema,
  DesktopFocusRequestSchema,
  DesktopGrantRegistrationRequestSchema,
  DesktopSessionRequestSchema,
  DesktopOwnerActivitySchema,
  DesktopSessionResponseSchema,
  DesktopStatusResponseSchema,
  FocusBrowserOwnerResultSchema,
  FocusBrowserOwnerRequestSchema,
  browserOwnerKey,
  desktopCredentialPath,
  desktopCredentialPathForRequest,
  desktopEntryPath,
  desktopGrantIdForPath,
  desktopViewerPath,
} from './index'

test('browser owners use stable root or agent identity', () => {
  expect(BrowserOwnerSchema.parse({ kind: 'root' })).toEqual({ kind: 'root' })
  expect(BrowserOwnerSchema.parse({ kind: 'agent', agentId: 'agent_123' })).toEqual({
    kind: 'agent',
    agentId: 'agent_123',
  })
  expect(browserOwnerKey({ kind: 'root' })).toBe('root')
  expect(browserOwnerKey({ kind: 'agent', agentId: 'agent_123' })).toBe('agent:agent_123')
  expect(BrowserOwnerSchema.safeParse({ kind: 'agent', agentId: '' }).success).toBe(false)
})

test('browser batch, capacity, focus, and owner activity schemas share one owner vocabulary', () => {
  const owner = { kind: 'agent' as const, agentId: 'agent_123' }
  expect(
    DesktopBrowserBatchSchema.parse({
      batchId: 'batch_123',
      targetId: 'target_123',
      webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/batches/batch_123',
      owner,
    }),
  ).toMatchObject({ owner })
  expect(
    BrowserCapacityErrorSchema.parse({
      error: 'browser_capacity',
      retryable: true,
      retryAfterMs: 60_000,
    }),
  ).toEqual({ error: 'browser_capacity', retryable: true, retryAfterMs: 60_000 })
  expect(FocusBrowserOwnerResultSchema.parse({ focused: false })).toEqual({ focused: false })
  expect(FocusBrowserOwnerRequestSchema.parse({ owner, requestId: 'focus-123' })).toEqual({
    owner,
    requestId: 'focus-123',
  })
  expect(DesktopFocusRequestSchema.safeParse({ requestId: 'focus-123', extra: true }).success).toBe(
    false,
  )
  expect(
    DesktopOwnerActivitySchema.parse({
      owner,
      phase: 'idle',
      focused: false,
      liveBatchCount: 0,
      batchTabCount: 3,
      discardedBatchTabCount: 2,
      lastActiveAt: 123,
    }),
  ).toMatchObject({ owner, phase: 'idle', discardedBatchTabCount: 2 })
})

test('a browser credential stays in the inherited path prefix for every relative asset', () => {
  const entry = desktopCredentialPath('desktop-123', 'secret_token-456')

  expect(entry).toBe('/v1/desktop/desktop-123.secret_token-456/')
  expect(desktopCredentialPathForRequest(`${entry}static/app.js`)).toEqual({
    grantId: 'desktop-123',
    token: 'secret_token-456',
    tail: '/static/app.js',
  })
})

test('the viewer entry keeps Kasm websocket traffic under the credential prefix', () => {
  const viewer = desktopViewerPath('desktop-123', 'secret_token-456')
  const url = new URL(viewer, 'https://vm.test')

  expect(url.pathname).toBe('/v1/desktop/desktop-123.secret_token-456/')
  expect(url.searchParams.get('autoconnect')).toBe('1')
  expect(url.searchParams.get('resize')).toBe('scale')
  expect(url.searchParams.get('path')).toBe('v1/desktop/desktop-123.secret_token-456/websockify')
})

test('desktop Kasm auth lives in the archived per-VM state tree', () => {
  expect(DESKTOP_KASM_AUTH_PATH).toBe('/home/exedev/.duet/desktop/kasm-auth.json')
})

test('desktop entry paths round-trip a safe grant id', () => {
  const entryPath = desktopEntryPath('grant_123')

  expect(entryPath).toBe('/v1/desktop/grant_123/')
  expect(desktopGrantIdForPath(`${entryPath}client.html`)).toBe('grant_123')
})

test('desktop path parsing rejects paths and traversal-shaped grant ids', () => {
  expect(desktopGrantIdForPath('/v1/files/grant_123')).toBeNull()
  expect(desktopGrantIdForPath('/v1/desktop/grant%2Fchild/client.html')).toBeNull()
  expect(desktopGrantIdForPath('/v1/desktop/grant..child/client.html')).toBeNull()
  expect(() => desktopEntryPath('grant/child')).toThrow('Invalid desktop grant id')
  expect(() => desktopEntryPath('grant..child')).toThrow('Invalid desktop grant id')
})

test('desktop sessions bind one exact canonical web origin', () => {
  for (const origin of [
    'https://app.duet.so',
    'https://customer.example:8443',
    'http://localhost:3000',
    'http://127.0.0.2:3000',
    'http://[::1]:3000',
  ]) {
    expect(DesktopSessionRequestSchema.parse({ embedOrigin: origin })).toEqual({
      embedOrigin: origin,
    })
  }

  for (const embedOrigin of [
    'http://customer.example',
    'https://APP.duet.so',
    'https://app.duet.so/',
    'https://app.duet.so/path',
    'https://app.duet.so?query=1',
    'https://app.duet.so#fragment',
    'https://user@app.duet.so',
    'https://app.duet.so:443',
    '*.duet.so',
    'https://one.example https://two.example',
  ]) {
    expect(DesktopSessionRequestSchema.safeParse({ embedOrigin }).success).toBe(false)
  }
  expect(
    DesktopSessionRequestSchema.safeParse({ embedOrigin: 'https://app.duet.so', extra: true })
      .success,
  ).toBe(false)
})

test('desktop wire schemas expose one token-free viewer capability', () => {
  expect(
    DesktopSessionResponseSchema.safeParse({
      entryUrl: 'https://workspace.example/v1/desktop/grant_123/',
      expiresAt: 123_456,
      phase: 'starting',
      screen: DESKTOP_SCREEN,
    }).success,
  ).toBe(true)
  expect(
    DesktopSessionResponseSchema.parse({
      entryUrl: 'https://workspace.example/v1/desktop/grant_123/',
      token: 'secret',
      expiresAt: 123_456,
      phase: 'starting',
      screen: DESKTOP_SCREEN,
    }),
  ).toEqual({
    entryUrl: 'https://workspace.example/v1/desktop/grant_123/',
    expiresAt: 123_456,
    phase: 'starting',
    screen: DESKTOP_SCREEN,
  })
  expect(
    DesktopGrantRegistrationRequestSchema.parse({
      grantId: 'desktop-1',
      tokenDigest: 'a'.repeat(64),
      expiresAt: 123_456,
      embedOrigin: 'https://app.duet.so',
    }),
  ).toMatchObject({ embedOrigin: 'https://app.duet.so' })
  expect(
    DesktopStatusResponseSchema.safeParse({
      phase: 'ready',
      viewers: 1,
      owners: [
        {
          owner: { kind: 'agent', agentId: 'agent_123' },
          agentSlug: 'researcher',
          phase: 'active',
          focused: true,
          liveBatchCount: 1,
          batchTabCount: 2,
          discardedBatchTabCount: 0,
          lastActiveAt: 123_000,
        },
      ],
      futureField: true,
    }).success,
  ).toBe(true)
})
