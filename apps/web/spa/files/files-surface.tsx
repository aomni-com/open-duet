'use client'

import {
  ArrowUpIcon,
  CheckCircleIcon,
  CopyIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  FilePlusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  PencilSimpleIcon,
  PulseIcon,
  ShareNetworkIcon,
  SpinnerGapIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  DRIVE_UPLOAD_MAX_BYTES,
  FILE_TOO_LARGE_ERROR,
  filterDriveEntries,
  type App,
} from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { Input } from '@repo/ui/components/shadcn/input'
import { cn } from '@repo/ui/lib/utils'

import { uploadErrorCode } from '../api/vm-uploads'
import { WorkspaceEmptyState } from '../drive/workspace-page'
import { isStorageFullFileError } from '../entitlements/storage-surfaces'
import { formatBytes } from '../format'
import { LoadingHandoff } from '../loading/loading-handoff'
import { workspaceRefusalCopyKey } from '../workspace-refusal'
import { ActivityFeed } from './activity-feed'
import { projectFilesRows, type FilesRow } from './app-rows'
import { useAppNavigator, useDirectoryApps } from './apps-context'
import { DriveColumnsBrowser } from './drive-columns-browser'
import { DriveSkeleton } from './drive-skeleton'
import { DriveStatusDialog } from './drive-status-dialog'
import type { DriveChrome, DriveCommand } from './drive-toolbar'
import { runDriveUpload } from './drive-upload-run'
import { activateFilesRow } from './files-interactions'
import { FilesNotFound } from './files-not-found'
import {
  deletedPreviewRepairPath,
  filesViewQueryOptions,
  nextFilesViewCursor,
} from './lib/files-view'
import { joinBrowserFilePath, parentBrowserFilePath } from './lib/paths'
import type { DirectoryEntry, IFileSystemProvider } from './lib/types'
import { PreviewSkeleton } from './preview-skeleton'
import { ShareDialog, type ShareDialogApi, type ShareDialogTarget } from './share-dialog'

const formatBytesDecimal = (bytes: number) => formatBytes(bytes, 1000)

const PreviewPane = lazy(() =>
  import('./preview-pane').then(module => ({ default: module.PreviewPane })),
)

/* One frozen empty list, so a folder that has none does not hand the row
   projection a new array identity on every render. */
const NO_ENTRIES: readonly DirectoryEntry[] = []

/**
 * The narrowest browser region that can hold a document *beside* its listing.
 *
 * One column is `w-72` (18rem) and the document gets whatever is left, so this
 * is that column plus the least width a document is worth reading in — 26rem,
 * about sixty characters of prose. Below it the document takes the region over
 * instead, which is the older behaviour and the right one when the alternative
 * is a column with a sliver of text beside it.
 */
const DOCUMENT_BESIDE_MIN_WIDTH = 44 * 16

/** Only what the dialog copy needs to name the app and tell origin from replica. */
type DialogApp = Pick<App, 'slug'> & Partial<Pick<App, 'sourceShareId'>>

type DialogState =
  | { kind: 'create-file' | 'create-folder'; value: string }
  | {
      kind: 'rename' | 'copy' | 'move'
      entry: DirectoryEntry
      app?: DialogApp
      value: string
    }
  | {
      kind: 'delete'
      entry: DirectoryEntry
      app?: DialogApp
    }
  | null

type NoticeState = {
  tone: 'error' | 'success'
  message: string
  action?: { label: string; run(): void }
}

type UploadState = {
  done: number
  total: number
  currentName: string
  /** How far the current file has got, 0–100; 0 until the first report. */
  percent: number
  phase: 'uploading' | 'syncing'
}

