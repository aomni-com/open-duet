'use client'

import { ArrowLeft, ListChecks } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'

import { DEFAULT_AGENT_NAME, ROOT_AGENT_SCOPE, type SessionBucket } from '@repo/contract'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@repo/ui/components/shadcn/sheet'
import { cn } from '@repo/ui/lib/utils'

import { isInitialCollectionError, isInitialQueryError } from '../api/query-options'
import { useSpa } from '../context'
import {
  DEFAULT_SESSION_TIER,
  SessionsAccessDenied,
  SessionsProduct,
  useCanUseSessions,
} from '../routes/sessions'
import { defaultChatQueryOptions } from '../sessions/default-chat'
import { SessionAudienceManager } from '../sessions/session-audience-manager'
import { sessionQueryOptions } from '../sessions/session-data'
import { SessionLifecycleMenu, SessionTitleControl } from '../sessions/session-lifecycle-controls'
import { sessionOwnerSlug } from '../sessions/session-owner'
import { projectWorkConversationRows, workCollectionPhase } from './work-collection'
import {
  isOwnedTopLevelWorkConversation,
  workHomeUrl,
  workRouteDestination,
  workSessionUrl,
} from './work-destination'
import { useWorkSpace } from './work-frame'
import { WorkJobRow } from './work-job-row'
import { WorkLoadingIsland, WorkSessionBodyLoading } from './work-loading'
import { WorkSessionHeading } from './work-session-heading'

const GROUPS: readonly SessionBucket[] = ['asking', 'running', 'scheduled', 'done']

