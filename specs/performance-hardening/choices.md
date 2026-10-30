# Performance hardening choices

This ledger records decisions the implementation had to make where the audit identified a
problem but did not prescribe the final contract. Entries describe the durable choice, not the
mechanics of the pass that introduced it.

## Needs-user

### Syncthing initialization backs off from one second to 30 seconds

- **When:** P29 Syncthing initialization.
- **The choice:** Suppose the gateway starts before Syncthing, or Syncthing rejects a config write.
  The gateway retries connection, hardening, and mount projection after one second, doubles the
  wait after each failed lifecycle, and caps it at 30 seconds. Consumers remain stopped throughout;
  once all phases succeed, retrying ends and consumers start exactly once.
- **The gap:** The audit required bounded backoff but supplied no measured VM boot ordering or
  recovery-time distribution.
- **The reach:** These process-local constants trade recovery latency against loopback API and log
  pressure. They change no stored state or protocol and can be tuned without migration.
- **Verdict:** needs-user. Keep the provisional one-to-30-second range until production boot and
  retry telemetry establishes a better curve.
- **Confidence:** low.

### Runner diagnostics retain 64 KiB of stderr

- **When:** P18 agent-runner process transport.
- **The choice:** Stderr—the process's human-readable diagnostic stream—retains its newest 64 KiB.
  For example, a process that writes 100 KiB of errors finishes with a marked 64 KiB tail available
  to the failure report.
- **The gap:** The audit required explicit byte ceilings but supplied no observed distribution for
  valid protocol-record sizes or runner diagnostic volume.
- **The reach:** This in-memory limit applies independently to every live agent turn. It changes no
  stored record or wire format and can be adjusted without migration.
- **Verdict:** needs-user. Keep the provisional 64 KiB tail until production telemetry shows how
  much failure context is useful.
- **Confidence:** low.

### Marketplace contention gets 32 repair attempts and 4,096 conflict-name probes

- **When:** P27 marketplace materialization.
- **The choice:** Imagine another process recreating `AGENT.md` every time the marketplace puller
  moves it aside. The materializer tries the same repair at most 32 times, then returns a normal
  retryable pull error while leaving its transaction journal intact. Searching for a free
  `sync-conflict` filename has a separate 4,096-name ceiling because a folder may legitimately
  contain many old conflict copies even when nobody is actively racing the current install.
- **The gap:** The audit required finite work but supplied no measured collision or concurrent-
  writer distribution.
- **The reach:** These internal constants trade one pull's filesystem work against how quickly it
  yields to the hourly puller's existing exponential retry. They change no stored format.
- **Verdict:** needs-user. Keep the provisional ceilings until contention telemetry shows whether
  real writer races need a time budget or different counts.
- **Confidence:** low.

### Install locks expire after one hour and stop waiting after 30 seconds

- **When:** P28 gateway-release and skills-install locks.
- **The choice:** A lock is an atomically created directory whose modification time is refreshed
  while installation remains active. A caller waits at most 30 seconds for that directory. A lease
  that has not been refreshed for one hour is treated as abandoned and reclaimed.
- **The gap:** The audit required a lease and bounded wait but supplied no production distribution
  for release download/install duration.
- **The reach:** An unusually slow install lasting over an hour could lose exclusivity. Both values
  are internal defaults and can change without a migration.
- **Verdict:** needs-user. One hour is deliberately far above normal artifact installation while
  still recovering a dead marker; deployment timing should validate it.
- **Confidence:** low.

### Failed cleanup retries wait 15 minutes for users and five minutes for VMs

- **When:** P31 expired identities and P32 leaked-VM cleanup.
- **The choice:** A user who still belongs to someone else's live workspace is retried after 15
  minutes. A workspace whose VM teardown could not be scheduled is retried after five minutes.
  Until then, the failed row is absent from the eligible prefix, letting later cleanup work pass.
- **The gap:** The audit required rotation but supplied no recovery-time or operator-intervention
  distribution for either failure.
