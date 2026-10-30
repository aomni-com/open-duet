/* ============================================================================
   One recipe per node kind. React owns what exists here — which nodes, their
   text, their state classes. It does not own *where* they are: positions are a
   transform written by the motion loop, because sixty nodes re-rendering sixty
   times a second is the one thing a reconciler should never be asked to do.

   `MapNode` is a discriminated union, so the switch below cannot miss a kind,
   and there is not a cast in this file.
   ========================================================================= */
import { memo } from 'react'

import { CoreField } from './core-field'
import { agentIsLive, liveWork, pulseStyle } from './live'
import { AgentFace, AppTile, Badge, KindMark, LiveMark, UnreadDot } from './map-glyphs'
import {
  AGENT_NAME_Y,
  AGENT_SUB_Y,
  agentCaptionRoom,
  APP_LABEL_Y,
  AVATAR_SIZE,
  charsIn,
  CORE_AVATAR_SIZE,
  CORE_LABEL_Y,
  CORE_META_Y,
  CORE_AVATAR_Y,
  drawnSubtitle,
  M,
  tileRadius,
  TYPE,
} from './metrics'
import { isSilent, meaningOf, stateOf, toneOf } from './palette'
import type {
  AgentNode,
  AppNode,
  CoreNode,
  JobNode,
  JobsMoreNode,
  JobsNode,
  MapNode,
  MoreNode,
} from './types'
import { hasUnread } from './unread'

/**
 * A caption, cut to the room it was given.
 *
 * `room` is world units, never a character count: the layout is the only thing
 * that knows how much space a seat has, and the budget it implies falls out of
 * that plus the size the caption is set in. Two hand-tuned numbers used to
 * stand in for it — 18 characters for an agent and 13 for an app — which cut
 * `research-assistant5` and `Research Board` in half on a window with room for
 * three of each.
 */
function fit(text: string | number | undefined, room: number, size: number): string {
  const s = String(text ?? '')
  const max = charsIn(room, size)
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

/**
 * Everything a node needs that is not the node.
 *
 * `say` is the map's copy, already translated by the component above. It is on
 * the context rather than read per node because `MapNodeView` is memoised, and a
 * hook inside it would be one more reason for sixty subtrees to re-render.
 */
export type NodeWords = {
  addAgent: string
  more: (count: number) => string
  openAgent: (name: string) => string
  /** the same sentence, for an agent that has sessions in flight */
  openLiveAgent: (name: string, count: number) => string
  openApp: (title: string) => string
  /** the word on the Jobs seat */
  jobs: string
  /** the row that stands for the work that did not fit */
  moreJobs: string
  /** the whole list, for one agent */
  openJobs: (name: string) => string
  /** one job in flight */
  openJob: (title: string) => string
}

export type NodeContext = {
  /** past seven agents the secondary labels hide */
  dense: boolean
  /** past fifteen the fans go too, and the names get a tighter slot */
  crowded: boolean
  /** whether a job row has the room to name its jobs — solved by the ring */
  jobTitles: boolean
  /** the built-in mascot, supplied by the host so the map ships no assets */
  duetAvatarSrc: string
  say: NodeWords
}

type MapNodeViewProps = {
  node: MapNode
  ctx: NodeContext
  className: string
  registerRef: (el: SVGGElement | null) => void
  onHit: (node: MapNode) => void
  onHover: (node: MapNode | null) => void
}

/*
 * One node, memoised.
 *
 * The map re-renders whenever you point at something, and without this every
 * one of sixty-odd nodes rebuilt its whole subtree to change a class name on one
 * of them. Memoised, a hover re-renders only the handful whose emphasis actually
 * changed.
 *
 * That is also why `ctx` and the callbacks are required to be stable: this
 * component is only as good as its props' identity.
 */
export const MapNodeView = memo(function MapNodeView({
  node,
  ctx,
  className,
  registerRef,
  onHit,
  onHover,
}: MapNodeViewProps) {
  return (
    <g
      ref={registerRef}
      className={className}
      tabIndex={0}
      role="button"
      aria-label={nodeLabel(node, ctx)}
      {...nodeDataAttributes(node)}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        onHit(node)
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        onHit(node)
      }}
      onMouseEnter={() => onHover(node)}
      onMouseLeave={() => onHover(null)}
      /* Tabbing onto a face is pointing at it. Everything hover brings back —
         the captions on this agent's own apps, the card on a working one — is a
         picture of what you have arrived at, and a keyboard is no reason to be
         shown less of it. */
      onFocus={() => onHover(node)}
      onBlur={() => onHover(null)}
    >
      <MapNodeBody node={node} ctx={ctx} />
    </g>
  )
})

