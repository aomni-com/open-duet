import {
  EmailSignInStartRequestSchema,
  EmailSignInStartResponseSchema,
  EmailSignInVerifyRequestSchema,
  EmailSignInVerifyResponseSchema,
  SIGN_IN_CODE_TTL_SECONDS,
  type SignInVerifyOutcome,
} from '@repo/contract'

import { fnAction, readJson, type ApiApp, type ApiRouteRuntime } from '../shared'
import {
  consumePreAuthRateLimit,
  emailIdentity,
  networkIdentity,
  requestIdentity,
} from './pre-auth-rate-limit'

// Two buckets, because neither one alone is a limit. The network bucket is the
// cheap one to evade and, on a deployment that does not trust proxy headers,
// collapses to a single shared `net:global` — so it bounds nothing in
// particular. The email bucket is the one that stops an address being bombed
// from many networks, and it is charged on every well-formed request whatever
// the network bucket decided.
const START_NETWORK_RATE_LIMIT = 20
const START_EMAIL_RATE_LIMIT = 3
const START_EMAIL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

// Keyed on the request id, not the address: an email bucket here would let
// anyone lock a victim out of their own sign-in. The real brute-force floor is
// the request record's five-guess budget; this only stops a caller hammering
// one request faster than a human could be typing.
const VERIFY_RATE_LIMIT = 10
const VERIFY_NETWORK_RATE_LIMIT = 60

export const AUTH_AUTH_BYPASS_PATHS = ['/v1/auth/email/start', '/v1/auth/email/verify'] as const

/**
 * The agent sign-in rail's HTTP shape, and nothing else: parse, rate-limit,
 * call, map. Every auth decision belongs to `domains/authRequests`.
 */
export function registerAuthRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  options: { trustProxyHeaders: boolean },
): void {
  /**
   * ⚠️ The 202 is an enumeration firewall: this endpoint is unauthenticated, so
   * any difference between a known and an unknown address — body, status, or
   * latency — hands an anonymous caller an account oracle. Hence: the id is
   * minted unconditionally by the action, `expires_in` is the constant rather
   * than anything derived from a stored row, no user is looked up here, and
   * both buckets are consumed in the same order whoever the address belongs to.
   */
  app.post('/v1/auth/email/start', async c => {
    const limitedByNetwork = await consumePreAuthRateLimit(runtime, {
      endpoint: 'auth_email_start',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: START_NETWORK_RATE_LIMIT,
    })
    if (limitedByNetwork !== null) return limitedByNetwork
    // Parsed between the two buckets because the email bucket needs a canonical
    // address to key on, and a body that carries none has nothing to charge.
    const body = EmailSignInStartRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const limitedByEmail = await consumePreAuthRateLimit(runtime, {
      endpoint: 'auth_email_start',
      identity: emailIdentity(body.data.email),
      limit: START_EMAIL_RATE_LIMIT,
      windowMs: START_EMAIL_RATE_LIMIT_WINDOW_MS,
    })
    if (limitedByEmail !== null) return limitedByEmail
    const started = (await runtime.convex.action(fnAction('domains/authRequests/actions:start'), {
      internalKey: runtime.internalKey,
      email: body.data.email,
      ...(body.data.client_name === undefined ? {} : { clientName: body.data.client_name }),
      now: runtime.now(),
    })) as { requestId: string }
    return c.json(
      EmailSignInStartResponseSchema.parse({
        request_id: started.requestId,
        expires_in: SIGN_IN_CODE_TTL_SECONDS,
      }),
      202,
    )
  })

  /**
   * The other half. Unlike `start`, this one may say plenty about the account —
   * by the time it answers, the caller has proven possession of a code that was
   * mailed to the address, so there is no oracle left to protect.
   */
  app.post('/v1/auth/email/verify', async c => {
    // The network floor every other pre-auth endpoint carries. Without it the
    // only bucket is keyed on a caller-supplied `request_id`, so varying that
    // one field buys unbounded unauthenticated calls, each reaching Convex for
    // a query and a membership scan.
    const limitedByNetwork = await consumePreAuthRateLimit(runtime, {
      endpoint: 'auth_email_verify',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: VERIFY_NETWORK_RATE_LIMIT,
    })
    if (limitedByNetwork !== null) return limitedByNetwork
    const body = EmailSignInVerifyRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'auth_email_verify',
      identity: requestIdentity(body.data.request_id),
      limit: VERIFY_RATE_LIMIT,
    })
    if (limited !== null) return limited

    const outcome = (await runtime.convex.action(fnAction('domains/authRequests/actions:verify'), {
      internalKey: runtime.internalKey,
      requestId: body.data.request_id,
      code: body.data.code,
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.workspace_name === undefined
        ? {}
        : { workspaceName: body.data.workspace_name }),
      ...(body.data.workspace_slug === undefined
        ? {}
        : { workspaceSlug: body.data.workspace_slug }),
      now: runtime.now(),
    })) as SignInVerifyOutcome

    switch (outcome.kind) {
      case 'issued':
        return c.json(
          EmailSignInVerifyResponseSchema.parse({
            access_token: outcome.accessToken,
            token_type: 'bearer',
            prefix: outcome.prefix,
            scopes: outcome.scopes,
            workspace: outcome.workspace,
            created: outcome.created,
          }),
        )
      case 'invalid_code':
        return c.json({ error: 'invalid_code', attempts_remaining: outcome.attemptsRemaining }, 400)
      case 'forbidden':
        return c.json({ error: 'forbidden' }, 403)
      // 409 rather than 400: nothing the caller sent is wrong, and the code
      // they hold is still good. They answer by naming a workspace and calling
      // again with the same code.
      case 'ambiguous':
        return c.json({ error: 'workspace_ambiguous', workspaces: outcome.workspaces }, 409)
      case 'expired':
        return c.json({ error: 'expired' }, 410)
    }
  })
}
