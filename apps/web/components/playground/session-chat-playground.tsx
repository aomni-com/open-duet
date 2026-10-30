'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useCallback, useMemo, useRef, useState } from 'react'
import { MemoryRouter } from 'react-router'

import type { WorkspaceMember } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { buildTierQualityOptions } from '../../spa/model-tiers/tier-quality-options'
import type { ProjectedMessage } from '../../spa/sessions/projection'
import { createSessionAuthorDirectory } from '../../spa/sessions/session-authors'
import {
  SessionComposer,
  type SessionComposerSubmitPayload,
} from '../../spa/sessions/session-composer'
import { VirtualizedSessionTimeline } from '../../spa/sessions/virtualized-session-timeline'

type Surface = 'default' | 'job'

const PAGE_SIZE = 24
const INITIAL_START = 88
const FIXTURE_NOW = Date.UTC(2026, 7, 17, 15, 0)
const FIXTURE_MEMBER: WorkspaceMember = {
  id: 'user_chat_playground',
  email: 'walter@example.com',
  name: 'Walter',
  role: 'owner',
  isBillingUser: true,
}
const FIXTURE_SENDER = { kind: 'user', userId: FIXTURE_MEMBER.id } as const
const AUTHORS = createSessionAuthorDirectory({ members: [FIXTURE_MEMBER] })
const QUALITY_OPTIONS = buildTierQualityOptions()
const PICKER_LABELS = {
  list: 'Available',
  loading: 'Loading…',
  empty: 'Nothing available',
  unavailable: 'Unavailable',
} as const

const HISTORY = Array.from({ length: 60 }, (_, index): ProjectedMessage[] => {
  const turn = index + 1
  const createdAt = FIXTURE_NOW - (60 - turn) * 60_000
  const agentText =
    turn % 9 === 0
      ? `Checkpoint ${turn} is complete.\n\n- The rollout owner is confirmed.\n- The staging evidence is attached.\n- No blocking alerts remain.`
      : `Checkpoint ${turn} is verified. I kept the evidence and the next action together so this longer transcript exercises rows with changing heights.`

  return [
    {
      id: `fixture-input-${turn}`,
      role: 'input',
      source: 'prompt',
      sender: FIXTURE_SENDER,
      text: `Review launch checkpoint ${turn}.`,
      createdAt,
    },
    {
      id: `fixture-agent-${turn}`,
      role: 'agent',
      finalized: true,
      createdAt: createdAt + 20_000,
      finalizedAt: createdAt + 35_000,
      parts: [{ kind: 'text', id: `fixture-agent-${turn}-text`, text: agentText }],
    },
  ]
}).flat()

export function SessionChatPlayground() {
  return (
    <MemoryRouter initialEntries={['/w/acme/agents/milo/sessions/default']}>
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <ChatWorkbench />
      </NextIntlClientProvider>
    </MemoryRouter>
  )
}

