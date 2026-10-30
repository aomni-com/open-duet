# Unified session list

Sessions and jobs are one list. A session's `bucket` says what it is doing, a
per-member cursor says whether you have seen it, and the map reads every agent's
work in one request.

Shipped to staging and production on 2026-08-08.

---

## What it replaced, and why that was wrong

There were two endpoints over **one table**. `jobSummary` was literally
`{ ...sessionSummary(session), jobView, relaySummary }`, and `jobView` was
stamped the moment a session's state machine started — so a session *left*
`listSessions` and *entered* `listJobs` at that instant. The two lists pinned
`jobView === undefined` and `jobView === view` respectively: disjoint, never
overlapping.

That produced the defect the feature exists to fix: **a person's list of their
own work structurally omitted the work that was actually running.** Ask for "all
running sessions" and you had to ask twice.

`jobView` also sat mid-key in nine indexes, so there was no cheap "give me both"
— job-ness had been made a structural dimension of the data rather than a fact
about a row.

**The vocabulary is deliberately one word.** To a reader every session is work;
"job" is a UI word only. An agent still needs the distinction, because it decides
whether to attach a state machine — and the wire's answer is the presence of
`machine`, nothing else. `packages/skills-registry/skills/start-session/SKILL.md`
is the only place that is taught, because it is the only place that needs it.

## The bucket

`SESSION_BUCKETS = ['asking', 'running', 'scheduled', 'done']` — a materialized
column, the leading key of every list index, and the one dimension every surface
groups by.

It is **not** `status`. `status` (now `turnStatus`) is the *last turn's* terminal
state, and for a session running a state machine the two diverge: a machine that
finished one state and moved to the next reports `complete` while it is very much
still running. Grouping by the turn files live work under "finished".

`bucketOf` (`packages/contract/src/sessions/index.ts`) owns the rule, and it
lives in the contract rather than beside the column because two callers need the
same answer — the backend that materializes it, and the SPA that must give a
bucket to a row it is optimistically authoring. A second implementation would be
a second definition of the product's central concept.

**It is materialized because Convex cannot index a derivation** — the same reason
`jobView` was a column, applied to the value the product actually groups by.

### Invariants

- `row.bucket === bucketOf(row)` for **every** row, including ones no list
  returns. Pinned as a data invariant over real transitions, not by grepping
  writers for source text — the riskiest writer assembles its patch across a
  dozen lines and has no literal to grep.
- **Every column `bucketOf` reads must restamp `bucket` when it changes.** A
  writer that updates `turnStatus` or `machine` without recomputing is the way
  this silently rots.
- A **live** machine outranks the turn; a **finished** one outranks nothing. Its
  `outcome` is a fact about the past, and reading it as the present is how a
  follow-up message on a finished job stayed filed under "done" while its runner
  worked — invisible to the reader *and* to the terminalization sweep, which
  walks only the unfinished buckets.
- `asking` outranks everything for **seating**, because the one thing that cannot
  proceed without a person must never be pushed into "+N more". The **badge**
  ranks `running` above `asking` — money being spent outranks a question that
  waits, and the question is still there when you click in. These two orderings
  disagree on purpose; `job-groups.ts` says so.
- **There is no cursor across buckets.** `bucket` leads the index and a Convex
  cursor belongs to one range. Faking a union produces duplicates or holes, so
  the shape the index forces is the shape the UI gets: one cursor per bucket.

## Unread

Keyed `(workspaceId, userId, sessionId)` in `sessionReads`. Unread is a fact
about a **reader**, not a row — several people watch the same agent, and a badge
that cleared for everyone the moment one of them looked would be worse than none.

```
unread = updatedAt > membership._creationTime
         && (cursor === undefined || cursor < lastEventSeq)
```

**Why the floor.** "No cursor means unread" has to be true — the case the whole
feature exists for is a job an agent started that you never opened, and requiring
a prior open would make exactly that case invisible forever. Taken alone it marks
a workspace with any history entirely unread on day one. The floor is the
**membership row's own creation time**, and that placement is load-bearing: a
removed-then-reinvited member gets a new row, so months-old sessions cannot
resurrect as already-read. The bug is designed out rather than patched.

