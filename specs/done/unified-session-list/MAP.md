# Unified session list — quadrant map

> **Historical.** This is the walk that produced the design, kept for its
> reasoning and its landmines. Its build plan and status lines are superseded by
> [`README.md`](./README.md), which records what shipped. Do not follow the
> ladder at the bottom of this file.

The map from an `explore-unknowns` walk over collapsing sessions and jobs into
one list, adding per-workspace-user unread, and closing the `v.any()` holes at
the Convex boundary.

**This walk ran backwards.** The backend was built before the map was written,
on branch `worktree-unified-session-list`. That is not the intended order and it
cost us: two of the landmines in quadrant four are defects the implementation
introduced and the walk then found. The map is still binding for everything
that remains — the web half, unread, the renames, and the cutover.

Status at the time of writing: backend merged-list work is built and green
(88/88 in `packages/backend/src/agent-sessions.test.ts`), production code is
**−112 lines**. Everything in the build plan below is unbuilt.

---

## Quadrant 1 — Known knowns

The settled ground the walk started from, all verified in the tree.

**A job was never a second entity.** `jobSummary` was literally
`{ ...sessionSummary(session), jobView, relaySummary }`. One table, one
lifecycle, two doors.

**The two lists were disjoint, not overlapping.** `listSessions` pinned
`jobView === undefined`; `listJobs` pinned `jobView === view`. A session gained
a `jobView` the moment its state machine started (`events.ts`
`applyStateMachineProjection`), so it *left* one list and *entered* the other.
Exactly one endpoint returned any given row.

**The cache keys already admitted it.** Sessions had `list` / `detail` /
`history`; jobs had `list` and nothing else, because a job's detail *is*
`sessions.detail`. That asymmetry was the strongest single argument for the
merge.

**`status` is the turn's terminal state, not the session's.** `events.ts` only
ever assigns `patch.status` from a terminal event. A machine advancing between
states reports `status: 'complete'` while it runs on. Nothing consulted
`jobView` when grouping — `groupKeyOf` → `stateOf` → `status` — so **a running
job already displayed under "Finished"** before this work started.

**Multi-member workspaces are real.** `workspaceMembers` carries
owner/editor/viewer, invitations are live, and list reads gate on
`assertRole(…, 'viewer')`. Lists are not filtered by `userId`: every member sees
every session. Per-workspace-user unread is therefore the only correct shape.

**`archived: 'include'` was unreachable.** The SPA could not produce it and the
D19 refine rejected it whenever `agentId` was present. It was the sole consumer
of two indexes.

**The knowledge map already truncated.** `use-workspace-map.ts` fetched one page
of 30 active jobs workspace-wide and never called `fetchNextPage`, then grouped
by agent on the client. Per-agent buckets were already wrong on a busy
workspace.

**Hard cutover has precedent.** `specs/done/schema-cleanup/` declared both
environments disposable, reset to the final schema and reseeded rather than
carrying migration machinery. `cutover/README-cutover.md` is the runbook.

---

## Quadrant 2 — Known unknowns

The decision ledger. Every question closed by the user, by the territory, or
recorded OPEN with what unblocks it.

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Panel: top-N per bucket, or scrolling? | **Scrolls.** The API pages by bucket | user |
| 2 | Merge the two lists? | **Yes.** `JobSummary` becomes a narrowing, not a type | user |
| 3 | "Ready to read": group or badge? | **Badge.** Unread annotates, never partitions — it is the Finished query plus a per-user bit, and a per-user bit cannot be an index prefix | user |
| 4 | Scope of unread | **Any bucket.** A running machine that emits output is unread | user |
| 5 | What counts as unread | **Any event advancing `lastEventSeq`.** Simplest; `lastMessageSeq` is a later one-column upgrade if it grates | user |
| 6 | Do `doc_patch` events count? | **Yes** — `todos`/`state_machine` frames are tool calls, which the user sees as activity | user |
| 7 | Where to stamp read | **On view and on every data update** | user |
| 8 | Ring: draw conversations? | **Yes** — any session `running` or `asking`, machine or not | user |
| 9 | Ring fetch shape | **Counts query**, not rows. See landmine L9 | user |
| 10 | `/w/:slug/jobs` route | **Deleted.** Same query under a different name | user |
| 11 | Agent-facing API | **Rewrite `start-session`**; teach job-vs-machine as a concept the wire no longer encodes | user |
| 12 | Search across buckets | **Global.** You search because you don't know the group | user |
| 13 | Attention rank | **`running` outranks `asking`** — running means tokens being spent | user |
| 14 | Unread on the agent face | **Its own badge**, not a state. `fresh` leaves the state enum | user |
| 15 | Panel overflow link | **Deleted.** The panel pages; a second page for the same query doesn't earn its place | user |
| 16 | The word "job" | **UI-only, and it means every session.** Wire and database stay "session" | user |
| 17 | Renames | `status → turnStatus`, `startMode → requestedMachine`, `stateMachine → machineState`, `relaySummary → machine` | user |
| 18 | `sessionRevision` | **Deleted.** Written on every event, read by nothing but tests | territory + user |
| 19 | Sleeping job that gets messaged | **Leave it.** Reads "On a clock" until `turn_started`; the fix costs ~5 more bucket writers | user |
| 20 | Default session noise on the ring | **No filter needed.** It sits at `complete` between turns, so it buckets `done` | territory |
| 21 | Migration for the new required column | **Manual backfill via Convex CLI, or wipe.** Throwaway script, not committed machinery | user |

