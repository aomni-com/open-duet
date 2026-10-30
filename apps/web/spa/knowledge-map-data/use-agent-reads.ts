'use client'

/* ============================================================================
   What one agent keeps and what it knows, read when you go inside it.

   The ring draws neither, so neither is fetched until a face is opened — and
   then for exactly one agent. That is the whole reason home costs three
   requests instead of sixteen.

   ---- a list and where the list came from, together ----
   Everything here comes back as a `Read`: the rows *and* the phase the query is
   in. That pairing is the point. An agent with no files and an agent whose
   folder listing has not landed yet both hand back an empty array, and a
   surface that is given only the array draws the same confident "0 files" for
   both. This module refuses to let a caller make that mistake by never handing
   over rows on their own.
   ========================================================================= */
import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { duetQueryKeys } from '../api/query-keys'
import { collectionPagesQueryOptions, isInitialCollectionError } from '../api/query-options'
import { useSpa, type SpaApi } from '../context'
import { agentSkillsQueryOptions } from '../drive/agent-profile'
import type { FileItem, Skill } from '../knowledge-map/types'
import { toMapFile, toMapSkill, visibleFiles, type MapCopy } from './project'
import type { Phase } from './use-workspace-map'

/**
 * Rows, and where they came from.
 *
 * `items` is only ever the truth while `phase` is `'ready'`. On the other two
 * it is empty because there is nothing to show yet — not because there is
 * nothing there.
 */
export type Read<T> = {
  phase: Phase
  items: readonly T[]
  hasMore?: boolean
  loadingMore?: boolean
  moreFailed?: boolean
  onLoadMore?: () => void
}

/* Two reads and not three. The drive's connections used to be the third, warmed
   here on the theory that somebody inside an agent is about to ask what it can
   reach. Nothing on the surface draws them any more — a connection belongs to
   the drive rather than to one agent, so every agent was showing the same list —
   and a read whose only remaining job is warming a page reached from the drive
   nav is a request charged on every zoom for a page this one does not lead to. */
export type AgentReads = {
  skills: Read<Skill>
  files: Read<FileItem>
}

/**
 * One level of an agent's own folder.
 *
 * The drive route reads folders through an imperative provider rather than
 * react-query, so there is no cached "files under this path" to reuse. This is
 * the smallest possible addition: the same `listWorkspaceFiles` call the drive
 * makes, behind a key a surface can share across re-renders.
 *
 * Held for as long as a profile is: a folder you looked at a minute ago has not
 * changed under you, and coming back to an agent should be instant.
 */
const FILES_STALE_TIME_MS = 5 * 60_000

export function agentFilesQueryOptions(
  api: Pick<SpaApi, 'listWorkspaceFiles'>,
  workspaceSlug: string,
  anchorPath: string,
) {
  return collectionPagesQueryOptions({
    queryKey: [...duetQueryKeys.workspaces.scope(workspaceSlug), 'map-files', anchorPath] as const,
    queryFn: request => api.listWorkspaceFiles(workspaceSlug, anchorPath, request),
    staleTime: FILES_STALE_TIME_MS,
    retry: false,
  })
}

/** Whose folder to read. `null` is nobody, which reads nothing. */
export type ReadTarget = { id: string; anchorPath: string }

/**
 * The reads the agent surface is made of, for the one agent that is open.
 *
 * `target` is `null` when nothing is open, which disables the queries rather
 * than omitting them — hooks cannot be conditional, and a disabled query still
 * serves whatever is already in the cache.
 *
 * The skills key is the agent's own, the same one `agent-profile.ts` gives the
 * detail canvas, so opening an agent here warms the page you might open next.
 * Duet's anchor is `''`: Duet is the drive, so its files are the drive's own
 * top level and its skills are the drive's own.
 */
export function useAgentReads(
  workspaceSlug: string,
  target: ReadTarget | null,
  now: number,
  copy: MapCopy,
): AgentReads {
  const { api } = useSpa()
  const enabled = target !== null
  const read = target ?? { id: 'none', anchorPath: '' }

  const filesQuery = useInfiniteQuery({
    ...agentFilesQueryOptions(api, workspaceSlug, read.anchorPath),
    enabled,
  })
  const skillsQuery = useInfiniteQuery({
    ...agentSkillsQueryOptions(api, workspaceSlug, read),
    enabled,
  })

  const filesPhase = isInitialCollectionError(filesQuery)
    ? 'error'
    : filesQuery.isPending
      ? 'pending'
      : 'ready'
  const skillsPhase = isInitialCollectionError(skillsQuery)
    ? 'error'
    : skillsQuery.isPending
      ? 'pending'
      : 'ready'
  const entries = filesQuery.data?.pages.flatMap(page => page.items)
  const names = skillsQuery.data?.pages.flatMap(page => page.items)

  return useMemo(
    () => ({
      files: {
        phase: filesPhase,
        items: entries === undefined ? [] : visibleFiles(entries).map(e => toMapFile(e, now, copy)),
        hasMore: filesQuery.hasNextPage,
        loadingMore: filesQuery.isFetchingNextPage,
        moreFailed: filesQuery.isFetchNextPageError,
        onLoadMore:
          filesQuery.hasNextPage || filesQuery.isFetchNextPageError
            ? () => void filesQuery.fetchNextPage()
            : undefined,
      },
      skills: {
        phase: skillsPhase,
        items: (names ?? []).map(toMapSkill),
        hasMore: skillsQuery.hasNextPage,
        loadingMore: skillsQuery.isFetchingNextPage,
        moreFailed: skillsQuery.isFetchNextPageError,
        onLoadMore:
          skillsQuery.hasNextPage || skillsQuery.isFetchNextPageError
            ? () => void skillsQuery.fetchNextPage()
            : undefined,
      },
    }),
    [copy, entries, filesPhase, filesQuery, names, now, skillsPhase, skillsQuery],
  )
}
