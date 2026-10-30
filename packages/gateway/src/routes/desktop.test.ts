import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { desktopCredentialPath } from '@repo/contract'

import { BrowserExtensionBridge } from '../desktop/extension-bridge'
import {
  createDesktopIngress,
  desktopWebSocketHandlers,
  handleDesktopUpgrade,
  readKasmCredentialFile,
  type DesktopSocketData,
} from './desktop'

function createReadyLifecycle() {
  let viewers = 0
  return {
    async ensureStarted() {
      return 'ready' as const
    },
    phase: () => 'ready' as const,
    viewerAttached() {
      viewers += 1
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        viewers -= 1
      }
    },
    viewerCount: () => viewers,
  }
}

test('grant minting starts the supervisor and status reads its single lifecycle state', async () => {
  let starts = 0
  let viewers = 2
  const ingress = createDesktopIngress({
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    lifecycle: {
      async ensureStarted() {
        starts += 1
        return 'ready'
      },
      phase: () => 'ready',
      viewerAttached: () => () => undefined,
      viewerCount: () => viewers,
    },
  })

  const grant = await ingress.routes.request('/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantId: 'desktop-lifecycle',
      tokenDigest: createHash('sha256').update('secret').digest('hex'),
      expiresAt: Date.now() + 60_000,
      embedOrigin: 'https://customer.example',
    }),
  })
  expect(starts).toBe(1)
  expect(await grant.json()).toMatchObject({ phase: 'ready' })

  let status = await ingress.routes.request('/status')
  expect(await status.json()).toMatchObject({ phase: 'ready', viewers: 2 })
  viewers = 0
  status = await ingress.routes.request('/status')
  expect(await status.json()).toMatchObject({ viewers: 0 })
})

test('a failed desktop start returns 503 without banking the grant', async () => {
  const token = 'browser_secret'
  const ingress = createDesktopIngress({
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    lifecycle: {
      async ensureStarted() {
        throw new Error('systemd unavailable')
      },
      phase: () => 'stopped',
      viewerAttached: () => () => undefined,
      viewerCount: () => 0,
    },
  })

  const response = await ingress.routes.request('/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantId: 'desktop-failed-start',
      tokenDigest: createHash('sha256').update(token).digest('hex'),
      expiresAt: Date.now() + 60_000,
      embedOrigin: 'https://customer.example',
    }),
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'desktop_start_failed' })
  expect(await ingress.grants.authorize('desktop-failed-start', token)).toBe(false)
})

test('a valid path grant proxies the exact tail with only loopback Kasm credentials', async () => {
  const upstreamRequests: Request[] = []
  const ingress = createDesktopIngress({
    now: () => 100,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    fetch: async (request: Request) => {
      upstreamRequests.push(request)
      return new Response('kasm client', {
        headers: {
          'content-encoding': 'gzip',
          'content-security-policy': "default-src 'self'; frame-ancestors https://upstream.invalid",
          'x-frame-options': 'DENY',
          'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-opener-policy': 'same-origin',
        },
      })
    },
  })
  const token = 'browser_secret'
  ingress.grants.put('desktop-1', {
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    expiresAt: 200,
    payload: { embedOrigin: 'https://customer.example' },
  })
  const path = `${desktopCredentialPath('desktop-1', token)}static/app.js?mode=full`

  expect(await ingress.authorizePath(new URL(`https://vm.test${path}`).pathname)).toEqual({
    embedOrigin: 'https://customer.example',
  })
  const response = await ingress.routes.request(path)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('kasm client')
  expect(upstreamRequests).toHaveLength(1)
  expect(upstreamRequests[0]?.url).toBe('http://127.0.0.1:6901/static/app.js?mode=full')
  expect(upstreamRequests[0]?.headers.get('authorization')).toBe(`Basic ${btoa('duet:local-only')}`)
  expect(response.headers.get('content-security-policy')).toBe(
    'frame-ancestors https://customer.example',
  )
  expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
  expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('x-frame-options')).toBeNull()
})

