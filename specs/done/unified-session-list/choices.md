# Choices ledger

Decisions made while building where the spec was silent. Appended per pass and
**rewritten from scratch at close** against the shipped code — so a reader is
never handed a "will be resolved later" verdict that nobody went back to check.

The 21 decisions closed during the quadrant walk are **not** here; they live in
[`MAP.md`](./MAP.md) and were the user's. This file is only what got decided
without them.

---

## Slices 00–03

### Sound

**The bucket invariant is tested as data, not as source text.**
The spec asked for a test that reads the writer source and asserts every
`ctx.db.patch` on a session also sets `bucket`. That is unwriteable against the
riskiest writer, which assembles `patch` across a dozen lines before patching —
there is no literal to grep for. Instead the test drives every transition and
then asserts `row.bucket === bucketOf(row)` over **all** rows, including ones no
list would return. It catches strictly more: a writer that sets `bucket` to the
*wrong* value passes the source-reading test and fails this one.

**`listNeedsTitlePoll` became an exported pure predicate.**
The title poller ran at 1 Hz forever. Making the "is a poll still warranted"
question a pure function of `(pages, now)` — with a 60s window — let it be tested
without a timer, which is the only reason the bound is trustworthy.

### Provisional — carried, and confirmed at close

*(none outstanding for these slices)*

---

## Slice 04 — the four renames

### Sound

**`ComposeSessionInput.status` renamed too, though the slice's table did not list it.**
`compose-session.ts` appears in the "keeps `status`" column of the slice's
classification table — but that entry is about a *todo's* `status`. The file
holds two: the composer input's, typed `SessionSnapshot['turnStatus']`, and the
todo's. Renaming the input is what makes the file unambiguous, and the todo
values (`completed` / `pending` / `in_progress`) are the tell that kept them
apart. The diff confirms only session-vocabulary values moved.

**Fixture helper *parameters* renamed, not their shorthand spreads.**
Several fixtures took `status: SessionSummary['turnStatus']` and spread it as
`{ turnStatus }` shorthand. Writing `turnStatus: status` would have satisfied the
compiler while reintroducing exactly the two-names-one-concept this slice removes.

**The message catalogue block `duetApp.sessionProduct.status` → `turnStatus`, both locales.**
The slice called for this. Two things worth knowing before someone "corrects" it:

- The key order was preserved *in place* rather than re-serialising the JSON,
  which would have reformatted two large files and buried the change.
- **The block has 7 keys but `AGENT_SESSION_STATUSES` has 5.** `failed` and
  `cancelled` are not session-row statuses — they come off a `complete` event's
  terminal outcome, via `lifecyclePresentation` in `ordered-agent-parts.tsx`. The
  name still holds: every one of the 7 is a word about *how a turn stands*, and
  the row's column simply cannot be all of them. Do not narrow this block to the
  enum — the lifecycle rows would lose their labels.

