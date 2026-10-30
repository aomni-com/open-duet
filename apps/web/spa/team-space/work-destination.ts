import { ROOT_AGENT_SCOPE, type SessionListItem } from '@repo/contract'

import type { SessionFilters } from '../sessions/session-data'

export type WorkPresentation =
  | { kind: 'home' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'app'; appSlug: string }
  | { kind: 'build' }

export type WorkRouteDestination =
  | { kind: 'home' }
  | { kind: 'session'; agentSlug: string; sessionId: string }
  | { kind: 'app'; agentSlug: string; appSlug: string }
  | { kind: 'build' }

export function workConversationFiltersForAgent(agentId: string) {
  return {
    search: '',
    archived: 'exclude',
    agentId,
    excludeDefault: true,
    topLevel: true,
  } as const satisfies SessionFilters
}

export const workConversationFilters = workConversationFiltersForAgent(ROOT_AGENT_SCOPE)

export function workHomeUrl(workspaceSlug: string, agentSlug: string = ROOT_AGENT_SCOPE): string {
  const path = `/w/${encodeURIComponent(workspaceSlug)}/home`
  return agentSlug === ROOT_AGENT_SCOPE ? path : `${path}?agent=${encodeURIComponent(agentSlug)}`
}

/** The Work address of a conversation; session paths always select Work. */
export function workSessionUrl(
  workspaceSlug: string,
  agentSlug: string,
  sessionId: string,
): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}`
}

export function workPresentationForPath(
  pathname: string,
  workspaceSlug: string,
  search = '',
): WorkPresentation {
  const destination = workRouteDestination(pathname, workspaceSlug, search)
  if (destination.kind === 'session') {
    return { kind: 'session', sessionId: destination.sessionId }
  }
  if (destination.kind === 'app') return { kind: 'app', appSlug: destination.appSlug }
  return destination
}

export function workRouteDestination(
  pathname: string,
  workspaceSlug: string,
  search = '',
): WorkRouteDestination {
  const root = `/w/${encodeURIComponent(workspaceSlug)}`
  if (
    pathname === root ||
    pathname === `${root}/` ||
    pathname === `${root}/home` ||
    pathname === `${root}/home/`
  ) {
    return { kind: 'home' }
  }

  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const workSession = pathname.match(
    new RegExp(`^${escapedRoot}/agents/([^/?#]+)/sessions/([^/?#]+)/?$`),
  )
  const workAgentSlug = safelyDecode(workSession?.[1])
  const workSessionId = safelyDecode(workSession?.[2])
  if (workAgentSlug !== undefined && workSessionId !== undefined) {
    return { kind: 'session', agentSlug: workAgentSlug, sessionId: workSessionId }
  }

  const hint = new URLSearchParams(search)
  const app = pathname.match(new RegExp(`^${escapedRoot}/agents/([^/?#]+)/apps/([^/?#]+)/?$`))
  const appAgentSlug = safelyDecode(app?.[1])
  const appSlug = safelyDecode(app?.[2])
  if (appAgentSlug !== undefined && appSlug !== undefined && hint.get('mode') === 'work') {
    return { kind: 'app', agentSlug: appAgentSlug, appSlug }
  }

  return { kind: 'build' }
}

function safelyDecode(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function isOwnedTopLevelWorkConversation(
  session: Pick<SessionListItem, 'id' | 'agent' | 'createdBySessionId'>,
  expectedAgentId: string | undefined,
  defaultSessionId: string | undefined,
): boolean {
  return (
    session.createdBySessionId === undefined &&
    session.agent?.id === expectedAgentId &&
    session.id !== defaultSessionId
  )
}
