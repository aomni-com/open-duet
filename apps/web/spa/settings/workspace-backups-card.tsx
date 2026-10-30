'use client'

import { Archive, DownloadSimple, SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useFormatter, useTranslations } from 'next-intl'
import { useRef, useState } from 'react'

import type { Backup, WorkspaceSummary } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { workspaceBackupMutationOptions, workspaceBackupsQueryOptions } from '../api/backups'
import { DuetApiError } from '../api/client'
import { useSpa } from '../context'
import { formatBytes } from '../format'
import { CollectionLoadMore } from './collection-load-more'
import { SettingsCard } from './settings-frame'

export function WorkspaceBackupsCard({ workspace }: { workspace: WorkspaceSummary }) {
  const t = useTranslations('duetSettings.workspace.backups')
  const common = useTranslations('duetSettings')
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const owner = workspace.role === 'owner'
  const backups = useInfiniteQuery({
    ...workspaceBackupsQueryOptions(api, workspace.slug),
    enabled: owner,
  })
  const create = useMutation(
    workspaceBackupMutationOptions.create(api, queryClient, workspace.slug),
  )
  const download = useMutation(workspaceBackupMutationOptions.download(api, workspace.slug))
  const remove = useMutation(
    workspaceBackupMutationOptions.delete(api, queryClient, workspace.slug),
  )
  const requestId = useRef<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [emptyDriveNotice, setEmptyDriveNotice] = useState(false)
  const items = owner ? (backups.data?.items ?? []) : []
  const capturing = items.some(backup => backup.status === 'queued' || backup.status === 'running')
  const canCreate = workspace.status === 'active' && workspace.servicingStatus === 'active'
  const start = () => {
    requestId.current ??= crypto.randomUUID()
    create.mutate(requestId.current, {
      onSuccess: () => {
        requestId.current = undefined
      },
    })
  }
  const deleteBackup = (id: string) => {
    remove.mutate(id, {
      onSuccess: result => {
        setConfirmDelete(undefined)
        if (result.emptyDriveOnNextStart) setEmptyDriveNotice(true)
      },
    })
  }
  const error = create.error ?? download.error ?? remove.error
  const errorMessage =
    error instanceof DuetApiError && error.code === 'backup_in_use'
      ? t('inUse')
      : error instanceof DuetApiError && error.code === 'backup_in_progress'
        ? t('inProgress')
        : t('actionError')

  return (
    <div data-backups-card>
      <SettingsCard>
        {!owner ? (
          <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">{t('contents')}</p>
              <button
                type="button"
                onClick={start}
                disabled={!canCreate || capturing || create.isPending || backups.isPending}
                className={cn(buttonVariants(), 'shrink-0')}
              >
                {create.isPending ? (
                  <SpinnerGap className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Archive className="size-4" aria-hidden="true" />
                )}
                {create.isPending
                  ? t('starting')
                  : create.isError && requestId.current
                    ? t('retryRequest')
                    : t('export')}
              </button>
            </div>
            {!canCreate ? (
              <p className="text-sm text-muted-foreground">{t('vmUnavailable')}</p>
            ) : null}
            {workspace.status === 'archived' ? (
              <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm leading-6">
                {t('archivedWarning')}
              </p>
            ) : null}
            {emptyDriveNotice ? (
              <p
                role="status"
                className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm leading-6"
              >
                {t('emptyDriveNotice')}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}
            {backups.isPending ? (
              <p className="text-sm text-muted-foreground">{t('loading')}</p>
            ) : backups.isLoadingError ? (
              <div className="space-y-3">
                <p role="alert" className="text-sm text-destructive">
                  {t('loadError')}
                </p>
                <button
                  type="button"
                  onClick={() => void backups.refetch()}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {common('retry')}
                </button>
              </div>
            ) : (
              <>
                {backups.isRefetchError && !backups.isFetchNextPageError ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p role="alert" className="text-sm text-destructive">
                      {t('refreshError')}
                    </p>
                    <button
                      type="button"
                      onClick={() => void backups.refetch()}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      {common('retry')}
                    </button>
                  </div>
                ) : null}
                {items.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    {backups.hasNextPage ? t('noneLoaded') : t('empty')}
                  </p>
                ) : (
                  <div className="divide-y">
                    {items.map(backup => (
                      <BackupRow
                        key={backup.id}
                        backup={backup}
                        canRetry={canCreate && !capturing && !create.isPending}
                        pendingDownload={download.isPending && download.variables === backup.id}
                        pendingDelete={remove.isPending && remove.variables === backup.id}
                        confirming={confirmDelete === backup.id}
                        onRetry={start}
                        onDownload={() => {
                          void download.mutateAsync(backup.id).then(
                            grant => {
                              const anchor = document.createElement('a')
                              anchor.href = grant.url
                              anchor.download = grant.filename
                              anchor.rel = 'noopener'
                              document.body.append(anchor)
                              anchor.click()
                              anchor.remove()
                            },
                            () => {}, // Mutation error state renders the failure message.
                          )
                        }}
                        onDelete={() => setConfirmDelete(backup.id)}
                        onConfirmDelete={() => deleteBackup(backup.id)}
                        onCancelDelete={() => setConfirmDelete(undefined)}
                      />
                    ))}
                  </div>
                )}
                {backups.hasNextPage || backups.isFetchNextPageError ? (
                  <CollectionLoadMore
                    loading={backups.isFetchingNextPage}
                    failed={backups.isFetchNextPageError}
                    labels={{
                      load: common('loadMore'),
                      loading: common('loadingMore'),
                      retry: common('retryLoadMore'),
                    }}
                    onLoad={() => void backups.fetchNextPage()}
                  />
                ) : null}
              </>
            )}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}

function BackupRow({
  backup,
  canRetry,
  pendingDownload,
  pendingDelete,
  confirming,
  onRetry,
  onDownload,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  backup: Backup
  canRetry: boolean
  pendingDownload: boolean
  pendingDelete: boolean
  confirming: boolean
  onRetry(): void
  onDownload(): void
  onDelete(): void
  onConfirmDelete(): void
  onCancelDelete(): void
}) {
  const t = useTranslations('duetSettings.workspace.backups')
  const common = useTranslations('duetSettings')
  const format = useFormatter()
  const busy = ['queued', 'running', 'deleting'].includes(backup.status)
  const partial = backup.status === 'ready' && backup.completeness === 'partial'
  const status =
    backup.status === 'running' && backup.phase
      ? t(`phase.${backup.phase}`)
      : partial
        ? t('partial')
        : t(`status.${backup.status}`)
  return (
    <article data-backup-id={backup.id} className="space-y-3 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm font-medium">{t(`purpose.${backup.purpose}`)}</p>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                partial || backup.status === 'failed'
                  ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300'
                  : backup.status === 'ready'
                    ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {busy ? (
                <SpinnerGap className="size-3 animate-spin" aria-hidden="true" />
              ) : partial || backup.status === 'failed' ? (
                <WarningCircle className="size-3" aria-hidden="true" />
              ) : null}
              {status}
            </span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            <time dateTime={new Date(backup.createdAt).toISOString()}>
              {format.dateTime(backup.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
            </time>
            {backup.bytes !== undefined ? ` · ${formatBytes(backup.bytes, 1000)}` : null}
          </p>
          {backup.status === 'running' ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                {t('counts', {
                  files: backup.progress.processedFiles,
                  records: backup.progress.processedRecords,
                })}
              </p>
              <p>
                {t('bytes', {
                  captured: formatBytes(backup.progress.capturedBytes, 1000),
                  uploaded: formatBytes(backup.progress.uploadedBytes, 1000),
                })}
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {backup.status === 'ready' ? (
            <button
              type="button"
              onClick={onDownload}
              disabled={pendingDownload}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <DownloadSimple className="size-4" aria-hidden="true" />
              {pendingDownload ? t('preparingDownload') : t('download')}
            </button>
          ) : null}
          {backup.status === 'failed' ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={!canRetry}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('retry')}
            </button>
          ) : null}
          {backup.status !== 'deleting' ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={pendingDelete}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('delete')}
            </button>
          ) : backup.error?.code === 'cleanup_failed' ? (
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={pendingDelete}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('retryDelete')}
            </button>
          ) : null}
        </div>
      </div>
      {backup.status === 'queued' || backup.status === 'running' ? (
        <p className="text-xs leading-5 text-muted-foreground">{t('continues')}</p>
      ) : null}
      {partial || backup.progress.warningCount > 0 ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm leading-6">
          <p>{t('warnings', { count: backup.progress.warningCount })}</p>
          {backup.progress.warningSummary.length > 0 ? (
            <p>
              {backup.progress.warningSummary
                .map(warning =>
                  t(
                    t.has(`warning.${warning.code}`) ? `warning.${warning.code}` : 'warning.other',
                    { count: warning.count },
                  ),
                )
                .join(' · ')}
            </p>
          ) : null}
          <p className="text-muted-foreground">{t('warningHelp')}</p>
        </div>
      ) : null}
      {backup.error ? (
        <p className="text-sm leading-6 text-red-700 dark:text-red-300">
          {t(`error.${backup.error.code}`)}
        </p>
      ) : null}
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-destructive/25 p-3">
          <p className="text-sm leading-6">{t('deleteConfirm')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={pendingDelete}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {pendingDelete ? t('deleting') : t('confirmDelete')}
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={pendingDelete}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {common('cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  )
}
