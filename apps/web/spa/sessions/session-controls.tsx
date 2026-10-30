'use client'

/* The host names the conversation, so rename and lifecycle actions belong
   beside its title rather than inside the conversation timeline. */
import {
  Archive,
  ArrowCounterClockwise,
  CircleNotch,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Fragment, useEffect, useRef, useState } from 'react'

import type { SessionArchive, SessionPermissions } from '@repo/contract'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/shadcn/alert-dialog'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'

export function EditableTitle({
  value,
  onSave,
}: {
  value: string
  onSave: (title: string) => Promise<unknown>
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(value)
  const [optimisticTitle, setOptimisticTitle] = useState<string>()
  const commit = () => {
    setEditing(false)
    const nextTitle = title.trim()
    if (!nextTitle || nextTitle === value) return
    setOptimisticTitle(nextTitle)
    void onSave(nextTitle).then(
      () => setOptimisticTitle(undefined),
      () => setOptimisticTitle(undefined),
    )
  }
  // The input mirrors the display text's metrics exactly so entering and
  // leaving edit mode never shifts the header layout.
  if (editing)
    return (
      <form
        className="min-w-0"
        onSubmit={event => {
          event.preventDefault()
          commit()
        }}
      >
        <input
          aria-label={t('titleLabel')}
          autoFocus
          className="w-full min-w-0 rounded-sm bg-transparent text-sm font-medium outline-none ring-2 ring-ring/25 ring-offset-2 ring-offset-background"
          value={title}
          onFocus={event => event.currentTarget.select()}
          onChange={event => setTitle(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
              return
            }
            if (event.key !== 'Enter') return
            event.preventDefault()
            commit()
          }}
          onBlur={commit}
        />
      </form>
    )
  return (
    <button
      className="group flex max-w-full items-center gap-2 text-left"
      onClick={() => {
        setTitle(value)
        setEditing(true)
      }}
    >
      <span className="truncate text-sm font-medium">{optimisticTitle ?? value}</span>
      <PencilSimple
        /* The row is the button, so the title was always tappable — but the one
           thing telling a reader it could be renamed appeared only under a
           pointer, which means a phone was never told. Same shape of fix as the
           drive's row actions: drawn on touch, revealed on hover. */
        className="shrink-0 text-muted-foreground opacity-60 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100"
        size={14}
      />
    </button>
  )
}

export function SessionMenu({
  archive,
  permissions,
  busy,
  onArchive,
  onDelete,
}: {
  archive: SessionArchive
  permissions: SessionPermissions
  busy: boolean
  onArchive: (kind: 'personal' | 'global', archived: boolean) => Promise<unknown>
  onDelete: () => Promise<void>
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const trigger = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [archiveError, setArchiveError] = useState(false)
  const [pendingArchiveKind, setPendingArchiveKind] = useState<'personal' | 'global'>()
  const [deleteError, setDeleteError] = useState(false)
  const actions = sessionLifecycleActions(archive, permissions)
  useEffect(() => {
    if (permissions.delete || !deleteOpen) return
    setDeleteOpen(false)
    setDeleteError(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }, [deleteOpen, permissions.delete])
  if (actions.length === 0) return null
  return (
    <AlertDialog
      open={deleteOpen}
      onOpenChange={open => {
        if (!deleting) setDeleteOpen(open)
        if (!open) setDeleteError(false)
        if (!open) requestAnimationFrame(() => trigger.current?.focus())
      }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            aria-label={t('actions')}
            aria-busy={busy || deleting}
            disabled={busy || deleting}
            className={`${buttonVariants({ variant: 'ghost', size: 'icon' })} min-h-11 min-w-11`}
          >
            •••
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {actions.map((action, index) =>
            action.kind === 'delete' ? (
              <Fragment key="delete">
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  className="min-h-11 text-red-700 focus:text-red-800 dark:text-red-300 dark:focus:text-red-200"
                  disabled={busy || deleting}
                  onSelect={() => setDeleteOpen(true)}
                >
                  <Trash />
                  {t('delete')}
                </DropdownMenuItem>
              </Fragment>
            ) : (
              <DropdownMenuItem
                key={action.kind}
                className="min-h-11"
                disabled={busy || deleting}
                onSelect={event => {
                  event.preventDefault()
                  setArchiveError(false)
                  setPendingArchiveKind(action.kind)
                  void onArchive(action.kind, action.archived)
                    .then(
                      () => setMenuOpen(false),
                      () => setArchiveError(true),
                    )
                    .finally(() => setPendingArchiveKind(undefined))
                }}
              >
                {pendingArchiveKind === action.kind ? (
                  <CircleNotch className="animate-spin" aria-hidden />
                ) : action.archived ? (
                  <Archive />
                ) : (
                  <ArrowCounterClockwise />
                )}
                {t(action.label)}
              </DropdownMenuItem>
            ),
          )}
          {archiveError ? (
            <p role="alert" className="px-2 py-2 text-xs text-red-700 dark:text-red-300">
              {t('actionError')}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {permissions.delete ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {t('deleteError')}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              className="min-h-11 focus-visible:ring-foreground"
              disabled={deleting}
            >
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-red-700 text-white hover:bg-red-800 focus-visible:ring-foreground dark:bg-red-700 dark:hover:bg-red-600"
              disabled={deleting}
              onClick={event => {
                event.preventDefault()
                setDeleting(true)
                setDeleteError(false)
                void onDelete()
                  .catch(() => setDeleteError(true))
                  .finally(() => setDeleting(false))
              }}
            >
              {deleting ? <CircleNotch className="animate-spin" aria-hidden /> : null}
              {t(deleting ? 'deleting' : deleteError ? 'retryDelete' : 'delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}

type LifecycleAction =
  | {
      kind: 'personal' | 'global'
      archived: boolean
      label: 'archivePersonal' | 'restorePersonal' | 'archiveGlobal' | 'restoreGlobal'
    }
  | { kind: 'delete'; label: 'delete' }

export function sessionLifecycleActions(
  archive: SessionArchive,
  permissions: SessionPermissions,
): LifecycleAction[] {
  const actions: LifecycleAction[] = []
  if (permissions.personalArchive) {
    const archived = archive.personalArchivedAt === null
    actions.push({
      kind: 'personal',
      archived,
      label: archived ? 'archivePersonal' : 'restorePersonal',
    })
  }
  if (permissions.globalArchive) {
    const archived = archive.globalArchivedAt === null
    actions.push({
      kind: 'global',
      archived,
      label: archived ? 'archiveGlobal' : 'restoreGlobal',
    })
  }
  if (permissions.delete) actions.push({ kind: 'delete', label: 'delete' })
  return actions
}

export function shouldPutAwayAfterArchive(
  previous: SessionArchive['reason'],
  next: SessionArchive['reason'],
): boolean {
  return previous === null && next !== null
}
