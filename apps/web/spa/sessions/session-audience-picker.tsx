'use client'

import { CaretDown, Check, CircleNotch, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  normalizeWorkspaceMemberSearch,
  type AgentStartSessionRequestInput,
  type WorkspaceMember,
} from '@repo/contract'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/shadcn/popover'
import { cn } from '@repo/ui/lib/utils'

import { useCollectionContinuation } from '../api/collection-continuation'
import { duetQueryOptions, WORKSPACE_MEMBER_SEARCH_PAGE_SIZE } from '../api/query-options'
import { useSpa } from '../context'

export type SessionAudienceMode = 'workspace' | 'specific' | 'personal'

export type SelectedAudienceMember = Pick<WorkspaceMember, 'id' | 'email' | 'name'>

export function audiencePreviewMembers(
  creator: SelectedAudienceMember,
  selected: readonly SelectedAudienceMember[],
): {
  members: SelectedAudienceMember[]
  count: number
  overflow: number
} {
  const byId = new Map<string, SelectedAudienceMember>([[creator.id, creator]])
  for (const member of selected) byId.set(member.id, member)
  const people = [...byId.values()]
  const members = people.slice(0, 4)
  return {
    members,
    count: people.length,
    overflow: people.length - members.length,
  }
}

export function audienceCollectionState(
  itemCount: number,
  hasNextPage: boolean,
  pageFailed: boolean,
): 'empty' | 'incomplete' | 'rows' {
  if (itemCount > 0) return 'rows'
  return hasNextPage || pageFailed ? 'incomplete' : 'empty'
}

export function effectiveAudienceIds(
  creatorId: string,
  selectedUserIds: readonly string[],
): string[] {
  return [...new Set([creatorId, ...selectedUserIds])].sort()
}

export function audienceRequest(
  mode: SessionAudienceMode,
  creatorId: string,
  selectedUserIds: readonly string[],
): AgentStartSessionRequestInput['audience'] {
  if (mode === 'workspace') return undefined
  return {
    kind: 'specific',
    // The API derives and inserts the authenticated human. Personal mode
    // therefore sends no additional people, regardless of a preserved picker
    // selection the reader may return to later.
    memberUserIds:
      mode === 'personal'
        ? []
        : [...new Set(selectedUserIds.filter(id => id !== creatorId))].sort(),
  }
}

export function audienceRequestKey(
  mode: SessionAudienceMode,
  creatorId: string,
  selectedUserIds: readonly string[],
): string {
  return mode === 'workspace'
    ? 'workspace'
    : `specific:${effectiveAudienceIds(creatorId, mode === 'personal' ? [] : selectedUserIds).join(
        ',',
      )}`
}

