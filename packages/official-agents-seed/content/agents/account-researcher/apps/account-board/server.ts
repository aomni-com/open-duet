import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createFullEnrichClient,
  type FullEnrichOptions,
  type PhoneLookupResult,
} from './fullenrich'

type AccountStatus = 'queued' | 'researching' | 'needs-review' | 'ready'

type Source = {
  title: string
  url: string
}

type FoundFact = {
  label: string
  status: 'found' | 'conflicting' | 'stale'
  value: string
  retrievedAt: string
  source: Source
  note?: string
}

type UnfoundFact = {
  label: string
  status: 'unfound'
  retrievedAt: string
  note?: string
}

type Dossier = {
  facts: Array<FoundFact | UnfoundFact>
}

type SellerView = {
  id: string
  type: 'battlecard' | 'abm-plan'
  title: string
  content: string
  generatedAt: string
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

/**
 * A member of the buying group the seller should reach. `reason` is required
 * because a contact list without one is a list of titles: the whole value of
 * this section is which evidenced problem puts each person on it.
 */
type Contact = {
  id: string
  name: string
  title?: string
  profileUrl: string
  reason: string
  roles: Role[]
  email?: Email
  avatar?: Avatar
  phone: Phone
}

type Account = {
  id: string
  name: string
  domain?: string
  status: AccountStatus
  createdAt: string
  updatedAt: string
  dossier: Dossier
  views: SellerView[]
  contacts: Contact[]
}

type AccountStore = {
  accounts: Account[]
}

type AccountBoardOptions = FullEnrichOptions & {
  directory?: string
  port?: number
}

type ChangeEvent = {
  accountId: string
  resource: 'account' | 'dossier' | 'view' | 'contacts' | 'contact-phone' | 'contact-avatar'
}

const statuses = new Set<AccountStatus>(['queued', 'researching', 'needs-review', 'ready'])
const viewTypes = new Set<SellerView['type']>(['battlecard', 'abm-plan'])
const avatarSources = new Set<Avatar['source']>(['linkedin', 'x'])
const avatarTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_AVATAR_BYTES = 512 * 1024
const MAX_CONTACTS = 25

export function createAccountBoardApp(options: AccountBoardOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const avatarDirectory = join(directory, 'avatars')
  const store = createAccountRepository(join(directory, 'accounts.json'))
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

  async function runPhoneLookup(account: Account, contact: Contact): Promise<void> {
    let result: PhoneLookupResult
    try {
      result = await fullEnrich.lookupPhone({
        fullName: contact.name,
        companyName: account.name,
        ...(account.domain === undefined ? {} : { domain: account.domain }),
        profileUrl: contact.profileUrl,
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
    await store.updateContact(account.id, contact.id, current => ({ ...current, phone }))
    broadcast({ accountId: account.id, resource: 'contact-phone' })
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/accounts') {
      return Response.json(await store.read())
    }

    if (request.method === 'POST' && url.pathname === '/api/accounts') {
      const input = await readJson(request)
      const name = cleanString(input?.name, 120)
      const domain = cleanDomain(input?.domain)
      if (name === undefined || (input?.domain !== undefined && domain === undefined)) {
        return errorResponse('Name is required and domain must be a valid hostname.', 400)
      }
      const id = slugify(name)
      if (id === '') return errorResponse('Name must contain letters or numbers.', 400)
      const account = await store.create({ id, name, domain })
      if (account === undefined) return errorResponse('An account with that id already exists.', 409)
      broadcast({ accountId: id, resource: 'account' })
      return Response.json({ account }, { status: 201 })
    }

    const accountMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)$/)
    if (accountMatch !== null) {
      const id = accountMatch[1]!
      if (request.method === 'GET') {
        const account = await store.find(id)
        return account === undefined ? errorResponse('Account not found.', 404) : Response.json({ account })
      }
      if (request.method === 'PATCH') {
        const input = await readJson(request)
        const status = input?.status
        if (typeof status !== 'string' || !statuses.has(status as AccountStatus)) {
          return errorResponse('Status must be queued, researching, needs-review, or ready.', 400)
        }
        const account = await store.setStatus(id, status as AccountStatus)
        if (account === undefined) return errorResponse('Account not found.', 404)
        broadcast({ accountId: id, resource: 'account' })
        return Response.json({ account })
      }
      if (request.method === 'DELETE') {
        const removed = await store.remove(id)
        if (!removed) return errorResponse('Account not found.', 404)
        broadcast({ accountId: id, resource: 'account' })
        return new Response(null, { status: 204 })
      }
    }

    const dossierMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/dossier$/)
    if (request.method === 'PUT' && dossierMatch !== null) {
      const dossier = parseDossier(await readJson(request))
      if (dossier === undefined) {
        return errorResponse('Every found fact requires a value, source URL, and retrieval date.', 400)
      }
      const id = dossierMatch[1]!
      const account = await store.setDossier(id, dossier)
      if (account === undefined) return errorResponse('Account not found.', 404)
      broadcast({ accountId: id, resource: 'dossier' })
      return Response.json({ account })
    }

    const viewMatch = url.pathname.match(
      /^\/api\/accounts\/([a-z0-9-]+)\/views\/([a-z0-9-]+)$/,
    )
    if (viewMatch !== null) {
      const accountId = viewMatch[1]!
      const viewId = viewMatch[2]!
      if (request.method === 'PUT') {
        const view = parseView(viewId, await readJson(request))
        if (view === undefined) {
          return errorResponse('View requires a supported type, title, Markdown content, and date.', 400)
        }
        const account = await store.setView(accountId, view)
        if (account === undefined) return errorResponse('Account not found.', 404)
        broadcast({ accountId, resource: 'view' })
        return Response.json({ account })
      }
      if (request.method === 'DELETE') {
        const account = await store.removeView(accountId, viewId)
        if (account === undefined) return errorResponse('Account or view not found.', 404)
        broadcast({ accountId, resource: 'view' })
        return Response.json({ account })
      }
    }

    const contactsMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/contacts$/)
    if (request.method === 'PUT' && contactsMatch !== null) {
      const id = contactsMatch[1]!
      const existing = await store.find(id)
      if (existing === undefined) return errorResponse('Account not found.', 404)
      const parsed = parseContacts(await readJson(request), existing.contacts)
      if ('error' in parsed) return errorResponse(parsed.error, 400)
      const account = await store.setContacts(id, parsed.contacts)
      if (account === undefined) return errorResponse('Account not found.', 404)
      broadcast({ accountId: id, resource: 'contacts' })
      return Response.json({ account })
    }

    const contactMatch = url.pathname.match(
      /^\/api\/accounts\/([a-z0-9-]+)\/contacts\/([a-z0-9-]+)\/(phone|avatar)$/,
    )
    if (contactMatch !== null) {
      const accountId = contactMatch[1]!
      const contactId = contactMatch[2]!
      const account = await store.find(accountId)
      const contact = account?.contacts.find(item => item.id === contactId)
      if (account === undefined || contact === undefined) {
        return errorResponse('Contact not found.', 404)
      }

      if (contactMatch[3] === 'phone' && request.method === 'POST') {
        if (contact.phone.state === 'enriching') {
          return errorResponse('A phone lookup for this contact is already running.', 409)
        }
        if (!fullEnrich.configured) {
          return errorResponse(
            'This app cannot reach the Duet API, so it cannot look up a phone number.',
            503,
          )
        }
        const started = await store.updateContact(accountId, contactId, current => ({
          ...current,
          phone: { state: 'enriching', startedAt: new Date().toISOString() },
        }))
        if (started === undefined) return errorResponse('Contact not found.', 404)
        broadcast({ accountId, resource: 'contact-phone' })
        const lookup = runPhoneLookup(account, contact).finally(() => lookups.delete(lookup))
        lookups.add(lookup)
        return Response.json({ account: started }, { status: 202 })
      }

      if (contactMatch[3] === 'avatar') {
        const avatarPath = join(avatarDirectory, `${accountId}-${contactId}`)
        if (request.method === 'GET') {
          const file = Bun.file(avatarPath)
          if (contact.avatar === undefined || !(await file.exists())) {
            return errorResponse('No photo for this contact.', 404)
          }
          return new Response(file, {
            headers: { 'cache-control': 'no-cache', 'content-type': contact.avatar.contentType },
          })
        }
        if (request.method === 'PUT') {
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
          await writeFile(avatarPath, bytes)
          const updated = await store.updateContact(accountId, contactId, current => ({
            ...current,
            avatar: {
              source: source as Avatar['source'],
              sourceUrl,
              contentType,
              capturedAt: new Date().toISOString(),
            },
          }))
          if (updated === undefined) return errorResponse('Contact not found.', 404)
          broadcast({ accountId, resource: 'contact-avatar' })
          return Response.json({ account: updated })
        }
      }
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

function createAccountRepository(path: string) {
  let cached: AccountStore | undefined
  let writes = Promise.resolve()

  async function read(): Promise<AccountStore> {
    cached ??= await readStore(path)
    return structuredClone(cached)
  }

  async function mutate<T>(change: (current: AccountStore) => { next: AccountStore; result: T }) {
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

  async function create(input: { id: string; name: string; domain?: string }) {
    return await mutate<Account | undefined>(current => {
      if (current.accounts.some(account => account.id === input.id)) return { next: cached!, result: undefined }
      const now = new Date().toISOString()
      const account: Account = {
        ...input,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        dossier: { facts: [] },
        views: [],
        contacts: [],
      }
      return { next: { accounts: [...current.accounts, account] }, result: account }
    })
  }

  async function find(id: string) {
    return (await read()).accounts.find(account => account.id === id)
  }

  async function update(id: string, change: (account: Account) => Account) {
    return await mutate<Account | undefined>(current => {
      const existing = current.accounts.find(account => account.id === id)
      if (existing === undefined) return { next: cached!, result: undefined }
      const account = { ...change(existing), updatedAt: new Date().toISOString() }
      return {
        next: { accounts: current.accounts.map(item => (item.id === id ? account : item)) },
        result: account,
      }
    })
  }

  const setStatus = (id: string, status: AccountStatus) => update(id, account => ({ ...account, status }))
  const setDossier = (id: string, dossier: Dossier) =>
    update(id, account => ({ ...account, dossier, status: 'needs-review' }))
  const setView = (id: string, view: SellerView) =>
    update(id, account => ({
      ...account,
      views: [...account.views.filter(item => item.id !== view.id), view],
    }))
  const setContacts = (id: string, contacts: Contact[]) =>
    update(id, account => ({ ...account, contacts }))

  const updateContact = (accountId: string, contactId: string, change: (contact: Contact) => Contact) =>
    update(accountId, account => ({
      ...account,
      contacts: account.contacts.map(contact =>
        contact.id === contactId ? change(contact) : contact,
      ),
    }))

  async function removeView(id: string, viewId: string) {
    const existing = await find(id)
    if (existing === undefined || !existing.views.some(view => view.id === viewId)) return undefined
    return await update(id, account => ({
      ...account,
      views: account.views.filter(view => view.id !== viewId),
    }))
  }

  async function remove(id: string) {
    return await mutate(current => {
      if (!current.accounts.some(account => account.id === id)) return { next: cached!, result: false }
      return { next: { accounts: current.accounts.filter(account => account.id !== id) }, result: true }
    })
  }

  return {
    read,
    create,
    find,
    setStatus,
    setDossier,
    setView,
    removeView,
    setContacts,
    updateContact,
    remove,
  }
}

function parseDossier(input: Record<string, unknown> | undefined): Dossier | undefined {
  if (!Array.isArray(input?.facts) || input.facts.length > 500) return undefined
  const facts: Dossier['facts'] = []
  for (const candidate of input.facts) {
    if (!isRecord(candidate)) return undefined
    const label = cleanString(candidate.label, 120)
    const retrievedAt = cleanDate(candidate.retrievedAt)
    const note = candidate.note === undefined ? undefined : cleanString(candidate.note, 500)
    if (label === undefined || retrievedAt === undefined || (candidate.note !== undefined && note === undefined)) {
      return undefined
    }
    if (candidate.status === 'unfound') {
      if (candidate.value !== undefined || candidate.source !== undefined) return undefined
      facts.push({ label, status: 'unfound', retrievedAt, ...(note === undefined ? {} : { note }) })
      continue
    }
    if (!['found', 'conflicting', 'stale'].includes(String(candidate.status))) return undefined
    const value = cleanString(candidate.value, 2_000)
    const source = parseSource(candidate.source)
    if (value === undefined || source === undefined) return undefined
    facts.push({
      label,
      status: candidate.status as FoundFact['status'],
      value,
      retrievedAt,
      source,
      ...(note === undefined ? {} : { note }),
    })
  }
  return { facts }
}

/**
 * The set is replaced whole, because re-ranking a buying group is one decision
 * rather than a series of edits. What survives a replacement is what the user
 * spent on: a contact still on the list keeps the photo and the phone number
 * already retrieved for them.
 */
function parseContacts(
  input: Record<string, unknown> | undefined,
  previous: readonly Contact[],
): { contacts: Contact[] } | { error: string } {
  if (!Array.isArray(input?.contacts)) return { error: 'A contact set is required.' }
  if (input.contacts.length > MAX_CONTACTS) {
    return { error: `A buying group is at most ${MAX_CONTACTS} contacts.` }
  }
  const contacts: Contact[] = []
  const seen = new Set<string>()
  for (const candidate of input.contacts) {
    if (!isRecord(candidate)) return { error: 'Every contact must be an object.' }
    const name = cleanString(candidate.name, 120)
    if (name === undefined) return { error: 'Every contact needs a name.' }
    const id = cleanString(candidate.id, 80) ?? slugify(name)
    if (!/^[a-z0-9-]+$/.test(id)) {
      return { error: 'A contact id may only contain lowercase letters, numbers, and hyphens.' }
    }
    if (seen.has(id)) return { error: `Two contacts share the id "${id}".` }
    seen.add(id)
    const profileUrl = httpUrl(candidate.profileUrl)
    if (profileUrl === undefined) {
      return { error: `${name} needs the profile URL they were found at.` }
    }
    const reason = cleanString(candidate.reason, 600)
    if (reason === undefined) {
      return { error: `${name} needs a reason: one line saying why they are on the list.` }
    }
    const roles = parseRoles(candidate.roles)
    if (roles === undefined) return { error: 'Every role needs a title and a company.' }
    const email = parseEmail(candidate.email)
    if (email === undefined) {
      return {
        error: 'A found email needs an address, the provider verification, and a retrieval date.',
      }
    }
    const carried = previous.find(contact => contact.id === id)
    contacts.push({
      id,
      name,
      profileUrl,
      reason,
      roles,
      ...optionalString('title', candidate.title, 160),
      ...(email === null ? {} : { email }),
      ...(carried?.avatar === undefined ? {} : { avatar: carried.avatar }),
      phone: carried?.phone ?? { state: 'idle' },
    })
  }
  return { contacts }
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

function parseView(id: string, input: Record<string, unknown> | undefined): SellerView | undefined {
  const type = input?.type
  const title = cleanString(input?.title, 160)
  const content = cleanString(input?.content, 50_000)
  const generatedAt = cleanDate(input?.generatedAt)
  if (
    typeof type !== 'string' ||
    !viewTypes.has(type as SellerView['type']) ||
    title === undefined ||
    content === undefined ||
    generatedAt === undefined
  ) return undefined
  return { id, type: type as SellerView['type'], title, content, generatedAt }
}

function parseSource(value: unknown): Source | undefined {
  if (!isRecord(value)) return undefined
  const title = cleanString(value.title, 300)
  const url = httpUrl(value.url)
  return title === undefined || url === undefined ? undefined : { title, url }
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

function optionalString<K extends string>(
  key: K,
  value: unknown,
  max: number,
): Record<K, string> | Record<string, never> {
  const cleaned = cleanString(value, max)
  return cleaned === undefined ? {} : ({ [key]: cleaned } as Record<K, string>)
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

function cleanDomain(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const domain = cleanString(value, 253)?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  return domain !== undefined && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : undefined
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status })
}

async function readStore(path: string): Promise<AccountStore> {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as AccountStore
    // A board written before contacts existed has accounts without the field,
    // and the page reads it unconditionally.
    return {
      accounts: stored.accounts.map(account => ({ ...account, contacts: account.contacts ?? [] })),
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { accounts: [] }
    throw error
  }
}

async function writeStore(path: string, store: AccountStore): Promise<void> {
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
  const app = createAccountBoardApp()
  console.log(`Account Board listening on ${app.url}`)
}
