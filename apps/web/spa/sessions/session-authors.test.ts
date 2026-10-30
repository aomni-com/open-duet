import { expect, test } from 'bun:test'

import type { App, SessionSummary, WorkspaceMember } from '@repo/contract'

import {
  createSessionAuthorDirectory,
  resolveSessionAuthor,
  sessionAuthorSources,
  type SessionAuthorCopy,
} from './session-authors'

const VIEWER: WorkspaceMember = {
  id: 'user_viewer',
  email: 'viewer@example.com',
  name: 'Grace Hopper',
  role: 'owner',
  isBillingUser: true,
}

const TEAMMATE: WorkspaceMember = {
  id: 'user_ada',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  role: 'editor',
  isBillingUser: false,
}

// Stand-in for the product's own strings. The real message catalogue is proved
// through the rendered transcript in `session-message.test.tsx`; here the shape
// only has to be distinguishable so a mispaired category is visible.
const COPY: SessionAuthorCopy = {
  unknownMember: 'Unknown member',
  pendingMember: 'a workspace member',
  pendingSession: 'another conversation',
  app: 'App',
  session: 'Session',
  withCategory: ({ name, category }) => `${name} (${category})`,
}

function app(fields: Partial<App> & Pick<App, 'id' | 'slug'>): App {
  return {
    workspaceId: 'workspace_1',
    anchorId: 'anchor_1',
    anchorPath: '/apps/calendar',
    anchorState: 'active',
    command: 'bun start',
    apiScopes: [],
    port: 3000,
    visibility: 'folder',
    canonicalUrl: 'https://calendar.example.com',
    runtimeStatus: 'reconciled',
    createdByUserId: VIEWER.id,
    createdAt: 1,
    updatedAt: 1,
    controls: {
      manageDomain: false,
      updateRuntime: false,
      makePublic: false,
      makePrivate: false,
      delete: false,
    },
    ...fields,
  }
}

function author(
  sender: Parameters<typeof resolveSessionAuthor>[0],
  sources: Parameters<typeof createSessionAuthorDirectory>[0],
) {
  return resolveSessionAuthor(sender, createSessionAuthorDirectory(sources), COPY)
}

const SEO_AGENT = { id: 'agent_seo', slug: 'seo-specialist' }

/** One answered read of a sending session, for the source builder. */
function read(fields: Partial<SessionSummary> & { sessionId: string }): {
  sessionId: string
  summary: SessionSummary
} {
  const { sessionId, ...summary } = fields
  return {
    sessionId,
    summary: {
      id: sessionId,
      audience: { kind: 'workspace' },
      archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
      permissions: {
        send: true,
        answer: true,
        interrupt: true,
        rename: true,
        manageAudience: false,
        personalArchive: true,
        globalArchive: true,
        delete: true,
      },
      turnStatus: 'complete',
      bucket: 'done',
      title: 'Rebuild the content board',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: 1,
      updatedAt: 2,
      lastEventSeq: 3,
      unread: false,
      ...summary,
    },
  }
}

test('a human row shows the member who wrote it, not whoever is reading it', () => {
  const presentation = author(
    { kind: 'user', userId: TEAMMATE.id },
    { viewer: VIEWER, members: [VIEWER, TEAMMATE] },
  )

  expect(presentation.category).toBe('user')
  expect(presentation.label).toBe('Ada Lovelace')
  expect(presentation.accessibleLabel).toBe('Ada Lovelace')
  expect(presentation.portrait).toEqual({ kind: 'person', name: 'Ada Lovelace' })
})

test('a named human is not also labelled with their email, and a nameless one is', () => {
  const named = author({ kind: 'user', userId: TEAMMATE.id }, { members: [TEAMMATE] })
  expect(named.label).not.toContain(TEAMMATE.email)

  const nameless = author(
    { kind: 'user', userId: TEAMMATE.id },
    { members: [{ ...TEAMMATE, name: '   ' }] },
  )
  expect(nameless.label).toBe('ada@example.com')
  expect(nameless.portrait).toEqual({ kind: 'person', name: 'ada@example.com' })
})

test('a human the loaded roster does not know is an error, never an internal id', () => {
  const presentation = author(
    { kind: 'user', userId: 'user_departed_00000' },
    { viewer: VIEWER, members: [VIEWER, TEAMMATE] },
  )

  expect(presentation.unresolved).toBe(true)
  expect(presentation.label).toBe('Unknown member')
  expect(presentation.accessibleLabel).toBe('Unknown member')
  expect(presentation.portrait).toEqual({ kind: 'person-unknown' })
  // Neither the reader's name nor the internal user id may stand in for them.
  expect(JSON.stringify(presentation)).not.toContain('user_departed')
  expect(JSON.stringify(presentation)).not.toContain('Grace Hopper')
})

