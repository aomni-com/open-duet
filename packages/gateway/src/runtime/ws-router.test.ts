import { describe, expect, test } from 'bun:test'

import { createWebSocketRouter, runWebSocketUpgradeHandlers } from './ws-router'

type TestSocketData =
  | { kind: 'tunnel'; connectionId: string }
  | { kind: 'desktop'; connectionId: string }

describe('websocket router', () => {
  test.each([null, undefined])(
    'continues after %s until an upgrade handler accepts the request',
    async declined => {
      const visited: string[] = []
      const response = await runWebSocketUpgradeHandlers(new Request('https://vm.test/socket'), [
        () => {
          visited.push('tunnel')
          return declined
        },
        () => {
          visited.push('desktop')
          return new Response('upgraded', { status: 200 })
        },
        () => {
          visited.push('unexpected')
          return null
        },
      ])

      expect(visited).toEqual(['tunnel', 'desktop'])
      expect(await response?.text()).toBe('upgraded')
    },
  )

  test('dispatches a message only to the handler for its protocol', () => {
    const received: string[] = []
    const router = createWebSocketRouter<TestSocketData>({
      tunnel: {
        message(ws, message) {
          received.push(`tunnel:${ws.data.connectionId}:${message}`)
        },
      },
      desktop: {
        message(ws, message) {
          received.push(`desktop:${ws.data.connectionId}:${message}`)
        },
      },
    })

    router.message(socket({ kind: 'desktop', connectionId: 'viewer-a' }), 'pixels')

    expect(received).toEqual(['desktop:viewer-a:pixels'])
  })

  test('closes a socket tagged with an unknown protocol', () => {
    const router = createWebSocketRouter<TestSocketData>({
      tunnel: { message() {} },
      desktop: { message() {} },
    })
    const closes: Array<{ code?: number; reason?: string }> = []
    const ws = {
      data: { kind: 'unknown', connectionId: 'mystery' },
      close(code?: number, reason?: string) {
        closes.push({ code, reason })
      },
    } as unknown as Bun.ServerWebSocket<TestSocketData>

    expect(() => router.message(ws, 'ignored')).not.toThrow()
    expect(closes).toEqual([{ code: 1008, reason: 'unknown websocket protocol' }])
  })

  test('dispatches lifecycle events to the tagged protocol', () => {
    const received: string[] = []
    const router = createWebSocketRouter<TestSocketData>({
      tunnel: {
        message() {},
        open() {
          received.push('open')
        },
        drain() {
          received.push('drain')
        },
        close(ws, code, reason) {
          received.push(`close:${ws.data.connectionId}:${code}:${reason}`)
        },
      },
      desktop: { message() {} },
    })
    const ws = socket({ kind: 'tunnel', connectionId: 'accept-a' })

    router.open?.(ws)
    router.drain?.(ws)
    router.close?.(ws, 1000, 'done')

    expect(received).toEqual(['open', 'drain', 'close:accept-a:1000:done'])
  })
})

function socket(data: TestSocketData): Bun.ServerWebSocket<TestSocketData> {
  return { data } as Bun.ServerWebSocket<TestSocketData>
}