function ChatWorkbench() {
  const [surface, setSurface] = useState<Surface>('default')
  const [historyStart, setHistoryStart] = useState(INITIAL_START)
  const [addedMessages, setAddedMessages] = useState<ProjectedMessage[]>([])
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [loadOlderFailed, setLoadOlderFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const [tailRevision, setTailRevision] = useState(0)
  const shellRef = useRef<HTMLElement>(null)
  const messages = useMemo(
    () => [...HISTORY.slice(historyStart), ...addedMessages],
    [addedMessages, historyStart],
  )

  const loadOlder = useCallback(async () => {
    if (historyStart === 0 || isLoadingOlder) return
    setLoadOlderFailed(false)
    setIsLoadingOlder(true)
    await new Promise(resolve => setTimeout(resolve, 180))
    setHistoryStart(current => Math.max(0, current - PAGE_SIZE))
    setIsLoadingOlder(false)
  }, [historyStart, isLoadingOlder])

  const appendAgentMessage = () => {
    const sequence = addedMessages.length + 1
    setAddedMessages(current => [
      ...current,
      {
        id: `playground-live-${sequence}`,
        role: 'agent',
        finalized: true,
        createdAt: FIXTURE_NOW + sequence * 1_000,
        finalizedAt: FIXTURE_NOW + sequence * 1_000 + 800,
        parts: [
          {
            kind: 'text',
            id: `playground-live-${sequence}-text`,
            text: `Live update ${sequence}: the agent appended this while you were reading. It follows only when the viewport is already at the tail.`,
          },
        ],
      },
    ])
  }

  const streamAgentChunk = () => {
    setAddedMessages(current => {
      const activeStream = current.at(-1)
      if (activeStream?.role !== 'agent' || !activeStream.id.startsWith('playground-stream-')) {
        const streamId = `playground-stream-${current.length + 1}`
        return [
          ...current,
          {
            id: streamId,
            role: 'agent',
            finalized: false,
            createdAt: FIXTURE_NOW + (current.length + 1) * 1_000,
            parts: [
              {
                kind: 'text',
                id: `${streamId}-chunk-1`,
                text: 'Streaming chunk 1 arrived while this response is still running.',
                pending: true,
              },
            ],
          },
        ]
      }

      const streamingText = activeStream.parts.find(part => part.kind === 'text')
      if (streamingText === undefined) return current
      const sequence = (streamingText.text.match(/Streaming chunk/g) ?? []).length + 1
      return [
        ...current.slice(0, -1),
        {
          ...activeStream,
          parts: activeStream.parts.map(part =>
            part.id === streamingText.id
              ? {
                  ...streamingText,
                  text: `${streamingText.text}\n\nStreaming chunk ${sequence} extended the same AI turn. The viewport measured a taller final row while the response stayed attached to the live tail.`,
                }
              : part,
          ),
        },
      ]
    })
  }

  const submit = async (payload: SessionComposerSubmitPayload) => {
    const sequence = addedMessages.length + 1
    const createdAt = FIXTURE_NOW + sequence * 2_000
    setAddedMessages(current => [
      ...current,
      {
        id: `playground-submit-${sequence}`,
        role: 'input',
        source: 'prompt',
        sender: FIXTURE_SENDER,
        text: payload.value,
        createdAt,
      },
      {
        id: `playground-reply-${sequence}`,
        role: 'agent',
        finalized: true,
        createdAt: createdAt + 500,
        finalizedAt: createdAt + 1_200,
        parts: [
          {
            kind: 'text',
            id: `playground-reply-${sequence}-text`,
            text:
              surface === 'job'
                ? 'I added that direction to this job and returned the conversation to its live tail.'
                : 'Got it. This reply uses the same chat primitive as a job conversation.',
          },
        ],
      },
    ])
    setDraft('')
    setTailRevision(current => current + 1)
    return 'committed' as const
  }

  const reset = () => {
    setHistoryStart(INITIAL_START)
    setAddedMessages([])
    setDraft('')
    setLoadOlderFailed(false)
    setTailRevision(current => current + 1)
  }

  const jumpToHistory = () => {
    shellRef.current
      ?.querySelector<HTMLElement>('[data-virtualized-session-timeline]')
      ?.scrollTo({ top: 0, behavior: 'instant' })
  }

  const showShortHistoryFailure = () => {
    setHistoryStart(HISTORY.length - 2)
    setAddedMessages([])
    setLoadOlderFailed(true)
    setTailRevision(current => current + 1)
  }

  const isJob = surface === 'job'
  return (
    <main className="flex h-dvh min-h-[40rem] min-w-0 flex-col overflow-hidden bg-muted/30 p-3 text-foreground sm:p-6">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-3">
        <header className="flex shrink-0 flex-wrap items-end justify-between gap-3 px-1">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand">
              Shared chat primitive
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
              Jobs and default AI chat
            </h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              Send, append, and scroll to the top to exercise tail-following and paged history.
            </p>
          </div>
          <div
            className="flex flex-wrap items-center gap-1.5"
            aria-label="Chat playground controls"
          >
            {(['default', 'job'] as const).map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={surface === option}
                onClick={() => setSurface(option)}
                className="min-h-9 rounded-lg border bg-background px-3 text-xs font-medium aria-pressed:border-brand aria-pressed:bg-brand/10 aria-pressed:text-brand"
              >
                {option === 'default' ? 'Default AI chat' : 'Job'}
              </button>
            ))}
            <button
              type="button"
              onClick={jumpToHistory}
              className="min-h-9 rounded-lg border bg-background px-3 text-xs font-medium"
            >
              Scroll to history
            </button>
            <button
              type="button"
              onClick={appendAgentMessage}
              className="min-h-9 rounded-lg border bg-background px-3 text-xs font-medium"
            >
              Append AI turn
            </button>
            <button
              type="button"
              onClick={streamAgentChunk}
              className="min-h-9 rounded-lg border bg-background px-3 text-xs font-medium"
            >
              Stream AI chunk
            </button>
            <button
              type="button"
              onClick={reset}
              className="min-h-9 rounded-lg border bg-background px-3 text-xs font-medium"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={showShortHistoryFailure}
              className="min-h-9 rounded-lg border bg-background px-3 text-xs font-medium"
            >
              Short history failure
            </button>
          </div>
        </header>

        <section
          ref={shellRef}
          aria-label={isJob ? 'Job chat preview' : 'Default AI chat preview'}
          data-chat-playground-surface={surface}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-xl"
        >
          <header className="flex min-w-0 shrink-0 items-center gap-3 border-b px-3 py-2.5 sm:px-5">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${isJob ? 'bg-blue-500' : 'bg-emerald-500'}`}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {isJob ? 'Prepare the launch readiness report' : 'Chat with Milo'}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {isJob ? 'Job · running' : 'Default AI chat · always available'}
              </p>
            </div>
            <div className="shrink-0 text-right text-[11px] text-muted-foreground">
              <p data-loaded-message-count>{messages.length} loaded</p>
              <p>{historyStart === 0 ? 'Beginning reached' : 'More above'}</p>
            </div>
          </header>

          <VirtualizedSessionTimeline
            messages={messages}
            timelineLabel={isJob ? 'Job conversation' : 'Default AI conversation'}
            loadingEarlierLabel="Loading earlier messages"
            loadEarlierFailedLabel="Could not load earlier messages"
            retryEarlierLabel="Try again"
            hasOlder={historyStart > 0}
            isLoadingOlder={isLoadingOlder}
            loadOlderFailed={loadOlderFailed}
            loadOlder={loadOlder}
            tailRevision={tailRevision}
            duetName="Milo"
            agent={isJob ? { name: 'Milo', avatarKey: 'milo' } : undefined}
            authors={AUTHORS}
            imageUrl={() => '/icons/duet-avatar.png'}
            cwd={undefined}
            fileUrl={() => 'about:blank'}
          />

          <footer className="relative z-10 shrink-0 border-t bg-background p-2 sm:p-3">
            <div className="mx-auto w-full min-w-0 max-w-4xl">
              <SessionComposer
                mode="message"
                skills={{ items: [], labels: PICKER_LABELS }}
                agents={{ items: [], labels: PICKER_LABELS }}
                value={draft}
                onValueChange={setDraft}
                onSubmit={submit}
                input={{
                  label: isJob ? 'Continue this job' : 'Message Milo',
                  placeholder: isJob ? 'Continue this job…' : 'Message Milo…',
                  maxHeight: 144,
                }}
                quality={{
                  label: 'Quality',
                  value: 'balanced',
                  options: QUALITY_OPTIONS,
                  onValueChange: () => {},
                }}
                status={isJob ? 'Milo is working…' : undefined}
                submit={{ label: 'Send', submittingLabel: 'Sending…' }}
              />
            </div>
          </footer>
        </section>
      </div>
    </main>
  )
}
