'use client'

import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { DESKTOP_SCREEN } from '@repo/contract'

import { DuetApiError } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import { useSpa, type SpaApi } from '../context'
import { workspaceRefusalCopyKey } from '../workspace-refusal'
import { DesktopPane } from './desktop-pane'

const STATUS_POLL_MS = 2_000
export function desktopSessionQueryOptions(
  api: Pick<SpaApi, 'mintDesktopSession'>,
  workspaceSlug: string,
  embedOrigin: string,
) {
  return {
    queryKey: duetQueryKeys.workspaces.desktop.session(workspaceSlug),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.mintDesktopSession(workspaceSlug, embedOrigin, signal),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: (failureCount: number, error: unknown) =>
      failureCount < 1 && error instanceof DuetApiError && error.status === 401,
    // A startup burst can briefly use the browser session being rotated by a
    // neighboring request. Give that replacement cookie a brief settling window.
    retryDelay: 250,
    refetchInterval: false as const,
    refetchOnMount: 'always' as const,
    refetchOnReconnect: 'always' as const,
    refetchOnWindowFocus: false,
  }
}

export function desktopFocusRequestId(pageId: string, routeKey: string, agentSlug: string): string {
  return `desktop-focus:${pageId}:${routeKey}:${agentSlug}`
}

export function WorkspaceDesktop({
  workspaceSlug,
  agentSlug,
  focusRequestId,
}: {
  workspaceSlug: string
  agentSlug?: string
  focusRequestId?: string
}) {
  const { api } = useSpa()
  const embedOrigin = typeof window === 'undefined' ? '' : window.location.origin
  const enabled = workspaceSlug.length > 0 && embedOrigin.length > 0
  const session = useQuery({
    ...desktopSessionQueryOptions(api, workspaceSlug, embedOrigin),
    enabled,
  })
  const status = useQuery({
    queryKey: duetQueryKeys.workspaces.desktop.status(workspaceSlug),
    queryFn: ({ signal }) => api.readDesktopStatus(workspaceSlug, signal),
    enabled,
    refetchInterval: STATUS_POLL_MS,
  })
  const { mutate: focusOwner } = useMutation({
    mutationFn: ({ slug, requestId }: { slug: string; requestId: string }) =>
      api.focusDesktopOwner(workspaceSlug, slug, requestId),
  })
  const submittedFocusRequest = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (
      agentSlug === undefined ||
      !shouldSubmitDesktopFocus(submittedFocusRequest.current, focusRequestId)
    ) {
      return
    }
    submittedFocusRequest.current = focusRequestId
    focusOwner({ slug: agentSlug, requestId: focusRequestId })
  }, [agentSlug, focusOwner, focusRequestId])

  const activeSession = session.data
  const phase = status.data?.phase ?? activeSession?.phase ?? 'starting'

  return (
    <DesktopPane
      phase={phase}
      entryUrl={activeSession?.entryUrl ?? null}
      owners={status.data?.owners ?? []}
      screen={activeSession?.screen ?? DESKTOP_SCREEN}
      refusal={workspaceRefusalCopyKey(status.error ?? session.error) ?? undefined}
    />
  )
}

export function shouldSubmitDesktopFocus(
  previousRequestId: string | undefined,
  requestId: string | undefined,
): requestId is string {
  return requestId !== undefined && requestId !== previousRequestId
}
