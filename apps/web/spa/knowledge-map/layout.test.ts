import { expect, test } from 'bun:test'

import { at, height, unionAll, width } from './box'
import { build, carriedBy, familyIds, MAX_APPS, ring } from './layout'
import { charsIn, discRadius, drawnSubtitle, size, TYPE } from './metrics'
import type {
  Agent,
  AgentNode,
  AppNode,
  JobNode,
  JobsNode,
  MapData,
  MapNode,
  MoreNode,
} from './types'

function agent(id: string, apps = 3, jobs = 2): Agent {
  return {
    id,
    name: id,
    avatarKey: id,
    /* The count is literal: completed-seat behavior has its own mixed-state
       case below, while geometry callers can still ask for a truly idle row. */
    jobs: Array.from({ length: jobs }, (_, j) => ({
      id: `${id}-j${j + 1}`,
      title: 'asked',
      when: 'now',
      state: 'asking' as const,
      unread: false,
    })),
    apps: Array.from({ length: apps }, (_, i) => ({
      id: `${id}-a${i}`,
      title: `App ${i}`,
      when: 'now',
      state: i % 2 === 0 ? ('connected' as const) : ('available' as const),
    })),
  }
}

/**
 * @param jobs how much work each agent has in flight — the second row is drawn
 *   from it, and `0` is the ring at rest.
 * @param duetApps what nobody on the ring claimed — the drive's own apps. Named
 *   rather than positional, because it arrived after `jobs` did and a fourth
 *   bare number is a call site that silently means something else.
 */
function data(n: number, apps = 3, jobs = 2, { duetApps = 0 } = {}): MapData {
  return {
    coreMeta: '1,284 documents · 62 MB',
    /* Duet grows no Jobs seat: its apps stand *on* the ring rather than on a
       tangent outside a face, so there is no row for a second one to hang
       under. Its jobs stay empty here to say so out loud. */
    duet: { ...agent('core', duetApps, 0), name: 'Core knowledge', jobs: [] },
    agents: Array.from({ length: n }, (_, i) => agent(`agent-${i}`, apps, jobs)),
  }
}

const CLEARANCE = 8

/* The promise the ring makes: no two of the round bodies it lays out ever touch,
   at any fleet size, with every agent carrying a full fan. It is asserted
   against `discRadius` rather than `size` because the framing box reserves label
   space that is often empty — measuring collisions with it would flag every
   diagonally-separated pair on the ring. */
test.each([3, 4, 5, 6, 7, 8, 10, 12, 16, 18, 20, 24])(
  'no two ring bodies touch at %i agents',
  n => {
    const scene = build(data(n, 9))
    const bodies = scene.nodes.map(node => ({ id: node.id, pos: node.pos, r: discRadius(node) }))

    const collisions: string[] = []
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!
        const b = bodies[j]!
        const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) - a.r - b.r
        if (gap < CLEARANCE) collisions.push(`${a.id} × ${b.id} (${gap.toFixed(1)})`)
      }
    }
    expect(collisions).toEqual([])
  },
)

/* What the camera is handed. The map is always drawn whole, so this is the
   shape the frame has to hold — and a scene whose shape is a line wastes
   whichever axis it is not on. */
function sceneBox(agents: number, apps = 3) {
  const scene = build(data(agents, apps))
  const box = unionAll(scene.nodes.map(n => at(size(n, { dense: scene.geom.dense }), n.pos)))!
  return { w: width(box), h: height(box) }
}

/* The ring is the whole picture at rest, and at two slots it is not a ring at
   all — it is a straight line through the core. Which line decides whether a
   drive with one agent uses the surface it was given: starting the ring at zero
   made that line vertical, and one agent, its app and the add slot stacked in a
   column down the middle of a landscape window at 0.37 as wide as it was tall,
   with the outer thirds empty.

   From three slots up the ring is a ring and near enough square whatever the
   phase, so the bar is only ever asked to catch the sizes where it is a line —
   which is why it can be this blunt: the drawing is never narrower than it is
   tall. */