test('a roster that has not arrived yet is a wait, not an error, and still hides the id', () => {
  const presentation = author({ kind: 'user', userId: TEAMMATE.id }, { viewer: VIEWER })

  expect(presentation.pending).toBe(true)
  expect(presentation.unresolved).toBeUndefined()
  expect(presentation.label).toBe('a workspace member')
  expect(presentation.accessibleLabel).toBe('a workspace member')
  expect(presentation.portrait).toEqual({ kind: 'person-pending' })
  expect(JSON.stringify(presentation)).not.toContain('user_ada')
})

test('the reader’s own row is named before the roster arrives', () => {
  const presentation = author({ kind: 'user', userId: VIEWER.id }, { viewer: VIEWER })

  expect(presentation.label).toBe('Grace Hopper')
  expect(presentation.pending).toBeUndefined()
})

test('an app row is an app: current name, then slug, then its durable short id', () => {
  const named = author(
    { kind: 'app', appId: 'app_calendar' },
    { apps: [app({ id: 'app_calendar', slug: 'calendar', name: 'Team Calendar' })] },
  )
  expect(named.category).toBe('app')
  expect(named.label).toBe('Team Calendar')
  expect(named.categoryLabel).toBe('App')
  expect(named.accessibleLabel).toBe('Team Calendar (App)')
  expect(named.portrait).toEqual({ kind: 'app' })

  const unnamed = author(
    { kind: 'app', appId: 'app_calendar' },
    { apps: [app({ id: 'app_calendar', slug: 'calendar' })] },
  )
  expect(unnamed.label).toBe('calendar')

  const deleted = author({ kind: 'app', appId: 'app_calendar_9999' }, { apps: [] })
  expect(deleted.label).toBe('app_calendar…')
  expect(deleted.portrait).toEqual({ kind: 'app' })
})

test('an app row wears the app’s own icon, and degrades to the generic mark without one', () => {
  const withIcon = author(
    { kind: 'app', appId: 'app_calendar' },
    {
      apps: [app({ id: 'app_calendar', slug: 'calendar', icon: 'icon.png', updatedAt: 42 })],
      fileUrl: (drivePath, version) => `/w/acme/files${drivePath}?v=${version}`,
    },
  )
  // The icon is a file in the app's own anchor folder, addressed at the
  // revision the workspace last saw so a replaced icon is not read from cache.
  expect(withIcon.portrait).toEqual({
    kind: 'app-icon',
    src: '/w/acme/files/apps/calendar/icon.png?v=42',
  })

  const iconless = author(
    { kind: 'app', appId: 'app_calendar' },
    {
      apps: [app({ id: 'app_calendar', slug: 'calendar' })],
      fileUrl: (drivePath, version) => `/w/acme/files${drivePath}?v=${version}`,
    },
  )
  expect(iconless.portrait).toEqual({ kind: 'app' })

  // A deleted app, and any surface that cannot serve workspace files at all,
  // keep the generic mark rather than pointing at a URL nothing answers.
  const deleted = author(
    { kind: 'app', appId: 'app_retired_9999' },
    { apps: [], fileUrl: drivePath => drivePath },
  )
  expect(deleted.portrait).toEqual({ kind: 'app' })

  const noFiles = author(
    { kind: 'app', appId: 'app_calendar' },
    { apps: [app({ id: 'app_calendar', slug: 'calendar', icon: 'icon.png' })] },
  )
  expect(noFiles.portrait).toEqual({ kind: 'app' })
})

test('a session inside an agent is named by that agent, not by its own title', () => {
  const delegated = author(
    { kind: 'session', sessionId: 'session_ops_12345678' },
    {
      sessions: new Map([
        [
          'session_ops_12345678',
          { title: 'Rebuild the content board', agentName: 'SEO Specialist' },
        ],
      ]),
    },
  )

  // "who messaged me" is answered by the agent; the sending conversation's own
  // title is what THAT agent was working on, which the reader did not ask.
  expect(delegated.category).toBe('session')
  expect(delegated.label).toBe('SEO Specialist')
  expect(delegated.accessibleLabel).toBe('SEO Specialist (Session)')
  expect(delegated.label).not.toContain('Rebuild')
})

test('a session row carries the address the reader can follow to read it', () => {
  const href = '/w/acme/agents/seo-specialist/sessions/session_ops_12345678'
  const addressed = author(
    { kind: 'session', sessionId: 'session_ops_12345678' },
    { sessions: new Map([['session_ops_12345678', { agentName: 'SEO Specialist', href }]]) },
  )
  expect(addressed.href).toBe(href)

  // A session whose owner has not resolved — still loading, or deleted since —
  // is still named, and simply has nowhere to send the reader.
  const unaddressed = author(
    { kind: 'session', sessionId: 'session_ops_12345678' },
    { sessions: new Map([['session_ops_12345678', { agentName: 'SEO Specialist' }]]) },
  )
  expect(unaddressed.label).toBe('SEO Specialist')
  expect(unaddressed.href).toBeUndefined()
})