export function FilesSurface({
  provider,
  shareApi,
  workspaceSlug,
  path,
  onNavigate,
  retryNotFound = false,
  chrome = 'page',
}: {
  provider: IFileSystemProvider
  shareApi: ShareDialogApi
  workspaceSlug: string
  path: string | null
  onNavigate(path: string, options?: { replace?: boolean }): void
  retryNotFound?: boolean
  /** whether the drive is the page or a guest — see `DriveChrome` */
  chrome?: DriveChrome
}) {
  const t = useTranslations('duetApp.filesSurface')
  const [dragging, setDragging] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [pending, setPending] = useState(false)
  const [shareTarget, setShareTarget] = useState<ShareDialogTarget | null>(null)
  // Ephemeral, per-session, default hidden-off. Dotfiles (`.env`, `.duet-anchor`,
  // …) are filtered out client-side after `list`; the provider and gateway stay
  // unaware of this authenticated-UI preference. It deliberately outlives
  // navigation and search — only the toolbar toggle changes it.
  const [showHidden, setShowHidden] = useState(false)
  /* Held here rather than inside the feed, because on the page the opener and
     the drawer are no longer the same element — see `ActivityFeed`'s `control`. */
  const [activityOpen, setActivityOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [uploading, setUploading] = useState<UploadState | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadInFlight = useRef(false)
  /* Held in a ref rather than state: pressing Stop must reach the transport, not
     schedule a render. */
  const uploadAbort = useRef<AbortController | null>(null)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const reduceMotion = useReducedMotion()
  const queryClient = useQueryClient()
  const appNavigator = useAppNavigator()

  /* The folder itself. `isPending` is the only state that draws the skeleton,
     and it is true exactly once per folder — the first time this session opens
     it. Every later arrival has an answer in hand and revalidates underneath,
     which is what `refreshing` says in the footer. */
  const viewOptions = filesViewQueryOptions(
    provider,
    workspaceSlug,
    path,
    retryNotFound
      ? { notFoundRetry: { attempts: 20, delayMs: 500 }, queryClient }
      : { queryClient },
  )
  const viewKey = viewOptions.queryKey
  const viewQuery = useQuery(viewOptions)
  const view = viewQuery.data ?? null
  /* The full-surface skeleton is for arriving with nothing, not for moving.
     Once any folder has resolved the columns own their own loading — each one
     skeletons only if *it* has never been read — so a later navigation must not
     blank a drive that is already showing cached ancestors. */
  const everResolved = useRef(false)
  if (viewQuery.data !== undefined) everResolved.current = true
  const loading = viewQuery.isPending && !everResolved.current
  const refreshing = viewQuery.isFetching && !viewQuery.isPending
  const entries = view?.status === 'folder' || view?.status === 'file' ? view.entries : NO_ENTRIES
  /* Where the columns stand.

     While a navigation is still resolving there is no canonical answer yet —
     but the address already says where the reader is going, so the chain is
     derived from it rather than collapsing to the root. That is what lets the
     folder you just clicked open as a new column in its own loading state while
     every cached ancestor keeps rendering, instead of the whole drive blanking.

     A path that turns out to name a file needs no correction here: `folderPath`
     is already the folder that file lives in, which is exactly the chain the
     columns beside the open document draw. */
  const folderPath =
    view?.status === 'folder' || view?.status === 'file' ? view.folderPath : (path ?? '/')
  const { query: apps } = useDirectoryApps(workspaceSlug, folderPath)
  const activitySelection =
    (view?.status === 'folder' || view?.status === 'file') && view.requestedPath !== '/'
      ? {
          path: view.requestedPath,
          scope: view.status === 'folder' ? ('subtree' as const) : ('exact' as const),
        }
      : undefined

  /* Is there room to stand a document beside the listing it was opened from?
     Measured on the browser region rather than the viewport, because this same
     surface is both a full page and the drive inside an agent's card — the page
     can be wide while the card is not, and each has to answer for itself.

     `useLayoutEffect`, so the first paint is already the right layout: a document
     that mounted as a takeover and became a split one frame later would tear,
     and would photograph differently depending on which frame the shot caught. */
  const browserRegion = useRef<HTMLElement>(null)
  const [roomBesideListing, setRoomBesideListing] = useState(false)
  useLayoutEffect(() => {
    const element = browserRegion.current
    if (element === null) return
    const measure = () => setRoomBesideListing(element.clientWidth >= DOCUMENT_BESIDE_MIN_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  /* A document has taken the browser region over, which is now only what
     happens when there was no room to stand it beside the listing. Chrome that
     describes a listing — the footer, the drop zone — has nothing to describe
     while it has; beside a listing that is still on screen, both still do. */
  const documentTakeover = view?.status === 'file' && !roomBesideListing

  /* Rewriting the folder in place, so an optimistic row edit and the answer it
     anticipates are the same value rather than two that must agree. */
  const writeEntries = (next: readonly DirectoryEntry[]) =>
    queryClient.setQueryData(viewKey, current =>
      current?.status === 'folder' || current?.status === 'file'
        ? { ...current, entries: next }
        : current,
    )
  // The cached folder is the mutation source of truth; the drive presents only
  // the entries the hidden policy allows.
  const visibleEntries = filterDriveEntries(entries, showHidden ? 'include' : 'exclude')
  const rows = projectFilesRows({
    entries: visibleEntries,
    apps: apps.data?.items ?? [],
  })
  const directoryIncomplete = nextFilesViewCursor(view ?? undefined) !== null
  /* The entries can be complete while their row identities are not. Until the
     folder-scoped app source reaches its terminal page, a later page can still
     turn an ordinary folder into an app row, so the combined view reports a
     loaded prefix rather than an exact classification count. */
  const rowClassificationIncomplete =
    directoryIncomplete ||
    apps.isPending ||
    apps.hasNextPage ||
    apps.isError ||
    apps.isFetchNextPageError

  /* A warm re-read of the folder you are standing in, after your own write.
     It differs from arriving: the picture is already right, so a failure is a
     notice over a folder that still reads rather than a blank failure page, and
     a preview whose file has just gone hands you back its folder. */
  const refresh = async () => {
    const before = queryClient.getQueryData(viewKey) ?? null
    const { data } = await viewQuery.refetch()
    if (data === undefined) return
    const repairPath = deletedPreviewRepairPath(before, data)
    if (repairPath !== null) {
      onNavigateRef.current(repairPath, { replace: true })
      return
    }
    if (data.status === 'error' && (before?.status === 'folder' || before?.status === 'file')) {
      queryClient.setQueryData(viewKey, before)
      setNotice({ tone: 'error', message: data.error.message })
    }
  }

  useEffect(() => {
    setNotice(null)
  }, [path])

  /* The bytes never pass through this page. A picked file goes straight at the
     workspace VM (see `RestFileSystemProvider.upload`), because reading a
     multi-gigabyte one into memory to send it is what used to take the tab
     down. */
  const upload = async (files: File[]) => {
    if (files.length === 0 || uploadInFlight.current) return
    uploadInFlight.current = true
    setNotice(null)
    setUploading({
      done: 0,
      total: files.length,
      currentName: files[0]!.name,
      percent: 0,
      phase: 'uploading',
    })
    try {
      const controller = new AbortController()
      uploadAbort.current = controller
      const run = await runDriveUpload({
        files,
        folderPath,
        provider,
        onProgress: state => setUploading({ ...state, phase: 'uploading' }),
        signal: controller.signal,
      })
      if (!run.ok) {
        /* Stopped on purpose: no error, because nothing went wrong. The count
           is the only thing the person does not already know. */
        if ('cancelled' in run) {
          setNotice({ tone: 'success', message: t('uploadStopped', { count: run.done }) })
          await refresh()
          return
        }
        /* A file refused for size never reached the drive, so there is nothing
           to re-read — and its reason is a rule we can state, unlike the raw
           exception text the generic branch has to fall back on. */
        if (uploadErrorCode(run.error) === FILE_TOO_LARGE_ERROR) {
          setNotice({
            tone: 'error',
            message: t('uploadTooLarge', {
              name: run.file.name,
              limit: formatBytes(DRIVE_UPLOAD_MAX_BYTES, 1000),
            }),
          })
          return
        }
        if (!isStorageFullFileError(run.error)) {
          setNotice({ tone: 'error', message: `${run.file.name}: ${run.error.message}` })
        }
        await refresh()
        return
      }
      setUploading({
        done: files.length,
        total: files.length,
        currentName: files.at(-1)!.name,
        percent: 100,
        phase: 'syncing',
      })
      await refresh()
      setNotice({ tone: 'success', message: t('uploadComplete', { count: files.length }) })
    } finally {
      uploadAbort.current = null
      uploadInFlight.current = false
      setUploading(null)
    }
  }

  // Delete the folder, and only the folder. The app row inside it is not this
  // surface's to unlink: the anchor rail reaps a row whose folder stays gone, so
  // there is one deletion here instead of two that could half-succeed and strand
  // an app against a folder that is already gone.
  const deleteDialogEntry = async (state: Extract<DialogState, { kind: 'delete' }>) => {
    const before = entries
    setPending(true)
    setNotice(null)
    writeEntries(before.filter(entry => entry.path !== state.entry.path))
    const result = await provider.delete(state.entry.path, { recursive: state.entry.isDirectory })
    if (result.success) {
      await finishMutation({ success: true, data: undefined }, t('deleted'))
      return
    }

    setPending(false)
    setDialog(null)
    writeEntries(before)
    setNotice({ tone: 'error', message: result.error.message })
  }

  const applyDialog = async () => {
    if (dialog === null) return
    if (dialog.kind === 'delete') {
      await deleteDialogEntry(dialog)
      return
    }
    setPending(true)
    setNotice(null)
    if (dialog.kind === 'create-folder') {
      const path = safeChildPath(folderPath, dialog.value)
      const result =
        path instanceof Error
          ? { success: false as const, error: path }
          : await provider.mkdir(path)
      await finishMutation(result, t('folderCreated'))
      return
    }
    if (dialog.kind === 'create-file') {
      const path = safeChildPath(folderPath, dialog.value)
      const result =
        path instanceof Error
          ? { success: false as const, error: path }
          : await provider.write(path, new Uint8Array(), {
              contentType: 'text/plain; charset=utf-8',
            })
      await finishMutation(result, t('fileCreated'))
      return
    }
    const destination =
      dialog.kind === 'rename'
        ? safeChildPath(parentBrowserFilePath(dialog.entry.path), dialog.value)
        : dialog.kind === 'copy'
          ? safeChildPath(folderPath, dialog.value)
          : safeDestinationPath(dialog.value)
    if (destination instanceof Error) {
      await finishMutation({ success: false, error: destination }, '')
      return
    }
    if (!('entry' in dialog)) return
    const sourceEntry = dialog.entry
    const before = entries
    if (dialog.kind === 'rename') {
      writeEntries(
        before.map(entry =>
          entry.path === sourceEntry.path
            ? { ...entry, name: dialog.value, path: destination }
            : entry,
        ),
      )
    }
    const result =
      dialog.kind === 'copy'
        ? await provider.copy(sourceEntry.path, destination, {
            recursive: sourceEntry.isDirectory,
          })
        : await provider.rename(sourceEntry.path, destination)
    if (!result.success) writeEntries(before)
    await finishMutation(
      result,
      dialog.kind === 'copy' ? t('copied') : dialog.kind === 'move' ? t('moved') : t('renamed'),
    )
  }

  const finishMutation = async (
    result: { success: true; data: unknown } | { success: false; error: Error },
    successMessage: string,
  ) => {
    setPending(false)
    if (!result.success) {
      setDialog(null)
      if (!isStorageFullFileError(result.error)) {
        setNotice({ tone: 'error', message: result.error.message })
      }
      return
    }
    setDialog(null)
    setNotice({ tone: 'success', message: successMessage })
    await refresh()
  }

  const openActionDialog = (row: FilesRow, kind: 'rename' | 'copy' | 'move' | 'delete') => {
    const entry = row.entry
    setDialog(
      kind === 'delete'
        ? { kind, entry, app: row.app?.app }
        : {
            kind,
            entry,
            app: row.app?.app,
            value:
              kind === 'move'
                ? entry.path
                : kind === 'copy'
                  ? duplicateName(entry.name)
                  : entry.name,
          },
    )
  }

  const openEntry = (entry: DirectoryEntry) => {
    onNavigate(entry.path)
  }

  /* The drive's own affordances, described once and drawn as menu items by
     whichever of the strip's two menus is showing — one list, so neither can
     forget what the other offers.

     The activity feed joins them on the page and only there. It is a live
     readout rather than a command, and inside a card it keeps a pill of its own
     for exactly that reason — but the page's strip has nine controls competing
     for one row, and a status behind the same mark as everything else is a
     better trade there than a tenth pill. The card is unchanged. */
  const driveCommands: readonly DriveCommand[] = [
    {
      key: 'upload',
      label: t('upload'),
      Icon: UploadSimpleIcon,
      disabled: uploading !== null,
      run: () => uploadInput.current?.click(),
    },
    {
      key: 'new-folder',
      label: t('newFolder'),
      Icon: FolderPlusIcon,
      run: () => setDialog({ kind: 'create-folder', value: '' }),
    },
    {
      key: 'new-file',
      label: t('newFile'),
      Icon: FilePlusIcon,
      run: () => setDialog({ kind: 'create-file', value: '' }),
    },
    {
      /* A toggle, so it carries `pressed`: the strip draws it lit and the menu
         draws it checked, off the same field. */
      key: 'hidden',
      label: t(showHidden ? 'drive.hideHiddenFiles' : 'drive.showHiddenFiles'),
      Icon: showHidden ? EyeIcon : EyeSlashIcon,
      pressed: showHidden,
      run: () => setShowHidden(value => !value),
    },
    ...(chrome === 'inline'
      ? []
      : [
          {
            key: 'activity',
            label: t('activity.open'),
            Icon: PulseIcon,
            run: () => setActivityOpen(true),
          },
        ]),
  ]

  const activateRow = (row: FilesRow) => {
    activateFilesRow(row, {
      navigator: appNavigator,
      openEntry,
    })
  }

  /* `main` only where the drive IS the page, which is the same distinction
     `chrome` already draws for the strip: on the drive's own route this element
     is the document's one landmark, and inline it is one of four cards on an
     agent's page whose landmark `agents-section` already owns. A `main` in the
     inline case hands a screen reader two "main"s to pick the page out of.

     Either way the surface keeps its name, so inline it is a labelled
     `section` — still a region a reader can jump to, no longer a rival for the
     page. */
  const Landmark = chrome === 'inline' ? 'section' : 'main'

  return (
    <Landmark
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label={t('files')}
      data-files-surface
      data-files-path={folderPath}
    >
      <h1 className="sr-only">{t('files')}</h1>
      <input
        ref={uploadInput}
        className="hidden"
        type="file"
        multiple
        disabled={uploading !== null}
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.currentTarget.value = ''
          void upload(files)
        }}
      />

      <div className="pointer-events-none absolute bottom-12 right-3 z-40 w-[min(22rem,calc(100%-1.5rem))] sm:right-4">
        {notice && uploading === null ? (
          <motion.div
            key={`${notice.tone}:${notice.message}`}
            initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
            }
          >
            <Notice
              tone={notice.tone}
              message={notice.message}
              action={notice.action}
              onClose={() => setNotice(null)}
            />
          </motion.div>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {uploading ? (
          <motion.div
            key="upload"
            role="status"
            aria-label={t('uploadProgressLabel')}
            aria-live="polite"
            className="relative z-30 flex shrink-0 items-center gap-3 overflow-hidden border-b bg-brand/[0.045] px-4 py-2.5"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
            }
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
              {uploading.phase === 'syncing' ? (
                <CheckCircleIcon aria-hidden className="size-4" weight="fill" />
              ) : (
                <ArrowUpIcon aria-hidden className="size-4" weight="bold" />
              )}
            </span>
            <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
              <p className="truncate text-sm font-medium">
                {uploading.phase === 'syncing'
                  ? t('finishingUpload')
                  : t('uploadingFile', { name: uploading.currentName })}
              </p>
              <p className="shrink-0 text-xs text-muted-foreground">
                {/* A gigabyte-scale file sits on one line of this banner for
                    minutes. The percentage is the only thing that distinguishes
                    "still going" from "stuck", so it joins the count as soon as
                    the transfer reports anything at all. */}
                {uploading.phase === 'uploading' && uploading.percent > 0
                  ? t('uploadingPercent', {
                      done: Math.min(uploading.done + 1, uploading.total),
                      total: uploading.total,
                      percent: uploading.percent,
                    })
                  : t('uploading', {
                      done: Math.min(uploading.done + 1, uploading.total),
                      total: uploading.total,
                    })}
              </p>
            </div>
            {uploading.phase === 'uploading' ? (
              <>
                <SpinnerGapIcon
                  aria-hidden
                  className="size-4 shrink-0 animate-spin text-brand motion-reduce:animate-none"
                />
                {/* Only while bytes are moving. Once the drive is being re-read
                    there is nothing left to stop, and a control that does
                    nothing is worse than no control. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => uploadAbort.current?.abort()}
                >
                  {t('stopUpload')}
                </Button>
              </>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1">
        <section
          ref={browserRegion}
          /* The portaled header sits outside PreviewPane, so this region must
             provide the same named width boundary. */
          className="@container/files-doc flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1"
          /* Drop-to-upload targets the folder you are looking at. While a
             document has taken the region over there is no such folder on
             screen, so the drop would land somewhere the reader cannot see —
             the zone goes away with the listing it belongs to. */
          onDragEnter={
            documentTakeover
              ? undefined
              : event => {
                  event.preventDefault()
                  setDragging(true)
                }
          }
          onDragOver={documentTakeover ? undefined : event => event.preventDefault()}
          onDragLeave={
            documentTakeover
              ? undefined
              : event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDragging(false)
                  }
                }
          }
          onDrop={
            documentTakeover
              ? undefined
              : event => {
                  event.preventDefault()
                  setDragging(false)
                  void upload(Array.from(event.dataTransfer.files))
                }
          }
          aria-label={t('browser')}
        >
          <LoadingHandoff loading={loading} fallback={<DriveSkeleton label={t('drive.loading')} />}>
            {view === null && viewQuery.error !== null ? (
              /* A folder nobody could ask about, and no earlier answer to
                 fall back on. Every failure the server actually gave becomes a
                 view and is told by the branch below; this is the thrown one —
                 see `filesViewQueryOptions` — and without this branch the drive
                 would draw an empty listing for it. */
              <LoadFailure error={viewQuery.error} onRetry={() => void viewQuery.refetch()} />
            ) : view?.status === 'error' ? (
              <LoadFailure error={view.error} onRetry={() => void viewQuery.refetch()} />
            ) : view?.status === 'not-found' ? (
              <FilesNotFound
                onOpenParent={() => onNavigate(path === null ? '/' : view.parentPath)}
              />
            ) : documentTakeover && view?.status === 'file' ? (
              /* No room to stand it beside the listing, so the document *takes
                 over* the drive rather than floating in a dialog above it. A
                 lightbox dimmed the columns it covered, which read as "you are
                 somewhere else" while the address bar still said you were in the
                 drive — and on a narrow viewport it left the document a boxed
                 panel inside a page it had already taken.

                 It fills the whole browser region, control strip included: the
                 toolbar sorts and filters a listing, and there is no listing
                 left to sort. The document's own header carries its name and the
                 way back, so nothing points at a folder you cannot see. */
              <OpenDocument
                entry={view.previewed}
                provider={provider}
                workspaceSlug={workspaceSlug}
                onBack={() => onNavigate(view.folderPath)}
              />
            ) : (
              <DriveColumnsBrowser
                provider={provider}
                workspaceSlug={workspaceSlug}
                folderPath={folderPath}
                selectedPath={view?.requestedPath ?? null}
                apps={apps.data?.items ?? []}
                showHidden={showHidden}
                /* The document, standing in the width the stack gives up. It is
                   the same component the takeover renders — the modes differ in
                   how much room the document gets, not in what a document is. */
                documentPane={
                  view?.status === 'file' ? (
                    <OpenDocument
                      entry={view.previewed}
                      provider={provider}
                      workspaceSlug={workspaceSlug}
                      onBack={() => onNavigate(view.folderPath)}
                    />
                  ) : undefined
                }
                onNavigate={onNavigate}
                onOpenFile={filePath => onNavigate(filePath)}
                onOpenApp={activateRow}
                chrome={chrome}
                commands={driveCommands}
                activity={
                  <ActivityFeed
                    workspaceSlug={workspaceSlug}
                    {...activitySelection}
                    compact={chrome === 'inline'}
                    control={
                      chrome === 'inline'
                        ? undefined
                        : { open: activityOpen, onOpenChange: setActivityOpen }
                    }
                    onNavigate={browserPath => onNavigate(parentBrowserFilePath(browserPath))}
                  />
                }
                renderMenu={row => {
                  const entry = row.entry
                  return (
                    <FileActionsMenu
                      name={entry.name}
                      isDirectory={entry.isDirectory}
                      appFolder={row.app !== undefined}
                      onOpenFolder={() => {
                        if (entry === undefined) activateRow(row)
                        else openEntry(entry)
                      }}
                      onShare={
                        entry?.isDirectory === true && row.app?.app.sourceShareId === undefined
                          ? () => setShareTarget({ name: entry.name, path: entry.path })
                          : undefined
                      }
                      onAction={kind => openActionDialog(row, kind)}
                    />
                  )
                }}
              />
            )}
          </LoadingHandoff>
          {dragging ? (
            <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 backdrop-blur-sm">
              <div className="text-center">
                <UploadSimpleIcon className="mx-auto mb-3 size-10 text-primary" />
                <p className="font-semibold">{t('dropFiles')}</p>
                <p className="text-sm text-muted-foreground">{folderPath}</p>
              </div>
            </div>
          ) : null}
        </section>
      </div>
      {/* The footer counts and sizes the open folder. A document that has taken
          the region over is not that folder, and the document's own header
          already carries its name and size — so the footer leaves with the
          listing it describes rather than reporting on something off screen. */}
      {documentTakeover || view?.status === 'error' ? null : (
        <footer className="flex min-h-9 items-center justify-between gap-3 border-t border-border/65 bg-muted/15 px-4 text-xs text-muted-foreground">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1">
            <span>
              {t(rowClassificationIncomplete ? 'loadedItemCount' : 'itemCount', {
                count: rows.length,
              })}
            </span>
            {refreshing && uploading === null ? (
              <SpinnerGapIcon
                aria-label={t('drive.loading')}
                className="size-3 animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {apps.isPending ? (
              <span aria-live="polite">{t('loadingAppDetails')}</span>
            ) : apps.hasNextPage || apps.isError ? (
              <span className="flex items-center gap-2" aria-live="polite">
                <span
                  role={apps.isFetchNextPageError || apps.isError ? 'alert' : undefined}
                  className={
                    apps.isFetchNextPageError || apps.isError ? 'text-destructive' : undefined
                  }
                >
                  {apps.isFetchingNextPage
                    ? t('loadingAppDetails')
                    : apps.isFetchNextPageError || apps.isError
                      ? t('appDetailsFailed')
                      : t('moreAppDetailsAvailable')}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 bg-background px-2 text-xs text-foreground shadow-sm"
                  disabled={apps.isFetchingNextPage}
                  onClick={() => {
                    if (apps.isFetchNextPageError || apps.hasNextPage) void apps.fetchNextPage()
                    else void apps.refetch()
                  }}
                >
                  {apps.isFetchingNextPage
                    ? t('loadingMoreApps')
                    : apps.isFetchNextPageError || apps.isError
                      ? t('retryMoreApps')
                      : t('loadMoreApps')}
                </Button>
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => setStatusOpen(true)}
            aria-label={t('status.open')}
            className="-mr-1 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HardDriveIcon aria-hidden className="size-3.5" />
            {formatBytesDecimal(visibleEntries.reduce((sum, entry) => sum + (entry.size ?? 0), 0))}
          </button>
        </footer>
      )}
      <DriveStatusDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        path={folderPath}
        entries={visibleEntries}
        incomplete={directoryIncomplete}
      />
      <OperationDialog
        state={dialog}
        pending={pending}
        onChange={value =>
          setDialog(current => (current && 'value' in current ? { ...current, value } : current))
        }
        onClose={() => !pending && setDialog(null)}
        onSubmit={() => void applyDialog()}
      />
      <ShareDialog
        api={shareApi}
        workspaceSlug={workspaceSlug}
        target={shareTarget}
        open={shareTarget !== null}
        onOpenChange={open => {
          if (!open) setShareTarget(null)
        }}
        onShared={() => {
          setNotice({ tone: 'success', message: t('shareDialog.sent') })
        }}
      />
    </Landmark>
  )
}

/**
 * The drive's own affordances, in the control strip's rhythm.
 *
 * Every one of these is the behavior the card grid already had — this moves
 * where they sit, not what they do. They stay on the left so the view controls
 * (which change what you are looking at) never sit next to the ones that change
 * what is there.
 */
/**
 * An open document — the same one whether it holds the whole browser region or
 * stands in the width the column stack gives up.
 *
 * One component for both, because the modes disagree about how much room a
 * document gets and about nothing else. Two would have been two places to keep
 * Escape, the live-file wiring and the marker below in step.
 *
 * It carries `data-files-preview` — the marker the lightbox used to own. The
 * claim it makes ("a document is open") did not change when the presentation
 * did, and the staging deep-link journey reads it, so the name stays with the
 * meaning rather than with the deleted dialog.
 *
 * Escape comes along for the same reason: it closed the lightbox, people
 * learned it, and neither taking the region over nor standing beside a column
 * makes that gesture wrong. It is bound to the document rather than to a focused
 * node so it works wherever the reader's focus happens to be — except inside the
 * editor, where Escape is the textarea's to answer.
 */
function OpenDocument({
  entry,
  provider,
  workspaceSlug,
  onBack,
}: {
  entry: DirectoryEntry
  provider: IFileSystemProvider
  workspaceSlug: string
  onBack(): void
}) {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  useEffect(() => {
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return
      /* Escape belongs to the innermost thing that can be dismissed. A history
         drawer, a menu, or a confirm dialog open over the document all answer it
         first — leaving the drive is only what Escape means when the document
         itself is the outermost thing on screen. */
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null) {
        return
      }
      onBackRef.current()
    }
    /* Capture phase, deliberately. Radix closes its own layer on bubble, so a
       bubble-phase listener here sees the DOM *after* the drawer is already
       gone, finds no dialog, and leaves the document as well — one Escape
       dismissing two things. Running first means the check reads the state the
       reader actually pressed Escape against. */
    window.addEventListener('keydown', leave, true)
    return () => window.removeEventListener('keydown', leave, true)
  }, [])

  return (
    /* The loading wrapper is not flex, so flex-1 alone cannot fill it. */
    <div data-files-preview className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<PreviewSkeleton />}>
        <PreviewPane
          entry={entry}
          provider={provider}
          workspaceSlug={workspaceSlug}
          live={{ enabled: true, onBackToFolder: onBack }}
          onBack={onBack}
        />
      </Suspense>
    </div>
  )
}

function FileActionsMenu({
  name,
  isDirectory,
  appFolder,
  onOpenFolder,
  onShare,
  onAction,
}: {
  name: string
  isDirectory: boolean
  appFolder: boolean
  onOpenFolder(): void
  onShare?(): void
  onAction(kind: 'rename' | 'copy' | 'move' | 'delete'): void
}) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 opacity-100 md:opacity-0 md:group-hover:opacity-100"
          aria-label={t('actions', { name })}
          data-files-action="menu"
          onClick={appFolder ? event => event.stopPropagation() : undefined}
        >
          <DotsThreeIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={appFolder ? event => event.stopPropagation() : undefined}
      >
        <DropdownMenuItem data-files-menu-action="open-folder" onClick={onOpenFolder}>
          <FolderOpenIcon className="mr-2 size-4" />
          {appFolder ? t('openFolder') : isDirectory ? t('open') : t('preview')}
        </DropdownMenuItem>
        {onShare ? (
          <DropdownMenuItem onClick={onShare}>
            <ShareNetworkIcon className="mr-2 size-4" />
            {t('share')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem data-files-menu-action="rename" onClick={() => onAction('rename')}>
          <PencilSimpleIcon className="mr-2 size-4" />
          {t('rename')}
        </DropdownMenuItem>
        <DropdownMenuItem data-files-menu-action="copy" onClick={() => onAction('copy')}>
          <CopyIcon className="mr-2 size-4" />
          {t('makeCopy')}
        </DropdownMenuItem>
        <DropdownMenuItem data-files-menu-action="move" onClick={() => onAction('move')}>
          <ArrowUpIcon className="mr-2 size-4" />
          {t('move')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive"
          data-files-menu-action="delete"
          onClick={() => onAction('delete')}
        >
          <TrashIcon className="mr-2 size-4" />
          {t('delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OperationDialog({
  state,
  pending,
  onChange,
  onClose,
  onSubmit,
}: {
  state: DialogState
  pending: boolean
  onChange(value: string): void
  onClose(): void
  onSubmit(): void
}) {
  const t = useTranslations('duetApp.filesSurface')
  if (state === null) return null
  const deleteState = state.kind === 'delete' ? state : undefined
  const valueState = 'value' in state ? state : undefined
  const deleting = deleteState !== undefined
  const originApp = deleteState?.app?.sourceShareId === undefined ? deleteState?.app : undefined
  const replicaApp =
    'app' in state && state.app?.sourceShareId !== undefined ? state.app : undefined
  let title: string
  let description: string
  if (deleteState === undefined) {
    title = t(`dialog.${state.kind}.title`)
    description =
      replicaApp !== undefined && (state.kind === 'rename' || state.kind === 'move')
        ? t(`dialog.${state.kind}.replicaBody`, { app: replicaApp.slug })
        : t(`dialog.${state.kind}.body`)
  } else if (originApp !== undefined) {
    title = t('dialog.delete.appTitle', { name: deleteState.entry.name })
    description = t('dialog.delete.appBody', { app: originApp.slug, name: deleteState.entry.name })
  } else if (replicaApp !== undefined) {
    title = t('dialog.delete.replicaTitle')
    description = t('dialog.delete.replicaBody', { app: replicaApp.slug })
  } else {
    title = t('dialog.delete.title')
    description = t('dialog.delete.body', { name: deleteState.entry.name })
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {valueState !== undefined ? (
          <Input
            autoFocus
            aria-label={t(`dialog.${state.kind}.label`)}
            value={valueState.value}
            onChange={event => onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') onSubmit()
            }}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button
            variant={deleting ? 'destructive' : 'default'}
            data-files-dialog-action="confirm"
            onClick={onSubmit}
            disabled={pending || (valueState !== undefined && valueState.value.trim().length === 0)}
          >
            {pending ? t('working') : deleteState !== undefined ? t('delete') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LoadFailure({ error, onRetry }: { error: Error; onRetry(): void }) {
  const t = useTranslations('duetApp.filesSurface')
  const refusal = workspaceRefusalCopyKey(error)
  return (
    <div role="alert" className="h-full">
      <WorkspaceEmptyState
        className="h-full min-h-80"
        tone="destructive"
        icon={<WarningIcon />}
        title={refusal === null ? t('folderLoadFailed') : t(`refusals.${refusal}.title`)}
        body={refusal === null ? error.message : t(`refusals.${refusal}.body`)}
        action={
          <Button variant="outline" onClick={onRetry}>
            {refusal === null ? t('retry') : t('refusals.checkAgain')}
          </Button>
        }
      />
    </div>
  )
}

function Notice({
  tone,
  message,
  action,
  onClose,
}: {
  tone: 'error' | 'success'
  message: string
  action?: { label: string; run(): void }
  onClose(): void
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-center gap-2 rounded-xl border px-3.5 py-3 text-sm shadow-lg shadow-foreground/10 backdrop-blur-sm',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-emerald-500/30 bg-background/95 text-emerald-700 dark:text-emerald-300',
      )}
    >
      {tone === 'error' ? (
        <WarningIcon className="size-4" />
      ) : (
        <CheckCircleIcon className="size-4" weight="fill" />
      )}
      <span className="flex-1">{message}</span>
      {action ? (
        <Button variant="outline" size="sm" onClick={action.run}>
          {action.label}
        </Button>
      ) : null}
      <button onClick={onClose} className="font-medium">
        ×
      </button>
    </div>
  )
}

function safeChildPath(parent: string, name: string): string | Error {
  try {
    return joinBrowserFilePath(parent, name.trim())
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
function safeDestinationPath(path: string): string | Error {
  const value = path.trim()
  return value.startsWith('/') && !value.includes('/../')
    ? value
    : new Error('Enter an absolute destination path.')
}
function duplicateName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name} copy` : `${name.slice(0, dot)} copy${name.slice(dot)}`
}
