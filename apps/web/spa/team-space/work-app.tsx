'use client'

import { ArrowLeft } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useLocation, useNavigate, useParams } from 'react-router'

import { agentIsLocked, ROOT_AGENT_SCOPE } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryOptions } from '../api/query-options'
import { useAppActions } from '../apps/app-actions'
import { AppFrameBody } from '../apps/app-frame'
import { AppIcon, appDisplayName } from '../apps/app-icon'
import { useSpa } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import { appDisplayStatus } from '../status/entity-status'
import { workHomeUrl, workRouteDestination } from './work-destination'
import { useWorkSpace } from './work-frame'
import { WorkLoadingIsland } from './work-loading'
import { projectWorkApps } from './work-projection'

export default function WorkApp() {
  const { workspaceSlug = '' } = useParams()
  const { api } = useSpa()
  const { agents, loading: rosterLoading, ownershipReady, retry: retryWorkspace } = useWorkSpace()
  const navigate = useNavigate()
  const location = useLocation()
  const destination = workRouteDestination(location.pathname, workspaceSlug, location.search)
  const agentSlug = destination.kind === 'app' ? destination.agentSlug : ROOT_AGENT_SCOPE
  const appSlug = destination.kind === 'app' ? destination.appSlug : ''
  const t = useTranslations('duetApp.teamSpace')
  const query = useQuery(duetQueryOptions.workspaces.app(api, workspaceSlug, appSlug))
  const app = query.data?.app
  const displayStatus = app === undefined ? undefined : appDisplayStatus(app)
  const claimedOwner =
    agentSlug === ROOT_AGENT_SCOPE ? undefined : agents.find(agent => agent.slug === agentSlug)
  const config = useQuery({
    ...agentConfigQueryOptions(
      api,
      workspaceSlug,
      claimedOwner ?? { id: `unresolved:${agentSlug}`, anchorPath: '' },
    ),
    enabled: claimedOwner !== undefined,
  })
  const actualOwnerSlug =
    app === undefined ? undefined : projectWorkApps(agents, [app])[0]?.ownerSlug
  const ownerMatches = app === undefined || (ownershipReady && actualOwnerSlug === agentSlug)
  const ownerLocked =
    claimedOwner !== undefined &&
    config.data !== undefined &&
    agentIsLocked(claimedOwner, config.data)
  const ownerDependenciesReady =
    agentSlug === ROOT_AGENT_SCOPE ||
    (ownershipReady && claimedOwner !== undefined && config.data !== undefined && !ownerLocked)
  const pending =
    query.isPending || rosterLoading || (claimedOwner !== undefined && config.isPending)
  const appActions = useAppActions(workspaceSlug, {
    onDeleted: () => navigate(workHomeUrl(workspaceSlug), { replace: true }),
  })

  if (pending) return <WorkLoadingIsland view="work-app" label={t('openingAppLabel')} />

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
        <button
          type="button"
          onClick={() => navigate(workHomeUrl(workspaceSlug))}
          aria-label={t('backHome')}
          className="grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        >
          <ArrowLeft size={18} />
        </button>
        {app === undefined ? null : (
          <AppIcon
            app={app}
            status={appDisplayStatus(app)}
            workspaceSlug={workspaceSlug}
            className="size-6"
          />
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {app === undefined ? t('openingApp') : appDisplayName(app)}
        </h1>
        {app === undefined ||
        displayStatus === undefined ||
        !ownerMatches ||
        !ownerDependenciesReady ? null : (
          <>
            <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[10px] font-semibold capitalize text-muted-foreground">
              {t(`appStatus.${displayStatus}`)}
            </span>
            {appActions.menuFor(app)}
          </>
        )}
      </header>
      {app === undefined || !ownerMatches || !ownerDependenciesReady ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <div>
            <h2 className="text-base font-semibold">{t('appUnavailableTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('appUnavailableBody')}</p>
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')}
              onClick={() => {
                retryWorkspace()
                void query.refetch()
                if (claimedOwner !== undefined) void config.refetch()
              }}
            >
              {t('retry')}
            </button>
          </div>
        </div>
      ) : (
        <AppFrameBody app={app} workspaceSlug={workspaceSlug} />
      )}
      {appActions.dialogs}
    </div>
  )
}
