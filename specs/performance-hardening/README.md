# Performance hardening work ledger

Status: active

Started: 2026-08-14

Last updated: 2026-09-24

This is the durable work history for the 2026-08-14 performance audit. Finding IDs never
change. Completed work stays here with its evidence and residual risk rather than disappearing
from the queue. Decisions the audit left to implementation live in the
[choices ledger](choices.md).

Status vocabulary: `selected`, `open`, `mitigated`, `done`, or `dropped`. A mitigation reduces
exposure but does not replace the final acceptance seam.

## Invariants

- Streams begin delivering before their complete history has been read.
- Every replay, buffer, queue, poll set, traversal, retry set, and batch has an explicit work or
  byte bound and an overload outcome.
- Slow consumers apply backpressure or disconnect with a resumable cursor.
- One poison record cannot starve later scheduled work.
- UI work scales with the selected or visible entity, not every entity in a workspace.
- Indexed reads bound rows examined, not only rows returned.
- Performance tests assert observable resource bounds rather than private call structure.

## Current decisions

- The workspace agent ceiling is 50. This contains agent-count amplification but does not excuse
  per-agent fan-out.
- Drive loads every visible folder once, but only the three deepest visible folders poll. For
  `/`, `/1`, `/1/2`, `/1/2/3`, `/1/2/3/4`, only the final three refresh.
- A session surface resolves its owner from the indexed agent list, then reads only that owner's
  `agent.json`. Root and unavailable scopes read none. The selected file remains necessary because
  it owns onboarding lock state and the optional suggested first message.
