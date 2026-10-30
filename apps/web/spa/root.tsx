'use client'

import { usePostHog } from '@posthog/next'
import {
  QueryClientProvider,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { useTranslations } from 'next-intl'
import React, {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  parsePath,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutlet,
  useParams,
} from 'react-router'

import type { WhoamiResponse } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'

import { identifyProductUserOnce } from './analytics'
import { duetApi, DuetApiError } from './api/client'
import { createDuetQueryClient } from './api/query-client'
import { collectionItems, duetQueryOptions, prependCollectionItem } from './api/query-options'
import { duetQueryPersistence, type QueryCachePersistence } from './api/query-persistence'
import { TrainUploadsClient } from './api/train-uploads'
import { prepareWorkspaceTransition } from './api/workspace-transition'
import { SpaContext, type SpaApi, type SpaContextValue, useSpa } from './context'
import { DriveBootstrapShell, RouteLoadingIsland } from './drive/bootstrap-shell'
import { driveFolderUrl } from './drive/drive-routes'
import { DriveWorkspaceShell } from './drive/drive-workspace-shell'
import { StorageWarning } from './entitlements/storage-warning'
import { ROOT_ENTITLEMENT_POLL_MS } from './entitlements/subscribe-wall'
import { usePreloadAgentPages } from './knowledge-map-data/preload-agent-pages'
import { OnboardingChainOrchestrator } from './onboarding/onboarding-chain-orchestrator'
import { WorkspaceOnboardingRoute } from './onboarding/onboarding-route'
import { onboardingGatePath } from './onboarding/onboarding-routing'
import {
  PRODUCT_DESTINATION_VIEWS,
  warmAgentDestinationChunks,
} from './routes/product-destination-views'
import { type ProductDestinationId } from './routes/product-destinations'
import {
  isUserSettingSurface,
  isWorkspaceSettingSurface,
  WORKSPACE_DESTINATIONS,
} from './routes/route-metadata'
import { routingModeForInitialPath } from './routing-mode'
import { eligibleShareWorkspaces } from './shares/recipient-requests'
import { CreateWorkspaceDialog } from './shell/create-workspace-dialog'
import { PendingInvitations } from './shell/pending-invitations'
import { SessionExpired } from './shell/session-expired'
import { InlineState, StatePage } from './shell/state-page'
import { ToastProvider } from './shell/toast'
import { VersionChecker } from './shell/version-checker'
import { WorkspaceSwitchMenu } from './shell/workspace-switch-menu'
import { workHomeUrl, workPresentationForPath } from './team-space/work-destination'

const defaultTrainUploads = new TrainUploadsClient()

export function DuetSpa({
  initialPath,
  initialRouterState,
  serverPath,
  fixtureIdentity,
  api = duetApi,
  trainUploads = defaultTrainUploads,
  onSignedOut,
  onLocaleChange,
  entitlementPollMs = ROOT_ENTITLEMENT_POLL_MS,
  clock,
  cachePersistence,
}: {
  initialPath?: string
  initialRouterState?: unknown
  serverPath?: string
  fixtureIdentity?: WhoamiResponse
  api?: SpaApi
  trainUploads?: TrainUploadsClient
  onSignedOut?: () => void
  onLocaleChange?: (locale: 'en' | 'es-419') => void
  entitlementPollMs?: number
  clock?: () => number
  /**
   * Whose query cache this browser may keep between sittings. Absent — every
   * playground fixture, and any surface with no signed-in reader — means the
   * cache lives and dies with the tab.
   */
  cachePersistence?: QueryCachePersistence
} = {}) {
  const [queryClient] = useState(createDuetQueryClient)
  const userId = cachePersistence?.userId
  const databaseName = cachePersistence?.databaseName
  /* Whether to persist is decided by the prop alone, so the server and the
     first client render agree; only the storage underneath differs, and the
     persister already reads an absent one as "do not persist". */
  const persistence = useMemo(
    () => (userId === undefined ? undefined : duetQueryPersistence({ userId, databaseName })),
    [databaseName, userId],
  )

  const content = (
    <ToastProvider>
      {persistence === undefined ? null : <PersistCacheOnLeaving flush={persistence.flush} />}
      {/* Outside the bootstrap: a stale tab should learn it is stale even
          while identity is loading or the workspace failed to resolve. */}
      <VersionChecker />
      <SpaBootstrap
        initialPath={initialPath}
        initialRouterState={initialRouterState}
        serverPath={serverPath}
        fixtureIdentity={fixtureIdentity}
        api={api}
        trainUploads={trainUploads}
        onSignedOut={onSignedOut}
        onLocaleChange={onLocaleChange}
        entitlementPollMs={entitlementPollMs}
        clock={clock}
        forgetCache={persistence?.forget}
      />
    </ToastProvider>
  )

  if (persistence === undefined) {
    return <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
  }
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistence.options}>
      {content}
    </PersistQueryClientProvider>
  )
}

