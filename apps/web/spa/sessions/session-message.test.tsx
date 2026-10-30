import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import type { App, WorkspaceMember } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import type { ProjectedMessage } from './projection'
import { createSessionAuthorDirectory, type SessionAuthorDirectory } from './session-authors'
import { SessionMessage, type SessionAgentIdentity } from './session-message'
import { TurnUsagePanel } from './session-turn-usage'

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

const NAMELESS: WorkspaceMember = {
  id: 'user_nameless',
  email: 'quartermaster.operations.desk@very-long-workspace-domain.example.com',
  role: 'editor',
  isBillingUser: false,
}

const CALENDAR = {
  id: 'app_calendar',
  slug: 'calendar',
  name: 'Team Calendar',
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
} satisfies App

// An app that published an icon of its own, in a workspace whose files can be
// served — the two conditions a real transcript row needs to show one.
const TIMESHEETS = {
  ...CALENDAR,
  id: 'app_timesheets',
  slug: 'timesheets',
  name: 'Timesheets',
  anchorPath: '/apps/timesheets',
  icon: 'icon.png',
  updatedAt: 9,
} satisfies App

const APPS_WITH_ICONS: SessionAuthorDirectory = createSessionAuthorDirectory({
  members: [VIEWER],
  apps: [CALENDAR, TIMESHEETS],
  fileUrl: (drivePath, version) => `/w/acme/files${drivePath}?v=${version}`,
})

const SEO_SESSION = {
  id: 'session_seo_12345678',
  href: '/w/acme/agents/seo-specialist/sessions/session_seo_12345678',
}

const WORKSPACE: SessionAuthorDirectory = createSessionAuthorDirectory({
  viewer: VIEWER,
  members: [VIEWER, TEAMMATE, NAMELESS],
  apps: [CALENDAR],
  sessions: new Map([
    // A root session: no agent to speak as, and no agent surface to link to.
    ['session_ops_12345678', { title: 'Ops — main' }],
    // One agent delegating to another — the case the reader actually meets.
    [
      SEO_SESSION.id,
      {
        title: 'Rebuild the content board',
        agentName: 'SEO Specialist',
        href: SEO_SESSION.href,
      },
    ],
  ]),
})

function renderMessage(
  message: ProjectedMessage,
  directory: SessionAuthorDirectory = WORKSPACE,
  agent?: SessionAgentIdentity,
  workspaceSlug = agent?.workspaceSlug,
  turn?: { running?: boolean; clockNow?: number },
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionMessage
          message={message}
          duetName="Duet"
          agent={agent}
          workspaceSlug={workspaceSlug}
          authors={directory}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={path => `/files/${path}`}
          running={turn?.running}
          clockNow={turn?.clockNow}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )
}

function prompt(
  fields: Partial<ProjectedMessage> & Pick<ProjectedMessage, 'id'>,
): ProjectedMessage {
  return {
    role: 'input',
    source: 'prompt',
    sender: { kind: 'user', userId: TEAMMATE.id },
    text: 'Prepare the staging release.',
    createdAt: Date.UTC(2026, 7, 3, 11, 11),
    ...fields,
  } as ProjectedMessage
}

test('shows when an assistant message started', () => {
  const createdAt = Date.UTC(2026, 7, 3, 11, 11)
  const html = renderMessage({
    id: 'agent-message',
    role: 'agent',
    finalized: true,
    createdAt,
    parts: [{ kind: 'text', id: 'answer', text: 'Hello world!' }],
  })

  expect(html).toContain(`<time dateTime="${new Date(createdAt).toISOString()}"`)
})

test('adds the calendar date when a message is from a different day', () => {
  const html = renderMessage({
    id: 'old-agent-message',
    role: 'agent',
    finalized: true,
    createdAt: Date.UTC(2026, 7, 3, 11, 11),
    parts: [{ kind: 'text', id: 'answer', text: 'Hello from history!' }],
  })

  expect(html).toContain('Aug 3, 2026')
})

test('a teammate authored row names the teammate, never the reader', () => {
  const html = renderMessage(prompt({ id: 'from-ada' }))

  expect(html).toContain('aria-label="Message from Ada Lovelace"')
  expect(html).toContain('data-message-attribution="user"')
  expect(html).not.toContain('Grace Hopper')
})

