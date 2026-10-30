import { describe, expect, test } from 'bun:test'

import { parentBrowserFilePath } from '../files/lib/paths'
import {
  agentSettingsUrl,
  agentsMapUrl,
  chatLandingOf,
  isMapPath,
  mapDestinationOf,
  mapPlaceOf,
  RESERVED_AGENT_SLUGS,
  type MapPlace,
} from './agents-map-url'

/* Every place, round-tripped. The grammar's whole promise is that a URL the
   builder produced parses back to the place it was built from — anything else
   means a link the product wrote is a link the product cannot read. */
const PLACES: readonly MapPlace[] = [
  { kind: 'graph' },
  { kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } },
  { kind: 'agent', agentSlug: 'ops', card: { kind: 'files-entry' } },
  {
    kind: 'agent',
    agentSlug: 'ops',
    card: { kind: 'files', path: '/agents/ops/uploads/release notes.pdf' },
  },
  { kind: 'agent', agentSlug: 'ops', card: { kind: 'desktop' } },
  { kind: 'agent', agentSlug: 'ops', card: { kind: 'app', appSlug: 'invoices' } },
  { kind: 'sessions', agentSlug: 'ops', sessionId: null },
  { kind: 'sessions', agentSlug: 'ops', sessionId: 's_42' },
  { kind: 'agent', agentSlug: 'root', card: { kind: 'default' } },
  { kind: 'sessions', agentSlug: 'root', sessionId: 's_42' },
]

