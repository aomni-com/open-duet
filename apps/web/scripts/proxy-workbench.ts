import { createHash } from 'node:crypto'

const port = Number(process.env.DUET_PROXY_WORKBENCH_PORT ?? 4010)
const binaryFixture = Uint8Array.from({ length: 256 }, (_, index) => index)

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/v1/workbench/json') {
      return Response.json({
        method: request.method,
        query: Object.fromEntries(url.searchParams),
        body: request.body === null ? null : await request.json(),
      })
    }
    if (url.pathname === '/v1/workbench/binary') {
      const etag = '"duet-proxy-workbench"'
      const range = parseRange(request.headers.get('range'), binaryFixture.byteLength)
      if (range === null) {
        return new Response(binaryFixture, {
          headers: {
            'accept-ranges': 'bytes',
            'content-type': 'application/octet-stream',
            etag,
          },
        })
      }
      const bytes = binaryFixture.slice(range.start, range.end + 1)
      return new Response(bytes, {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes ${range.start}-${range.end}/${binaryFixture.byteLength}`,
          'content-type': 'application/octet-stream',
          etag,
        },
      })
    }
    if (url.pathname === '/v1/workbench/upload' && request.method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer())
      return Response.json(
        {
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        { status: 201 },
      )
    }
    if (url.pathname === '/v1/workbench/events') {
      const previous = Number(request.headers.get('last-event-id') ?? 0)
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`id: ${previous + 1}\ndata: first\n\n`))
            await Bun.sleep(750)
            controller.enqueue(encoder.encode(`id: ${previous + 2}\ndata: second\n\n`))
            controller.close()
          },
        }),
        { headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' } },
      )
    }
    if (url.pathname === '/v1/workbench/slow') {
      await abortableDelay(request.signal, 10_000)
      return Response.json({ completed: true })
    }
    if (url.pathname === '/v1/workbench/failure') {
      return Response.json({ error: 'workbench_failure' }, { status: 503 })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  },
})

console.log(`Duet proxy upstream workbench: ${server.url}`)
console.log('Set DUET_API_URL to this origin, run the web app, then use /api/duet/workbench/*.')
console.log(
  'Endpoints: json, binary (Range), upload (PUT), events (slow + Last-Event-ID), slow (abort), failure.',
)

async function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) throw new DOMException('client aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('client aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function parseRange(header: string | null, length: number): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? '')
  if (match === null) return null
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), length - 1)
  return start <= end && start < length ? { start, end } : null
}
