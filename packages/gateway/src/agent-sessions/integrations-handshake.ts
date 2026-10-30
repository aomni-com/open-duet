import { readJsonRpcRequest, readJsonRpcResult, type FetchLike } from '@repo/contract'

/**
 * The integrations server's opening exchange, performed by the gateway while
 * the runner's process is still booting.
 *
 * A runner opens every MCP server with `initialize`, `notifications/initialized`
 * and `tools/list`, serially, and each was a round trip to ctl — the largest
 * slice of a turn's time to first token, spent before the model is asked
 * anything. The exchange depends on nothing the runner will say: the provider
 * session is conversation-scoped and stateless, so its answers are the same
 * whoever asks. The gateway asks as soon as the input arrives and holds the
 * answers for the runner, which then pays a loopback instead of a tunnel.
 *
 * Held per session and replaced on every input: a turn's handshake is that
 * turn's, and the permissions behind the list may change between turns.
 * Anything the exchange could not establish is simply not answered here —
 * the runner's own request then goes upstream as it always did.
 */
export interface IntegrationsHandshakeTarget {
  url: string
  headers: Record<string, string>
}

export interface IntegrationsHandshake {
  initialize: unknown
  toolsList: unknown
}

export interface IntegrationsHandshakeWarmer {
  /** Begin the exchange for a session; a later call replaces the earlier answers. */
  warm(sessionId: string, target: IntegrationsHandshakeTarget): void
  /**
   * The local answer to one JSON-RPC message from the runner, or null when the
   * message must go upstream. Waits for an exchange still in flight.
   */
  answer(sessionId: string, body: string): Promise<Response | null>
  forget(sessionId: string): void
}

/** What the exchange asks for. The server answers with the version it supports. */
export const HANDSHAKE_PROTOCOL_VERSION = '2025-06-18'
const HELD_HANDSHAKE_TTL_MS = 10 * 60_000
const MAX_HELD_HANDSHAKES = 200
const LOCAL_ANSWERS = new Set(['initialize', 'tools/list'])

export function createIntegrationsHandshakeWarmer(options: {
  fetch: FetchLike
  now?: () => number
  log?: (fields: Record<string, unknown>) => void
}): IntegrationsHandshakeWarmer {
  const now = options.now ?? Date.now
  const held = new Map<
    string,
    { exchange: Promise<IntegrationsHandshake | null>; expiresAt: number }
  >()

  const exchange = async (
    sessionId: string,
    target: IntegrationsHandshakeTarget,
  ): Promise<IntegrationsHandshake | null> => {
    const headers = {
      ...target.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    const ask = async (id: number, method: string, params: unknown): Promise<unknown> => {
      const response = await options.fetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      })
      if (!response.ok) throw new Error(`${method} answered ${response.status}`)
      const result = readJsonRpcResult(
        await response.text(),
        response.headers.get('content-type'),
        id,
      )
      if (result === undefined) throw new Error(`${method} answered without a result`)
      return result
    }
    try {
      const initialize = await ask(1, 'initialize', {
        protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'duet-gateway', version: '0' },
      })
      const toolsList = await ask(2, 'tools/list', {})
      return { initialize, toolsList }
    } catch (error) {
      options.log?.({
        event: 'integrations_handshake_failed',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  return {
    warm(sessionId, target) {
      held.delete(sessionId)
      held.set(sessionId, {
        exchange: exchange(sessionId, target),
        expiresAt: now() + HELD_HANDSHAKE_TTL_MS,
      })
      while (held.size > MAX_HELD_HANDSHAKES) {
        const oldest = held.keys().next().value
        if (oldest === undefined) break
        held.delete(oldest)
      }
    },
    async answer(sessionId, body) {
      const request = readJsonRpcRequest(body)
      if (request === undefined) return null
      // A notification expects nothing back, and a stateless upstream has
      // nothing to do with one; 202 is the transport's own word for that.
      if (request.id === undefined && request.method.startsWith('notifications/')) {
        return new Response(null, { status: 202 })
      }
      if (request.id === undefined || !LOCAL_ANSWERS.has(request.method)) return null
      const entry = held.get(sessionId)
      if (entry === undefined || entry.expiresAt <= now()) return null
      const handshake = await entry.exchange
      if (handshake === null) return null
      const result = request.method === 'initialize' ? handshake.initialize : handshake.toolsList
      return Response.json(
        { jsonrpc: '2.0', id: request.id, result },
        { headers: { 'x-duet-mcp-handshake': 'gateway' } },
      )
    },
    forget(sessionId) {
      held.delete(sessionId)
    },
  }
}