describe('the map URL grammar', () => {
  test('round-trips every place through the builder and back', () => {
    for (const place of PLACES) {
      expect(mapPlaceOf(agentsMapUrl('acme', place), 'acme'), JSON.stringify(place)).toEqual(place)
    }
  })

  test('spells each place the way the map map says it does', () => {
    expect(agentsMapUrl('acme', { kind: 'graph' })).toBe('/w/acme/agents/graph')
    expect(
      agentsMapUrl('acme', { kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } }),
    ).toBe('/w/acme/agents/ops')
    expect(
      agentsMapUrl('acme', { kind: 'agent', agentSlug: 'ops', card: { kind: 'files-entry' } }),
    ).toBe('/w/acme/agents/ops/files')
    expect(
      agentsMapUrl('acme', {
        kind: 'agent',
        agentSlug: 'ops',
        card: { kind: 'files', path: '/agents/ops/uploads/release notes.pdf' },
      }),
    ).toBe('/w/acme/agents/ops/files/agents/ops/uploads/release%20notes.pdf')
    expect(
      agentsMapUrl('acme', { kind: 'agent', agentSlug: 'ops', card: { kind: 'desktop' } }),
    ).toBe('/w/acme/agents/ops/desktop')
    expect(
      agentsMapUrl('acme', {
        kind: 'agent',
        agentSlug: 'ops',
        card: { kind: 'app', appSlug: 'invoices' },
      }),
    ).toBe('/w/acme/agents/ops/apps/invoices')
    expect(agentsMapUrl('acme', { kind: 'sessions', agentSlug: 'ops', sessionId: null })).toBe(
      '/w/acme/agents/ops/sessions',
    )
    expect(agentsMapUrl('acme', { kind: 'sessions', agentSlug: 'ops', sessionId: 's_42' })).toBe(
      '/w/acme/agents/ops/sessions/s_42',
    )
  })

  test('reads the short agent Files URL as a redirect entry, never an implicit path', () => {
    expect(mapPlaceOf('/w/acme/agents/ops/files', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'ops',
      card: { kind: 'files-entry' },
    })
  })

  test('the root agent uses its short Files entry as the canonical Drive root', () => {
    const url = agentsMapUrl('acme', {
      kind: 'agent',
      agentSlug: 'root',
      card: { kind: 'files', path: '/' },
    })

    expect(url).toBe('/w/acme/agents/root/files')
    expect(mapPlaceOf(url, 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'root',
      card: { kind: 'files-entry' },
    })
  })

  test('walking upward writes resolved parent paths rather than traversal segments', () => {
    const parent = parentBrowserFilePath('/agents/ops/uploads')
    const grandparent = parentBrowserFilePath(parent)

    expect(
      agentsMapUrl('acme', {
        kind: 'agent',
        agentSlug: 'ops',
        card: { kind: 'files', path: parent },
      }),
    ).toBe('/w/acme/agents/ops/files/agents/ops')
    expect(
      agentsMapUrl('acme', {
        kind: 'agent',
        agentSlug: 'ops',
        card: { kind: 'files', path: grandparent },
      }),
    ).toBe('/w/acme/agents/ops/files/agents')
  })

  /* `?branch=` was the two-step's first half — the ring with the camera flown
     onto one agent's work. Work opens in one click now, so the query carries no
     meaning and an old link lands on whatever the bare path means: an unknown
     query is not a place, and the hard cutover means no redirect and no notice.
     What the bare path means has changed under these cases; the claim they make
     has not. */
  const ROOT = { kind: 'agent', agentSlug: 'root', card: { kind: 'default' } } as const

  test('a stale ?branch= link is just the bare path', () => {
    expect(mapPlaceOf('/w/acme/agents?branch=ops', 'acme')).toEqual(ROOT)
    expect(mapPlaceOf('/w/acme/agents?branch=ops&session=s_42', 'acme')).toEqual(ROOT)
  })

  test('a branch on an agent that cannot be named is just the bare path', () => {
    expect(mapPlaceOf('/w/acme/agents?branch=', 'acme')).toEqual(ROOT)
    // a session with no branch names no node — the bare path, not a half-read place
    expect(mapPlaceOf('/w/acme/agents?session=s_42', 'acme')).toEqual(ROOT)
  })

  /* An unfolded agent has put its whole branch away — the surface answers the
     same question bigger — so the two states are exclusive, and a URL carrying
     both is read as the unfolded one. */
  test('an unfolded agent ignores a branch left in the query', () => {
    expect(mapPlaceOf('/w/acme/agents/ops?branch=research', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'ops',
      card: { kind: 'default' },
    })
  })

  /* A slug arrives from a workspace name, an agent name or a job id, none of
     which this module chose. A name with a slash in it must land on the agent
     it names, not on a path of the parser's own invention. */
  test('encodes everything it interpolates, and decodes it back', () => {
    const place = {
      kind: 'sessions',
      agentSlug: 'brief writer',
      sessionId: 'session/../root',
    } as const
    const url = agentsMapUrl('acme space', place)
    expect(url).toBe('/w/acme%20space/agents/brief%20writer/sessions/session%2F..%2Froot')
    expect(mapPlaceOf(url, 'acme space')).toEqual(place)
  })

  test('reads a non-ASCII agent name as itself', () => {
    const place = { kind: 'agent', agentSlug: 'récherche', card: { kind: 'default' } } as const
    expect(mapPlaceOf(agentsMapUrl('acme', place), 'acme')).toEqual(place)
  })

  test('the drive is the map, addressed by the slug the contract already uses', () => {
    expect(mapPlaceOf('/w/acme/agents/root', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'root',
      card: { kind: 'default' },
    })
  })

  /* The catalog and the agent's own document sit under `/agents` and are not
     the canvas. Reporting a place for them is how the map's surface gets drawn
     over a page — the failure `driveCanvasPattern` exists to prevent. */
  test('is not the map at all for the destinations that share its prefix', () => {
    const notTheMap = [
      '/w/acme/agents/marketplace',
      '/w/acme/agents/marketplace/acme-labs/research',
      '/w/acme/agents/ops/settings',
      '/w/acme/agents/ops/train',
      '/w/acme/agents/ops/train/brief-format',
      '/w/acme/sessions',
      '/w/acme/sessions/session_1',
      '/w/acme/files',
      '/w/acme/train/agents/ops',
      '/w/acme/settings/general',
      '/settings',
      '/',
    ]
    for (const path of notTheMap) expect(mapPlaceOf(path, 'acme'), path).toBeNull()
  })

  test('is not the map when the workspace is somebody else’s', () => {
    expect(mapPlaceOf('/w/other/agents/ops', 'acme')).toBeNull()
    expect(mapPlaceOf('/w/other/agents', 'acme')).toBeNull()
  })

  /* The shell sizes the window before the route has resolved a workspace, so it
     asks the shape question alone. It must answer the same way for a path this
     viewer cannot open as for one they can — the canvas is a canvas either way,
     and disagreeing is how a destination renders with a bar on top of it. */
  test('answers the shape question without asking whose workspace it is', () => {
    expect(isMapPath('/w/other/agents/ops')).toBe(true)
    expect(mapPlaceOf('/w/other/agents/ops', 'acme')).toBeNull()

    expect(isMapPath('/w/acme/agents')).toBe(true)
    expect(isMapPath('/w/acme/agents/ops/sessions/s_42')).toBe(true)
    expect(isMapPath('/w/acme/agents/ops/settings')).toBe(false)
    expect(isMapPath('/w/acme/agents/marketplace')).toBe(false)
    expect(isMapPath('/w/acme/files')).toBe(false)
  })

  test('reads a trailing slash and an unrelated query as the same place', () => {
    const bare = { kind: 'agent', agentSlug: 'root', card: { kind: 'default' } } as const
    expect(mapPlaceOf('/w/acme/agents/', 'acme')).toEqual(bare)
    expect(mapPlaceOf('/w/acme/agents?shareRequest=share_1', 'acme')).toEqual(bare)
    expect(mapPlaceOf('/w/acme/agents/ops/', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'ops',
      card: { kind: 'default' },
    })
    expect(mapPlaceOf('/w/acme/agents#top', 'acme')).toEqual(bare)
  })

  /* Nothing on this surface is a lens, so a query changes no place — it is
     dropped, not read. A share landing on the bare path still lands there. */
  test('a query never changes which place a path names', () => {
    expect(mapPlaceOf('/w/acme/agents?view=gallery', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'root',
      card: { kind: 'default' },
    })
    expect(mapPlaceOf('/w/acme/agents/ops?anything=1', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'ops',
      card: { kind: 'default' },
    })
  })

  test('degrades a malformed escape to no place rather than to the wrong one', () => {
    expect(mapPlaceOf('/w/acme/agents/%GG', 'acme')).toBeNull()
    expect(mapPlaceOf('/w/%GG/agents', 'acme')).toBeNull()
  })

  /* An agent whose slug is a word the grammar spends is an agent the grammar
     can never address. The set is the rule, greppable, so a fifth destination
     under `/agents` cannot ship without joining it. */
  /* What reserving a word actually buys, stated precisely — because `graph` is
     the first word that is BOTH reserved and a place, and the looser claim this
     case used to make ("a reserved word is not a place") would have had to be
     weakened to let it through. Sharpened instead: a reserved word can never be
     read as an AGENT. That is the thing the set exists to guarantee, and it
     holds for every member including the one that is a place in its own right. */
  test('no reserved word can ever be read as an agent', () => {
    expect(RESERVED_AGENT_SLUGS.has('marketplace')).toBe(true)
    for (const slug of RESERVED_AGENT_SLUGS) {
      // an agent-shaped tail is the shape that would name one
      expect(mapPlaceOf(`/w/acme/agents/${slug}/files`, 'acme'), slug).toBeNull()
      expect(mapPlaceOf(`/w/acme/agents/${slug}/settings`, 'acme'), slug).toBeNull()
    }
  })

  /* And the ones this grammar does not own stay unreadable bare, because they
     belong to other routes: the catalog and the workspace desktop. */
  test('a reserved word owned by another route is not a place here', () => {
    expect(mapPlaceOf('/w/acme/agents/marketplace', 'acme')).toBeNull()
    expect(mapPlaceOf('/w/acme/agents/desktop', 'acme')).toBeNull()
  })

  test('sends an agent’s own document beside the agent, not under the machine', () => {
    expect(agentSettingsUrl('acme space', 'brief writer')).toBe(
      '/w/acme%20space/agents/brief%20writer/settings',
    )
  })
})

