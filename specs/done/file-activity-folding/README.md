# File activity folding

The file-activity audit log records what a person or agent *did* to a file,
rather than what the kernel observed. Change events collapse into one row per
`(file, actor, 6h bucket)`, a burst of files in one folder collapses into a
single folder summary, and nothing this feature writes outlives 30 days.

## The problem it solves

fanotify emits one event per `write()` syscall. A single 9 MB file streaming to
disk therefore arrived as **1,902 events for one path in 0.3 seconds**, each
stored as its own row reading "Edited `.cd.json`", each fanned out ~8× into
`fileEventScopes`. One path was 10% of the entire production events table.

The feed was not merely large — it was **stating a falsehood**. Across the
production export, **96% of repeated writes to a path were a syscall stream
rather than repeated saves** (2,625 of 2,745 multi-event buckets had a median
inter-event gap under 50ms). A user reading "edited 1,902 times" was reading a
syscall count wearing the costume of an edit count.

## The reason it works this way

**Density, not age.** The obvious design — tier history by age, keeping recent
detail and coarsening old — was measured against the real table and rejected:
19,332 rows became 16,069, a 17% saving. The rows that hurt are recent *by
definition*, because a burst is young. Folding is therefore keyed on how much
happened, never on how long ago.

**Distinct files, not events.** At 2.37 events per distinct file, a threshold
counting events would fold ordinary work. `FOLD_DISTINCT_FILES` counts paths,
which is what makes repeated saves unable to push a small edit over the line.

**Per delivery, not per bucket.** This is the sharpest trade-off in the feature
and the one most worth understanding before changing it. Folding per 6h bucket
means a group can cross the threshold *after* some of its files already have
rows, so collapsing them requires deleting those rows **and their scope rows**
at ingest — which would make the ingest mutation a second writer of
`fileEventScopes`, a table the projector owns. Judging a delivery instead means
the whole group is visible before anything is written, so folding needs no
deletes at all.

The cost is real and was measured live: **folding catches a fast burst and
misses a slow one.** 48 files written at API pace produced one fold of 11 files
and 37 rows left per-file, because the gateway spread them across many flushes
and only the fullest crossed the threshold. A build writing a tree *inside* the
VM lands in one flush and folds whole — that is the shape the production export
showed, and the case the feature exists for. An agent creating files one API
call at a time will not fold, however many it eventually writes.

**The count is server-derived, so ingest refuses it.** `DriveFileEventSchema` is
`strictObject` precisely to reject caller-supplied facts resolved on the server
(the same rule that refuses a spoofed `userId`). The gateway reports events; it
does not get to assert how many saves they amount to.

## Invariants

Violating any of these fails silently, which is why each has a test.

- **A change row must never satisfy the read-marker lookup.** Both share the
  key `(workspace, entity, actor, bucketStart)`. Before `fileEvents.isRead`
  existed, a change row answered the read-marker query and **read markers
  simply stopped being written** — no error, no log line, missing rows in an
  audit log. Pinned by *"a change row bearing a bucket never satisfies the
  read-marker lookup"* in `packages/backend/src/file-activity.test.ts`, which
  was watched failing (`appended: 0`) before the fix.
- **`bumpRollup` runs above every dedupe decision.** `fileAccess` is the only
  place raw magnitude survives once the feed hides it. Moving it below the
  dedupe would destroy that with no visible symptom.
- **Counts increment only inside the `batchId` guard.** The relay retries with
  backoff; insert tolerates replay, increment does not. Every increment path
  reaches `recordBatch`, which no-ops a redelivered batch.
- **`at` stays at the first event of a bucket.** The feed pages by `seq` while
  displaying `at`; bumping `at` would show newer timestamps at older positions.
  `lastAt` carries the newest, and exists because a stream spans deliveries.
- **A row states that a *path* was saved.** An entity outlives its path across a
  rename, so a merge requires the paths to match — otherwise the feed names a
  location the file no longer has.
- **A summary's `count` has two units, and they never mix in one row.** A
  *gateway* fold of a regenerable tree counts raw events; a *server* fold counts
  distinct files, marked `entryKind: 'folder'` so nothing has to infer it. A
  server fold merges only into another server fold and otherwise **declines**,
  leaving its burst per-file: costing rows is recoverable, a count meaning
  neither unit is not. In practice the gateway rewrites every write under a
  noisy tree into its own summary, so the collision should not arise — but that
  is the gateway's behaviour, and `recordBatchFromApi` is reachable without it.

## Where it lives

