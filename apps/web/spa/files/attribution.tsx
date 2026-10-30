'use client'

import {
  ArrowsClockwiseIcon,
  ClockCounterClockwiseIcon,
  GearIcon,
  KeyIcon,
  LaptopIcon,
  QuestionIcon,
  RobotIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
  UserIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

import {
  parseActorContext,
  summaryCountsFiles,
  type FileActivityEvent,
  type FileActorKind,
  type FileHistoryResponse,
} from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/shadcn/sheet'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryKeys } from '../api/query-keys'
import { isInitialCollectionError, workspaceMembersQueryOptions } from '../api/query-options'
import { UserAvatar } from '../identity/identity-avatar'
import {
  RestAttributionSource,
  type AttributionMember,
  type IAttributionSource,
} from './lib/attribution-source'
import { fileName, normalizeBrowserFilePath } from './lib/paths'
import { buildHistoryRows, mergeEventPages, type HistoryRow } from './lib/timeline'

// Sole owner of attribution presentation in the Files SPA (slice 05): the
// preview seen-by strip, the history/activity timelines, and the one
// context→label helper. Attribution is decoration here — when data is
// missing or the queries fail, everything degrades to a restrained "—" and
// the library/preview keep working.

// ---------------------------------------------------------------------------
// formatActor — the one context→label helper.

export type AttributionLabelKey =
  | 'agent'
  | 'agentNamed'
  | 'member'
  | 'apiKey'
  | 'apiKeyNamed'
  | 'terminal'
  | 'system'
  | 'sync'
  | 'mirror'

export type AttributionTranslator = (
  key: AttributionLabelKey,
  values?: Record<string, string>,
) => string

export type ActorLookups = {
  t: AttributionTranslator
  userName?: (userId: string) => string | undefined
}

export type FormattedActor = {
  kind: FileActorKind | 'unknown'
  label: string
  // Resolved member display name — present when the label is a person, so
  // the glyph can render initials instead of a kind icon.
  userName?: string
}

export function formatActor(
  context: string,
  userId: string | undefined,
  lookups: ActorLookups,
): FormattedActor {
  const { t } = lookups
  const parsed = parseActorContext(context)
  // Unknown grammar has no product label; the raw context string is the
  // only honest thing left to show.
  if (parsed === null) return { kind: 'unknown', label: context }
  const resolveUser = (id: string | undefined) =>
    id === undefined ? undefined : lookups.userName?.(id)
  switch (parsed.kind) {
    case 'web': {
      const name = resolveUser(userId ?? parsed.userId)
      return name === undefined
        ? { kind: parsed.kind, label: t('member') }
        : { kind: parsed.kind, label: name, userName: name }
    }
    case 'session': {
      const name = resolveUser(userId)
      return {
        kind: parsed.kind,
        label: name === undefined ? t('agent') : t('agentNamed', { name }),
      }
    }
    case 'api-key': {
      const name = resolveUser(userId)
      return {
        kind: parsed.kind,
        label: name === undefined ? t('apiKey') : t('apiKeyNamed', { name }),
      }
    }
    case 'sync':
      return { kind: parsed.kind, label: t('sync') }
    case 'mirror':
      return { kind: parsed.kind, label: t('mirror') }
    case 'terminal':
      return { kind: parsed.kind, label: t('terminal') }
    case 'system':
      return { kind: parsed.kind, label: t('system') }
  }
}

export function relativeTimeLabel(at: number, now: number, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' })
  const minutes = Math.max(1, Math.round((now - at) / 60_000))
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  if (days < 31) return formatter.format(-days, 'day')
  const months = Math.round(days / 30)
  if (months < 12) return formatter.format(-months, 'month')
  return formatter.format(-Math.round(days / 365), 'year')
}

// ---------------------------------------------------------------------------
// Data wiring: one injectable source (REST in the product, mock in the
// playground) plus the injectable clock fixtures freeze for screenshots.

export type AttributionConfig = {
  source: IAttributionSource
  // Injectable clock so fixture screenshots stay deterministic. The session
  // surface keeps its own pinned clock (`SpaContextValue.clock`) rather than
  // reading this one: this config is the files library's seam, and session
  // presentation is prop-injected so it renders without providers.
  now: () => number
}

const defaultConfig: AttributionConfig = {
  source: new RestAttributionSource(),
  now: Date.now,
}

const AttributionConfigContext = createContext<AttributionConfig>(defaultConfig)

export function AttributionConfigProvider({
  source,
  now,
  children,
}: Partial<AttributionConfig> & { children: ReactNode }) {
  const parent = useContext(AttributionConfigContext)
  const value = useMemo(
    () => ({ source: source ?? parent.source, now: now ?? parent.now }),
    [now, parent, source],
  )
  return (
    <AttributionConfigContext.Provider value={value}>{children}</AttributionConfigContext.Provider>
  )
}

// The injectable clock, exposed for surfaces that render relative times
// outside the attribution components (the library's card meta lines).
export function useAttributionNow(): () => number {
  return useContext(AttributionConfigContext).now
}

function useMemberDirectory(
  workspaceSlug: string,
  enabled: boolean,
): Map<string, AttributionMember> {
  const { source } = useContext(AttributionConfigContext)
  const query = useQuery({
    ...workspaceMembersQueryOptions(workspaceSlug, signal =>
      source.listMembers(workspaceSlug, { signal }),
    ),
    enabled: enabled && workspaceSlug.length > 0,
  })
  return useMemo(
    () => new Map((query.data?.items ?? []).map(member => [member.id, member])),
    [query.data],
  )
}

function useActorLookups(members: Map<string, AttributionMember>): ActorLookups {
  const t = useTranslations('duetApp.filesSurface.attribution')
  return useMemo(
    () => ({
      t: (key, values) => t(key, values),
      userName: userId => {
        const member = members.get(userId)
        return member === undefined ? undefined : (member.name ?? member.email)
      },
    }),
    [members, t],
  )
}

// ---------------------------------------------------------------------------
// Components.

/* Inline in a document header, seen-by is a glance, not a table. Three faces
   plus an overflow count fits beside a filename without crowding it; the names,
   edit marks and timestamps live in History, which is one click away. */
const SEEN_BY_MAX_CHIPS = 3

export function seenByOverflow(loaded: number, incomplete: boolean): number {
  return Math.max(loaded - SEEN_BY_MAX_CHIPS, 0) + (incomplete ? 1 : 0)
}

/**
 * Who has looked at this file, shown inline in the document header.
 *
 * It used to be a strip of its own beneath the header and carried the chrome to
 * match — a bottom border and its own padding. Inline, that chrome reads as a
 * stray rule through the middle of a header, so it is gone: this is a run of
 * faces on one line now, and it wraps nothing and divides nothing.
 */
export function SeenBy({ workspaceSlug, path }: { workspaceSlug: string; path: string }) {
  const t = useTranslations('duetApp.filesSurface.attribution')
  const locale = useLocale()
  const { source, now } = useContext(AttributionConfigContext)
  const query = useQuery({
    queryKey: duetQueryKeys.workspaces.fileAttribution.seenBy(
      workspaceSlug,
      normalizeBrowserFilePath(path),
    ),
    queryFn: ({ signal }) => source.seenBy(workspaceSlug, path, { signal }),
    enabled: workspaceSlug.length > 0,
    // Who has been in this file is a fact about right now, not something to
    // serve from a stale window the app chose for everything else.
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const rows = query.data?.items ?? []
  const members = useMemberDirectory(
    workspaceSlug,
    rows.some(row => row.userId !== undefined),
  )
  const lookups = useActorLookups(members)
  const visible = rows.slice(0, SEEN_BY_MAX_CHIPS)
  const incomplete = query.data?.nextCursor !== null && query.data?.nextCursor !== undefined
  const overflowLowerBound = seenByOverflow(rows.length, incomplete)
  return (
    <section
      aria-label={t('seenBy')}
      className="flex min-w-0 shrink items-center gap-x-2 overflow-hidden text-xs text-muted-foreground"
    >
      <span className="shrink-0">{t('seenBy')}</span>
      {visible.length === 0 ? (
        <EmptyAttribution />
      ) : (
        <span
          className={cn('flex shrink-0 items-center', incomplete ? '-space-x-1' : '-space-x-1.5')}
        >
          {visible.map(row => {
            const actor = formatActor(row.actor, row.userId, lookups)
            return (
              <span
                key={row.actor}
                /* Overlapped faces, no names: the label is the whole reason the
                   row used to be as wide as the filename beside it. */
                title={`${actor.label} · ${relativeTimeLabel(row.lastAt, now(), locale)}`}
                className={cn(
                  'grid shrink-0 place-items-center rounded-full border bg-background ring-1 ring-background',
                  incomplete ? 'size-6' : 'size-5',
                )}
              >
                <ActorGlyph actor={actor} className={incomplete ? 'size-5' : undefined} />
              </span>
            )
          })}
          {/* An exact overflow belongs in the stack. An incomplete page needs a
              separate text pill so its lower bound cannot read as another face
              or as the exact total. */}
          {overflowLowerBound > 0 ? (
            <SeenByOverflowChip
              incomplete={incomplete}
              label={
                incomplete
                  ? t('moreReadersAtLeastCompact', { count: overflowLowerBound })
                  : `+${overflowLowerBound}`
              }
              title={
                incomplete
                  ? t('moreReadersAtLeast', { count: overflowLowerBound })
                  : t('moreReaders', { count: overflowLowerBound })
              }
            />
          ) : null}
        </span>
      )}
    </section>
  )
}

export function SeenByOverflowChip({
  incomplete,
  label,
  title,
}: {
  incomplete: boolean
  label: string
  title: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'grid shrink-0 place-items-center rounded-full border bg-muted leading-none tabular-nums text-muted-foreground ring-1 ring-background',
        incomplete
          ? 'ml-3 h-6 min-w-fit px-2 text-[11px] font-semibold'
          : 'size-5 text-[9px] font-medium',
      )}
    >
      {label}
    </span>
  )
}

function EmptyAttribution() {
  return <span aria-hidden>—</span>
}

const KIND_ICONS: Record<FileActorKind | 'unknown', typeof UserIcon> = {
  web: UserIcon,
  session: RobotIcon,
  'api-key': KeyIcon,
  terminal: TerminalWindowIcon,
  sync: ArrowsClockwiseIcon,
  mirror: LaptopIcon,
  system: GearIcon,
  unknown: QuestionIcon,
}

function ActorGlyph({ actor, className }: { actor: FormattedActor; className?: string }) {
  if (actor.userName !== undefined) {
    return <UserAvatar name={actor.userName} className={cn('size-4', className)} />
  }
  const Icon = KIND_ICONS[actor.kind]
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-3" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Shared timeline surface (slice 12): the history drawer and the activity feed
// both page seq-ordered events, resolve the same members directory, and render
// through ONE row component. Only the wording — which slice-12 helper turns an
// event into a headline — differs between the two.

// One actor pill, reused by every timeline row. The slice-05 SeenByStrip keeps
// its own accepted pill markup; this is the shared chip for the new surfaces.
export function ActorChip({ actor }: { actor: FormattedActor }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border bg-muted/30 py-0.5 pl-1 pr-2.5 text-xs font-medium">
      <ActorGlyph actor={actor} />
      <span className="max-w-40 truncate">{actor.label}</span>
    </span>
  )
}

// The one row renderer. A time gutter, a wrapping headline, an optional muted
// meta line; when navigable the body becomes a button (the feed). No timeline
// markup is duplicated between the drawer and the feed.
export function AttributionRow({
  time,
  headline,
  meta,
  onNavigate,
}: {
  time: string
  headline: ReactNode
  meta?: ReactNode
  onNavigate?: () => void
}) {
  const body = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">{headline}</div>
      {meta !== undefined ? (
        <div className="mt-1 truncate text-xs text-muted-foreground">{meta}</div>
      ) : null}
    </div>
  )
  return (
    <li className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3 border-t px-4 py-3 first:border-t-0">
      <time className="pt-0.5 text-xs tabular-nums text-muted-foreground">{time}</time>
      {onNavigate !== undefined ? (
        <button
          type="button"
          onClick={onNavigate}
          className="min-w-0 rounded-md text-left outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  )
}

// Loading / error / empty / list scaffold shared by both surfaces so their
// non-data states never drift apart.
export function TimelineScaffold({
  pending,
  failed,
  pageFailed,
  empty,
  labels,
  onLoadMore,
  loadingMore,
  children,
}: {
  pending: boolean
  failed: boolean
  pageFailed?: boolean
  empty: boolean
  labels: {
    empty: string
    emptyBody: string
    failed: string
    moreFailed: string
    loadMore: string
    retryMore: string
  }
  onLoadMore?: () => void
  loadingMore?: boolean
  children: ReactNode
}) {
  if (pending) {
    return (
      <div className="space-y-3 p-4" aria-label={labels.emptyBody}>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-10 rounded-lg" style={{ opacity: 1 - index * 0.12 }} />
        ))}
      </div>
    )
  }
  if (failed) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
        <WarningIcon className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{labels.failed}</p>
      </div>
    )
  }
  if (empty) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-1 p-8 text-center">
        <ClockCounterClockwiseIcon className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">{labels.empty}</p>
        <p className="max-w-xs text-xs text-muted-foreground">{labels.emptyBody}</p>
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ul>{children}</ul>
      {onLoadMore !== undefined ? (
        <div className="p-3">
          {pageFailed ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive"
            >
              <WarningIcon className="size-4 shrink-0" weight="fill" />
              <p className="min-w-0 flex-1 text-xs font-medium">{labels.moreFailed}</p>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 border-destructive/40 bg-background text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? <SpinnerGapIcon className="mr-2 size-4 animate-spin" /> : null}
                {labels.retryMore}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? <SpinnerGapIcon className="mr-2 size-4 animate-spin" /> : null}
              {labels.loadMore}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}

