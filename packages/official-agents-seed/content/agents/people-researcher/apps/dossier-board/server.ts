import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createFullEnrichClient,
  type FullEnrichOptions,
  type PhoneLookupResult,
} from './fullenrich'

type IdentityConfirmation = 'profile-url' | 'verified-search' | 'user-choice'

type Identity = {
  profileUrl: string
  confirmedBy: IdentityConfirmation
}

type Role = {
  title: string
  company: string
  start?: string
  end?: string
}

type Email =
  | { status: 'found'; address: string; verification: string; retrievedAt: string; note?: string }
  | { status: 'unfound'; retrievedAt: string; note?: string }

type Highlight = {
  date: string
  summary: string
  url: string
}

type Avatar = {
  source: 'linkedin' | 'x'
  sourceUrl: string
  contentType: string
  capturedAt: string
}

/**
 * `idle` is "nobody has spent this yet" and is the only state the button acts
 * from. Everything else is the record of one lookup, including the ones that
 * came back empty — re-running a lookup that found nothing costs the same as
 * the first one, so an `unfound` phone is a result, not a retry prompt.
 */
type Phone =
  | { state: 'idle' }
  | { state: 'enriching'; startedAt: string }
  | { state: 'found'; number: string; region?: string; retrievedAt: string }
  | { state: 'unfound'; retrievedAt: string }
  | { state: 'failed'; reason: string; retrievedAt: string }

type Person = {
  id: string
  name: string
  title?: string
  company?: string
  domain?: string
  location?: string
  identity?: Identity
  summary?: string
  roles: Role[]
  email?: Email
  highlights: Highlight[]
  avatar?: Avatar
  phone: Phone
  createdAt: string
  updatedAt: string
}

type PersonStore = {
  people: Person[]
}

type ChangeEvent = {
  personId: string
  resource: 'person' | 'dossier' | 'avatar' | 'phone'
}

type DossierBoardOptions = FullEnrichOptions & {
  directory?: string
  port?: number
}

const confirmations = new Set<IdentityConfirmation>(['profile-url', 'verified-search', 'user-choice'])
const avatarSources = new Set<Avatar['source']>(['linkedin', 'x'])
const avatarTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_AVATAR_BYTES = 512 * 1024

