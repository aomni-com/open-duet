import { makeFunctionReference, type FunctionReference } from 'convex/server'

import { normalizeGeneratedSessionTitle } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireSessionPointFromDb } from './access'
import { patchSessionAndReconcileDiscovery } from './discovery'
import type { SessionRequestIdentity } from './identity'
import { projectSessionSummary } from './projection'
import { unreadForSession } from './queries'
import { sessionSearchCorpus } from './search'

export const SESSION_TITLE_MODEL = 'openai/gpt-6-luna'
export const SESSION_TITLE_TIMEOUT_MS = 8_000

/** The title model summarizes words; a prompt without any gives it nothing to read. */
export function titleCanBeGenerated(prompt: string): boolean {
  return prompt.trim().length > 0
}

export async function renameSessionImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: string
    actorId: Id<'users'>
    identity: SessionRequestIdentity
    title: string
    now?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  const { session, access } = await requireSessionPointFromDb(ctx, args)
  const title = args.title.trim()
  if (title.length === 0 || title.length > 120) throw new Error('Invalid title')
  const now = args.now ?? Date.now()
  await patchSessionAndReconcileDiscovery(ctx, session, {
    title,
    titleOrigin: 'manual',
    titleStatus: 'complete',
    titleAttemptId: undefined,
    searchText: sessionSearchCorpus(title, session.prompt),
    updatedAt: now,
  })
  const patched = {
    ...session,
    title,
    titleOrigin: 'manual' as const,
    titleStatus: 'complete' as const,
    titleAttemptId: undefined,
    searchText: sessionSearchCorpus(title, session.prompt),
    updatedAt: now,
  }
  // Renaming is not reading, so the badge is recomputed rather than cleared.
  return await projectSessionSummary(ctx, patched, {
    access,
    unread: await unreadForSession(
      ctx,
      args.workspaceId,
      args.identity.principal.kind === 'human'
        ? (args.identity.principal.userId as Id<'users'>)
        : undefined,
      patched,
    ),
  })
}

export async function finishTitleAttemptImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    attemptId: string
    title?: string
    now?: number
  },
) {
  const session = await ctx.db.get(args.sessionId)
  if (session === null || session.workspaceId !== args.workspaceId) return { applied: false }
  const patch = resolveTitleAttempt(session, args.attemptId, args.title)
  if (patch === null) return { applied: false }
  await patchSessionAndReconcileDiscovery(ctx, session, patch)
  return { applied: true }
}

export function resolveTitleAttempt(
  session: Pick<Doc<'agentSessions'>, 'archiveState' | 'prompt' | 'titleOrigin' | 'titleAttemptId'>,
  attemptId: string,
  generatedTitle: string | undefined,
): Partial<Doc<'agentSessions'>> | null {
  if (
    session.archiveState === 'deleting' ||
    session.titleOrigin !== 'excerpt' ||
    session.titleAttemptId !== attemptId
  )
    return null
  const title = generatedTitle === undefined ? null : normalizeGeneratedSessionTitle(generatedTitle)
  if (title === null) return { titleStatus: 'failed', titleAttemptId: undefined }
  return {
    title,
    titleOrigin: 'auto',
    titleStatus: 'complete',
    titleAttemptId: undefined,
    searchText: sessionSearchCorpus(title, session.prompt),
  }
}

export async function scheduleTitleAttempt(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    sessionId: Id<'agentSessions'>
    prompt: string
    attemptId: string
  },
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference(
      'domains/agentSessions/titleGeneration:generateSessionTitle',
    ) as unknown as FunctionReference<'action', 'internal'>,
    args,
  )
}