test.each([1, 2, 3, 7, 12])('a %i-agent drive is drawn across the frame, not down it', n => {
  const { w, h } = sceneBox(n)
  expect(w / h).toBeGreaterThan(0.9)
})

/* The core's caption hangs below its disc, and an agent directly beneath it
   shares its x — so the two captions have nothing but vertical distance keeping
   them from reading as one four-line block. Two agents is the smallest fleet
   that puts one there, and centred on the same x is the one case where the
   framing box is the right thing to measure. */
test('the ring never closes in far enough for the core caption to reach the agent below it', () => {
  const scene = build(data(2))
  const core = scene.byId.get('core')!
  const below = scene.nodes.find(n => n.kind === 'agent' && n.pos.y > core.pos.y + 100)!
  const ctx = { dense: false }
  expect(at(size(below, ctx), below.pos).y0 - at(size(core, ctx), core.pos).y1).toBeGreaterThan(24)
})

/* ---- the slug, under the name ----
   Two facts that have to agree: whether the second line is drawn, and whether
   the box reserved room for it. They agree because `drawnSubtitle` is the only
   thing either asks — `size()` here, `AgentBody` in the drawing. Asserted
   through the reserve, because that is the half with a consequence: every line
   leaving an agent downward is trimmed to where its words stop, so a reserve
   that forgot the second line would draw trunks through it. */
const subtitled = (node: AgentNode, subtitle: string | undefined): AgentNode => ({
  ...node,
  data: { ...node.data, subtitle },
})

function aFace(agents: number): AgentNode {
  return build(data(agents)).nodes.find((n): n is AgentNode => n.kind === 'agent')!
}

test('an agent showing its slug reserves the room to draw it', () => {
  const ctx = { dense: false }
  const face = aFace(2)
  const bare = size(subtitled(face, undefined), ctx).y1
  expect(size(subtitled(face, 'market-scout'), ctx).y1 - bare).toBeGreaterThanOrEqual(TYPE.t4)
})

/* Past the dense threshold the names are the only captions left on the ring —
   the fans have already given up theirs — and a third tier of words under every
   face is the drawing this map's type scale exists to refuse. The slug is still
   one click away, on the surface the face unfolds into. */
test('a dense ring keeps the names and drops the slugs', () => {
  const dense = build(data(12))
  expect(dense.geom.dense).toBe(true)
  const face = subtitled(aFace(12), 'market-scout')
  expect(drawnSubtitle(face.data, dense.geom)).toBeUndefined()
  expect(size(face, dense.geom).y1).toBe(size(subtitled(face, undefined), dense.geom).y1)
})

/** Everything an agent carries: its whole row, and the jobs under it. */
function hangingOff(nodes: readonly MapNode[], agentId: string): MapNode[] {
  const own = nodes.filter(n => n.parent === agentId)
  const jobsId = own.find(n => n.kind === 'jobs')?.id
  return [...own, ...(jobsId === undefined ? [] : nodes.filter(n => n.parent === jobsId))]
}

/** The row on the tangent: the apps, the count of the rest, and Jobs. */
function row(nodes: readonly MapNode[], agentId: string): (AppNode | MoreNode | JobsNode)[] {
  return nodes.filter(
    (n): n is AppNode | MoreNode | JobsNode =>
      (n.kind === 'app' || n.kind === 'more' || n.kind === 'jobs') && n.parent === agentId,
  )
}

/** Just the apps and their overflow — what the row was before Jobs joined it. */
function fan(nodes: readonly MapNode[], agentId: string): (AppNode | MoreNode)[] {
  return nodes.filter(
    (n): n is AppNode | MoreNode => (n.kind === 'app' || n.kind === 'more') && n.parent === agentId,
  )
}

/* The brief's number, and the only reading of "+6" that adds up: it counts what
   is hidden, not what exists.

   An agent with recent work shows one app fewer, because Jobs takes a seat
   in the same row and the row is four wide at every fleet size — a fifth seat
   draws one agent's row through its neighbour's at seven, ten and twelve
   agents. The count still answers for everything the row is not showing. */
