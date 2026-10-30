import { Hono } from 'hono'

import {
  AGENT_TERMINAL_STATES,
  GatewaySessionCwdReceiptSchema,
  GatewaySessionCwdRequestSchema,
  GatewaySessionDiscardReceiptSchema,
  GatewayRunnerInputReceiptSchema,
  GatewayRunnerInputRequestSchema,
  MCP_FORWARDED_REQUEST_HEADERS,
  type AgentTurnEvent,
} from '@repo/contract'

import {
  createAgentSessionsController,
  AgentSessionCwdError,
  AgentSessionDiscardedError,
  type AgentRelayEvent,
  type AgentRunnerFactory,
  type AgentSessionsController,
  type AgentSessionsControllerOptions,
  type FetchLike,
} from '../agent-sessions/coordinator'
import { DEFAULT_TURN_STARTED_TIMEOUT_MS } from '../runner/process-runner'
import {
  formatSessionEventSseFrame,
  type SessionEventSubscription,
} from '../runner/session-event-buffer'

export type { AgentRelayEvent, AgentRunnerFactory, FetchLike }

// Bun's own idleTimeout (255s, its hard cap — see runtime/http.ts) DOES kill an
// in-flight unary handler once the wait exceeds it, confirmed directly with a
// synthetic route (agentSessions.test.ts) — but ALSO confirmed that this does
// not currently happen to THIS route: it reads the request body
// (`readJson(c.req.raw)`, above) before the slow `deliverInput` wait, and a
// request whose body has already been fully read is not subject to the kill.
// So this call is hardening against a real Bun/Hono behavior, not a fix for a
// bug that was ever observed in production traffic to this specific route —
// it makes the protection explicit rather than relying on "we happen to read
// the body first" surviving every future refactor here or a Bun/Hono version
// change. SSE has its own version of this problem and solves it differently
// (a periodic keepalive comment on the stream, since a stream CAN emit bytes
// mid-wait); a plain JSON POST can't stream a keepalive, so this uses Bun's
// per-request `server.timeout()` instead — confirmed to reach the exact
// Request Bun is tracking, through Hono's `c.req.raw`. Every prompt/answer/
// wake command funnels through this one route, so one fix here covers all of
// them.
const INPUT_ROUTE_TIMEOUT_HEADROOM_MS = 30_000
const INPUT_ROUTE_TIMEOUT_SECONDS = Math.ceil(
  (DEFAULT_TURN_STARTED_TIMEOUT_MS + INPUT_ROUTE_TIMEOUT_HEADROOM_MS) / 1000,
)

export interface AgentSessionsRoutesOptions extends AgentSessionsControllerOptions {
  // Extends this one request's idle budget past Bun's 255s hard cap. Absent in
  // tests that don't construct a real Bun server; production always wires it.
  extendTimeout?: (request: Request, seconds: number) => void
  discardBrowserOwner?: (agentAnchorId: string) => Promise<void>
  /**
   * The integrations MCP server as the runner reaches it here: the gateway
   * performs its opening exchange while the runner boots (started where the
   * spawn's MCP config is built) and answers it from memory; everything else
   * is forwarded to ctl. Absent when this VM cannot address ctl.
   */
  integrationsMcp?: {
    /** The local answer, or null when the message must go upstream. */
    answer(sessionId: string, body: string): Promise<Response | null>
    /** Where upstream is for this session, or null when it cannot be addressed. */
    upstream(sessionId: string): { url: string; headers: Record<string, string> } | null
    fetch: FetchLike
  }
}