### OPEN

| Question | What unblocks it |
|---|---|
| Does `JOB_GROUP_ORDER` flip to match the new attention rank? | Currently left as `asking → running → …`: the face answers "what matters about this agent" (money), the panel answers "what should I do" (the blocker). One word from the user either way. |
| Is the badge count exact or capped? | Depends on the counts query's scan bound — see L9. A capped badge is allowed to undercount; an exact one needs a bound nobody has set. |

---

## Quadrant 3 — Unknown knowns

Taste and convention that existed but was not written down.

**The ring is a liveness indicator, not a status board.** One state per agent,
detail one click in. This is *why* `running` outranks everything: the ring's job
is to say the agent is working, not to summarise. It also explains the history
in `use-workspace-map.ts` — the map used to make sixteen round trips to draw
four numbers per agent, and that was torn out on purpose.

**States are ranked and toned in code, never named.** `palette.ts` says it
outright: the name is copy, and copy is translated. Every visible state word
comes from the message catalogue. This is what makes the UI/wire vocabulary
split safe — "job" is a catalogue entry, `session` is a wire word, and they meet
in exactly one place by construction: the agent-facing skill, where an agent has
to choose whether to start a machine.

**Only two states may be saturated** — *needs you* (coral) and *running*
(electric blue), "a warm and a cool, because an alarm and a machine getting on
with it should never have to be told apart by shade."

**Attention and liveness are different questions and never mix.** Attention
picks one top-ranked state and colours the face; liveness is a boolean, true
alongside any colour, driving the pulse. An agent asking *and* working shows
coral and pulses.

**Empty groups are dropped, never rendered at zero.** "A row of five headings
where four say '0' is a form, not a summary."

**A count is a claim.** `use-workspace-map.ts` deliberately leaves a count
`undefined` rather than print one it cannot support. This is the precedent that
governs the unread badge.

### What this reshaped

The state axis becomes **exactly** the bucket vocabulary — `asking · running ·
scheduled · done` — running unbroken from the Convex index prefix, through the
wire, to the CSS tone. That is only true once `fresh` leaves `ItemState`, which
is why decision 14 matters more than it looks. **Treat it as an invariant: a
fifth UI state with no index behind it breaks the chain.**

---

## Quadrant 4 — Unknown unknowns

Landmines found by adversarial sweep. Each is evidence-backed and marked.

### DECIDED — fixed on the branch

**L1 · A finished machine was read as the present.** `bucketOf` short-circuited
on `relaySummary.outcome`, so following up on a completed job stamped
`bucket: 'done'` while its runner ran. Verified before believing it:
`status: "running"`, `bucket: "done"`. Two failures in one — the row vanishes
from the list *and* it is invisible to the terminalization sweep, which walks
only unfinished buckets, so a workspace pause would leave that runner relaying
into nothing. **Rule corrected to:** a *live* machine outranks the turn; a
machine that is over outranks nothing.

**L2 · `sleep` without `state.stateMachine` stranded a job as live work.** The
projection was left untouched, so a job asleep on a clock read as running
indefinitely. A sleep is news about activity even when it carries no machine
shape; it is now carried onto the existing projection.

**L3 · A campaigns fixture inserted sessions without `bucket`.** It typechecked
because that test builds its ctx from a schema-less `convexTest`, so only the
runtime validator caught it. Four tests, missed by running one file.

**L4 · `sessionRevision` was the hottest write in the domain and nobody read
it.** See decision 18. Its real danger was diagnostic: contention on it would
have surfaced as *"unread badges don't clear"*, pointing at the wrong file
entirely.

### SHARP EDGE — accepted, must stay visible

**L5 · Every column `bucketOf` reads becomes a column that must restamp
`bucket`.** Currently `status` + `relaySummary` → 5 write sites. Teaching it a
third input takes that to ~10. This is the standing tax on materializing a
derivation and the reason decision 19 says leave the sleeping-job case alone.
Anyone tempted to add a fourth input should see this bill first.

**L6 · Buckets page independently; there is no cursor across them.** A Convex
cursor belongs to one index range. Each group pages completely — which is what
fixes the truncation — but "page everything unfinished at once" is not a
question with an answer.

**L7 · The optimistic list splicer becomes unsafe.** `patchSessionListCaches`
walks every cached list under `sessionKeys.lists(slug)` and splices optimistic
rows into any whose filters match. Job lists used to be a *different key
prefix*, so they were structurally immune. After the merge every list is a
candidate and `sessionMatchesStructuralFilters` does not know `bucket`. The
`onboarding` guard beside it exists because this exact bug already shipped once.

