# Workspace backup

A workspace backup is a private, portable ZIP that a person can give to an agent
in a fresh workspace. It combines the complete Drive with useful configuration
and historical conversations. Recovery uses existing APIs and readable files;
there is no native chat import or general restore endpoint. The same artifact
also supplies Drive recovery for automatic replacement of its source workspace.

## The boundary is the product

Drive is a disk backup boundary: hidden files, `.env`, ignored files,
dependencies, caches, empty directories, and symbolic links all belong. Publish
selection would silently omit precisely the local state someone may need to
recover. Nothing outside the configured Drive belongs, even when an older
archive included it. Chrome profiles, private checkpoints, and outside-Drive
provider files therefore do not survive replacement through this backup.

Portable Convex records supply configuration and context that files alone
cannot explain. Canonical sessions include archived, hidden, and child histories
with image bytes; browser discovery and readable transcripts are insufficient
sources. Static MCP tokens accompany their definitions because existing APIs
accept them. Provider OAuth connections require reconnection. Membership,
platform credentials, billing balances, and external sharing authority are not
portable. Source IDs identify historical relationships to remap, never target
identities to reuse. The [projection owner](../../../packages/backend/convex/domains/workspaceBackups/capture.ts)
and [archive recovery guidance](../../../packages/gateway/src/backups/recovery.md)
own the exact field and recreation contracts.

Automatic recovery installs only Drive into the same workspace. Its existing
Convex records remain authoritative, and credentials belong to the destination
VM. Fresh-workspace birth remains a distinct seed operation. Preserving the old
tar/private-state archive as a compatibility path would undermine this boundary;
cutover instead requires an explicit disposition of legacy references.

## Honest capture and durable recovery

Capture observes a running workspace without pausing writers. File-size bounds
and session event ceilings prevent append-only files and growing histories from
extending those reads indefinitely. Checksums describe captured bytes, not an
atomic snapshot. Detected changes, recoverable omissions, unsupported filesystem
nodes, and oversized records make a capture visibly partial. An unavailable Drive
or failed metadata producer fails the capture. Partial exports remain useful
downloads but cannot authorize operator teardown. Subscriber servicing retains
its existing bounded failure policy rather than making an unpaid VM immortal.

Closing a browser cannot cancel durable work. An interrupted ZIP capture fails
and starts afresh on a new request; an uploaded artifact awaiting acknowledgement
reconciles that same artifact. Advancing bytes and records demonstrate progress;
identical heartbeats cannot keep stalled work alive. See the [backup owner](../../../packages/gateway/src/backups/README.md)
and [lifecycle rules](../../../packages/backend/README.md#workspace-backups).

A lifecycle dependency protects its recovery artifact until settlement proves
that the matching VM generation has finished or stopped recovery. A health
timeout alone cannot prove that disk IO stopped. The destination image is fixed
when an operation is admitted: an old bootstrap image can lose a restore handoff
before self-update repairs it. Deleting a settled recovery backup clears its
reference and discloses that the next activation starts with empty Drive while
existing Convex metadata remains.

## Storage choices and measured limits

Private Blob keeps archive bytes out of Convex and API requests. Store authority
stays at the API; the VM receives renewable authority for one object. Retained
artifacts outlive their VM and have no automatic expiry. Deleting active work
must account for already-issued write authority so a late completion cannot
become an unowned object.

The [provider evidence](assets/blob-proof.md) explains two rejected approaches:
automatic fixed-size multipart exhausts the part budget on large disks, and
512 MiB parts were rejected. Adaptive parts with a measured 500 MiB maximum and
bounded scratch support large streams; the SDK progress transport avoids Bun
buffering a whole large body. Completed-object deletion is proven. **Provider
reclamation of unfinished multipart parts remains unverified**; local cancellation
and deletion of the intended object path do not establish their retention or
billing behavior.

Python's maintained ZIP library replaced the proposed libarchive encoder after
independent Linux [ZIP64 boundary proof](assets/archive-zip64-linux.txt). It avoids
custom ZIP framing but retains directory metadata proportional to entry count.
Hardlinks may become separate files, sparse files may expand, and ZIP mtimes have
second precision while inventory retains observed mtimes. Recovery stages before
replacing Drive children because the root may be a mount; it requires capacity
for staging while the old contents remain. The [restore memory evidence](assets/restore-decoder-memory.md)
records the corresponding decoder limits.

## Visual provenance and acceptance

The dedicated Backups tab supersedes the original General card proposal and
keeps recovery available when a workspace is paused or archived. The design
standard was the existing production Settings shell, not a separate mockup.
[Desktop](assets/settings-before-desktop.png) and
[mobile](assets/settings-before-mobile.png) captures preserve that baseline;
the [comparison images](assets/settings-comparison-desktop.png) and
[mobile comparison](assets/settings-comparison-mobile.png) isolate the navigation
change. The [desktop result](assets/backups-tab-desktop.png),
[mobile result](assets/backups-tab-mobile.png), and
[state montages](assets/backup-states-desktop.png) retain the accepted hierarchy
and warning treatment. [Visual review](assets/settings-review.md) records the
remaining crops, docs evidence, and accepted shared-shell limitations.

The [dedicated acceptance journey](../../../packages/test-harness/src/staging-e2e-synthetic)
is the live contract for independent artifact inspection, replacement, retained
download, API-based recreation, and deletion. Provider and ZIP64 probes establish
the large-data boundaries separately from that small disposable-workspace journey.
The [verification record](assets/verification.md) retains the completed local and
live staging evidence, including independent recovery and visual reviews.
Production rollout requires its own private-store connection and legacy-reference
census; staging evidence does not establish production readiness.
