# Gateway liveness and activity — final choice ledger

This ledger was rebuilt from the shipped code and evidence at closeout. It contains
only choices that remain load-bearing. Entries are grouped by verdict and ordered
from least to most confidence.

## Sound — medium confidence

### Historical path resolution is segment-local

Selectable history may fall back through direct ended bindings one path segment at
a time inside the current restore epoch; a live binding shadows the historical
alias. Imagine `a/report.md` moves to `b/report.md`: selecting the moved file can
still find its identity, but recreating `a/report.md` immediately makes the new live
file win. This avoids alias chains and descendant rewrites, though the interaction
between reused ancestors and direct historical children is subtle enough to keep at
medium confidence.

### Admission quiescence is an external cutover precondition

The reset CLI demands explicit acknowledgement that file-event producers are
quiesced and sealed retries discarded, but it does not pretend to perform that
fleet action. Imagine pausing software updates while gateways continue watching
files: a reset could be repopulated immediately. The existing pause controls the
release rail, not admission, so a loud operator precondition is safer than a false
latch.

### Projection age is backdated to canonical insertion

When a projector first examines pending work, it stores the canonical event's
creation time rather than the worker start time. Imagine the worker begins thirty
seconds late: once it starts, the reported pending age includes those thirty
seconds. Before that first worker pass, projection status reports sequence lag but
has no pending-age field. This uses the first durable queue timestamp without a
second clock owner.

### The first namespace is created lazily

Epoch 1, the synthetic root, and sequence 0 appear inside the first recorder
transaction rather than workspace birth. Imagine a workspace that never produces
file activity: it needs no empty namespace rows. This keeps initialization with the
only sequence/transition owner, at the cost of making first-use creation part of
that transaction.

## Sound — high confidence

### Symlinks are file-kind leaves

The structural contract has exactly file and folder namespace kinds; a symbolic
link is a file-kind leaf. Imagine a symlink to a directory: following it as a folder
would introduce traversal and identity behavior the watcher does not own. Treating
it as a leaf matches existing Files behavior without adding a third kind.

### Invalid paths are never classified as noise

`noisyTreeRoot` returns no match for invalid or non-normalized input. Imagine
`node_modules/../source.ts`: classifying the raw prefix as noisy could hide authored
activity. Validation rejects it at trust boundaries, and the classifier fails
closed as ordinary if called independently.

### One classifier owns folding and mover-search pruning

The contract's exact-segment noisy-root policy is shared by activity aggregation
and the anchor slow walk, while direct presence probes never call it. Imagine
`.github` or `node_modules_backup`: both remain ordinary. A single conservative
owner prevents the two rails from drifting without conflating search cost with
existence.

### Noisy summaries retain first-occurrence order

A summary stays at the array position of its first constituent while its timestamp
and count advance through later constituents. Imagine noisy event A, precise rename
B, then another event folded into A: moving the summary after B would reverse the
observed causal boundary. First-occurrence placement is stable across batching and
retry.

### Direct probes run concurrently; slow search runs once

All registered anchors are `lstat`-probed concurrently and their roster order is
retained; at most one filtered mover walk follows. Ten healthy anchors therefore
cost ten independent direct facts and zero directory reads, without ten serial
latencies or ten recovery walks.

### Reconcile telemetry crosses an optional callback seam

The reconciler reports structured fast, slow, or skipped measurements to an
optional callback; the runtime owns logging. Tests can inspect exact walk/pruning
counts without parsing logs, while the filesystem algorithm avoids depending on a
logging backend.

### Sync coalescing and API serialization are different methods

Recurring callers use `reconcileSync`; direct pushes use `reconcile`. Imagine two
API roster writes arriving quickly: callers must observe both, while ten periodic
ticks during one run need only the newest follow-up. Named entry points make the
choice compile-time visible instead of relying on an easy-to-miss mode flag.

### One restore window owns both restore paths

Registration and sync recovery share one serialized window around archive
completion only, with cleanup in `finally`. Two booleans could let one request clear
the guard while another restore remained active. The shared object makes the
reconciler's skip verdict structural and retry-safe.

### Boot-health failure is visible but does not poison the queue

Each caller receives its original persistence promise, while the internal queue
stores a handled tail. Imagine one health write fails: that caller must fail, but a
later good write must still run. This separates error visibility from queue
continuity without falsely certifying the failed release.

### Active and ended bindings use sparse index keys

Current and historical bindings occupy disjoint sparse index keys. A live lookup
cannot accidentally scan ended history, and historical selection cannot confuse a
currently occupied slot. This makes the read bound structural rather than dependent
on accumulated rename count.

### Lineage misses are counted transactionally

A missing or unresolvable rename source increments a durable namespace counter in the
same transition that chooses the safe new identity. A log-only warning could vanish
or double under retries; a transactional counter gives the live journey stable
evidence without storing sensitive path samples.

### Sequence allocation precedes read deduplication

Every admitted transition consumes the namespace clock before canonical read-marker
dedupe. Imagine write 1, duplicate read 2, write 3: persisted rows may be 1 and 3,
but sealed order and resume cursors remain truthful. Gaps mean a deduped read or a
policy-suppressed mirror read, not a missing write.

### Pending folder projection never scans the log

A folder with incomplete derived membership returns only completed indexed results;
it does not fall back to path-prefix or workspace-log scanning. Temporary
incompleteness is visible and bounded, whereas a fallback would make the worst case
unbounded precisely when the projector is behind.

### The 64-operation budget reserves cursor persistence

Each projector transaction performs at most 63 membership/event-completion steps
and one cursor-state write. Imagine a deep path requiring another chunk: partial
rows may exist physically, but none become reader-visible until event completion.
The fixed split makes forward progress without smuggling state overhead outside the
contract ceiling.

### Legacy rows are reset through pre-schema table replacement

The operator CLI uses schema-independent Convex import against an exact two-target
allowlist, snapshots first, replaces eight fixed tables sequentially, and verifies
emptiness. Imagine legacy rows containing a removed field: deploying a reset
mutation behind the strict schema cannot succeed. Pre-schema replacement is the
only ordering that removes the blocker without checking compatibility code into the
application.

### Live diagnostics are bounded and authenticated

Health, raw-path samples, anchor work, restore skip, boot certification, projection,
and binding probes expose only bounded production seams behind VM/internal
authentication. The acceptance journey can prove what it claims without inserting
unbounded debug state or mutating production behavior merely for observation.

### Unknown refusal values collapse to gateway failure

Known workspace lifecycle refusals keep typed status and copy; unknown upstream
values become `502 gateway_failed`. A new or malformed code is therefore never
misreported as a valid provisioning state. Files and Desktop share the classifier
but own their surface-specific presentation.

### Initial deep links keep the destination in view

The column browser pins an initial deep link to its terminal folder until the user
explicitly scrolls. Resize and programmatic layout movement do not surrender that
intent. At mobile width the selected pane occupies the viewport and breadcrumbs
carry ancestry, avoiding the misleading clipped ancestor sliver found during live
visual acceptance.

### The risk workload is test-only and lazy

The identity matrix and lazy million-entry generator live in a test-only contract
fixture. Contract tests pin the complete identity oracle; gateway risk tests reuse
the workload/scale portion, while backend outer-seam tests independently pin the
same shipped identity rules. The lazy generator avoids allocating millions of
strings on import, and none of this harness machinery is exported to production
consumers.
