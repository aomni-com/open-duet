'use client'

import {
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

import { isHiddenDriveEntry, type ViewerDescriptor } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'

import type { FilesRow } from '../files/app-rows'
import { DriveBrowser } from '../files/drive-view'
import type { DirectoryEntry, IFileSystemProvider } from '../files/lib/types'
import { PreviewPane } from '../files/preview-pane'
import { READONLY_SOURCE_PREVIEW_MODE } from '../files/preview-presentation'
import type { PublishViewerState } from './publish-viewer-controller'

/**
 * The chrome of the public publish viewer: a light identity banner over the
 * bare read-only surface. It is pure presentation — it owns only the banner,
 * the page layout, and the composition of the transient/terminal notices, and
 * consumes the immutable public {@link ViewerDescriptor} the server already
 * resolved. It fetches nothing (no identity/workspace API) and re-owns nothing:
 * `DriveBrowser` still owns listing presentation and `PreviewPane` still owns
 * file rendering, each in its read-only public mode.
 *
 * The banner is always present — the descriptor is available before the first
 * fetch settles — so a visitor sees whose files these are while loading, on an
 * error, and on every content view. A `NextIntlClientProvider` is assumed above
 * (the route mount and the playground both supply one); the shell itself carries
 * no locale.
 */
export function PublishViewerShell({
  descriptor,
  state,
  query,
  onQueryChange,
  onNavigate,
  onRetry,
  onLoadMore,
  provider,
  workspaceSlug,
  archiveUrl,
}: {
  descriptor: ViewerDescriptor
  state: PublishViewerState
  query: string
  onQueryChange: (value: string) => void
  onNavigate: (path: string) => void
  onRetry: () => void
  onLoadMore?: () => void
  /** The read-only public provider; `null` only during the pre-mount frame. */
  provider: IFileSystemProvider | null
  workspaceSlug: string
  /**
   * Maps the open folder's virtual path to its public `?zip` archive URL.
   * Absent (pre-mount, or a surface without archives) renders no download
   * affordance.
   */
  archiveUrl?: (path: string) => string
}) {
  // Dotfiles are served but hidden by default — presentation, not policy.
  // The toggle reveals them; the serving floor never reaches the client.
  const [showHidden, setShowHidden] = useState(false)
  const presentedState: PublishViewerState =
    state.status === 'folder' && !showHidden
      ? { ...state, entries: state.entries.filter(entry => !isHiddenDriveEntry(entry.name)) }
      : state
  // The download affordance is deliberately quiet and scoped: a ghost link in
  // the banner's right edge, only while browsing a subfolder. The root shows
  // none — the publish root is the arrival view, and the whole-publish
  // download would dominate it.
  const archiveHref =
    state.status === 'folder' && state.path !== '/' && archiveUrl !== undefined
      ? archiveUrl(state.path)
      : undefined
  return (
    <div data-publish-viewer className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <PublishBanner
        descriptor={descriptor}
        action={
          <span className="flex shrink-0 items-center gap-1">
            {state.status === 'folder' ? (
              <ShowHiddenToggle showHidden={showHidden} onToggle={() => setShowHidden(v => !v)} />
            ) : null}
            <ArchiveDownloadLink href={archiveHref} />
          </span>
        }
      />

      <main data-publish-viewer-body className="flex flex-1 flex-col">
        <PublishViewerBody
          descriptor={descriptor}
          state={presentedState}
          query={query}
          onQueryChange={onQueryChange}
          onNavigate={onNavigate}
          onRetry={onRetry}
          onLoadMore={onLoadMore}
          provider={provider}
          workspaceSlug={workspaceSlug}
        />
      </main>
    </div>
  )
}

/** The quiet banner show-hidden toggle, mirroring the Drive's vocabulary. */
function ShowHiddenToggle({ showHidden, onToggle }: { showHidden: boolean; onToggle: () => void }) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={showHidden}
      aria-label={t('drive.showHiddenFiles')}
      onClick={onToggle}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      {showHidden ? (
        <EyeIcon className="mr-1.5 size-4" />
      ) : (
        <EyeSlashIcon className="mr-1.5 size-4" />
      )}
      {t('drive.hidden')}
    </Button>
  )
}

/** The quiet banner-right download link; renders nothing without an href. */
function ArchiveDownloadLink({ href }: { href?: string }) {
  const t = useTranslations('duetApp.publishViewer')
  if (href === undefined) return null
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <a href={href} download>
        <DownloadSimpleIcon className="mr-1.5 size-4" />
        {t('downloadZip')}
      </a>
    </Button>
  )
}

/**
 * The light identity banner: `{workspaceName} · {ownerName} · published with
 * Duet`. The workspace name carries the weight (it is what the visitor came to
 * see), the owner is secondary, and the "published with Duet" attribution is
 * the quietest. Names truncate and the row wraps so a long workspace or owner
 * name never forces horizontal overflow, down to the 320px floor.
 */
export function PublishBanner({
  descriptor,
  action,
}: {
  descriptor: ViewerDescriptor
  /** Optional quiet control at the banner's right edge (download-as-zip). */
  action?: ReactNode
}) {
  const t = useTranslations('duetApp.publishViewer')
  return (
    <header
      data-publish-banner
      aria-label={t('banner.label')}
      className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/25 px-4 py-2.5 md:px-6"
    >
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm leading-tight">
        <span className="min-w-0 max-w-full truncate font-medium text-foreground">
          {descriptor.workspaceName}
        </span>
        {/* Separators ride inside their segment's group so a wrap never
            strands a middot at a line end. */}
        <span className="flex min-w-0 max-w-full items-center gap-x-2">
          <BannerSeparator />
          <span className="min-w-0 truncate text-muted-foreground">{descriptor.ownerName}</span>
        </span>
        <span className="flex items-center gap-x-2">
          <BannerSeparator />
          <span className="whitespace-nowrap text-muted-foreground/75">
            {t('banner.attribution')}
          </span>
        </span>
      </p>
      {action}
    </header>
  )
}

