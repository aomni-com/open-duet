'use client'

/* The knowledge map on its own, with nothing above it but the panel a host
   would build. Zoomed in by default, because the thing worth arguing about is
   the whole gesture: the camera inside a face, the ring still travelling behind
   it, and a surface unfolded over the top.

   The map reports what you clicked; this fixture is the surface above it. */
import { NextIntlClientProvider } from 'next-intl'
import { useCallback, useRef, useState } from 'react'
import { MemoryRouter } from 'react-router'

import appEn from '../../messages/en/app.json'
import {
  KnowledgeMap,
  type KnowledgeMapOpen,
  type KnowledgeMapZoom,
} from '../../spa/knowledge-map/knowledge-map'
import { AgentPage } from '../../spa/routes/agents-map/agent-page'
import { AgentSurface, type AgentSurfaceShowing } from '../../spa/routes/agents-map/agent-surface'
import { orderedItems } from '../../spa/routes/agents-map/agent-surface/header-order'
import { SURFACE_FILES, SURFACE_SKILLS } from './agent-surface-fixture'
import { KNOWLEDGE_MAP_FIXTURE } from './knowledge-map-fixture'

export function KnowledgeMapPlayground({ zoomed = true }: { zoomed?: boolean } = {}) {
  const [last, setLast] = useState<KnowledgeMapOpen | null>(null)
  const [zoom, setZoom] = useState<KnowledgeMapZoom | null>(() =>
    zoomed ? { kind: 'agent', agent: KNOWLEDGE_MAP_FIXTURE.agents[0]! } : null,
  )
  const [showing, setShowing] = useState<AgentSurfaceShowing | null>(null)
  const host = useRef<HTMLDivElement | null>(null)

  /* The shell polls every `[data-playground-wait-for-frame]` element for its own
     `playgroundFrameReady` before it declares the page ready, so this has to
     land on the host element rather than on the body — otherwise the screenshot
     is taken halfway through the opening tween. */
  const markFrameReady = useCallback(() => {
    if (host.current) host.current.dataset.playgroundFrameReady = 'true'
  }, [])

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div ref={host} data-playground-wait-for-frame className="h-[42rem] min-w-0">
            <KnowledgeMap
              data={KNOWLEDGE_MAP_FIXTURE}
              zoom={zoom}
              onZoom={setZoom}
              onOpen={setLast}
              onSettled={markFrameReady}
            />
            <AgentPage>
              {zoom !== null && zoom.kind === 'agent' && (
                <AgentSurface
                  name={zoom.agent.name}
                  subtitle={zoom.agent.subtitle}
                  portrait={{ avatarKey: 'research' }}
                  apps={{ phase: 'ready', items: zoom.agent.apps }}
                  row={orderedItems({ appIds: zoom.agent.apps.map(item => item.id), saved: null })}
                  skills={{ phase: 'ready', items: SURFACE_SKILLS }}
                  files={{ phase: 'ready', items: SURFACE_FILES }}
                  showing={showing}
                  onShow={setShowing}
                  onOpenFile={() => {}}
                  chat={<p className="grid place-items-center text-xs">the conversation</p>}
                  app={
                    <p className="grid place-items-center bg-card p-4 text-xs text-muted-foreground">
                      the app
                    </p>
                  }
                />
              )}
            </AgentPage>
          </div>
          <aside className="rounded-lg border border-border bg-card p-4 text-sm">
            <h2 className="mb-2 font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
              Last opened
            </h2>
            {last === null || last.kind !== 'apps' ? (
              <p className="text-muted-foreground">
                Nothing yet. Click an app; a face opens the agent instead.
              </p>
            ) : (
              <dl className="grid gap-1">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Agent</dt>
                  <dd>{last.agent.name}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">App</dt>
                  <dd className="text-right">{last.app.title}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">State</dt>
                  <dd>{last.app.state}</dd>
                </div>
              </dl>
            )}
          </aside>
        </div>
      </MemoryRouter>
    </NextIntlClientProvider>
  )
}
