/* ============================================================================
   How big everything is, and where a line leaving it should start.

   These numbers are load-bearing twice over: the camera solves a scale that
   fits the union of `size()`, and the edge router trims to `rim()`. They used
   to be stated in both places and copied by hand into a third — change
   `AGENT_R` and trunks would start drawing through the avatar. Now `rim()` is
   derived from `size()`, and every drawn dimension comes from `M`.

   No DOM in here on purpose: the geometry has to stay callable from a test.
   ========================================================================= */
import type { Agent, Box, FileFamily, MapNode } from './types'

/** One place for every measurement the map is built out of. */
export const M = {
  CORE_R: 104,
  CORE_GLOW_R: 118,
  /** the core's caption hangs below the disc; the box has to include it */
  CORE_CAP_Y: 178,
  AGENT_R: 34,
  AGENT_HIT: 38,
  /**
   * One seat in an agent's row — an app it can reach, the node counting the
   * apps it is not showing, or its work in flight. One size for all three,
   * because they stand in the same row: a seat that measured itself differently
   * from the seat beside it would be a seat the collision test and the edge
   * router both had the wrong number for.
   */
  APP_R: 22,
  APP_HIT: 30,
  ADD_R: 30,
  /** One job in the second row. The hit area is what a pointer needs, not the ink. */
  BEAD_R: 5,
  BEAD_HIT: 15,
  /** …and once its branch is open and the camera has come in to read it */
} as const

/**
 * Air inside the hole the unfolded surface leaves for the face, as a share of
 * the hole's short side.
 *
 * Tighter than the ring's own nine per cent: the hole is small, and the same
 * share of a small hole would leave the face at half the size the name beside it
 * is set at. It lives here rather than with the surface because it is a fact
 * about `bodyBox` — it is the clearance between what the camera flies in and
 * whatever the surface laid out around the gap.
 */
export const WELL_MARGIN = 0.05

/** Room for one agent tile and its name. The ring solves its radius from this. */
export const ARC_PER_SLOT = 214

/**
 * …and room for a tile alone, once the ring has stopped drawing fans.
 *
 * The arc is sized to hold two neighbouring *fans* apart, not two faces — at
 * 150 a pair of four-seat fans overlap before their discs are even counted. So
 * tightening the arc and dropping the fan are one decision, not two, and both
 * live behind `Ring.crowded`.
 */
export const ARC_PER_SLOT_CROWDED = 150

/**
 * How far past its plate a working agent's live flare swells, as a ratio.
 *
 * The one thing an agent paints outside its own tile. It used to be the badge
 * that reached furthest and this number was derived from *that* reserve; the
 * badge is gone — an agent's work is drawn as its own nodes now — and the flare
 * is what is left, so the reserve is struck from the flare instead.
 *
 * ⚠️ Stated twice and it has to be: `@keyframes km-flare` in the stylesheet
 * scales to this and CSS cannot read a TypeScript constant. Both sides name the
 * other. Move one without the other and the flare paints past the hole the
 * unfolded surface leaves for the face, landing on the row of doors beside it —
 * which is a thing every centre-to-centre check calls clean.
 */
export const FLARE_REACH = 1.16

/** Clear air between a node's own paint and the line leaving it. */
const RIM_GAP = 8

/* The repo's radius canon, in world units. `--radius` is 0.625rem = 10px, and
   the tiers are derived from it in tailwind.config.ts. Controls are `md`,
   tiles and rows are `lg`, panels are `xl`. The map draws in the same units at
   scale 1, so it uses the same numbers rather than inventing near-misses. */
export const RADIUS = { sm: 6, md: 8, lg: 10, xl: 14 } as const

/** The product's avatar corner, `rounded-[28%]` in identity-avatar.tsx. */
export const AVATAR_RADIUS = 0.28

/**
 * The corner of a square node of this size.
 *
 * A ratio, so every squarish thing on the map — a face, Duet's tile, the empty
 * slot that will become one — curves the same *amount* rather than by the same
 * number of units. A radius copied from a node of another size is a near-miss,
 * and near-misses are what make two rounded rects beside each other look like a
 * mistake instead of a family.
 */
export function tileRadius(size: number): number {
  return size * AVATAR_RADIUS
}

