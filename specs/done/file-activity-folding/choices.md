# Choices ledger — final

Every decision made where the spec was silent, or where the code contradicted
it. Re-audited against the **shipped** code, not against the pass that
introduced it: entries a later pass changed are recorded at their end state, and
entries a later pass reverted are gone.

Ranked least-confident first within each group. Each entry stands alone.

---

## Needs your eyes

### Burstiness is measured per delivery, not per 6h bucket

D5 says "fold above 10 distinct files" with the 6h bucket as the window. The
shipped threshold is measured against **one delivery** — one batch from the
gateway — instead.

**Why.** Folding per bucket means a group can cross the threshold *after* some
of its files already have rows: the eleventh file arrives and the first ten are
already written. Reaching the measured 4.8× then requires deleting those rows
**and their scope rows** at ingest, which makes the ingest mutation a second
writer of `fileEventScopes` — a table the projector owns. That is the
single-owner violation the README forbids, and the hot path is where an orphan
bug would hide. Per-delivery folding sees the whole group before writing
anything, so it needs no deletes at all.

It is also arguably the better definition. Burstiness is a property of *rate*: a
build writing 103 files arrives together, while eleven files edited across an
afternoon arrive apart and genuinely are eleven pieces of work.

**What it costs you.** The 4.8× projection assumed per-bucket collapse and is no
longer a measured number. I cannot restate it honestly, because the stored
events do not record which delivery they arrived in — that grouping only ever
existed at the gateway. The direction is certain; the ratio is not.

**If you'd rather** have the per-bucket semantics and the measured ratio, that
is the delete-on-crossing design, and it wants a shared cascade helper owned by
one module and used by both the fold and the prune. Say so and I will reslice.

**What the live journey then measured, which no fixture could show.** 48 files
written into one folder produced **one fold of 11 files and 37 rows left
per-file**. Those writes are separate HTTP round-trips from outside the VM, so
the gateway spread them over many flushes and only the fullest one crossed the
threshold.

This is the per-delivery choice's real edge, now evidenced rather than
predicted: **folding catches a fast burst and misses a slow one.** A build
writing a tree inside the VM lands in one flush and folds whole — that is the
shape the production export showed, and it is the case the feature was built
for. But anything written at API pace, such as an agent creating files one call
at a time, will not fold however many files it eventually writes.

Per-bucket accumulation would have caught both. If the slow case matters to
you, that is the reslice above.

### A summary's `count` has two units, and `entryKind` is how you tell

The gateway has always folded regenerable trees (`node_modules`, `.git`) into a
`changed-summary` whose count is **raw events** — the shipped feed says exactly
that: *"changed `.git` — 487 filesystem events"*. This feature added summaries of
its own, on ordinary directories, whose count is **distinct files**. Same kind,
same field, two units.

They never collide on a row, because a gateway fold sits on a noisy-tree root
and a server fold on an ordinary directory. But nothing let a *reader* tell
which unit a number was in, and the existing copy would have stated the wrong
one. Server folds are now marked `entryKind: 'folder'`, and
`summaryCountsFiles()` in the contract is the single place that answers the
question. Both surfaces branch on it.

**Why `entryKind` and not a new field or kind:** it exists, it is already
optional, and it is honest — a folded row *is* about a folder. I rejected
inferring the origin from whether the path is a noisy-tree root: true today, but
implicit coupling nobody would expect to be load-bearing.

**If you'd rather:** have server folds count raw events like the gateway does.
No discriminator, no new strings — at the cost of putting a syscall-inflated
number back in the one place this feature exists to keep honest.

### The bucket discriminator is a stored `isRead` boolean

The spec delegated its shape. It is a column rather than `kind` in the index.

**Why.** The index serves both sides. The read side is fine with
`.eq('kind', 'read')`, but the change side asks "is there a change row for this
bucket", and a change row keeps its original kind (`write`, `create`, `delete`) —
so a kind-based index would cost **three queries per event** in the hot ingest
path. One boolean answers either side in one query.

`fileEventScopes.isRead` already exists for the same reason one level down, so
the name and the job are precedented.

**What it costs you:** a derived column, computable from `kind`, which can drift
if a future write path forgets it. Both insert sites in `recordEvent` set it
explicitly.

---

## Sound

### The count means logical saves, and is absent when it is one

