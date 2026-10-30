# 03 — Delete what the route made dead

## The contract this unlocks

Nothing new. **This slice must change no pixels**, and that is its whole
review: if a baseline moves, something was load-bearing and the deletion was
wrong.

What it does is make the codebase read as though it had been designed this way,
rather than as the old shape with a route bolted on. Every item below is dead
*because of* slices 01 and 02 — none of it is opportunistic tidying, and none of
it may be deferred to "later", which is how a codebase ends up with two owners
for one idea.

## The list

**`spa/knowledge-map-data/ring-freshness.ts`** — deleted, with its tests and
call sites. Its header explains it exists because the map never unmounts; it
now does. The ring's data goes back to React Query's own `refetchOnMount`.
**Verify that claim rather than assuming it**: open an agent, let something
change, come back, and confirm the ring re-reads. If it does not, the module is
not dead and this bullet is wrong — say so in the spec instead of deleting it.

**The camera's focus half.** `useMapCamera` keeps `reframe` and loses focus
framing. Then look hard at what is left of `use-map-motion.ts`: `flyTo`,
`FLIGHT_MS`, the easing and the `flying()` predicate exist for a flight nobody
starts. Whatever the ring still needs to arrive at rest stays; the rest goes.
`flight.test.ts` and `framing.test.ts` shrink to what survives.

**CSS.** The 21 `.km-zoom` rules — those that moved onto the page root in slice
02 are already gone from here; the remainder are dead. The focus node states
(`.km-dim`, `.km-on`, `.km-gone`) go with the classes slice 02 stopped emitting.

**Three modules reason about `.km-zoom` in prose and behaviour, and each has to
be re-decided rather than search-replaced.** They are the reason this slice is
not a `git rm`:

- `agent-jobs/index.tsx` — the map's transform-only, no-opacity animation policy
  is justified by `.km-zoom > *`. On a page there is no such ancestor, so either
  the policy has a new reason or it has none. Say which.
- `agent-jobs/panes.tsx` — the jobs dialog portals to `document.body` explicitly
  to escape `.km-zoom`'s stacking context. Off the overlay that escape may be
  unnecessary; confirm before removing it, because a portal that was load-bearing
  for a different reason will fail as a z-index bug nobody traces back here.
- `agents-rail/index.tsx` — reads a declaration made on `.km-zoom` for the case
  where nothing has unfolded. The rail lives with the ring, so it needs whatever
  the ring's own root now declares.

**Playground fixtures.** `agent-surface-playground.tsx` and
`agent-surface-drive-playground.tsx` mount the surface inside a map to get the
hole and the canvas. They now mount a page. Keep every scenario they cover —
the setup states, the walled state, the busy and quiet drives — this is a
re-hosting, not a cull. `verify:visual-coverage` is what proves nothing was lost.

**`spa/knowledge-map/README.md`.** It documents the flight in the present tense:
"Click a face and the camera flies into it and the agent's own surface unfolds
over the canvas". Rewrite it to describe what the map is now — a picture that
reports what was clicked — following
[write-docs](../../../.agents/skills/write-docs/SKILL.md): a glossary of
principles, not a mirror of the code. The `<KnowledgeMap>` example near the top
still shows `zoom`/`onZoom`; it must not.

**`apps/web/README.md`** carries the same claim in its Boundaries section (the
`agents/*` splat, "six sibling routes pointing at one element risk remounting
the canvas"). That reasoning is now inverted — remounting is the design. Fix it.

## What the human can run

The whole app, unchanged. That is the point.

## Verification

1. Full gates, green.
2. **`bun run visual:approve` must produce no changed shots.** This is the
   slice's real assertion. A moved baseline means a deletion was not dead.
3. `bun test --changed` from the repo root — this slice deletes across
   `apps/web`, so let the import graph find the tests you did not think of.
4. The root `bun run test`, once, as the closeout gate. Once — not as a loop.
5. **The staging journey.** Register one in
   `packages/test-harness/src/staging-e2e-synthetic` covering: land on
   `/agents`, open an agent, use its chat, leave, confirm the ring re-reads.
   Then `bun run e2e:staging -- --journey <name>`, once, at the end. **Do not**
   run the full staging suite (~60 min).
6. Run [refactor-clean](../../../.agents/skills/refactor-clean/SKILL.md) over
   the finished change. This slice is the one whose job is shape, so it is the
   one that owes that pass.

## Delegated to the implementer

Everything about *how* to delete. Nothing about *what*: the list above is the
scope, and an item that turns out not to be dead gets written up here rather
than quietly kept.

## What must stay green

All of it, plus zero baseline movement.

## Closeout

When this lands, the feature is done. Run
[close-spec](../../../.agents/skills/close-spec/SKILL.md) to archive
`specs/agent-page/` into `specs/done/` and rewrite it from a build ladder into
the durable record of *why* the flight went — including decision 1's recorded
cost (glass over a still ground) so a future reader does not rediscover it as a
bug.
