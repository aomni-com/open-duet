import { expect, test } from 'bun:test'

import {
  createCdpGrantRegistry,
  desktopCdpWebSocketHandlers,
  handleDesktopCdpUpgrade,
  observeCdpBrowserMessage,
  processCdpClientMessage,
  type DesktopCdpSocketData,
  type DesktopCdpUpstreamSocket,
} from './cdp-proxy'

test('a CDP grant is opaque, short lived, and consumable by only one socket', async () => {
  const grants = createCdpGrantRegistry({
    now: () => 1_000,
    createGrantId: () => 'grant-a',
    createToken: () => 'secret-token',
  })

  const minted = await grants.mint({ batchId: 'batch-a', browserGeneration: 'generation-a' })
  expect(minted).toEqual({
    webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant-a.secret-token',
    expiresAt: 121_000,
  })
  expect(await grants.consume('/v1/desktop/browser/cdp/grant-a.wrong-token')).toBeNull()
  expect(await grants.consume('/v1/desktop/browser/cdp/grant-a.secret-token')).toEqual({
    batchId: 'batch-a',
    browserGeneration: 'generation-a',
  })
  expect(await grants.consume('/v1/desktop/browser/cdp/grant-a.secret-token')).toBeNull()
})

test('the WebSocket upgrade consumes the grant and binds its batch to Chrome', async () => {
  const grants = createCdpGrantRegistry({
    now: () => 1_000,
    createGrantId: () => 'grant-a',
    createToken: () => 'secret-token',
  })
  const minted = await grants.mint({ batchId: 'batch-a', browserGeneration: 'chrome-generation' })
  let upgradeData: DesktopCdpSocketData | undefined
  const server = {
    upgrade(_request: Request, options: { data: DesktopCdpSocketData }) {
      upgradeData = options.data
      return true
    },
  } as unknown as Bun.Server<DesktopCdpSocketData>
  const manager = { createBatchTab: async () => ({ targetId: 'target-a' }) }
  const request = new Request(minted.webSocketDebuggerUrl, {
    headers: { upgrade: 'websocket' },
  })

  expect(
    await handleDesktopCdpUpgrade(request, server, {
      grants,
      discoverUpstream: async () => 'ws://127.0.0.1:9222/devtools/browser/chrome-generation',
      manager,
    }),
  ).toBeUndefined()
  expect(upgradeData).toMatchObject({
    kind: 'desktop-cdp',
    batchId: 'batch-a',
    upstreamUrl: 'ws://127.0.0.1:9222/devtools/browser/chrome-generation',
    manager,
  })
  expect(
    (
      await handleDesktopCdpUpgrade(request, server, {
        grants,
        discoverUpstream: async () => 'must-not-run',
        manager,
      })
    )?.status,
  ).toBe(401)
})

test('the WebSocket upgrade refuses a grant from a prior Chrome generation', async () => {
  const grants = createCdpGrantRegistry({
    now: () => 1_000,
    createGrantId: () => 'grant-old',
    createToken: () => 'secret-token',
  })
  const minted = await grants.mint({ batchId: 'batch-a', browserGeneration: 'old-generation' })
  let upgraded = false
  const response = await handleDesktopCdpUpgrade(
    new Request(minted.webSocketDebuggerUrl, { headers: { upgrade: 'websocket' } }),
    {
      upgrade() {
        upgraded = true
        return true
      },
    } as unknown as Bun.Server<DesktopCdpSocketData>,
    {
      grants,
      discoverUpstream: async () => 'ws://127.0.0.1:9222/devtools/browser/new-generation',
      manager: { createBatchTab: async () => ({ targetId: 'unused' }) },
    },
  )

  expect([response?.status, upgraded]).toEqual([409, false])
})

test('Target.createTarget is synthesized through the exact batch window without changing its id', async () => {
  const calls: Array<{ batchId: string; url: string }> = []
  const result = await processCdpClientMessage(
    JSON.stringify({
      id: 42,
      method: 'Target.createTarget',
      params: { url: 'https://example.com/' },
    }),
    'batch-a',
    {
      async createBatchTab(batchId, url) {
        calls.push({ batchId, url })
        return { targetId: 'target-created' }
      },
    },
  )

  expect(calls).toEqual([{ batchId: 'batch-a', url: 'https://example.com/' }])
  expect(result).toEqual({
    kind: 'reply',
    message: JSON.stringify({ id: 42, result: { targetId: 'target-created' } }),
  })
})