// Shared data wiring: one paginated seq-ordered source (history for a path,
// or the workspace feed), merged without duplicates, plus the resolved member
// lookups the rows need. Wording lives in each surface; ordering lives here.
export type FileActivityArgs =
  | { workspaceSlug: string; enabled: boolean; kind: 'history'; path: string }
  | {
      workspaceSlug: string
      enabled: boolean
      kind: 'activity'
      path?: string
      scope?: 'exact' | 'subtree'
    }

export function fileActivityPollInterval(data: unknown): 5_000 | false {
  const pages =
    typeof data === 'object' && data !== null && 'pages' in data
      ? Reflect.get(data, 'pages')
      : undefined
  return Array.isArray(pages) && pages.length > 1 ? false : 5_000
}

function fileActivityQueryPollInterval(query: { state: { data: unknown } }): 5_000 | false {
  return fileActivityPollInterval(query.state.data)
}

/**
 * A timeline is only worth opening if it is current, so these queries opt out
 * of the app-wide 30s stale window: every mount reads again, and a timeline
 * left open keeps reading.
 */
export function fileActivityQueryOptions(source: IAttributionSource, args: FileActivityArgs) {
  const historyPath = args.kind === 'history' ? args.path : undefined
  const activityScope =
    args.kind === 'activity' && args.path !== undefined
      ? { path: normalizeBrowserFilePath(args.path), scope: args.scope ?? ('exact' as const) }
      : undefined
  return {
    queryKey:
      historyPath === undefined
        ? duetQueryKeys.workspaces.fileAttribution.activity(args.workspaceSlug, activityScope)
        : duetQueryKeys.workspaces.fileAttribution.history(
            args.workspaceSlug,
            normalizeBrowserFilePath(historyPath),
          ),
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      args.kind === 'history'
        ? source.fileHistory(args.workspaceSlug, args.path, { cursor: pageParam, signal })
        : source.workspaceActivity(args.workspaceSlug, {
            cursor: pageParam,
            signal,
            order: 'desc',
            ...(args.path === undefined ? {} : { path: args.path }),
            ...(args.path === undefined ? {} : { scope: args.scope ?? ('exact' as const) }),
          }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: FileHistoryResponse) => lastPage.nextCursor,
    enabled: args.enabled && args.workspaceSlug.length > 0,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always' as const,
    /* React Query refetches every retained page of an infinite query. Keep the
       live head current, but once someone pages backward treat that view as a
       stable historical snapshot; closing it discards the snapshot, so the
       next open starts from a fresh head. */
    refetchInterval: fileActivityQueryPollInterval,
  }
}

