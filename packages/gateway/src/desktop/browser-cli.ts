import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const DEFAULT_STATE_DIR = '/home/exedev/.duet'
const SESSION_ROUTE = 'http://127.0.0.1:3000/v1/desktop/browser/batches'

interface BrowserCliOptions {
  env?: Record<string, string | undefined>
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  writeLine?: (line: string) => void
}

export async function runDesktopBrowserCli(options: BrowserCliOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const sessionId = env.DUET_SESSION_ID?.trim()
  if (!sessionId) throw new Error('DUET_SESSION_ID is required')
  const stateDir = env.DUET_STATE_DIR?.trim() || DEFAULT_STATE_DIR
  const vmToken = (await readFile(resolve(stateDir, 'vm-token'), 'utf8')).trim()
  if (vmToken.length === 0) throw new Error('VM token is unavailable')
  const request = options.fetch ?? fetch
  const response = await request(SESSION_ROUTE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${vmToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId }),
  })
  const target = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    if (isRecord(target) && typeof target.error === 'string') {
      throw new DesktopBrowserCliError(
        target.error,
        target.retryable === true,
        typeof target.retryAfterMs === 'number' ? target.retryAfterMs : undefined,
      )
    }
    throw new Error(`Desktop browser request failed with status ${response.status}`)
  }
  if (
    !isRecord(target) ||
    typeof target.targetId !== 'string' ||
    target.targetId.length === 0 ||
    typeof target.webSocketDebuggerUrl !== 'string' ||
    !isGatewayCdpWebSocketUrl(target.webSocketDebuggerUrl)
  ) {
    throw new Error('Desktop browser returned an invalid target')
  }
  ;(options.writeLine ?? console.log)(
    JSON.stringify({
      targetId: target.targetId,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }),
  )
}

class DesktopBrowserCliError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code)
  }
}

function isGatewayCdpWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'ws:' &&
      url.hostname === '127.0.0.1' &&
      url.port === '3000' &&
      url.pathname.startsWith('/v1/desktop/browser/cdp/')
    )
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
