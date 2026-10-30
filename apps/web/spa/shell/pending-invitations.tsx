'use client'

import { EnvelopeSimple } from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { DuetApiError } from '../api/client'
import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { useToast } from './toast'

export function PendingInvitations() {
  const t = useTranslations('duetApp.invitations')
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const [expanded, setExpanded] = useState(false)
  const options = duetQueryOptions.user.invitations(api)
  const invitations = useInfiniteQuery({
    ...options,
    refetchOnWindowFocus: 'always',
    refetchInterval: 60_000,
  })
  const items = invitations.data?.items ?? []
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage: loadNextPage,
  } = invitations

  // A page can contain only invitations whose workspaces have been deleted.
  // Continue to the first visible invitation; never treat an unfinished page as empty.
  useEffect(() => {
    if (items.length === 0 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void loadNextPage()
    }
  }, [items.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, loadNextPage])

  const accept = useMutation({
    mutationFn: async (inviteId: string) => {
      const result = await api.acceptInvitation(inviteId)
      const identity = await api.whoami()
      queryClient.setQueryData(duetQueryOptions.identity(api).queryKey, identity)
      return result
    },
    onSuccess: result => {
      setExpanded(false)
      void queryClient.invalidateQueries({ queryKey: options.queryKey })
      navigate(`/w/${encodeURIComponent(result.workspaceSlug)}`)
    },
    onError: error => {
      const unavailable = error instanceof DuetApiError && error.status === 404
      toast({
        tone: 'error',
        message: t(
          unavailable
            ? 'unavailable'
            : error instanceof DuetApiError && error.status === 409
              ? 'full'
              : 'acceptError',
        ),
      })
      if (unavailable) void queryClient.invalidateQueries({ queryKey: options.queryKey })
    },
  })

  const first = items[0]
  const failed = invitations.isLoadingError || (items.length === 0 && isFetchNextPageError)
  if (first === undefined && !failed) return null
  const buttonClass = cn(buttonVariants({ size: 'sm' }), 'min-h-11 shrink-0 sm:min-h-9')

  return (
    <section
      aria-label={t('title')}
      className="relative z-20 shrink-0 border-b border-brand/20 bg-background text-foreground"
    >
      <div className="flex min-h-12 items-center gap-3 bg-brand/10 px-3 py-2 sm:px-5">
        <EnvelopeSimple size={20} className="hidden shrink-0 text-brand sm:block" aria-hidden />
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-xs text-muted-foreground">
            {failed ? t('loadError') : expanded ? t('title') : t('invitedTo')}
          </p>
          {first === undefined || expanded ? null : (
            <p className="truncate font-semibold" title={first.workspace.name}>
              {first.workspace.name}
            </p>
          )}
        </div>
        {first !== undefined && !expanded ? (
          <button
            type="button"
            className={buttonClass}
            disabled={accept.isPending}
            aria-label={t('acceptNamed', { name: first.workspace.name })}
            onClick={() => accept.mutate(first.id)}
          >
            {accept.isPending ? t('accepting') : t('accept')}
          </button>
        ) : null}
        {failed ? (
          <button type="button" className={buttonClass} onClick={() => void invitations.refetch()}>
            {t('retry')}
          </button>
        ) : items.length > 1 || hasNextPage ? (
          <button
            type="button"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'min-h-11 shrink-0 sm:min-h-9',
            )}
            aria-expanded={expanded}
            aria-controls="incoming-workspace-invitations"
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? t('hide') : t('viewAll')}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div
          id="incoming-workspace-invitations"
          className="max-h-[40dvh] overflow-y-auto border-t border-brand/15 bg-brand/5 px-3 sm:px-5"
        >
          <ul className="divide-y divide-border/60">
            {items.map(invite => (
              <li key={invite.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold">{invite.workspace.name}</p>
                  <p className="break-words text-xs text-muted-foreground">
                    {t('from', {
                      name: invite.inviter?.name ?? invite.inviter?.email ?? t('workspaceOwner'),
                      role: t(invite.role),
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={accept.isPending}
                  aria-label={t('acceptNamed', { name: invite.workspace.name })}
                  onClick={() => accept.mutate(invite.id)}
                >
                  {accept.isPending && accept.variables === invite.id
                    ? t('accepting')
                    : t('accept')}
                </button>
              </li>
            ))}
          </ul>
          {hasNextPage ? (
            <button
              type="button"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'mb-2 min-h-11')}
              disabled={isFetchingNextPage}
              onClick={() => void loadNextPage()}
            >
              {isFetchingNextPage
                ? t('loading')
                : isFetchNextPageError
                  ? t('retry')
                  : t('loadMore')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