test('every author class carries its own attribution and announced name', () => {
  const user = renderMessage(prompt({ id: 'user-row' }))
  expect(user).toContain('data-message-attribution="user"')
  expect(user).toContain('aria-label="Message from Ada Lovelace"')

  const app = renderMessage(prompt({ id: 'app-row', sender: { kind: 'app', appId: CALENDAR.id } }))
  expect(app).toContain('data-message-attribution="app"')
  expect(app).toContain('aria-label="Message from Team Calendar (App)"')

  const session = renderMessage(
    prompt({ id: 'session-row', sender: { kind: 'session', sessionId: 'session_ops_12345678' } }),
  )
  expect(session).toContain('data-message-attribution="session"')
  expect(session).toContain('aria-label="Message from Ops — main (Session)"')

  const system = renderMessage(prompt({ id: 'system-row', sender: { kind: 'system' } }))
  expect(system).toContain('data-message-attribution="system"')
  expect(system).toContain('aria-label="Message from Duet"')
})

test('a message from another agent is named by that agent and flies the reader to it', () => {
  const html = renderMessage(
    prompt({ id: 'delegated', sender: { kind: 'session', sessionId: SEO_SESSION.id } }),
  )

  expect(html).toContain('aria-label="Message from SEO Specialist (Session)"')
  expect(html).toContain(`href="${SEO_SESSION.href}"`)
  // The raw id is the fallback for a session nothing is known about, and must
  // not survive anywhere on a row that DOES know who wrote it.
  expect(html).not.toContain('session_seo_…')
})

test('a session with nowhere to go keeps its chip as plain text, not a dead link', () => {
  const html = renderMessage(
    prompt({ id: 'unaddressed', sender: { kind: 'session', sessionId: 'session_ops_12345678' } }),
  )

  expect(html).toContain('aria-label="Message from Ops — main (Session)"')
  expect(html).not.toContain('href=')
})

test('an app is recognized by its own icon, and one without an icon keeps the generic mark', () => {
  const withIcon = renderMessage(
    prompt({ id: 'icon-app', sender: { kind: 'app', appId: TIMESHEETS.id } }),
    APPS_WITH_ICONS,
  )
  expect(withIcon).toContain('data-message-avatar')
  expect(withIcon).toContain('src="/w/acme/files/apps/timesheets/icon.png?v=9"')
  expect(withIcon).toContain('aria-label="Message from Timesheets (App)"')

  const iconless = renderMessage(
    prompt({ id: 'plain-app', sender: { kind: 'app', appId: CALENDAR.id } }),
    APPS_WITH_ICONS,
  )
  expect(iconless).toContain('data-message-avatar')
  expect(iconless).not.toContain('<img')
})

test('a system row is named by this workspace, not by the constant the product ships', () => {
  const renamed = createSessionAuthorDirectory({ members: [VIEWER], duetName: 'Milo' })
  const html = renderMessage(prompt({ id: 'renamed-system', sender: { kind: 'system' } }), renamed)

  // `duetName` is passed as "Duet" here on purpose: the row must take the name
  // from the workspace directory, not from the agent name beside it.
  expect(html).toContain('aria-label="Message from Milo"')
  expect(html).not.toContain('Message from Duet')
})

test('a deleted app or session degrades to its own short id, and a missing human never does', () => {
  const app = renderMessage(
    prompt({ id: 'gone-app', sender: { kind: 'app', appId: 'app_retired_9999' } }),
  )
  expect(app).toContain('app_retired_…')

  const session = renderMessage(
    prompt({ id: 'gone-session', sender: { kind: 'session', sessionId: 'session_retired_9999' } }),
  )
  expect(session).toContain('session_reti…')

  const human = renderMessage(
    prompt({ id: 'gone-human', sender: { kind: 'user', userId: 'user_gone_1' } }),
  )
  expect(human).toContain('aria-label="Message from Unknown member"')
  expect(human).not.toContain('user_gone_1')
  expect(human).not.toContain('Grace Hopper')
})

test('a nameless human is named by email, in full, and a named one is not', () => {
  const nameless = renderMessage(
    prompt({ id: 'nameless', sender: { kind: 'user', userId: NAMELESS.id } }),
  )
  expect(nameless).toContain(NAMELESS.email)
  expect(nameless).toContain(`aria-label="Message from ${NAMELESS.email}"`)

  const named = renderMessage(prompt({ id: 'named' }))
  expect(named).not.toContain(TEAMMATE.email)
})

