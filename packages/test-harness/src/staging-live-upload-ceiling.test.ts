import { expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'

import {
  classifyUploadCeilingProbe,
  probeDeclaredBodyCeiling,
  type UploadCeilingProbe,
} from './staging-live-upload-ceiling.ts'

const answered = (head: string): UploadCeilingProbe => ({
  kind: 'answered',
  declaredBytes: 40_000_000_000,
  status: 413,
  head,
  elapsedMs: 12,
})

// Our refusal is the one carrying both our reason and the CORS header that lets
// a browser read it. Either alone is not enough: a bare 413 is exactly what
// something in front of us would send.
test('reads our own typed, CORS-stamped refusal as the gateway answering', () => {
  expect(
    classifyUploadCeilingProbe(
      answered(
        'HTTP/1.1 413 Payload Too Large\r\n' +
          'access-control-allow-origin: https://app-staging.duet.so\r\n' +
          'content-type: application/json\r\n\r\n' +
          '{"error":"file_too_large","limitBytes":32000000000}',
      ),
    ),
  ).toBe('gateway-refused')
})

test.each([
  'HTTP/1.1 413 Request Entity Too Large\r\nserver: nginx\r\nconnection: close\r\n\r\n',
  'HTTP/1.1 413 Request Entity Too Large\r\nConnection: close\r\n\r\n',
  'HTTP/1.1 413 Payload Too Large\r\ncontent-type: application/json\r\n\r\n{"error":"file_too_large"}',
  'HTTP/1.1 413 Payload Too Large\r\naccess-control-allow-origin: https://app.fixture.test\r\n\r\n',
])('requires both gateway reason and CORS stamp: %s', head => {
  expect(classifyUploadCeilingProbe(answered(head))).toBe('refused-in-front')
})

// Silence is the good answer: the declaration was admitted and the server is
// waiting for a body nobody is going to send.
test('reads silence as the declaration being admitted', () => {
  expect(
    classifyUploadCeilingProbe({
      kind: 'no-answer',
      declaredBytes: 2 * 1024 ** 3,
      elapsedMs: 5_000,
    }),
  ).toBe('admitted')
})

// A dropped TLS connection is no evidence that an upload declaration reached a server.
test('does not classify a broken transport as an admitted upload', async () => {
  const server = createServer(socket => socket.destroy())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture port missing')
    await expect(
      probeDeclaredBodyCeiling({
        vmBaseUrl: `https://localhost:${address.port}`,
        uploadPath: '/upload',
        uploadToken: 'fixture-token',
        filename: 'fixture.bin',
        declaredBytes: 1024,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/(?:ECONNRESET|ECONNREFUSED|TLS|socket|disconnected)/i)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    )
  }
})

test('requires a delivered declaration before silence can count as admission', async () => {
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture port missing')
    await expect(
      probeDeclaredBodyCeiling({
        vmBaseUrl: `https://localhost:${address.port}`,
        uploadPath: '/upload',
        uploadToken: 'fixture-token',
        filename: 'fixture.bin',
        declaredBytes: 1024,
        timeoutMs: 50,
      }),
    ).rejects.toThrow('Upload declaration was not delivered before the probe deadline')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    )
  }
})
