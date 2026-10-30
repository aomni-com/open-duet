'use client'

import {
  CheckCircle,
  CircleNotch,
  Copy,
  LinkBreak,
  PauseCircle,
  WarningCircle,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

import type { IncomingShareListItem, OutgoingShareListItem, ShareMode } from '@repo/contract'
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
import { cn } from '@repo/ui/lib/utils'

import { PauseSwitch } from '../settings/pause-switch'
import {
  projectShareStatus,
  type ProjectedShareStatus,
  type ShareManagementDirection,
} from './status-projector'

type PendingAction =
  | { kind: 'unlink'; share: IncomingShareListItem }
  | { kind: 'revoke'; share: OutgoingShareListItem }

export function SharesManagement({
  incoming,
  outgoing,
  busy,
  onUnlink,
  onRevoke,
  onSetPaused,
}: {
  incoming: IncomingShareListItem[]
  outgoing: OutgoingShareListItem[]
  busy: boolean
  onUnlink(shareId: string): Promise<void>
  onRevoke(shareId: string): Promise<void>
  onSetPaused(shareId: string, paused: boolean): Promise<void>
}) {
  const t = useTranslations('duetSettings.workspace.shares')
  const [pendingAction, setPendingAction] = useState<PendingAction>()
  const [confirming, setConfirming] = useState(false)

  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <section className="rounded-xl border bg-card p-6 text-center shadow-sm sm:p-10">
        <span className="mx-auto grid size-12 place-items-center rounded-lg bg-primary/10 text-primary">
          <Copy size={23} />
        </span>
        <h3 className="mt-4 font-semibold">{t('emptyTitle')}</h3>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          {t('emptyBody')}
        </p>
      </section>
    )
  }

  const actionBusy = busy || confirming
  const confirm = async () => {
    if (pendingAction === undefined) return
    setConfirming(true)
    try {
      if (pendingAction.kind === 'unlink') await onUnlink(pendingAction.share.id)
      else await onRevoke(pendingAction.share.id)
      setPendingAction(undefined)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <>
      <div className="space-y-5">
        <ShareSection
          title={t('incomingTitle')}
          description={t('incomingHelp')}
          empty={t('incomingEmpty')}
        >
          {incoming.map(share => (
            <ShareRow
              key={share.id}
              direction="incoming"
              path={share.mountPath ?? t('pathUnavailable')}
              counterpart={`${share.sharerName} · ${share.sourceWorkspaceName}`}
              mode={share.mode}
              status={projectShareStatus({
                direction: 'incoming',
                state: share.state,
                sync: share.syncStatus,
              })}
              busy={actionBusy}
              paused={share.pausedAt !== undefined}
              pauseEligible={share.state === 'active'}
              onSetPaused={paused => onSetPaused(share.id, paused)}
              onAction={() => setPendingAction({ kind: 'unlink', share })}
            />
          ))}
        </ShareSection>
        <ShareSection
          title={t('outgoingTitle')}
          description={t('outgoingHelp')}
          empty={t('outgoingEmpty')}
        >
          {outgoing.map(share => (
            <ShareRow
              key={share.id}
              direction="outgoing"
              path={share.sourcePath}
              counterpart={share.toEmail}
              mode={share.mode}
              status={projectShareStatus({
                direction: 'outgoing',
                state: share.state,
                sync: share.syncStatus,
              })}
              busy={actionBusy}
              paused={share.pausedAt !== undefined}
              pauseEligible={share.state === 'active'}
              onSetPaused={paused => onSetPaused(share.id, paused)}
              onAction={() => setPendingAction({ kind: 'revoke', share })}
            />
          ))}
        </ShareSection>
      </div>
      <ShareActionDialog
        action={pendingAction}
        busy={actionBusy}
        onCancel={() => !actionBusy && setPendingAction(undefined)}
        onConfirm={() => void confirm()}
      />
    </>
  )
}

function ShareSection({
  title,
  description,
  empty,
  children,
}: {
  title: string
  description: string
  empty: string
  children: ReactNode
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : children !== undefined
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-5 py-4 sm:px-6">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
      </header>
      <div className="px-5 sm:px-6">
        {hasRows ? (
          <div className="divide-y">{children}</div>
        ) : (
          <p className="py-6 text-sm text-muted-foreground">{empty}</p>
        )}
      </div>
    </section>
  )
}

function ShareRow({
  direction,
  path,
  counterpart,
  mode,
  status,
  busy,
  onAction,
  paused,
  pauseEligible,
  onSetPaused,
}: {
  direction: ShareManagementDirection
  path: string
  counterpart: string
  mode: ShareMode
  status: ProjectedShareStatus
  busy: boolean
  onAction(): void
  paused: boolean
  pauseEligible: boolean
  onSetPaused(paused: boolean): Promise<void>
}) {
  const t = useTranslations('duetSettings.workspace.shares')
  const action = status.actions[0]
  return (
    <article
      className="grid grid-cols-1 items-start gap-4 py-5 first:pt-5 last:pb-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      data-share-direction={direction}
      data-share-status={status.pill}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate font-mono text-sm font-semibold">{path}</p>
          <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {t(`modes.${mode}`)}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {direction === 'incoming'
            ? t('sharedBy', { counterpart })
            : t('sharedWith', { counterpart })}
        </p>
        <div className="mt-3 flex items-start gap-2">
          <StatusIcon pill={status.pill} />
          <div>
            <p className="text-sm font-medium">{t(`pills.${status.pill}`)}</p>
            <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t(`explanations.${status.explanation}`)}
            </p>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 justify-self-start sm:justify-self-end">
        {pauseEligible ? (
          <PauseSwitch
            checked={paused}
            disabled={busy}
            label={t(paused ? 'actions.resumeLabel' : 'actions.freezeLabel', { path })}
            onCheckedChange={next => void onSetPaused(next)}
          />
        ) : null}
        {action === undefined ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={onAction}
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'justify-self-end',
              action === 'revoke' &&
                'text-destructive hover:bg-destructive/5 hover:text-destructive',
            )}
          >
            {t(`actions.${action}`)}
          </button>
        )}
      </div>
    </article>
  )
}

function StatusIcon({ pill }: { pill: ProjectedShareStatus['pill'] }) {
  if (pill === 'upToDate') {
    return <CheckCircle size={19} weight="fill" className="mt-0.5 shrink-0 text-emerald-600" />
  }
  if (pill === 'syncing') {
    return <CircleNotch size={19} className="mt-0.5 shrink-0 animate-spin text-primary" />
  }
  if (pill === 'paused') {
    return <PauseCircle size={19} weight="fill" className="mt-0.5 shrink-0 text-sky-600" />
  }
  if (pill === 'unlinked') {
    return <LinkBreak size={19} className="mt-0.5 shrink-0 text-muted-foreground" />
  }
  return <WarningCircle size={19} className="mt-0.5 shrink-0 text-amber-600" />
}

function ShareActionDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: PendingAction | undefined
  busy: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const t = useTranslations('duetSettings.workspace.shares')
  if (action === undefined) return null
  const path =
    action.kind === 'unlink'
      ? (action.share.mountPath ?? t('pathUnavailable'))
      : action.share.sourcePath
  return (
    <AlertDialog open onOpenChange={open => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`confirms.${action.kind}.title`, { path })}</AlertDialogTitle>
          <AlertDialogDescription>{t(`confirms.${action.kind}.body`)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>
            {t('actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={event => {
              event.preventDefault()
              onConfirm()
            }}
            className={
              action.kind === 'revoke'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
          >
            {busy ? t('actions.working') : t(`actions.${action.kind}`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
