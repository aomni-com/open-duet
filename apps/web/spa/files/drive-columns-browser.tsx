'use client'

/* ============================================================================
   The drive, browsed as columns.

   One owner for everything the column stack needs and the surface around it does
   not care about: which groups are shown, how rows are ordered, how dense they
   are, and what each open folder currently lists. The surface keeps what it
   already owned — uploads, mutations, sharing, notices, the full viewer — so
   this is a change of presentation, not a second drive.

   The open chain is derived, never stored. `folderPath` arrives from the drive's
   one path (address bar on its own page, card state inside an agent), so back,
   forward, deep links, and the agent card's remembered folder all keep working
   without this component knowing which of them it is serving.
   ========================================================================= */
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { filterDriveEntries, type App } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import { projectFilesRows, type FilesRow } from './app-rows'
import { driveColumnChain } from './column-chain'
import {
  DEFAULT_DRIVE_FILTER,
  DEFAULT_DRIVE_SORT,
  driveGroupCounts,
  driveRowMatches,
  sortDriveRows,
  type DriveFilter,
  type DriveSortKey,
} from './column-rows'
import { DocumentHeaderSlotProvider } from './document-header-slot'
import type { ColumnDensity } from './drive-column'
import { DriveColumns, type DriveColumnModel } from './drive-columns'
import { useDriveColumnListings } from './drive-columns-data'
import {
  DrivePathBreadcrumb,
  DriveToolbar,
  type DriveChrome,
  type DriveCommand,
} from './drive-toolbar'
import type { IFileSystemProvider } from './lib/types'

