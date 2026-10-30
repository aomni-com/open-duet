# File activity folding — quadrant map

Walked 2026-08-16 with Example User. Closes **Q11 (Retention)** of
[specs/done/file-attribution/MAP.md](../file-attribution/MAP.md), which was
left OPEN pending "a week of volume data". We have the data.

Every number below comes from a **full production export** of `fileEvents`,
`fileEventScopes` and `fileActivityEntities` from `elated-hippopotamus-235`
(prod), 08-13 23:21 → 08-17 00:50 UTC. The snapshot was deleted after
extraction.

> **This map is the decision record.** Quadrants 1–4 below are why the feature
> has the shape it does. The *Tweakable build plan* and *Copyable
> implementation prompt* at the bottom are **spent** — the build is done and
> the slice files are gone; [README.md](README.md) holds what survived.

**Decision evidence.** The row-count comparison behind D5/D7 is rendered
against this data at
<https://claude.ai/code/artifact/4d5c7664-06c4-4e5d-90c3-f4a71a912cb9>; the copy
directions behind D9 at
<https://claude.ai/code/artifact/c75db8ce-2e8a-4197-a1a4-4270b1196f94>.

---

## 1 · Known knowns — settled ground

**The ask.** File activity should stay scrollable back to the beginning but get
coarser rather than be deleted, plus a 30-day prune. The surface is an **audit
log read by Example User and by the agent working on the file** — not a marketing
surface.

**Volume (measured, full table).**

| Fact | Value |
|---|---|
| Rows | 19,332 events / 156,524 scopes / 6,984 entities over 73.5h |
| Concentration | **83% of events came from one day** (16,114 on 08-16); quiet days are 6–841 |
| Group skew | **255 groups hold 77% of events**; 898 groups hold exactly 1 |
| Scope fan-out | one row per path ancestor — **equals path depth exactly**, mean 8.1, max 14 |
| Repeat ratio | **2.37 events per distinct file** |
| Repeat cause | **96% of multi-event file buckets are syscall streams** (2,625 of 2,745, median gap ≤50ms) |

**Territory the code pins down.**

| Fact | Evidence |
|---|---|
| Output shape already exists: `changed-summary` / `viewed-summary` + `count` | `schema.ts:1296-1306` |
| Reads are **already** deduped per `(entity, actor, 6h bucket)` at ingest | `model.ts:196-206` |
| Change events are inserted unconditionally — no dedupe at all | `model.ts:144` |
| `fileAccess` rollup is bumped **before** any dedupe, so raw magnitude survives | `model.ts:164`, `:188` |
| Batch replay is a full no-op, guarded on `batchId` | `model.ts:38-46` |
| Projection is cursor-driven and **tolerates seq gaps** | `projection.ts:58-59` |
| Feed pages by `by_workspace_seq`; scoped feed by `fileEventScopes` | `queries.ts:89` |
| `count` already reaches the UI in the wire contract, but is never rendered | `contract/file-attribution:140,145`; `attribution.tsx:673` |
| **No deletion path exists** for either table — no `.delete()`, no cron | grep across `convex/` |
| Batch-bounded prune crons already exist as references | `pruneDailyUsage`, `pruneTelemetrySamples` in `crons.ts` |

**The finding that set the design.** Age-based tiering does not work here.
Simulated on real data, a `<24h` raw / `1–7d` hourly / `>7d` daily scheme gives
**19,332 → 16,069 rows — a 17% saving** — because the rows that hurt are recent
by definition. Bursts are young. Density, not age, is the axis that pays.

---

## 2 · Known unknowns — decision ledger

