'use client'

import { useCallback, useMemo, useRef } from 'react'

import type { KnowledgeMapZoom } from '../../../spa/knowledge-map/knowledge-map'
import { KnowledgeMapHome } from '../../../spa/routes/agents-map/knowledge-map-home'
import { TeamSpaceAgentSurface } from './team-space-agent-surface'
import { projectWorkspace } from './team-space-map'
import { useWorkspace } from './team-space-workspace'

/**
 * The other door's body.
 *
 * Build is not a second product and it is not a tab on this one: it is the
 * surface that already exists, mounted here so the two can be seen as one
 * workspace. Nothing below is a drawing of the map — this is the product's own
 * `KnowledgeMapHome` and `AgentSurface`, fed from the same fixture the work
 * surface reads, through the same projection the route uses.
 *
 * The column beside it does not belong to this component. Both modes keep the
 * same one, at the same width, with the same switch in it; what changes inside
 * it is the middle — chats in Work, agents here — because the two modes differ
 * in what you navigate *between*, not in how the app is shaped.
 */
export function TeamSpaceBuild({
  agentSlug,
  onOpenAgent,
}: {
  /** Absent on the canvas. */
  agentSlug?: string
  onOpenAgent: (slug: string | undefined) => void
}) {
  const workspace = useWorkspace()
  const host = useRef<HTMLDivElement | null>(null)

  const projected = useMemo(() => projectWorkspace(workspace), [workspace])
  /* The map is the product's and speaks in projected records; the unfolded
     agent is this fixture's own surface and speaks in the fixture's. The slug
     is what the two agree on. */
  const agent = projected.data.agents.find(candidate => candidate.id === agentSlug)
  const agentRecord = workspace.agents.find(candidate => candidate.slug === agentSlug)

  const markFrameReady = useCallback(() => {
    if (host.current) host.current.dataset.playgroundFrameReady = 'true'
  }, [])

  return (
    <div
      ref={host}
      data-playground-wait-for-frame
      /* Only the map tweens, so only the map has a frame to wait for; the agent
         surface is ready the moment it mounts. */
      data-playground-frame-ready={agent === undefined ? undefined : 'true'}
      className="min-h-0 flex-1"
    >
      {agentRecord !== undefined ? (
        /* No `AgentPage` around it. That frame exists to give the product's own
           `AgentSurface` the map's ground and its `.km-page` container query;
           this surface is not that component, and borrowing the frame only
           inset the whole thing by the container's padding — which is why the
           agent's column started nine pixels below the workspace column beside
           it. The hues it also supplied are already on the shell's root. */
        <TeamSpaceAgentSurface agent={agentRecord} />
      ) : (
        <KnowledgeMapHome
          data={projected.data}
          state="ready"
          onZoom={(next: KnowledgeMapZoom | null) =>
            onOpenAgent(next?.kind === 'agent' ? next.agent.id : undefined)
          }
          onOpen={() => {}}
          onAddAgent={() => {}}
          onRetry={() => {}}
          onSettled={markFrameReady}
        />
      )}
    </div>
  )
}
