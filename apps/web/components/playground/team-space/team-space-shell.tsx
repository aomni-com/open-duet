'use client'

import {
  AtIcon,
  CaretUpDownIcon,
  ChatCircleIcon,
  CheckIcon,
  GearSixIcon,
  GraphIcon,
  HouseIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'

import { WORKSPACES, type TeamSession, type TeamWorkspace } from './team-space-fixture'
import { MemberFace, StatusDot, UnreadCount } from './team-space-parts'
import { useWorkspace, useMember } from './team-space-workspace'

/** Where the column can send you. */
export type TeamSpaceDestination =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'app'; id: string }

/**
 * The whole of the work surface's navigation.
 *
 * One column, and it answers three questions in the order a person asks them:
 * where do I start, what is already running, and who is in this workspace. The
 * first two are the body and they scroll. The third is furniture — it does not
 * change from hour to hour and nobody scrolls looking for it — so it sits on
 * the bottom edge above the reader's own row, where the eye already goes for
 * "who", and it is a stack of faces rather than a list because the question a
 * face answers is exactly the question being asked.
 *
 * Everything the builder's surface needs — the file tree, the app editor, an
 * agent's configuration — lives behind the mode switch, and where the reader is
 * only a worker there is no switch at all.
 */
export function TeamSpaceShell({
  mode = 'work',
  onMode,
  activeSessionId,
  activeAppId,
  activeAgentSlug,
  onOpenAgent,
  onNavigate,
  onSwitchWorkspace,
  rail,
  railCovers = true,
  children,
}: {
  mode?: 'work' | 'build'
  onMode?: (mode: 'work' | 'build') => void
  /** Build only: which agent is unfolded, if any. */
  activeAgentSlug?: string
  onOpenAgent?: (slug: string | undefined) => void
  /** Absent on Home and in the directory. */
  activeSessionId?: string
  activeAppId?: string
  onNavigate?: (target: TeamSpaceDestination) => void
  onSwitchWorkspace?: (id: string) => void
  /** The jobs panel, when a chat has one out. Its own column, right of the pane. */
  rail?: ReactNode
  /**
   * Whether the rail may cover the pane where there is no room beside it.
   *
   * False once the reader has gone *into* one of its rows: below `lg` the rail
   * and the job are two destinations rather than two panes, and an index drawn
   * over the thing it indexes is the reader's own click undone.
   */
  railCovers?: boolean
  children: ReactNode
}) {
  const workspace = useWorkspace()
  const viewer = useMember(workspace.viewerId)

  return (
    <div
      /* Which workspace is on screen, readable from the DOM. The switcher is the
         one control here whose whole effect is that everything else changes,
         and a test that had to assert that by reading a workspace name out of a
         header would be asserting a label rather than the fact. */
      data-team-space-workspace={workspace.id}
      /* `km-hues` declares the workspace's state colours for anything drawing a
         state mark outside the map — which every status dot and unread count
         below is. See `StatusDot`. */
      className="km-hues relative flex h-[100dvh] min-h-0 w-full overflow-hidden bg-background text-foreground"
    >
      <aside className="hidden w-[17rem] shrink-0 flex-col border-r border-border/70 bg-sidebar lg:flex">
        <WorkspaceHeader workspace={workspace} onSwitchWorkspace={onSwitchWorkspace} />
        {workspace.viewerCanBuild ? <ModeSwitch mode={mode} onMode={onMode} /> : null}

        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto px-2.5 pb-3',
            /* Without the switch the column starts on Home, and Home needs the
               same breathing room under the workspace name that the switch was
               giving it. */
            workspace.viewerCanBuild ? undefined : 'pt-2.5',
          )}
        >
          {mode === 'build' ? (
            <BuildNav
              activeAgentSlug={activeAgentSlug}
              onOpenAgent={agent => onOpenAgent?.(agent)}
            />
          ) : (
            <>
              <div className="space-y-0.5">
                <NavRow
                  icon={<HouseIcon />}
                  label="Home"
                  active={activeSessionId === undefined && activeAppId === undefined}
                  onSelect={() => onNavigate?.({ kind: 'home' })}
                />
                <NavRow icon={<AtIcon />} label="Mentions" badge={3} />
              </div>

              <SectionLabel action="New chat">Chats</SectionLabel>
              <div className="space-y-0.5">
                {workspace.sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onNavigate?.({ kind: 'session', id: session.id })}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      session.id === activeSessionId
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                      /* Unread is the one thing that outranks the selection: a
                         room you have not read has to be legible from across the
                         column, and greying it because you happen to be standing
                         somewhere else is how it gets missed. */
                      session.unread !== undefined && 'font-semibold text-foreground',
                    )}
                  >
                    {/* Every row carries a mark, the quiet ones included: the
                        gutter has to be the same width on all of them or the
                        titles do not line up. */}
                    <span className="grid w-5 shrink-0 place-items-center">
                      <StatusDot tone={sessionTone(session)} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    {session.unread !== undefined ? <UnreadCount count={session.unread} /> : null}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Same insets as `WorkspaceHeader`: these are the two identity rows of
            one column, at its top and its bottom, and four pixels of
            disagreement between them is visible even to somebody who could not
            say what they were looking at. */}
        <div className="flex shrink-0 items-center gap-1 border-t border-border/70 px-2.5 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1">
            {viewer ? <MemberFace member={viewer} className="size-7 shrink-0" /> : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-4">{viewer?.name}</span>
              <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                {viewer?.kind === 'person' ? viewer.role : null}
              </span>
            </span>
          </div>
          <span className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground">
            <GearSixIcon className="size-[18px]" />
          </span>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        {/* No column below `lg`, so Home carries the navigation instead. A room
            does not: its composer owns the bottom edge, and the way out of it is
            the back control in its own header. */}
        {mode === 'work' && activeSessionId === undefined && activeAppId === undefined ? (
          <nav className="flex shrink-0 items-stretch border-t border-border/70 bg-sidebar lg:hidden">
            {[
              { label: 'Home', icon: <HouseIcon />, active: true },
              { label: 'Chats', icon: <ChatCircleIcon />, badge: 7 },
              { label: 'Mentions', icon: <AtIcon />, badge: 3 },
              { label: 'You', icon: <GearSixIcon /> },
            ].map(tab => (
              <span
                key={tab.label}
                className={cn(
                  'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium [&_svg]:size-5',
                  tab.active === true ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {tab.icon}
                {tab.label}
                {tab.badge !== undefined ? (
                  <span className="absolute right-[calc(50%-1.55rem)] top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold tabular-nums text-brand-foreground">
                    {tab.badge}
                  </span>
                ) : null}
              </span>
            ))}
          </nav>
        ) : null}
      </div>

      {/* A column on a desktop, the whole screen on a phone. Below `lg` there is
          no room for a third column beside a conversation, and the alternative
          — hiding it — would leave the control in the chat header doing nothing
          on exactly the device where a person is most likely to be checking
          whether anything is stuck on them. */}
      {rail !== undefined ? (
        <div
          className={cn(
            'flex',
            railCovers
              ? 'absolute inset-0 z-30 bg-sidebar lg:static lg:z-auto lg:bg-transparent'
              : 'hidden lg:flex',
          )}
        >
          {rail}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Which workspace, and the way to another.
 *
 * The switcher is the one control that has to be here rather than in settings:
 * whether the reader may build is a fact about a *membership*, so the same
 * account crosses from a workspace with two modes to one with a single mode by
 * switching workspaces. A menu that only ever listed names would hide the thing
 * worth knowing, so each row says what the reader is in that workspace.
 */
function WorkspaceHeader({
  workspace,
  onSwitchWorkspace,
}: {
  workspace: TeamWorkspace
  onSwitchWorkspace?: (id: string) => void
}) {
  return (
    /* `h-12`, because the pane next door is `h-12`. The column and the surface
       it opens share a top edge, and two rules eight pixels apart across a
       vertical border is the kind of misalignment nobody names but everybody
       sees. Both lines of the name fit inside it — 16px each against a 28px
       tile — so the height is a constraint the content already met rather than
       one imposed on it. */
    <div className="flex h-12 shrink-0 items-center gap-1 px-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-sidebar-accent/60"
          >
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-sm font-semibold text-background"
            >
              {workspace.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-4">
                {workspace.name}
              </span>
              <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                Agents by {workspace.builder}
              </span>
            </span>
            <CaretUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {WORKSPACES.map(option => (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => onSwitchWorkspace?.(option.id)}
              className="gap-2"
            >
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-semibold text-background"
              >
                {option.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{option.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {option.viewerCanBuild ? 'You build and work here' : 'You work here'}
                </span>
              </span>
              {option.id === workspace.id ? (
                <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground">
        <MagnifyingGlassIcon className="size-[18px]" />
      </span>
    </div>
  )
}

/**
 * The pivot, stated once and in the only place it belongs.
 *
 * **Work** is this surface. **Build** is the one that already exists — files
 * beside a chat, where the agents are configured. Putting the two on one
 * control is what says they are the same workspace rather than two products. It is
 * rendered only for a reader whose membership can reach both: see
 * `TeamWorkspace.viewerCanBuild` on why the alternative is worse than absence.
 */
function ModeSwitch({
  mode,
  onMode,
}: {
  mode: 'work' | 'build'
  onMode?: (mode: 'work' | 'build') => void
}) {
  return (
    <div className="px-2.5 py-2">
      <div className="flex rounded-md bg-muted/70 p-0.5">
        <ModeTab
          icon={<SquaresFourIcon />}
          label="Work"
          on={mode === 'work'}
          onSelect={() => onMode?.('work')}
        />
        <ModeTab
          icon={<PencilSimpleIcon />}
          label="Build"
          on={mode === 'build'}
          onSelect={() => onMode?.('build')}
        />
      </div>
    </div>
  )
}

function ModeTab({
  icon,
  label,
  on,
  onSelect,
}: {
  icon: ReactNode
  label: string
  on: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={on ? 'true' : undefined}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 py-1 text-xs transition-colors [&_svg]:size-3.5',
        on
          ? 'bg-background font-semibold shadow-xs'
          : 'font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * What the column navigates between in Build.
 *
 * The same shape as the chats it replaces — one destination above a list — so
 * crossing between modes moves the *contents* of the column and nothing else.
 * The canvas is the mode's Home, and the list is the agents on it, ending in
 * the one row that is not an agent yet.
 */
function BuildNav({
  activeAgentSlug,
  onOpenAgent,
}: {
  activeAgentSlug?: string
  onOpenAgent: (slug: string | undefined) => void
}) {
  const workspace = useWorkspace()
  return (
    <>
      <div className="space-y-0.5">
        <NavRow
          icon={<GraphIcon />}
          label="Map"
          active={activeAgentSlug === undefined}
          onSelect={() => onOpenAgent(undefined)}
        />
      </div>

      <SectionLabel>Agents</SectionLabel>
      <div className="space-y-0.5">
        {workspace.agents
          .filter(agent => agent.orchestrator !== true)
          .map(agent => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onOpenAgent(agent.slug)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                agent.slug === activeAgentSlug
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )}
            >
              <MemberFace
                member={{ kind: 'agent', ...agent }}
                className={cn('size-5', agent.status === 'setup' && 'opacity-45 grayscale')}
              />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.status === 'working' ? <StatusDot tone="live" /> : null}
              {agent.status === 'setup' ? (
                <LockSimpleIcon className="size-3 shrink-0 opacity-60" />
              ) : null}
            </button>
          ))}
        {/* The list ends where the workspace does. A builder's column whose last
            row is the last agent has no answer to "and another one", and a plus
            hidden in a section heading is not one either — it is the same size
            as a control that adds a chat. */}
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
        >
          <span
            aria-hidden
            className="grid size-5 shrink-0 place-items-center rounded-[28%] border border-dashed border-border"
          >
            <PlusIcon className="size-3" />
          </span>
          Add an agent
        </button>
      </div>
    </>
  )
}

function NavRow({
  icon,
  label,
  active,
  badge,
  onSelect,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  badge?: number
  onSelect?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors [&_svg]:size-5',
        active === true
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge !== undefined ? (
        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

function SectionLabel({ children, action }: { children: ReactNode; action?: string }) {
  return (
    <div className="mt-5 flex items-center justify-between px-2 pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
        {children}
      </span>
      {action !== undefined ? (
        <button
          type="button"
          aria-label={action}
          className="grid size-4 place-items-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/** The one mark a chat row carries, decided in one place. */
function sessionTone(session: TeamSession): 'live' | 'asking' | 'sleeping' | 'idle' {
  if (session.live === true) return 'live'
  if (session.asking === true) return 'asking'
  if (session.sleeping === true) return 'sleeping'
  return 'idle'
}
