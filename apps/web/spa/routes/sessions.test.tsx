import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import type { SessionInputSender } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { DuetApiError } from '../api/client'
import { projectSession, type ProjectedMessage } from '../sessions/projection'
import { TRANSCRIPT_EVENTS, TRANSCRIPT_SNAPSHOT } from '../sessions/projection/fixtures'
import { createSessionAuthorDirectory } from '../sessions/session-authors'
import { SessionTimeline } from '../sessions/session-message'

const ADA: SessionInputSender = { kind: 'user', userId: 'user_ada' }

/** One member roster per test, so a row is labelled by who wrote it. */
function authorsNamed(name: string) {
  return createSessionAuthorDirectory({
    members: [
      {
        id: 'user_ada',
        email: 'ada@example.com',
        name,
        role: 'owner',
        isBillingUser: true,
      },
    ],
  })
}
import {
  onboardingCompletionFromRouterState,
  isLocalSessionDebugHost,
  SessionStateInspector,
  sessionDetailIsLoading,
  sessionTimelineCwd,
  reuseSessionClientRequestId,
  isConfirmedSubmissionRejection,
  restoredDraft,
  sendReplayingUnknownOutcome,
} from './sessions'

test('a confirmed session denial outranks the still-pending sibling read', () => {
  expect(
    sessionDetailIsLoading({
      snapshotPending: false,
      snapshotError: true,
      historyPending: true,
      historyError: false,
    }),
  ).toBeFalse()
  expect(
    sessionDetailIsLoading({
      snapshotPending: false,
      snapshotError: false,
      historyPending: true,
      historyError: false,
    }),
  ).toBeTrue()
})

test('editing attachments after a rejected send creates a new request identity', () => {
  const retry = {
    mode: 'message' as const,
    text: 'Review it',
    tier: 'balanced' as const,
    behavior: 'steer' as const,
    attachmentsKey: 'file-a',
    id: 'request-a',
  }
  expect(
    reuseSessionClientRequestId(retry, {
      mode: 'message',
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      attachmentsKey: 'file-a',
    }),
  ).toBe('request-a')
  expect(
    reuseSessionClientRequestId(retry, {
      mode: 'message',
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      attachmentsKey: 'file-a:file-b',
    }),
  ).not.toBe('request-a')
})

test('request identity follows the normalized effective audience', () => {
  const retry = {
    text: 'Review it',
    tier: 'balanced' as const,
    behavior: 'steer' as const,
    attachmentsKey: '',
    audienceKey: 'specific:user_ada,user_grace',
    id: 'request-a',
  }

  expect(
    reuseSessionClientRequestId(retry, {
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      attachmentsKey: '',
      audienceKey: 'specific:user_ada,user_grace',
    }),
  ).toBe('request-a')
  expect(
    reuseSessionClientRequestId(retry, {
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      attachmentsKey: '',
      audienceKey: 'specific:user_ada,user_linus',
    }),
  ).not.toBe('request-a')
  expect(
    reuseSessionClientRequestId(retry, {
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      attachmentsKey: '',
      audienceKey: 'workspace',
    }),
  ).not.toBe('request-a')
})

test('re-homing attachments after a rejected send creates a new request identity', () => {
  const retry = {
    mode: 'message' as const,
    text: 'Review it',
    tier: 'balanced' as const,
    behavior: 'steer' as const,
    attachmentsKey: 'file-a:agents/research/uploads/brief.pdf',
    id: 'request-a',
  }
  expect(
    reuseSessionClientRequestId(retry, {
      mode: 'message',
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      attachmentsKey: 'file-a:agents/writer/uploads/brief.pdf',
    }),
  ).not.toBe('request-a')
})

test('changing the creation scope rotates request identity even when submitted paths are pinned', () => {
  const retry = {
    text: 'Review it',
    tier: 'balanced' as const,
    behavior: 'steer' as const,
    cwd: 'agents/research',
    attachmentsKey: 'file-a:agents/research/uploads/brief.pdf',
    id: 'request-a',
  }
  expect(
    reuseSessionClientRequestId(retry, {
      text: 'Review it',
      tier: 'balanced',
      behavior: 'steer',
      cwd: 'agents/writer',
      attachmentsKey: 'file-a:agents/research/uploads/brief.pdf',
    }),
  ).not.toBe('request-a')
})