test('an agent draws its apps and one node counting the rest', () => {
  const idle = fan(build(data(3, 9, 0)).nodes, 'agent-0')
  expect(idle.filter(n => n.kind === 'app')).toHaveLength(MAX_APPS)
  const idleMore = idle.find(n => n.kind === 'more')
  if (idleMore?.kind !== 'more') throw new Error('expected a more node')
  expect(idleMore.count).toBe(6)

  const busy = fan(build(data(3, 9)).nodes, 'agent-0')
  expect(busy.filter(n => n.kind === 'app')).toHaveLength(MAX_APPS - 1)
  const busyMore = busy.find(n => n.kind === 'more')
  if (busyMore?.kind !== 'more') throw new Error('expected a more node')
  expect(busyMore.count).toBe(7)

  /* The row itself is the same width either way. That is the invariant the
     seat swap exists to keep. */
  expect(row(build(data(3, 9)).nodes, 'agent-0')).toHaveLength(MAX_APPS + 1)
})

test('a lone job gets the caption room its empty row leaves available', () => {
  const title = 'Wait for the nightly export'
  const loneData = data(3, 0, 1)
  loneData.agents[0]!.jobs[0]!.title = title
  const lone = build(loneData).nodes.find((node): node is JobNode => node.kind === 'job')
  const crowded = build(data(3, 0, 2)).nodes.find((node): node is JobNode => node.kind === 'job')

  expect(lone?.room).toBeGreaterThan(crowded?.room ?? Number.POSITIVE_INFINITY)
  expect(charsIn(lone?.room ?? 0, TYPE.t3)).toBeGreaterThanOrEqual(title.length)
})

/* A fan is lifted clear of the face it hangs off — including the fan of one,
   which is the seat the tangent maths puts exactly on the hub and so the one
   that would land on the agent if the lift were ever dropped. Nothing may share
   a coordinate with the agent it belongs to at any number of apps: a node drawn
   under a face is a node nobody can click and a caption nobody can read. */
test.each([1, 2, 3, 4, 7])('an agent of %i apps hangs all of them clear of its own face', apps => {
  const scene = build(data(3, apps, 0))
  const owner = scene.byId.get('agent-0')!
  const seats = fan(scene.nodes, 'agent-0')

  expect(seats).toHaveLength(Math.min(apps, MAX_APPS) + (apps > MAX_APPS ? 1 : 0))
  for (const seat of seats) {
    const gap = Math.hypot(seat.pos.x - owner.pos.x, seat.pos.y - owner.pos.y)
    expect(gap).toBeGreaterThan(discRadius(owner) + discRadius(seat))
  }
  /* And clear of each other, so two apps never draw as one. */
  const spread = new Set(seats.map(s => `${s.pos.x.toFixed(3)},${s.pos.y.toFixed(3)}`))
  expect(spread.size).toBe(seats.length)
})

/* The apps nobody on the ring claimed are Duet's, and Duet is the core — so
   they hang off the centre rather than going undrawn. They take slots on the
   ring of their own, the way the add slot does, because the alternative is a
   fan drawn inside a circle whose whole inside is trunks. */
test('the apps Duet owns hang off the core, one ring slot each', () => {
  const scene = build(data(2, 1, 2, { duetApps: 2 }))
  const seats = fan(scene.nodes, 'core')

  expect(seats.map(seat => seat.kind)).toEqual(['app', 'app'])
  expect(seats.map(seat => (seat.kind === 'app' ? seat.data.id : ''))).toEqual([
    'core-a0',
    'core-a1',
  ])
  for (const seat of seats) {
    expect(scene.links).toContainEqual({ from: 'core', to: seat.id, kind: 'limb' })
  }
})

/* Three and a count, the same promise the ring makes for an agent. */
test('Duet draws three apps and one node counting the rest', () => {
  const seats = fan(build(data(2, 1, 2, { duetApps: 9 })).nodes, 'core')
  expect(seats.filter(seat => seat.kind === 'app')).toHaveLength(MAX_APPS)
  const more = seats.find(seat => seat.kind === 'more')
  expect(more?.kind === 'more' ? more.count : null).toBe(6)
})

