/**
 * The streamable-HTTP MCP wire as a proxy sees it, on either end of the VM
 * tunnel: which request headers cross unchanged, and how to read a JSON-RPC
 * message off a body without a transport. A request arrives as one JSON
 * body; a response arrives either as JSON or as SSE `data:` frames.
 */

/**
 * The transport headers a runner may steer an upstream with.
 *
 * `mcp-protocol-version` and `last-event-id` are not optional politeness:
 * without the first a strict server may refuse the request outright, and
 * without the second SSE resumption is silently impossible — a dropped stream
 * restarts from nothing instead of from the last event the runner saw. Nothing
 * else crosses: a caller's own credential must never reach a third party, and
 * forwarding cookies would hand one a browser session.
 */
export const MCP_FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const

export type JsonRpcId = string | number

export interface JsonRpcRequestHead {
  method: string
  /** Absent on a notification. */
  id?: JsonRpcId
}

/** The method and id of a single (non-batched) JSON-RPC message, or undefined. */
export function readJsonRpcRequest(text: string): JsonRpcRequestHead | undefined {
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const { id, method } = message as { id?: unknown; method?: unknown }
  if (typeof method !== 'string') return undefined
  return typeof id === 'string' || typeof id === 'number' ? { method, id } : { method }
}

/** The `data:` payload of each SSE frame in `text`, in order. */
export function sseDataPayloads(text: string): string[] {
  return text
    .split(/\r\n\r\n|\n\n|\r\r/)
    .map(frame =>
      frame
        .split(/\r\n|\n|\r/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n'),
    )
    .filter(payload => payload.length > 0)
}

/** The `result` of the response to request `id`, from a JSON or SSE body. */
export function readJsonRpcResult(
  text: string,
  contentType: string | null,
  id: JsonRpcId,
): unknown {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const candidates = type === 'text/event-stream' ? sseDataPayloads(text) : [text]
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as { id?: unknown; result?: unknown }
      if (message.id === id && message.result !== undefined) return message.result
    } catch {
      // Not a JSON-RPC frame (a comment, a partial); keep looking.
    }
  }
  return undefined
}
