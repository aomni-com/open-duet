import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDuetClient, type DuetClientOptions, type SiteBranding } from './duet'

/**
 * One field. The user names their site; everything a brand kit can be read from
 * a site is read, and the parts a page cannot read are derived rather than
 * asked for. A questionnaire is how this stalls — the system is already
 * published on their own homepage.
 */
type Kit = {
  site: string
  brandName: string
  colors: Array<{ role: string; hex: string; usedFor: string }>
  fonts: Array<{ role: string; family: string }>
  logo?: { path?: string; source: string }
  tone?: string
  /** The model's prose for the sections extraction cannot reach. */
  judgment?: string
}

type StoredState = { kit: Kit | null; confirmedAt: string | null }

type Status = {
  ready: boolean
  message?: string
  kit: Kit | null
  confirmedAt: string | null
  complete: boolean
}

type AppOptions = DuetClientOptions & { directory?: string; port?: number }

export function createSetupBrandApp(options: AppOptions = {}) {
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
        stored = { kit: null, confirmedAt: null }
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
        kit: state.kit,
        confirmedAt: state.confirmedAt,
        complete: false,
      }
    }
    return {
      ready: true,
      kit: state.kit,
      confirmedAt: state.confirmedAt,
      complete: state.confirmedAt !== null,
    }
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/status') {
      return Response.json(await status())
    }

    if (request.method === 'POST' && url.pathname === '/api/scan') {
      const input = await readJson(request)
      const site = normalizeSite(typeof input?.site === 'string' ? input.site : '')
      if (site === undefined) {
        return errorResponse('Enter a web address, like acme.com.', 400)
      }
      const scraped = await duet.scrapeBranding(site)
      if (!scraped.ok) {
        return errorResponse(
          'That site could not be read. Check the address and try again.',
          scraped.reason.startsWith('scrape_4') ? 400 : 502,
        )
      }
      const kit = kitFromBranding(site, scraped.branding)
      kit.judgment = await duet.deriveJudgment(judgmentPrompt(kit, scraped.markdown))
      await writeState({ kit, confirmedAt: null })
      broadcast()
      return Response.json(await status())
    }

    if (request.method === 'POST' && url.pathname === '/api/confirm') {
      const state = await readState()
      if (state.kit === null) return errorResponse('Scan a site first.', 409)
      if (agentFolder === undefined) {
        return errorResponse('This page is not ready yet. Try again in a minute.', 503)
      }
      const kit = { ...state.kit }
      // The logo is what makes a kit usable rather than descriptive: extraction
      // yields a URL, and an asset a designer can place has to be a file.
      const logoUrl = kit.logo?.source
      if (logoUrl !== undefined) {
        const asset = await duet.fetchAsset(logoUrl)
        if (asset !== undefined) {
          const path = `${agentFolder}/brand/assets/logo${extensionFor(asset.contentType)}`
          if (await duet.writeFile(path, asset.bytes, asset.contentType)) {
            kit.logo = { path, source: logoUrl }
          }
        }
      }
      const wrote = await duet.writeFile(
        `${agentFolder}/brand/brand-kit.md`,
        encoder.encode(renderKit(kit)),
        'text/markdown; charset=utf-8',
      )
      if (!wrote) {
        return errorResponse('The brand kit could not be saved. Try again in a minute.', 502)
      }
      if (!(await duet.markAgentOnboarded())) {
        return errorResponse('Setup could not be finished. Try again in a minute.', 502)
      }
      await writeState({ kit, confirmedAt: new Date().toISOString() })
      broadcast()
      return Response.json(await status())
    }

    if (request.method === 'GET' && url.pathname === '/api/logo') {
      // Proxied rather than linked from the page. The brand's own CDN may refuse
      // a cross-origin request from the app frame, and a broken-image glyph in
      // the middle of "what it found" reads as a failed read.
      const state = await readState()
      const source = state.kit?.logo?.source
      if (source === undefined) return new Response('Not found', { status: 404 })
      const asset = await duet.fetchAsset(source)
      if (asset === undefined) return new Response('Not found', { status: 404 })
      return new Response(asset.bytes, {
        headers: { 'content-type': asset.contentType, 'cache-control': 'no-store' },
      })
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
 * A colour without a job gets used as a background by the next person who reads
 * the kit, so every hex Firecrawl returns arrives already named for what it is
 * for. These five are the roles its `colors` object reports.
 */
const COLOR_ROLES: Array<{
  key: keyof NonNullable<SiteBranding['colors']>
  role: string
  usedFor: string
}> = [
  { key: 'primary', role: 'Primary', usedFor: 'The brand colour — headlines, key surfaces' },
  { key: 'accent', role: 'Accent', usedFor: 'Buttons and highlights, never a page background' },
  { key: 'background', role: 'Surface', usedFor: 'Page and card backgrounds' },
  { key: 'textPrimary', role: 'Ink', usedFor: 'Body text' },
  { key: 'link', role: 'Link', usedFor: 'Inline links only' },
]

export function kitFromBranding(site: string, branding: SiteBranding): Kit {
  const colors = COLOR_ROLES.flatMap(({ key, role, usedFor }) => {
    const hex = branding.colors?.[key]
    return typeof hex === 'string' && hex.trim() !== '' ? [{ role, hex, usedFor }] : []
  })
  const heading = branding.typography?.fontFamilies?.heading ?? familyForRole(branding, 'heading')
  const body = branding.typography?.fontFamilies?.primary ?? familyForRole(branding, 'body')
  const fonts = [
    ...(heading === undefined ? [] : [{ role: 'Display', family: heading }]),
    ...(body === undefined ? [] : [{ role: 'Text', family: body }]),
  ]
  const logoUrl = branding.images?.logo
  return {
    site,
    brandName: brandNameFrom(site),
    colors,
    fonts,
    ...(typeof logoUrl === 'string' && logoUrl !== '' ? { logo: { source: logoUrl } } : {}),
    ...(branding.personality?.tone === undefined ? {} : { tone: branding.personality.tone }),
  }
}

function familyForRole(branding: SiteBranding, role: string): string | undefined {
  const match = branding.fonts?.find(font => font.role === role)?.family
  return typeof match === 'string' && match !== '' ? match : undefined
}

/** `https://www.acme.com/` → `acme` — a title the kit can carry. */
export function brandNameFrom(site: string): string {
  try {
    const host = new URL(site).hostname.replace(/^www\./, '')
    const label = host.split('.')[0] ?? host
    return label.charAt(0).toUpperCase() + label.slice(1)
  } catch {
    return site
  }
}

/**
 * Accepts what a person types — `acme.com`, `www.acme.com`, a full URL — and
 * returns the address to scrape, or undefined when there is no host in it.
 */
export function normalizeSite(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (!url.hostname.includes('.') || url.hostname.endsWith('.')) return undefined
    return url.origin + (url.pathname === '/' ? '' : url.pathname)
  } catch {
    return undefined
  }
}