export function SessionAudiencePicker({
  workspaceSlug,
  mode,
  members,
  creator,
  duetName,
  disabled,
  variant = 'default',
  onModeChange,
  onToggleMember,
}: {
  workspaceSlug: string
  mode: SessionAudienceMode
  members: readonly SelectedAudienceMember[]
  creator: SelectedAudienceMember
  duetName: string
  disabled: boolean
  variant?: 'default' | 'compact'
  onModeChange: (mode: SessionAudienceMode) => void
  onToggleMember: (member: SelectedAudienceMember) => void
}) {
  const t = useTranslations('duetApp.sessionProduct.audience')
  const { api } = useSpa()
  const [open, setOpen] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const continuationRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const search = normalizeWorkspaceMemberSearch(searchInput)
  const query = useInfiniteQuery({
    ...duetQueryOptions.workspaces.memberSearch(api, workspaceSlug, search),
    enabled: open && mode === 'specific',
  })
  const continuation = useCollectionContinuation(query)
  const results = useMemo(() => {
    const byId = new Map<string, WorkspaceMember>()
    for (const member of query.data?.pages.flatMap(page => page.items) ?? []) {
      byId.set(member.id, member)
    }
    return [...byId.values()]
  }, [query.data])
  const firstSelectableIndex = Math.max(
    0,
    results.findIndex(member => member.id !== creator.id),
  )
  const selectedIds = useMemo(() => new Set(members.map(member => member.id)), [members])
  const initialError = query.isError && query.data === undefined
  const pageError = query.isFetchNextPageError || (query.isError && query.data !== undefined)
  const retryLoadedResults = query.isFetchNextPageError
    ? continuation.load
    : () => void query.refetch()
  const resultState = audienceCollectionState(results.length, query.hasNextPage, pageError)
  const compact = variant === 'compact'
  const preview = useMemo(() => audiencePreviewMembers(creator, members), [creator, members])

  const closeAndRestoreFocus = () => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useEffect(() => {
    if (open) setActiveIndex(firstSelectableIndex)
  }, [firstSelectableIndex, open, search])
  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [activeIndex, results.length])
  useEffect(() => {
    if (
      open &&
      mode === 'specific' &&
      results.length < WORKSPACE_MEMBER_SEARCH_PAGE_SIZE &&
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !pageError
    ) {
      continuation.load()
    }
  }, [
    continuation,
    mode,
    open,
    pageError,
    query.hasNextPage,
    query.isFetchingNextPage,
    results.length,
  ])
  useEffect(() => {
    const target = continuationRef.current
    if (
      !open ||
      mode !== 'specific' ||
      target === null ||
      results.length < WORKSPACE_MEMBER_SEARCH_PAGE_SIZE ||
      !query.hasNextPage ||
      query.isFetchingNextPage ||
      pageError
    ) {
      return
    }
    let requested = false
    const requestNext = () => {
      if (requested) return
      requested = true
      continuation.load()
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) requestNext()
      },
      { root: listboxRef.current, rootMargin: '96px 0px' },
    )
    observer.observe(target)
    return () => {
      observer.disconnect()
    }
  }, [
    continuation,
    mode,
    open,
    pageError,
    query.hasNextPage,
    query.isFetchingNextPage,
    results.length,
  ])
  const toggleResult = (member: WorkspaceMember | undefined) => {
    if (member === undefined || member.id === creator.id) return
    onToggleMember(member)
  }

  const resultAnnouncement = query.isFetchingNextPage
    ? t('loadingMore')
    : pageError
      ? t('loadMoreError')
      : query.isPending
        ? t('loading')
        : initialError
          ? t('loadError')
          : resultState === 'empty'
            ? t('zeroMatches')
            : resultState === 'incomplete'
              ? t('noPeopleLoaded')
              : t('resultCount', { count: results.length })

  return (
    <section
      className={cn(compact ? 'space-y-1.5' : 'space-y-2 px-1')}
      data-session-audience-picker
      data-variant={variant}
    >
      <fieldset disabled={disabled} className={cn(!compact && 'space-y-1.5')}>
        <legend className={cn('text-xs font-medium text-foreground', compact && 'sr-only')}>
          {t('label')}
        </legend>
        <div
          role="radiogroup"
          aria-label={t('label')}
          className={cn(
            'grid min-h-11 w-full grid-cols-3 rounded-lg border border-border/70 bg-muted/40 p-1',
            compact && 'min-h-0 flex-1 rounded-md border-0 bg-transparent p-0',
          )}
        >
          {(['workspace', 'specific', 'personal'] as const).map(option => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={cn(
                'min-h-11 min-w-0 rounded-md px-3 text-xs font-medium leading-tight transition-colors',
                compact && 'min-h-7 rounded px-1 text-[11px] whitespace-nowrap sm:px-2 sm:text-xs',
                mode === option
                  ? compact
                    ? 'bg-background text-foreground shadow-xs ring-1 ring-border/70'
                    : 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => onModeChange(option)}
            >
              <span className="block truncate">
                {option === 'personal' ? t('personal', { name: duetName }) : t(option)}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <p className={cn('text-xs text-muted-foreground', compact && 'sr-only')} aria-live="polite">
        {mode === 'workspace'
          ? t('workspaceStatement')
          : mode === 'personal'
            ? t('personalStatement', { name: duetName })
            : t('specificStatement', { count: members.length })}
      </p>

      {mode === 'specific' ? (
        <div className={cn('space-y-2', compact && 'pt-0.5')}>
          {compact ? null : (
            <div
              className="flex min-w-0 flex-nowrap gap-1.5 overflow-x-auto pb-1"
              data-audience-selected
            >
              <AudienceChip member={creator} detail={t('creator')} />
              {members
                .filter(member => member.id !== creator.id)
                .map(member => (
                  <AudienceChip
                    key={member.id}
                    member={member}
                    detail={member.email}
                    removeLabel={t('remove', {
                      name: member.name?.trim() || member.email,
                    })}
                    onRemove={() => onToggleMember(member)}
                  />
                ))}
            </div>
          )}

          <Popover
            open={open}
            onOpenChange={next => {
              if (!disabled) setOpen(next)
            }}
          >
            <PopoverTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label={t('trigger', { count: members.length })}
                aria-expanded={open}
                disabled={disabled}
                className="flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border/70 bg-background px-3 text-left text-sm hover:bg-muted/40 disabled:opacity-60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {compact ? <AudiencePreview preview={preview} /> : null}
                  <span className="min-w-0 truncate">{t('trigger', { count: preview.count })}</span>
                </span>
                <CaretDown className="size-4 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              data-session-audience-popover
              align="start"
              side="top"
              collisionPadding={12}
              className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden p-0"
              onEscapeKeyDown={event => {
                event.preventDefault()
                event.stopPropagation()
                closeAndRestoreFocus()
              }}
            >
              <label className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3">
                <MagnifyingGlass className="size-4 shrink-0 text-muted-foreground" />
                <span className="sr-only">{t('search')}</span>
                <input
                  type="search"
                  role="combobox"
                  value={searchInput}
                  maxLength={32}
                  autoFocus
                  placeholder={t('search')}
                  aria-autocomplete="list"
                  aria-controls={listboxId}
                  aria-expanded="true"
                  aria-activedescendant={
                    results[activeIndex] === undefined
                      ? undefined
                      : `${listboxId}-option-${activeIndex}`
                  }
                  className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={event => setSearchInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      closeAndRestoreFocus()
                      return
                    }
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      event.stopPropagation()
                      setActiveIndex(current => {
                        const delta = event.key === 'ArrowDown' ? 1 : -1
                        let next = current
                        while (true) {
                          const candidate = Math.max(0, Math.min(results.length - 1, next + delta))
                          if (candidate === next) return current
                          next = candidate
                          if (results[next]?.id !== creator.id) return next
                        }
                      })
                      return
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      toggleResult(results[activeIndex])
                    }
                  }}
                />
              </label>

              <p className="sr-only" role="status" aria-live="polite">
                {resultAnnouncement}
              </p>
              <div
                id={listboxId}
                ref={listboxRef}
                role="listbox"
                aria-label={t('results')}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 scroll-pb-24"
              >
                {query.isPending ? (
                  <AudienceState
                    icon={<CircleNotch className="animate-spin" />}
                    text={t('loading')}
                  />
                ) : initialError ? (
                  <AudienceState
                    text={t('loadError')}
                    action={
                      <button
                        type="button"
                        className="min-h-11 rounded-md px-3 text-sm font-medium text-brand"
                        onClick={() => void query.refetch()}
                      >
                        {t('retry')}
                      </button>
                    }
                  />
                ) : resultState !== 'rows' ? (
                  <AudienceState
                    text={t(resultState === 'incomplete' ? 'noPeopleLoaded' : 'zeroMatches')}
                    action={
                      resultState !== 'incomplete' || !pageError ? undefined : (
                        <button
                          type="button"
                          disabled={query.isFetchingNextPage}
                          className="min-h-11 rounded-md px-3 text-sm font-medium text-brand"
                          onClick={retryLoadedResults}
                        >
                          {t('retry')}
                        </button>
                      )
                    }
                  />
                ) : (
                  <>
                    {results.map((member, index) => {
                      const creatorRow = member.id === creator.id
                      const selected = selectedIds.has(member.id)
                      return (
                        <button
                          key={member.id}
                          id={`${listboxId}-option-${index}`}
                          ref={element => {
                            optionRefs.current[index] = element
                          }}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          aria-disabled={creatorRow}
                          disabled={creatorRow}
                          className={cn(
                            'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none',
                            index === activeIndex && 'bg-accent text-accent-foreground',
                            creatorRow && 'opacity-70',
                          )}
                          onPointerMove={() => setActiveIndex(index)}
                          onClick={() => toggleResult(member)}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
                            {audienceInitial(member)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {member.name?.trim() || member.email}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {member.email}
                            </span>
                          </span>
                          {selected ? <Check className="size-4 shrink-0" /> : null}
                        </button>
                      )
                    })}
                    {pageError ? (
                      <AudienceState
                        text={t('loadMoreError')}
                        action={
                          <button
                            type="button"
                            className="min-h-11 rounded-md px-3 text-sm font-medium text-brand"
                            onClick={retryLoadedResults}
                          >
                            {t('retry')}
                          </button>
                        }
                      />
                    ) : null}
                  </>
                )}
                {query.hasNextPage && !pageError ? (
                  <div
                    ref={continuationRef}
                    aria-hidden={!query.isFetchingNextPage}
                    className="flex min-h-8 items-center justify-center gap-2 text-xs text-muted-foreground"
                  >
                    {query.isFetchingNextPage ? (
                      <>
                        <CircleNotch className="size-3.5 animate-spin" />
                        <span>{t('loadingMore')}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
    </section>
  )
}

function AudiencePreview({ preview }: { preview: ReturnType<typeof audiencePreviewMembers> }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1.5" data-audience-summary>
      {preview.members.map(member => (
        <span
          key={member.id}
          title={member.name?.trim() || member.email}
          className="grid size-6 place-items-center rounded-full border-2 border-background bg-muted text-[9px] font-bold text-foreground shadow-sm ring-1 ring-border/80"
        >
          {audienceInitial(member, 2)}
        </span>
      ))}
      {preview.overflow > 0 ? (
        <span className="grid size-6 place-items-center rounded-full border-2 border-background bg-muted-foreground text-[9px] font-semibold text-background shadow-sm ring-1 ring-border/80">
          +{preview.overflow}
        </span>
      ) : null}
    </span>
  )
}

function AudienceChip({
  member,
  detail,
  removeLabel,
  onRemove,
}: {
  member: SelectedAudienceMember
  detail: string
  removeLabel?: string
  onRemove?: () => void
}) {
  return (
    <span className="flex min-h-11 min-w-0 max-w-[min(100%,18rem)] shrink-0 items-center gap-2 rounded-full border border-border/70 bg-muted/45 py-1 pl-2 pr-1.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand/10 text-[11px] font-semibold text-brand">
        {audienceInitial(member)}
      </span>
      <span className="min-w-0 max-w-52">
        <span className="block truncate text-xs font-medium">
          {member.name?.trim() || member.email}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">{detail}</span>
      </span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={removeLabel}
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  )
}

function AudienceState({
  icon,
  text,
  action,
}: {
  icon?: React.ReactNode
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 px-4 py-3 text-center text-sm text-muted-foreground">
      {icon}
      <span>{text}</span>
      {action}
    </div>
  )
}

function audienceInitial(member: SelectedAudienceMember, length = 1): string {
  const label = member.name?.trim() || member.email
  if (length === 1) return label.slice(0, 1).toLocaleUpperCase()
  return label
    .split(/[\s@._-]+/)
    .slice(0, length)
    .map(part => part.slice(0, 1))
    .join('')
    .toLocaleUpperCase()
}
