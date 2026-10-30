'use client'

import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  BrainIcon,
  CheckIcon,
  FileTextIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  SpinnerGapIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import { useNavigate } from 'react-router'

import type { TrainRecord, TrainRecordSource } from '@repo/contract'
import { Markdown } from '@repo/ui/components/common/markdown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@repo/ui/components/shadcn/alert-dialog'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryKeys } from '../../api/query-keys'
import { duetQueryOptions } from '../../api/query-options'
import { trainRecordSourceUrl, type TrainScope } from '../../api/train-scope'
import { useWorkspaceCacheScope } from '../../api/workspace-cache-scope'
import { useSpa, type SpaApi } from '../../context'
import { useToast } from '../../shell/toast'
import { retrainTrainPath } from './train-routes'
import { formatTrainDate, TrainInlineRetry } from './train-shared'

/**
 * A memory is an authored document, not a typed message.
 *
 * The shared renderer keeps paragraphs `whitespace-pre-wrap` so a chat message
 * shows the newlines someone typed. Synthesis hard-wraps its prose at around
 * eighty columns, so honoring those newlines breaks every paragraph mid
 * sentence. Markdown's own rule — a single newline is a soft wrap — is the
 * right one here.
 *
 * Defined at module scope because react-markdown re-parses on every render and
 * an inline component would be a new type each time.
 */
const MEMORY_MARKDOWN_COMPONENTS = {
  p: function MemoryParagraph({
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<'p'> & { node?: unknown }) {
    return <p {...props} className="break-words last:!mb-0" />
  },
}

/**
 * Chips shown before the strip collapses. A training can archive up to 200
 * files (`MAX_TRAIN_FILES`), and the strip sits above the memory itself.
 */
const MAX_VISIBLE_SOURCES = 8

export async function invalidateTrainRecordCollections(
  queryClient: QueryClient,
  api: SpaApi,
  workspaceSlug: string,
  scope: TrainScope,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: duetQueryOptions.workspaces.train.recordList(api, workspaceSlug, scope).queryKey,
    }),
    queryClient.invalidateQueries({
      queryKey: duetQueryOptions.workspaces.train.memoryCounts(api, workspaceSlug).queryKey,
    }),
  ])
}