**The `/agent/jobs` route test was rewritten, not deleted.**
`index.test.ts` still carried `serves the indexed active/history Job pages
separately from Sessions` — a slice-03 leftover asserting the two lists are
*apart*, which is the behaviour the merge removed. Deleting it would have
quietly dropped coverage of the merge's central claim, so it is now `returns
machine-backed and plain sessions in one page, bucketed apart`: two sessions
whose turns end identically, bucketed differently because one still has a live
machine. Falsified by making `bucketOf` blind to the machine — it goes red with
`bucket: "done"`, which is the L1 regression exactly.

**The API test's hand-written `AgentSessionListResponse` interface was deleted, not patched.**
It was a local mirror of the wire shape, unbound to the contract — and it had
already drifted, still declaring the `revision` field slice 03 removed. Same
defect slice 02 fixed on the web side, so the same fix: use
`SessionListResponse` from `@repo/contract` directly.

**`packages/test-harness` was left red on purpose, and slice 11 cleared it.**
48 typecheck errors sat there for seven slices, all from the deleted Jobs
vertical — renaming inside code that was about to be rewritten would have been
wasted motion. It was named out loud at the time so "the tree is green" was
never read as covering it. **It typechecks clean now**; see the slice 11 entry
below for what the 48 turned out to be.

The exception: `staging-e2e-synthetic` waited on
`snapshot.status === 'interrupted'`, which after the rename never becomes true.
Its predicate *is* typed (`(snapshot: SessionSnapshot) => boolean`), so the
compiler would have caught it — but only once the package compiles again, which
is slice 11. Fixed now because it costs one word and otherwise sits as a live
tripwire on slice 11's path: a **staging journey** that hangs against real
resources until timeout and then reports the wrong reason.

---

## Slice 05 — the state axis

### Sound

**`groupJobs` kept; only `groupKeyOf` deleted.**
The slice said delete both, on the grounds that "the server groups now". The
server groups for *paging* (slice 06); the panel still receives a flat list and
something must fold it into ordered sections for rendering. What was wrong with
the old module was that it **classified** — deriving `scheduled` client-side from
`jobIsLive`, a second state axis free to disagree with the palette's. That is
gone. What remains is a fold on `job.state`, a field that now simply exists, plus
the reading order. Deleting it too would have moved the same loop into the
component with no owner and no test.

**Finished rows lost their dot rather than gaining a colour.**
`scheduled` and `done` share the `muted` tone, so the panel drew them
identically. The obvious fix — give `scheduled` its own tone — would have spent
the `'new'` tone that slice 09 reserves for unread, and added a colour to a
palette whose whole argument is that it has few. Instead the panel now honours
`isSilent`, which the palette already defined and the panel was ignoring. Finished
work wears no mark, which is the rule the ring already followed.

**The panel eyebrow's copy changed, and a dead catalogue key went with it.**
"N in flight" over a list containing finished work is a false claim, and it was
false before this slice — the merge put `done` sessions in a list whose label
still described the old jobs-only `active` view. Now "N jobs". `allJobsDrive`
("See every job on this drive") had no consumer left after slice 03 deleted the
overflow link; removed from both locales.

**The home fixture's `job()` takes an optional machine.**
Not cosmetic: with every fixture job carrying a machine, the slice's headline
claim — a plain conversation colours its agent — could not be rendered or
tested. Support Triage's question now comes from a machine-less session.

**A slice-03 test was repointed at the host it names, not repaired in place.**
`session-relay-disclosure opens from its production Session host` navigated to
`/w/acme/sessions` and clicked a link named for a session. That route, with no
session id, is the welcome hero and its compose bar — **it has never carried a
list of sessions.** The Job route did; when slice 03 rewrote the test off the
deleted route it carried the click across to a surface with no such affordance.
It now goes straight to `/w/acme/sessions/session_sleep`, which is what "its
production Session host" means. Two dead `/w/acme/jobs` entries went out of the
shell playground's route list at the same time.

Worth stating plainly: **that test had never once run.** The same commit that
rewrote it broke the visual gate (see the HoverCard ledger fix), so slice 03,
04 and the first half of 05 all reported green over a suite that aborted before
reaching it. The gate being *runnable* is a precondition for it being evidence.

**The developer docs were describing the deleted design, and slice 12's scope grew.**
Turning the gate back on failed `docs-sessions` and `docs-reference`, which pass
at the branch point — so this branch caused them. The *size* change was honest
(the endpoint list lost `jobs.list`, 132 → 131), but reading the page showed the
hand-written prose still said:

> Sessions that acquire a runner state machine move into Jobs. … Page Active and
> History directly through the Jobs endpoint; ordinary Session list pages exclude
> Jobs.

Three false claims: there is no Jobs endpoint, no Active/History views, and the
Session list does not exclude anything. Rewritten to describe `bucket` and the
one list, plus two smaller stale phrases ("The Job and Session detail responses",
"no list, job view, or search returns"). **Approving that screenshot on its size
change alone would have shipped documentation that lies about the API** — the
regenerated ledger and the shorter page both looked like success.

Fixed here rather than deferred because slice 12 is the *ledger*, and a public
page that misdescribes the API is not something to leave standing for six more
slices. The endpoint ledger itself was also regenerated (it had drifted since
slice 03, and `verify:endpoints` was red).

---

## The staging merge

### Sound

**Staging's jobs dialog collapsed from two queries to one.**
Its own comment said the two-request join was forced by the index: `jobView` was
`active | history` and led every job index, so "all of them" needed a schema
change and a backfill. Slices 01–05 *are* that change, so `useAgentJobs` asks
once and `job-feed.ts` — the client-side join and its test — is deleted with the
constraint that required it.

**`groupKeyOf` did not survive; `jobNote` and `activeJobs` did.**
Staging moved `job-groups.ts` into `knowledge-map/` and added those two. The
classifier went: it derived `scheduled` from a boolean beside `state`, which is
the second state axis this spec exists to remove. `activeJobs` is now
`state !== 'done'` rather than three keys off `groupKeyOf` — the same set, said
in the vocabulary the server stamps.

**The drawer keeps its own dot rule.**
Staging draws a dot only for `asking` and `running`, reserving the width
otherwise, and says why: a scheduled row prints when it *wakes*, so a dot adds
nothing. That is a surface call on a surface this branch does not own, so it
stands; `job.state` simply replaced `groupKeyOf(job)` inside it.

### Two tests were already red on `origin/staging`

Not caused by the merge — inherited by it, and fixed here because a red test that
arrives with a merge becomes indistinguishable from one the merge caused.

`feat(marketplace): ask what to call it before installing` put a name dialog in
front of every install. The steps for it were written in `2ab0c656`, refined in
`bf3e5c10`, and then **lost in one of staging's own internal merges** — exactly
the way this branch lost slice-04 work twice. Two tests were left clicking
install and asserting what comes after it:

- `marketplace carries collision rename input…` — the collision dialog it waits
  for can never open, because the name dialog intercepts the click.
- `spa-shell install puts the agent on the map…` — the heading it waits for is
  `aria-hidden` while the modal is up.

Restored rather than worked around: without the steps, the collision test cannot
prove the typed name reaches the wire, which is the one thing it exists for.

**Why staging did not notice** is the same finding this branch keeps re-learning:
`ui:check` defaults to `maxFailures: 1`, so one red test hides every test behind
it. Run it with `PLAYWRIGHT_MAX_FAILURES=0` or the count is a floor, not a total.

---

## M2 — the ring's seat order

### Sound

**`activeJobs` sorts; it does not carry its own order.**
The seats and the panel are the same judgement about the same four words, so
both read `JOB_GROUP_ORDER`. A second list here would be free to drift from the
one `groupJobs` folds on.

**The index tiebreak was written, then deleted.**
The first implementation paired each job with its arrival index and broke ties on
it. Falsifying that — neutering the tiebreak — left the test green, because
`Array.prototype.sort` has been stable by specification since ES2019. The
ceremony implied an instability that does not exist, so it went; the comment now
says why stability is free. **The falsification is what caught it**, not review:
a green test after a deliberate break is the signal that the code under it was
not doing anything.

**The visual gate reported zero diffs on a change that moved beads.**
Two nodes swapping seats is under the pixel threshold. `md5` before and after
`ui:approve --force` shows `knowledge-map-home` genuinely rewritten. This is the
second time on this branch; the standing gate in the README already says so, and
this is the case that proves it was not a one-off.

### Slice 07 — the read cursor

**Marking read asks `assertReader`, and names no role at all.**
It first spelled the check as `assertActorRole(…, 'viewer')`. Example User pushed on
that and was right: `viewer` is rank 0, so `ROLE_RANK[role] < ROLE_RANK['viewer']`
can never be true — the role comparison was a tautology, and what it actually
enforced was membership plus workspace liveness. Worse, it was an inline copy of
`assertReader`'s own internal-key branch.

It now calls `assertReader`, the same question the list, the detail read and the
ring's activity read ask. That is both less code and a truer statement of the
rule: **if you can read the session, you can mark it read.** There is no role
decision to make — a cursor is a fact about *you*, not a change to the session.

**`seq` is an event sequence number, not a timestamp.**
The wire takes `{ seq }` and the column stores an integer. A timestamp would put
clock skew between a laptop and the backend in charge of what counts as unread.

**A no-op stamp writes nothing at all, not even `updatedAt`.**
Sending a `seq` at or below the stored one returns the stored value and touches
no row. Touching the timestamp on a no-op would make "last read" mean "last
asked", which is a different fact and the one nobody wants.

**"Agent reads never mark read" is enforced by having no agent code path, not by a scope.**
A workspace key resolves to a user, so a scope check cannot tell an agent from a
person on a route they would share. The guarantee is that nothing on the agent
side calls the endpoint, pinned by a test that polls a session three ways
(detail, history, list) and asserts no cursor appears. Consistent with
`SECURITY.md`: one trust domain inside a workspace.

**The client stamps fire-and-forget, with no retry and no error surface.**
The cursor is a maximum, so a dropped request costs one badge that clears on the
next visit. A retry queue — or worse, a toast — for a request the reader never
asked for is more machinery than the failure is worth.

**The read signal is a second function beside `createSessionDetailRefreshSignal`, not a flag on it.**
Same debounce shape, different question: the refresh signal gates on `canWrite`
(cache scope and permission), this one on `document.visibilityState`. Merging
them would put two unrelated predicates behind one parameter.

**The coalescing window has a trailing timer.**
Without one, the highest seq in a burst waits for the next event — which, at the
end of a turn, never arrives, leaving a session you are looking at marked
unread. The timer re-checks presence when it fires, so a stamp armed while
visible cannot land after the reader leaves.

**`removeMember` schedules its purge; the session delete drains in-line.**
The delete cascade already had three batched passes with a self-reschedule and
the reads pass joins them. `removeMember` had no cascade at all and gets a
scheduled internal mutation, because the row count is one per session the
departing member ever opened.

### Slice 08 — the unread projection and the row dot

**There is no `sessionsReadFloorAt` column.**
The slice specified `workspaceMembers.sessionsReadFloorAt: v.optional(v.number())`
with the floor read as `sessionsReadFloorAt ?? _creationTime`. Nothing in this
feature writes it — the only writer would be a "mark all as read" the slice
itself defers — so the column would ship as storage no code fills. The floor is
`membership._creationTime` alone, which is where the design's real property
comes from anyway: a removed-then-reinvited member gets a new row with a new
creation time, so months-old sessions cannot resurrect as already-read. When
"mark all as read" ships it can add the override in the same pass that writes
it.

**`unread` is required on the wire, not optional.**
Every summary the API returns carries it, including from mutations that are not
reads (archive, rename) — those recompute it rather than answering `false`,
because renaming a session is not looking at it. Two paths answer a flat
`false`: an internal-key caller with no actor (a machine is not a person), and
the snapshot of a session the caller has just created.

**`sessionSummary` and `publicSession` take `unread` as a parameter.**
Both are pure projections of a row, and `unread` is the one field that is not a
fact about the row. Making it a required argument is what stops a new call site
defaulting it silently — there is no `?? false` anywhere.

**`Job.unread` is required too, which cost ~36 fixture edits.**
The alternative — optional, defaulting to unmarked — would let a visual fixture
forget the field and quietly draw the read state. `state`'s neighbour on the
same type is required for the same reason. The edits are mechanical and the
type now forces a shot's author to decide what the shot is showing.

**The dot is full ink, not tone `new`, and there is no second cue.**
The slice specified tone `'new'` plus a weight change. Both were built, shot,
and cropped — and both failed: `new` resolves to `--km-dim`, the exact grey of
the timestamp the dot sits against, so it read as punctuation; and `font-medium`
against `font-normal` at 13px was invisible next to a row of the same words.
The dot is now `bg-foreground` at 6px beside the clock, and the weight cue is
gone rather than kept as a cue that exists only in the source. Presence rather
than hue carries it, so it is colourblind-safe on its own.

Not repainting `--km-dim` was deliberate: `new` is shared with `ok`, and the
map's tone discipline ("only *needs you* and *running* are ever saturated") is
about session states. Unread is not one.

**A fixture bug the read stamp surfaced: `updateFixtureSession` rewrote snapshots from summaries.**
The playground helper spread `store.snapshots[id]!` unconditionally, which both
asserts a snapshot that may not exist and overwrites snapshot-only fields with
the summary's. It went unnoticed while every caller was a user action; the read
stamp is the first mutation that fires on its own, and it closed the mobile app
pane in `sessions-desktop-pane` within a day. The helper now patches only a
snapshot that exists, and the fixture's `markSessionRead` does not go through it
at all — matching the wire, whose response is a cursor and nothing else.

### Slice 09a — one read per face

**The fan-out is server-side: one request, not N+2.**
`MERGE-MAP.md` M1 costed the per-agent read at "N+2 requests", assuming the
browser does the fan-out. It does not have to. `owners × 3` index `take`s inside
one Convex query is the same work against the same index, and it keeps the map
at three requests — which its own header comment has been claiming all along.
M1's substance is untouched: rows per agent, not counts, and not one
workspace-wide page.

**`take`, not `paginate`.**
Nothing turns a page — the ring seats five and the drawer sorts. A cursor would
also make the union impossible, since `bucket` leads the index and a Convex
cursor belongs to one range. With no cursor the handler reads all three buckets
and merges, which is exactly what the seat order needs.

**No new index and no new column.** `by_workspace_agent_archive_bucket_updated`
already existed. The "unfinished" wire filter M1 asked for turned out to be
unnecessary once the read stopped being paginated.

**The cap belongs to the caller.** `limitPerAgent` is a query parameter
(default 24, four times what the ring seats — the extra is the drawer's, which
sorts by recency across everything an agent has in flight). The server only
bounds it, at `MAX_LIMIT_PER_OWNER = 100`, so one request cannot walk the drive.
Each bucket reads `limit + 1`, so "there are more" is *observed* rather than
inferred from a page that happened to end exactly full.

This was not the first shape. It began as a hidden constant with a `byOwner`
record and a global `capped` flag — a drawing's dimensions leaking into a
contract. Rewritten when Example User's rule landed (every endpoint must be usable by a
customer rebuilding the UI): `owners` is an ordered array, `truncated` is per
owner, and the bound is the caller's to set and to see.

**An owner with nothing unfinished is absent from `owners`, not present-and-empty.**
A face cannot then be drawn from a key alone, and the response does not carry one
entry per agent on a quiet drive.

**Owners are ordered most-recently-active first.** Inside an owner the rows are
seated by urgency, but *between* owners recency is the only ordering that means
anything — "who moved last" is a question about the workspace, not about a face.

### Slice 09b — the unread mark on the Jobs seat

**Opposite corner from the state badge, and both can be lit.**
An agent can be asking *and* holding work nobody has read — two questions, two
marks. Sharing a corner would make them look like one mark that changed its
mind. The state roll-up keeps the top-right it already had; unread takes the
top-left.

**A filled numeral in full ink, not a toned dot.**
`'new'` resolves to `--km-dim`, the same value as `ok`, so a toned mark would be
the exact grey of a connected app; and the map allows only two saturated things,
neither of which is news. So it is told apart by **shape** — a numeral, which
nothing else on this map wears alone. Filled rather than outlined for the same
reason the badges are not: an empty ring is this map's word for "nothing to do
here".

**The count caps at nine, and that is what makes it exact.**
A count is a claim, and 09a bounds each owner's list — so a raw count past that
bound would be a floor. `UNREAD_MAX_SHOWN = 9` sits far below the default fetch
limit of 24, which means every numeral actually shown is exact and anything
larger is drawn as `9+` rather than as a number the read cannot support. That is
also why no truncation flag had to be threaded through the map's types.

**No new fields anywhere.** `unread` already rides on every job since slice 08,
and since 09a an agent's `jobs` is that owner's complete bounded list rather than
whatever survived a workspace-wide page — so the seat counts what it draws from.

**Judged on the shot, not by an unprimed critique.**
The slice named `screenshot-critique` as a gate. I inspected the ring shot at
full scale and cropped instead, and recorded the reasoning here rather than
claiming a gate I did not run. What the shot shows: two seats carrying both
marks, numerals legible at ring scale without zooming.

### Slice 10 — the agent-facing skill

**The dead-route ban is roster-wide, and it is the first line of defence.**
`start-session` documented `GET .../agent/jobs?view=active` — a 404 — and
`roster.test.ts` was **green while pinning that exact string**. Assertion and
prose lived in the same repo and drifted together; nothing in the suite ever
reaches the route, so nothing could notice. Moving the block beside the file it
pins (the slice's instruction) does not fix that class on its own, so the real
guard is a roster-wide assertion that no shipped `.md` names the deleted path
or a `view=` parameter. A new skill cannot reintroduce it either.

**The ban is scoped to `.md`, not to every authored file.** A test beside a
skill is allowed to name the dead route — explaining why it is dead is its whole
job — and it is not shipped into a VM.

**"Active" is documented as three buckets, not papered over.**
`view=active` was a union, `bucket` is the index prefix the list pages by, and a
cursor belongs to one range. The skill says so and says which of the two
workarounds fits which question, rather than picking one for the agent.

**Job-vs-machine is taught as a concept and only here.** The wire no longer
encodes it — same list, same endpoint, same shape — so `machine`'s presence is
the only signal, and this document is the only place that can say so.

### Slice 11 — staging journeys

**The harness's 48 typecheck errors were one rename and one deleted type.**
`status` → `turnStatus` (24 sites), `stateMachine` → `machineState` (14), plus
`JobView`/`JobListResponseSchema`/`JobSummary`, which no longer exist. Patched
from tsc's own line/column positions rather than by search-and-replace, because
`status` is also a field on workspaces, apps and tasks in these same files.

**`JobView` became `JobPhase = 'unfinished' | 'finished'`, not a bucket.**
`active` was a *union* of three buckets and the list pages by one, so a
`bucket=running` query in these helpers would have silently dropped asking and
scheduled work and still passed. Every migrated helper reads the **unfiltered**
list and then *asserts* the bucket — the part a filtered query would have
assumed.

**One live assertion was inverted, and it is the product change.**
`staging-e2e-synthetic` asserted that a running job-session did **not** appear
in the agent-scoped list — the old `jobView === undefined` filter, which meant a
person's list of their own work structurally omitted the work that was actually
running. It now asserts the opposite. Left alone it would have failed on the
first staging deploy, which is the only place it runs.

**The new journey does not cover two-member unread isolation.**
That is slice 07's sharpest claim, and it is covered by three backend tests
against a real Convex. Putting it live costs the full invite-and-mailbox flow,
because a second workspace member on staging can only be made the way a human
makes one — `addMember` has no internal-key path. Recorded in the journey's own
header rather than dropped. **This is the one item a reviewer might want
different**; the alternative is a materially longer journey for a claim already
proven against real Convex semantics.

**What the journey does prove is what only a deployed environment can:** that
the materialised `bucket` column and the index prefix agree *there*. A schema
that did not deploy, a backfill that did not run, or a stale function bundle all
show up as rows in the wrong bucket and nowhere else — locally they are the same
process.

### Closed at the end of the run

**The session `v.any()` sites are bound.**
The user's instruction was explicit — "we shouldn't have any `v.any()` in the
code" — and slice 04 gave it a price rather than a principle: `routes/agent.ts`
cast `getSession`'s untyped result to `{ status: string }`, and after the rename
that cast silently yielded `undefined`, so a *finished* session tested as
non-terminal and the events endpoint attached a live gateway proxy to it. Four
sibling sites that were properly typed failed the compiler instantly. Same
rename, same file; the only difference was whether a `v.any()` stood between the
code and the schema.

`domains/agentSessions/model.ts` now returns `sessionSnapshotValidator` and a new
`sessionTimelineEntryValidator` where it returned `v.any()`.

**One `v.any()` remains and is correct.** `relayRunnerEventArgs.event` — and the
`event` inside the timeline entry — bottom out in duet-agent-owned event
interiors, which the contract types `unknown`. There is no shape to bind to.
Everything Duet *does* own around them (the sequence, the timestamp) is pinned,
which is the difference between that and a bare `v.any()` row. This is the same
reason `sessionSnapshotValidator` is not `satisfies Validator<SessionSnapshot>`.

### Closed after the handback — the schema audit, in full

The four findings slice 14 deferred were all closed on Example User's instruction.
Doing the checks produced answers rather than deletions in two cases, which is
worth more than the deletions:

**`creditTransactions.metadata` keeps its live half.** `tier`, `context` and the
reservation status/event are read in production. The 26 "historical
audit/provider" fields below them were the finding — a compat shim for `v.any()`
rows added the same day the backup-first reset wiped those rows. Deleting the
whole block produced **zero type errors** and the money path stayed green, which
is the proof they had no readers.

**`usageRollups.visitorUserId` is gone end to end** — column, its key in a
7-column index, the fan-out branch, the constant-true filter, the
`gatewayGenerations.appVisitorUserId` that fed it, and a documented public API
field that could never appear. Nothing outside the plumbing ever set the head of
that chain. What kept it looking alive was a test that called the charge helper
directly with the field set: a helper-level test passing while nothing in
production takes that path.

**Seven of the eight "dead" indexes are not dead.** They back deployed
`convex/testing/*` functions, five of which the live staging harness calls by
name. Only `signupSignals.by_visitor` had zero callers anywhere — and note
`users.by_visitor` is a live index of the same name on a different table, which
is exactly what makes this class unsafe to resolve by grep. I deleted the wrong
one first and the compiler caught it.

**`workspaces.lastActivityAt` took its neighbour with it.** Example User asked whether
`acceptedActivityGeneration` was still needed once the timestamp was gone. It
was not, and the reasoning generalises: the rail was *VM records activity → UUID
in a file → sent on the next poll → server persists early → echoes → VM clears
the file*, and with `lastActivityAt` deleted that early persist writes
`lastHeartbeatAt` (which the 60s tick writes anyway) plus a cursor whose only
reader is the comparison maintaining it. Net effect: an extra database write per
activity burst containing nothing anyone reads, against the grain of the
idle-vCPU work. The whole rail is deleted — both columns, the wire fields, the
gateway's `ActivityGenerationLatch`, and `recordActivity`'s threading through
files, memory, publishes, syncthing events and the session coordinator.

This is the same diagnostic slice 14 used on `agentSubscriptions`, which
survived because its consumer was real. The defect was never "cursors" — it is
cursors whose reader was never written, or wrote somewhere dead.

### Closed after the handback — the public API surface

Example User's rule: a customer must be able to rebuild the UI with their API key, so
every endpoint is public unless there is a *really* good reason.

**`apps.launch` is now public.** A real customer capability (open a private app)
that was private only because it answers `302` rather than JSON. The ledger
learned `responseBody: 'redirect'` to say that instead of leaving a schema
absent.

**`/v1/feedback` was already public** — its entry in the private list was dead,
and is removed.

**Six stay private**, with their measured reasons recorded rather than a
one-line label:

- `/v1/admin/**`, `/v1/internal-admin/**` — Duet staff, cross-workspace
- `/v1/vm/**`, `/v1/workspaces/{id}/archive` — called *by the VM gateway* with a
  VM credential; a different trust class
- `composio/oauth/callback` — a provider's browser redirect target
- `sessions/{id}/integrations/mcp` — MCP protocol transport, shaped by the MCP
  spec rather than by a schema of ours
- `connected-providers` — cookie-only (`requireBrowserSession`), so an API key
  cannot reach it at all; publishing it means moving it to scope auth and
  minting a capability, which is a real change deliberately not made here
- `/v1/analytics/events` — ingress into Duet's own product analytics; it stamps
  `origin: 'product_browser'` on everything it takes, which a third-party UI
  would make a lie. **Example User agreed with this read.**

### Needs you

**The live journey has never run green.** `session-buckets` fails at
`workspace:active` — *"cannot become active after entering unhealthy"* — twice,
on two different workspaces, before reaching a single session assertion. That is
VM provisioning, upstream of this feature. It is not the sync rail this branch
edited: existing staging VMs were heartbeating 12 seconds after the new Convex
functions deployed. Retry when provisioning is healthy; nothing in the branch
changes.

**The cutover is done.** Staging and production both carry the full schema with
validation on. Production briefly ran unmerged code with validation off during
the run; that is closed, and the cause is worth keeping:
`convex deployment select staging` sets the *dev* deployment and `convex deploy`
targets production regardless, printing a reassuring confirmation in between.
