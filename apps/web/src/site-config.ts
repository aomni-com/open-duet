import { DUET_API_ORIGIN } from '@repo/contract'

// Origins are the only per-environment config: they map to distinct Vercel
// projects (e.g. ctl-staging.duet.so). Paths belong to code, not config.
const DEFAULT_MCP_ORIGIN = 'https://mcp.duet.so'
const DEFAULT_APP_ORIGIN = 'https://app.duet.so'

export interface SiteConfig {
  apiBaseUrl: string
  mcpUrl: string
}

export function siteConfig(env: Record<string, string | undefined> = process.env): SiteConfig {
  return {
    apiBaseUrl: normalizeUrl(env.DUET_API_URL ?? DUET_API_ORIGIN),
    mcpUrl: normalizeUrl(env.DUET_MCP_PUBLIC_URL ?? DEFAULT_MCP_ORIGIN),
  }
}

export function browserCookieHostname(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.VERCEL !== '1') return 'localhost'
  return new URL(env.DUET_APP_URL ?? DEFAULT_APP_ORIGIN).hostname
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '')
}
