'use client'

/* Hallmark · macrostructure: Workbench · tone: composed operational · theme: Cobalt
 * pre-emit critique: P5 H5 E4 S5 R5 V4 · enrichment: none
 */

import {
  CaretDown,
  ChatCircle,
  CircleNotch,
  GearSix,
  House,
  PencilSimple,
  Plus,
  SquaresFour,
} from '@phosphor-icons/react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutationState,
  useQuery,
} from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router'

import {
  DEFAULT_AGENT_NAME,
  initialSessionTitle,
  projectSessionListItem,
  ROOT_AGENT_SCOPE,
  type Agent,
  type AgentStartSessionRequestInput,
  type SessionCreateResponse,
  type SessionListItem,
  type WorkspaceSummary,
} from '@repo/contract'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@repo/ui/components/shadcn/sheet'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../agents/agent-avatar'
import { duetMutationKeys, duetQueryKeys } from '../api/query-keys'
import { collectionItems, duetQueryOptions, isInitialCollectionError } from '../api/query-options'
import { useSpa } from '../context'
import { agentsMapUrl } from '../drive/agents-map-url'
import { driveRoutes } from '../drive/drive-routes'
import { UserAvatar } from '../identity/identity-avatar'
import { useCanUseSessions } from '../routes/sessions'
import { sessionQueryOptions } from '../sessions/session-data'
import { settingsNavigationState } from '../settings/settings-navigation'
import {
  candidateWorkConversationOwners,
  unreadWorkOwnerIds,
  verifyWorkConversationOwners,
  workConversationPresenceFingerprint,
} from './work-agent-presence'
import {
  projectWorkConversationRows,
  workCollectionDraining,
  workCollectionPhase,
} from './work-collection'
import { WorkConversationRow } from './work-conversation-row'
import {
  workConversationFilters,
  workConversationFiltersForAgent,
  workHomeUrl,
  workRouteDestination,
} from './work-destination'
import {
  chatCreationPlacement,
  followRouteAgent,
  projectWorkApps,
  toggleExpandedAgent,
  type WorkApp,
} from './work-projection'

type WorkSpaceValue = {
  workspace: WorkspaceSummary
  agents: readonly Agent[]
  apps: readonly WorkApp[]
  loading: boolean
  failed: boolean
  canUseSessions: boolean
  ownershipReady: boolean
  retry: () => void
}

type TransientWorkConversation = {
  mutationId: number
  ownerSlug: string
  title: string
  submittedAt: number
  pending: boolean
  session?: SessionListItem
}

const WorkSpaceContext = createContext<WorkSpaceValue | null>(null)

export function useWorkSpace(): WorkSpaceValue {
  const value = useContext(WorkSpaceContext)
  if (value === null) throw new Error('Work surfaces must be mounted inside WorkFrame')
  return value
}

/** The account surface shared by Work's sidebar and Build's bottom-left rail. */
export function WorkspaceAccountFooter({
  userName,
  role,
  accountControl,
}: {
  userName: string
  role: string
  accountControl: ReactNode
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-t border-border/70 px-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
        <UserAvatar name={userName} className="size-7" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-4">{userName}</span>
          <span className="block text-[11px] capitalize leading-4 text-muted-foreground">
            {role}
          </span>
        </span>
      </div>
      {accountControl}
    </div>
  )
}

