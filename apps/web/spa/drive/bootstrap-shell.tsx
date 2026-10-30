'use client'

import { useTranslations } from 'next-intl'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { DuetLoadingCue, DuetMark } from '../../components/brand/duet-mark'
import { AgentDetailLoadingSkeleton } from '../agents/agent-detail-loading'
import { DriveSkeleton } from '../files/drive-skeleton'
import { HomeLoadingIsland } from '../loading/home-loading'
import { isWorkLoadingView, loadingViewForPath } from '../loading/loading-route'
import { MarketplaceAgentsLoadingContent } from '../marketplace/loading'
import { AgentPageSkeleton } from '../routes/agents-map/agent-page-skeleton'
import { RosterSkeletonColumn } from '../routes/agents-map/agents-rail/skeleton-column'
import { AgentsSection } from '../routes/agents-map/agents-section'
import { IntegrationsLoadingView } from '../routes/integrations/integrations-loading'
import { AgentsWorkspaceLoadingFrame } from '../sessions/session-loading'
import { WorkBootstrapShell, WorkLoadingIsland } from '../team-space/work-loading'
import { isDriveCanvasPath } from './drive-routes'
import { DRIVE_TOPBAR_CLEARANCE, DriveShell, DriveTopBar } from './drive-shell'
import { buildWorkspaceTabs, workspaceTabForPath } from './workspace-tabs'

/**
 * The identity boundary resolves inside the same geometry as the product.
 * Only the route island is provisional, so authentication and chunk loading
 * never flash a separate full-page loading screen before the real shell.
 */
export function DriveBootstrapShell({ initialPath }: { initialPath?: string }) {
  const t = useTranslations('duetApp')
  const here = initialPath ?? '/'
  const pathname = new URL(here, 'https://duet.local').pathname
  const loadingView = loadingViewForPath(here)
  const activeTab = workspaceTabForPath(pathname)
  const tabs = buildWorkspaceTabs(destination =>
    destination === 'desktop' ? t('desktop.tabLabel') : t(destination),
  )

  if (isWorkLoadingView(loadingView)) {
    return <WorkBootstrapShell view={loadingView} label={t('loadingIslandLabel')} />
  }

  return (
    <DriveShell
      topBar={
        <DriveTopBar
          tabs={tabs}
          activeTab={activeTab}
          label={t('workspaceNavigation')}
          disabled
          leftSlot={<BootstrapWorkspaceMark brand={t('brand')} label={t('loadingIslandLabel')} />}
          rightSlot={<BootstrapAccountMark />}
        />
      }
    >
      <RouteLoadingIsland standalone path={initialPath} label={t('loadingIslandLabel')} />
    </DriveShell>
  )
}