test('expired, wrong-id, and malformed desktop paths fail at the shared auth boundary', async () => {
  let now = 100
  const ingress = createDesktopIngress({
    now: () => now,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const token = 'right_token'
  ingress.grants.put('desktop-1', {
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    expiresAt: 200,
    payload: { embedOrigin: 'https://customer.example' },
  })

  expect(await ingress.authorizePath(desktopCredentialPath('desktop-2', token))).toBeNull()
  expect(await ingress.authorizePath('/v1/desktop/not-a-credential/')).toBeNull()
  now = 200
  expect(await ingress.authorizePath(desktopCredentialPath('desktop-1', token))).toBeNull()
})

test('VM-only grant registration returns the credential-free entry prefix', async () => {
  const ingress = createDesktopIngress({
    now: () => 100,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const response = await ingress.routes.request('/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantId: 'desktop-1',
      tokenDigest: createHash('sha256').update('browser_secret').digest('hex'),
      expiresAt: 200,
      embedOrigin: 'https://customer.example',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    entryPath: '/v1/desktop/desktop-1/',
    phase: 'ready',
  })
})

test('each simultaneous viewer grant writes only its own exact frame ancestor', async () => {
  const ingress = createDesktopIngress({
    now: () => 100,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    fetch: async () => new Response('<html>desktop</html>'),
  })
  for (const [grantId, token, embedOrigin] of [
    ['desktop-a', 'token_a', 'https://one.example'],
    ['desktop-b', 'token_b', 'https://two.example'],
  ] as const) {
    ingress.grants.put(grantId, {
      tokenDigest: createHash('sha256').update(token).digest('hex'),
      expiresAt: 200,
      payload: { embedOrigin },
    })
    const response = await ingress.routes.request(desktopCredentialPath(grantId, token))
    expect(response.headers.get('content-security-policy')).toBe(`frame-ancestors ${embedOrigin}`)
  }
})

test('a full live desktop registry refuses a new grant without evicting the first', async () => {
  const ingress = createDesktopIngress({
    now: () => 100,
    grantCapacity: 1,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const register = (grantId: string, token: string) =>
    ingress.routes.request('/grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantId,
        tokenDigest: createHash('sha256').update(token).digest('hex'),
        expiresAt: 200,
        embedOrigin: 'https://customer.example',
      }),
    })

  expect((await register('desktop-a', 'token_a')).status).toBe(200)
  const refused = await register('desktop-b', 'token_b')
  expect(refused.status).toBe(503)
  expect(refused.headers.get('retry-after')).toBe('1')
  expect(await refused.json()).toEqual({ error: 'desktop_unavailable' })
  expect(await ingress.grants.authorize('desktop-a', 'token_a')).toBe(true)
  expect(await ingress.grants.authorize('desktop-b', 'token_b')).toBe(false)
})

test('an existing image policy supplies the extension update and exact CRX without an ID file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duet-browser-extension-'))
  const crxPath = join(directory, 'extension.crx')
  const extensionId = 'a'.repeat(32)
  const policyPath = join(directory, 'managed-policy.json')
  await writeFile(
    policyPath,
    JSON.stringify({
      ExtensionInstallForcelist: [
        `${extensionId};http://127.0.0.1:3000/v1/desktop/browser-extension/update.xml`,
      ],
    }),
  )
  const bridge = new BrowserExtensionBridge({ extensionPolicyPath: policyPath })
  await writeFile(crxPath, Buffer.from([67, 114, 50, 52, 1, 2, 3]))
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    browserExtensionCrxPath: crxPath,
    browserExtension: bridge,
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })

  expect(await Bun.file(join(directory, 'id')).exists()).toBe(false)
  const update = await ingress.routes.request('/browser-extension/update.xml')
  expect(update.status).toBe(200)
  expect(update.headers.get('content-type')).toContain('application/xml')
  expect(await update.text()).toContain(
    `<app appid="${extensionId}"><updatecheck codebase="http://127.0.0.1:3000/v1/desktop/browser-extension/extension.crx" version="1.0.0"/>`,
  )

  const socket = {
    send() {},
    close() {
      throw new Error('unexpected extension rejection')
    },
  }
  bridge.message(socket, JSON.stringify({ type: 'hello', extensionId, workerStartedAt: 1 }))
  expect(bridge.connected()).toBe(true)

  const crx = await ingress.routes.request('/browser-extension/extension.crx')
  expect(crx.status).toBe(200)
  expect(crx.headers.get('content-type')).toBe('application/x-chrome-extension')
  expect(new Uint8Array(await crx.arrayBuffer())).toEqual(
    new Uint8Array([67, 114, 50, 52, 1, 2, 3]),
  )
})