test('only an explicit client refusal returns attachment cleanup ownership to the draft', () => {
  expect(isConfirmedSubmissionRejection(new DuetApiError(400, 'invalid_request'))).toBe(true)
  expect(isConfirmedSubmissionRejection(new DuetApiError(409, 'request_conflict'))).toBe(true)
  expect(isConfirmedSubmissionRejection(new DuetApiError(502, 'gateway_failed'))).toBe(false)
  expect(isConfirmedSubmissionRejection(new TypeError('network failed'))).toBe(false)
})

test('a direct visit to an agent surface has no onboarding celebration', () => {
  expect(onboardingCompletionFromRouterState(null, 'research')).toBeUndefined()
  expect(onboardingCompletionFromRouterState({}, 'research')).toBeUndefined()
  expect(
    onboardingCompletionFromRouterState({ onboardedAt: 1_700_000_000_000 }, 'research'),
  ).toBeUndefined()
})

const timelineWithPerTurnMarkers: ProjectedMessage[] = [
  {
    id: 'message_1',
    role: 'agent',
    finalized: true,
    parts: [
      { kind: 'text', id: 'text_1', text: 'First answer' },
      { kind: 'lifecycle', id: 'lifecycle_1', type: 'complete' },
    ],
  },
  {
    id: 'message_2',
    role: 'agent',
    finalized: true,
    parts: [
      { kind: 'text', id: 'text_2', text: 'Second answer' },
      { kind: 'lifecycle', id: 'lifecycle_2', type: 'interrupted' },
      {
        kind: 'lifecycle',
        id: 'lifecycle_3',
        type: 'complete',
        error: 'budget exhausted',
      },
      {
        kind: 'lifecycle',
        id: 'lifecycle_4',
        type: 'complete',
        status: 'cancelled',
        error: 'stopped mid-tool',
      },
    ],
  },
]

test('drops per-turn complete markers while keeping meaningful lifecycle rows', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={timelineWithPerTurnMarkers}
          duetName="Duet"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('First answer')
  expect(html).toContain('Second answer')
  expect(html).toContain('Interrupted')
  // Settled turns are noise, but a terminal event carrying an error the
  // transcript never showed must keep rendering.
  expect(html).not.toContain('Complete')
  // Read the rendered text, not the tags between it: the claim is that a
  // reader sees the ending and its reason together, and how many elements
  // carry them is presentation the row is free to change.
  const rendered = html.replace(/<[^>]+>/g, '')
  expect(rendered).toMatch(/Failed\s*·\s*budget exhausted/)
  expect(rendered).toMatch(/Cancelled\s*·\s*stopped mid-tool/)
})

test('a settled turn does not echo its answer back as a completion row', () => {
  const answer = 'The web service is missing DATABASE_URL.'
  const { messages } = projectSession({
    snapshot: TRANSCRIPT_SNAPSHOT,
    durableEvents: [
      ...TRANSCRIPT_EVENTS.slice(0, -1),
      { seq: 6, createdAt: 6, event: { type: 'complete', status: 'completed', result: answer } },
    ],
  })

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={messages}
          duetName="Duet"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  // The agent's final text already streamed as a message part; the terminal
  // event carries the same string, and repeating it is noise.
  expect(html).toContain(answer)
  expect(html.match(/missing DATABASE_URL/g)).toHaveLength(1)
  expect(html).not.toContain('data-agent-part-kind="lifecycle"')
})

test('renders the persisted root assistant name on authored messages', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'message_ask',
              role: 'agent',
              finalized: true,
              parts: [
                { kind: 'text', id: 'text_ask', text: 'I checked the release.' },
                {
                  kind: 'ask',
                  id: 'ask_1',
                  questions: [
                    {
                      header: 'Approval',
                      question: 'Should I deploy it?',
                      options: [],
                    },
                  ],
                },
              ],
            },
          ]}
          duetName="Milo"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html.match(/<article/g)).toHaveLength(1)
  expect(html.match(/aria-label="Message from Milo"/g)).toHaveLength(1)
  expect(html.match(/>Milo<\/span>/g)).toHaveLength(1)
  expect(html).toContain('I checked the release.')
  expect(html).toContain('Should I deploy it?')
})

test('renders a registered agent’s canonical identity on authored messages', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'message_research',
              role: 'agent',
              finalized: true,
              parts: [{ kind: 'text', id: 'text_research', text: 'I checked the sources.' }],
            },
          ]}
          duetName="Duet"
          agent={{ name: 'Research', avatarKey: 'research' }}
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('aria-label="Message from Research"')
  expect(html).toContain('data-agent-avatar="dicebear"')
  expect(html).not.toContain('/icons/duet-avatar.png')
})