export function useFileActivityPages(args: FileActivityArgs) {
  const { source, now } = useContext(AttributionConfigContext)
  const locale = useLocale()
  const query = useInfiniteQuery(fileActivityQueryOptions(source, args))
  const events = useMemo(
    () => mergeEventPages((query.data?.pages ?? []).map(page => page.items)),
    [query.data],
  )
  const members = useMemberDirectory(
    args.workspaceSlug,
    events.some(row => row.event.userId !== undefined),
  )
  const lookups = useActorLookups(members)
  return { query, events, lookups, now, locale }
}

// ---------------------------------------------------------------------------
// FileHistoryDrawer — per-file seq-ordered timeline with reads inline. Deleted
// files stay viewable by their historical path (the query keys on path, not on
// the live entry). Opened from preview-pane.tsx.

export function FileHistoryDrawer({
  workspaceSlug,
  path,
}: {
  workspaceSlug: string
  path: string
}) {
  const t = useTranslations('duetApp.filesSurface')
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t('history.open')}>
          <ClockCounterClockwiseIcon className="size-4 md:mr-2" />
          <span className="sr-only md:not-sr-only">{t('history.open')}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="space-y-1 border-b px-4 py-3 pr-12 text-left">
          <SheetTitle className="truncate text-sm">
            {fileName(normalizeBrowserFilePath(path))}
          </SheetTitle>
          <SheetDescription className="text-xs">{t('history.subtitle')}</SheetDescription>
        </SheetHeader>
        {open ? <FileHistoryBody workspaceSlug={workspaceSlug} path={path} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function FileHistoryBody({ workspaceSlug, path }: { workspaceSlug: string; path: string }) {
  const t = useTranslations('duetApp.filesSurface')
  const { query, events, lookups, now, locale } = useFileActivityPages({
    workspaceSlug,
    enabled: true,
    kind: 'history',
    path,
  })
  const rows = useMemo(() => buildHistoryRows(events), [events])
  return (
    <TimelineScaffold
      pending={query.isPending}
      failed={isInitialCollectionError(query)}
      pageFailed={query.isFetchNextPageError}
      empty={rows.length === 0}
      labels={{
        empty: t('history.empty'),
        emptyBody: t('history.emptyBody'),
        failed: t('history.failed'),
        moreFailed: t('history.moreFailed'),
        loadMore: t('history.loadMore'),
        retryMore: t('history.retryMore'),
      }}
      onLoadMore={
        query.hasNextPage || query.isFetchNextPageError
          ? () => void query.fetchNextPage()
          : undefined
      }
      loadingMore={query.isFetchingNextPage}
    >
      {rows.map(row => (
        <HistoryRowView key={row.key} row={row} lookups={lookups} now={now()} locale={locale} />
      ))}
    </TimelineScaffold>
  )
}

function HistoryRowView({
  row,
  lookups,
  now,
  locale,
}: {
  row: HistoryRow
  lookups: ActorLookups
  now: number
  locale: string
}) {
  const t = useTranslations('duetApp.filesSurface')
  if (row.type === 'read-bucket') {
    const actor = formatActor(row.actor, row.userId, lookups)
    return (
      <AttributionRow
        time={relativeTimeLabel(row.lastAt, now, locale)}
        headline={
          <>
            <ActorChip actor={actor} />
            <span className="text-muted-foreground">{t('history.seenThisPeriod')}</span>
          </>
        }
      />
    )
  }
  const event = row.event
  const actor = formatActor(event.actor, event.userId, lookups)
  const { verbKey, magnitude } = historyLabels(event)
  return (
    <AttributionRow
      time={relativeTimeLabel(event.at, now, locale)}
      headline={
        <>
          <b className="font-semibold">{t(verbKey)}</b>
          {event.kind === 'restore' ? null : (
            <span className="text-muted-foreground">{t('history.by')}</span>
          )}
          <ActorChip actor={actor} />
        </>
      }
      meta={
        event.kind === 'rename' ? (
          <span className="font-mono">
            {event.fromPath} → {event.path}
          </span>
        ) : magnitude === undefined ? undefined : (
          <span className="text-muted-foreground">
            {t(magnitude.key, { count: String(magnitude.count) })}
          </span>
        )
      }
    />
  )
}

const HISTORY_VERB_KEY = {
  write: 'history.edited',
  create: 'history.created',
  delete: 'history.deleted',
  rename: 'history.renamed',
  restore: 'history.restored',
  read: 'history.seenThisPeriod',
  'changed-summary': 'history.edited',
  'viewed-summary': 'history.seenThisPeriod',
} as const satisfies Record<string, string>

/**
 * What a history row says, given that `count` means two different things.
 *
 * On a file row it is logical SAVES — consecutive writes inside the coalesce
 * window are one save, so the number is what a person did, not how many
 * `write()` syscalls the watcher saw. On a folded folder row it is DISTINCT
 * FILES. A count of one is left unsaid: every row would otherwise end in
 * "1 save".
 */
export function historyLabels(event: FileActivityEvent): {
  verbKey: string
  /** Magnitude, rendered as sub-text. One shape for every row that has one. */
  magnitude?: { key: string; count: number }
} {
  const verbKey = HISTORY_VERB_KEY[event.kind]
  if (event.kind === 'changed-summary' || event.kind === 'viewed-summary') {
    // A gateway fold counted raw events; only a server fold counted files.
    const key = summaryCountsFiles(event) ? 'history.files' : 'activity.summaryCount'
    return { verbKey, magnitude: { key, count: event.count } }
  }
  const saves = 'count' in event ? event.count : undefined
  return saves !== undefined && saves > 1
    ? { verbKey, magnitude: { key: 'history.saves', count: saves } }
    : { verbKey }
}
