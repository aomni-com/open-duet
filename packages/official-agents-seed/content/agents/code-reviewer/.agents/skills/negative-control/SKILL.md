---
name: negative-control
description: Prove a check could have failed before reporting it as a pass. Use when writing a pass condition, before marking any case green, when a check passed on the first attempt with no setup, or when deciding whether a run is evidence of anything.
---

# Negative Control

A check that cannot fail is not evidence — it is a green light wired to nothing.
`AGENTS.md` says any check you run must name a control that could have failed;
this is how to build one and how to spot a check that never could.

## The four controls

Pick the cheapest one that applies to the case in front of you.

| Control | How | What it proves |
| --- | --- | --- |
| **Prior build** | Run the identical steps against the build before the change | The strongest. The change is what moved the result, not the environment or your setup |
| **Broken input** | Change one thing the feature must depend on — wrong id, malformed value, missing required field | You are touching the code you think you are |
| **Off switch** | Flag off, permission revoked, dependency stopped | The path you exercised is the new path, not the old one still serving |
| **Fresh state** | Repeat from empty data, new account, cleared session | The pass belongs to the feature, not to the row you happened to have |

Run the control, **watch it fail**, then run the real check and watch it pass.
Reversing that order — pass first, control afterwards "to be sure" — usually ends
with the control quietly skipped.

## What to record

One sentence in the review record: what you broke, and the failure you saw.

```
Negative control. Re-ran TC-004 with an orderId from another workspace:
200 and the same body → the handler never reads orderId. Check was worthless
and is rewritten as TC-004a.
```

That example is the point. The control's job is to catch checks like TC-004,
which would have gone green against a completely broken feature.

## Checks that could not have failed

Treat any of these as a red flag on the check, not a fact about the feature:

- **Green on the first attempt with no setup.** Nothing had to be arranged for
  the condition to hold, so it probably already held.
- **Two different inputs produce identical output.** The input is not reaching
  the code.
- **It would have passed before the feature existed.** Ask this of every case
  before running it — it is the single most common worthless check.
- **The assertion is on the wrong thing:** page loaded rather than the value on
  it, request returned 200 rather than the record it was supposed to write,
  element present rather than element correct.
- **You read it from a cache.** A stale tab, a CDN, a memoised response, a
  service worker. Hard-reload, or fetch with the cache bypassed, before
  believing any UI pass.
- **The wait did the work.** A check that only passes when you happen to be
  watching, or only after a sleep you added, is timing-dependent — that is a
  finding, not a pass.

## When no control is possible

Say so. Some cases genuinely cannot be inverted cheaply — a destructive
migration, a one-way external side effect, a third-party outage path. Then:

1. Mark the case `not verified`, not `pass`.
2. Name the control that *would* settle it and what it would cost.
3. Carry it into the review's *Not reviewed* section.

`not verified` is a real result and it is safe to publish. A `pass` you could not
control is the one output that makes a team stop looking.
