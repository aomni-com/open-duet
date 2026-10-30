'use client'

/* ============================================================================
   The ⋯ menu on an app, and everything behind it.

   An app used to have a page of its own — a workspace-level `/w/:ws/apps/:slug`
   — and that page carried a header bar with the app's name, its state, and
   every control it has. The page is gone: an app belongs to whichever agent's
   folder encloses it, so it is *addressed* under that agent and drawn on that
   agent's card, whole, with nothing framing it.

   The controls had to go somewhere, and this is it. One menu on the chip that
   names the app, which is the only chrome the card has that is already about
   *this app* rather than about the agent. Same shape as the agent's own ⋯ menu
   next door: this file owns the trigger, the items, the mutations and the
   dialogs, so no surface that mounts it re-implements any of them.

   App deletion confirms that the runtime leaves while its files survive. Domain
   removal explains its address fallback inside the shared domain manager.
   Publishing is reversible from the same menu.

   EVERY item carries a tooltip, off to the right of the menu, and each says
   the CONSEQUENCE rather than restating the label: which URL starts or stops
   serving, what a copied link is for, what survives a delete. `Publish` and
   `Delete app` are two words each and neither says what it leaves behind —
   the item names the action and the tooltip is where the reader finds out
   what it does. Right, not above: the menu is already anchored to the end of
   a chip, so a tooltip over it would cover the item under the pointer.
   ========================================================================= */
import {
  ArrowSquareOutIcon,
  CopyIcon,
  DotsThreeIcon,
  GlobeIcon,
  LockIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

import { ELEVATED_APP_CAPABILITIES, type App, type AppApiCapability } from '@repo/contract'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/shadcn/alert-dialog'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'

import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { useToast } from '../shell/toast'
import { AppDomainDialog } from './app-domain-dialog'
import { appDisplayName } from './app-icon'
import { appMenuItems, type AppMenuItem } from './app-menu-items'
import { replaceApp, withAppVisibility, withoutApp } from './app-state'

const ELEVATED_APP_CAPABILITY_SET = new Set<AppApiCapability>(ELEVATED_APP_CAPABILITIES)

type UseAppActionsResult = {
  /** the menu for one app, for a host that has somewhere to hang it */
  menuFor(app: App): ReactNode
  /** mount once per surface — domain management and delete confirmation */
  dialogs: ReactNode
}

/**
 * The single owner of the app ⋯ menu's behavior.
 *
 * `onDeleted` lets a host that is *showing* the deleted app move off it; a host
 * that only lists apps passes nothing, because a row that disappears needs no
 * navigation.
 */
export function useAppActions(
  workspaceSlug: string,
  options: { onDeleted?: (app: App) => void } = {},
): UseAppActionsResult {
  const { api } = useSpa()
  const t = useTranslations('duetApp.appsSurface')
  const toast = useToast()
  const queryClient = useQueryClient()
  const queryKey = duetQueryOptions.workspaces.apps(api, workspaceSlug).queryKey
  const appsKey = duetQueryKeys.workspaces.apps.all(workspaceSlug)
  const [domainTarget, setDomainTarget] = useState<App | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null)

  /* Optimistic, and rolled back by hand: the switch is the whole feedback the
     reader gets, so a menu that waits for the round trip reads as a menu that
     did nothing. */
  const visibility = useMutation({
    mutationFn: (target: { app: App; next: 'public' | 'folder' }) =>
      api.setAppVisibility(workspaceSlug, target.app.slug, target.next),
    onMutate: async target => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData(queryKey)
      queryClient.setQueryData(queryKey, current =>
        withAppVisibility(current, target.app.slug, target.next),
      )
      return { previous }
    },
    onError: (_cause, _target, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous)
    },
    onSuccess: result =>
      queryClient.setQueryData(queryKey, current => replaceApp(current, result.app)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: appsKey }),
  })

  /* Never optimistic: it is behind a confirmation that stays up until the
     server has answered, and a row removed before the call lands would leave
     the reader looking at a card for an app that still exists. */
  const remove = useMutation({
    mutationFn: (app: App) => api.deleteApp(workspaceSlug, app.slug),
    onSuccess: (_result, app) => {
      queryClient.setQueryData(queryKey, current => withoutApp(current, app.slug))
      void queryClient.invalidateQueries({ queryKey: appsKey })
      void queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.appDomains(workspaceSlug),
      })
      setDeleteTarget(null)
      options.onDeleted?.(app)
    },
  })

  const menuFor = (app: App) => (
    <AppMenu
      app={app}
      busy={visibility.isPending}
      onVisibility={next => visibility.mutate({ app, next })}
      onDelete={() => setDeleteTarget(app)}
      onDomains={() => setDomainTarget(app)}
      onCopied={() => toast(t('copiedPublicLink'))}
    />
  )

  const dialogs = (
    <>
      {domainTarget !== null && (
        <AppDomainDialog
          workspaceSlug={workspaceSlug}
          app={domainTarget}
          onClose={() => setDomainTarget(null)}
        />
      )}
      <DeleteAppDialog
        app={deleteTarget}
        busy={remove.isPending}
        failed={remove.isError}
        onOpenChange={open => {
          if (remove.isPending) return
          if (!open) {
            remove.reset()
            setDeleteTarget(null)
          }
        }}
        onConfirm={() => {
          if (deleteTarget !== null) remove.mutate(deleteTarget)
        }}
      />
    </>
  )

  return { menuFor, dialogs }
}

