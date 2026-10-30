import { signValue, verifyValue } from './signing'

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * The MCP OAuth profile rides inside the same signed grant as the device flow.
 * Its presence is what makes a token an OAuth 2.1 token rather than a
 * connected-provider device credential, and the two shapes differ on the wire.
 */
export interface OAuthGrantDetails {
  redirectUri: string
  scope?: string
  resource?: string
  codeChallenge?: string
}

export interface GrantPayload {
  kind: 'device' | 'access' | 'refresh' | 'code'
  flowId: string
  createdAt: number
  clientId: string
  plan: 'eligible' | 'ineligible'
  quotaAfterMs?: number
  refreshes?: number
  oauth?: OAuthGrantDetails
  /**
   * Set at every mint. Without it two tokens issued in the same millisecond
   * from the same grant are byte-identical, which no real issuer does and
   * which would quietly hide a client that reuses a stale credential.
   */
  nonce?: string
}

export async function encodeGrant(payload: GrantPayload): Promise<string> {
  return await signValue(`fake-oauth-${payload.kind}-`, payload)
}

export async function decodeGrant(
  value: string | undefined,
  kind: GrantPayload['kind'],
): Promise<GrantPayload | undefined> {
  const payload = await verifyValue(`fake-oauth-${kind}-`, value)
  return validGrantPayload(payload, kind) ? payload : undefined
}

function validGrantPayload(value: unknown, kind: GrantPayload['kind']): value is GrantPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    payload.kind === kind &&
    typeof payload.flowId === 'string' &&
    typeof payload.createdAt === 'number' &&
    Number.isFinite(payload.createdAt) &&
    typeof payload.clientId === 'string' &&
    (payload.plan === 'eligible' || payload.plan === 'ineligible') &&
    (payload.quotaAfterMs === undefined ||
      (typeof payload.quotaAfterMs === 'number' && payload.quotaAfterMs >= 0)) &&
    (payload.refreshes === undefined ||
      (typeof payload.refreshes === 'number' &&
        Number.isInteger(payload.refreshes) &&
        payload.refreshes >= 0)) &&
    (payload.oauth === undefined || validOAuthDetails(payload.oauth)) &&
    (payload.nonce === undefined || typeof payload.nonce === 'string')
  )
}

function validOAuthDetails(value: unknown): value is OAuthGrantDetails {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const details = value as Record<string, unknown>
  return (
    typeof details.redirectUri === 'string' &&
    ['scope', 'resource', 'codeChallenge'].every(
      field => details[field] === undefined || typeof details[field] === 'string',
    )
  )
}
