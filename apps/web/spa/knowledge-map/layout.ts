/* ============================================================================
   Where everything goes. A pure function of the data.

     build(data)  ->  Scene

   No DOM, no timers, no colour. Hand it the same argument twice and you get the
   same numbers twice, which is what makes the geometry testable and the view
   replaceable.

   ---- one thing hangs off an agent ----
   An agent is the apps it can reach, up to three of them, plus one node
   standing for the rest. There is no branch to open and nothing to expand: the
   ring is the whole picture at rest, and everything else about an agent — its
   jobs, its skills, its files, its conversation — is inside it, reached by
   zooming rather than by growing the drawing sideways.

   The core carries apps the same way, because Duet is a carrier like any other
   — it just stands in the middle. Its seats are slots on the ring rather than a
   fan, for the reason `duetSeats` gives.

   ---- the ring grows with the fleet ----
   Every slot needs a fixed slice of *arc*, not a fixed slice of angle, so the
   radius is solved from the head count rather than pinned. Nodes keep their
   size; the circle gets bigger and the camera pulls back a little. That is what
   makes twelve agents look like three, only wider.
   ========================================================================= */
import { seatedJobs } from './job-groups'
import { agentIsLive } from './live'
import { ARC_PER_SLOT, ARC_PER_SLOT_CROWDED, charsIn, M, TYPE } from './metrics'
import type {
  Agent,
  AppItem,
  AppNode,
  JobNode,
  JobsMoreNode,
  JobsNode,
  Link,
  MapNode,
  MapData,
  MoreNode,
  Ring,
  Scene,
  Vec,
} from './types'

export const CX = 700
export const CY = 700

/** The short axis of whatever the map is drawn in. The camera solves against it. */
export const VIEW = 1048

/**
 * The viewBox for a surface of this shape, centred on the core.
 *
 * The map used to be pinned to a square and the square was pinned to a fraction
 * of the window height, so a wide container got a square of map and two bands of
 * dead background — and the camera, which frames content into `VIEW` on *both*
 * axes, still solved as though the extra width were not there. Anything the
 * solve did not cover was simply cut off at the edge of the box.
 *
 * So the box takes the shape of the container instead: the shorter axis stays at
 * `VIEW` and the longer one grows. A scale of 1 means the same thing at every
 * aspect ratio, and the room a wide window gives you is room the camera can use.
 */
export type Viewport = { w: number; h: number; box: string }

export function viewport(width: number, height: number): Viewport {
  const ratio = width > 0 && height > 0 ? width / height : 1
  const w = ratio >= 1 ? VIEW * ratio : VIEW
  const h = ratio >= 1 ? VIEW : VIEW / ratio
  return { w, h, box: `${CX - w / 2} ${CY - h / 2} ${w} ${h}` }
}

const FAN_LIFT = 148 // the agent name sets this floor: closer and an app lands on it
const FAN_PITCH = 100 // gap between two app nodes when they are named
const FAN_PITCH_DENSE = 64 // and when they are only monograms

/* The caption of an app with no neighbours. The pitch is what stops two names
   in the same fan running into each other, so it is the wrong bound for a fan
   of one — and an agent that can reach exactly one app was reading
   "Research Boa…" with a clear third of the window either side of it. */
const LONE_APP_ROOM = 176
const LONE_JOB_ROOM = 220

/** Three, and then a node that says how many are left. The brief's number. */
export const MAX_APPS = 3

/* Past seven *agents* the secondary labels are noise. `ring` is handed the slot
   count, which is one more than that because the add slot reserves its own arc
   — so this is 8, not 7. */
const DENSE_ABOVE_SLOTS = 8

/* And past fifteen the fans themselves are noise.

   The ring's radius grows linearly with the head count, because every agent
   claims a fixed slice of arc — so everything hanging off an agent is a
   constant the camera pays for at every fleet size, and the camera fits the
   whole drawing into the container's short axis. Measured: at eighteen agents
   the map already draws its smallest caption below its own `TEXT_FLOOR`, and at
   twenty the faces are 33px. Dropping the fans and taking their arc back puts
   twenty agents at 49px with every caption at the floor, and moves the ceiling
   past thirty.

   What it costs is that you can no longer see, from the ring, which apps a
   crowded drive's agents can reach. You get that by going in — where the pane
   on the right already names them, which is the same argument `carriedBy`
   makes for hiding the fan while you are inside an agent. */
