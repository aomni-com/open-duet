# Implementation choices

These are the final design choices made where the request left room for judgment.
The complete Drive boundary, portable histories, private Blob storage, explicit
retention, dedicated Backups tab, and replacement of the old archive were user
requirements, not discretionary additions.

## Storage and capacity

### Keep Blob with an explicit unfinished-upload limitation

**When:** Provider proof and closeout review, 2026-09-29.

**Decision:** Use the required Vercel Blob provider and its official SDK. Cancel
local work and delete completed objects, but do not claim that hidden unfinished
multipart parts have been reclaimed. The alternative is to block this feature
until Vercel confirms reclamation or supplies an abort operation.

**Gap:** The request did not specify how to handle undocumented provider cleanup.

**Rationale:** The provider choice is explicit, completed-object deletion works,
and inventing an S3-style abort operation would not improve Blob's behavior.
Neither the SDK nor the inspected provider documentation establishes a cleanup
deadline for unfinished parts. This is a documented provider limitation, not a
verified cleanup guarantee or a user approval that was never given.

**Consequence:** Failed uploads may leave provider-managed parts whose storage
retention and billing are unverified. Operational follow-up with Vercel remains
useful; it does not justify retaining failed local work or completed objects.

### Separate preview storage from production

**When:** Storage setup, 2026-09-29.

**Decision:** Create a dedicated private preview/development store rather than
reuse the team's unrelated public store. Production storage is left unconfigured.

**Gap:** The request named the provider but no store or production rollout.

**Rationale:** Archives include private Drive bytes. A separate private store
meets the requirement without mixing retention with another application's data.

**Consequence:** Staging has its own storage connection. Production needs a
private store connection and an old-archive census before this branch is deployed
there; no production migration or cleanup has been performed.

### Renewable authority for one object

**When:** Blob adapter and worker passes, 2026-09-29.

**Decision:** The API issues fifteen-minute upload grants for one immutable path
and separately signed read links. It never sends the store-wide credential to a
VM or browser. The alternative was the SDK's webhook-dependent upload helper.

**Gap:** Planning did not select the SDK admission method or token lifetime.

**Rationale:** The official client-token method supports multipart renewal with
the actual project connection. Webhook plumbing would introduce a second
completion owner without improving this background job's contract.

**Consequence:** Long captures renew authority rather than receive a long-lived
credential. Download links can be renewed while their artifact is retained.

### Adaptive parts and bounded temporary disk

**When:** Multipart transfer proof, 2026-09-29.

**Decision:** Send a small first part, ordinary parts afterward, and 500 MiB parts
for very large objects, with at most two part files outstanding. Use the SDK's
progress transport and a one-minute operation deadline. The alternative was its
automatic fixed-size uploader or a whole-archive temporary file.

**Gap:** Buffer sizes, retry transport, and operation deadlines were unspecified.

**Rationale:** The automatic uploader exhausts the provider's part budget on
large disks. The chosen schedule fits its documented object limit; 512 MiB
requests were rejected, while 500 MiB worked. The progress transport avoids Bun
buffering an entire large file body before sending it.

**Consequence:** Capture needs up to 1,000 MiB of part scratch, independent of total
archive size. A slow or failed operation fails visibly rather than holding a
worker indefinitely. Per-part high-water counts prevent retries inflating progress.

### Use the standard ZIP implementation

**When:** Archive and restore passes, 2026-09-29.

**Decision:** Use the VM image's Python ZIP library for ZIP64 writing and decoding,
with streamed file contents. The alternative was maintaining custom ZIP framing
or retaining the old tar producer.

**Gap:** The archive's encoder and decoder were not prescribed.

**Rationale:** The standard library already owns CRC, ZIP64, compression, and
entry framing. Independent extraction confirms interoperability. Archive policy
stays in the gateway, separate from the narrower publish-file policy.