/**
 * Write the cache down on the way out.
 *
 * The standing subscription writes on a throttle, which is right for a live
 * surface and wrong for the reader this feature is for: read a page, click
 * away within two seconds, and what they read was never stored. Both events,
 * because they answer different departures — `visibilitychange` is the tab
 * going to the background, `pagehide` is this document being replaced.
 */
function PersistCacheOnLeaving({ flush }: { flush: (queryClient: QueryClient) => Promise<void> }) {
  const queryClient = useQueryClient()
  useEffect(() => {
    const write = () => void flush(queryClient)
    const onHidden = () => {
      if (document.visibilityState === 'hidden') write()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', write)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', write)
    }
  }, [flush, queryClient])
  return null
}

function SpaBootstrap({
  initialPath,
  initialRouterState,
  serverPath,
  fixtureIdentity,
  api,
  trainUploads,
  onSignedOut,
  onLocaleChange,
  entitlementPollMs,
  clock,
  forgetCache,
}: {
  initialPath?: string
  initialRouterState?: unknown
  serverPath?: string
  fixtureIdentity?: WhoamiResponse
  api: SpaApi
  trainUploads: TrainUploadsClient
  onSignedOut?: () => void
  onLocaleChange?: (locale: 'en' | 'es-419') => void
  entitlementPollMs: number
  clock?: () => number
  /** Present only while this browser is keeping a cache; see `duetQueryPersistence`. */
  forgetCache?: () => Promise<void>
}) {
  const t = useTranslations('duetApp')
  const productAnalytics = usePostHog()
  const identifiedUserId = useRef<string | undefined>(undefined)
  const queryClient = useQueryClient()
  const [activeWorkspaceSlug, setActiveWorkspaceSlug] = useState<string>()
  const identityOptions = duetQueryOptions.identity(api)
  const identityQuery = useQuery({
    ...identityOptions,
    enabled: typeof window !== 'undefined',
    initialData: fixtureIdentity,
    retry: (failureCount, error) =>
      failureCount < 2 && !(error instanceof DuetApiError && error.status === 401),
    retryDelay: 500,
    refetchInterval: query => (query.state.status === 'error' ? false : entitlementPollMs),
  })
  const initialIdentity = identityQuery.data
  const initialWorkspaceSlug = (initialPath ?? serverPath)?.match(/^\/w\/([^/?#]+)(?:[/?#]|$)/)?.[1]
  const initialWorkspaceVerificationNeeded =
    initialIdentity !== undefined &&
    !identityQuery.isFetchedAfterMount &&
    initialWorkspaceSlug !== undefined &&
    !initialIdentity.workspaces.some(workspace => workspace.slug === initialWorkspaceSlug)
  const initialWorkspaceVerificationRequested = useRef(false)
  const refetchIdentity = identityQuery.refetch
  useEffect(() => {
    if (!initialWorkspaceVerificationNeeded || initialWorkspaceVerificationRequested.current) {
      return
    }
    initialWorkspaceVerificationRequested.current = true
    void refetchIdentity()
  }, [initialWorkspaceVerificationNeeded, refetchIdentity])
  const viewerPaysAnyWorkspace =
    identityQuery.data?.workspaces.some(
      workspace => workspace.billingUserId === identityQuery.data?.user.id,
    ) ?? false
  const billingOptions = duetQueryOptions.user.billingOverview(api, entitlementPollMs)
  const billingQuery = useQuery({
    ...billingOptions,
    enabled: viewerPaysAnyWorkspace,
  })
  const billingOverview = billingQuery.data ?? undefined
  useEffect(() => {
    if (identityQuery.data !== undefined) {
      identifiedUserId.current = identifyProductUserOnce(
        productAnalytics,
        identityQuery.data,
        identifiedUserId.current,
      )
    }
  }, [identityQuery.data, productAnalytics])

  if (identityQuery.isError) {
    if (identityQuery.error instanceof DuetApiError && identityQuery.error.status === 401) {
      return <SessionExpired returnTo={currentDocumentPath()} />
    }
    return (
      <StatePage
        title={t('errorTitle')}
        body={t('errorBody')}
        action={
          <button className={buttonVariants()} onClick={() => void identityQuery.refetch()}>
            {t('retry')}
          </button>
        }
      />
    )
  }
  if (identityQuery.isPending || initialWorkspaceVerificationNeeded) {
    return <DriveBootstrapShell initialPath={initialPath ?? serverPath} />
  }

  const identity = identityQuery.data
  const value: SpaContextValue = {
    api,
    trainUploads,
    identity,
    billingOverview,
    activeWorkspaceSlug,
    async transitionWorkspace(nextSlug) {
      if (activeWorkspaceSlug === undefined) {
        setActiveWorkspaceSlug(nextSlug)
        return identity.workspaces.find(workspace => workspace.slug === nextSlug)
      }
      if (activeWorkspaceSlug === nextSlug) {
        return identity.workspaces.find(workspace => workspace.slug === nextSlug)
      }
      const workspace = await prepareWorkspaceTransition({
        queryClient,
        previousSlug: activeWorkspaceSlug,
        nextSlug,
        refreshIdentity: async () => {
          const freshIdentity = await api.whoami()
          queryClient.setQueryData(identityOptions.queryKey, freshIdentity)
          return freshIdentity
        },
      })
      if (workspace !== undefined) setActiveWorkspaceSlug(nextSlug)
      return workspace
    },
    async createWorkspace(input) {
      const result = await api.createWorkspace(input)
      // Birth computes servicing state atomically. Refresh that projection instead of
      // synthesizing an active workspace that could briefly evade the entitlement wall.
      const freshIdentity = await api.whoami()
      queryClient.setQueryData(identityOptions.queryKey, freshIdentity)
      return result
    },
    async logout() {
      /* Before leaving, not after: the next reader of this browser must not
         find the last one's workspace waiting in IndexedDB. Latched, so the
         `pagehide` this navigation is about to fire cannot write it back. */
      await forgetCache?.()
      if (onSignedOut) onSignedOut()
      else window.location.assign('/sign-out')
    },
    onLocaleChange,
    clock,
  }

  return (
    <SpaContext.Provider value={value}>
      <SpaRouter
        initialPath={initialPath}
        initialRouterState={initialRouterState}
        serverPath={serverPath}
      />
    </SpaContext.Provider>
  )
}

function SpaRouter({
  initialPath,
  initialRouterState,
  serverPath,
}: {
  initialPath?: string
  initialRouterState?: unknown
  serverPath?: string
}) {
  const routingMode = routingModeForInitialPath(initialPath)
  const [mounted, setMounted] = useState(routingMode.kind === 'memory')
  useEffect(() => setMounted(true), [])
  const routes = (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <PendingInvitations />
      <div className="relative min-h-0 flex-1 overflow-hidden [--product-viewport-height:100%]">
        <OnboardingChainOrchestrator>
          <SpaRoutes />
        </OnboardingChainOrchestrator>
      </div>
    </div>
  )

  if (routingMode.kind === 'memory') {
    return (
      <MemoryRouter
        initialEntries={[{ ...parsePath(routingMode.initialPath), state: initialRouterState }]}
      >
        {routes}
      </MemoryRouter>
    )
  }
  if (!mounted) return <DriveBootstrapShell initialPath={serverPath} />
  return <BrowserRouter>{routes}</BrowserRouter>
}

function SpaRoutes() {
  const { billingOverview, activeWorkspaceSlug } = useSpa()
  const navigate = useNavigate()
  const openBilling = useCallback(() => navigate('/settings/billing'), [navigate])
  const pendingShareLanding = usePendingShareLanding()
  if (pendingShareLanding) return <DriveBootstrapShell initialPath="/" />
  return (
    <>
      <StorageWarning
        billing={billingOverview}
        activeWorkspaceSlug={activeWorkspaceSlug}
        onOpenBilling={openBilling}
      />
      <Routes>
        <Route index element={<RootRedirect />} />
        <Route path="w/:workspaceSlug/onboarding" element={<WorkspaceOnboardingRoute />} />
        <Route path="w/:workspaceSlug" element={<WorkspaceRoute />}>
          {/* The workspace front door is Work Home. Onboarding remains the outer
              gate, so a new workspace never sees product chrome early. */}
          <Route index element={<WorkspaceFrontDoor />} />
          {WORKSPACE_DESTINATIONS.map(([route, destination]) => (
            <Route key={route} path={route} element={<LazyDestination id={destination} />} />
          ))}
          {/* Invitations are part of the roster, so Members is where they are
                read and written; the address they used to have still resolves,
                because an owner's bookmark should land on the list rather than
                on a 404. Order is not what makes it win — the router ranks by
                specificity, so a static `invites` outranks `:surface` wherever
                it is declared — it sits here because this is where it reads. */}
          <Route path="settings/invites" element={<Navigate to="../settings/members" replace />} />
          <Route path="settings/:surface?" element={<WorkspaceSettingRoute />} />
          <Route path="*" element={<NotFoundRoute />} />
        </Route>
        <Route path="settings/:surface?" element={<GlobalShellRoute kind="user" />} />
        <Route path="internal-admin" element={<GlobalShellRoute kind="admin" />} />
        <Route path="*" element={<NotFoundRoute standalone />} />
      </Routes>
    </>
  )
}

function usePendingShareLanding(): boolean {
  const { api, identity } = useSpa()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const handledLanding = useRef<string | undefined>(undefined)
  const pending = useQuery(duetQueryOptions.user.pendingShareLanding(api))
  const shareRequestsKey = useMemo(() => duetQueryOptions.user.shareRequests(api).queryKey, [api])
  useEffect(() => {
    const share = pending.data
    if (share == null) return
    const workspace = eligibleShareWorkspaces(identity.workspaces)[0] ?? identity.workspaces[0]
    if (workspace === undefined) return
    if (share === 'unavailable') {
      if (handledLanding.current === share) return
      handledLanding.current = share
      const destination = `${driveFolderUrl(workspace.slug, '/')}?shareLink=unavailable`
      if (`${location.pathname}${location.search}` !== destination)
        navigate(destination, { replace: true })
      return
    }
    if (handledLanding.current === share.id) return
    handledLanding.current = share.id
    queryClient.setQueryData(shareRequestsKey, current => {
      if (collectionItems(current).some(candidate => candidate.id === share.id)) return current
      return prependCollectionItem(current, share)
    })
    void queryClient.invalidateQueries({
      queryKey: shareRequestsKey,
      exact: true,
    })
    const destination = `${driveFolderUrl(workspace.slug, '/')}?shareRequest=${encodeURIComponent(share.id)}`
    if (`${location.pathname}${location.search}` !== destination)
      navigate(destination, { replace: true })
  }, [
    identity.workspaces,
    location.pathname,
    location.search,
    navigate,
    pending.data,
    queryClient,
    shareRequestsKey,
  ])
  const markedLanding =
    location.pathname === '/' && new URLSearchParams(location.search).get('shared') === '1'
  return markedLanding && (pending.isPending || pending.data != null)
}

/* The workspace's own front door is the collaborative Work surface. */
function WorkspaceFrontDoor() {
  const { workspaceSlug = '' } = useParams()
  return <Navigate to={workHomeUrl(workspaceSlug)} replace />
}

function RootRedirect() {
  const { identity } = useSpa()
  if (identity.workspaces.length === 0) return <EmptyWorkspaceRoute />
  const workspace = identity.workspaces[0]!
  const destination = workHomeUrl(workspace.slug)
  return <Navigate to={onboardingGatePath(workspace) ?? destination} replace />
}

function WorkspaceRoute() {
  const t = useTranslations('duetApp')
  const { workspaceSlug } = useParams()
  const location = useLocation()
  const { identity, activeWorkspaceSlug, transitionWorkspace } = useSpa()
  const outlet = useOutlet()
  const [transitionError, setTransitionError] = useState(false)
  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  const gatePath = workspace === undefined ? null : onboardingGatePath(workspace)
  useEffect(() => {
    if (workspace === undefined || workspace.slug === activeWorkspaceSlug || transitionError) {
      return
    }
    let cancelled = false
    void transitionWorkspace(workspace.slug).catch(() => {
      if (!cancelled) setTransitionError(true)
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceSlug, transitionError, transitionWorkspace, workspace])
  if (transitionError) return <WorkspaceTransitionError />
  if (workspace === undefined) return <InvalidWorkspaceRoute />
  if (gatePath !== null) return <Navigate to={gatePath} replace />
  if (activeWorkspaceSlug !== undefined && workspace.slug !== activeWorkspaceSlug) {
    return (
      <DriveWorkspaceShell workspace={workspace}>
        <RouteLoadingIsland
          path={`${location.pathname}${location.search}`}
          label={t('loadingIslandLabel')}
        />
      </DriveWorkspaceShell>
    )
  }
  return (
    <DriveWorkspaceShell workspace={workspace}>
      {outlet}
      {/* Paused servicing is the wall next door — the VM's reads are
          deliberately closed, so warming a fleet nobody can navigate to would
          be a burst of requests for nothing. `servicingStatus` is the one
          fact the wall itself turns on (see `deriveWorkspaceWall`). */}
      {workspace.servicingStatus !== 'paused' &&
      workPresentationForPath(location.pathname, workspace.slug, location.search).kind ===
        'build' ? (
        <PreloadAgentPages workspaceSlug={workspace.slug} />
      ) : null}
    </DriveWorkspaceShell>
  )
}

/* Clicking between agents is the product's ordinary gesture, so everything an
   agent page waits on is asked for the moment the workspace is stood — see the
   hook. A component rather than a hook call in `WorkspaceRoute` because the
   route has early returns above (transition, gate) that a hook cannot sit
   under, and those are exactly the states the preload must not fire in. */
function PreloadAgentPages({ workspaceSlug }: { workspaceSlug: string }) {
  usePreloadAgentPages(workspaceSlug)
  useEffect(() => {
    warmAgentDestinationChunks()
  }, [])
  return null
}

function GlobalShellRoute({ kind }: { kind: 'user' | 'admin' }) {
  const { surface } = useParams()
  const { identity, activeWorkspaceSlug } = useSpa()
  const workspace =
    identity.workspaces.find(candidate => candidate.slug === activeWorkspaceSlug) ??
    identity.workspaces[0]
  if (workspace === undefined) return <EmptyWorkspaceRoute />
  if (kind === 'admin' && !identity.internalAdmin) return <UnauthorizedRoute />
  return (
    <DriveWorkspaceShell workspace={workspace}>
      {kind === 'user' && !isUserSettingSurface(surface) ? (
        <NotFoundRoute />
      ) : (
        <LazyDestination id={kind === 'admin' ? 'internalAdmin' : 'userSettings'} />
      )}
    </DriveWorkspaceShell>
  )
}

function WorkspaceSettingRoute() {
  const { surface } = useParams()
  if (!isWorkspaceSettingSurface(surface)) return <NotFoundRoute />
  return <LazyDestination id="workspaceSettings" />
}

function LazyDestination({ id }: { id: ProductDestinationId }) {
  const t = useTranslations('duetApp')
  const location = useLocation()
  const Destination = PRODUCT_DESTINATION_VIEWS[id].component
  return (
    <RouteBoundary key={id} title={t('routeErrorTitle')} body={t('routeErrorBody')}>
      <div className="contents" data-destination-content={id}>
        <Suspense
          fallback={
            <RouteLoadingIsland
              path={`${location.pathname}${location.search}`}
              label={t('loadingIslandLabel')}
            />
          }
        >
          <Destination />
        </Suspense>
      </div>
    </RouteBoundary>
  )
}

class RouteBoundary extends React.Component<
  { children: ReactNode; title: string; body: string },
  { error: Error | null }
> {
  state = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error !== null) {
      return <InlineState title={this.props.title} body={this.props.body} />
    }
    return this.props.children
  }
}

function EmptyWorkspaceRoute() {
  const t = useTranslations('duetApp')
  const { createWorkspace } = useSpa()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <StatePage
        title={t('emptyWorkspaceTitle')}
        body={t('emptyWorkspaceBody')}
        action={
          <button onClick={() => setOpen(true)} className={buttonVariants()}>
            {t('createWorkspace')}
          </button>
        }
      />
      <CreateWorkspaceDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreate={async input => {
          const created = await createWorkspace(input)
          navigate(workHomeUrl(created.slug))
        }}
      />
    </>
  )
}

function InvalidWorkspaceRoute() {
  const t = useTranslations('duetApp')
  const { identity } = useSpa()
  const navigate = useNavigate()
  return (
    <StatePage
      title={t('invalidWorkspaceTitle')}
      body={t('invalidWorkspaceBody')}
      action={
        identity.workspaces.length > 0 ? (
          <WorkspaceSwitchMenu
            workspaceSwitch={{
              workspaces: identity.workspaces,
              onSelect: workspace => navigate(workHomeUrl(workspace.slug)),
            }}
          />
        ) : undefined
      }
    />
  )
}

function WorkspaceTransitionError() {
  const t = useTranslations('duetApp')
  return <StatePage title={t('errorTitle')} body={t('errorBody')} />
}

function UnauthorizedRoute() {
  const t = useTranslations('duetApp')
  return <StatePage title={t('unauthorizedTitle')} body={t('unauthorizedBody')} />
}

function NotFoundRoute({ standalone = false }: { standalone?: boolean }) {
  const t = useTranslations('duetApp')
  const state = <InlineState title={t('notFoundTitle')} body="404" />
  return standalone ? <main className="min-h-screen bg-sidebar p-6">{state}</main> : state
}

function currentDocumentPath(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return `${window.location.pathname}${window.location.search}`
}
