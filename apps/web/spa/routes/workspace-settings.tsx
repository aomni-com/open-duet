'use client'

import { CheckCircle, ShieldCheck, Trash } from '@phosphor-icons/react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import type {
  ConnectedProviderId,
  CollectionPage,
  ConnectStartResponse,
  ModelSelectionId,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
} from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryKeys } from '../api/query-keys'
import {
  duetMutationOptions,
  duetQueryOptions,
  invalidateAfterConnectedProviderMutation,
  invalidateAfterPauseMutation,
  isInitialCollectionError,
  mapCollectionItems,
} from '../api/query-options'
import { projectConnectedProviderRows } from '../connected-providers/connected-provider-presentation'
import { ConnectedProvidersManagement } from '../connected-providers/connected-providers-management'
import { useSpa } from '../context'
import { UserAvatar } from '../identity/identity-avatar'
import { PublishesManagement } from '../publishes/publishes-management'
import { CollectionLoadMore } from '../settings/collection-load-more'
import {
  SettingsCard,
  SettingsFrame,
  SettingsMutationStatus,
  SettingsPage,
  SettingsState,
  formatMicroUsd,
} from '../settings/settings-frame'
import { TelemetryHistoryChart } from '../settings/telemetry-history-chart'
import { UsageSpendChart } from '../settings/usage-spend-chart'
import { UsageTierBadge } from '../settings/usage-tier-badge'
import { WorkspaceAppDomains } from '../settings/workspace-app-domains'
import { WorkspaceBackupsCard } from '../settings/workspace-backups-card'
import { WorkspaceDefaultTierCard } from '../settings/workspace-default-tier-card'
import { projectWorkspaceRoster } from '../settings/workspace-roster'
import { SharesManagement } from '../shares/shares-management'

/* An invitation can only carry the two roles an owner may hand out, and the
   contract already says which those are — reading it off the invite keeps the
   picker and the request that follows it from ever disagreeing. */
type WorkspaceInviteRole = WorkspaceInvite['role']

export default function WorkspaceSettingsRoute() {
  const { surface = 'general' } = useParams()
  return (
    <SettingsFrame kind="workspace">
      {surface === 'general' ? <GeneralSettings /> : null}
      {surface === 'backups' ? <BackupsSettings /> : null}
      {surface === 'app-domains' ? <AppDomainsSettings /> : null}
      {surface === 'members' ? <MembersSettings /> : null}
      {surface === 'shares' ? <SharesSettings /> : null}
      {surface === 'connected-providers' ? <ConnectedProvidersSettings /> : null}
      {surface === 'publishes' ? <WorkspaceResourceSettings /> : null}
      {surface === 'usage' ? <UsageSettings /> : null}
      {surface === 'audit' ? <AuditSettings /> : null}
      {surface === 'billing-user' ? <BillingUserSettings /> : null}
    </SettingsFrame>
  )
}

function ConnectedProvidersSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const queryClient = useQueryClient()
  const [connectSession, setConnectSession] = useState<
    (ConnectStartResponse & { provider: ConnectedProviderId }) | undefined
  >()
  const providers = useQuery(
    duetQueryOptions.workspaces.connectedProviders.list(api, workspace.slug),
  )
  const connect = useMutation(
    duetMutationOptions.workspaces.connectedProviders.connect(api, queryClient, workspace.slug),
  )
  const disconnect = useMutation(
    duetMutationOptions.workspaces.connectedProviders.disconnect(api, queryClient, workspace.slug),
  )
  const poll = useQuery({
    ...duetQueryOptions.workspaces.connectedProviders.poll(
      api,
      workspace.slug,
      connectSession?.sessionId ?? '',
      connectSession?.intervalMs ?? 0,
    ),
    enabled: connectSession !== undefined,
  })

  useEffect(() => {
    if (poll.data?.status === 'connected' || poll.data?.status === 'failed') {
      invalidateAfterConnectedProviderMutation(queryClient, workspace.slug)
    }
  }, [poll.data, queryClient, workspace.slug])

  return (
    <SettingsPage group="workspace" surface="connectedProviders">
      {providers.isPending ? (
        <SettingsState title={t('loading')} body={t('workspace.connectedProviders.loading')} busy />
      ) : providers.isError ? (
        <SettingsState
          title={t('loadError')}
          body={t('workspace.connectedProviders.loadError')}
          action={
            <button
              type="button"
              onClick={() => void providers.refetch()}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('workspace.connectedProviders.retry')}
            </button>
          }
        />
      ) : (
        <>
          <ConnectedProvidersManagement
            providers={projectConnectedProviderRows({
              listed: providers.data,
              connectSession,
              poll: poll.data,
              connectingProvider: connect.isPending ? connect.variables : undefined,
              failedProvider: connect.isError ? connect.variables : undefined,
              disconnectingProvider: disconnect.isPending ? disconnect.variables : undefined,
            })}
            onConnect={provider => {
              connect.mutate(provider, {
                onSuccess: session => setConnectSession({ ...session, provider }),
              })
            }}
            onDisconnect={provider => {
              disconnect.mutate(provider, {
                onSuccess: () => {
                  if (connectSession?.provider === provider) setConnectSession(undefined)
                },
              })
            }}
          />
          {connect.isError || disconnect.isError || poll.isError ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {t('workspace.connectedProviders.mutationError')}
            </p>
          ) : null}
        </>
      )}
    </SettingsPage>
  )
}

function useActiveWorkspace() {
  const { workspaceSlug = '' } = useParams()
  const { identity } = useSpa()
  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  if (workspace === undefined) throw new Error('Active workspace is missing')
  return workspace
}

function BackupsSettings() {
  const workspace = useActiveWorkspace()
  return (
    <SettingsPage group="workspace" surface="backups">
      <WorkspaceBackupsCard key={workspace.slug} workspace={workspace} />
    </SettingsPage>
  )
}

function AppDomainsSettings() {
  const workspace = useActiveWorkspace()
  return (
    <SettingsPage group="workspace" surface="appDomains">
      <WorkspaceAppDomains key={workspace.slug} workspaceSlug={workspace.slug} />
    </SettingsPage>
  )
}

function GeneralSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const identityOptions = duetQueryOptions.identity(api)
  const [name, setName] = useState(workspace.name)
  const [slug, setSlug] = useState(workspace.slug)
  const mutation = useMutation({
    mutationFn: async () => {
      await api.updateWorkspace(workspace.slug, { name, slug })
      return await api.whoami()
    },
    onSuccess: identity => {
      queryClient.setQueryData(identityOptions.queryKey, identity)
      navigate(`/w/${slug}/settings/general`, { replace: true })
    },
  })
  const defaultTierMutation = useMutation({
    mutationFn: async (tier: ModelSelectionId) => {
      await api.setWorkspaceDefaultTier(workspace.slug, tier)
      return await api.whoami()
    },
    onSuccess: identity => queryClient.setQueryData(identityOptions.queryKey, identity),
  })
  return (
    <SettingsPage group="workspace" surface="general">
      <div className="space-y-5">
        <SettingsCard
          title={t('workspace.general.identity')}
          description={t('workspace.general.help')}
        >
          <form
            className="space-y-5"
            onSubmit={event => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <Field label={t('workspace.general.name')}>
              <input
                value={name}
                onChange={event => setName(event.target.value)}
                disabled={workspace.role !== 'owner'}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60"
              />
            </Field>
            <Field label={t('workspace.general.url')} hint="duet.so/w/">
              <input
                value={slug}
                onChange={event => setSlug(event.target.value)}
                disabled={workspace.role !== 'owner'}
                className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm disabled:opacity-60"
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <RoleBadge role={workspace.role} />
              {workspace.role === 'owner' ? (
                <button
                  disabled={mutation.isPending || !name.trim() || !slug.trim()}
                  className={buttonVariants()}
                >
                  {mutation.isPending ? t('saving') : t('save')}
                </button>
              ) : (
                <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>
              )}
            </div>
            <SettingsMutationStatus mutation={mutation} />
          </form>
        </SettingsCard>
        <WorkspaceDefaultTierCard
          projection={workspace.defaultTier}
          role={workspace.role}
          pending={defaultTierMutation.isPending}
          onChange={tier => defaultTierMutation.mutate(tier)}
        />
        <SettingsMutationStatus mutation={defaultTierMutation} />
      </div>
    </SettingsPage>
  )
}