test('an agent that fits draws no more node, and one with nothing draws nothing', () => {
  for (const apps of [1, 2, 3]) {
    const nodes = fan(build(data(3, apps, 0)).nodes, 'agent-0')
    expect(nodes.map(n => n.kind)).toEqual(Array.from({ length: apps }, () => 'app'))
  }
  expect(fan(build(data(3, 0, 0)).nodes, 'agent-0')).toEqual([])
  /* And an agent with neither apps nor work carries nothing at all. */
  expect(row(build(data(3, 0, 0)).nodes, 'agent-0')).toEqual([])
})

test('five job seats keep unfinished work visible and fill the rest with completed sessions', () => {
  const owner = {
    ...agent('agent-0', 3, 0),
    jobs: [
      { id: 'done-new', title: 'Done new', when: 'now', state: 'done' as const, unread: false },
      { id: 'running', title: 'Running', when: 'now', state: 'running' as const, unread: false },
      {
        id: 'done-middle',
        title: 'Done middle',
        when: 'now',
        state: 'done' as const,
        unread: false,
      },
      { id: 'asking', title: 'Needs you', when: 'now', state: 'asking' as const, unread: false },
      { id: 'done-old', title: 'Done old', when: 'now', state: 'done' as const, unread: false },
      {
        id: 'done-oldest',
        title: 'Done oldest',
        when: 'now',
        state: 'done' as const,
        unread: false,
      },
    ],
  }
  const scene = build({ ...data(0), agents: [owner] })
  const shown = scene.nodes
    .filter(node => node.kind === 'job')
    .map(node => (node.kind === 'job' ? node.data.id : ''))

  expect(shown).toEqual(['asking', 'running', 'done-new', 'done-middle', 'done-old'])
  expect(scene.byId.has('agent-0/jobs/more')).toBe(true)
})

/* Screen-x runs with the angle above the core and against it below, so a fan
   laid out in plain angular order reads first→last at the top and last→first at
   the bottom. Same nodes, same screen, opposite reading order — which defeats
   any positional memory you build up. On the flanks the row is a column, so the
   same promise is made about y. */
test('a fan always reads first to last, wherever its agent stands', () => {
  const scene = build(data(4, 5))
  const core = scene.byId.get('core')!
  const agents = scene.nodes.filter(n => n.kind === 'agent')

  for (const owner of agents) {
    const nodes = row(scene.nodes, owner.id)
    expect(nodes).toHaveLength(MAX_APPS + 1)
    const vertical = Math.abs(owner.pos.y - core.pos.y) < 1
    const along = nodes.map(n => (vertical ? n.pos.y : n.pos.x))
    expect(along).toEqual([...along].sort((a, b) => a - b))
  }
})

/* A fan hangs square to the agent it belongs to rather than following the arc
   through it, so its captions share one baseline instead of landing on four.
   Square to the agent, not square to the screen: the row is only horizontal for
   an agent that happens to stand at the top of the ring, and what has to hold
   at every bearing is that all of its apps sit on one line perpendicular to the
   radius they hang off. */
test('a fan is square to its own agent, so its captions share a baseline', () => {
  const scene = build(data(4, 5))
  const core = scene.byId.get('core')!

  for (const owner of scene.nodes.filter(n => n.kind === 'agent')) {
    const out = { x: owner.pos.x - core.pos.x, y: owner.pos.y - core.pos.y }
    const len = Math.hypot(out.x, out.y)
    /* How far along the radius each app sits. One shared value means one line
       square to it; four values would be the arc the fan is not laid out on. */
    const along = row(scene.nodes, owner.id).map(n =>
      Number((((n.pos.x - core.pos.x) * out.x + (n.pos.y - core.pos.y) * out.y) / len).toFixed(6)),
    )
    expect(along).toHaveLength(MAX_APPS + 1)
    expect(new Set(along).size).toBe(1)
  }
})

test('the map stops naming apps past seven agents, not before', () => {
  expect(build(data(7)).geom.dense).toBe(false)
  expect(build(data(8)).geom.dense).toBe(true)
})

test('the ring grows with the fleet but never below its floor', () => {
  expect(ring(4).agent).toBe(ring(2).agent)
  expect(ring(13).agent).toBeGreaterThan(ring(4).agent)
})