export function WorkFrame({
  workspace,
  desktopWorkspaceControl,
  desktopAccountControl,
  mobileWorkspaceControl,
  mobileAccountControl,
  children,
}: {
  workspace: WorkspaceSummary
  desktopWorkspaceControl: ReactNode
  desktopAccountControl: ReactNode
  mobileWorkspaceControl: ReactNode
  mobileAccountControl: ReactNode
  children: ReactNode
}) {
  const { api, identity } = useSpa()
  const navigate = useNavigate()
  const location = useLocation()
  const t = useTranslations('duetApp.teamSpace')
  const [chatsOpen, setChatsOpen] = useState(false)
  /* Which agent groups are open — a set, so several can be, which is what a
     column for comparing owners' work needs. `undefined` until the first seed,
     which is how the effect below tells "nothing open" from "not asked yet". */
  const [expandedAgentSlugs, setExpandedAgentSlugs] = useState<ReadonlySet<string> | undefined>()
  const [reconciledCreationIds, setReconciledCreationIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  )
  const canUseSessions = useCanUseSessions(workspace.slug)
  const agentsQuery = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspace.slug))
  const appsQuery = useInfiniteQuery(duetQueryOptions.workspaces.apps(api, workspace.slug))
  const activityQuery = useQuery({
    ...duetQueryOptions.workspaces.sessionActivity(api, workspace.slug),
    enabled: canUseSessions,
  })
  const chatsQuery = useInfiniteQuery({
    ...sessionQueryOptions.list(api, workspace.slug, workConversationFilters, 12),
    enabled: canUseSessions,
  })
  const workConversationMutations = useMutationState({
    filters: {
      mutationKey: duetMutationKeys.workspaces.sessions.creations(workspace.slug, 'work'),
    },
    select: mutation => {
      const variables = mutation.state.variables as
        | Partial<Pick<AgentStartSessionRequestInput, 'prompt' | 'attachments' | 'images'>>
        | undefined
      const response = mutation.state.data as SessionCreateResponse | undefined
      const session =
        mutation.state.status === 'success' && response !== undefined
          ? projectSessionListItem(response.snapshot)
          : undefined
      return {
        mutationId: mutation.mutationId,
        ownerSlug: (mutation.options.mutationKey?.at(-1) as string | undefined) ?? ROOT_AGENT_SCOPE,
        // Named the way the server will name it, so the row does not change its
        // mind when the response lands — and a files-only start is not blank.
        title:
          session?.title ??
          (typeof variables?.prompt === 'string'
            ? initialSessionTitle({ ...variables, prompt: variables.prompt }) || t('conversation')
            : undefined),
        submittedAt: mutation.state.submittedAt,
        pending: mutation.state.status === 'pending',
        visible: mutation.state.status === 'pending' || mutation.state.status === 'success',
        session,
      }
    },
  })
  const agents = collectionItems(agentsQuery.data)
  const rawApps = collectionItems(appsQuery.data)
  const chatProjection = useMemo(
    () => projectWorkConversationRows(chatsQuery.data?.pages ?? [], 12),
    [chatsQuery.data],
  )
  const chats = chatProjection.items
  const reconcileCreations = useCallback((mutationIds: readonly number[]) => {
    if (mutationIds.length === 0) return
    setReconciledCreationIds(current => {
      if (mutationIds.every(mutationId => current.has(mutationId))) return current
      return new Set([...current, ...mutationIds])
    })
  }, [])
  useEffect(() => {
    const canonicalConversationIds = new Set(chats.map(chat => chat.id))
    const reconciled = workConversationMutations.flatMap(conversation =>
      conversation.ownerSlug === ROOT_AGENT_SCOPE &&
      conversation.session !== undefined &&
      canonicalConversationIds.has(conversation.session.id)
        ? [conversation.mutationId]
        : [],
    )
    reconcileCreations(reconciled)
  }, [chats, reconcileCreations, workConversationMutations])
  const transientConversations = useMemo<TransientWorkConversation[]>(
    () =>
      workConversationMutations
        .flatMap(conversation =>
          conversation.visible &&
          conversation.title !== undefined &&
          !reconciledCreationIds.has(conversation.mutationId)
            ? [{ ...conversation, title: conversation.title }]
            : [],
        )
        .sort((left, right) => right.submittedAt - left.submittedAt),
    [reconciledCreationIds, workConversationMutations],
  )
  const chatPhase = workCollectionPhase({
    pending: chatsQuery.isPending,
    initialError: isInitialCollectionError(chatsQuery),
    continuationError: chatsQuery.isFetchNextPageError,
    itemCount: chats.length,
    draining: chatProjection.fetchNext,
  })
  /* The same drain the delegated-work panel runs, for the same reason: this
     endpoint drops rows inside the page it is measuring, so an empty first page
     behind a live cursor means "keep reading", not "this workspace is having no
     conversations". */
  useEffect(() => {
    if (!chatProjection.fetchNext || chatsQuery.isFetching || chatsQuery.isFetchNextPageError)
      return
    void chatsQuery.fetchNextPage()
  }, [chatProjection.fetchNext, chatsQuery])
  const chatCreation = chatCreationPlacement(canUseSessions, chatPhase, chats.length)
  const apps = useMemo(
    () =>
      agentsQuery.data !== undefined
        ? projectWorkApps(agents, rawApps, workspace.duetName ?? DEFAULT_AGENT_NAME)
        : [],
    [agents, agentsQuery.data, rawApps, workspace.duetName],
  )
  const candidateConversationOwners = useMemo(
    () => candidateWorkConversationOwners(activityQuery.data?.owners ?? []),
    [activityQuery.data],
  )
  /* Which owners have something unread, read straight off the activity poll —
     it already answers for every owner in one request whether or not the group
     is open, so a collapsed group costs nothing to mark. */
  const unreadOwnerIds = useMemo(
    () => unreadWorkOwnerIds(activityQuery.data?.owners ?? []),
    [activityQuery.data],
  )
  const conversationPresenceFingerprint = useMemo(
    () => workConversationPresenceFingerprint(candidateConversationOwners),
    [candidateConversationOwners],
  )
  const conversationPresenceQuery = useQuery({
    queryKey: duetQueryKeys.workspaces.sessions.workConversationPresence(
      workspace.slug,
      conversationPresenceFingerprint,
    ),
    queryFn: ({ signal }) =>
      verifyWorkConversationOwners({
        owners: candidateConversationOwners,
        request: query => api.listSessions(workspace.slug, query, signal),
        signal,
      }),
    enabled:
      canUseSessions && activityQuery.data !== undefined && candidateConversationOwners.length > 0,
    placeholderData: keepPreviousData,
    /* Activity changes re-key this query immediately. This slower pass heals
       changes outside activity's bounded window without turning the 10-second
       workspace poll into N requests every time it ticks; a partial outage
       retries sooner without hiding the owners that did verify. */
    refetchInterval: query =>
      query.state.data?.failedOwnerIds.length
        ? 60_000
        : candidateConversationOwners.length > 0
          ? 5 * 60_000
          : false,
  })
  const agentsWithConversations = useMemo(() => {
    const candidateOwnerIds = new Set(candidateConversationOwners.map(owner => owner.agentId))
    const verifiedOwnerIds = new Set(conversationPresenceQuery.data?.visibleOwnerIds ?? [])
    const transientOwnerSlugs = new Set(
      transientConversations
        .filter(conversation => conversation.ownerSlug !== ROOT_AGENT_SCOPE)
        .map(conversation => conversation.ownerSlug),
    )
    return agents.filter(
      agent =>
        (candidateOwnerIds.has(agent.id) && verifiedOwnerIds.has(agent.id)) ||
        transientOwnerSlugs.has(agent.slug),
    )
  }, [agents, candidateConversationOwners, conversationPresenceQuery.data, transientConversations])
  const activeDestination = workRouteDestination(location.pathname, workspace.slug, location.search)
  const activeSessionId =
    activeDestination.kind === 'session' ? activeDestination.sessionId : undefined
  const activeAgentSlug =
    activeDestination.kind === 'session' && activeDestination.agentSlug !== ROOT_AGENT_SCOPE
      ? activeDestination.agentSlug
      : undefined
  const onHome = activeDestination.kind === 'home'
  const retryAgents = agentsQuery.refetch
  const retryApps = appsQuery.refetch
  const retry = useCallback(() => {
    void retryAgents()
    void retryApps()
  }, [retryAgents, retryApps])
  const agentsInitialError = agentsQuery.isLoadingError
  const appsInitialError = appsQuery.isLoadingError
  const startConversation = useCallback(
    (agentSlug: string = ROOT_AGENT_SCOPE) => {
      setChatsOpen(false)
      navigate(workHomeUrl(workspace.slug, agentSlug))
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            '[data-work-session-starter] textarea, [data-work-session-starter] [contenteditable="true"]',
          )
          ?.focus()
      })
    },
    [navigate, workspace.slug],
  )
  const startNewChat = useCallback(() => startConversation(), [startConversation])
  /* ---- which group is open is the reader's, and the app only ever nudges it ----
     Three things want to open a group, and every one of them is a *change*
     rather than a standing fact: a create just started under an agent, the
     reader navigated to a conversation that agent owns, or nothing is open yet
     and the column should not lead with a closed list.

     They used to be written as invariants — "while the URL names an agent, that
     agent's group is open" — and an invariant cannot be overridden. The effect
     re-runs whenever the roster or the activity poll hands back a new array, so
     opening a *different* group while reading a conversation set the state and
     had it snapped back a frame later: the group opened and shut on its own.
     Collapsing the current one did the same thing in reverse.

     So the URL is followed once per URL. `followedAgent` remembers which agent
     was last acted on; a group the reader opens or closes afterwards stays that
     way until the address actually changes again. */
  const followedAgent = useRef<string | undefined>(undefined)
  const seededAgentGroup = useRef(false)
  useEffect(() => {
    const pendingAgentSlug = transientConversations.find(
      conversation => conversation.pending && conversation.ownerSlug !== ROOT_AGENT_SCOPE,
    )?.ownerSlug
    if (pendingAgentSlug !== undefined) {
      if (followedAgent.current !== pendingAgentSlug) {
        followedAgent.current = pendingAgentSlug
        setExpandedAgentSlugs(current => followRouteAgent(current ?? new Set(), pendingAgentSlug))
      }
      return
    }
    if (activeAgentSlug !== undefined) {
      if (followedAgent.current !== activeAgentSlug) {
        followedAgent.current = activeAgentSlug
        setExpandedAgentSlugs(current => followRouteAgent(current ?? new Set(), activeAgentSlug))
      }
      return
    }
    /* Off an agent-owned destination, so the next one is a change again. */
    followedAgent.current = undefined
    if (
      !seededAgentGroup.current &&
      expandedAgentSlugs === undefined &&
      agentsQuery.data !== undefined &&
      activityQuery.data !== undefined
    ) {
      seededAgentGroup.current = true
      const first = agentsWithConversations[0]?.slug
      setExpandedAgentSlugs(first === undefined ? new Set() : new Set([first]))
    }
  }, [
    activeAgentSlug,
    activityQuery.data,
    agentsQuery.data,
    agentsWithConversations,
    expandedAgentSlugs,
    transientConversations,
  ])
  const value = useMemo<WorkSpaceValue>(
    () => ({
      workspace,
      agents,
      apps,
      loading: agentsQuery.isPending || appsQuery.isPending,
      failed: agentsInitialError || appsInitialError,
      canUseSessions,
      ownershipReady: agentsQuery.data !== undefined,
      retry,
    }),
    [
      agents,
      agentsQuery.data,
      agentsQuery.isPending,
      apps,
      appsInitialError,
      appsQuery.isPending,
      canUseSessions,
      agentsInitialError,
      retry,
      workspace,
    ],
  )

  const conversationRow = (chat: SessionListItem, agentSlug: string) => (
    <WorkConversationRow
      key={chat.id}
      chat={chat}
      active={chat.id === activeSessionId}
      unreadLabel={t('unread')}
      onOpen={() => {
        setChatsOpen(false)
        navigate(
          `${agentsMapUrl(workspace.slug, {
            kind: 'sessions',
            agentSlug,
            sessionId: chat.id,
          })}?mode=work`,
        )
      }}
    />
  )

  const pendingConversationRow = (conversation: (typeof transientConversations)[number]) => (
    <div
      key={`pending:${conversation.mutationId}`}
      data-work-pending-conversation
      aria-current="page"
      title={conversation.title}
      className="flex min-h-11 w-full items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-left text-sm font-medium text-sidebar-accent-foreground lg:min-h-0"
    >
      {/* The row a sent chat becomes, already: the same empty lead, and in the
          place its running mark will take, the running hue turning. */}
      <span aria-hidden className="w-[17px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      <CircleNotch
        aria-label={t('sending')}
        size={12}
        weight="bold"
        className="shrink-0 animate-spin text-live motion-reduce:animate-none"
      />
    </div>
  )

  const rootTransientConversations = transientConversations.filter(
    conversation =>
      conversation.ownerSlug === ROOT_AGENT_SCOPE &&
      (conversation.session === undefined ||
        !chats.some(chat => chat.id === conversation.session?.id)),
  )

  const chatList = (
    <div className="space-y-0.5">
      {rootTransientConversations.map(conversation =>
        conversation.pending || conversation.session === undefined
          ? pendingConversationRow(conversation)
          : conversationRow(conversation.session, ROOT_AGENT_SCOPE),
      )}
      {!canUseSessions ? (
        <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">
          {t('conversationsDenied')}
        </p>
      ) : chatPhase === 'pending' ? (
        <div className="space-y-2 px-2 py-1" aria-label={t('loadingConversations')}>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-7 animate-pulse rounded-md bg-sidebar-accent/60" />
          ))}
        </div>
      ) : chatPhase === 'initial-error' ? (
        <div className="px-2 py-2 text-xs leading-5 text-muted-foreground">
          <p>{t('conversationsError')}</p>
          <button
            type="button"
            onClick={() => void chatsQuery.refetch()}
            className="mt-1 min-h-9 font-medium text-foreground underline underline-offset-4"
          >
            {t('retry')}
          </button>
        </div>
      ) : chatPhase === 'continuation-error' ? (
        <div className="px-2 py-2 text-xs leading-5 text-muted-foreground">
          <p>{t('conversationsError')}</p>
          <button
            type="button"
            onClick={() => void chatsQuery.fetchNextPage()}
            className="mt-1 min-h-9 font-medium text-foreground underline underline-offset-4"
          >
            {t('retryMore')}
          </button>
        </div>
      ) : chatCreation === 'empty-list' ? (
        <button
          type="button"
          onClick={startNewChat}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span
            aria-hidden
            className="grid size-5 shrink-0 place-items-center rounded-[28%] border border-dashed border-muted-foreground/60"
          >
            <Plus size={12} weight="bold" />
          </span>
          {t('newChat')}
        </button>
      ) : (
        <>
          {chats.map(chat => conversationRow(chat, ROOT_AGENT_SCOPE))}
          {chatProjection.truncated ? (
            chatsQuery.isFetchNextPageError ? (
              <button
                type="button"
                onClick={() => void chatsQuery.fetchNextPage()}
                className="px-2 py-1 text-[11px] font-medium text-foreground underline underline-offset-4"
              >
                {t('retryMore')}
              </button>
            ) : (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                {t('olderConversations')}
              </p>
            )
          ) : null}
        </>
      )}
    </div>
  )

  const otherChatsSection =
    agentsWithConversations.length === 0 ? null : (
      <section data-work-other-chats>
        <div className="mb-1 mt-5 px-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            {t('otherChats')}
          </span>
        </div>
        <div className="space-y-1">
          {agentsWithConversations.map(agent => (
            <AgentConversationGroup
              key={agent.id}
              agent={agent}
              workspaceSlug={workspace.slug}
              canUseSessions={canUseSessions}
              expanded={expandedAgentSlugs?.has(agent.slug) === true}
              hasUnreadWork={unreadOwnerIds.has(agent.id)}
              onToggle={() =>
                setExpandedAgentSlugs(current =>
                  toggleExpandedAgent(current ?? new Set(), agent.slug),
                )
              }
              onStartConversation={() => startConversation(agent.slug)}
              renderSession={session => conversationRow(session, agent.slug)}
              transientConversations={transientConversations.filter(
                conversation => conversation.ownerSlug === agent.slug,
              )}
              renderPending={pendingConversationRow}
              onTransientReconciled={reconcileCreations}
            />
          ))}
        </div>
      </section>
    )

  const ownerOnHome = onHome && workspace.role === 'owner'
  const openMembers = () =>
    navigate(`/w/${encodeURIComponent(workspace.slug)}/settings/members`, {
      state: settingsNavigationState(location.pathname, location.search),
    })

  return (
    <WorkSpaceContext.Provider value={value}>
      <div
        data-team-space="work"
        className="km-hues relative flex h-[var(--product-viewport-height,100dvh)] min-h-0 w-full overflow-hidden bg-background text-foreground"
      >
        {/* On a phone Invite lives in the top bar. Desktop Home renders it in
            the page's scroll flow so it moves with the content it belongs to. */}
        <aside className="hidden w-[17rem] shrink-0 flex-col border-r border-border/70 bg-sidebar lg:flex">
          <div className="flex h-12 shrink-0 items-center gap-1 px-2.5">
            <div className="min-w-0 flex-1">{desktopWorkspaceControl}</div>
          </div>

          <div className="px-2.5 py-2">
            <div className="grid grid-cols-2 rounded-md bg-muted/70 p-0.5">
              <button
                type="button"
                aria-pressed="true"
                className="flex items-center justify-center gap-1.5 rounded-[5px] bg-background px-2 py-1 text-xs font-semibold shadow-sm ring-1 ring-border [&_svg]:size-3.5"
              >
                <SquaresFour weight="fill" /> {t('work')}
              </button>
              <button
                type="button"
                onClick={() => navigate(driveRoutes.graph(workspace.slug))}
                className="flex items-center justify-center gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-3.5"
              >
                <PencilSimple /> {t('build')}
              </button>
            </div>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3" aria-label={t('work')}>
            <button
              type="button"
              onClick={() => navigate(workHomeUrl(workspace.slug))}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                onHome
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground',
              )}
            >
              <House size={17} weight={onHome ? 'fill' : 'regular'} /> {t('home')}
            </button>

            <div className="mb-1 mt-5 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                {t('chats')}
              </span>
              {chatCreation === 'heading' ? (
                <button
                  type="button"
                  onClick={startNewChat}
                  aria-label={t('newChat')}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <Plus size={15} />
                </button>
              ) : null}
            </div>
            {chatList}

            {otherChatsSection}
          </nav>

          <WorkspaceAccountFooter
            userName={identity.user.name ?? identity.user.email}
            role={t(`roles.${workspace.role}`)}
            accountControl={desktopAccountControl}
          />
        </aside>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {ownerOnHome ? (
            <div className="pointer-events-none fixed right-[3.75rem] top-0.5 z-20 lg:hidden">
              <InviteButton
                label={t('invite')}
                onSelect={openMembers}
                className="pointer-events-auto h-11 rounded-lg"
              />
            </div>
          ) : null}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 bg-background/90 px-3 backdrop-blur lg:hidden">
            <div className={cn('min-w-0 flex-1', ownerOnHome && 'pr-24')}>
              {mobileWorkspaceControl}
            </div>
            {mobileAccountControl}
          </header>
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
          {onHome ? (
            <nav
              aria-label={t('workNavigation')}
              className="grid h-16 shrink-0 grid-cols-3 border-t border-border/70 bg-sidebar pb-[env(safe-area-inset-bottom)] lg:hidden"
            >
              <MobileNavButton
                label={t('home')}
                icon={<House />}
                active
                onSelect={() => navigate(workHomeUrl(workspace.slug))}
              />
              <MobileNavButton
                label={t('chats')}
                icon={<ChatCircle />}
                onSelect={() => setChatsOpen(true)}
              />
              <MobileNavButton
                label={t('you')}
                icon={<GearSix />}
                onSelect={() =>
                  navigate('/settings/profile', {
                    state: settingsNavigationState(location.pathname, location.search),
                  })
                }
              />
            </nav>
          ) : null}
        </div>

        <Sheet open={chatsOpen} onOpenChange={setChatsOpen}>
          <SheetContent
            side="right"
            className="flex w-full max-w-none flex-col gap-0 p-0 sm:max-w-none lg:hidden [&>button]:right-1.5 [&>button]:top-1.5 [&>button]:size-11"
          >
            <SheetHeader className="flex h-14 shrink-0 justify-center border-b px-4 text-left">
              <SheetTitle className="text-sm">{t('chats')}</SheetTitle>
              <SheetDescription className="sr-only">{t('chatsDescription')}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {chatList}
              {otherChatsSection}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </WorkSpaceContext.Provider>
  )
}

