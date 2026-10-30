'use client'

import { CaretDown, Gear, Plus, TerminalWindow, UserCircle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useLocation, useNavigate } from 'react-router'

import type { WorkspaceSummary } from '@repo/contract'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'
import type { DuetLocale } from '@repo/web-locale'

import { useSpa } from '../context'
import { CheckoutCelebrationOverlay } from '../entitlements/checkout-celebration'
import { WorkspaceBillingBoundary } from '../entitlements/workspace-billing-boundary'
import { UserAvatar } from '../identity/identity-avatar'
import { AgentManagementFrame } from '../routes/train/train-rail'
import { CreateWorkspaceDialog } from '../shell/create-workspace-dialog'
import { PreferenceMenuItems } from '../shell/preference-menu-items'
import { useSwitchLocale } from '../shell/use-switch-locale'
import { WorkspaceMenuItems } from '../shell/workspace-menu-items'
import { workHomeUrl, workPresentationForPath } from '../team-space/work-destination'
import { WorkFrame, WorkspaceAccountFooter } from '../team-space/work-frame'
import { agentManagementDestinationForPath } from './agent-management-route'
import { driveRoutes, driveWorkspaceDestination, isDriveCanvasPath } from './drive-routes'
import { DRIVE_TOPBAR_CLEARANCE, DriveShell, DriveTopBar } from './drive-shell'
import { workspaceRouteTransitionKey } from './route-entrance'
import { WorkspaceRouteTransition } from './workspace-route-transition'
import { buildWorkspaceTabs, workspaceTabForPath } from './workspace-tabs'

