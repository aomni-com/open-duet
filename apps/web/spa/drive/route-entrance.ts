import { workPresentationForPath } from '../team-space/work-destination'
import { mapPlaceOf } from './agents-map-url'
import type { DriveTab } from './drive-routes'

/**
 * The part of the workspace canvas that is actually being replaced.
 *
 * Work and Build share one authenticated shell, but their URLs carry different
 * subjects. Work destinations are explicit content panes, while Build keeps a
 * long-lived agents section whose card tail changes without becoming a new
 * page. Keeping this projection pure lets the transition layer animate real
 * destination changes without keying persistent navigation or fragmenting one
 * logical destination because a query parameter or nested selector changed.
 */
export function workspaceRouteTransitionKey(
  pathname: string,
  search: string,
  workspaceSlug: string,
  activeTab: DriveTab | null,
): string {
  const work = workPresentationForPath(pathname, workspaceSlug, search)
  if (work.kind === 'home') return 'work-home'
  if (work.kind === 'session') return `work-session:${work.sessionId}`
  if (work.kind === 'app') return `work-app:${work.appSlug}`
  return routeEntranceKey(pathname, workspaceSlug, activeTab)
}

/** The stable subject inside Build's persistent navigation. */
export function routeEntranceKey(
  path: string,
  workspaceSlug: string,
  activeTab: DriveTab | null,
): string {
  /* Drive folders share one subject; settings surfaces remain distinct. */
  if (mapPlaceOf(path, workspaceSlug) === null) return activeTab ?? path
  /* Graph and agent-card URLs replace the centre without replacing the roster. */
  return 'agents-section'
}
