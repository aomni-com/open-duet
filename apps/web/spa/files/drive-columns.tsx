'use client'

/* ============================================================================
   The drive as a stack of columns.

   Column *i* lists one folder; picking a folder in it opens column *i+1* to its
   right, so depth reads horizontally instead of replacing the view. Picking a
   file selects it and hands it to the surface, which presents it.

   This component owns no path. The open chain arrives already derived from the
   drive's `path` (see `column-chain.ts`), and drilling calls back out — which is
   what keeps folder deep links on the drive's own page and remembered folder
   state inside the agent card, without this component knowing which it is.

   What it does own is how the stack *moves*: two distinct scroll behaviours that
   are easy to collapse into one and wrong when you do — see below.
   ========================================================================= */
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import type { FilesRow } from './app-rows'
import { driveColumnsKeyAction, type KeyRow } from './column-keys'
import { DriveColumn, type ColumnDensity, type ColumnState } from './drive-column'

export type DriveColumnModel = {
  /** The folder this column lists. */
  dir: string
  rows: readonly FilesRow[]
  state: ColumnState
  /** True only when the unfiltered directory listing is known to contain no rows. */
  canClaimEmpty: boolean
  hasNextPage: boolean
  loadingNextPage: boolean
  nextPageFailed: boolean
  loadNextPage(): Promise<void>
}

