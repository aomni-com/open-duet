'use client'

import {
  ArrowLeft,
  CaretRight,
  CheckCircle,
  Folder,
  FolderOpen,
  Package,
  ShareNetwork,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useState } from 'react'

import type { IncomingShare, ShareRequest, WorkspaceSummary } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import {
  duetQueryOptions,
  isInitialCollectionError,
  mapCollectionItems,
} from '../api/query-options'
import { useSpa } from '../context'

export function eligibleShareWorkspaces(
  workspaces: readonly WorkspaceSummary[],
): WorkspaceSummary[] {
  return workspaces.filter(
    workspace => workspace.status === 'active' && workspace.role !== 'viewer',
  )
}

export function defaultShareMountPath(parentPath: string, folderName: string): string {
  return parentPath.length === 0 ? folderName : `${parentPath}/${folderName}`
}

export function acceptedShareDestination(
  response: { share: Pick<IncomingShare, 'mountPath'> },
  submitted: { workspaceSlug: string; mountPath: string },
): { workspaceSlug: string; mountPath: string } {
  return {
    workspaceSlug: submitted.workspaceSlug,
    mountPath: response.share.mountPath ?? submitted.mountPath,
  }
}

export function shareDecisionState(input: {
  blocked: boolean
  mountPath: string
  acceptPending: boolean
  declinePending: boolean
}): { locked: boolean; canAccept: boolean; canDecline: boolean } {
  const locked = input.acceptPending || input.declinePending
  return {
    locked,
    canAccept: !input.blocked && !locked && input.mountPath.trim().length > 0,
    canDecline: !locked,
  }
}

export function shareRequestTitleKey(incomplete: boolean): 'title' | 'titleLoaded' {
  return incomplete ? 'titleLoaded' : 'title'
}

export function shareRequestCollectionState(
  itemCount: number,
  incomplete: boolean,
): 'empty' | 'incomplete' | 'rows' {
  if (itemCount > 0) return 'rows'
  return incomplete ? 'incomplete' : 'empty'
}

export function RecipientShareRequests({
  workspaceSlug,
  focusedShareId,
  unavailableLink = false,
  onAccepted,
}: {
  workspaceSlug: string
  focusedShareId?: string
  unavailableLink?: boolean
  onAccepted?(workspaceSlug: string, mountPath: string): void
}) {
  const t = useTranslations('duetApp.shareRequests')
  const { api, identity } = useSpa()
  const queryClient = useQueryClient()
  const requestsOptions = duetQueryOptions.user.shareRequests(api)
  const requests = useInfiniteQuery(requestsOptions)
  const [selectedId, setSelectedId] = useState<string>()

  useEffect(() => {
    if (
      focusedShareId !== undefined &&
      requests.data?.items.some(share => share.id === focusedShareId)
    ) {
      setSelectedId(focusedShareId)
    }
  }, [focusedShareId, requests.data?.items])

  const selected = requests.data?.items.find(share => share.id === selectedId)
  const removeRequest = (shareId: string) => {
    queryClient.setQueryData(requestsOptions.queryKey, current =>
      mapCollectionItems(current, items => items.filter(share => share.id !== shareId)),
    )
    setSelectedId(undefined)
  }

  /* Nothing while the answer is in flight. This banner is an interruption —
     almost every load has no share to review — so a skeleton here reserves a
     card's height for something that will not arrive, and the drive visibly
     drops when it doesn't. An interruption may appear late; it may not push
     the page around on the way to being absent. */
  if (requests.isPending) return null
  if (requests.data === undefined || isInitialCollectionError(requests)) {
    return (
      <aside
        role="alert"
        className="mx-4 mt-4 flex items-center justify-between gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm md:mx-6"
      >
        <span>{t('loadError')}</span>
        <button
          className={buttonVariants({ variant: 'outline' })}
          onClick={() => void requests.refetch()}
        >
          {t('retry')}
        </button>
      </aside>
    )
  }
  const requestsIncomplete = requests.hasNextPage || requests.isFetchNextPageError
  if (
    shareRequestCollectionState(requests.data.items.length, requestsIncomplete) === 'empty' &&
    !unavailableLink
  )
    return null

  return (
    <section
      aria-labelledby="share-requests-title"
      className="mx-4 mt-4 min-w-0 rounded-xl border border-primary/20 bg-primary/[0.035] p-4 shadow-sm md:mx-6 md:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <ShareNetwork size={21} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="share-requests-title" className="font-semibold">
            {t(shareRequestTitleKey(requestsIncomplete), { count: requests.data.items.length })}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      {unavailableLink ? (
        <div className="mt-4">
          <ShareProblem title={t('linkUnavailableTitle')} body={t('linkUnavailableBody')} />
        </div>
      ) : null}

      {requests.data.items.length > 1 || selected === undefined ? (
        <div className="mt-4 grid min-w-0 gap-2">
          {requests.data.items.map(share => (
            <button
              key={share.id}
              aria-current={share.id === selectedId ? 'true' : undefined}
              className={`flex min-h-14 min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-primary/[0.025] ${
                share.id === selectedId ? 'border-primary/50 bg-primary/[0.06]' : 'bg-background'
              }`}
              onClick={() => setSelectedId(share.id)}
            >
              <FolderOpen className="shrink-0 text-primary" size={22} weight="duotone" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {share.source.folderName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t('from', {
                    sharer: share.source.sharerName,
                    workspace: share.source.workspaceName,
                  })}
                </span>
              </span>
              <span className="shrink-0 text-xs font-medium text-primary">{t('review')}</span>
              <CaretRight className="shrink-0 text-muted-foreground" size={16} />
            </button>
          ))}
        </div>
      ) : null}

      {requests.hasNextPage || requests.isFetchNextPageError ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={requests.isFetchingNextPage}
            onClick={() => void requests.fetchNextPage()}
            className={buttonVariants({ variant: 'outline' })}
          >
            {requests.isFetchingNextPage
              ? t('loadingMore')
              : requests.isFetchNextPageError
                ? t('loadMoreError')
                : t('loadMore')}
          </button>
        </div>
      ) : null}

      {selected !== undefined ? (
        <AcceptSharePanel
          key={selected.id}
          share={selected}
          currentWorkspaceSlug={workspaceSlug}
          workspaces={identity.workspaces}
          onClose={() => setSelectedId(undefined)}
          onConsumed={() => removeRequest(selected.id)}
          onAccepted={onAccepted}
        />
      ) : null}
    </section>
  )
}

