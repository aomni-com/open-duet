import {
  MCP_FORWARDED_REQUEST_HEADERS,
  readJsonRpcRequest,
  readJsonRpcResult,
  STRIPPED_UPSTREAM_RESPONSE_HEADERS,
  type FetchLike,
} from '@repo/contract'

import { capMcpPayload, splitSseFrames } from './result-cap'

/**
 * The one MCP byte path. Composio and any custom server differ in everything
 * about their lifecycles and agree on exactly this: a request arrives from a
 * runner, an Authorization-shaped header is injected, bytes are forwarded, the
 * upstream's encoding headers are stripped, and an oversized tool result is
 * capped before it can reach a model. There is no second forwarder.
 */
export interface McpUpstreamTarget {
  url: string
  headers: Record<string, string>
  /**
   * What this target already knows about its `tools/list`, and where to put
   * what it learns. Absent, every list goes upstream.
   */
  toolsList?: {
    /** The result to answer with, when the source remembers one. */
    known?: unknown
    /** Receives a result the upstream just gave; must not be awaited by the caller. */
    remember: (result: unknown) => void
  }
  /** Drop the caller's mcp-session-id: the upstream identity behind this route changed. */
  resetTransportSession?: boolean
}

/**
 * A local failure: the request did not come back with an upstream's answer, so
 * the status beside it is Duet's own reading of what went wrong rather than
 * something the third party said.
 */
export type McpProxyFailure =
  /* Nothing answered: DNS, TLS, a refused connection, a blocked address. */
  | 'unreachable'
  /* One frame grew past the ceiling with no boundary in sight. */
  | 'oversized_frame'

export interface McpProxyOutcome {
  status: number
  cappedFrom?: number
  failure?: McpProxyFailure
  error?: string
}

export interface McpUpstreamSource {
  /** For logging and health attribution only. Never rendered. */
  readonly sourceId: string
  resolve(attempt: 'first' | 'after-unauthorized'): Promise<McpUpstreamTarget>
  /**
   * Whether a failed status is worth re-resolving the target and retrying once.
   *
   * Composio answers from its row without asking the provider whether the
   * session still exists, so a vanished session shows itself only as the
   * endpoint refusing — that refusal is what a second, provider-backed resolve
   * repairs. Custom servers do not define it: their credential refresh is
   * expiry-driven, and a refresh-on-401 would compete with it.
   */
  retryable?(status: number): boolean
  settled?(outcome: McpProxyOutcome): void
}

/**
 * How long an upstream has to start answering.
 *
 * The number to beat is the MCP SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`,
 * which the runner does not override — and the runner connects servers one at a
 * time, so a server that accepts a connection and then goes silent costs 60s on
 * `connect` plus 60s on `listTools`, serially, on every turn start. Slice 00
 * measured real servers answering `initialize` and `tools/list` in well under a
 * second, so seconds of headroom buy nothing and cost every turn.
 *
 * This bounds time-to-first-byte, not the life of a stream: the standalone SSE
 * channel an MCP client keeps open must be allowed to stay silent for as long
 * as the server has nothing to say.
 */
export const MCP_UPSTREAM_TIMEOUT_MS = 5_000

/**
 * `fetch` that gives up waiting for response headers, answering 504 rather than
 * hanging. A 504 is a far better outcome for the runner than a stall: it is a
 * failure the SDK reports in milliseconds instead of a minute of silence.
 */
export function withUpstreamTimeout(
  fetchImpl: FetchLike,
  timeoutMs: number = MCP_UPSTREAM_TIMEOUT_MS,
): FetchLike {
  return async (input, init) => {
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, timeoutMs)
    // The caller's own cancellation still has to reach the socket: replacing
    // its signal rather than chaining it would leave a cancelled request
    // running to completion upstream.
    init?.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal })
    } catch (error) {
      if (!expired) throw error
      return Response.json({ error: 'upstream_timeout' }, { status: 504 })
    } finally {
      // Cleared once the headers are in: whatever the body does afterwards is
      // the stream's business, not this deadline's.
      clearTimeout(timer)
    }
  }
}

