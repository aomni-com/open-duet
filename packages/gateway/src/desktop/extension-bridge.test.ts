import { describe, expect, test } from 'bun:test'

import { DESKTOP_BROWSER_EXTENSION_ID } from '@repo/contract'

import {
  BrowserExtensionBridge,
  handleBrowserExtensionUpgrade,
  type BrowserExtensionSocketData,
  parseBrowserExtensionMessage,
  type BrowserExtensionSocket,
} from './extension-bridge'

class FakeSocket implements BrowserExtensionSocket {
  sent: string[] = []
  closes: Array<{ code: number; reason: string }> = []

  send(message: string): void {
    this.sent.push(message)
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason })
  }
}

test('extension messages reject unknown fields and malformed response envelopes', () => {
  expect(
    parseBrowserExtensionMessage(
      JSON.stringify({
        type: 'hello',
        extensionId: DESKTOP_BROWSER_EXTENSION_ID,
        workerStartedAt: 1,
      }),
    ),
  ).toEqual({ type: 'hello', extensionId: DESKTOP_BROWSER_EXTENSION_ID, workerStartedAt: 1 })
  expect(() =>
    parseBrowserExtensionMessage(
      JSON.stringify({ type: 'hello', extensionId: 'wrong', extra: true }),
    ),
  ).toThrow('invalid browser extension message')
  expect(() =>
    parseBrowserExtensionMessage(JSON.stringify({ type: 'response', requestId: 'r1' })),
  ).toThrow('invalid browser extension message')
  expect(() =>
    parseBrowserExtensionMessage(
      JSON.stringify({ type: 'event', event: 'focusTransient', windowId: 12, at: 1 }),
    ),
  ).toThrow('invalid browser extension message')
})

test('extension websocket upgrade requires the exact pinned Chrome origin', () => {
  const bridge = new BrowserExtensionBridge()
  let upgraded = false
  const server = {
    requestIP() {
      return { address: '127.0.0.1', port: 40_000, family: 'IPv4' }
    },
    upgrade() {
      upgraded = true
      return true
    },
  } as unknown as Bun.Server<BrowserExtensionSocketData>
  const request = (origin: string) =>
    new Request('http://127.0.0.1:3000/v1/desktop/browser-extension/socket', {
      headers: { upgrade: 'websocket', origin },
    })

  expect(
    handleBrowserExtensionUpgrade(
      request(`chrome-extension://${DESKTOP_BROWSER_EXTENSION_ID}`),
      server,
      bridge,
    ),
  ).toBeUndefined()
  expect(upgraded).toBe(true)
  expect(
    handleBrowserExtensionUpgrade(request('https://external.example'), server, bridge),
  ).toMatchObject({ status: 403 })

  const externalServer = {
    ...server,
    requestIP() {
      return { address: '203.0.113.9', port: 40_000, family: 'IPv4' }
    },
  } as unknown as Bun.Server<BrowserExtensionSocketData>
  expect(
    handleBrowserExtensionUpgrade(
      request(`chrome-extension://${DESKTOP_BROWSER_EXTENSION_ID}`),
      externalServer,
      bridge,
    ),
  ).toMatchObject({ status: 403 })
})

describe('browser extension bridge', () => {
  test('accepts only the pinned extension identity and replaces an older worker connection', () => {
    const bridge = new BrowserExtensionBridge()
    const first = new FakeSocket()
    const second = new FakeSocket()
    const connections: number[] = []
    bridge.subscribeConnection(connection => connections.push(connection.workerStartedAt))

    bridge.open(first)
    bridge.message(
      first,
      JSON.stringify({ type: 'hello', extensionId: 'wrong', workerStartedAt: 1 }),
    )
    expect(first.closes).toEqual([{ code: 1008, reason: 'unexpected extension identity' }])

    bridge.open(first)
    bridge.message(
      first,
      JSON.stringify({
        type: 'hello',
        extensionId: DESKTOP_BROWSER_EXTENSION_ID,
        workerStartedAt: 2,
      }),
    )
    bridge.open(second)
    bridge.message(
      second,
      JSON.stringify({
        type: 'hello',
        extensionId: DESKTOP_BROWSER_EXTENSION_ID,
        workerStartedAt: 3,
      }),
    )
    expect(first.closes.at(-1)).toEqual({ code: 1012, reason: 'new extension worker connected' })
    expect(bridge.connected()).toBe(true)
    expect(connections).toEqual([2, 3])
  })

  test('correlates replies, forwards events, and ignores duplicate replies', async () => {
    const bridge = new BrowserExtensionBridge()
    const socket = new FakeSocket()
    const events: unknown[] = []
    bridge.subscribe(event => events.push(event))
    bridge.open(socket)
    bridge.message(
      socket,
      JSON.stringify({
        type: 'hello',
        extensionId: DESKTOP_BROWSER_EXTENSION_ID,
        workerStartedAt: 1,
      }),
    )

    const response = bridge.request({ command: 'snapshot' })
    const request = JSON.parse(socket.sent[0]!) as { requestId: string }
    bridge.message(
      socket,
      JSON.stringify({ type: 'response', requestId: request.requestId, result: { windows: [] } }),
    )
    bridge.message(
      socket,
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        result: { windows: ['duplicate'] },
      }),
    )
    bridge.message(
      socket,
      JSON.stringify({ type: 'event', event: 'focusSettled', windowId: 12, at: 10 }),
    )

    expect(await response).toEqual({ windows: [] })
    expect(events).toEqual([{ type: 'event', event: 'focusSettled', windowId: 12, at: 10 }])
  })

  test('rejects a structurally valid envelope with the wrong command result', async () => {
    const bridge = new BrowserExtensionBridge()
    const socket = new FakeSocket()
    bridge.message(
      socket,
      JSON.stringify({
        type: 'hello',
        extensionId: DESKTOP_BROWSER_EXTENSION_ID,
        workerStartedAt: 1,
      }),
    )

    const response = bridge.request({ command: 'createWindow', url: 'about:blank' })
    const request = JSON.parse(socket.sent[0]!) as { requestId: string }
    bridge.message(
      socket,
      JSON.stringify({ type: 'response', requestId: request.requestId, result: { windows: [] } }),
    )

    await expect(response).rejects.toThrow('invalid browser extension response')
  })

  test('rejects pending commands on timeout and disconnect', async () => {
    const callbacks: Array<() => void> = []
    const bridge = new BrowserExtensionBridge({
      setTimer: callback => {
        callbacks.push(callback)
        return callbacks.length
      },
      clearTimer: () => undefined,
    })
    const socket = new FakeSocket()
    bridge.open(socket)
    bridge.message(
      socket,
      JSON.stringify({
        type: 'hello',
        extensionId: DESKTOP_BROWSER_EXTENSION_ID,
        workerStartedAt: 1,
      }),
    )

    const timedOut = bridge.request({ command: 'snapshot' })
    callbacks.shift()?.()
    await expect(timedOut).rejects.toThrow('browser extension command timed out')

    const disconnected = bridge.request({ command: 'snapshot' })
    bridge.close(socket)
    await expect(disconnected).rejects.toThrow('browser extension disconnected')
  })
})
