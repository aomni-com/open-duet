# 10 — Delete the two-step's machinery

**Contract unlocked.** No dead reachability. The README's own rule: *"No
transitional seams. Every deletion is unconditional."*

Depends on [09](09-one-click-opens-it.md). Kept last and separate **on purpose**:
this is the slice to revert alone if the user misses the fly-in.

## Deleted

- `layout.ts#openBranch`, `openedElsewhere`
- the `Openable` mixin and `node.open` on `JobNode` / `JobsMoreNode`
- `JobsNode.deg` / `along`, and the doc paragraph explaining why they are carried
- `jobSeatsOf`'s `opened` parameter
- `JOB_OPEN_PITCH`, `JOB_OPEN_LIFT`, `M.JOB_OPEN_R`
- the `n.open` ternaries in `size` / `discRadius` / `inkRadius`
- `KnowledgeMapZoom`'s `jobs` variant; `openId`; `nodeClass`'s `open` parameter
- the `km-gone` `openedElsewhere` clause
- `branchJob` and `onZoom`'s jobs branch in `agents-map.tsx`
- the playground's zoom-jobs arm

## NOT deleted — two corrections worth writing down

**`ctx.jobTitles` survives.** It is `Ring.jobTitles`, solved in `layout.ts:144`
from the **resting** arc (`charsIn(jobPitch, TYPE.t3) >= JOB_TITLE_MIN_CHARS`),
and `BeadBody` reads `node.open || ctx.jobTitles`. Once `node.open` is gone it is
the *only* thing deciding bead captions. Deleting it with the rest would silently
remove bead titles from every small-fleet ring — a visible regression with no
test on it.

**The frame-budget work outlives the flight it was measured on.** Of the three
fixes in the README's *What the frame budget cost*:

- the SVG `transform` attribute → CSS property fix, and
- the `--km-hold` quantisation to 0.05

are general — they serve the agent zoom and every hover, and are still in force.
Only `openBranch`'s reference-preserving rebuild described deleted code;
`build(data)` simply stays as it is, and its 88% identity property becomes the
resting invariant rather than a toggle property. The **measurements** stay in the
README as knowledge. The code goes.

## Why delete rather than keep the flight reachable another way

This was the feature's highest-risk open question. Resolved, with reasons:

1. **Nothing tests it.** `openBranch`, `openedElsewhere` and `JOB_OPEN_*` have no
   coverage in `layout.test.ts`, `framing.test.ts`, `type-scale.test.ts`,
   `flight.test.ts`, the playground spec, or the components tree. It is the only
   substantial block in `layout.ts` with no test.
2. **Unreachable-but-live code here is a second owner** of *how a job row is
   drawn*, against `ctx.jobTitles` — which the README's own one-owner table
   forbids.
3. **Keeping it reachable means inventing a gesture nobody asked for** —
   hover-to-fan, long-press. That is a new feature wearing a compatibility
   costume.
4. Git has it, if it is ever wanted back as a feature with its own slice.

## Verification

- `bun --cwd=apps/web run check-types` **with zero suppressions** — the real gate
  here. The union narrowing sweeps every reader.
- `bun test apps/web/spa/knowledge-map`; `layout.test.ts` loses its branch cases
  and **nothing else moves**.
- `flight.test.ts` loses its branch cases and keeps its agent-zoom ones.
- `bun test -g "overlaps anything else"`.
- `bun --cwd=apps/web run visual:coverage:write` and
  `bun visual:union:write && bun visual:union` for the removed symbols.
- `bun ui:check` across all four map fixtures. **Expected: no pixel change at
  rest**, because the resting drawing never used `node.open`. Treat any diff as a
  regression to explain, not to `--force`.

## Stale links

`?branch=ops` becomes an unknown query on the ring, which the grammar already
ignores — `mapPlaceOf` reads the param and, absent it, answers `{kind:'ring'}`.
No redirect and no notice, consistent with decision 8's hard cutover. Worth one
line in the README so the first bug report is already answered.

## Risk

~150 lines with no coverage. The mitigation is that they are unreachable after
[09](09-one-click-opens-it.md), so the failure mode is a compile error rather
than a silent one.

## Delegated

Nothing. Every symbol is named above.