Consecutive writes to a path within 1s are one save. A row with a single save
carries no `count` at all — the contract documents "absent means one", it keeps
the common row lean, and it stops the feed rendering a meaningless "1 save".

The window is not a delicate knob: on production data, 100ms and 5s give 4,014
and 3,839 logical saves respectively. 1s is a round number in a flat region.

### Both surfaces state magnitude the same way

The history pane and the activity feed render the same events, and only the
former was in the slice's scope. Left alone, one would have said "6 saves" while
the other said nothing about the same row.

Both now state it, and both take it from one shape: **the verb never carries a
number, and every magnitude renders as sub-text.** An earlier version put the
file count inline in the verb ("Edited 103 files by …") while saves sat in
sub-text — two structural patterns for one verb in adjacent rows, which the
unprimed critique flagged. Collapsed to one.

### A rename ends a merge run

Found by a failing test, not by design. An entity keeps its identity across a
rename, so its bucket row outlives the path it names — and the first
implementation merged a post-rename save into the pre-rename row, leaving the
feed saying *"Edited `old/box/nested/a.md`"* for a file now at `new/box/`. An
existing folder-move test caught it.

The merge now requires `existing.path === event.path`: a row states "this path
was saved", and once the path differs the run is over. Pinned by its own test
rather than left to the fixture that happened to catch it.

### Only `write` and `create` share a row

`delete` and `rename` stay per-event — each is a distinct terminal fact about
the entry, not another sighting of the same one. Merging a delete into a run of
writes would lose the deletion from the feed entirely.

### The gateway's own summaries merge too

`changed-summary` and `viewed-summary` from the gateway go through the same
bucket merge, adding their counts. This is what makes MAP **D6** true: the
gateway emits a fresh summary per 5-second flush window — 69 rows for one
`node_modules` tree in the production export — and they now land as one row.
Without this, D6's reasoning in the README would be wrong.

### A server fold declines rather than merging into a gateway summary

Found by the closing audit, which noticed the README asserted "they never share
a row" while nothing in ingest enforced it. What actually kept them apart was a
*gateway behaviour* — it rewrites every write under a noisy tree into its own
summary, so a raw write should never reach the fold with a gateway row already
in the bucket — and `recordBatchFromApi` is reachable without the gateway.

The fold now merges only into another server fold. Faced with a gateway summary
it **declines**, and the group falls back to per-file rows.

Fixing that exposed a worse bug in the shipped code: declining, and the
already-present "no resolvable folder" path, both returned "handled" without
writing anything — so an unfoldable burst was **dropped entirely**. The fold now
reports `inserted` / `merged` / `declined`, and a declined group is recorded
per-file as its comment always claimed. Pinned by a test that fails at 499
(487 + 12) with the guard removed.

### The delivery ledger is pruned too

Found by the closing review, not planned. `fileEventBatches` gets one row per
delivery and **nothing ever deleted it** — on an active workspace, at a 5s
flush, that ledger outruns the events it exists to deduplicate. The feature's
own goal was that neither table grows without bound, and this was a third table
of its own making, unbounded.

It is safe to drop: the ledger only makes a relay retry a no-op, and a retry
lands within seconds (its backoff caps at 30s). A record 30 days old can never
be replayed against.

Note it expires on `recordedAt` — when the **server received** the delivery —
not on the events' own clock. The two differ, and the first version of the test
conflated them.

### A folder summary's count can double-count across deliveries

Merging adds each delivery's distinct-file count to the row's, so a file touched
by two separate bursts inside the same 6h bucket is counted in both. Tracking
which files a summary has already absorbed would mean storing the set on the
row.

The approximation is safe for the case that folds: a burst writes a given file
once, and folding only happens above ten distinct files in one delivery. It is
recorded rather than hidden because the number is user-visible.

### An unresolvable folder falls back to per-file rows

If `parentEntityAt` returns null there is no fold target, so the events keep
their own rows. Costing that group its folding is the honest failure; inventing
a synthetic folder entity would put rows on an entity the namespace does not
know.

### Two suites folding invalidated were re-specced, not re-pinned

The root gate found both. Neither was flakiness, and in both cases the *old*
assertion is what folding deliberately removes — so the fix was to restate the
contract, never to relax a number until it passed.

