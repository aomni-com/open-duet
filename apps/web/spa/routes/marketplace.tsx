'use client'

import { ArrowLeft } from '@phosphor-icons/react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, type NavigateFunction } from 'react-router'

import type {
  MarketplaceAgentSubscriptionResponse,
  MarketplaceListingSummary,
} from '@repo/contract'
import { AGENT_TAGS } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'

import {
  duetMutationOptions,
  duetQueryOptions,
  isInitialCollectionError,
} from '../api/query-options'
import { useSpa, type SpaApi } from '../context'
import { agentsMapUrl } from '../drive/agents-map-url'
import { driveRoutes } from '../drive/drive-routes'
import { MarketplaceConsentSheet } from '../marketplace/consent-sheet'
import { MarketplaceListingDetailPage } from '../marketplace/detail-page'
import { MarketplaceAgentGalleryCard } from '../marketplace/gallery-card'
import { useMarketplaceInstallFlow } from '../marketplace/install-flow'
import { MarketplaceInstallNameDialog } from '../marketplace/install-name-dialog'
import {
  marketplaceListingInstances,
  marketplaceUnreadAcknowledgements,
  type MarketplaceListingInstance,
} from '../marketplace/instance-projection'
import { MarketplaceLoadingView } from '../marketplace/loading'
import { selectListings, type TagSelection } from '../marketplace/tag-filter'
import { MarketplaceTagRail } from '../marketplace/tag-rail'

export default function MarketplaceAgentsRoute() {
  const { workspaceSlug = '', publisherSlug, agentName } = useParams()
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {publisherSlug === undefined || agentName === undefined ? (
        <MarketplaceAgentsGallery workspaceSlug={workspaceSlug} />
      ) : (
        <MarketplaceListingDetailRoute
          workspaceSlug={workspaceSlug}
          publisherSlug={publisherSlug}
          agentName={agentName}
        />
      )}
    </div>
  )
}

