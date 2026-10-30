/* ============================================================================
   The two contracts the knowledge map is built on.

   ---- 1. the data ----
   Everything the map draws comes from `MapData`. The shape is deliberately not
   uniform: a job, a skill, a file and an app are different kinds of thing, and
   modelling them as one bag of `{ title, meta }` is how a card ends up unable
   to decide what it is.

   An agent on the ring is its apps and the work it has in flight, and nothing
   else. Skills and files are here because the *zoom* is made of them — one
   agent's whole working life, unfolded in place — but they are read per agent,
   when you go inside one, rather than fanned out across the whole ring to draw
   four numbers nobody asked for.

   ---- 2. the scene ----
   `Scene` is what layout hands the view: nodes with positions, links between
   them, nothing else. `MapNode` is a discriminated union on `kind`, so nothing
   downstream needs a cast to read `node.data`.
   ========================================================================= */

import type { SessionBucket } from '@repo/contract'

/** The four things an agent is made of. The ring draws one of them; the zoom draws all four. */
export type KindKey = 'jobs' | 'skills' | 'files' | 'apps'

/**
 * What a job is doing — the wire's own word for it, not a second vocabulary.
 *
 * `SessionBucket` is a column on the row and the prefix of the index every list
 * pages by, so importing it here is what keeps the chain unbroken from the index
 * key to the CSS tone. A fifth UI state would need a fifth index behind it, and
 * that is the point: it cannot be added here alone.
 */
export type JobState = SessionBucket
export type AppState = 'connected' | 'available'

/** Every state the map has a rank and a tone for. */
export type ItemState = JobState | AppState | 'idle'

/** Colour is answered on two axes and they never mix — see palette.ts. */
export type Tone = 'alert' | 'live' | 'ok' | 'offer' | 'muted'

/** The most urgent state among a node's children, and how many are in it. */
export type Attention = { top: ItemState | null; n: number }

/** The mark a badge draws. One per meaning, so tone is never the only cue. */
export type BadgeGlyph = 'ask' | 'spin' | 'dot' | 'plus' | 'none'

/** Four buckets, not six: six file colours is a legend, not a map. */
export type FileFamily = 'text' | 'table' | 'code' | 'media'

/* A few fields here are never drawn on the ring. They are on the contract
   because the zoom reads the same records the ring does — but they are only
   ever asked for what the wire already has, so they are optional. */
export type Job = {
  id: string
  title: string
  when: string
  state: JobState
  /* Work that landed while this reader was away. Orthogonal to `state` on
     purpose — a finished job can be unread and a running one can be read — so
     it is a second field rather than a sixth state. */
  unread: boolean
  /**
   * When it last moved. Carried, not drawn — `when` is the phrased version and
   * is what any caption uses.
   *
   * It exists because "open the latest" is a question about recency that no
   * reading order answers: the groups are ordered by what is most *actionable*,
   * so a job scheduled yesterday outranks one that finished a minute ago.
   * Optional like the rest of the carried fields, so a fixture may leave it out
   * and fall back to reading order.
   */
  updatedAt?: number
  /** the sub-agent that owns it. Carried, not drawn. */
  sub?: string
  step?: string
  progress?: number
  /** when the clock is due to go off, already phrased */
  wakesIn?: string
  /** set when the sub-agent has come back needing a decision */
  question?: string
  options?: readonly string[]
  /** the skill it was deployed with, if any */
  skill?: string | null
}

export type Skill = {
  id: string
  title: string
  blurb: string
  /** carried, not drawn */
  runs?: number
}

export type FileItem = {
  id: string
  title: string
  kind: string
  /** a folder has none, and "0 B" would be a worse answer than nothing */
  size?: string
  when: string
  /** a folder opens as a folder, and never claims a byte count */
  folder?: boolean
  /** carried, not drawn */
  body?: string
}

export type AppItem = {
  id: string
  title: string
  when: string
  state: AppState
  /**
   * Where the app's own artwork is served, when it ships any.
   *
   * A URL rather than a drive path: the map draws it and nothing more, exactly
   * as it takes Duet's mascot as a `src`. What is absent stays absent — an app
   * with no icon is drawn as its initials rather than as a broken image.
   */
  icon?: string
}

/**
 * One account the drive is connected through.
 *
 * It reuses the state axis rather than carrying a vocabulary of its own: a
 * connection that is live is the resting case and wears nothing, one still
 * being set up is `running`, and one that has broken is `asking`, because that
 * is exactly what it is — work that has stopped and wants you. Colouring it any
 * other way would put a third palette on a map that has two.
 */
