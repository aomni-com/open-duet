import { DUET_API_ORIGIN } from '@repo/contract'

const DEFAULT_MCP_ORIGIN = 'https://mcp.duet.so'

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

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '')
}
