import { afterEach, expect, test } from 'bun:test'

import { discoverBrowserGeneration, discoverBrowserWebSocket } from './browser'

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

test('browser discovery returns the one browser-level CDP generation', async () => {
  let server: Bun.Server<Record<string, never>>
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/json/version') {
        return new Response('not found', { status: 404 })
      }
      return Response.json({
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/generation-a`,
      })
    },
  })
  servers.push(server)
  const origin = `http://127.0.0.1:${server.port}`

  expect(await discoverBrowserWebSocket(origin)).toBe(
    `ws://127.0.0.1:${server.port}/devtools/browser/generation-a`,
  )
  expect(await discoverBrowserGeneration(origin)).toBe('generation-a')
})