- **The analytics stress batch** wrote 500 files into one directory, which is
  exactly the burst that folds, so its 500 analytics events became one. Its
  intent is that a **max-size batch drops nothing**, not that a burst stays
  per-file. The batch now spreads across fifty folders at ten files each — *at*
  the threshold rather than over it — so the throughput coverage survives whole.
- **The API rename checkpoint** asserted that a create and a write of one file
  in one bucket were two rows. They are one row now, by design: the create keeps
  the seq and absorbs the save. What the test exists for — identity following a
  rename, and a recreated path getting a fresh entity — is untouched.

### `count` rides the read side only; the ingest schema still refuses it

The slice said to add `count` to "the contract **and** the Convex validator".
Both halves were wrong.

`DriveFileEventSchema` is `strictObject` *on purpose* — its own doc comment
explains that strictness is what refuses a caller-supplied `userId`, because
identity is resolved server-side. A save count is the same class of fact: it is
derived by coalescing the watcher's stream, and the gateway has no business
asserting it. So it rides `FileActivityEventSchema` only, exactly as `userId`
does. And the Convex column was already `v.optional(v.number())` with
`wireEvent` already passing it through, so no validator needed touching —
landmine L-E was overstated, and the map now says so.

Pinned by a test asserting both halves: ingest rejects a change event carrying a
count, the feed accepts one.

### Retention lives in the contract, beside the folding policy

`FILE_EVENT_RETENTION_MS` sits with the folding constants rather than local to
the cron, which is where `vmTelemetry` keeps its own. Folding bounds how many
rows a burst creates; retention bounds how long they live. Both answer "how much
of the watcher's output does the log keep", and the README's single-owner
invariant puts that in one place.

### `isRead` is optional and nothing was backfilled

Rows written before the column keep their shape, consistent with D4. No backfill
is needed because buckets are 6 hours: within one bucket of deploy every *live*
bucket carries it, and older buckets are closed and never looked up again. The
19,332 existing rows age out through the prune.

### Resolving an entity's parent has one owner

`parentAt` lived inside `projection.ts`, and ingest needed the same walk.
Extracted to `namespace.ts` — bindings are the namespace's business — with the
projector delegating to it, rather than a second copy appearing beside it.

### A duplicated summary type is gone

`timeline.ts` declared a local `SummaryEvent` mirroring the contract's summary
variants, making `ActivityEvent` a union with itself. It only surfaced because
the local copy lacked `entryKind`. Deleted rather than patched.

### A test-only fixture constructs the L-A adversarial state

`stampChangeBucketForTest` stamps `bucketStart` onto a change row — the state
slice 01 later produced for real. Without it the L-A regression test could not
be red before the fix, and a test never seen failing is decoration. It is
durable, not scaffolding: it pins the invariant against future refactors.

### The live journey's summary assertion is scoped, not deleted

`rollupCount === persistedSummaryCount` held while every summary counted raw
events. It is now scoped to **gateway** folds, which still must balance exactly,
while server folds are asserted on their own terms. Deleting it would have lost
a real invariant; leaving it would have failed against correct behaviour.

### The syscall-stream case is proven at the ingest seam, not live

The journey covers coalescing and folding, but not the 1,900-syscall stream that
motivated the feature: reproducing it needs a process **inside** the VM writing a
large file in chunks, and an API `PUT` is one write. Fixtures replaying the real
production shapes cover it instead. A live proof would want an in-VM writer step
the journey does not have today.

---

## Fixed in passing, unrelated to this feature

### The sessions-and-jobs journey no longer parses a schema it cannot get

It still parsed `NoDefaultSessionErrorSchema` after `bb01afb47` made "no default
chat yet" a **200 with a null session**, so `packages/test-harness` failed
typecheck before this feature touched it. Repointed at
`DefaultSessionResponseSchema`.

---

## Recorded, deliberately not done

### Eleven pre-existing defects in the history pane

The unprimed critique found them while reviewing this change: the read and
restore rows and the actor chips never got the care the change rows did — see
[assets/history-critique.md](assets/history-critique.md). They are a copy and
affordance pass on the history pane, and folding a copy rewrite into a behaviour
diff would have hidden both.

### The gateway still ships every syscall over the wire

L-G. One file write is still 1,902 events in four HTTP batches; the ingest
upsert collapses the *storage*, not the *traffic*. `pipeline.ts` already dedupes
reads in-buffer, so the change is small — deliberately left unbuilt, blocked on
nothing.
