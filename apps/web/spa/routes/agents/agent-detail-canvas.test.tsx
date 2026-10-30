import { describe, expect, test } from 'bun:test'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import { bucketOf, type App, type SessionSummary } from '@repo/contract'

import appEn from '../../../messages/en/app.json'
import { SpaContext, type SpaContextValue } from '../../context'
import { AGENT_MENU_ITEMS } from '../../drive/agent-roster-types'
import { AgentDetailCanvas, type AgentDetailCanvasProps } from './agent-detail-canvas'

const queryClient = new QueryClient()
const spa = {
  api: {
    openAgentOnboardingSession: async () => ({ sessionId: 'session_onboarding' }),
  },
} as unknown as SpaContextValue

function app(id: string, slug: string, name: string): App {
  return {
    id,
    workspaceId: 'workspace_1',
    anchorId: `anchor_${id}`,
    anchorPath: `agents/research/${slug}`,
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 4173,
    slug,
    name,
    visibility: 'folder',
    canonicalUrl: `https://${slug}.duet.so`,
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_1',
    createdAt: 1,
    updatedAt: 2,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  }
}

function session(
  id: string,
  title: string,
  turnStatus: SessionSummary['turnStatus'],
): SessionSummary {
  return {
    id,
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
    turnStatus,
    // Derived, not stated: a fixture that picks its own bucket can disagree
    // with the rule the product uses, and then it is testing itself.
    bucket: bucketOf({ turnStatus }),
    title,
    titleOrigin: 'manual',
    titleStatus: 'complete',
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 1,
    unread: false,
  }
}

describe('the default agent on the shared canvas', () => {
  // Duet gets the same page, not a page of its own — so what differs is only
  // what it genuinely lacks: a slug to print, a folder below the drive's own,
  // and an agent-scoped Train link.
  const asRoot = { kind: 'root' as const, name: 'Milo', slug: 'root', anchorPath: '' }

  test('names the drive root instead of echoing an empty path', () => {
    const html = render(asRoot)
    expect(html).toContain('Milo')
    expect(html).toContain('Drive root')
    // The registered header reads `slug · path`; the root has neither to show,
    // and printing `root · ` with an empty link is the failure this guards.
    expect(html).not.toContain('root · ')
  })

  test('carries the root scope on Train and session links, not a slug', () => {
    const html = render(asRoot)
    expect(html).toContain('/w/acme/train/root"')
    // `root` is the scope's own name, not an agent slug wearing one.
    expect(html).not.toContain('/train/agents/')
    // Session rows address the map's root scope — ROOT_AGENT_SCOPE doing its job.
    expect(html).toContain('/w/acme/agents/root/sessions/s1')
  })

  // The menu's items render only once the dropdown is open, so the contents are
  // asserted against the table that owns them rather than against static
  // markup that never contains them either way.
  test('offers rename and Open in Drive, and nothing it cannot do', () => {
    expect(AGENT_MENU_ITEMS.default).toEqual(['rename', 'open-in-drive'])
    expect(render({ ...asRoot, menu: 'default', onMenuAction: () => {} })).toContain(
      'Agent actions',
    )
  })

  test('still prints a registered agent’s slug and folder', () => {
    const html = render({ kind: 'registered', slug: 'research', anchorPath: 'agents/research' })
    expect(html).toContain('research')
    expect(html).toContain('agents/research')
    expect(html).not.toContain('Drive root')
  })
})

function render(overrides: Partial<AgentDetailCanvasProps> = {}): string {
  const props: AgentDetailCanvasProps = {
    workspaceSlug: 'acme',
    kind: 'registered',
    name: 'Research',
    slug: 'research',
    anchorPath: 'agents/research',
    updatedAt: 2,
    status: 'reconciled',
    locked: false,
    trainSurface: 'enabled',
    agentsMarkdown: '# Research\n\nSynthesizes sources into decision-ready briefs.',
    skills: ['deep-research', 'summarize'],
    apps: [app('app_1', 'briefs', 'Brief builder')],
    sessions: [session('s1', 'Compare vector database vendors', 'ask')],
    hasMoreSessions: false,
    renderAppIcon: app => <span>{app.name}</span>,
    menu: 'agent',
    ...overrides,
  }
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <SpaContext.Provider value={spa}>
          <MemoryRouter initialEntries={['/w/acme/agents/research']}>
            <AgentDetailCanvas {...props} />
          </MemoryRouter>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  )
}

test('renders identity, anchor path, rendered AGENTS.md, skills, apps, and sessions without an agent mode', () => {
  const html = render()
  expect(html).toContain('Research')
  expect(html).toContain('agents/research')
  // AGENTS.md is rendered as markdown, not shown as a raw fenced blob.
  expect(html).toContain('Synthesizes sources into decision-ready briefs.')
  expect(html).not.toContain('Duet decides how this agent runs each session.')
  expect(html).toContain('deep-research')
  expect(html).toContain('Brief builder')
  expect(html).toContain('Compare vector database vendors')
})

test('renders an agent icon from its versioned drive-file URL', () => {
  const html = render({
    icon: 'icon.png',
    updatedAt: 42,
  })

  expect(html).toContain('src="/api/duet/ws/acme/files/agents/research/icon.png?v=42"')
})

test('uses the canonical generated avatar when the agent has no icon', () => {
  expect(render()).toContain('data-agent-avatar="dicebear"')
})

