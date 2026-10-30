import { createAccountBoardApp } from '../../content/agents/account-researcher/apps/account-board/server'
import { createSetupBrandApp } from '../../content/agents/brand-designer/apps/setup-brand/server'
import { createConnectReposApp } from '../../content/agents/code-reviewer/apps/connect-repos/server'
import { createDossierBoardApp } from '../../content/agents/people-researcher/apps/dossier-board/server'
import { createConnectSearchConsoleApp } from '../../content/agents/seo-specialist/apps/connect-search-console/server'
import { createContentBoard } from '../../content/agents/seo-specialist/apps/content-board/server'
import { createConnectAccountsApp } from '../../content/agents/social-media-manager/apps/connect-accounts/server'
import { createConnectHelpdeskApp } from '../../content/agents/support-agent/apps/connect-helpdesk/server'
import { createSetupVoiceApp } from '../../content/agents/writer/apps/setup-voice/server'

export type OfficialAppKey = `${string}/${string}`

export interface RunningOfficialApp {
  url: URL
  stop(): void | Promise<void>
}

export interface OfficialAppDriver {
  start(input: { directory: string; port: 0; edge: ControlledOfficialAppEdge }): RunningOfficialApp
}

export type VisualConnection = { id: string; integration: string; status: string }
export type ReposProbeResult =
  | {
      ok: true
      account?: string
      repos: Array<{ id: string; description?: string; private: boolean; updatedAt?: string }>
    }
  | { ok: false; reason: string }

/**
 * What one phone lookup comes back with. `pending: true` parks the lookup in
 * `enriching` so the scene that shows a button mid-flight is arranged through
 * the app's real route rather than by writing a state file.
 */
/** What the Firecrawl branding scrape comes back with for a scene. */
export type BrandScrapeOutcome =
  | { ok: true; branding: Record<string, unknown>; markdown?: string }
  | { ok: false; status: number }

export type PhoneLookupOutcome =
  | { pending: true }
  | { pending?: false; number?: string; region?: string }

export interface ControlledOfficialAppEdge {
  connections: VisualConnection[]
  executeResults: Map<string, unknown>
  failWhoami: boolean
  reposProbe: ReposProbeResult
  brandScrape: BrandScrapeOutcome
  /** The judgment prose the model returns, or null for a scene without one. */
  brandJudgment: string | null
  /** The voice profile the model returns, or null for a scene without one. */
  voiceProfile: string | null
  phoneLookup: PhoneLookupOutcome
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export function createControlledOfficialAppEdge(): ControlledOfficialAppEdge {
  const edge: ControlledOfficialAppEdge = {
    connections: [],
    executeResults: new Map(),
    failWhoami: false,
    reposProbe: { ok: false, reason: 'No code host is connected.' },
    brandScrape: { ok: false, status: 502 },
    brandJudgment: null,
    voiceProfile: null,
    phoneLookup: { number: '+1 415 555 0134', region: 'US' },
    async fetch(input, init) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname.includes('/services/fullenrich/')) {
        if (init?.method === 'POST') return Response.json({ enrichment_id: 'visual-enrichment' })
        if (edge.phoneLookup.pending === true) {
          // Never settles: the scene wants the button in its running state.
          return await new Promise<Response>(() => {})
        }
        const { number, region } = edge.phoneLookup
        return Response.json({
          status: 'FINISHED',
          data: [
            {
              contact_info: number === undefined ? {} : { most_probable_phone: { number, region } },
            },
          ],
        })
      }
      if (url.pathname === '/v1/services/firecrawl/v2/scrape') {
        if (!edge.brandScrape.ok)
          return Response.json({ error: 'unreadable' }, { status: edge.brandScrape.status })
        return Response.json({
          success: true,
          data: {
            branding: edge.brandScrape.branding,
            ...(edge.brandScrape.markdown === undefined
              ? {}
              : { markdown: edge.brandScrape.markdown }),
          },
        })
      }
      if (url.pathname === '/v1/chat/completions') {
        const content = edge.voiceProfile ?? edge.brandJudgment
        if (content === null) return Response.json({ error: 'no model' }, { status: 503 })
        return Response.json({ choices: [{ message: { content } }] })
      }
      if (url.pathname.startsWith('/v1/ws/visual/files/')) {
        return Response.json({ path: url.pathname, bytes: 0 })
      }
      if (url.pathname === '/v1/ws/visual/app/onboarded') {
        return Response.json({ agent: { id: 'agent_visual', slug: 'brand-designer' } })
      }
      if (url.hostname === 'cdn.visual.test') {
        // A logo the scrape pointed at. One flat mark, so the scene shows a real
        // image rather than a broken-image glyph.
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 24"><rect width="64" height="24" rx="6" fill="#4f46b8"/><text x="32" y="16" font-family="Georgia,serif" font-size="11" fill="#fff" text-anchor="middle">acme</text></svg>',
          { headers: { 'content-type': 'image/svg+xml' } },
        )
      }
      if (url.pathname === '/v1/whoami') {
        return edge.failWhoami
          ? Response.json({ error: 'visual workspace unavailable' }, { status: 503 })
          : Response.json({ workspaces: [{ id: 'ws_visual', slug: 'visual' }] })
      }
      if (url.pathname === '/v1/ws/visual/integrations/connections') {
        return Response.json({ items: edge.connections })
      }
      const execute = url.pathname.match(/^\/v1\/integrations\/composio\/execute\/(.+)$/)
      if (execute !== null) {
        const result = edge.executeResults.get(decodeURIComponent(execute[1]!))
        return result === undefined
          ? Response.json({ successful: false, error: 'visual_provider_unavailable', data: null })
          : Response.json({ successful: true, error: null, data: result })
      }
      if (url.pathname === '/v1/ws/visual/integrations/connect') {
        const body = JSON.parse(String(init?.body)) as { integration: string }
        return Response.json({
          integration: body.integration,
          authorizeUrl: `https://connect.visual.test/${body.integration}`,
        })
      }
      throw new Error(`Unexpected official-app visual request: ${url.pathname}`)
    },
  }
  return edge
}

