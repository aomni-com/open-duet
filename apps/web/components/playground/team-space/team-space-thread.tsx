'use client'

import { BriefcaseIcon, CaretLeftIcon, DotsThreeIcon, PlusIcon } from '@phosphor-icons/react'
import { useRef, useState, type ReactNode } from 'react'

import type { ComposeBarSession } from '@repo/ui/components/compose-bar'
import { ComposeBarMentionPicker } from '@repo/ui/components/compose-bar/compose-bar-mention-picker'
import { cn } from '@repo/ui/lib/utils'

import { TEAM_ROSTER_LABELS, TeamSpaceComposer, rosterForRoom } from './team-space-composer'
import { liveJobCount, type TeamSession } from './team-space-fixture'
import { MemberFace, MemberFaces, StatusDot, UnreadCount } from './team-space-parts'
import { Transcript, usePinnedToBottom } from './team-space-transcript'
import { useWorkspace, useMember } from './team-space-workspace'

/**
 * One room.
 *
 * A person opens it, says what they want, and the orchestrator answers unless
 * somebody was named. Everything that follows is the same transcript a Slack
 * channel would show, with one addition the product cannot do without: when the
 * agent that answered hands the work on, the handoff is a row in the
 * conversation rather than something that happened out of sight. That row is
 * the whole argument for putting agents in a chat at all — the delegation is
 * the part a client needs to be able to read back — and it is a door: the
 * session it opened is the same one the jobs rail lists beside this pane.
 */
export function TeamSpaceThread({
  session,
  draft = '',
  mentionOpen = false,
  onBack,
  onOpenJob,
  jobsOpen = false,
  onToggleJobs,
}: {
  session: TeamSession
  draft?: string
  /** Draw the `@` roster over the composer, the way a typed `@` opens it. */
  mentionOpen?: boolean
  /** The way out, where there is no column to click. */
  onBack?: () => void
  onOpenJob?: (jobId: string) => void
  jobsOpen?: boolean
  onToggleJobs?: () => void
}) {
  const [value, setValue] = useState(draft)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const transcript = useRef<HTMLDivElement>(null)
  usePinnedToBottom(transcript, session.id)
  const workspace = useWorkspace()
  const inFlight = liveJobCount(workspace, session.id)
  /* Resolved here rather than in `composerSession`, which is a plain function
     and may not read the workspace: hooks belong to the component. */
  const runner = useMember(
    session.composer?.kind === 'working' ? session.composer.agentId : undefined,
  )
  const runnerFace =
    runner === undefined ? undefined : <MemberFace member={runner} className="size-5" />

  return (
    <>
      {/* The head of the same column the conversation and the composer are in.
          Left at the pane's edge it sat 40px adrift of every message under it —
          two left edges for one thread. */}
      <header className="flex h-12 shrink-0 items-center border-b border-border/70">
        <div className="mx-auto flex w-full max-w-[52rem] items-center gap-3 px-4 md:px-6">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to Home"
            className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground lg:hidden"
          >
            <CaretLeftIcon className="size-4" />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-sm font-semibold">{session.title}</h1>
            {session.live === true ? <StatusDot tone="live" /> : null}
          </div>
          <div className="min-w-0 flex-1" />
          <span className="hidden sm:block">
            <MemberFaces ids={session.memberIds} size="size-7" />
          </span>
          {/* The rail's own control lives here rather than in the rail, because a
            closed rail has nowhere to put it. The numeral counts work in
            flight, not history: finished jobs stay in the list and out of the
            badge.

            Absent, not disabled, where there is no rail to open — the
            arrangement that gives jobs a place of their own in the column has
            no use for a second front door in every chat header. */}
          {onToggleJobs === undefined ? null : (
            <button
              type="button"
              onClick={onToggleJobs}
              aria-pressed={jobsOpen}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                jobsOpen
                  ? 'border-border bg-muted text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <BriefcaseIcon className="size-3.5" />
              Jobs
              {inFlight > 0 ? <UnreadCount count={inFlight} /> : null}
            </button>
          )}
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
            <PlusIcon className="size-3.5" />
          </span>
          <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
            <DotsThreeIcon className="size-4" />
          </span>
        </div>
      </header>

      <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[52rem] pb-6">
          <ThreadIntro session={session} />
          <Transcript entries={session.entries} onOpenJob={onOpenJob} />
        </div>
      </div>

      <div className="shrink-0 pb-4 pt-1">
        {/* The same column the transcript rows are in, padded the same way, so the
            bar’s left edge lands on the avatar gutter rather than 24px inside it. */}
        <div className="relative mx-auto w-full max-w-[52rem] px-4 md:px-6">
          {mentionOpen ? (
            /* Rendered from fixed props rather than by typing into the editor:
               the popup is presentational, and driving a real caret into a
               baseline makes the picture depend on blink phase. */
            <ComposeBarMentionPicker
              suggestion={{
                trigger: 'agentMention',
                char: '@',
                query: '',
                items: rosterForRoom(workspace, session.memberIds),
                activeIndex: 0,
                select: () => {},
              }}
              labels={TEAM_ROSTER_LABELS}
              loading={false}
            />
          ) : null}
          <TeamSpaceComposer
            value={value}
            onValueChange={setValue}
            label={`Message ${session.title}`}
            roster={rosterForRoom(workspace, session.memberIds)}
            placeholder="Reply, or @ someone…"
            session={composerSession(session, runnerFace, todosExpanded, setTodosExpanded)}
            status={
              /* A phone has no room for a sentence beside the send button, and
                 half of one reads as a defect rather than as a hint. */
              <span className="hidden sm:inline">
                Everyone in this chat sees replies. Anything you name with @ is pulled in.
              </span>
            }
          />
        </div>
      </div>
    </>
  )
}