test('links the anchor path to its exact Drive folder URL', () => {
  const html = render()
  expect(html).toMatch(
    /<a[^>]*href="\/w\/acme\/files\/agents\/research"[^>]*>agents\/research<\/a>/,
  )
})

/* The session list here draws each row's state in the marks every other list
   uses (`ChatMarks`), not a palette of its own: waiting on the reader is the
   ask tone, and a finished session wears nothing rather than a green dot. */
test('session rows say what each session is doing in the shared marks', () => {
  const html = render({
    sessions: [
      session('s1', 'Compare vector database vendors', 'ask'),
      session('s2', 'Summarize the migration', 'complete'),
    ],
  })
  expect(html).toContain('data-chat-state="asking"')
  expect(html.match(/data-chat-state=/g)?.length).toBe(1)
  expect(html).not.toMatch(/bg-(blue|amber|emerald|rose|violet)-500/)
})

test('links each session row to the conversation on this agent, on the map', () => {
  const html = render()
  expect(html).toContain('/w/acme/agents/research/sessions/s1')
})

test('links a delegated session row to its conversation without query parameters', () => {
  const html = render({
    sessions: [
      { ...session('s2', 'Wait for the nightly export', 'ask'), createdBySessionId: 's1' },
    ],
  })
  expect(html).toContain('href="/w/acme/agents/research/sessions/s2"')
})

test('links the Train affordance to the agent-scoped memory surface', () => {
  const html = render()
  expect(html).toContain('/w/acme/train/research')
  expect(html).toContain('>Train<')
})

test('Train affordances follow the trainable projection whether the agent is locked or unlocked', () => {
  expect(render({ trainSurface: 'enabled', locked: false })).toContain('>Train<')
  expect(render({ trainSurface: 'enabled', locked: true })).toContain('>Train<')
  expect(render({ trainSurface: 'disabled', locked: false })).not.toContain('>Train<')
  expect(render({ trainSurface: 'disabled', locked: true })).not.toContain('>Train<')
})

test('a locked detail keeps its header and menu but collapses the body to one onboarding CTA', () => {
  const html = render({ locked: true, onboardingTarget: { kind: 'chat' } })

  /* Out of the catalogue rather than typed here: the claim is that the locked
     body collapses to exactly ONE onboarding control, and a literal turns that
     claim red every time the button's wording is edited. */
  expect(html.match(new RegExp(`>${appEn.duetApp.agentRoster.onboardAgent}<`, 'g'))).toHaveLength(1)
  expect(html).toContain('Research')
  expect(html).toContain('Agent actions')
  expect(html).not.toContain('deep-research')
  expect(html).not.toContain('Brief builder')
  expect(html).not.toContain('Compare vector database vendors')
  expect(html).not.toContain('Synthesizes sources into decision-ready briefs.')
})

test('a broken agent still renders the canvas with its status pill', () => {
  const html = render({ status: 'broken' })
  expect(html).toContain('Research')
  // The status pill surfaces the broken state.
  expect(html).toContain('Unavailable')
})

test('a missing AGENTS.md degrades to a readable note, never a crash', () => {
  const html = render({ agentsMarkdown: undefined })
  expect(html).toContain('described itself yet.')
})

test('an empty AGENTS.md is treated the same as missing', () => {
  const html = render({ agentsMarkdown: '   \n  ' })
  expect(html).toContain('described itself yet.')
})

test('empty skills, apps, and sessions each show their own readable empty state', () => {
  const html = render({ skills: [], apps: [], sessions: [] })
  expect(html).toContain('No skills yet')
  expect(html).toContain('No apps yet')
  expect(html).toContain('No sessions yet')
})

test('an empty agent-session page with a cursor stays continuable instead of claiming no sessions', () => {
  const html = render({ sessions: [], hasMoreSessions: true, onShowAllSessions: () => {} })

  expect(html).toContain(appEn.duetApp.agentDetail.showAll)
  expect(html).not.toContain(appEn.duetApp.agentDetail.noSessions)
})

test('agent-session failures distinguish an unavailable first page from a retained prefix', () => {
  const initial = render({
    sessions: [],
    sessionsInitialError: true,
    onRetrySessions: () => {},
  })
  expect(initial).toContain(appEn.duetApp.agentDetail.sessionsLoadError)
  expect(initial).toContain(appEn.duetApp.agentDetail.retry)
  expect(initial).not.toContain(appEn.duetApp.agentDetail.noSessions)

  const continuation = render({
    moreSessionsFailed: true,
    onShowAllSessions: () => {},
  })
  expect(continuation).toContain('Compare vector database vendors')
  expect(continuation).toContain(appEn.duetApp.agentDetail.sessionsMoreError)
  expect(continuation).toContain(appEn.duetApp.agentDetail.retryMore)
})

test('the apps card names continuation loading and retry without hiding loaded apps', () => {
  const loading = render({ hasMoreApps: true, loadingMoreApps: true, onLoadMoreApps: () => {} })
  expect(loading).toContain('Brief builder')
  expect(loading).toContain(appEn.duetApp.agentDetail.loadingMore)

  const retry = render({ moreAppsFailed: true, onLoadMoreApps: () => {} })
  expect(retry).toContain('Brief builder')
  expect(retry).toContain(appEn.duetApp.agentDetail.retryMore)

  expect(render({ apps: [], appsLoading: true })).toContain(appEn.duetApp.agentDetail.loadingMore)
  expect(render({ apps: [], appsInitialError: true, onRetryApps: () => {} })).toContain(
    appEn.duetApp.agentDetail.retry,
  )
})
