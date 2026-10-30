'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/* One agent unfolded on the workspace it lives on, full bleed, on both of them.

   The point of the fixture is the *composition*, so it is the real home surface
   at the size the product runs at rather than a panel in a box: the camera
   flies, the ring dims behind the glass, and the surface has to hold the agent
   whole on every desktop shape. The other agent fixture next door is the
   states — pending, failed, empty; this one is the picture.

   Two workspaces and not one, because the composition has two failure modes and
   they are opposites. Busy is where a row of app selectors runs out of room and
   the agent's name runs out of room beside its face. Quiet — one agent, one app, nothing in
   flight — is where the same row is three words wide with a hand's width of
   empty header beside them, and it is this product's own workspace, so it is
   the one that has to be right first.

   `jobsOpen` is the third thing it can be asked for: the jobs dialog, open over
   all of it, with a real `AgentJobsDialog` in a real portal rather than a panel
   drawn to look like one. That is the only way the overlay, the radius, the
   width and the state hues crossing the portal are screenshotted for real. */
import { NextIntlClientProvider } from 'next-intl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MemoryRouter } from 'react-router'

import type { App } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { AppFrameBody, AppFramePlaceholder, AppFrameSourceProvider } from '../../spa/apps/app-frame'
import { SpaContext, type SpaContextValue } from '../../spa/context'
import { projectWorkspaceMap, toDuet } from '../../spa/knowledge-map-data/project'
import type { KnowledgeMapZoom } from '../../spa/knowledge-map/knowledge-map'
import { AgentPage } from '../../spa/routes/agents-map/agent-page'
import { AgentSurface, type AgentSurfaceShowing } from '../../spa/routes/agents-map/agent-surface'
import { SetupStage } from '../../spa/routes/agents-map/agent-surface/parts'
import { useHeaderRow } from '../../spa/routes/agents-map/agent-surface/use-header-row'
import { ArchiveDefaultChatButton } from '../../spa/sessions/archive-default-chat-control'
import {
  DRIVE_UNCLAIMED_JOBS,
  FixtureApp,
  FixtureChat,
  FixtureSession,
  ONBOARDING_FIXTURE_MESSAGES,
  BUSY_FIXTURE_COPY,
  BUSY_FIXTURE_CORE,
  BUSY_FIXTURE_NOW,
  BUSY_FIXTURE_SLICES,
  QUIET_FIXTURE_CORE,
  QUIET_FIXTURE_SLICES,
} from './agent-surface-busy-fixture'
import { SURFACE_FILES, SURFACE_SKILLS } from './agent-surface-fixture'
import { FIXTURE_APP_ICONS } from './knowledge-map-fixture'
import { APP_FIXTURES, fixtureAppFrameSource } from './spa-fixture'