export type IntegrationItem = {
  id: string
  title: string
  /** the provider's own slug, which is what the catalogue calls it */
  provider: string
  state: Extract<ItemState, 'connected' | 'running' | 'asking'>
  /** the provider's mark, when it has one on the wire */
  logoUrl?: string
}

export type Agent = {
  id: string
  name: string
  /**
   * The seed the generated face is drawn from — the agent's slug, which is what
   * every other surface in the product already keys an avatar on
   * (`agentIdentityFromProfile` in sessions/session-agent.ts).
   *
   * Carried on the record rather than picked per surface, because the rail and
   * the ring draw the same agent side by side in one grid: seed them from two
   * different fields and the reader gets two different robots for one agent on
   * one screen. The map used to seed from `name` here and the rail from `id`,
   * so the same agent had three faces across the product and a rename silently
   * gave it a fourth.
   */
  avatarKey: string
  /**
   * The smaller line under the name — in practice the slug, for an agent whose
   * owner has given it a name of its own.
   *
   * Presentation, not identity: the slug the *router* travels on is in
   * `WorkspaceMap.routes`, and this is a line a face wears. Absent means there
   * is no second line, which is how an unnamed agent — whose name already is
   * its slug — avoids saying the same word twice.
   */
  subtitle?: string
  /** built in, and not removable */
  locked?: boolean
  /** the URL this agent's own custom icon is served at, absent means the generated face */
  icon?: string
  /** what its chat put to work. The face wears the most urgent of these. */
  jobs: readonly Job[]
  /**
   * This owner's own conversation, as a set of at most one.
   *
   * A set rather than a boolean or an optional record so the numeral it
   * produces has the same producer every other numeral on this map has —
   * `unreadCount` — and so "an owner has exactly one default chat" stays a fact
   * about the data rather than a `Math.min(1, …)` in a component that anyone
   * can raise. Absent means the owner's pointer names nothing, or the read
   * that answers it has not answered; both draw nothing.
   *
   * Deliberately *not* in `jobs`. The list a Jobs seat opens — Work's, since
   * Build stopped holding one — excludes this conversation, so counting it there
   * would put a numeral on a door with nothing behind it, which is exactly the
   * defect this field exists to close.
   */
  chat?: readonly Job[]
  /** what it can reach — the only one of the four the ring draws */
  apps: readonly AppItem[]
}

/** What the centre is drawn as: a name, and what it says the drive holds. */
export type CoreKnowledge = {
  label: string
  meta: string
}

export type MapData = {
  /**
   * Duet, in the same shape a ring agent comes in.
   *
   * The centre is not an abstraction with a caption on it — it is the drive
   * itself, and the apps no agent claimed are its own. It names the core and
   * carries a fan there exactly as a face on the ring does, so "the apps you
   * have" is one question with one answer wherever it is asked.
   */
  duet: Agent
  /** the caption under the core: what it says the drive holds, already phrased */
  coreMeta: string
  agents: readonly Agent[]
}

/** The union of everything the state vocabulary can be asked about. */
export type LeafItem = Job | Skill | FileItem | AppItem | IntegrationItem

/* --------------------------------------------------------------- the scene
   Everything below is the contract between layout and the view. A host never
   touches it — `KnowledgeMap` takes `MapData` and reports what was clicked,
   both of which are above this line. */

export type Vec = { x: number; y: number }

/** A box in world units. Node sizes are local; obstacles are absolute. */
export type Box = { x0: number; y0: number; x1: number; y1: number }

type NodeBase = {
  id: string
  pos: Vec
  /** new nodes are born at their parent's position, so they grow out of it */
  parent?: string
}

/* The centre carries its agent as well as its knowledge: Duet is an owner like
   any face, with a conversation of its own, and the numeral rule reaches it for
   the same reason it reaches everyone else. A rule with one exception is two
   rules. */
export type CoreNode = NodeBase & { kind: 'core'; data: CoreKnowledge; agent: Agent }

export type AgentNode = NodeBase & { kind: 'agent'; data: Agent }

/**
 * How wide this node's caption may be, in world units.
 *
 * A seat in a fan of four has its neighbours' captions either side of it and
 * gets the pitch between them; the only app an agent has gets the whole width
 * the layout was going to leave empty anyway. Solved where the seats are laid
 * out, because that is the only place that knows how many there are — and read
 * twice from there: once to budget the words, once to size the box the camera
 * frames, so the two can never disagree about how much room a name takes.
 */