**Consequence:** File bytes use bounded buffers; ZIP directory metadata grows with
entry count. The feature does not impose an invented file-count ceiling, and
large numbers of entries still carry an explicit memory cost.
Hardlinks become independent files, sparse files may expand to their logical
size, and ZIP timestamps have second precision; inventory retains observed mtimes.

## Capture and recovery

### Bound a live read without pretending it is a snapshot

**When:** Drive and metadata capture passes, 2026-09-29.

**Decision:** Read a file only through the size observed when opened, and bound
metadata collections by creation cutoffs and each session's event ceiling.
Detected changes, unreadable entries, missing images, and oversized records
produce partial-capture warnings. The alternative was pausing writers or chasing
a changing source indefinitely.

**Gap:** Live capture was required, but its finite-read rule was not specified.

**Rationale:** An append-only file or busy conversation must not keep an export
running forever. Descriptor-relative filesystem traversal prevents a concurrent
rename from redirecting a read outside Drive. Warnings preserve the distinction
between known omissions and a successful complete capture.

**Consequence:** Checksums describe captured bytes, not one atomic point in time.
A downloadable partial archive remains useful, but automatic replacement refuses
it. Very large individual metadata records can be omitted with an explicit warning.

### Spool portable records outside Drive

**When:** Portable metadata pass, 2026-09-29.

**Decision:** Process one category or session at a time, reuse its captured events
for both structured history and transcript, and stage attachments individually.
Encode source IDs as archive path components while preserving the original IDs
inside records. The alternative was retaining every record and image in memory.

**Gap:** Temporary representation and archive-local reference encoding were open.

**Rationale:** Histories must remain complete without heap growth proportional to
the workspace. One event capture also prevents the readable transcript and raw
history from describing different reads of a changing source.

**Consequence:** Temporary disk grows with the largest current category/session
and attachment, while inventory spools grow with entry count. Signed source URLs
never become archive records; receiving agents map source IDs to new IDs.

### Stage restore before replacing Drive children

**When:** Automatic recovery pass, 2026-09-29.

**Decision:** Verify the downloaded ZIP, extract to scratch, then stage replacement
children on the Drive filesystem before swapping them. Preserve the mount root
and keep old children until the swap succeeds. The alternative was extracting
directly over the destination or renaming the mount itself.

**Gap:** Automatic replacement was required, but installation mechanics were open.

**Rationale:** Drive can be a mount, so replacing its root can fail. Preflight
capacity and validation keep ordinary download, corruption, and space failures
from destroying the existing destination. Same-filesystem child renames support
rollback when installation fails.

**Consequence:** Recovery needs room for the download and expanded staging while
old Drive content remains. Insufficient capacity fails explicitly; this is not a
promise to restore arbitrarily large backups into a smaller disk.

## Jobs, lifecycle, and access

### One durable capture per workspace

**When:** Durable service pass, 2026-09-29.

**Decision:** Admit one active capture at a time. Reusing a request ID returns its
job; a different concurrent request receives the active job ID. Each job schedules
its own dispatch and cleanup callbacks. The alternative was concurrent captures
or work owned by a browser request or fleet-wide polling loop.

**Gap:** Concurrency, idempotency, and background execution were unspecified.

**Rationale:** A workspace has one disk and worker; competing captures would
multiply load without improving recovery. Durable callbacks survive a closed
tab, lost create response, and API process lifetime without adding a service.

**Consequence:** A failed interrupted capture starts afresh on a new request.
An uploaded artifact with a lost acknowledgement retries only its receipt.
An authenticated worker retires a journal whose job was deleted while unreachable.

### Show evidence of work instead of a guessed percentage

**When:** Worker and restore progress passes, 2026-09-29.

**Decision:** Show processed files/records and captured/uploaded bytes. Only
advancing work renews inactivity deadlines; identical heartbeats do not.
Restore reports actual download, indexing, extraction, and installation work.
The alternative was a fixed total-runtime timeout or a fabricated percentage.

**Gap:** Progress presentation and stuck-work detection were open.

