'use client'

import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  CaretDownIcon,
  CheckIcon,
  CircleIcon,
  DownloadSimpleIcon,
  EyeIcon,
  PencilSimpleIcon,
  SpinnerGapIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@repo/ui/components/shadcn/button'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { Textarea } from '@repo/ui/components/shadcn/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'

import { formatBytes } from '../format'
import { FileHistoryDrawer, SeenBy } from './attribution'
import { useDocumentHeaderSlot } from './document-header-slot'
import { AudioPreview, ImagePreview, VideoPreview } from './media-preview'
import {
  createPreviewSnapshotLoader,
  liveMutationsUnavailable,
  previewSourceDescriptor,
  supportsLivePreviewRefresh,
  type DocumentSaveStatus,
} from './preview-live-state'
import {
  EDITABLE_PREVIEW_MODE,
  resolvePreviewPresentation,
  type PreviewMode,
  type PreviewPresentation,
} from './preview-presentation'
import { ProseSkeleton } from './preview-skeleton'
import { useLiveFile, type LiveFileSnapshot } from './use-live-file'
import { useTextDocument } from './use-text-document'

const formatBytesDecimal = (bytes: number) => formatBytes(bytes, 1000)
import type { DirectoryEntry, IFileSystemProvider, VersionedFile } from './lib/types'

const MarkdownPreview = lazy(() =>
  import('./markdown-preview').then(module => ({ default: module.MarkdownPreview })),
)
const OfficePreview = lazy(() =>
  import('./office-preview').then(module => ({ default: module.OfficePreview })),
)

export type PreviewLiveCapability = { enabled: false } | { enabled: true; onBackToFolder(): void }

const DISABLED_LIVE_PREVIEW: PreviewLiveCapability = { enabled: false }

/**
 * The document's header, in whichever place the surface asked for it.
 *
 * Holding a region on its own it is a title bar with its own rule under it.
 * Portaled into the drive's control strip it is a run of controls sharing that
 * one row, and the rule and padding belong to the row — so the drive shows one
 * bar of chrome over the split instead of a bar per pane with two rules meeting
 * at the divider. Same markup either way; only where it lands and what frames
 * it.
 */
function DocumentHeader({ children }: { children: ReactNode }) {
  const slot = useDocumentHeaderSlot()
  const header = (
    <header
      data-files-preview-header
      className={cn(
        /* This header can be portaled into a narrow card, so its own container
           controls wrapping. Keep 44rem aligned with DOCUMENT_BESIDE_MIN_WIDTH. */
        'flex min-w-0 flex-wrap items-center gap-3 @[44rem]/files-doc:flex-nowrap',
        /* No rule of its own: the surface below the header already draws one,
           and two lines a few pixels apart read as a mistake. */
        slot.element === null
          ? 'min-h-14 justify-between px-4 py-2'
          : 'w-full min-w-0 flex-1 justify-start gap-2 py-1',
      )}
    >
      {children}
    </header>
  )
  return slot.element === null ? header : createPortal(header, slot.element)
}

function DocumentLeaveAction({
  onBack,
  onDismiss,
}: {
  onBack?: () => void
  onDismiss?: () => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  if (onDismiss) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label={t('closePreview')}
        data-files-preview-close
        className="-ml-2 size-11 shrink-0 rounded-lg bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground sm:size-9"
      >
        <XIcon className="size-4" />
      </Button>
    )
  }
  if (onBack) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        aria-label={t('liveFile.backToFolder')}
        data-files-preview-back
        className="-ml-2 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4 @[44rem]/files-doc:mr-1.5" />
        <span className="hidden @[44rem]/files-doc:inline">{t('liveFile.backToFolder')}</span>
      </Button>
    )
  }
  return null
}

