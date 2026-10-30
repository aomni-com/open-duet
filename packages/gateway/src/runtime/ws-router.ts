export type WebSocketHandlersByKind<Data extends { kind: string }> = {
  [Kind in Data['kind']]: Bun.WebSocketHandler<Extract<Data, { kind: Kind }>>
}

export type WebSocketUpgradeHandler = (
  request: Request,
) => Response | null | undefined | Promise<Response | null | undefined>

export async function runWebSocketUpgradeHandlers(
  request: Request,
  handlers: readonly WebSocketUpgradeHandler[],
): Promise<Response | null | undefined> {
  for (const handler of handlers) {
    const response = await handler(request)
    if (response !== null && response !== undefined) return response
  }
  return null
}

export function createWebSocketRouter<Data extends { kind: string }>(
  handlers: WebSocketHandlersByKind<Data>,
): Bun.WebSocketHandler<Data> {
  return {
    open(ws) {
      return handlerFor(handlers, ws)?.open?.(ws)
    },
    message(ws, message) {
      return handlerFor(handlers, ws)?.message(ws, message)
    },
    drain(ws) {
      return handlerFor(handlers, ws)?.drain?.(ws)
    },
    close(ws, code, reason) {
      return handlerFor(handlers, ws)?.close?.(ws, code, reason)
    },
  }
}

function handlerFor<Data extends { kind: string }>(
  handlers: WebSocketHandlersByKind<Data>,
  ws: Bun.ServerWebSocket<Data>,
): Bun.WebSocketHandler<Data> | undefined {
  const kind = (ws.data as { kind?: unknown })?.kind
  const handler = typeof kind === 'string' ? handlers[kind as Data['kind']] : undefined
  if (handler === undefined) {
    ws.close(1008, 'unknown websocket protocol')
    return undefined
  }
  // The runtime kind check narrows the socket and handler together; TypeScript
  // cannot preserve that relationship through the mapped handler type.
  return handler as Bun.WebSocketHandler<Data>
}