const CROWDED_ABOVE_SLOTS = 16

/* Below eight slots the arc formula asks for less radius than the fans need:
   at seven agents the outermost app of one agent and the innermost of its
   neighbour close to within their own discs. The floor holds them apart until
   the arc calculation overtakes it — `layout.test.ts` is what says so.

   The second row of jobs hangs *below* the fan rather than beside it, so it
   spends radius rather than arc — which is why this floor did not have to move
   for it. What it may never do is add a seat to the row itself. */
const MIN_RADIUS = 316

export function ring(slots: number): Ring {
  const crowded = slots > CROWDED_ABOVE_SLOTS
  const arc = crowded ? ARC_PER_SLOT_CROWDED : ARC_PER_SLOT
  const r = Math.max(MIN_RADIUS, (slots * arc) / (2 * Math.PI))
  const dense = slots > DENSE_ABOVE_SLOTS
  const step = 360 / slots
  const pitch = dense ? FAN_PITCH_DENSE : FAN_PITCH

  /* The chord between two neighbours out at the row's own radius, less the two
     discs that meet across it, the air between them, and the half-seat the row
     is offset by — divided between the gaps in one row. */
  const chord = 2 * (r + FAN_LIFT + JOB_ROW_LIFT) * Math.sin(Math.PI / slots)
  const jobPitch = Math.min(
    JOB_PITCH_MAX,
    Math.max(JOB_PITCH_MIN, (chord - 2 * (M.BEAD_R + 2) - JOB_ROW_AIR - pitch) / MAX_JOBS),
  )

  return {
    agent: r,
    fan: r + FAN_LIFT,
    step,
    crowded,
    jobPitch,
    /* Not "how many agents": whether the room this row actually got can hold a
       title. One predicate, and it moves on its own if any constant does. */
    jobTitles: charsIn(jobPitch, TYPE.t3) >= JOB_TITLE_MIN_CHARS,
    /* Half a slot, so nothing ever sits on an axis.
       At two slots the ring is not a ring, it is a straight line through the
       core — and starting at zero made that line vertical: one agent, its app
       and the add slot stacked in a column down the middle with two thirds of a
       landscape window empty either side. Offset by half a step the same two
       slots run left to right, which is the shape of the surface they are drawn
       on. Past that it is a rotation and nothing more: every distance on the
       ring is unchanged, so the clearances hold, and no caption is left sharing
       an axis with the core's. */
    phase: step / 2,
    pitch: dense ? FAN_PITCH_DENSE : FAN_PITCH,
    dense,
  }
}

/** The unit vector pointing out of the core at this bearing. */
function outward(deg: number): Vec {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: Math.cos(a), y: Math.sin(a) }
}

function polar(r: number, deg: number): Vec {
  const out = outward(deg)
  return { x: CX + r * out.x, y: CY + r * out.y }
}

/** The one id the centre answers to. The host's own id for Duet is its business. */
export const CORE_ID = 'core'