function MapNodeBody({ node, ctx }: { node: MapNode; ctx: NodeContext }) {
  switch (node.kind) {
    case 'core':
      return <CoreBody node={node} ctx={ctx} />
    case 'agent':
      return <AgentBody node={node} ctx={ctx} />
    case 'app':
      return <AppBody node={node} />
    case 'more':
      return <MoreBody node={node} ctx={ctx} />
    case 'add':
      return <AddBody ctx={ctx} />
    case 'jobs':
      return <JobsBody node={node} ctx={ctx} />
    case 'job':
      return <BeadBody node={node} ctx={ctx} />
    case 'jobsMore':
      return <BeadMoreBody node={node} ctx={ctx} />
  }
}

/* Duet stands on the core, because that is where Duet lives: not one more face
   on the ring but the one that answers for everything inside the sphere. The
   face is drawn after the cloud and half over its edge — behind it would put a
   drawing inside a point cloud, and beside it would make Duet an agent. */
function CoreBody({ node, ctx }: { node: CoreNode; ctx: NodeContext }) {
  return (
    <>
      <circle r={M.CORE_GLOW_R} fill="url(#km-core-glow)" className="km-core-disc" />
      <circle r={M.CORE_R} className="km-core-rim" />
      {/* After the disc, never before it. The glow is opaque at its edges, so a
          cloud painted underneath loses its outer half — which is why the core
          read as a small dense clump instead of a sphere. */}
      <CoreField />
      <g className="km-core-face" transform={`translate(0,${CORE_AVATAR_Y})`}>
        {/* Duet's tile, which is one rect like every other face on the map. It
            used to be a face inside a plate four units bigger and forty per cent
            rounder, so the two corners crossed: the white ring was a band down
            the flat edges and nothing at all at the corners, where Duet's own
            corner escaped past it. */}
        <AgentFace
          id="core"
          avatarKey={node.agent.avatarKey}
          src={ctx.duetAvatarSrc}
          size={CORE_AVATAR_SIZE}
          plate="km-core-plate"
        />
        {/* Inside the face group, so it hangs off Duet's own plate rather than
            off the glow — the centre is an owner like any face, and the rule
            reaches it for the same reason it reaches everyone else. The plate,
            not an offset: where the dot sits on it is `unreadDotOffset`. */}
        {hasUnread(node) && <UnreadDot plate={CORE_AVATAR_SIZE} />}
      </g>
      <text y={CORE_LABEL_Y} textAnchor="middle" className="km-label km-core-label">
        {node.data.label}
      </text>
      <text y={CORE_META_Y} textAnchor="middle" className="km-meta">
        {node.data.meta}
      </text>
      <circle r={M.CORE_GLOW_R} className="km-hit" />
    </>
  )
}