function judgmentPrompt(kit: Kit, markdown: string | undefined): string {
  return [
    `You are writing three sections of a brand kit for ${kit.brandName} (${kit.site}).`,
    '',
    'Extracted so far:',
    ...kit.colors.map(color => `- ${color.role}: ${color.hex}`),
    ...kit.fonts.map(font => `- ${font.role} type: ${font.family}`),
    ...(kit.tone === undefined ? [] : [`- Tone read from the site: ${kit.tone}`]),
    '',
    ...(markdown === undefined ? [] : ['The site reads like this:', markdown.slice(0, 4000), '']),
    'Write exactly three markdown sections and nothing else:',
    '',
    '## Voice',
    'How long a sentence runs, whether it makes claims or asks questions, and',
    'words this brand does not use. Three bullets.',
    '',
    '## Imagery',
    'One paragraph an image prompt can act on: photographic or illustrated, warm',
    'or cool, people or product, and what is off-limits.',
    '',
    '## Exclusions',
    'Three bullets on what must never happen to the mark or the palette.',
    '',
    'Be specific to this brand. Do not invent facts about the company.',
  ].join('\n')
}

export function renderKit(kit: Kit): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    `# ${kit.brandName} — brand kit`,
    `**Established:** ${today}  **Confirmed by:** the workspace owner  **Sources:** ${kit.site}`,
    '',
    '## Colour',
    '| Role | Hex | Used for |',
    '| --- | --- | --- |',
    ...(kit.colors.length === 0
      ? ['| _none read_ | — | Ask the user for the palette. |']
      : kit.colors.map(color => `| ${color.role} | \`${color.hex}\` | ${color.usedFor} |`)),
    '',
    '## Type',
    '| Role | Family | Fallback |',
    '| --- | --- | --- |',
    ...(kit.fonts.length === 0
      ? ['| _none read_ | — | — |']
      : kit.fonts.map(
          font =>
            `| ${font.role} | ${font.family} | ${font.role === 'Display' ? 'Georgia, serif' : 'system-ui, sans-serif'} |`,
        )),
    '',
    '## Logo',
    kit.logo?.path !== undefined
      ? `| Lockup | File | Use on |\n| --- | --- | --- |\n| Primary | \`${kit.logo.path}\` | Light backgrounds |`
      : '_No logo file yet. Ask the user to attach one and put it in `brand/assets/`._',
    '',
    kit.judgment ??
      [
        '## Voice',
        '_Not yet set — confirm with the user._',
        '',
        '## Imagery',
        '_Not yet set — confirm with the user._',
        '',
        '## Exclusions',
        '_Not yet set — confirm with the user._',
      ].join('\n'),
    '',
  ].join('\n')
}

function extensionFor(contentType: string): string {
  if (contentType.includes('svg')) return '.svg'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
  return '.img'
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
  const app = createSetupBrandApp()
  console.log(`Setup Brand listening on ${app.url}`)
}