test('an image without an extension identity does not advertise an installable extension', async () => {
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    browserExtension: new BrowserExtensionBridge({ extensionId: null }),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const response = await ingress.routes.request('/browser-extension/update.xml')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'browser_extension_unavailable' })
})

test('the authenticated extension status proves a live worker can execute snapshot', async () => {
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    browserExtension: {
      extensionId: 'a'.repeat(32),
      connected: () => true,
      request: async command => {
        expect(command).toEqual({ command: 'snapshot' })
        return { windows: [] }
      },
    },
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })

  const response = await ingress.routes.request('/browser-extension/status')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ connected: true, snapshot: { windows: [] } })
})

test('the VM-authenticated inventory reports durable logical owner bindings', async () => {
  const ledger = {
    version: 1 as const,
    browserGeneration: 'generation-1',
    windows: [
      {
        logicalWindowId: 'window-root',
        owner: { kind: 'root' as const },
        chromeWindowId: 7,
        identityTabId: 8,
        identityTargetId: 'target-root',
        lastActivityAt: 10,
        phase: 'idle' as const,
      },
    ],
    batches: [],
  }
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    browserManager: { inventory: () => ledger },
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })

  const response = await ingress.routes.request('/browser/windows/inventory')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(ledger)
})

test('the local Kasm credential reader rejects links and malformed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duet-desktop-auth-'))
  const credentialPath = join(directory, 'desktop', 'kasm-auth.json')
  await mkdir(join(directory, 'desktop'))
  await writeFile(credentialPath, JSON.stringify({ username: 'duet', password: 'local-only' }), {
    mode: 0o600,
  })
  expect(await readKasmCredentialFile(credentialPath)).toEqual({
    username: 'duet',
    password: 'local-only',
  })

  const linked = join(directory, 'linked.json')
  await symlink(credentialPath, linked)
  await expect(readKasmCredentialFile(linked)).rejects.toThrow('credential file')
  await writeFile(credentialPath, '{}')
  await expect(readKasmCredentialFile(credentialPath)).rejects.toThrow('credential file')
})

test('the VM-token route starts a browser batch without accepting caller-owned identity', async () => {
  const calls: string[] = []
  const ingress = createDesktopIngress({
    now: () => 1_500,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    browserBatches: {
      async start(sessionId) {
        calls.push(sessionId)
        return {
          batchId: 'batch-a',
          owner: { kind: 'agent', agentId: 'agent-stable-a' },
          targetId: `target-${sessionId}`,
          webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant.token',
        }
      },
    },
    browserManager: {
      inventory: () => ({ version: 1, windows: [], batches: [] }),
      activities: () => [
        {
          owner: { kind: 'agent', agentId: 'agent-stable-a' },
          phase: 'active',
          focused: true,
          liveBatchCount: 1,
          batchTabCount: 1,
          discardedBatchTabCount: 0,
          lastActiveAt: 1_400,
        },
      ],
    },
  })

  const response = await ingress.routes.request('/browser/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    batchId: 'batch-a',
    owner: { kind: 'agent', agentId: 'agent-stable-a' },
    targetId: 'target-session-a',
    webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant.token',
  })
  expect(calls).toEqual(['session-a'])
  expect(await (await ingress.routes.request('/status')).json()).toEqual({
    phase: 'ready',
    viewers: 0,
    owners: [
      {
        owner: { kind: 'agent', agentId: 'agent-stable-a' },
        phase: 'active',
        focused: true,
        liveBatchCount: 1,
        batchTabCount: 1,
        discardedBatchTabCount: 0,
        lastActiveAt: 1_400,
      },
    ],
  })
  expect(
    (
      await ingress.routes.request('/browser/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await ingress.routes.request('/browser/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-a', browserContextId: 'isolated' }),
      })
    ).status,
  ).toBe(400)
})

