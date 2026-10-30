import {
  AdminLoginAsRequestSchema,
  AdminLoginAsResponseSchema,
  extractBearerToken,
} from '@repo/contract'

import { constantTimeSecretMatches } from '../secret-auth'
import { fn, readJson, type ApiApp, type ApiRouteRuntime } from '../shared'

const DEFAULT_TTL_SECONDS = 60 * 60
const MAX_TTL_SECONDS = 24 * 60 * 60

export const ADMIN_AUTH_BYPASS_PATHS = ['/v1/admin/login-as'] as const

export function registerAdminRoutes(app: ApiApp, runtime: ApiRouteRuntime): void {
  app.post('/v1/admin/login-as', async c => {
    const token = extractBearerToken(c.req.header('authorization') ?? null)
    if (!constantTimeSecretMatches(token, runtime.programmaticLoginSecret)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const body = AdminLoginAsRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)

    const ttlSeconds = Math.min(
      MAX_TTL_SECONDS,
      Math.floor(body.data.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    )

    try {
      const result = AdminLoginAsResponseSchema.parse(
        await runtime.convex.mutation(fn('domains/apiKeys/api:mintImpersonationKey'), {
          internalKey: runtime.internalKey,
          email: body.data.email,
          ...(body.data.workspaceSlug === undefined
            ? {}
            : { workspaceSlug: body.data.workspaceSlug }),
          ...(body.data.create === undefined ? {} : { createIfMissing: body.data.create }),
          ...(body.data.name === undefined ? {} : { name: body.data.name }),
          ...(body.data.ephemeral === undefined ? {} : { ephemeral: body.data.ephemeral }),
          ttlSeconds,
          now: runtime.now(),
        }),
      )
      c.header(
        'set-cookie',
        `duet_session=${result.token}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Lax`,
      )
      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found|no workspace|not a member/i.test(message)) {
        return c.json({ error: 'not_found' }, 404)
      }
      // Disposability cannot be bolted onto an identity a previous caller
      // created as real — the conflict is the caller's to resolve, not a 500.
      if (/existing user ephemeral/i.test(message)) {
        return c.json({ error: 'ephemeral_conflict' }, 409)
      }
      if (/expiry is in the past/i.test(message)) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      return c.json({ error: 'server_error' }, 500)
    }
  })
}