export function RouteLoadingIsland({
  path,
  label,
  standalone = false,
}: {
  /**
   * The destination being waited for. Omitted only where the caller genuinely
   * has none — see `here` below, which asks the browser rather than guessing.
   */
  path?: string
  label: string
  /**
   * Whether this island reserves the top bar itself. Inside the workspace shell
   * it must not: that shell's content wrapper already begins below the bar, and
   * reserving it twice drops the skeleton a bar's height below the thing it
   * stands for — which is the jump on hydration this island exists to prevent.
   */
  standalone?: boolean
}) {
  /* ---- an unknown path is not the map ----
     This used to default to `''`, which walks out of `loadingViewForPath` as
     `agents-map` — so every wait whose path had not been threaded through drew
     *the ring*, whole, and then replaced it with the destination the reader had
     actually asked for. Measured on a cold load of an agent under an 8× CPU
     throttle: a map island for 400ms, then the agent's page skeleton. Two
     full-screen skeletons for one navigation, and the first was a picture of
     somewhere the reader was not going.

     The server hands this down from a request header, and a client that has
     mounted can simply read the address bar. Neither is a guess; the empty
     string was. */
  const here =
    path ??
    (typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`)
  const pathname = new URL(here, 'https://duet.local').pathname
  const loadingView = loadingViewForPath(here)
  const marketplaceT = useTranslations('duetApp.marketplace')
  if (isWorkLoadingView(loadingView)) {
    return <WorkLoadingIsland view={loadingView} label={label} />
  }
  return (
    <section
      data-bootstrap-island="true"
      /* The skeleton stands where the real thing will: land on the map and the
         island is behind the glass from the first frame, so nothing steps down
         by a bar's height on hydration. */
      className={cn(
        'h-full min-h-0 min-w-0 overflow-hidden bg-background',
        standalone && !isDriveCanvasPath(pathname) && DRIVE_TOPBAR_CLEARANCE,
      )}
    >
      {loadingView === 'agents-map' ? (
        <HomeLoadingIsland label={label} />
      ) : loadingView === 'agent-page' ? (
        /* The agent's page draws its own shape, in its own box. `.km-page` is
           what gives it the frame's gap and the clearance under the window's
           bar, exactly as the real page has it — without it the skeleton stands
           where nothing will, which is the jump this island exists to prevent. */
        /* The section, not the sheet alone. The roster stands on every
           destination under `/agents`, so a skeleton without it is a picture of
           a page that will never exist — and the correction, when identity
           lands, is the whole sheet jumping 22rem to the right. The column's own
           bars are reused rather than approximated, for the same reason this
           block reuses `.km-page`. */
        <AgentsSection roster={<RosterSkeletonColumn />}>
          <div className="km-hues km-page">
            <AgentPageSkeleton label={label} />
          </div>
        </AgentsSection>
      ) : loadingView === 'files' ? (
        <DriveSkeleton label={label} />
      ) : loadingView === 'marketplace' ? (
        <AgentsWorkspaceLoadingFrame view="marketplace" label={marketplaceT('loading')}>
          <MarketplaceAgentsLoadingContent />
        </AgentsWorkspaceLoadingFrame>
      ) : loadingView === 'marketplace-detail' ? (
        <AgentsWorkspaceLoadingFrame view="marketplace-detail" label={marketplaceT('loading')}>
          <MarketplaceAgentsLoadingContent layout="marketplace-detail" />
        </AgentsWorkspaceLoadingFrame>
      ) : loadingView === 'agent-detail' ? (
        <AgentsWorkspaceLoadingFrame view="agent-detail" label={label}>
          <AgentDetailLoadingSkeleton />
        </AgentsWorkspaceLoadingFrame>
      ) : loadingView === 'integrations' ? (
        <IntegrationsLoadingView label={label} />
      ) : (
        <AgentsLoadingIsland label={label} />
      )}
    </section>
  )
}

function BootstrapWorkspaceMark({ brand, label }: { brand: string; label: string }) {
  return (
    <div aria-hidden className="flex h-9 min-w-0 items-center gap-2 px-2">
      <DuetMark active size="xs" />
      <div className="hidden min-w-0 sm:block">
        <span className="block truncate text-xs font-semibold leading-tight">{brand}</span>
        <span className="mt-0.5 block truncate text-[10px] leading-tight text-header-foreground/55">
          {label}
        </span>
      </div>
    </div>
  )
}

function BootstrapAccountMark() {
  return (
    <div aria-hidden className="flex items-center gap-2">
      <Skeleton className="hidden h-6 w-20 rounded-full bg-header-accent/70 motion-reduce:animate-none lg:block" />
      <Skeleton className="size-9 rounded-[28%] bg-header-accent/80 motion-reduce:animate-none" />
    </div>
  )
}

function AgentsLoadingIsland({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex h-full min-h-0 min-w-0 overflow-hidden"
    >
      <aside
        aria-hidden
        className="hidden h-full w-[20rem] shrink-0 border-r border-border/40 bg-sidebar opacity-75 md:flex md:flex-col"
      >
        <div className="flex h-14 shrink-0 items-center border-b border-border/40 px-3">
          <div className="space-y-1.5">
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        </div>
        <div className="space-y-3 p-3">
          <div className="rounded-xl border border-border/60 bg-background p-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8 rounded-[28%]" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-2.5 w-32" />
              </div>
              <Skeleton className="size-8 rounded-md" />
            </div>
            <Skeleton className="mt-3 h-8 w-full rounded-md" />
            <div className="mt-3 space-y-2">
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-5/6 rounded-lg" />
              <Skeleton className="h-9 w-3/4 rounded-lg" />
            </div>
          </div>
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center px-5 pb-[13vh] pt-8 md:pb-[9vh]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-brand/[0.05] via-brand/[0.015] to-transparent"
        />
        <div aria-hidden className="relative w-full max-w-2xl space-y-5">
          <DuetLoadingCue label={label} className="mx-auto" />
          <div className="mx-auto flex w-72 max-w-[75%] flex-col items-center gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-12 h-8 w-28 rounded-lg" />
          </div>
        </div>
      </main>
    </div>
  )
}
