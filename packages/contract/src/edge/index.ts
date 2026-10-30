import { z } from 'zod'

import { AppDomainHostnameSchema } from '../domains/index'
import { PublishSnapshotComponentSchema } from '../publishes/index'
import { AppSlugSchema, PublishSlugSchema, WorkspaceSlugSchema } from '../slug/index'

// Standard app/publish traffic lives under the dedicated edge hosts —
// never bare `duet.so`, whose other subdomains (app, ctl, …) are unrelated
// deployments. Apps are subdomains of an edge host; publishes are paths on it.
export const DUET_EDGE_HOST = 'edge.duet.so'
export const DUET_STAGING_EDGE_HOST = 'edge-staging.duet.so'
export const EDGE_HOSTS = [DUET_EDGE_HOST, DUET_STAGING_EDGE_HOST] as const

/**
 * The one answer to "is this an edge host". Compare against `host`, not
 * `hostname`, so a port never sneaks past, and never by suffix, so
 * `edge.duet.so.evil.com` cannot pass as ours.
 */
export function isEdgeHost(host: string): boolean {
  return (EDGE_HOSTS as readonly string[]).includes(host)
}
export const EDGE_SECRET_HEADER = 'x-duet-edge-secret'
export const FORWARDED_HOST_HEADER = 'x-forwarded-host'
export const DUET_ORIGINAL_HOST_HEADER = 'x-duet-original-host'
export const DUET_WORKSPACE_SLUG_HEADER = 'x-duet-workspace-slug'
export const DUET_APP_SLUG_HEADER = 'x-duet-app-slug'
export const DUET_PUBLISH_SLUG_HEADER = 'x-duet-publish-slug'
export const DUET_PUBLISH_KIND_HEADER = 'x-duet-publish-kind'
export const DUET_PUBLISH_ANCHOR_PATH_HEADER = 'x-duet-publish-anchor-path'
export const DUET_PUBLISH_FREEZE_HEADER = 'x-duet-publish-freeze'
export const DUET_VIEWER_USER_ID_HEADER = 'x-duet-viewer-user-id'
// Public bootstrap for the anonymous publish viewer. The edge derives this from
// the backend resolve and forwards exactly these four public fields to apps/web;
// no email, session identity, VM address, or gateway token is ever carried here.
export const DUET_VIEWER_DESCRIPTOR_HEADER = 'x-duet-viewer-descriptor'
export const TUNNEL_TOKEN_HEADER = 'x-duet-tunnel-token'
export const DUET_APP_ACCESS_QUERY = 'duet_access'
export const DUET_APP_ACCESS_COOKIE = '__Host-duet_app_access'
export const APP_ACCESS_LAUNCH_TTL_MS = 2 * 60 * 1_000
export const APP_ACCESS_SESSION_TTL_MS = 8 * 60 * 60 * 1_000
const TUNNEL_TOKEN_PREFIX = 'duet_tt_'
const APP_ACCESS_GRANT_PREFIX = 'duet_app_'

const EdgeRouteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('app'),
    host: z.string(),
    workspaceSlug: WorkspaceSlugSchema,
    appSlug: AppSlugSchema,
    upstreamPath: z.string(),
  }),
  z.object({
    kind: z.literal('publish'),
    host: z.string(),
    workspaceSlug: WorkspaceSlugSchema,
    publishSlug: PublishSlugSchema,
    upstreamPath: z.string(),
  }),
])

export type EdgeRoute = z.infer<typeof EdgeRouteSchema>

const EdgeAppHostSchema = z.object({
  appSlug: AppSlugSchema,
  workspaceSlug: WorkspaceSlugSchema,
})

export function parseEdgeAppHost(
  host: string,
  edgeHost: string,
): { appSlug: string; workspaceSlug: string } | null {
  if (!host.endsWith(`.${edgeHost}`)) return null
  const subdomain = host.slice(0, -`.${edgeHost}`.length)
  const separator = subdomain.indexOf('--')
  if (separator <= 0 || separator !== subdomain.lastIndexOf('--')) return null
  const parsed = EdgeAppHostSchema.safeParse({
    appSlug: subdomain.slice(0, separator),
    workspaceSlug: subdomain.slice(separator + 2),
  })
  return parsed.success ? parsed.data : null
}