| Concern | Code |
|---|---|
| Policy constants, and the unit discriminator | `packages/contract/src/file-attribution/index.ts` — `FOLD_DISTINCT_FILES`, `WRITE_COALESCE_MS`, `FILE_EVENT_RETENTION_MS`, `isSameLogicalSave`, `summaryCountsFiles` |
| The one recorder | `recordEvent`, `mergeIntoBucketRow`, `recordFoldedGroup`, `planFoldGroups` in `packages/backend/convex/domains/fileActivity/model.ts` |
| Parent resolution, shared with the projector | `parentEntityAt` in `.../fileActivity/namespace.ts` |
| Retention | `.../fileActivity/retention.ts`, registered in `convex/crons.ts` — sweeps events, their scopes, and the delivery ledger |
| Feed copy | `historyLabels` in `apps/web/spa/files/attribution.tsx`; the workspace feed in `activity-feed.tsx` |
| Behaviour tests | `packages/backend/src/file-activity.test.ts` |
| Live proof | the folding steps in `packages/test-harness/src/staging-e2e-synthetic` |

`READ_BUCKET_MS` is reused as the fold bucket rather than a second constant
being introduced: bucket size proved near-irrelevant to the outcome (1h, 6h and
24h measured 4.2×, 4.2× and 4.3× on production data), so a second knob would
have had nothing to tune.

## Dead ends

- **Age-based tiering.** 17% saving on real data. Rejected above.
- **Extending the noisy-tree list** (`dist`, `build`, `out`, …) so more paths
  fold. That list also drives an `rm -rf` in the marketplace puller
  (`packages/gateway/src/marketplace/puller.ts`), so widening it for folding
  would have started deleting users' build output. Density folding catches those
  directories anyway, without touching a destructive path.
- **Keeping the first K rows and folding only the remainder**, to avoid deletes.
  Modelled at ~8,100 rows against the 8,146 that dedupe alone achieves — almost
  worthless, because most over-threshold groups sit only just over it. (That
  first figure was computed against the export, which has since been deleted;
  the 8,146 comparator survives in [MAP.md](MAP.md).)
- **Counting a per-file repeat in the UI.** A count of "1,902 changes" is what
  the watcher saw, not what happened. The count now means logical saves, and is
  absent when it is one.
- **Proving the syscall stream live.** A `PUT` is a single write, so the journey
  can show repeated saves sharing a bucket row but can never exercise
  `WRITE_COALESCE_MS` collapsing a stream — that needs a process *inside* the VM
  writing a large file in chunks. Fixtures replaying the real production shapes
  cover it.

## Provenance

The decisions were taken against measured data and rendered options, not
intuition:

- **[MAP.md](MAP.md)** — the quadrant walk. Every number in it comes from a full
  production export of `fileEvents`, `fileEventScopes` and
  `fileActivityEntities` (`elated-hippopotamus-235`, 08-13 → 08-17 UTC). The
  export was deleted after analysis; the numbers are what survive.
- **[choices.md](choices.md)** — every decision made where the plan was silent,
  re-audited against shipped code.
- **[assets/history-critique.md](assets/history-critique.md)** — an unprimed
  critique of the rendered history pane, run before the copy was accepted. It
  caught two defects in the change itself ("Edited 103 files" appearing in a
  *single file's* history, which production cannot produce; and one verb
  expressing its count two different ways in adjacent rows) and 11 pre-existing
  defects in the read/restore rows and actor chips, which are recorded there and
  deliberately left for a copy pass of their own.
- **Row-count comparison** driving the threshold and the distinct-files rule:
  <https://claude.ai/code/artifact/4d5c7664-06c4-4e5d-90c3-f4a71a912cb9>
- **Copy directions** driving the wording, including the rejected variant that
  would have shipped "Edited `.cd.json` (1,902 changes)":
  <https://claude.ai/code/artifact/c75db8ce-2e8a-4197-a1a4-4270b1196f94>

The rendered result is pinned by the committed baselines
`apps/web/tests/visual/__screenshots__/{desktop,mobile}/playground.spec.ts/files-history-paginated.png`
and `files-activity-scoped.png`, owned by the visual gate.

## Live evidence

`bun run e2e:staging -- --journey gateway-liveness`, green:

```
folding:       { burstFiles: 48, foldedGroups: 1, foldedFiles: 11, perFileRows: 37 }
summaryCounts: { git: 25, nodeModules: 24 }    rollupCount: 49
projection:    { completedSeq: 122, lag: 0 }
```

`rollupCount` equalling 25 + 24 is the scoped balance holding: gateway folds
still reconcile against `fileAccess` exactly, while server folds are judged on
their own terms. The journey records `folding` as evidence rather than asserting
a ratio, because how a burst splits into deliveries is a property of the
writer's pace and cannot be controlled from outside the VM.

## Still open

- **The gateway ships every syscall over the wire.** One file write is still
  ~1,900 events in four HTTP batches; ingest collapses the storage, not the
  traffic. `pipeline.ts` already dedupes *reads* in-buffer, so the change is
  small. Deliberately unbuilt, blocked on nothing.
- **Eleven pre-existing history-pane defects** in
  [assets/history-critique.md](assets/history-critique.md).
- **The slow-burst case.** If files arriving at API pace ought to fold, that is
  per-bucket accumulation, and it wants a shared event+scope cascade helper used
  by both the fold and the prune.
