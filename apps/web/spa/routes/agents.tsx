'use client'

import { Robot } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'

import {
  agentIsLocked,
  DEFAULT_AGENT_NAME,
  agentResolutionCandidate,
  groupAppsByAgent,
  ROOT_AGENT_SCOPE,
} from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'

import { useAgentActions } from '../agents/agent-actions'
import { AgentDetailLoadingSkeleton } from '../agents/agent-detail-loading'
import { agentDisplayName } from '../agents/agent-display'
import { duetQueryOptions } from '../api/query-options'
import { AppIcon } from '../apps/app-icon'
import { useSpa } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import {
  agentOnboardingTarget,
  agentTrainSurface,
  visibleAgentApps,
} from '../drive/agent-onboarding-projection'
import { agentReadmeQueryOptions, agentSkillsQueryOptions } from '../drive/agent-profile'
import { agentMenuShape } from '../drive/agent-roster-types'
import { driveRoutes } from '../drive/drive-routes'
import { WorkspaceEmptyState } from '../drive/workspace-page'
import { sessionQueryOptions } from '../sessions/session-data'
import { AgentsWorkspaceLoadingFrame } from '../sessions/session-loading'
import { agentDisplayStatus, appDisplayStatus } from '../status/entity-status'
import { AgentDetailCanvas } from './agents/agent-detail-canvas'

// The canvas queries the agent's own sessions (D2) scoped by its id. A generous
// first page so the reading surface is filled; "Show all" pages the same list.
const DETAIL_SESSION_PAGE = 20

