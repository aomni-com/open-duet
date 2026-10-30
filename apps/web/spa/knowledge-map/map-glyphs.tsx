/* ============================================================================
   Every small drawn thing on the map, as a component that takes only what it
   draws. Nothing here reads focus, reaches for the document, or knows what a
   job is — the badge is handed a tone and a glyph, not a state.
   ========================================================================= */
import {
  AppWindow,
  ClockCounterClockwise,
  HardDrive,
  Sparkle,
  type Icon,
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

import { createAgentAvatarDataUri } from '../agents/agent-avatar'
import { SPARKS } from './layout'
import type { PulseStyle } from './live'
import {
  AGENT_PLATE_RADIUS,
  AVATAR_RADIUS,
  M,
  px as p,
  tileRadius,
  unreadDotOffset,
} from './metrics'
import { monogram } from './monogram'
import type { BadgeGlyph, KindKey, Tone } from './types'

/* The same Phosphor icons the rest of the product already uses for these four
   destinations — `WORKSPACE_TAB_ICONS` in drive/workspace-tabs.ts for jobs and
   files, `PRODUCT_DESTINATION_VIEWS` for apps, and the skills card in
   agents/agent-detail-canvas.tsx. The map used to draw its own marks, which
   meant the icon for "jobs" here and the icon for Jobs in the nav were two
   different pictures of the same idea.

   `Record<KindKey, Icon>` so a new kind cannot silently inherit another's. */
const KIND_ICONS: Record<KindKey, Icon> = {
  jobs: ClockCounterClockwise,
  skills: Sparkle,
  files: HardDrive,
  apps: AppWindow,
}

/* A nested <svg> is how a Phosphor component lives inside the map's own svg; it
   carries its own 0 0 256 256 viewBox, and the group positions it. Colour comes
   from `currentColor`, which the stylesheet points at the kind's hue. */
export function KindMark({ kind, size = 22 }: { kind: KindKey; size?: number }) {
  const Glyph = KIND_ICONS[kind]
  return (
    <g className="km-mark" transform={`translate(${-size / 2},${-size / 2})`}>
      <Glyph size={size} weight="duotone" />
    </g>
  )
}

/**
 * One app, drawn as the thing it is: a rounded square with the app's own icon
 * filling it.
 *
 * A square because that is the shape app artwork is drawn for — every icon on
 * the drive, in this product and every other, is a square meant to be rounded
 * rather than circled, and a circle crops the corners off a picture somebody
 * made. It is the same corner as a face's, from `tileRadius`, so an app beside
 * an agent reads as the same family at two sizes.
 *
 * The plate and the outline are two elements for the same reason a face's are:
 * SVG paints a stroke over its own fill, so artwork laid over a rect that
 * strokes itself eats the inner half of the one border the tile has.
 *
 * An icon that cannot be drawn — deleted, unreadable, or never really there —
 * puts the initials back, which is the promise `FileIconImage` makes for every
 * HTML surface showing a drive-hosted icon. Without it an app whose icon row
 * outlived its icon file is an empty tile: less than the two letters the
 * artwork replaced, and silent about why.
 */
export function AppTile({
  id,
  title,
  icon,
  r,
}: {
  /** the node's id, which only has to be unique enough for the clip path */
  id: string
  title: string
  /** where the drive serves this app's artwork, when it ships any */
  icon?: string
  r: number
}) {
  const clip = `km-appclip-${id}`
  const box = { x: -r, y: -r, width: r * 2, height: r * 2 }
  const shape = { ...box, rx: tileRadius(r * 2) }
  const art = useDrawableArt(icon)
  return (
    <>
      <rect {...shape} className="km-app-disc" />
      {art === undefined ? (
        <text y={5} textAnchor="middle" className="km-app-mono">
          {monogram(title)}
        </text>
      ) : (
        <>
          <clipPath id={clip}>
            <rect {...shape} />
          </clipPath>
          {/* `slice`, so a picture that is not square fills the tile and is cut
              rather than letterboxed onto the wash behind it. */}
          <image
            {...box}
            href={art}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${clip})`}
            className="km-app-art"
          />
        </>
      )}
      <rect {...shape} className="km-app-edge" />
    </>
  )
}

/* ---- the unread dot -----------------------------------------------------
   One mark, on a face, for that owner's own conversation. It is drawn in two
   places — a face on the ring and the face at the centre — so it is one
   component rather than two hand-rolled `<g>`s free to drift apart.

   A dot rather than a numeral because an owner has exactly one default chat, so
   the only honest count is one, and a numeral that can only ever read `1` is a
   dot that invites the reader to look for a second digit.

   The unread hue (`--km-unread`, the app-wide `--unread`) rather than a tone:
   the tone reserved for this resolves to `--km-dim`, the same value as `ok`, so
   unread and connected would be the same grey. It is amber, the one hue the
   map vacated, and the same amber every sidebar's unread dot wears. The rim it
   carries is in `knowledge-map.css`, and it is load-bearing: a face's plate is
   a generated avatar in an arbitrary colour, and nothing guarantees contrast
   against it.

   `plate` is the size of the face it hangs off, and the position is derived
   from it here — see `unreadDotOffset`. It used to be an `inset` the caller
   worked out, on the reasoning that the plates differ and one shared offset
   would either float inside the portrait or hang off into nothing. That was
   true of a shared *number* and false of a shared *rule*: the two callers then
   tuned their own, landed at 0.765 and 0.737 of their half-sizes against a
   corner at 0.836, and drew visibly different marks. Sharing the glyph while
   splitting the geometry left the drift exactly where it could not be seen. */
export function UnreadDot({ plate, r = 6 }: { plate: number; r?: number }) {
  const offset = unreadDotOffset(plate)
  return (
    <g transform={`translate(${p(-offset)},${p(-offset)})`} className="km-unread">
      <circle r={r} className="km-unread-bg" />
    </g>
  )
}

/* ---- attention badges --------------------------------------------------
   A ring plus a glyph that says what to do. The tone attribute drives colour
   through currentColor; the glyph drives meaning. A ring on its own would be a
   decoration — which is why a finished job gets no badge at all rather than an
   empty one. */
export function Badge({
  tone,
  glyph,
  count = 1,
  r,
}: {
  tone: Tone
  glyph: BadgeGlyph
  count?: number
  r: number
}) {
  if (glyph === 'none') return null
  return (
    <g className="km-badge" data-tone={tone} data-glyph={glyph}>
      <circle r={r} className="km-badge-bg" />
      {glyph === 'ask' && (
        <text
          y={r * 0.5}
          textAnchor="middle"
          className="km-badge-q"
          style={{ fontSize: `${(r * 1.5).toFixed(1)}px` }}
        >
          ?
        </text>
      )}
      {glyph === 'spin' && (
        <path
          d={`M0 ${p(-r * 0.52)} A ${p(r * 0.52)} ${p(r * 0.52)} 0 1 1 ${p(-r * 0.37)} ${p(-r * 0.37)}`}
          className="km-badge-spin"
        />
      )}
      {glyph === 'dot' && <circle r={r * 0.3} className="km-badge-dot" />}
      {glyph === 'plus' && (
        <path
          d={`M${p(-r * 0.42)} 0 H${p(r * 0.42)} M0 ${p(-r * 0.42)} V${p(r * 0.42)}`}
          className="km-badge-rule"
        />
      )}
      {count > 1 && (
        <text x={r * 1.05} y={-r * 0.62} textAnchor="start" className="km-badge-n">
          {count}
        </text>
      )}
    </g>
  )
}

/* ---- working ----
   The plate's own outline, struck three times: a steady rim that says this agent
   has something in flight, and behind it one ring per comet on the trunk, each
   thrown off outwards at the moment its own comet arrives. Separate elements
   because they have to survive separately — a reader on `prefers-reduced-motion`
   gets no animation at all, so the rim is what is left, and it has to be legible
   on its own rather than being the resting frame of a flare.

   The flares are the arrivals of the things travelling up the wire, so there are
   exactly as many of them as there are comets, and they read their delay from
   the same `--km-lead` those comets do. Hard-coding two rings here and three
   comets there is how a beat quietly stops landing on anything.

   It traces the plate rather than standing off a corner: the corner belongs to
   the attention badge, which answers a different question and may well be lit at
   the same time. Concentric marks read as one object; two marks a few pixels
   apart read as a rash. */
export function LiveMark({ beat }: { beat: PulseStyle }) {
  const side = M.AGENT_R * 2
  const plate = { x: -M.AGENT_R, y: -M.AGENT_R, width: side, height: side, rx: AGENT_PLATE_RADIUS }
  return (
    /* `km-live-mark`, not `km-live`: that one is already the trunk's word for
       "this wire has work on it", and a rule written for one would have quietly
       landed on the other. */
    <g className="km-live-mark" style={beat}>
      {SPARKS.map(index => (
        <rect
          key={index}
          {...plate}
          className={index > 0 ? 'km-live-flare km-live-flare-echo' : 'km-live-flare'}
        />
      ))}
      <rect {...plate} className="km-live-rim" />
    </g>
  )
}

/* Generating a DiceBear face is not free — it builds an SVG and base64s it — and
   it is a pure function of the name, so it is worth doing once per agent for the
   life of the tab rather than once per agent per render. Twelve agents on a map
   that re-renders on every hover is a lot of wasted work otherwise. */
const FACE_CACHE = new Map<string, string>()
function cachedFace(name: string): string {
  const hit = FACE_CACHE.get(name)
  if (hit !== undefined) return hit
  const made = createAgentAvatarDataUri(name)
  FACE_CACHE.set(name, made)
  return made
}

/**
 * A face, generated by the same rule the rest of the product uses — the map used
 * to carry its own 70 kB table of baked data URIs, which meant a face could
 * drift from the one the roster showed for the same agent.
 *
 * `src` is the one way to override that: Duet's own drawing, which belongs to
 * the core and is not a generated pattern, and any agent that has uploaded a
 * custom icon of its own. `src` used to be selected by `locked` for the core
 * alone, which is the wire's word for "this agent cannot hold a conversation" —
 * so a disabled agent quietly wore the mascot's face.
 */
export function AgentFace({
  id,
  avatarKey,
  src,
  size,
  plate,
}: {
  /** only for the clip path's id, which has to be unique in the document */
  id: string
  /** the seed the generated face is drawn from — an agent's slug, never its
   *  display name, so renaming an agent does not hand it a new face */
  avatarKey: string
  src?: string
  size: number
  /** what the slab under the art is called, so a core and an agent can differ */
  plate: string
}) {
  const art = useDrawableArt(src)
  const clip = `km-avclip-${id}-${size}`
  const half = size / 2
  /* 28%, the same as `IdentityAvatarFrame`'s `rounded-[28%]`. It was 19% here,
     which put a nearly-square face inside a much rounder plate — the corners
     disagreed and the whole tile read as slightly broken. */
  const radius = size * AVATAR_RADIUS
  /* One geometry, and every layer of the tile struck from it. The slab, the
     clip, the art and the hairline were four rects written out four times, on
     three different sizes and two different radii; the tile is a single shape
     now and it is spelled once. The art takes the box without the corner —
     `rx` is the clip's business, and an `<image>` does not round itself. */
  const box = { x: -half, y: -half, width: size, height: size }
  const shape = { ...box, rx: radius }
  return (
    <g className="km-av">
      {/* Under the art rather than around it: SVG paints a stroke over its own
          fill, so the slab and the one border cannot be the same element even
          though they are the same shape. */}
      <rect {...shape} className={plate} />
      <clipPath id={clip}>
        <rect {...shape} />
      </clipPath>
      <image
        {...box}
        href={art ?? cachedFace(avatarKey)}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clip})`}
        className="km-av-img"
      />
      {/* The border. Singular — there is no second outline anywhere on a face. */}
      <rect {...shape} className="km-av-frame" />
    </g>
  )
}

export function resolveDrawableArt(
  source: string | undefined,
  undrawable: string | undefined,
): string | undefined {
  return source === undefined || source === undrawable ? undefined : source
}

/* Asked of an HTML image rather than the `<image>` that draws into SVG.
   React cannot reliably attach an early-enough error handler to the SVG host,
   while the browser's ordinary image element answers the same decode question
   against the same cache. Remembering the failed URL means replacing an icon
   immediately gives the new artwork its own chance to load. */
function useDrawableArt(source: string | undefined): string | undefined {
  const [undrawable, setUndrawable] = useState<string>()
  useEffect(() => {
    if (source === undefined) return
    let live = true
    const probe = new Image()
    probe.onerror = () => {
      if (live) setUndrawable(source)
    }
    probe.src = source
    return () => {
      live = false
    }
  }, [source])
  return resolveDrawableArt(source, undrawable)
}
