import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Repo = {
  id: string
  description?: string
  private: boolean
  updatedAt?: string
}

type Connection =
  | { status: 'disconnected'; reason?: string; checkedAt?: string }
  | { status: 'connected'; host: 'github'; account?: string; checkedAt: string }

type SetupState = {
  connection: Connection
  repos: Repo[]
  selection: { repoIds: string[]; updatedAt?: string }
  setup: { complete: boolean; completedAt?: string }
}

type ProbeResult =
  | { ok: true; account?: string; repos: Repo[] }
  | { ok: false; reason: string }

type ConnectReposOptions = {
  directory?: string
  port?: number
  probe?: () => Promise<ProbeResult>
  now?: () => number
}

/** Matches the sibling onboarding apps' status cache. */
const PROBE_CACHE_MS = 10_000

const repoIdPattern = /^[\w.-]+\/[\w.-]+$/

export function createConnectReposApp(options: ConnectReposOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const store = createSetupRepository(join(directory, 'state.json'))
  const probe = options.probe ?? probeCodeHost
  const clock = options.now ?? Date.now
  let lastProbeAt: number | undefined
  const page = Bun.file(join(sourceDirectory, 'page.html')).text()
  const watchers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()
  const encoder = new TextEncoder()

  function broadcast(): void {
    const frame = encoder.encode('data: {}\n\n')
    for (const [controller, close] of watchers) {
      try {
        controller.enqueue(frame)
      } catch {
        close()
      }
    }
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/setup') {
      // Opening the page must tell the truth about the code host, the way the
      // sibling onboarding apps do on their status route. Reading stored state
      // alone met an already-authorized user with "Not connected yet" and made
      // them press a button to correct the page about themselves.
      //
      // Bounded by elapsed time, not by "has it ever run". Probing spawns two
      // `gh` subprocesses and `refresh()` runs on every broadcast, so an
      // unbounded probe would spawn a pair per ticked checkbox — but a
      // once-ever latch is worse: a user who authorizes after a failed probe
      // would sit on a stale "Not connected yet" forever. Ten seconds bounds
      // the subprocesses and still converges without the user doing anything.
      const now = clock()
      if (lastProbeAt !== undefined && now - lastProbeAt < PROBE_CACHE_MS) {
        return Response.json(await store.read())
      }
      lastProbeAt = now
      return Response.json(await store.applyProbe(await probe()))
    }

    if (request.method === 'POST' && url.pathname === '/api/connection/check') {
      const result = await probe()
      lastProbeAt = clock()
      const state = await store.applyProbe(result)
      broadcast()
      return Response.json(state)
    }

    if (request.method === 'PUT' && url.pathname === '/api/repos') {
      const input = await readJson(request)
      const repos = parseRepos(input?.repos)
      const account = input?.account === undefined ? undefined : cleanString(input.account, 120)
      if (repos === undefined || (input?.account !== undefined && account === undefined)) {
        return errorResponse(
          'Body must be {repos: [{id: "owner/name", ...}], account?} with at most 500 repos.',
          400,
        )
      }
      const state = await store.setRepos(repos, account)
      broadcast()
      return Response.json(state)
    }

    if (request.method === 'PUT' && url.pathname === '/api/selection') {
      const input = await readJson(request)
      const repoIds = parseRepoIds(input?.repoIds)
      if (repoIds === undefined) {
        return errorResponse('Body must be {repoIds: ["owner/name", ...]}.', 400)
      }
      const state = await store.setSelection(repoIds)
      if (state === undefined) {
        return errorResponse('Every repoId must be one of the repos this app has listed.', 400)
      }
      broadcast()
      return Response.json(state)
    }

    if (request.method === 'POST' && url.pathname === '/api/complete') {
      const state = await store.complete()
      if ('error' in state) return errorResponse(state.error, 409)
      broadcast()
      return Response.json(state)
    }

    if (request.method === 'GET' && url.pathname === '/events') {
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
    fetch: fetchRequest,
  }
}

