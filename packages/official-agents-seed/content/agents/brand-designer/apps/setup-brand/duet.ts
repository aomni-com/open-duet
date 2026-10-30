/**
 * The app's entire outward edge. Four routes, each with the app's own runtime
 * key — this app never talks to a vendor directly and never persists a
 * credential:
 *
 *   GET  /v1/whoami                                → which workspace this is
 *   POST /v1/services/firecrawl/v2/scrape          → read the site's brand
 *   PUT  /v1/ws/:slug/files/:path                  → write the kit and the logo
 *   POST /v1/ws/:slug/app/onboarded                → unlock the agent
 *
 * Plus one call to the workspace's model gateway at `$DUET_GATEWAY_BASE_URL`,
 * which the platform hands to an app that declares `services`. The gateway
 * attributes that spend to THIS APP rather than to the workspace runner, which
 * is why the app authenticates there with its own key too — it never receives
 * the runner's workspace-wide `DUET_API_KEY`.
 *
 * Credentials: `$DUET_APP_API_KEY` is read from the environment and kept in
 * memory only. It is never written to disk, logged, or sent to the page.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type DuetClientOptions = {
  fetchImpl?: FetchLike
  env?: Record<string, string | undefined>
}

/** The slice of Firecrawl's `branding` format this app actually reads. */
export type SiteBranding = {
  colors?: Partial<Record<'primary' | 'accent' | 'background' | 'textPrimary' | 'link', string>>
  fonts?: Array<{ family?: string; role?: string }>
  typography?: { fontFamilies?: { primary?: string; heading?: string } }
  images?: { logo?: string; favicon?: string; logoAlt?: string }
  personality?: { tone?: string; energy?: string; targetAudience?: string }
  confidence?: { overall?: number }
}

export type ScrapeResult =
  | { ok: true; branding: SiteBranding; markdown?: string }
  | { ok: false; reason: string }

/**
 * `services` is the attribution every app claims — named for the capability that
 * lets it spend here. It bills the model's own cost rather than a user tier's
 * flat rate, which is the honest shape when the app has pinned the model: there
 * is no route to cover.
 *
 * Attribution does not grant spending access: workspace billing eligibility
 * and available credit are checked before the model request is forwarded.
 */
const TIER = 'services'
const MODEL = 'openai/gpt-6-luna'

export function createDuetClient(options: DuetClientOptions = {}) {
  const env = options.env ?? Bun.env
  // Wrapped at the seam: a bare global fetch assigned onto an object throws
  // "Illegal invocation" in browsers and is a known Bun/browser divergence.
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const apiUrl = env.DUET_API_URL?.replace(/\/+$/, '')
  const apiKey = env.DUET_APP_API_KEY
  const gatewayUrl = env.DUET_GATEWAY_BASE_URL?.replace(/\/+$/, '')
  let workspaceSlug: string | undefined

  const configured = apiUrl !== undefined && apiUrl !== '' && apiKey !== undefined && apiKey !== ''

  async function request(path: string, init?: RequestInit): Promise<Response> {
    if (!configured) throw new Error('duet_api_unconfigured')
    return await fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    })
  }

  async function workspace(): Promise<string> {
    if (workspaceSlug !== undefined) return workspaceSlug
    const response = await request('/v1/whoami')
    if (!response.ok) throw new Error(`whoami_${response.status}`)
    const body = (await response.json()) as { workspaces?: Array<{ slug?: string }> }
    const slug = body.workspaces?.[0]?.slug
    if (slug === undefined) throw new Error('whoami_no_workspace')
    workspaceSlug = slug
    return slug
  }

  return {
    configured,

    /** The site's own brand, read once through the platform's Firecrawl proxy. */
    async scrapeBranding(url: string): Promise<ScrapeResult> {
      try {
        const response = await request('/v1/services/firecrawl/v2/scrape', {
          method: 'POST',
          body: JSON.stringify({ url, formats: ['branding', 'markdown'], onlyMainContent: true }),
        })
        if (!response.ok) return { ok: false, reason: `scrape_${response.status}` }
        const body = (await response.json()) as {
          success?: boolean
          data?: { branding?: SiteBranding; markdown?: string }
        }
        const branding = body.data?.branding
        if (branding === undefined) return { ok: false, reason: 'no_branding' }
        return {
          ok: true,
          branding,
          ...(typeof body.data?.markdown === 'string' ? { markdown: body.data.markdown } : {}),
        }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },

    /**
     * One completion, for the half of a brand kit that extraction cannot reach:
     * what each colour is FOR, what must never happen to the mark, how the brand
     * writes. Returns undefined rather than throwing — a kit missing its
     * judgment sections is still worth writing, and the agent can fill them in.
     */
    async deriveJudgment(prompt: string): Promise<string | undefined> {
      if (gatewayUrl === undefined || gatewayUrl === '') return undefined
      try {
        const response = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-duet-tier': TIER,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt }],
          }),
        })
        if (!response.ok) return undefined
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = body.choices?.[0]?.message?.content
        return typeof content === 'string' && content.trim() !== '' ? content : undefined
      } catch {
        return undefined
      }
    },

    /** Write one file into the workspace drive, by drive-relative path. */
    async writeFile(path: string, body: Uint8Array, contentType: string): Promise<boolean> {
      try {
        const slug = await workspace()
        const encoded = path.split('/').map(encodeURIComponent).join('/')
        const response = await request(`/v1/ws/${slug}/files/${encoded}`, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body,
        })
        return response.ok
      } catch {
        return false
      }
    },

    /** Fetch an asset the scrape pointed at — a logo lives on the brand's CDN. */
    async fetchAsset(url: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
      try {
        const response = await fetchImpl(url)
        if (!response.ok) return undefined
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
        return { bytes: new Uint8Array(await response.arrayBuffer()), contentType }
      } catch {
        return undefined
      }
    },

    /**
     * The end of onboarding. Nothing else unlocks the agent's card, and no
     * session is running to do it. Reports failure rather than throwing so the
     * caller can retry.
     */
    async markAgentOnboarded(): Promise<boolean> {
      try {
        const slug = await workspace()
        const response = await request(`/v1/ws/${slug}/app/onboarded`, {
          method: 'POST',
          body: JSON.stringify({ onboarded: true }),
        })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

export type DuetClient = ReturnType<typeof createDuetClient>
