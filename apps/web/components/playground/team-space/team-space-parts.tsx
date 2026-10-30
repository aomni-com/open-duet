'use client'

/* The state hexes below stand outside the map, so they need the class that
   declares them; see `.km-hues` in this stylesheet. */
import '../../../spa/knowledge-map/knowledge-map.css'

import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../../../spa/agents/agent-avatar'
import { UserAvatar } from '../../../spa/identity/identity-avatar'
import { findMemberIn, type TeamMember } from './team-space-fixture'
import { useWorkspace } from './team-space-workspace'

/**
 * One face, whoever it belongs to. People and agents are addressed the same way
 * in a session, so they are drawn by one component — the only difference is
 * which portrait generator the seed goes through, and that the orchestrator
 * wears the product's own mark rather than a drawn robot.
 */
export function MemberFace({ member, className }: { member: TeamMember; className?: string }) {
  if (member.kind === 'person') {
    return <UserAvatar name={member.name} className={className} />
  }
  return (
    <AgentAvatar
      avatarKey={member.slug}
      duet={member.orchestrator === true}
      className={className}
    />
  )
}

/** A cluster of faces, overlapped, with the overflow counted. */
export function MemberFaces({
  ids,
  max = 4,
  size = 'size-6',
  ringClassName = 'ring-background',
}: {
  ids: readonly string[]
  max?: number
  size?: string
  /** The colour the overlap is cut out of — the surface the stack sits on. */
  ringClassName?: string
}) {
  const workspace = useWorkspace()
  const members = ids
    .map(id => findMemberIn(workspace, id))
    .filter((member): member is TeamMember => member !== undefined)
  const shown = members.slice(0, max)
  const rest = members.length - shown.length
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map(member => (
        <MemberFace key={member.id} member={member} className={cn(size, 'ring-2', ringClassName)} />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            size,
            'grid place-items-center rounded-[28%] bg-muted text-[10px] font-semibold text-muted-foreground ring-2',
            ringClassName,
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Prose with `@slug` turned into the chip the composer showed.
 *
 * The product does this through the Markdown pipeline and a shared tag codec —
 * see `spa/sessions/session-mention-chips.ts`. A fixture that imported it would
 * have to carry the tag grammar in every fixture string; what is being judged
 * here is the room, so the chip is matched off the roster directly and wears
 * the same class the real renderer gives it.
 */
export function MentionText({ body }: { body: string }) {
  const workspace = useWorkspace()
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of body.matchAll(/@([a-z0-9-]+)/gi)) {
    const member = findMemberIn(workspace, (match[1] ?? '').toLowerCase())
    if (member === undefined) continue
    const start = match.index ?? 0
    if (start > cursor) nodes.push(body.slice(cursor, start))
    nodes.push(
      <span
        key={`${member.id}-${start}`}
        className="rounded bg-brand/[0.12] px-1 font-medium text-brand"
      >
        @{member.kind === 'agent' ? member.name : member.name.split(' ')[0]}
      </span>,
    )
    cursor = start + match[0].length
  }
  if (cursor < body.length) nodes.push(body.slice(cursor))
  return <>{nodes}</>
}

/**
 * What a row is doing, as one mark.
 *
 * The colours are not chosen here. The workspace already has a state
 * vocabulary and it is written down in `spa/knowledge-map/palette.ts`: two
 * saturated states and no more — **running** is electric blue and **needs you**
 * is rust, deliberately a cool and a warm so a machine getting on with it and
 * an alarm never have to be told apart by shade. Waiting on a clock is *not* a
 * third colour; the palette gives it the resting tone and separates it by
 * glyph, which is why it is a ring here rather than a dot. Unread is its own
 * axis again — amber, the one hue the map vacated when running moved off it.
 *
 * The hexes come from `.km-hues` in `knowledge-map.css`, which exists for
 * exactly this: drawing the map's state marks while standing outside the map.
 * The shell puts that class on its root, so these are the same values the
 * canvas next door paints with rather than a second set that would drift.
 *
 * One addition the map does not make: a mark for a row where nothing is
 * happening. The map draws nothing there on purpose — "decorating the normal
 * case is how a map turns into a dashboard" — but a *list* is a different
 * surface with a different problem. Every row needs the same left gutter or the
 * titles do not line up, and a faint mark reads as a considered "nothing"
 * where an empty gap reads as something that failed to render.
 */
export function StatusDot({
  tone,
  className,
}: {
  tone: 'live' | 'asking' | 'sleeping' | 'idle' | 'setup'
  className?: string
}) {
  if (tone === 'sleeping') {
    return (
      <span
        className={cn(
          'inline-block size-1.5 shrink-0 rounded-full border border-muted-foreground/55',
          className,
        )}
      />
    )
  }
  const fill =
    tone === 'live'
      ? 'var(--km-live, #0b6ed1)'
      : tone === 'asking'
        ? 'var(--km-ask, #bc3a22)'
        : /* nothing happening, and nothing wrong: the quietest mark that is
             still a mark. */
          'oklch(var(--muted-foreground) / 0.28)'
  return (
    <span className={cn('relative flex size-1.5 shrink-0', className)}>
      {tone === 'live' ? (
        <span
          style={{ backgroundColor: fill }}
          className="absolute inline-flex size-full animate-ping rounded-full opacity-70"
        />
      ) : null}
      <span
        style={{ backgroundColor: fill }}
        className="relative inline-flex size-full rounded-full"
      />
    </span>
  )
}

/**
 * How many messages are waiting, in the one colour left for saying so.
 *
 * Amber rather than the brand blue it used to be. Blue already means *running*
 * one gutter to the left of this badge, and two blues on one row meaning two
 * different things is the confusion the state palette exists to prevent.
 */
export function UnreadCount({ count }: { count: number }) {
  return (
    <span
      style={{ backgroundColor: 'var(--km-unread, #d97316)' }}
      /* `leading-none` and a flex box rather than `grid place-items-center`:
         at 10px the glyph box carries about 5px of half-leading, which pushed
         every numeral a pixel and a half below the middle of its pill. */
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums text-white"
    >
      {count}
    </span>
  )
}

/**
 * A state, said in the workspace's own two colours.
 *
 * `palette.ts` allows exactly two saturated states — running is blue, needs-you
 * is rust — and gives everything else the resting tone. The pill honours that
 * rather than reaching for a third and a fourth hue: a violet "on a clock" and
 * an emerald "running" were two colours this product does not use, sitting next
 * to the map that does.
 */
export function statePillClass(state: 'asking' | 'running' | 'scheduled' | 'done'): string {
  if (state === 'asking')
    return 'bg-[color-mix(in_oklab,var(--km-ask,#bc3a22)_12%,transparent)] text-[var(--km-ask,#bc3a22)]'
  if (state === 'running')
    return 'bg-[color-mix(in_oklab,var(--km-live,#0b6ed1)_12%,transparent)] text-[var(--km-live,#0b6ed1)]'
  return 'bg-muted text-muted-foreground'
}
