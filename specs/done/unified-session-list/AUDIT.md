> **Build-time findings**, kept because several are traps that will recur.
> [`README.md`](./README.md) is the record of what shipped.

# Slice 00 — audit of the built half

The backend merge landed before the map existed. This is its disposition against
the map's decisions, plus the gate baseline every later slice is measured from.

## Gate baseline

Measured with the project's own gates, **one at a time**. See the warning below.

| Package | Result |
|---|---|
| `packages/contract` | **433 pass, 0 fail** |
| `packages/gateway` | **895 pass, 0 fail** |
| `apps/api` | **415 pass, 7 skip, 1 fail** |
| `packages/backend` `agent-sessions.test.ts` | **89 pass, 0 fail** (88 + the new invariant test) |
| `packages/backend` `provisioning.test.ts` | **23 pass, 0 fail** |
| `packages/backend` full suite | **932 pass, 0 fail** (measured alone in slice 04, both before and after the rename) |
| `apps/web` | cannot run — 66 typecheck errors, test files do not load |
| `bun run check-types` | 17/19 packages pass; `test-harness` and `web` red |

**The single API failure** is `agent session list route > serves the indexed
active/history Job pages separately from Sessions` — the test for the deleted
`/agent/jobs` route. Slice 03 owns it.

`apps/web`'s 66 errors, by class:

| Class | Count | Owner |
|---|---|---|
| TS2741 — `bucket` missing | 36 | slice 02 (fixtures) |
| TS2305 / TS2724 — deleted `Job*` types | 24 | slice 03 (deletion) |
| misc | 6 | inside the jobs playgrounds; die with them |

`test-harness` is red for the same `Job*` imports — slice 11.

### Warning for anyone re-measuring: run one suite at a time

The first API run reported **42 failures**, the second **47**, the third — run
alone — **1**. The 46 were `ConnectionRefused` against a dead local Convex
fixture, caused by a *backgrounded test command of my own* that was still running
the backend suite and respawning fixtures on other ports.

The harness's `convex-dev-supervisor.mjs` restarts a killed backend, so orphaned
fixtures do not simply die out; the supervisor has to go too. Before trusting any
number here:

```
ps -eo pid,etime,command | grep -E "[c]onvex-local-backend|[c]onvex-dev-supervisor|[b]un test"
```

A non-deterministic failure count in this repo is a contention smell, not a
flaky-test smell. Recording 42 as a baseline would have poisoned every later
slice's "must stay green".

**The full backend suite was never measured alone**, and the number is therefore
absent above rather than guessed. Two other runs were competing for it: a leftover
root `bun run test` from a completed planning subagent, and — still running — a
backend suite belonging to **a different Claude session** (a different parent
process, not this one). That one was left alone on purpose; killing another
actor's work to get a cleaner number is not a trade worth making, and this repo
has an incident on record from exactly that reasoning.

The files this spec's "must stay green" actually names — the sessions suite and
provisioning — were each measured alone and are recorded above.

One full-suite run did complete under that contention: **913 pass, 6 fail** in 23
minutes. Zero of those failures were `ConnectionRefused` — they were timeouts and
races, which is the more dangerous shape, because a contention failure that isn't
a connection error is indistinguishable from a real defect by eye. The one that
was still visible in the captured output (`seed-at-birth.test.ts`) passes **8/8**
run alone.

**Rule for this repo, learned the expensive way:** never measure a suite while
another is running, and check for live runs before believing a number. Contention
here does not announce itself.

### The rule's other edge, learned in slice 04

The rule above is true and it is also a trap, because it gives every failure an
innocent explanation. Slice 04's full backend run showed 19 failures across three
files, fifteen of them `ConnectionRefused` — textbook contention shape. It was
**one real defect**: a renamed field broke an assertion inside an `eventually()`
retry loop, the loop spun to the 5s timeout, the fixture backend was torn down,
and every later test in the file failed on a dead socket.

Run-alone reproduced it exactly (8/23), and a bisect against the pre-slice-04
tree settled it (23/23 there). **Bisect before you believe "contention"** — the
cost of one bisect is minutes; the cost of shipping the defect it was hiding is
the slice.

It then happened a *second* time in the same slice, and the second bisect is the
one that matters: the full backend suite read **918/14** on the working tree and
**932/0** on the tree one commit behind it. A clean baseline is the only thing
that can tell "the suite is flaky here" apart from "I broke it" — the two produce
the same output. Measure the baseline before theorising.

**The full backend suite is 932/932 and stable.** It was recorded as
"never measured alone" through slice 03 and is now measured, twice, in both
directions. Treat any failure in it as real.

The genuine flake in that same pass looked *different*: `default session aliases
stay lazy` fails only under full-suite load, passes run-alone, and its own body
already retries a background dispatch behind `if (gatewayCalls.length === 0)`.
Two samples of the full API suite: one fail, one clean 416/423. A test that
admits its own race in its source is the profile of a real flake; a cascade of
socket errors behind a single timeout is not.

