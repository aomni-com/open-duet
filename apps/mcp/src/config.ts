// MCP app config. Defaults live here; env vars override per environment and are
// resolved at call time. No secrets — those stay in process.env and are
// delivered by the secrets push.

import { DUET_API_ORIGIN } from '@repo/contract'

export const DEFAULT_DUET_MCP_PUBLIC_URL = 'https://mcp.duet.so/'
export const DEFAULT_MODEL_GATEWAY_URL = 'https://gateway.duet.so'

export function resolveApiBaseUrl(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return override ?? env.DUET_API_URL ?? DUET_API_ORIGIN
}

export function resolveModelGatewayUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return override ?? env.DUET_MODEL_GATEWAY_URL ?? DEFAULT_MODEL_GATEWAY_URL
}

export function resolveMcpPublicUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = override ?? env.DUET_MCP_PUBLIC_URL
  if (configured === undefined && env.VERCEL_ENV !== undefined) {
    throw new Error('DUET_MCP_PUBLIC_URL is required in deployed environments')
  }
  return `${canonicalMcpOrigin(configured ?? DEFAULT_DUET_MCP_PUBLIC_URL)}/`
}

function canonicalMcpOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname.replace(/\/+$/, '') !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('DUET_MCP_PUBLIC_URL must be an HTTPS origin')
  }
  return url.origin
}
