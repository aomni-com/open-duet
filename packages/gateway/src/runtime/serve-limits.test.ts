import { expect, test } from 'bun:test'

import { DRIVE_UPLOAD_MAX_BYTES } from '@repo/contract'

import { gatewayServeLimits } from './serve-limits'

/**
 * This assertion used to read "the transport admits the largest disk any plan
 * provisions", which was the right invariant while free space was the only
 * thing that could refuse an upload. It is not the invariant any more: the
 * Drive now publishes a per-file cap that deliberately sits *below* Pro and Max
 * disks, so admitting the largest disk would say nothing about whether the
 * transport can be the binding limit. Do not restore the old claim — what
 * matters is only that the route, which can explain itself, always answers
 * before Bun, which cannot.
 */
test('the transport ceiling stays above the cap it exists to protect', () => {
  expect(gatewayServeLimits.maxRequestBodySize).toBeGreaterThan(DRIVE_UPLOAD_MAX_BYTES)
})

test('a declaration between the cap and the ceiling is answered by the route', async () => {
  const reached: string[] = []
  const server = Bun.serve({
    port: 0,
    ...gatewayServeLimits,
    fetch: request => {
      reached.push(request.headers.get('content-length') ?? '')
      return new Response('reached the gateway')
    },
  })

  try {
    // Just over the cap: the route must get it, so the caller reads a typed,
    // CORS-stamped 413 rather than Bun's headerless one.
    const overCap = await sendHead(server.port!, DRIVE_UPLOAD_MAX_BYTES + 1)
    expect(overCap).toStartWith('HTTP/1.1 200')
    expect(reached).toEqual([String(DRIVE_UPLOAD_MAX_BYTES + 1)])

    // Above the ceiling, Bun cuts in first. This is the original bug's shape,
    // pinned so the window it lives in cannot silently widen.
    const overCeiling = await sendHead(server.port!, gatewayServeLimits.maxRequestBodySize + 1)
    expect(overCeiling).toStartWith('HTTP/1.1 413')
    expect(overCeiling).not.toInclude('access-control-allow-origin')
    expect(reached).toHaveLength(1)
  } finally {
    server.stop(true)
  }
})

/**
 * The request head and nothing else. A body cap that rejects on the declaration
 * answers immediately, so the seven gigabytes never have to be sent to learn
 * whether they would have been allowed.
 */
async function sendHead(port: number, contentLength: number): Promise<string> {
  const chunks: Uint8Array[] = []
  const closed = Promise.withResolvers<void>()
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open: connection => {
        connection.write(
          [
            'PUT /v1/files/uploads/backup.zip HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Origin: https://app.duet.so',
            `Content-Length: ${contentLength}`,
            '',
            '',
          ].join('\r\n'),
        )
      },
      data: (_connection, data) => {
        chunks.push(new Uint8Array(data))
        closed.resolve()
      },
      close: () => closed.resolve(),
    },
  })
  await closed.promise
  socket.end()
  return Buffer.concat(chunks).toString('utf8')
}
