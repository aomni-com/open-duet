import {
  OAuthAuthorizationRequestSchema,
  OAuthAuthorizationStateSchema,
  type DynamicClientRegistrationRequest,
  type OAuthAuthorizationRequest,
} from '@repo/contract'

import { fnQuery, type ApiRouteRuntime } from '../shared'

export interface NormalizedOAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none'
  source: 'dcr'
}

export class OAuthClientResolutionError extends Error {}

export type ResolvedOAuthAuthorization =
  | {
      ok: true
      client: NormalizedOAuthClient
      request: OAuthAuthorizationRequest
    }
  | {
      ok: false
      error:
        | 'invalid_request'
        | 'unauthorized_client'
        | 'unsupported_response_type'
        | 'invalid_scope'
      state?: string
      redirectUri?: string
    }

export function normalizeDcrClient(
  clientId: string,
  metadata: DynamicClientRegistrationRequest,
): NormalizedOAuthClient {
  return normalizeClient(clientId, metadata, 'dcr')
}

// Slice 09 calls this seam once, then persists its returned fields directly in
// oauthAuthorizationRequests. Consent and later lifecycle paths consume that
// request snapshot and must never call this resolver again. Dynamic client
// registration is the only path that mints a client this server knows, so a
// client_id absent from the store has no resolvable metadata.
export async function resolveOAuthClientForAuthorizationSnapshot(
  clientId: string,
  runtime: ApiRouteRuntime,
): Promise<NormalizedOAuthClient> {
  const cached = await runtime.convex.query(fnQuery('domains/oauth/api:getCachedClient'), {
    internalKey: runtime.internalKey,
    clientId,
    now: runtime.now(),
  })
  if (cached === null) {
    throw new OAuthClientResolutionError('OAuth client metadata could not be resolved')
  }
  return parseNormalizedClient(cached)
}

export async function resolveOAuthAuthorization(
  raw: Record<string, string>,
  runtime: ApiRouteRuntime,
  resource: string,
): Promise<ResolvedOAuthAuthorization> {
  const clientId = raw.client_id
  if (clientId === undefined || clientId.length === 0) {
    return { ok: false, error: 'invalid_request' }
  }

  let client: NormalizedOAuthClient
  try {
    client = await resolveOAuthClientForAuthorizationSnapshot(clientId, runtime)
  } catch (error) {
    if (!(error instanceof OAuthClientResolutionError)) throw error
    return { ok: false, error: 'unauthorized_client' }
  }

  const redirectUri = raw.redirect_uri
  if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, error: 'invalid_request' }
  }
  const parsedState = OAuthAuthorizationStateSchema.safeParse(raw.state)
  const state = parsedState.success ? parsedState.data : undefined
  const parsed = OAuthAuthorizationRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issueRoots = new Set(parsed.error.issues.map(issue => issue.path[0]))
    const error = issueRoots.has('response_type')
      ? 'unsupported_response_type'
      : issueRoots.has('scope')
        ? 'invalid_scope'
        : 'invalid_request'
    return { ok: false, error, redirectUri, ...(state === undefined ? {} : { state }) }
  }
  if (parsed.data.resource !== resource) {
    return {
      ok: false,
      error: 'invalid_request',
      redirectUri,
      ...(state === undefined ? {} : { state }),
    }
  }
  return { ok: true, client, request: parsed.data }
}

function normalizeClient(
  clientId: string,
  metadata: DynamicClientRegistrationRequest,
  source: 'dcr',
): NormalizedOAuthClient {
  return {
    clientId,
    clientName: metadata.client_name,
    redirectUris: [...metadata.redirect_uris],
    tokenEndpointAuthMethod: 'none',
    source,
  }
}

function parseNormalizedClient(value: unknown): NormalizedOAuthClient {
  if (!isRecord(value)) throw new Error('Stored OAuth client is invalid')
  const redirectUris = value.redirectUris
  if (
    typeof value.clientId !== 'string' ||
    value.clientId.length === 0 ||
    typeof value.clientName !== 'string' ||
    value.clientName.length === 0 ||
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.some(uri => typeof uri !== 'string') ||
    value.tokenEndpointAuthMethod !== 'none' ||
    value.source !== 'dcr'
  ) {
    throw new Error('Stored OAuth client is invalid')
  }
  return {
    clientId: value.clientId,
    clientName: value.clientName,
    redirectUris: [...(redirectUris as string[])],
    tokenEndpointAuthMethod: 'none',
    source: 'dcr',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