- **The reach:** These intervals trade retry latency for repeated Convex work and logs. They are
  ordinary internal constants; the VM timestamp is durable, while the user reuses its existing
  expiry timestamp.
- **Verdict:** needs-user. The provisional intervals match each cron's urgency without creating a
  rapid poison loop; production failure telemetry should tune them.
- **Confidence:** low.

### A failed stale-health transition waits five minutes before retrying

- **When:** P37 stale-workspace health sweep.
- **The choice:** Imagine 1,000 stale workspaces whose transition to `unhealthy` always fails, with
  a valid stale workspace immediately behind them. Each failed row is made ineligible
  for five minutes. The next minute's cron therefore reaches the later workspace instead of
  selecting the same 1,000 failures again. When the delay expires, the failed row may be tried
  again; a new VM heartbeat clears the delay immediately because the workspace is healthy evidence,
  not failed cleanup work.
- **The gap:** The audit required forward progress but supplied no recovery-time distribution for
  malformed workspace metadata or transient database failures.
- **The reach:** Five minutes trades recovery latency for repeated Convex work and error logs. It is
  an internal constant and can change without rewriting stored rows.
- **Verdict:** needs-user. Keep five minutes provisionally, matching the existing leaked-VM cleanup
  cadence, and tune it if production failures show a different recovery profile.
- **Confidence:** low.

### A live session subscriber may queue 256 events or 1 MiB

- **When:** P13 session-stream backpressure.
- **The choice:** Retained replay is read lazily outside the live budget. Events that arrive after
  subscription may occupy at most 256 queue entries or approximately 1 MiB before that subscriber
  is detached. It drains already accepted frames, closes, and reconnects from its last durable SSE
  ID. This prevents one stalled browser from retaining an unlimited turn while preserving replay.
- **The gap:** The audit required event and byte ceilings but supplied no production distribution
  for event sizes, client stalls, or reconnect frequency.
- **The reach:** These are internal gateway defaults. Changing them needs no protocol or data
  migration; lowering them trades memory for more reconnects, while raising them does the reverse.
- **Verdict:** needs-user. Keep the provisional values until production queue and reconnect
  telemetry supports a tighter budget.
- **Confidence:** low.

### A relay journal is bounded by bytes alone

- **When:** P07 durable relay outbox; reduced to one knob on 2026-08-19 and sized in checkpoints
  on 2026-08-20.
- **The choice:** The cap exists for one reason — a runaway session must not fill the drive — and
  bytes are what expresses it, because bytes are what a drive runs out of, and bytes are what the
  replay fold costs to hold. A record count alongside them is a second knob for the same failure
  that says less, since 1,024 records is anything from a kilobyte to half a gigabyte. A session
  stops producing when its unacknowledged journal would exceed the cap; the gateway kills the
  runner, drains the committed prefix, and restarts the still-accepted turn. Work may repeat, but
  output is not silently continued past an undurable event. The size is the largest journal that
  can still be read rather than a round number: the loader turns the file into one string, so a cap
  above the runtime's max string length never binds — the load throws first, and ungracefully.
  Sizing past that bound means reading the journal in chunks. What it buys is several whole session
  snapshots, since a record carries a checkpoint, so a stalled drain is not mistaken for a runaway.
- **The gap:** The audit required a finite capacity and overload policy but supplied no measured
  turn size. The provisional values were then observed killing an ordinary image-heavy turn
  rather than a runaway one. Production supplied the missing measurement: a healthy VM carries no
  journal at all between acknowledgements — every session directory holds its snapshot and
  nothing else, mid-turn included. The limit therefore bounds a backlog, not a turn. What it does
  NOT bound is a single record the control plane refuses; that is the relay's retry budget's job,
  and it is a separate guard because it fails in a separate way.
- **The reach:** The limits bound one session's disk and recovery work. They are internal defaults
  and can change without migrating stored records. Binding is not free — it kills the runner and
  re-runs the whole turn at full model cost — so the cap is deliberately loose. The real ceiling
  on a backlog is drain throughput, one in-order HTTP round trip per event, so a large journal is
  relayed slowly rather than dropped.