test('note, answer, and pending are metadata beside the author, never instead of it', () => {
  for (const source of ['prompt', 'note', 'answer'] as const) {
    const html = renderMessage(prompt({ id: `${source}-row`, source }))
    expect(html).toContain('aria-label="Message from Ada Lovelace"')
    expect(html).toContain('data-message-attribution="user"')
  }

  const note = renderMessage(prompt({ id: 'note-row', source: 'note' }))
  expect(note).toContain(appEn.duetApp.sessionProduct.note)

  const pending = renderMessage(prompt({ id: 'pending-row', createdAt: undefined, pending: true }))
  expect(pending).toContain('aria-label="Message from Ada Lovelace"')
  expect(pending).toContain(appEn.duetApp.sessionProduct.sending)
})

test('renders durable attachments below inline images as linked preview cards', () => {
  const html = renderMessage(
    prompt({
      id: 'with-attachments',
      images: [{ storageId: 'inline-image', mimeType: 'image/png', bytes: 186_420 }],
      attachments: [
        {
          path: 'agents/research/uploads/brand-board.png',
          name: 'brand-board.png',
          bytes: 186_420,
          mimeType: 'image/png',
        },
        {
          path: 'agents/research/uploads/brief.pdf',
          name: 'brief.pdf',
          bytes: 84_203,
          mimeType: 'application/pdf',
        },
      ],
    }),
    WORKSPACE,
    undefined,
    'acme',
  )

  expect(html).toContain('data-message-attachment-card')
  expect(html).toContain('data-message-inline-image')
  expect(html).toContain('href="/w/acme/files/agents/research/uploads/brief.pdf"')
  expect(html).toContain('src="/api/duet/ws/acme/files/agents/research/uploads/brand-board.png"')
  expect(html.indexOf('src="about:blank"')).toBeLessThan(
    html.indexOf('data-message-attachment-card'),
  )
})

test('renders uploaded images uncropped at their intrinsic aspect ratio', () => {
  const html = renderMessage(
    prompt({
      id: 'portrait-image',
      images: [{ storageId: 'portrait', mimeType: 'image/png', bytes: 186_420 }],
    }),
  )

  const inlineImage = /data-message-inline-image[\s\S]*?<\/span>/.exec(html)?.[0]
  expect(inlineImage).toBeDefined()
  expect(inlineImage).toContain('object-contain')
  expect(inlineImage).not.toContain('aspect-video')
  expect(inlineImage).not.toContain('object-cover')
})

test('fits an overflow image inside its submitted attachment thumbnail without cropping', () => {
  const html = renderMessage(
    prompt({
      id: 'overflow-image',
      attachments: [
        {
          path: 'agents/research/uploads/portrait.png',
          name: 'portrait.png',
          bytes: 186_420,
          mimeType: 'image/png',
        },
      ],
    }),
    WORKSPACE,
    undefined,
    'acme',
  )

  const thumbnail = /<img[^>]*src="[^"]*portrait\.png"[^>]*>/.exec(html)?.[0]
  expect(thumbnail).toBeDefined()
  expect(thumbnail).toContain('object-contain')
  expect(thumbnail).not.toContain('object-cover')
})

test('does not mount an arbitrarily large drive attachment as an image preview', () => {
  const html = renderMessage(
    prompt({
      id: 'large-image-attachment',
      attachments: [
        {
          path: 'agents/research/uploads/large.png',
          name: 'large.png',
          bytes: 1024 * 1024 * 1024,
          mimeType: 'image/png',
        },
      ],
    }),
    WORKSPACE,
    undefined,
    'acme',
  )

  expect(html).toContain('data-message-attachment-card')
  expect(html).not.toContain('src="/api/duet/ws/acme/files/agents/research/uploads/large.png"')
})

test('an optimistic row keeps no durable time and converges without changing its author', () => {
  const optimistic = renderMessage(
    prompt({ id: 'optimistic', createdAt: undefined, pending: true, sender: viewerSender() }),
  )
  const durable = renderMessage(prompt({ id: 'durable', sender: viewerSender() }))

  expect(optimistic).not.toContain('<time')
  expect(authorHeader(optimistic)).toBe(authorHeader(durable))
  expect(optimistic).toContain('aria-label="Message from Grace Hopper"')
})

test('an optimistic row renders its local image and landed file card while sending', () => {
  const html = renderMessage(
    prompt({
      id: 'optimistic-media',
      createdAt: undefined,
      pending: true,
      sender: viewerSender(),
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
      attachments: [
        {
          path: 'agents/research/uploads/brief.pdf',
          name: 'brief.pdf',
          bytes: 84_203,
          mimeType: 'application/pdf',
        },
      ],
    }),
    WORKSPACE,
    undefined,
    'acme',
  )

  expect(html).toContain('src="data:image/png;base64,aGVsbG8="')
  expect(html).toContain('data-message-attachment-card')
  expect(html).toContain(appEn.duetApp.sessionProduct.sending)
})