There is deliberately **no `sessionsReadFloorAt` column**. The plan had one;
nothing would have written it, and the property above comes from the membership
row's lifetime, not from an override.

### Invariants

- **The write is a maximum, never an assignment.** That is what makes the
  browser's coalescing window safe — intermediates may be dropped, since the one
  that lands carries everything below it — and makes retries and racing tabs
  non-events. A no-op write touches nothing, not even `updatedAt`: that column
  means "last read something new", not "last asked".
- **Presence clears unread, not mounting.** Every stamp is gated on
  `document.visibilityState`, and there is no `pagehide` flush. An open tab
  behind three windows is not someone reading, and a tab closing is the least
  reliable evidence of presence there is. Wrong-toward-unread is the safe
  direction: a badge you clear by looking costs a click; one that never appears
  means the feature silently did not work.
- **Agent reads never mark read.** A workspace key resolves to a user, so a scope
  check cannot tell an agent from a person on a route they share. The guarantee
  is that no agent code path calls the endpoint — pinned by a test that polls a
  session three ways and asserts no cursor appears.
- **Reading must not move the row.** The dot clears through
  `commitSessionSummaryFields(…, ['unread'])` — deliberately not `updatedAt`, or
  every list ordered by recency would reshuffle the instant someone looked.
- `unread` is server-owned. The SPA never compares sequence numbers, because the
  comparison needs the floor and a floor the client was told about is a second
  place for it to be wrong.

**Accepted defect:** deleting an agent terminalizes its sessions, bumping
`lastEventSeq` on each, which marks them all unread for every member at once.
Rare, loud, and bounded. Suppressing it means teaching the cursor *why* a seq
moved, which throws away the simplicity that makes the predicate one line.

## The map's read

`GET /v1/ws/{slug}/agent/sessions/activity` returns every owner's unfinished
sessions in one request, bounded by a caller-set `limitPerAgent`.

**Rows, not counts.** The ring draws one node per session, so a count would
delete the thing being drawn.

**Per owner, not per drive.** The ring is drawn per agent and was fed three
workspace-wide pages of thirty, split on the client. On a busy drive an agent
whose work fell off page one was drawn with less than it had and sorted in the
drawer as though it had never moved — against a drawer whose headline promise is
"most recently active first". Every extra agent made it worse for all of them.

**The fan-out is the server's.** `owners × 3` index reads is the same work
against the same index either way; doing it here costs one request instead of
one per face, and returns the map to three requests total.

**`take`, not `paginate`.** Nothing turns a page, and a cursor would make the
union impossible. Not paginating is also what made the "unfinished" wire filter
unnecessary — no new index, no new column.

## The public API rule

**Every endpoint is public unless auth genuinely forbids it.** A customer must be
able to rebuild the UI with their API key. This is why `apps.launch` is
published despite answering `302` — the ledger models that with
`responseBody: 'redirect'` rather than leaving a schema absent.

The survivors are shaped by credential class, not convenience: `/v1/admin/**`
and `/v1/internal-admin/**` (staff, cross-workspace), `/v1/vm/**` and the
workspace archive (called *by the VM gateway*, a different trust class), the
Composio OAuth callback (a browser redirect target), the MCP transport (shaped by
the MCP spec, no schema of ours), `connected-providers` (cookie-only today —
publishing it needs scope auth and a capability that does not exist), and the
analytics ingress (Duet's own metrics; a third party posting there would make
`origin: 'product_browser'` a lie).

## Dead ends

- **Counts for the ring.** Planned, then killed: staging had already made jobs
  into nodes, so counts would have deleted the data the ring is made of.
- **The unread badge on the agent's face.** Where it was designed to go. Staging
  cleared that corner deliberately — past seven agents a coloured dot on a
  portrait has no room to say which job it is about. It lives on the Jobs seat,
  which already answers "what is this agent's work doing".
