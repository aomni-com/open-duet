# 02 — The agent is a route

## The contract this unlocks

`/w/:ws/agents/:agentSlug` resolves to a **route element**. The map is not
mounted while you are on it. Going back to `/agents` mounts the map fresh and
frames it at rest.

This is the architectural cut. After it, "the zoom IS the route" — the sentence
[`ring-freshness.ts`](../../../apps/web/spa/knowledge-map-data/ring-freshness.ts)
opens with — is false, and the workaround it justifies is dead. Slice 03 buries
it.

## API seam

**`spa/root.tsx`** — the `agents/*` splat currently mounts one element for the
ring and every agent URL beneath it. It splits:

- `agents` (index) → the ring.
- `agents/marketplace`, and the other members of `RESERVED_AGENT_SLUGS` → as
  today, untouched.
- `agents/:agentSlug/*` → the agent page.

**Read [`agents-map-url.ts`](../../../apps/web/spa/drive/agents-map-url.ts)
before you write the table and use its grammar.** `RESERVED_AGENT_SLUGS` exists
precisely so a destination under `/agents` cannot be confused with an agent
named the same thing, and it is a `Set` rather than a regex so a fifth
destination cannot ship without turning a test red. Route ordering is now a
second place that fact could be encoded — **do not encode it twice.** Ask the
module.

**`spa/routes/agents-map.tsx`** is ~1,090 lines that today serve both places.
It splits into two route components. The split is along a seam that already
exists in the file: everything gated on `focus`/`agentScope` is the agent page's,
everything about `MapData`, the rail and the ring is the map's. **The shared
reads — the workspace query, the agents roster, the entitlement gate — move to a
module both import**, not to a wrapper component that renders one or the other;
a wrapper is the old always-mounted shape wearing a new name.

**`spa/routes/agents-map/knowledge-map-home.tsx`** — `zoom`, `onZoom` and the
`children` slot go. It draws a ring and reports what was clicked. What a click
*means* becomes `navigate(...)` in the ring route, which is where every other
destination in this app is already decided.

**`spa/knowledge-map/knowledge-map.tsx`** — `zoom`, `onZoom`, `focusId`,
`unfolded`, the `.km-zoom` overlay div and the `children` it wrapped all go, and
with them the node states that only a focus can produce: `km-dim`, `km-on`,
`km-gone`, and `carriedBy`. A map with no focus draws every node the same way.

**The agent page's ground.** The page needs the `--km-*` surface without a map
under it (decision 1). The tokens and the panel styles live in
`knowledge-map.css` and are currently reachable only under `.km-zoom`. Give the
page a root class of its own and move — do not copy — those rules onto it. Two
selectors carrying the same declarations is the duplication this spec exists to
avoid, and the copy is the one that will drift.

## What the human can run

- `/playground/spa-shell` — click an agent, land on its page, hit back, land on
  the ring. Watch the address bar: it should be doing exactly what it did
  before, because the grammar has not changed.
- The map fixtures (`knowledge-map`, `knowledge-map-loading`) — the ring with no
  focus states left in it.

## Verification

1. The full gate list, green.
2. **`agents-map-url`'s own tests must pass untouched.** They are the proof the
   grammar survived a routing change. If one needs editing, you have changed the
   URL contract, which this spec forbids — go back and fix the route table.
3. `loading-route.test.ts` likewise: every path it asserts maps to `agents-map`
   still must, because the loading skeleton a cold landing draws is keyed on the
   path, not on which component ends up mounted.
4. The geometry gate, and the three chat tests.
5. `bun run visual:approve`, then
   [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md)
   against `assets/before/` **and** against slice 01's shots — this is the slice
   where the ring stops being behind the glass, so the panels are the thing to
   look at.
6. An unprimed
   [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md)
   on the agent page, last.

## Human review checkpoint (non-blocking)

This is the one that answers the README's first known unknown. Open the agent
page shot with
[preview-shots](../../../.agents/skills/preview-shots/SKILL.md), ~5 minutes:
**does the surface still read with nothing behind it?** Silence means decide on
the evidence, record it here, close the shots, continue. If it reads flat, write
that down as a finding for a follow-up pass — **do not** start adjusting the
ground inside this slice.

## Delegated to the implementer

- The names of the two route components and the shared-reads module.
- The page root's class name.
- How the ring route phrases its `navigate` calls.

Not delegated: whether the map stays mounted (decision 3 — it does not), whether
a wrapper component may hold the shared reads (it may not), and whether
`agents-map-url` may be bypassed (it may not).

## What must stay green

Everything in [Gates](../README.md#gates). Pay particular attention to
`verify:boundaries` — this slice moves reads between modules and that script is
what notices when a boundary is crossed the wrong way.

## What feedback would change this slice

If the ring's own arrival animation now fires on every return and reads as a
tic, that is the README's second known unknown coming true. Measure it here,
record it, and let slice 03 decide — it is a one-flag change and it does not
belong in the middle of a routing cut.
