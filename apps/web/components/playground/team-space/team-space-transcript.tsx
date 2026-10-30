'use client'

import {
  ArrowBendDownRightIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  CircleNotchIcon,
  FileTextIcon,
  TableIcon,
} from '@phosphor-icons/react'
import { useEffect, type RefObject } from 'react'

import { cn } from '@repo/ui/lib/utils'

import type { TeamArtifact, TeamEntry } from './team-space-fixture'
import { MemberFace, MentionText, statePillClass, StatusDot } from './team-space-parts'
import { useMember } from './team-space-workspace'

/**
 * The rows a conversation is made of, owned once.
 *
 * A chat and a job are the same kind of thing — a session — so they are drawn
 * by the same code. Everything that differs between them is the frame around
 * this: what the header says, what ground it sits on, and who the composer is
 * talking to.
 */
export function Transcript({
  entries,
  onOpenJob,
}: {
  entries: readonly TeamEntry[]
  /** Absent inside a job: a job's own transcript has no further handoffs to open. */
  onOpenJob?: (jobId: string) => void
}) {
  return entries.map(entry =>
    entry.kind === 'day' ? (
      <DayDivider key={entry.id} label={entry.label} />
    ) : entry.kind === 'handoff' ? (
      <HandoffRow key={entry.id} entry={entry} onOpen={onOpenJob} />
    ) : (
      <MessageRow key={entry.id} entry={entry} />
    ),
  )
}

/**
 * Hold a conversation at its newest message while the surface settles.
 *
 * Held rather than set once. Several things move under a transcript as it
 * arrives: the composer measures its own chrome and takes that height back off
 * the pane, the mention picker's active row calls `scrollIntoView` — which
 * walks every scrollable ancestor, this one included — and a phone spends long
 * enough laying the column out that all of it lands after any single effect has
 * run. So the bottom is held until either the settling window closes or the
 * reader takes over, whichever comes first; the first wheel, drag or key hands
 * the scroll back, and the hold never fights a person.
 */
export function usePinnedToBottom(pane: RefObject<HTMLDivElement | null>, key: string) {
  useEffect(() => {
    const element = pane.current
    if (element === null) return

    let handle = 0
    let frames = 0
    const pin = () => {
      element.scrollTop = element.scrollHeight
    }
    const release = () => {
      cancelAnimationFrame(handle)
      frames = Infinity
    }
    pin()
    handle = requestAnimationFrame(function tick() {
      pin()
      frames += 1
      if (frames < 180) handle = requestAnimationFrame(tick)
    })

    const observer = new ResizeObserver(() => {
      if (frames < 180) pin()
    })
    observer.observe(element)
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild)

    for (const event of ['wheel', 'pointerdown', 'keydown'] as const) {
      element.addEventListener(event, release, { passive: true })
    }
    return () => {
      release()
      observer.disconnect()
      for (const event of ['wheel', 'pointerdown', 'keydown'] as const) {
        element.removeEventListener(event, release)
      }
    }
  }, [pane, key])
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="relative px-4 py-4 md:px-6">
      <div className="absolute inset-x-4 top-1/2 h-px bg-border/70 md:inset-x-6" />
      <div className="relative flex justify-center">
        <span className="rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  )
}

