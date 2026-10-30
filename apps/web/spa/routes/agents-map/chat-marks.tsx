/* The map's stylesheet, for the state hues `StateDot` reads (see below). */
import '../../knowledge-map/knowledge-map.css'

import type { SessionBucket } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import { isSilent, toneOf } from '../../knowledge-map/palette'
import type { ItemState, Tone } from '../../knowledge-map/types'
import { StateDot } from './agent-surface/parts'

/**
 * What a conversation is asking of the reader, in at most two dots.
 *
 * One owner for every sidebar row that stands for a conversation: Build's
 * roster draws it for each agent's own chat, and Work's chat list draws it for
 * every chat. A mark that meant one thing in one sidebar and another in the
 * other would be worse than having it in only one of them, so neither draws
 * its own.
 *
 * Two marks, two questions, never folded into one. Unread is "something
 * happened here while you were away" and state is "what is happening here
 * now"; a finished chat can be unread exactly as a running one can be read.
 * Unread leads, because it is the one about the reader, and it wears the
 * unread hue (`--unread`, the map's amber) — the same mark the map hangs on an
 * agent's face, so "you have not seen this" looks alike on every surface.
 *
 * The state dot is the map's own vocabulary: `StateDot` on the tone the palette
 * gives the state, absent for the resting states rather than drawn in grey. A
 * row wearing nothing is a row saying nothing, which is what most rows should
 * be saying. Running also breathes, because a static dot reads as a status
 * light and this one means work is happening while you look.
 *
 * `data-unread` and `data-chat-state` are the handles a test or a screenshot
 * finds the marks by, wherever they are drawn. The marks carry `.km-hues`
 * themselves — a class that declares the palette's hues and nothing else — so
 * they draw in the right colours on any surface, including a portalled sheet
 * or a page the map never mounts on, without each caller remembering to scope
 * them.
 */
export function ChatMarks({
  unread,
  state,
  tone,
  label,
  className,
}: {
  unread: boolean
  /** the chat's state, carried onto the DOM so the mark can be asserted by name */
  state: ItemState | null
  /** null when the state is one the palette draws no mark for */
  tone: Tone | null
  label: string
  className?: string
}) {
  if (!unread && tone === null) return null
  return (
    <span className={cn('km-hues inline-flex shrink-0 items-center gap-1', className)}>
      {unread && (
        <>
          <span aria-hidden data-unread="" className="size-1.5 rounded-full bg-unread" />
          <span className="sr-only">{label}</span>
        </>
      )}
      {tone !== null && state !== null && (
        <span aria-hidden data-chat-state={state} className="relative inline-flex">
          {state === 'running' && (
            <span
              data-tone={tone}
              className="absolute inset-0 animate-ping rounded-full bg-[var(--km-tone,currentColor)] opacity-60 motion-reduce:hidden"
            />
          )}
          <StateDot tone={tone} />
        </span>
      )}
    </span>
  )
}

/** The mark a single conversation earns from its bucket: the state itself, and
 * the tone to draw it in, or nulls when the state is a resting one. */
export function chatMarkState(bucket: SessionBucket): {
  state: ItemState | null
  tone: Tone | null
} {
  return isSilent(bucket) ? { state: null, tone: null } : { state: bucket, tone: toneOf(bucket) }
}