function AgentConversationGroup({
  agent,
  workspaceSlug,
  canUseSessions,
  expanded,
  hasUnreadWork,
  onToggle,
  onStartConversation,
  renderSession,
  transientConversations,
  renderPending,
  onTransientReconciled,
}: {
  agent: Agent
  workspaceSlug: string
  canUseSessions: boolean
  expanded: boolean
  hasUnreadWork: boolean
  onToggle: () => void
  onStartConversation: () => void
  renderSession: (session: SessionListItem) => ReactNode
  transientConversations: readonly TransientWorkConversation[]
  renderPending: (conversation: TransientWorkConversation) => ReactNode
  onTransientReconciled: (mutationIds: readonly number[]) => void
}) {
  const { api } = useSpa()
  const t = useTranslations('duetApp.teamSpace')
  const filters = useMemo(() => workConversationFiltersForAgent(agent.id), [agent.id])
  const conversations = useInfiniteQuery({
    ...sessionQueryOptions.list(api, workspaceSlug, filters, 8),
    enabled: canUseSessions && expanded,
  })
  const sessions = useMemo(() => collectionItems(conversations.data), [conversations.data])
  const visibleTransientConversations = transientConversations.filter(
    conversation =>
      conversation.session === undefined ||
      !sessions.some(session => session.id === conversation.session?.id),
  )
  useEffect(() => {
    const sessionIds = new Set(sessions.map(session => session.id))
    onTransientReconciled(
      transientConversations.flatMap(conversation =>
        conversation.session !== undefined && sessionIds.has(conversation.session.id)
          ? [conversation.mutationId]
          : [],
      ),
    )
  }, [onTransientReconciled, sessions, transientConversations])
  /* The third list that reads past a page the server emptied — see
     `workCollectionDraining`. This one draws every row it has rather than a
     bounded slice, so it asks the rule directly instead of through a
     projection. */
  const draining = workCollectionDraining({
    itemCount: sessions.length,
    hasNextPage: conversations.hasNextPage,
    pagesRead: conversations.data?.pages.length ?? 0,
  })
  useEffect(() => {
    if (!draining || conversations.isFetching || conversations.isFetchNextPageError) return
    void conversations.fetchNextPage()
  }, [draining, conversations])
  const phase = workCollectionPhase({
    pending: conversations.isPending,
    initialError: isInitialCollectionError(conversations),
    continuationError: conversations.isFetchNextPageError,
    itemCount: sessions.length,
    draining,
  })
  const agentName = agent.name ?? agent.slug

  return (
    <section data-work-agent-conversations={agent.slug}>
      <div className="group flex items-center gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring lg:min-h-10',
            expanded && 'text-foreground',
          )}
        >
          {/* The dot rides the avatar only while the group is shut. Open, every
              row below carries its own, and a second mark on the owner would be
              saying the same thing twice. The ring is the sidebar's own ground,
              so the dot reads as a badge sitting on the avatar rather than a
              stray pip beside it. */}
          <span className="relative shrink-0">
            <AgentAvatar
              avatarKey={agent.slug}
              profile={agent}
              workspaceSlug={workspaceSlug}
              className="size-7"
            />
            {hasUnreadWork && !expanded ? (
              <span
                aria-hidden
                data-unread=""
                /* Seated off the corner rather than on it. An owner's avatar is
                   arbitrary artwork, so the badge cannot borrow contrast from
                   what it sits on. Most of it hangs over the sidebar's own
                   ground, and the ring is that ground continued underneath, so
                   what separates the dot from the avatar is the column behind
                   both rather than a hue that happens to differ. The unread
                   hue, like every unread mark (`ChatMarks`, the map's face):
                   the palette's blue means running, and an unread badge in it
                   would say the wrong thing. */
                className="absolute -right-1 -top-1 size-2.5 rounded-full bg-unread ring-[3px] ring-sidebar"
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{agentName}</span>
          {hasUnreadWork && !expanded ? <span className="sr-only">{t('unread')}</span> : null}
          <CaretDown
            aria-hidden
            size={14}
            className={cn(
              'shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              !expanded && '-rotate-90',
            )}
          />
        </button>
        <button
          type="button"
          aria-label={t('newAgentConversation', { name: agentName })}
          title={t('newAgentConversation', { name: agentName })}
          onClick={onStartConversation}
          className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-[background-color,color,opacity,transform] hover:bg-sidebar-accent hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transform-none lg:size-8 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
        >
          <Plus aria-hidden size={15} />
        </button>
      </div>

      {expanded ? (
        <div className="ml-4 border-l border-border/65 pb-1 pl-2">
          {visibleTransientConversations.map(conversation =>
            conversation.pending || conversation.session === undefined
              ? renderPending(conversation)
              : renderSession(conversation.session),
          )}
          {!canUseSessions ? (
            <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">
              {t('conversationsDenied')}
            </p>
          ) : phase === 'pending' ? (
            <div className="space-y-2 px-2 py-1" aria-label={t('loadingConversations')}>
              {Array.from({ length: 2 }, (_, index) => (
                <div key={index} className="h-7 animate-pulse rounded-md bg-sidebar-accent/60" />
              ))}
            </div>
          ) : phase === 'initial-error' ? (
            <div className="px-2 py-2 text-xs leading-5 text-muted-foreground">
              <p>{t('conversationsError')}</p>
              <button
                type="button"
                onClick={() => void conversations.refetch()}
                className="mt-1 min-h-9 font-medium text-foreground underline underline-offset-4"
              >
                {t('retry')}
              </button>
            </div>
          ) : phase === 'empty' &&
            !conversations.hasNextPage &&
            visibleTransientConversations.length === 0 ? (
            <p className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
              {t('agentConversationsEmpty')}
            </p>
          ) : phase === 'continuation-error' ? (
            <button
              type="button"
              onClick={() => void conversations.fetchNextPage()}
              className="min-h-9 px-2 text-[11px] font-medium text-foreground underline underline-offset-4"
            >
              {t('retryMore')}
            </button>
          ) : (
            <div className="space-y-0.5">
              {sessions.map(renderSession)}
              {conversations.isFetchNextPageError ? (
                <button
                  type="button"
                  onClick={() => void conversations.fetchNextPage()}
                  className="min-h-9 px-2 text-[11px] font-medium text-foreground underline underline-offset-4"
                >
                  {t('retryMore')}
                </button>
              ) : conversations.hasNextPage ? (
                <button
                  type="button"
                  disabled={conversations.isFetchingNextPage}
                  onClick={() => void conversations.fetchNextPage()}
                  className="min-h-9 px-2 text-[11px] font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground disabled:opacity-60"
                >
                  {conversations.isFetchingNextPage
                    ? t('loadingMoreConversations')
                    : t('loadMoreConversations')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

/** An owner's way to bring people in, from Home. The caller chooses the
 * placement: in Home's scroll flow on desktop, or in the top bar on a phone. */
export function InviteButton({
  label,
  onSelect,
  className,
}: {
  label: string
  onSelect: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onSelect}
      className={cn(
        'inline-flex min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border/80 bg-background px-2.5 text-xs font-medium text-muted-foreground shadow-sm transition-[border-color,color,transform] hover:border-border hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none',
        className,
      )}
    >
      <Plus aria-hidden size={13} />
      <span>{label}</span>
    </button>
  )
}

function MobileNavButton({
  label,
  icon,
  active = false,
  onSelect,
}: {
  label: string
  icon: ReactNode
  active?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex min-h-11 flex-col items-center justify-center gap-0.5 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-5',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
