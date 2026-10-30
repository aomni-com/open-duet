'use client'

/* ============================================================================
   The rows the rail is made of, and the answers its read can give.

   Split from the column next door so the four answers a read can give are each
   a plain box a test and a fixture can mount inline, without a rail, a canvas
   or a camera around them. The column is photographed once, open, for the frame.

   It also settles what the rail is: rows in, clicks out. Everything below is
   presentational — no query, no destination, no idea what a camera is.
   ========================================================================= */
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { ComponentType } from 'react'

import type { MessagePreview } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../../../agents/agent-avatar'
import { AppAvatar } from '../../../apps/app-icon'
import type { Phase } from '../../../knowledge-map-data/use-workspace-map'
import { appNodeId } from '../../../knowledge-map/layout'
import { attention, isSilent, toneOf } from '../../../knowledge-map/palette'
import type { AppItem } from '../../../knowledge-map/types'
import { chatIsUnread } from '../../../knowledge-map/unread'
import { ChatMarks } from '../chat-marks'
import { railNodeId, type RailRow } from './roster'

export type AgentsRailListProps = {
  rows: readonly RailRow[]
  /** Keep the workspace navigator to one scannable line per agent. */
  compact?: boolean
  /** where the roster read got to. A failed one is never drawn as an empty drive. */
  phase: Phase
  onRetry: () => void
  continuation: {
    available: boolean
    loading: boolean
    failed: boolean
    load(): void
  }
  /** the carrier itself, so the host can send the reader to it */
  onOpen: (row: RailRow) => void
  /** one thing it can reach, and whose it is: an app opens on the card of the
   *  agent that encloses it, so the row is half the destination. */
  onOpenApp: (row: RailRow, app: AppItem) => void
  /**
   * Which *node* the pointer is on, so the host can mark it on the map.
   *
   * The rail and the ring are the same records twice, and this is what ties a
   * row to its face. A map node id rather than an agent id,
   * because every band of a row has a counterpart out there — the agent, each
   * app it can reach, each job in flight — and the ids come from the layout's
   * own builders so this file is never guessing at their shape.
   *
   * Reported rather than drawn here: the mark belongs to the canvas, and this
   * file has never known one exists.
   */
  onHoverNode?: (nodeId: string | null) => void
  /**
   * What this workspace calls the person behind a user id, or `undefined` while
   * the roster is still arriving — and for a member who has since left.
   *
   * A function rather than the roster itself, so this file never learns what a
   * workspace member looks like. The route passes the same lookup the
   * transcript resolves a bubble's author with, which is what stops the two
   * surfaces disagreeing about what somebody is called.
   */
  memberName: (userId: string) => string | undefined
  /**
   * The agent the reader is currently reading, marked on its row.
   *
   * An agent id rather than a slug, because that is what a row carries and
   * resolving one to the other here would put a second copy of the route
   * table in a presentational file.
   */
  selectedAgentId?: string
  /**
   * One row's description.
   *
   * A component rather than a string, because it is a file read per agent and a
   * loop cannot call a hook. The route passes one that reads `AGENTS.md`; a
   * fixture passes one that returns a string, and neither knows about the other.
   */
  description: ComponentType<{ row: RailRow }>
}

/**
 * How far the bands under the name are inset, so they hang off the same vertical
 * the name starts on: the row's own left padding, the avatar, and the gap
 * between the two.
 *
 * One constant because three places need the same answer, and the first term is
 * the row's own padding — retune the density and every hand-written copy has to
 * be found again, which is a drift no test sees and only a screenshot shows.
 * Carried as a style rather than a Tailwind arbitrary value because Tailwind
 * scans the source for class names and cannot see one a template built.
 */
const ROW_BAND_INSET = 'calc(1.25rem + 2rem + 0.75rem)' // px-5, the face, gap-3

