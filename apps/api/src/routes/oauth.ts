import {
  AuthorizationServerMetadataSchema,
  CAPABILITIES,
  DynamicClientRegistrationErrorResponseSchema,
  DynamicClientRegistrationRequestSchema,
  DynamicClientRegistrationResponseSchema,
  OAuthAuthorizationErrorResponseSchema,
  OAuthConsentApproveRequestSchema,
  OAuthConsentApproveResponseSchema,
  OAuthConsentDenyRequestSchema,
  OAuthConsentDenyResponseSchema,
  OAuthConsentInspectResponseSchema,
  OAuthTokenErrorResponseSchema,
  OAuthTokenRequestSchema,
  OAuthTokenResponseSchema,
} from '@repo/contract'

import { normalizeDcrClient, resolveOAuthAuthorization } from '../oauth/client-metadata'
import {
  fn,
  fnQuery,
  readJson,
  requireHumanActor,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'
import { consumePreAuthRateLimit, networkIdentity } from './pre-auth-rate-limit'

const OAUTH_METADATA_RATE_LIMIT = 120
const OAUTH_REGISTRATION_RATE_LIMIT = 20
const OAUTH_AUTHORIZE_RATE_LIMIT = 60
const OAUTH_TOKEN_RATE_LIMIT = 60

export const OAUTH_AUTH_BYPASS_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
] as const

export interface RegisterOAuthRoutesOptions {
  trustProxyHeaders: boolean
  apiUrl: string
  mcpPublicUrl: string
}

