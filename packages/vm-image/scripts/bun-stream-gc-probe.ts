// Keep errored native response bodies alive after their Response is collected.
// Bun 1.3.14 crashes in stream finalization here; run in a disposable process.
// https://github.com/oven-sh/bun/pull/31963
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
const server = createServer(socket => {
  socket.once('data', () => {
    socket.write(
      'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100000\r\n\r\ndata: hi\n\n',
    )
    setTimeout(() => socket.destroy(), 5)
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')
for (let i = 0; i < 200; i++) {
  let response: Response | undefined = await fetch(`http://127.0.0.1:${address.port}`, {
    signal: AbortSignal.timeout(2_000),
  })
  let body: ReadableStream<Uint8Array> | undefined = response.body!
  await Bun.sleep(15)
  response = undefined
  Bun.gc(true)
  await assert.rejects(Bun.readableStreamToText(body))
  body = undefined
  Bun.gc(true)
}
server.close()
console.log('PASS: 200 errored response streams survived collection')
