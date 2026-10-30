# 01 — The surface draws its own face

## The contract this unlocks

The agent surface stops depending on the camera to put a face on it. It draws
its own portrait, in the box the hole occupied, and the camera stops aiming at
that box. **The flight is gone from this point on** — clicking a face on the
ring produces the surface immediately.

Nothing about routing changes here. The surface is still `KnowledgeMap`'s child
and the map is still mounted. That is deliberate: this slice is the one a reader
can judge on its own ("does the surface still look right with a real portrait in
it, and does arriving instantly feel worse?") without a router change underneath
it confusing the verdict.

## API seam

**Deleted:** `spa/knowledge-map/zoom-well.ts` — the whole module. It exists to
carry one `ref` from the surface to the camera; with nothing aiming at the well
there is no ref and no context.

**`spa/routes/agents-map/agent-surface/index.tsx`** — `useZoomWell()` and the
`ref` on `.km-face` go. `<div ref={wellRef} className="km-face" />` becomes an
`AgentAvatar`, keeping the class: `.km-face` is the geometry (the `--km-well`
box, `justify-self` under the narrow container query) and it keeps owning that.
What changes is that something is painted in it.

**This adds props, and that is the seam worth getting right.** `AgentAvatar`
takes `avatarKey`, and optionally `profile` / `workspaceSlug` / `duet` for an
agent with authored icon art — none of which the surface holds. The surface is
presentational by contract (`apps/web/README.md`: the route owns the queries),
so the route hands it what to draw, exactly the way it already hands it `name`
and `subtitle`:

```tsx
/* The same pair the map's own faces are drawn from, handed in for the same
   reason `subtitle` is: the ring and this surface must not each decide what
   this agent looks like, or they will disagree. */
portrait: { avatarKey: string; profile?: AgentAvatarProfile }
```

Read how `map-node.tsx` builds `AgentFace` and give the surface the same inputs.
**Do not let the surface derive the key from the slug** — that is a second
owner for the agent's appearance, and decision 2 exists to keep one.

**`spa/knowledge-map/knowledge-map.tsx`** — the `aim()` effect and its
`ResizeObserver` on `root`/`well` go, along with `wellFraming`, the
`--km-hole-x/y/r` custom properties it writes, and `ZoomWellProvider`. A focused
agent now frames the same way an opened branch already does: `frameTo` centred,
and **never flying** — pass `false`, do not thread a `fly` decision through.

**`spa/knowledge-map/knowledge-map.css`** — the scrim that reads `--km-hole-*`
loses its punch and becomes a plain wash. Do not delete the wash; the ring still
has to step back behind the panels while the overlay exists. It stops being a
radial hole and becomes flat.

**`spa/knowledge-map/well.test.ts`** — deleted with its subject. Its claim (the
face fits inside the hole, badge and all) is about a flight that no longer
happens. Do not port it; there is nothing left to measure.

## What the human can run

- `/playground/spa-shell` — click a face on the ring, land on the agent
  instantly with its portrait drawn in the cluster; leave, and the ring returns
  without a flight.
- `/playground/agent-surface`, `agent-surface-busy`, `agent-surface-quiet` — the
  static shots of the cluster, now with a portrait where the fixtures previously
  left a gap for a face the fixture never drew.

**Before you start, archive the current look.** Copy the 22 `*agent-surface*`
and 13 `*knowledge-map*` baselines from
`apps/web/tests/visual/__screenshots__/` into `specs/agent-page/assets/before/`.
After this slice the old look exists nowhere else, and slices 02 and 03 both
need something to compare against.

## Verification

1. `bun run check-types`, the unit suite, `verify:boundaries`,
   `verify:visual-coverage` — all green.
2. **The geometry gate must still pass unchanged:**
   `bunx playwright test --config playwright.dev.config.ts -g "overlaps anything else in"`.
   This is the real check on decision 2. The portrait occupies the box the hole
   occupied, so the column-start skew, the gap equality and the
   nothing-overlaps-anything assertions should all hold **without being
   edited**. If you find yourself relaxing `COLUMN_START_SKEW_PX` or
   `GAP_SKEW_PX`, stop: the portrait is the wrong size or in the wrong box, and
   the test is right.
   - Two assertions in that block *are* expected to fail and must be deleted
     rather than loosened: `the surface must leave a gap for the face`, and the
     `FADE_CLEARANCE_PX` check that the flown-in face clears the canvas fade.
     Both name a face the map draws into the surface. It does not any more.
3. `bun run visual:approve` in Docker, then **compare** the new shots against
   `assets/before/` with
   [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md) —
   the question is "is the portrait less wrong than the hole", not "does it
   match".
4. **Last, before accepting:** an unprimed
   [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md)
   on the agent surface shot. Primed eyes will forgive a portrait that sits two
   pixels off the name's optical centre; that is exactly what this catches.

## Human review checkpoint (non-blocking)

Open the before/after pair with
[preview-shots](../../../.agents/skills/preview-shots/SKILL.md) and give the
user ~5 minutes. The question is narrow: **does the static portrait carry the
agent's identity as well as the flown-in face did?** If there is no answer,
decide on the evidence, write the decision and its reasoning into this file, close
the shots, and continue. Do not stall.

## Delegated to the implementer

- Which props `AgentAvatar` takes and how the agent's art key reaches it — read
  the component, do not design an interface.
- Whether the flat wash keeps its current opacity or wants a different one now
  that it is not punched. Reversible, cosmetic, yours.
- Internal naming of anything you extract.

Everything else is decided. In particular: **do not** choose a different
portrait size, **do not** move the portrait out of the `--km-well` box, and
**do not** keep a reduced-motion branch — there is no motion left to reduce.

## What must stay green

The full gate list in [the README](../README.md#gates), plus the three chat
geometry tests that landed just before this spec (`keeps the conversation while
a long draft is composed`, `fills the same half of any window`, `tray lines up
with the compose bar under it`). They measure the left column and this slice
changes the column's header.

## What feedback would change this slice

If the portrait reads as a sticker rather than as the agent — the ring's faces
sit on a plate with a badge and a flare, and none of that comes with
`AgentAvatar` — then the answer is to give the surface's portrait the plate too,
inside this slice. It is not a reason to reopen decision 2.
