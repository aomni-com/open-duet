'use client'

import { CaretDown, CheckCircle, Gear, UserCircle } from '@phosphor-icons/react'
import { useState } from 'react'

import type { DriveTab } from '../../spa/drive/drive-routes'
import { DriveShell, DriveTabPanel, DriveTopBar } from '../../spa/drive/drive-shell'
import { buildWorkspaceTabs, type WorkspaceTabLabel } from '../../spa/drive/workspace-tabs'

const TAB_LABELS: Record<WorkspaceTabLabel, string> = {
  agents: 'Agents',
  files: 'Drive',
  desktop: 'Desktop',
  integrations: 'Integrations',
}
const tabs = buildWorkspaceTabs(destination => TAB_LABELS[destination])

export function DriveShellPlayground() {
  const [activeTab, setActiveTab] = useState<DriveTab>('agents')
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [utilityMenu, setUtilityMenu] = useState<'workspace' | 'account' | null>(null)

  return (
    <DriveShell
      topBar={
        <DriveTopBar
          tabs={tabs}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          label="Workspace sections"
          leftSlot={
            <div className="relative min-w-0">
              <button
                type="button"
                aria-expanded={workspaceOpen}
                onClick={() => setWorkspaceOpen(open => !open)}
                className="flex h-9 max-w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/45"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-[10px] font-bold text-background">
                  A
                </span>
                <span className="hidden truncate sm:inline">Acme Studio</span>
                <CaretDown aria-hidden className="hidden shrink-0 sm:block" size={14} />
              </button>
              {workspaceOpen ? (
                <div className="absolute left-0 top-11 z-40 w-56 rounded-xl border bg-popover p-2 text-sm shadow-xl">
                  <p className="px-2 py-1 text-xs text-muted-foreground">Current workspace</p>
                  <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted">
                    <CheckCircle aria-hidden size={16} /> Acme Studio
                  </button>
                </div>
              ) : null}
            </div>
          }
          rightSlot={
            <div className="relative flex items-center gap-1">
              <span className="hidden items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] text-muted-foreground md:inline-flex">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Online
              </span>
              <button
                type="button"
                aria-label="Workspace settings"
                aria-expanded={utilityMenu === 'workspace'}
                onClick={() =>
                  setUtilityMenu(current => (current === 'workspace' ? null : 'workspace'))
                }
                className="grid size-9 place-items-center rounded-lg text-foreground/70 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
              >
                <Gear aria-hidden size={18} />
              </button>
              <button
                type="button"
                aria-label="Walter account"
                aria-expanded={utilityMenu === 'account'}
                onClick={() =>
                  setUtilityMenu(current => (current === 'account' ? null : 'account'))
                }
                className="grid size-8 place-items-center rounded-full bg-muted text-foreground outline-none ring-1 ring-border focus-visible:ring-2 focus-visible:ring-ring/45"
              >
                <UserCircle aria-hidden size={20} />
              </button>
              {utilityMenu ? (
                <div className="absolute right-0 top-11 z-40 w-48 rounded-xl border bg-popover p-2 text-sm shadow-xl">
                  <p className="px-2 py-2 font-medium">
                    {utilityMenu === 'workspace' ? 'Acme Studio' : 'Walter'}
                  </p>
                  <button className="w-full rounded-lg px-2 py-2 text-left hover:bg-muted">
                    {utilityMenu === 'workspace' ? 'Workspace settings' : 'Account settings'}
                  </button>
                </div>
              ) : null}
            </div>
          }
        />
      }
    >
      {tabs.map(tab => (
        <DriveTabPanel key={tab.value} value={tab.value} activeTab={activeTab}>
          <div className="grid h-full place-items-center bg-muted/15 p-6">
            <div className="rounded-2xl border border-dashed bg-background px-8 py-6 text-center shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Controlled panel
              </p>
              <p className="mt-2 text-xl font-semibold">{tab.label}</p>
            </div>
          </div>
        </DriveTabPanel>
      ))}
    </DriveShell>
  )
}
