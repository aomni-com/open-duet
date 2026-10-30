import { describe, expect, test } from 'bun:test'

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import type { AgentRoute } from '../../knowledge-map-data/project'
import type { Agent as MapAgent } from '../../knowledge-map/types'
import { focusOf, type MapProjection } from './where'

const agent = (id: string, name: string): MapAgent => ({
  id,
  name,
  avatarKey: id,
  apps: [],
  jobs: [],
})

const route = (slug: string): AgentRoute => ({
  slug,
  anchorPath: `agents/${slug}`,
  launchable: true,
})

const OPS = agent('agent_1', 'Ops')
const DUET = agent(ROOT_AGENT_SCOPE, 'Duet')

const NESTED = agent('agent_2', 'Scout')

const MAP: MapProjection = {
  data: { duet: DUET, coreMeta: '', agents: [OPS] },
  /* The directory is a superset of the ring: `agent_2` is nested, so the ring
     defers it to its parent, but its address must keep answering. */
  agentDirectory: new Map([
    ['agent_1', OPS],
    ['agent_2', NESTED],
  ]),
  routes: new Map([
    ['agent_1', route('ops')],
    ['agent_2', route('scout')],
  ]),
}

const EMPTY: MapProjection = {
  data: { duet: DUET, coreMeta: '', agents: [] },
  agentDirectory: new Map(),
  routes: new Map(),
}

describe('what the map is showing, resolved from the URL', () => {
  test('the ring is the ring at every phase', () => {
    for (const phase of ['pending', 'error', 'ready'] as const) {
      expect(focusOf({ kind: 'graph' }, MAP, phase)).toEqual({ kind: 'graph' })
    }
  })

  test('finds the agent the slug names, and hands over its route with it', () => {
    expect(
      focusOf({ kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } }, MAP, 'ready'),
    ).toEqual({ kind: 'agent', agent: OPS, route: route('ops') })
  })

  /* The dialog is drawn over the agent, so a jobs URL unfolds the same agent a
     bare one does. Anything else and a pasted job link opens the dialog over
     the ring, on an agent nobody can see. */
  /* The falsification condition of the one-layer ring: hiding a nested agent
     from root's circle must not cost it its address. The ring has no `scout`
     node, the directory does — a deep link still unfolds it. */
  test('a nested agent off the ring still resolves from the directory', () => {
    const focus = focusOf(
      { kind: 'agent', agentSlug: 'scout', card: { kind: 'default' } },
      MAP,
      'ready',
    )
    expect(focus).toEqual({ kind: 'agent', agent: NESTED, route: route('scout') })
  })

  test('a sessions URL unfolds the agent the dialog belongs to', () => {
    expect(
      focusOf({ kind: 'sessions', agentSlug: 'ops', sessionId: 's_42' }, MAP, 'ready'),
    ).toEqual({
      kind: 'agent',
      agent: OPS,
      route: route('ops'),
    })
  })

  /* The centre is not on the ring and has no route of its own, so it is
     resolved by the token the contract already uses rather than by a lookup
     that would always miss. */
  test('the drive’s own agent answers at the root scope', () => {
    expect(
      focusOf(
        { kind: 'agent', agentSlug: ROOT_AGENT_SCOPE, card: { kind: 'default' } },
        EMPTY,
        'pending',
      ),
    ).toEqual({ kind: 'core', agent: DUET })
  })

  /* The whole reason these are two states rather than one. A cold deep link and
     a dead link look identical for the first few hundred milliseconds; collapse
     them and every deep link flashes "no such agent" before it opens. */
  test('tells a link that is still loading from one that is wrong', () => {
    const place = { kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } } as const
    expect(focusOf(place, EMPTY, 'pending')).toEqual({ kind: 'waiting', agentSlug: 'ops' })
    expect(focusOf(place, EMPTY, 'ready')).toEqual({ kind: 'unknown', agentSlug: 'ops' })
    // a read that failed has not established the agent is absent either
    expect(focusOf(place, EMPTY, 'error')).toEqual({ kind: 'waiting', agentSlug: 'ops' })
  })

  /* The old zoom held `node.data` captured at the moment of the click, so an
     agent's work never changed while you were inside it. Resolving from the URL
     against the current projection is what fixes that, and this is the assert
     that says so: the same place, read twice, follows the data. */
  test('follows the values in successive supplied projections', () => {
    const updatedAgent = agent('agent_1', 'Ops updated')
    /* A newer projection rebuilds the directory — that is the surface a slug
       resolves against now, so it is the one this test refreshes. */
    const later: MapProjection = {
      ...MAP,
      data: { ...MAP.data, agents: [updatedAgent] },
      agentDirectory: new Map([...MAP.agentDirectory, ['agent_1', updatedAgent]]),
    }
    const place = { kind: 'agent', agentSlug: 'ops', card: { kind: 'default' } } as const

    const before = focusOf(place, MAP, 'ready')
    const after = focusOf(place, later, 'ready')
    expect(before).toEqual({ kind: 'agent', agent: OPS, route: route('ops') })
    expect(after).toEqual({ kind: 'agent', agent: updatedAgent, route: route('ops') })
  })
})
