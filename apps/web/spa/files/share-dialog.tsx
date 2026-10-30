'use client'

import { AppWindowIcon, ShareNetworkIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import type { App, CreateShareRequest } from '@repo/contract'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@repo/ui/components/shadcn/accordion'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import { Input } from '@repo/ui/components/shadcn/input'
import { Textarea } from '@repo/ui/components/shadcn/textarea'
import { cn } from '@repo/ui/lib/utils'

import { DuetApiError, type DuetApiClient } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import { workspaceSubtreeAppsQueryOptions } from '../api/query-options'
import { anchorPathFromBrowserPath } from './lib/paths'

export type ShareDialogApi = Pick<DuetApiClient, 'createShare' | 'listApps'>
export type SharePermission = 'view' | 'edit'
type ShareErrorKind = 'duplicate' | 'cap' | 'generic'

export type ShareDialogTarget = {
  name: string
  path: string
}

export function shareRequestFromForm(input: {
  path: string
  email: string
  permission: SharePermission
  ignorePatterns: string
}): CreateShareRequest {
  const ignorePatterns = [
    ...new Set(
      input.ignorePatterns
        .split('\n')
        .map(pattern => pattern.trim())
        .filter(Boolean),
    ),
  ]
  return {
    path: anchorPathFromBrowserPath(input.path),
    toEmail: input.email.trim(),
    mode: input.permission === 'view' ? 'read' : 'write',
    ...(ignorePatterns.length === 0 ? {} : { ignorePatterns }),
  }
}

export function ShareDialog({
  api,
  workspaceSlug,
  target,
  open,
  onOpenChange,
  onShared,
}: {
  api: ShareDialogApi
  workspaceSlug: string
  target: ShareDialogTarget | null
  open: boolean
  onOpenChange(open: boolean): void
  onShared?(): void
}) {
  const t = useTranslations('duetApp.filesSurface.shareDialog')
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [permission, setPermission] = useState<SharePermission>('view')
  const [ignorePatterns, setIgnorePatterns] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<ShareErrorKind | null>(null)
  const subtreePath = target === null ? '' : anchorPathFromBrowserPath(target.path)
  const appsQuery = useInfiniteQuery({
    ...workspaceSubtreeAppsQueryOptions(workspaceSlug, subtreePath, request =>
      api.listApps(workspaceSlug, { ...request, path: subtreePath, scope: 'subtree' }),
    ),
    enabled: open && target !== null,
  })
  const previewReady = appsQuery.data !== undefined

  useEffect(() => {
    if (!open || target === null) return
    setEmail('')
    setPermission('view')
    setIgnorePatterns('')
    setSubmitting(false)
    setError(null)
  }, [open, target])

  const submit = async () => {
    if (target === null || !previewReady) return
    setSubmitting(true)
    setError(null)
    try {
      await api.createShare(
        workspaceSlug,
        shareRequestFromForm({
          path: target.path,
          email,
          permission,
          ignorePatterns,
        }),
      )
      await queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.shares(workspaceSlug),
      })
      onShared?.()
      onOpenChange(false)
    } catch (cause) {
      setError(shareErrorKind(cause))
      setSubmitting(false)
    }
  }

  if (target === null) return null
  return (
    <Dialog open={open} onOpenChange={nextOpen => !submitting && onOpenChange(nextOpen)}>
      <DialogContent
        className="bottom-0 top-auto flex max-h-[calc(100dvh-0.5rem)] translate-y-0 flex-col overflow-hidden rounded-t-2xl border-b-0 sm:bottom-auto sm:top-[50%] sm:max-h-[min(92vh,48rem)] sm:max-w-lg sm:translate-y-[-50%] sm:rounded-lg sm:border"
        data-share-dialog={target.name}
      >
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShareNetworkIcon className="size-5" />
          </div>
          <DialogTitle>{t('title', { name: target.name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="share-recipient-email">
                {t('emailLabel')}
              </label>
              <Input
                id="share-recipient-email"
                type="email"
                autoComplete="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={event => setEmail(event.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <fieldset className="space-y-2" disabled={submitting}>
              <legend className="text-sm font-medium">{t('permissionLabel')}</legend>
              <div className="grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
                {(['view', 'edit'] as const).map(value => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={permission === value}
                    className={cn(
                      'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      permission === value
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setPermission(value)}
                  >
                    {t(value === 'view' ? 'canView' : 'canEdit')}
                  </button>
                ))}
              </div>
            </fieldset>

            <section
              className="rounded-xl border bg-muted/20 p-4"
              aria-labelledby="share-apps-title"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-background shadow-sm">
                  <AppWindowIcon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 id="share-apps-title" className="text-sm font-semibold">
                    {t('appsTitle')}
                  </h3>
                  <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                    {t('appsDescription')}
                  </p>
                  <IncludedApps
                    apps={appsQuery.data?.items ?? null}
                    failed={appsQuery.data === undefined && appsQuery.isError}
                    incomplete={
                      appsQuery.isRefetching ||
                      appsQuery.hasNextPage ||
                      appsQuery.isFetchNextPageError
                    }
                    canLoadMore={appsQuery.hasNextPage || appsQuery.isFetchNextPageError}
                    loadingMore={appsQuery.isFetchingNextPage}
                    moreFailed={appsQuery.isFetchNextPageError}
                    onLoadMore={() => void appsQuery.fetchNextPage()}
                  />
                </div>
              </div>
            </section>

            <Accordion type="single" collapsible>
              <AccordionItem value="advanced" className="rounded-xl border px-4">
                <AccordionTrigger className="py-3 text-sm">{t('advanced')}</AccordionTrigger>
                <AccordionContent>
                  <label className="text-sm font-medium" htmlFor="share-ignore-patterns">
                    {t('ignoreLabel')}
                  </label>
                  <p className="mb-2 mt-1 text-[13px] leading-5 text-muted-foreground">
                    {t('ignoreHelp')}
                  </p>
                  <Textarea
                    id="share-ignore-patterns"
                    className="h-16 min-h-16 font-mono text-xs sm:h-24 sm:min-h-24"
                    placeholder={t('ignorePlaceholder')}
                    value={ignorePatterns}
                    onChange={event => setIgnorePatterns(event.target.value)}
                    disabled={submitting}
                  />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
          <p className="mt-3 text-[13px] leading-5 text-muted-foreground">{t('expiry')}</p>
          {error !== null ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t(`errors.${error}`)}
            </div>
          ) : null}
          <DialogFooter className="mt-4 grid grid-cols-2 gap-2 border-t bg-background pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-4 sm:flex sm:pb-0">
            <Button
              type="button"
              variant="outline"
              className="text-foreground"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              <span>{t('cancel')}</span>
            </Button>
            <Button type="submit" disabled={!previewReady || submitting || error === 'cap'}>
              {submitting ? <SpinnerGapIcon className="mr-2 size-4 animate-spin" /> : null}
              {submitting ? t('sending') : t('share')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function IncludedApps({
  apps,
  failed,
  incomplete,
  canLoadMore,
  loadingMore,
  moreFailed,
  onLoadMore,
}: {
  apps: App[] | null
  failed: boolean
  incomplete: boolean
  canLoadMore: boolean
  loadingMore: boolean
  moreFailed: boolean
  onLoadMore(): void
}) {
  const t = useTranslations('duetApp.filesSurface.shareDialog')
  if (failed) return <p className="mt-3 text-xs text-destructive">{t('appsFailed')}</p>
  if (apps === null) {
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <SpinnerGapIcon className="size-3.5 animate-spin" />
        {t('appsLoading')}
      </p>
    )
  }
  if (apps.length === 0 && !incomplete) {
    return <p className="mt-3 text-xs text-muted-foreground">{t('appsEmpty')}</p>
  }
  return (
    <div className="mt-3 space-y-2">
      <ul className="space-y-1.5">
        {apps.map(app => (
          <li
            key={app.id}
            className="flex items-center justify-between gap-3 rounded-md bg-background px-2.5 py-2 text-xs shadow-sm"
          >
            <span className="truncate font-medium">{app.slug}</span>
            <span className="truncate text-muted-foreground">{app.anchorPath}</span>
          </li>
        ))}
      </ul>
      {incomplete ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('appsIncomplete')}</p>
          {canLoadMore ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore
                ? t('appsLoadingMore')
                : moreFailed
                  ? t('appsTryAgain')
                  : t('appsLoadMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function shareErrorKind(cause: unknown): ShareErrorKind {
  if (!(cause instanceof DuetApiError)) return 'generic'
  if (cause.status === 429 || cause.code === 'rate_limited') return 'cap'
  if (cause.status === 409 && cause.code === 'already_shared') return 'duplicate'
  return 'generic'
}