export function createDossierBoardApp(options: DossierBoardOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const avatarDirectory = join(directory, 'avatars')
  const store = createPersonRepository(join(directory, 'people.json'))
  const page = Bun.file(join(sourceDirectory, 'page.html')).text()
  const fullEnrich = createFullEnrichClient(options)
  const watchers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()
  const encoder = new TextEncoder()
  const lookups = new Set<Promise<void>>()

  function broadcast(change: ChangeEvent): void {
    const frame = encoder.encode(`data: ${JSON.stringify(change)}\n\n`)
    for (const [controller, close] of watchers) {
      try {
        controller.enqueue(frame)
      } catch {
        close()
      }
    }
  }

  async function runPhoneLookup(person: Person): Promise<void> {
    let result: PhoneLookupResult
    try {
      result = await fullEnrich.lookupPhone({
        fullName: person.name,
        ...(person.company === undefined ? {} : { companyName: person.company }),
        ...(person.domain === undefined ? {} : { domain: person.domain }),
        ...(person.identity === undefined ? {} : { profileUrl: person.identity.profileUrl }),
      })
    } catch (error) {
      result = {
        found: false,
        reason: error instanceof Error ? error.message : 'The lookup failed unexpectedly.',
      }
    }
    const retrievedAt = new Date().toISOString()
    const phone: Phone = result.found
      ? {
          state: 'found',
          number: result.number,
          ...(result.region === undefined ? {} : { region: result.region }),
          retrievedAt,
        }
      : result.reason === undefined
        ? { state: 'unfound', retrievedAt }
        : { state: 'failed', reason: result.reason, retrievedAt }
    await store.setPhone(person.id, phone)
    broadcast({ personId: person.id, resource: 'phone' })
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/people') {
      return Response.json(await store.read())
    }

    if (request.method === 'POST' && url.pathname === '/api/people') {
      const input = await readJson(request)
      const name = cleanString(input?.name, 120)
      if (name === undefined) return errorResponse('A name is required.', 400)
      const id = slugify(name)
      if (id === '') return errorResponse('Name must contain letters or numbers.', 400)
      const domain = cleanDomain(input?.domain)
      if (input?.domain !== undefined && domain === undefined) {
        return errorResponse('Domain must be a valid hostname.', 400)
      }
      const person = await store.create({
        id,
        name,
        ...optionalString('title', input?.title, 160),
        ...optionalString('company', input?.company, 160),
        ...optionalString('location', input?.location, 160),
        ...(domain === undefined ? {} : { domain }),
      })
      if (person === undefined) return errorResponse('A person with that id already exists.', 409)
      broadcast({ personId: id, resource: 'person' })
      return Response.json({ person }, { status: 201 })
    }

    const personMatch = url.pathname.match(/^\/api\/people\/([a-z0-9-]+)$/)
    if (personMatch !== null) {
      const id = personMatch[1]!
      if (request.method === 'GET') {
        const person = await store.find(id)
        return person === undefined
          ? errorResponse('Person not found.', 404)
          : Response.json({ person })
      }
      if (request.method === 'DELETE') {
        const removed = await store.remove(id)
        if (!removed) return errorResponse('Person not found.', 404)
        await rm(join(avatarDirectory, id), { force: true })
        broadcast({ personId: id, resource: 'person' })
        return new Response(null, { status: 204 })
      }
    }

    const dossierMatch = url.pathname.match(/^\/api\/people\/([a-z0-9-]+)\/dossier$/)
    if (request.method === 'PUT' && dossierMatch !== null) {
      const parsed = parseDossier(await readJson(request))
      if ('error' in parsed) return errorResponse(parsed.error, 400)
      const person = await store.setDossier(dossierMatch[1]!, parsed.dossier)
      if (person === undefined) return errorResponse('Person not found.', 404)
      broadcast({ personId: person.id, resource: 'dossier' })
      return Response.json({ person })
    }

    const avatarMatch = url.pathname.match(/^\/api\/people\/([a-z0-9-]+)\/avatar$/)
    if (avatarMatch !== null) {
      const id = avatarMatch[1]!
      if (request.method === 'GET') {
        const person = await store.find(id)
        if (person?.avatar === undefined) return errorResponse('No photo for this person.', 404)
        const file = Bun.file(join(avatarDirectory, id))
        if (!(await file.exists())) return errorResponse('No photo for this person.', 404)
        return new Response(file, {
          headers: { 'cache-control': 'no-cache', 'content-type': person.avatar.contentType },
        })
      }
      if (request.method === 'PUT') {
        const person = await store.find(id)
        if (person === undefined) return errorResponse('Person not found.', 404)
        const source = url.searchParams.get('source') ?? ''
        const sourceUrl = httpUrl(url.searchParams.get('from'))
        const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim()
        if (!avatarSources.has(source as Avatar['source'])) {
          return errorResponse('A photo must say which profile it came from: linkedin or x.', 400)
        }
        if (sourceUrl === undefined) {
          return errorResponse('A photo needs the profile URL it was taken from.', 400)
        }
        if (!avatarTypes.has(contentType)) {
          return errorResponse('A photo must be a JPEG, PNG, or WebP.', 415)
        }
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength === 0) return errorResponse('The photo was empty.', 400)
        if (bytes.byteLength > MAX_AVATAR_BYTES) {
          return errorResponse(`The photo is larger than ${MAX_AVATAR_BYTES / 1024} KB.`, 413)
        }
        await mkdir(avatarDirectory, { recursive: true })
        await writeFile(join(avatarDirectory, id), bytes)
        const updated = await store.setAvatar(id, {
          source: source as Avatar['source'],
          sourceUrl,
          contentType,
          capturedAt: new Date().toISOString(),
        })
        if (updated === undefined) return errorResponse('Person not found.', 404)
        broadcast({ personId: id, resource: 'avatar' })
        return Response.json({ person: updated })
      }
    }

    const phoneMatch = url.pathname.match(/^\/api\/people\/([a-z0-9-]+)\/phone$/)
    if (request.method === 'POST' && phoneMatch !== null) {
      const id = phoneMatch[1]!
      const person = await store.find(id)
      if (person === undefined) return errorResponse('Person not found.', 404)
      if (person.phone.state === 'enriching') {
        return errorResponse('A phone lookup for this person is already running.', 409)
      }
      if (!fullEnrich.configured) {
        return errorResponse('This app cannot reach the Duet API, so it cannot look up a phone number.', 503)
      }
      if (
        !fullEnrich.canLookUp({
          fullName: person.name,
          ...(person.company === undefined ? {} : { companyName: person.company }),
          ...(person.domain === undefined ? {} : { domain: person.domain }),
          ...(person.identity === undefined ? {} : { profileUrl: person.identity.profileUrl }),
        })
      ) {
        return errorResponse(
          'A phone lookup needs either a confirmed profile URL or a full name with an employer.',
          409,
        )
      }
      const started = await store.setPhone(id, {
        state: 'enriching',
        startedAt: new Date().toISOString(),
      })
      if (started === undefined) return errorResponse('Person not found.', 404)
      broadcast({ personId: id, resource: 'phone' })
      const lookup = runPhoneLookup(started).finally(() => lookups.delete(lookup))
      lookups.add(lookup)
      return Response.json({ person: started }, { status: 202 })
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
    /** Resolves once every in-flight phone lookup has settled. */
    settled: async () => {
      await Promise.allSettled(lookups)
    },
    fetch: fetchRequest,
  }
}

