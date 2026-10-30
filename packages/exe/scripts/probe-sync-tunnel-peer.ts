import { decodeTunnelFrame, sendTunnelBytes, tunnelHeaders } from '@repo/sync-tunnel'

const [url, exeTokenPath, tunnelTokenPath] = process.argv.slice(2)
if (!url || !exeTokenPath || !tunnelTokenPath) {
  throw new Error('usage: probe-sync-tunnel-peer.ts <ws-url> <exe-token-path> <tunnel-token-path>')
}

const exeVmProxyToken = (await Bun.file(exeTokenPath).text()).trim()
const tunnelToken = (await Bun.file(tunnelTokenPath).text()).trim()
const payloads = ['alpha-from-b', 'beta-from-b']
const echoes: string[] = []
const latenciesMs: number[] = []

await new Promise<void>((resolve, reject) => {
  const BunWebSocket = WebSocket as BunWebSocketConstructor
  const ws = new BunWebSocket(url, {
    headers: tunnelHeaders({ exeVmProxyToken, tunnelToken }),
  })
  let nextPayload = 0
  const timeout = setTimeout(() => {
    ws.close()
    reject(new Error('sync tunnel peer timed out'))
  }, 30_000)

  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => {
    void sendNext()
  })
  ws.addEventListener('message', event => {
    const frame = decodeTunnelFrame(
      event.data instanceof ArrayBuffer ? event.data : new TextEncoder().encode(String(event.data)),
    )
    echoes.push(new TextDecoder().decode(frame.payload))
    latenciesMs.push(performance.now() - sendStartedAt)
    if (echoes.length === payloads.length) {
      clearTimeout(timeout)
      ws.close()
      resolve()
      return
    }
    void sendNext()
  })
  ws.addEventListener('error', () => {
    clearTimeout(timeout)
    reject(new Error('sync tunnel peer websocket errored'))
  })

  let sendStartedAt = 0
  async function sendNext(): Promise<void> {
    sendStartedAt = performance.now()
    await sendTunnelBytes(webSocketSender(ws), new TextEncoder().encode(payloads[nextPayload]!))
    nextPayload += 1
  }
})

console.log(JSON.stringify({ echoes, latenciesMs }, null, 2))

interface BunWebSocketConstructor {
  new (url: string | URL, options?: { headers?: RequestInit['headers'] }): WebSocket
}

function webSocketSender(ws: WebSocket): {
  bufferedAmount: number
  send(data: Uint8Array): unknown
} {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    send(data) {
      return ws.send(toArrayBuffer(data))
    },
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