export function build(data: MapData): Scene {
  const count = data.agents.length
  /* Duet's own apps stand on the ring rather than in a fan of their own: a fan
     hangs on the tangent outside the face it belongs to, and the core's outside
     is the ring itself. Given a slot each they are spaced by the same arc as
     everything else out there, and the trunks running past them keep their
     clearance for free. */
  const duetSlots = seatsFor(data.duet.apps).seats
  const geom = ring(count + duetSlots + 1)

  const nodes: MapNode[] = [
    {
      id: CORE_ID,
      kind: 'core',
      pos: { x: CX, y: CY },
      data: { label: data.duet.name, meta: data.coreMeta },
      /* The record itself, not a copy: the projection is the only place an
         agent is minted, and the centre is an owner like any face. */
      agent: data.duet,
    },
  ]
  const links: Link[] = []

  data.agents.forEach((agent, i) => {
    const deg = geom.phase + i * geom.step
    nodes.push({ id: agent.id, kind: 'agent', pos: polar(geom.agent, deg), data: agent })
    /* Undefined rather than false when it is not: the flag is a presentation
       hint like `dashed` beside it, and a scene full of `live: false` says the
       ring is asserting stillness rather than simply not drawing anything. */
    links.push({
      from: CORE_ID,
      to: agent.id,
      kind: 'trunk',
      live: agentIsLive(agent) || undefined,
    })
    for (const n of branchOf(agent, deg, geom)) {
      nodes.push(n)
      /* A limb joins a node to whatever carries it — an app to its agent, a job
         to the Jobs seat it hangs off. The second row is the only place on this
         map where that is not the agent itself. */
      links.push({ from: n.parent ?? agent.id, to: n.id, kind: 'limb' })
    }
  })

  for (const n of duetSeats(data.duet, geom, count)) {
    nodes.push(n)
    links.push({ from: CORE_ID, to: n.id, kind: 'limb' })
  }

  /* No cap here. The ring is a drawing, not a policy — the product allows far
     more agents than it can pleasantly draw, so a map that says "full" at
     twelve is inventing a limit the server does not have. It gets denser
     instead, and the add slot always adds.

     One seat, whichever way it is filled. A `create` satellite used to hang off
     this one on a dashed limb, at an app seat's radius and bearing, so the pair
     read as one choice with two doors. It read as one because it *was* one,
     which is the argument for asking it after the click instead: the satellite
     cost arc, a second caption, and — at one agent, where the ring is a line —
     the scene's whole long axis. */
  const addAngle = geom.phase + (count + duetSlots) * geom.step
  nodes.push({
    id: 'add',
    kind: 'add',
    count,
    pos: polar(geom.agent, addAngle),
    parent: CORE_ID,
  })
  links.push({ from: CORE_ID, to: 'add', kind: 'trunk', dashed: true })

  return { nodes, links, byId: new Map(nodes.map(n => [n.id, n])), geom }
}

/** How many seats an app list takes, and what goes in them. */
type Seats = { shown: readonly AppItem[]; rest: number; seats: number }

/**
 * Three apps, and then one seat counting whatever is left. Both carriers ask
 * this — an agent, and the core — so neither can drift from the other about how
 * many seats to reserve or what "+2" means.
 *
 * `max` is the one thing a carrier gets to vary, and only one does: an agent
 * with recent work shows a third app fewer, because Jobs takes a seat in the
 * same row. Passing a cap here rather than slicing at the call site is what
 * keeps `rest` honest — a list sliced outside would count what it hid as zero
 * and the `+N` would quietly stop adding up.
 */
function seatsFor(apps: readonly AppItem[], max: number = MAX_APPS): Seats {
  const shown = apps.slice(0, max)
  const rest = apps.length - shown.length
  return { shown, rest, seats: shown.length + (rest > 0 ? 1 : 0) }
}

/** `<agent>/apps/<app>` and `<agent>/more` — the ids a fan answers to. */
export function appNodeId(agentId: string, appId: string): string {
  return `${agentId}/apps/${appId}`
}
export function moreNodeId(agentId: string): string {
  return `${agentId}/more`
}

/** `<agent>/jobs`, `<agent>/jobs/<job>` and `<agent>/jobs/more`. */
export function jobsNodeId(agentId: string): string {
  return `${agentId}/jobs`
}
export function jobNodeId(agentId: string, jobId: string): string {
  return `${agentId}/jobs/${jobId}`
}
export function jobsMoreNodeId(agentId: string): string {
  return `${agentId}/jobs/more`
}

/**
 * The nearest thing the ring actually drew, for something pointed at from off
 * the map.
 *
 * The rail lists everything; the ring seats three apps and five jobs per agent
 * and folds the rest behind a mark. So a row can point at work that has no node
 * of its own, and the honest answer is not "nothing" — it is the mark the
 * reader would have to open to find it. Falls back to the agent carrying it,
 * and only then to nothing at all, because lighting an unrelated node is worse
 * than lighting none.
 *
 * It reads the id rather than being handed the shape, because the id *is* the
 * shape — `<agent>/apps/<app>` and `<agent>/jobs/<job>` are built three
 * functions up, and the parse is their inverse.
 */
export function nearestDrawnNode(id: string, drawn: (candidate: string) => boolean): string | null {
  if (drawn(id)) return id
  for (const [pattern, mark] of [
    [/^(.*)\/apps\/[^/]+$/, moreNodeId],
    [/^(.*)\/jobs\/[^/]+$/, jobsMoreNodeId],
  ] as const) {
    const owner = pattern.exec(id)?.[1]
    if (owner === undefined) continue
    if (drawn(mark(owner))) return mark(owner)
    return drawn(owner) ? owner : null
  }
  return null
}

