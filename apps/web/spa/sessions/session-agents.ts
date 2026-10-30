'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useCallback, useMemo } from 'react'

import type { AgentRelationship, AgentRosterWireRow } from '@repo/contract'
import type { ComposeBarAgent, ComposeBarAgents } from '@repo/ui/components/compose-bar'

import { useCollectionContinuation } from '../api/collection-continuation'
import { duetQueryOptions, isInitialCollectionError } from '../api/query-options'
import { useSpa } from '../context'

/** One badge per relationship, so no row's standing is left to be inferred. */
export type AgentRosterLabels = Record<AgentRelationship, string> & { awaitingSetup: string }

/**
 * The roster as picker rows, in the order the gateway sent them.
 *
 * Deliberately no sorting, no filtering, no relationship of its own and no lock
 * recomputation: the gateway owns all four, and deriving any of them here would
 * make the picker disagree with the roster the agent is reading in its own
 * prompt. The slug rides in `description` because two colleagues may share a
 * display name and the slug is the only thing that tells them apart.
 */
export function agentRosterRows(
  roster: readonly AgentRosterWireRow[],
  labels: AgentRosterLabels,
): readonly ComposeBarAgent[] {
  return roster.map(row => ({
    id: row.slug,
    name: row.name,
    slug: row.slug,
    path: row.path,
    description: row.slug,
    scopeLabel: labels[row.relationship],
    // Listed but not selectable: an agent that has not finished onboarding
    // would bounce the work back, and hiding it would read as "no such
    // colleague" rather than "not yet".
    ...(row.locked ? { disabled: true, disabledLabel: labels.awaitingSetup } : {}),
  }))
}

/**
 * The `@` picker's list, for the agent a session belongs to.
 *
 * `agentSlug` is the address — `root` for the drive root — never a cwd or an
 * agentId, because the slug is what every agent-facing API takes.
 */
export function useSessionAgents(workspaceSlug: string, agentSlug: string): ComposeBarAgents {
  const { api } = useSpa()
  const t = useTranslations('duetApp.sessionProduct')

  const query = useInfiniteQuery(
    duetQueryOptions.workspaces.agentRoster(api, workspaceSlug, agentSlug),
  )
  const continuation = useCollectionContinuation(query)
  const { refetch } = query

  const onOpen = useCallback(() => {
    void refetch()
  }, [refetch])

  const rowLabels = useMemo(
    () => ({
      self: t('agentSelfLabel'),
      parent: t('agentParentLabel'),
      sibling: t('agentSiblingLabel'),
      child: t('agentChildLabel'),
      awaitingSetup: t('agentAwaitingSetup'),
    }),
    [t],
  )

  const items = useMemo(
    () => agentRosterRows(query.data?.items ?? [], rowLabels),
    [query.data, rowLabels],
  )

  const unavailable = isInitialCollectionError(query)

  return useMemo(
    () => ({
      items,
      loading: query.isFetching,
      // A roster we could not read is not a workspace without agents. The VM
      // may be asleep or not yet synced, and telling someone their colleagues
      // are gone is a worse answer than saying we could not ask.
      unavailable,
      continuation:
        continuation.available || continuation.loading || continuation.failed
          ? {
              loading: continuation.loading,
              unavailable: continuation.failed,
              onLoadMore: continuation.load,
              labels: {
                loadMore: t('agentsLoadMore'),
                loading: t('agentsLoadingMore'),
                retry: t('agentsLoadMoreRetry'),
              },
            }
          : undefined,
      labels: {
        list: t('agents'),
        loading: t('agentsLoading'),
        empty: t('agentsEmpty'),
        unavailable: t('agentsUnavailable'),
      },
      onOpen,
    }),
    [items, onOpen, continuation, query.isFetching, t, unavailable],
  )
}
