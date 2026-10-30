'use client'

/* ============================================================================
   The short session link, and nothing else.

   `/w/:ws/sessions/:sessionId` is not a surface: the product reads every
   conversation on the map, at the owning agent's own address. This shape
   survives for one writer — an agent inside the sandbox holds a session id and
   its workspace slug, and asking it to also resolve which agent owns the child
   before it may emit a link is complexity in the wrong place. So the product
   keeps the simple address and spends
   one read here turning it into the real one.
   ========================================================================= */
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Link, Navigate, useParams } from 'react-router'

import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { RouteLoadingIsland } from '../drive/bootstrap-shell'
import { sessionQueryOptions } from '../sessions/session-data'
import { sessionMapHref } from '../sessions/session-owner'

export default function SessionRedirectRoute() {
  const { workspaceSlug = '', sessionId } = useParams()

  return sessionId === undefined ? (
    <Navigate to={`/w/${encodeURIComponent(workspaceSlug)}/agents`} replace />
  ) : (
    <SessionLinkResolver workspaceSlug={workspaceSlug} sessionId={sessionId} />
  )
}

function SessionLinkResolver({
  workspaceSlug,
  sessionId,
}: {
  workspaceSlug: string
  sessionId: string
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const appT = useTranslations('duetApp')
  const { api } = useSpa()
  const detail = useQuery({
    ...sessionQueryOptions.detail(api, workspaceSlug, sessionId),
    retry: false,
  })
  const agent = useQuery({
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, {
      id: detail.data?.agent?.id ?? '',
    }),
    enabled: detail.data?.agent !== undefined,
  })
  const href =
    detail.data === undefined
      ? undefined
      : sessionMapHref(
          workspaceSlug,
          detail.data,
          agent.data === undefined || agent.data === null ? undefined : [agent.data],
        )

  if (href !== undefined) return <Navigate to={href} replace />
  if (detail.isError || agent.isError) {
    return (
      <section className="flex h-full items-center justify-center bg-background p-8 text-center">
        <div className="max-w-sm">
          <h1 className="font-serif text-xl font-normal italic tracking-tight">
            {t('unavailableTitle')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('unavailableBody')}</p>
          <Link
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')}
            to={`/w/${encodeURIComponent(workspaceSlug)}/agents`}
          >
            {t('back')}
          </Link>
        </div>
      </section>
    )
  }
  /* The map's own frame, not a conversation skeleton: this route never shows
     a conversation — it lands on the map, so it waits in the map's clothes. */
  return (
    <RouteLoadingIsland
      path={`/w/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}`}
      label={appT('loadingIslandLabel')}
    />
  )
}