function MessageRow({ entry }: { entry: Extract<TeamEntry, { kind: 'message' }> }) {
  const author = useMember(entry.authorId)
  if (author === undefined) return null
  const badge =
    author.kind === 'agent'
      ? author.orchestrator === true
        ? 'Orchestrator'
        : 'Agent'
      : author.external === true
        ? 'Guest'
        : undefined

  /* A second line from the same author in the same breath is a continuation,
     not a new speaker: it keeps the text column and gives up the portrait and
     the name. Rhythm carries the grouping — a continuation sits close to what
     it continues. */
  const stacked = entry.stacked === true

  return (
    <article className={cn('group relative min-w-0 px-4 md:px-6', stacked ? 'py-0.5' : 'py-2.5')}>
      <div className="flex min-w-0 items-start gap-3">
        {stacked ? (
          <span aria-hidden className="mt-0.5 size-9 shrink-0" />
        ) : (
          <MemberFace member={author} className="mt-0.5 size-9" />
        )}
        <div className="w-0 min-w-0 flex-1">
          <div className={cn('flex min-w-0 items-center gap-2 pb-1', stacked && 'hidden')}>
            <span className="min-w-0 truncate text-sm font-semibold">{author.name}</span>
            {badge !== undefined ? (
              <span
                className={cn(
                  'shrink-0 rounded-sm px-1 text-[10px] font-semibold uppercase leading-4 tracking-wide',
                  author.kind === 'agent'
                    ? 'bg-brand/[0.12] text-brand'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {badge}
              </span>
            ) : null}
            <time className="shrink-0 text-xs text-muted-foreground">{entry.at}</time>
          </div>
          <p className="text-sm leading-6 text-foreground">
            <MentionText body={entry.body} />
          </p>
          {entry.artifacts !== undefined ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {entry.artifacts.map(artifact => (
                <ArtifactCard key={artifact.id} artifact={artifact} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}

/**
 * The delegation, made readable — and the door to the job it opened.
 *
 * Indented into the text column rather than given a row of its own, because it
 * is something the agent above it did, not a third party speaking. The steps
 * are here rather than behind a disclosure for the reason the surface exists at
 * all: what an agent is doing on a client's behalf has to be legible without
 * anyone opening a console. Clicking it opens the session it dispatched, which
 * is the same session the jobs rail lists — one job, two doors.
 */
function HandoffRow({
  entry,
  onOpen,
}: {
  entry: Extract<TeamEntry, { kind: 'handoff' }>
  onOpen?: (jobId: string) => void
}) {
  const from = useMember(entry.fromId)
  const to = useMember(entry.toId)
  if (from === undefined || to === undefined) return null

  return (
    <div className="px-4 py-1.5 md:px-6">
      <button
        type="button"
        onClick={() => onOpen?.(entry.jobId)}
        disabled={onOpen === undefined}
        className={cn(
          'group/handoff ml-12 block w-[calc(100%-3rem)] min-w-0 overflow-hidden rounded-lg border border-border/75 bg-muted/25 text-left transition-colors',
          onOpen !== undefined && 'hover:border-border hover:bg-muted/50',
        )}
      >
        <span className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <ArrowBendDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <MemberFace member={from} className="size-5" />
          <span className="shrink-0 text-xs font-semibold">{from.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">handed this to</span>
          <MemberFace member={to} className="size-5" />
          <span className="min-w-0 truncate text-xs font-semibold">{to.name}</span>
          <span
            className={cn(
              'ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              statePillClass(entry.status === 'running' ? 'running' : 'done'),
            )}
          >
            {entry.status === 'running' ? <StatusDot tone="live" /> : null}
            {entry.status === 'running' ? 'Running' : 'Finished'}
          </span>
        </span>
        <span className="block px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 text-sm font-medium leading-5">{entry.task}</span>
            {onOpen !== undefined ? (
              <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors group-hover/handoff:text-foreground">
                Open job
                <ArrowSquareOutIcon className="size-3" />
              </span>
            ) : null}
          </span>
          <span className="mt-2.5 block space-y-1.5">
            {entry.steps.map(step => (
              <StepRow key={step.label} label={step.label} state={step.state} />
            ))}
          </span>
        </span>
      </button>
    </div>
  )
}

/** One line of a checklist, in the transcript card and in the job's own header. */
export function StepRow({ label, state }: { label: string; state: 'done' | 'active' | 'todo' }) {
  return (
    <span className="flex items-center gap-2 text-xs">
      <span
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-full',
          state === 'done'
            ? 'bg-muted text-muted-foreground'
            : state === 'active'
              ? 'bg-[color-mix(in_oklab,var(--km-live,#0b6ed1)_15%,transparent)] text-[var(--km-live,#0b6ed1)]'
              : 'bg-muted text-muted-foreground/60',
        )}
      >
        {state === 'done' ? (
          <CheckIcon className="size-2.5" weight="bold" />
        ) : state === 'active' ? (
          <CircleNotchIcon className="size-2.5 animate-spin" weight="bold" />
        ) : (
          <span className="size-1 rounded-full bg-current" />
        )}
      </span>
      <span className={cn(state === 'active' ? 'text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
    </span>
  )
}

export function ArtifactCard({ artifact }: { artifact: TeamArtifact }) {
  return (
    <span className="flex min-w-0 max-w-[19rem] items-center gap-2.5 rounded-lg border border-border/75 bg-card px-3 py-2">
      <span
        aria-hidden
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4',
          /* An artifact's tile says what *kind* of thing it is, which is the
             other axis entirely — low chroma by rule, and never one of the two
             saturated state colours. */
          artifact.tone === 'sheet'
            ? 'bg-[#26775b]/10 text-[#26775b] dark:text-[#5fae90]'
            : artifact.tone === 'app'
              ? 'bg-[#356697]/10 text-[#356697] dark:text-[#7ba7d4]'
              : 'bg-muted text-muted-foreground',
        )}
      >
        {artifact.tone === 'sheet' ? <TableIcon /> : <FileTextIcon />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{artifact.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{artifact.meta}</span>
      </span>
    </span>
  )
}
