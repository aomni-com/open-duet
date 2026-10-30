import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDuetClient, type DuetClientOptions, type DuetClient } from './duet'

/**
 * Which platforms this app offers. A connection to a platform IS one account,
 * so the choices are the active connections themselves; `identityTool` is a
 * best-effort provider call that names the account with its real handle. When
 * it fails the account is still listed — under the platform's name — because
 * the connection is real either way; only the label degrades.
 */
const PLATFORMS: Array<{ integration: string; name: string; identityTool?: string }> = [
  { integration: 'twitter', name: 'X (Twitter)', identityTool: 'TWITTER_USER_LOOKUP_ME' },
  { integration: 'linkedin', name: 'LinkedIn', identityTool: 'LINKEDIN_GET_MY_INFO' },
  { integration: 'instagram', name: 'Instagram', identityTool: 'INSTAGRAM_GET_USER_INFO' },
  { integration: 'facebook', name: 'Facebook' },
  { integration: 'tiktok', name: 'TikTok', identityTool: 'TIKTOK_GET_USER_PROFILE' },
  { integration: 'youtube', name: 'YouTube' },
]

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

export function createConnectAccountsApp(options: AppOptions = {}) {
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
  const identityCache = new Map<string, string | undefined>()

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

  /** Best-effort real handle for one connected account; never blocks listing. */
  async function accountLabel(duetClient: DuetClient, platform: (typeof PLATFORMS)[number], connectionId: string): Promise<string> {
    const fallback = `${platform.name} account`
    if (platform.identityTool === undefined) return fallback
    const cacheKey = `${platform.integration}:${connectionId}`
    if (identityCache.has(cacheKey)) return identityCache.get(cacheKey) ?? fallback
    const result = await duetClient.execute(platform.identityTool, {})
    const label = result.ok ? extractIdentity(result.data) : undefined
    identityCache.set(cacheKey, label)
    return label ?? fallback
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
    if (!duet.configured) {
      return {
        ...base,
        ready: false,
        message: 'This page cannot reach your workspace yet. Ask your agent to take a look.',
        providers: PLATFORMS.map(p => ({ integration: p.integration, name: p.name, connected: false, status: 'unknown' })),
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
        providers: PLATFORMS.map(p => ({ integration: p.integration, name: p.name, connected: false, status: 'unknown' })),
        complete: false,
      }
    }
    const providers = PLATFORMS.map(platform => {
      const relevant = connections.filter(item => item.integration === platform.integration)
      const best = relevant.sort((a, b) => rank(a.status) - rank(b.status))[0]
      return {
        integration: platform.integration,
        name: platform.name,
        connected: relevant.some(item => item.status === 'active'),
        status: best?.status ?? 'not-connected',
      }
    })
    const options: ScopeOption[] = []
    const discovery: Status['discovery'] = []
    for (const platform of PLATFORMS) {
      const active = connections.filter(
        item => item.integration === platform.integration && item.status === 'active',
      )
      if (active.length === 0) continue
      for (const connection of active) {
        options.push({
          id: `${platform.integration}:account:${connection.id}`,
          integration: platform.integration,
          label: connection.name ?? (await accountLabel(duet, platform, connection.id)),
          detail: platform.name,
        })
      }
      discovery.push({ integration: platform.integration, state: 'ok' })
    }
    // Completion follows the chosen ACCOUNT, not the platform: a replaced or
    // removed connection un-completes even if the platform stays connected.
    const optionIds = new Set(options.map(option => option.id))
    const complete =
      state.selection.length > 0 &&
      state.confirmedAt !== null &&
      state.selection.every(item => optionIds.has(item.id))
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
      identityCache.clear()
      return Response.json(await status(true))
    }

    if (request.method === 'PUT' && url.pathname === '/api/selection') {
      const input = await readJson(request)
      const ids = Array.isArray(input?.ids) ? input.ids.filter(id => typeof id === 'string') : undefined
      if (ids === undefined || ids.length !== new Set(ids).size || ids.length > 200) {
        return errorResponse('Send the list of accounts to keep in scope.', 400)
      }
      const current = await status(true)
      const byId = new Map(current.options.map(option => [option.id, option]))
      const missing = ids.filter(id => !byId.has(id))
      if (missing.length > 0) {
        return errorResponse('Some of those accounts are not connected any more. Refresh and pick again.', 409)
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

function rank(status: string): number {
  return status === 'active' ? 0 : status === 'pending' ? 1 : status === 'error' ? 2 : 3
}

/**
 * Platforms wrap "who am I" differently. Scan a few levels deep for a handle
 * first (rendered as @handle), then any display name, instead of pinning one
 * vendor's envelope. Returns undefined when nothing name-like is present.
 */
export function extractIdentity(value: unknown): string | undefined {
  const handle = findString(value, ['username', 'handle', 'screen_name'])
  if (handle !== undefined) return `@${handle.replace(/^@/, '')}`
  const name = findString(value, ['display_name', 'name', 'localizedFirstName', 'title'])
  return name
}

function findString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined
  if (!Array.isArray(value)) {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys, depth + 1)
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
  const app = createConnectAccountsApp()
  console.log(`Connect Accounts listening on ${app.url}`)
}