| # | Question | Decision | Closed by |
|---|---|---|---|
| D1 | Where does folding happen | **At ingest.** No compaction cron, no rewriting of history | Example User |
| D2 | Does the 30-day prune still ship | **Yes, as a backstop**, so no table grows without bound | Example User |
| D3 | What holds the fold window | **Durable bucket upsert in Convex**, generalizing the read-marker pattern (`model.ts:196`) to the parent-directory entity with a `count` | Example User |
| D4 | The existing 156K rows | **Leave them.** Table is 73h old; D2's prune ages them out. Zero migration risk | Example User |
| D5 | Threshold and window | **Dedupe `(path, actor, 6h)` first, then fold to the directory above 10 distinct files.** Reuse `READ_BUCKET_MS` | Example User + data |
| D6 | Gateway flush-window bug (69 summary rows for one tree) | **Out of scope.** D3's upsert collapses its output to one row anyway. Keep as a later network optimization | Territory |
| D7 | Does the fold key count events or files | **Distinct files.** At 2.37 events/file, counting events would fold ordinary work | Data |
| D8 | What does `count` mean | **Logical saves: consecutive writes to one path within 1s coalesce into one.** `.cd.json` reads as 1, not 1,902 | Example User + data |
| D9 | Feed copy | **Direction A**, and always show the count — D8 makes it true. New strings required | Example User |
| L-D | Timestamp on a deduped row | **Keep the first event's `at`**, matching what read markers already do, so `seq` and `at` stay in agreement | Example User |

**Why the tuning knobs are not delicate** — both were measured, not guessed:

- Bucket size barely matters: 1h → 4.2×, 6h → 4.2×, 24h → 4.3×. So reuse the
  existing `READ_BUCKET_MS` rather than introduce a second time constant.
- Coalesce window barely matters: 100ms → 4,014 logical saves, 5s → 3,839.
  1s is a round number inside a flat region.

**Projected result.**

| Stage | Events | Scopes | Loses |
|---|---|---|---|
| Today | 19,332 | 156,524 | — |
| Dedupe per `(path, actor, bucket)` | 8,146 (2.4×) | ~66K | **nothing** |
| \+ fold above 10 distinct files | 4,016 (4.8×) | ~36K | per-file detail inside bursts only |

---

## 3 · Unknown knowns — extracted context

| # | Extracted | What it reshaped |
|---|---|---|
| C1 | Audience is **Example User and the agent working on the file** — a machine-readable audit log | Favour completeness and honesty over polish; no truncation cleverness |
| C2 | **"No idea how this will be used. We just want a good audit log."** | Do not over-fit to a use case. Keep raw data intact; keep the rule explainable in one sentence |
| C3 | Prefer the simplest thing that is not misleading | Rejected a conditional "hide the count for streams" in favour of making the count correct, then always showing it |
| C4 | The count question was the real design question, not the row count | Produced D8; without it the product would ship the sentence *"Edited .cd.json (1,902 changes)"*, which is false |

**The `.cd.json` investigation, recorded so nobody re-opens it.** A single path
produced 1,902 events — 10% of the whole table. It is **not** a misbehaving
agent, and **not** a default-agent bug: it is one 9 MB file streaming to disk at
6,077 syscalls/second (0.3s total, median inter-event gap 0ms). fanotify emits
one event per `write()`. The shipped `account-board` app writes only
`accounts.json` and avatars; nothing in the repo writes `.cd.json`. There is
nothing to fix in the agent — the fix is D8.

---

## 4 · Unknown unknowns — landmine cards

| # | Landmine | Evidence | Status |
|---|---|---|---|
| L-A | **The bucket index cannot tell a read from a change.** `by_workspace_entity_actor_bucket` has no `kind`, and the read-marker lookup treats any hit as "marker exists". Once change rows also write `bucketStart` on the same key, **read markers silently stop being written** — silent data loss in an audit log | `schema.ts:1316`, `model.ts:196-206` | **Decided:** the index gains a discriminator **before** any change row writes `bucketStart`. Ordering is not optional |
| L-B | An incrementing count is only replay-safe **inside** the `batchId` guard; the relay retries with backoff. Insert tolerates replay, increment does not | `model.ts:38-46`; `FILE_EVENT_RETRY_BACKOFF_CAP_MS` | **Invariant:** safe today. Never increment outside `recordBatch` |
| L-C | `fileAccess` preserves true magnitude because `bumpRollup` runs **before** dedupe. A tidy-up that moves it below would destroy the only place raw magnitude survives | `model.ts:164`, `:188` | **Sharp edge:** do not move it. This is also what lets the feed hide the number safely |
| L-E | Ordinary change events carry no `count` in the wire contract | `contract/file-attribution:140,145` | **Overstated — corrected in slice 00.** The Convex table column was already `v.optional(v.number())` and `wireEvent` already passed it through, so no validator change was needed. And the count must go on the **read side only**: the ingest schema is `strictObject` precisely to refuse server-derived facts from the caller. See [choices.md](choices.md) |
| L-F | The prune must cascade to `fileEventScopes` (~8 per event) or it orphans them and the subtree feed points at missing events | `fileEventScopes` has no cascade | **Decided:** cascade. Projection already tolerates seq gaps; copy `pruneDailyUsage` |
| L-G | The gateway still ships every syscall over the wire — 1,902 events, 4 HTTP batches, for one file write. `pipeline.ts` already dedupes *reads* in-buffer via `bufferedReadKeys` | `pipeline.ts:166`, `:214` | **OPEN (optimization).** Unblocks: nothing — ship after the ingest fix if wire volume matters |