test('the proxy rejects extra browser contexts and forwards unrelated CDP verbatim', async () => {
  const manager = {
    async createBatchTab() {
      throw new Error('must not create a tab')
    },
  }
  expect(
    await processCdpClientMessage(
      JSON.stringify({ id: 7, method: 'Target.createBrowserContext', params: {} }),
      'batch-a',
      manager,
    ),
  ).toEqual({
    kind: 'reply',
    message: JSON.stringify({
      id: 7,
      error: {
        code: -32000,
        message: 'Duet uses one shared default browser context',
      },
    }),
  })

  const frame = JSON.stringify({ id: 8, method: 'Target.getTargets' })
  expect(await processCdpClientMessage(frame, 'batch-a', manager)).toEqual({
    kind: 'forward',
    message: frame,
  })
})

test('page target creation attributes opener descendants while ignoring shared workers', async () => {
  const attributed: unknown[] = []
  const removed: unknown[] = []
  const manager = {
    createBatchTab: async () => ({ targetId: 'unused' }),
    async attributePopup(batchId: string, targetId: string, openerId: string) {
      attributed.push({ batchId, targetId, openerId })
      return true
    },
    async removeBatchTarget(batchId: string, targetId: string) {
      removed.push({ batchId, targetId })
      return true
    },
  }

  await observeCdpBrowserMessage(
    JSON.stringify({
      method: 'Target.targetCreated',
      params: {
        targetInfo: { type: 'page', targetId: 'popup-target', openerId: 'root-target' },
      },
    }),
    'batch-a',
    manager,
  )
  await observeCdpBrowserMessage(
    JSON.stringify({
      method: 'Target.targetDestroyed',
      params: { targetId: 'popup-target' },
    }),
    'batch-a',
    manager,
  )
  await observeCdpBrowserMessage(
    JSON.stringify({
      method: 'Target.targetCreated',
      params: {
        targetInfo: { type: 'service_worker', targetId: 'worker', openerId: 'root-target' },
      },
    }),
    'batch-a',
    manager,
  )

  expect(attributed).toEqual([
    { batchId: 'batch-a', targetId: 'popup-target', openerId: 'root-target' },
  ])
  expect(removed).toEqual([{ batchId: 'batch-a', targetId: 'popup-target' }])
})

test('the socket relay keeps transparent frames ordered around intercepted creation', async () => {
  const upstream = new FakeCdpUpstream()
  let opens = 0
  let closes = 0
  const downstream = new FakeCdpDownstream({
    kind: 'desktop-cdp',
    upstreamUrl: 'ws://127.0.0.1:9222/devtools/browser/generation',
    batchId: 'batch-a',
    manager: {
      createBatchTab: async () => ({ targetId: 'target-created' }),
      openBatchLease: async () => {
        opens += 1
      },
      closeBatchLease: async () => {
        closes += 1
      },
    },
    pending: [],
    pendingBytes: 0,
    operation: Promise.resolve(),
    closed: false,
  })
  const handlers = desktopCdpWebSocketHandlers({ connect: () => upstream })
  handlers.open!(downstream as never)
  upstream.readyState = WebSocket.OPEN
  upstream.onopen?.()

  handlers.message!(downstream as never, JSON.stringify({ id: 1, method: 'Target.getTargets' }))
  handlers.message!(
    downstream as never,
    JSON.stringify({ id: 2, method: 'Target.createTarget', params: { url: 'about:blank' } }),
  )
  await downstream.data.operation

  expect(upstream.sent).toEqual([JSON.stringify({ id: 1, method: 'Target.getTargets' })])
  expect(downstream.sent).toEqual([
    JSON.stringify({ id: 2, result: { targetId: 'target-created' } }),
  ])
  handlers.close!(downstream as never, 1000, 'done')
  handlers.close!(downstream as never, 1000, 'duplicate')
  await downstream.data.operation
  expect({ opens, closes }).toEqual({ opens: 1, closes: 1 })
})

class FakeCdpUpstream implements DesktopCdpUpstreamSocket {
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  send(message: string): void {
    this.sent.push(message)
  }
  close(): void {}
}

class FakeCdpDownstream {
  sent: string[] = []
  constructor(readonly data: DesktopCdpSocketData) {}
  send(message: string): void {
    this.sent.push(message)
  }
  close(): void {}
  getBufferedAmount(): number {
    return 0
  }
}
