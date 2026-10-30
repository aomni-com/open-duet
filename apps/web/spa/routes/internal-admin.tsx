'use client'

import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  HardDrivesIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import {
  INTERNAL_ADMIN_STALE_HEARTBEAT_MS,
  INTERNAL_ADMIN_VM_OPERATIONS,
  UsageReportPeriodSchema,
  type InternalAdminFeedback,
  type InternalAdminFleetVm,
  type InternalAdminInferenceMargin,
  type UsageReportPeriod,
  type InternalAdminVmOperation,
  type InternalAdminVmOperationResult,
  type Backup,
  type InternalAdminWorkspaceDetail,
  type InternalAdminWorkspaceMutationRequest,
  type InternalAdminWorkspaceSummary,
  type InternalAdminCleanupPreview,
  type InternalAdminCleanupOperation,
} from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { DuetApiError } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import type { SpaApi } from '../context'
import { useSpa } from '../context'
import { driveFolderUrl } from '../drive/drive-routes'
import { WorkspacePageHeader } from '../drive/workspace-page'
import { PauseSwitch } from '../settings/pause-switch'
import { ModelRouterOperations } from './model-router-policy'

type Section =
  | 'workspaces'
  | 'fleet'
  | 'inference'
  | 'modelRouter'
  | 'feedback'
  | 'credits'
  | 'marketplace'

/** What the hub's own gateway said, when it said anything worth showing. */
function syncFailureDetail(error: unknown): string | undefined {
  if (!(error instanceof DuetApiError)) return undefined
  const data = error.data
  if (typeof data !== 'object' || data === null) return undefined
  const { gatewayStatus, detail } = data as {
    gatewayStatus?: number
    detail?: string
  }
  if (typeof detail !== 'string' || detail.length === 0) return undefined
  return gatewayStatus === undefined ? detail : `${gatewayStatus} — ${detail}`
}
const RESET_FREE_CREDITS_CONFIRMATION = 'RESET FREE CREDITS'
export type InternalAdminApi = Pick<
  SpaApi,
  | 'internalAdminSearch'
  | 'internalAdminCreateUser'
  | 'internalAdminUserCleanupPreview'
  | 'internalAdminStartUserCleanup'
  | 'internalAdminCleanupStatus'
  | 'internalAdminRetryUserCleanup'
  | 'internalAdminOpenOfficialHub'
  | 'internalAdminSyncOfficialHub'
  | 'internalAdminWorkspace'
  | 'internalAdminFeedback'
  | 'internalAdminMutateFeedback'
  | 'internalAdminFreeCredits'
  | 'internalAdminResetFreeCredits'
  | 'internalAdminTakedownListing'
  | 'internalAdminMutateWorkspace'
  | 'internalAdminVmStatus'
  | 'internalAdminVmUpdates'
  | 'internalAdminSetVmUpdates'
  | 'internalAdminFleetHealth'
  | 'internalAdminInferenceMargin'
  | 'internalAdminModelRouterPolicy'
  | 'internalAdminSetModelRouterPolicy'
  | 'internalAdminVmOperation'
  | 'internalAdminVmBackup'
  | 'internalAdminFiles'
  | 'internalAdminFile'
  | 'internalAdminLogs'
  | 'internalAdminCommand'
>

export default function InternalAdminRoute() {
  const { api, identity } = useSpa()
  const navigate = useNavigate()
  return (
    <InternalAdminSurface
      api={api}
      allowed={identity.internalAdmin}
      onOpenWorkspace={workspaceSlug => navigate(driveFolderUrl(workspaceSlug, '/'))}
    />
  )
}

