export async function discoverBrowserWebSocket(cdpUrl: string): Promise<string> {
  const versionUrl = new URL('/json/version', `${cdpUrl.replace(/\/+$/, '')}/`)
  let lastError: unknown
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(versionUrl)
      if (!response.ok) throw new Error(`Chrome CDP returned ${response.status}`)
      const body = (await response.json()) as unknown
      if (!isRecord(body) || typeof body.webSocketDebuggerUrl !== 'string') {
        throw new Error('Chrome CDP omitted webSocketDebuggerUrl')
      }
      const parsed = new URL(body.webSocketDebuggerUrl)
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw new Error('Chrome CDP returned an invalid WebSocket URL')
      }
      return parsed.toString()
    } catch (error) {
      lastError = error
      if (attempt < 149) await Bun.sleep(100)
    }
  }
  throw new Error(
    `Chrome CDP did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

export async function discoverBrowserGeneration(cdpUrl: string): Promise<string> {
  const url = new URL(await discoverBrowserWebSocket(cdpUrl))
  const prefix = '/devtools/browser/'
  if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) {
    throw new Error('Chrome CDP returned a WebSocket URL without a browser generation')
  }
  return decodeURIComponent(url.pathname.slice(prefix.length))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
