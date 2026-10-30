'use client'

import { CaretDown, Check, CircleNotch, Plus, Users, X } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  normalizeWorkspaceMemberSearch,
  type SessionAudience,
  type SessionAudienceDeltaRequest,
  type SessionAudienceMemberPreview,
  type SessionSnapshot,
  type WorkspaceMember,
} from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/shadcn/dialog'
import { cn } from '@repo/ui/lib/utils'

import { DuetApiError } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { UserAvatar } from '../identity/identity-avatar'
import { audienceCollectionState } from './session-audience-picker'
import { commitRemovedSessionCache } from './session-cache'
import { sessionQueryOptions, useUpdateSessionAudience } from './session-data'

const MOBILE_AUDIENCE_PREVIEW_LIMIT = 2

export function SessionAudiencePreview({
  audience,
  workspaceMembers,
}: {
  audience: SessionAudience
  workspaceMembers?: readonly SessionAudienceMemberPreview[] | null
}) {
  const t = useTranslations('duetApp.sessionProduct.audience')
  if (audience.kind === 'workspace' && workspaceMembers === null) {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5"
        data-audience-preview-state="unavailable"
        data-session-audience-preview
      >
        <span className="grid size-6 place-items-center rounded-[28%] bg-muted text-muted-foreground">
          <Users className="size-3.5" aria-hidden />
        </span>
        <CaretDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </span>
    )
  }
  const count = audience.kind === 'specific' ? audience.count : workspaceMembers?.length
  const preview = (
    audience.kind === 'specific' ? audience.preview : (workspaceMembers ?? [])
  ).slice(0, 5)
  if (count === undefined) {
    return (
      <span className="flex shrink-0 -space-x-1" aria-hidden data-session-audience-preview>
        {Array.from({ length: 3 }, (_, index) => (
          <span
            key={index}
            className="size-7 animate-pulse rounded-[28%] border-2 border-background bg-muted motion-reduce:animate-none"
          />
        ))}
      </span>
    )
  }
  const mobileOverflow = Math.max(
    0,
    count - Math.min(preview.length, MOBILE_AUDIENCE_PREVIEW_LIMIT),
  )
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-session-audience-preview>
      <span className="flex shrink-0 -space-x-1" aria-hidden>
        {preview.map((member, index) => (
          <UserAvatar
            key={member.memberId}
            title={member.name}
            className={cn(
              'size-7 border-2 border-background shadow-sm ring-1 ring-black/10',
              index < MOBILE_AUDIENCE_PREVIEW_LIMIT ? 'block' : 'hidden sm:block',
            )}
            name={member.name}
          />
        ))}
        {mobileOverflow > 0 ? (
          <span className="grid size-7 place-items-center rounded-[28%] border-2 border-background bg-muted text-[9px] font-semibold text-muted-foreground shadow-sm ring-1 ring-black/10 sm:hidden">
            +{mobileOverflow}
          </span>
        ) : null}
      </span>
      <span className="hidden truncate text-xs text-muted-foreground sm:inline">
        {t('headerCount', { count })}
      </span>
      <CaretDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </span>
  )
}

type SessionAudienceManagerProps = {
  workspaceSlug: string
  snapshot: SessionSnapshot
  onPutAway: () => void
}

export function SessionAudienceManager(props: SessionAudienceManagerProps) {
  return (
    <SessionAudienceManagerForSession
      key={`${props.workspaceSlug}:${props.snapshot.id}`}
      {...props}
    />
  )
}