test('a row whose roster has not loaded waits without naming or blaming anyone', () => {
  const loading = createSessionAuthorDirectory({ viewer: VIEWER })
  const html = renderMessage(prompt({ id: 'waiting' }), loading)

  expect(html).toContain('aria-label="Message from a workspace member"')
  // The header holds a placeholder rather than printing a stand-in as a name.
  expect(html).toContain('data-message-author-placeholder')
  expect(html).not.toContain(appEn.duetApp.sessionProduct.authorUnknown)
  expect(html).not.toContain('user_ada')
})

function viewerSender() {
  return { kind: 'user', userId: VIEWER.id } as const
}

/** The identity strip a reader looks at: portrait, name, and category. */
function authorHeader(html: string): string {
  const header = /data-message-avatar[\s\S]*?<\/div>/.exec(html)
  expect(header).not.toBeNull()
  return header![0]
}

const TURN_USAGE = {
  input: 1_200,
  output: 480,
  cacheRead: 9_000,
  cacheWrite: 300,
  totalTokens: 10_980,
  cost: { input: 0.0036, output: 0.0072, cacheRead: 0.0009, cacheWrite: 0.0011, total: 0.0128 },
}

test('a settled turn says how long it thought and offers its usage', () => {
  const createdAt = Date.UTC(2026, 7, 3, 11, 11)
  const html = renderMessage({
    id: 'agent-message',
    role: 'agent',
    finalized: true,
    createdAt,
    finalizedAt: createdAt + 82_000,
    turnUsage: TURN_USAGE,
    parts: [{ kind: 'text', id: 'answer', text: 'Hello world!' }],
  })

  expect(html).toContain('thought for 1m 22s')
  expect(html).toContain('aria-label="View token usage"')
})

test('a turn that settled without usage still tells its duration, and one without a clock stays silent', () => {
  const createdAt = Date.UTC(2026, 7, 3, 11, 11)
  const bare = renderMessage({
    id: 'agent-message',
    role: 'agent',
    finalized: true,
    createdAt,
    finalizedAt: createdAt + 4_000,
    parts: [{ kind: 'text', id: 'answer', text: 'Hello world!' }],
  })
  expect(bare).toContain('thought for 4s')
  expect(bare).not.toContain('View token usage')

  const unclocked = renderMessage({
    id: 'agent-message',
    role: 'agent',
    finalized: true,
    createdAt,
    parts: [{ kind: 'text', id: 'answer', text: 'Hello world!' }],
  })
  expect(unclocked).not.toContain('thought for')
})

test('the usage panel reads the turn tally in humane units', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <TurnUsagePanel
          turnUsage={TURN_USAGE}
          usageByModel={[
            {
              model: 'claude-sonnet-5',
              transport: { provider: 'duet-gateway', billing: 'plan-covered' },
              usage: TURN_USAGE,
            },
          ]}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('Total tokens')
  expect(html).toContain('11.0k')
  expect(html).toContain('Per model')
  expect(html).toContain('claude-sonnet-5')
  // Dollars stay off the readout everywhere: tokens are the product's number.
  expect(html).not.toContain('$')
})

test('a running turn counts out loud, pinned still when the clock is a prop', () => {
  const createdAt = Date.UTC(2026, 7, 3, 11, 11)
  const html = renderMessage(
    {
      id: 'agent-message',
      role: 'agent',
      finalized: false,
      createdAt,
      parts: [{ kind: 'text', id: 'draft', text: 'Working on it.', pending: true }],
    },
    undefined,
    undefined,
    undefined,
    { running: true, clockNow: createdAt + 42_000 },
  )
  expect(html).toContain('thinking for 42s')

  const settled = renderMessage(
    {
      id: 'agent-message',
      role: 'agent',
      finalized: true,
      createdAt,
      finalizedAt: createdAt + 42_000,
      parts: [{ kind: 'text', id: 'answer', text: 'Done.' }],
    },
    undefined,
    undefined,
    undefined,
    { running: false, clockNow: createdAt + 90_000 },
  )
  expect(settled).toContain('thought for 42s')
  expect(settled).not.toContain('thinking for')
})