/* The ring is a drawing, not a policy: the product allows far more agents than
   the map can pleasantly draw, so the map must not be the thing that says no. */
test('the add slot is always there, at any fleet size', () => {
  for (const n of [0, 1, 12, 40]) {
    const add = build(data(n)).byId.get('add')!
    expect(add.kind).toBe('add')
    if (add.kind !== 'add') continue
    expect(add.count).toBe(n)
  }
})

/* Inside an agent its fan is not drawn at all. The pane on the right is already
   showing one of those apps and naming it, so the nodes were a second answer to
   a question that had been answered — and a worse one: for an agent on the upper
   or the left flank the row hung off the frame or under the glass.

   The add slot is why this is a predicate rather than a test on `parent`. It
   hangs off the core exactly the way a fan hangs off an agent, and opening Duet
   must not take the one thing on an untouched map that is asking to be clicked. */
test('the apps an agent carries are not drawn while you are inside it', () => {
  const scene = build(data(3, 5, 2))
  const away = scene.nodes.filter(n => carriedBy(n, 'agent-1')).map(n => n.id)
  /* The beads go with the fan, and for the same reason: inside the agent, the
     door under its name opens the whole list at a size a title actually fits. */
  expect(new Set(away)).toEqual(new Set(hangingOff(scene.nodes, 'agent-1').map(n => n.id)))

  /* Duet's own apps go the same way when you go inside Duet — and the add slot,
     which hangs off the core by the same `parent`, stays exactly where it is. */
  const inside = scene.nodes.filter(n => carriedBy(n, 'core')).map(n => n.id)
  expect(new Set(inside)).toEqual(new Set(fan(scene.nodes, 'core').map(n => n.id)))
  expect(inside).not.toContain('add')

  expect(scene.nodes.filter(n => carriedBy(n, null)).map(n => n.id)).toEqual([])
})

/* The trunk is the only thing on the map that can say an agent is *working*
   without saying anything about what is most urgent about it — the badge on the
   face is spent on the second question and an agent that is stuck on one thing
   and running two others has only one badge. So the flag is on the link, next
   to `dashed`, and the layout is where it is read: the fan hangs off the same
   agent and stays quiet, and so does the add slot, which has no agent at all. */
test('a trunk carries whether the agent on the end of it is working', () => {
  const jobs = {
    live: [{ id: 'l', title: 'j', when: 'now', state: 'running' as const, unread: false }],
    clock: [{ id: 'c', title: 'j', when: 'now', state: 'scheduled' as const, unread: false }],
    stuck: [{ id: 's', title: 'j', when: 'now', state: 'asking' as const, unread: false }],
  }
  const scene = build({
    ...data(0),
    agents: (['live', 'clock', 'stuck'] as const).map(key => ({
      ...agent(key, 2),
      jobs: jobs[key],
    })),
  })
  const trunkTo = (id: string) => scene.links.find(link => link.kind === 'trunk' && link.to === id)

  expect(trunkTo('live')?.live).toBe(true)
  expect(trunkTo('clock')?.live).toBeUndefined()
  expect(trunkTo('stuck')?.live).toBeUndefined()
  expect(trunkTo('add')?.live).toBeUndefined()
  expect(scene.links.filter(link => link.kind === 'limb' && link.live === true)).toEqual([])
})

/* What the camera has to hold while a surface is unfolded over the canvas: the
   node you went into and everything hanging off it. */
test('a zoomed agent frames itself and its own fan, and nobody else', () => {
  const scene = build(data(3, 5))
  expect(new Set(familyIds(scene, 'agent-1'))).toEqual(
    new Set(['agent-1', ...hangingOff(scene.nodes, 'agent-1').map(n => n.id)]),
  )
  expect(familyIds(scene, 'core')).toEqual(['core', 'add'])
  expect(new Set(familyIds(build(data(3, 5, 2, { duetApps: 2 })), 'core'))).toEqual(
    new Set(['core', 'add', 'core/apps/core-a0', 'core/apps/core-a1']),
  )
  expect(familyIds(scene, null)).toBeNull()
})
