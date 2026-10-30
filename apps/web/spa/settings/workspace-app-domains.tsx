'use client'

import { ArrowRightIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { WorkspaceAppDomainRow } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'

import { useWorkspaceAppDomains } from '../api/app-domains'
import { duetQueryOptions, isInitialCollectionError } from '../api/query-options'
import { AppDomainDialog, DomainStatus } from '../apps/app-domain-dialog'
import { appProductUrl } from '../apps/app-location'
import { useSpa } from '../context'
import { useToast } from '../shell/toast'
import { CollectionLoadMore } from './collection-load-more'
import { SettingsCard, SettingsState } from './settings-frame'

export function WorkspaceAppDomains({ workspaceSlug }: { workspaceSlug: string }) {
  const { api } = useSpa()
  const t = useTranslations('duetSettings.workspace.appDomains')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const inventory = useWorkspaceAppDomains(api, workspaceSlug)
  const [selected, setSelected] = useState<WorkspaceAppDomainRow['app'] | null>(null)
  const openApp = useMutation({
    mutationFn: async (appSlug: string) => {
      // The inventory does not fan out for app/agent details. One explicit
      // navigation reads that app and the ordinary bounded, cached roster.
      const [app, agents] = await Promise.all([
        queryClient.fetchQuery(duetQueryOptions.workspaces.app(api, workspaceSlug, appSlug)),
        queryClient.ensureInfiniteQueryData(duetQueryOptions.workspaces.agents(api, workspaceSlug)),
      ])
      return appProductUrl(
        workspaceSlug,
        app.app,
        agents.pages.flatMap(page => page.items),
      )
    },
    onSuccess: path => navigate(path),
    onError: () => toast({ message: t('openError'), tone: 'error' }),
  })
  if (inventory.isPending)
    return <SettingsState title={t('loading')} body={t('loadingBody')} busy />
  if (inventory.data === undefined || isInitialCollectionError(inventory))
    return (
      <SettingsState
        title={t('loadError')}
        body={t('loadErrorBody')}
        action={
          <Button variant="outline" onClick={() => void inventory.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    )
  return (
    <div className="space-y-4" data-workspace-app-domains>
      {inventory.isRefetchError && (
        <div role="alert" className="rounded-md border p-3 text-sm">
          <p>{t('refreshError')}</p>
          <Button variant="outline" className="mt-2" onClick={() => void inventory.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {inventory.data.items.length === 0 ? (
        <SettingsState
          title={t('empty')}
          body={t('emptyBody')}
          action={
            <Button variant="outline" asChild>
              <Link to={`/w/${encodeURIComponent(workspaceSlug)}/agents/graph`}>
                {t('browseApps')}
              </Link>
            </Button>
          }
        />
      ) : (
        <SettingsCard>
          <ul className="divide-y" aria-label={t('inventory')}>
            {inventory.data.items.map(({ domain, app }) => (
              <li
                key={domain.id}
                className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                data-app-domain-row={app.slug}
              >
                <div className="min-w-0 space-y-1">
                  <h3 className="break-words font-medium">{app.name ?? app.slug}</h3>
                  <p className="break-all text-sm text-muted-foreground">{domain.hostname}</p>
                  <DomainStatus domain={domain} />
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelected(app)}>
                    {t(app.controls.manageDomain ? 'manage' : 'view')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={openApp.isPending}
                    onClick={() => openApp.mutate(app.slug)}
                  >
                    {openApp.isPending && openApp.variables === app.slug ? (
                      <SpinnerGapIcon aria-hidden className="animate-spin" />
                    ) : (
                      <ArrowRightIcon aria-hidden />
                    )}
                    {t(openApp.isPending && openApp.variables === app.slug ? 'opening' : 'openApp')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
      {inventory.hasNextPage || inventory.isFetchNextPageError ? (
        <CollectionLoadMore
          loading={inventory.isFetchingNextPage}
          failed={inventory.isFetchNextPageError}
          failureMessage={t('continuationError')}
          labels={{ load: t('loadMore'), loading: t('loadingMore'), retry: t('retryMore') }}
          onLoad={() => void inventory.fetchNextPage()}
        />
      ) : null}
      {selected !== null && (
        <AppDomainDialog
          key={selected.id}
          workspaceSlug={workspaceSlug}
          app={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
