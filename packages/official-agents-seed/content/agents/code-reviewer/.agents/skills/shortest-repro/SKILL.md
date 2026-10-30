---
name: shortest-repro
description: Shrink a reported failure into the shortest sequence that reliably produces it. Use when a bug report is long, vague, or written as a theory, when a failure only sometimes appears, or when deciding that something cannot be reproduced.
---

# Shortest Repro

A reproduction is what turns "this breaks X" from a claim into a finding. When
a review must demonstrate the failure it names — or a user hands you a bug
report — this is how to get from a paragraph of frustration to ten steps that
fail every time.

## Confirm before you shrink

Run the report **exactly as written**, unshrunk, once. Two outcomes:

- **It fails.** Good — you have something to shrink, and you know the report is
  honest.
- **It does not fail.** That is your first finding and it goes in the report
  before any shrinking: which step diverged, and what happened there instead.
  Do not silently "fix" the steps into something that works and call that the
  repro — you would be reproducing your own guess.

Never start from the report's *conclusion*. "It's a caching bug" tells you which
paths the reporter stopped checking, which is exactly where to look.

## Shrink one thing at a time

Remove one element, re-run, and keep the result. Work outward in this order,
because the later ones are the expensive ones to vary:

1. **Steps** — drop a step. Still fails? It was never part of the repro.
2. **Data** — smaller record, fewer rows, simpler value.
3. **Account** — a different user, then a lower role.
4. **Client** — another browser, another device, another API client.
5. **Environment** — another build, another workspace, another region.

Anything you remove that makes it *pass* goes back in — and it is now the most
interesting thing you have. It is not a step; it is a **condition**.

## Steps versus conditions

Reports mix these and it is why repros fail on someone else's machine.

- A **step** is an action performed in order. It belongs in `## Steps`.
- A **condition** is something that must already be true — a feature flag, an
  account age, an existing record, a timezone, a second tab open, a prior failed
  attempt. It belongs in the environment stamp or the preconditions line.

A condition hidden inside prose is a condition nobody else will have.

## When linear shrinking stalls

Bisect over states rather than removing one at a time: halve the data set, split
the config flags, pick the midpoint build between the last known good and the
first known bad. This is bisection over *states you can construct*, and the goal
is still a sequence a person can run — not a commit.

## Intermittent

Do not write "flaky" until you have looked for the hidden condition. In order of
how often they turn out to be the answer: ordering, timing and races, leftover
state from your own previous attempt, first-run versus second-run, concurrency
(two tabs, two requests), cache warmth, clock and timezone, and data that
changed under you.

If it stays intermittent, report the fraction and the conditions on **both**
sides — what was true in the attempts that failed and in the ones that did not.
That contrast is usually the entire diagnosis, handed over without you having to
make it.

## Stop rules

- Ten steps or fewer, and removing any remaining step makes it stop failing.
  Test that claim, do not assert it.
- Two consecutive shrinking attempts that yield nothing: ship what you have and
  say where you stopped.
- Reliability is measured on the shrunk sequence, from fresh state, three times.
  A sequence you only ever ran once has not been reproduced.

## Keep out of the repro

Your theory, the suspected file, the proposed fix. A repro that names a cause
stops the developer from checking, and if the cause is wrong the failure comes
back under a new ticket. Hypotheses go in `## Notes`, labelled as hypotheses,
after the steps that stand on their own.