export function createAgentSessionsRoutes(options: AgentSessionsRoutesOptions): {
  routes: Hono
  controller: AgentSessionsController
} {
  const controller = createAgentSessionsController(options)
  const routes = new Hono()

  routes.post('/sessions/:sessionId/input', async c => {
    const body = GatewayRunnerInputRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    options.extendTimeout?.(c.req.raw, INPUT_ROUTE_TIMEOUT_SECONDS)
    try {
      const receipt = await controller.deliverInput(c.req.param('sessionId'), body.data)
      return c.json(GatewayRunnerInputReceiptSchema.parse(receipt))
    } catch (error) {
      return runnerError(c, error, options.log, c.req.param('sessionId'))
    }
  })

  routes.get('/sessions/:sessionId/events', c => {
    const subscription = controller.subscribeToEvents(
      c.req.param('sessionId'),
      readSinceSeq(c.req.raw, c.req.query('since')),
    )
    return new Response(streamAgentEvents(c.req.raw, subscription), {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    })
  })

  routes.post('/sessions/:sessionId/interrupt', async c => {
    const interrupted = await controller.interrupt(c.req.param('sessionId'))
    return c.json({ ok: true, interrupted })
  })

  // The runner's integrations server. The opening exchange is answered from
  // what the warmer established when the input arrived; anything else — tool
  // calls, the server-initiated stream, session teardown — crosses to ctl with
  // the transport headers intact and ctl's own credential for the session.
  routes.all('/sessions/:sessionId/integrations/mcp', async c => {
    const integrationsMcp = options.integrationsMcp
    const sessionId = c.req.param('sessionId')
    const upstream = integrationsMcp?.upstream(sessionId) ?? null
    if (integrationsMcp === undefined || upstream === null) {
      return c.json({ error: 'integrations_unavailable' }, 503)
    }
    const body =
      c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.raw.text()
    if (body !== undefined) {
      const local = await integrationsMcp.answer(sessionId, body)
      if (local !== null) return local
    }
    const headers = new Headers(upstream.headers)
    for (const name of MCP_FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name)
      if (value !== undefined) headers.set(name, value)
    }
    return await integrationsMcp.fetch(upstream.url, {
      method: c.req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  })

  routes.post('/sessions/:sessionId/cwd', async c => {
    const body = GatewaySessionCwdRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const receipt = await controller.setCwd(c.req.param('sessionId'), body.data.cwd)
      return c.json(GatewaySessionCwdReceiptSchema.parse(receipt))
    } catch (error) {
      if (error instanceof AgentSessionCwdError) {
        if (error.code === 'not_found') return c.json({ error: 'not_found' }, 404)
        return c.json({ error: 'invalid_cwd', reason: error.reason }, 422)
      }
      throw error
    }
  })

  routes.delete('/sessions/:sessionId', async c => {
    const discarded = await controller.discard(c.req.param('sessionId'))
    return c.json(GatewaySessionDiscardReceiptSchema.parse({ ok: true, discarded }))
  })

  routes.delete('/agents/:agentAnchorId/sessions', async c => {
    const agentAnchorId = c.req.param('agentAnchorId')
    const discarded = await controller.discardAgent(agentAnchorId)
    await options.discardBrowserOwner?.(agentAnchorId)
    return c.json({ ok: true, discarded })
  })

  return { routes, controller }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function readSinceSeq(request: Request, querySince: string | undefined): number {
  const raw = querySince ?? request.headers.get('last-event-id')
  if (raw === undefined || raw === null) return 0
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return 0
  return parsed
}

export function streamAgentEvents(
  request: Request,
  subscription: SessionEventSubscription,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = subscription[Symbol.asyncIterator]()
  let closed = false
  let keepalive: ReturnType<typeof setInterval> | null = null
  const closeSubscription = () => {
    if (closed) return
    closed = true
    if (keepalive !== null) clearInterval(keepalive)
    keepalive = null
    request.signal.removeEventListener('abort', closeSubscription)
    subscription.close()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      request.signal.addEventListener('abort', closeSubscription, { once: true })
      // The response's first byte is what releases its headers to the client.
      // The API subscribes the moment a turn is submitted, seconds before the
      // runner has anything to say, and its connect budget is far shorter than
      // a spawn — a stream that waits for its first event to say anything is a
      // stream the API gives up on and replaces with fallback polling.
      controller.enqueue(encoder.encode(': connected\n\n'))
      // Keepalive comment during quiet stretches (e.g. a long tool call) so neither
      // Bun's idle timeout nor an intermediary drops a live SSE with no events yet.
      keepalive = setInterval(() => {
        if (closed || (controller.desiredSize ?? 0) <= 0) return
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          closeSubscription()
        }
      }, 15_000)
    },
    async pull(controller) {
      if (closed) return
      try {
        const result = await iterator.next()
        if (closed) return
        if (result.done) {
          controller.close()
          closeSubscription()
          return
        }
        const frame = result.value
        controller.enqueue(encoder.encode(formatSessionEventSseFrame(frame)))
        // Only end on the DURABLE terminal frame (seq set = Convex has acked
        // the row). Ending on the earlier no-id terminal frame would cut off
        // before the durable frame and race a client that refetches Convex.
        if (frame.seq !== null && isTerminalEvent(frame.event)) {
          controller.close()
          closeSubscription()
        }
      } catch (error) {
        if (!closed) controller.error(error)
        closeSubscription()
      }
    },
    cancel() {
      closeSubscription()
    },
  })
}

function isTerminalEvent(event: AgentTurnEvent): boolean {
  return AGENT_TERMINAL_STATES.includes(event.type as (typeof AGENT_TERMINAL_STATES)[number])
}

function runnerError(
  c: { json: (body: unknown, status?: number) => Response },
  error: unknown,
  log?: (fields: Record<string, unknown>) => void,
  sessionId?: string,
): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/Invalid agent cwd/.test(message)) return c.json({ error: 'invalid_request' }, 400)
  log?.({ event: 'runner_input_failed', sessionId, exception: error })
  // A discarded session's envelope is gone for good — nothing can ever be
  // settled into it. Answering 410 instead of the generic 503 tells the
  // caller this will never succeed, so it can stop retrying instead of
  // treating it as a transient runner_unavailable.
  if (error instanceof AgentSessionDiscardedError) {
    return c.json({ error: 'session_discarded' }, 410)
  }
  // The runner's own account of the failure — a spawn timeout carries its
  // stderr — is the only thing that distinguishes a wedged start from a slow
  // one, and the 503 body deliberately says neither.
  return c.json({ error: 'runner_unavailable' }, 503)
}