- **Known cost, accepted:** a journal record embeds the runner's full checkpoint whenever it
  changes (`turn_started`, `todos`, `follow_up_queue`, `state_machine`, terminals), so a session
  whose conversation state is large writes that state repeatedly, and only the last copy is ever
  read. Relocating the checkpoint into the session snapshot is **not** the fix, and P07's own
  history says why: the outbox used to live inside the envelope, and writing it there rewrote the
  whole snapshot — checkpoint included — on every event, which is the cost the journal was
  introduced to remove. Moving the checkpoint back would restore that rewrite for exactly the
  events carrying the fat payload. The duplication is a symptom; the size is the disease, and it
  is an agent-side one — a checkpoint stays small when generated images live on the drive instead
  of inside `agent.messages`. Until then the byte cap is the guard.
- **Verdict:** user (Example User). A kill is reserved for a genuine runaway; a long turn gets to finish.
- **Confidence:** medium.

### Session history and SSE backfill retain 100 rows per page

- **When:** P01/P02 session replay.
- **The choice:** Both the newest browser history page and each internal durable SSE backfill page
  retain at most 100 rows. The stream still emits one event per downstream pull; 100 is only the
  maximum result held between Convex reads. Older browser pages load explicitly.
- **The gap:** The audit required a bounded page but supplied no production distribution for event
  size, reconnect depth, time-to-first-frame, or older-history usage.
- **The reach:** The number trades Convex round trips against API/browser memory. It is a shared
  request default, not stored data, and can change without a migration.
- **Verdict:** needs-user. Reusing the existing 100-row default avoids a new unexplained scale, but
  production latency and payload telemetry should confirm it.
- **Confidence:** low.

## Sound

### Paging backward turns file activity into a snapshot

- **When:** P15 file-activity refresh.
- **The choice:** While a timeline shows only its newest page, React Query polls it every five
  seconds. Once someone presses “load more,” the open timeline stops polling and keeps those pages
  as one historical snapshot. Closing removes that snapshot from the browser cache; reopening loads
  a fresh newest page and resumes polling. The alternative—one live head cache plus a separately
  merged historical cache—would preserve live updates while browsing old pages, but adds a second
  pagination owner for an edge case.
- **The gap:** The audit required historical page count not to multiply recurring requests, but did
  not decide whether a user browsing history also needs live updates in that same open view.
- **The reach:** Recurring work stays constant without a new API, cursor mode, or client state
  machine. A user paging through history sees a stable snapshot until they reopen it.
- **Verdict:** sound and user-directed toward simplicity. The behavior is reversible if usage shows
  that simultaneous live updates and historical browsing matter.
- **Confidence:** medium.

### Only a successful exact share snapshot can become a no-op

- **When:** P17 share convergence.
- **The choice:** The gateway remembers the complete desired share snapshot, including refreshed
  credentials, only after every share converges without error. Before reusing it, the gateway still
  verifies mount records, the relocation journal, and root safety. Clean recovery signals skip
  folder writes and Syncthing convergence; any drift, changed snapshot, failed attempt, or gateway
  restart runs the full existing convergence.
- **The gap:** Skipping repeated work could have used durable state, semantic field-by-field
  comparison, or process memory; the audit specified only that unchanged work should be a no-op.
- **The reach:** There is no migration or recovery protocol. At worst, restart pays for one ordinary
  convergence; uncertainty never skips repair.
- **Verdict:** sound. Process-local positive evidence plus cheap recovery probes is the smallest
  cache that cannot conceal a failed, deleted, or interrupted convergence.
- **Confidence:** high.

### Bare official names mean the one official workspace

- **When:** P20 marketplace lookup.
- **The choice:** Onboarding and campaign configuration sometimes name an official agent without a
  listing id. Those names now resolve inside the workspace with the fixed official slug, then
  through the existing exact `(workspace, agent name)` listing index. A different verified publisher
  using the same name is still a legitimate marketplace publisher, but cannot satisfy Duet's
  campaign or onboarding selection.
- **The gap:** The old resolver equated “verified publisher” with “Duet official” even though the
  seed manifest already owns the official workspace's exact identity.