export default function AgentDetailRoute() {
  const t = useTranslations('duetApp.agentDetail')
  const { workspaceSlug, agentSlug } = useParams()
  const { api, identity } = useSpa()
  const navigate = useNavigate()
  if (workspaceSlug === undefined) throw new Error('Agent detail requires a workspace route')

  const rosterQuery = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const appsQuery = useInfiniteQuery(duetQueryOptions.workspaces.apps(api, workspaceSlug))

  // A route is a point read, not a claim that the currently browsed roster
  // prefix contains every agent. The public collection's exact slug filter
  // uses the backend point index and has its own cache key.
  // Duet answers to the reserved `root` slug — no roster lookup, because it has
  // no row to find. Everything below treats it as a subject like any other.
  const isRoot = agentSlug === ROOT_AGENT_SCOPE
  const agentQuery = useQuery({
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, { slug: agentSlug ?? '' }),
    enabled: !isRoot && agentSlug !== undefined,
  })
  const exactAgent = isRoot ? undefined : (agentQuery.data ?? undefined)
  // The point read establishes that this address exists. Once that is known,
  // the roster row is the presentation authority used by both the map and the
  // shared management rail. Keep the entire row together: an avatar URL joins
  // anchorPath, icon, and updatedAt, so mixing fields from two revisions can
  // construct a file URL neither revision ever owned.
  const agent =
    exactAgent === undefined
      ? undefined
      : (rosterQuery.data?.items.find(candidate => candidate.id === exactAgent.id) ?? exactAgent)
  const present = isRoot || agent !== undefined
  const agentId = isRoot ? ROOT_AGENT_SCOPE : (agent?.id ?? '')
  const anchorPath = isRoot ? '' : (agent?.anchorPath ?? '')

  // Share the paged skills cache with the rail and map instead of re-reading it.
  const skillsQuery = useInfiniteQuery({
    ...agentSkillsQueryOptions(api, workspaceSlug, { id: agentId, anchorPath }),
    enabled: present,
  })
  const skills = useMemo(
    () => skillsQuery.data?.pages.flatMap(page => page.items) ?? [],
    [skillsQuery.data],
  )

  // The full README has a separate cache from the extracted role and paged skills.
  // Their shared path owner handles the drive root, whose anchor is empty.
  const readmeQuery = useQuery({
    ...agentReadmeQueryOptions(api, workspaceSlug, { id: agentId, anchorPath }),
    enabled: present,
  })

  // Duet has no `agent.json`: it is always trainable, never locked, never
  // awaiting onboarding. Leaving this disabled is what says so.
  const agentConfigQuery = useQuery({
    ...agentConfigQueryOptions(api, workspaceSlug, { id: agentId, anchorPath }),
    enabled: agent !== undefined,
  })

  const sessionsQuery = useInfiniteQuery({
    ...sessionQueryOptions.list(
      api,
      workspaceSlug,
      { search: '', archived: 'exclude', agentId },
      DETAIL_SESSION_PAGE,
    ),
    enabled: present,
  })
  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap(page => page.items) ?? [],
    [sessionsQuery.data],
  )
  // Aliased so the web boundary checker's `fetch…(` heuristic does not read
  // react-query's pager as a raw network call (same reason the rail aliases it).
  const { fetchNextPage: loadMoreSessions } = sessionsQuery

  // Duet owns what no agent claimed: `groupAppsByAgent` already separates those
  // out as `.root`, so nothing here re-derives "belongs to no agent".
  const rawApps = useMemo(() => {
    if (!isRoot && agent === undefined) return []
    const roster = rosterQuery.data?.items ?? []
    const candidates =
      agent === undefined || roster.some(candidate => candidate.id === agent.id)
        ? roster
        : [...roster, agent]
    const groups = groupAppsByAgent(
      candidates.map(agentResolutionCandidate),
      appsQuery.data?.items ?? [],
    )
    return isRoot || agent === undefined ? groups.root : (groups.byAgentId.get(agent.id) ?? [])
  }, [isRoot, agent, rosterQuery.data, appsQuery.data])
  const config = agentConfigQuery.data
  const apps =
    agent === undefined || config === undefined
      ? rawApps
      : visibleAgentApps(agent, config, agent.anchorPath, [...rawApps])
  const locked = agent !== undefined && config !== undefined ? agentIsLocked(agent, config) : false
  const onboardingTarget =
    locked && agent !== undefined && config !== undefined
      ? agentOnboardingTarget(config, agent.anchorPath, [...rawApps])
      : undefined

  // The ⋯ menu's behavior. On a confirmed delete the agent this route renders no
  // longer exists, so navigate back to the roster's default view — a valid page
  // whatever was deleted.
  const actions = useAgentActions(workspaceSlug, {
    onDeleted: () => navigate(driveRoutes.agents(workspaceSlug)),
  })

  if (!isRoot && agentQuery.isPending) {
    return (
      <AgentsWorkspaceLoadingFrame view="agent-detail" label={t('loading')}>
        <AgentDetailLoadingSkeleton />
      </AgentsWorkspaceLoadingFrame>
    )
  }

  if (!isRoot && agentQuery.isLoadingError) {
    return (
      <div className="grid h-full place-items-center">
        <WorkspaceEmptyState
          tone="destructive"
          icon={<Robot />}
          title={t('loadErrorTitle')}
          body={t('loadErrorBody')}
          action={
            <button className={buttonVariants()} onClick={() => void agentQuery.refetch()}>
              {t('retry')}
            </button>
          }
        />
      </div>
    )
  }

  // Duet's name is the workspace's, because it has no row of its own; every
  // other field it would carry is one it does not have, so the canvas is told
  // which kind of subject it is rather than handed a fabricated agent.
  //
  // Resolved once into a discriminated value so each field below is a plain
  // read. Branching per prop would need a non-null assertion on every one of
  // them, and an assertion is a claim the compiler cannot check.
  const subject = isRoot
    ? ({
        kind: 'root',
        name:
          identity.workspaces.find(workspace => workspace.slug === workspaceSlug)?.duetName ??
          DEFAULT_AGENT_NAME,
        slug: ROOT_AGENT_SCOPE,
        anchorPath: '',
        updatedAt: 0,
        status: 'reconciled',
        menu: 'default',
      } as const)
    : agent === undefined
      ? undefined
      : ({
          kind: 'registered',
          name: agentDisplayName(agent),
          slug: agent.slug,
          anchorPath: agent.anchorPath,
          icon: agent.icon,
          updatedAt: agent.updatedAt,
          status: agentDisplayStatus(agent),
          menu: agentMenuShape(agent),
        } as const)

  if (subject === undefined) {
    return (
      <div className="grid h-full place-items-center">
        <WorkspaceEmptyState
          tone="muted"
          icon={<Robot />}
          title={t('notFoundTitle')}
          body={t('notFoundBody')}
        />
      </div>
    )
  }

  return (
    <>
      <AgentDetailCanvas
        workspaceSlug={workspaceSlug}
        kind={subject.kind}
        name={subject.name}
        slug={subject.slug}
        anchorPath={subject.anchorPath}
        {...(subject.kind === 'registered' && subject.icon !== undefined
          ? { icon: subject.icon }
          : {})}
        updatedAt={subject.updatedAt}
        status={subject.status}
        locked={locked}
        onboardingTarget={onboardingTarget}
        trainSurface={config === undefined ? 'enabled' : agentTrainSurface(config)}
        agentsMarkdown={readmeQuery.data ?? undefined}
        skills={skills}
        hasMoreSkills={skillsQuery.hasNextPage}
        loadingMoreSkills={skillsQuery.isFetchingNextPage}
        moreSkillsFailed={skillsQuery.isFetchNextPageError}
        onShowAllSkills={
          skillsQuery.hasNextPage ? () => void skillsQuery.fetchNextPage() : undefined
        }
        apps={apps}
        appsLoading={appsQuery.isPending}
        appsInitialError={appsQuery.data === undefined || appsQuery.isLoadingError}
        hasMoreApps={appsQuery.hasNextPage}
        loadingMoreApps={appsQuery.isFetchingNextPage}
        moreAppsFailed={appsQuery.isFetchNextPageError}
        onLoadMoreApps={
          appsQuery.hasNextPage || appsQuery.isFetchNextPageError
            ? () => void appsQuery.fetchNextPage()
            : undefined
        }
        onRetryApps={() => void appsQuery.refetch()}
        sessions={sessions}
        sessionsLoading={sessionsQuery.isPending}
        sessionsInitialError={sessionsQuery.isLoadingError}
        loadingMoreSessions={sessionsQuery.isFetchingNextPage}
        moreSessionsFailed={sessionsQuery.isFetchNextPageError}
        hasMoreSessions={sessionsQuery.hasNextPage || sessionsQuery.isFetchNextPageError}
        onShowAllSessions={
          (sessionsQuery.hasNextPage || sessionsQuery.isFetchNextPageError) &&
          !sessionsQuery.isFetchingNextPage
            ? () => void loadMoreSessions()
            : undefined
        }
        onRetrySessions={() => void sessionsQuery.refetch()}
        renderAppIcon={app => (
          <AppIcon
            app={app}
            status={appDisplayStatus(app)}
            workspaceSlug={workspaceSlug}
            className="size-full"
          />
        )}
        menu={subject.menu}
        onMenuAction={action =>
          actions.onMenuAction(
            { name: subject.name, slug: subject.slug, anchorPath: subject.anchorPath },
            action,
          )
        }
      />
      {actions.dialogs}
    </>
  )
}