test('focus-existing forwards stable owner identity and never starts or creates', async () => {
  const owners: unknown[] = []
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    browserManager: {
      inventory: () => ({ version: 1, windows: [], batches: [] }),
      focusOwner: async owner => {
        owners.push(owner)
        return owner.kind === 'root'
      },
    },
  })
  const focus = (owner: unknown, requestId: string) =>
    ingress.routes.request('/browser/windows/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, requestId }),
    })
  const root = await focus({ kind: 'root' }, 'focus-root')
  expect(await root.json()).toEqual({ focused: true })
  const duplicate = await focus({ kind: 'root' }, 'focus-root')
  expect(await duplicate.json()).toEqual({ focused: true })
  const mismatched = await focus({ kind: 'agent', agentId: 'a' }, 'focus-root')
  expect(mismatched.status).toBe(400)
  const missing = await focus({ kind: 'agent', agentId: 'a' }, 'focus-agent')
  expect(await missing.json()).toEqual({ focused: false })
  expect(owners).toEqual([{ kind: 'root' }, { kind: 'agent', agentId: 'a' }])
  expect(
    (
      await ingress.routes.request('/browser/windows/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: { kind: 'root' } }),
      })
    ).status,
  ).toBe(400)
})

test('browser batch failures preserve capacity and identity error contracts', async () => {
  let error: Error & { code: string; retryable?: boolean; retryAfterMs?: number } = Object.assign(
    new Error('missing'),
    {
      code: 'browser_session_not_found',
    },
  )
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
    browserBatches: {
      start: async () => Promise.reject(error),
    },
  })
  const request = () =>
    ingress.routes.request('/browser/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    })

  let response = await request()
  expect([response.status, await response.json()]).toEqual([
    404,
    { error: 'browser_session_not_found' },
  ])

  error = Object.assign(new Error('owner pending'), { code: 'browser_owner_unavailable' })
  response = await request()
  expect([response.status, await response.json()]).toEqual([
    503,
    { error: 'browser_owner_unavailable', retryable: true },
  ])

  error = Object.assign(new Error('full'), {
    code: 'browser_capacity',
    retryable: true,
    retryAfterMs: 60_000,
  })
  response = await request()
  expect([response.status, await response.json()]).toEqual([
    429,
    { error: 'browser_capacity', retryable: true, retryAfterMs: 60_000 },
  ])
})

test('the relay preserves frame types and tears viewer presence down exactly once', () => {
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const upstream = new FakeUpstreamWebSocket()
  let connectOptions: Bun.WebSocketOptions | undefined
  const handlers = desktopWebSocketHandlers({
    connect: (_url, options) => {
      connectOptions = options
      return upstream
    },
  })
  const downstream = new FakeServerWebSocket({
    kind: 'desktop',
    upstreamUrl: 'ws://127.0.0.1:6901/websockify',
    authorization: 'Basic local',
    protocols: ['binary'],
    ingress,
    pending: [],
    pendingBytes: 0,
    closed: false,
  })

  handlers.open?.(downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>)
  expect(ingress.viewerCount()).toBe(1)
  expect(connectOptions?.headers).toMatchObject({
    authorization: 'Basic local',
    origin: 'http://127.0.0.1:6901',
  })
  handlers.message(
    downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>,
    Buffer.from([1, 2, 3]),
  )
  upstream.open()
  expect(upstream.sent).toEqual([new Uint8Array([1, 2, 3]).buffer])

  upstream.receive('text-frame')
  upstream.receive(new Uint8Array([4, 5]).buffer)
  expect(downstream.sent).toEqual(['text-frame', new Uint8Array([4, 5]).buffer])

  upstream.abnormalClose()
  handlers.close?.(downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>, 1006, 'lost')
  expect(ingress.viewerCount()).toBe(0)
})

class FakeUpstreamWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeUpstreamWebSocket.CONNECTING
  bufferedAmount = 0
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  binaryType: BinaryType = 'blob'
  send(message: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(message)
  }
  close() {}
  open() {
    this.readyState = FakeUpstreamWebSocket.OPEN
    this.onopen?.()
  }
  receive(data: string | ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent)
  }
  abnormalClose() {
    this.onclose?.({ code: 1006, reason: 'lost' } as CloseEvent)
  }
}

class FakeServerWebSocket {
  sent: Array<string | ArrayBuffer> = []
  closes = 0
  bufferedAmount = 0
  constructor(readonly data: DesktopSocketData) {}
  send(message: string | BufferSource) {
    this.sent.push(
      typeof message === 'string'
        ? message
        : message instanceof ArrayBuffer
          ? message
          : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
    )
    return 1
  }
  close() {
    this.closes += 1
  }
  getBufferedAmount() {
    return this.bufferedAmount
  }
}