---

## Builder must confirm before coding

- **L-A ships first.** The index discriminator lands and deploys before any
  change row writes `bucketStart`. Two deploys, not one — dropping or
  repurposing a column that running code still writes needs the two-phase
  cutover this repo has been bitten by before.
- Directory entities must already exist for the fold target. `entryKind` is
  `'file' | 'folder'`, so folder entities are modelled — confirm the parent
  directory's entity is resolvable at ingest without an extra walk.
- A folded row's scopes are the **directory's** ancestors, one shallower than a
  file's — confirm this reduces projector operations against the 64-op
  transaction budget (`FILE_ACTIVITY_LIMITS.maxProjectorOperations`).
- Confirm no product need for per-file rows inside a burst before shipping the
  fold; the dedupe half (2.4×, lossless) could ship alone first.

---

## Tweakable build plan — SUPERSEDED

> Spent. Kept only because the measured alternatives below are still the
> evidence for retuning the threshold. Item 3 ("ship dedupe alone first") and
> item 5's deploy-ordering were both rejected at interview.

Sorted by how likely you are to change your mind, not by execution order.

1. **Judgment — the fold threshold (D5, K=10 distinct files).** Alternatives
   measured: K=3 → 7.3×, K=5 → 6.1×, K=25 → 2.8×. Swap freely; it is one
   constant.
2. **Judgment — the coalesce window (D8, 1s).** Flat from 100ms to 5s. One
   constant.
3. **Judgment — ship dedupe alone first.** The lossless 2.4× needs no
   threshold, no folding, and no new copy beyond a count. The fold can follow.
4. **Judgment — feed copy (D9, direction A).** Strings only.
5. **Mechanical — L-A index discriminator + its deploy ordering.**
6. **Mechanical — the `count` field on change events, contract + Convex
   validator (L-E).**
7. **Mechanical — the 30-day prune cron with scope cascade (D2, L-F).**

---

## Copyable implementation prompt — SUPERSEDED

> **Spent — the feature shipped.** Kept only as a record of what the walk
> originally proposed, which differs from what was built.

> Implement file activity folding from `specs/file-activity-folding/MAP.md`.
> Follow the decision ledger D1–D9 and L-D exactly; they are givens, not
> suggestions.
>
> Land it in this order:
> 1. Add a kind discriminator to `by_workspace_entity_actor_bucket` and deploy
>    it **before** anything writes `bucketStart` on a change row (landmine L-A —
>    getting this wrong silently stops read markers being written).
> 2. Add an optional `count` to change events in the contract **and** the Convex
>    arg validator (L-E).
> 3. In `recordEvent`, dedupe change events per `(entity, actor, 6h bucket)` the
>    way `recordRead` already does, incrementing `count` only when the gap since
>    the last write to that path exceeds 1s (D8). Keep the first event's `at`
>    (L-D). Leave `bumpRollup` above the dedupe (L-C).
> 4. Fold to the parent-directory entity once a bucket exceeds 10 distinct files
>    (D5, D7).
> 5. Render the count in the history row, direction A (D9).
> 6. Add a batch-bounded 30-day prune cascading to `fileEventScopes`, modelled
>    on `pruneDailyUsage` (D2, L-F).
>
> Use `write-tests` red/green throughout. The existing `recordRead` dedupe is
> the reference implementation for step 3.