function MarketplaceAgentsGallery({ workspaceSlug }: { workspaceSlug: string }) {
  const t = useTranslations('duetApp.marketplace')
  const { api, identity } = useSpa()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Route state, deliberately not persisted: a filter that survives a reload
  // leaves someone looking at a catalog that seems broken because they
  // narrowed it last week.
  const [selectedTag, setSelectedTag] = useState<TagSelection>(null)
  const catalog = useInfiniteQuery(
    duetQueryOptions.agents.marketplace.catalog(
      api,
      selectedTag === null ? {} : { tag: selectedTag },
    ),
  )
  const subscriptions = useQuery(duetQueryOptions.workspaces.agentSubscriptions(api, workspaceSlug))
  const agents = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const workspaceRole = identity.workspaces.find(
    workspace => workspace.slug === workspaceSlug,
  )?.role
  const canInstall = workspaceRole === 'owner' || workspaceRole === 'editor'
  const install = useMutation(
    duetMutationOptions.workspaces.agents.marketplace.install(api, queryClient, workspaceSlug),
  )
  // A card's Install runs the SAME ceremony as the detail page, through the
  // one owner of its ordering. The flow needs the listing DETAIL (the name
  // dialog's slug placeholder, the consent sheet's declarations), fetched
  // lazily for the one clicked card rather than carried by the whole catalog.
  const [installTarget, setInstallTarget] = useState<MarketplaceListingSummary | null>(null)
  const flow = useMarketplaceInstallFlow(install, {
    onInstalled: response => {
      setInstallTarget(null)
      void navigateToInstalledAgent(api, queryClient, workspaceSlug, response, navigate)
    },
  })
  const cancelFlow = flow.cancel
  const installDetail = useQuery({
    ...duetQueryOptions.agents.marketplace.detail(
      api,
      installTarget?.publisherSlug ?? '',
      installTarget?.agentName ?? '',
    ),
    enabled: installTarget !== null,
  })
  const cancelInstall = useCallback(() => {
    setInstallTarget(null)
    cancelFlow()
  }, [cancelFlow])
  // A detail that cannot load cannot be installed from here; the card itself
  // still opens the listing route, which has its own failure surface.
  const installFlowBroken = installTarget !== null && installDetail.isLoadingError
  useEffect(() => {
    if (installFlowBroken) cancelInstall()
  }, [cancelInstall, installFlowBroken])

  if (catalog.isPending || subscriptions.isPending || agents.isPending)
    return <MarketplaceLoadingView label={t('loading')} />
  if (
    catalog.data === undefined ||
    isInitialCollectionError(catalog) ||
    subscriptions.isLoadingError ||
    subscriptions.data === undefined ||
    isInitialCollectionError(agents) ||
    agents.data === undefined
  )
    return (
      <MarketplaceAgentsFailure
        onRetry={() =>
          void Promise.all([catalog.refetch(), subscriptions.refetch(), agents.refetch()])
        }
      />
    )

  const refreshFailed =
    (catalog.isRefetchError && !catalog.isFetchNextPageError) ||
    subscriptions.isRefetchError ||
    (agents.isRefetchError && !agents.isFetchNextPageError)

  if (flow.pendingConsent !== null && installDetail.data !== undefined)
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
        <MarketplaceConsentSheet
          detail={installDetail.data}
          onConfirm={flow.confirmConsent}
          onCancel={cancelInstall}
        />
      </main>
    )

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
      <header className="mx-auto mb-8 max-w-2xl text-center">
        {/* Small type, but it is the page's heading: the surface names itself
            once, and each card's badge says whether Duet vouches for it. */}
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            data-marketplace-back="true"
            aria-label={t('backToAgents')}
            title={t('backToAgents')}
            onClick={() => navigate(driveRoutes.agents(workspaceSlug))}
            className="grid size-11 place-items-center rounded-full text-muted-foreground outline-none transition-[color,background-color,transform] duration-200 hover:-translate-x-0.5 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none sm:size-8"
          >
            <ArrowLeft aria-hidden size={16} />
          </button>
          <h1 className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
            {t('eyebrow')}
          </h1>
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
          {t('galleryDescription')}
        </p>
        <Button
          className="mt-5"
          variant="outline"
          size="sm"
          type="button"
          onClick={() =>
            void Promise.all([catalog.refetch(), subscriptions.refetch(), agents.refetch()])
          }
        >
          {t('refresh')}
        </Button>
        {catalog.data.meta?.canPublishListings ? (
          // Rendered ONLY from the server-projected capability. The mutation
          // refuses independently, so this is presentation, never the gate.
          <button
            type="button"
            data-testid="marketplace-publish-control"
            className="ml-2 mt-5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium"
          >
            {t('publishListing')}
          </button>
        ) : null}
      </header>
      {refreshFailed ? (
        <MarketplaceRefreshFailure
          onRetry={() =>
            void Promise.all([catalog.refetch(), subscriptions.refetch(), agents.refetch()])
          }
        />
      ) : null}
      <MarketplaceTagRail tags={AGENT_TAGS} selected={selectedTag} onSelect={setSelectedTag} />
      {(() => {
        // Filtered and ordered by the one owner; this route never decides
        // either. Verified/community remains the outer split — trust is a
        // different question from function, and a tag must not mix them.
        const shown = selectListings(catalog.data.items, null)
        const verified = shown.filter(listing => listing.verifiedPublisher)
        const community = shown.filter(listing => !listing.verifiedPublisher)
        if (shown.length === 0)
          return (
            <p data-testid="marketplace-tag-empty" className="text-sm text-muted-foreground">
              {t(
                catalog.hasNextPage || catalog.isFetchNextPageError
                  ? 'catalogIncomplete'
                  : 'noListingsForTag',
              )}
            </p>
          )
        // Each section renders only when it has listings, so with only official
        // agents present this surface is byte-identical to what shipped before
        // the marketplace existed — which is the launch state, since publishing
        // is gated off.
        const renderSection = (
          listings: typeof catalog.data.items,
          label: string,
          testId: string,
        ) =>
          listings.length === 0 ? null : (
            <section aria-label={label} data-testid={testId} className="mb-8 last:mb-0">
              {community.length > 0 ? (
                <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{label}</h2>
              ) : null}
              <div className="grid grid-cols-1 justify-center gap-4 sm:grid-cols-[repeat(auto-fit,minmax(17rem,20rem))]">
                {listings.map(listing => (
                  <MarketplaceAgentGalleryCard
                    key={`${listing.publisherSlug}/${listing.agentName}`}
                    listing={listing}
                    instances={marketplaceListingInstances(
                      listing.id,
                      subscriptions.data.items,
                      agents.data.items,
                    )}
                    installing={install.isPending && install.variables.listingId === listing.id}
                    onSelect={() =>
                      navigate(
                        driveRoutes.marketplaceListing(
                          workspaceSlug,
                          listing.publisherSlug,
                          listing.agentName,
                        ),
                      )
                    }
                    onInstall={
                      canInstall
                        ? () => {
                            setInstallTarget(listing)
                            flow.begin(listing.id)
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          )
        return (
          <>
            {renderSection(verified, t('sectionVerified'), 'marketplace-verified-gallery')}
            {renderSection(community, t('sectionCommunity'), 'marketplace-community-gallery')}
          </>
        )
      })()}
      {catalog.hasNextPage || catalog.isFetchNextPageError ? (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            disabled={catalog.isFetchingNextPage}
            onClick={() => void catalog.fetchNextPage()}
          >
            {catalog.isFetchingNextPage
              ? t('loadingMore')
              : catalog.isFetchNextPageError
                ? t('loadMoreError')
                : t('loadMore')}
          </Button>
        </div>
      ) : null}
      {installTarget !== null && installDetail.data !== undefined ? (
        <MarketplaceInstallNameDialog
          detail={installDetail.data}
          open={flow.naming !== null}
          intent={flow.naming?.intent}
          initialName={flow.naming?.initialName}
          collision={flow.naming?.collision}
          onCancel={cancelInstall}
          onConfirm={name => flow.named(installDetail.data, name)}
        />
      ) : null}
    </main>
  )
}

function MarketplaceListingDetailRoute({
  workspaceSlug,
  publisherSlug,
  agentName,
}: {
  workspaceSlug: string
  publisherSlug: string
  agentName: string
}) {
  const t = useTranslations('duetApp.marketplace')
  const { api, identity } = useSpa()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const detail = useQuery(duetQueryOptions.agents.marketplace.detail(api, publisherSlug, agentName))
  const subscriptions = useQuery(duetQueryOptions.workspaces.agentSubscriptions(api, workspaceSlug))
  const agents = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const install = useMutation(
    duetMutationOptions.workspaces.agents.marketplace.install(api, queryClient, workspaceSlug),
  )
  const acknowledge = useMutation(
    duetMutationOptions.workspaces.agents.marketplace.acknowledge(api, queryClient, workspaceSlug),
  )
  const flow = useMarketplaceInstallFlow(install, {
    onInstalled: response =>
      void navigateToInstalledAgent(api, queryClient, workspaceSlug, response, navigate),
  })
  const attemptedAcknowledgements = useRef(new Set<string>())
  const listingId = detail.data?.id
  const workspaceRole = identity.workspaces.find(
    workspace => workspace.slug === workspaceSlug,
  )?.role
  const canInstall = workspaceRole === 'owner' || workspaceRole === 'editor'
  const instances = marketplaceListingInstances(
    listingId ?? '',
    subscriptions.data?.items ?? [],
    agents.data?.items ?? [],
  )

  // The changelog is the detail route's primary content. Once it is visible,
  // acknowledge the exact applied revision through the per-subscription mutation.
  useEffect(() => {
    if (detail.data === undefined || !canInstall) return
    for (const { key, subscriptionId } of marketplaceUnreadAcknowledgements(
      instances.instances,
      attemptedAcknowledgements.current,
    )) {
      attemptedAcknowledgements.current.add(key)
      acknowledge.mutate(subscriptionId)
    }
  }, [acknowledge, canInstall, detail.data, instances.instances])

  if (detail.isPending || subscriptions.isPending || agents.isPending)
    return <MarketplaceLoadingView label={t('loading')} layout="marketplace-detail" />
  if (
    detail.isLoadingError ||
    detail.data === undefined ||
    subscriptions.isLoadingError ||
    subscriptions.data === undefined ||
    isInitialCollectionError(agents) ||
    agents.data === undefined
  )
    return (
      <MarketplaceAgentsFailure
        onRetry={() =>
          void Promise.all([detail.refetch(), subscriptions.refetch(), agents.refetch()])
        }
      />
    )

  const refreshFailed =
    detail.isRefetchError ||
    subscriptions.isRefetchError ||
    (agents.isRefetchError && !agents.isFetchNextPageError)

  const onDetailInstall = (intent: 'initial' | 'additional') => flow.begin(detail.data.id, intent)

  if (flow.pendingConsent !== null)
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
        <MarketplaceConsentSheet
          detail={detail.data}
          onConfirm={flow.confirmConsent}
          onCancel={flow.cancel}
        />
      </main>
    )

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
      {refreshFailed ? (
        <MarketplaceRefreshFailure
          onRetry={() =>
            void Promise.all([detail.refetch(), subscriptions.refetch(), agents.refetch()])
          }
        />
      ) : null}
      <MarketplaceListingDetailPage
        detail={detail.data}
        instances={instances}
        installing={install.isPending}
        canInstall={canInstall}
        onBack={() => navigate(driveRoutes.agents(workspaceSlug))}
        onInstall={onDetailInstall}
        onOpenAgent={instance => navigateToMarketplaceInstance(workspaceSlug, instance, navigate)}
      />
      <MarketplaceInstallNameDialog
        detail={detail.data}
        open={flow.naming !== null}
        intent={flow.naming?.intent}
        initialName={flow.naming?.initialName}
        collision={flow.naming?.collision}
        onCancel={flow.cancel}
        onConfirm={name => flow.named(detail.data, name)}
      />
    </main>
  )
}

async function navigateToInstalledAgent(
  api: SpaApi,
  queryClient: QueryClient,
  workspaceSlug: string,
  response: MarketplaceAgentSubscriptionResponse,
  navigate: NavigateFunction,
): Promise<void> {
  const agentId = response.subscription.agentId
  if (agentId === undefined) return
  const agent = await queryClient.fetchQuery(
    duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, { id: agentId }),
  )
  if (agent === null) return
  navigate(
    agentsMapUrl(workspaceSlug, {
      kind: 'agent',
      agentSlug: agent.slug,
      card: { kind: 'default' },
    }),
  )
}

function navigateToMarketplaceInstance(
  workspaceSlug: string,
  instance: MarketplaceListingInstance,
  navigate: NavigateFunction,
): void {
  if (instance.agent === undefined) return
  navigate(
    agentsMapUrl(workspaceSlug, {
      kind: 'agent',
      agentSlug: instance.agent.slug,
      card: { kind: 'default' },
    }),
  )
}

function MarketplaceAgentsFailure({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('duetApp.marketplace')
  return (
    <div role="alert" className="mx-auto my-12 w-full max-w-xl rounded-xl border bg-card p-8">
      <h1 className="text-xl font-semibold">{t('loadErrorTitle')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t('loadErrorBody')}</p>
      <Button className="mt-5" type="button" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}

function MarketplaceRefreshFailure({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('duetApp.marketplace')
  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
    >
      <span className="text-destructive">{t('refreshError')}</span>
      <Button variant="outline" size="sm" type="button" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}
