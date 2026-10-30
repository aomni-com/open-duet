import { appendFileSync, writeFileSync } from 'node:fs'

import { createProbeCdpRelay } from './probe-cdp-proxy-relay.ts'

const upstreamUrl = process.env.UPSTREAM_WS
const readyFile = process.env.PROXY_READY_FILE
const methodsFile = process.env.PROXY_METHODS_FILE
if (!upstreamUrl || !readyFile || !methodsFile) {
  throw new Error('UPSTREAM_WS, PROXY_READY_FILE, and PROXY_METHODS_FILE are required')
}

let actuatorId = 0
const relay = createProbeCdpRelay({
  upstreamUrl,
  createTarget: async params => {
    const result = await sendCdp(upstreamUrl, {
      id: ++actuatorId,
      method: 'Target.createTarget',
      params,
    })
    if (!isRecord(result) || typeof result.targetId !== 'string') {
      throw new Error('actuator did not return a target id')
    }
    appendFileSync(methodsFile, `${JSON.stringify({ actuator: 'Target.createTarget' })}\n`)
    return result.targetId
  },
  onMethod: method => appendFileSync(methodsFile, `${JSON.stringify({ relay: method })}\n`),
})

writeFileSync(readyFile, `${relay.url}\n`)
console.log(`PROXY_URL=${relay.url}`)
await new Promise(() => {})

async function sendCdp(
  url: string,
  command: { id: number; method: string; params?: Record<string, unknown> },
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error(`actuator ${command.method} timed out`))
    }, 10_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify(command)), { once: true })
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as unknown
      if (!isRecord(message) || message.id !== command.id) return
      clearTimeout(timeout)
      socket.close()
      if (isRecord(message.error)) {
        reject(new Error(String(message.error.message ?? 'actuator command failed')))
        return
      }
      resolve(message.result)
    })
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout)
        reject(new Error(`actuator ${command.method} failed`))
      },
      { once: true },
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
