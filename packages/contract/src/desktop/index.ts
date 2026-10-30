import { z } from 'zod'

import { WorkspaceGatewayRefusalErrorSchema } from '../gateway'

const DESKTOP_PATH_PREFIX = '/v1/desktop/'

export const DESKTOP_SCREEN = { width: 1440, height: 900 } as const
export const DESKTOP_LOOPBACK_PORT = 6901
export const DESKTOP_CDP_PORT = 9222
export const DESKTOP_BROWSER_EXTENSION_POLICY_PATH =
  '/etc/opt/chrome/policies/managed/duet-browser-extension.json'
export const DESKTOP_GRANT_TTL_MS = 2 * 60 * 1000
export const BROWSER_MANAGED_WINDOW_LIMIT = 10
export const BROWSER_IDLE_DISCARD_GRACE_MS = 60 * 1000
export const BROWSER_BATCH_TAB_TTL_MS = 24 * 60 * 60 * 1000
export const BROWSER_STACK_RETENTION_MS = 24 * 60 * 60 * 1000

// The image build and the in-place operator update install the same immutable
// Chrome artifact. The cross-package contract is intentional: changing the
// browser pin without changing both paths would make reprovisioned VMs differ
// from VMs updated through the operator rail.
export const DESKTOP_CHROME_VERSION = '151.0.7922.137-1'
export const DESKTOP_CHROME_DEB_SHA256 =
  'e6dabf044cf9cd0279cfe86efa431682c18bfc06d06339ce055aaa87ae871727'

export const DESKTOP_CHROME_PROFILE_REL = '.duet/chrome'
/**
 * The same profile, addressed from inside the gateway state dir it lives in.
 * Derived rather than written out a second time: the archive's tar exclusions
 * and the metrics reaper both need this form, and two literals that must agree
 * are two literals that eventually will not.
 */
export const DESKTOP_CHROME_PROFILE_IN_STATE = DESKTOP_CHROME_PROFILE_REL.slice('.duet/'.length)
export const DESKTOP_KASM_AUTH_PATH = '/home/exedev/.duet/desktop/kasm-auth.json'

/**
 * The systemd units behind the on-demand desktop, and the X display they own.
 *
 * Named here rather than inline at each call site because the gateway drives
 * these units by name over sudo, and the sudoers rules that permit it live in
 * the VM image — a rail that only moves on an image rebuild. Anything the
 * gateway does to the desktop has to stay inside the argv set already granted
 * there.
 */
export const DESKTOP_TARGET_UNIT = 'duet-desktop.target'
export const DESKTOP_BROWSER_UNIT = 'duet-desktop-browser.service'
export const DESKTOP_DISPLAY = 1
export const DESKTOP_CHROME_CACHE_EXCLUSIONS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'ShaderCache',
] as const

export const DesktopPhaseSchema = z.enum(['stopped', 'starting', 'ready'])
export type DesktopPhase = z.infer<typeof DesktopPhaseSchema>

export const BrowserOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }),
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }),
])
export type BrowserOwner = z.infer<typeof BrowserOwnerSchema>
export type BrowserOwnerKey = 'root' | `agent:${string}`

export function browserOwnerKey(owner: BrowserOwner): BrowserOwnerKey {
  return owner.kind === 'root' ? 'root' : `agent:${owner.agentId}`
}

export const DesktopBrowserBatchSchema = z.object({
  batchId: z.string().min(1),
  targetId: z.string().min(1),
  webSocketDebuggerUrl: z.string().url(),
  owner: BrowserOwnerSchema,
})
export type DesktopBrowserBatch = z.infer<typeof DesktopBrowserBatchSchema>

export const BrowserCapacityErrorSchema = z.object({
  error: z.literal('browser_capacity'),
  retryable: z.literal(true),
  retryAfterMs: z.number().int().positive(),
})
export type BrowserCapacityError = z.infer<typeof BrowserCapacityErrorSchema>

export const FocusBrowserOwnerResultSchema = z.object({ focused: z.boolean() })
export type FocusBrowserOwnerResult = z.infer<typeof FocusBrowserOwnerResultSchema>

export const DesktopFocusRequestIdSchema = z.string().min(1).max(128)
export const DesktopFocusRequestSchema = z
  .object({ requestId: DesktopFocusRequestIdSchema })
  .strict()
export const FocusBrowserOwnerRequestSchema = DesktopFocusRequestSchema.extend({
  owner: BrowserOwnerSchema,
}).strict()
export type FocusBrowserOwnerRequest = z.infer<typeof FocusBrowserOwnerRequestSchema>

export const DesktopOwnerPhaseSchema = z.enum(['active', 'cooling', 'idle'])
export type DesktopOwnerPhase = z.infer<typeof DesktopOwnerPhaseSchema>

export const DesktopOwnerActivitySchema = z.object({
  owner: BrowserOwnerSchema,
  agentSlug: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  phase: DesktopOwnerPhaseSchema,
  focused: z.boolean(),
  liveBatchCount: z.number().int().nonnegative(),
  batchTabCount: z.number().int().nonnegative(),
  discardedBatchTabCount: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
})
export type DesktopOwnerActivity = z.infer<typeof DesktopOwnerActivitySchema>