function AgentBody({ node, ctx }: { node: AgentNode; ctx: NodeContext }) {
  const agent = node.data
  const subtitle = drawnSubtitle(agent, ctx)
  return (
    <>
      <AgentFace
        id={agent.id}
        avatarKey={agent.avatarKey}
        src={agent.icon}
        size={AVATAR_SIZE}
        plate="km-agent-disc"
      />
      {/* Working, which is not the same question as the badge's. Attention
          surfaces one state, so an agent stuck on a question has already spent
          its badge and says nothing about the two sessions it is running
          underneath. This is true alongside every badge rather than instead of
          one, and it is drawn on the plate rather than off its corner so the two
          never compete for the same piece of the face.

          After the face, not before it: the tile fills its own plate now, so a
          rim struck underneath would be a rim behind an opaque drawing. */}
      {agentIsLive(agent) && <LiveMark beat={pulseStyle(agent.id)} />}
      {/* The name is always underneath, wherever the agent stands on the ring —
          the lines that would have crossed it start below it instead. */}
      <text y={AGENT_NAME_Y} textAnchor="middle" className="km-label">
        {fit(agent.name, agentCaptionRoom(ctx), TYPE.t2)}
      </text>
      {/* …and under that, what the rest of the product calls this agent. Only
          for an agent somebody has named: an unnamed one is already wearing its
          slug on the line above, and a drive full of faces saying the same word
          twice is what this line would be by default. `drawnSubtitle` is also
          what the box was struck from — see `size()`. */}
      {subtitle !== undefined && (
        <text y={AGENT_SUB_Y} textAnchor="middle" className="km-agent-sub">
          {fit(subtitle, agentCaptionRoom(ctx), TYPE.t4)}
        </text>
      )}
      {/* No *state* badge. It used to roll this agent's most urgent job state up
          onto its face, and that was the right drawing while the jobs themselves
          were not on the map — a coral dot on a portrait was the only way to
          know anything was asking.

          Now the work is drawn: a Jobs seat in the row below, with one node per
          job wearing its own state. A state badge on the face is the same fact a
          third time, in the one place with no room to say which job it is
          about, and past seven agents it degrades to an unlabelled coloured dot
          sitting on somebody's portrait. The rim above still says the agent is
          *working*, which is a different question and one the row cannot answer
          at a glance.

          What the face *does* wear is the numeral below, and it is not that
          rejected badge coming back by another name. That one stood for N jobs
          and could not say which; this one stands for exactly one conversation —
          the owner's own chat, the thing this face's own click opens — so the
          "which one" question cannot arise. The work's unread is next door on
          the seat, counted from a list this chat is deliberately not in.

          The dot straddles the plate's edge rather than sitting inside it, the
          way the seat's own marks do — its centre lands *on* the corner, so
          half the disc is on the map's pale ground instead of buried in the
          portrait. That is `unreadDotOffset`'s doing and not this call site's:
          it used to be a hand-tuned 26 here and a different hand-tuned number
          at the centre, which is exactly how the two faces came to draw the
          mark differently. The dot reaches ~34.4 units against the box `size()`
          already reserves at 40, so the camera still pays nothing for it. */}
      {hasUnread(node) && <UnreadDot plate={AVATAR_SIZE} />}
      <rect
        x={-M.AGENT_HIT}
        y={-M.AGENT_HIT}
        width={M.AGENT_HIT * 2}
        height={M.AGENT_HIT * 2}
        className="km-hit"
      />
    </>
  )
}

/* One app, as its own icon on a rounded square — and its initials when it has
   no icon. It is deliberately the same body as the chips it replaced: an app is
   a place you can go, not a document, so it is a mark and a name rather than a
   row with a size and a timestamp. */
function AppBody({ node }: { node: AppNode }) {
  const state = stateOf(node.data)
  return (
    <>
      <AppTile id={node.id} title={node.data.title} icon={node.data.icon} r={M.APP_R} />
      {/* Always drawn, hidden by density rather than by absence: pointing at an
          agent brings its own names back, and a node React removed cannot come
          back without a re-render. */}
      <text y={APP_LABEL_Y} textAnchor="middle" className="km-app-label">
        {fit(node.data.title, node.room, TYPE.t3)}
      </text>
      {/* Only the offer wears a mark. A connected app is the resting state, and a
          tick on every one of them is a dashboard rather than a map. */}
      {!isSilent(state) && (
        <g transform="translate(16,-16)">
          <Badge tone={toneOf(state)} glyph={meaningOf(state).glyph} r={8} />
        </g>
      )}
      <circle r={M.APP_HIT} className="km-hit" />
    </>
  )
}

/* The apps that did not fit. It counts what it is hiding rather than the total,
   because "+2" beside three drawn apps is the only reading that adds up. */
function MoreBody({ node, ctx }: { node: MoreNode; ctx: NodeContext }) {
  return (
    <>
      {/* The same tile as the apps it stands for, empty: a count in the shape of
          the things being counted. */}
      <rect
        x={-M.APP_R}
        y={-M.APP_R}
        width={M.APP_R * 2}
        height={M.APP_R * 2}
        rx={tileRadius(M.APP_R * 2)}
        className="km-app-edge km-more-edge"
      />
      <text y={5} textAnchor="middle" className="km-app-mono">
        +{node.count}
      </text>
      <text y={APP_LABEL_Y} textAnchor="middle" className="km-app-label">
        {fit(ctx.say.more(node.count), node.room, TYPE.t3)}
      </text>
      <circle r={M.APP_HIT} className="km-hit" />
    </>
  )
}

