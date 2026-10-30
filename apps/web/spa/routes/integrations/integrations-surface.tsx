'use client'

import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

import type { IntegrationCatalogItem, IntegrationConnection } from '@repo/contract'
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
import { Button, buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import {
  WorkspacePage,
  WorkspaceEmptyState,
  WorkspacePageHeader,
  WorkspacePanel,
  WorkspacePanelHeader,
} from '../../drive/workspace-page'
import { WORKSPACE_TAB_ICONS } from '../../drive/workspace-tabs'
import { LoadingHandoff } from '../../loading/loading-handoff'
import {
  IntegrationAgentAccessEditor,
  type IntegrationAgentOption,
} from './integration-agent-access'
import { IntegrationMark } from './integration-mark'
import { IntegrationsLoadingView } from './integrations-loading'

export type IntegrationReturnNotice =
  | { kind: 'pending' }
  | { kind: 'success'; integration: string }
  | { kind: 'canceled' }
  | { kind: 'error' }

export function IntegrationsSurface({
  state,
  connections,
  connectionsHasMore,
  connectionsPageFailed,
  connectionsLoadingMore,
  catalog,
  mcpServersPanel,
  search,
  hasMore,
  catalogPageFailed,
  refreshing,
  refreshFailed,
  loadingMore,
  connecting,
  disconnecting,
  agents,
  pendingAgentPolicies,
  failedAgentPolicies,
  returnNotice,
  mutationError,
  onSearch,
  onRetry,
  onRefresh,
  onLoadMore,
  onLoadMoreConnections,
  onConnect,
  onDisconnect,
  onSetAgentPolicy,
  onRetryCallback,
  onDismissNotice,
}: {
  state: 'loading' | 'error' | 'ready'
  connections: IntegrationConnection[]
  connectionsHasMore?: boolean
  connectionsPageFailed?: boolean
  connectionsLoadingMore?: boolean
  catalog: IntegrationCatalogItem[]
  /* A slot rather than a prop bundle: the workspace's own MCP servers have
     their own query, their own failure and their own mutations, none of which
     this surface reads. It owns where the panel sits on the page, and nothing
     else about it. */
  mcpServersPanel: ReactNode
  search: string
  hasMore?: boolean
  catalogPageFailed?: boolean
  refreshing?: boolean
  refreshFailed?: boolean
  loadingMore?: boolean
  connecting?: string
  disconnecting?: string
  agents: IntegrationAgentOption[]
  pendingAgentPolicies?: ReadonlySet<string>
  failedAgentPolicies?: ReadonlySet<string>
  returnNotice?: IntegrationReturnNotice
  mutationError?: boolean
  onSearch(value: string): void
  onRetry(): void
  onRefresh(): void
  onLoadMore(): void
  onLoadMoreConnections?(): void
  onConnect(integration: string): void
  onDisconnect(connection: IntegrationConnection): void
  onSetAgentPolicy(connection: IntegrationConnection, allowedAgentIds: string[] | undefined): void
  onRetryCallback?(): void
  onDismissNotice(): void
}) {
  const t = useTranslations('duetIntegrations')
  const [disconnectTarget, setDisconnectTarget] = useState<IntegrationConnection>()
  const visibleConnections = connections.filter(connection => connection.status !== 'disconnected')

  return (
    <LoadingHandoff
      loading={state === 'loading'}
      fallback={<IntegrationsLoadingView label={t('loading')} />}
    >
      <WorkspacePage className="max-w-5xl">
        <WorkspacePageHeader
          icon={<WORKSPACE_TAB_ICONS.integrations weight="fill" />}
          title={t('title')}
          description={t('description')}
          actions={
            <Button
              variant="outline"
              onClick={onRefresh}
              disabled={refreshing}
              className="min-h-11 shadow-xs sm:min-h-0"
            >
              <ArrowClockwiseIcon className={refreshing ? 'size-4 animate-spin' : 'size-4'} />
              {t('refresh')}
            </Button>
          }
        />

        {returnNotice ? (
          <CallbackBanner
            notice={returnNotice}
            onRetry={onRetryCallback}
            onDismiss={onDismissNotice}
          />
        ) : null}
        {mutationError ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          >
            {t('mutationError')}
          </div>
        ) : null}
        {state === 'ready' && refreshFailed ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span>{t('refreshError')}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        ) : null}

        {state === 'error' ? (
          /* The custom-server panel keeps its place under the failure: those
             servers are the workspace's own and do not go away because the
             provider catalog did. */
          <div className="min-w-0 space-y-5">
            <WorkspacePanel>
              <WorkspaceEmptyState
                className="min-h-64"
                tone="destructive"
                icon={<WarningCircleIcon />}
                title={t('loadErrorTitle')}
                body={t('loadErrorBody')}
                action={
                  <button type="button" onClick={onRetry} className={buttonVariants()}>
                    {t('retry')}
                  </button>
                }
              />
            </WorkspacePanel>
            {mcpServersPanel}
          </div>
        ) : state === 'ready' ? (
          <div className="min-w-0 space-y-5">
            <ConnectedCard
              connections={visibleConnections}
              hasMore={connectionsHasMore}
              pageFailed={connectionsPageFailed}
              loadingMore={connectionsLoadingMore}
              catalog={catalog}
              connecting={connecting}
              disconnecting={disconnecting}
              agents={agents}
              pendingAgentPolicies={pendingAgentPolicies}
              failedAgentPolicies={failedAgentPolicies}
              onConnect={onConnect}
              onLoadMore={onLoadMoreConnections}
              onDisconnect={setDisconnectTarget}
              onSetAgentPolicy={onSetAgentPolicy}
            />
            {/* Between what the workspace has and what it can browse: both
                panels above the fold answer "what is attached", and the
                catalog stays the one place you go to add something. */}
            {mcpServersPanel}
            <CatalogCard
              items={catalog}
              connected={new Set(visibleConnections.map(item => item.integration))}
              search={search}
              hasMore={hasMore}
              pageFailed={catalogPageFailed}
              loadingMore={loadingMore}
              connecting={connecting}
              onSearch={onSearch}
              onLoadMore={onLoadMore}
              onConnect={onConnect}
            />
          </div>
        ) : null}
        {disconnectTarget ? (
          <DisconnectDialog
            displayName={
              disconnectTarget.name ??
              catalog.find(item => item.integration === disconnectTarget.integration)?.name ??
              disconnectTarget.integration
            }
            onCancel={() => setDisconnectTarget(undefined)}
            onConfirm={() => {
              onDisconnect(disconnectTarget)
              setDisconnectTarget(undefined)
            }}
          />
        ) : null}
      </WorkspacePage>
    </LoadingHandoff>
  )
}