export default function WorkConversation() {
  const { workspaceSlug = '' } = useParams()
  const { api } = useSpa()
  const {
    workspace,
    agents,
    loading: rosterLoading,
    ownershipReady,
    retry: retryWorkspace,
  } = useWorkSpace()
  const navigate = useNavigate()
  const location = useLocation()
  const destination = workRouteDestination(location.pathname, workspaceSlug, location.search)
  const agentSlug = destination.kind === 'session' ? destination.agentSlug : ROOT_AGENT_SCOPE
  const sessionId = destination.kind === 'session' ? destination.sessionId : ''
  const reduceMotion = useReducedMotion()
  const t = useTranslations('duetApp.teamSpace')
  /* The reader's own answer about the panel, and `undefined` until they give
     one. Everything else about it is derived, which is the point: the panel is
     showing when the reader arrives — the work this conversation delegated is
     part of reading it, not a thing to go looking for — and it is showing
     because the viewport is wide enough to hold a column beside the
     conversation, not because a `useState` was seeded once and left to drift.

     Seeding it was the bug. The same flag drives a modal sheet below `lg`, so
     a `true` written on a wide viewport and never re-read followed a reader
     who narrowed their window and arrived as a focus trap over the
     conversation they were reading — nobody asked for it, and the "once, never
     re-asserted" guard that stopped the default *reopening* a closed panel
     could not stop the stale value crossing the breakpoint. Derived, the
     default simply follows the viewport, and only an answer the reader
     actually gave outlives it. A reader who opened the panel and then narrows
     does get the sheet: that one is theirs. */
  const [jobsChoice, setJobsChoice] = useState<boolean | undefined>(undefined)
  const [desktop, setDesktop] = useState(false)
  const canUseSessions = useCanUseSessions(workspaceSlug)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const jobsOpen = jobsChoice ?? desktop
  const detail = useQuery({
    ...sessionQueryOptions.detail(api, workspaceSlug, sessionId),
    enabled: canUseSessions,
  })
  const parentSessionId = detail.data?.createdBySessionId
  /* Whether this conversation has a delegated-work panel at all.

     A conversation that was itself delegated does not: the query below is
     disabled for one, and the header carries no toggle for one. Those two were
     already written; the panel itself was not, and a surface whose contents can
     never load and whose control does not exist still drew — 19rem of pulsing
     skeletons beside a job, with nothing to close it with. One fact, asked
     once, and every piece of the panel reads it.

     Withheld until the read lands, because until then "no parent" and "no
     parent *yet*" are the same `undefined` — and a default that fires on the
     second one opens the panel on a job. */
  const hasJobsPanel = detail.data !== undefined && parentSessionId === undefined
  const parent = useQuery({
    ...sessionQueryOptions.detail(api, workspaceSlug, parentSessionId ?? ''),
    enabled: canUseSessions && parentSessionId !== undefined,
  })
  const claimedOwner =
    agentSlug === ROOT_AGENT_SCOPE ? undefined : agents.find(agent => agent.slug === agentSlug)
  const claimedOwnerReady =
    agentSlug === ROOT_AGENT_SCOPE || (ownershipReady && claimedOwner !== undefined)
  const ownerDefault = useQuery({
    ...defaultChatQueryOptions(api, workspaceSlug, agentSlug),
    enabled: canUseSessions && claimedOwnerReady,
  })
  const children = useInfiniteQuery({
    ...sessionQueryOptions.children(api, workspaceSlug, sessionId, { archived: 'exclude' }, 24),
    enabled: canUseSessions && hasJobsPanel,
  })
  /* Every conversation this one spawned, whatever it is running. The panel used
     to draw only the children carrying a `machine`, which made an ordinary
     delegated conversation invisible in the one place it is reachable from —
     the rail excludes it as a child, so a machineless child appeared nowhere at
     all. With nothing filtered client-side these rows are exactly what the
     query returns, which is the same shape the Work rail has and the same
     projection it uses. */
  const jobProjection = useMemo(
    () => projectWorkConversationRows(children.data?.pages ?? [], 24),
    [children.data],
  )
  const jobs = jobProjection.items
  const jobsPhase = workCollectionPhase({
    pending: children.isPending,
    initialError: isInitialCollectionError(children),
    continuationError: children.isFetchNextPageError,
    itemCount: jobs.length,
    draining: jobProjection.fetchNext,
  })
  /* A page the server emptied is not an empty panel — read past it. Bounded by
     the projection's own request budget, so this settles rather than chasing a
     long tail of rows this reader cannot see, and held off a failed
     continuation, which would otherwise retry itself forever. */
  useEffect(() => {
    if (!jobProjection.fetchNext || children.isFetching || children.isFetchNextPageError) return
    void children.fetchNextPage()
  }, [jobProjection.fetchNext, children])
  const grouped = useMemo(
    () =>
      GROUPS.map(bucket => ({
        bucket,
        jobs: jobs.filter(job => job.bucket === bucket),
      })).filter(group => group.jobs.length > 0),
    [jobs],
  )
  const parentUrl =
    parentSessionId === undefined
      ? workHomeUrl(workspaceSlug)
      : `/w/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(parentSessionId)}`
  const exit = () => navigate(parentUrl, { replace: true })

  if (!canUseSessions) return <SessionsAccessDenied />

  const ownerMatches =
    detail.data === undefined ||
    (agentSlug === ROOT_AGENT_SCOPE
      ? detail.data.agent === undefined
      : !ownershipReady || detail.data.agent?.id === claimedOwner?.id)
  const topLevelIsWorkConversation =
    detail.data !== undefined &&
    isOwnedTopLevelWorkConversation(detail.data, claimedOwner?.id, ownerDefault.data?.id)
  const validWorkShape =
    parentSessionId !== undefined ||
    (!isInitialQueryError(ownerDefault) && topLevelIsWorkConversation)
  const classificationPending =
    detail.isPending ||
    (parentSessionId === undefined && claimedOwnerReady && ownerDefault.isPending) ||
    (agentSlug !== ROOT_AGENT_SCOPE && rosterLoading)
  if (classificationPending) {
    return (
      <WorkLoadingIsland
        view="work-session"
        label={t('openingConversation')}
        sessionAsking={detail.data?.bucket === 'asking'}
      />
    )
  }
  if (detail.data !== undefined && ownerMatches && ownerDefault.data?.id === sessionId) {
    return <Navigate to={workHomeUrl(workspaceSlug, agentSlug)} replace />
  }
  if (detail.data === undefined || !ownerMatches || !validWorkShape) {
    const retryClassification =
      detail.isLoadingError ||
      ownerDefault.isLoadingError ||
      (agentSlug !== ROOT_AGENT_SCOPE && !ownershipReady)
    return (
      /* The handle belongs to the *route*, not to the success path: a reader who
         followed a link to a conversation this surface cannot show is still
         looking at that conversation's address, and a test scoping to it should
         find the refusal rather than nothing at all. Without this, every spec
         that asks "what does this conversation say when the read fails" scoped
         to an element the failure branch had quietly stopped rendering, and
         asked its question of an empty locator. */
      <div data-work-session={sessionId} className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-sm">
          {/* Two different facts, and they were wearing one sentence.

              A read that failed is not a link that names nothing: the
              conversation is there, this fetch of it did not arrive, and the
              honest offer is to try the read again. Telling that reader the
              conversation is unavailable — that its address may have changed or
              that it may no longer be part of this workspace — is the product
              inventing a cause it has no evidence for, about a session it may
              well hold. The retry/back-home split below already knew which of
              the two this was; only the words did not. */}
          <h1 className="text-base font-semibold">
            {t(
              retryClassification ? 'conversationLoadFailedTitle' : 'conversationUnavailableTitle',
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(retryClassification ? 'conversationLoadFailedBody' : 'conversationUnavailableBody')}
          </p>
          <button
            type="button"
            onClick={() => {
              if (!retryClassification) {
                navigate(workHomeUrl(workspaceSlug), { replace: true })
                return
              }
              void detail.refetch()
              if (claimedOwnerReady) void ownerDefault.refetch()
              if (parentSessionId !== undefined) void parent.refetch()
              if (agentSlug !== ROOT_AGENT_SCOPE) retryWorkspace()
            }}
            className="mt-4 min-h-11 rounded-md border px-3 text-sm font-medium"
          >
            {retryClassification ? t('retry') : t('backHome')}
          </button>
        </div>
      </div>
    )
  }

  const jobRailBody = (
    <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
      {jobsPhase === 'pending' ? (
        <div role="status" aria-label={t('openingConversation')} className="space-y-3 px-2 py-3">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="size-2 animate-pulse rounded-full bg-muted-foreground/20 motion-reduce:animate-none" />
              <span className="h-9 flex-1 animate-pulse rounded-lg bg-muted/55 motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      ) : jobsPhase === 'initial-error' ? (
        <div className="px-3 py-8 text-center">
          <p className="text-sm font-medium">{t('jobsErrorTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('jobsErrorBody')}</p>
          <button
            type="button"
            onClick={() => void children.refetch()}
            className="mt-3 min-h-11 rounded-md border bg-background px-3 text-xs font-medium shadow-sm"
          >
            {t('retry')}
          </button>
        </div>
      ) : jobsPhase === 'continuation-error' ? (
        <div className="px-3 py-8 text-center">
          <p className="text-sm font-medium">{t('jobsErrorTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('jobsErrorBody')}</p>
          <button
            type="button"
            onClick={() => void children.fetchNextPage()}
            className="mt-3 min-h-11 rounded-md border bg-background px-3 text-xs font-medium shadow-sm"
          >
            {t('retryMore')}
          </button>
        </div>
      ) : jobsPhase === 'empty' ? (
        <div className="px-3 py-8 text-center">
          <p className="text-sm font-medium">{t('jobsEmptyTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('jobsEmptyBody')}</p>
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map(group => (
            <section key={group.bucket}>
              <h3 className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground/75">
                {t(`jobGroups.${group.bucket}`)}
              </h3>
              <div className="space-y-1">
                {group.jobs.map(job => {
                  const ownerSlug = sessionOwnerSlug(job.agent, agents)
                  const jobUrl =
                    ownerSlug === undefined
                      ? undefined
                      : workSessionUrl(workspaceSlug, ownerSlug, job.id)
                  return (
                    <WorkJobRow
                      key={job.id}
                      job={job}
                      ownerName={job.agent?.name ?? workspace.duetName ?? DEFAULT_AGENT_NAME}
                      unreadLabel={t('unread')}
                      onOpen={jobUrl === undefined ? undefined : () => navigate(jobUrl)}
                    />
                  )
                })}
              </div>
            </section>
          ))}
          {jobProjection.truncated ? (
            children.isFetchNextPageError ? (
              <button
                type="button"
                onClick={() => void children.fetchNextPage()}
                className="px-2 text-[11px] font-medium text-foreground underline underline-offset-4"
              >
                {t('retryMore')}
              </button>
            ) : (
              <p className="px-2 text-[11px] leading-4 text-muted-foreground">{t('olderJobs')}</p>
            )
          ) : null}
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-background [&_[data-message-inline-image]>img]:max-h-36 lg:[&_[data-message-inline-image]>img]:max-h-96">
      {/* The handle a test reaches one conversation by. Build's jobs dialog used
          to be that handle — `getByRole('dialog')` scoped every query to the
          session under review, because the surface behind it kept a second one
          mounted. Work has the same problem and no dialog: the rail beside this
          lists other conversations and the delegated-work panel lists more. So
          the surface says which node it is, the way the drive's rows and panes
          already do. */}
      <section data-work-session={sessionId} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
          <button
            type="button"
            onClick={() => navigate(parentUrl)}
            aria-label={parentSessionId === undefined ? t('backHome') : t('backConversation')}
            className={cn(
              'size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              parentSessionId === undefined ? 'grid lg:hidden' : 'grid',
            )}
          >
            <ArrowLeft size={18} />
          </button>
          <WorkSessionHeading
            className="flex-1"
            title={
              detail.data?.title ??
              (detail.isPending ? t('openingConversation') : t('conversation'))
            }
            /* Renaming is the conversation's own control, and this header is the
               one place that names it. It arrived here when Build's jobs dialog
               was deleted: that band held the only rename in the product, and a
               conversation nobody can name is one nobody can find again.
               Withheld until the read lands — there is no title to edit yet —
               and withheld for a child, whose name belongs to the run that
               spawned it rather than to whoever is reading it. */
            {...(detail.data === undefined || parentSessionId !== undefined
              ? {}
              : {
                  titleControl: (
                    <SessionTitleControl
                      workspaceSlug={workspaceSlug}
                      sessionId={sessionId}
                      title={detail.data.title}
                    />
                  ),
                })}
            source={
              parentSessionId === undefined
                ? undefined
                : parent.data?.title === undefined
                  ? t('jobFromConversation')
                  : t('jobFrom', { title: parent.data.title })
            }
          />
          {detail.data === undefined || parentSessionId !== undefined ? null : (
            <>
              <SessionAudienceManager
                workspaceSlug={workspaceSlug}
                snapshot={detail.data}
                onPutAway={exit}
              />
              {/* Archive and delete, beside the audience the same conversation
                  answers for. `exit` is what both mean when they succeed: the
                  list this header came from no longer holds the row. */}
              <SessionLifecycleMenu
                workspaceSlug={workspaceSlug}
                sessionId={sessionId}
                onPutAway={exit}
              />
            </>
          )}
          {hasJobsPanel ? (
            <button
              type="button"
              onClick={() => setJobsChoice(choice => !(choice ?? desktop))}
              aria-expanded={jobsOpen}
              aria-label={t('recentJobs')}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium shadow-sm transition-[background-color,color,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none',
                /* Open is a neutral wash: blue is for work in flight and
                   focus, and a toggle painted blue reads as something running. */
                jobsOpen ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              <ListChecks size={15} />
              <span className="hidden sm:inline">{t('recentJobs')}</span>
            </button>
          ) : null}
        </header>

        <SessionsProduct
          workspaceSlug={workspaceSlug}
          sessionId={sessionId}
          agentSlug={agentSlug}
          duetName={workspace.duetName ?? DEFAULT_AGENT_NAME}
          defaultTier={workspace.defaultTier.effective ?? DEFAULT_SESSION_TIER}
          routes={{ exit: () => parentUrl }}
          creditRecovery={workspace.creditRecovery}
          /* Every conversation here, not only a delegated child. This surface's
             subject is one conversation and it has the width, which are the two
             things the permission is about — the narrower reading was a
             leftover from when Build's jobs dialog held the other half. */
          pane
          loadingFallback={
            <WorkSessionBodyLoading
              asking={detail.data.bucket === 'asking'}
              label={t('openingConversation')}
            />
          }
        />
      </section>

      <AnimatePresence initial={false}>
        {jobsOpen && desktop && hasJobsPanel ? (
          <motion.aside
            aria-label={t('recentJobs')}
            initial={reduceMotion ? false : { x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex min-h-0 w-[19rem] flex-col border-l border-border/70 bg-sidebar"
          >
            <header className="flex h-12 shrink-0 items-center border-b border-border/70 px-3">
              <h2 className="text-sm font-semibold">{t('recentJobs')}</h2>
            </header>
            {jobRailBody}
          </motion.aside>
        ) : null}
      </AnimatePresence>
      {!desktop && hasJobsPanel ? (
        <Sheet open={jobsOpen} onOpenChange={setJobsChoice}>
          <SheetContent
            side="right"
            className="flex w-full max-w-none flex-col gap-0 p-0 sm:max-w-none [&>button]:right-1.5 [&>button]:top-1.5 [&>button]:size-11"
          >
            <SheetHeader className="flex h-14 shrink-0 justify-center border-b px-4 text-left">
              <SheetTitle className="text-sm">{t('recentJobs')}</SheetTitle>
              <SheetDescription className="sr-only">{t('jobsDescription')}</SheetDescription>
            </SheetHeader>
            {jobRailBody}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}
