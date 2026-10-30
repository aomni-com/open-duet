import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDuetClient, type DuetClientOptions, type DuetClient } from './duet'

/**
 * Which helpdesks this app offers, and how it lists what a connected one can
 * see. `discover` runs only for an active connection; a provider without a
 * queue-partition API through the connection honestly offers its whole queue
 * as the single choice instead of inventing a list.
 */
type ScopeOption = { id: string; integration: string; label: string; detail?: string }

type Discovery =
  | { state: 'ok'; options: ScopeOption[] }
  | { state: 'failed'; message: string }

const PROVIDERS: Array<{
  integration: string
  name: string
  discover: (duet: DuetClient) => Promise<Discovery>
}> = [
  {
    integration: 'zendesk',
    name: 'Zendesk',
    discover: async () => wholeQueue('zendesk', 'Everything in Zendesk'),
  },
  {
    integration: 'intercom',
    name: 'Intercom',
    discover: async () => wholeQueue('intercom', 'Every conversation in Intercom'),
  },
  {
    integration: 'help_scout',
    name: 'Help Scout',
    discover: async duet => {
      const result = await duet.execute('HELP_SCOUT_LIST_INBOXES', {})
      if (!result.ok) return listUnavailable()
      const mailboxes = findObjectArray(result.data, ['name'])
      if (mailboxes === undefined) return listUnavailable()
      return {
        state: 'ok',
        options: mailboxes.map(box => ({
          id: `help_scout:inbox:${String(box.id ?? box.name)}`,
          integration: 'help_scout',
          label: String(box.name),
          detail: typeof box.email === 'string' ? `Help Scout · ${box.email}` : 'Help Scout',
        })),
      }
    },
  },
  {
    integration: 'freshdesk',
    name: 'Freshdesk',
    discover: async () => wholeQueue('freshdesk', 'Every ticket in Freshdesk'),
  },
  {
    integration: 'gmail',
    name: 'Gmail (shared inbox)',
    discover: async duet => {
      const result = await duet.execute('GMAIL_LIST_LABELS', { user_id: 'me' })
      if (!result.ok) return listUnavailable()
      const labels = findObjectArray(result.data, ['name'])
      if (labels === undefined) return listUnavailable()
      const usable = labels.filter(
        label => label.id === 'INBOX' || label.type === 'user' || label.type === undefined,
      )
      if (usable.length === 0) return listUnavailable()
      return {
        state: 'ok',
        options: usable.map(label => ({
          id: `gmail:label:${String(label.id ?? label.name)}`,
          integration: 'gmail',
          label: label.id === 'INBOX' ? 'Inbox' : String(label.name),
        })),
      }
    },
  },
]

function wholeQueue(integration: string, label: string): Discovery {
  return { state: 'ok', options: [{ id: `${integration}:all`, integration, label }] }
}

function listUnavailable(): Discovery {
  return { state: 'failed', message: 'Connected, but the list could not be loaded yet.' }
}

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

export function createConnectHelpdeskApp(options: AppOptions = {}) {
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
    if (!duet.configured) {
      return {
        ...base,
        ready: false,
        message: 'This page cannot reach your workspace yet. Ask your agent to take a look.',
        providers: PROVIDERS.map(p => ({ ...providerRow(p), connected: false, status: 'unknown' })),
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
        providers: PROVIDERS.map(p => ({ ...providerRow(p), connected: false, status: 'unknown' })),
        complete: false,
      }
    }
    const providers = PROVIDERS.map(provider => {
      const connection = connections
        .filter(item => item.integration === provider.integration)
        .sort((a, b) => rank(a.status) - rank(b.status))[0]
      return {
        ...providerRow(provider),
        connected: connection?.status === 'active',
        status: connection?.status ?? 'not-connected',
      }
    })
    const options: ScopeOption[] = []
    const discovery: Status['discovery'] = []
    for (const provider of PROVIDERS) {
      const row = providers.find(item => item.integration === provider.integration)!
      if (!row.connected) continue
      const found = await provider.discover(duet)
      if (found.state === 'ok') {
        options.push(...found.options)
        discovery.push({ integration: provider.integration, state: 'ok' })
      } else {
        discovery.push({
          integration: provider.integration,
          state: 'failed',
          message: found.message,
        })
      }
    }
    const activeIntegrations = new Set(
      providers.filter(item => item.connected).map(item => item.integration),
    )
    const complete =
      state.selection.length > 0 &&
      state.confirmedAt !== null &&
      state.selection.every(item => activeIntegrations.has(item.integration))
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
      if (ids === undefined || ids.length !== new Set(ids).size || ids.length > 200) {
        return errorResponse('Send the list of choices to keep in scope.', 400)
      }
      const current = await status(true)
      const byId = new Map(current.options.map(option => [option.id, option]))
      const missing = ids.filter(id => !byId.has(id))
      if (missing.length > 0) {
        return errorResponse('Some of those choices are not available any more. Refresh and pick again.', 409)
      }
      const selection = ids.map(id => byId.get(id)!)
      await writeState({
        selection,
        confirmedAt: selection.length > 0 ? new Date().toISOString() : null,
      })
      cachedStatus = undefined
      const updated = await status(true)
      return Response.json(updated)
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

function providerRow(provider: { integration: string; name: string }) {
  return { integration: provider.integration, name: provider.name }
}

function rank(status: string): number {
  return status === 'active' ? 0 : status === 'pending' ? 1 : status === 'error' ? 2 : 3
}

/**
 * Providers wrap their lists differently (`data.labels`, `_embedded.mailboxes`,
 * …), and the exact envelope is the least stable part of the contract. Scan a
 * few levels deep for the first array of objects carrying the fields we need
 * instead of pinning one vendor's wrapper.
 */
export function findObjectArray(
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
  const app = createConnectHelpdeskApp()
  console.log(`Connect Helpdesk listening on ${app.url}`)
}