/** Five, and then a mark that says there is more. It never says how many. */
export const MAX_JOBS = 5

/* How far the second row hangs below the first, and how far apart the jobs in
   it stand.

   The lift clears the Jobs seat's own *caption* rather than its disc: a caption
   hangs below a node in screen space, and for an agent on the lower half of the
   ring "below" is straight out along the spoke — which is exactly where the row
   goes. Measured from `size()`, not guessed. */
const JOB_ROW_LIFT = 84

/* ---- how much room one job gets, and whether that is enough for a title ----
   Solved from the arc actually available between neighbouring agents at the
   row's own radius, rather than pinned. That is the same rule the ring's radius
   already follows — the drawing keeps its size and the circle grows — and it is
   what makes the answer *automatic*: three agents have room for a title beside
   every job, twenty do not, and nothing in between has to be enumerated.

   The threshold is readability, not a head count. A caption is either a title
   or it is a truncation pretending to be one, and `charsIn` is the only thing
   that knows which — so the row asks it rather than asking how many agents
   there are. Below the floor the jobs are dots, which is the honest drawing of
   one of twenty agents' work seen from the whole drive. */
const JOB_PITCH_MAX = 112
const JOB_PITCH_MIN = 26
/** Clear air between the last job of one agent's row and the first of the next. */
const JOB_ROW_AIR = 8
/** Fewer characters than this is a truncation pretending to be a title. */
const JOB_TITLE_MIN_CHARS = 9

/* ---- and how it opens ----
   The same shape, given the room it needs: a fan of nodes hanging off the Jobs
   seat, exactly as the apps hang off the agent. It is not a list — the whole
   point of drawing work on a map is that a job is a node with a line to its
   owner, and a list is what the dialog is for.

   What changes is the pitch, and it can change because the camera has come in
   to frame this branch and nothing else. The room at rest is whatever the arc
   between two neighbours could spare; opened, it is what a title needs. */

/* ---- an agent's branch: what it can reach, and what it is doing ----
   One row on the tangent at the fan radius — the apps, and, in the middle of
   them, its recent work. The jobs hang off that seat in a second row below
   it, which is the only place on this map where anything has a grandparent.

   They sit on the tangent rather than on the arc through it for the reason the
   fan already did: on the arc the captions land on slightly different baselines
   whenever the agent is near the top or the bottom of the ring, and that reads
   as misalignment rather than as radial layout.

   Jobs takes the *middle* seat rather than an end, and the second reason is the
   load-bearing one: it is the agent's own work, so it belongs on the agent's
   own radius; and a seat at either end would carry its children out past the
   end of the row, into the arc the neighbouring agent's fan is already using.
   From the middle the second row is centred under the first and costs no arc
   the fan was not spending anyway.

   What a seat *is* stays `seatNodes`' business, and how many an app list takes
   stays `seatsFor`'s. This only decides where they sit and what sits among
   them — the core carries seats too, and a second answer to either question
   here is the drift those two owners exist to prevent. */
