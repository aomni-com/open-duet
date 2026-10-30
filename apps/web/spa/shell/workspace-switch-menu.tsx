'use client'

import { ArrowsLeftRight, CaretUp } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import type { WorkspaceSummary } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'

import { WorkspaceMenuItems } from './workspace-menu-items'

/**
 * The viewer's workspaces, and where choosing one goes. A blocking billing
 * surface makes the shell behind it inert, its own switcher included, so
 * without this a person with a working workspace elsewhere has no way to reach
 * it.
 */
export type WorkspaceSwitch = {
  workspaces: readonly WorkspaceSummary[]
  onSelect(workspace: WorkspaceSummary): void
}

export function hasWorkspaceToSwitchTo(
  current: WorkspaceSummary,
  workspaceSwitch: WorkspaceSwitch | undefined,
): workspaceSwitch is WorkspaceSwitch {
  return workspaceSwitch?.workspaces.some(candidate => candidate.id !== current.id) ?? false
}

/** Account navigation remains available outside the workspace shell. */
export function WorkspaceSwitchMenu({
  current,
  workspaceSwitch,
  className,
  compact = false,
}: {
  current?: WorkspaceSummary
  workspaceSwitch: WorkspaceSwitch
  className?: string
  compact?: boolean
}) {
  const t = useTranslations('duetApp')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('switchWorkspace')}
          className={cn(
            className ?? buttonVariants({ variant: 'outline' }),
            'inline-flex items-center gap-1',
          )}
        >
          {compact ? <ArrowsLeftRight aria-hidden size={17} /> : null}
          <span className={compact ? 'hidden sm:inline' : undefined}>{t('switchWorkspace')}</span>
          <CaretUp aria-hidden size={12} className={compact ? 'hidden sm:block' : undefined} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top" className="max-w-72">
        <WorkspaceMenuItems
          current={current}
          workspaces={workspaceSwitch.workspaces}
          onSelect={workspaceSwitch.onSelect}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
