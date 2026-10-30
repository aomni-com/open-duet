# 04 — The unread axis gets a module, a rule, and its first baseline

> **Superseded in part, 2026-08-13 — and shipped.** This slice was written for a
> *numeral*. The numeral was built, shot, looked at, and replaced by a **dot**,
> and the Jobs seat was stripped of every mark it had. What shipped:
> `hasUnread(node)` instead of `unreadOf(node): number`; `UnreadDot` instead of
> `UnreadNumeral`; `unreadCount` and `UNREAD_MAX_SHOWN` deleted rather than
> moved. Read decision 10 and *Reversals* in the README for the current rule.
> The rest of this file — the seam, the corner rule, the geometry numbers, the
> baseline order, and the verification — held and is why the slice went green.


**Contract unlocked.** Every numeral on the map comes from one function, and that
function is a function of the node alone. No product behaviour changes: nothing
fills the face's numeral yet. That is deliberate — the geometry risk is isolated
in a slice with no data behind it, so a red pixel here is the mark, not the read.

## The rule, made precise enough to build against

> **A numeral on a node is the unread count of what that node's own click opens.**

That is the user's rule — *any number on top of a node is the UNREAD amount and
nothing else* — sharpened until it decides cases:

- the **face** opens the agent view, whose chat is that owner's default chat →
  its numeral is that one conversation's unread, so 0 or 1;
- the **Jobs seat** opens the jobs dialog, which lists all four buckets and
  excludes the default chat → its numeral is exactly that set, which is why the
  chat leaves it and `done` joins it;
- **no other node** wears a numeral, because no other node opens a conversation.

Write it in one function and the remaining slices are consequences.

## The API seam

New `apps/web/spa/knowledge-map/unread.ts`, which takes `UNREAD_MAX_SHOWN` and
`unreadCount` **verbatim** from `palette.ts`. Colour is `palette.ts`'s subject by
its own header, and its unread doc already argues the mark is *not* a tone; the
two have been cohabiting for one file's worth of convenience.

```ts
/**
 * The numeral this node wears: the unread among what its own click opens.
 * One function, so "which list" is decided once for every node kind at once.
 */
export function unreadOf(node: MapNode): number
```

`agent` / `core` → `unreadCount(node.agent.chat)`; `jobs` → the seat's count;
every other kind → `0`.

**Why `unreadOf` and not just `unreadCount`.** `unreadCount` owns *how to count a
list*, not *which list*. Two call sites — `unreadCount(agent.jobs)` in `JobsBody`
and `unreadCount(agent.chat)` in `AgentBody` — would be two places that decide
what a numeral means, and the next edit is where they diverge. `unreadOf` is the
owner the rule above needs, and the one test file that can assert the rule for
every node kind at once.

Also new, in `map-glyphs.tsx`:

```tsx
export function UnreadNumeral({ n }: { n: number })
```

the `<g className="km-unread">` lifted out of `JobsBody` (`map-node.tsx:410-417`)
so the corner, the full ink and the `9+` rule cannot drift between two drawings
of one mark.

`Agent` in `types.ts` grows:

```ts
/**
 * This owner's own conversation, as a set of at most one.
 *
 * A set rather than an optional record so the numeral it produces has the same
 * producer every other numeral on this map has, and so "an owner has exactly
 * one default chat" is a fact about the data rather than a `Math.min(1, …)` in
 * a component that anyone can raise. Absent means the alias has not answered,
 * or answered 404 — both draw nothing.
 */
chat?: readonly Job[]
```

`layout.ts` hands the core node the duet agent it already holds, so `CoreNode`
carries an `agent` and the rule reaches the centre of the picture.

## Resolved here — the implementer inherits these

- **Top-left, on every node kind.** The seat's own comment argues its two corners
  apart because attention and unread can be lit at once. The face has no state
  badge to separate from, but a mark that changes corner between node kinds is a
  mark a reader must re-learn per node. One meaning, one corner.