export function DriveWorkspaceShell({
  workspace,
  children,
}: {
  workspace: WorkspaceSummary
  children: ReactNode
}) {
  const t = useTranslations('duetApp')
  const { identity, createWorkspace, logout } = useSpa()
  const switchLocale = useSwitchLocale()
  const navigate = useNavigate()
  const location = useLocation()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [mobileSwitcherOpen, setMobileSwitcherOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const switcherButton = useRef<HTMLButtonElement>(null)
  const mobileSwitcherButton = useRef<HTMLButtonElement>(null)
  const createReturnFocus = useRef<HTMLButtonElement | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const activeTab = workspaceTabForPath(location.pathname)
  const tabs = buildWorkspaceTabs(destination =>
    destination === 'desktop' ? t('desktop.tabLabel') : t(destination),
  )
  /* The map is a canvas, not a document: it wants the whole window, and the bar
     floats over it rather than standing on it. See `DriveShell`. */
  const canvas = isDriveCanvasPath(location.pathname)
  const workPresentation = workPresentationForPath(
    location.pathname,
    workspace.slug,
    location.search,
  )
  const work = workPresentation.kind !== 'build'
  const agentManagement = agentManagementDestinationForPath(location.pathname, workspace.slug)

  const switchWorkspace = useCallback(
    async (next: WorkspaceSummary) => {
      setSwitcherOpen(false)
      setMobileSwitcherOpen(false)
      navigate(
        work ? workHomeUrl(next.slug) : driveWorkspaceDestination(location.pathname, next.slug),
      )
    },
    [location.pathname, navigate, work],
  )

  useEffect(() => {
    content.current?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  const transitionKey = workspaceRouteTransitionKey(
    location.pathname,
    location.search,
    workspace.slug,
    activeTab,
  )
  const destination = (
    <WorkspaceRouteTransition transitionKey={transitionKey}>{children}</WorkspaceRouteTransition>
  )

  const renderAccountMenu = (trigger: 'avatar' | 'settings' = 'avatar') => (
    <AccountMenu
      workspace={workspace}
      userName={identity.user.name ?? identity.user.email}
      internalAdmin={identity.internalAdmin}
      trigger={trigger}
      onNavigate={navigate}
      onNavigateSettings={path =>
        navigate(path, {
          state: { settingsReturnTo: `${location.pathname}${location.search}` },
        })
      }
      onLocale={switchLocale}
      onLogout={() => void logout()}
    />
  )
  const accountMenu = renderAccountMenu()
  const adminMessage = workspace.adminMessage ? (
    <aside
      role="status"
      className="border-b border-amber-300/50 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100 md:px-6"
    >
      <strong className="mr-2">{t('operatorMessage')}</strong>
      <span>{workspace.adminMessage}</span>
    </aside>
  ) : null

  const shell = work ? (
    <WorkFrame
      workspace={workspace}
      desktopWorkspaceControl={
        <WorkspaceSwitcher
          workspace={workspace}
          workspaces={identity.workspaces}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          onSelect={switchWorkspace}
          onCreate={() => {
            setSwitcherOpen(false)
            createReturnFocus.current = switcherButton.current
            requestAnimationFrame(() => setCreateOpen(true))
          }}
          buttonRef={switcherButton}
        />
      }
      desktopAccountControl={renderAccountMenu('settings')}
      mobileWorkspaceControl={
        <WorkspaceSwitcher
          workspace={workspace}
          workspaces={identity.workspaces}
          open={mobileSwitcherOpen}
          onOpenChange={setMobileSwitcherOpen}
          onSelect={switchWorkspace}
          onCreate={() => {
            setMobileSwitcherOpen(false)
            createReturnFocus.current = mobileSwitcherButton.current
            requestAnimationFrame(() => setCreateOpen(true))
          }}
          buttonRef={mobileSwitcherButton}
          showNameOnMobile
        />
      }
      mobileAccountControl={accountMenu}
    >
      <div className="flex h-full min-h-0 flex-col">
        {adminMessage}
        <div className="min-h-0 flex-1">{destination}</div>
      </div>
    </WorkFrame>
  ) : (
    <DriveShell
      bottomLeft={
        <WorkspaceAccountFooter
          userName={identity.user.name ?? identity.user.email}
          role={t(`teamSpace.roles.${workspace.role}`)}
          accountControl={renderAccountMenu('settings')}
        />
      }
      topBar={
        <DriveTopBar
          tabs={tabs}
          activeTab={activeTab}
          label={t('workspaceNavigation')}
          onSelectTab={tab => navigate(driveRoutes[tab](workspace.slug))}
          leftSlot={
            <WorkspaceSwitcher
              workspace={workspace}
              workspaces={identity.workspaces}
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
              onSelect={switchWorkspace}
              onCreate={() => {
                setSwitcherOpen(false)
                createReturnFocus.current = switcherButton.current
                requestAnimationFrame(() => setCreateOpen(true))
              }}
              buttonRef={switcherButton}
            />
          }
          rightSlot={null}
        />
      }
    >
      <div
        ref={content}
        id={activeTab ? `drive-panel-${activeTab}` : undefined}
        role={activeTab ? 'tabpanel' : undefined}
        aria-labelledby={activeTab ? `drive-tab-${activeTab}` : undefined}
        tabIndex={activeTab ? 0 : undefined}
        className={cn(
          'h-full min-h-0 min-w-0 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
          !canvas && DRIVE_TOPBAR_CLEARANCE,
        )}
      >
        {adminMessage}
        {agentManagement === null ? (
          destination
        ) : (
          <AgentManagementFrame workspaceSlug={workspace.slug} destination={agentManagement}>
            {destination}
          </AgentManagementFrame>
        )}
      </div>
    </DriveShell>
  )

  return (
    <>
      <WorkspaceBillingBoundary
        workspace={workspace}
        onSwitchWorkspace={switchWorkspace}
        recoveryView={
          workspace.role === 'owner' &&
          location.pathname.replace(/\/$/, '') === `/w/${workspace.slug}/settings/backups`
        }
      >
        {shell}
        <CreateWorkspaceDialog
          open={createOpen}
          onClose={() => {
            setCreateOpen(false)
            requestAnimationFrame(() => createReturnFocus.current?.focus())
          }}
          onCreate={async input => {
            const created = await createWorkspace(input)
            navigate(workHomeUrl(created.slug))
          }}
        />
      </WorkspaceBillingBoundary>
      <CheckoutCelebrationOverlay />
    </>
  )
}

function WorkspaceSwitcher({
  workspace,
  workspaces,
  open,
  onOpenChange,
  onSelect,
  onCreate,
  buttonRef,
  showNameOnMobile = false,
}: {
  workspace: WorkspaceSummary
  workspaces: WorkspaceSummary[]
  open: boolean
  onOpenChange(open: boolean): void
  onSelect(workspace: WorkspaceSummary): void
  onCreate(): void
  buttonRef: React.RefObject<HTMLButtonElement | null>
  showNameOnMobile?: boolean
}) {
  const t = useTranslations('duetApp')
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          ref={buttonRef}
          aria-label={t('switchWorkspace')}
          /* The workspace switcher is icon-only below `sm` — its name and caret
             are `hidden sm:block` — so a 36px row was a 40px target with a 24px
             avatar in it. `h-11 min-w-11` on a phone, the pointer's 36 above. */
          className="flex h-11 max-w-full items-center gap-2 rounded-full px-2 text-left outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-header-ring/45 max-sm:min-w-11 sm:h-9"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-[10px] font-bold text-background">
            {workspace.name.slice(0, 1).toUpperCase()}
          </span>
          <span className={cn('min-w-0', showNameOnMobile ? 'block' : 'hidden sm:block')}>
            <span className="block max-w-40 truncate text-xs font-semibold leading-tight">
              {workspace.name}
            </span>
            {/* `/70`, not the `/55` this carried on the old opaque bar. That
                bar was a mid grey in the light theme and this slug cleared it;
                the glass composites to near the page white, where the same
                alpha measured 3.7:1 — under the 4.5 floor for text this
                small. */}
            <span className="mt-0.5 block max-w-40 truncate text-[10px] leading-tight text-header-foreground/70">
              {workspace.slug}
            </span>
          </span>
          <CaretDown
            aria-hidden
            className={cn('shrink-0', showNameOnMobile ? 'block' : 'hidden sm:block')}
            size={14}
          />
        </button>
      </DropdownMenuTrigger>
      {/* Sized by its rows: a fixed width left a dead column once the ⌘n hints
          went, with the checkmark stranded far from the name it marks. The
          ever-present "Create workspace" row is floor enough; the ceiling
          makes a long name truncate instead of stretching the menu. */}
      <DropdownMenuContent align="start" sideOffset={8} className="max-w-72">
        <WorkspaceMenuItems current={workspace} workspaces={workspaces} onSelect={onSelect} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCreate} className="font-medium">
          <Plus size={16} /> {t('createWorkspace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu({
  workspace,
  userName,
  internalAdmin,
  trigger = 'avatar',
  onNavigate,
  onNavigateSettings,
  onLocale,
  onLogout,
}: {
  workspace: WorkspaceSummary
  userName: string
  internalAdmin: boolean
  trigger?: 'avatar' | 'settings'
  onNavigate(path: string): void
  onNavigateSettings(path: string): void
  onLocale(locale: DuetLocale): void
  onLogout(): void
}) {
  const t = useTranslations('duetApp')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <AccountTrigger label={t('accountMenu')} userName={userName} trigger={trigger} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-60">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-semibold">{workspace.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{workspace.slug}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(workspaceStatusLabel(workspace.status))}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onNavigateSettings(`/w/${workspace.slug}/settings/general`)}
        >
          <Gear size={17} /> {t('workspaceSettings')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNavigateSettings('/settings/profile')}>
          <UserCircle size={17} /> {t('userSettings')}
        </DropdownMenuItem>
        {internalAdmin ? (
          <DropdownMenuItem onSelect={() => onNavigate('/internal-admin')}>
            <TerminalWindow size={17} /> {t('internalAdmin')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <PreferenceMenuItems onLocale={onLocale} onLogout={onLogout} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const AccountTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'aria-label'> & {
    label: string
    userName: string
    trigger?: 'avatar' | 'settings'
  }
>(function AccountTrigger({ label, userName, trigger = 'avatar', className, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        /* The account menu is the door to every setting and to signing out, and
           it sits in the far corner where a thumb is least accurate. It gets the
           full 44 on a phone. */
        'grid size-11 place-items-center rounded-[32%] bg-foreground/[0.055] text-header-foreground outline-none ring-1 ring-inset ring-foreground/[0.07] transition-[background-color,transform] duration-150 hover:bg-foreground/[0.11] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-header-ring motion-reduce:transform-none sm:size-9',
        className,
      )}
    >
      {trigger === 'settings' ? (
        <Gear aria-hidden size={17} className="text-muted-foreground" />
      ) : (
        <UserAvatar name={userName} className="size-7" />
      )}
    </button>
  )
})

function workspaceStatusLabel(status: WorkspaceSummary['status']) {
  if (status === 'active') return 'active' as const
  if (status === 'provisioning') return 'provisioning' as const
  if (status === 'unhealthy') return 'unhealthy' as const
  return 'unavailable' as const
}