const visualEnv = {
  DUET_API_URL: 'https://duet.visual.test',
  DUET_APP_API_KEY: 'duet_app_visual',
  DUET_GATEWAY_BASE_URL: 'https://duet.visual.test',
  // The platform tells an app which agent folder it is in, and an app that has
  // not been told refuses to write. Production sets it; so must the harness.
  DUET_AGENT_DIR: 'agents/visual-agent',
}

export const OFFICIAL_APP_DRIVERS: Readonly<Record<OfficialAppKey, OfficialAppDriver>> = {
  'account-researcher/account-board': {
    start: ({ directory, port, edge }) =>
      createAccountBoardApp({
        directory,
        port,
        env: visualEnv,
        fetchImpl: edge.fetch,
        pollIntervalMs: 0,
        timeoutMs: 5_000,
      }),
  },
  'brand-designer/setup-brand': {
    start: ({ directory, port, edge }) =>
      createSetupBrandApp({ directory, port, env: visualEnv, fetchImpl: edge.fetch }),
  },
  'writer/setup-voice': {
    start: ({ directory, port, edge }) =>
      createSetupVoiceApp({ directory, port, env: visualEnv, fetchImpl: edge.fetch }),
  },
  'people-researcher/dossier-board': {
    start: ({ directory, port, edge }) =>
      createDossierBoardApp({
        directory,
        port,
        env: visualEnv,
        fetchImpl: edge.fetch,
        pollIntervalMs: 0,
        timeoutMs: 5_000,
      }),
  },
  'code-reviewer/connect-repos': {
    start: ({ directory, port, edge }) =>
      createConnectReposApp({
        directory,
        port,
        probe: async () => edge.reposProbe,
      }),
  },
  'seo-specialist/connect-search-console': {
    start: ({ directory, port, edge }) =>
      createConnectSearchConsoleApp({
        directory,
        port,
        env: visualEnv,
        fetchImpl: edge.fetch,
      }),
  },
  'seo-specialist/content-board': {
    start: ({ directory, port }) =>
      createContentBoard({ directory, agentDirectory: directory, port }),
  },
  'social-media-manager/connect-accounts': {
    start: ({ directory, port, edge }) =>
      createConnectAccountsApp({
        directory,
        port,
        env: visualEnv,
        fetchImpl: edge.fetch,
      }),
  },
  'support-agent/connect-helpdesk': {
    start: ({ directory, port, edge }) =>
      createConnectHelpdeskApp({
        directory,
        port,
        env: visualEnv,
        fetchImpl: edge.fetch,
      }),
  },
}