### The visual gate was unrunnable for three slices, and nobody noticed

Slice 03 deleted the `jobs-density` playground, which the shared-UI ledger named
as the exact owner of four HoverCard symbols. Coverage is symbol-exact, so
`ui:check` refused to start — and because it refused *before* Playwright, it
never reported a test failure. Slices 03, 04 and the first half of 05 all read
green while the entire visual suite was dark.

What that hid: a test slice 03 itself rewrote — `session-relay-disclosure opens
from its production Session host` — navigated to `/w/acme/sessions` and clicked
a link that does not exist there (that route is the compose hero; the deleted
Job route was the one with a list). It had never run once.

Two rules fall out:

- **A gate that refuses to start is not a gate that passed.** Read `ui:check`'s
  tail for `passed`, not just its exit path through lint and typecheck.
- **`ui:check` aborts at the first failure** — the run that found the above
  reported `1 failed` and **426 did not run**. One red test hides everything
  behind it, so a clean-looking count after a failure means nothing. Enumerate
  with `--max-failures=0 --workers=1` before believing a total.

### `grep "error TS"` does not find TypeScript errors

`tsc` defaults to pretty output, which ends in a **summary table** — file paths
and counts — not `error TS####:` lines. So `grep -cE "error TS"` returns `0` on a
run with five real errors, one of which was a live bug (`group.jobs` against a
type whose field is `items`).

This is the same lesson as the filtered-count note above, and it was learned
again three times after that note was written, because the note blamed the count
rather than the command. Both halves are needed:

```
bunx tsc --noEmit --pretty false -p <pkg>/tsconfig.json
```

And **use each package's own check config** — `apps/api`, `packages/gateway` and
`packages/backend` check through `tsconfig.check.json` or a second convex pass,
so pointing tsc at the plain `tsconfig.json` reports dozens of errors that the
real gate does not have. Reading the wrong config is as misleading as reading
the wrong grep.

Three shapes of the same failure now have entries here: a gate that refuses to
start, a gate that aborts at the first failure, and a gate whose output your
filter cannot match. All three exit in a way that reads as success.

### apps/api baseline moved, deliberately

Was 415 pass / 1 fail — the permanent failure being the test for the deleted
`/agent/jobs` route. Now **416 pass / 0 fail**: slice 04 rewrote that test into
`returns machine-backed and plain sessions in one page, bucketed apart`, which
pins the merge instead of the thing the merge removed. There is no longer a
known-failing test in this suite; treat any failure as real.

## Decision verdicts

Every decision in the map's quadrant 2, checked against the code.

| # | Decision | Verdict |
|---|---|---|
| 1 | Panel pages by bucket | **partial** — the backend pages by bucket; the panel is slice 06 |
| 2 | One list; `JobSummary` is a narrowing | **held** — `listJobs`, `JobSummary`, `JobView`, `JobListQuery/Response` all gone |
| 3 | Unread is a badge, never a partition | not built — slices 07–09 |
| 4 | Unread spans every bucket | not built |
| 5 | Unread = any event advancing `lastEventSeq` | not built |
| 6 | `doc_patch` events count as unread | not built |
| 7 | Stamp on view and on data update | not built |
| 8 | Ring draws `running`/`asking` conversations | not built — slice 05 |
| 9 | Ring fetches counts, not rows | not built — slice 09 |
| 10 | `/w/:slug/jobs` deleted | **partial** — the API route is gone; the web route is slice 03 |
| 11 | `start-session` rewritten | not built — slice 10 |
| 12 | Search is global across buckets | **held** — `search_sessions` applies `bucket` only when asked |
| 13 | `running` outranks `asking` | not built — slice 05 |
| 14 | `fresh` leaves the state enum | not built — slice 05 |
| 15 | Panel overflow link deleted | not built — slice 03 |
| 16 | UI says "job", wire says "session" | not built — slice 03's catalogue audit |
| 17 | The four renames | **1 of 4** — `relaySummary → machine` done early, out of order (see slice 04); three remain |
| 18 | `sessionRevision` deleted | **held** — column, function, 11 call sites, and the wire field |
| 19 | Messaged sleeping job still reads "on a clock" | **held, accepted** — `bucketOf` prefers a live machine's `sleeping` reading |
| 20 | Default session buckets `done` between turns | **held** — no filter needed; it sits at `complete` |
| 21 | Manual backfill or wipe | **unproven** — see the deploy probe below |

## Landmine dispositions

**L1 — fixed, and the fix was not free.** `bucketOf` originally short-circuited on
`machine.outcome`, so a follow-up message on a *finished* job stamped
`bucket: 'done'` while its runner ran — invisible to the list *and* to the
terminalization sweep. Pinned by `answering a finished job puts it back under
running, not done`. The corrected rule: **a live machine outranks the turn; a
machine that is over outranks nothing.**