export const DesktopEmbedOriginSchema = z.string().superRefine((input, context) => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid embed origin' })
    return
  }
  const isIpv4Loopback = /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '[::1]' || isIpv4Loopback
  if (
    input !== url.origin ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
  ) {
    context.addIssue({ code: 'custom', message: 'Expected an exact canonical HTTPS origin' })
  }
})
export type DesktopEmbedOrigin = z.infer<typeof DesktopEmbedOriginSchema>

export const DesktopSessionRequestSchema = z
  .object({ embedOrigin: DesktopEmbedOriginSchema })
  .strict()
export type DesktopSessionRequest = z.infer<typeof DesktopSessionRequestSchema>

export const DesktopGrantRegistrationRequestSchema = z
  .object({
    grantId: z.string().min(1).refine(isSafeGrantId),
    tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.number().finite(),
    embedOrigin: DesktopEmbedOriginSchema,
  })
  .strict()
export type DesktopGrantRegistrationRequest = z.infer<typeof DesktopGrantRegistrationRequestSchema>

export const DesktopUnavailableErrorSchema = z.object({
  error: z.literal('desktop_unavailable'),
})

const DesktopCommonBareErrorSchema = z.object({
  error: z.union([
    z.enum(['unauthorized', 'not_found', 'desktop_gateway_failed']),
    WorkspaceGatewayRefusalErrorSchema,
  ]),
})
const DesktopInsufficientScopeErrorSchema = z.object({
  error: z.literal('insufficient_scope'),
  scope: z.string().min(1),
})
const DesktopInvalidRequestErrorSchema = z.object({ error: z.literal('invalid_request') })

export const DesktopStatusErrorSchema = z.union([
  DesktopCommonBareErrorSchema,
  DesktopInsufficientScopeErrorSchema,
])
export const DesktopSessionErrorSchema = z.union([
  DesktopStatusErrorSchema,
  DesktopInvalidRequestErrorSchema,
  DesktopUnavailableErrorSchema,
])
export const DesktopFocusErrorSchema = z.union([
  DesktopStatusErrorSchema,
  DesktopInvalidRequestErrorSchema,
])

export const DesktopSessionResponseSchema = z.object({
  entryUrl: z.string().url(),
  expiresAt: z.number().int().positive(),
  phase: DesktopPhaseSchema,
  screen: z.object({
    width: z.literal(DESKTOP_SCREEN.width),
    height: z.literal(DESKTOP_SCREEN.height),
  }),
})
export type DesktopSessionResponse = z.infer<typeof DesktopSessionResponseSchema>

export const DesktopStatusResponseSchema = z.object({
  phase: DesktopPhaseSchema,
  viewers: z.number().int().nonnegative(),
  owners: z.array(DesktopOwnerActivitySchema),
})
export type DesktopStatusResponse = z.infer<typeof DesktopStatusResponseSchema>

function isSafeGrantId(grantId: string): boolean {
  return grantId.length > 0 && !grantId.includes('/') && !grantId.includes('..')
}

function isSafeDesktopToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(token)
}

export function desktopEntryPath(grantId: string): string {
  if (!isSafeGrantId(grantId)) throw new Error('Invalid desktop grant id')
  return `${DESKTOP_PATH_PREFIX}${encodeURIComponent(grantId)}/`
}

export function desktopGrantIdForPath(path: string): string | null {
  if (!path.startsWith(DESKTOP_PATH_PREFIX)) return null

  const encodedGrantId = path.slice(DESKTOP_PATH_PREFIX.length).split('/', 1)[0]
  if (encodedGrantId === undefined || encodedGrantId.length === 0) return null

  try {
    const grantId = decodeURIComponent(encodedGrantId)
    return isSafeGrantId(grantId) ? grantId : null
  } catch {
    return null
  }
}

export function desktopCredentialPath(grantId: string, token: string): string {
  if (!isSafeGrantId(grantId)) throw new Error('Invalid desktop grant id')
  if (!isSafeDesktopToken(token)) throw new Error('Invalid desktop token')
  return `${DESKTOP_PATH_PREFIX}${encodeURIComponent(grantId)}.${token}/`
}

/** Kasm's assets are relative, but its default socket path is rooted at `/websockify`. */
export function desktopViewerPath(grantId: string, token: string): string {
  const credentialPath = desktopCredentialPath(grantId, token)
  const query = new URLSearchParams({
    autoconnect: '1',
    resize: 'scale',
    path: `${credentialPath.slice(1)}websockify`,
  })
  return `${credentialPath}?${query}`
}

export function desktopCredentialPathForRequest(path: string): {
  grantId: string
  token: string
  tail: string
} | null {
  if (!path.startsWith(DESKTOP_PATH_PREFIX)) return null
  const credentialEnd = path.indexOf('/', DESKTOP_PATH_PREFIX.length)
  if (credentialEnd === -1) return null
  const credential = path.slice(DESKTOP_PATH_PREFIX.length, credentialEnd)
  const separator = credential.lastIndexOf('.')
  if (separator <= 0) return null
  const encodedGrantId = credential.slice(0, separator)
  const token = credential.slice(separator + 1)
  if (!isSafeDesktopToken(token)) return null
  try {
    const grantId = decodeURIComponent(encodedGrantId)
    if (!isSafeGrantId(grantId)) return null
    return { grantId, token, tail: path.slice(credentialEnd) }
  } catch {
    return null
  }
}