function AcceptSharePanel({
  share,
  currentWorkspaceSlug,
  workspaces,
  onClose,
  onConsumed,
  onAccepted,
}: {
  share: ShareRequest
  currentWorkspaceSlug: string
  workspaces: readonly WorkspaceSummary[]
  onClose(): void
  onConsumed(): void
  onAccepted?(workspaceSlug: string, mountPath: string): void
}) {
  const t = useTranslations('duetApp.shareRequests')
  const { api } = useSpa()
  const eligible = useMemo(() => eligibleShareWorkspaces(workspaces), [workspaces])
  const initialWorkspace =
    eligible.find(workspace => workspace.slug === currentWorkspaceSlug) ?? eligible[0]
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace?.id ?? '')
  const selectedWorkspace = eligible.find(workspace => workspace.id === workspaceId)
  const [mountPath, setMountPath] = useState(defaultShareMountPath('', share.source.folderName))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [declineConfirm, setDeclineConfirm] = useState(false)

  const accept = useMutation({
    mutationFn: async () => {
      if (selectedWorkspace === undefined) throw new Error('No eligible workspace')
      const response = await api.acceptShare(share.id, {
        toWorkspaceId: selectedWorkspace.id,
        mountPath,
      })
      return acceptedShareDestination(response, {
        workspaceSlug: selectedWorkspace.slug,
        mountPath,
      })
    },
    onSuccess: destination => {
      onConsumed()
      onAccepted?.(destination.workspaceSlug, destination.mountPath)
    },
  })
  const decline = useMutation({
    mutationFn: async () => await api.declineShare(share.id),
    onSuccess: onConsumed,
  })

  const expired = share.state === 'expired'
  const unavailable = !share.source.originLive || eligible.length === 0
  const blocked = expired || unavailable
  const decision = shareDecisionState({
    blocked,
    mountPath,
    acceptPending: accept.isPending,
    declinePending: decline.isPending,
  })

  return (
    <div
      role="region"
      aria-label={t('acceptLabel', { folder: share.source.folderName })}
      className="mt-4 overflow-hidden rounded-xl border bg-background shadow-lg"
    >
      <div className="flex items-start justify-between gap-4 border-b p-4 md:p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-primary">
            {t('requestLabel')}
          </p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight">{share.source.folderName}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('details', {
              sharer: share.source.sharerName,
              workspace: share.source.workspaceName,
            })}
          </p>
        </div>
        <button
          aria-label={t('close')}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'icon' }),
            'shrink-0 text-foreground/70',
          )}
          disabled={decision.locked}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>

      <div className="grid gap-5 p-4 pb-36 md:grid-cols-[minmax(0,1fr)_minmax(15rem,0.72fr)] md:p-5">
        <div className="space-y-5">
          {expired ? (
            <ShareProblem title={t('expiredTitle')} body={t('expiredBody')} />
          ) : !share.source.originLive ? (
            <ShareProblem title={t('originUnavailableTitle')} body={t('originUnavailableBody')} />
          ) : eligible.length === 0 ? (
            <ShareProblem title={t('targetUnavailableTitle')} body={t('targetUnavailableBody')} />
          ) : null}

          {eligible.length > 1 ? (
            <fieldset>
              <legend className="text-sm font-semibold">{t('workspaceLegend')}</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {eligible.map(workspace => (
                  <label
                    key={workspace.id}
                    className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 ${workspace.id === workspaceId ? 'border-primary bg-primary/5' : 'bg-card'}`}
                  >
                    <input
                      className="size-4 accent-primary"
                      type="radio"
                      name={`share-workspace-${share.id}`}
                      value={workspace.id}
                      checked={workspace.id === workspaceId}
                      disabled={decision.locked}
                      onChange={() => {
                        setWorkspaceId(workspace.id)
                        setBrowsePath('')
                        setMountPath(defaultShareMountPath('', share.source.folderName))
                      }}
                    />
                    <span>
                      <span className="block text-sm font-semibold">{workspace.name}</span>
                      <span className="block text-xs text-muted-foreground">/{workspace.slug}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : selectedWorkspace !== undefined ? (
            <div>
              <p className="text-sm font-semibold">{t('workspaceLegend')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{selectedWorkspace.name}</p>
            </div>
          ) : null}

          {selectedWorkspace !== undefined ? (
            <div>
              <label htmlFor={`share-mount-${share.id}`} className="text-sm font-semibold">
                {t('destinationLabel')}
              </label>
              <div className="mt-2 flex gap-2">
                <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-card px-3">
                  <Folder size={18} className="shrink-0 text-muted-foreground" />
                  <input
                    id={`share-mount-${share.id}`}
                    value={mountPath}
                    onChange={event => setMountPath(event.currentTarget.value)}
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    disabled={blocked || decision.locked}
                  />
                </div>
                <button
                  className={buttonVariants({ variant: 'outline' })}
                  onClick={() => setPickerOpen(open => !open)}
                  disabled={blocked || decision.locked}
                >
                  {pickerOpen ? t('hideFolders') : t('chooseFolder')}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('destinationHint')}</p>
              {pickerOpen ? (
                <FolderPicker
                  workspace={selectedWorkspace}
                  path={browsePath}
                  disabled={decision.locked}
                  onPathChange={setBrowsePath}
                  onChoose={path => {
                    setMountPath(defaultShareMountPath(path, share.source.folderName))
                    setPickerOpen(false)
                  }}
                />
              ) : null}
            </div>
          ) : null}

          {accept.isError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t('acceptError')}
            </p>
          ) : null}
        </div>

        <aside className="rounded-xl border bg-muted/30 p-4">
          <div className="flex items-center gap-2">
            <Package size={19} className="text-primary" weight="duotone" />
            <h4 className="text-sm font-semibold">{t('appsTitle')}</h4>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('appsBody')}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-1">
            {share.source.apps.length === 0 ? (
              <p className="col-span-2 rounded-lg border border-dashed bg-background px-3 py-3 text-sm text-muted-foreground md:col-span-1">
                {t('noApps')}
              </p>
            ) : (
              share.source.apps.map(app => (
                <div
                  key={`${app.slug}:${app.path}`}
                  className="rounded-lg border bg-background p-3"
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs font-semibold md:text-sm">
                    <CheckCircle className="text-emerald-600" size={17} weight="fill" />
                    <span className="min-w-0 truncate">{app.slug}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{app.path}</p>
                </div>
              ))
            )}
          </div>
        </aside>

        <div className="fixed inset-x-8 bottom-[5.75rem] z-30 flex flex-wrap items-center gap-2 rounded-xl border bg-background/95 px-3 py-2.5 shadow-lg backdrop-blur md:static md:col-span-2 md:rounded-none md:border-x-0 md:border-b-0 md:bg-transparent md:px-0 md:py-0 md:pt-4 md:shadow-none md:backdrop-blur-none">
          {declineConfirm ? (
            <>
              <span className="basis-full text-sm font-semibold">{t('declineConfirm')}</span>
              <button
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive',
                )}
                disabled={decision.locked}
                onClick={() => decline.mutate()}
              >
                {decline.isPending ? t('declining') : t('decline')}
              </button>
              <button
                className={buttonVariants({ variant: 'ghost' })}
                disabled={decision.locked}
                onClick={() => setDeclineConfirm(false)}
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                className={buttonVariants()}
                disabled={!decision.canAccept}
                onClick={() => accept.mutate()}
              >
                {accept.isPending ? t('accepting') : t('accept')}
              </button>
              <button
                className={cn(buttonVariants({ variant: 'outline' }), 'text-foreground/75')}
                disabled={!decision.canDecline}
                onClick={() => setDeclineConfirm(true)}
              >
                {t('decline')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FolderPicker({
  workspace,
  path,
  disabled,
  onPathChange,
  onChoose,
}: {
  workspace: WorkspaceSummary
  path: string
  disabled: boolean
  onPathChange(path: string): void
  onChoose(path: string): void
}) {
  const t = useTranslations('duetApp.shareRequests')
  const { api } = useSpa()
  const listing = useInfiniteQuery(
    duetQueryOptions.workspaces.shareFolder(api, workspace.slug, path),
  )
  const directories = listing.data?.items.filter(entry => entry.type === 'directory') ?? []
  const directoriesIncomplete = listing.hasNextPage || listing.isFetchNextPageError

  return (
    <div className="mt-3 overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <button
          className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold disabled:opacity-40"
          disabled={disabled || path.length === 0}
          onClick={() => onPathChange(path.split('/').slice(0, -1).join('/'))}
        >
          <ArrowLeft size={16} /> {t('up')}
        </button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          /{workspace.slug}/{path}
        </span>
        <button
          className="min-h-11 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground"
          disabled={disabled}
          onClick={() => onChoose(path)}
        >
          {t('useFolder')}
        </button>
      </div>
      <div className="max-h-52 overflow-y-auto p-2">
        {listing.isPending ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">{t('loadingFolders')}</p>
        ) : isInitialCollectionError(listing) ? (
          <div role="alert" className="grid justify-items-start gap-2 px-2 py-4">
            <p className="text-sm text-destructive">{t('folderError')}</p>
            <button
              type="button"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              onClick={() => void listing.refetch()}
            >
              {t('retry')}
            </button>
          </div>
        ) : directories.length === 0 && !directoriesIncomplete ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">{t('noFolders')}</p>
        ) : (
          <>
            {directories.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">{t('noFoldersLoaded')}</p>
            ) : null}
            {directories.map(entry => (
              <button
                key={entry.path}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted"
                disabled={disabled}
                onClick={() => onPathChange(entry.path)}
              >
                <Folder size={18} className="text-primary" weight="duotone" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <CaretRight size={15} className="text-muted-foreground" />
              </button>
            ))}
            {listing.hasNextPage || listing.isFetchNextPageError ? (
              <button
                type="button"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'sm' }),
                  'mt-1 w-full text-muted-foreground',
                )}
                disabled={disabled || listing.isFetchingNextPage}
                onClick={() => void listing.fetchNextPage()}
              >
                {listing.isFetchingNextPage
                  ? t('loadingMoreFolders')
                  : listing.isFetchNextPageError
                    ? t('retryMoreFolders')
                    : t('loadMoreFolders')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function ShareProblem({ title, body }: { title: string; body: string }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <WarningCircle size={20} className="mt-0.5 shrink-0" weight="fill" />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed">{body}</p>
      </div>
    </div>
  )
}