/* The slot an agent will stand in, so it is drawn as an empty one: the same
   square at the same corner *ratio* as the faces it will sit beside. It used to
   borrow the agent tile's radius outright, which is a different curve on a
   smaller square — the one shape on the ring that did not match its family. */
function AddBody({ ctx }: { ctx: NodeContext }) {
  return (
    <>
      <rect
        x={-M.ADD_R}
        y={-M.ADD_R}
        width={M.ADD_R * 2}
        height={M.ADD_R * 2}
        rx={tileRadius(M.ADD_R * 2)}
        className="km-add-disc"
      />
      <path d="M-13 0 L13 0 M0 -13 L0 13" className="km-add-plus" />
      <text y={60} textAnchor="middle" className="km-label km-add-label">
        {fit(ctx.say.addAgent, agentCaptionRoom(ctx), TYPE.t2)}
      </text>
      <rect
        x={-M.AGENT_HIT}
        y={-M.AGENT_HIT}
        width={M.AGENT_HIT * 2}
        height={M.AGENT_HIT * 2}
        className="km-hit"
      />
    </>
  )
}

/* One agent's work in flight, on the agent's own spoke: a hub against the face
   and the beads strung back toward the drive.

   No caption on any of them. A caption hangs *below* a node in screen space,
   and for every agent on the lower half of the ring "below" is straight down
   the spoke — through the beads. What a bead says, it says by being there. */
/* The seat is organisational, and that is the whole of it: it says this agent
   has work and it opens the list. It wears no mark at all.

   It used to wear two — a roll-up of the most urgent job state, and a count of
   the unread among them — and both are gone deliberately. A roll-up on a seat
   is a summary of a list, in the one place with no room to say which row it is
   summarising; the dialog the seat opens holds that list properly, per row, with
   the title beside each. Two marks arguing for attention on a node whose only
   job is to be a door was the map answering a question it had no room to answer.

   What survives on the ring is the beads: one node per job, each carrying its
   own state as tone. That is the map's own idiom — rows, not counts — and it is
   why the seat needs to say nothing on their behalf. */
function JobsBody({ node, ctx }: { node: JobsNode; ctx: NodeContext }) {
  return (
    <>
      {/* The same plate the apps beside it wear, at the same corner ratio. They
          share a row, so they share a body: a circle among rounded tiles reads
          as a different kind of object rather than as the seat next door. What
          tells them apart is the mark and the hue, which is the whole point of
          the kind axis. */}
      <rect
        x={-M.APP_R}
        y={-M.APP_R}
        width={M.APP_R * 2}
        height={M.APP_R * 2}
        rx={tileRadius(M.APP_R * 2)}
        className="km-app-disc"
      />
      <KindMark kind="jobs" size={20} />
      <text y={APP_LABEL_Y} textAnchor="middle" className="km-app-label">
        {fit(ctx.say.jobs, node.room, TYPE.t3)}
      </text>
      <circle r={M.APP_HIT} className="km-hit" />
    </>
  )
}

/* One job: a dot, or a node with its title under it.

   Which of the two is not a decision this component makes. `ctx.jobTitles` is
   solved by the ring from the arc the row actually got, and `node.open` is the
   reader's. A title is either readable or it is not drawn — five characters of
   "Q3 revenue reconciliation" is not a shorter title, it is a different and
   wrong one.

   Note this is React removing the caption, where an app's is always rendered
   and hidden by density in CSS. The difference is deliberate and it is not
   symmetry for its own sake: an app's caption comes *back* when you point at
   its agent, so it has to stay in the DOM. A job's cannot come back — the room
   it would need is the room the arc did not have, and five titles revealed on
   hover at twenty-seven units of pitch is one illegible smear. Absence is the
   honest answer here and hiding is the honest answer there. */