export async function forwardMcpRequest(
  fetchImpl: FetchLike,
  request: Request,
  source: McpUpstreamSource,
  limits: { maxToolResultBytes: number },
): Promise<Response> {
  // Buffered once, up front: a retry needs the same bytes a second time, and a
  // consumed stream cannot be replayed.
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : new Uint8Array(await request.arrayBuffer())
  const head = body === undefined ? undefined : readJsonRpcRequest(new TextDecoder().decode(body))
  const toolsListId = head?.method === 'tools/list' && head.id !== undefined ? head.id : undefined

  // A resolve failure is the source's own problem and belongs to its caller;
  // only a request that actually left the building is this source's outcome.
  const send = async (target: McpUpstreamTarget): Promise<Response> => {
    try {
      return await sendToUpstream(fetchImpl, request, body, target)
    } catch (error) {
      source.settled?.({
        status: 502,
        failure: 'unreachable',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  let target = await source.resolve('first')
  const toolsList = toolsListId === undefined ? undefined : target.toolsList
  if (toolsList?.known !== undefined) {
    return Response.json(
      { jsonrpc: '2.0', id: toolsListId, result: toolsList.known },
      { headers: { 'x-duet-mcp-cache': 'hit' } },
    )
  }
  let upstream = await send(target)
  if (source.retryable?.(upstream.status) === true) {
    target = await source.resolve('after-unauthorized')
    upstream = await send(target)
  }

  const headers = new Headers(upstream.headers)
  // fetch already decoded the upstream body; its encoding headers would
  // mislabel our plaintext stream and break strict client decoders. They are
  // also wrong by construction once the cap rewrites a frame.
  for (const name of STRIPPED_UPSTREAM_RESPONSE_HEADERS) headers.delete(name)

  // A tools/list answer is one small frame, so reading it whole to learn it
  // costs nothing the streaming path was protecting.
  if (
    toolsListId !== undefined &&
    toolsList !== undefined &&
    upstream.ok &&
    upstream.body !== null
  ) {
    const text = await readBounded(upstream.body, frameCeiling(limits.maxToolResultBytes))
    if (text === null) {
      source.settled?.({ status: upstream.status, failure: 'oversized_frame' })
      return oversizedResponse(headers)
    }
    const result = readJsonRpcResult(text, upstream.headers.get('content-type'), toolsListId)
    if (result !== undefined) toolsList.remember(result)
    // Readable in devtools and from a probe: whether the list was learned, or
    // the frame was not one it could be learned from.
    headers.set('x-duet-mcp-cache', result === undefined ? 'unlearnable' : 'learned')
    source.settled?.({ status: upstream.status })
    return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers })
  }

  return await cappedResponse(upstream, headers, source, limits.maxToolResultBytes)
}

async function sendToUpstream(
  fetchImpl: FetchLike,
  request: Request,
  body: Uint8Array | undefined,
  target: McpUpstreamTarget,
): Promise<Response> {
  const headers = new Headers()
  for (const name of MCP_FORWARDED_REQUEST_HEADERS) {
    if (name === 'mcp-session-id' && target.resetTransportSession === true) continue
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  for (const [name, value] of Object.entries(target.headers)) headers.set(name, value)
  return await fetchImpl(target.url, {
    method: request.method,
    headers,
    // body wraps a fresh, exact-length ArrayBuffer (Uint8Array over
    // arrayBuffer()); pass the buffer so the type is a clean BodyInit.
    ...(body === undefined || body.byteLength === 0 ? {} : { body: body.buffer as ArrayBuffer }),
  })
}

function mediaType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * How far past the result cap one indivisible chunk of response may grow.
 *
 * The cap limits what reaches the MODEL. It cannot limit what the proxy holds
 * on the way there, because a JSON-RPC frame is only capable of being capped
 * once it is whole — half a frame is unparseable JSON. So a server that streams
 * without ever emitting a frame boundary grows the buffer inside a serverless
 * invocation for as long as it likes, and a URL a user pasted is exactly the
 * kind of upstream that might.
 *
 * The multiple is generous on purpose: slice 00 measured a legitimate 1.3 MB
 * single result against a 128 KiB cap, so "one frame is small" is not an
 * assumption available to us. At the shipped cap this ceiling is 10 MiB — far
 * above anything real and still a bound. Past it the request fails: an upstream
 * that has sent 10 MiB with no boundary is not going to produce a valid one.
 */
const MAX_FRAME_MULTIPLE = 80

function frameCeiling(maxToolResultBytes: number): number {
  return maxToolResultBytes * MAX_FRAME_MULTIPLE
}

/**
 * The whole body, or nothing, once it passes the ceiling. Reading a JSON
 * response is the one place the proxy has no frame boundaries to release
 * against, so the limit is the only thing standing between a hostile upstream
 * and an unbounded allocation inside the invocation.
 */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string | null> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > limit) return null
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function oversizedResponse(headers: Headers): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json')
  return new Response(JSON.stringify({ error: 'upstream_response_too_large' }), {
    status: 502,
    headers: responseHeaders,
  })
}

async function cappedResponse(
  upstream: Response,
  headers: Headers,
  source: McpUpstreamSource,
  maxToolResultBytes: number,
): Promise<Response> {
  const contentType = upstream.headers.get('content-type')
  const type = mediaType(upstream.headers)

  // A bodiless status (204 on session teardown, 304) must stay bodiless: giving
  // one a body — even an empty string — is a constructor error, not a response.
  if (type === 'application/json' && upstream.body !== null) {
    const text = await readBounded(upstream.body, frameCeiling(maxToolResultBytes))
    if (text === null) {
      source.settled?.({ status: upstream.status, failure: 'oversized_frame' })
      return oversizedResponse(headers)
    }
    const capped = capMcpPayload(text, contentType, maxToolResultBytes)
    source.settled?.({
      status: upstream.status,
      ...(capped.cappedFrom === undefined ? {} : { cappedFrom: capped.cappedFrom }),
    })
    return new Response(capped.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  }

  if (type === 'text/event-stream' && upstream.body !== null) {
    return new Response(
      upstream.body.pipeThrough(cappingFrameStream(upstream, source, maxToolResultBytes)),
      { status: upstream.status, statusText: upstream.statusText, headers },
    )
  }

  source.settled?.({ status: upstream.status })
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

/**
 * Cap an SSE body frame by frame instead of buffering it.
 *
 * Buffering would be simpler and would break the transport: the standalone GET
 * stream an MCP client opens for server-initiated messages never ends, so a
 * proxy that waits for the last byte hangs it until the function times out.
 * Frames are self-delimiting, so each one can be capped and released the moment
 * its boundary arrives, which is also the only unit the cap may work on — a
 * partial frame is not parseable JSON.
 */
function cappingFrameStream(
  upstream: Response,
  source: McpUpstreamSource,
  maxToolResultBytes: number,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const ceiling = frameCeiling(maxToolResultBytes)
  let pending = ''
  let pendingBytes = 0
  let cappedFrom = 0

  const emit = (text: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    const capped = capMcpPayload(text, 'text/event-stream', maxToolResultBytes)
    if (capped.cappedFrom !== undefined) cappedFrom += capped.cappedFrom
    controller.enqueue(encoder.encode(capped.body))
  }

  return new TransformStream({
    transform(chunk, controller) {
      pendingBytes += chunk.byteLength
      pending += decoder.decode(chunk, { stream: true })
      const frames = splitSseFrames(pending)
      // The last entry is a frame only if it ended on a boundary; otherwise it
      // is a partial frame that must wait for the rest of its bytes.
      const trailing = frames.at(-1)
      const complete = trailing?.terminator === '' ? frames.slice(0, -1) : frames
      pending = trailing?.terminator === '' ? trailing.text : ''
      if (complete.length === 0) {
        // The buffer only shrinks at a boundary, so this is the one place a
        // frameless stream can be stopped. Erroring the stream is the whole
        // point: reading on would be agreeing to hold whatever it sends.
        if (pendingBytes > ceiling) {
          source.settled?.({ status: upstream.status, failure: 'oversized_frame' })
          controller.error(new Error('mcp upstream frame exceeded the buffer ceiling'))
        }
        return
      }
      pendingBytes = encoder.encode(pending).byteLength
      emit(complete.map(frame => `${frame.text}${frame.terminator}`).join(''), controller)
    },
    // The outcome is only known once the last frame has passed, so this is
    // where the source hears about it. A stream the reader abandons never
    // flushes and so reports nothing — an unfinished read is not an outcome.
    flush(controller) {
      pending += decoder.decode()
      if (pending.length > 0) emit(pending, controller)
      source.settled?.({
        status: upstream.status,
        ...(cappedFrom > 0 ? { cappedFrom } : {}),
      })
    },
  })
}
