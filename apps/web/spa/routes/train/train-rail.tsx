'use client'

import { ArrowLeftIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { DEFAULT_AGENT_NAME, ROOT_AGENT_SCOPE, type Agent } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../../agents/agent-avatar'
import { agentDisplayName } from '../../agents/agent-display'
import { duetQueryOptions } from '../../api/query-options'
import { ROOT_TRAIN_SCOPE, type TrainScope } from '../../api/train-scope'
import { useSpa } from '../../context'
import type { AgentManagementDestination } from '../../drive/agent-management-route'
import { agentsMapUrl, agentSettingsUrl } from '../../drive/agents-map-url'
import { trainPath } from './train-routes'

// Agent Settings and Train share this control-centre rail. It deliberately is
// not the drive roster: that rail carries chat and app affordances, while this
// one keeps the selected agent stable as the pane on the right changes.

type AgentManagementScope = {
  key: string
  scope: TrainScope
  name: string
  agent?: Agent
}

export function AgentManagementFrame({
  workspaceSlug,
  destination,
  children,
}: {
  workspaceSlug: string
  destination: AgentManagementDestination
  children: ReactNode
}) {
  const t = useTranslations('duetTrain')
  const { api, identity } = useSpa()
  const agents = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const counts = useQuery(duetQueryOptions.workspaces.train.memoryCounts(api, workspaceSlug))
  const duetName =
    identity.workspaces.find(workspace => workspace.slug === workspaceSlug)?.duetName ??
    DEFAULT_AGENT_NAME
  const scopes = trainRailScopes(agents.data?.items ?? [], duetName)

  /* No scroller of its own: the drive shell already owns one, so the rail and
     the surface flow inside it and the whole view scrolls as one page.

     `min-h-full` is what makes the rail reach the bottom of that scroller. It is
     the same floor `WorkspacePage` sets for every other destination, and without
     it this grid is only as tall as whichever column has more rows — so a drive
     with four agents drew a column of furniture that stopped a third of the way
     down the window, with the page's own background under the rest of it. */
  return (
    <section
      data-agent-management-frame
      className="grid min-h-full min-w-0 grid-cols-1 md:grid-cols-[17rem_minmax(0,1fr)]"
    >
      <aside
        data-agent-management-rail
        className="min-w-0 border-b border-border/70 bg-sidebar p-3 md:border-b-0 md:border-r"
      >
        <AgentManagementBack workspaceSlug={workspaceSlug} agentSlug={destination.agentSlug} />
        <nav
          aria-label={t('scopeRail')}
          className="mt-2 flex max-w-full gap-1.5 overflow-x-auto pb-1 md:mt-3 md:block md:space-y-1 md:overflow-visible md:pb-0"
        >
          {scopes.map(entry => (
            <AgentManagementLink
              key={entry.key}
              entry={entry}
              workspaceSlug={workspaceSlug}
              destination={destination}
              pending={agents.isPending}
              count={memoryCountFor(entry.scope, counts)}
            />
          ))}
        </nav>
      </aside>
      <div className="min-h-0 min-w-0">{children}</div>
    </section>
  )
}

// Duet is the drive root, so it leads and is where Train opens.
export function trainRailScopes(
  agents: readonly Agent[],
  duetName: string,
): AgentManagementScope[] {
  return [
    { key: 'root', scope: ROOT_TRAIN_SCOPE, name: duetName },
    ...agents.map(agent => ({
      key: agent.id,
      scope: { kind: 'agent', agentSlug: agent.slug } as const,
      name: agentDisplayName(agent),
      agent,
    })),
  ]
}

/**
 * Out of the control centre, to the agent whose controls were open.
 *
 * A destination rather than `navigate(-1)`, and that is the whole fix: every
 * row of the rail is a real entry, so popping history walked back through the
 * scopes you had already looked at instead of leaving. "Back" that returns you
 * to the same page you are on is worse than no back button at all.
 *
 * Deterministic also means it survives the case the old code had a special
 * branch for — a cold deep link with nothing to pop — without needing one, and
 * it is a `Link`, so it middle-clicks like the door that brought you here.
 */
function AgentManagementBack({
  workspaceSlug,
  agentSlug,
}: {
  workspaceSlug: string
  agentSlug: string
}) {
  const t = useTranslations('duetTrain')

  return (
    <Link
      to={agentsMapUrl(workspaceSlug, {
        kind: 'agent',
        agentSlug,
        card: { kind: 'default' },
      })}
      className="flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
    >
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {t('back')}
    </Link>
  )
}

function AgentManagementLink({
  entry,
  workspaceSlug,
  destination,
  pending,
  count,
}: {
  entry: AgentManagementScope
  workspaceSlug: string
  destination: AgentManagementDestination
  pending: boolean
  count: number | null | undefined
}) {
  const t = useTranslations('duetTrain')
  const isRoot = entry.scope.kind === 'root'
  const entrySlug = entry.scope.kind === 'root' ? ROOT_AGENT_SCOPE : entry.scope.agentSlug
  const active = entrySlug === destination.agentSlug
  const to =
    destination.mode === 'settings'
      ? agentSettingsUrl(workspaceSlug, entrySlug)
      : trainPath(workspaceSlug, entry.scope)

  return (
    <Link
      to={to}
      /* Replace, because picking a scope is choosing which row of this one
         control centre is selected — a lens, not a journey. Pushed, Back had to
         crawl every scope you had glanced at before it could leave. */
      replace
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-11 min-w-[12rem] items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors md:min-h-12 md:min-w-0',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        /* Selected is the neutral wash every sidebar row uses: blue is for
           work in flight and focus, and a blue row reads as a running one. */
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <AgentAvatar
        avatarKey={entry.agent?.slug ?? entry.name}
        duet={entry.scope.kind === 'root'}
        profile={entry.agent}
        workspaceSlug={workspaceSlug}
        className={cn(
          'size-7 shrink-0 rounded-md ring-1',
          active ? 'ring-brand/40' : 'ring-border/70',
        )}
      />
      {/* Leading is tightened so the name and its count read as one block the
          height of the avatar beside them, rather than sprawling past it. */}
      <span className="min-w-0 leading-[1.15]">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate">{entry.name}</span>
          {isRoot ? (
            // Duet is the drive root, so its memories apply everywhere.
            <span className="shrink-0 font-normal text-muted-foreground">{t('globalSuffix')}</span>
          ) : null}
        </span>
        <span className="block truncate text-[11px] tabular-nums text-muted-foreground">
          {pending || count === undefined
            ? t('memoryCountLoading')
            : count === null
              ? t('memoryCountUnavailable')
              : t('memoryCount', { count })}
        </span>
      </span>
    </Link>
  )
}

// `undefined` is "still counting"; `null` is "no count to show" — the query
// failed, or it answered without mentioning this agent. Both must stay
// distinguishable from a real 0: an agent with no memories is a fact, a
// missing count is not.
function memoryCountFor(
  scope: TrainScope,
  counts: {
    isError: boolean
    data?: { rootCount: number | null; counts: Record<string, number | null> }
  },
): number | null | undefined {
  if (scope.kind === 'root') {
    if (counts.isError) return null
    return counts.data?.rootCount
  }
  if (counts.isError) return null
  if (counts.data === undefined) return undefined
  return counts.data.counts[scope.agentSlug] ?? null
}
