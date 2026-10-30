import { describe, expect, test } from 'bun:test'

import {
  isUserSettingSurface,
  isWorkspaceSettingSurface,
  WORKSPACE_DESTINATIONS,
  WORKSPACE_SETTINGS,
} from './route-metadata'

describe('SPA route metadata', () => {
  /* The router's own table, flattened from the destinations. Apps and Work
     conversations keep their agent-owned canonical paths inside the single
     agent host. The workspace-level session door remains a redirect for links
     minted outside the browser. */
  const routes = WORKSPACE_DESTINATIONS.map(([route]) => route)

  test('an app has no workspace-level address, and a session keeps its own', () => {
    expect(routes).not.toContain('apps')
    expect(routes).not.toContain('apps/:appSlug')
    expect(routes).toContain('sessions')
    expect(routes).toContain('sessions/:sessionId')
    expect(routes).toContain('home')
    expect(routes).not.toContain('agents/root/sessions/:sessionId')
    expect(routes).toContain('agents/*')
  })

  /* The ring and an agent are two destinations, not one splat with a tail. They
     used to be one, to keep the canvas mounted across a camera flight into a
     face; there is no flight, and an agent is a page the map is not on.

     The tail under an agent stays one route — it selects what the card shows and
     never leaves the page — and `agents-map-url` still reads it. The static
     siblings outrank both patterns and must keep their own entries. */
  /* One splat for the agent page, and the bare path inside it. Two sibling
     patterns for one element used to be the shape here, and React Router
     reconciles by position — so a path crossing between them remounted the
     destination, which the entry rewrite does on every cold landing. Benign
     while the page was the whole window; not benign with a persistent roster in
     the same subtree.

     The graph keeps a static segment of its own, and the static siblings
     outrank the splat on specificity as they always did. */
  test('the agent page is one splat, and the graph and the agent document are their own', () => {
    /* The splat alone, and it matches the bare path too — a second `'agents'`
       entry beside it is the very thing the comment on that destination forbids,
       and it shipped once under a comment saying it had not. */
    expect(routes).not.toContain('agents')
    expect(routes).toContain('agents/*')
    expect(routes).not.toContain('agents/:agentSlug')
    expect(routes).not.toContain('agents/:agentSlug/*')
    expect(routes).toContain('agents/graph')
    expect(routes).toContain('agents/:agentSlug/settings')
    expect(routes).toContain('agents/marketplace')
  })

  test('rejects arbitrary settings surfaces instead of accepting the first one', () => {
    expect(isWorkspaceSettingSurface('members')).toBe(true)
    expect(isWorkspaceSettingSurface('unknown')).toBe(false)
    expect(isUserSettingSurface('unknown')).toBe(false)
  })

  /* Invitations are rows on the roster now, so there is no surface behind the
     old address and nothing left to render. That is precisely why the router
     redirects it: without the redirect this table is what turns an owner's
     bookmark into a 404. */
  test('the retired invites address is no longer a settings surface', () => {
    expect(isWorkspaceSettingSurface('invites')).toBe(false)
    expect(WORKSPACE_SETTINGS.map(([route]) => route)).not.toContain('invites')
  })

  test('recognizes connected providers as a workspace-settings surface', () => {
    expect(isWorkspaceSettingSurface('connected-providers')).toBe(true)
  })
})

test('App domains is an addressable workspace Settings surface', async () => {
  const { default: messages } = await import('../../messages/en/app.json')
  expect(WORKSPACE_SETTINGS).toContainEqual(['app-domains', 'appDomains'])
  expect(isWorkspaceSettingSurface('app-domains')).toBe(true)
  expect((messages.duetApp as Record<string, unknown>).appDomains).toBe('App domains')
})
