import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDuetClient, type DuetClientOptions } from './duet'

/**
 * One provider, one pick. The SEO Specialist works exactly one Search Console
 * property, so unlike its sibling onboarding apps the selection here is a
 * single choice, and saving several is a 400 rather than a scope.
 */
const INTEGRATION = 'google_search_console'
const LIST_SITES_TOOL = 'GOOGLE_SEARCH_CONSOLE_LIST_SITES'

type ScopeOption = { id: string; integration: string; label: string; detail?: string }

type StoredState = { selection: ScopeOption[]; confirmedAt: string | null }

type Status = {
  ready: boolean
  message?: string
  providers: Array<{ integration: string; name: string; connected: boolean; status: string }>
  options: ScopeOption[]
  discovery: Array<{ integration: string; state: 'ok' | 'failed'; message?: string }>
  selection: ScopeOption[]
  complete: boolean
  confirmedAt: string | null
  checkedAt: string
}

type AppOptions = DuetClientOptions & { directory?: string; port?: number }

const STATUS_CACHE_MS = 10_000

export function createConnectSearchConsoleApp(options: AppOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const statePath = join(directory, 'state.json')
  const page = Bun.file(join(sourceDirectory, 'page.html')).text()
  const duet = createDuetClient(options)
  const encoder = new TextEncoder()
  const watchers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()

  let stored: StoredState | undefined
  let writes = Promise.resolve()
  let cachedStatus: { value: Status; at: number } | undefined
  let lastBroadcastSnapshot: string | undefined

  function broadcast(): void {
    const frame = encoder.encode('data: {"changed":true}\n\n')
    for (const [controller, close] of watchers) {
      try {
        controller.enqueue(frame)
      } catch {
        close()
      }
    }
  }

  async function readState(): Promise<StoredState> {
    if (stored !== undefined) return stored
    try {
      stored = JSON.parse(await readFile(statePath, 'utf8')) as StoredState
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        stored = { selection: [], confirmedAt: null }
      } else throw error
    }
    return stored!
  }

  async function writeState(next: StoredState): Promise<void> {
    const write = writes.then(async () => {
      const temporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        await rename(temporaryPath, statePath)
        stored = next
      } catch (error) {
        await rm(temporaryPath, { force: true })
        throw error
      }
    })
    writes = write.then(
      () => undefined,
      () => undefined,
    )
    await write
  }

  async function computeStatus(): Promise<Status> {
    const state = await readState()
    const checkedAt = new Date().toISOString()
    const base = {
      selection: state.selection,
      confirmedAt: state.confirmedAt,
      checkedAt,
      options: [] as ScopeOption[],
      discovery: [] as Status['discovery'],
    }
    const providerRow = { integration: INTEGRATION, name: 'Google Search Console' }
    if (!duet.configured) {
      return {
        ...base,
        ready: false,
        message: 'This page cannot reach your workspace yet. Ask your agent to take a look.',
        providers: [{ ...providerRow, connected: false, status: 'unknown' }],
        complete: false,
      }
    }
    let connections
    try {
      connections = await duet.listConnections()
    } catch {
      return {
        ...base,
        ready: false,
        message: 'This page cannot reach your workspace yet. Try again in a minute.',
        providers: [{ ...providerRow, connected: false, status: 'unknown' }],
        complete: false,
      }
    }
    const relevant = connections.filter(item => item.integration === INTEGRATION)
    const best = relevant.sort((a, b) => rank(a.status) - rank(b.status))[0]
    const connected = relevant.some(item => item.status === 'active')
    const providers = [
      { ...providerRow, connected, status: best?.status ?? 'not-connected' },
    ]
    const options: ScopeOption[] = []
    const discovery: Status['discovery'] = []
    if (connected) {
      const result = await duet.execute(LIST_SITES_TOOL, {})
      const sites = result.ok ? findObjectArray(result.data, ['siteUrl']) : undefined
      if (sites === undefined) {
        discovery.push({
          integration: INTEGRATION,
          state: 'failed',
          message: 'Connected, but the list of sites could not be loaded yet.',
        })
      } else {
        discovery.push({ integration: INTEGRATION, state: 'ok' })
        options.push(...sites.map(site => siteOption(String(site.siteUrl))))
      }
    }
    const optionIds = new Set(options.map(option => option.id))
    const complete =
      state.selection.length === 1 &&
      state.confirmedAt !== null &&
      optionIds.has(state.selection[0]!.id)
    return { ...base, ready: true, providers, options, discovery, complete }
  }

  async function status(forceFresh: boolean): Promise<Status> {
    const now = Date.now()
    if (!forceFresh && cachedStatus !== undefined && now - cachedStatus.at < STATUS_CACHE_MS) {
      return cachedStatus.value
    }
    const value = await computeStatus()
    cachedStatus = { value, at: now }
    const snapshot = JSON.stringify({ ...value, checkedAt: undefined })
    if (lastBroadcastSnapshot !== undefined && snapshot !== lastBroadcastSnapshot) broadcast()
    lastBroadcastSnapshot = snapshot
    return value
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/status') {
      return Response.json(await status(false))
    }

    if (request.method === 'POST' && url.pathname === '/api/refresh') {
      return Response.json(await status(true))
    }

    if (request.method === 'PUT' && url.pathname === '/api/selection') {
      const input = await readJson(request)
      const ids = Array.isArray(input?.ids) ? input.ids.filter(id => typeof id === 'string') : undefined
      if (ids === undefined || ids.length > 1) {
        return errorResponse('Pick just one site — this seat works a single property at a time.', 400)
      }
      const current = await status(true)
      const byId = new Map(current.options.map(option => [option.id, option]))
      if (ids.some(id => !byId.has(id))) {
        return errorResponse('That site is not available any more. Refresh and pick again.', 409)
      }
      const selection = ids.map(id => byId.get(id)!)
      await writeState({
        selection,
        confirmedAt: selection.length > 0 ? new Date().toISOString() : null,
      })
      cachedStatus = undefined
      return Response.json(await status(true))
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      return sseResponse(request, watchers, encoder)
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(await page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return new Response('Not found', { status: 404 })
  }

  const server = Bun.serve({
    port: options.port ?? Number(Bun.env.PORT ?? 3000),
    idleTimeout: 255,
    fetch: fetchRequest,
  })

  return {
    url: server.url,
    stop: () => server.stop(true),
  }
}