test('a session with no agent to speak as falls back to its title, then its short id', () => {
  // The drive root owns sessions too, and nothing there has an agent name.
  const rootSession = author(
    { kind: 'session', sessionId: 'session_ops_12345678' },
    { sessions: new Map([['session_ops_12345678', { title: 'Ops — main' }]]) },
  )
  expect(rootSession.label).toBe('Ops — main')
  expect(rootSession.categoryLabel).toBe('Session')
  expect(rootSession.accessibleLabel).toBe('Ops — main (Session)')
  expect(rootSession.portrait).toEqual({ kind: 'session' })

  // A session still loading, or one deleted since it wrote here, has no name to
  // show and keeps the handle its owner can still look up.
  const unknown = author({ kind: 'session', sessionId: 'session_gone_12345678' }, {})
  expect(unknown.label).toBe('session_gone…')
  expect(unknown.portrait).toEqual({ kind: 'session' })

  // A title the server has not filled in yet is not a name.
  const untitled = author(
    { kind: 'session', sessionId: 'session_new_123456789' },
    { sessions: new Map([['session_new_123456789', { title: '   ' }]]) },
  )
  expect(untitled.label).toBe('session_new_…')
})

test('a sending session whose read is still in flight waits instead of showing its id', () => {
  const presentation = author(
    { kind: 'session', sessionId: 'session_ops_12345678' },
    { sessions: new Map([['session_ops_12345678', { pending: true }]]) },
  )

  expect(presentation.pending).toBe(true)
  expect(presentation.label).toBe('another conversation')
  expect(presentation.accessibleLabel).toBe('another conversation')
  // The whole point: the id must not flash on screen and then become a name.
  expect(JSON.stringify(presentation)).not.toContain('session_ops')
})

test('a sender session resolves to its agent’s name and its address on that agent', () => {
  const sources = sessionAuthorSources(
    'acme',
    [read({ sessionId: 'session_seo_1', agent: { id: SEO_AGENT.id, name: 'SEO Specialist' } })],
    [SEO_AGENT],
  )

  expect(sources.get('session_seo_1')).toEqual({
    title: 'Rebuild the content board',
    agentName: 'SEO Specialist',
    href: '/w/acme/agents/seo-specialist/sessions/session_seo_1',
  })
})

test('a session whose owner is unresolved is still named, with nowhere to go', () => {
  // The roster has not loaded, so the owning agent's id cannot become a slug.
  const loading = sessionAuthorSources(
    'acme',
    [read({ sessionId: 'session_seo_1', agent: { id: SEO_AGENT.id, name: 'SEO Specialist' } })],
    undefined,
  )
  expect(loading.get('session_seo_1')?.agentName).toBe('SEO Specialist')
  expect(loading.get('session_seo_1')?.href).toBeUndefined()

  // An agent the roster no longer holds must not be guessed into another one.
  const departed = sessionAuthorSources(
    'acme',
    [read({ sessionId: 'session_seo_1', agent: { id: 'agent_deleted', name: 'Retired' } })],
    [SEO_AGENT],
  )
  expect(departed.get('session_seo_1')?.href).toBeUndefined()
})

test('a root session has no agent to speak as and addresses the drive’s own scope', () => {
  const sources = sessionAuthorSources('acme', [read({ sessionId: 'session_root_1' })], [SEO_AGENT])

  expect(sources.get('session_root_1')).toEqual({
    title: 'Rebuild the content board',
    href: '/w/acme/agents/root/sessions/session_root_1',
  })
})

test('a read in flight is a wait; one that answered with nothing is a session that is gone', () => {
  const waiting = sessionAuthorSources(
    'acme',
    [{ sessionId: 'session_slow_1', pending: true }],
    [SEO_AGENT],
  )
  expect(waiting.get('session_slow_1')).toEqual({ pending: true })

  // Deleted since it wrote here: no source at all, so the row falls back to the
  // short id rather than waiting forever on a name that is never coming.
  const gone = sessionAuthorSources(
    'acme',
    [{ sessionId: 'session_gone_1', pending: false }],
    [SEO_AGENT],
  )
  expect(gone.size).toBe(0)
})

test('a system row is this workspace’s own Duet, under whatever name it goes by', () => {
  const renamed = author({ kind: 'system' }, { duetName: 'Milo' })

  expect(renamed.category).toBe('system')
  expect(renamed.label).toBe('Milo')
  expect(renamed.accessibleLabel).toBe('Milo')
  expect(renamed.categoryLabel).toBeUndefined()
  // Renaming the assistant renames the label, never the mark it wears.
  expect(renamed.portrait).toEqual({ kind: 'duet' })

  const unnamed = author({ kind: 'system' }, {})
  expect(unnamed.label).toBe('Duet')
  expect(unnamed.accessibleLabel).toBe('Duet')
})
