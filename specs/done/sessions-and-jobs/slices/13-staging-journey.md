# 13 — Live staging journey

**Repo:** Duet, `packages/test-harness`. The closeout gate. Depends on
everything.

## Contract unlocked

The feature is proven against live staging, end to end, by the path a user
actually takes.

## API seam

A new journey registered in `packages/test-harness/src/staging-e2e-synthetic`
— the map from journey name to `{ fixture, description, run }` alongside the
twelve existing entries. Fixture: `workspace-agent` (the journey needs a real
agent turn), unless the browser half requires `workspace-browser`.

## The journey

1. Open an agent's **default session** through the alias route — confirm no row
   existed beforehand, and that the first message creates it and stamps
   `agents.defaultSessionId`.
2. Ask it for a **recurring check**. The default session must delegate rather
   than run a machine itself — that is the prompt layer from slice 11 doing its
   job, and it is the one behavior most likely to regress silently.
3. The child **job appears in the Jobs list** — and only after its machine
   actually starts (L1/D24: `applyStateMachineProjection` is the only writer).
4. The **parent interrogates the child** with `behavior: "follow_up"` and reads
   the reply back out of history.
5. The job **wakes once on its timer** and reports.

Step 5 is the one that needs slice 04's fleet pin on the red branch — a fleet
still on 0.3.7 cannot prove the reminder half. On the green branch it proves the
existing behavior instead.

## What the human can run or see

```sh
bun run e2e:staging -- --journey sessions-and-jobs
```

Consumes real staging resources. **Run this one journey only, at the end of the
work, as a closeout gate.** Do not run the full suite (`bun run e2e:staging`
with no args) — it takes ~60 minutes and is reserved for dedicated e2e sessions.

## Verification gates

The journey green against live staging. Local gates do not execute staging
journeys, so this is the only place the whole ladder is exercised together.

## Must stay green

The other eleven journeys are not run here; do not modify shared fixtures in a
way that would break them.

## Fixed by this slice

The journey's five steps and their order. One journey, registered, run once at
closeout.

## Delegated to the implementer

Fixture choice, the disposable workspace's lifecycle, and how step 5 compresses
the timer (a short absolute `wakeAt`, not a 24h wait).

## After this slice

Run [close-spec](../../../.claude/skills/close-spec/SKILL.md): archive to
`specs/done/sessions-and-jobs/` and rewrite this plan as a durable rationale
record. Fold `MAP.md`'s L2 verdict — whichever colour slice 00 produced — into
that record, because it is the finding most likely to be re-derived wrongly by a
future reader.
