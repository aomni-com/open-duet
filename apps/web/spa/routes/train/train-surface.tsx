'use client'

import {
  ArrowsClockwiseIcon,
  BrainIcon,
  CaretRightIcon,
  FileTextIcon,
  GearIcon,
  LinkIcon,
  PlusIcon,
  SpinnerGapIcon,
  UploadSimpleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import {
  MAX_TRAIN_FILES,
  MAX_TRAIN_URLS,
  TRAIN_UPLOADS_CAP_BYTES,
  urlToUploadFilename,
  type Agent,
  type TrainUploadEntry,
  type TrainJobStatus,
  type TrainRecordSummary,
  ROOT_AGENT_SCOPE,
} from '@repo/contract'
import { Button, buttonVariants } from '@repo/ui/components/shadcn/button'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../../agents/agent-avatar'
import { agentDisplayName } from '../../agents/agent-display'
import { duetQueryKeys } from '../../api/query-keys'
import {
  duetQueryOptions,
  invalidateAfterTrainCompletion,
  isInitialCollectionError,
} from '../../api/query-options'
import type { TrainScope } from '../../api/train-scope'
import { type UploadRequest, VmUploadError } from '../../api/vm-uploads'
import { useWorkspaceCacheScope } from '../../api/workspace-cache-scope'
import { useSpa } from '../../context'
import { agentSettingsUrl } from '../../drive/agents-map-url'
import { WorkspacePanel } from '../../drive/workspace-page'
import { formatBytes } from '../../format'
import { useToast } from '../../shell/toast'
import { retrainTargetFromSearch, trainPathWithoutRetrain, trainRecordPath } from './train-routes'
import { formatTrainDate, TrainInlineRetry } from './train-shared'
import { normalizeTrainSourceUrl } from './train-source-url'
import { countActiveUrlAttempts, dismissUrlAttempt } from './train-url-attempt'

const formatBytesBinary = (bytes: number) => formatBytes(bytes, 1024)

export const activeJobsPolling = {
  refetchInterval: (query: {
    state: {
      data?: {
        pages?: Array<{ items: TrainJobStatus[] }>
        items?: TrainJobStatus[]
        jobs?: TrainJobStatus[]
      }
    }
  }) =>
    (
      query.state.data?.pages?.flatMap(page => page.items) ??
      query.state.data?.items ??
      query.state.data?.jobs ??
      []
    ).some(job => job.state === 'queued' || job.state === 'running')
      ? 5_000
      : false,
}

type FileTransfer = {
  file: File
  progress: number
  status: 'queued' | 'uploading' | 'cancelled' | 'failed'
  error?: 'quota' | 'upload'
  request?: UploadRequest
}

type UrlAttempt = {
  url: string
  status: 'pending' | 'failed'
  detail?: string
  request?: AbortController
}

type TrainUploadsView = {
  files: TrainUploadEntry[]
  totalBytes: number
  fileCount?: number
  capBytes: number
  running: boolean
}

export function TrainSurface({
  scope,
  readOnly,
  agentName,
  agents,
}: {
  scope: TrainScope
  readOnly: boolean
  agentName?: string
  // The agents the route has already resolved (the scoped one). Inherited
  // memories name their owners, and any owner not here is looked up by slug.
  agents: Agent[]
}) {
  const t = useTranslations('duetTrain')
  const showToast = useToast()
  const { api, trainUploads, activeWorkspaceSlug } = useSpa()
  const workspaceSlug = activeWorkspaceSlug ?? ''
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  // The retrain target is a URL parameter rather than click state, because
  // "Retry training" is this page's Train button relabeled after a failure —
  // see train-routes.ts. It therefore also outlives success, which is why the
  // banner is persistent and why completion clears it.
  const retrainTarget = retrainTargetFromSearch(searchParams)
  // Stable so the job-completion effect can depend on it without re-running on
  // every render.
  const clearRetrainTarget = useCallback(() => {
    navigate(trainPathWithoutRetrain(workspaceSlug, scope, searchParams), { replace: true })
  }, [navigate, scope, searchParams, workspaceSlug])
  const queryClient = useQueryClient()
  const cacheScope = useWorkspaceCacheScope(workspaceSlug)
  const [urlDraft, setUrlDraft] = useState('')
  const [urlError, setUrlError] = useState<string>()
  const [fileError, setFileError] = useState<string>()
  const [transfers, setTransfers] = useState<Record<string, FileTransfer>>({})
  const transfersRef = useRef<Record<string, FileTransfer>>({})
  const uploadQueue = useRef<string[]>([])
  const activeUploads = useRef(0)
  const [urlAttempts, setUrlAttempts] = useState<UrlAttempt[]>([])
  const dismissedUrlRequests = useRef(new WeakSet<AbortController>())
  const [restoredSources, setRestoredSources] = useState(false)
  const observedUploadsWorkspace = useRef<string | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement>(null)
  const jobsOptions = duetQueryOptions.workspaces.train.jobPages(api, workspaceSlug, scope)
  const recordsOptions = duetQueryOptions.workspaces.train.recordList(api, workspaceSlug, scope)
  const jobsKey = jobsOptions.queryKey
  const uploadsKey = duetQueryKeys.workspaces.train.uploads(workspaceSlug, scope)

  const uploads = useInfiniteQuery({
    queryKey: uploadsKey,
    queryFn: ({ pageParam, signal }) =>
      trainUploads.list(
        workspaceSlug,
        scope,
        pageParam === undefined ? {} : { cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: workspaceSlug.length > 0 && !readOnly,
    refetchOnMount: 'always',
  })
  const uploadsView = useMemo<TrainUploadsView>(() => {
    const uploadMeta = uploads.data?.pages[0]?.meta
    return {
      files: uploads.data?.pages.flatMap(page => page.items) ?? [],
      totalBytes: uploadMeta?.totalBytes ?? 0,
      fileCount: uploadMeta?.fileCount ?? 0,
      capBytes: uploadMeta?.capBytes ?? TRAIN_UPLOADS_CAP_BYTES,
      running: uploadMeta?.running ?? false,
    }
  }, [uploads.data])
  useEffect(() => {
    if (
      !uploads.isFetchedAfterMount ||
      uploads.data === undefined ||
      observedUploadsWorkspace.current === workspaceSlug
    )
      return
    observedUploadsWorkspace.current = workspaceSlug
    setRestoredSources(uploadsView.files.length > 0 && !uploadsView.running)
  }, [
    uploads.data,
    uploads.isFetchedAfterMount,
    uploadsView.files.length,
    uploadsView.running,
    workspaceSlug,
  ])

  const jobs = useInfiniteQuery({
    ...jobsOptions,
    enabled: workspaceSlug.length > 0,
    ...activeJobsPolling,
  })
  const jobItems = useMemo(() => jobs.data?.pages.flatMap(page => page.items) ?? [], [jobs.data])
  const records = useInfiniteQuery({
    ...recordsOptions,
    enabled: workspaceSlug.length > 0,
  })
  const newestJob = jobItems.reduce<TrainJobStatus | undefined>(
    (newest, job) => (newest === undefined || job.createdAt > newest.createdAt ? job : newest),
    undefined,
  )
  const lastJobFailed = newestJob?.state === 'failed'
  const observedJobs = useRef<{
    workspaceSlug: string
    states?: ReadonlyMap<string, TrainJobStatus['state']>
  }>({ workspaceSlug })
  useEffect(() => {
    if (observedJobs.current.workspaceSlug !== workspaceSlug) {
      observedJobs.current = { workspaceSlug }
    }
    const observation = observeJobCompletions(observedJobs.current.states, jobItems)
    observedJobs.current.states = observation.states
    if (observation.completedJobIds.length === 0) return
    observation.completedJobIds.forEach(() => showToast(t('trainingComplete')))
    invalidateAfterTrainCompletion(queryClient, workspaceSlug, scope)
    // The job this target belonged to is over. Leaving the parameter set would
    // let a later visit to the same URL silently replace the memory again.
    if (retrainTarget !== undefined) clearRetrainTarget()
  }, [clearRetrainTarget, jobItems, queryClient, retrainTarget, scope, showToast, t, workspaceSlug])
  const start = useMutation({
    mutationFn: () =>
      api.startTraining(
        workspaceSlug,
        retrainTarget === undefined ? {} : { targetSlug: retrainTarget },
        scope,
      ),
    onSuccess: () => {
      if (!cacheScope.isActive()) return
      void queryClient.invalidateQueries({ queryKey: jobsKey })
      void queryClient.invalidateQueries({ queryKey: uploadsKey })
    },
  })

  const addUrl = () => {
    try {
      const normalized = normalizeTrainSourceUrl(urlDraft)
      if (
        uploadsView.files.some(file => file.url === normalized) ||
        urlAttempts.some(attempt => attempt.url === normalized)
      ) {
        setUrlError(t('duplicateUrl'))
        return
      }
      const urlCount =
        uploadsView.files.filter(file => file.url !== undefined).length +
        countActiveUrlAttempts(urlAttempts)
      if (urlCount >= MAX_TRAIN_URLS) {
        setUrlError(t('urlLimit', { count: MAX_TRAIN_URLS }))
        return
      }
      setUrlDraft('')
      setUrlError(undefined)
      const request = new AbortController()
      setUrlAttempts(current => [...current, { url: normalized, status: 'pending', request }])
      void trainUploads
        .addUrl(workspaceSlug, scope, normalized, request.signal)
        .then(async entry => {
          if (dismissedUrlRequests.current.has(request)) {
            await trainUploads.remove(workspaceSlug, scope, entry.filename).catch(() => undefined)
            return
          }
          await uploads.refetch()
          setUrlAttempts(current =>
            current.filter(attempt => attempt.request !== request && attempt.url !== normalized),
          )
        })
        .catch(async (error: unknown) => {
          if (request.signal.aborted) {
            await trainUploads
              .remove(workspaceSlug, scope, urlToUploadFilename(normalized))
              .catch(() => undefined)
            setUrlAttempts(current => current.filter(attempt => attempt.request !== request))
            return
          }
          setUrlAttempts(current =>
            current.map(attempt =>
              attempt.request === request
                ? {
                    ...attempt,
                    status: 'failed',
                    detail: sourceFetchDetail(error),
                  }
                : attempt,
            ),
          )
        })
    } catch {
      setUrlError(t('invalidUrl'))
    }
  }

  const updateTransfers = (next: Record<string, FileTransfer>) => {
    transfersRef.current = next
    setTransfers(next)
  }

  const pumpUploads = () => {
    while (activeUploads.current < 2) {
      const filename = uploadQueue.current.shift()
      if (filename === undefined) return
      const transfer = transfersRef.current[filename]
      if (transfer?.status !== 'queued') continue
      activeUploads.current += 1
      const request = trainUploads.upload(workspaceSlug, scope, transfer.file, progress => {
        const current = transfersRef.current[filename]
        if (!current || current.file !== transfer.file || current.status !== 'uploading') return
        updateTransfers({
          ...transfersRef.current,
          [filename]: { ...current, progress },
        })
      })
      updateTransfers({
        ...transfersRef.current,
        [filename]: { ...transfer, status: 'uploading', request },
      })
      void request.done
        .then(async () => {
          await uploads.refetch()
          if (transfersRef.current[filename]?.file !== transfer.file) return
          const next = { ...transfersRef.current }
          delete next[filename]
          updateTransfers(next)
        })
        .catch((error: unknown) => {
          const current = transfersRef.current[filename]
          if (!current || current.file !== transfer.file) return
          updateTransfers({
            ...transfersRef.current,
            [filename]: {
              ...current,
              status:
                error instanceof DOMException && error.name === 'AbortError'
                  ? 'cancelled'
                  : 'failed',
              error: error instanceof VmUploadError && error.status === 413 ? 'quota' : 'upload',
              request: undefined,
            },
          })
        })
        .finally(() => {
          activeUploads.current -= 1
          pumpUploads()
        })
    }
  }

  const addFiles = (incoming: FileList | null) => {
    if (incoming === null) return
    const plan = planFileSelection({
      staged: uploadsView,
      transfers: transfersRef.current,
      queue: uploadQueue.current,
      files: Array.from(incoming),
    })
    for (const request of plan.abort) request.abort()
    uploadQueue.current = plan.queue
    updateTransfers(plan.transfers)
    // Quota rejections already render on their own chip; only the file-count
    // limit (which produces no chip) gets a message, beneath the picker.
    setFileError(plan.error === 'limit' ? t('fileLimit', { count: MAX_TRAIN_FILES }) : undefined)
    pumpUploads()
    if (fileInput.current) fileInput.current.value = ''
  }
  const cancelUpload = (filename: string) => {
    const transfer = transfersRef.current[filename]
    if (!transfer) return
    uploadQueue.current = uploadQueue.current.filter(name => name !== filename)
    transfer.request?.abort()
    updateTransfers({
      ...transfersRef.current,
      [filename]: { ...transfer, status: 'cancelled', request: undefined },
    })
  }
  const removeSource = (filename: string) => {
    void trainUploads.remove(workspaceSlug, scope, filename).then(() => uploads.refetch())
  }
  const hasPending =
    Object.values(transfers).some(
      transfer => transfer.status === 'queued' || transfer.status === 'uploading',
    ) || urlAttempts.some(attempt => attempt.status === 'pending')
  const canStart = uploadsView.files.length > 0 && !hasPending && !start.isPending
  const allRecords = records.data?.items ?? []
  const ownedRecords =
    scope.kind === 'root' ? allRecords : allRecords.filter(record => record.inherited !== true)
  const inheritedRecords =
    scope.kind === 'agent' ? allRecords.filter(record => record.inherited === true) : []
  /* The agents an inherited memory names. The route resolves only the agent it
     is scoped to, so each ancestor that owns an inherited memory is looked up
     by its own slug — a handful at most, one per generation — rather than
     paging the whole roster to name them. Unresolved, a row falls back to the
     owner's slug, so a lookup still in flight reads as the slug, not a gap. */
  const ownerSlugs = [
    ...new Set(
      inheritedRecords.flatMap(record =>
        record.ownerAgentSlug === undefined ||
        agents.some(agent => agent.slug === record.ownerAgentSlug)
          ? []
          : [record.ownerAgentSlug],
      ),
    ),
  ]
  const ownerLookups = useQueries({
    queries: ownerSlugs.map(slug =>
      duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, { slug }),
    ),
  })
  const inheritedOwners = [
    ...agents,
    ...ownerLookups.flatMap(lookup => (lookup.data ? [lookup.data] : [])),
  ]
  // The roster rail is the scope picker now, so this column carries only what
  // the selected scope owns — no agent directory duplicating the rail.
  const recordsColumn = (
    <div className="min-w-0 space-y-4">
      <TrainRecordsCard
        scope={scope}
        readOnly={readOnly}
        records={ownedRecords}
        loading={records.isPending}
        error={isInitialCollectionError(records) ? 'request_failed' : undefined}
        incomplete={records.hasNextPage || records.isFetchNextPageError}
        onRetry={() => void records.refetch()}
      />
      {scope.kind === 'agent' ? (
        <InheritedMemoriesCard
          workspaceSlug={workspaceSlug}
          agents={inheritedOwners}
          records={inheritedRecords}
          incomplete={records.hasNextPage || records.isFetchNextPageError}
        />
      ) : null}
      {records.hasNextPage || records.isFetchNextPageError ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={records.isFetchingNextPage}
            onClick={() => void records.fetchNextPage()}
          >
            {records.isFetchingNextPage
              ? t('loadingMore')
              : records.isFetchNextPageError
                ? t('loadMoreError')
                : t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )

  return (
    <main data-train-control-center className="min-w-0 bg-background">
      <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-4 px-4 pb-16 pt-5 sm:px-6 sm:pt-6 xl:gap-5 xl:px-8">
        <TrainScopeHeader
          scope={scope}
          agentName={agentName}
          agents={agents}
          workspaceSlug={workspaceSlug}
          readOnly={readOnly}
          actions={
            <>
              <Link
                to={agentSettingsUrl(
                  workspaceSlug,
                  scope.kind === 'root' ? ROOT_AGENT_SCOPE : scope.agentSlug,
                )}
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-11 gap-1.5 px-3 shadow-xs sm:h-9',
                )}
              >
                <GearIcon className="size-4" aria-hidden="true" />
                {t('settings')}
              </Link>
              <Button
                aria-label={t('refresh')}
                variant="outline"
                onClick={() => {
                  void jobs.refetch()
                  void records.refetch()
                  // The rail's cards own the count query; refresh invalidates it
                  // for them rather than holding a copy here.
                  void queryClient.invalidateQueries({
                    queryKey: duetQueryKeys.workspaces.train.records.memoryCounts(workspaceSlug),
                  })
                }}
                className="size-11 px-0 shadow-xs sm:h-9 sm:w-auto sm:px-3"
              >
                <ArrowsClockwiseIcon className="size-4" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">{t('refresh')}</span>
              </Button>
            </>
          }
        />

        {/* The rail already costs 20rem, so the two columns only earn their
            keep from xl up; below that they stack into one readable column. */}
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,.9fr)]">
          {readOnly ? (
            <div id="train-memory-library" className="min-w-0 xl:col-start-2 xl:row-start-1">
              {recordsColumn}
            </div>
          ) : null}

          <section
            aria-label={t('trainingTools')}
            className={cn('relative min-w-0', readOnly && 'xl:col-start-1 xl:row-start-1')}
          >
            <div className="space-y-4">
              {retrainTarget === undefined ? null : (
                <RetrainBanner target={retrainTarget} onCancel={clearRetrainTarget} />
              )}
              {readOnly ? (
                <WorkspacePanel className="bg-muted/20 p-4 sm:p-5">
                  <p className="text-sm font-semibold">{t('replicaReadOnlyTitle')}</p>
                </WorkspacePanel>
              ) : (
                <>
                  <TrainSourceCard
                    scope={scope}
                    urlDraft={urlDraft}
                    uploads={uploadsView}
                    uploadsLoading={uploads.isPending}
                    uploadsInitialError={uploads.isLoadingError}
                    uploadsRefreshFailed={uploads.isRefetchError && !uploads.isFetchNextPageError}
                    uploadsHasMore={uploads.hasNextPage || uploads.isFetchNextPageError}
                    uploadsPageFailed={uploads.isFetchNextPageError}
                    uploadsLoadingMore={uploads.isFetchingNextPage}
                    restored={restoredSources}
                    lastJobFailed={lastJobFailed}
                    transfers={Object.values(transfers)}
                    urlAttempts={urlAttempts}
                    urlError={urlError}
                    fileError={fileError}
                    pending={start.isPending}
                    startError={start.isError}
                    canStart={canStart}
                    onUrlDraft={value => {
                      setUrlDraft(value)
                      setUrlError(undefined)
                    }}
                    onAddUrl={addUrl}
                    onDismissUrl={url =>
                      setUrlAttempts(current =>
                        dismissUrlAttempt(current, url, dismissedUrlRequests.current),
                      )
                    }
                    onChooseFiles={() => fileInput.current?.click()}
                    onCancelUpload={cancelUpload}
                    onRemoveSource={removeSource}
                    onLoadMore={() => void uploads.fetchNextPage()}
                    onRetryUploads={() => void uploads.refetch()}
                    onStart={() => start.mutate()}
                  />
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={event => addFiles(event.currentTarget.files)}
                  />
                </>
              )}
              <TrainJobsCard
                scope={scope}
                jobs={jobItems}
                loading={jobs.isPending}
                error={isInitialCollectionError(jobs)}
                hasMore={jobs.hasNextPage || jobs.isFetchNextPageError}
                pageFailed={jobs.isFetchNextPageError}
                loadingMore={jobs.isFetchingNextPage}
                onLoadMore={() => void jobs.fetchNextPage()}
                onRetry={() => void jobs.refetch()}
              />
            </div>
          </section>

          {readOnly ? null : (
            <aside id="train-memory-library" aria-label={t('memoryLibrary')} className="min-w-0">
              {recordsColumn}
            </aside>
          )}
        </div>
      </div>
    </main>
  )
}