/* ============================================================================
   Whose address `…/sessions/:sessionId` actually is.

   The dialog withholds the owner's own chat from all four of its lists, so a
   URL naming that conversation is a correct link with the wrong address — and
   the commonest one in the product, because a session's lineage badge names the
   parent it was spawned from and that parent is usually the chat. Answered with
   the place that holds it rather than with a refusal.
   ========================================================================= */
test('a URL naming the owner’s own chat is answered by the panel that holds it', () => {
  expect(
    chatLandingOf({ kind: 'sessions', agentSlug: 'ops', sessionId: 's_chat' }, 's_chat'),
  ).toEqual({ kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } })
})

test('a URL naming ordinary work is left exactly where it is', () => {
  expect(
    chatLandingOf({ kind: 'sessions', agentSlug: 'ops', sessionId: 's_42' }, 's_chat'),
  ).toBeNull()
})

/* Nobody has answered for the pointer yet — or this owner has no chat at all,
   which is the same shape. Rewriting on an unanswered pointer would send every
   deep link to the panel for as long as the alias read takes. */
test('an owner with no answered pointer rewrites nothing', () => {
  expect(
    chatLandingOf({ kind: 'sessions', agentSlug: 'ops', sessionId: 's_42' }, undefined),
  ).toBeNull()
})