- **The reach:** The lookup is correct at any catalog size without a new index, field, table, or
  migration. Ordinary marketplace installs remain listing-id keyed.
- **Verdict:** sound. Reusing the canonical identity is both simpler and stricter than scanning a
  catalog for an attribute that is not identity.
- **Confidence:** high.

### Continuous polling is acceptable when recovery has an owner

- **When:** Prioritizing the remaining performance findings after the bounded-work pass.
- **The choice:** A client may continue polling a transitional session, app, job, or integration
  indefinitely while its backend owner continues making bounded recovery attempts. The defect to
  fix is a state with no lease expiry, retry, repair, or terminalization path—not the continued
  observation of a recoverable state. Likewise, the session-activity maximum of 153 indexed Convex
  queries under the 50-agent product ceiling is accepted, and the knowledge map keeps its bounded
  per-agent information because that data may become visible later.
- **The gap:** The audit treated indefinite polling and query fan-out as suspicious without evidence
  that every bounded instance causes material cost or that stopping observation helps recovery.
- **The reach:** P21 and P36 now target backend liveness rather than client timers. P08 and P22 leave
  the active queue, preventing speculative projections and premature removal of potentially useful
  data.
- **Verdict:** sound and user-directed. Require a concrete stuck state, correctness failure,
  unbounded resource, or measured production cost before adding machinery.
- **Confidence:** high.

### Exceptional ceilings log the outcome, not the payload

- **When:** Cross-cutting performance limit observability.
- **The choice:** A ceiling that drops work, disconnects a stream, skips corrupt state, or ends a
  process emits one structured signal when that outcome begins. The signal names the affected
  identity, limit, and recovery action but never includes runner output, file contents, or tunnel
  bytes. Normal pagination, product-capacity validation, rate limiting, and UI polling budgets use
  their existing response or visible-state contracts instead of warning logs.
- **The gap:** A finite bound prevents resource exhaustion but can hide the underlying fault if its
  overload outcome is observable only as a reconnect, retry, or missing event.
- **The reach:** Operators can distinguish deliberate overload handling from ordinary transport
  failure without turning a filesystem storm or stalled client into a log storm.
- **Verdict:** sound and user-directed. Outcome-changing safety guards require telemetry; expected
  control-flow boundaries do not.
- **Confidence:** high.

### Title polling expires independently from input-delivery polling

- **When:** P35 session title polling.
- **The choice:** A session detail has two separate reasons to refresh once per second. A title may
  still be generating, or an accepted user input may still be waiting for a runner to claim it.
  The title reason now stops under the same age and terminal-status rule used by session lists. The
  input-delivery reason remains active while its delivery attempt exists. For example, a two-hour-
  old session with a stuck generated title and no pending input stops polling; the same session
  with a newly accepted message continues polling for delivery even though its title is old.
- **The gap:** The finding named divergent title polling, but the detail query combined title work
  with a separate delivery lease. It did not say whether the title ceiling should stop the whole
  detail poll.
- **The reach:** P35 cannot conceal or delay input delivery. Recovery and bounded polling for a
  stranded delivery lease remain owned by P21 instead of being accidentally treated as a title
  timeout.
- **Verdict:** sound. Each cause decides its own liveness; fixing one unbounded cause must not
  suppress observation of unrelated active work.
- **Confidence:** high.

### A failed PID lookup preserves the last confirmed Syncthing exclusion

- **When:** P30 Syncthing PID refresh.
- **The choice:** The privileged filesystem watcher excludes Syncthing's process ID so replicated
  writes are attributed from Syncthing's semantic event stream rather than counted twice. If one
  `systemctl` lookup fails or returns invalid output, the gateway keeps the last confirmed process
  ID, logs the failure, waits 30 seconds, and retries. It clears the exclusion only when a
  successful lookup reports no active PID. The alternative treated “lookup failed” as “Syncthing
  stopped,” briefly admitting
  duplicate or misattributed filesystem events.
