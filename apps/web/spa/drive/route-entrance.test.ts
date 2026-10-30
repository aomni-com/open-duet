import { describe, expect, test } from 'bun:test'

import { routeEntranceKey, workspaceRouteTransitionKey } from './route-entrance'

const AGENT = '/w/acme/agents/research'

describe('routeEntranceKey', () => {
  /* These paths change the centre selection without replacing Build navigation. */
  test.each([
    ['the bare agent', AGENT],
    ['its folder', `${AGENT}/files`],
    ['a folder deep inside it', `${AGENT}/files/agents/research/uploads`],
    ['the desktop', `${AGENT}/desktop`],
    ['one of its apps', `${AGENT}/apps/reporting`],
    ['another of its apps', `${AGENT}/apps/metrics`],
    ['one of its sessions', `${AGENT}/sessions/session_live`],
  ])('%s is the same subject', (_what, path) => {
    expect(routeEntranceKey(path, 'acme', 'agents')).toBe(routeEntranceKey(AGENT, 'acme', 'agents'))
  })

  /* The roster stands beside every centre in the section. */
  test('another agent is the same section', () => {
    expect(routeEntranceKey('/w/acme/agents/root', 'acme', 'agents')).toBe(
      routeEntranceKey(AGENT, 'acme', 'agents'),
    )
  })

  /* The graph is the section's other centre, reached from a row of the same
     roster — so arriving there is the same non-arrival as any other row. */
  test('the graph is the same section as an agent on it', () => {
    expect(routeEntranceKey('/w/acme/agents/graph', 'acme', 'agents')).toBe(
      routeEntranceKey(AGENT, 'acme', 'agents'),
    )
  })

  /* And the collapse stops at the section's edge. An agent's settings document
     and Train light the Agents tab but stand outside the section — they replace
     the window, roster included — so each is an arrival of its own. */
  test.each([
    ['an agent’s settings document', `${AGENT}/settings`],
    ['train', '/w/acme/train'],
  ])('%s is not the section', (_what, path) => {
    expect(routeEntranceKey(path, 'acme', 'agents')).not.toBe(
      routeEntranceKey(AGENT, 'acme', 'agents'),
    )
  })

  test('another destination is another subject', () => {
    expect(routeEntranceKey('/w/acme/integrations', 'acme', 'integrations')).not.toBe(
      routeEntranceKey('/w/acme/files', 'acme', 'files'),
    )
  })

  /* Browsing the drive is not arriving either — one destination, many folders —
     and the tab is the whole of the answer where there is no card grammar. */
  test('two folders of the drive are one subject', () => {
    expect(routeEntranceKey('/w/acme/files/reports/q3', 'acme', 'files')).toBe(
      routeEntranceKey('/w/acme/files', 'acme', 'files'),
    )
  })

  /* Settings sections are not a destination the bar carries, so they fall
     through to the path and keep their own arrivals. */
  test('settings sections stay distinct', () => {
    expect(routeEntranceKey('/settings/profile', 'acme', null)).not.toBe(
      routeEntranceKey('/settings/billing', 'acme', null),
    )
  })

  /* A path belonging to another workspace does not parse as this one's map, so
     it must not collapse into this workspace's agent keys. */
  test('another workspace is not this one', () => {
    expect(routeEntranceKey('/w/labs/agents/research', 'acme', 'agents')).not.toBe(
      routeEntranceKey(AGENT, 'acme', 'agents'),
    )
  })
})

describe('workspaceRouteTransitionKey', () => {
  test('gives each Work destination a stable content identity', () => {
    expect(workspaceRouteTransitionKey('/w/acme/home', '', 'acme', null)).toBe('work-home')
    expect(
      workspaceRouteTransitionKey(
        '/w/acme/agents/root/sessions/chat_1',
        '?mode=work&panel=people',
        'acme',
        'agents',
      ),
    ).toBe('work-session:chat_1')
    expect(
      workspaceRouteTransitionKey(
        '/w/acme/agents/root/apps/readiness',
        '?mode=work',
        'acme',
        'agents',
      ),
    ).toBe('work-app:readiness')
  })

  test('changes between Work conversations without fragmenting one conversation by query state', () => {
    const first = workspaceRouteTransitionKey(
      '/w/acme/agents/root/sessions/chat_1',
      '?mode=work',
      'acme',
      'agents',
    )
    expect(
      workspaceRouteTransitionKey(
        '/w/acme/agents/root/sessions/chat_1',
        '?mode=work&jobs=open',
        'acme',
        'agents',
      ),
    ).toBe(first)
    expect(
      workspaceRouteTransitionKey(
        '/w/acme/agents/root/sessions/chat_2',
        '?mode=work',
        'acme',
        'agents',
      ),
    ).not.toBe(first)
  })

  test('retains Build section grouping instead of animating agent card changes', () => {
    expect(workspaceRouteTransitionKey('/w/acme/agents/root', '', 'acme', 'agents')).toBe(
      workspaceRouteTransitionKey('/w/acme/agents/research/files', '', 'acme', 'agents'),
    )
  })
})