function branchOf(
  agent: Agent,
  deg: number,
  geom: Ring,
): (AppNode | MoreNode | JobsNode | JobNode | JobsMoreNode)[] {
  const visible = seatedJobs(agent.jobs)
  /* A crowded ring draws no apps at all — see `CROWDED_ABOVE_SLOTS` — and an
     agent with recent work shows one app fewer, because Jobs takes a seat in
     the same row rather than adding one.

     The row is four seats wide at every fleet size and that is not a style
     choice: `MIN_RADIUS` and `ARC_PER_SLOT` are both solved against a
     four-seat fan, and a fifth seat puts one agent's row through its
     neighbour's at seven, ten and twelve agents. Something has to give up its
     place, and between "the third app this agent can reach" and "what it is
     doing right now", the app loses. The `more` seat already answers for
     everything the row is not showing. */
  const hasJobs = visible.length > 0
  const taken = seatsFor(geom.crowded ? [] : agent.apps, hasJobs ? MAX_APPS - 1 : MAX_APPS)
  const seats = taken.seats + (hasJobs ? 1 : 0)
  if (seats === 0) return []

  const out = outward(deg)
  /* Flipped so the row always runs left to right on screen — and top to bottom
     on the two flanks, where it is a column. Without it the reading order
     reverses on the lower half of the ring, which defeats any positional memory
     you build up. */
  const flip = out.y > 1e-9 || (Math.abs(out.y) <= 1e-9 && out.x < 0) ? -1 : 1
  const tan = { x: -out.y * flip, y: out.x * flip }
  const seatAt = (radius: number, offset: number): Vec => ({
    x: CX + out.x * radius + tan.x * offset,
    y: CY + out.y * radius + tan.y * offset,
  })

  /* Where the Jobs seat lands is decided before anything is placed, because the
     second row hangs off that offset — a value left behind by the loop that
     draws the first row goes wrong the moment the two are reordered. The apps
     close up around it: an app at or past the middle shifts one seat out. */
  const room = seats > 1 ? geom.pitch : LONE_APP_ROOM
  const offsetOf = (i: number): number => (i - (seats - 1) / 2) * geom.pitch
  const jobsAt = hasJobs ? Math.floor(taken.seats / 2) : -1
  const appSeat = (i: number): Vec =>
    seatAt(geom.fan, offsetOf(i < jobsAt ? i : i + (hasJobs ? 1 : 0)))

  const nodes: (AppNode | MoreNode | JobsNode | JobNode | JobsMoreNode)[] = [
    ...seatNodes(agent, agent.id, taken, room, appSeat),
  ]
  if (!hasJobs) return nodes

  /* Spliced where it stands rather than appended. The row is emitted in reading
     order — `layout.test.ts` proves first-to-last against the array — and a seat
     placed in the middle but pushed on the end makes the two disagree, which is
     a promise broken by an ordering nobody can see. */
  const along = offsetOf(jobsAt)
  nodes.splice(jobsAt, 0, {
    id: jobsNodeId(agent.id),
    kind: 'jobs',
    parent: agent.id,
    agent,
    pos: seatAt(geom.fan, along),
    room,
    deg,
    along,
  })
  return [...nodes, ...jobSeatsOf(agent, deg, geom, along)]
}

/* ---- the apps Duet owns ----
   Everything on the drive that no agent claimed. They are the core's, so they
   take their slots straight after the agents and hang off the centre by a limb
   — the same relationship an agent has with its own fan, drawn at ring radius
   because that is where the core's own outside is.

   Duet grows no Jobs seat, and that is a deliberate omission rather than an
   oversight: these seats stand *on* the ring rather than on a tangent outside a
   face, so there is no row for a second one to hang under, and the work Duet
   owns is reached by going inside it. See the spec's open question.

   Parented to `CORE_ID` rather than to whatever id the host calls Duet by: the
   map decides what its centre is named, and this way `carriedBy` puts these
   away when you go inside Duet without anything having to agree about ids. */
function duetSeats(duet: Agent, geom: Ring, firstSlot: number): (AppNode | MoreNode)[] {
  /* A whole slot each, so a name gets the room an agent's would — these never
     have a neighbour on the tangent the way a fan's seats do. */
  return seatNodes(duet, CORE_ID, seatsFor(duet.apps), LONE_APP_ROOM, i =>
    polar(geom.agent, geom.phase + (firstSlot + i) * geom.step),
  )
}

/**
 * The nodes a carrier's seats are made of, wherever those seats are.
 *
 * The two carriers differ only in where the seats sit — an agent's on the
 * tangent outside its face, the core's on the ring — so that is all either one
 * supplies. Everything about what a seat *is* lives here: an id that answers to
 * its carrier, the carrier itself for whoever the host has to be handed, and the
 * counting node at the end. Two builders that had to keep agreeing about that
 * would be one field away from drifting.
 */
function seatNodes(
  owner: Agent,
  ownerId: string,
  { shown, rest }: Seats,
  room: number,
  seat: (i: number) => Vec,
): (AppNode | MoreNode)[] {
  const nodes: (AppNode | MoreNode)[] = shown.map((app, i) => ({
    id: appNodeId(ownerId, app.id),
    kind: 'app',
    parent: ownerId,
    agent: owner,
    data: app,
    pos: seat(i),
    room,
  }))
  if (rest > 0) {
    nodes.push({
      id: moreNodeId(ownerId),
      kind: 'more',
      parent: ownerId,
      agent: owner,
      count: rest,
      pos: seat(shown.length),
      room,
    })
  }
  return nodes
}

/**
 * One agent's recent work, as the row hanging off its Jobs seat.
 *
 * The first five are the prioritized `seatedJobs`: every unfinished session
 * before completed history, with the newest rows retained inside each bucket.
 *
 * The single owner of where a job stands. It used to be called twice — once for
 * the ring at rest and once for a branch the reader had flown into, differing by
 * a pitch and a lift — and the second caller went with the two-step.
 */