function createPersonRepository(path: string) {
  let cached: PersonStore | undefined
  let writes = Promise.resolve()

  async function read(): Promise<PersonStore> {
    cached ??= await readStore(path)
    return structuredClone(cached)
  }

  async function mutate<T>(change: (current: PersonStore) => { next: PersonStore; result: T }) {
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

  async function create(input: Omit<Person, 'createdAt' | 'updatedAt' | 'roles' | 'highlights' | 'phone'>) {
    return await mutate<Person | undefined>(current => {
      if (current.people.some(person => person.id === input.id)) {
        return { next: cached!, result: undefined }
      }
      const now = new Date().toISOString()
      const person: Person = {
        ...input,
        roles: [],
        highlights: [],
        phone: { state: 'idle' },
        createdAt: now,
        updatedAt: now,
      }
      return { next: { people: [...current.people, person] }, result: person }
    })
  }

  async function find(id: string) {
    return (await read()).people.find(person => person.id === id)
  }

  async function update(id: string, change: (person: Person) => Person) {
    return await mutate<Person | undefined>(current => {
      const existing = current.people.find(person => person.id === id)
      if (existing === undefined) return { next: cached!, result: undefined }
      const person = { ...change(existing), updatedAt: new Date().toISOString() }
      return {
        next: { people: current.people.map(item => (item.id === id ? person : item)) },
        result: person,
      }
    })
  }

  const setDossier = (id: string, dossier: Dossier) =>
    update(id, person => ({
      ...person,
      ...dossier,
    }))
  const setAvatar = (id: string, avatar: Avatar) => update(id, person => ({ ...person, avatar }))
  const setPhone = (id: string, phone: Phone) => update(id, person => ({ ...person, phone }))

  async function remove(id: string) {
    return await mutate(current => {
      if (!current.people.some(person => person.id === id)) return { next: cached!, result: false }
      return { next: { people: current.people.filter(person => person.id !== id) }, result: true }
    })
  }

  return { read, create, find, setDossier, setAvatar, setPhone, remove }
}

type Dossier = Pick<
  Person,
  'title' | 'company' | 'domain' | 'location' | 'identity' | 'summary' | 'roles' | 'email' | 'highlights'
>

/**
 * The board refuses a dossier whose identity is unstated, and an email that
 * claims a value without the provider's verdict on it. Both are the same rule:
 * a page that shows a face, an address and an employer is exactly the document
 * a reader stops checking, so the parts that could be about the wrong person
 * have to arrive with their evidence attached.
 */
function parseDossier(input: Record<string, unknown> | undefined): { dossier: Dossier } | { error: string } {
  const identity = parseIdentity(input?.identity)
  if (identity === undefined) {
    return {
      error:
        'A dossier needs the confirmed profile URL and how identity was confirmed (profile-url, verified-search, or user-choice).',
    }
  }
  const roles = parseRoles(input?.roles)
  if (roles === undefined) return { error: 'Every role needs a title and a company.' }
  const email = parseEmail(input?.email)
  if (email === undefined) {
    return { error: 'A found email needs an address, the provider verification, and a retrieval date.' }
  }
  const highlights = parseHighlights(input?.highlights)
  if (highlights === undefined) {
    return { error: 'Every public-activity entry needs a date, a summary, and an HTTP(S) URL.' }
  }
  const domain = input?.domain === undefined ? undefined : cleanDomain(input.domain)
  if (input?.domain !== undefined && domain === undefined) {
    return { error: 'Domain must be a valid hostname.' }
  }
  return {
    dossier: {
      identity,
      roles,
      highlights,
      ...(email === null ? {} : { email }),
      ...(domain === undefined ? {} : { domain }),
      ...optionalString('title', input?.title, 160),
      ...optionalString('company', input?.company, 160),
      ...optionalString('location', input?.location, 160),
      ...optionalString('summary', input?.summary, 1_200),
    },
  }
}

function parseIdentity(value: unknown): Identity | undefined {
  if (!isRecord(value)) return undefined
  const profileUrl = httpUrl(value.profileUrl)
  const confirmedBy = value.confirmedBy
  if (profileUrl === undefined || typeof confirmedBy !== 'string') return undefined
  return confirmations.has(confirmedBy as IdentityConfirmation)
    ? { profileUrl, confirmedBy: confirmedBy as IdentityConfirmation }
    : undefined
}

function parseRoles(value: unknown): Role[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) return undefined
  const roles: Role[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const title = cleanString(candidate.title, 160)
    const company = cleanString(candidate.company, 160)
    if (title === undefined || company === undefined) return undefined
    roles.push({
      title,
      company,
      ...optionalString('start', candidate.start, 40),
      ...optionalString('end', candidate.end, 40),
    })
  }
  return roles
}