/**
 * Search Console has two property shapes and neither reads well raw: a
 * `sc-domain:` property covers every page on the domain, a URL-prefix
 * property covers one address. Say that in the user's words.
 */
function siteOption(siteUrl: string): ScopeOption {
  const domainProperty = siteUrl.startsWith('sc-domain:')
  return {
    id: `${INTEGRATION}:site:${siteUrl}`,
    integration: INTEGRATION,
    label: domainProperty ? siteUrl.slice('sc-domain:'.length) : siteUrl,
    detail: domainProperty ? 'The whole domain, every page on it' : 'Just this address',
  }
}

function rank(status: string): number {
  return status === 'active' ? 0 : status === 'pending' ? 1 : status === 'error' ? 2 : 3
}

/** See the sibling onboarding apps: tolerant of the provider's envelope. */
function findObjectArray(
  value: unknown,
  requiredKeys: string[],
  depth = 0,
): Array<Record<string, unknown>> | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    const objects = value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
    )
    if (objects.length > 0 && objects.every(item => requiredKeys.every(key => key in item))) {
      return objects
    }
    return undefined
  }
  for (const child of Object.values(value)) {
    const found = findObjectArray(child, requiredKeys, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function sseResponse(
  request: Request,
  watchers: Map<ReadableStreamDefaultController<Uint8Array>, () => void>,
  encoder: TextEncoder,
): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    request.signal.removeEventListener('abort', abort)
    watchers.delete(controller)
  }
  const abort = (): void => {
    close()
    try {
      controller.close()
    } catch {
      // Cancellation may have closed the stream already.
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      watchers.set(controller, close)
      request.signal.addEventListener('abort', abort, { once: true })
      controller.enqueue(encoder.encode(': connected\n\n'))
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          close()
        }
      }, 15_000)
    },
    cancel: close,
  })
  return new Response(stream, {
    headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' },
  })
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json()
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status })
}

if (import.meta.main) {
  const app = createConnectSearchConsoleApp()
  console.log(`Connect Search Console listening on ${app.url}`)
}
