'use client'

import { Check, Robot, UsersThree } from '@phosphor-icons/react'
import { motion, useReducedMotion } from 'framer-motion'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'

import {
  agentIsLaunchable,
  DEFAULT_AGENT_NAME,
  initialSessionTitle,
  ROOT_AGENT_SCOPE,
  type Agent,
} from '@repo/contract'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/shadcn/popover'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../agents/agent-avatar'
import { AppIcon, appDisplayName } from '../apps/app-icon'
import { useSpa } from '../context'
import { agentsMapUrl } from '../drive/agents-map-url'
import {
  DEFAULT_SESSION_TIER,
  SessionConversation,
  SessionsAccessDenied,
  useWorkSessionCreation,
  WorkSessionStarter,
} from '../routes/sessions'
import { settingsNavigationState } from '../settings/settings-navigation'
import { appDisplayStatus } from '../status/entity-status'
import { workHomeUrl } from './work-destination'
import { InviteButton, useWorkSpace } from './work-frame'
import { greetingForDate } from './work-projection'
import { WorkSessionHeading } from './work-session-heading'

const STARTERS = [
  ['weekLabel', 'weekDraft'],
  ['updateLabel', 'updateDraft'],
  ['changesLabel', 'changesDraft'],
  ['prioritiesLabel', 'prioritiesDraft'],
] as const

export function workHomeView(
  canUseSessions: boolean,
  pendingPrompt: string | undefined,
): 'access-denied' | 'conversation' | 'starter' {
  if (!canUseSessions) return 'access-denied'
  return pendingPrompt === undefined ? 'starter' : 'conversation'
}