/** Presentational: what the menu offers is `appMenuItems`' answer, not this. */
function AppMenu({
  app,
  busy,
  onVisibility,
  onDelete,
  onDomains,
  onCopied,
}: {
  app: App
  busy: boolean
  onVisibility: (next: 'public' | 'folder') => void
  onDelete: () => void
  onDomains: () => void
  /** the host's own "copied" acknowledgement — see the copy item below */
  onCopied?: () => void
}) {
  const t = useTranslations('duetApp.appsSurface')
  const items = appMenuItems(app)

  return (
    <DropdownMenu>
      {/* The trigger names itself the same way its items do. It carried a
          `title` while the items had real tooltips, which is two mechanisms for
          one job in one menu — and the native one is the worse of them. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className="km-chip-menu">
              <DotsThreeIcon aria-hidden size={14} weight="bold" />
              <span className="sr-only">{t('appMenu')}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" collisionPadding={12}>
          {t('appMenu')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6} className="w-60">
        {/* Whether the app is published is a *state*, said out loud. Leaving the
            reader to infer it from which switch happens to be offered fails
            exactly when it matters — an app nobody may unpublish shows no
            switch at all, and silence there reads as "private". */}
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate">{appDisplayName(app)}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {app.visibility === 'public' ? t('public') : t('private')}
            {app.sourceShareId !== undefined ? ` · ${t('sharedWithYou')}` : ''}
          </span>
        </DropdownMenuLabel>
        {items.length > 0 && <DropdownMenuSeparator />}
        {items.map(item => (
          <AppMenuAction
            key={item.kind}
            item={item}
            busy={busy}
            onVisibility={onVisibility}
            onDelete={onDelete}
            onDomains={onDomains}
            onCopied={onCopied}
          />
        ))}
        {app.apiScopes.length > 0 && <ApiScopeDeclaration app={app} />}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Which sentence belongs to which item, in one place.
 *
 * A `Record` keyed by the union rather than a message key written out beside
 * each case: the compiler then refuses a new kind of menu item that arrives
 * without an explanation, which is the only thing standing between this menu
 * and the state it was in — two of five items explaining themselves and the
 * other three silent.
 */
const MENU_TIPS: Record<AppMenuItem['kind'], string> = {
  'open-in-new-tab': 'openInNewTabTooltip',
  'copy-link': 'copyPublicLinkTooltip',
  publish: 'publishTooltip',
  'make-private': 'makePrivateTooltip',
  delete: 'deleteAppTooltip',
  'custom-domains': 'domainsTooltip',
}

/**
 * One item, with what it does said beside it.
 *
 * A real tooltip rather than a `title` attribute: `title` renders wherever the
 * pointer happens to be, after a delay the reader cannot predict, and screen
 * readers treat it inconsistently. The menu opens at the start edge on phones,
 * leaving a narrow but predictable column to its right; a fixed readable width
 * keeps the sentence inside that column without covering the next menu item.
 */
function MenuTip({ kind, children }: { kind: AppMenuItem['kind']; children: ReactNode }) {
  const t = useTranslations('duetApp.appsSurface')
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" align="start" collisionPadding={8} className="w-36">
        {t(MENU_TIPS[kind])}
      </TooltipContent>
    </Tooltip>
  )
}

function AppMenuAction({
  item,
  busy,
  onVisibility,
  onDelete,
  onDomains,
  onCopied,
}: {
  item: AppMenuItem
  busy: boolean
  onVisibility: (next: 'public' | 'folder') => void
  onDelete: () => void
  onDomains: () => void
  onCopied?: () => void
}) {
  const t = useTranslations('duetApp.appsSurface')
  switch (item.kind) {
    case 'open-in-new-tab':
      return (
        <MenuTip kind="open-in-new-tab">
          <DropdownMenuItem asChild className="text-sm">
            <a href={item.url} target="_blank" rel="noreferrer">
              <ArrowSquareOutIcon aria-hidden size={15} />
              {t('openInNewTab')}
            </a>
          </DropdownMenuItem>
        </MenuTip>
      )
    /* The menu shuts on select, so the copy has no button left to turn into a
       tick — the host says so instead, which is why `onCopied` is handed down
       rather than raised here. */
    case 'copy-link':
      return (
        <MenuTip kind="copy-link">
          <DropdownMenuItem
            className="text-sm"
            onSelect={() => {
              void navigator.clipboard
                .writeText(item.url)
                .then(() => onCopied?.())
                .catch(() => {})
            }}
          >
            <CopyIcon aria-hidden size={15} />
            {t('copyPublicLink')}
          </DropdownMenuItem>
        </MenuTip>
      )
    /* The item names the action; the line under it names its consequence —
       which URL starts or stops serving, and to whom. */
    case 'publish':
      return (
        <MenuTip kind="publish">
          <DropdownMenuItem
            className="text-sm"
            disabled={busy}
            onSelect={() => onVisibility('public')}
          >
            <GlobeIcon aria-hidden size={15} />
            {t('publish')}
          </DropdownMenuItem>
        </MenuTip>
      )
    case 'make-private':
      return (
        <MenuTip kind="make-private">
          <DropdownMenuItem
            className="text-sm"
            disabled={busy}
            onSelect={() => onVisibility('folder')}
          >
            <LockIcon aria-hidden size={15} />
            {t('makePrivate')}
          </DropdownMenuItem>
        </MenuTip>
      )
    case 'custom-domains':
      return (
        <MenuTip kind="custom-domains">
          <DropdownMenuItem className="text-sm" onSelect={onDomains}>
            <GlobeIcon aria-hidden size={15} />
            {t('domains.title')}
          </DropdownMenuItem>
        </MenuTip>
      )
    case 'delete':
      return (
        <MenuTip kind="delete">
          <DropdownMenuItem className="text-sm text-destructive" onSelect={onDelete}>
            <TrashIcon aria-hidden size={15} />
            {t('deleteApp')}
          </DropdownMenuItem>
        </MenuTip>
      )
  }
}

/**
 * What authority this app holds over the workspace, as it declared it.
 *
 * Read-only, and the last thing in the menu: the reader agreed to these when
 * the app was installed, and this is where that agreement stays legible
 * afterwards. Elevated capabilities keep their warning treatment and carry the
 * "why it matters" sentence in the accessibility tree unconditionally.
 */
function ApiScopeDeclaration({ app }: { app: App }) {
  const t = useTranslations('duetApp.appsSurface.apiAccess')
  const hasElevated = app.apiScopes.some(scope => ELEVATED_APP_CAPABILITY_SET.has(scope))
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
        {t('title')}
      </DropdownMenuLabel>
      <ul className="flex flex-wrap gap-1 px-2 pb-1.5">
        {app.apiScopes.map(scope => {
          const label = t(`capabilities.${scope}`)
          const isElevated = ELEVATED_APP_CAPABILITY_SET.has(scope)
          return (
            <li
              key={scope}
              aria-label={isElevated ? `${label}: ${t('elevatedCapability')}` : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs font-medium text-foreground',
                isElevated &&
                  'border-amber-600/50 bg-amber-500/10 text-amber-900 dark:text-amber-200',
              )}
            >
              {isElevated ? <WarningCircleIcon aria-hidden size={11} weight="fill" /> : null}
              {label}
            </li>
          )
        })}
      </ul>
      {hasElevated ? (
        <p role="note" className="sr-only">
          <strong>{t('elevatedTitle')}</strong> {t('elevatedBody')}
        </p>
      ) : null}
    </>
  )
}

function DeleteAppDialog({
  app,
  busy,
  failed,
  onOpenChange,
  onConfirm,
}: {
  app: App | null
  busy: boolean
  failed: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const t = useTranslations('duetApp.appsSurface.delete')
  return (
    <AlertDialog open={app !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('title', { name: app === null ? '' : appDisplayName(app) })}
          </AlertDialogTitle>
          {/* Say what survives: the app stops existing, its folder does not. A
              reader who expected the files to go too would go looking for them
              rather than finding them gone. */}
          <AlertDialogDescription>
            {t('description', { path: app?.anchorPath ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t('error')}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('cancel')}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? <SpinnerGapIcon className="mr-2 size-4 animate-spin" /> : null}
            {failed ? t('retry') : t('confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
