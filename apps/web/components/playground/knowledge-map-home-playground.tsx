'use client'

/* The home surface as it ships: full-bleed map, real projection, an agent
   unfolded on it, plus the states you cannot reach on a busy drive. The
   controls are `sr-only` so the screenshot is the surface, not a toolbar above
   it.

   The `empty` variant is a brand-new workspace, and it is a map: Duet is the centre
   rather than a ring member, so a roster of nobody still draws the core, the
   face on it, and the add slot asking for the first agent.

   The `zoomed` variant is the composition that matters most and is the hardest
   to get right: the panel has to be centred and whole in whatever shape the map
   was given, from a wide desktop down to a phone. */
import { NextIntlClientProvider } from 'next-intl'
import { useCallback, useMemo, useRef, useState } from 'react'
import { MemoryRouter } from 'react-router'

import appEn from '../../messages/en/app.json'
import { projectWorkspaceMap } from '../../spa/knowledge-map-data/project'
import type { KnowledgeMapZoom } from '../../spa/knowledge-map/knowledge-map'
import { AgentPage } from '../../spa/routes/agents-map/agent-page'
import { AgentPageSkeleton } from '../../spa/routes/agents-map/agent-page-skeleton'
import { AgentSurface, type AgentSurfaceShowing } from '../../spa/routes/agents-map/agent-surface'
import { useHeaderRow } from '../../spa/routes/agents-map/agent-surface/use-header-row'
import { KnowledgeMapHome } from '../../spa/routes/agents-map/knowledge-map-home'
import { FixtureApp, FixtureChat } from './agent-surface-busy-fixture'
import { SURFACE_FILES, SURFACE_SKILLS } from './agent-surface-fixture'
import { FIXTURE_APP_ICONS } from './knowledge-map-fixture'
import {
  FIXTURE_NOW,
  HOME_FIXTURE_COPY,
  HOME_FIXTURE_CORE,
  HOME_FIXTURE_SLICES,
} from './knowledge-map-home-fixture'

/* `zoomed` and `skeleton` are the *other* route: an agent is its own page and
   no map is mounted under it, so those two draw `AgentPage` alone and the rest
   draw `KnowledgeMapHome` alone. This fixture used to stack both at once, which
   is a composition the product has never had. */
type HomeState = 'ready' | 'loading' | 'error' | 'empty' | 'zoomed' | 'skeleton'

export function KnowledgeMapHomePlayground({ state = 'ready' }: { state?: HomeState } = {}) {
  const [current, setCurrent] = useState<HomeState>(state)
  const [showing, setShowing] = useState<AgentSurfaceShowing | null>(null)
  const host = useRef<HTMLDivElement | null>(null)

  const projected = useMemo(
    () =>
      projectWorkspaceMap(
        HOME_FIXTURE_CORE,
        HOME_FIXTURE_SLICES,
        FIXTURE_NOW,
        HOME_FIXTURE_COPY,
        FIXTURE_APP_ICONS,
      ),
    [],
  )
  const empty = useMemo(
    () =>
      projectWorkspaceMap(
        { name: 'Acme Studio', meta: 'No agents · no apps', apps: [], jobs: [] },
        [],
        FIXTURE_NOW,
        HOME_FIXTURE_COPY,
        FIXTURE_APP_ICONS,
      ),
    [],
  )

  const markFrameReady = useCallback(() => {
    if (host.current) host.current.dataset.playgroundFrameReady = 'true'
  }, [])

  /* Only the map tweens, so only the map has a frame to wait for; the flat
     states are ready the moment they mount. `empty` is a map like any other —
     a centre, the add slot, and the trunk between them — so it waits too, while
     `loading` is now the *shape* of a map rather than one: no camera, nothing
     to settle, and a screenshot that waited for a frame it will never get. */
  const settles = current !== 'error' && current !== 'loading'
  const agent = projected.data.agents[0]
  const zoom = useMemo<KnowledgeMapZoom | null>(
    () => (current === 'zoomed' && agent !== undefined ? { kind: 'agent', agent } : null),
    [agent, current],
  )

  /* What the pane resolves to with nothing picked, which is the whole of it now
     that the canvas has no picker on it: the agent's first app. */
  const shownApp = agent?.apps[0]

  /* The row the fixture hands the surface is the real one, arranged through the
     real hook — a fixture that passed a frozen list would show the strip but
     never the drag, and the drag is the part worth looking at. In-memory
     storage so the screenshot is the same every run. */
  const kept = useRef(new Map<string, string>())
  const storage = useMemo(
    () => ({
      getItem: (key: string) => kept.current.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.current.set(key, value),
    }),
    [],
  )
  const row = useHeaderRow(
    agent?.id ?? '',
    { appIds: agent?.apps.map(item => item.id) ?? [] },
    storage,
  )

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        <div
          ref={host}
          data-playground-wait-for-frame
          data-playground-frame-ready={settles ? undefined : 'true'}
          className="h-[100dvh] bg-background"
        >
          <nav aria-label="Home fixture controls" className="sr-only">
            {(['ready', 'zoomed', 'skeleton', 'loading', 'empty', 'error'] as const).map(option => (
              <button key={option} type="button" onClick={() => setCurrent(option)}>
                {option}
              </button>
            ))}
          </nav>
          {current === 'skeleton' ? (
            <AgentPage>
              <AgentPageSkeleton label="Loading agent" />
            </AgentPage>
          ) : current === 'zoomed' && zoom !== null && zoom.kind === 'agent' ? (
            <AgentPage>
              <AgentSurface
                name={zoom.agent.name}
                subtitle={zoom.agent.subtitle}
                portrait={{ avatarKey: 'research' }}
                apps={{ phase: 'ready', items: zoom.agent.apps }}
                row={row.items}
                drag={{ onDrop: row.drop }}
                skills={{ phase: 'ready', items: SURFACE_SKILLS }}
                files={{ phase: 'ready', items: SURFACE_FILES }}
                showing={showing}
                onShow={setShowing}
                onOpenFile={() => {}}
                integrationsHref="/w/acme/integrations"
                trainHref={`/w/acme/agents/${zoom.agent.id}/train`}
                settingsHref={`/w/acme/agents/${zoom.agent.id}`}
                chat={<FixtureChat />}
                app={shownApp === undefined ? undefined : <FixtureApp title={shownApp.title} />}
              />
            </AgentPage>
          ) : (
            <KnowledgeMapHome
              data={current === 'empty' ? empty.data : projected.data}
              /* `zoomed` and `skeleton` never reach here — they are the other
                 route, drawn above — so what is left is the map's own three. */
              state={current === 'loading' ? 'loading' : current === 'error' ? 'error' : 'ready'}
              onZoom={next => setCurrent(next === null ? 'ready' : 'zoomed')}
              onOpen={() => {}}
              onAddAgent={() => {}}
              onRetry={() => {}}
              onSettled={settles ? markFrameReady : undefined}
            />
          )}
        </div>
      </MemoryRouter>
    </NextIntlClientProvider>
  )
}
