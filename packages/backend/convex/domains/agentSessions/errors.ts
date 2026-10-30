import { ConvexError } from 'convex/values'

import { isCollectionCursorError, type SessionError } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'

type DbCtx = QueryCtx | MutationCtx
type SessionErrorCode = SessionError['error']

export function throwSessionError(error: SessionErrorCode): never {
  throw new ConvexError({ error } satisfies SessionError)
}

/** Preserve the public cursor code across Convex's process boundary. */
export async function decodeSessionCollectionCursor<T>(
  cursor: string,
  decode: (cursor: string) => Promise<T>,
): Promise<T> {
  try {
    return await decode(cursor)
  } catch (error) {
    if (isCollectionCursorError(error)) throw new ConvexError({ error: 'invalid_cursor' as const })
    throw error
  }
}

export function admitSessionId(ctx: DbCtx, value: string): Id<'agentSessions'> {
  return ctx.db.normalizeId('agentSessions', value) ?? throwSessionError('not_found')
}

export async function requireProjectedSession(
  ctx: DbCtx,
  workspaceId: Id<'workspaces'>,
  value: string,
): Promise<Doc<'agentSessions'>> {
  const session = await ctx.db.get(admitSessionId(ctx, value))
  if (
    session === null ||
    session.workspaceId !== workspaceId ||
    !session.visible ||
    session.archiveState === 'deleting'
  ) {
    throwSessionError('not_found')
  }
  return session
}