/**
 * Where the unread dot's centre sits on a plate of this size: the 45° point on
 * the plate's own corner, along each axis from the node's centre.
 *
 * ---- why this is a function and not two numbers ----
 * It was two numbers. Each draw site hand-tuned an inset against its own plate
 * — 26 on an agent's 68, 28 on Duet's 76 — which is 0.765 and 0.737 of their
 * half-sizes against a corner that sits at 0.836 for both. So neither dot was
 * on the corner, and they missed it by *different* amounts: the agent's
 * straddled the edge, Duet's was very nearly swallowed by the plate. One
 * component drawing the disc could not save them, because what the two sites
 * disagreed about was the geometry, not the glyph.
 *
 * ---- the geometry ----
 * A plate is a rounded square, so its 45° edge is a point on the corner *arc*
 * rather than on a circle: the arc's centre is `tileRadius` in from each side,
 * and the point is `tileRadius / √2` back out along the diagonal. Which makes
 * the whole thing one ratio of `size`, so the dot's centre lands on the edge at
 * every scale and exactly half the disc is on the plate — the same relationship
 * on a 24-unit plate as on a 512-unit one, with no new constant to tune.
 */
export function unreadDotOffset(size: number): number {
  const corner = tileRadius(size)
  return size / 2 - corner + corner * Math.SQRT1_2
}

/**
 * The face, which *is* the agent plate rather than a smaller tile inside it.
 *
 * It used to be 54 in a 68 plate: two rounded rects, seven units apart, each
 * with a stroke of its own. Two borders around one object read as a sticker
 * peeling off its backing — and the corners could only agree while a derived
 * radius held them together, which the core's never did. One rect cannot
 * disagree with itself, so there is now one, at the product's own avatar
 * corner, exactly as `IdentityAvatarFrame` draws a face everywhere else.
 */
export const AVATAR_SIZE = M.AGENT_R * 2

/**
 * Duet's face, and where it stands.
 *
 * It is bigger than an agent's and it sits astride the top of the sphere rather
 * than beside it: Duet is not a member of the ring, it is the thing the ring is
 * arranged around. Half on and half off the disc is what says "on top of" —
 * centred inside would read as one more decoration in the cloud.
 */
export const CORE_AVATAR_SIZE = 76
/* Dead centre of the sphere. It used to sit a full radius up, which read as a
   badge perched on the rim rather than as Duet living on the core knowledge. */
export const CORE_AVATAR_Y = 0

/* The caption under a seat in an agent's row — an app, the node counting the
   rest, or Jobs. One number for the three of them: they sit on one line at one
   radius, and a seat whose words sat a pixel off its neighbour's would say the
   row is not a row. */
export const APP_LABEL_Y = 42

/* The two lines under the sphere: the drive's name, and what it holds. Named
   because the loading portrait stands bars where these words will be, and a
   placeholder that copied the numbers is a placeholder that stops matching the
   first time one of them moves. `CORE_CAP_Y` above is where the *box* ends,
   which is below both of them and is a different question. */
export const CORE_LABEL_Y = 148
export const CORE_META_Y = 170

/* The agent tile's corner — the face's own, because the tile is the face. Kept
   as a name rather than inlined because the live rim traces this exact shape,
   and a rim struck from a radius of its own is how one object grows a second
   outline a pixel off the first. */
export const AGENT_PLATE_RADIUS = tileRadius(AVATAR_SIZE)

/* ---- how much of a name fits, and how much room that name then needs ----
   Both questions have to be answered from the same number or the picture and
   the camera disagree: a caption budgeted wider than the box it is framed in
   gets cut off by the edge of the surface, and one budgeted narrower gets cut
   off by an ellipsis with empty space around it. That was the live bug —
   `research-assistan…` and `Research Boa…` on a window with two thirds of its
   width unused. */

/** The type scale, in world units. `knowledge-map.css` restates these as tiers. */
export const TYPE = {
  t1: 21, // the core, and nothing else
  t2: 16, // names: an agent, a card, the add slot
  t3: 13, // labels: a chip, a tile
  t4: 11, // counts and meta, always mono
} as const

/* ---- captions are not part of the scene ----
   Everything else on the map is drawn in world units and scaled by the camera,
   which is right for a picture and wrong for a word: the camera solves whatever
   scale holds the whole drawing, so on a big fleet the smallest thing on the map
   was rendering at a third of the size it was set in and the names became
   texture. A word is either readable or it is not there.

   So the type scale is counter-scaled against the camera, down to a floor and no
   further — below the floor it holds and stops shrinking, which is the whole
   promise. It is one multiplier for all four tiers rather than a floor per tier,
   because the tiers *are* the hierarchy: floors applied separately would
   collapse 21/16/13/11 towards one number exactly when there is most on screen
   to tell apart. */

/** No word on the map is ever drawn smaller than this, in screen pixels. */
export const TEXT_FLOOR = 11

/* How far the correction is allowed to run. A caption held at a fixed screen
   size takes more *world* room the further the camera pulls back, and the room
   it is budgeted against is fixed — so past this the words would start running
   into their neighbours', which is a different way of being unreadable. The map
   drops its secondary captions long before it gets here. */
const MAX_HOLD = 1.9

/**
 * What to multiply the type scale by, given where the camera is.
 *
 * 1 at rest and while flying in — text is allowed to grow with the scene,
 * because that is what going inside something looks like. It only ever fights
 * the camera on the way out.
 */
