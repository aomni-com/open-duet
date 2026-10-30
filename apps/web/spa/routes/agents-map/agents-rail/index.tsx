'use client'

/* The state hues. `StateDot` on the rows reads `--km-*`, which is declared on
   `.knowledge-map` — and this column is beside that element rather than inside
   it, so without the stylesheet and the `.km-hues` class the whole state axis
   falls back to `currentColor` and collapses to grey. */
import '../../../knowledge-map/knowledge-map.css'

/* Build's persistent navigator. It projects the map's existing records, keeps
   Work's sidebar footprint on desktop, and becomes a dismissible drawer only
   where that footprint would cover the selected destination. */
import {
  GraphIcon,
  PencilSimpleIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { CSSProperties } from 'react'

import { triggerHapticFeedback } from '@repo/ui/lib/haptics'
import { cn } from '@repo/ui/lib/utils'

import { AgentsRailList, type AgentsRailListProps } from './list'

/** Shared with the cold-landing skeleton so the map never jumps sideways. */
export const ROSTER_WIDTH = '17rem'

/** The head's three controls are one size and one shape; only their glyphs differ. */
export const ROSTER_ICON_BUTTON =
  'grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7'

export const ROSTER_HEAD_BOX = 'shrink-0 pt-[var(--drive-topbar-h,0px)]'

/**
 * The way back to a folded column, placed by whatever is standing beside it.
 *
 * Same shape as the three controls in the head, because it is the same control
 * — it is only somewhere else while the head it belongs to is off screen.
 */
export function OpenRoster({ onToggle }: { onToggle: () => void }) {
  const t = useTranslations('duetApp.agentsRail')
  return (
    <button
      type="button"
      aria-label={t('open')}
      title={t('open')}
      aria-expanded={false}
      onClick={() => {
        triggerHapticFeedback('light')
        onToggle()
      }}
      className={ROSTER_ICON_BUTTON}
    >
      <SidebarSimpleIcon aria-hidden size={17} />
    </button>
  )
}

export type RailDestination = { href: string; onOpen: () => void }

export type AgentsRailProps = AgentsRailListProps & {
  /** whether the column is drawn — resolved by `useRosterOut`, never by this file */
  out: boolean
  /** Controls the below-desktop drawer; desktop always keeps the rail present. */
  onToggle: () => void
  /** The persistent creation door beside the persistent roster. */
  onAddAgent: () => void
  /** Work and Build keep one sidebar footprint; these are its two mode doors. */
  workDestination: RailDestination
  /** The map is Build's home, above the agent list just as Home sits above Chats. */
  graphDestination: RailDestination
  graphSelected: boolean
}

export function AgentsRail({
  out,
  onToggle,
  onAddAgent,
  workDestination,
  graphDestination,
  graphSelected,
  ...list
}: AgentsRailProps) {
  const t = useTranslations('duetApp.agentsRail')
  const add = useTranslations('duetApp.addAgent')
  return (
    /* The drawer clears the canvas but remains below the window chrome. */
    <aside
      className="km-hues relative z-10 h-full lg:w-[var(--rail-w)]"
      style={{ '--rail-w': ROSTER_WIDTH } as CSSProperties}
    >
      <div
        /* Below `lg` this is an overlay; at `lg` it is a permanent layout column. */
        /* Folded away, it is still in the document so that it can *move* — but a
           list nobody can see is a list nobody should be able to tab into or
           hear read out, and `overflow: hidden` hides it from neither. `inert`
           takes it out of the tab order and out of the accessibility tree in one
           attribute, which is exactly the two things the clip cannot do. */
        {...(out ? {} : { inert: true })}
        aria-hidden={out ? undefined : true}
        className={cn(
          'absolute inset-y-0 left-0 z-10 w-screen max-w-[26rem] overflow-hidden bg-sidebar',
          'transition-transform duration-300 ease-out motion-reduce:transition-none',
          out ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
          'lg:z-auto lg:h-full lg:w-[var(--rail-w)] lg:max-w-none lg:translate-x-0 lg:shadow-none',
        )}
      >
        <div className="flex h-full w-screen max-w-[26rem] flex-col border-r border-border/70 bg-sidebar lg:w-[var(--rail-w)] lg:max-w-none">
          {/* Under the window's own bar rather than in it, and off the same
              variable the bar is sized by (`--drive-topbar-h`, set by
              `DriveShell`) so the two cannot drift apart. It falls back to zero
              for a host that mounts this surface without the product's chrome —
              the playground.

              the playground. */}
          <header className={ROSTER_HEAD_BOX}>
            <div className="px-2.5 py-2">
              <div className="grid grid-cols-2 rounded-md bg-muted/70 p-0.5">
                <a
                  href={workDestination.href}
                  onClick={event => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                      return
                    event.preventDefault()
                    workDestination.onOpen()
                  }}
                  className="flex items-center justify-center gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-3.5"
                >
                  <SquaresFourIcon aria-hidden /> {t('work')}
                </a>
                <span
                  aria-current="page"
                  className="flex items-center justify-center gap-1.5 rounded-[5px] bg-background px-2 py-1 text-xs font-semibold shadow-sm ring-1 ring-border [&_svg]:size-3.5"
                >
                  <PencilSimpleIcon aria-hidden weight="bold" /> {t('build')}
                </span>
              </div>
            </div>

            <div className="px-2.5 pb-3">
              <a
                href={graphDestination.href}
                aria-current={graphSelected ? 'page' : undefined}
                onClick={event => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                  event.preventDefault()
                  graphDestination.onOpen()
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                  graphSelected
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground',
                )}
              >
                <GraphIcon aria-hidden size={17} weight={graphSelected ? 'fill' : 'regular'} />
                {t('map')}
              </a>

              <div className="mt-5 flex items-center px-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                  {t('title')}
                </h2>
              </div>

              <button
                type="button"
                aria-label={t('close')}
                title={t('close')}
                aria-expanded
                onClick={() => {
                  triggerHapticFeedback('light')
                  onToggle()
                }}
                className={cn(
                  ROSTER_ICON_BUTTON,
                  'absolute top-[calc(var(--drive-topbar-h,0px)+0.5rem)] right-2.5 lg:hidden',
                )}
              >
                <SidebarSimpleIcon aria-hidden size={17} />
              </button>
            </div>
          </header>

          {/* The safe-area floor is for the phone, where this runs the whole
              height of the screen and its last row would otherwise share a hit
              area with the home indicator. It resolves to zero everywhere else. */}
          <nav
            aria-label={t('title')}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
          >
            <AgentsRailList {...list} compact />
            <button
              type="button"
              onClick={onAddAgent}
              className="mx-2.5 mt-0.5 flex w-[calc(100%-1.25rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-[28%] border border-dashed border-muted-foreground/60"
              >
                <PlusIcon size={12} weight="bold" />
              </span>
              {add('title')}
            </button>
          </nav>
        </div>
      </div>
    </aside>
  )
}
