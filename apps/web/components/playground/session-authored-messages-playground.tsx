'use client'

import { NextIntlClientProvider } from 'next-intl'
import { MemoryRouter } from 'react-router'

import type { App, WorkspaceMember } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import type { ProjectedMessage } from '../../spa/sessions/projection'
import {
  createSessionAuthorDirectory,
  type SessionAuthorDirectory,
} from '../../spa/sessions/session-authors'
import { SessionTimeline, type SessionAgentIdentity } from '../../spa/sessions/session-message'

const DAVID: WorkspaceMember = {
  id: 'user_david',
  email: 'david@example.com',
  name: 'David Zhang',
  role: 'owner',
  isBillingUser: true,
}

const ALEXANDRIA: WorkspaceMember = {
  id: 'user_alexandria',
  email: 'alexandria@example.com',
  name: 'Alexandria Catherine Montgomery',
  role: 'editor',
  isBillingUser: false,
}

// A member who never set a real name: the transcript has to fall back to the
// current email, at its full awkward length, without collapsing the row.
const QUARTERMASTER: WorkspaceMember = {
  id: 'user_quartermaster',
  email: 'quartermaster.operations@long-workspace-domain.example.com',
  role: 'editor',
  isBillingUser: false,
}

const CALENDAR = {
  id: 'app_calendar',
  slug: 'calendar',
  name: 'Team Calendar',
  workspaceId: 'workspace_acme',
  anchorId: 'anchor_calendar',
  anchorPath: '/apps/calendar',
  anchorState: 'active',
  command: 'bun start',
  apiScopes: ['sessions'],
  port: 3000,
  visibility: 'folder',
  canonicalUrl: 'https://calendar.example.com',
  runtimeStatus: 'reconciled',
  createdByUserId: DAVID.id,
  createdAt: 1,
  updatedAt: 1,
  // An app that published an icon of its own: the row is meant to be
  // recognized by that icon, the way its users already recognize the app.
  icon: 'icon.webp',
  controls: {
    manageDomain: false,
    updateRuntime: false,
    makePublic: false,
    makePrivate: false,
    delete: false,
  },
} satisfies App

// A registered app that never published an icon, beside one that did: the
// generic mark has to keep the same footprint as a real icon.
const INVENTORY = {
  ...CALENDAR,
  id: 'app_inventory',
  slug: 'inventory',
  name: 'Inventory Sync',
  anchorId: 'anchor_inventory',
  anchorPath: '/apps/inventory',
  icon: undefined,
} satisfies App

// The playground cannot serve workspace files, so an app's icon path resolves
// to a local asset that stands in for one — the production path is unchanged,
// only the origin of the bytes is.
const FIXTURE_APP_ICONS: Record<string, string> = {
  '/apps/calendar/icon.webp': '/playground/provider-googlecalendar.webp',
}

const DAVID_SENDER = { kind: 'user', userId: DAVID.id } as const
const ALEXANDRIA_SENDER = { kind: 'user', userId: ALEXANDRIA.id } as const
const QUARTERMASTER_SENDER = { kind: 'user', userId: QUARTERMASTER.id } as const
const CALENDAR_SENDER = { kind: 'app', appId: CALENDAR.id } as const
const INVENTORY_SENDER = { kind: 'app', appId: INVENTORY.id } as const
const OPS_SENDER = { kind: 'session', sessionId: 'session_ops_parent' } as const
const SEO_SENDER = { kind: 'session', sessionId: 'session_seo_board' } as const
const SYSTEM_SENDER = { kind: 'system' } as const

const WORKSPACE_AUTHORS = createSessionAuthorDirectory({
  members: [DAVID, ALEXANDRIA, QUARTERMASTER],
  apps: [CALENDAR, INVENTORY],
  sessions: new Map([
    // A conversation on the drive root: no agent to speak as, so it is named by
    // its own title, and its chip is plain text.
    ['session_ops_parent', { title: 'Ops — main' }],
    // One agent messaging another — named by the agent, and its chip is the way
    // to the conversation the message came out of.
    [
      'session_seo_board',
      {
        title: 'Rebuild the content board',
        agentName: 'SEO Specialist',
        href: '/w/acme/agents/seo-specialist/sessions/session_seo_board',
      },
    ],
  ]),
  fileUrl: (drivePath, version) => `${FIXTURE_APP_ICONS[drivePath] ?? drivePath}?v=${version}`,
})