/**
 * Names the memory a training run is about to replace.
 *
 * Persistent for as long as the parameter is set, and never a dialog: the word
 * "replace" is the whole warning, including for the manual edits a retrain
 * overwrites. It exists because the target outlives its job — without a
 * visible, cancellable marker, returning to this URL later would quietly
 * overwrite a memory the user had stopped thinking about.
 */
export function RetrainBanner({ target, onCancel }: { target: string; onCancel(): void }) {
  const t = useTranslations('duetTrain')
  return (
    <WorkspacePanel className="border-brand/35 bg-brand/5 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ArrowsClockwiseIcon className="size-4 shrink-0 text-brand" aria-hidden="true" />
            {t('retrainBannerTitle', { name: target })}
          </p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('retrainBannerHelp')}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className={cn(buttonVariants({ variant: 'ghost' }), 'shrink-0')}
        >
          {t('retrainCancel')}
        </button>
      </div>
    </WorkspacePanel>
  )
}

// Train's own hero. The scope's avatar is the mark — the same identity the rail
// shows — so the page and the rail agree at a glance, and the brain rides with
// the product noun instead of standing in for the scope.
function TrainScopeHeader({
  scope,
  agentName,
  agents,
  workspaceSlug,
  readOnly,
  actions,
}: {
  scope: TrainScope
  agentName?: string
  agents: Agent[]
  workspaceSlug: string
  readOnly: boolean
  actions: ReactNode
}) {
  const t = useTranslations('duetTrain')
  const isRoot = scope.kind === 'root'
  const agent = isRoot ? undefined : agents.find(candidate => candidate.slug === scope.agentSlug)
  const name = isRoot ? t('globalMemory') : t('agentTitle', { agent: agentName ?? scope.agentSlug })
  // Only descriptions that say something the title cannot: what "global" reaches,
  // and why a shared agent's controls are missing.
  const description = isRoot
    ? t('globalDescription')
    : readOnly
      ? t('agentReadOnlyDescription')
      : undefined

  return (
    <header className="relative flex flex-col gap-4 pr-12 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:pr-0">
      <div className="flex min-w-0 items-center gap-3.5">
        <AgentAvatar
          avatarKey={agent?.slug ?? (isRoot ? t('globalMemory') : (scope.agentSlug ?? ''))}
          duet={isRoot}
          profile={agent}
          workspaceSlug={workspaceSlug}
          priority={isRoot}
          className="size-11 shrink-0 rounded-xl ring-1 ring-border/70"
        />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-brand">
            <BrainIcon className="size-3.5" weight="duotone" aria-hidden="true" />
            {t('title')}
          </p>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{name}</h1>
          {description === undefined ? null : (
            <p className="mt-1 max-w-[68ch] text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="absolute right-0 top-0 flex shrink-0 items-center gap-2 sm:static">
        {actions}
      </div>
    </header>
  )
}

export function observeJobCompletions(
  previous: ReadonlyMap<string, TrainJobStatus['state']> | undefined,
  jobs: TrainJobStatus[],
): {
  states: ReadonlyMap<string, TrainJobStatus['state']>
  completedJobIds: string[]
} {
  const states = new Map(jobs.map(job => [job.jobId, job.state]))
  if (previous === undefined) return { states, completedJobIds: [] }
  const completedJobIds = jobs
    .filter(
      job =>
        job.state === 'done' &&
        (previous.get(job.jobId) === 'queued' || previous.get(job.jobId) === 'running'),
    )
    .map(job => job.jobId)
  return { states, completedJobIds }
}

export function planFileSelection({
  staged,
  transfers,
  queue,
  files,
}: {
  staged: TrainUploadsView
  transfers: Record<string, FileTransfer>
  queue: string[]
  files: File[]
}): {
  transfers: Record<string, FileTransfer>
  queue: string[]
  abort: UploadRequest[]
  error?: 'limit' | 'quota'
} {
  const next = { ...transfers }
  const nextQueue = [...queue]
  const abort: UploadRequest[] = []
  let reserved = Object.values(next)
    .filter(transfer => transfer.status === 'queued' || transfer.status === 'uploading')
    .reduce(
      (sum, transfer) =>
        sum +
        transfer.file.size -
        (staged.files.find(file => file.filename === transfer.file.name)?.size ?? 0),
      0,
    )
  let error: 'limit' | 'quota' | undefined
  for (const file of files) {
    const existing = staged.files.find(entry => entry.filename === file.name)
    const replaced = next[file.name]
    if (replaced?.request) abort.push(replaced.request)
    if (replaced && (replaced.status === 'queued' || replaced.status === 'uploading')) {
      reserved -= replaced.file.size - (existing?.size ?? 0)
    }
    const stagedNames = new Set(staged.files.map(entry => entry.filename))
    const pendingNames = Object.keys(next).filter(name => !stagedNames.has(name))
    const distinctCount = (staged.fileCount ?? stagedNames.size) + pendingNames.length
    const couldReplaceUnloaded =
      (staged.fileCount ?? stagedNames.size) > stagedNames.size &&
      existing === undefined &&
      replaced === undefined
    if (
      !couldReplaceUnloaded &&
      !stagedNames.has(file.name) &&
      !next[file.name] &&
      distinctCount >= MAX_TRAIN_FILES
    ) {
      error = 'limit'
      continue
    }
    const delta = file.size - (existing?.size ?? 0)
    if (
      staged.totalBytes + reserved + delta > staged.capBytes &&
      !(couldReplaceUnloaded && file.size <= staged.capBytes)
    ) {
      error = 'quota'
      next[file.name] = { file, progress: 0, status: 'failed', error: 'quota' }
      continue
    }
    reserved += delta
    next[file.name] = { file, progress: 0, status: 'queued' }
    const priorQueueIndex = nextQueue.indexOf(file.name)
    if (priorQueueIndex >= 0) nextQueue.splice(priorQueueIndex, 1)
    nextQueue.push(file.name)
  }
  return { transfers: next, queue: nextQueue, abort, error }
}

export function TrainSourceCard({
  scope,
  urlDraft,
  uploads,
  uploadsLoading,
  uploadsInitialError = false,
  uploadsRefreshFailed = false,
  uploadsHasMore = false,
  uploadsPageFailed = false,
  uploadsLoadingMore = false,
  restored = false,
  lastJobFailed = false,
  transfers,
  urlAttempts,
  urlError,
  fileError,
  pending,
  startError,
  canStart,
  onUrlDraft,
  onAddUrl,
  onDismissUrl,
  onChooseFiles,
  onCancelUpload,
  onRemoveSource,
  onLoadMore,
  onRetryUploads,
  onStart,
}: {
  scope: TrainScope
  urlDraft: string
  uploads: TrainUploadsView
  uploadsLoading: boolean
  uploadsInitialError?: boolean
  uploadsRefreshFailed?: boolean
  uploadsHasMore?: boolean
  uploadsPageFailed?: boolean
  uploadsLoadingMore?: boolean
  restored?: boolean
  lastJobFailed?: boolean
  transfers: FileTransfer[]
  urlAttempts: UrlAttempt[]
  urlError?: string
  fileError?: string
  pending: boolean
  startError: boolean
  canStart: boolean
  onUrlDraft(value: string): void
  onAddUrl(): void
  onDismissUrl(url: string): void
  onChooseFiles(): void
  onCancelUpload(filename: string): void
  onRemoveSource(filename: string): void
  onLoadMore?(): void
  onRetryUploads(): void
  onStart(): void
}) {
  const t = useTranslations('duetTrain')
  const reduceMotion = useReducedMotion()
  const stagingDisabled = uploadsLoading || uploadsInitialError || pending
  const urlInputId = scope.kind === 'root' ? 'train-url' : `train-url-${scope.agentSlug}`
  const urlErrorId = `${urlInputId}-error`
  // Add stays inert until there is something to add — a button that only ever
  // returns "enter a valid URL" is a trap, not an affordance.
  const canAddUrl = !stagingDisabled && urlDraft.trim().length > 0
  return (
    <WorkspacePanel data-testid="train-source-card">
      <div className="relative space-y-4 p-4 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-5 tracking-tight">
            {t(scope.kind === 'root' ? 'newGlobalTraining' : 'newTraining')}
          </h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('sourceHelp')}</p>
        </div>
        <div>
          <label htmlFor={urlInputId} className="text-sm font-medium">
            {t('websiteUrl')}
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id={urlInputId}
              // Deliberately `text`, not `url`: the browser's native url
              // validation rejects a bare `stripe.com`, which is exactly what
              // this field is meant to accept. `normalizeTrainSourceUrl` adds
              // the scheme.
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={stagingDisabled}
              value={urlDraft}
              aria-invalid={urlError === undefined ? undefined : true}
              aria-describedby={urlError === undefined ? undefined : urlErrorId}
              onChange={event => onUrlDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (canAddUrl) onAddUrl()
                }
              }}
              placeholder="stripe.com"
              className={cn(
                'h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-brand sm:h-9',
                urlError !== undefined && 'border-destructive/60 focus:ring-destructive',
              )}
            />
            <button
              type="button"
              disabled={!canAddUrl}
              onClick={onAddUrl}
              className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11 sm:min-h-9')}
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              {t('add')}
            </button>
          </div>
          {urlError === undefined ? null : (
            <p
              id={urlErrorId}
              aria-live="polite"
              className="mt-1.5 text-sm font-medium text-destructive"
            >
              {urlError}
            </p>
          )}
        </div>

        <button
          type="button"
          disabled={stagingDisabled}
          onClick={onChooseFiles}
          className="flex min-h-20 w-full items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/30 px-4 text-sm font-medium hover:border-brand/50 hover:bg-brand/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <UploadSimpleIcon className="size-5 text-brand" aria-hidden="true" />
          <span>
            {t('chooseFiles')}
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {t('supportedFiles')}
            </span>
          </span>
        </button>

        {fileError === undefined ? null : (
          <p aria-live="polite" className="-mt-2 text-sm font-medium text-destructive">
            {fileError}
          </p>
        )}

        {uploadsInitialError || uploadsRefreshFailed ? (
          <TrainInlineRetry message={t('uploadsError')} onRetry={onRetryUploads} />
        ) : null}

        {lastJobFailed && uploads.files.length > 0 ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/10 px-3.5 py-3 text-sm">
            <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <p>{t('lastRunFailed')}</p>
          </div>
        ) : restored ? (
          <p className="text-xs text-muted-foreground">{t('restoredSources')}</p>
        ) : null}

        {uploads.files.length + transfers.length + urlAttempts.length > 0 ? (
          <motion.ul layout aria-label={t('selectedSources')} className="space-y-2">
            <AnimatePresence initial={false}>
              {urlAttempts.map(attempt => (
                <SourceRow
                  key={attempt.url}
                  label={attempt.url}
                  kind="url"
                  state={attempt.status}
                  detail={
                    attempt.status === 'pending'
                      ? t('urlPending')
                      : (attempt.detail ?? t('urlFailed'))
                  }
                  disabled={stagingDisabled}
                  onRemove={() => onDismissUrl(attempt.url)}
                />
              ))}
              {transfers.map(transfer => (
                <SourceRow
                  key={transfer.file.name}
                  label={transfer.file.name}
                  kind="file"
                  detail={
                    transfer.error === 'quota'
                      ? t('quotaError')
                      : transfer.status === 'cancelled'
                        ? t('uploadCancelled')
                        : formatBytesBinary(transfer.file.size)
                  }
                  state={transfer.status}
                  progress={transfer.progress}
                  disabled={stagingDisabled}
                  onRemove={() => onCancelUpload(transfer.file.name)}
                />
              ))}
              {uploads.files
                .filter(
                  entry =>
                    !transfers.some(transfer => transfer.file.name === entry.filename) &&
                    !urlAttempts.some(attempt => attempt.url === entry.url),
                )
                .map(entry => (
                  <SourceRow
                    key={entry.filename}
                    label={entry.url ?? entry.filename}
                    kind={entry.url === undefined ? 'file' : 'url'}
                    detail={formatBytesBinary(entry.size)}
                    disabled={stagingDisabled}
                    onRemove={() => onRemoveSource(entry.filename)}
                  />
                ))}
            </AnimatePresence>
          </motion.ul>
        ) : null}
        {uploadsHasMore && onLoadMore ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={uploadsLoadingMore}
            onClick={onLoadMore}
          >
            {uploadsLoadingMore
              ? t('loadingMore')
              : uploadsPageFailed
                ? t('loadMoreError')
                : t('loadMore')}
          </Button>
        ) : null}

        <AnimatePresence initial={false}>
          {uploadsLoading ? (
            <motion.div
              role="status"
              aria-label={t('loadingSources')}
              className="absolute inset-0 z-10 space-y-4 bg-background p-4 sm:p-5"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
              <Skeleton className="h-11 w-full rounded-lg" />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {startError ? (
          <p className="text-sm font-medium text-destructive">{t('startError')}</p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs leading-5 text-muted-foreground">{t('limits')}</p>
          <button
            type="button"
            disabled={stagingDisabled || !canStart}
            onClick={onStart}
            className={cn(buttonVariants(), 'min-h-11 sm:min-h-9')}
          >
            {pending ? (
              <SpinnerGapIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <BrainIcon className="size-4" aria-hidden="true" />
            )}
            {pending ? t('starting') : lastJobFailed ? t('retryStart') : t('start')}
          </button>
        </div>
      </div>
    </WorkspacePanel>
  )
}

function SourceRow({
  label,
  detail,
  kind,
  state,
  progress,
  disabled = false,
  onRemove,
}: {
  label: string
  detail?: string
  kind: 'url' | 'file'
  state?: FileTransfer['status'] | UrlAttempt['status']
  progress?: number
  disabled?: boolean
  onRemove(): void
}) {
  const t = useTranslations('duetTrain')
  const reduceMotion = useReducedMotion()
  return (
    <motion.li
      layout={!reduceMotion}
      className="min-w-0 rounded-lg border bg-background px-3 py-2.5"
      initial={reduceMotion ? false : { opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex min-w-0 items-center gap-3">
        {kind === 'url' ? (
          <LinkIcon className="size-4 shrink-0 text-brand" aria-hidden="true" />
        ) : (
          <FileTextIcon className="size-4 shrink-0 text-brand" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{label}</span>
          {detail && state !== 'failed' ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
          ) : null}
        </span>
        {state === 'uploading' ? (
          <span className="shrink-0 text-xs font-medium tabular-nums text-brand">
            {t('uploadProgressVisible', { progress: progress ?? 0 })}
          </span>
        ) : null}
        {state === 'pending' || state === 'queued' ? (
          <SpinnerGapIcon
            className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-label={t('pending')}
          />
        ) : null}
        {state === 'cancelled' || state === 'failed' ? (
          <XCircleIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : null}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          aria-label={t('removeSource', { name: label })}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'xs' }),
            'min-h-11 border-border/70 bg-background px-2.5 text-foreground sm:min-h-8',
          )}
        >
          {state === 'uploading' || state === 'queued' ? t('cancel') : t('remove')}
        </button>
        <span className="sr-only">{kind}</span>
      </div>
      {detail && state === 'failed' ? (
        <p className="mt-1 pl-7 text-xs font-medium leading-5 text-destructive">{detail}</p>
      ) : null}
      {state === 'uploading' ? (
        <div
          role="progressbar"
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          aria-label={t('uploadProgress', { progress: progress ?? 0 })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? 0}
        >
          <motion.div
            className="h-full origin-left rounded-full bg-brand"
            initial={false}
            animate={{ scaleX: (progress ?? 0) / 100 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      ) : null}
    </motion.li>
  )
}

export function TrainJobsCard({
  scope,
  jobs,
  loading,
  error,
  hasMore = false,
  pageFailed = false,
  loadingMore = false,
  onLoadMore,
  onRetry,
}: {
  scope: TrainScope
  jobs: TrainJobStatus[]
  loading: boolean
  error: boolean
  hasMore?: boolean
  pageFailed?: boolean
  loadingMore?: boolean
  onLoadMore?(): void
  onRetry(): void
}) {
  const t = useTranslations('duetTrain')
  const locale = useLocale()
  return (
    <WorkspacePanel className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold leading-5 tracking-tight">{t('jobHistory')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              jobs.length === 0 && scope.kind === 'agent'
                ? 'jobHistoryEmptyHelp'
                : 'jobHistoryHelp',
            )}
          </p>
        </div>
        {loading ? (
          <SpinnerGapIcon
            className="size-5 animate-spin text-muted-foreground"
            aria-label={t('loading')}
          />
        ) : null}
      </div>
      {error ? <TrainInlineRetry message={t('jobsError')} onRetry={onRetry} /> : null}
      {!loading && !error && jobs.length === 0 ? (
        <EmptyState
          title={t(hasMore || pageFailed ? 'noJobsLoaded' : 'noJobs')}
          body={t(
            hasMore || pageFailed
              ? 'noJobsLoadedBody'
              : scope.kind === 'agent'
                ? 'noAgentJobsBody'
                : 'noJobsBody',
          )}
          compact={scope.kind === 'agent'}
        />
      ) : null}
      {jobs.length > 0 ? (
        <ul className="mt-4 divide-y">
          {jobs.map(job => (
            <li key={job.jobId} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-medium">{job.jobId}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatTrainDate(job.createdAt, locale)}
                  </p>
                </div>
                <StatusBadge state={job.state} />
              </div>
              {job.state === 'queued' || job.state === 'running' ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(`phase.${phaseCopyKey(job.phase)}`)}
                </p>
              ) : null}
              {job.error ? (
                <p className="mt-2 text-xs font-medium text-destructive">{job.error}</p>
              ) : null}
              {job.sourceFailures?.map(failure => (
                <div
                  key={`${failure.source}-${failure.message}`}
                  className="mt-2 text-xs text-amber-700 dark:text-amber-300"
                >
                  <p className="font-medium">{t('sourceFailed', { source: failure.source })}</p>
                  <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/80">
                    {failure.message}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {hasMore && onLoadMore ? (
        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? t('loadingMore') : pageFailed ? t('loadMoreError') : t('loadMore')}
        </Button>
      ) : null}
    </WorkspacePanel>
  )
}

export function phaseCopyKey(
  phase: TrainJobStatus['phase'],
): 'preparing' | 'training' | 'finishing' {
  switch (phase) {
    case 'preparing':
    case 'snapshotting':
      return 'preparing'
    case 'training':
      return 'training'
    case 'finalizing':
    case 'cleanup':
    case 'done':
    case 'failed':
      return 'finishing'
  }
}

export function TrainRecordsCard({
  scope,
  readOnly,
  records,
  loading,
  error,
  incomplete = false,
  onRetry,
}: {
  scope: TrainScope
  readOnly: boolean
  records: TrainRecordSummary[]
  loading: boolean
  error?: string
  incomplete?: boolean
  onRetry(): void
}) {
  const t = useTranslations('duetTrain')
  const locale = useLocale()
  const { activeWorkspaceSlug } = useSpa()
  const workspaceSlug = activeWorkspaceSlug ?? ''
  return (
    <WorkspacePanel className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-5 tracking-tight">{t('memoryLibrary')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(readOnly ? 'memoryLibraryReadOnlyHelp' : 'memoryLibraryHelp')}
          </p>
        </div>
        <CountPill
          value={incomplete ? t('loadedCountShort', { count: records.length }) : records.length}
          label={t(incomplete ? 'memoryLoadedCount' : 'memoryCount', { count: records.length })}
        />
      </div>
      {loading ? <LoadingRows /> : null}
      {error ? <TrainInlineRetry message={t('recordsError')} onRetry={onRetry} /> : null}
      {!loading && error === undefined && records.length === 0 ? (
        <EmptyState
          title={t(incomplete ? 'noRecordsLoaded' : 'noRecords')}
          body={t(incomplete ? 'noRecordsLoadedBody' : 'noRecordsBody')}
        />
      ) : null}
      {records.length > 0 ? (
        <ul className={MEMORY_LIST_CLASS}>
          {records.map(record => (
            <li key={record.slug} className="min-w-0">
              <Link
                to={trainRecordPath(workspaceSlug, scope, record.slug)}
                className={MEMORY_ROW_CLASS}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-sm font-medium leading-6',
                      scope.kind === 'agent' ? 'line-clamp-2 sm:line-clamp-1' : 'truncate',
                    )}
                  >
                    {record.headline ?? record.slug}
                  </span>
                  <span className="mt-0.5 block truncate text-xs tabular-nums text-muted-foreground">
                    {record.fileCount == null
                      ? t('memoryRecord')
                      : t('fileCount', { count: record.fileCount })}
                    {' · '}
                    {formatTrainDate(record.createdAt, locale)}
                  </span>
                </span>
                <CaretRightIcon
                  className="size-4 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </WorkspacePanel>
  )
}

export function InheritedMemoriesCard({
  workspaceSlug,
  agents = [],
  records,
  incomplete = false,
}: {
  workspaceSlug: string
  agents?: Agent[]
  records: TrainRecordSummary[]
  incomplete?: boolean
}) {
  const t = useTranslations('duetTrain')
  const locale = useLocale()
  return (
    <WorkspacePanel className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-5 tracking-tight">
            {t('inheritedMemories')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('inheritedMemoriesHelp')}</p>
        </div>
        <CountPill
          value={incomplete ? t('loadedCountShort', { count: records.length }) : records.length}
          label={t(incomplete ? 'memoryLoadedCount' : 'memoryCount', { count: records.length })}
        />
      </div>
      {records.length === 0 ? (
        <EmptyState
          title={t(incomplete ? 'noInheritedMemoriesLoaded' : 'noInheritedMemories')}
          body={t(incomplete ? 'noInheritedMemoriesLoadedBody' : 'noInheritedMemoriesBody')}
          compact
        />
      ) : (
        <ul className={MEMORY_LIST_CLASS}>
          {records.map(record => {
            const owner = record.ownerAgentSlug
            const ownerScope: TrainScope =
              owner === undefined ? { kind: 'root' } : { kind: 'agent', agentSlug: owner }
            const ownerAgent =
              owner === undefined ? undefined : agents.find(agent => agent.slug === owner)
            const ownerName =
              owner === undefined
                ? t('rootOwner')
                : ownerAgent === undefined
                  ? owner
                  : agentDisplayName(ownerAgent)
            return (
              <li key={`${owner ?? 'root'}:${record.slug}`} className="min-w-0">
                <Link
                  to={trainRecordPath(workspaceSlug, ownerScope, record.slug)}
                  className={MEMORY_ROW_CLASS}
                >
                  <AgentAvatar
                    /* The slug, which `owner` already is — never `ownerName`,
                       which is the *display* name and gives a renamed agent a
                       different generated face here than it wears everywhere
                       else. `ownerScope` beside this is built from the same
                       field for the same reason. */
                    avatarKey={owner ?? ROOT_AGENT_SCOPE}
                    duet={owner === undefined}
                    profile={ownerAgent}
                    workspaceSlug={workspaceSlug}
                    className="size-7 shrink-0 rounded-md"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-medium leading-6 sm:line-clamp-1">
                      {record.headline ?? record.slug}
                    </span>
                    <span className="mt-0.5 block truncate text-xs tabular-nums text-muted-foreground">
                      {t('inheritedFrom', { owner: ownerName })}
                      {' · '}
                      {formatTrainDate(record.createdAt, locale)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                    <span className="hidden sm:inline">{t('viewAtOwner')}</span>
                    <CaretRightIcon
                      className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </WorkspacePanel>
  )
}

function StatusBadge({ state }: { state: TrainJobStatus['state'] }) {
  const t = useTranslations('duetTrain')
  const styles =
    state === 'done'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : state === 'failed'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-live/10 text-live'
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles}`}>
      {t(`status.${state}`)}
    </span>
  )
}

// Memory rows are full-bleed inside their card: the negative margin cancels the
// panel padding so hover fills and hairline rules run edge to edge, the way a
// library list should read.
// Memory rows run flush to the card's bottom edge: the last row's own padding
// is the card's bottom inset, so no stray empty strip trails the list.
const MEMORY_LIST_CLASS =
  '-mx-4 -mb-4 mt-4 min-w-0 divide-y divide-border/65 border-t border-border/65 sm:-mx-5 sm:-mb-5'
const MEMORY_ROW_CLASS =
  'group flex min-w-0 items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:px-5'

function CountPill({ value, label }: { value: number | string; label: string }) {
  return (
    <span className="mt-0.5 shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
      <span aria-hidden="true">{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

function EmptyState({
  title,
  body,
  compact = false,
}: {
  title: string
  body: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-dashed bg-muted/20 px-5 text-center',
        compact ? 'mt-4 py-6 sm:py-8' : 'mt-4 py-8',
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-pretty text-xs leading-5 text-muted-foreground">
        {body}
      </p>
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="mt-4 space-y-2" aria-hidden="true">
      {[0, 1, 2].map(row => (
        <Skeleton key={row} className="h-14 rounded-lg" />
      ))}
    </div>
  )
}

function sourceFetchDetail(error: unknown): string | undefined {
  return error instanceof VmUploadError ? error.message : undefined
}