function SessionAudienceManagerForSession({
  workspaceSlug,
  snapshot,
  onPutAway,
}: SessionAudienceManagerProps) {
  const t = useTranslations('duetApp.sessionProduct.audience')
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<{
    delta: SessionAudienceDeltaRequest
    staleAudience: boolean
  }>()
  const mounted = useRef(true)
  const workspaceAudienceQuery = useQuery({
    ...duetQueryOptions.workspaces.members(api, workspaceSlug),
    enabled: snapshot.audience.kind === 'workspace',
    retry: false,
  })
  const audienceQuery = useInfiniteQuery({
    ...sessionQueryOptions.audience(api, workspaceSlug, snapshot.id),
    enabled: open && snapshot.audience.kind === 'specific',
    retry: false,
  })
  const update = useUpdateSessionAudience(workspaceSlug, snapshot.id)
  const specificRows = useMemo(
    () => audienceQuery.data?.pages.flatMap(page => page.items) ?? [],
    [audienceQuery.data],
  )
  const workspaceRows = useMemo(
    () =>
      (workspaceAudienceQuery.data?.items ?? []).map(member => ({
        memberId: member.id,
        userId: member.id,
        name: member.name?.trim() || member.email,
        email: member.email,
        role: member.role,
      })),
    [workspaceAudienceQuery.data],
  )
  const specificAudience = snapshot.audience.kind === 'specific' ? snapshot.audience : undefined
  const specific = specificAudience !== undefined
  const rows = specific ? specificRows : workspaceRows
  const currentState = audienceCollectionState(
    rows.length,
    specific && audienceQuery.hasNextPage,
    specific && audienceQuery.isFetchNextPageError,
  )
  const accessGone = useCallback(() => {
    setOpen(false)
    commitRemovedSessionCache(queryClient, workspaceSlug, snapshot.id)
    onPutAway()
  }, [onPutAway, queryClient, snapshot.id, workspaceSlug])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (audienceQuery.error instanceof DuetApiError && audienceQuery.error.status === 404) {
      accessGone()
    }
  }, [accessGone, audienceQuery.error])

  const apply = async (delta: SessionAudienceDeltaRequest) => {
    setFailure(undefined)
    try {
      const summary = await update.mutateAsync(delta)
      if (!mounted.current) return
      if (summary === null) {
        accessGone()
        return
      }
      if (summary.archive.globalArchivedAt !== null) {
        setOpen(false)
        onPutAway()
        return
      }
      setAdding(false)
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof DuetApiError && error.status === 404) {
        accessGone()
        return
      }
      const staleAudience =
        error instanceof DuetApiError && error.code === 'invalid_audience_member'
      if (staleAudience) {
        void queryClient.invalidateQueries({
          queryKey: duetQueryKeys.workspaces.members(workspaceSlug),
        })
      }
      setFailure({ delta, staleAudience })
    }
  }
  const listPending = specific ? audienceQuery.isPending : workspaceAudienceQuery.isPending
  const listInitialError = specific
    ? audienceQuery.isError && audienceQuery.data === undefined
    : workspaceAudienceQuery.isError && workspaceAudienceQuery.data === undefined
  const headerCount = specificAudience?.count ?? workspaceAudienceQuery.data?.items.length
  const retryList = () => (specific ? audienceQuery.refetch() : workspaceAudienceQuery.refetch())
  const workspacePreviewMembers = specific
    ? undefined
    : listInitialError
      ? null
      : workspaceAudienceQuery.data === undefined
        ? undefined
        : workspaceRows

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setAdding(false)
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={
            headerCount === undefined
              ? t(listInitialError ? 'headerTriggerUnavailable' : 'headerTriggerPending')
              : t('headerTrigger', { count: headerCount })
          }
          aria-expanded={open}
          className="flex h-11 min-w-0 shrink-0 items-center rounded-md px-1.5 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SessionAudiencePreview
            audience={snapshot.audience}
            workspaceMembers={workspacePreviewMembers}
          />
        </button>
      </DialogTrigger>
      <DialogContent
        data-session-audience-manager
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0 sm:w-full [&>button]:grid [&>button]:size-11 [&>button]:place-items-center [&>button]:focus:ring-1 [&>button]:focus:ring-inset"
        onEscapeKeyDown={() => setOpen(false)}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-16 text-left">
          <DialogTitle>{t('manageTitle')}</DialogTitle>
          <DialogDescription>{t('manageDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          <p className="sr-only" role="status" aria-live="polite">
            {specific && audienceQuery.isFetchingNextPage
              ? t('loadingMore')
              : specific && audienceQuery.isFetchNextPageError
                ? t('loadMoreError')
                : listPending
                  ? t('loading')
                  : listInitialError
                    ? t('loadError')
                    : t('headerCount', { count: rows.length })}
          </p>
          {listPending ? (
            <ManagerState icon={<CircleNotch className="animate-spin" />} text={t('loading')} />
          ) : listInitialError ? (
            <ManagerState
              text={t('loadError')}
              action={
                <Button variant="outline" onClick={() => void retryList()}>
                  {t('retry')}
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 px-1">
                <h3 className="text-sm font-medium">{t('current')}</h3>
                {specific && snapshot.permissions.manageAudience ? (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={update.isPending}
                    onClick={() => setAdding(current => !current)}
                  >
                    <Plus aria-hidden />
                    {t('addPeople')}
                  </Button>
                ) : null}
              </div>

              {rows.length === 0 ? (
                <ManagerState
                  text={t(currentState === 'incomplete' ? 'noCurrentLoaded' : 'zeroCurrent')}
                />
              ) : (
                <ul className="space-y-1">
                  {rows.map(member => (
                    <li key={member.memberId}>
                      <AudienceRow
                        member={member}
                        disabled={update.isPending}
                        removeLabel={
                          specific && snapshot.permissions.manageAudience
                            ? t('remove', { name: member.name })
                            : undefined
                        }
                        onRemove={() => void apply({ remove: [member.userId] })}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {specific && audienceQuery.isFetchNextPageError ? (
                <ManagerState
                  text={t('loadMoreError')}
                  action={
                    <Button variant="outline" onClick={() => void audienceQuery.fetchNextPage()}>
                      {t('retry')}
                    </Button>
                  }
                />
              ) : specific && audienceQuery.hasNextPage ? (
                <Button
                  variant="ghost"
                  className="min-h-11 w-full"
                  disabled={audienceQuery.isFetchingNextPage || update.isPending}
                  onClick={() => void audienceQuery.fetchNextPage()}
                >
                  {audienceQuery.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
                </Button>
              ) : null}

              {specific && adding && snapshot.permissions.manageAudience ? (
                <AudienceAddPeople
                  workspaceSlug={workspaceSlug}
                  currentUserIds={new Set(rows.map(member => member.userId))}
                  disabled={update.isPending}
                  onAdd={userIds => void apply({ add: userIds })}
                  onSelectionChange={userIds =>
                    setFailure(current =>
                      current?.staleAudience && current.delta.add !== undefined
                        ? { ...current, delta: { add: userIds } }
                        : current,
                    )
                  }
                />
              ) : null}

              {failure === undefined ? null : (
                <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <p className="text-sm text-foreground">
                    {t(failure.staleAudience ? 'changedError' : 'updateError')}
                  </p>
                  <Button
                    variant="outline"
                    className="mt-2 min-h-11"
                    disabled={
                      update.isPending || (failure.staleAudience && failure.delta.add?.length === 0)
                    }
                    onClick={() => void apply(failure.delta)}
                  >
                    {t('retry')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AudienceAddPeople({
  workspaceSlug,
  currentUserIds,
  disabled,
  onAdd,
  onSelectionChange,
}: {
  workspaceSlug: string
  currentUserIds: ReadonlySet<string>
  disabled: boolean
  onAdd: (userIds: string[]) => void
  onSelectionChange: (userIds: string[]) => void
}) {
  const t = useTranslations('duetApp.sessionProduct.audience')
  const { api } = useSpa()
  const [searchInput, setSearchInput] = useState('')
  const [selected, setSelected] = useState<ReadonlyMap<string, WorkspaceMember>>(new Map())
  const search = normalizeWorkspaceMemberSearch(searchInput)
  const query = useInfiniteQuery(
    duetQueryOptions.workspaces.memberSearch(api, workspaceSlug, search),
  )
  const results = useMemo(() => query.data?.pages.flatMap(page => page.items) ?? [], [query.data])
  const resultState = audienceCollectionState(
    results.length,
    query.hasNextPage,
    query.isFetchNextPageError,
  )
  const toggle = (member: WorkspaceMember) => {
    if (currentUserIds.has(member.id)) return
    const next = new Map(selected)
    if (next.has(member.id)) next.delete(member.id)
    else next.set(member.id, member)
    setSelected(next)
    onSelectionChange([...next.keys()].sort())
  }
  return (
    <section className="rounded-lg border" data-session-audience-add>
      <label className="flex min-h-11 items-center border-b px-3">
        <span className="sr-only">{t('search')}</span>
        <input
          type="search"
          value={searchInput}
          maxLength={32}
          placeholder={t('search')}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
          onChange={event => setSearchInput(event.target.value)}
        />
      </label>
      <p className="sr-only" role="status" aria-live="polite">
        {query.isFetchingNextPage
          ? t('loadingMore')
          : query.isFetchNextPageError
            ? t('loadMoreError')
            : query.isPending
              ? t('loading')
              : query.isError
                ? t('loadError')
                : t('resultCount', { count: results.length })}
      </p>
      {selected.size === 0 ? null : (
        <div className="space-y-1 border-b p-1" data-session-audience-selected>
          {[...selected.values()].map(member => (
            <AudienceRow
              key={member.id}
              member={{
                memberId: member.id,
                userId: member.id,
                name: member.name?.trim() || member.email,
                email: member.email,
                role: member.role,
              }}
              disabled={disabled}
              removeLabel={t('remove', { name: member.name?.trim() || member.email })}
              onRemove={() => toggle(member)}
            />
          ))}
        </div>
      )}
      <div role="listbox" aria-label={t('results')} className="max-h-64 overflow-y-auto p-1">
        {query.isPending ? (
          <ManagerState text={t('loading')} />
        ) : query.isError && query.data === undefined ? (
          <ManagerState
            text={t('loadError')}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : resultState !== 'rows' ? (
          <ManagerState
            text={t(resultState === 'incomplete' ? 'noPeopleLoaded' : 'zeroMatches')}
            action={
              resultState !== 'incomplete' ? undefined : (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={query.isFetchingNextPage || disabled}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage
                    ? t('loadingMore')
                    : query.isFetchNextPageError
                      ? t('retry')
                      : t('loadMore')}
                </Button>
              )
            }
          />
        ) : (
          results.map(member => {
            const current = currentUserIds.has(member.id)
            const checked = current || selected.has(member.id)
            return (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={checked}
                disabled={disabled || current}
                className={cn(
                  'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm',
                  checked && 'bg-muted',
                  current && 'opacity-60',
                )}
                onClick={() => toggle(member)}
              >
                <Avatar name={member.name?.trim() || member.email} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {member.name?.trim() || member.email}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {member.email}
                  </span>
                </span>
                {checked ? <Check className="size-4 shrink-0" aria-hidden /> : null}
              </button>
            )
          })
        )}
        {resultState === 'rows' && query.isFetchNextPageError ? (
          <ManagerState
            text={t('loadMoreError')}
            action={
              <Button variant="outline" onClick={() => void query.fetchNextPage()}>
                {t('retry')}
              </Button>
            }
          />
        ) : resultState === 'rows' && query.hasNextPage ? (
          <Button
            variant="ghost"
            className="min-h-11 w-full"
            disabled={query.isFetchingNextPage || disabled}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
          </Button>
        ) : null}
      </div>
      <div className="border-t p-2">
        <Button
          className="min-h-11 w-full"
          disabled={disabled || selected.size === 0}
          onClick={() => onAdd([...selected.keys()].sort())}
        >
          {t('addSelected', { count: selected.size })}
        </Button>
      </div>
    </section>
  )
}

function AudienceRow({
  member,
  disabled,
  removeLabel,
  onRemove,
}: {
  member: SessionAudienceMemberPreview
  disabled: boolean
  removeLabel?: string
  onRemove: () => void
}) {
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2">
      <Avatar name={member.name} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-medium" title={member.name}>
          {member.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={member.email}>
          {member.email}
        </span>
      </span>
      {removeLabel === undefined ? null : (
        <button
          type="button"
          aria-label={removeLabel}
          disabled={disabled}
          className="grid size-11 shrink-0 place-items-center rounded-md bg-muted/35 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          onClick={onRemove}
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}

function Avatar({ name }: { name: string }) {
  return <UserAvatar name={name} className="size-8" />
}

function ManagerState({
  icon,
  text,
  action,
}: {
  icon?: React.ReactNode
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-2 px-4 py-3 text-center text-sm text-muted-foreground">
      {icon ?? <Users className="size-5" aria-hidden />}
      <span>{text}</span>
      {action}
    </div>
  )
}