- **A tone for unread.** The reserved `'new'` resolved to the same grey as a
  connected app, and the map allows only two saturated colours, neither of them
  news. Built, shot, and replaced with a full-ink numeral; the tone is deleted.
  A weight cue was tried alongside and removed — 500 against 400 at 13px is
  invisible next to a row of the same words.
- **A source-reading test for the bucket invariant.** Unwriteable against the
  riskiest writer, and a regex over object literals is a brittle oracle for a
  rule about data.
- **`order: 'oldest'` to find an agent's own chat.** An agent starts
  conversations of its own, so no ordering of that list ever means "the chat this
  agent is". The pointer on the owner's row is the sole answer.
- **`export → transform → import --replace-all` for the cutover.** ~800MB moved
  twice to delete keys off 32 rows. `convex import --table X --replace`
  **preserves `_id`** — the assumption that it did not was never checked and was
  the only thing justifying the whole-snapshot route.

## Where the code is

| concern | entry point |
| --- | --- |
| the rule | `bucketOf`, `SESSION_BUCKETS` — `packages/contract/src/sessions/index.ts` |
| the list | `listSessionsImpl` — `packages/backend/convex/domains/agentSessions/queries.ts` |
| unread | `packages/backend/convex/domains/agentSessions/reads.ts` |
| the map's read | `packages/backend/convex/domains/agentSessions/activity.ts` |
| the browser's stamp | `useSessionReadStamp` — `apps/web/spa/sessions/session-reads.ts` |
| the ring | `apps/web/spa/knowledge-map/` (its README owns the drawing) |
| the seat order | `JOB_GROUP_ORDER` — `apps/web/spa/knowledge-map/job-groups.ts` |
| what agents are told | `packages/skills-registry/skills/start-session/SKILL.md` |
| live proof | `packages/test-harness/src/staging-e2e-synthetic` |

Tests that pin the behaviour: `packages/backend/src/agent-sessions.test.ts`
(bucket invariant, read cursor, cascades, activity), `packages/contract/src/sessions/index.test.ts`
(the truth table), `apps/web/spa/sessions/session-reads.test.ts` (presence
gating), `apps/web/spa/knowledge-map/palette.test.ts` (unread is a second axis).

## Visual provenance

- [`assets/05-ring-three-badges.png`](./assets/05-ring-three-badges.png) and
  [`assets/05-panel-four-states.png`](./assets/05-panel-four-states.png) —
  captured from the product during the state-axis pass, and the reason two
  findings landed. They show three grey dots an unprimed reader could not name:
  `scheduled` and `done` shared the `muted` tone, so a job waking in four hours
  drew exactly like one finished last week. The fix was not a fifth colour —
  `done` is silent and `scheduled` is not, so the panel honours `isSilent`.

  They are also the evidence for the gate lesson below: `ui:check` reported
  **zero diffs** while 13 baselines had genuinely changed.

## Two things that outlived the build

**The visual gate cannot be a verdict on a small change.** A badge swapping coral
for blue is under the pixel threshold; `ui:approve --force` plus `md5` is how you
tell. And `--force`'s *first* application is not a no-op even on an untouched
shot — baselines accumulate sub-threshold drift and it flushes all of it at once,
so a changed hash proves nothing unless the baseline was already normalised. The
check that works is opening the picture.

**`convex deploy` always means production.** `convex deployment select staging`
sets the *dev* deployment and does not redirect it, printing a reassuring
confirmation in between. Use `convex dev --once` for staging. This cost a
production deploy of unmerged code during the cutover; details in
[`cutover/staging.md`](./cutover/staging.md).

---

The decisions taken without the user, with verdicts, are in
[`choices.md`](./choices.md). The quadrant walks that produced the design are
[`MAP.md`](./MAP.md) and [`MERGE-MAP.md`](./MERGE-MAP.md); the build-time
findings are [`AUDIT.md`](./AUDIT.md).
