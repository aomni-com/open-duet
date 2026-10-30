# 11 — Baselines, gates, and closeout

**Contract unlocked.** The picture is evidence, not argument. This closes the
README's two long-standing open items as well as this feature's.

Depends on everything.

## The shots

- **`bun ui:check knowledge-map-jobs`** — re-run against the baseline
  [04](04-the-unread-axis.md) struck, now with the full fixture: an owner with an
  unread chat and read jobs; one with both; one with neither; one whose only
  unread work is finished (so its seat exists solely for the numeral).
- **Re-approve** `knowledge-map`, `knowledge-map-home`, `knowledge-map-zoom` —
  all move if the numeral changes any box.
- [`compare-screenshots`](../../../.agents/skills/compare-screenshots/SKILL.md)
  on every moved baseline: candidate against the prior look, telemetry and a
  less-wrong verdict, not a match check.
- **`--force` on nothing that did not fail.** Three gate traps are live and
  documented in the README: a real change can pass sub-threshold
  (`maxDiffPixelRatio: 0.005`, per-pixel `threshold: 0.3`), `--force` has twice
  baked in drift belonging to neither the feature nor the fixture, and a green
  tick is not evidence. **Diff the pixels and look.**

## The unprimed critique

[`screenshot-critique`](../../../.agents/skills/screenshot-critique/SKILL.md) on
the face numeral at 3, 7 and 20 agents. Ask it blind, and ask it the question
that actually decides the feature:

> *What does the number on the portrait mean, and what does the number beside it
> mean?*

If an unprimed reader reads them as the same roll-up twice, the corner rule or
the mark is wrong — and the fallbacks are position or `aria-label` copy, **not** a
second colour.

Second critique, on the dialog opened from a bead over the ring: *does this read
as a surface over the map, or as a page you navigated to?*

## Human checkpoint — non-blocking

Open the shots with
[`preview-shots`](../../../.agents/skills/preview-shots/SKILL.md), give ~5
minutes, then decide on the evidence, record the decision and its rationale in
the README, close the shots and continue. Implementation never stalls on
sign-off; this is a chance to course-correct a reversible call.

## The gates

```bash
bun test apps/web/spa/knowledge-map               # the pure geometry
bun test -g "overlaps anything else"              # NOT reached by ui:check <id>
bun --cwd=apps/web run test                       # + boundaries + coverage
bun --cwd=apps/web run check-types
bun --cwd=apps/web run lint
bun --cwd=apps/web run visual:coverage:write      # any new .tsx symbol, tests included
bun visual:union:write && bun visual:union
bun assets:verify
```

Then, **once**, as the closeout gate and not as a feedback loop:

```bash
bun run test
```

## Closeout

- Write `choices.md` for this feature — the decisions taken during
  implementation, per [audit-choices](../../../.agents/skills/audit-choices/SKILL.md).
- Amend the archived `agent-jobs-dialog` spec's *"the zoom is state, not a
  route"* invariant (the README's standing TODO).
- Add the forward pointer in `specs/done/unified-session-list/README.md`'s dead
  ends — its face-badge entry needs a line saying where it was re-opened and why,
  or the next reader trusts a closed spec over a live one.
- Add the forward pointer in the same spec's *"The fan-out is the server's"*
  note: this feature moved it back to the browser, deliberately, as the price of
  the frontend-only constraint.
- Update the README's *Next Agent Prompt* one last time.

When all of this is green, [close-spec](../../../.agents/skills/close-spec/SKILL.md)
archives the whole feature to `specs/done/`.
