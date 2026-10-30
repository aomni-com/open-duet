import { describe, expect, test } from 'bun:test'

import { ROOT_AGENT_SCOPE, type SessionListItem } from '@repo/contract'

import {
  isOwnedTopLevelWorkConversation,
  workConversationFilters,
  workConversationFiltersForAgent,
  workHomeUrl,
  workPresentationForPath,
  workRouteDestination,
} from './work-destination'

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session_1',
    title: 'Launch planning',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    turnStatus: 'complete',
    bucket: 'done',
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 1,
    unread: false,
    audience: { kind: 'workspace' },
    archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
    permissions: {
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    },
    ...overrides,
  }
}

describe('Team Space destination contract', () => {
  test('session paths open Work without interpreting query parameters', () => {
    for (const search of ['', '?mode=work', '?workParent=wrong-parent']) {
      expect(
        workRouteDestination('/w/acme/agents/research/sessions/child', 'acme', search),
      ).toEqual({
        kind: 'session',
        agentSlug: 'research',
        sessionId: 'child',
      })
    }
  })

  test('makes Home the stable Work landing without changing entity URLs', () => {
    expect(workHomeUrl('acme space')).toBe('/w/acme%20space/home')
    expect(workPresentationForPath('/w/acme/home', 'acme')).toEqual({
      kind: 'home',
    })
    expect(workPresentationForPath('/w/acme/agents/graph', 'acme')).toEqual({
      kind: 'build',
    })
    expect(workPresentationForPath('/w/acme/files', 'acme')).toEqual({
      kind: 'build',
    })
  })

  test('keeps a trailing-slash Home URL in Work', () => {
    expect(workPresentationForPath('/w/acme/home/', 'acme')).toEqual({ kind: 'home' })
  })

  test('parses one Work entity destination and fails closed on malformed encoding', () => {
    expect(
      workRouteDestination(
        '/w/acme/agents/research/sessions/session%201',
        'acme',
        '?workParent=parent%201',
      ),
    ).toEqual({
      kind: 'session',
      agentSlug: 'research',
      sessionId: 'session 1',
    })
    expect(workRouteDestination('/w/acme/agents/root/apps/bad%ZZ', 'acme', '?mode=work')).toEqual({
      kind: 'build',
    })
  })

  test('recognizes Duet sessions and preserves explicit Work context for children and apps', () => {
    expect(
      workPresentationForPath('/w/acme/agents/root/sessions/session_1', 'acme', '?mode=work'),
    ).toEqual({
      kind: 'session',
      sessionId: 'session_1',
    })
    expect(workPresentationForPath('/w/acme/agents/root/sessions/session_1', 'acme')).toEqual({
      kind: 'session',
      sessionId: 'session_1',
    })
    expect(
      workPresentationForPath('/w/acme/agents/root/apps/reports', 'acme', '?mode=work'),
    ).toEqual({
      kind: 'app',
      appSlug: 'reports',
    })
    expect(
      workPresentationForPath('/w/acme/agents/research/apps/briefing', 'acme', '?mode=work'),
    ).toEqual({
      kind: 'app',
      appSlug: 'briefing',
    })
    expect(workPresentationForPath('/w/acme/agents/research/sessions/session_1', 'acme')).toEqual({
      kind: 'session',
      sessionId: 'session_1',
    })
    expect(
      workPresentationForPath(
        '/w/acme/agents/research/sessions/session_1',
        'acme',
        '?workParent=parent_1',
      ),
    ).toEqual({ kind: 'session', sessionId: 'session_1' })
    expect(workPresentationForPath('/w/acme/agents/root/apps/reports', 'acme')).toEqual({
      kind: 'build',
    })
  })

  test('recognizes a top-level agent conversation from its path', () => {
    expect(
      workRouteDestination('/w/acme/agents/research/sessions/session_1', 'acme', '?mode=work'),
    ).toEqual({
      kind: 'session',
      agentSlug: 'research',
      sessionId: 'session_1',
    })
    expect(workRouteDestination('/w/acme/agents/research/sessions/session_1', 'acme')).toEqual({
      kind: 'session',
      agentSlug: 'research',
      sessionId: 'session_1',
    })
  })

  /* No `bucket` key, and that absence is the claim: the rail asks for every
     status a session can be in — waiting on somebody, running, on a clock,
     finished — and narrows only on the three questions that decide whether a
     row belongs to Work at all. Adding a bucket here would hide running work
     from the one column that exists to show it. */
  test('requests unarchived top-level non-default Duet sessions without a status filter', () => {
    expect(workConversationFilters).toEqual({
      search: '',
      archived: 'exclude',
      agentId: ROOT_AGENT_SCOPE,
      excludeDefault: true,
      topLevel: true,
    })
  })

  test('scopes an agent conversation list to top-level non-default sessions', () => {
    expect(workConversationFiltersForAgent('agent_research')).toEqual({
      search: '',
      archived: 'exclude',
      agentId: 'agent_research',
      excludeDefault: true,
      topLevel: true,
    })
  })

  test('validates a top-level Work conversation against its exact owner and default chat', () => {
    const agentSession = session({ agent: { id: 'agent_research', name: 'Research' } })
    expect(isOwnedTopLevelWorkConversation(agentSession, 'agent_research', 'default_1')).toBe(true)
    expect(isOwnedTopLevelWorkConversation(agentSession, 'agent_writer', 'default_1')).toBe(false)
    expect(isOwnedTopLevelWorkConversation(agentSession, 'agent_research', 'session_1')).toBe(false)
    expect(
      isOwnedTopLevelWorkConversation(
        { ...agentSession, createdBySessionId: 'parent_1' },
        'agent_research',
        'default_1',
      ),
    ).toBe(false)
    expect(isOwnedTopLevelWorkConversation(agentSession, undefined, 'default_1')).toBe(false)
  })

  test('admits top-level machine work for an agent', () => {
    const machineSession = session({
      agent: { id: 'agent_research', name: 'Research' },
      machine: {
        activity: 'running',
        progress: { completed: 1, total: 3 },
        step: 'Gathering sources',
      },
    })
    expect(isOwnedTopLevelWorkConversation(machineSession, 'agent_research', 'default_1')).toBe(
      true,
    )
  })
})