export function PreviewPane({
  entry,
  provider,
  workspaceSlug,
  mode = EDITABLE_PREVIEW_MODE,
  live = DISABLED_LIVE_PREVIEW,
  onBack,
  onDismiss,
}: {
  entry: DirectoryEntry
  provider: IFileSystemProvider
  workspaceSlug: string
  /**
   * Leave the document and return to the folder it lives in.
   *
   * Supplied wherever the document sits inside the drive — holding the whole
   * region, or standing beside the column it was opened from. Closing it is the
   * document's own control either way; the public viewer has no folder to go
   * back to and omits it.
   */
  onBack?: () => void
  /** Dismiss an in-context viewer without implying navigation to a folder. */
  onDismiss?: () => void
  /**
   * How this document is presented. Defaults to the authenticated Drive's
   * editable/rich/attributed mode; the public viewer passes read-only/source.
   */
  mode?: PreviewMode
  live?: PreviewLiveCapability
}) {
  const t = useTranslations('duetApp.filesSurface')
  const liveEnabled = live.enabled && supportsLivePreviewRefresh(entry)
  const loadSnapshot = useMemo(() => createPreviewSnapshotLoader(provider, mode), [mode, provider])
  const liveFile = useLiveFile({
    provider,
    path: entry.path,
    enabled: liveEnabled,
    loadSnapshot,
  })
  const [oneShot, setOneShot] = useState<{
    snapshot: LiveFileSnapshot | null
    error: Error | null
    revision: number
  }>({ snapshot: null, error: null, revision: 0 })
  const mutationsUnavailable = liveMutationsUnavailable(liveFile.state.phase)

  useEffect(() => {
    if (liveEnabled) return
    const controller = new AbortController()
    setOneShot(current => ({ ...current, snapshot: null, error: null }))
    void loadSnapshot(entry, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (!result.success) {
        setOneShot(current => ({ ...current, error: result.error }))
        return
      }
      setOneShot(current => ({ ...current, snapshot: { entry, file: result.data } }))
    })
    return () => controller.abort()
  }, [entry, liveEnabled, loadSnapshot, oneShot.revision])

  const snapshot = liveEnabled ? liveFile.state.snapshot : oneShot.snapshot
  const acceptedEntry = snapshot?.entry ?? entry
  const file = snapshot?.file ?? null
  const extension = acceptedEntry.name.split('.').at(-1)?.toLowerCase() ?? ''
  const presentation = resolvePreviewPresentation(acceptedEntry.name, acceptedEntry.size, mode)
  const { isText, markdown, editable, autosaves, showHistory, showSeenBy } = presentation
  const source = previewSourceDescriptor(
    provider,
    acceptedEntry.path,
    file?.etag ?? null,
    liveEnabled,
  )

  const doc = useTextDocument({
    provider,
    path: acceptedEntry.path,
    file,
    snapshotEntry: acceptedEntry,
    isText,
    editable,
    contentType: textContentType(extension),
    mutationsUnavailable,
    live: liveFile,
  })
  // The Markdown rendered/source toggle only exists in rich mode; source mode
  // pins the raw view and never renders Markdown as a page.
  const [markdownView, setMarkdownView] = useState<'source' | 'rendered'>(
    markdown === 'toggle' ? 'rendered' : 'source',
  )

  useEffect(
    () => setMarkdownView(markdown === 'toggle' ? 'rendered' : 'source'),
    [acceptedEntry.path, markdown],
  )

  const retry = () => {
    doc.clearError()
    if (liveEnabled) liveFile.retry()
    else setOneShot(current => ({ ...current, revision: current.revision + 1 }))
  }
  const initialError = liveEnabled
    ? liveFile.state.snapshot === null && liveFile.state.phase === 'error'
      ? liveFile.state.error
      : null
    : oneShot.error
  if (snapshot === null && initialError === null) {
    /* The name and the size are already in hand from the listing that produced
       this entry — the only thing actually in flight is the content. So the
       header renders now and the skeleton is scoped to the one region with
       nothing to show yet, instead of blanking facts we already hold. */
    return (
      <section
        data-files-preview-pane
        className="@container/files-doc flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        aria-label={t('preview')}
      >
        <DocumentHeader>
          <DocumentLeaveAction onBack={onBack} onDismiss={onDismiss} />
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <h2 className="min-w-0 truncate text-sm font-semibold">{entry.name}</h2>
            {entry.size === undefined ? null : (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatBytesDecimal(entry.size)}
              </span>
            )}
          </div>
        </DocumentHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProseSkeleton />
        </div>
      </section>
    )
  }
  if (snapshot === null && initialError !== null) {
    return (
      <section
        data-files-preview-pane
        className="@container/files-doc flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        aria-label={t('preview')}
      >
        <DocumentHeader>
          <DocumentLeaveAction onBack={onBack} onDismiss={onDismiss} />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.name}</h2>
        </DocumentHeader>
        <PreviewState title={t('previewFailed')} body={initialError.message}>
          <Button variant="outline" size="sm" onClick={retry}>
            <ArrowClockwiseIcon className="mr-2 size-4" />
            {t('retry')}
          </Button>
        </PreviewState>
      </section>
    )
  }
  if (snapshot === null) return null

  const fileMissing = liveEnabled && liveFile.state.phase === 'missing'

  return (
    <section
      data-files-preview-pane
      className="@container/files-doc flex h-full min-h-0 flex-1 flex-col overflow-hidden duration-200 motion-safe:animate-in motion-safe:fade-in"
      aria-label={t('preview')}
    >
      <DocumentHeader>
        <DocumentLeaveAction onBack={onBack} onDismiss={onDismiss} />
        {/* flex-1 keeps the name beside Back when the controls wrap below. */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h2 className="min-w-0 truncate text-sm font-semibold">{acceptedEntry.name}</h2>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatBytesDecimal(snapshot.file.size)}
          </span>
          {showSeenBy ? <SeenBy workspaceSlug={workspaceSlug} path={acceptedEntry.path} /> : null}
        </div>
        <div
          className={cn(
            'flex min-w-0 shrink-0 items-center gap-1 @[44rem]/files-doc:w-auto @[44rem]/files-doc:flex-nowrap @[44rem]/files-doc:justify-start @[44rem]/files-doc:gap-2',
            onDismiss ? 'w-auto flex-nowrap' : 'w-full flex-wrap',
          )}
        >
          {markdown === 'toggle' && editable ? (
            /* Keep this secondary toggle below the title row's visual weight. */
            <div className="flex rounded-lg border bg-muted/30 p-0.5">
              <Button
                variant={markdownView === 'rendered' ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setMarkdownView('rendered')}
              >
                <EyeIcon className="size-3.5 @[44rem]/files-doc:mr-1" />
                <span className="sr-only @[44rem]/files-doc:not-sr-only">{t('preview')}</span>
              </Button>
              <Button
                variant={markdownView === 'source' ? 'secondary' : 'ghost'}
                size="xs"
                disabled={fileMissing}
                onClick={() => setMarkdownView('source')}
              >
                <PencilSimpleIcon className="size-3.5 @[44rem]/files-doc:mr-1" />
                <span className="sr-only @[44rem]/files-doc:not-sr-only">{t('edit')}</span>
              </Button>
            </div>
          ) : null}
          {autosaves ? <SaveStatus status={doc.status} /> : null}
          {showHistory ? (
            <FileHistoryDrawer workspaceSlug={workspaceSlug} path={acceptedEntry.path} />
          ) : null}
          <Button
            variant="outline"
            size="icon"
            asChild
            aria-label={t('download')}
            className="size-11 sm:size-9"
          >
            <a href={source.url} download={acceptedEntry.name}>
              <DownloadSimpleIcon className="size-4" />
              <span className="sr-only">{t('download')}</span>
            </a>
          </Button>
        </div>
      </DocumentHeader>
      {doc.conflict && editable ? (
        <div
          data-files-live-conflict
          data-files-live-banner
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <WarningIcon className="size-5 text-amber-600" />
          <span className="min-w-56 flex-1">{t('conflict')}</span>
          {/* Two versions exist and only the reader knows which one matters.
              They carry the same weight because neither is the safe default —
              one discards what they typed, the other discards what the drive
              received — and the tooltip, not the styling, is where each says
              plainly what it will do. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-files-live-action="reload-latest"
                variant="outline"
                size="sm"
                disabled={mutationsUnavailable}
                onClick={doc.reloadLatest}
              >
                {t('reload')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" collisionPadding={16} className="max-w-xs">
              {t('reloadTooltip')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-files-live-action="replace-file"
                variant="outline"
                size="sm"
                disabled={mutationsUnavailable}
                onClick={() => void doc.save(true)}
              >
                {t('saveAnyway')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" collisionPadding={16} className="max-w-xs">
              {t('saveAnywayTooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {liveEnabled && liveFile.state.phase === 'missing' ? (
        <div
          data-files-live-banner
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <WarningIcon className="size-5 text-amber-600" />
          <span className="min-w-56 flex-1">{t('liveFile.missing')}</span>
          <Button
            data-files-live-action="back-to-folder"
            variant="outline"
            size="sm"
            onClick={live.onBackToFolder}
          >
            {t('liveFile.backToFolder')}
          </Button>
        </div>
      ) : null}
      {doc.error !== null ? (
        <div
          role="alert"
          className="border-b border-destructive/30 px-4 py-2 text-sm text-destructive"
        >
          {doc.error.message}
        </div>
      ) : null}
      <div
        data-files-preview-body
        className={cn(
          'min-h-0 flex-1 overscroll-contain bg-muted/15',
          presentation.binary === null ? 'overflow-auto' : 'overflow-hidden',
        )}
      >
        {markdown === 'toggle' && markdownView === 'rendered' ? (
          <Suspense fallback={<ProseSkeleton />}>
            <MarkdownPreview content={doc.text} />
          </Suspense>
        ) : isText ? (
          /* The viewport minimum is only a fallback; bounded panes fill their host. */
          <div className="relative h-full p-4">
            <Textarea
              aria-label={t('editor')}
              data-files-editor
              readOnly={!editable || fileMissing}
              className={`h-full resize-none border-0 bg-transparent font-mono text-[13px] leading-6 shadow-none focus-visible:ring-0 ${
                doc.conflict ? 'mb-3 min-h-[38vh] md:mb-0 md:min-h-[45vh]' : 'min-h-[45vh]'
              }`}
              value={doc.text}
              /* Looking away is asking for it to be saved: the reader who
                 clicks into another pane or another app should not have to
                 wait out the debounce to be safe. */
              onBlur={() => void doc.save()}
              onChange={event => doc.edit(event.target.value)}
            />
            {doc.conflict && doc.text.split('\n').length > 20 ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-4 bottom-4 flex h-9 items-end justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-1"
              >
                <CaretDownIcon className="size-3.5 text-muted-foreground" />
              </div>
            ) : null}
          </div>
        ) : (
          <BinaryPreview
            entry={acceptedEntry}
            file={file}
            presentation={presentation}
            source={source}
          />
        )}
      </div>
    </section>
  )
}