// A workspace that renamed its assistant. Duet authored the row either way, so
// the row says what this workspace calls it — and still wears the mascot.
const RENAMED_DUET_AUTHORS = createSessionAuthorDirectory({
  members: [DAVID],
  duetName: 'Milo',
})

// The same transcript before the identity behind it has arrived — the roster
// for a person, the session's own read for a relayed row. Nothing is missing
// yet, so a row that cannot be named waits instead of accusing, and a session
// waits rather than flashing the raw id it falls back to when nothing answers.
const LOADING_AUTHORS = createSessionAuthorDirectory({
  sessions: new Map([['session_slow_read', { pending: true }]]),
})

const PRIMARY_MESSAGES: ProjectedMessage[] = [
  {
    id: 'agent-before-steer',
    role: 'agent',
    finalized: true,
    parts: [
      {
        kind: 'text',
        id: 'agent-before-steer-text',
        text: 'I set a one-hour reminder to get milk.',
      },
    ],
  },
  {
    id: 'user-mid-turn',
    role: 'input',
    source: 'prompt',
    sender: DAVID_SENDER,
    text: 'Can you describe what you did?',
    createdAt: Date.UTC(2026, 6, 19, 16, 25),
  },
  {
    id: 'agent-after-steer',
    role: 'agent',
    finalized: true,
    parts: [
      {
        kind: 'text',
        id: 'agent-after-steer-text',
        text: 'The reminder is scheduled to wake this session in one hour and ask you to get milk.',
      },
    ],
  },
]

// Every class of author this product can have, adjacent, so the four identities
// are compared against each other rather than each judged alone — and so the
// note, answer, and still-sending states are seen beside an author they do not
// replace.
const ADJACENT_AUTHOR_MESSAGES: ProjectedMessage[] = [
  {
    id: 'user-prompt',
    role: 'input',
    source: 'prompt',
    sender: DAVID_SENDER,
    /* A message composed with the `/` picker. The renderer drops raw HTML, so
       without the chip transform the skill vanishes from the sender's own
       message and the history reads as if none had been invoked. */
    text: '<Skill name="review" path="/home/duet/drive/.agents/skills/review" /> Prepare the staging release.',
    createdAt: Date.UTC(2026, 6, 19, 16, 27),
  },
  {
    id: 'user-no-name',
    role: 'input',
    source: 'prompt',
    sender: QUARTERMASTER_SENDER,
    text: 'Hold it until the inventory job finishes.',
    createdAt: Date.UTC(2026, 6, 19, 16, 27),
  },
  {
    id: 'app-prompt',
    role: 'input',
    source: 'prompt',
    sender: CALENDAR_SENDER,
    text: 'The release window opens at 5:00 PM and closes at 6:00 PM.',
    createdAt: Date.UTC(2026, 6, 19, 16, 28),
  },
  {
    id: 'app-prompt-iconless',
    role: 'input',
    source: 'prompt',
    sender: INVENTORY_SENDER,
    text: 'Two release-blocking items are still checked out.',
    createdAt: Date.UTC(2026, 6, 19, 16, 28),
  },
  {
    id: 'session-note',
    role: 'input',
    source: 'note',
    sender: OPS_SENDER,
    text: 'Use the dedicated test account and preserve the logs.',
    createdAt: Date.UTC(2026, 6, 19, 16, 28),
  },
  {
    id: 'agent-delegated-prompt',
    role: 'input',
    source: 'prompt',
    sender: SEO_SENDER,
    text: 'Build a copy of my Content Board app, owned by the user, with two UI fixes.',
    createdAt: Date.UTC(2026, 6, 19, 16, 29),
  },
  {
    id: 'system-prompt',
    role: 'input',
    source: 'prompt',
    sender: SYSTEM_SENDER,
    text: 'Scheduled reminder: publish the release notes once staging is green.',
    createdAt: Date.UTC(2026, 6, 19, 16, 29),
  },
  {
    id: 'user-answer',
    role: 'input',
    source: 'answer',
    sender: DAVID_SENDER,
    text: 'Yes, deploy it.',
    createdAt: Date.UTC(2026, 6, 19, 16, 29),
  },
  {
    id: 'user-optimistic',
    role: 'input',
    source: 'prompt',
    sender: ALEXANDRIA_SENDER,
    text: 'Add me to the release thread.',
    pending: true,
  },
]