export function AgentsRailList({
  rows,
  phase,
  onRetry,
  continuation,
  onOpen,
  onOpenApp,
  onHoverNode,
  memberName,
  selectedAgentId,
  description,
  compact = false,
}: AgentsRailListProps) {
  const t = useTranslations('duetApp.agentsRail')
  if (phase === 'pending') return <SkeletonRows compact={compact} />
  if (phase === 'error') {
    return (
      <div className="grid justify-items-center gap-3 px-6 py-12 text-center">
        <WarningCircleIcon
          aria-hidden
          size={22}
          weight="duotone"
          className="text-muted-foreground"
        />
        <p className="text-sm text-muted-foreground">{t('failed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    )
  }
  return (
    <>
      <ul>
        {rows.map(row => (
          <AgentRow
            key={row.agent.id}
            row={row}
            onOpen={onOpen}
            onOpenApp={onOpenApp}
            onHoverNode={onHoverNode}
            memberName={memberName}
            selected={row.agent.id === selectedAgentId}
            Description={description}
            compact={compact}
          />
        ))}
      </ul>
      {(continuation.available || continuation.failed) && (
        <div className="grid gap-2 border-t border-border/50 px-5 py-4">
          <div className="grid gap-1 text-xs text-muted-foreground">
            <p>{t('loaded', { count: rows.length })}</p>
            {continuation.failed ? <p>{t('moreFailed')}</p> : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={continuation.loading}
            onClick={continuation.load}
          >
            {continuation.loading
              ? t('loadingMore')
              : continuation.failed
                ? t('retryMore')
                : t('loadMore')}
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * The short label for whoever spoke, or `undefined` when nothing should be
 * drawn — the agent's own voice, or an identity this reader cannot resolve.
 *
 * Only a member is named. An app or a sending session is a machine speaking
 * into somebody's conversation, and its name would read as a second agent in a
 * list of agents; the words themselves say what happened, and the transcript is
 * where the full author belongs.
 */
function speaker(
  author: MessagePreview['author'],
  memberName: (userId: string) => string | undefined,
): string | undefined {
  return author.kind === 'user' ? memberName(author.userId) : undefined
}

function AgentRow({
  row,
  onOpen,
  onOpenApp,
  onHoverNode,
  memberName,
  selected,
  Description,
  compact,
}: {
  row: RailRow
  onOpen: (row: RailRow) => void
  onOpenApp: (row: RailRow, app: AppItem) => void
  onHoverNode?: ((nodeId: string | null) => void) | undefined
  memberName: (userId: string) => string | undefined
  selected: boolean
  Description: ComponentType<{ row: RailRow }>
  compact: boolean
}) {
  const t = useTranslations('duetApp.agentsRail')
  const said = row.preview === undefined ? undefined : speaker(row.preview.author, memberName)
  /* ---- the mark, and what it is about ----
     This row *is* the conversation you have with this carrier: clicking it
     opens that owner's own chat, and nothing on this column opens anything
     else. So the mark answers for that chat.

     It used to answer for the carrier's work instead, which put a live dot on a
     row whose conversation was silent and left a row whose conversation had
     asked a question wearing nothing. The reader could not act on either
     reading, because the work the dot was about was not on the other end of
     the click.

     Two marks, two questions, and they are deliberately not folded into one:
     unread is "something happened here while you were away", state is "what is
     happening here now", and a finished chat can be unread exactly as a running
     one can be read. `attention` and `isSilent` stay the owners of which states
     are worth drawing at all — the resting ones draw nothing, because a dot on
     every row is a dot nobody reads. */
  const chat = row.agent.chat
  const top = attention(chat).top
  const tone = top === null || isSilent(top) ? null : toneOf(top)
  const unread = chatIsUnread(chat)

  const ownerId = railNodeId(row)

  if (compact) {
    return (
      <li
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        className="group/row relative px-2.5"
        onPointerEnter={() => onHoverNode?.(ownerId)}
        onPointerLeave={() => onHoverNode?.(null)}
      >
        <button
          type="button"
          onClick={() => onOpen(row)}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none',
            'transition-[background-color,color,transform] duration-150 hover:bg-sidebar-accent/70 active:scale-[0.99]',
            'focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transform-none',
            selected
              ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <AgentAvatar
            avatarKey={row.agent.avatarKey}
            duet={row.duet}
            className="size-5 shrink-0"
            {...(row.agent.icon === undefined ? {} : { src: row.agent.icon })}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              /* Weight, and — only off the selected row — full ink. The selected
                 row already paints its own foreground against the accent wash,
                 and overriding that here would make "you are reading this one"
                 and "this one is unread" fight over the same colour. */
              unread && 'font-semibold',
              unread && !selected && 'text-foreground',
            )}
          >
            {row.agent.name}
          </span>
          <ChatMarks unread={unread} state={top} tone={tone} label={t('unread')} />
        </button>
      </li>
    )
  }

  return (
    /* The "you are here" mark. This file used to argue it was a consequence
       rather than an omission — the column was on screen only while the map was
       showing the drive, so there was never an agent unfolded for a row to be
       marked as — and it ended: "If the rail ever stays out beside an agent,
       that is when it needs one back." It does now, on every destination, so
       here it is.

       `aria-current` rather than a class alone, because the fact is "this is
       the one you are on" and the tint is only how it is said. */
    <li
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      /* "You are here", said twice: a rule down the leading edge and a wash of
         the same colour across the row. Two signals rather than one because the
         wash alone was a tint of grey a shade off the hover state — the reader
         could not tell the row they were *on* from the row they happened to be
         pointing at — and the rule alone is three pixels of colour against a
         band that can be three hundred tall.

         The fill is `muted` at full strength rather than a tint of the accent.
         This palette is very nearly monochrome — `--primary` carries a chroma
         of 0.026 in light and 0.006 in dark — so a six-per-cent wash of it is
         indistinguishable from the grey the row already paints on hover, which
         is the one comparison this mark has to win. Solid `muted` sits a clear
         step darker than hover's `muted/40`, and the rule beside it is the
         accent doing the work a hue would do in a palette that had one.

         The rule is a pseudo-element faded in, not a real border: a border
         appearing on selection would take three pixels out of the row's width
         and shuffle every name in the list sideways as the reader moved down
         it. For the same reason nothing here touches the type — the map's own
         picker settled that once (`knowledge-map.css`), a name is the same name
         whether or not you are looking at it, and weight is the one signal that
         resets the word's width. */
      className={cn(
        'group/row relative border-b border-border/50 last:border-b-0',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary',
        'before:opacity-0 before:transition-opacity before:duration-150 motion-reduce:before:transition-none',
        'data-[selected=true]:bg-muted data-[selected=true]:before:opacity-100',
      )}
      /* The whole band, not just the name — the apps strip and the job list
         under it are the same agent, and losing the mark halfway down a row
         you are still reading would read as a bug. Instant, with no delay of
         its own: sweeping the list is how you look for an agent, so the canvas
         has to keep up rather than lag a beat behind the pointer. */
      onPointerEnter={() => onHoverNode?.(ownerId)}
      onPointerLeave={() => onHoverNode?.(null)}
    >
      <button
        type="button"
        onClick={() => onOpen(row)}
        className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="shrink-0">
          <AgentAvatar
            avatarKey={row.agent.avatarKey}
            duet={row.duet}
            className="size-8"
            {...(row.agent.icon === undefined ? {} : { src: row.agent.icon })}
          />
        </span>
        {/* At least the avatar's own height, and centred inside it. A row for a
            carrier nobody has written to is then one line set against the middle
            of its portrait, rather than a name pinned to the top of a band with
            an empty second line under it — which reads as a line that failed
            rather than a row with nothing to add. A row that does carry a
            message overflows the minimum and fills it, so this costs nothing. */}
        <span className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
          {/* The name, what its conversation wants of you, and when this carrier
              last moved. Separated by more air than holds the two marks
              together — under about twice their own gap the three run as one
              string — and the marks sit against the name they belong to rather
              than against the clock. */}
          <span className="flex items-baseline gap-3">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm',
                unread ? 'font-semibold text-foreground' : 'font-medium',
              )}
            >
              {row.agent.name}
            </span>
            <ChatMarks
              unread={unread}
              state={top}
              tone={tone}
              label={t('unread')}
              className="self-center"
            />
            {row.when !== undefined && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {row.when}
              </span>
            )}
          </span>
          {/* One line of prose under the name, and which one it is depends on
              whether there is anything to say.

              Never both. Two lines of prose under a name is a paragraph, and a
              column of paragraphs is a column nobody scans — so the newest
              thing wins when there is one, and the description is what a row
              says about an agent you have never used, which is the more useful
              of the two things it could say about that agent.

              The swap is visible: a row can show the description on the frame
              before the activity read lands and the message a frame later. That
              is honest rather than avoidable — reserving the space would mean
              drawing a blank line under every name until the second read
              answers, which is worse than a line that improves.

              The compact workspace sidebar omits both; this detailed variant
              is used where the row has room to explain itself. */}
          {row.preview === undefined ? (
            /* Two lines for a description. At one line every description this
               product actually writes was cut mid-word at about two thirds —
               "and the we⋯" — so the row carried the *shape* of a description
               without ever delivering one, which is the whole reason it is on
               the row. */
            <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              <Description row={row} />
            </span>
          ) : (
            <span
              data-rail-preview
              data-preview-author={row.preview.author.kind}
              className="mt-0.5 truncate text-xs leading-5 text-foreground/80"
            >
              <span className="sr-only">
                {row.preview.author.kind === 'agent'
                  ? t('lastMessageFromAgent', { name: row.agent.name })
                  : t('lastMessageToAgent', { name: row.agent.name })}
              </span>
              {/* Who said it, in front of what they said — and only when it was
                  somebody other than the agent. The row is already under the
                  agent's name, so repeating it here is redundancy fifteen
                  pixels lower; an unprefixed line therefore *means* the agent
                  spoke, which is the same idiom every chat list uses for the
                  other party in a two-way conversation.

                  Never "You". The author is an identity rather than a
                  category, but a workspace has several members and this row
                  cannot tell which of them is reading it — so it says the
                  name, which is true for every reader.

                  A name that will not resolve draws nothing rather than a
                  placeholder: the words are what the row is for, and the
                  roster arriving a moment later should fill a gap, not correct
                  a lie. */}
              {said === undefined ? null : (
                <span className="text-muted-foreground">
                  {t('lastMessageSpeaker', { name: said })}
                </span>
              )}
              {row.preview.text}
            </span>
          )}
        </span>
      </button>

      <div>
        {/* What this carrier can reach. A reader scanning for "can this one even
            see the warehouse" should be able to answer it from the row.

            This is a two-app preview rather than a second app browser. Both
            controls always fit in the rail; rendering a third and clipping its
            label leaves an unlabeled pill that looks broken. Opening the agent
            remains the complete view of everything it can reach.

            Held on the name axis, so the two bands of a row — who, and what it
            reaches — share one vertical. */}
        {row.agent.apps.length > 0 && (
          <div
            data-rail-apps
            role="group"
            aria-label={t('agentApps', { name: row.agent.name })}
            /* `gap-2` below `sm` is not spacing taste: eight pixels is the
               clearance a 36px control needs to count as separable from the one
               beside it, and the strip is the densest row of controls on the page.
               The pointer gets the tighter six back. */
            style={{ paddingLeft: ROW_BAND_INSET }}
            className="flex gap-2 pb-1.5 sm:gap-1.5"
          >
            {row.agent.apps.slice(0, 2).map(app => (
              <button
                key={app.id}
                type="button"
                onClick={() => onOpenApp(row, app)}
                /* Enter runs outermost first, so the row has already claimed the
                   agent by the time this fires and the app wins. Leaving restores
                   the agent rather than clearing: the pointer is still inside the
                   row, and blanking the map for the gap between two pills would
                   flicker the mark off and straight back on. */
                onPointerEnter={() => onHoverNode?.(appNodeId(ownerId, app.id))}
                onPointerLeave={() => onHoverNode?.(ownerId)}
                /* 36 for a finger, 28 back for a pointer. Not the full 44: this
                   is a chip in a scrolling strip and a 44px one turns a row of
                   three into a second toolbar — 36 with real clearance beside it
                   is the trade, and the clearance is on the strip above. */
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card pr-3 pl-1.5 text-[11px] text-muted-foreground sm:h-7 sm:pr-2.5 sm:pl-1 transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <AppAvatar src={app.icon} name={app.title} className="size-5 shrink-0" />
                <span className="max-w-24 truncate sm:max-w-28">{app.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/* Five, and they reserve the detailed row's identity geometry while the read
   is in flight.

   Sized to the row it becomes, so the list that lands settles into the shape
   the bars were already drawing rather than stepping the moment the read
   answers. Under-drawing resolves into the truth; over-drawing has to be taken
   away again, and that reads as a fault (`spa/loading/README.md`).

   Exported so the cold-landing skeleton draws the roster's own bars rather than
   a lookalike. The pre-identity shell has no workspace and therefore no rows,
   but it does know the column will be there — and a skeleton that omits it
   paints a full-width sheet that shrinks the moment identity lands, which is
   the jump the whole loading rail exists to prevent. */
export function SkeletonRows({ compact = false }: { compact?: boolean } = {}) {
  if (compact) {
    return (
      <ul aria-hidden className="space-y-0.5 px-2.5">
        {[0, 1, 2, 3, 4].map(index => (
          <li key={index} className="flex h-8 items-center gap-2 rounded-md px-2">
            <span className="size-5 shrink-0 animate-pulse rounded-md bg-muted" />
            <span
              className="h-3 animate-pulse rounded-full bg-muted/70"
              style={{ width: `${5.75 + (index % 3) * 1.35}rem` }}
            />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul aria-hidden>
      {[0, 1, 2, 3, 4].map(index => (
        <li key={index} className="flex items-start gap-3 border-b border-border/50 px-5 py-2.5">
          <span className="grid shrink-0 justify-items-center gap-1">
            <span className="size-8 rounded-lg bg-muted" />
            {/* One width for all five: a monogram is two letters whatever the
                carrier is called, so bars of varying length would be promising
                a variation the rows that land do not have. */}
            <span className="h-2.5 w-5 rounded-full bg-muted/60" />
          </span>
        </li>
      ))}
    </ul>
  )
}