/**
 * The three things a room can be doing without you, in the compose bar's own
 * vocabulary. A room doing none of them supplies no session at all, and the bar
 * is just a bar.
 */
function composerSession(
  session: TeamSession,
  runnerFace: ReactNode,
  todosExpanded: boolean,
  onExpandedChange: (expanded: boolean) => void,
): ComposeBarSession | undefined {
  const state = session.composer
  if (state === undefined) return undefined
  if (state.kind === 'waiting') {
    return {
      key: `${session.id}:waiting`,
      phase: 'waiting',
      label: state.label,
      tone: 'text-[var(--km-ask,#bc3a22)]',
      question: state.question,
    }
  }
  if (state.kind === 'sleeping') {
    return {
      key: `${session.id}:sleeping`,
      phase: 'sleeping',
      label: state.label,
      tone: 'text-muted-foreground',
      hint: state.hint,
    }
  }
  return {
    key: `${session.id}:working`,
    phase: 'working',
    label: state.label,
    tone: 'text-[var(--km-live,#0b6ed1)]',
    avatar: runnerFace,
    todos: {
      label: 'Checklist',
      items: state.todos.map((todo, index) => ({ id: `${session.id}:${index}`, ...todo })),
      statusLabels: { pending: 'To do', active: 'Running', complete: 'Done', failed: 'Failed' },
      expanded: todosExpanded,
      expandLabel: 'Show the checklist',
      collapseLabel: 'Hide the checklist',
      onExpandedChange,
    },
    action: { label: 'Stop', ariaLabel: 'Stop the run', onSelect: () => {} },
  }
}

/**
 * What a room says about itself before its first message.
 *
 * It draws no rule under itself. The first thing below it is always a day
 * divider, which is a rule with the date sitting in it — two lines a
 * centimetre apart, and the first one saying nothing the second does not.
 * The date is the one that earns its keep, so the intro simply stops.
 */
function ThreadIntro({ session }: { session: TeamSession }) {
  return (
    <div className="px-4 pb-4 pt-8 md:px-6">
      <MemberFaces ids={session.memberIds} size="size-10" max={5} />
      <h2 className="mt-4 font-serif text-2xl font-normal italic tracking-tight">
        {session.title}
      </h2>
      <p className="mt-2 max-w-[62ch] text-sm leading-6 text-muted-foreground">{session.intro}</p>
    </div>
  )
}
