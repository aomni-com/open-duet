'use client'

/* Hallmark · component: audit-log pane · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * pre-emit critique: P5 H5 E4 S5 R5 V4
 */

import { ArrowBendUpLeftIcon, CheckIcon, XIcon } from '@phosphor-icons/react'

import { cn } from '@repo/ui/lib/utils'

import { findSessionIn, pullInsFor, type TeamPullIn, type TeamVerdict } from './team-space-fixture'
import { MemberFace } from './team-space-parts'
import { ArtifactCard } from './team-space-transcript'
import { useMember, useWorkspace } from './team-space-workspace'

/**
 * Everywhere this agent has been pulled in, and what it said when it got there.
 *
 * The other surfaces answer questions about *work*: a chat is where it was
 * asked for, a job is one piece of it. Neither answers a question about the
 * *agent*, and "is Ledger any good at this" is the question a person who
 * maintains agents actually has. Its evidence is scattered across every room
 * the agent was ever named in, which is why it needs a view of its own.
 *
 * Three decisions worth stating, because each had an obvious alternative:
 *
 * **The output is the subject of the row, not the metadata.** A log would lead
 * with time and place. This leads with what the agent *said*, because that is
 * the thing being judged; where and when it said it is how you go and check.
 *
 * **The verdict lives on the row, not behind it.** Marking an answer right or
 * wrong is the whole reason to read this, so it is two controls at rest — not
 * a hover reveal, which would hide the primary action of the surface behind a
 * pointer, and not a menu, which would put a click in front of a judgement.
 *
 * **Marking is not the end of it.** A verdict is a bit; what improves an agent
 * is being told *why*. So every row can be carried into the conversation on the
 * left, where the maintainer says what should have happened instead — and a
 * verdict pressed here writes the opening of that sentence rather than closing
 * the subject.
 */
export function TeamSpaceAgentHistory({
  agentId,
  verdicts,
  onVerdict,
  onBringIntoChat,
  broughtId,
}: {
  agentId: string
  /** Verdicts the reader has set this session, over whatever the fixture carried. */
  verdicts: Readonly<Record<string, TeamVerdict>>
  onVerdict: (entry: TeamPullIn, verdict: TeamVerdict) => void
  onBringIntoChat: (entry: TeamPullIn) => void
  /** The row most recently carried across, so it can acknowledge the click. */
  broughtId?: string
}) {
  const entries = pullInsFor(agentId)
  const verdictOf = (entry: TeamPullIn): TeamVerdict | undefined =>
    verdicts[entry.id] ?? entry.verdict

  /* Counted, never asserted. Every number on this surface is derived from the
     rows under it, so it cannot drift from what the reader can see. */
  const reviewed = entries.filter(entry => verdictOf(entry) !== undefined).length
  const wrong = entries.filter(entry => verdictOf(entry) === 'wrong').length

  if (entries.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-xs">
          <p className="text-sm font-medium">Nothing to review yet</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Once this agent is named in a chat, every answer it gives shows up here for you to mark.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The same reading column every other face of the agent uses. Left to
          fill the pane, an output ran to a 120-character measure at 1440px —
          the widest text in the app, on the surface whose whole job is being
          read carefully. */}
      <div className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold">Pulled in {entries.length} times</h2>
          <p className="text-xs text-muted-foreground">
            {reviewed} reviewed
            {wrong > 0 ? `, ${wrong} marked wrong` : null}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ol className="space-y-3">
          {entries.map(entry => (
            <li key={entry.id}>
              <PullInCard
                entry={entry}
                verdict={verdictOf(entry)}
                brought={entry.id === broughtId}
                onVerdict={verdict => onVerdict(entry, verdict)}
                onBring={() => onBringIntoChat(entry)}
              />
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function PullInCard({
  entry,
  verdict,
  brought,
  onVerdict,
  onBring,
}: {
  entry: TeamPullIn
  verdict: TeamVerdict | undefined
  brought: boolean
  onVerdict: (verdict: TeamVerdict) => void
  onBring: () => void
}) {
  const workspace = useWorkspace()
  const asker = useMember(entry.askedById)
  const chat = findSessionIn(workspace, entry.chatId)

  return (
    <article
      data-verdict={verdict}
      className={cn(
        'relative overflow-hidden rounded-xl border bg-card transition-colors',
        /* A marked row carries its verdict on its own edge rather than in a
           badge: the mark has to survive being scanned past, and a strip down
           the side is readable at a glance where a chip is not. */
        verdict === 'wrong'
          ? 'border-l-2 border-l-[var(--km-ask,#bc3a22)] border-y-border/75 border-r-border/75'
          : verdict === 'right'
            ? 'border-l-2 border-l-success border-y-border/75 border-r-border/75'
            : 'border-border/75',
        brought && 'ring-2 ring-brand/40',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 text-xs text-muted-foreground">
        {asker ? <MemberFace member={asker} className="size-4 shrink-0" /> : null}
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground/75">{asker?.name}</span> in{' '}
          <span className="font-medium text-foreground/75">{chat.title}</span>
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
          {entry.day} {entry.at}
        </span>
      </div>

      <p className="px-4 pt-1 text-xs italic text-muted-foreground">“{entry.ask}”</p>

      {/* The subject of the row. Everything above is where to go and check it. */}
      <p className="px-4 pt-2 text-sm leading-6 text-foreground">{entry.output}</p>

      {entry.artifacts !== undefined ? (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {entry.artifacts.map(artifact => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : null}

      {entry.note !== undefined ? (
        <p className="mt-3 border-t border-border/60 bg-muted/30 px-4 py-2 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground/75">You said:</span> {entry.note}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 px-4 py-2">
        <VerdictButton tone="right" on={verdict === 'right'} onSelect={() => onVerdict('right')} />
        <VerdictButton tone="wrong" on={verdict === 'wrong'} onSelect={() => onVerdict('wrong')} />
        <button
          type="button"
          onClick={onBring}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px"
        >
          <ArrowBendUpLeftIcon className="size-3.5" />
          Bring into chat
        </button>
      </div>
    </article>
  )
}

/**
 * Right and wrong, as a pair of toggles.
 *
 * The colours are a deliberate departure from the state palette next door.
 * `palette.ts` budgets two saturated hues for what a *machine* is doing —
 * running and needs-you. A verdict is not that: it is a person's judgement of
 * an answer, a different axis entirely, so it reads from the product's own
 * `success` and the rust it shares with needs-you rather than inventing a third
 * state colour. Pressed is filled; unpressed is a hairline, so the pair reads
 * as one control with a position rather than two buttons.
 */
function VerdictButton({
  tone,
  on,
  onSelect,
}: {
  tone: TeamVerdict
  on: boolean
  onSelect: () => void
}) {
  const right = tone === 'right'
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={on}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px',
        on && right && 'border-transparent bg-success/12 text-success',
        on &&
          !right &&
          'border-transparent bg-[color-mix(in_oklab,var(--km-ask,#bc3a22)_12%,transparent)] text-[var(--km-ask,#bc3a22)]',
        !on && 'border-border/70 text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {right ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
      {right ? 'Right' : 'Wrong'}
    </button>
  )
}