function createSetupRepository(path: string) {
  let cached: SetupState | undefined
  let writes = Promise.resolve()

  async function read(): Promise<SetupState> {
    cached ??= await readStore(path)
    return structuredClone(cached)
  }

  async function mutate<T>(change: (current: SetupState) => { next: SetupState; result: T }) {
    const result = writes.then(async () => {
      const outcome = change(await read())
      if (outcome.next !== cached) {
        await writeStore(path, outcome.next)
        cached = outcome.next
      }
      return outcome.result
    })
    writes = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }

  /* Setup stays honest under later edits: completion never survives an empty
     selection, and ticks never point at repos the app no longer lists. */
  function settle(state: SetupState): SetupState {
    const known = new Set(state.repos.map(repo => repo.id))
    const repoIds = state.selection.repoIds.filter(id => known.has(id))
    const complete =
      state.setup.complete && state.connection.status === 'connected' && repoIds.length > 0
    return {
      ...state,
      selection: { ...state.selection, repoIds },
      setup: complete ? state.setup : { complete: false },
    }
  }

  async function applyProbe(result: ProbeResult): Promise<SetupState> {
    const checkedAt = new Date().toISOString()
    return await mutate(current => {
      const next = settle(
        result.ok
          ? {
              ...current,
              connection: {
                status: 'connected',
                host: 'github',
                ...(result.account === undefined ? {} : { account: result.account }),
                checkedAt,
              },
              repos: result.repos,
            }
          : {
              ...current,
              connection: {
                status: 'disconnected',
                ...(result.reason === undefined ? {} : { reason: result.reason }),
                checkedAt,
              },
            },
      )
      return { next, result: next }
    })
  }

  async function setRepos(repos: Repo[], account: string | undefined): Promise<SetupState> {
    const checkedAt = new Date().toISOString()
    return await mutate(current => {
      const next = settle({
        ...current,
        connection: {
          status: 'connected',
          host: 'github',
          ...(account === undefined ? {} : { account }),
          checkedAt,
        },
        repos,
      })
      return { next, result: next }
    })
  }

  async function setSelection(repoIds: string[]): Promise<SetupState | undefined> {
    return await mutate<SetupState | undefined>(current => {
      const known = new Set(current.repos.map(repo => repo.id))
      if (repoIds.some(id => !known.has(id))) return { next: cached!, result: undefined }
      const next = settle({
        ...current,
        selection: { repoIds, updatedAt: new Date().toISOString() },
      })
      return { next, result: next }
    })
  }

  async function complete(): Promise<SetupState | { error: string }> {
    return await mutate<SetupState | { error: string }>(current => {
      if (current.connection.status !== 'connected') {
        return { next: cached!, result: { error: 'The code host is not connected yet.' } }
      }
      if (current.selection.repoIds.length === 0) {
        return { next: cached!, result: { error: 'No repos are selected yet.' } }
      }
      const next = {
        ...current,
        setup: { complete: true, completedAt: new Date().toISOString() },
      }
      return { next, result: next }
    })
  }

  return { read, applyProbe, setRepos, setSelection, complete }
}

/* ──────────────────────────────────────────────────────────────────────────
 * The one place this app talks to the code host.
 *
 * The `gh` CLI is the documented route (see the `github` skill): when GitHub
 * is connected in this workspace, `gh` is authenticated, so listing the
 * user's repositories is one real command. Nothing else in the app knows how
 * repos are fetched — supporting another host, or another transport, means
 * replacing only this section. When `gh` is unavailable the probe reports an
 * honest `disconnected` and the agent can instead record repos it fetched
 * itself via `PUT /api/repos`.
 * ────────────────────────────────────────────────────────────────────────── */

async function probeCodeHost(): Promise<ProbeResult> {
  const login = await runCodeHostCommand(['gh', 'api', 'user', '--jq', '.login'])
  if (!login.ok) return { ok: false, reason: login.reason }
  const list = await runCodeHostCommand([
    'gh',
    'repo',
    'list',
    '--limit',
    '100',
    '--json',
    'nameWithOwner,description,isPrivate,updatedAt',
  ])
  if (!list.ok) return { ok: false, reason: list.reason }
  try {
    const rows: unknown = JSON.parse(list.stdout)
    if (!Array.isArray(rows)) throw new Error('not an array')
    const repos = rows.flatMap((row): Repo[] => {
      if (!isRecord(row) || typeof row.nameWithOwner !== 'string') return []
      const description = typeof row.description === 'string' ? row.description.trim() : ''
      return [
        {
          id: row.nameWithOwner,
          ...(description === '' ? {} : { description: description.slice(0, 300) }),
          private: row.isPrivate === true,
          ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
        },
      ]
    })
    return { ok: true, account: login.stdout.trim(), repos }
  } catch {
    return { ok: false, reason: 'GitHub answered, but the list of projects could not be read.' }
  }
}

async function runCodeHostCommand(
  command: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const process = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
    const kill = setTimeout(() => process.kill(), 20_000)
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ])
    clearTimeout(kill)
    if (exitCode !== 0) {
      return { ok: false, reason: 'GitHub is not connected in this workspace yet.' }
    }
    return { ok: true, stdout }
  } catch {
    return { ok: false, reason: 'The GitHub tool is not available in this workspace yet.' }
  }
}

/* ────────────────────────── end of code-host seam ───────────────────────── */

function parseRepos(value: unknown): Repo[] | undefined {
  if (!Array.isArray(value) || value.length > 500) return undefined
  const repos: Repo[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const id = cleanString(candidate.id, 200)
    if (id === undefined || !repoIdPattern.test(id) || seen.has(id)) return undefined
    seen.add(id)
    const description =
      candidate.description === undefined ? undefined : cleanString(candidate.description, 300)
    if (candidate.description !== undefined && description === undefined) return undefined
    const updatedAt = candidate.updatedAt === undefined ? undefined : cleanDate(candidate.updatedAt)
    if (candidate.updatedAt !== undefined && updatedAt === undefined) return undefined
    repos.push({
      id,
      ...(description === undefined ? {} : { description }),
      private: candidate.private === true,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    })
  }
  return repos
}

function parseRepoIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 500) return undefined
  const repoIds: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !repoIdPattern.test(candidate)) return undefined
    if (!repoIds.includes(candidate)) repoIds.push(candidate)
  }
  return repoIds
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json()
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : undefined
}

function cleanDate(value: unknown): string | undefined {
  const date = cleanString(value, 40)
  return date !== undefined && !Number.isNaN(Date.parse(date)) ? date : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status })
}

async function readStore(path: string): Promise<SetupState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SetupState
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        connection: { status: 'disconnected' },
        repos: [],
        selection: { repoIds: [] },
        setup: { complete: false },
      }
    }
    throw error
  }
}

async function writeStore(path: string, store: SetupState): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

if (import.meta.main) {
  const app = createConnectReposApp()
  console.log(`Connect Repos listening on ${app.url}`)
}