test('keeps a registered agent’s portrait stable when its display name changes', () => {
  const renderAgent = (name: string) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
          <SessionTimeline
            messages={[
              {
                id: 'message_research',
                role: 'agent',
                finalized: true,
                parts: [{ kind: 'text', id: 'text_research', text: 'I checked the sources.' }],
              },
            ]}
            duetName="Duet"
            agent={{ name, avatarKey: 'research' }}
            authors={authorsNamed('Ada')}
            imageUrl={() => 'about:blank'}
            cwd={undefined}
            fileUrl={() => 'about:blank'}
          />
        </NextIntlClientProvider>
      </MemoryRouter>,
    )

  const beforeRename = renderAgent('Research')
  const afterRename = renderAgent('Evidence Research')
  const avatarSrc = (html: string) =>
    html.match(/data-agent-avatar="dicebear"[^>]*><img[^>]*src="([^"]+)"/)?.[1]

  expect(beforeRename).toContain('Message from Research')
  expect(afterRename).toContain('Message from Evidence Research')
  expect(avatarSrc(beforeRename)).toBeDefined()
  expect(avatarSrc(afterRename)).toBe(avatarSrc(beforeRename))
})

test('renders every projected message as a complete authored row', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'message_1',
              role: 'agent',
              finalized: false,
              parts: [{ kind: 'text', id: 'text_1', text: 'I set the reminder.' }],
            },
            {
              id: 'message_2',
              role: 'input',
              source: 'prompt',
              sender: ADA,
              text: 'What did you do?',
            },
            {
              id: 'message_3',
              role: 'agent',
              finalized: true,
              parts: [{ kind: 'text', id: 'text_2', text: 'It will wake in one hour.' }],
            },
          ]}
          duetName="Duet"
          authors={authorsNamed('Ada Lovelace')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html.match(/<article/g)).toHaveLength(3)
  expect(html.match(/data-message-avatar/g)).toHaveLength(3)
  expect(html.match(/data-identity-avatar="agent"/g)).toHaveLength(2)
  expect(html.match(/data-identity-avatar="user"/g)).toHaveLength(1)
  expect(html.match(/data-avatar-shape="squarish"/g)).toHaveLength(3)
  expect(html.match(/aria-label="Message from Duet"/g)).toHaveLength(2)
  expect(html.match(/aria-label="Message from Ada Lovelace"/g)).toHaveLength(1)
})

test('a run of prompts from one person is announced once and stays one stack', () => {
  const noon = Date.UTC(2026, 6, 19, 12, 0)
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'first',
              role: 'input',
              source: 'prompt',
              sender: ADA,
              text: 'Cut the release branch.',
              createdAt: noon,
            },
            {
              id: 'second',
              role: 'input',
              source: 'prompt',
              sender: ADA,
              text: 'Tag it too.',
              createdAt: noon + 60_000,
            },
            {
              id: 'third',
              role: 'input',
              source: 'prompt',
              sender: ADA,
              text: 'And post the changelog.',
              createdAt: noon + 120_000,
            },
          ]}
          duetName="Duet"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  // Every message keeps its own row and its own label for assistive tech; only
  // the repeated face and name drop away.
  expect(html.match(/<article/g)).toHaveLength(3)
  expect(html.match(/aria-label="Message from Ada"/g)).toHaveLength(3)
  expect(html.match(/data-message-avatar/g)).toHaveLength(1)
  expect(html.match(/>Ada<\/span>/g)).toHaveLength(1)
  expect(html.match(/data-message-stacked="true"/g)).toHaveLength(2)
})

test('does not merge adjacent prompt, note, and answer messages from the user', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'prompt',
              role: 'input',
              source: 'prompt',
              sender: ADA,
              text: 'Start the release.',
            },
            {
              id: 'note',
              role: 'input',
              source: 'note',
              sender: ADA,
              text: 'Use the staging account.',
            },
            { id: 'answer', role: 'input', source: 'answer', sender: ADA, text: 'Yes, proceed.' },
          ]}
          duetName="Duet"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={undefined}
          fileUrl={() => 'about:blank'}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html.match(/<article/g)).toHaveLength(3)
  expect(html.match(/data-message-avatar/g)).toHaveLength(3)
  expect(html.match(/>Ada<\/span>/g)).toHaveLength(3)
  expect(html.match(/>Note<\/span>/g)).toHaveLength(1)
})

