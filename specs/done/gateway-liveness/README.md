# Gateway liveness and stable file activity

Shipped to staging on 2026-08-13. This record explains why the system has its
current shape and what future changes must preserve. Production activity data was
not reset or rolled out as part of this work.

## What this solves

A workspace with a very large generated tree could spend minutes reconciling
anchors, miss its heartbeat window, and be reported as provisioning or unhealthy
even though its gateway was alive. The same filesystem pressure could flood the
activity pipeline, while path-keyed history lost the identity of a file or folder
when it moved.

The shipped design keeps the healthy reconciliation path proportional to registered
anchors, prunes the exceptional missing-anchor search, folds generated-tree
activity before storage, and gives file/folder history a stable backend-owned
identity. Root, exact-entry, and folder-subtree views remain bounded and honest
about event-time paths. Restore, retry, and unhealthy states are explicit rather
than inferred from silence.

The liveness and activity rails intentionally share only the contract-owned noisy
path classifier and the final acceptance workload. Anchor reconciliation,
filesystem attribution, canonical recording, namespace transitions, scope
projection, and presentation each retain one owner.

## Why it works this way

### Presence is a direct fact; search is only a recovery aid

Every registered anchor path is probed directly. A drive walk happens only after
an anchor is missing or identity-invalid, and that mover search prunes exact `.git`
and conservative derived-content segments. The pruning rule never participates in
the presence verdict. This prevents a registered anchor inside an excluded tree
from being falsely reaped while keeping the healthy path O(anchors).

Reconciliation stays awaited before boot-health success. Detaching it would make a
release certify itself while its durable anchor view was still unknown. Recurring
sync may coalesce to the newest roster, but direct API pushes remain one-for-one so
callers can observe each committed intermediate state.

Restore is a structural state, not a delay heuristic. One restore window covers
archive completion for both registration and sync recovery, clears on failure, and
causes reconciliation to report `restore_in_flight` without manufacturing missing
evidence. An unreadable drive is handled the same way.

### Raw operational facts and persisted activity have different cardinality

Operational listeners receive every admitted filesystem event first. Only the
persistence copy is folded, by actor, exact noisy root, changed/viewed category,
and sealed batch. This keeps scan nudges responsive while ensuring `.git` and
derived trees occupy O(groups) canonical rows. A sealed retry is immutable;
events arriving behind it belong to a later batch.

The classifier is deliberately narrow. Ambiguous authored directories such as
`dist`, `build`, `out`, `target`, `vendor`, and `coverage` remain precise. Invalid
or non-normalized paths fail closed as ordinary rather than being hidden as noise.
Atomic editor replacement is classified as a destination write, whereas an
explicit Files move remains a rename.

### Paths describe history; entities identify it

`fileEvents` is the single canonical log. Event-time `path` and `fromPath` are
never rewritten, but each non-restore fact points to a stable entity. Versioned
parent/name bindings resolve current and direct historical aliases. A direct
rename preserves identity; a folder move changes one binding without touching
descendants. Copies, hard links, and delete/recreate create distinct identities.
Rename-over keeps the source identity and retires the destination without merging
their histories.

Restore starts a new namespace epoch. A missing or unresolvable rename source records
a lineage miss and creates the safest new identity instead of guessing from inode,
file handle, content, timestamps, or metadata. A live binding shadows a historical
alias when a path is reused.

Exact history resolves one selectable entity and reads its canonical rows
newest-first. Folder activity is a derived membership index keyed by stable folder
identity. Projection advances one contiguous workspace cursor in bounded,
idempotent chunks; partial membership writes remain invisible until the complete
event (including both rename phases) is committed. A pending projection never
falls back to scanning the workspace log.

### The cutover had to precede the strict schema

Staging still contained legacy rows rejected by the new schema, so a freshly
deployed reset mutation could never become callable. The operator path therefore
uses Convex's schema-independent table import to replace exactly eight fixed tables
before deployment. The tool accepts only exact allowlisted staging/production
deployments and requires operator attestations that producers are quiesced and
sealed gateway retries were discarded. It snapshots first and verifies every table
empty after replacement.

This was a hard reset, not a migration. There is one `fa:<sequence>` cursor grammar,
one namespace allocator, no dual parser, no backfill, and no path-keyed fallback.
Sequence gaps are legitimate because every admitted transition consumes sequence
space before read-marker deduplication or policy suppression of mirror reads.

## Invariants

- Awaited anchor reconciliation is part of release-health certification.
- Direct anchor probes decide presence; exclusions narrow only a missing-anchor
  mover search.
- Sync reconciliation may coalesce; synchronous API pushes may not.
- Restore-in-flight and unreadable-drive skips create no missing evidence.
- Operational filesystem listeners see every admitted raw path before folding.
- Folded descendants are never inserted and later deleted; only their counted
  summary is persisted. User-resolvable actors emit one counted analytics fact.
- The exact noisy-root classifier is shared, conservative, segment-aware, and
  never decides anchor presence.
- Canonical events are stored once. Paths are event-time labels; stable entities
  own logical identity.
- Direct rename preserves identity. Copy, hard link, and delete/recreate do not.
  Rename-over preserves the source; atomic replacement preserves the destination.
- Root reads the canonical workspace log. Exact and subtree selection never fall
  back to broader activity.
- Every activity read and projection mutation has a structural bound. Projection
  exposes no partially completed event.
- `fileActivityNamespaces.nextSequence` is the sole per-workspace sequence owner;
  gaps do not imply lost events.
