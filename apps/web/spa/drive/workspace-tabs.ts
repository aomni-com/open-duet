import { Desktop, HardDrive, Plug, Robot } from '@phosphor-icons/react'

import { type DriveTab, driveTabForPath } from './drive-routes'
import type { DriveTopBarTab } from './drive-shell'

export type WorkspaceTabLabel = 'agents' | 'files' | 'desktop' | 'integrations'

export const WORKSPACE_TAB_ICONS = {
  agents: Robot,
  files: HardDrive,
  desktop: Desktop,
  integrations: Plug,
} as const

/**
 * The workspace destinations the bar carries.
 *
 * Jobs was never one of them: it is not a place you go and stay, it is what an
 * agent is currently doing, and the agent's own surface says so beside the
 * agent whose work it is. What has changed is that the drive-wide *list* behind
 * it is gone entirely rather than merely unlisted. Two doorless addresses
 * remain — one session, one app — but neither is a section: each is the durable
 * name of a single record, reached by link rather than by bar.
 *
 * Desktop is hidden for now, not removed: the route and the per-agent desktop
 * pane both still exist, only the workspace-level button is withdrawn.
 */
export function buildWorkspaceTabs(
  label: (destination: WorkspaceTabLabel) => string,
): readonly DriveTopBarTab[] {
  return [
    { value: 'agents', label: label('agents'), icon: WORKSPACE_TAB_ICONS.agents },
    { value: 'files', label: label('files'), icon: WORKSPACE_TAB_ICONS.files },
    {
      value: 'integrations',
      label: label('integrations'),
      icon: WORKSPACE_TAB_ICONS.integrations,
    },
  ]
}

/**
 * Which bar tab a path lights, or `null` when the path is not one of them.
 *
 * `desktop` is the divergence this seam exists to absorb: the route still
 * answers, but the bar carries no button for it, so lighting it would point
 * the panel's `aria-labelledby` at an id no element carries and leave the
 * roving tabindex with no member to land on.
 */
export function workspaceTabForPath(path: string): DriveTab | null {
  const tab = driveTabForPath(path)
  return tab === 'desktop' ? null : tab
}
