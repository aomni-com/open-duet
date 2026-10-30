'use client'

import type { Icon } from '@phosphor-icons/react'
import { type KeyboardEvent, type ReactNode, useRef } from 'react'

import { cn } from '@repo/ui/lib/utils'

import type { DriveTab } from './drive-routes'
import { rovingTabIndexForKey } from './tab-keyboard'

export type DriveTopBarTab = {
  readonly value: DriveTab
  readonly label: string
  readonly icon: Icon
}

/**
 * How far down a surface has to start to clear the floating bar.
 *
 * Put it on the thing that *scrolls*, not on a wrapper around it: on the
 * scroller it is a first-screen offset that the content then travels through,
 * so a list slides under frosted glass the way it does under an OS title bar.
 * On a wrapper it is a dead band the content is clipped at, which is the same
 * geometry and none of the effect.
 *
 * A canvas takes the window whole and skips this: it is meant to show through.
 */
export const DRIVE_TOPBAR_CLEARANCE = 'pt-[var(--drive-topbar-h)]'

/**
 * The window: one frosted bar, and everything else underneath it.
 *
 * The bar is out of flow. It floats, and the route runs the full height of the
 * window behind it — which is the whole reason the glass reads as glass. A bar
 * that owns its own band above the content has nothing to blur, and
 * `backdrop-filter` over a flat colour is an expensive way to draw that colour
 * again. `--drive-topbar-h` is the one number the bar and everything under it
 * both read, so the two cannot drift apart.
 */
