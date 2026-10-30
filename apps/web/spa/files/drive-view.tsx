'use client'

import {
  ArrowUpIcon,
  CaretRightIcon,
  EyeIcon,
  EyeSlashIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  MagnifyingGlassIcon,
  UploadSimpleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { AppIcon } from '../apps/app-icon'
import { WorkspaceEmptyState } from '../drive/workspace-page'
import { formatBytes } from '../format'
import type { FilesRow } from './app-rows'
import { relativeTimeLabel, useAttributionNow } from './attribution'
import { FileGlyph } from './file-glyph'
import { filesRowKey } from './files-interactions'
import { parentBrowserFilePath } from './lib/paths'

type DocumentRow = FilesRow

export type DriveCollection = {
  folders: FilesRow[]
  documents: DocumentRow[]
}

// Restored archives can carry the Unix epoch as an "unknown" mtime. Showing
// that sentinel as decades-old activity is technically faithful but misleading.
function fileModifiedLabel(modifiedAt: Date, now: number, locale: string): string | undefined {
  const timestamp = modifiedAt.getTime()
  if (!Number.isFinite(timestamp) || timestamp < 24 * 60 * 60 * 1_000) return undefined
  return relativeTimeLabel(timestamp, now, locale)
}

function rowLabel(row: FilesRow): string {
  return row.entry.name
}

function rowMatches(row: FilesRow, query: string): boolean {
  if (rowLabel(row).toLowerCase().includes(query)) return true
  return row.app !== undefined && row.app.displayName.toLowerCase().includes(query)
}

/**
 * The open folder's rows shaped for the drive: folders first (A→Z, app
 * folders included), then documents (A→Z), optionally narrowed by a
 * case-insensitive name query.
 */
export function splitDriveCollection(rows: readonly FilesRow[], query: string): DriveCollection {
  const trimmed = query.trim().toLowerCase()
  const visible = trimmed.length === 0 ? [...rows] : rows.filter(row => rowMatches(row, trimmed))
  const byLabel = (a: FilesRow, b: FilesRow) => rowLabel(a).localeCompare(rowLabel(b))
  return {
    folders: visible.filter(row => row.entry.isDirectory).sort(byLabel),
    documents: visible.filter(row => !row.entry.isDirectory).sort(byLabel),
  }
}

/**
 * The one `DriveBrowser` renders both the authenticated-editable Drive and the
 * anonymous read-only Publish viewer, discriminated by `mode`:
 * - `authenticated` carries the write/auth chrome (upload, create, per-row
 *   menu, the activity feed) plus the show-hidden toggle.
 * - `public` forbids every one of them and accepts only navigation/open
 *   callbacks — there is no fake no-op callback escape hatch.
 */
export type DriveBrowserCapabilities =
  | { mode: 'public' }
  | {
      mode: 'authenticated'
      /** The built-in actions: upload files, create a folder, create a file. */
      onUpload: () => void
      uploadDisabled?: boolean
      onCreateFolder: () => void
      onCreateFile: () => void
      /** Whether dotfiles are currently revealed, and the toolbar toggle. */
      showHidden: boolean
      onToggleHidden: () => void
      /** Slot for the activity-feed trigger so the drive stays presentation-pure. */
      activity?: ReactNode
      /** Per-card actions menu, supplied by the surface so behavior never forks. */
      renderMenu?: (row: FilesRow) => ReactNode
    }

/**
 * Drive — the whole browsing experience in one calm, content-first view:
 * a compact operational header (identity, search, actions), a breadcrumb
 * trail once you leave the root, then Folders and Documents as inviting
 * objects. It rides the surface's rows/actions seams, so the presentation
 * never forks behavior.
 */
export function DriveBrowser({
  rows,
  query,
  onQueryChange,
  path,
  onNavigate,
  onOpenDocument,
  onOpenApp,
  workspaceSlug,
  capabilities,
  hero,
}: {
  rows: readonly FilesRow[]
  /** Live search text; the drive filters the open folder as it changes. */
  query: string
  onQueryChange: (value: string) => void
  /** The open browser path — drives the breadcrumb and up affordance. */
  path: string
  /** Navigate to a directory (breadcrumb, folder cards, app chevrons). */
  onNavigate: (path: string) => void
  /** Open a document — the surface presents it (preview dialog). */
  onOpenDocument: (row: DocumentRow) => void
  /** Open an app row's target — live app or detail. */
  onOpenApp: (row: FilesRow) => void
  /** Resolves real app icons on app folder cards. */
  workspaceSlug: string
  /** Editable-vs-public capabilities: the single contract, no callback fakes. */
  capabilities: DriveBrowserCapabilities
  /**
   * Display-only hero override. The default heading/tagline name the
   * authenticated workspace Drive; a surface presenting someone else's files
   * (the public publish viewer) supplies its own identity — the published
   * root's name — instead of product-internal copy.
   */
  hero?: { heading: string; tagline: string }
}) {
  const t = useTranslations('duetApp.filesSurface')
  const { folders, documents } = splitDriveCollection(rows, query)
  const searching = query.trim().length > 0
  const empty = folders.length === 0 && documents.length === 0
  const authenticated = capabilities.mode === 'authenticated' ? capabilities : null
  const renderMenu = authenticated?.renderMenu

  return (
    <div className="@container">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 md:px-6 md:py-6">
        <header className="flex flex-col gap-4 border-b border-border/60 pb-5">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/[0.08] text-brand ring-1 ring-inset ring-brand/10"
            >
              <HardDriveIcon className="size-5" weight="duotone" />
            </span>
            <div className="min-w-0 pt-0.5">
              <h2 className="truncate text-lg font-semibold tracking-tight text-foreground">
                {hero?.heading ?? t('drive.heading')}
              </h2>
              <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
                {hero?.tagline ?? t('drive.tagline')}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-md">
              <MagnifyingGlassIcon
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                value={query}
                onChange={event => onQueryChange(event.target.value)}
                placeholder={t('drive.searchPlaceholder')}
                aria-label={t('drive.searchPlaceholder')}
                className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-9 text-sm shadow-xs transition-shadow placeholder:text-muted-foreground/70 focus:outline-none focus-visible:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/20"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => onQueryChange('')}
                  aria-label={t('drive.searchClear')}
                  className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon aria-hidden className="size-4" />
                </button>
              ) : null}
            </div>
            {authenticated ? (
              <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                <Button
                  size="sm"
                  className="min-w-0"
                  onClick={authenticated.onUpload}
                  disabled={authenticated.uploadDisabled}
                >
                  <UploadSimpleIcon className="mr-1.5 size-4" />
                  {t('upload')}
                </Button>
                <Button
                  className="min-w-0"
                  variant="outline"
                  size="sm"
                  onClick={authenticated.onCreateFolder}
                >
                  <FolderPlusIcon className="mr-1.5 size-4" />
                  {t('newFolder')}
                </Button>
                <Button
                  className="min-w-0"
                  variant="outline"
                  size="sm"
                  onClick={authenticated.onCreateFile}
                >
                  <FilePlusIcon className="mr-1.5 size-4" />
                  {t('newFile')}
                </Button>
                <Button
                  className="min-w-0"
                  variant={authenticated.showHidden ? 'secondary' : 'outline'}
                  size="sm"
                  aria-pressed={authenticated.showHidden}
                  aria-label={t('drive.showHiddenFiles')}
                  onClick={authenticated.onToggleHidden}
                >
                  {authenticated.showHidden ? (
                    <EyeIcon className="mr-1.5 size-4" />
                  ) : (
                    <EyeSlashIcon className="mr-1.5 size-4" />
                  )}
                  {t('drive.hidden')}
                </Button>
                {authenticated.activity}
              </div>
            ) : null}
          </div>
        </header>

        {path !== '/' ? (
          <DriveBreadcrumb path={path} onNavigate={onNavigate} rootLabel={hero?.heading} />
        ) : null}

        {empty ? (
          <WorkspaceEmptyState
            tone="muted"
            icon={<MagnifyingGlassIcon weight="duotone" />}
            title={searching ? t('drive.noResultsTitle') : t('drive.emptyTitle')}
            body={searching ? t('drive.noResultsBody') : t('drive.emptyBody')}
          />
        ) : (
          <div className="flex flex-col gap-8">
            {folders.length > 0 ? (
              <DriveSection heading={t('drive.folders')} count={folders.length}>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                  {folders.map(row => (
                    <FolderCard
                      key={filesRowKey(row)}
                      row={row}
                      workspaceSlug={workspaceSlug}
                      menu={renderMenu?.(row)}
                      onNavigate={onNavigate}
                      onOpenApp={onOpenApp}
                    />
                  ))}
                </div>
              </DriveSection>
            ) : null}
            {documents.length > 0 ? (
              <DriveSection heading={t('drive.documents')} count={documents.length}>
                <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4">
                  {documents.map(row => (
                    <DocumentTile
                      key={row.entry.path}
                      row={row}
                      menu={renderMenu?.(row)}
                      onOpen={() => onOpenDocument(row)}
                    />
                  ))}
                </div>
              </DriveSection>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The in-drive breadcrumb: an up affordance, the drive root, then each
 * folder segment — the open one emphasized. Lives inside the drive so the
 * whole journey reads as one surface.
 */
function DriveBreadcrumb({
  path,
  onNavigate,
  rootLabel,
}: {
  path: string
  onNavigate: (path: string) => void
  /** Root crumb label override — the publish viewer's published-root name. */
  rootLabel?: string
}) {
  const t = useTranslations('duetApp.filesSurface')
  const parts = path.split('/').filter(Boolean)
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate(parentBrowserFilePath(path))}
        aria-label={t('up')}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUpIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => onNavigate('/')}
        className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {rootLabel ?? t('files')}
      </button>
      {parts.map((part, index) => {
        const target = `/${parts.slice(0, index + 1).join('/')}`
        const current = index === parts.length - 1
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            <CaretRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => onNavigate(target)}
              aria-current={current ? 'location' : undefined}
              className={cn(
                'truncate rounded-md px-2 py-1 transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                current
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {part}
            </button>
          </span>
        )
      })}
    </nav>
  )
}

/** A calm section header — title plus a muted tabular count — over its grid. */
function DriveSection({
  heading,
  count,
  children,
}: {
  heading: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {heading}
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      </h3>
      {children}
    </section>
  )
}

/**
 * A folder as an inviting card: glyph plate (the app's real icon for app
 * folders), name, one-line meta (app status or last-modified), and a
 * drill-in cue. The card keeps the surface's app contract: clicking an app
 * card opens the app (live or detail), so entering
 * an app's folder is the explicit chevron button, and the accessible label
 * carries the app status just like the row projection expects.
 */
function FolderCard({
  row,
  workspaceSlug,
  menu,
  onNavigate,
  onOpenApp,
}: {
  row: FilesRow
  workspaceSlug: string
  menu?: ReactNode
  onNavigate: (path: string) => void
  onOpenApp: (row: FilesRow) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const locale = useLocale()
  const now = useAttributionNow()
  const name = row.entry.name
  const displayName = row.app?.displayName ?? name
  const modifiedAt = row.entry.modifiedAt
  const modifiedLabel =
    modifiedAt === undefined ? undefined : fileModifiedLabel(modifiedAt, now(), locale)
  const statusLabel = row.app === undefined ? undefined : t(`appStatus.${row.app.status}`)
  const cardLabel = statusLabel === undefined ? name : `${name}, ${statusLabel}`
  // App cards show the app's display name, so the meta keeps the folder
  // identity visible when the two differ (the list's "Folder: name" cue).
  const meta =
    statusLabel !== undefined
      ? displayName === name
        ? statusLabel
        : `${statusLabel} · ${name}`
      : (modifiedLabel ?? t('drive.folderMeta'))

  return (
    <div
      data-files-card={row.app === undefined ? 'folder' : 'app'}
      data-files-row-key={filesRowKey(row)}
      data-app-status={row.app?.status}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-xs',
        'transition-[border-color,box-shadow,transform] duration-150 hover:shadow-sm motion-safe:hover:-translate-y-0.5',
        'border-border/70 hover:border-border',
        row.app?.status === 'disabled' && 'opacity-75',
      )}
    >
      <button
        type="button"
        onClick={event => {
          // Same double-click guard as the row projection: a fast second
          // click must not launch the app twice.
          if (row.app !== undefined && event.detail > 1) return
          if (row.app !== undefined) onOpenApp(row)
          else onNavigate(row.entry.path)
        }}
        title={displayName}
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={cardLabel}
      />
      <span
        aria-hidden
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset',
          row.app !== undefined
            ? 'bg-muted/60 ring-border/60'
            : 'bg-amber-400/10 ring-amber-400/20',
        )}
      >
        {row.app !== undefined ? (
          <AppIcon
            app={row.app.app}
            status={row.app.status}
            workspaceSlug={workspaceSlug}
            className="size-6 shrink-0"
          />
        ) : (
          <FolderIcon weight="fill" className="size-5 text-amber-400" />
        )}
      </span>
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
        <span className="truncate text-xs text-muted-foreground">{meta}</span>
      </span>
      {row.app !== undefined ? (
        <button
          type="button"
          onClick={() => onNavigate(row.entry.path)}
          aria-label={t('openFolderNamed', { name })}
          data-files-action="open-folder"
          className="relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CaretRightIcon className="size-4" />
        </button>
      ) : (
        <CaretRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
        />
      )}
      {menu ? <span className="relative shrink-0">{menu}</span> : null}
    </div>
  )
}

