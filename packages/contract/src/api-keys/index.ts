import { z } from 'zod'

import { HumanEntryCodeSchema } from '../entry-code/index'
import { parseScope } from '../scopes/index'
import { utf8BoundedString } from '../utf8/index'
import { DUET_API_KEY_PREFIX } from './fields'

export { DUET_API_KEY_PREFIX } from './fields'
export const BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const BROWSER_SESSION_ROTATE_BEFORE_MS = 5 * 60 * 1000
// The identity a browser session is minted from: the Convex Auth session
// whose cookies the web app carries. Inactivity is the only guard — the
// rotating refresh token dies after this long unused. Someone who keeps
// using the product is never signed out: the library insists on a finite
// absolute deadline, so it is set past any person's use of the product.
export const IDENTITY_SESSION_INACTIVE_MS = 30 * 24 * 60 * 60 * 1000
export const IDENTITY_SESSION_TOTAL_MS = 100 * 365 * 24 * 60 * 60 * 1000
export const MAX_API_KEY_NAME_UTF8_BYTES = 80
export const ApiKeyNameStorageSchema = z
  .string()
  .trim()
  .min(1)
  .pipe(utf8BoundedString(MAX_API_KEY_NAME_UTF8_BYTES, 'API key name'))

export const BrowserSessionCredentialSchema = z.object({
  token: z.string().startsWith(DUET_API_KEY_PREFIX),
  prefix: z.string().startsWith(DUET_API_KEY_PREFIX),
  expiresAt: z.number().int().positive(),
})

export type BrowserSessionCredential = z.infer<typeof BrowserSessionCredentialSchema>

const DeviceUserCodeSchema = HumanEntryCodeSchema
export const DeviceApprovalActionSchema = z.enum(['inspect', 'approve', 'deny'])
export type DeviceApprovalAction = z.infer<typeof DeviceApprovalActionSchema>
export const DeviceApprovalRequestSchema = z.strictObject({ userCode: DeviceUserCodeSchema })
export const DeviceApprovalResponseSchema = z.object({
  userCode: DeviceUserCodeSchema,
  status: z.enum(['pending', 'approved', 'denied', 'consumed', 'expired']),
  expiresAt: z.number().int().positive(),
  clientName: ApiKeyNameStorageSchema.optional(),
})
export type DeviceApprovalResponse = z.infer<typeof DeviceApprovalResponseSchema>
export const DEVICE_NAME_MAX_LENGTH = 64
export const DeviceCodeRequestSchema = z.strictObject({
  client_name: ApiKeyNameStorageSchema.optional(),
})
export const DeviceCodeResponseSchema = z.object({
  device_code: z.string().regex(/^[a-f0-9]{64}$/),
  user_code: DeviceUserCodeSchema,
  verification_uri: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
})
export const DeviceTokenRequestSchema = z.object({
  device_code: z.string().regex(/^[a-f0-9]{64}$/),
})
export const DeviceTokenResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), interval: z.number().int().positive() }),
  z.object({ status: z.literal('slow_down'), interval: z.number().int().positive() }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('consumed') }),
  z.object({
    status: z.literal('approved'),
    access_token: z.string().startsWith(DUET_API_KEY_PREFIX),
    token_type: z.literal('bearer'),
    prefix: z.string().startsWith(DUET_API_KEY_PREFIX),
  }),
])

export const DevicePollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), interval: z.number() }),
  z.object({ status: z.literal('slow_down'), interval: z.number() }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('consumed') }),
  z.object({
    status: z.literal('approved'),
    key: z.string(),
    prefix: z.string(),
  }),
])

export function extractApiKeyCredential(headers: Headers): { token: string } | null {
  const bearerToken = extractBearerToken(headers.get('authorization'))
  if (bearerToken !== null) return tokenCredential(bearerToken)

  const apiKey = headers.get('x-api-key')?.trim()
  if (apiKey === undefined || apiKey.length === 0) return null
  return tokenCredential(apiKey)
}

export function extractBearerToken(header: string | null): string | null {
  if (header === null) return null
  const parts = header.trim().split(/\s+/)
  if (parts.length !== 2) return null
  const [scheme, token] = parts
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) return null
  return token
}

export async function hashApiKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function assertSingleWorkspaceScopes(scopes: string[]): { workspaceSlug: string } {
  if (scopes.length === 0) throw new Error('At least one scope is required')

  let workspaceSlug: string | null = null
  for (const scope of scopes) {
    const parsed = parseScope(scope)
    if (parsed === null) throw new Error(`Invalid scope: ${scope}`)
    workspaceSlug ??= parsed.workspaceSlug
    if (parsed.workspaceSlug !== workspaceSlug) {
      throw new Error('API key scopes must reference exactly one workspace')
    }
  }

  if (workspaceSlug === null) throw new Error('At least one scope is required')
  return { workspaceSlug }
}

function tokenCredential(token: string): { token: string } | null {
  if (!token.startsWith(DUET_API_KEY_PREFIX) || token.length === DUET_API_KEY_PREFIX.length)
    return null
  return { token }
}
