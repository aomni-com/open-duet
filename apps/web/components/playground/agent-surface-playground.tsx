'use client'

/* One agent unfolded, in the states it can actually be in.

   Every body the card on the right can have, one per row: the app the agent
   opened on and its folder on the drive — the two the reader can pick — and then
   the three you cannot reach on a healthy drive, which is why this is where
   their design lives.

   A read that failed is the first of those, and it is the whole reason the
   surface takes a *phase* with every list: an empty array and a failed request
   hand over the same rows, and the card must never draw them the same way.

   An agent that reaches no apps is the second. Its row is one chip and the card
   still resolves somewhere — `defaultKeys` always emits the files key, so the
   row is never empty and there is no way to strand a reader with nothing to
   press. (That is also why `EmptyStage` is unreachable in production and is not
   drawn here: a fixture standing it up would be claiming a state the product
   cannot enter. See the spec's finding F9.)

   The third is not in the card at all: an agent on a drive without the sessions
   entitlement. Listing jobs needs that scope, so the door is not drawn rather
   than opening onto a dialog that would 403 — which makes "two doors" a shape
   this surface still has, and one nothing else photographs.

   The pickable two are here rather than in the drive fixture next door because
   of what they have to prove together: the row of selectors across the top of
   the card stays put and keeps saying which of them you are in, whatever the
   body underneath swapped to.

   One per row rather than two across. Side by side, each case was drawn into a
   left column two thirds narrower than the one the product gives it, which is a
   shape nothing on a desktop ever renders — and a fixture that reports a wrap
   the product never does is a fixture that argues for the wrong layout. */
import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'

import appEn from '../../messages/en/app.json'
import { AgentSurface, type AgentSurfaceShowing } from '../../spa/routes/agents-map/agent-surface'
import { orderedItems } from '../../spa/routes/agents-map/agent-surface/header-order'
import { ArchiveDefaultChatButton } from '../../spa/sessions/archive-default-chat-control'
import { SURFACE_FILES, SURFACE_SKILLS } from './agent-surface-fixture'
import { KNOWLEDGE_MAP_FIXTURE } from './knowledge-map-fixture'

const AGENT = KNOWLEDGE_MAP_FIXTURE.agents[0]!

/* The work in flight, which is all the surface itself reads now: the dot on the
   Jobs door is drawn from it, and the door's own dialog runs its own query.
   Every group the map's `active` view can hand over, so the dot is resolved
   against a list that has more than one state in it. */

export function AgentSurfacePlayground() {
  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        <div className="grid gap-4">
          <Case title="The app it opens on" showing={null} />
          <Case title="Its folder on the drive" showing={{ kind: 'files' }} />
          <Case title="A read that failed" showing={null} failed />
          <Case title="An agent that reaches no apps" showing={null} empty />
          <Case title="An agent behind the sessions wall" showing={null} walled />
          <Case title="While its first message is landing" showing={null} chatBusy />
        </div>
      </MemoryRouter>
    </NextIntlClientProvider>
  )
}

/* Inside the map's own box, because that is the only place this surface exists:
   it is glass over a canvas and it reads the map's variables. Rendered on a
   plain page it would be a panel with no colours and no reason for its own
   shape. */
function Case({
  title,
  showing: initial,
  failed = false,
  empty = false,
  walled = false,
  chatBusy = false,
}: {
  title: string
  showing: AgentSurfaceShowing | null
  failed?: boolean
  empty?: boolean
  /** no sessions entitlement, so no jobs door — see the header */
  walled?: boolean
  /**
   * A first message into this chat has not landed yet, so the one control over
   * the conversation is shut. The send ends by stamping the owner's pointer at
   * the session it mints, and archiving underneath it would clear a pointer
   * about to be written again.
   */
  chatBusy?: boolean
}) {
  const [showing, setShowing] = useState<AgentSurfaceShowing | null>(initial)
  const phase = failed ? ('error' as const) : ('ready' as const)
  const none = <T,>(items: readonly T[]): readonly T[] => (empty ? [] : items)
  const shown = showing?.kind === 'app' ? showing.app : empty ? undefined : AGENT.apps[0]
  return (
    <figure className="grid gap-2">
      <figcaption className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
        {title}
      </figcaption>
      <div className="knowledge-map h-[32rem] min-h-0 rounded-xl border border-border">
        <div className="km-page">
          <AgentSurface
            name={AGENT.name}
            subtitle={AGENT.subtitle}
            portrait={{ avatarKey: 'research' }}
            apps={{ phase, items: none(AGENT.apps) }}
            row={orderedItems({ appIds: none(AGENT.apps).map(item => item.id), saved: null })}
            skills={{ phase: failed ? 'pending' : 'ready', items: none(SURFACE_SKILLS) }}
            files={{ phase, items: none(SURFACE_FILES) }}
            showing={showing}
            onShow={setShowing}
            /* One nested colleague, so the shot carries the one-layer rule's
               other half: the ring hides the child, the parent's surface owns
               the door to it. */
            childAgents={[{ id: 'scout-helper', name: 'Scout Helper' }]}
            onOpenChildAgent={() => {}}
            onOpenFile={() => {}}
            trainHref="/w/acme/agents/research/train"
            settingsHref="/w/acme/agents/research"
            integrationsHref="/w/acme/integrations"
            chat={
              <p className="grid place-items-center p-4 text-xs text-muted-foreground">
                the conversation
              </p>
            }
            /* Withheld behind the sessions wall exactly as the jobs door is:
               there is no conversation to demote, so a control whose only
               outcome is a refusal says a second time what the column already
               says. The button is presentation only — the route owns the reads
               that decide whether it is drawn — so the fixture supplies it
               directly rather than standing up a query client. */
            {...(walled
              ? {}
              : {
                  chatAction: <ArchiveDefaultChatButton disabled={chatBusy} onClick={() => {}} />,
                })}
            app={
              shown === undefined ? undefined : (
                <p className="grid place-items-center bg-card p-4 text-xs text-muted-foreground">
                  {shown.title}
                </p>
              )
            }
            drive={
              <p className="grid place-items-center bg-card p-4 text-xs text-muted-foreground">
                the agent&rsquo;s folder
              </p>
            }
          />
        </div>
      </div>
    </figure>
  )
}
