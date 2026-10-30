import { decodeGrant, DEVICE_GRANT_TYPE, encodeGrant, type GrantPayload } from './grants'
import {
  FAKE_MCP_OVERSIZED_BYTES,
  FAKE_MCP_OVERSIZED_TOOL,
  FAKE_MCP_SERVER_NAME,
  handleMcp,
  mcpChallenge,
} from './mcp'
import { FAKE_OAUTH_ISSUER_MOUNT_PATH, resolveMount } from './mount'
import {
  authorizationServerMetadata,
  authorize,
  deleteRegistration,
  exchangeAuthorizationCode,
  jwks,
  MCP_SCOPES,
  oauthTokenResponse,
  protectedResourceMetadata,
  registerClient,
  revoke,
  type IssuerConfig,
} from './oauth'

export type FakeOAuthIssuerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface FakeOAuthIssuerRequest {
  method: string
  path: string
  body: unknown
}

export interface FakeOAuthIssuer {
  fetch: FakeOAuthIssuerFetch
  requests: FakeOAuthIssuerRequest[]
}

export interface FakeOAuthIssuerOptions {
  approvalDelayMs?: number
  plan?: 'eligible' | 'ineligible'
  quotaAfterMs?: number
  now?: () => number
  /**
   * Turns on Client ID Metadata Documents by supplying the seam that reads
   * one. Off by default: with CIMD advertised a client never registers, and
   * the RFC 7591/7592 path would go unexercised.
   */
  clientMetadataFetch?: (url: string) => Promise<Response>
}

export {
  FAKE_MCP_OVERSIZED_BYTES,
  FAKE_MCP_OVERSIZED_TOOL,
  FAKE_MCP_SERVER_NAME,
  FAKE_OAUTH_ISSUER_MOUNT_PATH,
  MCP_SCOPES,
}

const DEVICE_EXPIRES_IN_SECONDS = 600
const TOKEN_EXPIRES_IN_SECONDS = 3_600
const DEFAULT_APPROVAL_DELAY_MS = 1_000
export const FAKE_OAUTH_ISSUER_QUOTA_AFTER_MS = 15_000

/**
 * The deliberately narrow fake used by connected-provider tests and by the
 * custom-MCP-server journey. Every grant is authenticated and self-contained so
 * any serverless instance can consume a code or token minted by another
 * instance.
 *
 * Two unrelated wire contracts share the handler: the RFC 8628 device flow with
 * its model-completion seam, and the MCP OAuth 2.1 authorization-code flow in
 * front of a small real MCP server. They share `/token` and nothing else; a
 * token minted by one profile is not the shape the other speaks.
 */