test('passes a persisted session cwd through to timeline media', () => {
  const cwd = sessionTimelineCwd({
    sessionId: 'session-1',
    persistedCwd: 'projects/acme',
    pendingCwd: undefined,
  })
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'agent',
              role: 'agent',
              finalized: true,
              parts: [{ kind: 'text', id: 'text', text: '![Chart](chart.png)' }],
            },
          ]}
          duetName="Duet"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={cwd}
          fileUrl={drivePath => `/files/${drivePath}`}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('src="/files/projects/acme/chart.png"')
})

test('treats a missing persisted cwd as drive root', () => {
  const cwd = sessionTimelineCwd({
    sessionId: 'session-1',
    persistedCwd: undefined,
    pendingCwd: undefined,
  })
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionTimeline
          messages={[
            {
              id: 'user',
              role: 'input',
              source: 'prompt',
              sender: ADA,
              text: '![Chart](chart.png)',
            },
          ]}
          duetName="Duet"
          authors={authorsNamed('Ada')}
          imageUrl={() => 'about:blank'}
          cwd={cwd}
          fileUrl={drivePath => `/files/${drivePath}`}
        />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain('src="/files/chart.png"')
})

test('does not invent a cwd for a pending create', () => {
  expect(
    sessionTimelineCwd({
      sessionId: undefined,
      persistedCwd: 'stale/persisted/path',
      pendingCwd: undefined,
    }),
  ).toBeUndefined()
  expect(
    sessionTimelineCwd({
      sessionId: undefined,
      persistedCwd: undefined,
      pendingCwd: 'agents/research',
    }),
  ).toBe('agents/research')
})

test('hides the session state inspector off localhost', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <SessionStateInspector state={{ phase: 'internal' }} />
    </NextIntlClientProvider>,
  )

  expect(html).toBe('')
})

test('offers the session state inspector trigger when served from localhost', () => {
  ;(globalThis as { location?: unknown }).location = { hostname: 'localhost' }
  try {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <SessionStateInspector state={{ phase: 'internal' }} />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('Session state')
  } finally {
    delete (globalThis as { location?: unknown }).location
  }
})

test('classifies only loopback hosts as session debug hosts', () => {
  expect(isLocalSessionDebugHost('localhost')).toBe(true)
  expect(isLocalSessionDebugHost('127.0.0.1')).toBe(true)
  expect(isLocalSessionDebugHost('app.duet.so')).toBe(false)
  expect(isLocalSessionDebugHost(undefined)).toBe(false)
})

test('a failed send returns its text ahead of what was written while it travelled', () => {
  expect(restoredDraft('Summarize the brief', '')).toBe('Summarize the brief')
  expect(restoredDraft('Summarize the brief', 'and the notes')).toBe(
    'Summarize the brief\n\nand the notes',
  )
  // An attachment-only send has no words to restore, so nothing is prepended.
  expect(restoredDraft('', 'and the notes')).toBe('and the notes')
})

test('a send with an unknown outcome is replayed once, verbatim, when the reader kept writing', async () => {
  const unknown = new Error('network down')
  const outcomes = (...results: Array<'ok' | Error>) => {
    const sent: number[] = []
    const attempt = async () => {
      sent.push(sent.length)
      const result = results[sent.length - 1] ?? 'ok'
      if (result instanceof Error) throw result
      return result
    }
    return { sent, attempt }
  }

  // Kept writing: the identical request goes once more, so a send the server
  // did accept is deduplicated by its id rather than re-sent merged.
  const replayed = outcomes(unknown, 'ok')
  expect(await sendReplayingUnknownOutcome(replayed.attempt, () => true)).toBe('ok')
  expect(replayed.sent).toHaveLength(2)

  // Only once.
  const twice = outcomes(unknown, unknown)
  await expect(sendReplayingUnknownOutcome(twice.attempt, () => true)).rejects.toBe(unknown)
  expect(twice.sent).toHaveLength(2)

  // Nothing written meanwhile: the restored draft is the same request, so the
  // reader's own retry already reuses its id.
  const idle = outcomes(unknown)
  await expect(sendReplayingUnknownOutcome(idle.attempt, () => false)).rejects.toBe(unknown)
  expect(idle.sent).toHaveLength(1)

  // A refusal is a verdict, not an unknown.
  const refused = outcomes(new DuetApiError(400, 'invalid_request'))
  await expect(sendReplayingUnknownOutcome(refused.attempt, () => true)).rejects.toBeInstanceOf(
    DuetApiError,
  )
  expect(refused.sent).toHaveLength(1)
})