- Every visible desktop Files column retains its own refresh ownership. On narrow
  screens the selected destination occupies the full pane and breadcrumbs carry
  ancestry.
- Unknown gateway refusal codes fail as `502 gateway_failed`; typed unhealthy
  refusals replace indefinite loading in Files and Desktop.
- No legacy activity compatibility architecture survives the reset.

## Where the contracts live

- Shared limits, event shapes, cursor grammar, and noisy paths:
  `packages/contract/src/file-attribution/` and `noisyTreeRoot` in
  `packages/contract/src/drive/index.ts`.
- Raw attribution, folding, stable retries, and watcher semantics:
  `packages/gateway/src/attribution/pipeline.ts`, `fanotify-codec.ts`, and
  `helper-main.ts`.
- Anchor fast/slow reconciliation and telemetry:
  `packages/gateway/src/routes/anchors.ts` and the gateway health diagnostics.
- Restore and release-health ordering:
  `packages/gateway/src/vm/restore-window.ts`, `vm/phone-home.ts`,
  `packages/gateway/src/runtime/http.ts`, and `packages/gateway/src/boot-health.ts`.
- Stable namespace and canonical recorder:
  `packages/backend/convex/domains/fileActivity/namespace.ts` and `model.ts`.
- Bounded folder projection and reads:
  `packages/backend/convex/domains/fileActivity/projection.ts` and `queries.ts`.
- HTTP and SSE surfaces: `apps/api/src/routes/file-activity.ts`; SSE explicitly
  requests ascending pages so `Last-Event-ID` always resumes forward.
- Files activity, unhealthy refusal, and responsive columns:
  `apps/web/spa/files/`, `apps/web/spa/desktop/`, and
  `apps/web/spa/workspace-refusal.ts`.
- Cutover and live proof: `packages/backend/scripts/file-activity-cutover.ts` and
  `runGatewayLivenessJourney` in
  `packages/test-harness/src/staging-e2e-synthetic`.

The principal executable guards are the gateway attribution/anchor/restore tests,
`packages/backend/src/file-activity-namespace.test.ts`,
`packages/backend/src/file-activity.test.ts`,
`apps/api/src/routes/file-activity.test.ts`, the Files attribution tests, and
`packages/test-harness/src/staging-e2e-synthetic`.

## What changed from the build plan

- The reset moved from a backend mutation to pre-schema direct table replacement
  after live staging rows proved the strict schema could not deploy first.
- Admission quiescence remained an operator-proven fleet condition. The existing
  update-pause control pauses releases, not file-event production, and was not
  misrepresented as a safety latch.
- Summary timestamps advance to the newest constituent while their array position
  remains where the first constituent appeared. This preserves causal ordering
  around precise events.
- Projector accounting became at most 63 membership/event-completion steps plus
  one cursor-state write under the 64-operation contract ceiling.
- Symbolic links use file-kind leaf semantics; no third namespace kind was added.
- Mobile Files changed from a clipped ancestor sliver to one full selected pane.
  Breadcrumbs, rather than simultaneous columns, preserve hierarchy at that width.
- The live journey grew bounded authenticated diagnostics for raw paths, anchor
  fast/slow work, restore skipping, boot health, projection, and entity bindings.
  Production behavior was not mutated merely to obtain the evidence.

## Dead ends

- A filtered drive walk cannot establish anchor presence: it can hide the very
  registered path being checked.
- Detaching reconcile from health certification turns a successful heartbeat into
  a false claim about durable state.
- A longer reaper delay hides restore races without establishing correctness.
- Path rewriting, rename-edge traversal, and copied historical logs all make folder
  moves proportional to descendants or history.
- Inode/content/xattr identity would create a second, ambiguous namespace authority.
- Post-storage summarization still writes the flood and makes retries/delete cleanup
  unsafe; folding must happen before persistence.
- Deploying a reset function before the strict schema is impossible when legacy
  rows fail schema validation.
- A release-update pause is not activity-admission quiescence.

## Evidence and visual provenance

The deterministic raw-versus-folded watcher transcript is preserved in
[`assets/watcher-aggregation-transcript.txt`](assets/watcher-aggregation-transcript.txt),
with its runnable source beside it. Namespace and canonical API checkpoints are
preserved in [`assets/namespace-transcript.md`](assets/namespace-transcript.md)
and [`assets/canonical-api-checkpoint.md`](assets/canonical-api-checkpoint.md).
The destructive staging choreography, exact deployment, accepted journey id,
metrics, cleanup, and the decision not to mutate production are recorded in
[`assets/staging-cutover-evidence.md`](assets/staging-cutover-evidence.md).

The visual standard is the checked-in desktop/mobile baseline pairs under
`apps/web/tests/visual/__screenshots__/` for `desktop-unhealthy.png`,
`files-unhealthy.png`, `files-activity-summaries.png`, and
`files-activity-scoped.png`. They were captured from the product playground, not
an external design reference. The unhealthy pairs require a framed, readable
refusal instead of indefinite loading; the activity pairs require actor, action,
path, count, order, and scope to remain legible without client-side regrouping.
The accepted live Files screenshots were transient journey artifacts; the durable
responsive requirement is the optimized-build geometry assertion in
`apps/web/tests/visual/playground.spec.ts`.

The original liveness exploration artifact predates the stable-activity design and
is retained as decision provenance:
<https://claude.ai/code/artifact/9e060f15-091c-40b7-967d-42dcd940a19c>.