export function InternalAdminSurface({
  api,
  allowed,
  initialSection = 'workspaces',
  initialSearch = '',
  onOpenWorkspace,
}: {
  api: InternalAdminApi
  allowed: boolean
  initialSection?: Section
  initialSearch?: string
  onOpenWorkspace(workspaceSlug: string): void
}) {
  const t = useTranslations('duetAdmin')
  const [section, setSection] = useState<Section>(initialSection)
  const openGolden = useMutation({
    mutationFn: () => api.internalAdminOpenOfficialHub(),
    onSuccess: result => onOpenWorkspace(result.workspaceSlug),
  })
  // Always converges, so there is nothing to confirm and no "already current"
  // outcome. What the operator needs back is what it changed — an empty list
  // is the real answer that the hub already matched the deployed code.
  const syncGolden = useMutation({
    mutationFn: () => api.internalAdminSyncOfficialHub(),
  })
  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-muted/20">
      <header className="border-b bg-background px-4 py-5 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end lg:justify-between">
          <WorkspacePageHeader
            icon={<TerminalWindowIcon weight="duotone" />}
            eyebrow={t('eyebrow')}
            title={t('title')}
            description={t('subtitle')}
            // Never narrower than a readable title: once the tabs and actions
            // outgrow the row, they wrap beneath it instead of squeezing it.
            className="lg:min-w-80 lg:flex-1"
          />
          <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
            {allowed ? (
              <button
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-auto min-h-10 bg-background',
                )}
                disabled={openGolden.isPending}
                onClick={() => openGolden.mutate()}
              >
                {openGolden.isPending ? <SpinnerGapIcon className="animate-spin" /> : null}
                {!openGolden.isPending ? <ArrowSquareOutIcon /> : null}
                {t('golden.open')}
              </button>
            ) : null}
            {allowed ? (
              <button
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-auto min-h-10 bg-background',
                )}
                disabled={syncGolden.isPending}
                onClick={() => syncGolden.mutate()}
              >
                {syncGolden.isPending ? <SpinnerGapIcon className="animate-spin" /> : null}
                {!syncGolden.isPending ? <ArrowsClockwiseIcon /> : null}
                {syncGolden.isPending ? t('golden.syncing') : t('golden.sync')}
              </button>
            ) : null}
            <nav
              aria-label={t('sectionsLabel')}
              className="grid w-full grid-cols-2 gap-1 rounded-xl border bg-muted/40 p-1 sm:flex sm:min-w-0 sm:flex-1 sm:overflow-x-auto lg:w-auto lg:flex-none"
            >
              {(
                [
                  'workspaces',
                  'fleet',
                  'inference',
                  'modelRouter',
                  'feedback',
                  'credits',
                  'marketplace',
                ] as const
              ).map(item => (
                <button
                  key={item}
                  disabled={!allowed}
                  onClick={() => setSection(item)}
                  className={`min-h-10 whitespace-nowrap rounded-lg px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${section === item ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t(`sections.${item}`)}
                </button>
              ))}
            </nav>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 sm:p-8">
        {openGolden.isError && allowed ? (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {t('golden.error')}
          </div>
        ) : null}
        {syncGolden.isError && allowed ? (
          <div
            className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            data-testid="official-hub-sync-error"
          >
            {t('golden.syncError')}
            {/* The gateway's own words. Without them every failure looks like a
                sleeping VM, and an operator chases the wrong thing. */}
            {syncFailureDetail(syncGolden.error) === undefined ? null : (
              <span className="mt-1 block font-mono text-xs opacity-80">
                {syncFailureDetail(syncGolden.error)}
              </span>
            )}
          </div>
        ) : null}
        {syncGolden.isSuccess && allowed ? (
          <div
            className="mb-4 rounded-lg border bg-muted/40 p-3 text-sm"
            data-testid="official-hub-sync-result"
          >
            {syncGolden.data.written.length === 0 &&
            syncGolden.data.deleted.length === 0 &&
            syncGolden.data.retiredAgents.length === 0
              ? t('golden.syncUnchanged')
              : [
                  syncGolden.data.written.length > 0
                    ? t('golden.syncWrote', {
                        count: syncGolden.data.written.length,
                      })
                    : null,
                  syncGolden.data.deleted.length > 0
                    ? t('golden.syncDeleted', {
                        count: syncGolden.data.deleted.length,
                      })
                    : null,
                  syncGolden.data.retiredAgents.length > 0
                    ? t('golden.syncRetired', {
                        agents: syncGolden.data.retiredAgents.map(agent => agent.slug).join(', '),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
          </div>
        ) : null}
        {!allowed ? (
          <AdminState
            icon="denied"
            title={t('denied.title')}
            body={t('denied.body')}
            actionLabel={t('denied.back')}
            onAction={() => window.history.back()}
          />
        ) : section === 'workspaces' ? (
          <WorkspaceOperations api={api} initialSearch={initialSearch} />
        ) : null}
        {allowed && section === 'fleet' ? <FleetOperations api={api} /> : null}
        {allowed && section === 'inference' ? <InferenceOperations api={api} /> : null}
        {allowed && section === 'modelRouter' ? <ModelRouterOperations api={api} /> : null}
        {allowed && section === 'feedback' ? <FeedbackOperations api={api} /> : null}
        {allowed && section === 'credits' ? <CreditOperations api={api} /> : null}
        {allowed && section === 'marketplace' ? <ListingTakedown api={api} /> : null}
      </main>
    </div>
  )
}

function WorkspaceOperations({
  api,
  initialSearch,
}: {
  api: InternalAdminApi
  initialSearch: string
}) {
  const t = useTranslations('duetAdmin')
  const [draft, setDraft] = useState(initialSearch)
  const [query, setQuery] = useState(initialSearch)
  const [selected, setSelected] = useState<InternalAdminWorkspaceSummary>()
  const search = useQuery({
    ...duetQueryOptions.admin.search(api, query),
    enabled: query.length > 0,
  })
  if (selected !== undefined)
    return <WorkspaceDetail api={api} workspace={selected} onBack={() => setSelected(undefined)} />
  return (
    <div className="space-y-6">
      <FleetUpdates api={api} />
      <UserCleanupPanel api={api} />
      <CreateUser
        api={api}
        onCreated={email => {
          setDraft(email)
          setQuery(email)
        }}
      />
      <section className="rounded-xl border bg-background p-5 shadow-sm sm:p-7">
        <h2 className="text-lg font-semibold">{t('search.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('search.body')}</p>
        <form
          className="mt-5 flex flex-col gap-3 sm:flex-row"
          onSubmit={event => {
            event.preventDefault()
            setQuery(draft.trim())
          }}
        >
          <label className="flex-1">
            <span className="sr-only">{t('search.label')}</span>
            <input
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder={t('search.placeholder')}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <button disabled={!draft.trim()} className={buttonVariants()}>
            {t('search.action')}
          </button>
        </form>
      </section>
      {search.isPending && query ? (
        <AdminState busy title={t('loading.title')} body={t('loading.search')} />
      ) : null}
      {search.isError ? (
        <AdminState
          icon="error"
          title={t('error.title')}
          body={t('error.body')}
          actionLabel={t('error.retry')}
          onAction={() => void search.refetch()}
        />
      ) : null}
      {search.data?.workspaces.length === 0 ? (
        <AdminState title={t('empty.searchTitle')} body={t('empty.searchBody')} />
      ) : null}
      {search.data?.workspaces.length ? (
        <div className="grid gap-3">
          {search.data.workspaces.map(workspace => (
            <WorkspaceResult
              key={workspace.id}
              workspace={workspace}
              onSelect={() => setSelected(workspace)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function UserCleanupPanel({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin.userCleanup')
  const [identifier, setIdentifier] = useState('')
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [operationId, setOperationId] = useState<string>()
  const preview = useQuery({
    ...duetQueryOptions.admin.userCleanupPreview(api, target),
    enabled: target.length > 0,
  })
  const status = useQuery({
    ...duetQueryOptions.admin.userCleanup(api, operationId ?? ''),
    enabled: operationId !== undefined,
  })
  const start = useMutation({
    mutationFn: () => api.internalAdminStartUserCleanup(preview.data!.user.userId, reason),
    onSuccess: operation => setOperationId(operation.operationId),
  })
  const retry = useMutation({
    mutationFn: () => api.internalAdminRetryUserCleanup(operationId!, reason),
    onSuccess: operation => setOperationId(operation.operationId),
  })
  const operation: InternalAdminCleanupOperation | undefined = status.data ?? start.data
  return (
    <section
      className="rounded-xl border bg-background p-5 shadow-sm sm:p-7"
      data-testid="admin-user-cleanup"
    >
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('body')}</p>
      <form
        className="mt-5 flex flex-col gap-3 sm:flex-row"
        onSubmit={event => {
          event.preventDefault()
          setTarget(identifier.trim())
        }}
      >
        <input
          value={identifier}
          onChange={event => setIdentifier(event.target.value)}
          placeholder={t('placeholder')}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button disabled={!identifier.trim() || preview.isFetching} className={buttonVariants()}>
          {t('preview')}
        </button>
      </form>
      {preview.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t('error')}
        </p>
      ) : null}
      {preview.data ? (
        <CleanupPreview
          preview={preview.data}
          reason={reason}
          setReason={setReason}
          operation={operation}
          onStart={() => start.mutate()}
          onRetry={() => retry.mutate()}
          busy={start.isPending || retry.isPending}
        />
      ) : null}
    </section>
  )
}

function CleanupPreview({
  preview,
  reason,
  setReason,
  operation,
  onStart,
  onRetry,
  busy,
}: {
  preview: InternalAdminCleanupPreview
  reason: string
  setReason(value: string): void
  operation?: InternalAdminCleanupOperation
  onStart(): void
  onRetry(): void
  busy: boolean
}) {
  const t = useTranslations('duetAdmin.userCleanup')
  return (
    <div className="mt-5 space-y-4" data-testid="admin-user-cleanup-preview">
      <div>
        <strong>{preview.user.email}</strong>
        <span className="ml-2 text-xs text-muted-foreground">{preview.user.userId}</span>
      </div>
      <ul className="space-y-1 text-sm">
        {preview.workspaces.map(workspace => (
          <li key={workspace.workspaceId} className="rounded border px-3 py-2">
            {workspace.classification} · {workspace.workspaceId} · {workspace.memberCount}{' '}
            {t('members')}
          </li>
        ))}
      </ul>
      {preview.blockers.length > 0 ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          {preview.blockers.map((blocker, index) => (
            <div key={`${blocker.code}-${index}`}>
              {blocker.code}
              {blocker.workspaceId ? ` · ${blocker.workspaceId}` : ''}
            </div>
          ))}
        </div>
      ) : null}
      <label className="block text-sm font-medium">
        {t('reason')}
        <input
          value={reason}
          onChange={event => setReason(event.target.value)}
          minLength={3}
          maxLength={500}
          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={!preview.canStart || reason.trim().length < 3 || busy}
          onClick={onStart}
          className={buttonVariants({ variant: 'destructive' })}
        >
          {t('start')}
        </button>
        {operation?.canRetry ? (
          <button
            disabled={reason.trim().length < 3 || busy}
            onClick={onRetry}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('retry')}
          </button>
        ) : null}
      </div>
      {operation ? (
        <div className="text-sm" role="status">
          {t('status')}: <strong>{operation.status}</strong>
          {operation.resources.some(resource => resource.status === 'provider_pending')
            ? ` · ${t('providerPending')}`
            : ''}
        </div>
      ) : null}
    </div>
  )
}

function CreateUser({ api, onCreated }: { api: InternalAdminApi; onCreated(email: string): void }) {
  const t = useTranslations('duetAdmin')
  const [email, setEmail] = useState('')
  const client = useQueryClient()
  const create = useMutation({
    mutationFn: () => api.internalAdminCreateUser({ email: email.trim() }),
    onSuccess: result => {
      setEmail('')
      void client.invalidateQueries({
        queryKey: duetQueryKeys.admin.search(result.email),
      })
    },
  })
  return (
    <section
      aria-labelledby="create-user-title"
      className="rounded-xl border bg-background p-5 shadow-sm sm:p-7"
    >
      <h2 id="create-user-title" className="text-lg font-semibold">
        {t('createUser.title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('createUser.body')}</p>
      <form
        className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={event => {
          event.preventDefault()
          if (!create.isPending) create.mutate()
        }}
      >
        <label className="flex flex-1 flex-col gap-2 text-sm font-medium">
          {t('createUser.email')}
          <input
            type="email"
            required
            maxLength={320}
            autoComplete="off"
            value={email}
            disabled={create.isPending}
            onChange={event => {
              setEmail(event.target.value)
              create.reset()
            }}
            placeholder="person@example.com"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm font-normal"
          />
        </label>
        <button disabled={!email.trim() || create.isPending} className={buttonVariants()}>
          {create.isPending ? <SpinnerGapIcon className="animate-spin" /> : null}
          {t(create.isPending ? 'createUser.pending' : 'createUser.action')}
        </button>
      </form>
      {create.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t(
            create.error instanceof DuetApiError && create.error.code === 'user_already_exists'
              ? 'createUser.exists'
              : 'createUser.error',
          )}
        </p>
      ) : null}
      {create.isSuccess ? (
        <div className="mt-3 space-y-2 text-sm">
          <p role="status" className="break-words">
            {t('createUser.success', {
              email: create.data.email,
              workspace: create.data.workspaceSlug,
            })}
          </p>
          <button
            className={buttonVariants({ variant: 'outline' })}
            onClick={() => onCreated(create.data.email)}
          >
            {t('createUser.inspect')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/**
 * The global fleet update brake. One row governs every VM in the deployment:
 * pausing stops runtime activation across the fleet and
 * drops drifted VMs back to the idle sync cadence. This is the incident lever
 * for a bad release, so it lives at the top of the default section.
 */
function FleetUpdates({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const locale = useLocale()
  const client = useQueryClient()
  const [reason, setReason] = useState(() => t('defaults.vmUpdatesReason'))
  const query = useQuery(duetQueryOptions.admin.vmUpdates(api))
  const flip = useMutation({
    mutationFn: (paused: boolean) => api.internalAdminSetVmUpdates(paused, reason),
    onSuccess: () => client.invalidateQueries({ queryKey: duetQueryKeys.admin.vmUpdates }),
  })
  const paused = query.data?.paused === true
  return (
    <Panel title={t('vmUpdates.title')} body={t('vmUpdates.body')}>
      {query.isPending ? (
        <SpinnerGapIcon className="animate-spin" />
      ) : query.isError ? (
        <InlineNotice error>{t('error.body')}</InlineNotice>
      ) : (
        <div
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="admin-vm-updates"
          data-updates-paused={paused}
        >
          <div className="min-w-0">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                paused
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              }`}
            >
              {paused ? t('vmUpdates.paused') : t('vmUpdates.flowing')}
            </span>
            {query.data?.updatedAt === undefined ? null : (
              <p className="mt-2 break-words text-xs text-muted-foreground">
                {t('vmUpdates.lastChange')}:{' '}
                {new Intl.DateTimeFormat(locale, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                }).format(query.data.updatedAt)}
                {query.data.reason === undefined ? '' : ` — ${query.data.reason}`}
              </p>
            )}
          </div>
          <div className="flex w-full items-end gap-2 sm:w-auto">
            <label className="min-w-0 flex-1 text-xs font-medium sm:w-64">
              {t('reason')}
              <input
                value={reason}
                onChange={event => setReason(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm font-normal"
              />
            </label>
            <button
              disabled={flip.isPending || reason.trim().length < 3}
              onClick={() => flip.mutate(!paused)}
              data-testid="admin-vm-updates-flip"
              className={buttonVariants({
                variant: paused ? 'default' : 'destructive',
              })}
            >
              {paused ? t('vmUpdates.resume') : t('vmUpdates.pause')}
            </button>
          </div>
        </div>
      )}
      {flip.isError ? <InlineNotice error>{t('vmUpdates.error')}</InlineNotice> : null}
      {flip.isSuccess ? <InlineNotice>{t('vmUpdates.saved')}</InlineNotice> : null}
    </Panel>
  )
}