type Captioned = { room: number }

/** One app an agent can reach. Since the fan lost its chips, this is the fan. */
export type AppNode = NodeBase & Captioned & { kind: 'app'; agent: Agent; data: AppItem }

/** The apps that did not fit. It carries the count it stands for, never a total. */
export type MoreNode = NodeBase & Captioned & { kind: 'more'; agent: Agent; count: number }

/**
 * The one seat that grows the ring.
 *
 * It used to be two — this, and a `create` satellite on a dashed limb beside it
 * — because there are two ways to fill it: hire an agent that already exists,
 * or write one from nothing. Both are still there; the fork just moved off the
 * canvas and into the dialog this opens. A map is a picture of what a drive
 * *holds*, and a seat drawn twice was the map spending arc, radius and a second
 * caption on a question nobody has asked yet when they point at it.
 */
export type AddNode = NodeBase & { kind: 'add'; count: number }

/**
 * An agent's work in flight: a seat in its fan, and the jobs hanging off it.
 *
 * `JobsNode` sits in the same row as the apps — the agent's own level — and the
 * jobs are the map's only grandchildren, in a second row below it. They carry
 * no captions of their own: a job title needs about eight characters at any
 * pitch that row can afford, and eight characters of a title is not a title.
 * What they say, they say by their state and by being there.
 */
export type JobsNode = NodeBase &
  Captioned & {
    kind: 'jobs'
    agent: Agent
    /**
     * Where this seat stands, in the terms its own second row needs: the bearing
     * of the agent it belongs to, and how far along the tangent the seat sits.
     *
     * Carried for the same reason `room` is — solved where the seats are laid
     * out, because that is the only place that knows — and read by `openBranch`,
     * which re-places the second row without rebuilding the first. Recovering
     * either by inverting a position would be a second derivation of a number the
     * layout already computed, and two derivations drift.
     */
    deg: number
    along: number
  }

/**
 * Whether this node is inside the branch the reader has opened.
 *
 * At rest a job is a dot four pixels across, which is honest — it is one of
 * twenty agents' worth of work seen from the whole drive, and a title would be
 * five characters of one. Opened, the same node is a row with its title beside
 * it, and the camera is standing close enough to read it.
 */

export type JobNode = NodeBase & Captioned & { kind: 'job'; agent: Agent; data: Job }
/** The work that did not fit. It never says how much: the read is capped. */
export type JobsMoreNode = NodeBase & Captioned & { kind: 'jobsMore'; agent: Agent }

export type MapNode =
  | CoreNode
  | AgentNode
  | AppNode
  | MoreNode
  | AddNode
  | JobsNode
  | JobNode
  | JobsMoreNode

/** A trunk joins the core to an agent; a limb joins an agent to one of its apps. */
type LinkKind = 'trunk' | 'limb'

export type Link = {
  from: string
  to: string
  kind: LinkKind
  /** the add slot's trunk, which is drawn dashed */
  dashed?: boolean
  /**
   * the agent on the far end has a session in flight, so the line carries a
   * pulse out to it — see `live.ts` for what counts, and note that this is a
   * different question from the badge's: attention surfaces one state and this
   * is true alongside all of them
   */
  live?: boolean
}

/** Solved once per render from the head count — see layout.ts. */
export type Ring = {
  agent: number
  /** the radius the app nodes hang at */
  fan: number
  step: number
  /** the bearing the first slot starts at — half a step, so nothing is on an axis */
  phase: number
  /** world units between two app nodes on the same agent */
  pitch: number
  /** …and between two jobs, solved from the arc the row actually has */
  jobPitch: number
  /** whether that room can hold a title. If not, the row draws dots. */
  jobTitles: boolean
  /** past seven agents the secondary labels are noise */
  dense: boolean
  /**
   * past fifteen agents the fans themselves are noise, and the arc they needed
   * comes back to the ring.
   *
   * The radius grows linearly with the head count, so everything hanging off an
   * agent is a constant the camera pays for at every fleet size. Past this the
   * ring spends that budget on the faces instead: twenty agents draws at 49px
   * with the fans dropped, against 33px with them — and 33px is already below
   * the map's own caption floor.
   */
  crowded: boolean
}

export type Scene = {
  nodes: readonly MapNode[]
  links: readonly Link[]
  byId: ReadonlyMap<string, MapNode>
  geom: Ring
}