- **The gap:** The audit required the refresh loop to survive but did not decide what its exclusion
  set should contain while discovery is uncertain.
- **The reach:** Attribution remains conservative during transient systemd failures, and recovery
  needs no durable state because the next successful lookup replaces the whole set.
- **Verdict:** sound. Unknown process state should not erase the last confirmed safety exclusion;
  confirmed inactivity still does.
- **Confidence:** high.

### First-attempt stale work takes priority over previously failed rows

- **When:** P37 stale-workspace health sweep.
- **The choice:** The sweep has two eligible groups. First it selects stale active workspaces that
  have never failed this transition. If fewer than the 1,000-row batch remain, it fills the unused
  slots with previously failed rows whose retry time has arrived. A failed row receives a retry
  timestamp; a successful transition leaves the active index; a persisted heartbeat clears the
  timestamp. The unbuilt cursor alternative would remember one global scan position, adding a
  singleton state record whose cursor must remain valid while successful rows leave the index.
- **The gap:** The audit allowed either per-row retry eligibility or cursor rotation, but did not
  choose between them or define which group should consume a constrained batch first.
- **The reach:** The workspace record gains one operational timestamp and one compound index. This
  gives every failure its own scheduling state and keeps new stale evidence moving even while old
  malformed rows continue to fail.
- **Verdict:** sound. Per-row eligibility matches the existing cleanup-fairness pattern and avoids a
  second state machine; prioritizing first attempts prevents retries from recreating the poison
  prefix they were introduced to remove.
- **Confidence:** high.

### An oversized stdout record terminates the turn instead of guessing at framing

- **When:** P18 agent-runner process transport.
- **The choice:** Stdout is parsed as NDJSON: a newline is the only boundary proving one JSON record
  is complete. The user-set 10 MiB budget resets after every newline, so a long turn may contain any
  number of ordinary events. If one complete or still-incomplete record exceeds the limit, the
  gateway records a diagnostic and terminates the process. Its durable session checkpoint remains
  the retry source. The same event reaches the structured session log with metadata only, not the
  oversized content.
  The unbuilt alternative was to discard old bytes and keep reading, but a later newline would then
  present only the suffix of the original JSON as though it were a new record; real model events or
  command acknowledgements could be silently misparsed or lost.
- **The gap:** The audit required explicit oversize behavior but did not choose termination,
  truncation, or an attempted resynchronization rule.
- **The reach:** A malformed or runaway runner cannot consume unbounded gateway memory. A genuinely
  valid record above the configured ceiling retries rather than being partially delivered, keeping
  the session ledger as the sole continuation boundary.
- **Verdict:** sound. Without a trusted delimiter, stopping and replaying is the only bounded outcome
  that does not invent protocol meaning.
- **Confidence:** high.

### Stderr keeps the newest diagnostic tail and says when older text was removed

- **When:** P18 agent-runner process transport.
- **The choice:** Stderr is diagnostic text rather than a protocol. When it exceeds its byte budget,
  the gateway removes the oldest text, prepends an `earlier runner stderr truncated` marker, and
  keeps the newest tail. It also emits one metadata-only structured log entry when truncation first
  occurs. For example, lengthy startup chatter disappears while the final stack
  trace remains. Keeping the oldest prefix instead would preserve startup context but commonly lose
  the failure at the end; silently truncating either side would make an incomplete report look
  complete.
- **The gap:** The audit required useful bounded errors but did not specify which end to retain or
  whether truncation must be visible.
- **The reach:** Startup failures, turn-start timeouts, and gateway logs continue to receive a
  bounded diagnostic string. Secret redaction still happens before text is retained, and no error
  response or stored schema changes.
- **Verdict:** sound. The failure-proximate tail is normally the actionable portion, and the marker
  makes the information loss explicit.
- **Confidence:** high.

### A blocked ephemeral user reuses the expiry clock as its next retry time

- **When:** P31 expired identities.
- **The choice:** Once an ephemeral user has expired, `ephemeralExpiresAt` already means “this row
  may be retired at or after this time.” If retirement fails, the sweep moves that time forward
  instead of adding a second retry field. The identity remains explicitly ephemeral, and later rows
  become eligible immediately; after the delay, the same normal query sees it again.
