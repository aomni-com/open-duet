# The agent is a page, not a flight

Clicking a face on `/agents` stops being a **camera move** and becomes a
**navigation**. The agent surface keeps its composition — portrait and name over
two columns of glass, conversation left, the picked view right — and loses the
machinery that put it there: the 520ms flight, the hole the face was flown into,
the scrim punched around that hole, and the overlay it all lived in.

**The URL does not change.** `/w/:ws/agents/:agentSlug` and everything under it
already address exactly these places — see
[`url-map`](../done/url-map/README.md), whose grammar this spec does not touch.
What changes is that the address now resolves to a route element instead of a
zoom state on a canvas that never unmounts.

---

## Next Agent Prompt

**Status:** **slice 01 has shipped.** Start at
[slice 02](slices/02-the-agent-is-a-route.md). Last updated 2026-08-18.

Read `## The four decisions` first — three of them were answered by the user in
the planning session and are not yours to revisit.

**What 01 left you.** The surface draws its own `AgentAvatar` in the
`--km-well` box (a new `portrait` prop, fed from the roster row the route
already holds); `zoom-well.ts`, `well.test.ts`, `wellFraming` and the
`--km-hole-*` scrim punch are deleted; the camera frames a focus centred and
**never flies**. The two geometry assertions that measured a flown-in face are
gone from `playground.spec.ts`, and 76 baselines are re-approved.

