'use client'

import { Check } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import type { WorkspaceSummary } from '@repo/contract'
import { DropdownMenuItem } from '@repo/ui/components/shadcn/dropdown-menu'

/**
 * One row per workspace the viewer can open, the current one checked. Renders
 * inside a `DropdownMenuContent`; the host owns the trigger and anything after
 * the rows. A workspace whose servicing is paused says so, because the reason
 * to switch is often to leave one that cannot run for one that can.
 */
export function WorkspaceMenuItems({
  current,
  workspaces,
  onSelect,
}: {
  current?: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
  onSelect(workspace: WorkspaceSummary): void
}) {
  const t = useTranslations('duetApp')
  return workspaces.map(candidate => (
    <DropdownMenuItem key={candidate.id} onSelect={() => onSelect(candidate)}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{candidate.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {candidate.slug}
          {candidate.servicingStatus === 'paused' ? ` · ${t('workspaceAsleep')}` : null}
        </span>
      </span>
      {candidate.id === current?.id ? <Check size={15} /> : null}
    </DropdownMenuItem>
  ))
}