export function registerOAuthRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  options: RegisterOAuthRoutesOptions,
): void {
  app.get('/.well-known/oauth-authorization-server', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'oauth_metadata',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: OAUTH_METADATA_RATE_LIMIT,
    })
    if (limited !== null) return limited
    const issuer = options.apiUrl
    return c.json(
      AuthorizationServerMetadataSchema.parse({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        scopes_supported: CAPABILITIES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        protected_resources: [options.mcpPublicUrl],
      }),
    )
  })

  app.get('/oauth/authorize', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'oauth_authorize',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: OAUTH_AUTHORIZE_RATE_LIMIT,
    })
    if (limited !== null) return limited

    const raw = Object.fromEntries(new URL(c.req.url).searchParams)
    const resolved = await resolveOAuthAuthorization(raw, runtime, options.mcpPublicUrl)
    if (!resolved.ok) {
      const error = OAuthAuthorizationErrorResponseSchema.parse({
        error: resolved.error,
        ...(resolved.state === undefined ? {} : { state: resolved.state }),
      })
      if (resolved.redirectUri === undefined) return c.json(error, 400)
      const redirect = new URL(resolved.redirectUri)
      redirect.searchParams.set('error', error.error)
      if (error.state !== undefined) redirect.searchParams.set('state', error.state)
      return c.redirect(redirect.toString())
    }

    const now = runtime.now()
    const requestId = await runtime.convex.mutation(
      fn('domains/oauth/api:createAuthorizationRequest'),
      {
        internalKey: runtime.internalKey,
        clientId: resolved.client.clientId,
        clientName: resolved.client.clientName,
        redirectUri: resolved.request.redirect_uri,
        ...(resolved.request.state === undefined ? {} : { state: resolved.request.state }),
        capabilities: resolved.request.scope.split(' '),
        resource: resolved.request.resource,
        codeChallenge: resolved.request.code_challenge,
        now,
      },
    )
    const handoff = new URL('/oauth/authorize', runtime.appUrl)
    handoff.searchParams.set('request', String(requestId))
    return c.redirect(handoff.toString())
  })

  app.post('/oauth/token', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'oauth_token',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: OAUTH_TOKEN_RATE_LIMIT,
    })
    if (limited !== null) return limited

    const raw = await readForm(c.req.raw)
    if (raw === null) return tokenError(c, 'invalid_request')
    const parsed = OAuthTokenRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return tokenError(
        c,
        raw.grant_type !== 'authorization_code' && raw.grant_type !== 'refresh_token'
          ? 'unsupported_grant_type'
          : 'invalid_request',
      )
    }

    let result: unknown
    if (parsed.data.grant_type === 'authorization_code') {
      try {
        result = await runtime.convex.mutation(fn('domains/oauth/api:exchangeAuthorizationCode'), {
          internalKey: runtime.internalKey,
          code: parsed.data.code,
          clientId: parsed.data.client_id,
          redirectUri: parsed.data.redirect_uri,
          resource: parsed.data.resource,
          codeVerifier: parsed.data.code_verifier,
          now: runtime.now(),
        })
      } catch (error) {
        if (/Invalid authorization code/.test(errorMessage(error))) {
          return tokenError(c, 'invalid_grant')
        }
        throw error
      }
    } else {
      result = await runtime.convex.mutation(fn('domains/oauth/api:rotateRefreshToken'), {
        internalKey: runtime.internalKey,
        refreshToken: parsed.data.refresh_token,
        clientId: parsed.data.client_id,
        resource: parsed.data.resource,
        now: runtime.now(),
      })
    }
    if (isInvalidGrant(result)) return tokenError(c, 'invalid_grant')
    return c.json(OAuthTokenResponseSchema.parse(result), 200, {
      'cache-control': 'no-store',
      pragma: 'no-cache',
    })
  })

  app.get('/v1/oauth/authorization/:requestId', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    try {
      const result = await runtime.convex.query(fnQuery('domains/oauth/api:inspectAuthorization'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        requestId: c.req.param('requestId'),
        now: runtime.now(),
      })
      return c.json(OAuthConsentInspectResponseSchema.parse(result))
    } catch (error) {
      if (
        /Authorization request not found|ArgumentValidationError|Invalid value/.test(
          errorMessage(error),
        )
      ) {
        return c.json({ error: 'not_found' }, 404)
      }
      throw error
    }
  })

  app.post('/v1/oauth/authorization/:requestId/approve', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = OAuthConsentApproveRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.mutation(fn('domains/oauth/api:approveAuthorization'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        requestId: c.req.param('requestId'),
        workspaceSlug: body.data.workspaceSlug,
        now: runtime.now(),
      })
      return c.json(OAuthConsentApproveResponseSchema.parse(result))
    } catch (error) {
      return authorizationActionError(c, error)
    }
  })

  app.post('/v1/oauth/authorization/:requestId/deny', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = OAuthConsentDenyRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await runtime.convex.mutation(fn('domains/oauth/api:denyAuthorization'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        requestId: c.req.param('requestId'),
        now: runtime.now(),
      })
      return c.json(OAuthConsentDenyResponseSchema.parse(result))
    } catch (error) {
      return authorizationActionError(c, error)
    }
  })

  app.post('/oauth/register', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'oauth_register',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: OAUTH_REGISTRATION_RATE_LIMIT,
    })
    if (limited !== null) return limited

    const raw = await readJson(c.req.raw)
    if (
      isRecord(raw) &&
      (raw.token_endpoint_auth_method !== 'none' ||
        'client_secret' in raw ||
        'client_secret_expires_at' in raw)
    ) {
      return c.json(
        DynamicClientRegistrationErrorResponseSchema.parse({
          error: 'invalid_client_metadata',
          error_description:
            'Only public clients with token_endpoint_auth_method none are supported',
        }),
        400,
      )
    }
    const parsed = DynamicClientRegistrationRequestSchema.safeParse(raw)
    if (!parsed.success) {
      const invalidRedirect = parsed.error.issues.some(issue => issue.path[0] === 'redirect_uris')
      return c.json(
        DynamicClientRegistrationErrorResponseSchema.parse({
          error: invalidRedirect ? 'invalid_redirect_uri' : 'invalid_client_metadata',
          error_description: invalidRedirect
            ? 'Every redirect URI must be an exact absolute URI'
            : 'Client metadata does not match the supported public-client profile',
        }),
        400,
      )
    }

    const now = runtime.now()
    const clientId = `duet_client_${crypto.randomUUID().replaceAll('-', '')}`
    const normalized = normalizeDcrClient(clientId, parsed.data)
    await runtime.convex.mutation(fn('domains/oauth/api:registerDynamicClient'), {
      internalKey: runtime.internalKey,
      ...normalized,
      now,
    })
    return c.json(
      DynamicClientRegistrationResponseSchema.parse({
        ...parsed.data,
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
      }),
      201,
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readForm(request: Request): Promise<Record<string, string> | null> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
    return null
  }
  try {
    return Object.fromEntries(new URLSearchParams(await request.text()))
  } catch {
    return null
  }
}

function isInvalidGrant(value: unknown): boolean {
  return isRecord(value) && value.ok === false && value.reason === 'invalid_grant'
}

function tokenError(
  c: ApiContext,
  error: 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type',
) {
  return c.json(OAuthTokenErrorResponseSchema.parse({ error }), 400, {
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
}

function authorizationActionError(c: ApiContext, error: unknown): Response {
  const message = errorMessage(error)
  if (/not found/i.test(message)) return c.json({ error: 'not_found' }, 404)
  if (/not eligible/i.test(message)) return c.json({ error: 'forbidden' }, 403)
  if (/expired/i.test(message)) return c.json({ error: 'authorization_request_expired' }, 410)
  if (/not pending/i.test(message))
    return c.json({ error: 'authorization_request_not_pending' }, 409)
  throw error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