export default function WorkHome() {
  const { workspaceSlug = '' } = useParams()
  const { identity, clock } = useSpa()
  const { workspace, agents, apps, loading, failed, retry, canUseSessions } = useWorkSpace()
  const navigate = useNavigate()
  const location = useLocation()
  const format = useFormatter()
  const t = useTranslations('duetApp.teamSpace')
  const reduceMotion = useReducedMotion()
  const [seed, setSeed] = useState<{ text: string }>()
  const firstName = (identity.user.name ?? identity.user.email).split(/[\s@]/, 1)[0] ?? ''
  const now = useMemo(() => new Date(clock?.() ?? Date.now()), [clock])
  const greeting = t(`greeting.${greetingForDate(now)}`)
  const date = useMemo(
    () =>
      format.dateTime(now, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    [format, now],
  )
  const duetName = workspace.duetName ?? DEFAULT_AGENT_NAME
  const availableAgents = useMemo(() => agents.filter(agentIsLaunchable), [agents])
  const selectedAgentSlug = new URLSearchParams(location.search).get('agent') ?? ROOT_AGENT_SCOPE
  const selectedAgent =
    selectedAgentSlug === ROOT_AGENT_SCOPE
      ? undefined
      : availableAgents.find(agent => agent.slug === selectedAgentSlug)
  const selectedOwnerSlug = selectedAgent?.slug ?? ROOT_AGENT_SCOPE
  const selectedOwnerName = selectedAgent?.name ?? selectedAgent?.slug ?? duetName
  const ownerOnHome = workspace.role === 'owner'
  const openMembers = useCallback(
    () =>
      navigate(`/w/${encodeURIComponent(workspace.slug)}/settings/members`, {
        state: settingsNavigationState(location.pathname, location.search),
      }),
    [location.pathname, location.search, navigate, workspace.slug],
  )
  const openCreatedSession = useCallback(
    (sessionId: string) =>
      navigate(
        `${agentsMapUrl(workspace.slug, {
          kind: 'sessions',
          agentSlug: selectedOwnerSlug,
          sessionId,
        })}?mode=work`,
        { replace: true },
      ),
    [navigate, selectedOwnerSlug, workspace.slug],
  )
  const creation = useWorkSessionCreation({
    workspaceSlug,
    defaultTier: workspace.defaultTier.effective ?? DEFAULT_SESSION_TIER,
    seed,
    ownerCwd: selectedAgent?.anchorPath,
    agentSlug: selectedOwnerSlug,
    onStarted: openCreatedSession,
  })
  const selectAgent = useCallback(
    (agentSlug: string) => navigate(workHomeUrl(workspace.slug, agentSlug), { replace: true }),
    [navigate, workspace.slug],
  )
  const view = workHomeView(canUseSessions, creation.pendingPrompt)
  const showAppsSection = loading || failed || apps.length > 0

  if (view === 'conversation') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center border-b border-border/70 px-3 sm:px-4">
          <WorkSessionHeading
            title={
              initialSessionTitle({
                prompt: creation.pendingPrompt ?? '',
                ...creation.pendingMedia,
              }) || t('conversation')
            }
          />
        </header>
        <SessionConversation
          workspaceSlug={workspaceSlug}
          agents={agents}
          ownerAgentSlug={selectedOwnerSlug}
          sessionId={undefined}
          pendingPrompt={creation.pendingPrompt}
          pendingAgentFirstMessage={creation.pendingAgentFirstMessage}
          pendingQuality={creation.pendingQuality}
          defaultTier={workspace.defaultTier.effective ?? DEFAULT_SESSION_TIER}
          duetName={duetName}
          pendingCwd={creation.pendingCwd}
          pendingMedia={creation.pendingMedia}
          pendingDraft={creation.prompt}
          creditRecovery={workspace.creditRecovery}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'mx-auto w-full max-w-[46rem] px-5',
            showAppsSection
              ? 'pb-28 pt-9 sm:pt-14 lg:pb-20'
              : 'flex min-h-full flex-col justify-center py-12',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <p className="min-h-8 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              {date}
            </p>
            {ownerOnHome ? (
              <InviteButton
                label={t('invite')}
                onSelect={openMembers}
                className="hidden h-8 rounded-md lg:inline-flex"
              />
            ) : null}
          </div>
          <h1 className="mt-2 font-serif text-3xl font-normal leading-tight tracking-tight">
            {greeting}, {firstName}
          </h1>

          <section aria-label={t('startConversation')} className="mt-5" data-work-session-starter>
            {view === 'starter' ? (
              <WorkSessionStarter
                workspaceSlug={workspaceSlug}
                ownerAgentSlug={selectedOwnerSlug}
                duetName={selectedOwnerName}
                creditRecovery={workspace.creditRecovery}
                placeholder={t('composerPlaceholder')}
                creation={creation}
                submitAccessory={
                  <WorkAgentPicker
                    workspaceSlug={workspace.slug}
                    duetName={duetName}
                    agents={availableAgents}
                    selectedSlug={selectedOwnerSlug}
                    disabled={creation.audience?.submitting ?? false}
                    onSelect={selectAgent}
                  />
                }
              />
            ) : (
              <div className="h-40 overflow-hidden rounded-xl border border-border/75">
                <SessionsAccessDenied />
              </div>
            )}
          </section>

          {canUseSessions ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {STARTERS.map(([labelKey, draftKey]) => {
                const label = t(`starters.${labelKey}`)
                const draft = t(`starters.${draftKey}`)
                return (
                  <button
                    key={label}
                    type="button"
                    data-work-starter
                    onClick={() => setSeed({ text: draft })}
                    className="min-h-11 rounded-full border border-border/80 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[border-color,color,transform] hover:border-border hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none lg:min-h-0"
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          ) : null}
          {showAppsSection ? (
            <>
              <div className="mb-2 mt-8 flex items-center gap-2 sm:mt-10">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                  {t('appsTitle')}
                </h2>
                <span className="h-px flex-1 bg-border/60" />
              </div>

              {loading ? (
                <div className="grid gap-2 sm:grid-cols-2" aria-label={t('loadingApps')}>
                  {Array.from({ length: 4 }, (_, index) => (
                    <div key={index} className="h-24 animate-pulse rounded-xl bg-muted/55" />
                  ))}
                </div>
              ) : failed ? (
                <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 px-5 py-4 text-center sm:py-8">
                  <Robot className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">{t('workspaceErrorTitle')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('workspaceErrorBody')}
                  </p>
                  <button
                    type="button"
                    onClick={retry}
                    className="mt-4 inline-flex min-h-11 items-center rounded-md border bg-background px-3 text-xs font-medium shadow-sm transition-transform active:scale-[0.98] motion-reduce:transform-none"
                  >
                    {t('retry')}
                  </button>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {apps.map(({ app, ownerSlug, ownerName }) => {
                    const status = appDisplayStatus(app)
                    const name = appDisplayName(app)
                    return (
                      <button
                        key={app.id}
                        type="button"
                        data-work-app-card
                        title={name}
                        onClick={() =>
                          navigate(
                            `${agentsMapUrl(workspace.slug, {
                              kind: 'agent',
                              agentSlug: ownerSlug,
                              card: { kind: 'app', appSlug: app.slug },
                            })}?mode=work`,
                          )
                        }
                        className="group flex h-28 w-full min-w-0 items-center gap-3 rounded-xl border border-border/75 bg-card p-3.5 text-left shadow-[0_1px_0_hsl(var(--foreground)/0.025)] outline-none transition-[border-color,box-shadow,transform] duration-150 hover:border-border hover:shadow-sm active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none"
                      >
                        <span className="grid size-11 shrink-0 place-items-center rounded-[28%] bg-muted/55 ring-1 ring-inset ring-border/60">
                          <AppIcon
                            app={app}
                            status={status}
                            workspaceSlug={workspace.slug}
                            className="size-8"
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block max-h-10 overflow-hidden text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                            {name}
                          </span>
                          <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <UsersThree size={13} />
                            <span className="truncate">{t('builtBy', { name: ownerName })}</span>
                          </span>
                          <span className="mt-1 block truncate text-[11px] capitalize text-muted-foreground/80">
                            {t(`visibility.${app.visibility}`)} · {t(`appStatus.${status}`)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-full bg-muted-foreground/35',
                            status === 'reconciled' && 'bg-emerald-500',
                            status === 'reconciling' && 'animate-pulse bg-amber-500',
                            (status === 'failed' || status === 'broken') && 'bg-destructive',
                          )}
                          aria-label={t(`appStatus.${status}`)}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          ) : null}
        </motion.div>
      </div>
    </div>
  )
}

function WorkAgentPicker({
  workspaceSlug,
  duetName,
  agents,
  selectedSlug,
  disabled,
  onSelect,
}: {
  workspaceSlug: string
  duetName: string
  agents: readonly Agent[]
  selectedSlug: string
  disabled: boolean
  onSelect: (slug: string) => void
}) {
  const t = useTranslations('duetApp.teamSpace')
  const [open, setOpen] = useState(false)
  const selected = agents.find(agent => agent.slug === selectedSlug)
  const selectedName = selected?.name ?? selected?.slug ?? duetName

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('agentPickerLabel', { name: selectedName })}
          disabled={disabled}
          className="inline-flex min-h-11 max-w-[9rem] shrink-0 items-center gap-1.5 rounded-md border border-border/80 bg-background py-1 pl-1 pr-2 text-left outline-none transition-[border-color,background-color,transform] hover:border-border hover:bg-accent/60 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none sm:max-w-[12rem] md:min-h-8"
        >
          <AgentAvatar
            avatarKey={selected?.slug ?? ROOT_AGENT_SCOPE}
            duet={selected === undefined}
            profile={selected}
            workspaceSlug={workspaceSlug}
            className="size-7 shrink-0 md:size-6"
          />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{selectedName}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden p-1.5"
        data-work-agent-picker
      >
        <p className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
          {t('startWith')}
        </p>
        <div
          role="listbox"
          aria-label={t('chooseAgent')}
          className="max-h-72 overflow-y-auto"
          onKeyDown={moveAgentPickerFocus}
        >
          <AgentPickerOption
            workspaceSlug={workspaceSlug}
            name={duetName}
            slug={ROOT_AGENT_SCOPE}
            selected={selectedSlug === ROOT_AGENT_SCOPE}
            onSelect={() => {
              onSelect(ROOT_AGENT_SCOPE)
              setOpen(false)
            }}
          />
          {agents.map(agent => (
            <AgentPickerOption
              key={agent.id}
              workspaceSlug={workspaceSlug}
              name={agent.name ?? agent.slug}
              slug={agent.slug}
              agent={agent}
              selected={selectedSlug === agent.slug}
              onSelect={() => {
                onSelect(agent.slug)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function moveAgentPickerFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
  )
  if (options.length === 0) return

  const activeIndex = options.findIndex(option => option === document.activeElement)
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowUp'
          ? activeIndex <= 0
            ? options.length - 1
            : activeIndex - 1
          : activeIndex === options.length - 1
            ? 0
            : activeIndex + 1
  event.preventDefault()
  options[nextIndex]?.focus()
}

function AgentPickerOption({
  workspaceSlug,
  name,
  slug,
  agent,
  selected,
  onSelect,
}: {
  workspaceSlug: string
  name: string
  slug: string
  agent?: Agent
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-muted/70',
      )}
    >
      <AgentAvatar
        avatarKey={slug}
        duet={agent === undefined}
        profile={agent}
        workspaceSlug={workspaceSlug}
        className="size-8 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
      {selected ? (
        <Check aria-hidden size={16} weight="bold" className="shrink-0 text-foreground" />
      ) : null}
    </button>
  )
}