export function labelScale(cam: number): number {
  if (!(cam > 0)) return 1
  return Math.min(MAX_HOLD, Math.max(1, TEXT_FLOOR / (TYPE.t4 * cam)))
}

/** What the smallest word on the map actually measures, in screen pixels. */
export function smallestText(cam: number): number {
  return TYPE.t4 * cam * labelScale(cam)
}

/* Measured on the product's own face with `getComputedTextLength`, not guessed:
   ordinary mixed-case names run 0.48–0.53 em a character at both sizes the map
   captions in. The wide end is the one to budget against — a name of all caps
   that overruns by a character is caught by the halo the captions are painted
   with, and a name that stops a character early is not. */
const CHAR_EM = 0.53

/** How many characters of `size` fit in `world` units of room. */
export function charsIn(world: number, size: number): number {
  return Math.max(4, Math.floor(world / (size * CHAR_EM)))
}

/** Past seven agents the secondary labels hide, so the boxes shrink with them. */
export type Density = { dense: boolean; crowded?: boolean }

/**
 * The room an agent's own name is given.
 *
 * One slot's worth of arc, less the clear air that keeps two names on
 * neighbouring slots from touching — the ring reserves this much per agent at
 * every fleet size, so it is the honest bound at every fleet size. A dense ring
 * gives up a little of it, because past seven agents the names are the only
 * captions left and they are what the eye has to pick between.
 */
export function agentCaptionRoom(ctx: Density): number {
  if (ctx.crowded === true) return ARC_PER_SLOT_CROWDED - CROWDED_CAPTION_AIR
  return ARC_PER_SLOT - (ctx.dense ? 28 : 6)
}

/* ---- where an agent's own words sit ----
   Stated here rather than in the drawing, because the box below is struck from
   the same numbers: the baseline each line is set on, plus the tail the halo and
   the descenders need under the last of them. */
export const AGENT_NAME_Y = 63
export const AGENT_SUB_Y = 79
const TEXT_TAIL = 11

/**
 * The smaller line under an agent's name — its slug — when the ring has room to
 * read one.
 *
 * One predicate, asked by the drawing and by the box below it, because those
 * are the two halves of the same fact: a line that is drawn without being
 * reserved for is a line every trunk leaving downward is drawn through.
 *
 * A dense ring drops it. Past eight agents the fans have already given up their
 * own captions and the names are the only words left to pick between — a third
 * tier under every face is what the type scale exists to refuse. It is still one
 * click away, on the surface the face unfolds into.
 */
export function drawnSubtitle(agent: Agent, ctx: Density): string | undefined {
  return ctx.dense ? undefined : agent.subtitle
}

/* Why a crowded ring gives up so much more of its slot than a dense one.

   A caption is counter-scaled against the camera (`labelScale`), so the room it
   really needs is its world budget times the hold — and past `MIN_SCALE` the
   hold is nearly two. A crowded ring is also the furthest the camera ever
   pulls back, so it is where the two multiply: 122 units of budget at a hold of
   1.38 is 168 units of ink between neighbours 149 apart, which is two names
   touching. Held to 100, the same name lands inside its own slot.

   This is the cap `MAX_HOLD`'s comment warns about, arriving. It is answered
   here, in the budget, rather than by loosening the hold — a caption that stops
   being counter-scaled stops being readable, which is the worse failure. */
const CROWDED_CAPTION_AIR = 50

/**
 * The box a node actually paints into, in local coordinates, labels included.
 *
 * Add a kind and forget its box and the camera clips it. `MapNode` is a
 * discriminated union so the switch below cannot silently miss one.
 *
 * The bottom edge is read a second time, by `rim()`, as "how far down the words
 * go" — so reserving room below them is not free padding. An agent's box used
 * to end 24 units under the last thing it drew, and every line leaving one
 * downward started that far out in open space, pointing at the node it had
 * already left. Below the disc these are the ink, near enough for the halo the
 * labels are painted with; the horizontal reserve is for the longest name a
 * node of that kind can hold, and stays generous.
 */
