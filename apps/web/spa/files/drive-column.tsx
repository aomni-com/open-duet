'use client'

/* ============================================================================
   One column of the drive.

   A column is a listing of exactly one folder, rendered as a list-with-columns:
   glyph · name · kind · size · modified. It owns nothing about navigation —
   `DriveColumns` hands it already-filtered, already-ordered rows and tells it
   which row is selected and which one is expanded into the column on its right.

   The size column is a Duet addition. The surface this was ported from had no
   byte count in its file model and so had to leave the column out; `FileEntry`
   carries a real one here, so it is shown rather than inferred.
   ========================================================================= */
import { SpinnerGapIcon } from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { AppIcon } from '../apps/app-icon'
import { formatBytes } from '../format'
import type { FilesRow } from './app-rows'
import { relativeTimeLabel, useAttributionNow } from './attribution'
import { driveRowName } from './column-rows'
import { FileGlyph } from './file-glyph'
import { filesRowKey } from './files-interactions'

/** Row spacing for every column, driven by the toolbar's density toggle. */
export type ColumnDensity = 'comfortable' | 'compact'

/** What a column has to show: its listing, a spinner, or a reason it has neither. */
export type ColumnState =
  | { kind: 'ready' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }

/**
 * The metric set per density.
 *
 * `comfortable` leaves every override empty so `cn()` drops it and the roomy
 * column stays exactly what it was before density existed. `compact` tightens
 * every axis at once — smaller media, tighter type, less row padding — which is
 * what actually doubles rows-per-screen; shrinking only the padding just makes a
 * roomy row look squeezed. The overrides are appended after the base classes so
 * tailwind-merge resolves the conflict in compact's favour.
 */
type DensityMetrics = {
  rowPadding: string
  rowExtra: string
  media: string
  glyph: string
  meta: string
  list: string
  header: string
  headerSpacer: string
  skeletonMedia: string
  skeletonBar: string
}

const DENSITY_METRICS: Record<ColumnDensity, DensityMetrics> = {
  comfortable: {
    rowPadding: 'py-1.5',
    rowExtra: '',
    media: '',
    glyph: '',
    meta: '',
    list: '',
    header: '',
    headerSpacer: '',
    skeletonMedia: '',
    skeletonBar: '',
  },
  compact: {
    rowPadding: 'py-0.5',
    rowExtra: 'gap-1.5 text-xs leading-tight',
    media: 'size-5 rounded',
    glyph: 'size-3.5',
    meta: 'text-[11px] leading-tight',
    list: 'py-0.5',
    header: 'gap-1.5 py-1',
    headerSpacer: 'w-5',
    skeletonMedia: 'size-5 rounded',
    skeletonBar: 'h-2',
  },
}

/* The secondary columns appear only when the column is wide enough to read
   them, so a narrow drive degrades to glyph + name instead of truncating four
   fields into illegibility.

   Every template ends in one `auto` track for the row's actions menu. It has to
   be declared even where no menu renders: an item with no track of its own does
   not overflow, it wraps — silently doubling the height of every row. */
const BASE_GRID = 'grid-cols-[auto_minmax(0,1fr)_auto]'
const WIDE_GRID = '@[15rem]/drive-column:grid-cols-[auto_minmax(0,1fr)_3.25rem_auto]'
const WIDER_GRID = 'sm:@[19rem]/drive-column:grid-cols-[auto_minmax(0,1fr)_3.25rem_4.5rem_auto]'
const WIDEST_GRID =
  'sm:@[24rem]/drive-column:grid-cols-[auto_minmax(0,1fr)_3.25rem_4.5rem_5.5rem_auto]'