export function DriveColumnsBrowser({
  provider,
  workspaceSlug,
  folderPath,
  selectedPath,
  apps,
  showHidden,
  commands,
  activity,
  chrome,
  documentPane,
  renderMenu,
  onOpenApp,
  onNavigate,
  onOpenFile,
}: {
  provider: IFileSystemProvider
  workspaceSlug: string
  /** The open folder. Its ancestors become the columns to its left. */
  folderPath: string
  /** The row the drive stands on — the open folder, or the file being previewed. */
  selectedPath: string | null
  apps: readonly App[]
  showHidden: boolean
  /** The drive's own affordances, rendered in the control strip. */
  commands?: readonly DriveCommand[]
  activity?: ReactNode
  /** whether the drive is the page or a guest — see `DriveChrome` */
  chrome?: DriveChrome
  /**
   * The document open on this listing, standing to the right of it.
   *
   * Its presence is what condenses the stack: the rail narrows to a single
   * column and the document takes the rest. Undefined is the resting drive, and
   * the surface above decides which — it is the one that knows whether the
   * region is wide enough to be worth splitting.
   */
  documentPane?: ReactNode
  renderMenu?: (row: FilesRow) => ReactNode
  /** An app's row opens the app rather than its anchor folder. */
  onOpenApp?: (row: FilesRow) => void
  onNavigate: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const [filter, setFilter] = useState<DriveFilter>(DEFAULT_DRIVE_FILTER)
  const [sort, setSort] = useState<DriveSortKey>(DEFAULT_DRIVE_SORT)
  const [density, setDensity] = useState<ColumnDensity>('comfortable')
  /* State rather than a ref: the document portals into this element, so the
     render that creates it has to be followed by one that can see it. */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)

  /* A search describes the folder it was typed in. Walking to another folder
     silently keeps it and the new column reads as half-empty, so the query is
     dropped on arrival — the group and density are view preferences and stay. */
  useEffect(() => {
    setFilter(current => (current.search === '' ? current : { ...current, search: '' }))
  }, [folderPath])

  const chain = useMemo(() => driveColumnChain(folderPath), [folderPath])
  const listings = useDriveColumnListings({ provider, workspaceSlug, chain })

  const columns = useMemo<DriveColumnModel[]>(
    () =>
      listings.map(listing => {
        const visible = filterDriveEntries(listing.entries, showHidden ? 'include' : 'exclude')
        const rows = projectFilesRows({
          entries: visible,
          apps,
        })
        return {
          dir: listing.dir,
          state: listing.state,
          /* Filtering a known row (a dotfile, or a search miss) does not make
             its folder empty. Neither does an empty loaded prefix while the
             directory still has another page. */
          canClaimEmpty:
            listing.state.kind === 'ready' &&
            listing.entries.length === 0 &&
            !listing.hasNextPage &&
            !listing.nextPageFailed,
          hasNextPage: listing.hasNextPage,
          loadingNextPage: listing.loadingNextPage,
          nextPageFailed: listing.nextPageFailed,
          loadNextPage: listing.loadNextPage,
          rows: sortDriveRows(
            rows.filter(row => driveRowMatches(row, filter)),
            sort,
          ),
        }
      }),
    [listings, showHidden, apps, filter, sort],
  )

  /* Counts describe the open folder only — the drive has no recursive index, so
     a workspace-wide number would be one nobody can stand behind. The active
     search is deliberately ignored: these are group totals, not query results. */
  const groupCounts = useMemo(() => {
    const open = listings.at(-1)
    return driveGroupCounts(
      open === undefined
        ? []
        : projectFilesRows({
            entries: filterDriveEntries(open.entries, showHidden ? 'include' : 'exclude'),
            apps,
          }),
    )
  }, [listings, showHidden, apps])

  /* What leads the strip: the trail, and — once a file is open — that file's
     own header beside it, behind a hairline.

     Closed, the trail takes the whole middle of the row (`sm:flex-1`) so that
     the drive's controls end up flush right and nothing is parked against the
     path. Open, it gives that room to the header instead and stands at its own
     width: the file's name is the longer, more particular thing, and it is what
     the reader is here for.

     A card's row is 40px and holds four views' worth of chrome, so there it is
     one or the other: opening a file stands the breadcrumb down and gives its
     place to the back button and the file's name. That is not a saving: with
     the trail gone the name *is* the answer to where you are, so it belongs at
     the left where the trail was, not squeezed against the far end of a row
     still led by a path you have stopped looking at. */
  const open = documentPane !== undefined
  const trailIsHeader = chrome === 'inline' && open
  const trail = (
    <>
      {trailIsHeader ? null : (
        <div className={cn('min-w-0 shrink', open ? null : 'sm:flex-1')}>
          <DrivePathBreadcrumb path={folderPath} onNavigate={onNavigate} />
        </div>
      )}
      {open && !trailIsHeader ? (
        <span aria-hidden className="h-4 w-px shrink-0 bg-border/70" />
      ) : null}
      {open ? <div ref={setHeaderSlot} className="flex min-w-0 flex-1 items-center" /> : null}
    </>
  )

  return (
    /* `h-full`, not `flex-1`: the handoff wrapper above this is a plain block, so
       a flex basis has nothing to resolve against and the stack would collapse to
       the height of its rows — leaving the columns stopping short of the bottom
       instead of running the full height they are given. */
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* One bar of chrome over the split, not one per pane and not two over
          both. The trail says which folder the listing is; the open document
          renders its own controls into the slot beside it — see
          `document-header-slot` — and the drive's controls close the row.

          The controls collapse behind one mark as soon as a document is open,
          on the page as much as in a card: the row has a header to carry by
          then, and a sort and a filter that act on a 288px rail have stopped
          being the thing the reader came for. */}
      <DriveToolbar
        trail={trail}
        filter={filter}
        sort={sort}
        density={density}
        groupCounts={groupCounts}
        commands={commands}
        activity={activity}
        chrome={chrome}
        controls={chrome === 'inline' || open ? 'collapsed' : 'full'}
        onFilterChange={setFilter}
        onSortChange={setSort}
        onDensityChange={setDensity}
      />
      {/* The listing and the document it opened, side by side.

          The rail is pinned to exactly one column's width rather than given a
          fraction of the row: a column is a fixed `w-72`, so any other number
          leaves either a sliver of the next column showing or a gap after the
          last one. Pinned, the deepest column fills it exactly and everything
          above it is off the left edge — which is what the stack sliding over
          looks like from the reader's side. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* ---- the listing gives up its width, visibly ----
            Opening a file used to be one frame: the listing was the pane and
            then it was a rail, with no picture of how one became the other. A
            reader who cannot see a surface move has to work out afterwards what
            happened to it — so the width is animated, and the document arrives
            over the room the listing has already started giving up.

            `width` rather than a transform, and knowingly: this is the one
            place in the drive where a layout property is animated, because the
            columns beside it have to *actually* reflow into the narrower rail.
            A transform would scale the type and slide the rows out of the box
            they still occupy. It is a single ~280ms disclosure on one element
            rather than a per-frame loop, which is the case the rule against
            animating layout is not about. */}
        <div
          data-files-columns-pane
          data-open={open ? 'true' : 'false'}
          className={cn(
            'flex min-h-0 flex-col motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]',
            open
              ? /* A surface of its own, not just a line. The drive's panel and
                   the document's body are the same near-white, so a hairline
                   alone left the split reading as one field with a scratch down
                   it rather than a listing and the thing it opened. */
                'w-72 shrink-0 border-r border-border bg-muted/50'
              : 'w-full min-w-0 flex-1',
          )}
        >
          <DriveColumns
            columns={columns}
            selectedPath={selectedPath}
            density={density}
            workspaceSlug={workspaceSlug}
            condensed={documentPane !== undefined}
            renderMenu={renderMenu}
            onOpenApp={onOpenApp}
            onOpenFolder={onNavigate}
            onSelectFile={onNavigate}
            onOpenFile={onOpenFile}
          />
        </div>
        {/* It arrives rather than appears: the listing is already narrowing
            when this fades up off the same clock, so the two read as one
            movement. Transform and opacity only — the pane's own width is the
            room the listing gave up, and animating that too would be two things
            competing for the same pixels.

            Rendered only when there is a document. A wrapper that is always
            there is an empty `flex-1` sitting on the right of every folder the
            reader opens, taking half the surface to hold nothing — and because
            it is empty there is no clue anywhere on screen about what the space
            is for. */}
        {open ? (
          <div
            data-files-document-pane
            className="flex min-h-0 min-w-0 flex-1 motion-safe:animate-document-in"
          >
            <DocumentHeaderSlotProvider value={{ element: headerSlot }}>
              {documentPane}
            </DocumentHeaderSlotProvider>
          </div>
        ) : null}
      </div>
    </div>
  )
}
