import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDuetClient, type DuetClientOptions } from './duet'

/**
 * Samples in, a voice profile out. The Writer's whole refusal is "never flatten
 * voice", and until it has read the author it can only infer voice from the
 * draft in front of it — which is the draft it was asked to change. Reading two
 * or three finished pieces once, up front, is what makes "preserve this" mean
 * something specific.
 */
type Sample = { name: string; words: number; excerpt: string }

/**
 * How far the author lets the writer go. The one decision no amount of reading
 * can settle, and the agent's own central dial: past about a third rewritten it
 * has stopped editing and started rewriting.
 */
const LICENCES = ['light', 'balanced', 'firm'] as const
type Licence = (typeof LICENCES)[number]

type Profile = { samples: Sample[]; licence: Licence; voice?: string }
type StoredState = { profile: Profile | null; confirmedAt: string | null }

type Status = {
  ready: boolean
  message?: string
  profile: Profile | null
  confirmedAt: string | null
  complete: boolean
}

type AppOptions = DuetClientOptions & { directory?: string; port?: number }

/** Enough writing to read a voice from; below this the profile is guesswork. */
const MIN_WORDS = 150
const MAX_SAMPLES = 5
const MAX_SAMPLE_BYTES = 400_000

export function createSetupVoiceApp(options: AppOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const statePath = join(directory, 'state.json')
  const page = Bun.file(join(sourceDirectory, 'page.html')).text()
  const duet = createDuetClient(options)
  /**
   * The agent folder this app writes into, handed over by the platform because
   * only it knows: an installed copy is named by whoever installed it, so the
   * manifest's canonical path is right for the official hub and a guess
   * everywhere else. Absent means the platform has not said yet — the app
   * refuses to write rather than falling back to a default, because a write to
   * the wrong folder followed by an unlock is exactly the stranding this
   * onboarding exists to prevent.
   */
  const agentFolder = (options.env ?? Bun.env).DUET_AGENT_DIR
  const encoder = new TextEncoder()
  const watchers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()

  let stored: StoredState | undefined
  let writes = Promise.resolve()
  /** Full sample text, kept in memory: state.json holds only the excerpt. */
  const fullText = new Map<string, string>()

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
        stored = { profile: null, confirmedAt: null }
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

  async function status(): Promise<Status> {
    const state = await readState()
    if (!duet.configured || agentFolder === undefined) {
      return {
        ready: false,
        message: 'This page cannot reach your workspace yet. Ask your agent to take a look.',
        profile: state.profile,
        confirmedAt: state.confirmedAt,
        complete: false,
      }
    }
    return {
      ready: true,
      profile: state.profile,
      confirmedAt: state.confirmedAt,
      complete: state.confirmedAt !== null,
    }
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/status') {
      return Response.json(await status())
    }

    if (request.method === 'POST' && url.pathname === '/api/samples') {
      // Inferred, not annotated: a `FormData` annotation here resolves to the
      // DOM lib and collides with undici's identically-named type.
      const form = await request.formData().catch(() => undefined)
      if (form === undefined) return errorResponse('Attach a file or paste some writing.', 400)
      // Each read replaces the set wholesale, so the text from the previous one
      // is not just dead weight — a stale name would still answer `has()` and
      // let a confirm through on writing the author had already replaced.
      fullText.clear()
      const collected: Sample[] = []
      for (const entry of form.getAll('sample')) {
        const read = await sampleFrom(entry)
        if (read === undefined) continue
        if (read.text.length > MAX_SAMPLE_BYTES) {
          return errorResponse(`"${read.name}" is too large. Try a single piece.`, 413)
        }
        collected.push(summarize(read.name, read.text))
        fullText.set(read.name, read.text)
        if (collected.length === MAX_SAMPLES) break
      }
      const total = collected.reduce((sum, sample) => sum + sample.words, 0)
      if (total < MIN_WORDS) {
        return errorResponse(
          `That is about ${total} words. Add a bit more — two or three finished pieces read best.`,
          400,
        )
      }
      const licence = parseLicence(form.get('licence'))
      const state = await readState()
      await writeState({
        profile: { samples: collected, licence: licence ?? state.profile?.licence ?? 'balanced' },
        confirmedAt: null,
      })
      broadcast()
      return Response.json(await status())
    }

    if (request.method === 'PUT' && url.pathname === '/api/licence') {
      const input = await readJson(request)
      const licence = parseLicence(input?.licence)
      if (licence === undefined) return errorResponse('Pick how far the edit may go.', 400)
      const state = await readState()
      if (state.profile === null) return errorResponse('Add some writing first.', 409)
      await writeState({ profile: { ...state.profile, licence }, confirmedAt: null })
      broadcast()
      return Response.json(await status())
    }

    if (request.method === 'POST' && url.pathname === '/api/confirm') {
      const state = await readState()
      if (state.profile === null) return errorResponse('Add some writing first.', 409)
      // Sample text is held in memory, so a restart between adding and
      // confirming leaves the stored profile pointing at writing this process no
      // longer has. Reading a voice from nothing still produces confident prose,
      // and recording that as "what to preserve" is worse than asking again.
      if (state.profile.samples.some(sample => !fullText.has(sample.name))) {
        await writeState({ profile: null, confirmedAt: null })
        broadcast()
        return errorResponse('Add your writing again — this page was restarted.', 409)
      }
      if (agentFolder === undefined) {
        return errorResponse('This page is not ready yet. Try again in a minute.', 503)
      }
      const profile = { ...state.profile }
      profile.voice = await duet.describeVoice(voicePrompt(profile, fullText))

      // The samples themselves are the evidence behind every "I left this
      // alone", so they are kept beside the profile rather than summarized away.
      for (const sample of profile.samples) {
        const text = fullText.get(sample.name)
        if (text === undefined) continue
        const saved = await duet.writeFile(
          `${agentFolder}/voice/samples/${safeFileName(sample.name)}`,
          encoder.encode(text),
          'text/markdown; charset=utf-8',
        )
        if (!saved) {
          return errorResponse('A writing sample could not be saved. Try again in a minute.', 502)
        }
      }
      const wrote = await duet.writeFile(
        `${agentFolder}/voice/author-voice.md`,
        encoder.encode(renderProfile(profile)),
        'text/markdown; charset=utf-8',
      )
      if (!wrote) {
        return errorResponse('The voice profile could not be saved. Try again in a minute.', 502)
      }
      if (!(await duet.markAgentOnboarded())) {
        return errorResponse('Setup could not be finished. Try again in a minute.', 502)
      }
      await writeState({ profile, confirmedAt: new Date().toISOString() })
      broadcast()
      return Response.json(await status())
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

async function sampleFrom(
  entry: string | File,
): Promise<{ name: string; text: string } | undefined> {
  if (typeof entry === 'string') {
    const text = entry.trim()
    return text === '' ? undefined : { name: 'pasted.md', text }
  }
  const text = (await entry.text()).trim()
  return text === '' ? undefined : { name: entry.name || 'sample.md', text }
}

export function summarize(name: string, text: string): Sample {
  return {
    name,
    words: countWords(text),
    // The page shows the author what it read back, so a mis-attached file is
    // obvious before anything is written.
    excerpt: text.slice(0, 240).replace(/\s+/g, ' ').trim(),
  }
}

export function countWords(text: string): number {
  const matched = text.trim().match(/\S+/g)
  return matched === null ? 0 : matched.length
}

export function parseLicence(value: unknown): Licence | undefined {
  return typeof value === 'string' && (LICENCES as readonly string[]).includes(value)
    ? (value as Licence)
    : undefined
}

/** A drive path segment from an arbitrary upload name. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80)
  return cleaned === '' ? 'sample.md' : cleaned
}

const LICENCE_RULE: Record<Licence, string> = {
  light: 'Copyedit only. Do not restructure, and do not cut a paragraph without asking.',
  balanced:
    'Two passes as usual — structure, then line. Hand back anything past a third rewritten.',
  firm: 'Restructure freely when the argument needs it; still never change what the piece claims.',
}

function voicePrompt(profile: Profile, fullText: Map<string, string>): string {
  const samples = profile.samples
    .map(sample => `--- ${sample.name} ---\n${(fullText.get(sample.name) ?? '').slice(0, 6000)}`)
    .join('\n\n')
  return [
    "You are reading an author's own finished writing to record what a writer",
    'must preserve. Do not judge the writing and do not suggest improvements.',
    '',
    samples,
    '',
    'Write exactly three markdown sections and nothing else:',
    '',
    '## Register',
    'Two or three sentences: who this sounds like it is written for, how formal,',
    'how long the sentences run, first or third person.',
    '',
    '## Preserve',
    'Four to six bullets naming SPECIFIC traits a model would otherwise smooth',
    'away — sentence-length swings, deliberate fragments, recurring metaphors,',
    'words this author reaches for on purpose. Quote a short example for each.',
    '',
    '## Tics to leave alone',
    'Two or three habits that look like errors and are not, so a later pass does',
    'not "fix" them.',
  ].join('\n')
}

export function renderProfile(profile: Profile): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    '# Author voice',
    `**Established:** ${today}  **Read from:** ${profile.samples.map(sample => sample.name).join(', ')}`,
    '',
    '## Editing licence',
    `**${profile.licence}** — ${LICENCE_RULE[profile.licence]}`,
    '',
    profile.voice ??
      [
        '## Register',
        '_Not yet read — ask the author before the first edit._',
        '',
        '## Preserve',
        '_Not yet read — ask the author before the first edit._',
        '',
        '## Tics to leave alone',
        '_Not yet read — ask the author before the first edit._',
      ].join('\n'),
    '',
    '---',
    '',
    'The samples this was read from are in `voice/samples/`. Check a revision',
    'against this file before handing it back, and say which traits you kept.',
    '',
  ].join('\n')
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
  const app = createSetupVoiceApp()
  console.log(`Setup Voice listening on ${app.url}`)
}
