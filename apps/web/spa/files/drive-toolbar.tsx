'use client'

/* ============================================================================
   The drive's control strip — the only bar of chrome the drive has.

   The trail leads it, the drive's own actions follow, and the view controls
   close it: one 48px row wherever they all fit, wrapping on narrow viewports.
   The trail used to have a bar of its own directly under this one, which put
   two rules and two gutters over a surface with one subject, and left the lower
   bar holding a single word across the whole width. Where you are is the first
   thing the row says, not a second row.

   Presentation only. Every value here is owned by the surface, including the
   per-group counts, which are counted over the open folder and nothing else:
   the drive has no recursive index, so a number covering the whole workspace
   would be a number nobody can stand behind.
   ========================================================================= */
import {
  CaretDownIcon,
  CaretRightIcon,
  FunnelIcon,
  HouseIcon,
  ListIcon,
  MagnifyingGlassIcon,
  RowsIcon,
  DotsThreeOutlineIcon,
  SortAscendingIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { ComponentType, ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'

import {
  DRIVE_FILTER_GROUPS,
  DRIVE_SORT_KEYS,
  type DriveFilter,
  type DriveFilterGroup,
  type DriveSortKey,
} from './column-rows'
import type { ColumnDensity } from './drive-column'
import { normalizeBrowserFilePath } from './lib/paths'

const GROUP_LABEL: Record<DriveFilterGroup, string> = {
  all: 'columns.groupAll',
  images: 'columns.groupImages',
  docs: 'columns.groupDocs',
  code: 'columns.groupCode',
  pdfs: 'columns.groupPdfs',
  media: 'columns.groupMedia',
}

const SORT_LABEL: Record<DriveSortKey, string> = {
  name: 'columns.sortName',
  modified: 'columns.sortModified',
  kind: 'columns.sortKind',
  size: 'columns.sortSize',
}

/**
 * The drive's control pill — one shape for everything in this strip, whichever
 * side of it the control lives on. The drive's own actions render into
 * `actions` from another module, so the class belongs to the strip that frames
 * them, not to either caller: a control that brings its own chrome reads as a
 * different kind of thing, which is how Activity came to look like a state.
 */
export const DRIVE_CONTROL =
  'flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50'

/**
 * Whether the drive *is* the page, or is a guest inside somebody else's surface.
 *
 * Named for the reason rather than the look, because the look follows from it:
 * on its own page the strip gets a 48px row it may wrap out of, and inside an
 * agent's card it is one of four views sharing that card with a conversation —
 * a fixed 40px that never grows, because every pixel it takes comes out of the
 * conversation. What the strip *draws* in that height is `DriveControls`.
 *
 * Not `density`: that word is taken, and it means how tall a *row* is.
 */
export type DriveChrome = 'page' | 'inline'

/**
 * How much of the strip is spent in the open, and how much is behind one mark.
 *
 * `full` draws the trail, the view controls, and one mark holding the drive's
 * own actions. `collapsed` keeps only the trail and the search and puts the
 * view controls behind that same mark — plus, in a card, the activity feed,
 * which keeps a pill of its own there because a status behind a menu is a
 * status nobody looks at and a card has room for exactly one more thing.
 *
 * Not the same question as `DriveChrome`, though a card always answers it the
 * same way. The page collapses too, whenever a document is open: the row then
 * has to carry that document's own header as well, and the listing which the
 * filters and the sort govern is a single narrow column by that point. The
 * controls that act on a rail step back for the thing the reader opened.
 */
export type DriveControls = 'full' | 'collapsed'

/**
 * One of the drive's own affordances — upload, create, show hidden.
 *
 * Described rather than rendered, because the strip draws them two ways and
 * both have to stay the same set: a pill in the row while the listing is the
 * subject, a menu item once the row has collapsed. Handing the toolbar finished
 * buttons is what made the second rendering impossible without a second list to
 * forget to update.
 */
export type DriveCommand = {
  key: string
  label: string
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  run: () => void
  disabled?: boolean
  /** a toggle rather than a one-shot, drawn as pressed and checked */
  pressed?: boolean
}

/**
 * The one search field, wherever the strip is drawn.
 *
 * It survives the collapse because a folder you cannot filter by name is a
 * folder you have to scroll, and scrolling is the thing a card the size of a
 * conversation pane has least of.
 */
function DriveSearch({
  filter,
  onFilterChange,
}: {
  filter: DriveFilter
  onFilterChange: (filter: DriveFilter) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <div className="relative min-w-40 flex-1 sm:flex-none">
      <MagnifyingGlassIcon
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={filter.search}
        aria-label={t('columns.searchPlaceholder')}
        placeholder={t('columns.searchPlaceholder')}
        onChange={event => onFilterChange({ ...filter, search: event.target.value })}
        className="h-8 w-full rounded-md border border-border/60 bg-transparent pl-7 pr-7 sm:w-40 text-xs placeholder:text-muted-foreground/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring lg:w-52 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {filter.search.length > 0 ? (
        <button
          type="button"
          aria-label={t('columns.clearSearch')}
          onClick={() => onFilterChange({ ...filter, search: '' })}
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

/* ---- the option groups, once ----
   Each renders the *contents* of a radio group and nothing around it, so the
   same options appear in the strip's own dropdown and inside the collapsed
   menu without either one holding a second copy of the list. */
function ShowOptions({
  filter,
  groupCounts,
  onFilterChange,
}: {
  filter: DriveFilter
  groupCounts: Record<DriveFilterGroup, number>
  onFilterChange: (filter: DriveFilter) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <DropdownMenuRadioGroup
      value={filter.group}
      onValueChange={value => onFilterChange({ ...filter, group: value as DriveFilterGroup })}
    >
      {DRIVE_FILTER_GROUPS.map(group => (
        <DropdownMenuRadioItem key={group} value={group} className="gap-2 text-xs">
          <span className="flex-1">{t(GROUP_LABEL[group])}</span>
          <span className="tabular-nums text-muted-foreground">{groupCounts[group]}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

function SortOptions({
  sort,
  onSortChange,
}: {
  sort: DriveSortKey
  onSortChange: (sort: DriveSortKey) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <DropdownMenuRadioGroup
      value={sort}
      onValueChange={value => onSortChange(value as DriveSortKey)}
    >
      {DRIVE_SORT_KEYS.map(key => (
        <DropdownMenuRadioItem key={key} value={key} className="text-xs">
          {t(SORT_LABEL[key])}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

const DENSITY_OPTIONS = [
  { value: 'comfortable', icon: RowsIcon, label: 'columns.densityComfortable' },
  { value: 'compact', icon: ListIcon, label: 'columns.densityCompact' },
] as const

function DensityOptions({
  density,
  onDensityChange,
}: {
  density: ColumnDensity
  onDensityChange: (density: ColumnDensity) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <DropdownMenuRadioGroup
      value={density}
      onValueChange={value => onDensityChange(value as ColumnDensity)}
    >
      {DENSITY_OPTIONS.map(option => (
        <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2 text-xs">
          <option.icon aria-hidden className="size-3.5" />
          {t(option.label)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/**
 * The drive's own affordances as menu items — the *only* rendering of them that
 * is not a pill, and the one both menus share.
 *
 * A second copy is how the two drifted before: a command added to the strip
 * quietly failed to appear behind the mark, and nothing said so.
 */
function CommandItems({ commands }: { commands: readonly DriveCommand[] }) {
  return (
    <>
      {commands.map(command =>
        command.pressed === undefined ? (
          <DropdownMenuItem
            key={command.key}
            disabled={command.disabled}
            onSelect={command.run}
            className="gap-2 text-xs"
          >
            <command.Icon aria-hidden className="size-3.5" />
            {command.label}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuCheckboxItem
            key={command.key}
            checked={command.pressed}
            disabled={command.disabled}
            onSelect={event => {
              /* The menu stays open: this is a view toggle and the reader is
                 very often about to reach for another one. */
              event.preventDefault()
              command.run()
            }}
            className="gap-2 text-xs"
          >
            {command.label}
          </DropdownMenuCheckboxItem>
        ),
      )}
    </>
  )
}

/**
 * The drive's own affordances, behind one mark, with the view controls left
 * drawn in the row beside it.
 *
 * What the strip spends its width on is the listing's shape — which folder,
 * which rows, in what order — and those stay in the open. Upload, create,
 * show-hidden and the activity feed are things you do *to* a folder, or read
 * about it, rather than ways of reading it here; five pills of them left the
 * row looking like a toolbar with a path stuck on the front.
 */
function DriveActionsMenu({ commands }: { commands: readonly DriveCommand[] }) {
  const t = useTranslations('duetApp.filesSurface')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-drive-actions
          aria-label={t('columns.actions')}
          className={cn(DRIVE_CONTROL, 'px-2')}
        >
          <DotsThreeOutlineIcon aria-hidden className="size-3.5" weight="fill" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <CommandItems commands={commands} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Everything the collapsed strip does not have room for, behind one mark.
 *
 * The commands first, then the three view groups, because that is the order the
 * page's own strip reads in left to right — a reader who learned the drive on
 * its own page finds the same things in the same sequence.
 */
function DriveMoreMenu({
  commands,
  filter,
  sort,
  density,
  groupCounts,
  onFilterChange,
  onSortChange,
  onDensityChange,
}: {
  commands: readonly DriveCommand[]
  filter: DriveFilter
  sort: DriveSortKey
  density: ColumnDensity
  groupCounts: Record<DriveFilterGroup, number>
  onFilterChange: (filter: DriveFilter) => void
  onSortChange: (sort: DriveSortKey) => void
  onDensityChange: (density: ColumnDensity) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const filtered = filter.group !== 'all'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-drive-more
          aria-label={t('columns.more')}
          className={cn(
            DRIVE_CONTROL,
            'px-2',
            filtered && 'border-primary/40 bg-primary/10 text-foreground',
          )}
        >
          <DotsThreeOutlineIcon aria-hidden className="size-3.5" weight="fill" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <CommandItems commands={commands} />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t('columns.show')}
        </DropdownMenuLabel>
        <ShowOptions filter={filter} groupCounts={groupCounts} onFilterChange={onFilterChange} />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t('columns.sort')}
        </DropdownMenuLabel>
        <SortOptions sort={sort} onSortChange={onSortChange} />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t('columns.density')}
        </DropdownMenuLabel>
        <DensityOptions density={density} onDensityChange={onDensityChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DriveToolbar({
  filter,
  sort,
  density,
  groupCounts,
  commands = [],
  activity,
  trail,
  chrome = 'page',
  controls = 'full',
  onFilterChange,
  onSortChange,
  onDensityChange,
}: {
  filter: DriveFilter
  sort: DriveSortKey
  density: ColumnDensity
  /** How many rows of the open folder fall in each group. */
  groupCounts: Record<DriveFilterGroup, number>
  /** The drive's own affordances — upload, create, show-hidden. */
  commands?: readonly DriveCommand[]
  /** the live feed's own trigger, which brings its own popover */
  activity?: ReactNode
  /**
   * The trail, and whatever the open document puts beside it.
   *
   * Leads the row wherever the drive is drawn. It is the answer to "which
   * folder is this", which is the question every other control in the strip
   * assumes you have already answered — so it reads first, and the row it once
   * had to itself is gone.
   */
  trail?: ReactNode
  /** whether the drive is the page or a guest — see `DriveChrome` */
  chrome?: DriveChrome
  /** how much of the strip is drawn in the open — see `DriveControls` */
  controls?: DriveControls
  onFilterChange: (filter: DriveFilter) => void
  onSortChange: (sort: DriveSortKey) => void
  onDensityChange: (density: ColumnDensity) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  const filtered = filter.group !== 'all'

  return (
    <div
      data-drive-toolbar
      data-drive-chrome={chrome}
      data-drive-controls={controls}
      className={cn(
        'flex shrink-0 items-center border-b border-border/50',
        chrome === 'inline'
          ? /* A fixed 40px and never a second line: this strip is one of four
               views sharing a card with a conversation, and a row that grows
               takes that height from the conversation. Collapsed, it has
               nothing left to wrap. */
            'h-10 gap-2 px-3'
          : /* Narrow viewports cannot hold the whole set in one 48px row, and a
               strip that scrolls sideways hides half of it behind a gesture
               nobody is told about. So it wraps: the trail and the drive's
               actions take the first line, the view controls the next, and the
               strip is only a fixed 48px once all of it fits. */
            'flex-wrap gap-2 px-3 py-2 sm:h-12 sm:flex-nowrap sm:gap-3 sm:py-0',
      )}
    >
      {trail}

      {/* Collapsed, the strip keeps the trail's two companions — the search,
          because a folder you cannot filter by name is a folder you have to
          scroll, and the activity feed, because it is a live readout rather
          than an action and a status nobody can see is not a status. Everything
          else is one mark away. */}
      {controls === 'collapsed' ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <DriveSearch filter={filter} onFilterChange={onFilterChange} />
          {activity}
          <DriveMoreMenu
            commands={commands}
            filter={filter}
            sort={sort}
            density={density}
            groupCounts={groupCounts}
            onFilterChange={onFilterChange}
            onSortChange={onSortChange}
            onDensityChange={onDensityChange}
          />
        </div>
      ) : (
        <>
          {/* The trail alone at the near end, one cluster at the far one, and
              the widest gap on the row between them — a cheaper way to say
              "where you are" and "what you can do" are different kinds of thing
              than a rule or a pill sitting against the path. The trail grows
              into that gap (`sm:flex-1` on its wrapper), so the cluster stays
              flush right whatever the path is.

              `activity` renders here and draws nothing on this chrome: its
              opener is an item in the actions menu, and what is left is the
              drawer it opens, which has to stay mounted somewhere the menu
              closing cannot take with it. */}
          {activity}

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:shrink-0">
            <DriveActionsMenu commands={commands} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('columns.show')}
                  className={cn(
                    DRIVE_CONTROL,
                    filtered
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <FunnelIcon
                    aria-hidden
                    className="size-3.5 shrink-0"
                    weight={filtered ? 'fill' : 'regular'}
                  />
                  <span className="font-medium">{t('columns.show')}</span>
                  {filtered ? (
                    <span className="text-muted-foreground">{t(GROUP_LABEL[filter.group])}</span>
                  ) : null}
                  <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <ShowOptions
                  filter={filter}
                  groupCounts={groupCounts}
                  onFilterChange={onFilterChange}
                />
              </DropdownMenuContent>
            </DropdownMenu>

            <DriveSearch filter={filter} onFilterChange={onFilterChange} />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={t('columns.sort')} className={cn(DRIVE_CONTROL)}>
                  <SortAscendingIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="font-medium">{t(SORT_LABEL[sort])}</span>
                  <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <SortOptions sort={sort} onSortChange={onSortChange} />
              </DropdownMenuContent>
            </DropdownMenu>

            <div
              role="group"
              aria-label={t('columns.density')}
              className="flex h-11 items-center rounded-md border border-border/60 p-0.5 md:h-8"
            >
              {DENSITY_OPTIONS.map(option => {
                const OptionIcon = option.icon
                const selected = density === option.value
                return (
                  /* Icon-only, and two glyphs that differ by a couple of lines: the
                 tooltip is where each one says which it is. */
                  <Tooltip key={option.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        /* Anchored structurally: this control's only words are its
                       label, and a test that reaches for them breaks the next
                       time the copy is improved. */
                        data-drive-density={option.value}
                        aria-pressed={selected}
                        aria-label={t(option.label)}
                        onClick={() => onDensityChange(option.value)}
                        className={cn(
                          /* A finger's square below `md`, the pointer's 28 above.
                             The words for these two glyphs are not lost on a
                             phone — the toolbar's overflow menu carries the same
                             choice spelled out, and the tooltip here is the
                             pointer's shortcut to it rather than its only home. */
                          'grid h-10 w-10 place-items-center rounded transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring md:size-7',
                          selected
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <OptionIcon aria-hidden className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t(option.label)}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The open path, leading the control strip.
 *
 * Long chains collapse from the middle rather than scrolling: the root and the
 * last two folders are what orient you, and an ellipsis is a more honest cue
 * that something is hidden than a trail that silently runs off its edge.
 */
export function DrivePathBreadcrumb({
  path,
  onNavigate,
}: {
  path: string
  onNavigate: (path: string) => void
}) {
  const t = useTranslations('duetApp.filesSurface')
  let segments: string[]
  try {
    const normalized = normalizeBrowserFilePath(path, true)
    segments = normalized.length === 0 ? [] : normalized.split('/')
  } catch {
    segments = []
  }

  const crumbs = segments.map((segment, index) => ({
    name: segment,
    path: `/${segments.slice(0, index + 1).join('/')}`,
  }))
  const collapsed = crumbs.length > 3
  const shown = collapsed ? crumbs.slice(-2) : crumbs

  return (
    <nav
      aria-label={t('columns.breadcrumb')}
      data-drive-breadcrumb
      /* No rule and no gutter of its own: the strip this sits in draws one
         across the whole split and owns the padding at both ends. A trail that
         brought its own would sit a control's width in from an edge every other
         control in the row is flush against. */
      className="flex h-8 min-w-0 items-center gap-1 text-xs text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => onNavigate('/')}
        className="flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <HouseIcon aria-hidden className="size-3.5" />
        <span className="font-medium">{t('files')}</span>
      </button>
      {collapsed ? (
        <>
          <CaretRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
          <span className="px-1 text-muted-foreground/60">…</span>
        </>
      ) : null}
      {shown.map((crumb, index) => (
        <span key={crumb.path} className="flex min-w-0 items-center gap-1">
          <CaretRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
          <button
            type="button"
            onClick={() => onNavigate(crumb.path)}
            className={cn(
              'max-w-40 truncate rounded px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              index === shown.length - 1 && 'font-medium text-foreground',
            )}
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </nav>
  )
}