/* A bare `…/sessions` means the list itself; the effect that opens the latest
   job owns where that lands, and two rules answering one address is how a
   reader ends up somewhere neither of them chose. */
test('a bare sessions address is not this rule’s business', () => {
  expect(
    chatLandingOf({ kind: 'sessions', agentSlug: 'ops', sessionId: null }, 's_chat'),
  ).toBeNull()
})

/* Every other place on the map names no session at all. */
test('a place that is not a session address is left alone', () => {
  expect(
    chatLandingOf({ kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } }, 's_chat'),
  ).toBeNull()
})

/* ============================================================================
   A session's address survives Build losing its surface for one.

   `new` used to be reserved here for the jobs dialog's composer; both the
   composer and the dialog are gone, and `new` is an ordinary segment again —
   which is safe because drive ids are generated and a reader cannot mint one
   called `new`.

   The shape itself stays, because Work builds its own conversation URL through
   this grammar (`workSessionUrl` appends `?mode=work` to exactly this path) and
   `chatLandingOf` still has to recognise an owner's own chat arriving at it. */
test('a session address is still read and still built', () => {
  expect(mapPlaceOf('/w/acme/agents/ops/sessions', 'acme')).toEqual({
    kind: 'sessions',
    agentSlug: 'ops',
    sessionId: null,
  })
  expect(mapPlaceOf('/w/acme/agents/ops/sessions/s_42', 'acme')).toEqual({
    kind: 'sessions',
    agentSlug: 'ops',
    sessionId: 's_42',
  })
})

/* ---------------------------------------------------------------- the graph
   The drive's picture of itself stops being what `/agents` means and becomes a
   place of its own. Both halves are asserted together because they are one
   change: the segment has to exist before the bare path can mean anything else. */
describe('the graph is a place, and /agents is the root agent', () => {
  test('the graph has an address of its own', () => {
    expect(agentsMapUrl('acme', { kind: 'graph' })).toBe('/w/acme/agents/graph')
    expect(mapPlaceOf('/w/acme/agents/graph', 'acme')).toEqual({ kind: 'graph' })
  })

  test('bare /agents is the root agent, not the picture', () => {
    expect(mapPlaceOf('/w/acme/agents', 'acme')).toEqual({
      kind: 'agent',
      agentSlug: 'root',
      card: { kind: 'default' },
    })
  })

  /* Reserved as well as answered, and those are two different jobs. Answered is
     what makes the shell, the tab and the skeleton recognise it; reserved is
     what stops an agent taking a word no URL could then address. */
  test('no agent can be called graph', () => {
    expect(RESERVED_AGENT_SLUGS.has('graph')).toBe(true)
    expect(mapPlaceOf('/w/acme/agents/graph/files', 'acme')).toBeNull()
  })

  /* The cold-landing skeleton asks this, and it decides between a whole drive's
     worth of ring resolving into a page with no ring on it, and the page the
     reader is actually going to. */
  test('the skeleton is told which of the two a path is', () => {
    expect(mapDestinationOf('/w/acme/agents/graph')).toBe('graph')
    expect(mapDestinationOf('/w/acme/agents')).toBe('agent')
    expect(mapDestinationOf('/w/acme/agents/ops')).toBe('agent')
  })
})