**L2 — fixed.** A `sleep` event omitting `state.stateMachine` left the projection's
activity stale, stranding a job asleep-on-a-clock as live work. Now carried onto
the existing projection.

**L3 — fixed twice, and it will happen again.** A campaigns fixture inserted
sessions without `bucket`; it typechecked because that test builds its ctx from a
schema-less `convexTest`, so only the runtime validator caught it. Four tests,
found by running the whole suite instead of one file.

**Slice 04 hit the identical wall — same file, same four tests** — this time for
`turnStatus`. That is not coincidence, it is the shape of the hole:

> `convex/domains/campaigns/conversionFit.test.ts` inserts `agentSessions` rows
> through `convexTest`'s untyped `ctx.db`. **Every required column added to or
> renamed on `agentSessions` breaks it, and nothing but a runtime
> `Validator error: Missing required field X` will say so.**

It is the only file in the repo that inserts session rows directly
(`grep -rn "insert('agentSessions'"` returns it and the production writer, and
nothing else). **Slice 07 adds `sessionReads` and will meet it a third time.**

Its failure is also disproportionate to its cause: the run that found it showed
**14 failures**, only 4 of them here — the other 10 were a `provisioning.test.ts`
cascade that disappeared the moment this fixture was fixed. Chasing the big
number first wastes the pass; fix the validator error and re-measure.

**L5 — the standing tax, now measured.** `bucketOf` reads two fields and is
stamped at **five** write sites (`events.ts` ×2, `delivery.ts` ×3). Every field
`bucketOf` reads becomes a field that must restamp `bucket`. See the deviation
below for how this is now enforced.

**L14 — accepted, carded, and re-argued.** The sweep walks `['active','archived']`
and so no longer reaches a `deleting`-but-running session, whose runner is
therefore never told to stop. The spec recommended fixing it here. I disagree
with the location: `requireWritableSession` throws for deleting rows, so
sweeping them means teaching the sweep to tolerate a row it is documented not to
touch. **The honest fix is at delete time** — `beginDeleteSession` should
interrupt the runner rather than leave the sweep to find it later — and that
changes delete semantics, which is outside this spec. Recorded as a pre-existing
gap that this change narrowed rather than opened.

**L15 — fix, and it is worse than "reads the wrong field".**
`provisioningCore.hasActiveWork` counts `status: 'running'` and `'ask'` only. So
a workspace reprovision can proceed while a state machine is mid-run
(`status: 'complete'`, bucket `running`) or asleep on a clock (bucket
`scheduled`) — it sees no active work and reprovisions underneath it. This is the
exact mirror of L1, on the operator path.

**Fixed here.** A one-for-one index swap, not a new access path:
`by_workspace_status` had exactly one consumer left (this function), so it is
replaced by `by_workspace_bucket` and the two status reads become one walk of the
three unfinished buckets. Index count unchanged; `provisioning.test.ts` 23/23.

Note this also *widens* what counts as active work, deliberately: a job asleep on
a clock now blocks a reprovision. The old pair (`running` + `ask`) already counted
a session waiting on a human, so the intent was never "CPU is busy" — it was
"unfinished work exists", and `bucket` is the column that knows.

## Deviation from the slice, with reasoning

The slice specified a **source-reading** test (`bucket-writers.test.ts`) that
greps `ctx.db.patch` literals for a co-occurring `bucket`. I did not build that.

It cannot work on the most important writer. `events.ts` builds a `patch` object
across a dozen lines and then calls `ctx.db.patch(session._id, patch)` — there is
no object literal at the call site to grep, so the one writer most likely to
drift is the one the test cannot see. And a regex over TypeScript object literals
is a brittle oracle for a rule about *data*.

Replaced with a **data-invariant** test: drive every transition through the real
mutations, then assert that every resulting row satisfies

```
row.bucket === bucketOf(row)
```

This is strictly stronger — it catches a missed writer wherever it lives,
including one added later in a file that does not exist yet — and it asserts
through the entry point rather than through the source text. It also gets better
after slice 01, when `bucketOf` moves to the contract and the test imports the
same function production uses.

## Deploy probe

See `cutover/probe.md`.

## A pre-existing api failure that only appears under full-file load

`default session aliases stay lazy, create-or-message, and attribute agent cwd`
fails in a full `bun test src/index.test.ts` run and passes when run alone. The
assertion is `gatewayCalls.length > 0` inside an `eventually`, after retrying a
queued root default (`index.test.ts:12262`).

**It is not slice 07's.** Bisected by stashing the whole working tree and
re-running the file: it fails there too, at the same assertion. Recording it
here rather than fixing it because the mechanism is the shared runner-drain, not
the read cursor — but it is load-dependent rather than random, so slice 11 and
the cutover should expect it and not read it as a new regression.

