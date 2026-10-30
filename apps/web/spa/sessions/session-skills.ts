'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useCallback, useMemo } from 'react'

import type { WorkspaceSkill, WorkspaceSkillScope } from '@repo/contract'
import type { ComposeBarSkills } from '@repo/ui/components/compose-bar'

import { useCollectionContinuation } from '../api/collection-continuation'
import { duetQueryOptions, isInitialCollectionError } from '../api/query-options'
import { useSpa } from '../context'

/**
 * The `/` picker's list, for the folder a session actually runs in.
 *
 * Fetched when the composer mounts rather than when the picker opens, so the
 * list is there the instant someone types `/`. That is affordable only because
 * the cache is keyed on the folder — every composer pointed at the same agent
 * shares one entry, so a workspace pays one agent-runtime spawn per agent, not
 * one per conversation. Opening the picker still refetches: a skill installed a
 * minute ago should be there the next time the list is actually read.
 *
 * `cwd` is the selected agent's anchor (absent for the default agent, which
 * runs at the drive root), so an agent only offers the skills it can run.
 */
export function useSessionSkills(workspaceSlug: string, cwd: string | undefined): ComposeBarSkills {
  const { api } = useSpa()
  const t = useTranslations('duetApp.sessionProduct')

  const query = useInfiniteQuery(duetQueryOptions.workspaces.skills(api, workspaceSlug, cwd))
  const continuation = useCollectionContinuation(query)
  const { refetch } = query

  const onOpen = useCallback(() => {
    void refetch()
  }, [refetch])

  const scopeLabels = useMemo(
    () =>
      ({
        user: t('skillScopeUser'),
        project: t('skillScopeProject'),
        temporary: t('skillScopeTemporary'),
        builtin: t('skillScopeBuiltin'),
      }) satisfies Record<WorkspaceSkillScope, string>,
    [t],
  )

  const items = useMemo(
    () =>
      (query.data?.items ?? []).map((skill: WorkspaceSkill) => ({
        // The path, not the name: two scopes can offer the same skill name,
        // and the row identity has to survive that.
        id: skill.path,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scopeLabel: skill.scope === undefined ? undefined : scopeLabels[skill.scope],
      })),
    [query.data, scopeLabels],
  )
  const unavailable = isInitialCollectionError(query)

  return useMemo(
    () => ({
      items,
      loading: query.isFetching,
      // A workspace we could not reach is not a workspace without skills. The
      // VM may simply be asleep, and telling someone their skills are gone is a
      // worse answer than saying we could not ask.
      unavailable,
      continuation:
        continuation.available || continuation.loading || continuation.failed
          ? {
              loading: continuation.loading,
              unavailable: continuation.failed,
              onLoadMore: continuation.load,
              labels: {
                loadMore: t('skillsLoadMore'),
                loading: t('skillsLoadingMore'),
                retry: t('skillsLoadMoreRetry'),
              },
            }
          : undefined,
      labels: {
        list: t('skills'),
        loading: t('skillsLoading'),
        empty: t('skillsEmpty'),
        unavailable: t('skillsUnavailable'),
      },
      onOpen,
    }),
    [items, onOpen, continuation, query.isFetching, t, unavailable],
  )
}