- **The core wears one too.** `MapData.duet` is an `Agent` and root has a default
  chat (`workspaces.rootDefaultSessionId`). A rule with one exception is two
  rules.
- **Full ink, never a tone.** Reusing `unified-session-list`'s decision, not
  reopening it — the map allows two saturated things and unread is neither.

## Delegated to the implementer

The badge radius per density tier (`ctx.crowded` / `ctx.dense`). An `r=8` disc on
a 28px face at 24 agents is half the portrait, and the answer is a screenshot,
not an argument. Bounded by the two assertions below.

## The baseline, corrected

**The README's "the picture has no screenshot baseline yet" was stale.**
`knowledge-map-jobs` has committed desktop and mobile baselines, tracked in git,
and `bun ui:check knowledge-map-jobs` passes against them (verified 2026-08-13).
The gate is live.

What that buys this slice: the pure half — the module move, `unreadOf`,
`Agent.chat`, `CoreNode.agent` — ran green against those baselines with **zero
pixels moved**, which is the proof a pure move is pure.

What is still true is the half that matters. The **crowded** fixture
(`knowledge-map-crowded-fixture.ts`) carries `unread: false` in all four places —
so the numeral has never been photographed at the density where legibility is at
risk. The base fixture does have one unread job
(`knowledge-map-fixture.ts:96`), so the mark itself is not unphotographed; the
*crowd* is.

Order matters:

1. `bun ui:check knowledge-map-jobs` on the fixture as it stands — the first
   baseline this fixture has ever had.
2. Grow the crowded fixture: an owner with an unread chat and read jobs, one with
   both, one with neither, one whose only unread work is finished.
3. Then the mark.

Without step 1 every later slice is unfalsifiable, and the README's own gate-trap
warning says a real change can pass `ui:check` sub-threshold.

## Verification

- `knowledge-map/unread.test.ts` — receives `palette.test.ts:118-128`'s four
  assertions **unedited** (proof of a pure move is that no assertion changed),
  then the rule, one case per node kind: a face counts only its `chat`; a seat
  only its `jobs`; app, bead, `more`, `add`, `jobsMore` all answer `0`; a face
  whose chat *and* jobs are unread answers `1`, not the sum; an absent `chat`
  answers `0`.
- `knowledge-map/layout.test.ts` — the core node carries `data.duet`, and it is
  the same object by identity, not a copy.
- `framing.test.ts` / `type-scale.test.ts` — **run with the numeral present at 20
  agents.** Either they pass unchanged (the mark lives outside the ink box, as
  the seat's already does) or the change to `inkRadius` is deliberate and
  recorded. Numbers to measure against: `M.AGENT_R = 34`, `FLARE_REACH = 1.16`
  → `inkRadius(agent) = 39.4`; a numeral of `r = 8` at the plate's corner reaches
  ~48–56 depending on offset. The seat's numeral is *already* outside its own
  `inkRadius` (22.6 + 8 vs 22), so precedent says the box need not grow —
  **measure, do not assume.**
- `bun test -g "overlaps anything else"` — not reached by `ui:check <id>`.
- Unprimed [`screenshot-critique`](../../../.agents/skills/screenshot-critique/SKILL.md)
  on the 20-agent shot, asked blind: *what does the number on the portrait mean?*
- [`compare-screenshots`](../../../.agents/skills/compare-screenshots/SKILL.md)
  against the step-1 baseline. Diff the pixels and look; a green tick is not
  evidence.

## Must stay green

The whole geometry suite; `bun --cwd=apps/web run check-types` — the `CoreNode`
field is a compiler-enforced sweep of every construction site.

## What feedback would change this slice

If the unprimed critique reads the face numeral as "1 job" rather than "1 unread
message", the fallbacks in order are: position (a corner the seat's numeral never
uses), then the `aria-label` copy. **Not** a second colour — `unified-session-list`
killed that and the reasoning still holds.
