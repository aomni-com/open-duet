# Live updates

WebSockets are not supported for apps; use SSE.

```ts
// server.ts — one process, UI + API + events
Bun.serve({ port, idleTimeout: 255, fetch: app.fetch })
// ^ REQUIRED. Bun's default is a 10s idle timeout, which is shorter
//   than the heartbeat below — the server would kill its own stream.
//   The gateway hit exactly this (runtime/http.ts:1188).
//   Without it Bun reports:
//   [Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.

const watchers = new Set<(frame: string) => void>()
const announce = () => { for (const send of watchers) send('data: {}\n\n') }

app.post('/api/tasks', async c => {
  const task = createTask(await c.req.json())
  announce()
  return c.json(task, 201)
})

app.get('/events', c => {
  const stream = new ReadableStream({
    start(controller) {
      const send = (frame: string) => controller.enqueue(encoder.encode(frame))
      watchers.add(send)
      const ping = setInterval(() => send(': ping\n\n'), 15_000)
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(ping); watchers.delete(send); controller.close()
      })
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
})
```

```js
<!-- the page -->
new EventSource('/events').onmessage = () => refresh()
// EventSource reconnects by itself; do not write retry logic.
```

The `abort` listener is the load-bearing line. Every reconnect through the edge
leaves a dead writer behind without it, and a pane open all afternoon slowly fills the app's
memory with them.
