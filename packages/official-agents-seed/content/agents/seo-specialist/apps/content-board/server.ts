import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* The stage chain from the SEO Specialist's AGENTS.md, in order. The board is
   the only place it is enumerated at runtime, so a card can never sit in a
   stage the agent does not know how to work. */
export const STAGES = [
  'opportunity',
  'keywords',
  'research',
  'evidence',
  'brief',
  'draft',
  'review',
  'publish',
  'handoff',
] as const

/* Not stages of the chain — the two ways a card leaves it. */
export const TERMINALS = ['shelved', 'blocked'] as const

export const VERDICTS = ['new', 'refresh', 'fold-in', 'reject'] as const

type Stage = (typeof STAGES)[number] | (typeof TERMINALS)[number]
type Verdict = (typeof VERDICTS)[number]

type Artifact = {
  stage: (typeof STAGES)[number]
  file: string
  summary: string | null
  recordedAt: number
}

type Card = {
  slug: string
  title: string
  stage: Stage
  verdict: Verdict | null
  primaryKeyword: string | null
  note: string | null
  artifacts: Artifact[]
  createdAt: number
  updatedAt: number
}

type StoredBoard = { cards: Card[] }

type ContentBoardOptions = {
  directory?: string
  port?: number
  agentDirectory?: string
  env?: Record<string, string | undefined>
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

type PlatformTarget = { apiUrl: string; apiKey: string; workspaceSlug: string; agentSlug: string }

/* A verdict of `new` or `refresh` is the only thing that lets a card leave
   `opportunity` for the writing chain. This is the agent's own gate, kept
   where it cannot be forgotten mid-conversation: an article that was never
   judged against the pages that already exist cannot acquire a brief here. */
const PASSING_VERDICTS = new Set<Verdict>(['new', 'refresh'])

export function createContentBoard(options: ContentBoardOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const page = Bun.file(join(sourceDirectory, 'page.html')).text()
  const board = createBoardRepository(join(directory, 'board.json'))
  const watchers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()
  const encoder = new TextEncoder()
  const fetchImpl = options.fetchImpl ?? fetch
  let advancingReview = new Set<string>()

  /* The platform supplies both locations as drive-relative paths because an
     installed agent can be named or moved by its owner. Walking back by the
     app path's own segments finds the drive root without guessing the agent's
     folder name; tests may inject an absolute agent directory directly. */
  const env = options.env ?? Bun.env
  const agentDirectory =
    options.agentDirectory ??
    resolveAgentDirectory(sourceDirectory, env.DUET_APP_DIR, env.DUET_AGENT_DIR)
  const artifactRoot = agentDirectory === undefined ? undefined : resolve(agentDirectory, 'seo')
  async function resolvePlatformTarget(): Promise<PlatformTarget> {
    const apiUrl = env.DUET_API_URL
    const apiKey = env.DUET_APP_API_KEY
    const agentPath = env.DUET_AGENT_DIR?.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
    if (!apiUrl || !apiKey || !agentPath) {
      throw new PlatformError(
        503,
        'platform_unavailable',
        'Duet has not finished connecting this board to its agent yet.',
      )
    }

    const headers = { authorization: `Bearer ${apiKey}` }
    const identityResponse = await fetchImpl(new URL('/v1/whoami', apiUrl), { headers })
    const identity = await readPlatformJson(identityResponse)
    const workspaces = Array.isArray(identity.workspaces) ? identity.workspaces : []
    const workspace = workspaces.length === 1 ? workspaces[0] : undefined
    const workspaceSlug = readObjectText(workspace, 'slug')
    if (!identityResponse.ok || workspaceSlug === undefined) {
      throw new PlatformError(
        identityResponse.ok ? 502 : identityResponse.status,
        'platform_unavailable',
        'The board could not identify its Duet workspace.',
      )
    }

    const agentsResponse = await fetchImpl(
      new URL(`/v1/ws/${encodeURIComponent(workspaceSlug)}/agents`, apiUrl),
      { headers },
    )
    const agentsBody = await readPlatformJson(agentsResponse)
    const agents = Array.isArray(agentsBody.items) ? agentsBody.items : []
    const owner = agents.find(
      agent =>
        readObjectText(agent, 'anchorPath')
          ?.replaceAll('\\', '/')
          .replace(/^\/+|\/+$/g, '') === agentPath,
    )
    const agentSlug = readObjectText(owner, 'slug')
    if (!agentsResponse.ok || agentSlug === undefined) {
      throw new PlatformError(
        agentsResponse.ok ? 502 : agentsResponse.status,
        'platform_unavailable',
        'The board could not find the agent that owns it.',
      )
    }
    return { apiUrl, apiKey, workspaceSlug, agentSlug }
  }

  async function sendMessage(card: Card, message: string): Promise<void> {
    const target = await resolvePlatformTarget()
    const response = await fetchImpl(
      new URL(
        `/v1/ws/${encodeURIComponent(target.workspaceSlug)}/agents/${encodeURIComponent(target.agentSlug)}/sessions/default/messages`,
        target.apiUrl,
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          behavior: 'steer',
          prompt: `Feedback from the Content Board for “${card.title}” (${card.slug}), currently in ${card.stage}:\n\n${message}`,
        }),
      },
    )
    if (!response.ok) {
      const body = await readPlatformJson(response)
      throw new PlatformError(
        response.status,
        'feedback_failed',
        readObjectText(body, 'message') ?? 'Duet could not deliver that feedback to the agent.',
      )
    }
  }

  async function artifactResponse(pathParam: string | null): Promise<Response> {
    if (artifactRoot === undefined) {
      return fail(
        503,
        'agent_directory_unavailable',
        'The platform has not identified this app’s agent folder yet.',
      )
    }
    if (!pathParam) {
      return fail(
        400,
        'invalid_path',
        'Send ?path=seo/<slug>/<file>, relative to the SEO Specialist agent dir.',
      )
    }

    const agentRelativePath = pathParam.replaceAll('\\', '/')
    if (!agentRelativePath.startsWith('seo/')) {
      return fail(403, 'forbidden', 'Artifacts stay under the agent’s seo/ directory.')
    }
    const relativePath = agentRelativePath.slice('seo/'.length)
    const segments = relativePath.split('/')
    if (
      relativePath.length === 0 ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
      return fail(400, 'invalid_path', 'Path must not contain empty or traversal segments.')
    }

    const fullPath = resolve(artifactRoot, relativePath)
    if (!fullPath.startsWith(`${artifactRoot}${sep}`)) {
      return fail(403, 'forbidden', 'Artifacts stay under the agent’s seo/ directory.')
    }

    try {
      const [realArtifactRoot, realFilePath] = await Promise.all([
        realpath(artifactRoot),
        realpath(fullPath),
      ])
      if (!realFilePath.startsWith(`${realArtifactRoot}${sep}`)) {
        return fail(403, 'forbidden', 'Artifacts stay under the agent’s seo/ directory.')
      }
      return new Response(await readFile(realFilePath, 'utf8'), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      })
    } catch (error) {
      return isMissingFile(error)
        ? fail(404, 'artifact_not_found', `No artifact at ${agentRelativePath}.`)
        : fail(500, 'read_failed', 'Could not read that artifact.')
    }
  }

  function broadcast(event: { type: string; slug: string }): void {
    const frame = encoder.encode(
      `id: ${event.slug}:${Date.now()}\ndata: ${JSON.stringify(event)}\n\n`,
    )
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
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const cardMatch = /^\/api\/cards\/([^/]+)$/.exec(path)
    const artifactMatch = /^\/api\/cards\/([^/]+)\/artifacts$/.exec(path)
    const advanceMatch = /^\/api\/cards\/([^/]+)\/advance$/.exec(path)
    const feedbackMatch = /^\/api\/cards\/([^/]+)\/feedback$/.exec(path)

    if (request.method === 'GET' && path === '/api/board') {
      return Response.json({
        stages: [...STAGES],
        terminals: [...TERMINALS],
        ...(await board.read()),
      })
    }

    if (request.method === 'GET' && path === '/api/artifact') {
      return await artifactResponse(url.searchParams.get('path'))
    }

    if (request.method === 'POST' && path === '/api/cards') {
      const body = await readJson(request)
      if (body === undefined) return fail(400, 'invalid_json', 'Body must be a JSON object.')
      const slug = readSlug(body.slug)
      if (slug === undefined) {
        return fail(400, 'invalid_slug', 'slug must be 1–64 characters of a-z, 0-9 and hyphens.')
      }
      const title = readText(body.title, 200)
      if (title === undefined) return fail(400, 'invalid_title', 'title must be 1–200 characters.')
      const verdict = readVerdict(body.verdict)
      if (verdict === null) return fail(400, 'invalid_verdict', verdictMessage())
      const created = await board.create({
        slug,
        title,
        verdict: verdict.value,
        primaryKeyword: readText(body.primaryKeyword, 120) ?? null,
        note: readText(body.note, 500) ?? null,
      })
      if (created === undefined) {
        return fail(409, 'slug_taken', `A card for "${slug}" already exists.`)
      }
      broadcast({ type: 'card.created', slug })
      return Response.json({ card: created }, { status: 201 })
    }

    if (request.method === 'GET' && cardMatch) {
      const card = await board.find(cardMatch[1]!)
      return card === undefined ? missing(cardMatch[1]!) : Response.json({ card })
    }

    if (request.method === 'PATCH' && cardMatch) {
      const slug = cardMatch[1]!
      const body = await readJson(request)
      if (body === undefined) return fail(400, 'invalid_json', 'Body must be a JSON object.')
      const current = await board.find(slug)
      if (current === undefined) return missing(slug)

      const patch: Partial<Card> = {}
      if (body.title !== undefined) {
        const title = readText(body.title, 200)
        if (title === undefined)
          return fail(400, 'invalid_title', 'title must be 1–200 characters.')
        patch.title = title
      }
      if (body.verdict !== undefined) {
        const verdict = readVerdict(body.verdict)
        if (verdict === null) return fail(400, 'invalid_verdict', verdictMessage())
        patch.verdict = verdict.value
      }
      if (body.primaryKeyword !== undefined) {
        patch.primaryKeyword = readText(body.primaryKeyword, 120) ?? null
      }
      if (body.note !== undefined) patch.note = readText(body.note, 500) ?? null
      if (body.stage !== undefined) {
        const stage = readStage(body.stage)
        if (stage === undefined) {
          return fail(
            400,
            'invalid_stage',
            `stage must be one of: ${[...STAGES, ...TERMINALS].join(', ')}.`,
          )
        }
        const verdict = patch.verdict === undefined ? current.verdict : patch.verdict
        const refusal = refuseStage(stage, verdict)
        if (refusal !== undefined) return fail(409, refusal.error, refusal.message)
        patch.stage = stage
      }
      if (Object.keys(patch).length === 0) {
        return fail(
          400,
          'empty_patch',
          'Send at least one of stage, verdict, title, primaryKeyword, note.',
        )
      }

      const updated = await board.update(slug, patch)
      if (updated === undefined) return missing(slug)
      broadcast({ type: 'card.updated', slug })
      return Response.json({ card: updated })
    }

    if (request.method === 'POST' && advanceMatch) {
      const slug = advanceMatch[1]!
      const current = await board.find(slug)
      if (current === undefined) return missing(slug)
      if (current.stage !== 'review') {
        return fail(
          409,
          'not_waiting_for_input',
          'This card is not waiting for a person to review it.',
        )
      }
      const refusal = refuseStage('publish', current.verdict)
      if (refusal !== undefined) return fail(409, refusal.error, refusal.message)
      if (advancingReview.has(slug)) {
        return fail(409, 'advance_in_progress', 'This approval is already being sent.')
      }
      advancingReview.add(slug)
      try {
        await sendMessage(
          current,
          'Approved. Continue to publish preparation. Do not publish anything without a separate explicit approval.',
        )
        const updated = await board.advance(slug, 'review', 'publish')
        if (updated === undefined) {
          return fail(
            409,
            'card_changed',
            'The approval was sent, but the card changed before the board could advance it. The board will refresh automatically.',
          )
        }
        broadcast({ type: 'card.advanced', slug })
        return Response.json({ card: updated })
      } catch (error) {
        return error instanceof PlatformError
          ? fail(error.status, error.code, error.message)
          : fail(502, 'advance_failed', 'Duet could not deliver that approval to the agent.')
      } finally {
        advancingReview.delete(slug)
      }
    }

    if (request.method === 'POST' && feedbackMatch) {
      const slug = feedbackMatch[1]!
      const body = await readJson(request)
      if (body === undefined) return fail(400, 'invalid_json', 'Body must be a JSON object.')
      const message = readText(body.message, 4_000)
      if (message === undefined)
        return fail(400, 'invalid_message', 'message must be 1–4,000 characters.')
      const card = await board.find(slug)
      if (card === undefined) return missing(slug)
      if (card.stage !== 'review') {
        return fail(
          409,
          'not_waiting_for_input',
          'This card is not waiting for a person to review it.',
        )
      }
      try {
        await sendMessage(card, message)
        return Response.json({ ok: true })
      } catch (error) {
        return error instanceof PlatformError
          ? fail(error.status, error.code, error.message)
          : fail(502, 'feedback_failed', 'Duet could not deliver that feedback to the agent.')
      }
    }

    if (request.method === 'POST' && artifactMatch) {
      const slug = artifactMatch[1]!
      const body = await readJson(request)
      if (body === undefined) return fail(400, 'invalid_json', 'Body must be a JSON object.')
      const stage = readStage(body.stage)
      if (stage === undefined || !(STAGES as readonly string[]).includes(stage)) {
        return fail(400, 'invalid_stage', `stage must be one of: ${STAGES.join(', ')}.`)
      }
      const file = readText(body.file, 240)
      if (file === undefined) {
        return fail(
          400,
          'invalid_file',
          'file must be the drive path of the artifact this stage wrote.',
        )
      }
      const updated = await board.recordArtifact(slug, {
        stage: stage as Artifact['stage'],
        file,
        summary: readText(body.summary, 300) ?? null,
        recordedAt: Date.now(),
      })
      if (updated === undefined) return missing(slug)
      broadcast({ type: 'card.artifact', slug })
      return Response.json({ card: updated }, { status: 201 })
    }

    if (request.method === 'DELETE' && cardMatch) {
      const removed = await board.remove(cardMatch[1]!)
      if (!removed) return missing(cardMatch[1]!)
      broadcast({ type: 'card.removed', slug: cardMatch[1]! })
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && path === '/events') {
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
          // The stream may already be closing through cancellation.
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

    if (request.method === 'GET' && path === '/') {
      return new Response(await page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    return fail(404, 'not_found', 'No such route. Read README.md for the API.')
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

function resolveAgentDirectory(
  sourceDirectory: string,
  appPath: string | undefined,
  agentPath: string | undefined,
): string | undefined {
  if (appPath === undefined || agentPath === undefined) return undefined
  const appSegments = appPath.replaceAll('\\', '/').split('/').filter(Boolean)
  if (appSegments.length === 0) return undefined
  return resolve(sourceDirectory, ...appSegments.map(() => '..'), agentPath)
}

function refuseStage(
  stage: Stage,
  verdict: Verdict | null,
): { error: string; message: string } | undefined {
  if (stage === 'opportunity' || (TERMINALS as readonly string[]).includes(stage)) return undefined
  if (verdict === null) {
    return {
      error: 'verdict_required',
      message: `Set a verdict before moving past opportunity. Write ${'opportunity.md'} first, then PATCH { "verdict": "new" | "refresh" }.`,
    }
  }
  if (!PASSING_VERDICTS.has(verdict)) {
    return {
      error: 'verdict_blocks_stage',
      message: `A "${verdict}" verdict has no article to write. Move this card to shelved, or re-judge it in opportunity.`,
    }
  }
  return undefined
}

class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function readPlatformJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function readObjectText(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function verdictMessage(): string {
  return `verdict must be null or one of: ${VERDICTS.join(', ')}.`
}

function fail(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status })
}

function missing(slug: string): Response {
  return fail(404, 'card_not_found', `No card for "${slug}".`)
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function readText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= max ? text : undefined
}

function readSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const slug = value.trim().toLowerCase()
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64 ? slug : undefined
}

function readStage(value: unknown): Stage | undefined {
  return typeof value === 'string' && [...STAGES, ...TERMINALS].includes(value as Stage)
    ? (value as Stage)
    : undefined
}

/* `null` is the rejection; `{value}` carries an accepted verdict, including a
   deliberate clear back to null. */
function readVerdict(value: unknown): { value: Verdict | null } | null {
  if (value === null) return { value: null }
  if (value === undefined) return { value: null }
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value)
    ? { value: value as Verdict }
    : null
}

function createBoardRepository(path: string) {
  let stored: StoredBoard | undefined
  let writes = Promise.resolve()

  async function read(): Promise<StoredBoard> {
    stored ??= await readBoardStore(path)
    return structuredClone(stored)
  }

  /* Every mutation runs through this queue, so two agents writing at once
     cannot interleave a read-modify-write and lose a card. */
  async function commit<T>(mutate: (current: StoredBoard) => { next: StoredBoard; result: T }) {
    const result = writes.then(async () => {
      const current = await read()
      const outcome = mutate(current)
      await writeBoardStore(path, outcome.next)
      stored = outcome.next
      return outcome.result
    })
    writes = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }

  async function find(slug: string): Promise<Card | undefined> {
    return (await read()).cards.find(card => card.slug === slug)
  }

  async function create(input: {
    slug: string
    title: string
    verdict: Verdict | null
    primaryKeyword: string | null
    note: string | null
  }): Promise<Card | undefined> {
    return await commit(current => {
      if (current.cards.some(card => card.slug === input.slug)) {
        return { next: current, result: undefined }
      }
      const now = Date.now()
      const card: Card = {
        slug: input.slug,
        title: input.title,
        stage: 'opportunity',
        verdict: input.verdict,
        primaryKeyword: input.primaryKeyword,
        note: input.note,
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      }
      return { next: { cards: [...current.cards, card] }, result: card }
    })
  }

  async function update(slug: string, patch: Partial<Card>): Promise<Card | undefined> {
    return await commit(current => {
      const card = current.cards.find(entry => entry.slug === slug)
      if (card === undefined) return { next: current, result: undefined }
      const updated: Card = { ...card, ...patch, updatedAt: Date.now() }
      return {
        next: { cards: current.cards.map(entry => (entry.slug === slug ? updated : entry)) },
        result: updated,
      }
    })
  }

  async function advance(slug: string, from: Stage, to: Stage): Promise<Card | undefined> {
    return await commit(current => {
      const card = current.cards.find(entry => entry.slug === slug)
      if (card === undefined || card.stage !== from) return { next: current, result: undefined }
      const updated: Card = { ...card, stage: to, updatedAt: Date.now() }
      return {
        next: { cards: current.cards.map(entry => (entry.slug === slug ? updated : entry)) },
        result: updated,
      }
    })
  }

  async function recordArtifact(slug: string, artifact: Artifact): Promise<Card | undefined> {
    return await commit(current => {
      const card = current.cards.find(entry => entry.slug === slug)
      if (card === undefined) return { next: current, result: undefined }
      // One artifact per stage per file: re-running a stage replaces its row
      // rather than stacking duplicates nobody can read.
      const kept = card.artifacts.filter(
        entry => !(entry.stage === artifact.stage && entry.file === artifact.file),
      )
      const updated: Card = {
        ...card,
        artifacts: [...kept, artifact].sort(
          (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage),
        ),
        updatedAt: Date.now(),
      }
      return {
        next: { cards: current.cards.map(entry => (entry.slug === slug ? updated : entry)) },
        result: updated,
      }
    })
  }

  async function remove(slug: string): Promise<boolean> {
    return await commit(current => {
      const cards = current.cards.filter(card => card.slug !== slug)
      return { next: { cards }, result: cards.length !== current.cards.length }
    })
  }

  return { read, find, create, update, advance, recordArtifact, remove }
}

async function readBoardStore(path: string): Promise<StoredBoard> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StoredBoard
  } catch (error) {
    if (isMissingFile(error)) return { cards: [] }
    throw error
  }
}

async function writeBoardStore(path: string, store: StoredBoard): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

if (import.meta.main) {
  const app = createContentBoard()
  console.log(`Content board listening on ${app.url}`)
}