export function size(n: MapNode, ctx: Density): Box {
  switch (n.kind) {
    case 'core':
      /* Duet stands above the sphere, so the top of the box is her, not it. */
      return { x0: -176, y0: CORE_AVATAR_Y - CORE_AVATAR_SIZE / 2 - 10, x1: 176, y1: M.CORE_CAP_Y }
    case 'agent': {
      /* The reserve is the caption's room, not a number picked beside it: the
         two used to be set independently and the words outgrew the box. Down to
         the last line this agent actually draws — an agent wearing its slug is
         a line taller than one that is only its name. */
      const half = agentCaptionRoom(ctx) / 2
      const last = drawnSubtitle(n.data, ctx) === undefined ? AGENT_NAME_Y : AGENT_SUB_Y
      return { x0: -half, y0: -40, x1: half, y1: last + TEXT_TAIL }
    }
    case 'app':
    case 'more':
    case 'jobs':
      /* Dense drops the caption entirely, so the box is the disc and nothing
         more; otherwise it is however much room the fan left this seat. */
      return ctx.dense
        ? { x0: -26, y0: -26, x1: 26, y1: 26 }
        : { x0: -n.room / 2, y0: -26, x1: n.room / 2, y1: 58 }
    case 'add':
      return { x0: -62, y0: -52, x1: 62, y1: 68 }
    case 'job':
    case 'jobsMore':
      /* A dot, always. It used to grow into a titled node when its branch was
         flown into, and the box had to be the opened one's or the camera framed
         captions that hung outside the frame it solved. There is no opened
         branch any more — work opens in the dialog — so the box is the dot's. */
      return { x0: -7, y0: -7, x1: 7, y1: 7 }
  }
}

/**
 * The radius of the round-ish body a node paints, ignoring its caption.
 *
 * Two things read this: `rim()`, for where a line leaves, and the layout's own
 * test, which asserts that no two of these bodies touch at any fleet size. The
 * framing box from `size()` is deliberately generous — it reserves label space
 * that may be empty — so it is the wrong thing to measure collisions with.
 */
export function discRadius(n: MapNode): number {
  switch (n.kind) {
    case 'core':
      return M.CORE_GLOW_R + 4
    case 'agent':
      return M.AGENT_R + RIM_GAP
    case 'add':
      return M.ADD_R + RIM_GAP
    case 'app':
    case 'more':
    case 'jobs':
      return M.APP_R + 5
    case 'job':
    case 'jobsMore':
      return M.BEAD_R + 2
  }
}

/**
 * The box a node's own body paints into, with no caption in it.
 *
 * What the camera frames when it flies *into* something. `size()` reserves room
 * for a name, which is right for holding the whole map on screen and wrong for
 * putting one face in a gap the size of a face: the reserve is wider than the
 * plate and hangs below it, so framing it drops the face high and left of where
 * the surface left room.
 *
 * The *ink*, not the clearance — `discRadius` adds the gap a line has to leave
 * from, which is a fifth of the plate again and is nothing anybody can see. The
 * hole the surface leaves is the size of a face, so the face has to be the size
 * of the hole; framing the clearance left it floating in a ring of its own air.
 *
 * An agent's ink is its plate and the flare that swells off it while it is
 * working. It used to be the plate and a *badge* standing off its corner; the
 * badge is gone, because an agent's work is drawn as its own nodes now — but
 * something still reaches past the tile, so the reserve moved rather than
 * disappearing. A box drawn to the plate alone is a box the flare hangs out of,
 * and what hangs out lands on the row of doors the surface put beside the hole.
 */
export function bodyBox(n: MapNode): Box {
  const r = inkRadius(n)
  return { x0: -r, y0: -r, x1: r, y1: r }
}

function inkRadius(n: MapNode): number {
  switch (n.kind) {
    case 'core':
      return M.CORE_GLOW_R
    case 'agent':
      /* The plate *and its flare* — see `FLARE_REACH`. A box drawn to the plate
         alone is a box the flare hangs out of on every working agent. */
      return M.AGENT_R * FLARE_REACH
    case 'add':
      return M.ADD_R
    case 'app':
    case 'more':
    case 'jobs':
      return M.APP_R
    case 'job':
    case 'jobsMore':
      return M.BEAD_R
  }
}

/**
 * How far from a node's centre a line should start.
 *
 * One rule: a line leaves a node from beyond whatever that node paints in the
 * direction it is heading. Every node here wears its caption underneath, so a
 * line going down clears the words and a line going any other way leaves the
 * disc. That is what stops a trunk being drawn through the name of the thing it
 * joins, and twelve trunks converging into a knot in the middle of the core.
 *
 * @param uy the y component of the unit vector the line is travelling along
 */
export function rim(n: MapNode, uy: number, ctx: Density): number {
  return uy > 0.55 ? size(n, ctx).y1 + RIM_GAP : discRadius(n)
}

/** One rounding rule for path data: shorter `d`, and no visible difference. */
export const px = (v: number): string => v.toFixed(1)

/** Which family a file extension belongs to — four buckets, not six. */
export function fileFamily(kind: string | undefined): FileFamily {
  const k = String(kind ?? 'md').toLowerCase()
  if (['csv', 'xls', 'xlsx', 'tsv'].includes(k)) return 'table'
  if (['sql', 'json', 'yaml', 'yml', 'js'].includes(k)) return 'code'
  if (['img', 'png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(k)) return 'media'
  return 'text'
}