export function allowedIntegrationRedirect(
  value: string,
  context: { webAppUrl: string; workspaceSlug: string; edgeHost: string },
): string | null {
  try {
    if (value.trimStart().startsWith('//')) return null
    const webApp = new URL(context.webAppUrl)
    const destination = new URL(value, webApp)
    if (destination.username.length > 0 || destination.password.length > 0) return null
    const appHost = parseEdgeAppHost(destination.hostname, context.edgeHost)
    const allowed =
      destination.origin === webApp.origin ||
      (destination.protocol === 'https:' &&
        destination.port.length === 0 &&
        appHost?.workspaceSlug === context.workspaceSlug)
    if (!allowed) return null
    destination.search = ''
    destination.hash = ''
    return destination.toString()
  } catch {
    return null
  }
}

// The public grammar's single owner: which of the three publish request modes a
// URL asks for. Selector *presence* is authoritative — a `?raw`/`?list` with any
// value (or none) still counts — so the reserved bytes/listing paths can never be
// reached by accident, and every ordinary link (deep paths, `?theme=dark`, other
// params) falls through to the viewer. Both reserved selectors at once is a
// contradiction, not a last-wins tiebreak: it resolves to `invalid` (a `400` at
// the edge), matching the gateway's `invalid_selector` rejection.
export const PUBLISH_SELECTORS = ['raw', 'list', 'zip'] as const
export type PublishSelector = (typeof PUBLISH_SELECTORS)[number]

export function classifyPublishRequest(url: URL): 'viewer' | PublishSelector | 'invalid' {
  const selectors = PUBLISH_SELECTORS.filter(name => url.searchParams.has(name))
  if (selectors.length > 1) return 'invalid'
  return selectors[0] ?? 'viewer'
}

export const EdgeAppHostIdentitySchema = z.object({
  appId: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceSlug: WorkspaceSlugSchema,
  appSlug: AppSlugSchema,
})
export type EdgeAppHostIdentity = z.infer<typeof EdgeAppHostIdentitySchema>

export const EdgeResolveRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app-host'), hostname: AppDomainHostnameSchema }).strict(),
  z.object({
    kind: z.literal('app'),
    host: z.string(),
    workspaceSlug: WorkspaceSlugSchema,
    appSlug: AppSlugSchema,
    viewerUserId: z.string().optional(),
    viewerAppId: z.string().optional(),
    viewerCredential: z.enum(['cookie', 'grant']).optional(),
    customBinding: z
      .object({ hostname: AppDomainHostnameSchema, appId: z.string().min(1) })
      .strict()
      .optional(),
  }),
  z.object({
    kind: z.literal('publish'),
    host: z.string(),
    workspaceSlug: WorkspaceSlugSchema,
    publishSlug: PublishSlugSchema,
  }),
  z.object({
    kind: z.literal('tunnel'),
    workspaceSlug: WorkspaceSlugSchema,
    port: z.number().int().min(3000).max(9999),
  }),
])

export type EdgeResolveRequest = z.infer<typeof EdgeResolveRequestSchema>

// The minimum public bootstrap the viewer banner + single-file root need. It is
// an explicit allow-list: unknown keys are stripped (default zod object behavior),
// so an accidentally-projected email/VM/token never survives validation, and the
// owner label carries a non-email invariant so no email can leak through it.
export const ViewerDescriptorSchema = z.object({
  workspaceName: z.string().min(1),
  ownerName: z
    .string()
    .min(1)
    .refine(label => !label.includes('@'), 'ownerName must not be an email'),
  rootName: z.string().min(1),
  kind: z.enum(['file', 'folder']),
})

export type ViewerDescriptor = z.infer<typeof ViewerDescriptorSchema>

export const PublishFreezeHeaderSchema = z.object({
  publishId: PublishSnapshotComponentSchema,
  generation: PublishSnapshotComponentSchema,
})

export type PublishFreezeHeader = z.infer<typeof PublishFreezeHeaderSchema>

export function serializePublishFreezeHeader(value: PublishFreezeHeader): string {
  return JSON.stringify(PublishFreezeHeaderSchema.parse(value))
}

