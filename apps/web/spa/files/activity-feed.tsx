'use client'

import { PulseIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useMemo, useState } from 'react'

import { summaryCountsFiles } from '@repo/contract'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/shadcn/sheet'
import { cn } from '@repo/ui/lib/utils'

import { isInitialCollectionError } from '../api/query-options'
import {
  ActorChip,
  AttributionRow,
  TimelineScaffold,
  formatActor,
  relativeTimeLabel,
  useFileActivityPages,
  type ActorLookups,
} from './attribution'
import { DRIVE_CONTROL } from './drive-toolbar'
import { fileName } from './lib/paths'
import { buildFeedRows, type FeedRow } from './lib/timeline'

// Workspace activity feed (slice 12, directions C+D): the workspaceActivity
// query mounted from the files route. Adjacent same-actor writes group into
// one "edited N files" row, but renames/deletes/restores — and every terminal
// and mirror write — stay their own visible row (the mirror-honesty firewall).
// Rows navigate to the file where the path still exists; deleted/restore rows
// have nowhere live to go and are inert. Convex reactivity is the product
// transport; this surface never consumes the slice-17 SSE feed.

export function ActivityFeed({
  workspaceSlug,
  path,
  scope,
  onNavigate,
  compact = false,
  control,
}: {
  workspaceSlug: string
  path?: string
  scope?: 'exact' | 'subtree'
  onNavigate?: (browserPath: string) => void
  /**
   * Drop the word and keep the pulse.
   *
   * Inside a card the drive's strip is search, this, and one mark — so this one
   * spends its label. It keeps its place rather than folding into the mark
   * beside it, because it is a live readout rather than a command: a status
   * behind a menu is a status nobody looks at. The word survives as the
   * accessible name, which is where it was already doing the real work.
   */
  compact?: boolean
  /**
   * Somebody else owns the opener, so this renders only the drawer.
   *
   * One prop for both facts, because they are the same fact. Where the drive
   * spends its whole strip on the listing, the feed's opener is an item in the
   * actions menu — and a menu item cannot own this drawer, because selecting it
   * closes the menu and unmounts everything inside it, drawer included. So the
   * opener goes in the menu and the drawer stays out here, and the state that
   * joins them belongs to the surface that renders both.
   */
  control?: { open: boolean; onOpenChange: (open: boolean) => void }
}) {
  const t = useTranslations('duetApp.filesSurface')
  const own = useState(false)
  const open = control?.open ?? own[0]
  const setOpen = control?.onOpenChange ?? own[1]
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {control === undefined ? (
        <SheetTrigger asChild>
          {/* The same pill as the drive's other actions: drawn as a shadcn
              button it came out taller and darker than its neighbours, which
              reads as a state nothing explains. */}
          <button
            type="button"
            className={cn(DRIVE_CONTROL, 'min-w-0', compact && 'px-2')}
            aria-label={t('activity.open')}
          >
            <PulseIcon aria-hidden className="size-3.5" />
            {compact ? null : <span className="font-medium">{t('activity.open')}</span>}
          </button>
        </SheetTrigger>
      ) : null}
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="space-y-1 border-b px-4 py-3 pr-12 text-left">
          <SheetTitle className="text-sm">{t('activity.title')}</SheetTitle>
          <SheetDescription className="text-xs">
            {path === undefined
              ? t('activity.subtitle')
              : scope === 'subtree'
                ? t('activity.subtitleFolderNamed', { path })
                : t('activity.subtitleFile')}
          </SheetDescription>
        </SheetHeader>
        {open ? (
          <ActivityFeedBody
            workspaceSlug={workspaceSlug}
            path={path}
            scope={scope}
            onNavigate={browserPath => {
              setOpen(false)
              onNavigate?.(browserPath)
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ActivityFeedBody({
  workspaceSlug,
  path,
  scope,
  onNavigate,
}: {
  workspaceSlug: string
  path?: string
  scope?: 'exact' | 'subtree'
  onNavigate: (browserPath: string) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const { query, events, lookups, now, locale } = useFileActivityPages({
    workspaceSlug,
    enabled: true,
    kind: 'activity',
    ...(path === undefined ? {} : { path }),
    ...(scope === undefined ? {} : { scope }),
  })
  const rows = useMemo(() => buildFeedRows(events, 'desc'), [events])
  return (
    <TimelineScaffold
      pending={query.isPending}
      failed={isInitialCollectionError(query)}
      pageFailed={query.isFetchNextPageError}
      empty={rows.length === 0}
      labels={{
        empty: t('activity.empty'),
        emptyBody: t(
          path === undefined
            ? 'activity.emptyBody'
            : scope === 'subtree'
              ? 'activity.emptyBodyFolder'
              : 'activity.emptyBodyFile',
        ),
        failed: t('activity.failed'),
        moreFailed: t('activity.moreFailed'),
        loadMore: t('activity.loadMore'),
        retryMore: t('activity.retryMore'),
      }}
      onLoadMore={
        query.hasNextPage || query.isFetchNextPageError
          ? () => void query.fetchNextPage()
          : undefined
      }
      loadingMore={query.isFetchingNextPage}
    >
      {rows.map(row => (
        <FeedRowView
          key={row.key}
          row={row}
          lookups={lookups}
          now={now()}
          locale={locale}
          scoped={path !== undefined}
          onNavigate={onNavigate}
        />
      ))}
    </TimelineScaffold>
  )
}

/**
 * A grouped row standing for exactly one event can still carry a save count:
 * the server folds repeated saves of one file into a single event, so the
 * number lives on the event rather than in the length of the group. Kept
 * consistent with the file-history pane, which states the same fact.
 */
function singleRowSaves(row: Extract<FeedRow, { type: 'group' }>): number | undefined {
  const event = row.events[0]?.event
  const count = event !== undefined && 'count' in event ? event.count : undefined
  return count !== undefined && count > 1 ? count : undefined
}

function FeedRowView({
  row,
  lookups,
  now,
  locale,
  scoped,
  onNavigate,
}: {
  row: FeedRow
  lookups: ActorLookups
  now: number
  locale: string
  scoped: boolean
  onNavigate: (browserPath: string) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  if (row.type === 'group') {
    const actor = formatActor(row.actor, row.userId, lookups)
    const single = row.events.length === 1
    const verb =
      row.category === 'read'
        ? t('activity.viewed')
        : row.allCreates
          ? t('activity.created')
          : t('activity.edited')
    const countKey =
      row.category === 'read'
        ? 'activity.readCount'
        : row.allCreates
          ? 'activity.createdCount'
          : 'activity.editedCount'
    return (
      <AttributionRow
        time={relativeTimeLabel(row.latestAt, now, locale)}
        onNavigate={() => onNavigate(`/${row.paths[0]}`)}
        headline={
          <>
            <ActorChip actor={actor} />
            {single ? (
              <>
                <span className="text-muted-foreground">{verb}</span>
                <b className="font-semibold">
                  {scoped ? `/${row.paths[0]}` : fileName(row.paths[0]!)}
                </b>
              </>
            ) : (
              <b className="font-semibold">{t(countKey, { count: String(row.events.length) })}</b>
            )}
          </>
        }
        meta={
          single ? (
            singleRowSaves(row) === undefined ? undefined : (
              <span className="text-muted-foreground">
                {t('history.saves', { count: String(singleRowSaves(row)) })}
              </span>
            )
          ) : (
            <span className="font-mono">{row.paths.join(' · ')}</span>
          )
        }
      />
    )
  }
  const event = row.event
  const actor = formatActor(event.actor, event.userId, lookups)
  if (event.kind === 'changed-summary' || event.kind === 'viewed-summary') {
    return (
      <AttributionRow
        time={relativeTimeLabel(event.at, now, locale)}
        onNavigate={() => onNavigate(`/${event.path}`)}
        headline={
          <>
            <ActorChip actor={actor} />
            <span className="text-muted-foreground">
              {t(
                event.kind === 'changed-summary'
                  ? 'activity.changedSummary'
                  : 'activity.viewedSummary',
              )}
            </span>
            <span>
              <b className="font-semibold">{scoped ? `/${event.path}` : event.path}</b>
              <span className="text-muted-foreground">&nbsp;— </span>
              {t(summaryCountsFiles(event) ? 'history.files' : 'activity.summaryCount', {
                count: String(event.count),
              })}
            </span>
          </>
        }
      />
    )
  }
  if (event.kind === 'rename') {
    return (
      <AttributionRow
        time={relativeTimeLabel(event.at, now, locale)}
        onNavigate={() => onNavigate(`/${event.path}`)}
        headline={
          <>
            <ActorChip actor={actor} />
            <span className="text-muted-foreground">{t('activity.renamed')}</span>
          </>
        }
        meta={
          <span className="font-mono">
            {event.fromPath} → {event.path}
          </span>
        }
      />
    )
  }
  if (event.kind === 'delete') {
    return (
      <AttributionRow
        time={relativeTimeLabel(event.at, now, locale)}
        headline={
          <>
            <ActorChip actor={actor} />
            <span className="text-muted-foreground">{t('activity.deleted')}</span>
            <b className="font-semibold">{fileName(event.path)}</b>
          </>
        }
      />
    )
  }
  return (
    <AttributionRow
      time={relativeTimeLabel(event.at, now, locale)}
      headline={
        <>
          <ActorChip actor={actor} />
          <span className="text-muted-foreground">{t('activity.restored')}</span>
        </>
      }
    />
  )
}