function jobSeatsOf(
  agent: Agent,
  deg: number,
  geom: Ring,
  along: number,
): (JobNode | JobsMoreNode)[] {
  const visible = seatedJobs(agent.jobs)
  if (visible.length === 0) return []

  const shown = visible.slice(0, MAX_JOBS)
  const rest = visible.length - shown.length
  const count = shown.length + (rest > 0 ? 1 : 0)

  const out = outward(deg)
  const flip = out.y > 1e-9 || (Math.abs(out.y) <= 1e-9 && out.x < 0) ? -1 : 1
  const tan = { x: -out.y * flip, y: out.x * flip }
  const pitch = geom.jobPitch
  const radius = geom.fan + JOB_ROW_LIFT
  const seat = (i: number): Vec => {
    const offset = along + (i - (count - 1) / 2) * pitch
    return { x: CX + out.x * radius + tan.x * offset, y: CY + out.y * radius + tan.y * offset }
  }

  /* A lone title has no neighbouring bead to collide with. Give it the same
     caption width as a lone app instead of clipping it to the pitch a crowded
     row would need. The node stays in exactly the same place; only the honest
     text budget changes. */
  const shared = {
    parent: jobsNodeId(agent.id),
    agent,
    room: count === 1 ? LONE_JOB_ROOM : pitch,
  }
  const seats: (JobNode | JobsMoreNode)[] = shown.map((job, i) => ({
    id: jobNodeId(agent.id, job.id),
    kind: 'job',
    data: job,
    pos: seat(i),
    ...shared,
  }))
  if (rest > 0) {
    seats.push({
      id: jobsMoreNodeId(agent.id),
      kind: 'jobsMore',
      pos: seat(count - 1),
      ...shared,
    })
  }
  return seats
}

/**
 * Is this node part of the branch `agentId` carries?
 *
 * Which is to say: is it a node that stops being drawn once you are standing
 * inside that agent. The branch is the ring's answer to "what can this agent
 * reach and what is it doing", and inside the agent the surface answers both
 * questions bigger and by name — so the row would be a second, smaller copy of
 * it, and for an agent on the upper or the left flank a copy that hangs off the
 * frame or under the glass.
 *
 * It asks each node who it belongs to rather than who its parent is, because a
 * job hangs off the Jobs seat rather than off the agent — the map's one
 * grandchild. A `parent` test silently answers false for those and leaves them
 * drawn under the glass. The add slot has no owner at all, which is why opening
 * Duet does not put away the one thing on an untouched map that is asking to be
 * clicked.
 */
export function carriedBy(node: MapNode, agentId: string | null): boolean {
  if (agentId === null) return false
  switch (node.kind) {
    case 'app':
    case 'more':
    case 'jobs':
    case 'job':
    case 'jobsMore':
      return node.agent.id === agentId
    case 'core':
    case 'agent':
    case 'add':
      return false
  }
}

/**
 * The nodes the camera has to hold while you are zoomed into one agent.
 *
 * The agent *and* everything hanging off it: those stay on screen behind the
 * surface that unfolds over them, and framing without them meant the camera
 * happily solved a scale that sliced one of them in half against the edge.
 * The core answers for itself, because Duet's face is on it.
 */
export function familyIds(scene: Scene, focusId: string | null): string[] | null {
  if (focusId === null) return null
  return scene.nodes
    .filter(n => n.id === focusId || n.parent === focusId || carriedBy(n, focusId))
    .map(n => n.id)
}

/* The one place an edge's identity is spelled. The renderer keys its element by
   this and the motion loop looks the element up by it; if the two ever disagreed
   the edges would silently stop animating, so neither gets to write it out. */
export function linkKey(link: Link): string {
  return `${link.from}|${link.to}`
}

/* A live trunk is drawn more than once: the wire, and then one element per comet
   travelling along it. They are separate elements because they are separate
   strokes — one steady, and two dashed and moving a beat apart — and every one
   of them has to trace the identical line, so each is filed under its own key
   and handed the same `d` in the same frame. */
export const SPARKS = [0, 1] as const

export function sparkKey(link: Link, spark: number): string {
  return `${linkKey(link)}|spark${spark}`
}
