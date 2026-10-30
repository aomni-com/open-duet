import { getDocumentSize } from 'convex/values'

import {
  ModelSelectionIdSchema,
  projectSessionActivityMachine,
  type SessionListItem,
  type SessionSummary,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import {
  sessionAccessAllows,
  sessionAgentStateOf,
  type SessionAccessTarget,
  type SessionPointAccess,
} from './access'
import { sessionAgentIdentity } from './agentSessionsShared'
import { projectCurrentSpecificAudience, type AudienceDirectorySupport } from './audience'
import { addSessionListReadCost, type SessionListReadCost } from './pageBudget'

type DbCtx = QueryCtx | MutationCtx
type AdmittedSessionAccess = Extract<SessionPointAccess, { ok: true }>

export interface SessionProjectionContext {
  access: AdmittedSessionAccess
  unread: boolean
}

export interface SessionProjectionSupport {
  audience: SessionSummary['audience']
  personalArchivedAt: number | null
  mutableAudience: boolean
  callerState: Doc<'agentSessionMemberStates'> | null
  agentState: SessionAccessTarget['agentState']
  readCost: SessionListReadCost
}

export async function projectSessionSummary(
  ctx: DbCtx,
  session: Doc<'agentSessions'>,
  context: SessionProjectionContext,
  audienceSupport?: AudienceDirectorySupport,
): Promise<SessionSummary> {
  return projectSessionSummaryFromSupport(
    session,
    context,
    await loadSessionProjectionSupport(
      ctx,
      session,
      context.access.basis === 'workspace'
        ? undefined
        : (context.access.membership.membershipId as Id<'workspaceMembers'>),
      audienceSupport,
    ),
  )
}

export async function loadSessionProjectionSupport(
  ctx: DbCtx,
  session: Doc<'agentSessions'>,
  membershipId?: Id<'workspaceMembers'>,
  audienceSupport?: AudienceDirectorySupport,
): Promise<SessionProjectionSupport> {
  let readCost: SessionListReadCost = { ranges: 0, documents: 0, bytes: 0 }
  let callerState: Doc<'agentSessionMemberStates'> | null = null
  let audience: SessionSummary['audience']
  if (session.audienceKind === 'workspace') {
    audience = { kind: 'workspace' }
    callerState =
      membershipId === undefined ? null : await sessionMemberState(ctx, session._id, membershipId)
    if (membershipId !== undefined) {
      readCost = addSessionListReadCost(readCost, {
        ranges: 1,
        documents: callerState === null ? 0 : 1,
        bytes: callerState === null ? 0 : getDocumentSize(callerState),
      })
    }
  } else {
    const projected = await projectCurrentSpecificAudience(
      ctx,
      session,
      membershipId,
      audienceSupport,
    )
    audience = projected.audience
    callerState = projected.callerState
    readCost = addSessionListReadCost(readCost, projected.readCost)
  }
  let ownerDefaultSessionId: Id<'agentSessions'> | undefined
  let agent: Doc<'agents'> | null = null
  if (session.agentId === undefined) {
    const workspace = await ctx.db.get(session.workspaceId)
    readCost = addSessionListReadCost(readCost, {
      ranges: 1,
      documents: workspace === null ? 0 : 1,
      bytes: workspace === null ? 0 : getDocumentSize(workspace),
    })
    ownerDefaultSessionId = workspace?.rootDefaultSessionId
  } else {
    agent = await ctx.db.get(session.agentId)
    readCost = addSessionListReadCost(readCost, {
      ranges: 1,
      documents: agent === null ? 0 : 1,
      bytes: agent === null ? 0 : getDocumentSize(agent),
    })
    ownerDefaultSessionId = agent?.defaultSessionId
  }
  return {
    audience,
    personalArchivedAt: callerState?.personalArchivedAt ?? null,
    mutableAudience:
      session.audienceKind === 'specific' &&
      session.onboarding !== true &&
      ownerDefaultSessionId !== session._id,
    callerState,
    agentState: sessionAgentStateOf(session, agent),
    readCost,
  }
}

export function projectSessionSummaryFromSupport(
  session: Doc<'agentSessions'>,
  context: SessionProjectionContext,
  support: SessionProjectionSupport,
): SessionSummary {
  return {
    ...projectSessionRow(session, context.unread),
    ...projectSessionSupportFields(session, context, support),
  }
}

export function projectSessionListItemFromSupport(
  session: Doc<'agentSessions'>,
  context: SessionProjectionContext,
  support: SessionProjectionSupport,
): SessionListItem {
  const machine = projectSessionActivityMachine(session.machine)
  return {
    ...projectSessionRowWithoutMachine(session, context.unread),
    ...(machine === undefined ? {} : { machine }),
    ...projectSessionSupportFields(session, context, support),
  }
}

function projectSessionSupportFields(
  session: Doc<'agentSessions'>,
  context: SessionProjectionContext,
  support: SessionProjectionSupport,
): Pick<SessionSummary, 'audience' | 'archive' | 'permissions'> {
  const globalArchivedAt = globalArchiveTimestamp(session)
  const participates = sessionAccessAllows(context.access, 'participate')
  const managesGlobalLifecycle = sessionAccessAllows(context.access, 'global-lifecycle')
  return {
    audience: support.audience,
    archive: {
      globalArchivedAt,
      personalArchivedAt: support.personalArchivedAt,
      reason:
        globalArchivedAt !== null
          ? 'global'
          : support.personalArchivedAt !== null
            ? 'personal'
            : null,
    },
    permissions: {
      send: participates,
      answer: participates,
      interrupt: participates,
      rename: participates,
      manageAudience: participates && support.mutableAudience,
      personalArchive: context.access.basis !== 'workspace',
      globalArchive: managesGlobalLifecycle,
      delete: managesGlobalLifecycle,
    },
  }
}

export async function projectSessionSnapshot(
  ctx: DbCtx,
  session: Doc<'agentSessions'>,
  context: SessionProjectionContext,
) {
  const summary = await projectSessionSummary(ctx, session, context)
  const tier = ModelSelectionIdSchema.safeParse(session.lastModelId)
  return {
    ...summary,
    workspaceId: session.workspaceId,
    ...(tier.success ? { tier: tier.data } : {}),
    lastDeliveredInputSeq: session.lastDeliveredInputSeq,
    ...(session.deliveryAttempt === undefined ? {} : { deliveryAttempt: session.deliveryAttempt }),
    ...(session.todos === undefined ? {} : { todos: session.todos }),
    ...(session.followUpQueue === undefined ? {} : { followUpQueue: session.followUpQueue }),
    ...(session.requestedMachine === undefined
      ? {}
      : { requestedMachine: session.requestedMachine }),
    ...(session.machineState === undefined ? {} : { machineState: session.machineState }),
  }
}

function projectSessionRow(session: Doc<'agentSessions'>, unread: boolean) {
  return {
    ...projectSessionRowWithoutMachine(session, unread),
    ...(session.machine === undefined ? {} : { machine: session.machine }),
  }
}

function projectSessionRowWithoutMachine(session: Doc<'agentSessions'>, unread: boolean) {
  return {
    id: session._id,
    turnStatus: session.turnStatus,
    bucket: session.bucket,
    title: session.title,
    titleOrigin: session.titleOrigin,
    titleStatus: session.titleStatus,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.onboarding === undefined ? {} : { onboarding: session.onboarding }),
    ...(session.createdBySessionId === undefined
      ? {}
      : { createdBySessionId: session.createdBySessionId }),
    ...sessionAgentIdentity(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastEventSeq: session.lastEventSeq,
    unread,
  }
}

async function sessionMemberState(
  ctx: DbCtx,
  sessionId: Id<'agentSessions'>,
  membershipId: Id<'workspaceMembers'>,
) {
  return await ctx.db
    .query('agentSessionMemberStates')
    .withIndex('by_session_membership', q =>
      q.eq('sessionId', sessionId).eq('membershipId', membershipId),
    )
    .unique()
}

function globalArchiveTimestamp(session: Doc<'agentSessions'>): number | null {
  if (session.archiveState !== 'archived') return null
  if (session.archivedAt === undefined) throw new Error('Archived session timestamp is missing')
  return session.archivedAt
}