function BeadBody({ node, ctx }: { node: JobNode; ctx: NodeContext }) {
  const titled = ctx.jobTitles
  return (
    <>
      {/* Work that landed while you were away, drawn as a ring *around* the
          bead rather than as a mark beside it.

          Beside is not available: a bead is about five pixels of ink at twenty
          agents, and a second dot hung off one would be smaller than a pixel and
          would land on its neighbour in the same tangent row. And colour is
          already spoken for — the bead's fill is its state, so tinting it for
          unread would be two meanings on one hue, which is the reading the map
          killed a reserved tone over.

          So unread is a change to the bead itself, a ring in the same unread
          hue the agent's own dot and every sidebar's unread mark use. Where a
          dot fits, unread is a dot; on a bead, which a dot cannot hang off,
          it is a ring. One hue either way. */}
      {node.data.unread && (
        <>
          {/* A hair of the page's own ground between the bead and its ring.
              Without it the ring sits directly on the fill, and on an *asking*
              bead — rust, the one hue closest to amber on the wheel — the two
              blur into a single smudge. That is the pair this had to survive,
              because an asking job you have not read is the most urgent thing
              the ring can draw. Separation is the mark's own, exactly as it is
              for the dot on a face. */}
          <circle r={M.BEAD_R + 1.75} className="km-bead-unread-gap" />
          <circle r={M.BEAD_R + 3.5} className="km-bead-unread" />
        </>
      )}
      <circle r={M.BEAD_R} className="km-bead" />
      {titled && (
        <text y={20} textAnchor="middle" className="km-job-label">
          {fit(node.data.title, node.room, TYPE.t3)}
        </text>
      )}
      <circle r={M.BEAD_HIT} className="km-hit" />
    </>
  )
}

/* The work that did not fit. It draws a mark, never a number: the ring's job
   read is drive-wide and capped at thirty rows, so any count here would be a
   floor presented as a total. */
function BeadMoreBody({ node, ctx }: { node: JobsMoreNode; ctx: NodeContext }) {
  const titled = ctx.jobTitles
  return (
    <>
      <circle r={0} className="km-bead km-bead-more-disc" />
      <path d="M-6 0 L6 0 M0 -6 L0 6" className="km-bead-more" />
      {titled && (
        <text y={20} textAnchor="middle" className="km-job-label km-job-label-more">
          {fit(ctx.say.moreJobs, node.room, TYPE.t3)}
        </text>
      )}
      <circle r={M.BEAD_HIT} className="km-hit" />
    </>
  )
}

/** The data attributes CSS keys colour off. One name for one idea. */
function nodeDataAttributes(node: MapNode): Record<string, string> {
  const attrs: Record<string, string> = { 'data-node': node.kind }
  switch (node.kind) {
    case 'app':
      attrs['data-kind'] = 'apps'
      attrs['data-tone'] = toneOf(stateOf(node.data))
      break
    case 'more':
      attrs['data-kind'] = 'apps'
      break
    case 'jobs':
    case 'jobsMore':
      attrs['data-kind'] = 'jobs'
      break
    case 'job':
      attrs['data-kind'] = 'jobs'
      attrs['data-tone'] = toneOf(stateOf(node.data))
      break
    case 'agent':
      if (node.data.locked) attrs['data-locked'] = ''
      /* What the peek card hangs off, and what a test can ask the ring without
         reading a fill colour off a rect. */
      if (agentIsLive(node.data)) attrs['data-live'] = ''
      break
  }
  return attrs
}

/** What a screen reader is told: what it does, not what it is. */
function nodeLabel(node: MapNode, ctx: NodeContext): string {
  switch (node.kind) {
    case 'core':
      return ctx.say.openAgent(node.data.label)
    case 'agent': {
      /* The rim and the pulse are drawn for a reader who can see them, and the
         card that explains them only opens for a reader who can point at them.
         The label is where the same fact is stated for everyone else. */
      const live = liveWork(node.data).jobs.length
      return live > 0
        ? ctx.say.openLiveAgent(node.data.name, live)
        : ctx.say.openAgent(node.data.name)
    }
    case 'app':
      return ctx.say.openApp(node.data.title)
    case 'more':
      /* Two sentences: what it stands for, and what clicking it does. It opens
         the agent, where the whole list is, so it says so rather than promising
         a screen of its own that does not exist. */
      return `${ctx.say.more(node.count)}. ${ctx.say.openAgent(node.agent.name)}`
    case 'add':
      return ctx.say.addAgent
    case 'jobs':
      return ctx.say.openJobs(node.agent.name)
    case 'job':
      return ctx.say.openJob(node.data.title)
    case 'jobsMore':
      return ctx.say.openJobs(node.agent.name)
  }
}
