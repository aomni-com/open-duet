'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useState } from 'react'
import { MemoryRouter } from 'react-router'

import appEn from '../../messages/en/app.json'
import { projectSession } from '../../spa/sessions/projection'
import {
  AUTHORED_BOUNDARY_EVENTS,
  COMPLETE_TRANSCRIPT_EVENTS,
  FAILED_TRANSCRIPT_EVENTS,
  LIVE_DOCUMENT_EPHEMERAL,
  LIVE_DOCUMENT_EVENTS,
  SLEEP_TRANSCRIPT_EVENTS,
  TRANSCRIPT_EVENTS,
  TRANSCRIPT_SNAPSHOT,
} from '../../spa/sessions/projection/fixtures'
import { createSessionAuthorDirectory } from '../../spa/sessions/session-authors'
import { SessionTimeline } from '../../spa/sessions/session-message'

const WORKBENCH_AUTHORS = createSessionAuthorDirectory({
  members: [
    {
      id: 'user_demo',
      email: 'david@example.com',
      name: 'David Zhang',
      role: 'owner',
      isBillingUser: true,
    },
  ],
})

const SCENARIOS = {
  authored: {
    label: 'Authored boundaries',
    status: 'complete',
    events: AUTHORED_BOUNDARY_EVENTS,
    ephemeral: [],
  },
  live: {
    label: 'Live + documents',
    status: 'running',
    events: LIVE_DOCUMENT_EVENTS,
    ephemeral: LIVE_DOCUMENT_EPHEMERAL,
  },
  ask: { label: 'Needs approval', status: 'ask', events: TRANSCRIPT_EVENTS, ephemeral: [] },
  sleep: {
    label: 'Sleeping',
    status: 'sleep',
    events: SLEEP_TRANSCRIPT_EVENTS,
    ephemeral: [],
  },
  complete: {
    label: 'Completed',
    status: 'complete',
    events: COMPLETE_TRANSCRIPT_EVENTS,
    ephemeral: [],
  },
  failed: {
    label: 'Interrupted / error',
    status: 'interrupted',
    events: FAILED_TRANSCRIPT_EVENTS,
    ephemeral: [],
  },
} as const
type Scenario = keyof typeof SCENARIOS