export function DriveShell({
  topBar,
  bottomLeft,
  children,
}: {
  topBar: ReactNode
  /** Optional account footer used by the Build shell. */
  bottomLeft?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      data-drive-shell="true"
      /* 3.75rem on a phone, and the extra quarter-rem is not styling: the bar's
         own controls have to clear 44px, and at 3.5rem a 44px tab has no room to
         breathe inside it. Four pixels of window is what a shell whose every
         control a thumb can actually hit costs. The pointer keeps its 3rem. */
      className="relative h-[var(--product-viewport-height,100dvh)] min-h-0 min-w-0 overflow-hidden bg-background text-foreground [--drive-topbar-h:3.75rem] sm:[--drive-topbar-h:3rem]"
    >
      {topBar}
      {bottomLeft !== undefined ? (
        <div
          data-drive-bottom-left="true"
          className="absolute inset-x-0 bottom-0 z-20 hidden w-[17rem] border-r border-border/70 bg-sidebar lg:block"
        >
          {bottomLeft}
        </div>
      ) : null}
      <div data-drive-shell-content="true" className="h-full min-h-0 min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  )
}

export function DriveTopBar({
  tabs,
  activeTab,
  onSelectTab,
  leftSlot,
  rightSlot,
  label,
  disabled = false,
}: {
  tabs: readonly DriveTopBarTab[]
  activeTab: DriveTab | null
  onSelectTab?: (tab: DriveTab) => void
  leftSlot: ReactNode
  rightSlot: ReactNode
  label: string
  disabled?: boolean
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rovingTab = activeTab ?? tabs[0]?.value

  const selectAndFocus = (index: number) => {
    if (disabled || onSelectTab === undefined) return
    const tab = tabs[index]
    if (tab === undefined) return
    onSelectTab(tab.value)
    tabRefs.current[index]?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return
    const destination = rovingTabIndexForKey(event.key, index, tabs.length)
    if (destination === null) return
    event.preventDefault()
    selectAndFocus(destination)
  }

  return (
    /* Pinned to the top of the window rather than stacked above it — see
       `DriveShell`. The bar itself carries no fill: the glass is a layer of its
       own underneath, so the bar is a row of controls standing on it. */
    <header className="absolute inset-x-0 top-0 z-30 flex h-[var(--drive-topbar-h)] items-center gap-2 px-3 text-header-foreground sm:gap-3">
      <DriveTopBarGlass />

      <div
        data-drive-topbar-slot="left"
        className="relative flex min-w-0 flex-1 basis-0 items-center overflow-hidden"
      >
        {leftSlot}
      </div>

      {/* The tabs ride the glass in a track of their own. On a bar that no
          longer has a colour, a chip cannot borrow contrast from its
          background, so the segment supplies its own: an alpha track over
          whatever composited beneath it, and a raised pill on top of that.
          Both are stated in alpha of the *foreground*, which is the only way
          one number reads the same in a light theme and a dark one — a chrome
          tone like `--header-accent` is a near-white in the light theme and
          would vanish into the pale glass it now sits on. */}
      <div
        role="tablist"
        aria-label={label}
        className="relative flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.055] p-1 ring-1 ring-inset ring-foreground/[0.07] sm:p-0.5"
      >
        {tabs.map((tab, index) => {
          const selected = tab.value === activeTab
          const Icon = tab.icon
          return (
            <button
              key={tab.value}
              ref={node => {
                tabRefs.current[index] = node
              }}
              id={`drive-tab-${tab.value}`}
              type="button"
              role="tab"
              disabled={disabled}
              aria-label={tab.label}
              aria-selected={selected}
              aria-controls={`drive-panel-${tab.value}`}
              tabIndex={!disabled && tab.value === rovingTab ? 0 : -1}
              onClick={() => onSelectTab?.(tab.value)}
              onKeyDown={event => onTabKeyDown(event, index)}
              className={cn(
                /* An unselected tab is label only — it has the track under it
                   and does not need a fill of its own. `/75`, because the
                   track composites lighter than the old opaque bar did and the
                   label has to climb with it. */
                /* `h-11` and `min-w-11`: an unselected tab is icon-only below
                   `sm` (see the label's own class), so without a width floor it
                   was a 36px square — and the three of them are the product's
                   primary navigation. The pointer gets its 28px row back. */
                'inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-header-foreground/75 outline-none transition-[color,background-color,transform,box-shadow] duration-150 active:scale-[0.98] sm:h-7 sm:min-w-20 sm:px-3 motion-reduce:transform-none',
                'hover:bg-foreground/[0.06] hover:text-header-foreground focus-visible:ring-2 focus-visible:ring-header-ring',
                disabled && 'pointer-events-none',
                selected &&
                  'bg-header-accent text-header-accent-foreground shadow-sm ring-1 ring-inset ring-foreground/[0.07] hover:bg-header-accent',
              )}
            >
              <Icon aria-hidden size={16} weight={selected ? 'fill' : 'regular'} />
              <span className={selected ? 'inline' : 'hidden sm:inline'}>{tab.label}</span>
            </button>
          )
        })}
      </div>

      <div
        data-drive-topbar-slot="right"
        className="relative flex min-w-0 flex-1 basis-0 items-center justify-end overflow-hidden"
      >
        {rightSlot}
      </div>
    </header>
  )
}

/**
 * The material the bar stands on: blur that runs out instead of stopping.
 *
 * It is a layer rather than the bar's own `background` for one reason — it has
 * to be *masked*, and a mask on the bar would take the controls with it. So the
 * glass is its own element, taller than the bar, faded to nothing at the
 * bottom by a mask that carries the backdrop filter with it.
 *
 * That fade is the whole effect. A frosted bar that ends on a hairline is an
 * object sitting on the page; one that dissolves is a depth of field, and what
 * scrolls under it goes soft before it goes away — which is the thing an OS
 * title bar does and a `border-b` cannot. It also replaces the hairline
 * honestly: the edge used to be what said where the chrome stopped, and a
 * gradient says it over half a rem instead of over one pixel.
 *
 * The tint is stated in `--background`, not `--header`. The old fill was the
 * header's own tone, which is a *lighter* slab in both themes — 72% of it over
 * the canvas composited to a grey band, so the bar read as a bar and the blur
 * underneath it was paying for an effect nobody could see. Tinting toward the
 * page instead means what shows through is the content, dimmed, which is what
 * glass is.
 *
 * Two numbers here are held apart on purpose, and getting them wrong is what
 * makes this look broken rather than deep. **The tint stops at the bar's own
 * edge; only blur is allowed past it.** A veil is opaque, so any of it hanging
 * below the bar washes whatever is under there toward the page colour — and the
 * things directly under this bar are not all scrolling content. The map's own
 * toggle sits ten pixels below it, and a background-coloured wash over its top
 * border reads exactly like a half-drawn button. Blur alone is honest there: it
 * softens what is already soft and leaves a crisp edge crisp. The overhang is
 * therefore short, and pure blur.
 */
function DriveTopBarGlass() {
  const fade = 'linear-gradient(to bottom,#000 0%,#000 70%,transparent 100%)'
  return (
    <div
      aria-hidden
      data-drive-topbar-glass="true"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
      className="pointer-events-none absolute inset-x-0 top-0 h-[calc(var(--drive-topbar-h)+0.5rem)] backdrop-blur-[20px] backdrop-saturate-[1.6]"
    >
      {/* Height is the *bar*, not the layer — see above. `/0` rather than
          `transparent` so the ramp interpolates through the page colour
          instead of dipping through transparent black on the way down. */}
      <div className="absolute inset-x-0 top-0 h-[var(--drive-topbar-h)] bg-gradient-to-b from-background/88 via-background/78 to-background/0" />
      {/* The specular edge, dark themes only. Glass catches light on the lip it
          presents to the viewer, which is a *lift* — on a pale theme the same
          line has to be a darkening to be visible at all, and a dark seam
          across the top of the window reads as a rendering artifact rather
          than as a lit edge. */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent dark:via-white/10" />
    </div>
  )
}

export function DriveTabPanel({
  value,
  activeTab,
  children,
  className,
}: {
  value: DriveTab
  activeTab: DriveTab
  children: ReactNode
  className?: string
}) {
  const active = value === activeTab
  return (
    <section
      id={`drive-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`drive-tab-${value}`}
      tabIndex={active ? 0 : -1}
      hidden={!active}
      className={cn(
        'h-full min-h-0 min-w-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
        DRIVE_TOPBAR_CLEARANCE,
        active && 'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200',
        className,
      )}
    >
      {children}
    </section>
  )
}