**Rationale:** Live source size is unknown, and valid large operations can run a
long time. Incremental captured bytes keep compressible files observable even
before enough compressed data exists to send another upload part.

**Consequence:** Backups use a five-minute inactivity window. Restore's local
stall abort leaves time for cleanup before the control plane's longer deadline.
Healthy work can continue beyond those durations, but silence cannot renew itself.

### Keep cleanup records until issued write authority settles

**When:** Deletion pass, 2026-09-29.

**Decision:** Deletion refuses new grants and retains its cleanup row until issued
upload grants expire plus a two-minute settlement allowance. Verified completed
objects can delete immediately. The alternative was removing the row on request.

**Gap:** The request did not define races between cancellation and late upload.

**Rationale:** Issued Blob grants cannot be revoked individually. Dropping the row
would lose the owner responsible for deleting an object that completes late.

**Consequence:** Deleting active work may remain visibly pending for the remaining
grant lifetime. Independent callbacks prevent one failed deletion blocking others.
This completed-object protection does not prove hidden multipart reclamation.

### Keep lifecycle admission separate from completion

**When:** Lifecycle replacement and review passes, 2026-09-29.

**Decision:** A replacement request returns an admitted backup job before teardown.
Only complete capture and a fresh servicing-policy check permit operator teardown.
Pin recovery until installed acknowledgement plus normal sync, explicit stopped
failure, or confirmed teardown of the matching VM generation. The alternative
was a long synchronous request or releasing the pin on any health timeout.

**Gap:** The asynchronous lifecycle receipt and recovery settlement protocol were open.

**Rationale:** API timeouts cannot own a multi-stage disk operation. A generic
heartbeat failure does not establish that restore IO stopped. Binding settlement
to the actual VM generation prevents stale callbacks releasing a newer recovery.

**Consequence:** A pinned backup cannot be deleted. Deleting an unpinned failed
recovery clears the authoritative reference and tells its VM to retire the local
restore prerequisite. Retrying a failed installation reuses the intact backup;
once installation has succeeded, later replacement captures the VM's current
Drive. Unpaid servicing keeps its existing grace policy.
Deleting an archived workspace's settled recovery backup also clears its recovery
reference: the next activation starts with empty Drive while its existing Convex
records remain. Settings warns before deletion; the API deletion response reports
that consequence.

### Select current images once per admitted operation

**When:** Deployment integration, 2026-09-29.

**Decision:** New boots use the configured image unless explicitly overridden.
Keep that destination fixed through teardown and retries, separately from the
image recorded on the existing VM. The alternative was reusing the historical
image or rereading configuration on every retry.

**Gap:** Replacing the archive protocol exposed how old image pins were selected.

**Rationale:** An old first-boot gateway can discard a new restore descriptor
before self-update can repair it. A fixed admitted destination also prevents a
configuration change from changing an operation halfway through.

**Consequence:** A new staging image is part of deployment. Future reactivations
receive current code; completion or abandonment releases the destination pin.
No fleet-wide reprovision is implied.

### Reuse administrative authority and preserve recovery access

**When:** API and Settings passes, 2026-09-29.

**Decision:** Use the existing workspace admin capability and its normal VM-key
rotation. Let owners reach retained backup management from billing barriers,
without requiring a running VM. Resolve admitted backup commands separately from
ordinary traffic so an unhealthy but reachable VM can participate in recovery.
The alternative was a new backup credential or requiring funded live traffic for
all backup operations.

**Gap:** The exact capability and availability rules were not prescribed.

**Rationale:** A complete export includes histories beyond ordinary file discovery.
The security model already treats the VM as one workspace trust domain. Retained
artifacts must remain recoverable after their VM or funding is gone.

**Consequence:** Ordinary files-only keys cannot export the workspace. Recovery
control does not enter the ordinary gateway cache or open user traffic on an
unhealthy VM. Download/delete can remain available when new capture cannot run.
