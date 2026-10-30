import { ConvexError } from 'convex/values'

import { SessionErrorSchema, type SessionError } from '@repo/contract'

import type { ApiContext } from './shared'

type SessionErrorResponse = {
  body: SessionError
  status: 400 | 403 | 404 | 409 | 503
}

export function mapSessionError(error: unknown): SessionErrorResponse {
  if (!(error instanceof ConvexError)) throw error
  const parsed = SessionErrorSchema.safeParse(error.data)
  if (!parsed.success) throw error

  switch (parsed.data.error) {
    case 'not_found':
    case 'no_default_session':
      return { body: parsed.data, status: 404 }
    case 'audience_kind_immutable':
    case 'idempotency_conflict':
      return { body: parsed.data, status: 409 }
    case 'invalid_audience_member':
    case 'invalid_audience_delta':
    case 'invalid_request':
      return { body: parsed.data, status: 400 }
    case 'forbidden':
      return { body: parsed.data, status: 403 }
    default: {
      const exhaustive: never = parsed.data
      return exhaustive
    }
  }
}

export function sessionErrorResponse(c: ApiContext, error: unknown): Response {
  const mapped = mapSessionError(error)
  return c.json(mapped.body, mapped.status)
}