export function DriveColumn({
  ref,
  rows,
  selectedPath,
  openPath = null,
  state,
  canClaimEmpty,
  hasNextPage,
  loadingNextPage,
  nextPageFailed,
  density,
  workspaceSlug,
  isNew = false,
  condensed = false,
  emptyLabel,
  renderMenu,
  onActivate,
  onOpen,
  onRetry,
  onLoadNextPage,
}: {
  ref?: React.Ref<HTMLDivElement>
  rows: readonly FilesRow[]
  selectedPath: string | null
  /**
   * The row in *this* column that is expanded into the next one. It keeps a
   * subordinate highlight so the whole drilled path stays legible after the
   * active selection has moved deeper.
   */
  openPath?: string | null
  state: ColumnState
  canClaimEmpty: boolean
  hasNextPage: boolean
  loadingNextPage: boolean
  nextPageFailed: boolean
  density: ColumnDensity
  workspaceSlug: string
  /** Slide the column in when it is the freshly-drilled one. */
  isNew?: boolean
  /**
   * This column is the whole rail, standing beside an open document — the same
   * word the stack above uses for the same condition, because it is one.
   *
   * It drops the column headings. They label a table, and a rail one column
   * wide is a list — but the deciding reason is the seam: the document beside it
   * carries its own header, and two horizontal rules of different heights
   * meeting at the divider is the first thing the eye lands on. One rule reads
   * as a boundary; two read as a mistake.
   */
  condensed?: boolean
  /** Overrides the empty copy; the root wants drive-level wording. */
  emptyLabel?: string
  renderMenu?: (row: FilesRow) => ReactNode
  /** Single click: drill a folder, or select a file. */
  onActivate: (row: FilesRow) => void
  /** Double click or Enter: open the file fully. */
  onOpen: (row: FilesRow) => void
  onRetry?: () => void
  onLoadNextPage: () => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const metrics = DENSITY_METRICS[density]
  const empty = canClaimEmpty && rows.length === 0

  return (
    <div
      ref={ref}
      data-drive-column
      className={cn(
        '@container/drive-column flex h-full min-h-0 w-full shrink-0 flex-col overflow-y-auto border-r border-border/50 sm:w-72',
        isNew &&
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-2 motion-safe:duration-200',
      )}
    >
      {condensed ? null : (
        <div
          className={cn(
            'sticky top-0 z-10 grid items-center gap-2 border-b border-border/50 bg-background/85 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 backdrop-blur',
            BASE_GRID,
            WIDE_GRID,
            WIDER_GRID,
            WIDEST_GRID,
            metrics.header,
          )}
        >
          <span className={cn('w-8', metrics.headerSpacer)} aria-hidden />
          <span className="truncate">{t('name')}</span>
          <span className="hidden truncate text-right @[15rem]/drive-column:block">
            {t('columns.kind')}
          </span>
          <span className="hidden truncate text-right sm:@[19rem]/drive-column:block">
            {t('size')}
          </span>
          <span className="hidden truncate sm:@[24rem]/drive-column:block">{t('lastEdited')}</span>
          {/* Holds the actions column open so the header keeps its rows' grid. */}
          <span className={renderMenu === undefined ? 'w-0' : 'w-8'} aria-hidden />
        </div>
      )}

      {state.kind === 'loading' && rows.length === 0 ? <ColumnSkeleton density={density} /> : null}
      {state.kind === 'error' ? (
        <div role="alert" className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground">{t('folderLoadFailed')}</p>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {empty ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground/60">
          {emptyLabel ?? t('columns.empty')}
        </p>
      ) : null}

      <div className={cn('py-1', metrics.list)}>
        {rows.map(row => (
          <DriveColumnRow
            key={filesRowKey(row)}
            row={row}
            workspaceSlug={workspaceSlug}
            isSelected={rowPath(row) === selectedPath}
            isOnTrail={rowPath(row) === openPath}
            density={density}
            menu={renderMenu?.(row)}
            onActivate={() => onActivate(row)}
            onOpen={() => onOpen(row)}
          />
        ))}
        {hasNextPage || nextPageFailed ? (
          <div className="px-3 py-2">
            <Button
              variant="secondary"
              size="sm"
              className="w-full text-muted-foreground"
              disabled={loadingNextPage}
              onClick={onLoadNextPage}
            >
              {loadingNextPage ? (
                <SpinnerGapIcon
                  aria-hidden
                  className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {nextPageFailed ? t('columns.retryMore') : t('columns.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function rowPath(row: FilesRow): string {
  return row.entry.path
}

/**
 * Content-shaped loading rows — a media box over a name bar, on the real row
 * grid, so a column materializes in place instead of flashing a spinner.
 */
function ColumnSkeleton({ density }: { density: ColumnDensity }) {
  const metrics = DENSITY_METRICS[density]
  const widths = ['70%', '45%', '82%', '55%', '38%', '64%']
  return (
    <div className={cn('py-1', metrics.list)} aria-hidden>
      {widths.map(width => (
        <div
          key={width}
          className={cn(
            'grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-3',
            metrics.rowPadding,
            metrics.rowExtra,
          )}
        >
          <Skeleton className={cn('size-8 shrink-0 rounded-md', metrics.skeletonMedia)} />
          <Skeleton className={cn('h-3 rounded-sm', metrics.skeletonBar)} style={{ width }} />
        </div>
      ))}
    </div>
  )
}

function DriveColumnRow({
  row,
  workspaceSlug,
  isSelected,
  isOnTrail,
  density,
  menu,
  onActivate,
  onOpen,
}: {
  row: FilesRow
  workspaceSlug: string
  isSelected: boolean
  isOnTrail: boolean
  density: ColumnDensity
  menu?: ReactNode
  onActivate: () => void
  onOpen: () => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const locale = useLocale()
  const now = useAttributionNow()
  const metrics = DENSITY_METRICS[density]

  const name = driveRowName(row)
  const entry = row.entry
  const isDirectory = entry.isDirectory
  const displayName = row.app?.displayName ?? name
  const statusLabel = row.app === undefined ? undefined : t(`appStatus.${row.app.status}`)

  /* A symlink is neither followed nor dropped: it keeps its own kind and says
     where it points, because resolving it would let a link out of the drive
     read as part of the drive. */
  const symlink = entry.type === 'symlink'
  const kind = symlink
    ? t('columns.symlink')
    : isDirectory
      ? t('folder')
      : (name.split('.').at(-1)?.toUpperCase() ?? '')

  const size = !isDirectory && entry.size !== undefined
  const modified = entry.modifiedAt
  const modifiedLabel =
    modified === undefined || modified.getTime() < 24 * 60 * 60 * 1_000
      ? '—'
      : relativeTimeLabel(modified.getTime(), now(), locale)

  const label =
    statusLabel === undefined
      ? symlink && entry.target !== undefined
        ? `${name}, ${t('columns.symlinkTo', { target: entry.target })}`
        : name
      : `${name}, ${statusLabel}`

  // The trail row — expanded into the next column but no longer the active
  // selection — takes a subordinate wash plus a left accent bar, so the whole
  // nested path reads at a glance while the selection keeps the full accent.
  const showTrail = isOnTrail && !isSelected

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isDirectory ? isOnTrail : undefined}
      /* The same row-kind vocabulary the card grid published. It is a shipped
         selector contract — the visual suite and the staging harness both read
         it — so the columns keep one owner for it rather than a parallel name. */
      data-files-card={row.app !== undefined ? 'app' : isDirectory ? 'folder' : 'document'}
      data-files-row-key={filesRowKey(row)}
      data-app-status={row.app?.status}
      className={cn(
        'group relative grid w-full items-center gap-2 px-3 text-left text-sm',
        'transition-colors duration-150',
        metrics.rowPadding,
        metrics.rowExtra,
        BASE_GRID,
        WIDE_GRID,
        WIDER_GRID,
        WIDEST_GRID,
        'hover:bg-muted/60',
        showTrail &&
          'bg-accent/40 text-accent-foreground before:absolute before:inset-y-0.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary hover:bg-accent/50',
        isSelected && 'bg-accent text-accent-foreground hover:bg-accent',
        row.app?.status === 'disabled' && 'opacity-75',
      )}
    >
      <button
        type="button"
        onClick={event => {
          // Same guard the cards use: a fast second click must not launch an
          // app twice.
          if (row.app !== undefined && event.detail > 1) return
          onActivate()
        }}
        /* An app opens on the first click, so it must not also open on the
           second. Only files have a distinct double-click meaning. */
        onDoubleClick={row.app === undefined ? onOpen : undefined}
        title={displayName}
        aria-label={label}
        className="absolute inset-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />

      <span
        aria-hidden
        className={cn(
          'pointer-events-none grid size-8 shrink-0 place-items-center rounded-md bg-muted/40 ring-1 ring-inset ring-border/60',
          metrics.media,
        )}
      >
        {row.app !== undefined ? (
          <AppIcon
            app={row.app.app}
            status={row.app.status}
            workspaceSlug={workspaceSlug}
            className={cn('size-5 shrink-0', metrics.glyph)}
          />
        ) : (
          <FileGlyph entry={{ name, isDirectory }} className={cn('size-5', metrics.glyph)} />
        )}
      </span>

      <span className="pointer-events-none min-w-0 truncate">{displayName}</span>

      <span
        className={cn(
          /* Right-aligned: these are short labels in a fixed column, and a
             ragged left edge beside a truncating filename reads as the name
             having been cut early to make room for whitespace. */
          'pointer-events-none hidden truncate text-right text-xs text-muted-foreground @[15rem]/drive-column:block',
          metrics.meta,
        )}
      >
        {/* An app's row shows the app's name, so when that differs from the
            folder it is anchored to the folder identity would vanish from the
            row entirely — the card grid kept it as a `status · folder` meta and
            the column keeps it here for the same reason. */}
        {statusLabel === undefined
          ? kind
          : displayName === name
            ? statusLabel
            : `${statusLabel} · ${name}`}
      </span>
      <span
        className={cn(
          'pointer-events-none hidden truncate text-right text-xs tabular-nums text-muted-foreground sm:@[19rem]/drive-column:block',
          metrics.meta,
        )}
      >
        {size ? formatBytes(entry.size!, 1000) : '—'}
      </span>
      <span
        className={cn(
          'pointer-events-none hidden truncate text-xs text-muted-foreground sm:@[24rem]/drive-column:block',
          metrics.meta,
        )}
      >
        {modifiedLabel}
      </span>

      {/* Always present, so the actions track lines up with the header's. */}
      <span className="relative shrink-0 justify-self-end">{menu}</span>
    </div>
  )
}