- The workspace preload (`apps/web/spa/knowledge-map-data/preload-agent-pages.ts`) is a deliberate,
  bounded exception to per-agent fan-out: flying between agents is the product's ordinary gesture,
  so every agent's page reads are warmed once per workspace visit — off the critical path, a few
  owners at a time, never polling, bounded by the 50-agent ceiling. It also covers the one read a
  permanently visible surface makes per agent (the roster row's description): a fan-out that would
  otherwise fire from first paint is better paid here, batched, than on the landing's critical
  path. P12's rule still governs what a mounted page reads.
- Runner stdout has a per-record byte ceiling. The budget resets at every newline, so
  long turns with many ordinary tool events do not accumulate toward it. Reaching either runner
  output ceiling emits one structured session log without copying output contents into the log.
- Increasing memory, timeouts, or page size is not an accepted fix for unbounded work.
- Recurring work is not a defect merely because it can continue indefinitely. Polling is acceptable
  when the owning state machine has a concrete recovery path and eventually progresses or reaches a
  terminal result. Optimize bounded query counts only when production evidence or a correctness
  failure justifies the added machinery.

### Limit observability

An exceptional safety ceiling is not silent. If reaching a bound drops work, disconnects a stream,
skips corrupt state, or terminates a process, its owner emits one structured signal with the
affected identity, the bound that fired, and the recovery action. It does not copy file contents,
runner output, or tunnel payloads into diagnostics. Gateway signals go through the
[local logger](../../packages/gateway/src/gateway-logger.ts); Convex maintenance failures use the
scheduled function log; HTTP product and rate limits remain observable through their status and
response contract. Pagination sizes, polling budgets, and product-capacity validation are normal
control flow, not incidents, and must not create warning-log noise.

## Findings

### Session payload and client audit (2026-09-24)

The 1 KiB combined encoded tool-output preview in `15f11a59b` passes review:
the marker counts toward the budget, Unicode and JSON escaping remain valid,
local data is unchanged, and journal replay repairs older pending records.
An independent review passed all 50 focused serializer/ledger tests. This is
an output-field budget, not a whole-tool-event budget or a historical Convex
backfill. No customer VM was accessed for this audit.

| ID | Status | Finding | Acceptance seam |
| --- | --- | --- | --- |
| P44 | done | **Bounded relay diagnostics.** Task chunks, settlement diagnostics, and their machine-history/terminal copies use 1 KiB previews on stored and live publication paths. Complete local checkpoints remain intact. | Coordinator regression reproduces the former rejection; the live `relay-recovery` journey delivers a real 350 KiB script result and terminal without blocking. |
| P45 | done | **Byte-budgeted live replay.** History and SSE continuation share `readEventPage`, preserving numeric live cursors and opaque history cursors. | Real API regression reproduces the former database read overflow with 100 × 200 KiB events, then verifies ordered replay, cancellation and resumption. |
| P46 | done | **Bounded tool input/details.** Each diagnostic field receives an independent 1 KiB encoded-JSON allowance with a visible marker; full local execution data remains intact. | Serializer/ledger regressions and live relay input/output acceptance pass. Existing Convex rows are not rewritten. |
| P47 | done | **Incremental canonical projection.** Browser-cache append generations permit suffix processing and indexed tool replacement; changed historical ordering falls back to full replay. | Canonical/live reconciliation and event-visit tests pass, including 2,001 canonical events processed in 2,001 projection visits. Immutable array copying remains. |
| P48 | done | **Lazy native tool disclosures.** Closed tools do not mount or serialize payload bodies; opening uses current props. | Serialization-counter regressions and desktop/mobile Docker keyboard/disclosure checks pass; no baseline changes. |

Disposition: P44–P48 are implemented and verified; the
[closed rationale and evidence](../done/session-performance/README.md) records
scope and tradeoffs. The root gate passed all 23 tasks and the expanded live
`relay-recovery` journey passed with zero cleanup orphans. Existing stored
Convex events retain their original sizes; bounded replay handles them while
new publications and pending local journal replay receive the compact previews.

Falsified or bounded candidates:

- Ordinary history pages already account for read and response bytes through
  [SessionHistoryPageBudget](../../packages/backend/convex/domains/agentSessions/pageBudget.ts);
  P45 is specifically the separate SSE continuation read.
- Ephemeral token appends already have an incremental projection path; P47
  applies to durable appends, not every token.
- Relay rejection is not an infinite poison-head loop: the 60-attempt
  abandonment/reporting path restores progress, though oversized diagnostics previously triggered that delay.
- Custom MCP launch reads are capped by the 20-server workspace admission
  limit; no new cache or projection is justified by those collection reads.
- Session activity's bounded per-agent reads remain accepted under P08;
  this audit found no new production evidence to reverse that decision.
- Durable SSE backpressure, coalesced hint refreshes, explicit history paging,
  and journal compaction already have owners and regression coverage. They
  were not re-filed as unbounded mechanisms.

### Production function amplification (2026-09-12)

| ID | Status | Finding | Acceptance seam |
| --- | --- | --- | --- |
| P40 | done | API session hints trigger two continuation reads per ephemeral frame. Production showed about 15,000 calls/minute; a 50-frame regression reproduced 100 reads. This is per-stream amplification, not an unbounded history read. | Forward ephemeral frames immediately, coalesce durable refreshes, retain ordered paged replay, cancellation and fallback recovery. |
| P41 | done | An exhausted runner queue throws an ordinary error and the API matches its text, which production redacts. | Acknowledged input drains return a structured no-op; actual dispatch failures remain failures and later queued input still recovers. |
| P42 | open | Three disk resize jobs across two production workspaces each failed four times against exe.dev's extra-allocation quota. CLI plan reports default disk 25 GB, max disk 500 GB and pooled disk 100 GB; the 148-VM snapshot has 4,504 GiB allocated, or 804 GiB above a 25 GiB/VM allowance. Provider accounting remains to be confirmed. | Preserve the paid plan's immediately available capacity. Resolve the provider quota; on-demand allocation requires write-time admission and recovery, not an hourly-only usage guard. |
| P43 | open | The existing internal-admin fleet-health query caps each status bucket before excluding VM-less workspaces. A large VM-less prefix can omit later live VMs; the full API suite reproduces this after its payer census fixtures, while the health case passes alone. Production impact has not been measured. | Apply VM presence before the fleet bound and prove version/telemetry visibility with a VM-less prefix exceeding that bound. |

### Session-event liveness

| ID | Status | Finding | Acceptance seam |
| --- | --- | --- | --- |
| P01 | done | The [API SSE backfill](../../apps/api/src/routes/agent.ts) previously read every remaining page and duplicated it as serialized frames before opening the stream. | Emit after the first bounded page; cancellation stops reads; page boundaries preserve order and identity; retained rows and bytes do not scale with total history. |
| P02 | done | The [browser history client](../../apps/web/spa/api/client.ts) previously downloaded the entire history and could repeat it after SSE invalidation. | Render a bounded first page, page older history explicitly, and reconnect without invalidating all history. |
| P03 | done | [Live frame handling](../../apps/web/spa/sessions/session-data.ts) previously copied and reprojected accumulated history for every token frame. | Incremental projection produces the same transcript with near-linear total work as frames grow. |
| P13 | done | [Gateway SSE subscribers](../../packages/gateway/src/runner/session-event-buffer.ts) previously had unbounded per-client queues. | A stalled reader has a byte/event ceiling and an explicit disconnect/resume policy with no durable gaps. |
| P21 | done | [Session delivery](../../packages/backend/convex/domains/agentSessions/delivery.ts) already owns a 30-second lease, and recurring VM sync drains pending input. A crashed dispatcher or lost acknowledgement is reclaimed without another user message. | A focused outer test proves the recurring `drain` path re-leases the same durable input after expiry and clears the pending state after acknowledgement. |
| P35 | done | The session list stops title polling after 60 seconds, but the [detail query](../../apps/web/spa/sessions/session-data.ts) omitted that guard and could poll a stuck title at 1 Hz forever. | List and detail share one age/terminal policy, with a regression proving the partial fix cannot diverge again. |

### Gateway and VM bounded work

| ID | Status | Finding | Acceptance seam |
| --- | --- | --- | --- |
| P04 | mitigated | Once full, [gateway log storage](../../packages/gateway/src/capped-log-writer.ts) synchronously reread and rewrote roughly 10 MB per append. Compaction now leaves 25% headroom, making that rewrite occasional rather than continuous. | Final closure moves compaction off the request path while retained on-disk bytes and restart tail semantics remain bounded. |
| P05 | done | One missing or mismatched [anchor](../../packages/gateway/src/routes/anchors.ts) previously triggered an uncapped serial drive walk plus anchor-by-entry matching every sync; the first bounded fix could restart forever at its cutoff. | Recovery is one `O(entries + anchors)` search, prunes noisy roots, examines at most 40,960 entries, and treats completion or the abnormal hard ceiling as a terminal reanchor/reap verdict. |
| P06 | done | Both [sync tunnel](../../packages/sync-tunnel/src/index.ts) bridge directions previously omitted transport backpressure; one started an unserialized promise per chunk. | A blocked destination pauses its source, queued bytes remain capped, ordering holds, and disconnect aborts pending writes. |
| P07 | done | The durable [agent relay outbox](../../packages/gateway/src/agent-sessions/ledger.ts) previously reparsed and rewrote the full file per event and per receipt. | Append is constant-time, acknowledgement compacts in batches, crash recovery is preserved, and the outbox has an explicit event/byte ceiling. |
| P17 | done | [Share convergence](../../packages/gateway/src/sync/share-converger.ts) previously revalidated and rewrote unchanged desired state on every sync. | The process remembers only the last successful desired snapshot. An identical sync performs cheap mount, relocation-journal, and root-safety checks, then skips folder writes and Syncthing convergence. Restart, failure, recovery drift, or changed input runs the existing convergence unchanged. |
| P18 | done | [Runner stdout records and stderr](../../packages/gateway/src/runner/process-runner.ts) previously had no byte ceiling for a turn. | Oversized complete or incomplete stdout records terminate the turn; stderr retains a marked bounded tail; ordinary NDJSON parsing is unchanged. |
| P26 | done | A permanently rejected [file-event batch](../../packages/gateway/src/attribution/pipeline.ts) retried at the queue head forever while later sealed batches accumulated without a total event bound. | Retry only transport/408/429/5xx outcomes; terminal responses drop and count only their batch; pending, sealed, and current events share one 2,000-event ceiling. |
| P27 | done | Filesystem races could keep [marketplace materialization](../../packages/gateway/src/marketplace/materializer.ts) in unbounded directory, install, or conflict-preservation loops, blocking the puller's single queue. | Each operation has a fixed attempt budget, preserves its recovery journal, and returns a retryable contention error so a later pull can resume. |
| P28 | done | PID-only locks in [gateway releases](../../packages/gateway/src/gateway-release.ts) and [skills installation](../../packages/gateway/src/skills-install.ts) could wait forever after PID reuse. | One shared lock uses atomic directory ownership, refreshes its live lease, reclaims stale ownership, and stops acquisition after 30 seconds. |
| P29 | done | [Syncthing initialization](../../packages/gateway/src/runtime/http.ts) previously retried connection only; a later hardening or mount-projection failure was logged once and could leave partial state indefinitely. | Consumers start only after the complete initialization transaction succeeds, or an explicit pending state retries it with bounded backoff. |
| P30 | done | One transient discovery error previously terminated the recurring [Syncthing PID refresh](../../packages/gateway/src/attribution/helper-supervisor.ts) forever. | Catch and back off per iteration so the exclusion set resumes after transient failure. |
| P38 | done | At the 100-live-key ceiling, a VM asking for model credentials retried issuance every five seconds even though capacity could not change until the first 24-hour expiry. | Persist the earliest capacity-changing expiry; heartbeat/reconciliation continue, but credential issuance performs no key-set scan before that boundary and accelerates when it becomes due. |

### Backend amplification and fairness

| ID | Status | Finding | Acceptance seam |
| --- | --- | --- | --- |
| P08 | dropped | [Session activity](../../packages/backend/convex/domains/agentSessions/activity.ts) performs three indexed queries per agent, now bounded by the 50-agent workspace ceiling. | The resulting maximum of 153 Convex queries is accepted; do not add a projection or alternate read model without production evidence that it is a problem. |
| P09 | done | One 500-event file batch previously enqueued [one projector job per stored event](../../packages/backend/convex/domains/fileActivity/model.ts) while the projector also self-scheduled. | One batch creates at most one initial wakeup and the existing worker still drains through retries. |
| P10 | done | Permanently unbillable [model-settlement rows](../../packages/backend/convex/domains/modelGateway/settlement.ts) could occupy the fixed retry prefix forever. | Each status is read through `status + updatedAt`, candidates merge oldest-first, and every unfinished attempt moves to the tail so later healthy work remains reachable. |
| P14 | open | Root and exact [file-activity feeds](../../packages/backend/convex/domains/fileActivity/queries.ts) apply the non-read filter after index selection. | A read-heavy-tail fixture examines rows proportional to the requested non-read page through an index or equivalent projection. |
| P16 | done | Every VM sync performed an [anchor-to-agent N+1](../../packages/backend/convex/domains/anchors/model.ts), including anchors that cannot own agents. | Workspace agents load once and join by anchor ID; the agent-query count stays fixed as anchors grow. |
| P19 | open | [Signup abuse protection](../../packages/backend/convex/domains/signupAbuse/model.ts) scans the complete attacker-controlled visitor bucket per attempt. | Work stays bounded under repeated aliases while mailbox thresholds and transaction atomicity remain unchanged. |
| P20 | done | [Official marketplace lookup](../../packages/backend/convex/domains/marketplace/listings.ts) previously scanned up to 500 catalog rows and treated any verified publisher as the official source. | Bare onboarding names resolve the fixed official workspace slug, then use the exact publisher-and-agent index. Community listings never participate, regardless of catalog size. |
| P23 | open | [Fleet decommissioning](../../packages/backend/convex/domains/workspaces/provisioningActions.ts) may serially archive up to 1,000 large workspaces in one action and reselect the same permanent failures every tick. | Cursor-backed bounded batches are resumable, idempotent, and fair across ticks; one failure neither replays successes nor blocks later cohorts. |
| P25 | done | The [provisioning expiry batch](../../packages/backend/convex/domains/workspaces/provisioningCore.ts) lacked per-item failure isolation, so one deterministic failure rolled back and repeated the same prefix. | Each workspace owns its failure boundary; cleanup happens before leaving the expiry index, and a malformed row cannot roll back later healthy rows. |
| P31 | done | [Expired-user cleanup](../../packages/backend/convex/domains/users/ephemeralModel.ts) caught failures but always reselected the earliest 50, so permanent failures could starve every later identity. | A failed retirement moves its expiry/retry clock forward 15 minutes, leaving later identities eligible immediately. |
| P32 | done | [Leaked-VM teardown](../../packages/backend/convex/domains/workspaces/provisioningCore.ts) could retry the same first 100 scheduling failures per status forever. | Failed rows gain a five-minute `vmCleanupRetryAt`; the due-time index skips them while later rows remain reachable. |
| P33 | open | The [VM-size sweep](../../packages/backend/convex/domains/workspaces/vmSizeModel.ts) always examines the first 500 eligible workspaces, including successful at-floor rows that remain eligible. | A persisted cursor or next-check timestamp guarantees eventual coverage of every workspace. |
| P34 | done | A malformed folder rename into its own subtree could create a cyclic [file-activity namespace](../../packages/backend/convex/domains/fileActivity/namespace.ts); the projector then spent its budget without cursor progress and immediately self-scheduled forever. | Ingestion rejects self/descendant folder moves; projection has a durable ancestry budget, records the skipped sequence, and advances past corrupt historical work. |
| P37 | done | Deterministic failures in the fixed-prefix [stale-health sweep](../../packages/backend/convex/domains/workspaces/provisioningCore.ts) could be selected forever and eventually starve its tail. | A failed row leaves the first-attempt bucket until its retry is due; new heartbeats clear retry state, and later stale rows remain reachable. |

### Browser request budgets

| ID | Status | Finding | Acceptance seam |
| --- | --- | --- | --- |
| P11 | done | Every visible [Drive column](../../apps/web/spa/files/drive-columns-data.ts) previously owned a five-second VM poll. | Every column loads once; thereafter exactly `chain.slice(-3)` refreshes, while chains of at most three refresh all visible columns. |
| P12 | done | The [session surface](../../apps/web/spa/routes/sessions.tsx) previously fetched every agent's `agent.json` and waited for the slowest unrelated agent. | Root and unavailable owners create zero config queries; the selected agent creates one; locked onboarding and its suggested first message retain their behavior. |
| P15 | done | [File-activity infinite-query polling](../../apps/web/spa/files/attribution.tsx) previously refetched every historical page already loaded every five seconds. | The live head polls while it is the only page. Loading older pages freezes that view as a historical snapshot; closing discards it, and reopening starts from a fresh live head. |
| P22 | dropped | The default [agent map](../../apps/web/spa/knowledge-map-data/use-workspace-map.ts) loads session information per agent, including data not currently visible. | Keep the bounded reads because that information may become visible; do not optimize it away or add a projection without measured need. |
| P24 | open | [OAuth settings](../../apps/api/src/routes/users.ts) accumulates every historical grant despite backend pagination. | Return a bounded active/recent first page and expose an explicit cursor for older history. |
| P36 | dropped | A forward-progress audit found no shared stuck-state defect. App desired state is re-driven by recurring VM sync and reports a reconciled or failed result; Train owns a durable report outbox and fails interrupted jobs at gateway restart; marketplace onboarding retries pulls and turns failures into an explicit skipped state. An abandoned provider authorization may remain pending, but polling exists only while its page is observed and Connect deliberately replaces the stale attempt. | Keep the existing recovery owners. Reopen only for evidence that a particular state cannot heal or that provider polling causes material load. |

## Work history

### 2026-08-14 — audit recorded

- Independent backend/API, gateway/VM, and web passes recorded the initial 25 findings above.
- Dismissed bounded paths included retained VM telemetry, cursor-paged fleet sampling, budgeted
  marketplace sweeps, cleanup continuations, provider/toolkit finite sets, abortable live-file
  polling, deadline-bound session waits, and capped provider connection attempts.
- Selected P08 containment, P11, and P12 as the first low-risk pass.

### 2026-08-14 — low-hanging bounds implemented

- P08 containment: `MAX_AGENTS_PER_WORKSPACE` changed from 500 to 50 at the shared contract so
  registration, replication, marketplace installation, VM payloads, and integrations inherit one
  source of truth. P08 remains open architecturally and is therefore only `mitigated`.
- P11: Drive refresh ownership became the deepest-three suffix of the visible chain rather than a
  root special case.
- P12: session ownership resolves from the roster before requesting config; only the selected
  agent's authored config is read. Removing that final read was rejected because it would discard
  onboarding lock and suggested-message semantics or require a new replicated schema.
- Verification: web changed-import tests 37/37; contract changed-import tests 166/166; focused
  backend registration, share-replication, and marketplace cap tests 3/3; web, contract, and
  backend type checks green; `git diff --check` green.
- Commit `40d8d573b` (`perf: bound workspace polling and agent fanout`) was pushed to
  `origin/staging`; production evidence is pending.

### 2026-08-14 — scheduler, topology, and logging bounds implemented

- P09: file-event recording schedules the scope projector once after a batch when at least one
  canonical event was inserted. Read dedupe and policy-suppressed mirror reads retain their prior
  no-wakeup behavior; the projector still owns its continuation chain.
- P16: VM topology loads the bounded workspace agent roster once, indexes it by anchor ID, and
  joins active/broken anchors in memory. App-only anchors no longer pay an agent query.
- P04 mitigation: overflow compacts the gateway log to 75% of its ceiling. The newest tail is
  retained and subsequent requests append into headroom; the remaining occasional synchronous
  compaction stays tracked as the final P04 work.
- P22 was deliberately left unchanged. Nested-agent default-chat data may become visible on the
  map later, so removing those reads now would optimize away information before that UI decision.
- Verification: backend file-activity 35/35, anchors 27/27, and focused VM-sync 1/1; gateway
  changed-import tests 179/179; backend and gateway type checks and lint green (two unrelated
  pre-existing gateway test warnings); `git diff --check` green.
- Delivery: this work-history entry ships with the implementation on `origin/staging`; production
  evidence is pending.

### 2026-08-14 — anchor recovery bounded

- P05: healthy anchors retain direct probes. A missing anchor now triggers a streaming, noisy-tree-
  pruned search with a fixed entry ceiling and one per-walk marker index. Exhausting the ceiling
  emits a typed diagnostic and advances no missing-folder evidence; a later complete walk resumes
  from the prior snapshot.
- Verification: focused anchor recovery 6/6; gateway changed-import tests 182/182; gateway type
  check and lint green (two unrelated pre-existing test warnings); `git diff --check` green.
- Delivery: commit `25978aec5` is included in the performance-hardening integration on
  `origin/staging`; production evidence is pending.

### 2026-08-14 — anchor recovery made terminal

- P05 follow-up: the former 4,096-entry cutoff could repeat the same partial walk forever. The
  authored-tree ceiling is now 40,960, generated/noisy subtrees remain pruned, and one readable
  mover search carries a conclusive verdict. A found identity reanchors; a traceless completed
  search or abnormal ceiling hit reaps in the same backend transition. Restore-in-flight and an
  unreadable drive remain non-conclusive because no valid search occurred. A unique marker remains
  positive identity even if a restore changed its inode. Failed report delivery atomically persists
  and replays the exact verdict without walking again; replays are backend-idempotent.
- Compatibility: `missingIsConclusive` is an optional gateway-to-API/backend report field. Older
  gateways retain the three-poll fallback during rollout; updated gateways terminate after one
  search. No database row or public browser schema changed.
- Follow-up audit: P26–P37 record every newly confirmed same-class failure where a bounded prefix,
  retry, or transitional poll lacks forward progress or terminal escalation. P10, P21, P23, and
  P25 were expanded where the new evidence overlapped an existing owner.
- Verification: gateway anchor-focused tests include report replay and stale-identity discard;
  backend rename and share transition policy 27/27; full Convex conclusive-reap outer seam 1/1;
  gateway changed-import sweep 184/184; gateway/backend/API/contract type checks and gateway lint
  green (one pre-existing lint warning).

### 2026-08-14 — transport and relay queues bounded

- P06: both tunnel directions now serialize writes behind the destination's drain signal. A
  blocked browser or Bun WebSocket uses the platform's bounded buffer; input that cannot be paused
  closes the bridge with a retryable overload outcome instead of retaining bytes indefinitely.
- P13: retained session replay is a lazy snapshot, while only new live arrivals consume the
  per-subscriber 256-event/1 MiB queue. Overflow detaches the producer after accepted frames drain;
  the existing durable SSE ID resumes the missing canonical rows.
- P07: relay events append once to a fsynced NDJSON journal. Acknowledgements materialize the
  folded session snapshot and compact a delivered prefix once per batch. The journal stops at
  the largest journal the loader can still read — a drive guard, not a backpressure knob; overload stops the runner,
  drains durable work, and recovers the accepted turn rather than silently discarding output.
- Compatibility: no database schema, endpoint payload, or SSE frame-format migration. This
  prelaunch codebase supports only the journal-backed relay format; no legacy embedded-outbox
  migration remains.
- Verification: final focused gateway anchor/queue/relay/tunnel tests 62/62; sync-tunnel 16/16;
  gateway and sync-tunnel type checks and lint green (one unrelated existing gateway test warning).
  Review regressions additionally pin immediate subscriber detachment, complete and concurrent
  WebSocket byte reservations, one-fold relay append, empty-cache eviction, and overload ordering.
- Delivery: the focused implementation and review-fix commits are included in the performance-
  hardening integration on `origin/staging`; production evidence is pending.

### 2026-08-14 — session replay and projection bounded

- P01: the API retains one 100-row durable backfill page and emits one frame per downstream pull.
  It does not fetch the next page until demand consumes the current one; cancellation prevents any
  further query or live attachment. SSE `since` and durable numeric IDs are unchanged.
- P02: the existing `cursor=N` history query remains strictly forward (`seq > N`). A separate,
  mutually exclusive `before=N` query owns backward paging; `before=0` returns the newest bounded
  page in ascending display order. The browser explicitly loads older pages and preserves them
  across head refreshes instead of redownloading the complete transcript.
- P03: append-only live frames keep stable ownership and apply only their new suffix. Durable,
  optimistic, or older-page reconciliation takes the correctness-first full rebuild path. The
  operation tracer reduced a 200-frame workload from 20,301 processed frames to 201.
- Compatibility: no persisted database schema or SSE frame change. The history query contract adds
  optional `before`; internal Convex reads add mutually exclusive `beforeSeq`.
- Verification: focused API integration 2/2; backfill demand/cancel 2/2; contract 19/19; web
  client/cache/projection 100/100; API, web, backend, and contract type/lint gates green. Docker
  visual approval 86/86 and the visual owner union passed; a fresh critique accepted the desktop
  and mobile paging control.
- Evidence: durable desktop/mobile baselines are registered as `sessions-detail-paged-history`.
  Existing mobile transcript edge clipping predates this control; the paging action itself remains
  contained and usable.
- Closeout: the branch-wide changed-import sweep reached the API session suite before its local
  Convex process exited, producing cascading connection refusals. The first timed-out case passed
  immediately in isolation; all affected focused gates above are green.
- Delivery: the focused implementation and review-fix commits are included in the performance-
  hardening integration on `origin/staging`; production evidence is pending.

### 2026-08-14 — poison queues and zero-progress loops closed

- P26: file-event delivery now distinguishes retryable transport/408/429/5xx failures from
  terminal responses. A terminal batch is counted as overflow and removed; all pending, sealed,
  and current events share one 2,000-event memory ceiling.
- P34: folder moves into themselves or descendants are rejected before namespace writes. The
  projector also carries a durable 129-step ancestry allowance, detects immediate cycles, records
  `lastSkippedSeq`, and advances rather than scheduling the same corrupt event forever.
- P10: settlement candidates use the `status + updatedAt` index, merge all statuses oldest-first,
  and move every unfinished attempt to the tail. This is direct schema, with no migration layer.
- P25: provisioning expiry catches each workspace independently and performs teardown/session
  cleanup before removing a successful row from the expiry index. One malformed row no longer
  rolls back healthy rows processed in the same mutation.
- Relay cleanup: `session.json` parsing strips unknown top-level properties generically. Durable
  relay events have one owner, `relay-outbox.ndjson`; no embedded-outbox migration or special-case
  parser remains.

### 2026-08-14 — filesystem contention and cleanup prefixes bounded

- P27: marketplace directory replacement, file installation, conflict stabilization, and conflict-
  name search now have explicit attempt ceilings. Contention leaves the journal intact; a later pull
  resumes the same transaction instead of wedging the subscription queue.
- P28: gateway releases and skills installation share one atomic directory lock. A live owner
  refreshes the lease until its action ends; hour-old abandoned ownership is reclaimed and
  acquisition stops after 30 seconds.
- P31: failed ephemeral retirement moves its existing expiry/retry clock forward 15 minutes, so the
  next 50-row sweep can reach later identities without adding a second lifecycle field.
- P32: leaked-VM cleanup uses one optional `vmCleanupRetryAt` field and a due-time index. Scheduling
  failure defers only that workspace for five minutes; successful and unrelated rows keep moving.
- Schema: `workspaces.vmCleanupRetryAt?: number` and
  `by_status_vmCleanupPending_vmTeardownRunId_retryAt` are direct prelaunch schema changes. No data
  migration or compatibility path exists.

### 2026-08-14 — session title polling converged

- P35: session lists and details now use the same title-status and age decision before polling.
  A stuck generated title ages out on either surface instead of making an open detail view poll at
  1 Hz forever. Delivery-attempt polling remains separate because its lease recovery is P21.

### 2026-08-14 — Syncthing initialization and PID refresh made live

- P29: connection, configuration hardening, and projection from the authoritative mount store are
  one initialization lifecycle. Any failed phase retries the lifecycle with capped backoff;
  disk-event translation, scan nudging, and read-mode enforcement remain stopped until every phase
  succeeds.
- P30: each Syncthing PID discovery attempt owns its failure boundary. A transient discovery error
  retains the last known exclusion, logs, waits for the normal refresh interval, and tries again.
  A confirmed inactive `MainPID` still clears the exclusion.
- Compatibility: no schema, stored state, API, or wire format changed. Retry state is process-local
  and gateway restart begins a fresh initialization lifecycle.
- Verification: the focused initialization and helper-supervisor tests are 18/18, the gateway
  changed-import sweep is 234/234, and gateway type checking is green. Gateway lint retains one
  unrelated existing warning in `coordinator.tier-switch.test.ts`.

### 2026-08-14 — stale-health sweep made fair

- P37: a stale workspace whose unhealthy transition fails now receives its own retry eligibility.
  Rows with no prior failure are processed first, so a deterministic poison prefix moves aside and
  later stale workspaces remain reachable. A persisted VM heartbeat clears the operational retry
  state before the workspace can be reconsidered.
- Schema: `workspaces.healthSweepRetryAt?: number` and the compound health-sweep index are direct
  prelaunch changes. Existing rows are first-attempt candidates; there is no migration or
  compatibility path.
- Verification: the outer provisioning test saturates the real 1,000-row batch, observes the old
  starvation failure, and proves both tail progress and heartbeat recovery.

### 2026-08-14 — runner diagnostic output bounded

- P18: a runner that emits an oversized complete or incomplete NDJSON record is terminated;
  discarding part of an incomplete JSON record cannot safely recover framing.
  Its existing durable turn state remains the retry boundary.
- Runner stderr retains only its newest bounded tail and marks when older diagnostics were removed,
  so failure messages remain useful without growing for the lifetime of a turn.
- The local `gateway.log` records `runner_output_limit_reached` under `agent-sessions` once,
  including the session, stream, byte ceiling, and whether the turn ended or older diagnostics were
  truncated; it never includes the runner output itself.
- Verification: behavioral tests cover oversized complete and delimiter-free stdout records plus
  sustained stderr; the process-runner suite preserves ordinary command-receipt NDJSON parsing.

### 2026-08-14 — exceptional limit telemetry completed

- Relay-outbox saturation, stalled session subscribers, both tunnel bridge directions, and
  file-event queue saturation now reach the gateway's structured local log at the point where the
  owner drops, disconnects, or terminates work.
- A corrupt file-activity ancestry cycle or over-deep chain records its skipped sequence in state
  and emits a metadata-only Convex error before projection advances.
- Existing anchor-search, materializer-contention, lock-timeout, Syncthing-retry, and maintenance-
  sweep signals were retained. Normal pages, API rate limits, the agent product ceiling, and UI
  polling budgets continue to use their existing response or visible-state contract.

### 2026-08-14 — recurring reads narrowed without new state machines

- P21 required no second recovery mechanism: the existing delivery lease and recurring VM drain
  already reclaim abandoned input without a new message. The missing regression now proves that
  exact production path.
- P17 caches only an exact, successfully applied desired-share snapshot in process memory. Every
  reuse still verifies mount records, the relocation journal, and root safety; failures, restarts,
  recovery drift, or changed input run ordinary convergence.
- P15 uses React Query's dynamic interval: a one-page live view polls, while explicitly paging into
  history turns the open view into a stable snapshot. Unmounting discards it so reopening is fresh.
- P20 resolves onboarding and campaign names through the fixed official-workspace identity and the
  existing publisher-and-agent index. No listing scan, new table, field, or migration was added.

### 2026-08-15 — transitional-state polling falsified

- P36 did not survive its owner audit. App reconciliation, Train, and marketplace onboarding each
  already have a retry or terminal path independent of browser polling. Provider authorization is
  user-driven; a stale attempt is replaceable and its query is scoped to the observed page. No new
  timeout, cron, lease, or state-machine field was justified.

### 2026-08-28 — credential-cap retries gained a progress boundary

- P38: 100 ambiguous lost refresh responses can fill the live VM-model-key set in about eight
  minutes. The old five-second retry then performed roughly 17,000 no-progress issuance checks
  before the first 24-hour expiry.
- The workspace now stores that earliest expiry. Ordinary syncs retain heartbeat and reconciliation
  recovery on the bounded idle cadence while skipping the key-set scan; the poll shortens when the
  stored boundary is less than one idle interval away. Successful issuance, revocation, rotation,
  reprovisioning, or a changed expected scope set clears or invalidates the boundary.
- Verification: the backend VM-sync file is 36/36, including cap, repeated pre-boundary heartbeat,
  exact expiry recovery, quiescence, and concurrency. API poll policy is 15/15 and proves both the
  idle heartbeat cadence and the shortened final wait. The durable rationale is recorded with the
  shipped [specific-people session rationale](../done/specific-people-sessions/README.md).

### 2026-09-11 — critical accounting contention (P39, deployed to production)

Production Insights reported seven critical entries over 72 hours: 200 exhausted
credential-counter calls and 52 billing/workspace conflicts. The API already fails
open on exhausted credential ticks; that limits customer impact but drops counter
updates. Service debit failures had no durable retry owner after the callback.

The bounded concurrency reproduction lost four of 64 credential calls and fourteen
of 32 direct service charges. Wider credential counters now preserve the deployment
window's existing spend. Workspace spending is separate from configuration, and
accepted model/service charges enter one bounded Batch Worker lane per billing
account. Same-account concurrency, exact debit totals, duplicate delivery, stopped
worker recovery, and preflight/session/file activity have passed local checks.
Failure isolation has a falsified rollback regression. Staging also exposed a
model-preflight timestamp writer that now shares the ordinary credential throttle.
The live journey then passed all seven paths with exact money and clean teardown,
and the spending backfill completed. The final revision also passed the staging
journey before production promotion; production deployment and its 823-workspace
spending migration are verified. See the
[contention rollout](../done/convex-critical-contention/README.md).

## Next pickup

### 2026-09-12 — production session-function amplification

P40 now coalesces hint-triggered durable refreshes while forwarding token deltas
within their durable block. The 50-frame regression went from 100 continuation
reads to at most two before completion. Durable hint boundaries and hints
arriving during a fallback query both have red/green ordering regressions;
ordinary backfill, cancellation and fallback recovery remain covered.

P41 uses the existing `alreadyDelivered` response for an empty drain. No schema
or public request shape changed. The backend regression also submits another
message after the no-op and proves delivery still progresses.

P42 remains an external quota investigation. Example User's VM is confirmed in the
reserved `pool-duet`; its assignment is not missing. Usage-based deferral was
not retained: hourly-only growth can reduce the storage available to a paying
user and cannot guarantee recovery when provider samples stop advancing.
Full plan capacity remains the contract pending provider clarification or a
complete design for growth on the write path.

Verification: 22 focused API tests, five public SSE/recovery integration cases,
the backend empty-drain/recovery regression, type checks and scoped lint passed.
The final independent review found no remaining production-code defects.
One repository-wide run completed with 21 of 23 test tasks successful. Backend
hit a local Convex `IsolateNotClean` error in the unchanged credential-burst test;
that exact case passed on a fresh fixture with 195 assertions. API hit a
redundant 1 ms timer/count assertion, which was removed in favor of the burst
and ordering coverage; the focused suite passed afterward. API also exposed the
unchanged fleet-health prefix issue recorded as P43; that case passed alone
with nine assertions, while the full suite's earlier VM-less fixtures explain
the failure. The full gate was
not repeated and is not claimed green. Deployment and live reduction in call
volume remain unverified.

The selected high-priority no-progress and unbounded-memory pass is complete. Remaining work should
prioritize failure-starved fleet work (P23) and the attacker-controlled signup scan (P19). P08,
P22, and P36 are accepted or recoverable work. P04, P14, P24, and P33 remain recorded but should
not gain machinery without production evidence or a concrete correctness failure.

For every completed item, append the decision, commit, focused tests, staging/production evidence,
residual risk, and follow-up IDs here. Split an item into `slices/` only when its implementation
reveals more than one independently verifiable contract.
