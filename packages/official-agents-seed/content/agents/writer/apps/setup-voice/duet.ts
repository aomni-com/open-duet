/**
 * The app's entire outward edge. Three routes, each with the app's own runtime
 * key — this app never talks to a vendor directly and never persists a
 * credential:
 *
 *   GET  /v1/whoami                 → which workspace this is
 *   PUT  /v1/ws/:slug/files/:path   → write the voice profile and the samples
 *   POST /v1/ws/:slug/app/onboarded → unlock the agent
 *
 * Plus one call to the workspace's model gateway at `$DUET_GATEWAY_BASE_URL`,
 * which every app process receives. The app authenticates there with its own
 * key, so the gateway attributes that generation to THIS APP — it never
 * receives the runner's workspace-wide `DUET_API_KEY`.
 *
 * Credentials: `$DUET_APP_API_KEY` is read from the environment and kept in
 * memory only. It is never written to disk, logged, or sent to the page.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type DuetClientOptions = {
  fetchImpl?: FetchLike
  env?: Record<string, string | undefined>
}

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

    /**
     * Reads the author's own writing and names what to preserve. This is the
     * one thing the seat cannot do without: its whole refusal is "never flatten
     * voice", and until it has read the author it can only infer voice from the
     * draft in front of it. Returns undefined rather than throwing — a profile
     * the author writes over is better than no seat at all.
     */
    async describeVoice(prompt: string): Promise<string | undefined> {
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