**L8 · The title-generation poller widens.** `refetchInterval: 1s` while any row
has `titleStatus === 'generating'` now covers job rows too.

### OPEN — decide before or during the build

**L9 · The unread badge count is a join the ring cannot do.** The ring fetches
`running` + `asking` pages; unread accumulates in `done`, which is not in that
payload at all. A *per-row dot* is free (`lastEventSeq` is already on every
summary — hand the client its cursors once). A *per-agent count* needs the
counts query (decision 9), which has no aggregate primitive in Convex and so
counts by walking. **Set a scan bound, or cap the badge and say so in the
contract.**

**L10 · Mark-as-read is not a cheap mutation.** There is no Convex client in the
SPA — everything is REST → Hono → `ConvexHttpClient`. "Stamp on every durable
frame" means one HTTPS request to a serverless function per frame, per open
session, per tab, and `task_output` streams chunk by chunk. **Debounce**, copy
`createSessionDetailRefreshSignal` (1s coalescing with an immediate flush on
terminal), and flush on unmount. The cursor is a monotonic max, so dropped
intermediates are lossless.

**L11 · `sessionReads` needs two indexes.** `(workspaceId, userId, sessionId)`
serves the upsert and the per-user read, but cannot be scanned by `sessionId` —
so the delete cascade in `deleteSessionBatchImpl` needs `by_session` as well.
Miss it and deletion silently leaks rows. Follow that file's batch convention:
one table per pass, reschedule when a batch fills.

**L12 · Deleting an agent terminalizes all its sessions**, bumping
`lastEventSeq` on each — which mass-marks them unread for every member at once.

**L13 · A removed-then-reinvited member resurrects stale read cursors**, so
months-old sessions read as already-read. `removeMember` cascades nothing.

**L14 · A deleting-but-still-running session is no longer swept.** The old
unscoped query had no `archiveState` filter; the bucket walk iterates
`['active','archived']` only. Arguably an improvement — the old path would have
thrown inside `requireWritableSession` and killed the batch — but the runner is
now never told to stop.

**L15 · `provisioningCore`'s `hasActiveWork` reads `status`**, so it has the
mirror-image blind spot L1 described: a running machine with `status: 'complete'`
is not counted as active work. Pre-existing, not a regression, and it is the
last consumer keeping `by_workspace_status` alive.

### Facts to confirm before coding

- The web half does not currently compile — `use-workspace-map.ts`,
  `spa/jobs/*`, `api/client.ts` and `query-keys.ts` still import deleted types.
- `roster.test.ts` is **green while asserting a dead URL**: it pins the string
  against `SKILL.md`, and neither moved. A green suite proving a 404.
- Four staging journeys still build `…/agent/jobs?view=…`.
- `apps/docs` endpoint ledger is stale; `verify-endpoints` exits 1. Regenerate,
  do not hand-edit.
- `SessionListQuerySchema`'s test still asserts `archived: 'include'` is
  accepted. It passes only because Zod strips unknown keys — the assertion is
  meaningless.
- A worktree needs `bun install` before any gate is trustworthy; without it TS
  silently resolves `@repo/contract` from the main checkout.

---

## Build plan

Sorted by likelihood of tweaking, not execution order. Judgment first.

### Most likely to change — decide as you go

1. **The counts query.** Shape, and its scan bound. Everything about the badge's
   honesty follows from this one decision (L9).
2. **Unread write path.** Debounce interval and flush points (L10). Start at 2–5s
   with a terminal/unmount flush and tune against a real busy turn.
3. **`fresh` removal and the badge's visual.** Decision 14 is settled; where the
   badge sits on the face and whether it caps at 9+ is not.
4. **`JOB_GROUP_ORDER`** — the one OPEN question in quadrant 2.

### Settled, but touches a lot

5. **The four renames** (decision 17). Mechanical but wide: contract, schema,
   validators, `projectRelaySummary`, `RelayStatus`, tests.
6. **Delete the Jobs vertical** — `spa/jobs/*`, `routes/jobs*.tsx`, route
   registration, `agentJobsUrl`, the `jobsProduct` catalogue block in both
   locales, 6 coverage-ledger entries, 2 playground registry entries.
7. **Rewire the web data layer** — merge `job-data` into `session-data`, collapse
   the query keys, teach `sessionMatchesStructuralFilters` about `bucket` (L7),
   and stop the title poller widening (L8).
8. **Rewrite `start-session`** for the new surface, keeping job-vs-machine as a
   taught concept, and move `roster.test.ts` with it.

### I trust you on that part

9. Staging journeys, docs ledger regeneration, the `archived:'include'` contract
   test, remaining portable `v.any()` sites.
10. Screenshot re-baselining — ~31 certain, ~17 at risk. Expect coral to appear
    on agents for the first time from plain conversations; that is the change
    reviewers should see, not one buried in a batch.
11. Cutover: backfill `bucket` via the Convex CLI (derivable from `status` +
    `relaySummary`), staging before production, per the `schema-cleanup` runbook.