// Identity that current data cannot name. An app or a session degrades to the
// stable handle its owner can still look up; a person never does — an internal
// user id is not a person, so a human the loaded roster does not know is shown
// as the broken invariant it is.
const UNNAMEABLE_MESSAGES: ProjectedMessage[] = [
  {
    id: 'deleted-app',
    role: 'input',
    source: 'prompt',
    sender: { kind: 'app', appId: 'app_retired_inventory_88' },
    text: 'The nightly inventory export finished.',
    createdAt: Date.UTC(2026, 6, 19, 16, 33),
  },
  {
    id: 'deleted-session',
    role: 'input',
    source: 'prompt',
    sender: { kind: 'session', sessionId: 'session_retired_44' },
    text: 'Continue the migration we started here.',
    createdAt: Date.UTC(2026, 6, 19, 16, 34),
  },
  {
    id: 'unresolved-human',
    role: 'input',
    source: 'prompt',
    sender: { kind: 'user', userId: 'user_departed_31415926' },
    text: 'Approve the budget line before Friday.',
    createdAt: Date.UTC(2026, 6, 19, 16, 35),
  },
]

const RENAMED_DUET_MESSAGES: ProjectedMessage[] = [
  {
    id: 'renamed-system-prompt',
    role: 'input',
    source: 'prompt',
    sender: SYSTEM_SENDER,
    text: 'Scheduled reminder: publish the release notes once staging is green.',
    createdAt: Date.UTC(2026, 6, 19, 16, 36),
  },
]

const IDENTITY_LOADING_MESSAGES: ProjectedMessage[] = [
  {
    id: 'roster-loading',
    role: 'input',
    source: 'prompt',
    sender: DAVID_SENDER,
    text: 'Prepare the staging release.',
    createdAt: Date.UTC(2026, 6, 19, 16, 27),
  },
  {
    id: 'session-read-loading',
    role: 'input',
    source: 'prompt',
    sender: { kind: 'session', sessionId: 'session_slow_read' },
    text: 'Hold the release until the board copy lands.',
    createdAt: Date.UTC(2026, 6, 19, 16, 27),
  },
]

// Typing three times before Duet answers is one voice, not three authors, so
// the continuations drop the repeated avatar and name and keep the clock on
// hover. This fixture is the visual owner of that stacking.
const STACKED_MESSAGES: ProjectedMessage[] = [
  {
    id: 'stack-first',
    role: 'input',
    source: 'prompt',
    sender: DAVID_SENDER,
    text: 'Cut the release branch.',
    createdAt: Date.UTC(2026, 6, 19, 16, 40),
  },
  {
    id: 'stack-second',
    role: 'input',
    source: 'prompt',
    sender: DAVID_SENDER,
    text: 'Tag it v4.2.0 while you are in there.',
    createdAt: Date.UTC(2026, 6, 19, 16, 41),
  },
  {
    id: 'stack-third',
    role: 'input',
    source: 'prompt',
    sender: DAVID_SENDER,
    text: 'And post the changelog to the launch folder.',
    createdAt: Date.UTC(2026, 6, 19, 16, 42),
  },
  {
    id: 'stack-reply',
    role: 'agent',
    finalized: true,
    parts: [
      {
        kind: 'text',
        id: 'stack-reply-text',
        text: 'Branch cut and tagged. The changelog is in the launch folder.',
      },
    ],
  },
  {
    id: 'stack-reply-two',
    role: 'agent',
    finalized: true,
    parts: [{ kind: 'text', id: 'stack-reply-two-text', text: 'Staging is redeploying now.' }],
  },
]

