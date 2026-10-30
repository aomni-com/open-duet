import {
  bucketOf,
  type ActivitySessionSummary,
  type Agent,
  type App,
  type Machine,
} from '@repo/contract'

import type {
  AgentSlice,
  CoreFacts,
  MapCopy,
  MapIcons,
} from '../../../spa/knowledge-map-data/project'
import { projectWorkspaceMap } from '../../../spa/knowledge-map-data/project'
import type { TeamWorkspace } from './team-space-fixture'

/* ============================================================================
   The same workspace, as the map's wire sees it.

   Build mode does not draw a picture of this fixture — it mounts the product's
   own `KnowledgeMapHome` and feeds it through `projectWorkspaceMap`, the same
   projection the route uses. So this file is an adapter and nothing else: it
   turns the workspace the work surface reads into the `Agent` / `App` /
   `ActivitySessionSummary` records the wire carries.

   Writing it this way is the point rather than an inconvenience. A hand-drawn
   lookalike map would agree with the work surface for exactly as long as
   somebody kept the two in step; going through the real projection means the
   faces, the fan of apps, the jobs on the ring and the counts under the centre
   are all derived from the one fixture, and a change to it moves both modes.
   ========================================================================= */

/* Fixed so a screenshot says the same thing every run — the map prints a
   relative caption against this for every job it draws. */
const NOW = Date.parse('2026-08-25T13:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* The product hands the projection a locale-aware formatter; a fixture hands it
   a frozen one. */
const COPY: MapCopy = {
  when: (at, now) => {
    const minutes = Math.max(1, Math.round((now - at) / MINUTE))
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    return `${days} day${days === 1 ? '' : 's'} ago`
  },
}

/* An app's artwork is a file in the workspace, so only something holding an API
   client could serve it. The fixture carries the bytes inline instead, which is
   the same answer the map's own fixture gives and for the same reason. */
const ICONS: MapIcons = { app: app => app.icon, agent: () => undefined }

function toAgent(workspace: TeamWorkspace, slug: string, name: string): Agent {
  return {
    id: slug,
    workspaceId: workspace.id,
    anchorId: `anchor-${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name,
    createdAt: NOW - 90 * DAY,
    updatedAt: NOW - DAY,
  }
}

function toApp(workspace: TeamWorkspace, id: string, name: string, icon: string, ago: number): App {
  return {
    id: `app-${id}`,
    workspaceId: workspace.id,
    anchorId: `anchor-app-${id}`,
    anchorPath: `apps/${id}`,
    anchorState: 'active',
    slug: id,
    name,
    icon,
    runtimeStatus: 'reconciled',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - ago,
  } as App
}

/* The map's own vocabulary for what a session is doing is `turnStatus`, and the
   bucket comes off `bucketOf` rather than being decided a second time here —
   the contract's note on that column is explicit that a second derivation is a
   second definition of the product's central concept. */
const TURN_STATUS = {
  asking: 'ask',
  running: 'running',
  scheduled: 'complete',
  done: 'complete',
} as const satisfies Record<string, 'ask' | 'complete' | 'interrupted' | 'running' | 'sleep'>

function toJob(
  id: string,
  title: string,
  state: keyof typeof TURN_STATUS,
  ago: number,
  unread: boolean,
): ActivitySessionSummary {
  const turnStatus = TURN_STATUS[state]
  const machine: Machine | undefined =
    state === 'scheduled'
      ? {
          orderedPath: [],
          activity: 'waiting',
          currentState: 'waiting',
          nextWakeAt: NOW + 4 * HOUR,
        }
      : undefined
  return {
    id,
    bucket: bucketOf({ turnStatus, ...(machine === undefined ? {} : { machine }) }),
    title,
    updatedAt: NOW - ago,
    unread,
    ...(machine === undefined ? {} : { machine }),
  }
}

/** Roughly how long ago, from the row's own short caption. Good enough for a map. */
function agoOf(note: string): number {
  const minutes = /(\d+)\s*min/.exec(note)
  if (minutes !== null) return Number(minutes[1]) * MINUTE
  const hours = /(\d+)\s*hr/.exec(note)
  if (hours !== null) return Number(hours[1]) * HOUR
  return /yesterday/i.test(note) ? DAY : 3 * HOUR
}

/**
 * The workspace as a map.
 *
 * Duet is never on the ring: it is the workspace root, a presentation identity
 * rather than an agent row, so what it owns here is what no agent claimed —
 * which on this fixture is the chats nobody handed off and the apps that belong
 * to no single agent.
 */
export function projectWorkspace(workspace: TeamWorkspace) {
  const ring = workspace.agents.filter(agent => agent.orchestrator !== true)

  const slices: readonly AgentSlice[] = ring.map(agent => ({
    agent: toAgent(workspace, agent.slug, agent.name),
    apps: workspace.apps
      .filter(app => app.ownerAgentId === agent.id)
      .map(app => toApp(workspace, app.id, app.name, app.art, 3 * HOUR)),
    jobs: workspace.jobs
      .filter(job => job.agentId === agent.id)
      .map(job => toJob(job.id, job.title, job.state, agoOf(job.note), job.unread === true)),
  }))

  const core: CoreFacts = {
    name: workspace.name,
    meta: `${ring.length} agents · ${workspace.apps.length} apps`,
    apps: workspace.apps
      .filter(app => !ring.some(agent => agent.id === app.ownerAgentId))
      .map(app => toApp(workspace, app.id, app.name, app.art, DAY)),
    jobs: workspace.jobs
      .filter(job => job.agentId === 'duet')
      .map(job => toJob(job.id, job.title, job.state, agoOf(job.note), job.unread === true)),
  }

  return projectWorkspaceMap(core, slices, NOW, COPY, ICONS)
}
