'use client'

import { CaretRight, ListChecks } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'

import { SESSION_ACTIVITY_PRIORITY } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/shadcn/dialog'

import { ACTIVE_POLL_MS, collectionItems, isInitialCollectionError } from '../api/query-options'
import { useSpa } from '../context'
import { workCollectionDraining } from '../team-space/work-collection'
import { defaultChatQueryOptions } from './default-chat'
import { sessionQueryOptions } from './session-data'

export function DefaultChatJobs({
  workspaceSlug,
  agentSlug,
}: {
  workspaceSlug: string
  agentSlug: string
}) {
  const { api } = useSpa()
  const t = useTranslations('duetApp.teamSpace')
  const common = useTranslations('duetSettings')
  const chat = useQuery(defaultChatQueryOptions(api, workspaceSlug, agentSlug))
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(null)
  const open = openedSessionId !== null && openedSessionId === chat.data?.id
  useEffect(() => setOpenedSessionId(null), [workspaceSlug, agentSlug, chat.data?.id])
  const children = useInfiniteQuery({
    ...sessionQueryOptions.children(api, workspaceSlug, chat.data?.id ?? '', {
      archived: 'exclude',
    }),
    enabled: open,
    refetchInterval: open ? ACTIVE_POLL_MS : false,
  })
  const jobs = collectionItems(children.data)
  const draining = workCollectionDraining({
    itemCount: jobs.length,
    hasNextPage: children.hasNextPage,
    pagesRead: children.data?.pages.length ?? 0,
  })
  useEffect(() => {
    if (open && draining && !children.isFetching && !children.isFetchNextPageError) {
      void children.fetchNextPage()
    }
  }, [open, draining, children])

  return (
    <Dialog
      open={open}
      onOpenChange={next => setOpenedSessionId(next ? (chat.data?.id ?? null) : null)}
    >
      {chat.data != null && (
        <DialogTrigger asChild>
          <button type="button" className="km-chat-act" title={t('recentJobs')}>
            <ListChecks aria-hidden size={12} />
            <span>{t('recentJobs')}</span>
          </button>
        </DialogTrigger>
      )}
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('recentJobs')}</DialogTitle>
          <DialogDescription>{t('jobsDescription')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {children.isPending || (draining && !children.isFetchNextPageError) ? (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              {common('loadingMore')}
            </p>
          ) : isInitialCollectionError(children) ? (
            <div role="alert" className="space-y-3 py-6 text-center">
              <p className="text-sm font-medium">{t('jobsErrorTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('jobsErrorBody')}</p>
              <Button variant="outline" onClick={() => void children.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              {jobs.length === 0 && !children.hasNextPage && (
                <div className="py-8 text-center">
                  <p className="text-sm font-medium">{t('jobsEmptyTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('jobsEmptyBody')}</p>
                </div>
              )}
              {SESSION_ACTIVITY_PRIORITY.map(bucket => {
                const rows = jobs.filter(job => job.bucket === bucket)
                if (rows.length === 0) return null
                return (
                  <section key={bucket}>
                    <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                      {t(`jobGroups.${bucket}`)}
                    </h3>
                    <div className="space-y-1">
                      {rows.map(job => (
                        <Link
                          key={job.id}
                          to={`/w/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(job.id)}`}
                          onClick={() => setOpenedSessionId(null)}
                          className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <span className="min-w-0">
                            <span className="block break-words text-sm font-medium">
                              {job.title}
                            </span>
                            {job.agent && (
                              <span className="block text-xs text-muted-foreground">
                                {job.agent.name}
                              </span>
                            )}
                          </span>
                          <CaretRight
                            aria-hidden
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                        </Link>
                      ))}
                    </div>
                  </section>
                )
              })}
              {children.isFetchNextPageError && (
                <p role="alert" className="text-sm text-destructive">
                  {t('jobsErrorTitle')}
                </p>
              )}
              {children.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={children.isFetching}
                  onClick={() => void children.fetchNextPage()}
                >
                  {children.isFetching
                    ? common('loadingMore')
                    : children.isFetchNextPageError
                      ? t('retryMore')
                      : common('loadMore')}
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