/**
 * A document as a tile: a soft banner carrying the type glyph over the
 * name and its size · last-modified meta. Opening a tile hands the row to
 * the surface, which presents it in the preview dialog.
 */
function DocumentTile({
  row,
  menu,
  onOpen,
}: {
  row: DocumentRow
  menu?: ReactNode
  onOpen: () => void
}) {
  const locale = useLocale()
  const now = useAttributionNow()
  const { entry } = row
  const meta = [
    entry.size !== undefined ? formatBytes(entry.size, 1000) : undefined,
    entry.modifiedAt !== undefined ? fileModifiedLabel(entry.modifiedAt, now(), locale) : undefined,
  ].filter(Boolean)

  return (
    <div
      data-files-card="document"
      data-files-row-key={entry.path}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border border-border/70 bg-card text-left shadow-xs',
        'transition-[border-color,box-shadow,transform] duration-150 hover:border-border hover:shadow-sm motion-safe:hover:-translate-y-0.5',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        title={entry.name}
        aria-label={entry.name}
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none flex items-center justify-center bg-muted/40 px-4 py-6">
        <FileGlyph entry={entry} className="size-9" />
      </div>
      <div className="pointer-events-none flex min-w-0 flex-col gap-0.5 border-t border-border/60 p-3">
        {/* Reserve two lines so the meta row shares one baseline whether the
            name wraps to one line or two. */}
        <span className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-snug text-foreground">
          {entry.name}
        </span>
        {meta.length > 0 ? (
          <span className="truncate text-xs text-muted-foreground">{meta.join(' · ')}</span>
        ) : null}
      </div>
      {menu ? <span className="absolute right-1.5 top-1.5">{menu}</span> : null}
    </div>
  )
}