function BannerSeparator() {
  return (
    <span aria-hidden className="select-none text-muted-foreground/40">
      ·
    </span>
  )
}

/**
 * Maps the settled {@link PublishViewerState} to a surface: a folder lists the
 * bare read-only `DriveBrowser`; a file opens the read-only/source
 * `PreviewPane` directly (no folder chrome); every transient/terminal state is
 * a centered {@link PublishNotice}.
 */
function PublishViewerBody({
  descriptor,
  state,
  query,
  onQueryChange,
  onNavigate,
  onRetry,
  onLoadMore,
  provider,
  workspaceSlug,
}: {
  descriptor: ViewerDescriptor
  state: PublishViewerState
  query: string
  onQueryChange: (value: string) => void
  onNavigate: (path: string) => void
  onRetry: () => void
  onLoadMore?: () => void
  provider: IFileSystemProvider | null
  workspaceSlug: string
}) {
  const t = useTranslations('duetApp.publishViewer')
  switch (state.status) {
    case 'folder':
      // A published folder with nothing in it gets a publish-scoped empty
      // notice rather than the shared Drive empty state, whose copy and icon
      // ("Upload files or create a folder", a search glyph) assume an
      // authenticated editor a public visitor is not.
      if (state.entries.length === 0 && state.nextCursor == null)
        return <PublishNotice kind="empty" />
      return (
        <div className="flex flex-1 flex-col">
          <DriveBrowser
            rows={plainRows(state.entries)}
            query={query}
            onQueryChange={onQueryChange}
            path={state.path}
            onNavigate={onNavigate}
            onOpenDocument={row => onNavigate(row.entry.path)}
            // Public rows carry no app projection, so an app card can never render
            // and this handler is unreachable; it satisfies the shared contract.
            onOpenApp={() => {}}
            workspaceSlug={workspaceSlug}
            capabilities={{ mode: 'public' }}
            // The hero names what was published — the root's own name — not the
            // authenticated product's "Drive" copy.
            hero={{ heading: descriptor.rootName, tagline: t('folderTagline') }}
          />
          {state.nextCursor != null || state.continuation === 'error' ? (
            <div className="mx-auto w-full max-w-6xl px-4 pb-6 md:px-6">
              <Button
                variant="outline"
                size="sm"
                disabled={state.continuation === 'loading'}
                onClick={onLoadMore}
              >
                {state.continuation === 'loading' ? (
                  <SpinnerGapIcon
                    aria-hidden
                    className="mr-2 size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {state.continuation === 'error'
                  ? t('retryMore')
                  : state.continuation === 'loading'
                    ? t('loadingMore')
                    : t('loadMore')}
              </Button>
            </div>
          ) : null}
        </div>
      )
    case 'file':
      return provider === null ? (
        <PublishNotice kind="loading" />
      ) : (
        <PreviewPane
          entry={state.entry}
          provider={provider}
          workspaceSlug={workspaceSlug}
          mode={READONLY_SOURCE_PREVIEW_MODE}
          live={{ enabled: false }}
        />
      )
    case 'not-found':
      return <PublishNotice kind="not-found" />
    case 'error':
      return (
        <PublishNotice kind="error">
          <Button variant="outline" size="sm" onClick={onRetry}>
            <ArrowClockwiseIcon className="mr-2 size-4" />
            {t('error.retry')}
          </Button>
        </PublishNotice>
      )
    default:
      return <PublishNotice kind="loading" />
  }
}

/**
 * A calm centered notice for the viewer's non-content states. `loading` shows a
 * quiet spinner (stilled under reduced motion); `error` slots a Retry action.
 * A paused workspace never reaches here — the edge serves its own paused page
 * before proxying to the viewer — so there is no paused notice. Copy is
 * localized, never the raw fetch error.
 */
export function PublishNotice({
  kind,
  children,
}: {
  kind: 'loading' | 'empty' | 'not-found' | 'error'
  children?: ReactNode
}) {
  const t = useTranslations('duetApp.publishViewer')
  const copy = {
    loading: { title: t('loading.title'), body: t('loading.body') },
    empty: { title: t('empty.title'), body: t('empty.body') },
    'not-found': { title: t('notFound.title'), body: t('notFound.body') },
    error: { title: t('error.title'), body: t('error.body') },
  }[kind]

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      {kind === 'loading' ? (
        <SpinnerGapIcon
          aria-hidden
          className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      ) : null}
      <div className="space-y-2">
        <p className="font-medium">{copy.title}</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{copy.body}</p>
      </div>
      {children}
    </div>
  )
}

/**
 * Plain filesystem rows — no app projection, no phantom rows. The public viewer
 * shows files as files; it never resolves the workspace's apps, so it hands
 * `DriveBrowser` the raw directory entries the shared `FilesRow` shape wraps.
 */
function plainRows(entries: readonly DirectoryEntry[]): FilesRow[] {
  return entries.map(entry => ({ kind: 'entry', entry }))
}