export function TrainRecordDetail({
  scope,
  slug,
  readOnly,
  onBack,
}: {
  scope: TrainScope
  slug: string
  readOnly: boolean
  onBack(): void
}) {
  const t = useTranslations('duetTrain')
  const { api, trainUploads, activeWorkspaceSlug } = useSpa()
  const workspaceSlug = activeWorkspaceSlug ?? ''
  const queryClient = useQueryClient()
  const cacheScope = useWorkspaceCacheScope(workspaceSlug)
  const navigate = useNavigate()
  const showToast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const detail = useQuery(duetQueryOptions.workspaces.train.record(api, workspaceSlug, scope, slug))
  const update = useMutation({
    mutationFn: (content: string) => api.updateTrainRecord(workspaceSlug, slug, content, scope),
    onSuccess: result => {
      if (!cacheScope.isActive()) return
      void detail.refetch()
      setDraft(result.record.content)
      setEditing(false)
      void queryClient.invalidateQueries({
        queryKey: duetQueryOptions.workspaces.train.recordList(api, workspaceSlug, scope).queryKey,
      })
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteTrainRecord(workspaceSlug, slug, scope),
    onSuccess: () => {
      if (!cacheScope.isActive()) return
      void invalidateTrainRecordCollections(queryClient, api, workspaceSlug, scope)
      onBack()
    },
  })
  const record = detail.data?.record
  const recordReadOnly = readOnly || record?.inherited === true
  const uploads = useInfiniteQuery({
    queryKey: duetQueryKeys.workspaces.train.uploads(workspaceSlug, scope),
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
  const jobRunning = uploads.data?.pages[0]?.meta?.running ?? false
  // Three independent reasons this memory cannot be retrained right now: its
  // sources were pruned, it belongs to an ancestor, or a job is already using
  // this scope's inbox — the last of which would otherwise surface as a raw
  // 409 the moment the user pressed the button.
  const canRetrain = record?.hasArchive === true && !recordReadOnly && !jobRunning
  const retrain = useMutation({
    mutationFn: () => api.restageTrainRecord(workspaceSlug, slug, scope),
    onSuccess: result => {
      if (!cacheScope.isActive()) return
      if (result.fellBack.length > 0)
        showToast(t('retrainFellBack', { count: result.fellBack.length }))
      navigate(retrainTrainPath(workspaceSlug, scope, slug))
    },
    onError: () => showToast(t('retrainError')),
  })
  const startEditing = () => {
    setDraft(record?.content ?? '')
    setEditing(true)
  }
  return (
    <div className="mx-auto w-full max-w-[74rem]">
      <div className="sticky top-0 z-20 -mx-1 flex min-h-12 flex-wrap items-center gap-2 border-b border-border/60 bg-background px-1 py-2">
        {!editing ? (
          <button type="button" onClick={onBack} className={buttonVariants({ variant: 'ghost' })}>
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t('back')}
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {record && !recordReadOnly && editing ? (
            <>
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => {
                  setDraft(record.content)
                  setEditing(false)
                }}
                className={buttonVariants({ variant: 'ghost' })}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={draft.trim().length === 0 || draft === record.content || update.isPending}
                onClick={() => update.mutate(draft)}
                className={buttonVariants()}
              >
                {update.isPending ? (
                  <SpinnerGapIcon className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckIcon className="size-4" aria-hidden="true" />
                )}
                {update.isPending ? t('saving') : t('save')}
              </button>
            </>
          ) : null}
          {record && !recordReadOnly && !editing ? (
            <button
              type="button"
              disabled={!canRetrain || retrain.isPending}
              title={canRetrain ? undefined : t('retrainUnavailable')}
              onClick={() => retrain.mutate()}
              className={buttonVariants({ variant: 'outline' })}
            >
              {retrain.isPending ? (
                <SpinnerGapIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowsClockwiseIcon className="size-4" aria-hidden="true" />
              )}
              {t('retrain')}
            </button>
          ) : null}
          {record && !recordReadOnly && !editing ? (
            <button
              type="button"
              onClick={startEditing}
              className={buttonVariants({ variant: 'outline' })}
            >
              <PencilSimpleIcon className="size-4" aria-hidden="true" />
              {t('edit')}
            </button>
          ) : null}
          {record && !recordReadOnly && !editing ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  disabled={remove.isPending}
                  className={cn(
                    buttonVariants({ variant: 'ghost' }),
                    'text-destructive hover:bg-destructive/10 hover:text-destructive',
                  )}
                >
                  <TrashIcon className="size-4" aria-hidden="true" />
                  {remove.isPending ? t('deleting') : t('delete')}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('deleteConfirm', {
                      name: record.headline ?? record.slug,
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => remove.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t('delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>
      {detail.isPending ? (
        <div className="mx-auto max-w-[44rem] py-12 sm:py-16" aria-hidden="true">
          <Skeleton className="h-4 w-28 rounded-full" />
          <Skeleton className="mt-5 h-12 w-4/5 rounded-lg sm:h-14" />
          <Skeleton className="mt-4 h-4 w-56 rounded-full" />
          <div className="mt-12 space-y-3 border-t border-border/60 pt-8">
            <Skeleton className="h-4 w-full rounded-full" />
            <Skeleton className="h-4 w-[94%] rounded-full" />
            <Skeleton className="h-4 w-[88%] rounded-full" />
            <Skeleton className="h-4 w-[68%] rounded-full" />
          </div>
        </div>
      ) : null}
      {detail.isError ? (
        <div className="mx-auto w-full max-w-lg py-10">
          <TrainInlineRetry message={t('recordError')} onRetry={() => void detail.refetch()} />
        </div>
      ) : null}
      {record ? (
        <article className="mx-auto w-full max-w-[44rem] pb-12 pt-10 sm:pb-16 sm:pt-14">
          <header>
            <p className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-brand">
              <BrainIcon className="size-4" weight="duotone" aria-hidden="true" />
              {t('trainedMemory')}
            </p>
            <h1 className="mt-4 break-words font-serif text-[clamp(2rem,5vw,3.5rem)] font-normal italic leading-[1.06] tracking-[-0.035em] text-foreground">
              {record.headline ?? record.slug}
            </h1>
            <RecordMetadata record={record} />
            <RecordSources record={record} scope={scope} workspaceSlug={workspaceSlug} />
          </header>
          {recordReadOnly ? (
            <p className="mt-8 border-y border-border/60 bg-muted/20 px-3 py-3 text-sm leading-6 text-muted-foreground sm:px-4">
              <span className="font-medium text-foreground">{t('readOnly')}</span>
              {' — '}
              {t(record.inherited ? 'inheritedReadOnlyHelp' : 'replicaReadOnlyHelp')}
            </p>
          ) : null}
          {editing ? (
            <section className="mt-10 border-t border-border/60 pt-8">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <label htmlFor="train-record-content" className="text-sm font-semibold">
                  {t('content')}
                </label>
                <span
                  aria-live="polite"
                  className={cn(
                    'text-xs',
                    draft === record.content ? 'text-muted-foreground' : 'font-medium text-brand',
                  )}
                >
                  {draft === record.content ? t('saved') : t('unsaved')}
                </span>
              </div>
              <div className="rounded-xl border border-border/80 bg-background px-4 py-4 shadow-sm transition focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/10 sm:px-5">
                <textarea
                  id="train-record-content"
                  aria-label={t('content')}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  className="min-h-[28rem] w-full scroll-mt-24 resize-y border-0 bg-transparent p-0 font-sans text-[1.0625rem] leading-7 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0 sm:leading-8"
                />
              </div>
              {update.isError ? (
                <p className="mt-4 border-y border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                  {t('updateError')}
                </p>
              ) : null}
            </section>
          ) : (
            <section
              aria-label={t('content')}
              className="mt-10 border-t border-border/60 pt-8 font-sans text-[1.0625rem] leading-7 text-foreground/90 sm:leading-8"
            >
              <Markdown components={MEMORY_MARKDOWN_COMPONENTS}>{record.content}</Markdown>
            </section>
          )}
        </article>
      ) : null}
    </div>
  )
}

/**
 * Chips naming the sources this memory was trained from, above the content.
 *
 * A scraped page reads as its URL rather than the slugified filename the
 * scraper produced, because the URL is what the person recognizes. A training
 * can hold up to 200 files, so the strip shows a handful and collapses the
 * rest — 200 chips above the fold is a wall, not provenance.
 *
 * Absent `sources` means a gateway that predates the field, which renders
 * nothing at all rather than an empty strip. An absent *archive* is different
 * and says so: it is the reason Retrain is unavailable.
 */
function RecordSources({
  record,
  scope,
  workspaceSlug,
}: {
  record: TrainRecord
  scope: TrainScope
  workspaceSlug: string
}) {
  const t = useTranslations('duetTrain')
  const [expanded, setExpanded] = useState(false)

  if (record.hasArchive !== true) {
    return (
      <p className="mt-6 border-y border-border/60 bg-muted/20 px-3 py-3 text-sm leading-6 text-muted-foreground sm:px-4">
        <span className="font-medium text-foreground">{t('sourcesGoneTitle')}</span>{' '}
        {t('sourcesGoneHelp')}
      </p>
    )
  }
  const sources = record.sources ?? []
  if (sources.length === 0) return null

  const shown = expanded ? sources : sources.slice(0, MAX_VISIBLE_SOURCES)
  const hidden = sources.length - shown.length
  return (
    <div className="mt-5">
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t('trainedFrom')}>
        {sources.length > 0 ? (
          <li className="mr-1 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t('trainedFrom')}
          </li>
        ) : null}
        {shown.map(source => (
          <li key={source.relPath}>
            <a
              href={trainRecordSourceUrl(workspaceSlug, scope, record.slug, source.relPath)}
              target="_blank"
              rel="noreferrer"
              title={source.title ?? source.url ?? source.relPath}
              className={cn(
                'flex max-w-[18rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.8125rem] transition-colors',
                source.url === undefined
                  ? 'border-border bg-card hover:bg-muted/60'
                  : 'border-brand/35 bg-brand/10 text-brand hover:bg-brand/15',
              )}
            >
              {source.url === undefined ? (
                <FileTextIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
              ) : (
                <LinkSimpleIcon className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{sourceLabel(source)}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatSourceBytes(source.bytes)}
              </span>
            </a>
          </li>
        ))}
        {hidden > 0 ? (
          <li>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-full border border-dashed border-border px-2.5 py-1 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              {t('moreSources', { count: hidden })}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/** A scrape is known by its address; a file by its name. */
function sourceLabel(source: TrainRecordSource): string {
  if (source.url === undefined) return source.relPath
  try {
    const parsed = new URL(source.url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return source.url
  }
}

function formatSourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function RecordMetadata({ record }: { record: TrainRecord }) {
  const t = useTranslations('duetTrain')
  const locale = useLocale()
  const items = useMemo(
    () =>
      [
        t('created', { date: formatTrainDate(record.createdAt, locale) }),
        record.fileCount == null ? undefined : t('fileCount', { count: record.fileCount }),
        record.model ? t('model', { model: record.model }) : undefined,
      ].filter((item): item is string => item !== undefined),
    [locale, record, t],
  )
  return (
    <ul className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
      {items.map(item => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}