/**
 * What the drive has of what you typed. It is a report, not a control: there
 * is nothing here to press, and the only reason to look is to confirm the
 * words are somewhere safe.
 */
function SaveStatus({ status }: { status: DocumentSaveStatus }) {
  const t = useTranslations('duetApp.filesSurface')
  if (status === 'none') return null
  const saved = status === 'saved'
  const saving = status === 'saving'
  return (
    <span
      data-files-save-status={status}
      role="status"
      aria-live="polite"
      /* A fixed slot, because this is the one thing in the header whose text
         changes by itself. Left to size itself, "Saved" becoming "Unsaved
         changes" would slide the filename and every control beside it out from
         under the reader's cursor — a document that shifts when you stop
         typing. */
      className="flex w-28 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
    >
      {saving ? (
        <SpinnerGapIcon aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
      ) : saved ? (
        <CheckIcon aria-hidden className="size-3.5" />
      ) : (
        /* The editor's unsaved dot, not a cloud: nothing here is about the
           network, and a slashed cloud reads as "disconnected". */
        <CircleIcon aria-hidden weight="fill" className="size-2" />
      )}
      {saving ? t('saving') : saved ? t('saved') : t('unsaved')}
    </span>
  )
}

function BinaryPreview({
  entry,
  file,
  presentation,
  source,
}: {
  entry: DirectoryEntry
  file: VersionedFile | null
  presentation: PreviewPresentation
  source: { url: string; key?: string }
}) {
  switch (presentation.binary) {
    case 'office':
      return (
        <div className="h-full min-h-0">
          <Suspense fallback={<Skeleton className="h-full min-h-[24rem] rounded-none" />}>
            <OfficePreview
              bytes={file?.data ?? new Uint8Array()}
              fileName={entry.name}
              downloadUrl={source.url}
              fallback={presentation.officeFallback}
            />
          </Suspense>
        </div>
      )
    case 'image':
      return <ImagePreview url={source.url} sourceKey={source.key} name={entry.name} />
    case 'pdf':
      return (
        <iframe
          key={source.key}
          title={entry.name}
          src={source.url}
          className="h-full w-full bg-muted/20 dark:bg-muted/10"
        />
      )
    case 'video':
      return (
        <VideoPreview
          url={source.url}
          sourceKey={source.key}
          name={entry.name}
          downloadUrl={source.url}
        />
      )
    case 'audio':
      return <AudioPreview url={source.url} sourceKey={source.key} name={entry.name} />
    default:
      return (
        <div className="h-full p-4">
          <pre className="h-full overflow-auto rounded-xl border bg-background p-4 font-mono text-xs leading-6 text-muted-foreground">
            {hexDump(file?.data ?? new Uint8Array())}
          </pre>
        </div>
      )
  }
}

function PreviewState({
  title,
  body,
  children,
}: {
  title: string
  body: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-[24rem] items-center justify-center p-8 text-center">
      <div className="space-y-3">
        <p className="font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
        {children}
      </div>
    </div>
  )
}

function textContentType(extension: string): string {
  if (extension === 'json') return 'application/json; charset=utf-8'
  if (extension === 'html') return 'text/html; charset=utf-8'
  if (extension === 'css') return 'text/css; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function hexDump(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'No preview bytes available.'
  return Array.from(bytes.slice(0, 512), value => value.toString(16).padStart(2, '0'))
    .reduce<string[]>((lines, value, index) => {
      if (index % 16 === 0) lines.push('')
      lines.at(-1)!.concat()
      lines[lines.length - 1] += `${value} `
      return lines
    }, [])
    .join('\n')
}
