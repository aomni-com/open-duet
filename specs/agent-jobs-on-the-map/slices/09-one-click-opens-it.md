# 09 — One click opens it

Requirement 3, and the reversal of **decision 5**. Depends on
[08](08-what-the-dialog-stands-over.md).

**Contract unlocked.** Clicking the Jobs seat opens the dialog with no job
selected. Clicking a bead opens it focused on that job. Clicking a face still
goes to the agent view, unchanged. Nothing flies in; nothing unfolds.

## The API seam

`KnowledgeMapZoom` and `KnowledgeMapOpen` move from `knowledge-map.tsx` into
`knowledge-map/types.ts`, whose header already claims the host contract as its
subject — a `.tsx` import inside the pure modules was always the wrong way round.

```ts
// knowledge-map/hit.ts
export type MapIntent =
  | { kind: 'zoom'; zoom: KnowledgeMapZoom | null }
  | { kind: 'open'; open: KnowledgeMapOpen }
  | { kind: 'addAgent' }
  | { kind: 'none' }

/** What clicking this node means. Takes the node and nothing else — there is no second step. */
export function intentOf(node: MapNode): MapIntent
```

**The signature is the proof.** A pure function of the node alone cannot express
a two-step, so the reversal of decision 5 is enforced by a type rather than by a
comment. `openId` disappears from `knowledge-map.tsx` entirely, and `hit`
(`:440-476`) becomes a five-line dispatcher.

Each writer owns exactly one `over` (from [08](08-what-the-dialog-stands-over.md)):
`agents-map.tsx`'s `onOpen` writes `over: 'ring'`; `jobsHref` writes
`over: 'agent'`. Nothing needs to remember where a click came from.

## What this costs, stated plainly

At twenty agents a bead is ~5px of ink with a 15-unit hit radius, and the fly-in
was the only thing that ever made one big enough to aim at. The README's *Known
unknowns* already flags touch targets; this slice raises the stakes, because a
mis-tap now opens the wrong conversation rather than a harmless zoom.

Three things blunt it, and they are why this is acceptable rather than merely
accepted:

- A mis-aimed click lands on the **Jobs seat** beside the beads, which is full
  size and opens the same list with nothing selected — a soft failure.
- `M.BEAD_HIT` is a separate number from `M.BEAD_R` precisely so the target can
  grow without moving the drawing.
- Keyboard reach is unchanged: every node is `role="button"`, `tabIndex={0}`,
  with an `aria-label`.

If measurement says that is not enough, the retreat position — named here so it
is not invented under pressure — is: a bead at `crowded` sizes opens the dialog
**unselected**, so a mis-tap costs a list rather than the wrong conversation.

## Resolved here

- One click, every entry point.
- `jobsMore` (the overflow) opens the dialog with no job selected — it means the
  list, which is decision 4 and unchanged.

## Verification

`knowledge-map/hit.test.ts`, one case per node kind:

- `jobs`, `jobsMore` → open with `job: null`
- `job` → open carrying `node.data`
- `agent` → zoom to that agent; `core` → zoom core
- `more` → zoom core when parented on `CORE_ID`, else the agent
- `app` → open apps; `add` → addAgent

and the rule as a table-driven assertion: **no node produces a `jobs` zoom.**

Then the one that closes a standing gap. The README's *Known unknowns* records
that *"the production route's job door has only been read, not driven."* A new
`knowledge-map.test.tsx` drives it: render `KnowledgeMap` with a jobs fixture,
click the Jobs seat, assert `onOpen({kind:'jobs', job:null})` fired and `onZoom`
did **not**; click a bead, assert `onOpen` carries that job; repeat with
`zoom={null}` to prove there is no first step left. Cheap, because nodes are
`role="button"` with `aria-label`.

## Must stay green

`nearest-drawn.test.ts`, `keys.test.ts`, `use-map-motion.test.ts`,
`use-agent-jobs.test.tsx` — the last one because the shut-dialog-asks-nothing
invariant must survive the dialog's new mounting.

## What a human sees

Playground event log: one click on a Jobs seat prints `onOpen { kind: 'jobs',
job: null }` with no preceding `onZoom`. Production: `/w/:slug/agents`, click a
Jobs seat, land on `?jobs=ops` with the ring still behind the overlay; close;
land back on the ring.

## Delegated

Whether the agent surface's `jobsHref` door keeps its current copy now that its
destination has a second spelling. Recommendation: leave it; revisit if the
critique flags it.
