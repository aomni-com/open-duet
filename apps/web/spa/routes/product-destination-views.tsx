import { Brain, Gear, SealCheck, TerminalWindow, UserCircle } from '@phosphor-icons/react'
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

import { WORKSPACE_TAB_ICONS } from '../drive/workspace-tabs'
import type { ProductDestinationId } from './product-destinations'

type DestinationView = {
  icon: typeof WORKSPACE_TAB_ICONS.agents
  component: LazyExoticComponent<ComponentType>
}

const loadAgentsMap = () => import('./agents-map')
const loadAgentRoute = () => import('./agent-route')

/**
 * Fetch the two agent-surface chunks ahead of any navigation. Flying between
 * the ring and an agent is the product's ordinary gesture, and the first hop
 * used to pay a Suspense skeleton for a chunk that was always going to be
 * needed. Same import thunks the lazy components resolve through, so the
 * module registry is shared and `lazy` finds its chunk already there.
 *
 * Best-effort: a chunk that cannot load right now (offline, a deploy swapped
 * the assets) is swallowed here — lazy navigation stays the owner of load
 * errors, at the moment somebody actually goes there.
 */
export function warmAgentDestinationChunks(): void {
  void loadAgentsMap().catch(() => undefined)
  void loadAgentRoute().catch(() => undefined)
}

export const PRODUCT_DESTINATION_VIEWS: Record<ProductDestinationId, DestinationView> = {
  workHome: {
    icon: WORKSPACE_TAB_ICONS.agents,
    component: lazy(() => import('../team-space/work-home')),
  },
  agentsGraph: {
    icon: WORKSPACE_TAB_ICONS.agents,
    component: lazy(loadAgentsMap),
  },
  /* Its own module, and the split is the point rather than tidiness: these two
     used to be one component that decided which of them it was at the bottom of
     six hundred lines, so the agent's page carried the map's chunk and could
     render it outright while its slug was still resolving. */
  agentPage: {
    icon: WORKSPACE_TAB_ICONS.agents,
    component: lazy(loadAgentRoute),
  },
  sessions: {
    icon: WORKSPACE_TAB_ICONS.agents,
    component: lazy(() => import('./session-redirect')),
  },
  agentDetail: { icon: WORKSPACE_TAB_ICONS.agents, component: lazy(() => import('./agents')) },
  agentTrain: { icon: Brain, component: lazy(() => import('./agent-train')) },
  marketplace: { icon: SealCheck, component: lazy(() => import('./marketplace')) },
  files: { icon: WORKSPACE_TAB_ICONS.files, component: lazy(() => import('./files')) },
  desktop: { icon: WORKSPACE_TAB_ICONS.desktop, component: lazy(() => import('./desktop')) },
  train: { icon: Brain, component: lazy(() => import('./train')) },
  integrations: {
    icon: WORKSPACE_TAB_ICONS.integrations,
    component: lazy(() => import('./integrations')),
  },
  workspaceSettings: { icon: Gear, component: lazy(() => import('./workspace-settings')) },
  userSettings: { icon: UserCircle, component: lazy(() => import('./user-settings')) },
  internalAdmin: { icon: TerminalWindow, component: lazy(() => import('./internal-admin')) },
}