test('desktop upgrade authorizes the grant and injects Basic only upstream', async () => {
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const token = 'browser_secret'
  ingress.grants.put('desktop-1', {
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    expiresAt: Date.now() + 60_000,
    payload: { embedOrigin: 'https://customer.example' },
  })
  let upgradeData: DesktopSocketData | undefined
  const server = {
    upgrade(_request: Request, options: { data: DesktopSocketData }) {
      upgradeData = options.data
      return true
    },
  } as unknown as Bun.Server<DesktopSocketData>
  const request = new Request(
    'https://vm.test/v1/desktop/desktop-1.browser_secret/websockify?foo=bar',
    { headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'binary' } },
  )

  const response = await handleDesktopUpgrade(request, server, ingress)

  expect(response).toBeUndefined()
  expect(upgradeData).toMatchObject({
    kind: 'desktop',
    upstreamUrl: 'ws://127.0.0.1:6901/websockify?foo=bar',
    authorization: `Basic ${btoa('duet:local-only')}`,
    protocols: ['binary'],
  })
  expect(request.headers.get('authorization')).toBeNull()
})

test('desktop upgrade refuses a syntactically valid path without a registered grant', async () => {
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const server = {
    upgrade() {
      throw new Error('unregistered desktop grant reached the WebSocket upgrade')
    },
  } as unknown as Bun.Server<DesktopSocketData>
  const request = new Request('https://vm.test/v1/desktop/made-up-id.made-up-token/websockify', {
    headers: { upgrade: 'websocket' },
  })

  const response = await handleDesktopUpgrade(request, server, ingress)

  expect(response?.status).toBe(401)
})

test('grant expiry refuses a fresh websocket admission without timing out an admitted relay', async () => {
  let now = 100
  const ingress = createDesktopIngress({
    now: () => now,
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const token = 'browser_secret'
  ingress.grants.put('desktop-1', {
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    expiresAt: 200,
    payload: { embedOrigin: 'https://customer.example' },
  })
  let admitted: DesktopSocketData | undefined
  const server = {
    upgrade(_request: Request, options: { data: DesktopSocketData }) {
      admitted = options.data
      return true
    },
  } as unknown as Bun.Server<DesktopSocketData>
  const request = new Request(
    `https://vm.test${desktopCredentialPath('desktop-1', token)}websockify`,
    { headers: { upgrade: 'websocket' } },
  )
  expect(await handleDesktopUpgrade(request, server, ingress)).toBeUndefined()
  expect(admitted).toBeDefined()
  now = 200
  const refused = await handleDesktopUpgrade(request, server, ingress)
  expect(refused?.status).toBe(401)

  const upstream = new FakeUpstreamWebSocket()
  const downstream = new FakeServerWebSocket(admitted!)
  const handlers = desktopWebSocketHandlers({ connect: () => upstream })
  handlers.open?.(downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>)
  handlers.message?.(
    downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>,
    'after-expiry',
  )
  upstream.open()
  expect(upstream.sent).toEqual(['after-expiry'])
  handlers.close?.(downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>, 1000, 'done')
})

test('a slow viewer is dropped instead of growing relay buffers without bound', () => {
  const ingress = createDesktopIngress({
    lifecycle: createReadyLifecycle(),
    readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
  })
  const upstream = new FakeUpstreamWebSocket()
  const handlers = desktopWebSocketHandlers({ connect: () => upstream })
  const downstream = new FakeServerWebSocket({
    kind: 'desktop',
    upstreamUrl: 'ws://127.0.0.1:6901/websockify',
    authorization: 'Basic local',
    protocols: [],
    ingress,
    pending: [],
    pendingBytes: 0,
    closed: false,
  })
  downstream.bufferedAmount = 9 * 1024 * 1024
  handlers.open?.(downstream as unknown as Bun.ServerWebSocket<DesktopSocketData>)
  upstream.receive(new Uint8Array([1]).buffer)

  expect(downstream.closes).toBe(1)
  expect(ingress.viewerCount()).toBe(0)
})
