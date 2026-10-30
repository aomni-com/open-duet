// API app config. Defaults live here; env vars override per environment, resolved
// at call time. Secrets (EXE_TOKEN, COMPOSIO_API_KEY, internal keys) are NOT config —
// they stay in process.env and are delivered by the secrets push.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DUET_API_ORIGIN, DUET_EDGE_HOST, CONVEX_EVENT_BUDGET_BYTES } from '@repo/contract'
import {
  OFFICIAL_AGENTS_PUBLISH_SLUG,
  OFFICIAL_AGENTS_WORKSPACE_SLUG,
} from '@repo/official-agents-seed/manifest'

// An origin, not a versioned prefix: the generated Composio client appends its
// own `/api/vX` segment. The execute proxy builds paths by hand and needs the
// versioned base below.
export const DEFAULT_COMPOSIO_API_BASE_URL = 'https://backend.composio.dev'
export const DEFAULT_COMPOSIO_EXECUTE_BASE_URL = 'https://backend.composio.dev/api/v3'
export const DEFAULT_DUET_APP_URL = 'https://app.duet.so'
export const DEFAULT_DUET_MCP_PUBLIC_URL = 'https://mcp.duet.so/'
export const DEFAULT_VM_SYNC_INTERVAL_SECONDS = 3
// What a workspace with nothing outstanding waits instead. Capped by the
// unhealthy sweep, not by taste — see MAX_VM_IDLE_SYNC_INTERVAL_SECONDS.
export const DEFAULT_VM_IDLE_SYNC_INTERVAL_SECONDS = 300
// The pre-existing account that owns the golden official-agents workspace in
// every environment (David, 2026-07-22). The seed refuses to run until this
// account exists in the target deployment; DUET_OFFICIAL_HUB_OWNER_EMAIL
// overrides per environment if the identities ever diverge.
export const DEFAULT_OFFICIAL_HUB_OWNER_EMAIL = 'admin@duet.so'

export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DUET_API_URL
  if (configured === undefined && env.VERCEL_ENV !== undefined && env.VERCEL_ENV !== 'production') {
    throw new Error('DUET_API_URL is required outside the production deployment')
  }
  return canonicalHttpsOrigin(configured ?? DUET_API_ORIGIN)
}

export function resolveMcpPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DUET_MCP_PUBLIC_URL
  if (configured === undefined && env.VERCEL_ENV !== undefined) {
    throw new Error('DUET_MCP_PUBLIC_URL is required in deployed environments')
  }
  return `${canonicalHttpsOrigin(configured ?? DEFAULT_DUET_MCP_PUBLIC_URL)}/`
}

export function resolveAppUrl(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (override ?? env.DUET_APP_URL ?? DEFAULT_DUET_APP_URL).replace(/\/+$/, '')
}

// The edge host this deployment's public app URLs live under. Staging sets
// DUET_EDGE_HOST=edge-staging.duet.so; prod may omit it.
export function resolveEdgeHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.DUET_EDGE_HOST ?? DUET_EDGE_HOST
}

export function resolveOfficialHubOwnerEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.DUET_OFFICIAL_HUB_OWNER_EMAIL ?? DEFAULT_OFFICIAL_HUB_OWNER_EMAIL
}

export function resolveOfficialHubBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `https://${resolveEdgeHost(env)}/${OFFICIAL_AGENTS_WORKSPACE_SLUG}/${OFFICIAL_AGENTS_PUBLISH_SLUG}`
}

export function resolveTrustProxyHeaders(
  override?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return override ?? env.DUET_TRUST_PROXY_HEADERS === '1'
}

export function resolveModelGatewayUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return override ?? env.DUET_MODEL_GATEWAY_URL
}

export function resolveRuntimeReleaseDir(
  override: string | undefined,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Vercel mounts the inventory beside the bundled module; its launcher cwd
  // need not be that directory. Absolute local/test paths retain their meaning.
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    override ?? env.DUET_RUNTIME_RELEASE_DIR ?? fallback,
  )
}

export function resolveVmIdleSyncIntervalSeconds(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value =
    override ??
    Number(env.DUET_VM_IDLE_SYNC_INTERVAL_SECONDS ?? DEFAULT_VM_IDLE_SYNC_INTERVAL_SECONDS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_VM_IDLE_SYNC_INTERVAL_SECONDS
}

export function resolveVmSyncIntervalSeconds(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value =
    override ?? Number(env.DUET_VM_SYNC_INTERVAL_SECONDS ?? DEFAULT_VM_SYNC_INTERVAL_SECONDS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_VM_SYNC_INTERVAL_SECONDS
}

export function resolveComposioApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPOSIO_API_BASE_URL ?? DEFAULT_COMPOSIO_API_BASE_URL
}

// `COMPOSIO_LIFECYCLE_BASE_URL` now reaches only this execute base. The
// connected-account lifecycle it once named goes through the client above and
// no longer reads it; the name is kept readable so a deployment that set it
// keeps its execute host.
export function resolveComposioExecuteBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.COMPOSIO_EXECUTE_BASE_URL ??
    env.COMPOSIO_LIFECYCLE_BASE_URL ??
    DEFAULT_COMPOSIO_EXECUTE_BASE_URL
  )
}

// TTL for the GatewayClient gatewayConnectionBySlug resolution cache. Kept short:
// a stale entry survives at most this long, and any gateway connection failure or
// 5xx invalidates the slug immediately, so VM re-registration is visible within
// one TTL even without a failing request.
export const DEFAULT_GATEWAY_RESOLUTION_TTL_MS = 15_000

export function resolveGatewayResolutionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.DUET_GATEWAY_RESOLUTION_TTL_MS ?? DEFAULT_GATEWAY_RESOLUTION_TTL_MS)
}

// What one MCP tool result may weigh once a model has to read it, measured over
// the serialized JSON-RPC `result`. One number for every MCP source: a per-path
// constant is exactly how two paths end up with two different answers.
//
// The durable rule is an ordering, not a value — this must stay at or below
// CONVEX_EVENT_BUDGET_BYTES, so anything the model was allowed to see the
// timeline can still show in full and a `[truncated]` marker always means
// something real. If the two ever drift, drift them down together. The ordering
// is a gate rather than a hope: config.test.ts fails when it inverts.
//
// Within that ceiling the discriminator is money: 128 KiB is ~35-45k tokens for
// a single tool result, re-sent on every step of the turn. Measured against a
// real public MCP server, legitimate results clustered at 3-9 KB while one
// ordinary call returned 1.3 MB — so this sits far above every real answer and
// far below the disaster it exists to stop.
export const DEFAULT_MCP_TOOL_RESULT_BYTES = 128 * 1024

/**
 * The ordering above is a gate on the shipped default, and the override has to
 * live under the same gate or it is not a gate at all: this is the value the
 * proxy actually uses, so an operator raising it past the relay budget would
 * invert the rule with nothing failing anywhere.
 *
 * A junk value is worse than a large one. `Number('lots')` is `NaN`, and every
 * comparison against `NaN` is false — the cap would silently never fire, which
 * is the one failure mode the cap exists to prevent. So anything that is not a
 * positive number falls back to the default rather than being trusted.
 */
export function resolveMcpToolResultBytes(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.DUET_MCP_TOOL_RESULT_BYTES)
  if (!Number.isFinite(override) || override <= 0) return DEFAULT_MCP_TOOL_RESULT_BYTES
  return Math.min(override, CONVEX_EVENT_BUDGET_BYTES)
}

function canonicalHttpsOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname.replace(/\/+$/, '') !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Public URL must be an HTTPS origin')
  }
  return url.origin
}