export function AgentSurfaceDrivePlayground({
  drive = 'busy',
  showing: initial = null,
  centre = false,
  setup,
  frame = false,
}: {
  drive?: 'busy' | 'quiet'
  showing?: AgentSurfaceShowing | null
  /**
   * The agent has not been set up yet, so the surface is one column and the
   * setup is all of it — no conversation panel, no row of views, no jobs door.
   *
   * Worth captures because it is the composition, not a panel: the second
   * column is *withheld*, which is the kind of change that reads fine in a
   * unit test and wrong on a screen. Three shapes, matching the route's:
   *
   * - `cta`  — nothing to mount yet: `SetupStage` with the onboard control.
   * - `waiting` — the same stage after it is pressed, which on a cold workspace
   *   machine is where a reader spends a couple of minutes. Captured because
   *   the longest-lived state of this feature is the one nothing photographed.
   * - `chat` — the setup conversation itself, full surface (stood in by the
   *   chat fixture; the geometry under test is the one-column surface holding
   *   a full-height conversation, not the conversation's internals).
   * - `app`  — the onboarding app, full surface, through the REAL frame: an
   *   actual `<iframe>` on the onboarding-shaped fixture document. This is
   *   the exact composition that shipped clipped to prod with every gate
   *   green, because no capture mounted an iframe on the map surface.
   */
  setup?: 'cta' | 'waiting' | 'chat' | 'app'
  /**
   * Zoom the drive's own centre instead of an agent on the ring.
   *
   * Duet is the one surface in the product that nothing photographed. It has no
   * training folder and no settings page, so its action row was empty and the
   * stylesheet hid the row outright — and the door this feature adds is
   * therefore the first thing that row has ever held. A control appearing in a
   * band that used to be `display: none`, on a composition no fixture captures,
   * is exactly the change that lands wrong in silence.
   */
  centre?: boolean
  /**
   * Stage the real app frame — `AppFrameBody`, an actual `<iframe>` — instead
   * of the stand-in panel on the ordinary two-column card. The panel is a
   * `<div>`, so shots taken with it prove the card's layout and nothing about
   * the frame's: `[data-app-frame]` height, top-edge clipping, and scroll are
   * geometry only an iframe can exhibit.
   *
   * `'loading'` stages the same frame's first second — the shape drawn under a
   * frame that has not painted anything over it yet. Mounted directly rather
   * than reached by stalling a frame, because there is no hermetic way to hold
   * an iframe's `load` event open: a fixture that pointed at something slow
   * would be a fixture that photographs a race.
   */
  frame?: boolean | 'loading'
} = {}) {
  const [showing, setShowing] = useState<AgentSurfaceShowing | null>(initial)
  const host = useRef<HTMLDivElement | null>(null)
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  )
  /* An empty context is enough now. The audience manager this fixture used to
     stand up lived in the jobs dialog's session menu; that dialog is gone, and
     the audience surface is Work's — so the stubs that answered for it went
     with it rather than sitting here answering nobody. */
  const spa = useMemo(() => ({ api: {} }) as unknown as SpaContextValue, [])

  const projected = useMemo(
    () =>
      projectWorkspaceMap(
        drive === 'quiet' ? QUIET_FIXTURE_CORE : BUSY_FIXTURE_CORE,
        drive === 'quiet' ? QUIET_FIXTURE_SLICES : BUSY_FIXTURE_SLICES,
        BUSY_FIXTURE_NOW,
        BUSY_FIXTURE_COPY,
        FIXTURE_APP_ICONS,
      ),
    [drive],
  )
  const agent = projected.data.agents[0]
  /* Duet comes out of `toDuet`, the same projection the route uses, rather than
     out of a literal shaped to look like an agent — the whole point of that
     function is that one surface draws both, and a hand-made node here could
     drift from the thing being drawn. Its work is the drive's unclaimed jobs. */
  const duet = useMemo(
    () =>
      toDuet(
        { name: 'Duet', meta: '', apps: [], jobs: DRIVE_UNCLAIMED_JOBS },
        BUSY_FIXTURE_NOW,
        BUSY_FIXTURE_COPY,
        FIXTURE_APP_ICONS,
      ),
    [],
  )
  const focus = centre ? duet : agent
  const zoom = useMemo<KnowledgeMapZoom | null>(
    () => (centre ? { kind: 'core' } : agent === undefined ? null : { kind: 'agent', agent }),
    [agent, centre],
  )

  /* The route mounts the app the card resolved to; the fixture stands one in,
     so the composition under review is the one that ships. */
  const shown = showing?.kind === 'app' ? showing.app : focus?.apps[0]

  /* The real hook, against in-memory storage: a fixture holding a frozen list
     would show the strip and never the drag. */
  const kept = useRef(new Map<string, string>())
  const storage = useMemo(
    () => ({
      getItem: (key: string) => kept.current.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.current.set(key, value),
    }),
    [],
  )
  const row = useHeaderRow(
    focus?.id ?? '',
    { appIds: focus?.apps.map(item => item.id) ?? [] },
    storage,
  )

  /* The map used to say when it had settled its camera; a page has no camera to
     settle, so the frame is ready once it has laid out. */
  useEffect(() => {
    if (host.current) host.current.dataset.playgroundFrameReady = 'true'
  })

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <SpaContext.Provider value={spa}>
          <MemoryRouter>
            {/* The frame source is provided unconditionally: harmless for the
            panel fixtures, and the frame captures must never fall back to the
            real launch-grant URL. */}
            <AppFrameSourceProvider source={fixtureAppFrameSource}>
              <div ref={host} data-playground-wait-for-frame className="h-[100dvh] bg-background">
                {/* The page, not the map. This fixture is about one agent unfolded,
                and an unfolded agent is its own route now — mounting it as the
                map's child would be photographing a composition the product
                stopped drawing. */}
                <AgentPage>
                  {zoom !== null && focus !== undefined && (
                    <AgentSurface
                      name={focus.name}
                      subtitle={focus.subtitle}
                      portrait={{ avatarKey: 'analyst' }}
                      duet={centre}
                      apps={{ phase: 'ready', items: focus.apps }}
                      row={row.items}
                      drag={{ onDrop: row.drop }}
                      skills={{ phase: 'ready', items: SURFACE_SKILLS }}
                      files={{ phase: 'ready', items: SURFACE_FILES }}
                      showing={showing}
                      onShow={setShowing}
                      onOpenFile={() => {}}
                      /* Withheld under a lock for the same reason, and drawn for
                     the drive's own centre as well as a face — the root is an
                     owner like any agent and its chat demotes the same way. */
                      {...(setup !== undefined
                        ? {}
                        : {
                            chatAction: (
                              <ArchiveDefaultChatButton disabled={false} onClick={() => {}} />
                            ),
                          })}
                      integrationsHref="/w/acme/integrations"
                      {...(centre
                        ? {}
                        : {
                            trainHref: '/w/acme/agents/analyst/train',
                            settingsHref: '/w/acme/agents/analyst',
                          })}
                      {...(setup === undefined
                        ? {}
                        : {
                            setup: {
                              /* The header is the agent's own cluster, dressed by
                             the surface from this state — so a fixture that
                             passed only a body would be photographing a locked
                             surface with its working header on. */
                              state: setup === 'cta' ? ('ready' as const) : setup,
                              body:
                                setup === 'chat' ? (
                                  /* The product's own timeline and compose bar, not
                                 the stand-in the column next door uses: here the
                                 conversation IS the subject — the claim under
                                 review is that a setup chat is an ordinary
                                 session — and a lookalike composer would be a
                                 shot of a claim nobody made. */
                                  <div className="km-setup-chat">
                                    <FixtureSession
                                      title="Onboarding"
                                      messages={ONBOARDING_FIXTURE_MESSAGES}
                                    />
                                  </div>
                                ) : setup === 'app' ? (
                                  <AppFrameBody
                                    app={frameApp('Connect Search Console')}
                                    workspaceSlug="acme"
                                  />
                                ) : (
                                  <SetupStage
                                    waiting={setup === 'waiting'}
                                    action={
                                      <button
                                        type="button"
                                        className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-brand-foreground"
                                      >
                                        {appEn.duetApp.agentRoster.onboardAgent}
                                      </button>
                                    }
                                  />
                                ),
                            },
                          })}
                      chat={<FixtureChat />}
                      app={
                        shown === undefined ? undefined : frame === 'loading' ? (
                          <AppFramePlaceholder name={shown.title} />
                        ) : frame ? (
                          <AppFrameBody app={frameApp(shown.title)} workspaceSlug="acme" />
                        ) : (
                          <FixtureApp title={shown.title} />
                        )
                      }
                    />
                  )}
                </AgentPage>
              </div>
            </AppFrameSourceProvider>
          </MemoryRouter>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  )
}

/* A reconciled app row for the frame to mount — the fixture list's first app,
   renamed so the picker chip and the frame's title agree. */
function frameApp(title: string): App {
  return { ...APP_FIXTURES[0]!, name: title, runtimeStatus: 'reconciled' }
}