export function SessionProjectionWorkbench() {
  const [scenario, setScenario] = useState<Scenario>('ask')
  const [cursor, setCursor] = useState<number>(TRANSCRIPT_EVENTS.length)
  const [archived, setArchived] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [query, setQuery] = useState('deployment')
  const [title, setTitle] = useState<string>(TRANSCRIPT_SNAPSHOT.title)
  const [titleOrigin, setTitleOrigin] = useState<'excerpt' | 'auto' | 'manual'>('auto')
  const [notice, setNotice] = useState<string>()
  const selected = SCENARIOS[scenario]
  const projectedLabel = cursor < selected.events.length ? 'Running' : selected.label
  const projection = useMemo(
    () =>
      projectSession({
        snapshot: {
          ...TRANSCRIPT_SNAPSHOT,
          turnStatus: selected.status,
          lastEventSeq: selected.events.length,
          archive: {
            ...TRANSCRIPT_SNAPSHOT.archive,
            globalArchivedAt: archived ? 1_700_000_004_000 : null,
            reason: archived ? 'global' : null,
          },
        },
        durableEvents: selected.events.slice(0, cursor),
        ephemeralFrames: selected.ephemeral,
      }),
    [archived, cursor, selected],
  )
  const sessionMatches = title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

  const selectScenario = (next: Scenario) => {
    setScenario(next)
    setCursor(SCENARIOS[next].events.length)
    setNotice(undefined)
  }

  const toggleArchived = () => {
    const next = !archived
    setArchived(next)
    setNotice(next ? 'Session moved to Archived.' : 'Session restored to Active.')
  }

  const createSession = () => {
    setDeleted(false)
    setArchived(false)
    setQuery('')
    setTitle('Investigate the deployment failure')
    setTitleOrigin('excerpt')
    setScenario('ask')
    setCursor(TRANSCRIPT_EVENTS.length)
    setNotice('Session created from the first user message.')
  }

  const renameSession = () => {
    setTitle('Release log diagnosis')
    setTitleOrigin('manual')
    setQuery('')
    setNotice('Manual title saved. Future generated titles cannot replace it.')
  }

  const generateTitle = () => {
    if (titleOrigin === 'manual') {
      setNotice('Luna title ignored because the session was manually renamed.')
      return
    }
    setTitle('Diagnose staging deployment failure')
    setTitleOrigin('auto')
    setNotice('Luna title generated once from the first user message.')
  }

  const deleteSession = () => {
    setDeleted(true)
    setNotice('Session hidden immediately and queued for permanent deletion.')
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[19rem_1fr]">
        <aside className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-400">
                Contract workbench
              </p>
              <h1 className="mt-1 text-xl font-semibold">Sessions</h1>
            </div>
            <button
              onClick={createSession}
              className="rounded-lg bg-violet-500 px-3 py-2 text-sm font-semibold text-white"
            >
              New
            </button>
          </div>
          <label className="block text-xs font-medium text-slate-400" htmlFor="session-search">
            Search and filter
          </label>
          <input
            id="session-search"
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          <div className="mt-3 flex gap-2 text-xs">
            <span className="rounded-full bg-violet-500/20 px-2.5 py-1 text-violet-300">
              Active
            </span>
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-400">Archived</span>
          </div>
          {!deleted && sessionMatches ? (
            <article className="mt-5 rounded-xl border border-violet-500/50 bg-violet-500/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-sm font-medium">{title}</h2>
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${archived ? 'bg-amber-400' : scenario === 'failed' ? 'bg-red-400' : 'bg-emerald-400'}`}
                />
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {titleOrigin} title · {archived ? 'archived' : projectedLabel.toLowerCase()} · just
                now
              </p>
            </article>
          ) : (
            <p className="mt-5 rounded-xl border border-dashed border-slate-700 px-3 py-6 text-center text-xs text-slate-400">
              {deleted ? 'No sessions yet.' : 'No sessions match this search.'}
            </p>
          )}
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <button
              onClick={renameSession}
              disabled={deleted}
              className="min-h-11 rounded-lg border border-slate-700 px-2 py-2 disabled:opacity-40"
            >
              Rename
            </button>
            <button
              onClick={toggleArchived}
              disabled={deleted}
              className="min-h-11 rounded-lg border border-slate-700 px-2 py-2 disabled:opacity-40"
            >
              {archived ? 'Restore' : 'Archive'}
            </button>
            <button
              onClick={deleteSession}
              disabled={deleted}
              className="min-h-11 rounded-lg border border-red-900 px-2 py-2 text-red-300 disabled:opacity-40"
            >
              Delete
            </button>
          </div>
          <button
            onClick={generateTitle}
            disabled={deleted}
            className="mt-2 min-h-11 w-full rounded-lg border border-violet-800 px-3 py-2 text-xs text-violet-300 disabled:opacity-40"
          >
            Run Luna title
          </button>
          {notice ? (
            <p role="status" className="mt-3 text-xs text-emerald-300">
              {notice}
            </p>
          ) : null}
        </aside>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-2xl">
          <header className="border-b border-slate-800 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Durable cursor {projection.cursor} of {selected.events.length}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Projection state: {archived ? 'archived' : projectedLabel.toLowerCase()}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Projection scenario">
                {(Object.keys(SCENARIOS) as Scenario[]).map(value => (
                  <button
                    key={value}
                    onClick={() => selectScenario(value)}
                    className={`min-h-9 rounded-lg px-3 text-xs ${scenario === value ? 'bg-violet-500 text-white' : 'bg-slate-800 text-slate-300'}`}
                  >
                    {SCENARIOS[value].label}
                  </button>
                ))}
              </div>
            </div>
          </header>
          <div className="space-y-4 p-5">
            {deleted ? (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-10 text-center">
                <p className="text-sm font-medium text-slate-300">Session deleted</p>
                <p className="mt-1 text-xs text-slate-500">
                  It is hidden now while the bounded cleanup finishes.
                </p>
              </div>
            ) : null}
            {!deleted && projection.messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-8 text-center">
                <p className="text-sm font-medium text-slate-300">
                  No durable events at this cursor
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Advance the replay cursor to rebuild the transcript.
                </p>
              </div>
            ) : null}
            {!deleted && projection.messages.length > 0 ? (
              <MemoryRouter>
                <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
                  <div className="overflow-hidden rounded-xl border border-slate-700 bg-background text-foreground">
                    <SessionTimeline
                      messages={projection.messages}
                      duetName="Duet"
                      authors={WORKBENCH_AUTHORS}
                      imageUrl={() => '/icons/duet-avatar.png'}
                      cwd={undefined}
                      fileUrl={() => 'about:blank'}
                    />
                  </div>
                </NextIntlClientProvider>
              </MemoryRouter>
            ) : null}
          </div>
          <footer className="border-t border-slate-800 p-4">
            <div>
              <p className="mb-3 text-xs text-slate-400">Replay durable history through event</p>
              <div
                className="grid gap-0.5 sm:gap-2"
                style={{
                  gridTemplateColumns: `repeat(${selected.events.length + 1}, minmax(0, 1fr))`,
                }}
              >
                {Array.from({ length: selected.events.length + 1 }, (_, index) => (
                  <button
                    key={index}
                    onClick={() => setCursor(index)}
                    className={`min-h-11 w-full rounded-lg text-xs ${cursor === index ? 'bg-violet-500 text-white' : 'bg-slate-800 text-slate-300'}`}
                  >
                    {index}
                  </button>
                ))}
              </div>
            </div>
          </footer>
        </section>
      </div>
    </main>
  )
}