export function createFakeOAuthIssuer(options: FakeOAuthIssuerOptions = {}): FakeOAuthIssuer {
  const approvalDelayMs = Math.max(0, options.approvalDelayMs ?? DEFAULT_APPROVAL_DELAY_MS)
  const plan = options.plan ?? 'eligible'
  const quotaAfterMs = options.quotaAfterMs ?? FAKE_OAUTH_ISSUER_QUOTA_AFTER_MS
  const now = options.now ?? Date.now
  const requests: FakeOAuthIssuerRequest[] = []
  const config: IssuerConfig = {
    plan,
    quotaAfterMs,
    now,
    tokenExpiresInSeconds: TOKEN_EXPIRES_IN_SECONDS,
    ...(options.clientMetadataFetch === undefined
      ? {}
      : { clientMetadataFetch: options.clientMetadataFetch }),
  }

  return {
    requests,
    async fetch(input, init) {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const url = new URL(request.url)
      const { path, baseUrl } = resolveMount(url)
      const payload = await readBody(request)
      const body = isRecord(payload) ? payload : {}
      requests.push({ method: request.method, path: url.pathname, body })

      if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
        return protectedResourceMetadata(baseUrl)
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        return authorizationServerMetadata(baseUrl, config)
      }
      if (request.method === 'GET' && path === '/.well-known/openid-configuration') {
        return authorizationServerMetadata(baseUrl, config)
      }
      if (request.method === 'GET' && path === '/.well-known/jwks.json') {
        return jwks()
      }

      if (request.method === 'POST' && path === '/register') {
        return await registerClient(baseUrl, body, now())
      }
      if (path.startsWith('/register/')) {
        if (request.method !== 'DELETE') {
          return Response.json({ error: 'method_not_allowed' }, { status: 405 })
        }
        return await deleteRegistration(path.slice('/register/'.length), request)
      }
      if (request.method === 'GET' && path === '/authorize') {
        return await authorize(baseUrl, url, config)
      }
      if (request.method === 'POST' && path === '/revoke') {
        return revoke()
      }

      if (request.method === 'POST' && path === '/device/code') {
        if (!validDeviceRequest(body)) return invalidRequest()
        const grant: GrantPayload = {
          kind: 'device',
          flowId: crypto.randomUUID(),
          createdAt: now(),
          clientId: body.client_id,
          plan,
          ...(quotaAfterMs === undefined ? {} : { quotaAfterMs }),
        }
        return Response.json({
          device_code: await encodeGrant(grant),
          user_code: userCode(grant.flowId),
          verification_uri: `${url.origin}/device`,
          interval: 1,
          expires_in: DEVICE_EXPIRES_IN_SECONDS,
        })
      }

      if (request.method === 'POST' && path === '/token') {
        if (body.grant_type === DEVICE_GRANT_TYPE) {
          const grant = await decodeGrant(stringField(body, 'device_code'), 'device')
          if (!grant) return invalidRequest()
          if (grant.createdAt + DEVICE_EXPIRES_IN_SECONDS * 1_000 <= now()) {
            return Response.json({ status: 'expired' })
          }
          if (grant.createdAt + approvalDelayMs > now()) {
            return Response.json({ status: 'pending' })
          }
          return await issueInitialTokens(grant, now())
        }
        if (body.grant_type === 'authorization_code') {
          return await exchangeAuthorizationCode(body, config)
        }
        if (body.grant_type === 'refresh_token') {
          const refresh = await decodeGrant(stringField(body, 'refresh_token'), 'refresh')
          if (!refresh) return invalidRequest()
          const refreshedAt = now()
          const refreshes = (refresh.refreshes ?? 0) + 1
          // Rotation on every other refresh is deliberate: it exercises both
          // "the AS returned a new refresh token" and "it did not". Anything
          // asserting that the token itself changed will flake at 50%.
          const rotateRefresh = refreshes % 2 !== 0
          if (refresh.oauth) {
            return await oauthTokenResponse(
              { ...refresh, kind: 'access', createdAt: refreshedAt },
              { rotateRefresh, refreshes },
              config,
            )
          }
          const accessToken = await encodeGrant({
            ...refresh,
            kind: 'access',
            createdAt: refreshedAt,
            refreshes: undefined,
            nonce: crypto.randomUUID(),
          })
          const response = {
            access_token: accessToken,
            expires_in: TOKEN_EXPIRES_IN_SECONDS,
            account_id: accountId(refresh),
          }
          if (!rotateRefresh) return Response.json(response)
          return Response.json({
            ...response,
            refresh_token: await encodeGrant({
              ...refresh,
              createdAt: refreshedAt,
              refreshes,
              nonce: crypto.randomUUID(),
            }),
          })
        }
        return invalidRequest()
      }

      if (path === '/mcp') {
        const access = await decodeGrant(bearerToken(request.headers), 'access')
        if (!access?.oauth || access.createdAt + TOKEN_EXPIRES_IN_SECONDS * 1_000 <= now()) {
          return mcpChallenge(baseUrl)
        }
        return handleMcp(request, payload, access)
      }

      if (request.method === 'POST' && path === '/chat/completions') {
        const access = await decodeGrant(bearerToken(request.headers), 'access')
        if (!access || access.createdAt + TOKEN_EXPIRES_IN_SECONDS * 1_000 <= now()) {
          return Response.json({ error: { message: 'invalid fake credential' } }, { status: 401 })
        }
        if (access.plan === 'ineligible') {
          return Response.json({ error: { message: 'plan not eligible' } }, { status: 402 })
        }
        if (access.quotaAfterMs !== undefined && access.createdAt + access.quotaAfterMs <= now()) {
          return Response.json({ error: { message: 'usage_limit_reached' } }, { status: 429 })
        }
        return completionResponse(body)
      }

      return Response.json({ error: 'not_found' }, { status: 404 })
    },
  }
}

async function issueInitialTokens(grant: GrantPayload, createdAt: number): Promise<Response> {
  const tokenPayload = { ...grant, createdAt }
  return Response.json({
    access_token: await encodeGrant({
      ...tokenPayload,
      kind: 'access',
      nonce: crypto.randomUUID(),
    }),
    refresh_token: await encodeGrant({
      ...tokenPayload,
      kind: 'refresh',
      refreshes: 0,
      nonce: crypto.randomUUID(),
    }),
    expires_in: TOKEN_EXPIRES_IN_SECONDS,
    account_id: accountId(grant),
  })
}

function accountId(grant: GrantPayload): string {
  return `fake-account-${grant.clientId.replace(/^duet-agent:/, '')}-${grant.flowId.slice(0, 8)}`
}

function userCode(flowId: string): string {
  return flowId
    .replaceAll('-', '')
    .slice(0, 8)
    .toUpperCase()
    .replace(/(.{4})(.{4})/, '$1-$2')
}

function validDeviceRequest(
  body: Record<string, unknown>,
): body is Record<string, unknown> & { client_id: string; scope: string } {
  return (
    typeof body.client_id === 'string' &&
    /^duet-agent:(?:openai-codex|github-copilot)$/.test(body.client_id) &&
    typeof body.scope === 'string' &&
    body.scope.length > 0
  )
}

/**
 * The device flow posts JSON; the MCP OAuth client posts
 * `application/x-www-form-urlencoded` at the same `/token`. Both land here.
 */
async function readBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return {}
  if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
    try {
      return Object.fromEntries(new URLSearchParams(await request.text()))
    } catch {
      return {}
    }
  }
  try {
    return (await request.json()) as unknown
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  return typeof value === 'string' ? value : undefined
}

function bearerToken(headers: Headers): string | undefined {
  return headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
}

function invalidRequest(): Response {
  return Response.json({ error: 'invalid_request' }, { status: 400 })
}

function completionResponse(body: Record<string, unknown>): Response {
  const model = typeof body.model === 'string' ? body.model : 'fake-model'
  const id = 'chatcmpl-fake'
  if (body.stream !== true) {
    return Response.json({
      id,
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { content: 'ok' } }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]
  return new Response(
    `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