export function DriveColumns({
  columns,
  selectedPath,
  density,
  workspaceSlug,
  condensed = false,
  rootEmptyLabel,
  renderMenu,
  onOpenApp,
  onOpenFolder,
  onSelectFile,
  onOpenFile,
  onRetry,
}: {
  columns: readonly DriveColumnModel[]
  /** The row the drive is currently standing on — a folder or a previewed file. */
  selectedPath: string | null
  density: ColumnDensity
  workspaceSlug: string
  /** The rail has been narrowed to one column to make room for a document. */
  condensed?: boolean
  rootEmptyLabel?: string
  renderMenu?: (row: FilesRow) => ReactNode
  /** An app's row opens the app, not the folder it is anchored to. */
  onOpenApp?: (row: FilesRow) => void
  onOpenFolder: (path: string) => void
  onSelectFile: (path: string) => void
  onOpenFile: (path: string) => void
  onRetry?: (dir: string) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const activeColumnRef = useRef<HTMLDivElement>(null)
  const endPinned = useRef(false)

  // Keyboard focus lives on one column at a time. Clamp when the stack shrinks,
  // which happens whenever selecting a file truncates the columns past it.
  const [activeColumnIndex, setActiveColumnIndex] = useState(0)
  useEffect(() => {
    setActiveColumnIndex(index => Math.min(index, Math.max(0, columns.length - 1)))
  }, [columns.length])

  // Follow focus: keep the focused column on screen as focus moves. `inline:
  // 'nearest'` is deliberate — it no-ops when the column is already visible, so
  // clicking a row in a column you can already see does not yank that column to
  // the right edge the way `inline: 'end'` does.
  //
  // Movement only. On mount nothing has been focused yet, and `block: 'nearest'`
  // does not no-op the way the inline axis does: a column is taller than the
  // drive panel, so revealing it scrolls the panel past everything stacked above
  // — the share banner a recipient just arrived for, the toolbar, the
  // breadcrumb. It is a smooth scroll, so it lands well after the panel looks
  // settled.
  const followedColumnIndex = useRef(activeColumnIndex)
  useEffect(() => {
    if (followedColumnIndex.current === activeColumnIndex) return
    followedColumnIndex.current = activeColumnIndex
    endPinned.current = activeColumnIndex === columns.length - 1
    activeColumnRef.current?.scrollIntoView({
      behavior: 'smooth',
      inline: 'nearest',
      block: 'nearest',
    })
  }, [activeColumnIndex, columns.length])

  // Reveal the folder named by a deep link, then every freshly opened column.
  // Focus stays on the column you clicked so vertical browsing keeps working
  // there, which means the follow-focus effect above cannot be what reveals the
  // new one. The initial stack jumps because there was no shallower state on
  // screen to animate from; later growth glides right to preserve the depth cue.
  // Walking back up does not scroll.
  const previousColumnCount = useRef(0)
  useEffect(() => {
    if (columns.length > previousColumnCount.current) {
      const el = scrollerRef.current
      endPinned.current = true
      if (el !== null && el.scrollWidth > el.clientWidth) {
        el.scrollTo({
          left: el.scrollWidth,
          behavior: previousColumnCount.current === 0 ? 'auto' : 'smooth',
        })
      }
    }
    previousColumnCount.current = columns.length
  }, [columns.length])

  // The stack, pushed left. Opening a document narrows the rail to a single
  // column, and a scroller keeps whatever `scrollLeft` it already had — which
  // would leave some ancestor standing in it instead of the column the reader
  // opened the file from. Gliding to the far right is what makes the deepest
  // one the survivor, and doing it as a glide rather than a jump is what the
  // depth cue below is for: the ancestors visibly slide off under the fade.
  //
  // A third effect rather than a clause in either above, because it answers a
  // third question. That one follows focus; the one before it reveals a column
  // that has just been born; this one re-aims a rail whose *width* changed under
  // a stack that did not.
  const wasCondensed = useRef<boolean | null>(null)
  /* True while the rail is still narrowing. See the effect below: the aim has to
     survive a width that is still moving. */
  const closing = useRef(false)
  useEffect(() => {
    const previously = wasCondensed.current
    wasCondensed.current = condensed
    if (!condensed || previously === condensed) return
    const el = scrollerRef.current
    /* Instant when the drive arrives already condensed — a deep link straight
       to a document — because there was no stack on screen to push and gliding
       would animate away from a position the reader never saw. A glide is only
       honest when it shows something moving that was there a moment ago. */
    if (previously === null) {
      endPinned.current = true
      el?.scrollTo({ left: el.scrollWidth, behavior: 'auto' })
      return
    }
    /* And tracked, not aimed once, because the rail's width is animated now.
       A single `scrollTo` here computes its target against the *old* width —
       the pane is still six hundred pixels wide at the moment this runs — so it
       lands on an ancestor and stays there, and the reader watches the rail
       close around the wrong folder. Whatever the observer below reads as the
       width shrinks is the honest maximum, frame by frame.

       Instant on each of those frames rather than smooth: the movement the
       reader is meant to follow is the rail closing, and a glide underneath it
       is a second animation racing the first to the same place. Pinned, the
       deepest column simply stays filling the rail while the rail narrows onto
       it — which is the whole picture that sentence in the header describes. */
    closing.current = true
    endPinned.current = true
    if (el) el.scrollLeft = el.scrollWidth
  }, [condensed])

  /* The tracking half. It runs only while `closing` is set, so an ordinary
     window resize later never yanks a reader's rail back to the right. */
  useEffect(() => {
    const el = scrollerRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => {
      if (!closing.current) return
      el.scrollLeft = el.scrollWidth
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* And it stops tracking when the pane stops moving. Read off the transition
     itself rather than a duration copied from the stylesheet — the two would
     drift, and a timer that ends early leaves the rail aimed at an ancestor for
     the last few frames of the close. */
  useEffect(() => {
    if (!condensed) {
      closing.current = false
      return
    }
    const pane = scrollerRef.current?.closest('[data-files-columns-pane]')
    if (!(pane instanceof HTMLElement)) {
      closing.current = false
      return
    }
    const settle = (event: Event): void => {
      if ((event as TransitionEvent).propertyName === 'width') closing.current = false
    }
    pane.addEventListener('transitionend', settle)
    pane.addEventListener('transitioncancel', settle)
    return () => {
      pane.removeEventListener('transitionend', settle)
      pane.removeEventListener('transitioncancel', settle)
    }
  }, [condensed])

  // Depth cue: which edges have columns hidden behind them, so drilling deep
  // reads as "the stack slid over to make room" rather than an abrupt clip.
  const [edges, setEdges] = useState({ start: false, end: false })
  const updateEdges = useCallback((preserveEnd = false) => {
    const el = scrollerRef.current
    if (!el) return
    if (preserveEnd && endPinned.current) el.scrollLeft = el.scrollWidth
    const max = el.scrollWidth - el.clientWidth
    const end = el.scrollLeft < max - 1
    setEdges({ start: el.scrollLeft > 1, end })
  }, [])
  useEffect(() => {
    updateEdges()
  }, [updateEdges, columns.length])
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      updateEdges(true)
      if (frame !== null) cancelAnimationFrame(frame)
      // A breakpoint resize changes the rail and every column in the same
      // layout pass. Re-aim after those sibling widths have all settled.
      frame = requestAnimationFrame(() => updateEdges(true))
    })
    observer.observe(el)
    const terminal = el.lastElementChild
    if (terminal instanceof HTMLElement) observer.observe(terminal)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [updateEdges])

  const activate = useCallback(
    (columnIndex: number, row: FilesRow) => {
      setActiveColumnIndex(columnIndex)
      /* An app is shown as itself. Its anchor folder is a directory like any
         other, so drilling would open the folder the app lives in and quietly
         never open the app — entering the folder is the row menu's job. */
      if (row.app !== undefined) {
        onOpenApp?.(row)
        return
      }
      if (row.entry.isDirectory) onOpenFolder(row.entry.path)
      else onSelectFile(row.entry.path)
    },
    [onOpenApp, onOpenFolder, onSelectFile],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const action = driveColumnsKeyAction(event.key, {
        columns: columns.map(column => ({ dir: column.dir, rows: column.rows.map(keyRow) })),
        activeColumnIndex,
        selectedPath,
      })
      // A null action means the key was never ours — leave it to the browser.
      if (action === null) return
      event.preventDefault()
      setActiveColumnIndex(action.focusColumn)
      if (action.navigate === undefined) return
      if (action.navigate.kind === 'app') {
        // Keyboard parity with click: the reducer names the row, the surface
        // owns what opening an app means.
        const path = action.navigate.path
        const row = columns[activeColumnIndex]?.rows.find(candidate => rowPath(candidate) === path)
        if (row !== undefined) onOpenApp?.(row)
        return
      }
      if (action.navigate.kind === 'folder') onOpenFolder(action.navigate.path)
      else if (action.navigate.kind === 'file-select') onSelectFile(action.navigate.path)
      else onOpenFile(action.navigate.path)
    },
    [columns, activeColumnIndex, selectedPath, onOpenApp, onOpenFolder, onSelectFile, onOpenFile],
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={scrollerRef}
        role="tree"
        aria-label={t('columns.label')}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={event => {
          if (event.target === event.currentTarget) endPinned.current = false
        }}
        onTouchMove={() => {
          endPinned.current = false
        }}
        onWheel={event => {
          if (event.deltaX !== 0 || event.shiftKey) endPinned.current = false
        }}
        onScroll={() => updateEdges()}
        data-drive-columns
        className="flex min-w-0 flex-1 overflow-x-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40"
      >
        {columns.map((column, columnIndex) => (
          <DriveColumn
            key={`${columnIndex}:${column.dir}`}
            ref={columnIndex === activeColumnIndex ? activeColumnRef : undefined}
            rows={column.rows}
            selectedPath={selectedPath}
            openPath={columns[columnIndex + 1]?.dir ?? null}
            state={column.state}
            canClaimEmpty={column.canClaimEmpty}
            hasNextPage={column.hasNextPage}
            loadingNextPage={column.loadingNextPage}
            nextPageFailed={column.nextPageFailed}
            density={density}
            workspaceSlug={workspaceSlug}
            isNew={columnIndex > 0}
            condensed={condensed}
            emptyLabel={columnIndex === 0 ? rootEmptyLabel : undefined}
            renderMenu={renderMenu}
            onActivate={row => activate(columnIndex, row)}
            onOpen={row => {
              setActiveColumnIndex(columnIndex)
              if (row.app !== undefined) {
                onOpenApp?.(row)
                return
              }
              if (row.entry.isDirectory) onOpenFolder(row.entry.path)
              else onOpenFile(row.entry.path)
            }}
            onLoadNextPage={() => void column.loadNextPage()}
            {...(onRetry === undefined ? {} : { onRetry: () => onRetry(column.dir) })}
          />
        ))}
      </div>

      {/* The column sliding off to the left is progressively blurred and tinted
          toward the edge, so depth reads as motion rather than a hard cut. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 z-10 w-20 backdrop-blur-[3px] transition-opacity duration-300 ease-out',
          'bg-gradient-to-r from-background/85 via-background/40 to-transparent',
          '[mask-image:linear-gradient(to_right,black,transparent)] [-webkit-mask-image:linear-gradient(to_right,black,transparent)]',
          edges.start ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/* A lighter right-hand fade hinting that more columns live off-screen. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background/70 to-transparent transition-opacity duration-300 ease-out',
          edges.end ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  )
}

function rowPath(row: FilesRow): string {
  return row.entry.path
}

/** The traversal reducer's view of a row: where it is, and whether it goes anywhere. */
function keyRow(row: FilesRow): KeyRow {
  if (row.app !== undefined) return { path: row.entry.path, kind: 'app' }
  return { path: row.entry.path, kind: row.entry.isDirectory ? 'folder' : 'file' }
}