/**
 * One question — who is in this workspace — answered in one list. A person who
 * has been asked and has not answered yet is part of that answer, so an open
 * invitation is a row here rather than a page of its own, and the field that
 * creates one sits at the top of the same list it will add to.
 */
function MembersSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const queryClient = useQueryClient()
  const membersKey = duetQueryKeys.workspaces.members(workspace.slug)
  const invitesKey = duetQueryKeys.workspaces.invites(workspace.slug)
  /* Two capabilities meet on this page. Reading the roster needs `files:read`,
     which every member holds; everything to do with invitations needs
     `members`, which the backend grants to owners alone. So the list is for
     everyone and the controls are not, and the invitation query is asked only
     by the role allowed to answer it — an unconditional read here would spend
     a request per visit on a certain 403. */
  const canAdminister = workspace.role === 'owner'
  const members = useQuery(duetQueryOptions.workspaces.members(api, workspace.slug))
  const invites = useInfiniteQuery({
    ...duetQueryOptions.workspaces.invites(api, workspace.slug),
    enabled: canAdminister,
  })
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceInviteRole>('editor')
  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      api.updateWorkspaceMember(workspace.slug, userId, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membersKey }),
  })
  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.removeWorkspaceMember(workspace.slug, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membersKey }),
  })
  const inviteMutation = useMutation({
    mutationFn: () =>
      api.createWorkspaceInvite(workspace.slug, { email: inviteEmail, role: inviteRole }),
    onSuccess: () => {
      setInviteEmail('')
      void queryClient.invalidateQueries({ queryKey: invitesKey })
    },
  })
  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => api.revokeWorkspaceInvite(workspace.slug, inviteId),
    onSuccess: (result, inviteId) => {
      queryClient.setQueryData<InfiniteData<CollectionPage<WorkspaceInvite>, string | undefined>>(
        invitesKey,
        current =>
          mapCollectionItems(current, items =>
            items.map(invite =>
              invite.id === inviteId ? { ...invite, revokedAt: result.revokedAt } : invite,
            ),
          ),
      )
    },
  })
  /* One reading of the clock per render, named: expiry is what decides whether
     an invitation is still a row, so every invitation on screen should have
     been judged against the same instant rather than against whenever its own
     comparison happened to run. */
  const now = Date.now()
  /* `enabled` decides whether to ask, never what may be shown: a disabled query
     still serves whatever is already cached, so a reader demoted mid-session
     would keep rendering invitations their new role may no longer read. The
     role decides the rows, and the query only decides the request. */
  const rows = projectWorkspaceRoster({
    members: members.data?.items ?? [],
    invites: canAdminister ? (invites.data?.items ?? []) : [],
    now,
  })
  const invitedCount = rows.filter(row => row.kind === 'invited').length
  /* An error outranks a success on the shared status line: a failure the
     reader cannot see is the one that costs them. */
  const attempts: Array<{ isError: boolean; isSuccess: boolean }> = [
    inviteMutation,
    roleMutation,
    removeMutation,
    revokeMutation,
  ]
  const status =
    attempts.find(attempt => attempt.isError) ?? attempts.find(attempt => attempt.isSuccess)
  return (
    <SettingsPage group="workspace" surface="members">
      {members.isPending ? (
        <SettingsState title={t('loading')} body={t('workspace.members.loading')} busy />
      ) : members.isLoadingError || members.data === undefined ? (
        <SettingsState title={t('ownerRequired')} body={t('workspace.members.denied')} />
      ) : (
        <SettingsCard
          title={
            invitedCount === 0
              ? t('workspace.members.count', { count: members.data.items.length })
              : `${t('workspace.members.count', { count: members.data.items.length })} · ${t('workspace.members.invitedCount', { count: invitedCount })}`
          }
          description={t('workspace.members.help')}
        >
          {members.isRefetchError ? (
            <SettingsRefreshFailure
              message={t('workspace.members.refreshError')}
              onRetry={() => void members.refetch()}
            />
          ) : null}
          <div className="divide-y">
            {canAdminister ? (
              <InviteField
                email={inviteEmail}
                role={inviteRole}
                pending={inviteMutation.isPending}
                onEmail={setInviteEmail}
                onRole={setInviteRole}
                onSubmit={() => inviteMutation.mutate()}
              />
            ) : null}
            {rows.map(row =>
              row.kind === 'member' ? (
                <MemberRow
                  key={row.id}
                  member={row.member}
                  editable={canAdminister}
                  onRole={role => roleMutation.mutate({ userId: row.id, role })}
                  onRemove={() => removeMutation.mutate(row.id)}
                />
              ) : (
                <InvitedRow
                  key={row.id}
                  invite={row.invite}
                  onRevoke={() => revokeMutation.mutate(row.id)}
                />
              ),
            )}
          </div>
          {canAdminister && isInitialCollectionError(invites) ? (
            <div className="mt-4 space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {t('workspace.members.invitesError')}
              </p>
              <button
                type="button"
                onClick={() => void invites.refetch()}
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('retry')}
              </button>
            </div>
          ) : null}
          {canAdminister && invites.isRefetchError && !invites.isFetchNextPageError ? (
            <SettingsRefreshFailure
              message={t('workspace.members.invitesRefreshError')}
              onRetry={() => void invites.refetch()}
            />
          ) : null}
          {canAdminister && invites.isPending ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('loading')}</p>
          ) : null}
          {canAdminister && (invites.hasNextPage || invites.isFetchNextPageError) ? (
            <CollectionLoadMore
              loading={invites.isFetchingNextPage}
              failed={invites.isFetchNextPageError}
              labels={{
                load: t('loadMore'),
                loading: t('loadingMore'),
                retry: t('retryLoadMore'),
              }}
              onLoad={() => void invites.fetchNextPage()}
            />
          ) : null}
          {status === undefined ? null : <SettingsMutationStatus mutation={status} />}
        </SettingsCard>
      )}
    </SettingsPage>
  )
}

