'use client'

import { XIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { Dialog, DialogContent, DialogTitle } from '@repo/ui/components/shadcn/dialog'

import type { SpaApi } from '../context'
import { fileName, normalizeBrowserFilePath } from '../files/lib/paths'
import {
  directoryEntryFromContract,
  type DirectoryEntry,
  type IFileSystemProvider,
} from '../files/lib/types'
import { PreviewPane } from '../files/preview-pane'
import { READONLY_RICH_PREVIEW_MODE } from '../files/preview-presentation'
import { ProseSkeleton } from '../files/preview-skeleton'

/**
 * A file named by a conversation, in the wire dialect: drive-relative, or the
 * VM-absolute path an agent sees. Not a browser path — there a leading slash
 * is the drive root, and collapsing the two would turn `/home/exedev/drive/x`
 * into a phantom folder inside the drive.
 */
type SessionFileTarget = {
  path: string
  size?: number
}

/**
 * The entry a wire-dialect target names, as the gateway resolves it.
 *
 * The stat goes out in the wire dialect on purpose: the client keeps a leading
 * slash (`%2F`) and the gateway contains a VM-absolute path against its live
 * drive root, so the frontend never needs to know the VM layout. The entry
 * that comes back carries the canonical drive path, which is what the
 * preview then reads through the provider.
 */
export async function resolveSessionFileTarget(
  api: Pick<SpaApi, 'statWorkspaceFile'>,
  workspaceSlug: string,
  target: SessionFileTarget,
  signal?: AbortSignal,
): Promise<DirectoryEntry | null> {
  try {
    const entry = directoryEntryFromContract(
      (await api.statWorkspaceFile(workspaceSlug, target.path, signal)).entry,
    )
    return entry.isDirectory ? null : entry
  } catch {
    return null
  }
}

type SessionFileViewerContextValue = {
  openFile(target: SessionFileTarget, restoreFocus?: HTMLElement): void
  fileUrl(path: string): string
}

const SessionFileViewerContext = createContext<SessionFileViewerContextValue | null>(null)

export function useSessionFileViewer(): SessionFileViewerContextValue | null {
  return useContext(SessionFileViewerContext)
}

/**
 * A conversation keeps the reader in context while it borrows Drive's one
 * preview engine. The file remains read-only here: editing, history, and the
 * folder hierarchy still belong to Drive, while inspecting an artifact belongs
 * beside the message that introduced it.
 */
export function SessionFileViewerProvider({
  workspaceSlug,
  api,
  provider,
  children,
}: {
  workspaceSlug: string
  api: Pick<SpaApi, 'statWorkspaceFile'>
  provider: IFileSystemProvider
  children: ReactNode
}) {
  const t = useTranslations('duetApp.filesSurface')
  const [entry, setEntry] = useState<DirectoryEntry | null>(null)
  const [resolving, setResolving] = useState(false)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const resolution = useRef<AbortController | null>(null)

  const close = () => {
    resolution.current?.abort()
    resolution.current = null
    setResolving(false)
    setEntry(null)
  }

  useEffect(() => () => resolution.current?.abort(), [])

  const value = useMemo<SessionFileViewerContextValue>(
    () => ({
      openFile: (next, trigger) => {
        const nextEntry = fileEntry(next)
        if (nextEntry === null) return
        resolution.current?.abort()
        restoreFocus.current = trigger ?? null
        setEntry(nextEntry)
        if (nextEntry.size !== undefined) {
          setResolving(false)
          return
        }

        const controller = new AbortController()
        resolution.current = controller
        setResolving(true)
        void resolveSessionFileTarget(api, workspaceSlug, next, controller.signal).then(
          resolved => {
            if (controller.signal.aborted) return
            resolution.current = null
            setResolving(false)
            // Stat owns both the canonical logical filename and its actual
            // size. A label supplied by Markdown is presentation, never file
            // identity.
            if (resolved !== null) setEntry(resolved)
          },
        )
      },
      fileUrl: path => provider.downloadUrl(path),
    }),
    [api, provider, workspaceSlug],
  )

  return (
    <SessionFileViewerContext.Provider value={value}>
      {children}
      <Dialog open={entry !== null} onOpenChange={open => !open && close()}>
        <DialogContent
          hideCloseButton
          aria-describedby={undefined}
          data-session-file-viewer
          onCloseAutoFocus={event => {
            if (restoreFocus.current === null) return
            event.preventDefault()
            restoreFocus.current.focus()
            restoreFocus.current = null
          }}
          className="h-dvh max-h-none w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-2xl outline-none sm:h-[min(92dvh,64rem)] sm:w-[min(94vw,96rem)] sm:rounded-2xl sm:border sm:border-border/80"
        >
          <DialogTitle className="sr-only">{entry?.name}</DialogTitle>
          {entry && resolving ? (
            <section
              data-session-file-resolving
              className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
              aria-label={t('opening')}
            >
              <header className="flex min-h-14 items-center gap-2.5 px-4 py-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={close}
                  aria-label={t('closePreview')}
                  className="-ml-2 size-11 shrink-0 rounded-lg bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground sm:size-9"
                >
                  <XIcon className="size-4" />
                </Button>
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.name}</h2>
                <span className="text-xs text-muted-foreground">{t('opening')}</span>
              </header>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ProseSkeleton />
              </div>
            </section>
          ) : entry ? (
            <PreviewPane
              entry={entry}
              provider={provider}
              workspaceSlug={workspaceSlug}
              mode={READONLY_RICH_PREVIEW_MODE}
              onDismiss={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </SessionFileViewerContext.Provider>
  )
}

function fileEntry(target: SessionFileTarget): DirectoryEntry | null {
  try {
    const path = normalizeBrowserFilePath(target.path)
    return {
      // The logical Drive path is canonical. Do not decode percent escapes or
      // classify a caller-provided label as though it were the stored file.
      name: fileName(path),
      path: `/${path}`,
      size: target.size,
      type: 'file',
      isDirectory: false,
    }
  } catch {
    return null
  }
}