function WorkspaceResult({
  workspace,
  onSelect,
}: {
  workspace: InternalAdminWorkspaceSummary
  onSelect(): void
}) {
  const t = useTranslations('duetAdmin')
  return (
    <button
      onClick={onSelect}
      data-admin-result="workspace"
      className="group flex w-full items-center gap-4 rounded-xl border bg-background p-4 text-left shadow-sm transition hover:border-primary/40 sm:p-5"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <HardDrivesIcon size={22} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-sm sm:text-base">{workspace.name}</strong>
          <StatusBadge value={workspace.servicingStatus} />
        </span>
        <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
          {workspace.slug} · {workspace.billingEmail}
        </span>
      </span>
      <span className="hidden text-right text-xs text-muted-foreground sm:block">
        {t('workspace.members', { count: workspace.memberCount })}
        <br />
        {t('workspace.paidBalance')}: {formatMoney(workspace.paidCreditBalanceMicroUsd)}
        <br />
        {t('workspace.monthlyBalance')}: {formatMoney(workspace.monthlyCreditBalanceMicroUsd)}
      </span>
      <CaretRightIcon className="shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
    </button>
  )
}

function WorkspaceDetail({
  api,
  workspace,
  onBack,
}: {
  api: InternalAdminApi
  workspace: InternalAdminWorkspaceSummary
  onBack(): void
}) {
  const t = useTranslations('duetAdmin')
  const queryClient = useQueryClient()
  const detail = useQuery(duetQueryOptions.admin.workspace(api, workspace.id))
  const [reason, setReason] = useState(() => t('defaults.supportReason'))
  const [amount, setAmount] = useState('')
  const [payerId, setPayerId] = useState('')
  const [message, setMessage] = useState(workspace.adminMessage ?? '')
  const [messageDirty, setMessageDirty] = useState(false)
  useEffect(() => {
    setMessage(workspace.adminMessage ?? '')
    setMessageDirty(false)
  }, [workspace.adminMessage, workspace.id])
  useEffect(() => {
    if (!messageDirty && detail.data !== undefined)
      setMessage(detail.data.workspace.adminMessage ?? '')
  }, [detail.data, messageDirty])
  const mutate = useMutation({
    mutationFn: (input: InternalAdminWorkspaceMutationRequest) =>
      api.internalAdminMutateWorkspace(workspace.id, input),
    onSuccess: async (_result, input) => {
      if (input.operation === 'credit') setAmount('')
      await queryClient.invalidateQueries({
        queryKey: duetQueryKeys.admin.workspace(workspace.id),
      })
      await queryClient.invalidateQueries({
        queryKey: duetQueryKeys.admin.searches,
      })
      if (input.operation === 'payer') setPayerId('')
      if (input.operation === 'message' || input.operation === 'payer')
        await queryClient.invalidateQueries({
          queryKey: duetQueryKeys.identity,
        })
    },
  })
  return (
    <div
      className="space-y-5"
      data-admin-query="workspace"
      data-query-status={detail.status}
      data-fetch-status={detail.fetchStatus}
    >
      <button
        onClick={onBack}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon />
        {t('workspace.back')}
      </button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold">{workspace.name}</h2>
            <StatusBadge
              value={detail.data?.workspace.servicingStatus ?? workspace.servicingStatus}
            />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {workspace.id} · {workspace.slug}
          </p>
        </div>
        <label className="w-full sm:w-80">
          <span className="mb-1 block text-xs font-medium">{t('reason')}</span>
          <input
            value={reason}
            onChange={event => setReason(event.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
      </div>
      {detail.isPending ? (
        <AdminState busy title={t('loading.title')} body={t('loading.workspace')} />
      ) : null}
      {detail.isError ? (
        <AdminState
          icon="error"
          title={t('error.title')}
          body={t('error.body')}
          actionLabel={t('error.retry')}
          onAction={() => void detail.refetch()}
        />
      ) : null}
      {detail.data ? (
        <>
          <VmOperations api={api} workspace={detail.data.workspace} reason={reason} />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric
              label={t('workspace.paidBalance')}
              value={formatMoney(detail.data.workspace.paidCreditBalanceMicroUsd)}
            />
            <Metric
              label={t('workspace.monthlyBalance')}
              value={formatMoney(detail.data.workspace.monthlyCreditBalanceMicroUsd)}
            />
            <Metric
              label={t('workspace.monthSpend')}
              value={formatMoney(detail.data.usage.spendMicroUsd)}
            />
            <Metric
              label={t('workspace.membersLabel')}
              value={String(detail.data.workspace.memberCount)}
            />
            <Metric
              label={t('workspace.stripe')}
              value={detail.data.workspace.stripeCustomerId ?? t('workspace.none')}
              mono
            />
          </div>
          <SyncHealth value={detail.data.syncHealth} />
          <div className="grid gap-5 xl:grid-cols-2">
            <Panel title={t('workspace.controls')} body={t('workspace.controlsBody')}>
              <div className="grid gap-3 sm:grid-cols-2">
                {detail.data.workspace.servicingStatus === 'paused' ? (
                  <button
                    disabled={
                      mutate.isPending || detail.data.workspace.servicingExemptAt !== undefined
                    }
                    onClick={() => mutate.mutate({ operation: 'unpause', reason })}
                    className={buttonVariants()}
                  >
                    {mutate.isPending && mutate.variables?.operation === 'unpause' ? (
                      <SpinnerGapIcon className="animate-spin" aria-hidden="true" />
                    ) : null}
                    {t('workspace.unpause')}
                  </button>
                ) : null}
                <button
                  disabled={mutate.isPending || detail.data.workspace.servicingStatus === 'banned'}
                  onClick={() => mutate.mutate({ operation: 'ban', reason })}
                  className={buttonVariants({ variant: 'destructive' })}
                >
                  {t('workspace.ban')}
                </button>
                <button
                  disabled={
                    mutate.isPending || detail.data.workspace.disputeFlaggedAt === undefined
                  }
                  onClick={() => mutate.mutate({ operation: 'dispute_clear', reason })}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('workspace.clearDispute')}
                </button>
                <button
                  disabled={mutate.isPending}
                  onClick={() =>
                    mutate.mutate({
                      operation: 'suspension',
                      suspended: !detail.data.workspace.suspended,
                      confirmation: workspace.slug,
                      reason,
                    })
                  }
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {detail.data.workspace.suspended ? t('workspace.resume') : t('workspace.suspend')}
                </button>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4 border-t pt-4">
                <div>
                  <p className="text-sm font-medium">{t('workspace.servicingExemption')}</p>
                  <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                    {t('workspace.servicingExemptionBody')}
                  </p>
                </div>
                <PauseSwitch
                  checked={detail.data.workspace.servicingExemptAt !== undefined}
                  disabled={mutate.isPending}
                  label={t('workspace.servicingExemption')}
                  onCheckedChange={exempt =>
                    mutate.mutate({ operation: 'servicing_exempt', exempt, reason })
                  }
                />
              </div>
              <div className="mt-4 border-t pt-4">
                <p className="break-all text-sm">
                  {t('workspace.currentPayer', {
                    email: detail.data.workspace.billingEmail,
                  })}
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1 block text-xs font-medium">
                      {t('workspace.newPayer')}
                    </span>
                    <select
                      value={payerId}
                      disabled={mutate.isPending}
                      onChange={event => setPayerId(event.target.value)}
                      className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="">{t('workspace.choosePayer')}</option>
                      {detail.data.usage.members
                        .filter(
                          member =>
                            member.role === 'owner' &&
                            member.userId !== detail.data.workspace.billingUserId,
                        )
                        .map(member => (
                          <option key={member.userId} value={member.userId}>
                            {member.name ? `${member.name} — ${member.email}` : member.email}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    className={buttonVariants()}
                    disabled={mutate.isPending || !payerId || reason.trim().length < 3}
                    onClick={() =>
                      mutate.mutate({
                        operation: 'payer',
                        newBillingUserId: payerId,
                        reason,
                      })
                    }
                  >
                    {mutate.isPending && mutate.variables?.operation === 'payer' ? (
                      <SpinnerGapIcon className="animate-spin" aria-hidden="true" />
                    ) : null}
                    {t('workspace.changePayer')}
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('workspace.payerHint')}</p>
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={message}
                  onChange={event => {
                    setMessage(event.target.value)
                    setMessageDirty(true)
                  }}
                  placeholder={t('workspace.messagePlaceholder')}
                  className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
                />
                <button
                  disabled={mutate.isPending}
                  onClick={() => mutate.mutate({ operation: 'message', message, reason })}
                  className={buttonVariants()}
                >
                  {t('save')}
                </button>
              </div>
            </Panel>
            <Panel title={t('workspace.adjust')} body={t('workspace.adjustBody')}>
              <div className="flex gap-2">
                <input
                  inputMode="decimal"
                  disabled={mutate.isPending}
                  value={amount}
                  onChange={event => setAmount(event.target.value)}
                  placeholder="25.00"
                  className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
                />
                <button
                  onClick={() =>
                    mutate.mutate({
                      operation: 'credit',
                      amountMicroUsd: Math.round(Number(amount) * 1_000_000),
                      reason,
                    })
                  }
                  disabled={mutate.isPending || !Number(amount)}
                  aria-busy={mutate.isPending && mutate.variables?.operation === 'credit'}
                  className={buttonVariants()}
                >
                  {mutate.isPending && mutate.variables?.operation === 'credit' ? (
                    <SpinnerGapIcon className="animate-spin" aria-hidden="true" />
                  ) : null}
                  {t('workspace.apply')}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t('workspace.adjustHint')}</p>
            </Panel>
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <Panel title={t('workspace.memberUsage')}>
              <div className="divide-y">
                {detail.data.usage.members.map(member => (
                  <div
                    key={member.userId}
                    className="flex items-center justify-between gap-3 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{member.name ?? member.email}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email} · {member.role}
                      </p>
                    </div>
                    <span className="font-mono text-xs">{formatMoney(member.spendMicroUsd)}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title={t('workspace.ledger')}>
              <div className="max-h-80 divide-y overflow-auto">
                {detail.data.ledger.map(row => (
                  <div
                    key={row.id}
                    data-ledger-type={row.type}
                    data-ledger-amount-micro-usd={row.amountMicroUsd}
                    className="flex items-center justify-between gap-3 py-3 text-xs"
                  >
                    <div>
                      <p className="font-medium">{row.type}</p>
                      <p className="max-w-64 truncate font-mono text-muted-foreground">
                        {row.reference}
                      </p>
                    </div>
                    <span
                      className={row.amountMicroUsd >= 0 ? 'text-emerald-600' : 'text-foreground'}
                    >
                      {formatMoney(row.amountMicroUsd)}
                    </span>
                  </div>
                ))}
                {detail.data.ledger.length === 0 ? (
                  <p className="py-6 text-sm text-muted-foreground">{t('empty.ledger')}</p>
                ) : null}
              </div>
            </Panel>
          </div>
        </>
      ) : null}
      {mutate.isError ? <InlineNotice error>{t('error.mutation')}</InlineNotice> : null}
      {mutate.isSuccess ? <InlineNotice>{t('saved')}</InlineNotice> : null}
    </div>
  )
}

function SyncHealth({ value }: { value: InternalAdminWorkspaceDetail['syncHealth'] }) {
  const t = useTranslations('duetAdmin')
  const locale = useLocale()
  return (
    <Panel
      title={t('workspace.syncHealth')}
      body={value.batches === 0 ? t('workspace.syncEmpty') : t('workspace.syncHealthBody')}
    >
      <div
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
        data-sync-health={`${value.batches}:${value.droppedReads}:${value.overflow}`}
      >
        <Metric label={t('workspace.syncBatches')} value={String(value.batches)} />
        <Metric
          label={t('workspace.syncDroppedReads')}
          value={value.batches === 0 ? t('workspace.syncNever') : String(value.droppedReads)}
        />
        <Metric
          label={t('workspace.syncOverflow')}
          value={value.batches === 0 ? t('workspace.syncNever') : String(value.overflow)}
        />
        <Metric
          label={t('workspace.syncLastBatch')}
          value={
            value.lastRecordedAt === undefined
              ? t('workspace.syncNever')
              : new Intl.DateTimeFormat(locale, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                  timeZone: 'UTC',
                }).format(value.lastRecordedAt)
          }
        />
      </div>
    </Panel>
  )
}

function VmOperations({
  api,
  workspace,
  reason,
}: {
  api: InternalAdminApi
  workspace: InternalAdminWorkspaceSummary
  reason: string
}) {
  const t = useTranslations('duetAdmin')
  const client = useQueryClient()
  const [enabled, setEnabled] = useState(false)
  const [path, setPath] = useState('')
  const [selectedFile, setSelectedFile] = useState<string>()
  const [logSelection, setLogSelection] = useState<string>()
  const [command, setCommand] = useState('uptime')
  const status = useQuery({
    ...duetQueryOptions.admin.vm(api, workspace.id),
    enabled,
  })
  const files = useQuery({
    ...duetQueryOptions.admin.files(api, workspace.id, path),
    enabled,
  })
  const file = useQuery({
    ...duetQueryOptions.admin.file(api, workspace.id, selectedFile),
    enabled: selectedFile !== undefined,
  })
  const [logSource, logAnchorId] = (logSelection ?? 'gateway').split(':', 2) as [
    'gateway' | 'agent',
    string | undefined,
  ]
  const logs = useQuery({
    ...duetQueryOptions.admin.logs(api, workspace.id, logSource, logAnchorId),
    enabled: logSelection !== undefined,
  })
  const run = useMutation({
    mutationFn: () => api.internalAdminCommand(workspace.id, command, reason),
  })
  const operation = useMutation({
    mutationFn: (value: InternalAdminVmOperation) =>
      api.internalAdminVmOperation(workspace.id, value, reason, workspace.slug),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: duetQueryKeys.admin.vm(workspace.id),
      }),
  })
  const backupId = operation.data?.status === 'backup_pending' ? operation.data.backupId : undefined
  const backup = useQuery({
    queryKey: [...duetQueryKeys.admin.vm(workspace.id), 'backup', backupId],
    queryFn: ({ signal }) => api.internalAdminVmBackup(workspace.id, backupId!, signal),
    enabled: backupId !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (!enabled)
    return (
      <button
        onClick={() => setEnabled(true)}
        className="flex min-h-20 w-full items-center justify-between rounded-xl border bg-background px-5 text-left shadow-sm"
      >
        <span>
          <strong className="block text-sm">{t('vm.title')}</strong>
          <span className="text-xs text-muted-foreground">{t('vm.lazy')}</span>
        </span>
        <CaretRightIcon />
      </button>
    )
  return (
    <Panel title={t('vm.title')} body={t('vm.body')}>
      <section className="mb-5 rounded-xl border bg-muted/20 p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold">{t('vm.logs')}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{t('vm.logsBody')}</p>
          </div>
          {logSelection === undefined ? (
            <button
              onClick={() => setLogSelection('gateway')}
              className="min-h-10 rounded-lg border bg-background px-4 text-xs font-semibold"
            >
              {t('vm.loadLogs')}
            </button>
          ) : (
            <div className="flex gap-2 sm:min-w-96">
              <select
                aria-label={t('vm.logSource')}
                value={logSelection}
                onChange={event => setLogSelection(event.target.value)}
                className="min-h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-xs"
              >
                <option value="gateway">{t('vm.gatewayLog')}</option>
                {logSource === 'agent' && logAnchorId !== undefined ? (
                  <option value={`agent:${logAnchorId}`}>
                    {t('vm.agentLog', { anchorId: logAnchorId })}
                  </option>
                ) : null}
                {logs.data?.available
                  .filter(
                    (
                      entry,
                    ): entry is typeof entry & {
                      source: 'agent'
                      anchorId: string
                    } =>
                      entry.source === 'agent' &&
                      entry.anchorId !== undefined &&
                      entry.anchorId !== logAnchorId,
                  )
                  .map(entry => (
                    <option key={entry.anchorId} value={`agent:${entry.anchorId}`}>
                      {t('vm.agentLog', { anchorId: entry.anchorId })}
                    </option>
                  ))}
              </select>
              <button
                aria-label={t('vm.refreshLogs')}
                onClick={() => void logs.refetch()}
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-xs font-medium"
              >
                <ArrowsClockwiseIcon className={logs.isFetching ? 'animate-spin' : undefined} />
                <span>{t('vm.refreshLogs')}</span>
              </button>
            </div>
          )}
        </div>
        {logSelection === undefined ? null : (
          <>
            <div
              aria-live="polite"
              className="mt-3 min-h-28 max-h-80 overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100 sm:p-4"
              role="log"
            >
              {(logs.isPending
                ? t('loading.title')
                : logs.isError
                  ? t('error.upstream')
                  : (logs.data?.content ?? t('vm.noLogs'))
              )
                .split('\n')
                .map((line, index, lines) => (
                  <div
                    key={`${index}:${line}`}
                    className="whitespace-pre-wrap break-words border-b border-white/10 py-1 first:pt-0 last:border-b-0 last:pb-0"
                  >
                    {line || (index === lines.length - 1 ? null : '\u00a0')}
                  </div>
                ))}
            </div>
            {logs.data?.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('vm.logsTruncated')}</p>
            ) : null}
          </>
        )}
      </section>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t('vm.health')}</h4>
          {status.isPending ? (
            <SpinnerGapIcon className="animate-spin" />
          ) : (
            <div className="rounded-xl bg-muted/50 p-3 text-xs">
              <p>
                {t('vm.control')}:{' '}
                <strong>{status.data?.controlStatus ?? t('workspace.none')}</strong>
              </p>
              <p>
                {t('vm.gateway')}:{' '}
                <strong>
                  {status.data?.gateway?.reachable ? t('vm.reachable') : t('vm.unreachable')}
                </strong>
              </p>
              <p className="mt-2 break-all font-mono text-muted-foreground">
                {t('vm.runtime')}: {status.data?.gateway?.runtimeVersion ?? '—'}
              </p>
            </div>
          )}
          <InternalAdminVmOperationNotice
            result={operation.data}
            backup={backup.data}
            error={operation.isError || backup.isError}
          />
          {backupId ? (
            <button
              onClick={() => void backup.refetch()}
              disabled={backup.isFetching}
              className="min-h-10 rounded-lg border px-3 text-xs font-semibold disabled:opacity-40"
            >
              {t('vm.refreshBackup')}
            </button>
          ) : null}
          <div className="grid grid-cols-2 gap-1">
            {INTERNAL_ADMIN_VM_OPERATIONS.map(value => (
              <button
                key={value}
                disabled={operation.isPending}
                onClick={() => operation.mutate(value)}
                className="min-h-10 rounded-lg border px-2 text-[11px] font-semibold disabled:opacity-40"
              >
                {t(`vm.${value}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t('vm.files')}</h4>
          <div className="rounded-xl border p-2">
            <button
              onClick={() => {
                setPath(path.split('/').slice(0, -1).join('/'))
                setSelectedFile(undefined)
              }}
              disabled={!path && selectedFile === undefined}
              className="mb-2 text-xs text-muted-foreground disabled:opacity-40"
            >
              .. / {path || t('vm.root')}
            </button>
            {files.isPending ? (
              <SpinnerGapIcon className="m-3 animate-spin" />
            ) : (
              files.data?.entries.map(entry => (
                <button
                  key={entry.path}
                  aria-label={entry.name}
                  onClick={() =>
                    entry.kind === 'directory' ? setPath(entry.path) : setSelectedFile(entry.path)
                  }
                  className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <span className="truncate">
                    {entry.kind === 'directory' ? '▸ ' : ''}
                    {entry.name}
                  </span>
                  <span className="text-muted-foreground">{entry.size ?? ''}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{selectedFile ? selectedFile : t('vm.command')}</h4>
          {selectedFile ? (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-950 p-3 text-[11px] text-zinc-100">
              {file.data?.content ?? t('loading.title')}
            </pre>
          ) : (
            <>
              <select
                aria-label={t('vm.command')}
                value={command}
                onChange={event => setCommand(event.target.value)}
                className="min-h-10 w-full rounded-lg border bg-background px-3 text-xs"
              >
                {['pwd', 'uptime', 'df -h', 'du -sh .', 'git status --short'].map(value => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <button
                onClick={() => run.mutate()}
                className="min-h-10 w-full rounded-lg bg-zinc-900 text-xs font-semibold text-white"
              >
                {t('vm.run')}
              </button>
              <pre className="min-h-28 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-950 p-3 text-[11px] text-zinc-100">
                {run.data ? `${run.data.stdout}${run.data.stderr}` : t('vm.output')}
              </pre>
            </>
          )}
        </div>
      </div>
      {operation.isError || run.isError ? (
        <InlineNotice error>{t('error.upstream')}</InlineNotice>
      ) : null}
    </Panel>
  )
}

function formatFleetDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = ms / 1000
  if (seconds < 90) return `${Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${Math.round(hours / 24)}d`
}

function FleetOperations({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const locale = useLocale()
  const query = useQuery(duetQueryOptions.admin.fleetHealth(api))
  const numberFormat = new Intl.NumberFormat(locale)
  const data = query.data
  return (
    <div
      className="space-y-6"
      data-admin-query="fleet"
      data-query-status={query.status}
      data-fetch-status={query.fetchStatus}
    >
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('fleet.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('fleet.body')}</p>
        </div>
        <button
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className={cn(buttonVariants({ variant: 'outline' }), 'gap-1.5')}
        >
          <ArrowsClockwiseIcon className={query.isFetching ? 'animate-spin' : undefined} />
          {t('fleet.refresh')}
        </button>
      </div>
      {query.isPending ? (
        <AdminState busy title={t('loading.title')} body={t('loading.fleet')} />
      ) : null}
      {query.isError ? (
        <AdminState
          icon="error"
          title={t('error.title')}
          body={t('error.body')}
          actionLabel={t('error.retry')}
          onAction={() => void query.refetch()}
        />
      ) : null}
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label={t('fleet.metrics.activeVms')}
              value={numberFormat.format(data.activeCount)}
            />
            <Metric
              label={t('fleet.metrics.runtime')}
              value={
                data.versions.runtime.length === 0
                  ? '—'
                  : t('fleet.buildCount', {
                      count: data.versions.runtime.length,
                    })
              }
            />
            <Metric
              label={t('fleet.metrics.staleHeartbeats')}
              value={numberFormat.format(data.staleHeartbeatCount)}
            />
            <Metric
              label={t('fleet.metrics.updateBrake')}
              value={data.updates.paused ? t('fleet.brakeOn') : t('fleet.brakeOff')}
            />
          </div>
          {data.truncated ? <InlineNotice error>{t('fleet.truncated')}</InlineNotice> : null}
          <Panel
            title={t('fleet.vms.title')}
            body={t('fleet.vms.body', {
              withSample: data.telemetry.withSample,
              missing: data.telemetry.missing,
              freshest:
                data.telemetry.newestSampleAgeMs === undefined
                  ? '—'
                  : formatFleetDuration(data.telemetry.newestSampleAgeMs),
            })}
          >
            {data.vms.length === 0 ? (
              <AdminState title={t('empty.fleetTitle')} body={t('empty.fleetBody')} />
            ) : (
              <div>
                <p className="mb-3 text-xs text-muted-foreground">{t('fleet.vms.scroll')}</p>
                <div
                  className="overflow-x-auto rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  role="region"
                  aria-label={t('fleet.vms.title')}
                  tabIndex={0}
                >
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="sticky left-0 z-20 bg-background py-2 pr-3 font-medium">
                          {t('fleet.vms.workspace')}
                        </th>
                        <th className="py-2 pr-3 font-medium">{t('fleet.vms.status')}</th>
                        <th className="py-2 pr-3 text-right font-medium">
                          <span className="sticky right-0 inline-block bg-background">
                            {t('fleet.vms.runtime')}
                          </span>
                        </th>
                        <th className="py-2 pr-3 text-right font-medium">
                          {t('fleet.vms.heartbeat')}
                        </th>
                        <th className="py-2 pr-3 text-right font-medium">{t('fleet.vms.cpu')}</th>
                        <th className="py-2 pr-3 text-right font-medium">
                          {t('fleet.vms.memory')}
                        </th>
                        <th className="py-2 text-right font-medium">{t('fleet.vms.sampleAge')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.vms.map(vm => (
                        <FleetVmRow
                          key={vm.workspaceId}
                          vm={vm}
                          noSample={t('fleet.vms.noSample')}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}

function FleetVmRow({ vm, noSample }: { vm: InternalAdminFleetVm; noSample: string }) {
  const heartbeatStale =
    vm.heartbeatAgeMs === undefined || vm.heartbeatAgeMs > INTERNAL_ADMIN_STALE_HEARTBEAT_MS
  // A whole allocated core of steady use is the runaway-loop signature.
  const cpuHot = vm.cpuCores !== undefined && vm.cpuCores >= 1
  return (
    <tr className="border-b last:border-0">
      <td className="sticky left-0 z-10 bg-background py-2 pr-3">
        <span className="font-medium">{vm.slug}</span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-1">
          <StatusBadge value={vm.status} />
          {vm.servicingStatus && vm.servicingStatus !== 'active' ? (
            <StatusBadge value={vm.servicingStatus} />
          ) : null}
        </div>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-muted-foreground">
        {vm.runtimeVersion ?? '—'}
      </td>
      <td
        className={cn(
          'py-2 pr-3 text-right tabular-nums',
          heartbeatStale && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {vm.heartbeatAgeMs === undefined ? '—' : formatFleetDuration(vm.heartbeatAgeMs)}
      </td>
      <td
        className={cn(
          'py-2 pr-3 text-right',
          cpuHot && 'font-semibold text-amber-700 dark:text-amber-400',
        )}
      >
        {vm.cpuCores === undefined ? (
          <span className="text-muted-foreground">{noSample}</span>
        ) : (
          // The cores value keeps a fixed right edge (the percent lives in its own
          // fixed-width column) so decimals align down the rows for quick scanning.
          <span className="inline-flex items-baseline justify-end gap-1">
            <span className="tabular-nums">{vm.cpuCores.toFixed(2)}</span>
            {vm.cpuPct === undefined ? null : (
              <span className="w-10 text-left text-xs tabular-nums text-muted-foreground">
                {' '}
                {Math.round(vm.cpuPct)}%
              </span>
            )}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
        {vm.memUsedMb === undefined ? '—' : `${(vm.memUsedMb / 1024).toFixed(1)}G`}
      </td>
      <td className="py-2 text-right tabular-nums text-muted-foreground">
        {vm.sampleAgeMs === undefined ? '—' : formatFleetDuration(vm.sampleAgeMs)}
      </td>
    </tr>
  )
}

/**
 * Fleet-wide model spend. The server folds settled calls into per-period rows
 * every few minutes; this view only reads them, so cost and billed always come
 * from the same settled calls.
 */
function InferenceOperations({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const locale = useLocale()
  const [granularity, setGranularity] = useState<UsageReportPeriod>('daily')
  // Unset reads the window ending now; paging sets it to a neighbour's anchor.
  const [through, setThrough] = useState<number>()
  // Periods the operator toggled; untouched, only the newest period is open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const query = useQuery(duetQueryOptions.admin.inferenceMargin(api, granularity, through))
  const page = (anchor: number | undefined) => {
    setThrough(anchor)
    setToggled({})
  }
  const numberFormat = new Intl.NumberFormat(locale)
  const data = query.data
  return (
    <div
      className="space-y-6"
      data-admin-query="inference"
      data-query-status={query.status}
      data-fetch-status={query.fetchStatus}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t('inference.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('inference.body')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label={t('inference.granularityLabel')}
            className="flex rounded-lg border bg-muted/40 p-1"
          >
            {UsageReportPeriodSchema.options.map(item => (
              <button
                key={item}
                aria-pressed={granularity === item}
                onClick={() => {
                  setGranularity(item)
                  page(undefined)
                }}
                className={cn(
                  'min-h-8 rounded-md px-3 text-sm font-medium',
                  granularity === item
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`inference.granularity.${item}`)}
              </button>
            ))}
          </div>
          <button
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className={cn(buttonVariants({ variant: 'outline' }), 'gap-1.5')}
          >
            <ArrowsClockwiseIcon className={query.isFetching ? 'animate-spin' : undefined} />
            {t('inference.refresh')}
          </button>
        </div>
      </div>
      {query.isPending ? (
        <AdminState busy title={t('loading.title')} body={t('loading.inference')} />
      ) : null}
      {query.isError ? (
        <AdminState
          icon="error"
          title={t('error.title')}
          body={t('error.body')}
          actionLabel={t('error.retry')}
          onAction={() => void query.refetch()}
        />
      ) : null}
      {data ? (
        <>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">
                  {t('inference.window', data.window)}
                </span>
                {data.updatedAt === undefined
                  ? null
                  : ` · ${t('inference.updated', {
                      time: new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'UTC',
                      }).format(data.updatedAt),
                    })}`}
              </p>
              <div className="flex gap-1">
                <button
                  onClick={() => page(data.olderThrough)}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1')}
                >
                  <CaretLeftIcon />
                  {t('inference.older')}
                </button>
                <button
                  disabled={data.newerThrough === undefined}
                  onClick={() => page(data.newerThrough)}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1')}
                >
                  {t('inference.newer')}
                  <CaretRightIcon />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Metric
                label={t('inference.metrics.upstream')}
                value={formatMoney(data.totals.upstreamCostMicroUsd)}
              />
              <Metric
                label={t('inference.metrics.billed')}
                value={formatMoney(data.totals.billedCostMicroUsd)}
              />
              <Metric
                label={t('inference.metrics.margin')}
                value={formatMoney(
                  data.totals.billedCostMicroUsd - data.totals.upstreamCostMicroUsd,
                )}
              />
              <Metric label={t('inference.metrics.ratio')} value={billedRatio(data.totals)} />
              <Metric
                label={t('inference.metrics.calls')}
                value={numberFormat.format(data.totals.calls)}
              />
            </div>
          </div>
          {data.truncated ? <InlineNotice error>{t('inference.truncated')}</InlineNotice> : null}
          {data.periods.length === 0 ? (
            <AdminState title={t('empty.inferenceTitle')} body={t('empty.inferenceBody')} />
          ) : (
            <>
              <Panel title={t('inference.periods.title')} body={t('inference.periods.body')}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <InferenceHeader first={t('inference.columns.period')} />
                    </thead>
                    <tbody>
                      {data.periods.map((period, index) => {
                        const open = toggled[period.period] ?? index === 0
                        return (
                          <Fragment key={period.period}>
                            <tr className="border-b last:border-0">
                              <td className="py-2 pr-3">
                                <button
                                  aria-expanded={open}
                                  aria-label={t(open ? 'inference.collapse' : 'inference.expand', {
                                    period: period.period,
                                  })}
                                  onClick={() =>
                                    setToggled(current => ({
                                      ...current,
                                      [period.period]: !open,
                                    }))
                                  }
                                  className="inline-flex items-center gap-1.5 font-medium tabular-nums"
                                >
                                  <CaretRightIcon
                                    className={cn('transition-transform', open && 'rotate-90')}
                                  />
                                  {period.period}
                                </button>
                              </td>
                              <InferenceAmountCells amounts={period} numberFormat={numberFormat} />
                            </tr>
                            {open
                              ? period.tiers.map(tier => (
                                  <tr
                                    key={tier.tier ?? ''}
                                    className="border-b bg-muted/30 text-muted-foreground last:border-0"
                                  >
                                    <td className="py-1.5 pl-6 pr-3 text-xs">
                                      {tier.tier ?? t('inference.untiered')}
                                    </td>
                                    <InferenceAmountCells
                                      amounts={tier}
                                      numberFormat={numberFormat}
                                    />
                                  </tr>
                                ))
                              : null}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title={t('inference.models.title')} body={t('inference.models.body')}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[880px] text-sm">
                    <thead>
                      <InferenceHeader
                        first={t('inference.columns.model')}
                        lead={[
                          t('inference.columns.tier'),
                          t('inference.columns.provider'),
                          t('inference.columns.routeSource'),
                        ]}
                      />
                    </thead>
                    <tbody>
                      {data.models.map(model => (
                        <tr
                          key={`${model.tier ?? ''}|${model.model}|${model.provider ?? ''}|${model.routeSource ?? ''}`}
                          className={cn(
                            'border-b last:border-0',
                            model.billedCostMicroUsd < model.upstreamCostMicroUsd &&
                              'bg-destructive/5',
                          )}
                        >
                          <td className="py-2 pr-3 font-mono text-xs">{model.model}</td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {model.tier ?? t('inference.untiered')}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {model.provider ?? t('inference.unknownProvider')}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {model.routeSource ?? t('inference.unknownRouteSource')}
                          </td>
                          <InferenceAmountCells amounts={model} numberFormat={numberFormat} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}
        </>
      ) : null}
    </div>
  )
}

function InferenceHeader({ first, lead = [] }: { first: string; lead?: string[] }) {
  const t = useTranslations('duetAdmin')
  return (
    <tr className="border-b text-left text-xs text-muted-foreground">
      {[first, ...lead].map(label => (
        <th key={label} className="py-2 pr-3 font-medium">
          {label}
        </th>
      ))}
      {(['calls', 'upstream', 'billed', 'margin', 'ratio'] as const).map(column => (
        <th key={column} className="py-2 pr-3 text-right font-medium last:pr-0">
          {t(`inference.columns.${column}`)}
        </th>
      ))}
    </tr>
  )
}

type InferenceAmounts = InternalAdminInferenceMargin['totals']

function InferenceAmountCells({
  amounts,
  numberFormat,
}: {
  amounts: InferenceAmounts
  numberFormat: Intl.NumberFormat
}) {
  const margin = amounts.billedCostMicroUsd - amounts.upstreamCostMicroUsd
  return (
    <>
      <td className="py-2 pr-3 text-right tabular-nums">{numberFormat.format(amounts.calls)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">
        {formatMoney(amounts.upstreamCostMicroUsd)}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        {formatMoney(amounts.billedCostMicroUsd)}
      </td>
      <td
        className={cn(
          'py-2 pr-3 text-right tabular-nums',
          margin < 0 && 'font-semibold text-destructive',
        )}
      >
        {formatMoney(margin)}
      </td>
      <td className="py-2 text-right tabular-nums">{billedRatio(amounts)}</td>
    </>
  )
}

/** Billed per dollar of upstream cost; a call with no reported cost has no ratio. */
function billedRatio(amounts: InferenceAmounts): string {
  if (amounts.upstreamCostMicroUsd === 0) return '—'
  return `${(amounts.billedCostMicroUsd / amounts.upstreamCostMicroUsd).toFixed(2)}×`
}

function FeedbackOperations({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const client = useQueryClient()
  const [archived, setArchived] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<InternalAdminFeedback>()
  const key = duetQueryKeys.admin.feedback(archived)
  const query = useQuery(duetQueryOptions.admin.feedback(api, archived))
  const mutate = useMutation({
    mutationFn: ({
      row,
      operation,
    }: {
      row: InternalAdminFeedback
      operation: 'archive' | 'unarchive' | 'delete'
    }) => api.internalAdminMutateFeedback(row.id, operation, t('defaults.feedbackReason')),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  })
  return (
    <div
      className="space-y-5"
      data-admin-query="feedback"
      data-query-variant={archived ? 'archived' : 'active'}
      data-query-status={query.status}
      data-fetch-status={query.fetchStatus}
    >
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('feedback.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('feedback.body')}</p>
        </div>
        <button
          onClick={() => setArchived(value => !value)}
          className={buttonVariants({ variant: 'outline' })}
        >
          {archived ? t('feedback.active') : t('feedback.archived')}
        </button>
      </div>
      {query.isPending ? (
        <AdminState busy title={t('loading.title')} body={t('loading.feedback')} />
      ) : null}
      {query.isError ? (
        <AdminState
          icon="error"
          title={t('error.title')}
          body={t('error.body')}
          actionLabel={t('error.retry')}
          onAction={() => void query.refetch()}
        />
      ) : null}
      <div className="grid gap-3">
        {query.data?.feedback.map(row => (
          <article key={row.id} className="rounded-xl border bg-background p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {row.source ?? t('feedback.unknown')} ·{' '}
                  {new Date(row.createdAt).toLocaleDateString()}
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{row.content}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                <button
                  aria-label={archived ? t('feedback.unarchive') : t('feedback.archive')}
                  onClick={() =>
                    mutate.mutate({
                      row,
                      operation: archived ? 'unarchive' : 'archive',
                    })
                  }
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium"
                >
                  <ArchiveBoxIcon />
                  {archived ? t('feedback.unarchive') : t('feedback.archive')}
                </button>
                <button
                  aria-label={t('feedback.delete')}
                  onClick={() => setPendingDelete(row)}
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-destructive/30 px-3 text-xs font-medium text-destructive"
                >
                  <TrashIcon />
                  {t('feedback.delete')}
                </button>
              </div>
            </div>
          </article>
        ))}
        {query.data?.feedback.length === 0 ? (
          <AdminState title={t('empty.feedbackTitle')} body={t('empty.feedbackBody')} />
        ) : null}
      </div>
      {pendingDelete ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-feedback-title"
            className="w-full max-w-md rounded-xl border bg-background p-6 shadow-2xl"
          >
            <h3 id="delete-feedback-title" className="text-lg font-semibold">
              {t('feedback.deleteTitle')}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t('feedback.deleteConfirm')}
            </p>
            <p className="mt-4 max-h-24 overflow-auto rounded-xl bg-muted p-3 text-sm">
              {pendingDelete.content}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(undefined)}
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('feedback.cancel')}
              </button>
              <button
                onClick={() => {
                  mutate.mutate({ row: pendingDelete, operation: 'delete' })
                  setPendingDelete(undefined)
                }}
                className={buttonVariants({ variant: 'destructive' })}
              >
                {t('feedback.deletePermanently')}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Operator takedown of a marketplace listing — the abuse lever.
 *
 * Addressed by listing id rather than a picker: the operator arrives here from a
 * report that already names the listing, and a browsable list would invite
 * taking down the wrong one of two same-named listings.
 */
function ListingTakedown({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const [listingId, setListingId] = useState('')
  const [reason, setReason] = useState(() => t('defaults.listingTakedownReason'))
  const takedown = useMutation({
    mutationFn: () => api.internalAdminTakedownListing(listingId.trim(), reason),
  })
  const ready = listingId.trim().length > 0 && !takedown.isPending
  return (
    <Panel title={t('listingTakedown.title')} body={t('listingTakedown.body')}>
      <label className="block text-xs font-medium">
        {t('listingTakedown.listingLabel')}
        <input
          value={listingId}
          onChange={event => setListingId(event.target.value)}
          data-testid="admin-takedown-listing-id"
          className="mt-1 min-h-10 w-full rounded-lg border bg-background px-3 font-mono text-sm"
        />
      </label>
      <label className="mt-3 block text-xs font-medium">
        {t('reason')}
        <input
          value={reason}
          onChange={event => setReason(event.target.value)}
          className="mt-1 min-h-10 w-full rounded-lg border bg-background px-3 text-sm"
        />
      </label>
      <button
        disabled={!ready}
        onClick={() => takedown.mutate()}
        data-testid="admin-takedown-submit"
        className={cn(buttonVariants({ variant: 'destructive' }), 'mt-3 w-full')}
      >
        {t('listingTakedown.action')}
      </button>
      {takedown.isError ? <InlineNotice error>{t('error.mutation')}</InlineNotice> : null}
      {takedown.isSuccess ? (
        <InlineNotice>
          {t(takedown.data.remaining ? 'listingTakedown.draining' : 'listingTakedown.done', {
            detached: takedown.data.detached,
          })}
        </InlineNotice>
      ) : null}
    </Panel>
  )
}

function CreditOperations({ api }: { api: InternalAdminApi }) {
  const t = useTranslations('duetAdmin')
  const client = useQueryClient()
  const [reason, setReason] = useState(() => t('defaults.freeCreditReason'))
  const query = useQuery(duetQueryOptions.admin.freeCredits(api))
  const reset = useMutation({
    mutationFn: () => api.internalAdminResetFreeCredits(reason, RESET_FREE_CREDITS_CONFIRMATION),
    onSuccess: () => client.invalidateQueries({ queryKey: duetQueryKeys.admin.freeCredits }),
  })
  return (
    <div
      className="grid gap-5 lg:grid-cols-[1fr_0.8fr]"
      data-admin-query="free-credits"
      data-query-status={query.status}
      data-fetch-status={query.fetchStatus}
    >
      <Panel title={t('credits.title')} body={t('credits.body')}>
        {query.isPending ? (
          <SpinnerGapIcon className="animate-spin" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label={t('credits.total')}
              value={formatMoney(query.data?.totalFreeCreditsMicroUsd ?? 0)}
            />
            <Metric label={t('credits.unpaid')} value={String(query.data?.unpaidUserCount ?? 0)} />
            <Metric
              label={t('credits.withBalance')}
              value={String(query.data?.usersWithBalanceCount ?? 0)}
            />
          </div>
        )}
      </Panel>
      <Panel title={t('credits.reset')} body={t('credits.resetBody')}>
        <label className="block text-xs font-medium">
          {t('reason')}
          <input
            value={reason}
            onChange={event => setReason(event.target.value)}
            className="mt-1 min-h-10 w-full rounded-lg border bg-background px-3 text-sm"
          />
        </label>
        <button
          disabled={reset.isPending}
          onClick={() => reset.mutate()}
          className={cn(buttonVariants({ variant: 'destructive' }), 'mt-3 w-full')}
        >
          {t('credits.resetAction')}
        </button>
        {reset.isError ? <InlineNotice error>{t('error.mutation')}</InlineNotice> : null}
        {reset.isSuccess ? <InlineNotice>{t('credits.resetDone')}</InlineNotice> : null}
      </Panel>
    </div>
  )
}

export function AdminState({
  title,
  body,
  busy = false,
  icon,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  busy?: boolean
  icon?: 'denied' | 'error'
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="grid min-h-52 place-items-center rounded-xl border border-dashed bg-background p-6 text-center">
      <div>
        {busy ? (
          <SpinnerGapIcon className="mx-auto mb-3 animate-spin text-primary" size={28} />
        ) : icon ? (
          <WarningCircleIcon className="mx-auto mb-3 text-amber-500" size={28} />
        ) : (
          <TerminalWindowIcon className="mx-auto mb-3 text-muted-foreground" size={28} />
        )}
        <h2 className="font-semibold">{title}</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
        {actionLabel && onAction ? (
          <button onClick={onAction} className={cn(buttonVariants({ variant: 'outline' }), 'mt-4')}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}
export function Panel({
  title,
  body,
  children,
}: {
  title: string
  body?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border bg-background p-5 shadow-sm">
      <h3 className="font-semibold">{title}</h3>
      {body ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}
export function Metric({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={`mt-2 truncate text-lg font-semibold ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </p>
    </div>
  )
}
export function StatusBadge({ value }: { value: string }) {
  const t = useTranslations('duetAdmin')
  const tone =
    value === 'active'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : value === 'banned'
        ? 'bg-red-500/10 text-red-700 dark:text-red-300'
        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {t(`status.${value}`)}
    </span>
  )
}
function InlineNotice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      className={`mt-3 flex items-center gap-2 rounded-lg p-2 text-xs ${error ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-700'}`}
    >
      {error ? <WarningCircleIcon /> : <CheckCircleIcon />}
      {children}
    </p>
  )
}
function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value / 1_000_000)
}