- **The gap:** The audit did not choose between a cursor, a new retry column, or reusing the existing
  eligibility clock.
- **The reach:** There is one clock and one index for ephemeral retirement. A UI that later displays
  the original requested expiry would need a separate immutable product field, because this field
  now owns operational eligibility after expiry.
- **Verdict:** sound. Today no consumer presents the original expiry after it becomes due, and one
  lifecycle clock is simpler than parallel eligibility state.
- **Confidence:** medium.

### Marketplace contention reuses the existing retryable pull failure

- **When:** P27 marketplace materialization.
- **The choice:** If another process keeps recreating a path until the materializer exhausts its
  attempt budget, the gateway throws a descriptive local error. The marketplace pull owner maps it
  to its existing `pull_failed` result with `retryable: true`, records that result on the
  subscription, and retains the detailed exception in gateway logs. The unbuilt alternative was a
  new public error code used only by this race even though no API or UI consumer branches on it.
- **The gap:** The audit required a retryable outcome but did not decide whether contention needed
  a distinct wire-level category.
- **The reach:** Pull scheduling and API shapes stay unchanged. Operators can inspect the detailed
  exception in logs, but aggregate subscription state cannot distinguish contention from other
  ordinary retryable pull failures without a later observability change.
- **Verdict:** sound. Reusing the existing outcome keeps the contract small until a real consumer
  needs to treat contention differently.
- **Confidence:** medium.

### Leaked-VM cleanup gets its own optional due-time field

- **When:** P32 leaked-VM cleanup.
- **The choice:** A failed VM teardown scheduler cannot change the workspace's `status`,
  `vmCleanupPending`, or missing `vmTeardownRunId`: those are real lifecycle facts. Instead it sets
  optional `vmCleanupRetryAt`, and the indexed sweep selects only rows whose retry time is due.
  Rows created before this field—or never failed—have no timestamp and remain immediately eligible.
- **The gap:** Unlike ephemeral expiry, this lifecycle had no existing clock whose meaning matched
  retry eligibility.
- **The reach:** The workspace schema and one compound index gain a direct prelaunch field. There is
  no migration or compatibility reader; normal optional-field ordering makes unstamped rows due.
- **Verdict:** sound. It preserves lifecycle truth while giving the scheduler one authoritative
  fairness clock.
- **Confidence:** high.

### Release and skills installation share one lock owner

- **When:** P28 filesystem locks.
- **The choice:** Gateway release installation and skills installation previously each implemented
  the same PID-only spin loop. Both now call one shared module backed by `proper-lockfile`, which
  acquires ownership with atomic directory creation and refreshes the directory timestamp while the
  action is live. The caller still owns its in-process queue and install transaction; the shared
  module owns cross-process exclusion, stale-owner recovery, timeout, and safe release.
- **The gap:** The audit found two copies but did not prescribe whether to patch each or consolidate
  the policy.
- **The reach:** Future VM-local installers should use this owner rather than invent a third lock
  dialect. The gateway now directly owns the small locking dependency; no daemon or database is
  added.
- **Verdict:** sound. Atomic acquisition closes the late-predecessor race, lease refresh protects a
  legitimately long install, and one policy owner removes drift between installers.
- **Confidence:** high.

### Backward history paging does not redefine the forward cursor

- **When:** P01/P02 session replay.
- **The choice:** `cursor=N` retains its established meaning: return events strictly after sequence
  N. A mutually exclusive `before=N` query pages toward older events, with `before=0` selecting the
  newest bounded page. Both directions return events in ascending display order. The alternative—
  reusing `cursor` for older pages—would silently break polling and staging journeys that already
  pass the last observed sequence.
- **The gap:** The audit required incremental older history but did not name the public query seam.
- **The reach:** The response remains `{ events, nextCursor? }`; callers continue the same direction
  they selected in the request. SSE independently retains `since` and `Last-Event-ID` resume.