## Slice 07 kept its cascade tests off the scheduler where it could

`removeMember` schedules its purge, so the test for it has to poll — and it
does. The *delete* cascade's boundary test does not: `drainDeleteBatches` runs
the passes by hand, so a truncated first pass shows up as leftover rows instead
of as a race against the scheduler. Both boundaries were falsified by deleting
the reschedule and watching them go red.

Reaching those boundaries needed more rows than a batch holds. Two bulk seeders
(`seedMemberReadsForTest`, `seedSessionReadersForTest`) build 250 rows in one
transaction each; the alternative was 250 round trips per test for no extra
coverage.

## `readCursorsFor` was written and then deleted in the same pass

The reads module started with a batched cursor lookup for slice 08's unread
projection. Nothing called it. It is deleted — slice 08 adds the reader at the
call site that proves its shape, rather than inheriting one guessed a slice
early.

## Slice 08: the visual gate was green on a change it could not see, twice

First the gate passed on `agent-surface`, `agent-surface-busy` and
`knowledge-map-home` — the three shots the slice names. A `--force` approve plus
`md5` said two of the three baselines had genuinely changed, which looked like
confirmation. It was not: those shots draw the *ring*, and the dot is a
*row*-level mark. The bytes that moved were something else.

The shot that actually draws the rows is `agent-jobs-dialog`, and it was
byte-identical — because the fixture it reads (`SURFACE_ALL_JOBS`) had every row
set `unread: false` by the same mechanical sweep that added the field. The
feature was correct, the test was correct, and the evidence was of the wrong
frame.

Two rules out of it, both already in the README's gate but worth the concrete
case:

- **Name the shot that draws the thing, not the shot near it.** "The baseline
  changed" is not evidence the change is the one you made.
- **A mechanical fixture sweep sets the boring default everywhere, including in
  the one fixture whose whole job is to show the interesting case.** After a
  sweep, go back and pick the rows the shot exists to draw.

## `ui:approve --force` flushes old drift, so a changed md5 proves nothing on its own

Measured in slice 09b, on `knowledge-map-empty` — a shot with no jobs at all,
which this feature cannot touch:

```
md5 before                     e648638b…
ui:approve --force  → md5      c6ee2f02…     ← changed
ui:approve --force  → md5      c6ee2f02…     ← stable
```

The *first* force-approve is not a no-op even on an untouched shot. Baselines
accumulate sub-threshold drift over many merges and never get re-approved,
because the gate is green the whole time; the first force flushes all of it at
once, and only the second run is deterministic.

**So the byte-diff recipe in the README's gate is necessary but not sufficient.**
"The baseline changed" is evidence only when the baseline was already normalised.
This correction applies to the slice 08 entry above: the two ring shots whose
md5s moved were probably flushing drift, not drawing the row dot — which is
consistent with what that entry concluded for a different reason.

The check that actually works is the one that ended both slices: **open the
picture and look at the thing.** For a mark this small, crop and upscale it.

## Slice 08: `bun test` in `apps/web` is not the web gate

Bare `bun test` from `apps/web` collects the Playwright specs and reports seven
failures that are not failures (`Playwright Test did not expect test() to be
called here`). The gate is `bun run test`, which scopes to `./scripts ./app
./src ./spa` and then runs the boundary and visual-coverage checks.

## `spa-shell` navigation shot is unstable, and it predates this branch

`playground/spa-shell exercises navigation, workspace, locale, and logout` fails
about **one run in four** on this branch. Measured, not guessed: six runs of the
shot alone, one failure; the failing frame is always `spa-shell-agents-home.png`.

The diff is the **whole ring drawn at two vertical offsets** — a reflow, not a
data difference. The mechanism is by design and documented in `layout.ts`: an
agent with work in flight shows one app fewer *because the Jobs seat takes a
seat in the same row*. So when the work read lands, every fan with work
re-seats, and the map moves. `use-workspace-map.ts` states the intent plainly —
"the map draws as soon as the ring is known… the fans grow; nothing blocks on
anything."

The playground's readiness gate cannot see it. `playground-shell.tsx` waits for
four frames of stable **body height**, and the ring is a fixed-height SVG whose
*contents* move. Height never changes, so readiness fires before the reflow.

**It is not this branch's.** Checked against a clean worktree at `origin/staging`
(`de089959`): the same test fails there too, on every run. Consolidating three
session reads into one activity read changed the timing of the reflow; it did
not introduce it.

Left alone deliberately. Fixing it properly means either making the map reserve
the Jobs seat before its work data arrives — a real design change to progressive
rendering — or teaching the playground shell to wait on in-flight queries rather
than on body height. Both are worth doing and neither belongs at the tail of
this feature.