// Duet closes agent creation with root-relative links to both the agent page and
// its anchor folder. This fixture pins both branches the link handler must
// serve: same-origin `/w/...` links navigate in place, while the `https://` link
// opens a new browsing context.
const LINK_BACK_MESSAGES: ProjectedMessage[] = [
  {
    id: 'agent-link-back',
    role: 'agent',
    finalized: true,
    parts: [
      {
        kind: 'text',
        id: 'agent-link-back-text',
        text: 'Your Research agent is ready — open [Research](/w/acme/agents/research) to see its sessions, or browse its anchor folder in [Research](/w/acme/files/agents/research). The house style lives at [duet.so](https://duet.so).',
      },
    ],
  },
]

const EDGE_MESSAGES: ProjectedMessage[] = [
  {
    id: 'agent-text-and-ask',
    role: 'agent',
    finalized: false,
    parts: [
      {
        kind: 'text',
        id: 'agent-text-and-ask-text',
        text: 'The release is ready and all local checks passed.',
      },
      {
        kind: 'ask',
        id: 'agent-text-and-ask-question',
        questions: [
          {
            header: 'Approval',
            question: 'Should I deploy it to staging?',
            options: [],
          },
        ],
      },
    ],
  },
  {
    id: 'long-user-pending',
    role: 'input',
    source: 'prompt',
    sender: ALEXANDRIA_SENDER,
    text: 'Please include this image in the handoff.',
    images: [{ storageId: 'fixture-image', mimeType: 'image/png', bytes: 4_096 }],
    createdAt: Date.UTC(2026, 6, 19, 16, 31),
    pending: true,
  },
  {
    id: 'agent-pending',
    role: 'agent',
    finalized: false,
    parts: [
      {
        kind: 'text',
        id: 'agent-pending-text',
        text: 'Adding the image to the handoff now…',
        pending: true,
      },
    ],
  },
]

export function SessionAuthoredMessagesPlayground() {
  return (
    <MemoryRouter initialEntries={['/w/acme/sessions']}>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <main className="min-h-screen bg-muted/20 px-3 py-8 text-foreground sm:px-8 sm:py-12">
          <div className="mx-auto w-full max-w-4xl space-y-6">
            <header className="px-1">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">
                Session messages
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                Every message has an author
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                A user prompt during an active turn remains a complete row between agent messages.
              </p>
            </header>

            <MessageFixture
              title="AI → user → AI"
              messages={PRIMARY_MESSAGES}
              agent={{ name: 'Research', avatarKey: 'research' }}
            />
            <MessageFixture title="Every kind of author" messages={ADJACENT_AUTHOR_MESSAGES} />
            <MessageFixture
              title="Identity that current data cannot name"
              messages={UNNAMEABLE_MESSAGES}
            />
            <MessageFixture
              title="A workspace that renamed its Duet"
              messages={RENAMED_DUET_MESSAGES}
              authors={RENAMED_DUET_AUTHORS}
            />
            <MessageFixture
              title="Before identity arrives"
              messages={IDENTITY_LOADING_MESSAGES}
              authors={LOADING_AUTHORS}
            />
            <MessageFixture title="Consecutive turns stack" messages={STACKED_MESSAGES} />
            <MessageFixture title="Links back into the app" messages={LINK_BACK_MESSAGES} />
            <MessageFixture
              title="One shell for mixed and pending content"
              messages={EDGE_MESSAGES}
            />
          </div>
        </main>
      </NextIntlClientProvider>
    </MemoryRouter>
  )
}

function MessageFixture({
  title,
  messages,
  agent,
  authors = WORKSPACE_AUTHORS,
}: {
  title: string
  messages: ProjectedMessage[]
  agent?: SessionAgentIdentity
  authors?: SessionAuthorDirectory
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
      <h2 className="border-b border-border/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:px-6">
        {title}
      </h2>
      <div role="log" aria-label={title}>
        <SessionTimeline
          messages={messages}
          duetName={authors.duetName}
          agent={agent}
          authors={authors}
          imageUrl={() => '/icons/duet-avatar.png'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </div>
    </section>
  )
}