- **Verdict:** sound. The new capability is additive and the old contract is executable in tests.
- **Confidence:** high.

### Bounded newest-page projection declares its starting sequence

- **When:** P02/P03 browser history and projection.
- **The choice:** A newest page may begin in the middle of a long session. The projector receives
  that page's first sequence as its local starting boundary instead of treating absent older rows
  as a delivery gap. Loading an older page moves the boundary backward and rebuilds from the larger
  canonical slice.
- **The gap:** The old projector assumed every transcript began at sequence one because the client
  always downloaded the complete history.
- **The reach:** Missing rows inside the loaded slice still surface as gaps; only rows explicitly
  outside the page boundary are considered intentionally unloaded.
- **Verdict:** sound. It separates pagination from corruption without concealing internal gaps.
- **Confidence:** high.

### Only append-only live frames use incremental projection

- **When:** P03 browser projection.
- **The choice:** Stable live-frame ownership applies only the newly appended suffix while the
  memoized session snapshot is unchanged. A snapshot change, canonical durable event, optimistic-
  input change, refetch, or older-page prepend rebuilds the projection from the current bounded
  slice. This keeps the token-hot path near-linear without teaching an incremental state machine to
  undo or reorder authoritative history.
- **The gap:** The audit required near-linear live work but did not define which changes were safe
  to continue incrementally.
- **The reach:** The optimized path processed 201 units for a 200-frame workload that formerly
  processed 20,301; reconciliation paths favor correctness and remain bounded by loaded pages.
- **Verdict:** sound. The optimization boundary follows data monotonicity rather than event type
  guesswork.
- **Confidence:** high.

### One authored-tree recovery search is terminal

- **When:** P05 anchor recovery.
- **The choice:** A missing path triggers one search through ordinary authored Drive entries, with
  generated/noisy roots pruned. The user selected 40,960 entries as a deliberately abnormal hard
  ceiling: positive identity evidence found before it reanchors; a traceless completed search or
  ceiling hit is conclusive absence and reaps immediately. It never restarts the same partial walk
  on every five-second sync. A unique matching marker is sufficient positive identity even when a
  copy/restore changed the inode. Restore-in-flight, a root failure, or localized read uncertainty
  produces no verdict; those conditions may recover and are not deletion evidence.
- **The gap:** The first bounded implementation stopped at 4,096 and retried from the root forever,
  turning a per-attempt bound into unbounded recurring work and delaying deletion indefinitely.
- **The reach:** The gateway report adds optional `missingIsConclusive`; the backend honors it in
  the existing reaper while retaining the three-poll fallback for older gateways. No durable table
  changes. The exact report and marker/kind identity are atomically fsynced beside the local anchor
  snapshot before transport and replayed without another walk until acknowledged. A re-minted identity
  discards stale evidence; backend replay at an already-updated ordinary or share path is a no-op.
  Async filesystem calls yield between entries, and the walker keeps one directory handle open, so
  the larger one-time search does not synchronously freeze the process.
- **Verdict:** sound, user-selected. The hard ceiling is an operational corruption/pathology guard,
  not a pagination boundary.
- **Confidence:** high.

### A completed mover search builds one marker index for all anchors

- **When:** P05 anchor recovery.
- **The choice:** An anchor marker is a small identity file inside an anchored directory. During a
  complete recovery walk, the gateway indexes each discovered marker once, then performs one map
  lookup for each missing anchor. With 2,000 entries and 20 missing anchors, work is proportional
  to roughly 2,020 operations plus returned candidates, rather than scanning all 2,000 entries 20
  separate times.
- **The gap:** The audit named the quadratic scan but did not choose the index owner or lifetime.
- **The reach:** The index exists only for one reconciliation snapshot; no cache invalidation,
  database table, or durable secondary index is introduced.
- **Verdict:** sound. It gives the required `O(entries + anchors)` behavior at the existing
  reconciliation owner.
- **Confidence:** high.

### Recovery traversal streams directories instead of materializing them