function CallbackBanner({
  notice,
  onRetry,
  onDismiss,
}: {
  notice: IntegrationReturnNotice
  onRetry?: () => void
  onDismiss(): void
}) {
  const t = useTranslations('duetIntegrations')
  const pending = notice.kind === 'pending'
  const success = notice.kind === 'success'
  const canceled = notice.kind === 'canceled'
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-xl border p-4 ${success ? 'border-emerald-500/30 bg-emerald-500/5' : notice.kind === 'error' ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/50'}`}
    >
      {pending ? (
        <CircleNotchIcon className="mt-0.5 size-5 animate-spin" />
      ) : success ? (
        <CheckCircleIcon className="mt-0.5 size-5 text-emerald-600" />
      ) : (
        <WarningCircleIcon className="mt-0.5 size-5 text-destructive" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {t(
            pending
              ? 'callbackPending'
              : success
                ? 'callbackSuccess'
                : canceled
                  ? 'callbackCanceled'
                  : 'callbackError',
          )}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {success
            ? t('callbackSuccessBody', { integration: notice.integration })
            : t(
                pending
                  ? 'callbackPendingBody'
                  : canceled
                    ? 'callbackCanceledBody'
                    : 'callbackErrorBody',
              )}
        </p>
      </div>
      {!pending ? (
        <div className="flex items-center gap-2">
          {!success && !canceled && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('retry')}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('dismiss')}
            onClick={onDismiss}
            className="rounded-md p-1 hover:bg-muted"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ConnectedCard({
  connections,
  hasMore,
  pageFailed,
  loadingMore,
  catalog,
  connecting,
  disconnecting,
  agents,
  pendingAgentPolicies,
  failedAgentPolicies,
  onConnect,
  onLoadMore,
  onDisconnect,
  onSetAgentPolicy,
}: {
  connections: IntegrationConnection[]
  hasMore?: boolean
  pageFailed?: boolean
  loadingMore?: boolean
  catalog: IntegrationCatalogItem[]
  connecting?: string
  disconnecting?: string
  agents: IntegrationAgentOption[]
  pendingAgentPolicies?: ReadonlySet<string>
  failedAgentPolicies?: ReadonlySet<string>
  onConnect(integration: string): void
  onLoadMore?(): void
  onDisconnect(connection: IntegrationConnection): void
  onSetAgentPolicy(connection: IntegrationConnection, allowedAgentIds: string[] | undefined): void
}) {
  const t = useTranslations('duetIntegrations')
  return (
    <WorkspacePanel>
      <WorkspacePanelHeader
        title={t('connectedTitle')}
        description={t(hasMore ? 'connectedLoadedCount' : 'connectedCount', {
          count: connections.length,
        })}
        leading={<PlugsConnectedIcon className="size-4" weight="duotone" />}
      />
      {connections.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <PlugsIcon className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">
            {t(hasMore ? 'connectedIncompleteTitle' : 'connectedEmptyTitle')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(hasMore ? 'connectedIncompleteBody' : 'connectedEmptyBody')}
          </p>
          {hasMore && onLoadMore !== undefined ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}
            >
              {loadingMore ? t('loadingMore') : pageFailed ? t('loadMoreError') : t('loadMore')}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="divide-y">
            {connections.map(connection => {
              const item = catalog.find(
                candidate => candidate.integration === connection.integration,
              )
              const name = connection.name ?? item?.name ?? connection.integration
              return (
                <div key={connection.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <IntegrationMark name={name} logoUrl={connection.logoUrl ?? item?.logoUrl} />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {connection.integration}
                    </span>
                  </div>
                  <div className="ml-13 flex w-full flex-wrap items-center justify-end gap-2 sm:ml-0 sm:w-auto">
                    <StatusBadge status={connection.status} />
                    {connection.status === 'error' ? (
                      <button
                        type="button"
                        onClick={() => onConnect(connection.integration)}
                        disabled={connecting !== undefined}
                        className={cn(
                          buttonVariants({ variant: 'ghost', size: 'sm' }),
                          'text-brand hover:bg-brand/10 hover:text-brand',
                        )}
                      >
                        {connecting === connection.integration ? t('reconnecting') : t('reconnect')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDisconnect(connection)}
                      disabled={disconnecting === connection.id}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'sm' }),
                        'text-destructive hover:bg-destructive/10 hover:text-destructive',
                      )}
                    >
                      {disconnecting === connection.id ? t('disconnecting') : t('disconnect')}
                    </button>
                    <IntegrationAgentAccessEditor
                      subject={connection.integration}
                      allowedAgentIds={connection.allowedAgentIds}
                      agents={agents}
                      pending={pendingAgentPolicies?.has(connection.integration)}
                      error={failedAgentPolicies?.has(connection.integration)}
                      onChange={allowedAgentIds => onSetAgentPolicy(connection, allowedAgentIds)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          {hasMore && onLoadMore !== undefined ? (
            <div className="flex justify-center border-t px-5 py-4">
              <button
                type="button"
                disabled={loadingMore}
                onClick={onLoadMore}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {loadingMore ? t('loadingMore') : pageFailed ? t('loadMoreError') : t('loadMore')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </WorkspacePanel>
  )
}

function CatalogCard({
  items,
  connected,
  search,
  hasMore,
  pageFailed,
  loadingMore,
  connecting,
  onSearch,
  onLoadMore,
  onConnect,
}: {
  items: IntegrationCatalogItem[]
  connected: Set<string>
  search: string
  hasMore?: boolean
  pageFailed?: boolean
  loadingMore?: boolean
  connecting?: string
  onSearch(value: string): void
  onLoadMore(): void
  onConnect(integration: string): void
}) {
  const t = useTranslations('duetIntegrations')
  const available = items.filter(item => !item.connected && !connected.has(item.integration))
  return (
    /* Named for the same reason the custom-server panel is: both panels offer a
       control called Connect, so a page-wide locator for one now matches the
       other. */
    <WorkspacePanel data-integration-catalog="">
      <WorkspacePanelHeader
        title={t('catalogTitle')}
        description={t('catalogBody')}
        leading={<PlugsIcon className="size-4" weight="duotone" />}
      />
      <div className="border-b border-border/65 px-4 py-3 sm:px-5">
        <label className="relative block">
          <span className="sr-only">{t('searchLabel')}</span>
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={event => onSearch(event.currentTarget.value)}
            placeholder={t('searchPlaceholder')}
            className="min-h-11 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring/45 sm:h-9 sm:min-h-0"
          />
        </label>
      </div>
      {available.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <MagnifyingGlassIcon className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-3 font-medium">
            {t(hasMore || pageFailed ? 'catalogIncompleteTitle' : 'catalogEmptyTitle')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(hasMore || pageFailed ? 'catalogIncompleteBody' : 'catalogEmptyBody')}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/65">
          {available.map(item => (
            <div
              key={item.integration}
              className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/25 sm:flex-nowrap sm:px-5"
            >
              <IntegrationMark name={item.name} logoUrl={item.logoUrl} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{item.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {item.description ?? item.integration}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onConnect(item.integration)}
                disabled={connecting !== undefined}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-auto')}
              >
                {connecting === item.integration ? (
                  <CircleNotchIcon className="size-3.5 animate-spin" />
                ) : (
                  <PlugsIcon className="size-3.5" />
                )}
                {connecting === item.integration ? t('connecting') : t('connect')}
              </button>
            </div>
          ))}
        </div>
      )}
      {hasMore || pageFailed ? (
        <div className="border-t p-4 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className={buttonVariants({ variant: 'outline' })}
          >
            {loadingMore ? t('loadingMore') : pageFailed ? t('loadMoreError') : t('loadMore')}
          </button>
        </div>
      ) : null}
    </WorkspacePanel>
  )
}

function StatusBadge({ status }: { status: IntegrationConnection['status'] }) {
  const t = useTranslations('duetIntegrations')
  const active = status === 'active'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : status === 'pending' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-destructive/10 text-destructive'}`}
    >
      {active ? (
        <CheckCircleIcon className="size-3" />
      ) : status === 'pending' ? (
        <CircleNotchIcon className="size-3 animate-spin" />
      ) : (
        <WarningCircleIcon className="size-3" />
      )}
      {t(`status.${status}`)}
    </span>
  )
}

function DisconnectDialog({
  displayName,
  onCancel,
  onConfirm,
}: {
  displayName: string
  onCancel(): void
  onConfirm(): void
}) {
  const t = useTranslations('duetIntegrations')
  return (
    <AlertDialog open onOpenChange={open => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <ShieldCheckIcon className="size-7 text-destructive" />
          <AlertDialogTitle>{t('disconnectTitle', { name: displayName })}</AlertDialogTitle>
          <AlertDialogDescription>{t('disconnectBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t('disconnect')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