export function parsePublishFreezeHeader(
  headerValue: string | null | undefined,
): PublishFreezeHeader | null {
  if (headerValue === null || headerValue === undefined) return null
  try {
    const parsed = PublishFreezeHeaderSchema.safeParse(JSON.parse(headerValue))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// The edge serializes the validated descriptor into DUET_VIEWER_DESCRIPTOR_HEADER;
// apps/web parses the same schema back. Validating on the way out strips any
// private field a caller mistakenly included before it can reach the wire.
export function serializeViewerDescriptor(descriptor: ViewerDescriptor): string {
  return JSON.stringify(ViewerDescriptorSchema.parse(descriptor))
}

export function parseViewerDescriptor(
  headerValue: string | null | undefined,
): ViewerDescriptor | null {
  if (headerValue === null || headerValue === undefined) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(headerValue)
  } catch {
    return null
  }
  const parsed = ViewerDescriptorSchema.safeParse(decoded)
  return parsed.success ? parsed.data : null
}

export const EdgeResolveResponseSchema = z.object({
  visibility: z.union([z.literal('folder'), z.literal('public')]),
  workspace: z.object({
    id: z.string(),
    slug: WorkspaceSlugSchema,
    httpsUrl: z.string().url(),
    vmName: z.string(),
  }),
  origin: z.object({
    httpsUrl: z.string().url(),
    gatewayAuthToken: z.string().min(1),
    gatewayPathPrefix: z.string().default(''),
  }),
  publish: z
    .object({
      id: z.string(),
      kind: z.enum(['file', 'folder']),
      anchorPath: z.string().min(1),
      freeze: z.object({ generation: z.string().min(1) }).optional(),
      // Required: the backend always projects the public descriptor for a
      // resolved publish, and the edge forwards it to the viewer origin as the
      // banner/root bootstrap. An absent descriptor is a resolve bug, not a
      // tolerated shape — the parse rejects it rather than serving a viewer with
      // no identity.
      viewer: ViewerDescriptorSchema,
    })
    .optional(),
})

export type EdgeResolveResponse = z.infer<typeof EdgeResolveResponseSchema>

export const EdgeAppDenialSchema = z.object({
  error: z.enum(['guest_private', 'forbidden', 'suspended']),
})

export const EdgePausedResolutionSchema = z.object({
  paused: z.literal(true),
  appName: z.string().trim().min(1),
})

export type EdgePausedResolution = z.infer<typeof EdgePausedResolutionSchema>

export const EdgeResolveResultSchema = z.union([
  EdgeResolveResponseSchema,
  EdgePausedResolutionSchema,
])

export type EdgeResolveResult = z.infer<typeof EdgeResolveResultSchema>

export const AppAccessGrantClaimsSchema = z.object({
  appId: z.string().min(1),
  userId: z.string().min(1),
  workspaceSlug: WorkspaceSlugSchema,
  appSlug: AppSlugSchema,
  launchExpiresAt: z.number().int().positive().safe(),
  expiresAt: z.number().int().positive().safe(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
})

export type AppAccessGrantClaims = z.infer<typeof AppAccessGrantClaimsSchema>

export const TunnelTokenClaimsSchema = z.object({
  sourceWorkspaceId: z.string().min(1),
  targetWorkspaceId: z.string().min(1),
  direction: z.enum(['source-to-target', 'target-to-source']),
})

export type TunnelTokenClaims = z.infer<typeof TunnelTokenClaimsSchema>

const TunnelTokenPartsSchema = z.object({
  prefix: z.literal(TUNNEL_TOKEN_PREFIX),
  expiresAt: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{16,64}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
})

type TunnelTokenParts = z.infer<typeof TunnelTokenPartsSchema>

export function parseEdgeRoute(requestUrl: string, hostHeader: string | null): EdgeRoute | null {
  if (hostHeader === null || hostHeader.trim().length === 0) return null
  const url = new URL(requestUrl)
  const host = hostHeader.split(':')[0]!.toLowerCase()
  for (const edgeHost of EDGE_HOSTS) {
    if (host === edgeHost) return parsePublishRoute(url, host)
    if (host.endsWith(`.${edgeHost}`)) return parseAppRoute(url, host, edgeHost)
  }
  return null
}

export function parseTunnelTokenParts(token: string): TunnelTokenParts | null {
  if (!token.startsWith(TUNNEL_TOKEN_PREFIX)) return null
  const rest = token.slice(TUNNEL_TOKEN_PREFIX.length)
  const [expiresAtBase36, nonce, signature, extra] = rest.split('_')
  if (
    expiresAtBase36 === undefined ||
    nonce === undefined ||
    signature === undefined ||
    extra !== undefined
  ) {
    return null
  }
  if (!/^[0-9a-z]+$/.test(expiresAtBase36)) return null
  const expiresAt = Number.parseInt(expiresAtBase36, 36)
  if (!Number.isSafeInteger(expiresAt) || expiresAt.toString(36) !== expiresAtBase36) return null
  const parsed = TunnelTokenPartsSchema.safeParse({
    prefix: TUNNEL_TOKEN_PREFIX,
    expiresAt,
    nonce,
    signature,
  })
  return parsed.success ? parsed.data : null
}

export function formatTunnelTokenParts(parts: Omit<TunnelTokenParts, 'prefix'>): string {
  return `${TUNNEL_TOKEN_PREFIX}${parts.expiresAt.toString(36)}_${parts.nonce}_${parts.signature}`
}

export async function tunnelTokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

// Canonical tunnel-token signature — the single owner both the backend (minter)
// and gateway (verifier) sign through. A delimiter-joined payload let distinct
// claims collide on one signature (("a","b:c") vs ("a:b","c")); the versioned
// JSON encoding with named fields removes the ambiguity. Claims are validated
// before signing so an ill-formed claim can never be minted.
export async function signTunnelToken(
  secret: string,
  claims: TunnelTokenClaims,
  expiresAt: number,
  nonce: string,
): Promise<string> {
  const validated = TunnelTokenClaimsSchema.parse(claims)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const payload = JSON.stringify({
    version: 1,
    sourceWorkspaceId: validated.sourceWorkspaceId,
    targetWorkspaceId: validated.targetWorkspaceId,
    direction: validated.direction,
    expiresAt,
    nonce,
  })
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function mintAppAccessGrant(
  secret: string,
  claims: AppAccessGrantClaims,
): Promise<string> {
  const validated = AppAccessGrantClaimsSchema.parse(claims)
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(validated)))
  const signature = await signAppAccessPayload(secret, payload)
  return `${APP_ACCESS_GRANT_PREFIX}${payload}.${signature}`
}

export async function verifyAppAccessGrant(
  secret: string,
  token: string,
  now: number,
): Promise<AppAccessGrantClaims | null> {
  if (!token.startsWith(APP_ACCESS_GRANT_PREFIX)) return null
  const [payload, signature, extra] = token.slice(APP_ACCESS_GRANT_PREFIX.length).split('.')
  if (!payload || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature)) {
    return null
  }
  try {
    const key = await appAccessSigningKey(secret, ['verify'])
    const verified = await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(signature),
      new TextEncoder().encode(payload),
    )
    if (!verified) return null
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as unknown
    const parsed = AppAccessGrantClaimsSchema.safeParse(decoded)
    if (!parsed.success || parsed.data.expiresAt <= now) return null
    return parsed.data
  } catch {
    return null
  }
}

async function signAppAccessPayload(secret: string, payload: string): Promise<string> {
  const key = await appAccessSigningKey(secret, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return bytesToHex(new Uint8Array(signature))
}

async function appAccessSigningKey(
  secret: string,
  usages: Array<'sign' | 'verify'>,
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  )
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function parseAppRoute(url: URL, host: string, edgeHost: string): EdgeRoute | null {
  const appHost = parseEdgeAppHost(host, edgeHost)
  if (appHost === null) return null
  const parsed = EdgeRouteSchema.safeParse({
    kind: 'app',
    host,
    ...appHost,
    upstreamPath: `${url.pathname}${url.search}`,
  })
  return parsed.success ? parsed.data : null
}

function parsePublishRoute(url: URL, host: string): EdgeRoute | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [workspaceSlug, publishSlug, ...rest] = parts
  const upstreamPath = `/${rest.join('/')}${url.search}`
  const parsed = EdgeRouteSchema.safeParse({
    kind: 'publish',
    host,
    workspaceSlug,
    publishSlug,
    upstreamPath,
  })
  return parsed.success ? parsed.data : null
}