- **When:** P05 anchor recovery.
- **The choice:** The recovery walker opens one directory, reads its entries incrementally, closes
  it, and then visits discovered child directories. It never asks the filesystem for a complete
  directory array, and it never keeps an open handle for every nested level. Noisy generated trees
  remain pruned before descent. The alternative could respect an entry counter while still
  allocating an unbounded root-directory array before the counter ran.
- **The gap:** The audit required bounded work but did not specify the filesystem iteration model.
- **The reach:** Memory and open-file usage are now bounded alongside entry work; traversal order
  is not treated as evidence, because incomplete results are discarded.
- **Verdict:** sound. The implementation's resource shape matches the stated bound rather than
  merely counting after an unbounded read.
- **Confidence:** high.

### Retained replay and new live arrivals have separate budgets

- **When:** P13 session-stream backpressure.
- **The choice:** A subscriber walks the buffer's immutable retained snapshot by cursor. Only
  frames arriving after subscription enter its bounded live queue. Counting retained history
  against that queue would make a legitimate reconnect with more than 256 retained frames
  overflow before delivering its first durable cursor, creating a reconnect loop.
- **The gap:** The audit named the unbounded live queue but did not distinguish old retained frames
  from new producer pressure.
- **The reach:** Replay can make forward progress across the full bounded ring, while memory added
  by an individual stalled subscriber remains capped.
- **Verdict:** sound. It applies the overload limit to the resource the subscriber can cause to
  grow, without turning existing retained history into an artificial failure.
- **Confidence:** high.

### Tunnel overload disconnects inputs that cannot be paused

- **When:** P06 duplex tunnel backpressure.
- **The choice:** Node TCP sources pause until their WebSocket destination drains. Browser and Bun
  WebSocket message callbacks have no equivalent inbound pause, so their TCP-bound data enters one
  ordered 1 MiB queue and a full queue closes the bridge; the gateway uses retryable close code
  1013. Data and control frames share one stable per-WebSocket sender: both encoded bytes waiting
  for their turn and bytes already buffered by the socket have explicit ceilings. Pending waits are
  aborted during teardown.
- **The gap:** The audit required a bounded outcome but did not choose between dropping bytes,
  blocking callbacks, or disconnecting.
- **The reach:** Tunnel bytes are never reordered or silently dropped. Peers must reconnect after
  overload, using the existing sync protocol above the tunnel.
- **Verdict:** sound. Disconnect is the only honest bounded outcome where the source transport
  offers no pause primitive.
- **Confidence:** high.

### Relay journal records carry the local state they commit

- **When:** P07 durable relay outbox.
- **The choice:** Each fsynced journal record contains both the stable relay event and the absolute
  checkpoint, wake, command, cursor, or launch change accepted with it. Reads fold those commits
  over `session.json`. After delivery, acknowledgement writes that folded snapshot first and then
  removes the delivered journal prefix in one compaction.
- **The gap:** Replacing full-file rewrites introduced a crash boundary between the session state
  and its outbound event; the audit did not prescribe which file owned atomicity.
- **The reach:** A crash before append accepts nothing; a crash after append recovers both event and
  local state; a crash between snapshot and compaction may retry the same stable ID but loses no
  checkpoint. Existing backend idempotency absorbs that retry.
- **Verdict:** sound. One durable record remains the atomic acceptance unit without adding a
  database or cross-file transaction.
- **Confidence:** high.

### Relay overload replays the accepted turn instead of dropping an event

- **When:** P07 durable relay outbox.
- **The choice:** Capacity rejection happens before the new record is written. The coordinator
  stops the producing runner, drains the already-durable prefix, and recovers the still-in-flight
  command. The model turn may execute again; the gateway never pretends the rejected event was
  durable and never lets the runner continue beyond it.
- **The gap:** A finite queue needs an overload policy. Blocking the event callback indefinitely
  would deadlock recovery, while dropping would corrupt the session transcript.
- **The reach:** Overload has explicit at-least-once compute semantics and stable relay-event
  identity for everything that was committed before the ceiling.
- **Verdict:** sound. Repeated model work is safer and observable; silent transcript loss is not.
- **Confidence:** high.