**The ring is still mounted behind the glass** — that is 02's whole job, and it
is the part the user actually asked for out loud ("don't bring the map into this
new page"). 01 only got it out of the *face*.

**Before you touch anything, read
[`spa/knowledge-map/README.md`](../../apps/web/spa/knowledge-map/README.md).**
It is the map's own doc and it describes the behaviour this spec removes, in the
present tense. Every slice below has to leave it true; slice 03 owns the rewrite.

**Blockers / warnings**

- **The camera already has a no-flight path and it ships today.**
  `flyTo(..., fly && !reduced ? FLIGHT_MS : 0)` in
  [`use-map-camera.ts:156`](../../apps/web/spa/knowledge-map/use-map-camera.ts) —
  anyone with `prefers-reduced-motion` gets instant arrival now. That path is the
  proof the destination works without motion; do not re-derive it.
- **`ring-freshness.ts` exists only because the map never unmounts.** Its own
  header says so ("the zoom IS the route"). It becomes deletable the moment the
  agent is a route and React Query's ordinary `refetchOnMount` can fire again.
  Deleting it is slice 03's job, not an optional tidy — a workaround left
  standing after its cause is gone is the parallel abstraction this spec exists
  to avoid.
- **35 committed screenshots move.** 22 named `*agent-surface*`, 13 named
  `*knowledge-map*`, under `apps/web/tests/visual/__screenshots__/`. They are shot
  in Docker by `playwright.config.ts`, never by the dev config. See
  `## Gates` — and note `--force` rewrites *every* baseline including unrelated
  drift, so approve with `--update-snapshots=changed` unless a shot is
  sub-threshold.
- **Do not widen this into a redesign.** The user chose to keep the dark
  `--km-*` surface and the current cluster geometry (decisions 1 and 2). A slice
  that starts re-composing the header has lost its scope firewall.

**Global TODO**

- [x] [01 — the surface draws its own face](slices/01-the-surface-draws-its-own-face.md) — shipped 2026-08-18
- [ ] [02 — the agent is a route](slices/02-the-agent-is-a-route.md)
- [ ] [03 — delete what the route made dead](slices/03-delete-what-the-route-made-dead.md)

**Update this section before you end your pass.**

---

## The four decisions

**1. The page keeps the dark canvas surface.** *(user, planning session)* The
agent page draws the same `--km-*` ground, the same glass panels and hairlines it
has today; what it loses is the ring behind them. The alternative — moving the
agent onto ordinary `WorkspacePage` chrome — was rejected as a visual redesign
riding along with an architectural change.

The honest cost, recorded because it will look like an oversight later: glass
with nothing moving behind it is a dark card with a blur bill. The
`backdrop-filter` stays for now because removing it is a look change and this
spec is not one. **If a later pass wants to drop it, that is a taste decision on
its own, not cleanup.**

**2. The portrait is the same art, the same size, in the same box.**
*(user, planning session)* `AgentAvatar` from
[`spa/agents/agent-avatar.tsx`](../../apps/web/spa/agents/agent-avatar.tsx) —
the owner the ring's own faces already use through `createAgentAvatarDataUri`.
It goes in the `--km-well` box the hole occupies, so the cluster's spacing, the
column-start alignment and the gap assertions all survive untouched. A larger
hero portrait was rejected: it costs height off the conversation, which the QA
pass immediately before this spec spent its effort giving back.

**3. The ring re-mounts on return and does not fly in.** *(user, planning
session)* Leaving an agent unmounts the page and mounts the map fresh, framed at
rest. The alternative — keeping the map alive behind the page for an instant
restore — was rejected because it preserves exactly the coupling this spec
removes.

**4. No compatibility layer, no migration.** *(default; not raised by the user)*
The URLs are unchanged, nothing is persisted about the zoom, and there is no
stored state to migrate. Every slice is a hard cutover. If you find yourself
writing a shim that both shapes can read, stop — you have mis-sliced.

---

## Slice graph

```
01 the surface draws its own face      ── portrait in, hole out, flight off
        │                                 (still an overlay; nothing else moves)
        ▼
02 the agent is a route                ── router split, map unmounts,
        │                                 page draws its own ground
        ▼
03 delete what the route made dead     ── overlay, camera focus, freshness
                                          workaround, dead CSS, docs, baselines
```

Each rung is shippable on its own. 01 is visible to a reader (the flight stops)
and touches no routing. 02 is the architectural cut. 03 is pure subtraction and
must change no pixels — which is what makes it safe to do last and easy to
review.

---

## Contracts and single owners

The point of the ladder is that each of these ends up with **one** owner. Name
them before you start; a second owner appearing mid-slice is the signal to
reslice.

| Concept | Owner after this spec | Owner today |
| --- | --- | --- |
| The agent's face on the surface | `AgentAvatar` in the surface's cluster | the map's camera, flying a node into a hole |
| Where the agent surface lives | a route element under `agents/*` | `zoom` state inside `KnowledgeMap` |
| Framing the ring | `useMapCamera.reframe`, at rest | the same, plus focus framing and flight |
| Ring data freshness | React Query `refetchOnMount` | `ring-freshness.ts`, hand-rolled |
| The map's surface tokens (`--km-*`) | `knowledge-map.css`, shared by map and page | same file, but reachable only under `.km-zoom` |

**Short-lived seams: none are permitted.** There is no slice in this ladder that
needs the old and new shapes to coexist. If 02 tempts you to leave `zoom` in
place "until 03 removes it", delete it in 02 and let the compiler find the
callers.

---

## Gates

Every slice must leave these green, from `apps/web`:

```bash
bun run check-types
bun test ./scripts ./app ./src ./spa ./components
bun run verify:boundaries && bun run verify:visual-coverage
```

Geometry, fast, against a running `bun run dev` — this is the feedback loop, not
a gate:

```bash
bunx playwright test --config playwright.dev.config.ts -g "overlaps anything else in"
```

Baselines, in Docker, and the only run that may approve a shot — see
[`ui-playground`](../../.agents/skills/ui-playground/SKILL.md):

```bash
bun run visual:approve
```

**Visual verification is not optional on any slice that moves a pixel.** Every
such slice ends with an unprimed
[screenshot-critique](../../.agents/skills/screenshot-critique/SKILL.md) pass,
and — because every slice here changes a look that already exists — a
[compare-screenshots](../../.agents/skills/compare-screenshots/SKILL.md)
judgment of the new shot against the archived old one. Archive the before-shots
into `assets/` at the start of slice 01; after that the old look exists nowhere
else.

**Closeout.** This is a big enough change to owe a live staging journey
(`AGENTS.md`). Slice 03 registers one in
`packages/test-harness/src/staging-e2e-synthetic` and runs
`bun run e2e:staging -- --journey <name>` once, at the end. Do not run the full
staging suite.

---

## Known unknowns

- **What the page's ground looks like with no ring on it.** Decision 1 says
  "the same surface"; it does not say whether the edge fade, the vignette and
  the core glow still read when there is nothing behind them. Slice 02 produces
  the first honest shot of it and the review checkpoint there is where that gets
  judged. If it reads as flat, that is a finding for a follow-up, not a licence
  to redesign inside slice 02.
- **Whether the ring's entrance still reads on a fresh mount.** The map today is
  mounted once per visit to the workspace; after 02 it mounts on every return
  from an agent. Its own arrival animation may now fire often enough to feel
  like a tic. Measured in slice 02, decided in 03.