export function InternalAdminVmOperationNotice({
  result,
  backup,
  error = false,
}: {
  result?: InternalAdminVmOperationResult
  backup?: Backup
  error?: boolean
}) {
  const t = useTranslations('duetAdmin')
  if (!result && !error) return null
  const backupFailed =
    backup?.lifecycle?.status !== 'complete' &&
    backup !== undefined &&
    (['failed', 'deleting'].includes(backup.status) ||
      ['failed', 'deferred', 'abandoned'].includes(backup.lifecycle?.status ?? '') ||
      (backup.status === 'ready' && backup.completeness !== 'complete'))
  const blocked = error || result?.status === 'deferred' || backupFailed
  let message: string
  if (result?.status === 'backup_pending') {
    const backupId = result.backupId
    if (error) message = t('vm.backupUnknown', { backupId })
    else if (backup?.lifecycle?.status === 'complete')
      message = t('vm.backupComplete', { backupId })
    else if (backupFailed) {
      message = t('vm.backupFailed', {
        backupId,
        reason: backup?.error?.message ?? backup?.lifecycle?.reason ?? t('vm.backupUnavailable'),
      })
    } else if (backup?.lifecycle?.status === 'restoring')
      message = t('vm.backupRestoring', { backupId })
    else message = t('vm.backupAccepted', { backupId })
  } else if (error) message = t('error.upstream')
  else if (result?.status === 'deferred')
    message = t('vm.operationDeferred', {
      sessions: result.activeAgentSessions,
      jobs: result.activeTrainJobs,
    })
  else if (result?.status === 'provisioning') message = t('vm.operationProvisioning')
  else message = t('vm.operationComplete')
  return (
    <p
      role={blocked ? 'alert' : 'status'}
      className={`rounded-lg border p-3 text-xs leading-relaxed break-words ${blocked ? 'border-red-500/30 bg-red-500/10 text-red-700' : 'bg-muted/30'}`}
    >
      {message}
    </p>
  )
}
