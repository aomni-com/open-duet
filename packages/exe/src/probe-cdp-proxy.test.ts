import { afterEach, expect, test } from 'bun:test'

import { createProbeCdpRelay } from '../scripts/probe-cdp-proxy-relay.ts'

const sockets: WebSocket[] = []
const releaseUpgrades: Array<() => void> = []
const upgradeHandlers: Promise<void>[] = []
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = []

afterEach(async () => {
  for (const release of releaseUpgrades.splice(0)) release()
  await Promise.all(upgradeHandlers.splice(0))
  for (const socket of sockets.splice(0)) socket.close()
  for (const server of servers.splice(0)) server.stop(true)
})

test('the relay changes only Target.createTarget and preserves the caller request id', async () => {
  const upstream = createRecordingCdp()
  const actuatorCalls: Array<Record<string, unknown> | undefined> = []
  const relay = createProbeCdpRelay({
    upstreamUrl: upstream.url,
    createTarget: async params => {
      actuatorCalls.push(params)
      return 'actuator-target-7'
    },
  })
  servers.push(relay)

  const socket = await connect(relay.url)
  const messages = collectMessages(socket)
  socket.send(JSON.stringify({ id: 41, method: 'Browser.getVersion' }))
  socket.send(
    JSON.stringify({ id: 42, method: 'Target.createTarget', params: { url: 'about:blank' } }),
  )

  const responses = [await messages.next(), await messages.next()].sort(
    (left, right) => (left as { id: number }).id - (right as { id: number }).id,
  )
  expect(responses).toEqual([
    { id: 41, result: { product: 'Mock Chrome' } },
    { id: 42, result: { targetId: 'actuator-target-7' } },
  ])
  expect(upstream.commands).toEqual([{ id: 41, method: 'Browser.getVersion' }])
  expect(actuatorCalls).toEqual([{ url: 'about:blank' }])

  socket.close()
})

test('the relay preserves flat-session envelopes and unsolicited target events', async () => {
  const upstream = createRecordingCdp()
  const relay = createProbeCdpRelay({
    upstreamUrl: upstream.url,
    createTarget: async () => 'unused',
  })
  servers.push(relay)

  const socket = await connect(relay.url)
  const messages = collectMessages(socket)
  socket.send(
    JSON.stringify({
      id: 8,
      sessionId: 'flat-session-1',
      method: 'Runtime.enable',
      params: {},
    }),
  )

  expect(await messages.next()).toEqual({
    id: 8,
    sessionId: 'flat-session-1',
    result: { enabled: true },
  })
  expect(await messages.next()).toEqual({
    method: 'Target.targetCreated',
    params: { targetInfo: { targetId: 'visible-other-target', type: 'page' } },
  })
  expect(upstream.commands).toEqual([
    { id: 8, sessionId: 'flat-session-1', method: 'Runtime.enable', params: {} },
  ])

  socket.close()
})

test('a downstream disconnect closes the Chrome-side connection with the same code', async () => {
  const upstream = createRecordingCdp()
  const relay = createProbeCdpRelay({
    upstreamUrl: upstream.url,
    createTarget: async () => 'unused',
  })
  servers.push(relay)

  const socket = await connect(relay.url)
  const messages = collectMessages(socket)
  socket.send(JSON.stringify({ id: 5, method: 'Browser.getVersion' }))
  await messages.next()
  socket.close(4001, 'probe complete')

  expect((await upstream.closed).code).toBe(4001)
})

test('the relay sheds a client whose pending commands exceed its upstream budget', async () => {
  let releaseUpgrade!: () => void
  const heldUpgrade = new Promise<void>(resolve => {
    releaseUpgrade = resolve
  })
  releaseUpgrades.push(releaseUpgrade)
  let startedUpgrade!: () => void
  const upgradeStarted = new Promise<void>(resolve => {
    startedUpgrade = resolve
  })
  const delayed = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, bunServer) {
      let finishUpgrade!: () => void
      upgradeHandlers.push(
        new Promise<void>(resolve => {
          finishUpgrade = resolve
        }),
      )
      startedUpgrade()
      await heldUpgrade
      try {
        if (bunServer.upgrade(request)) return
        return new Response('upgrade required', { status: 426 })
      } finally {
        finishUpgrade()
      }
    },
    websocket: { message() {} },
  })
  servers.push(delayed)
  const relay = createProbeCdpRelay({
    upstreamUrl: `ws://127.0.0.1:${delayed.port}/devtools/browser/delayed`,
    createTarget: async () => 'unused',
    maxPendingBytes: 8,
  })
  servers.push(relay)

  const socket = await connect(relay.url)
  const closed = new Promise<CloseEvent>(resolve =>
    socket.addEventListener('close', resolve, { once: true }),
  )
  await upgradeStarted
  socket.send(JSON.stringify({ id: 3, method: 'Browser.getVersion' }))

  expect((await closed).code).toBe(1013)
})

function createRecordingCdp(): {
  url: string
  commands: unknown[]
  closed: Promise<{ code: number; reason: string }>
} {
  const commands: unknown[] = []
  let resolveClosed!: (value: { code: number; reason: string }) => void
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    resolveClosed = resolve
  })
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request, { data: {} })) return
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      message(ws, frame) {
        const command = JSON.parse(String(frame)) as {
          id: number
          method: string
          sessionId?: string
        }
        commands.push(command)
        if (command.method === 'Runtime.enable') {
          ws.send(
            JSON.stringify({
              id: command.id,
              sessionId: command.sessionId,
              result: { enabled: true },
            }),
          )
          ws.send(
            JSON.stringify({
              method: 'Target.targetCreated',
              params: { targetInfo: { targetId: 'visible-other-target', type: 'page' } },
            }),
          )
          return
        }
        ws.send(
          JSON.stringify({
            id: command.id,
            result: command.method === 'Browser.getVersion' ? { product: 'Mock Chrome' } : {},
          }),
        )
      },
      close(_ws, code, reason) {
        resolveClosed({ code, reason })
      },
    },
  })
  servers.push(server)
  return { url: `ws://127.0.0.1:${server.port}/devtools/browser/mock`, commands, closed }
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    })
  })
  return socket
}

function collectMessages(socket: WebSocket): { next(): Promise<unknown> } {
  const received: unknown[] = []
  const waiting: Array<(message: unknown) => void> = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as unknown
    const resolve = waiting.shift()
    if (resolve === undefined) received.push(message)
    else resolve(message)
  })
  return {
    async next() {
      if (received.length > 0) return received.shift()
      return await new Promise(resolve => waiting.push(resolve))
    },
  }
}
