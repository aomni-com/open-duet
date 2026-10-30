/**
 * The app's entire outward edge. Every network call this app makes goes to the
 * Duet API — never to a social platform directly — through the routes
 * the platform gives an app with the `integrations` capability:
 *
 *   GET  /v1/whoami                                   → which workspace this is
 *   GET  /v1/ws/:slug/integrations/connections        → what is connected
 *   POST /v1/integrations/composio/execute/:toolSlug  → one provider call, by
 *        tool slug, with credentials injected server-side (the
 *        `composio-credentials` skill documents this route)
 *
 * Starting a connection is deliberately absent. The provider's authorization
 * page refuses to render inside Duet's app frame, so a Connect button here can
 * only open a stray tab that returns to this app rather than to the product.
 * Connecting belongs to the onboarding chat, which hands the user a link whose
 * `redirectTo` is a path inside Duet.
 *
 * Credentials: `$DUET_APP_API_KEY` is read from the environment and kept in
 * memory only. It is never written to disk, logged, or sent to the page.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type DuetConnection = {
  id: string
  integration: string
  status: 'active' | 'pending' | 'error' | 'disconnected'
  name?: string
}

export type DuetClientOptions = {
  fetchImpl?: FetchLike
  env?: Record<string, string | undefined>
}

export type ExecuteResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string }

export function createDuetClient(options: DuetClientOptions = {}) {
  const env = options.env ?? Bun.env
  // Wrapped at the seam: a bare global fetch assigned onto an object throws
  // "Illegal invocation" in browsers and is a known Bun/browser divergence.
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const apiUrl = env.DUET_API_URL?.replace(/\/+$/, '')
  const apiKey = env.DUET_APP_API_KEY
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

    async listConnections(): Promise<DuetConnection[]> {
      const slug = await workspace()
      const response = await request(`/v1/ws/${slug}/integrations/connections`)
      if (!response.ok) throw new Error(`connections_${response.status}`)
      const body = (await response.json()) as { items?: DuetConnection[] }
      return body.items ?? []
    },

    /** One provider call through the platform proxy, by Composio tool slug. */
    async execute(toolSlug: string, args: Record<string, unknown>): Promise<ExecuteResult> {
      try {
        const response = await request(
          `/v1/integrations/composio/execute/${encodeURIComponent(toolSlug)}`,
          { method: 'POST', body: JSON.stringify({ arguments: args }) },
        )
        if (!response.ok) return { ok: false, reason: `execute_${response.status}` }
        const body = (await response.json()) as {
          successful?: boolean
          error?: string | null
          data?: unknown
        }
        if (body.successful === false) return { ok: false, reason: body.error ?? 'tool_failed' }
        return { ok: true, data: body.data }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

export type DuetClient = ReturnType<typeof createDuetClient>