function parseEmail(value: unknown): Email | null | undefined {
  if (value === undefined) return null
  if (!isRecord(value)) return undefined
  const retrievedAt = cleanDate(value.retrievedAt)
  const note = value.note === undefined ? undefined : cleanString(value.note, 300)
  if (retrievedAt === undefined || (value.note !== undefined && note === undefined)) return undefined
  if (value.status === 'unfound') {
    if (value.address !== undefined || value.verification !== undefined) return undefined
    return { status: 'unfound', retrievedAt, ...(note === undefined ? {} : { note }) }
  }
  if (value.status !== 'found') return undefined
  const address = cleanString(value.address, 320)
  const verification = cleanString(value.verification, 40)
  if (address === undefined || !address.includes('@') || verification === undefined) return undefined
  return {
    status: 'found',
    address,
    verification,
    retrievedAt,
    ...(note === undefined ? {} : { note }),
  }
}

function parseHighlights(value: unknown): Highlight[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) return undefined
  const highlights: Highlight[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const date = cleanDate(candidate.date)
    const summary = cleanString(candidate.summary, 400)
    const url = httpUrl(candidate.url)
    if (date === undefined || summary === undefined || url === undefined) return undefined
    highlights.push({ date, summary, url })
  }
  return highlights
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json()
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function optionalString<K extends string>(
  key: K,
  value: unknown,
  max: number,
): Record<K, string> | Record<string, never> {
  const cleaned = cleanString(value, max)
  return cleaned === undefined ? {} : ({ [key]: cleaned } as Record<K, string>)
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

function cleanDomain(value: unknown): string | undefined {
  const domain = cleanString(value, 253)
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
  return domain !== undefined && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : undefined
}

function httpUrl(value: unknown): string | undefined {
  const raw = cleanString(value, 2_000)
  if (raw === undefined) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : undefined
  } catch {
    return undefined
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status })
}

async function readStore(path: string): Promise<PersonStore> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PersonStore
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { people: [] }
    throw error
  }
}

async function writeStore(path: string, store: PersonStore): Promise<void> {
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
  const app = createDossierBoardApp()
  console.log(`Dossier Board listening on ${app.url}`)
}