function InviteField({
  email,
  role,
  pending,
  onEmail,
  onRole,
  onSubmit,
}: {
  email: string
  role: WorkspaceInviteRole
  pending: boolean
  onEmail(email: string): void
  onRole(role: WorkspaceInviteRole): void
  onSubmit(): void
}) {
  const t = useTranslations('duetSettings')
  return (
    <div className="space-y-2 py-4 first:pt-0 last:pb-0">
      <form
        className="grid gap-3 sm:grid-cols-[1fr_9rem_auto]"
        onSubmit={event => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <input
          type="email"
          aria-label={t('email')}
          placeholder="teammate@example.com"
          value={email}
          onChange={event => onEmail(event.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        />
        <select
          aria-label={t('role')}
          value={role}
          onChange={event => onRole(event.target.value as WorkspaceInviteRole)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="editor">{t('roles.editor')}</option>
          <option value="viewer">{t('roles.viewer')}</option>
        </select>
        <button disabled={pending || !email} className={buttonVariants()}>
          {pending ? t('sending') : t('invite')}
        </button>
      </form>
      <p className="text-xs text-muted-foreground">{t('workspace.members.inviteHelp')}</p>
    </div>
  )
}

/**
 * The same row as a member's, dimmed. Sharing the geometry is the point — the
 * reader is looking at one list of people — so only the muting and the marker
 * separate somebody who is here from somebody who has been asked.
 */
function InvitedRow({ invite, onRevoke }: { invite: WorkspaceInvite; onRevoke(): void }) {
  const t = useTranslations('duetSettings')
  return (
    <div className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar name={invite.email} className="size-10 opacity-50 grayscale" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-muted-foreground">{invite.email}</p>
            <span className="rounded-full border border-dashed px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {t('workspace.members.invited')}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{t(`roles.${invite.role}`)}</p>
        </div>
      </div>
      {/* The visible word is "Revoke" on every row, so the accessible name has
          to carry the address — otherwise a screen reader hears the same
          button repeated once per invitation with no way to tell them apart. */}
      <button
        onClick={onRevoke}
        aria-label={t('workspace.members.revokeInvite', { email: invite.email })}
        className={cn(
          buttonVariants({ variant: 'outline' }),
          'ml-13 self-start text-muted-foreground hover:text-destructive sm:ml-0 sm:self-auto',
        )}
      >
        {t('revoke')}
      </button>
    </div>
  )
}

function MemberRow({
  member,
  editable,
  onRole,
  onRemove,
}: {
  member: WorkspaceMember
  editable: boolean
  onRole(role: WorkspaceRole): void
  onRemove(): void
}) {
  const t = useTranslations('duetSettings')
  return (
    <div className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar name={member.name ?? member.email} className="size-10" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold">{member.name ?? member.email}</p>
            {member.isBillingUser ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                {t('payer')}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{member.email}</p>
        </div>
      </div>
      {editable ? (
        <div className="flex items-center gap-2 pl-13 sm:pl-0">
          <select
            aria-label={t('roleFor', { email: member.email })}
            value={member.role}
            onChange={event => onRole(event.target.value as WorkspaceRole)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="owner">{t('roles.owner')}</option>
            <option value="editor">{t('roles.editor')}</option>
            <option value="viewer">{t('roles.viewer')}</option>
          </select>
          <button
            onClick={onRemove}
            aria-label={t('removeMember', { email: member.email })}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'icon' }),
              'text-muted-foreground hover:text-destructive',
            )}
          >
            <Trash size={17} />
          </button>
        </div>
      ) : (
        <RoleBadge role={member.role} />
      )}
    </div>
  )
}

function SharesSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const queryClient = useQueryClient()
  const key = duetQueryKeys.workspaces.shares(workspace.slug)
  const shares = useInfiniteQuery({
    ...duetQueryOptions.workspaces.shares(api, workspace.slug),
    refetchInterval: 5_000,
  })
  const unlink = useMutation({
    mutationFn: (shareId: string) => api.unlinkShare(workspace.slug, shareId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })
  const revoke = useMutation({
    mutationFn: (shareId: string) => api.revokeShare(workspace.slug, shareId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })
  const pause = useMutation({
    mutationFn: ({ shareId, paused }: { shareId: string; paused: boolean }) =>
      api.setSharePaused(workspace.slug, shareId, paused),
    onSettled: () => invalidateAfterPauseMutation(queryClient, workspace.slug, 'share'),
  })
  const mutationError = unlink.isError || revoke.isError || pause.isError

  return (
    <SettingsPage group="workspace" surface="shares">
      {shares.isPending ? (
        <SettingsState title={t('loading')} body={t('workspace.shares.loading')} busy />
      ) : shares.data === undefined || isInitialCollectionError(shares) ? (
        <SettingsState
          title={t('loadError')}
          body={t('workspace.shares.loadError')}
          action={
            <button
              type="button"
              onClick={() => void shares.refetch()}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('workspace.shares.actions.retry')}
            </button>
          }
        />
      ) : (
        <>
          <SharesManagement
            incoming={shares.data.items.filter(item => item.direction === 'incoming')}
            outgoing={shares.data.items.filter(item => item.direction === 'outgoing')}
            busy={unlink.isPending || revoke.isPending || pause.isPending}
            onUnlink={shareId => unlink.mutateAsync(shareId).then(() => undefined)}
            onRevoke={shareId => revoke.mutateAsync(shareId).then(() => undefined)}
            onSetPaused={(shareId, paused) =>
              pause.mutateAsync({ shareId, paused }).then(() => undefined)
            }
          />
          {shares.hasNextPage || shares.isFetchNextPageError ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={shares.isFetchingNextPage}
                onClick={() => void shares.fetchNextPage()}
                className={buttonVariants({ variant: 'outline' })}
              >
                {shares.isFetchingNextPage
                  ? t('loadingMore')
                  : shares.isFetchNextPageError
                    ? t('retryLoadMore')
                    : t('loadMore')}
              </button>
            </div>
          ) : null}
          {mutationError ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {t('workspace.shares.mutationError')}
            </p>
          ) : null}
        </>
      )}
    </SettingsPage>
  )
}

function WorkspaceResourceSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const queryClient = useQueryClient()
  const publishesOptions = duetQueryOptions.workspaces.publishes(api, workspace.slug)
  const key = publishesOptions.queryKey
  const publishes = useInfiniteQuery(publishesOptions)
  const pause = useMutation({
    mutationFn: ({ slug, paused }: { slug: string; paused: boolean }) =>
      api.setPublishPaused(workspace.slug, slug, paused),
    onMutate: async variables => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData(key)
      queryClient.setQueryData(key, current =>
        mapCollectionItems(current, items =>
          items.map(publish =>
            publish.slug === variables.slug
              ? {
                  ...publish,
                  ...(variables.paused
                    ? { pausedAt: Date.now() }
                    : { pausedAt: undefined, pauseGeneration: undefined }),
                }
              : publish,
          ),
        ),
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous)
    },
    onSuccess: response =>
      queryClient.setQueryData(key, current =>
        mapCollectionItems(current, items =>
          items.map(publish => (publish.id === response.publish.id ? response.publish : publish)),
        ),
      ),
    onSettled: () => invalidateAfterPauseMutation(queryClient, workspace.slug, 'publish'),
  })
  return (
    <SettingsPage group="workspace" surface="publishes">
      {publishes.isPending ? (
        <SettingsState title={t('loading')} body={t('workspace.publishes.loading')} busy />
      ) : publishes.data === undefined || isInitialCollectionError(publishes) ? (
        <SettingsState
          title={t('loadError')}
          body={t('workspace.publishes.loadError')}
          action={
            <button
              type="button"
              onClick={() => void publishes.refetch()}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('workspace.publishes.retry')}
            </button>
          }
        />
      ) : (
        <>
          <PublishesManagement
            publishes={publishes.data.items}
            transition={pause.isPending ? pause.variables : undefined}
            errorSlug={pause.isError ? pause.variables.slug : undefined}
            onSetPaused={(slug, paused) =>
              pause.mutateAsync({ slug, paused }).then(() => undefined)
            }
          />
          {publishes.hasNextPage || publishes.isFetchNextPageError ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={publishes.isFetchingNextPage}
                onClick={() => void publishes.fetchNextPage()}
                className={buttonVariants({ variant: 'outline' })}
              >
                {publishes.isFetchingNextPage
                  ? t('loadingMore')
                  : publishes.isFetchNextPageError
                    ? t('retryLoadMore')
                    : t('loadMore')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </SettingsPage>
  )
}

function UsageSettings() {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const dailyUsage = useQuery(
    duetQueryOptions.workspaces.usage(api, workspace.slug, 'daily', false),
  )
  const weeklyUsage = useQuery(
    duetQueryOptions.workspaces.usage(api, workspace.slug, 'weekly', false),
  )
  const monthlyUsage = useQuery(
    duetQueryOptions.workspaces.usage(api, workspace.slug, 'monthly', false),
  )
  const telemetry = useQuery(duetQueryOptions.workspaces.telemetry(api, workspace.slug))
  const ledger = useInfiniteQuery(duetQueryOptions.workspaces.ledger(api, workspace.slug))
  const members = useQuery(duetQueryOptions.workspaces.members(api, workspace.slug))
  const actorLabel = (actorUserId?: string) => {
    if (actorUserId === undefined) return t('workspace.usage.ledgerSystem')
    const member = members.data?.items.find(candidate => candidate.id === actorUserId)
    // Unresolved ids stay neutral: the member list may still be loading, and
    // internal-admin adjustments are attributed to users outside the workspace.
    return member?.name ?? member?.email ?? t('workspace.usage.ledgerUnknownActor')
  }
  return (
    <SettingsPage group="workspace" surface="usage">
      <div className="space-y-4 pb-20 md:pb-0">
        <TelemetryHistoryChart
          state={
            telemetry.isPending
              ? { status: 'loading' }
              : telemetry.isError
                ? { status: 'error' }
                : { status: 'ready', samples: telemetry.data.samples }
          }
        />
        <UsageSpendChart
          reports={{
            daily: dailyUsage.data,
            weekly: weeklyUsage.data,
            monthly: monthlyUsage.data,
          }}
        />
        {ledger.isPending ? (
          <SettingsCard
            title={t('workspace.usage.ledgerTitle')}
            description={t('workspace.usage.ledgerHelp')}
          >
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          </SettingsCard>
        ) : ledger.data === undefined || isInitialCollectionError(ledger) ? (
          <SettingsState
            title={t('loadError')}
            body={t('workspace.usage.error')}
            action={
              <button
                type="button"
                onClick={() => void ledger.refetch()}
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('retry')}
              </button>
            }
          />
        ) : (
          <SettingsCard
            title={t('workspace.usage.ledgerTitle')}
            description={t('workspace.usage.ledgerHelp')}
          >
            {ledger.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('workspace.usage.ledgerEmpty')}</p>
            ) : (
              <ol className="divide-y">
                {ledger.data.items.map(entry => (
                  <li
                    key={entry.id}
                    className="flex items-baseline gap-3 py-3 first:pt-0 last:pb-0"
                    data-ledger-type={entry.type}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium first-letter:uppercase">{entry.type}</p>
                        {entry.type === 'usage' && entry.tier !== undefined ? (
                          <UsageTierBadge tier={entry.tier} />
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {actorLabel(entry.actorUserId)} ·{' '}
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(entry.createdAt)}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums">
                      {formatMicroUsd(entry.amountMicroUsd)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {ledger.hasNextPage || ledger.isFetchNextPageError ? (
              <CollectionLoadMore
                loading={ledger.isFetchingNextPage}
                failed={ledger.isFetchNextPageError}
                labels={{
                  load: t('loadMore'),
                  loading: t('loadingMore'),
                  retry: t('retryLoadMore'),
                }}
                onLoad={() => void ledger.fetchNextPage()}
              />
            ) : null}
          </SettingsCard>
        )}
      </div>
    </SettingsPage>
  )
}

function AuditSettings() {
  const t = useTranslations('duetSettings')
  const locale = useLocale()
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const audit = useInfiniteQuery(duetQueryOptions.workspaces.audit(api, workspace.slug))
  const eventLabels: Record<string, string> = {
    'workspace.billing_user_changed': t('workspace.audit.events.billingUserChanged'),
    'workspace.member_role_changed': t('workspace.audit.events.memberRoleChanged'),
    'workspace.member_changed': t('workspace.audit.events.memberChanged'),
    'workspace.member_removed': t('workspace.audit.events.memberRemoved'),
    'api_key.issued': t('workspace.audit.events.apiKeyIssued'),
    'api_key.revoked': t('workspace.audit.events.apiKeyRevoked'),
    'billing.settings_updated': t('workspace.audit.events.billingSettingsUpdated'),
    'billing.customer_created': t('workspace.audit.events.billingCustomerCreated'),
    'user.profile_updated': t('workspace.audit.events.profileUpdated'),
  }
  return (
    <SettingsPage group="workspace" surface="audit">
      {audit.isPending ? (
        <SettingsState title={t('loading')} body={t('workspace.audit.loading')} busy />
      ) : audit.data === undefined || isInitialCollectionError(audit) ? (
        <SettingsState
          title={t('loadError')}
          body={t('workspace.audit.error')}
          action={
            <button
              type="button"
              onClick={() => void audit.refetch()}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('retry')}
            </button>
          }
        />
      ) : (
        <SettingsCard title={t('workspace.audit.recent')} description={t('workspace.audit.help')}>
          {audit.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('workspace.audit.empty')}</p>
          ) : (
            <ol className="divide-y">
              {audit.data.items.map(event => (
                <li key={event.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium first-letter:uppercase">
                      {eventLabels[event.event] ?? event.event.replaceAll(/[._]/g, ' ')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(event.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {audit.hasNextPage || audit.isFetchNextPageError ? (
            <CollectionLoadMore
              loading={audit.isFetchingNextPage}
              failed={audit.isFetchNextPageError}
              failureMessage={t('workspace.audit.loadMoreError')}
              labels={{
                load: t('nextPage'),
                loading: t('loadingMore'),
                retry: t('workspace.audit.retry'),
              }}
              onLoad={() => void audit.fetchNextPage()}
            />
          ) : null}
        </SettingsCard>
      )}
    </SettingsPage>
  )
}

function BillingUserSettings() {
  const t = useTranslations('duetSettings')
  const { api } = useSpa()
  const workspace = useActiveWorkspace()
  const queryClient = useQueryClient()
  const key = duetQueryKeys.workspaces.members(workspace.slug)
  const members = useQuery(duetQueryOptions.workspaces.members(api, workspace.slug))
  const mutation = useMutation({
    mutationFn: (userId: string) => api.setWorkspaceBillingUser(workspace.slug, userId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: duetQueryKeys.user.billing.overview }),
      ])
    },
  })
  const owners = useMemo(
    () => members.data?.items.filter(member => member.role === 'owner') ?? [],
    [members.data],
  )
  return (
    <SettingsPage group="workspace" surface="billingUser">
      {members.isPending ? (
        <SettingsState title={t('loading')} body={t('workspace.billingUser.loading')} busy />
      ) : members.isLoadingError || members.data === undefined ? (
        <SettingsState title={t('ownerRequired')} body={t('workspace.billingUser.denied')} />
      ) : (
        <SettingsCard
          title={t('workspace.billingUser.card')}
          description={t('workspace.billingUser.help')}
        >
          {members.isRefetchError ? (
            <SettingsRefreshFailure
              message={t('workspace.billingUser.refreshError')}
              onRetry={() => void members.refetch()}
            />
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {owners.map(owner => (
              <button
                key={owner.id}
                disabled={workspace.role !== 'owner' || owner.isBillingUser || mutation.isPending}
                onClick={() => mutation.mutate(owner.id)}
                className={`flex min-h-20 items-center gap-3 rounded-lg border p-4 text-left ${owner.isBillingUser ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'} disabled:cursor-default`}
              >
                <UserAvatar name={owner.name ?? owner.email} className="size-10" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {owner.name ?? owner.email}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {owner.email}
                  </span>
                </span>
                {owner.isBillingUser ? (
                  <CheckCircle className="text-primary" weight="fill" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="mt-5 flex items-start gap-3 rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 shrink-0 text-primary" size={20} />
            <p>{t('workspace.billingUser.invariant')}</p>
          </div>
          <SettingsMutationStatus mutation={mutation} />
        </SettingsCard>
      )}
    </SettingsPage>
  )
}

function SettingsRefreshFailure({ message, onRetry }: { message: string; onRetry(): void }) {
  const t = useTranslations('duetSettings')
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {t('retry')}
      </button>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-2">
      <span className="flex items-center justify-between text-sm font-medium">
        {label}
        {hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

function RoleBadge({ role }: { role: WorkspaceRole }) {
  const t = useTranslations('duetSettings')
  return (
    <span className="inline-flex min-h-8 items-center rounded-full border bg-muted/40 px-3 text-xs font-semibold capitalize">
      {t(`roles.${role}`)}
    </span>
  )
}
