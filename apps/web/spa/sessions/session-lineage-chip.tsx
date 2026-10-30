'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Link } from 'react-router'

import { cn } from '@repo/ui/lib/utils'

import { DuetApiError } from '../api/client'
import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { defaultChatQueryOptions } from './default-chat'
import { findCachedSessionSummary } from './session-cache'
import { sessionQueryOptions } from './session-data'
import { sessionLineageChip, shortIdLabel } from './session-lineage'
import { sessionOwnerSlug } from './session-owner'

export function SessionLineageChip({
  workspaceSlug,
  parentId,
}: {
  workspaceSlug: string
  parentId: string
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const cached = findCachedSessionSummary(queryClient, workspaceSlug, parentId)
  const parent = useQuery({
    ...sessionQueryOptions.detail(api, workspaceSlug, parentId),
    enabled: cached === undefined,
    retry: false,
  })
  const summary = cached ?? parent.data
  /* The parent's owner may live on any roster page. Resolve its exact id
     through the public point filter instead of treating page one as an
     identity oracle. */
  const ownerAgent = useQuery({
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, {
      id: summary?.agent?.id ?? '',
    }),
    enabled: summary?.agent !== undefined,
  })
  const ownerSlug =
    summary === undefined
      ? undefined
      : sessionOwnerSlug(
          summary.agent,
          ownerAgent.data === undefined || ownerAgent.data === null ? undefined : [ownerAgent.data],
        )
  /* The parent's owner may not be the agent whose page this is — a subagent's
     parent is its parent's — so the alias is asked for by that owner's slug.
     The same entry `preloadAgentPages` warms for every agent on the drive, so
     on the surfaces this chip appears on it is a cache read. */
  const ownerChat = useQuery({
    ...defaultChatQueryOptions(api, workspaceSlug, ownerSlug ?? ''),
    enabled: ownerSlug !== undefined,
  })
  const deleted =
    cached === undefined && parent.error instanceof DuetApiError && parent.error.status === 404
  const chip = sessionLineageChip({
    workspaceSlug,
    parentId,
    parent: summary,
    ...(ownerSlug === undefined ? {} : { ownerSlug }),
    ...(ownerChat.data == null ? {} : { chatId: ownerChat.data.id }),
    deleted,
  })
  const parentLabel = deleted ? t('deletedParent', { parent: shortIdLabel(parentId) }) : chip.label
  const className = cn(
    'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4',
    deleted
      ? 'border-border/60 bg-muted/40 text-muted-foreground'
      : 'border-brand/20 bg-brand/[0.06] text-brand hover:bg-brand/[0.1]',
  )
  const content = t('startedBy', { parent: parentLabel })

  return chip.href === undefined ? (
    <span data-session-lineage={deleted ? 'deleted' : 'unresolved'} className={className}>
      {content}
    </span>
  ) : (
    <Link data-session-lineage="linked" to={chip.href} className={className}>
      <span className="truncate">{content}</span>
    </Link>
  )
}
