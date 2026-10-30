Plan marker: `draft-b-tier-storage`

This is a read-only plan. No files were changed.

# 1) Recon facts

## Binding product facts

- `MAP.md` fixes the advertised/usable capacities at 20/50/100 GB and provider disks at 28/58/108 GB. Trial/free uses Starter, upgrades resize the same VM and restart it, while downgrades never shrink it (`specs/per-tier-storage/MAP.md:11-18`, `specs/per-tier-storage/MAP.md:65-78`).
- The resize research observed grow-only behavior, an accepted resize in roughly 650 ms, data preservation, and a reboot requirement before the guest sees the larger filesystem (`specs/per-tier-storage/research/disk-resize.md:3-7`, `specs/per-tier-storage/research/disk-resize.md:46-61`, `specs/per-tier-storage/research/disk-resize.md:83-109`).
- Equal and smaller resize requests are rejected, so idempotency cannot be implemented by blindly replaying `resize(target)` (`specs/per-tier-storage/research/disk-resize.md:111-127`).
- Exe storage is consumption-billed. Capacity itself is not the billable quantity, but the existing image and allocated drive bytes are (`specs/per-tier-storage/research/disk-billing.md:3-7`, `specs/per-tier-storage/research/disk-billing.md:30-76`).
- D5 requires three distinct day-seven dispositions: never-subscribed trial teardown without archive; subscriber archive at or below 1 GB; oversized subscriber teardown without archive (`specs/per-tier-storage/MAP.md:69`).
- The meter, 90% nudge, and red hard-stop presentation are locked; the plan-card, warning, and hard-stop examples are in the supplied HTML (`specs/per-tier-storage/assets/storage-ui-directions.html:43-79`).

## Existing ownership and missing seams

- The plan catalog owns plan IDs, prices, and monthly credits, but no storage facts. Max is currently $200 and must remain so (`packages/contract/src/plans/index.ts:3-24`).
- VM resource policy separately hard-codes `disk: '10GB'` (`packages/contract/src/resources/index.ts:1-5`). This is the stale capacity owner that the tier catalog must replace.
- VM creation passes that flat cap into Exe through `workspaceVmCreateOptions` (`packages/backend/convex/domains/workspaces/vmAttach.ts:115-128`, `packages/backend/convex/domains/workspaces/vmAttach.ts:157-175`).
- The workspace schema contains VM identity, URL, and token state but no realized capacity or drive-byte projection (`packages/backend/convex/schema.ts:193-253`).
- Attach recording likewise has no disk-capacity field (`packages/backend/convex/domains/workspaces/vmAttachModel.ts:29-40`, `packages/backend/convex/domains/workspaces/vmAttachModel.ts:96-135`).
- Exe already exposes lobby capacity as optional `disk_capacity_bytes`, plus `resize`, `restart`, `list`, and `setSharePublic` (`packages/exe/src/exe.ts:35-47`, `packages/exe/src/exe.ts:202-210`, `packages/exe/src/exe.ts:284-320`).
- The production backend adapter and fake currently expose only create/list/remove/set-public; they do not make resize/restart available to workspace actions (`packages/backend/convex/domains/workspaces/vmExe.ts:7-24`, `packages/backend/convex/domains/workspaces/vmExe.ts:26-67`).
- Lobby “running” is not proof that the guest or gateway is ready after restart (`packages/exe/src/exe.ts:329-350`, `packages/exe/README.md:72-77`).

## Subscription and reconciliation doors

- Subscription lifecycle projection writes the user projection and then calls `reconcileServicingStatus` (`packages/backend/convex/domains/credits/subscriptions.ts:266-317`).
- Paid-invoice projection—including renewals—writes the subscription projection and then calls the same servicing owner (`packages/backend/convex/domains/credits/subscriptions.ts:319-418`). This is D8’s natural monthly retry door.
- Billing-user reassignment also reconciles servicing for both the old and new payer (`packages/backend/convex/domains/workspaces/mutations.ts:238-245`). Disk targets must be reconsidered there as well.
- A paid user can create another workspace without receiving a new Stripe projection. Therefore, paid workspaces must still be born at 28 GB and request post-attach disk reconciliation. This is an inference from D2 plus the attach and projection lifecycles.
- The local fake-Stripe plan action does not write any subscription projection; it only returns Stripe-shaped objects (`packages/backend/convex/domains/credits/billingActions.ts:191-305`, `packages/backend/convex/domains/credits/billingActions.ts:307-355`). An API test confirms that posting a fake upgrade can leave the overview on Starter (`apps/api/src/index.test.ts:7779-7798`).
- Deployed staging is not fake Stripe: the harness requires an `sk_test_` key and the upgrade leg waits for the real projected Pro subscription/invoice (`packages/test-harness/src/staging-e2e-synthetic:145-165`, `packages/test-harness/src/staging-e2e-synthetic:479-496`).

**Inference:** the requested “staging fake-Stripe plan-change path” does not currently exist as described. The safe interpretation is:

1. Prove production projection reachability with the existing real Stripe staging leg.
2. Add a test-only captured-event/synthetic-projection adapter for local fake-Stripe coverage.
3. Do not add a second production subscription writer merely to make the fake action project state.

## Restart, proxy, share, and turn recovery

- Attach reasserts public proxy state when recovering an incompletely recorded deterministic VM, and calls `setSharePublic` for a newly created VM (`packages/backend/convex/domains/workspaces/vmAttach.ts:72-96`, `packages/backend/convex/domains/workspaces/vmAttach.ts:129-150`).
- The staging continuity journey already reboots a real VM and observes the restarted gateway before waking the session (`packages/test-harness/src/staging-e2e-synthetic:183-225`).
- That journey currently reboots a sleeping session, not an active turn (`packages/test-harness/src/staging-e2e-synthetic:154-185`).
- Local fix73 coverage proves spawn failure/dead-runner lock release and controller-recreation continuity (`packages/gateway/src/runner/process-runner.test.ts:164-244`, `packages/gateway/src/runner/process-runner.test.ts:1640-1868`).
- Gateway boot also sweeps orphan runners before normal operation (`packages/gateway/src/runner/orphan-sweep.ts:13-47`, `packages/gateway/src/runtime/http.ts:128-145`).
- Share restart probing presently exercises a gateway-service kill, not a complete VM reboot (`packages/exe/scripts/probe-rail-share-sync.ts:898-954`).

**Inference:** existing evidence is encouraging but does not close the binding risk. The implementation needs a real active-turn VM restart followed by an accepted prompt with no persistent `turn_already_running`, plus explicit public-edge and share reconvergence assertions.

## Measurement and reserve enforcement

- Existing disk telemetry calls `statvfs` on the drive mount and computes whole-filesystem usage. Because `/duet/drive` lives on the root filesystem, this includes the OS image and cannot power D11’s drive-only meter (`packages/gateway/src/vm/telemetry-sampler.ts:72-100`).
- Telemetry is sampled during every sync poll, while backend persistence is throttled to roughly five minutes (`packages/gateway/src/vm/sync-client.ts:131-149`, `packages/gateway/src/runtime/http.ts:473-477`, `packages/backend/convex/domains/workspaces/vmTelemetry.ts:10-42`).
- Therefore a recursive `du` must not run synchronously on every VM sync. It needs a bounded, single-flight, last-good cache. This is an inference from the existing polling path.
- The VM telemetry contract is additive and optional today, and Convex validates it again before persistence (`packages/contract/src/vm/index.ts:11-20`, `packages/contract/src/vm/index.ts:65-93`, `packages/backend/convex/domains/workspaces/vmSync.ts:73-89`).
- File growth enters through PUT and the `/actions` operations, including mkdir, symlink, move, copy, and delete (`packages/gateway/src/routes/files.ts:105-177`, `packages/gateway/src/routes/files.ts:498-668`).
- Agent launch is centralized in the session coordinator, giving reserve checks one launch seam (`packages/gateway/src/agent-sessions/coordinator.ts:283-421`).
- The agent event contract already has system events with `level: 'error'`, and the web projection retains them (`packages/contract/src/agent/index.ts:335-391`, `apps/web/spa/sessions/projection/index.ts:314-322`).

## Billing and presentation

- Billing overview already projects payer-owned workspaces, but only `{id, slug, name}` (`packages/contract/src/billing/index.ts:58-62`, `packages/contract/src/billing/index.ts:93-117`, `packages/backend/convex/domains/credits/userBilling.ts:40-101`).
- The SPA root polls billing overview and knows the active workspace slug (`apps/web/spa/root.tsx:120-141`, `apps/web/spa/root.tsx:178-203`).
- The billing plan card already owns the monthly-credit display (`apps/web/spa/routes/user-settings.tsx:219-369`).
- Billing mutations currently select the first payer workspace, so storage presentation must explicitly handle multiple payer workspaces instead of silently aggregating them (`apps/web/spa/routes/user-settings.tsx:125-197`).
- The low-credit warning is the existing dismissible billing CTA pattern (`apps/web/spa/entitlements/low-credit-warning.tsx:10-35`).
- Toasts currently support success and warning, but no error tone (`apps/web/spa/shell/toast.tsx:14-18`, `apps/web/spa/shell/toast.tsx:56-89`).
- Existing English wall copy repeatedly promises that everything is saved, which conflicts with D5/D6 (`apps/web/messages/en/app.json:17-45`).

## Archive path

- The retirement sweep currently calls archive before marking every servicing-paused workspace archived; failures leave the candidate eligible for later retry (`packages/backend/convex/domains/workspaces/provisioningActions.ts:107-192`).
- The backend only discovers `archive_too_large` after receiving the archive response (`packages/backend/convex/domains/workspaces/provisioningActions.ts:284-343`).
- Gateway archiving currently writes a tar, reads the complete tar into memory, and the HTTP route buffers it again (`packages/gateway/src/vm/archive.ts:59-103`, `packages/gateway/src/runtime/http.ts:551-570`).

This cannot safely scale to 100 GB disks. D5 needs capped streaming or bounded generation in the gateway, not merely a backend `Content-Length` check.

# 2) Slice ladder

Dependency graph:

```text
00-provider-control
  └─> 01-reboot-continuity

02-du-cost
03-projection-reachability

00 + 03 ─> 04-tier-contract-and-birth ─> 05-grow-reconciler
02 + 04 ─> 06-drive-telemetry ─> 07-reserve-enforcement
04 ──────────────────────────> 08-decommission-branching
06 + 07 ─────────────────────> 09-locked-storage-ui
05 + 07 + 08 + 09 ───────────> 10-staging-cutover
```

The scariest assumption is proven first in `00-provider-control`: if the exact deployed staging credential cannot resize and restart, D3 cannot ship without an infrastructure/token-scope change.

## 00-provider-control

**Contract unlocked**

The exact staging `EXE_TOKEN` can:

- List a disposable tagged VM and report `disk_capacity_bytes`.
- Resize it strictly upward.
- Restart it.
- Read it again with the same VM identity and new capacity.
- Clean up all created resources.

The repository currently documents token expectations for `new/ls/restart/rm`, but not resize (`packages/exe/README.md:36-46`).

**API seam and ownership**

- Owner: `packages/exe`.
- Surface: a dedicated staging probe using `ExeClient.list()`, `resize()`, `restart()`, and cleanup.
- Input: exact staging environment and a unique run tag.
- Output: secret-free structured evidence containing VM name, old/new byte capacity, command status, timestamps, and cleanup result.
- No production package imports the probe.

**Runnable artifact**

`probe:per-tier-storage-control` creates a disposable 28 GB VM, writes a marker checksum, grows by a small amount, restarts, verifies the capacity/checksum, and removes the VM.

**Verification**

- Nonzero exit on 401/403, missing capacity, resize failure, restart failure, checksum loss, or incomplete cleanup.
- Capture request IDs/statuses without token material.
- Rerun once to rule out a one-off provider incident.
- Kill criterion: any command-scope failure stops the ladder before product implementation.

**Delegated freedoms**

- Run-tag format, transcript serialization, retry/backoff, and disposable marker path.
- Not delegated: exact staging credential, grow/restart/list coverage, explicit cleanup, or failure criteria.

**Dependencies**

None. It must run before D7’s staging wipe.

## 01-reboot-continuity

**Contract unlocked**

A storage-driven full VM reboot preserves:

- Same VM and `https_url`.
- Marker bytes.
- Public app/proxy reachability.
- Share realization and post-reboot byte flow.
- Session history.
- Ability to accept a new turn after an active turn is interrupted by reboot, with no persistent `turn_already_running`.

**API seam and ownership**

- Owner: staging harness, extending `agent-continuity` and the share journey.
- Restart seam: existing internal-admin restart rail/`ExeClient.restart()`.
- Recovery seam: gateway orphan sweep and durable input/session ledger.
- Share/proxy owners remain unchanged; the test observes them rather than introducing a new share abstraction.

**Runnable/reviewable artifact**

A transcript records pre/post gateway instance, URL equality, edge health response, share status on both sides, marker checksum, session events, and the first accepted post-reboot prompt.

**Verification**

- Extend `packages/test-harness/src/staging-e2e-synthetic` to restart while a deliberately long turn is active, then prove a new prompt settles successfully.
- Keep `packages/gateway/src/runner/process-runner.test.ts` fix73 cases green, especially spawn failure, dead-runner release, accepted-command replay, and controller recreation.
- Add a complete VM reboot to the share-sync probe; the existing service-only kill remains a cheaper regression test.
- Assert the same public URL before/after instead of relying on authenticated gateway traffic as an indirect proxy proof.

**Delegated freedoms**

- Long-turn prompt text, health endpoint path, evidence formatting, and bounded polling intervals.
- Not delegated: active-turn timing, same-URL proof, post-reboot prompt acceptance, or share byte reconvergence.

**Dependencies**

`00-provider-control`.

## 02-du-cost

**Contract unlocked**

A measured drive-only usage mechanism is acceptable on empty, large-capacity, allocated-byte, sparse-file, and high-inode Duet drives without delaying the five-second VM sync loop.

**API seam and ownership**

- Owner: `packages/exe` probe for measurement; later implementation owner will be gateway.
- Candidate command: an allocated-byte, one-filesystem `du` over `DRIVE_ROOT_PATH`, whose current owner is `packages/contract/src/drive/index.ts:1`.
- The probe reports cold/warm latency, inode count, allocated bytes, sparse apparent bytes, CPU time, timeout behavior, and cleanup.

**Runnable artifact**

`probe:drive-du-cost` runs against representative 28/58/108 GB-capacity VMs. It need not physically fill 100 GB; fixtures must independently vary allocated bytes and inode count.

**Verification and verdict**

- Measure p50/p95 for empty drive, large files, sparse files, and a high-inode tree.
- Verify the chosen command excludes the root image and returns approximately zero for an empty drive.
- Initial implementation policy is single-flight, stale-while-refresh, last-good cache with no synchronous refresh in VM sync.
- Starting cadence: five minutes, matching backend telemetry retention.
- If representative p95 exceeds the agreed background budget or creates material IO interference, reslice the sampler before implementing the wire field; do not move `du` onto the sync request.

**Delegated freedoms**

- Fixture sizes/counts, benchmark reporting format, timeout, and final refresh cadence based on measurements.
- Not delegated: drive-only semantics, allocated-byte semantics, background execution, or last-good behavior.

**Dependencies**

None.

## 03-projection-reachability

**Contract unlocked**

Both production projection doors are demonstrably capable of invoking one test-observable post-projection effect, while local fake-Stripe testing reaches the same canonical projection code without becoming a second production writer.

**API seam and ownership**

- Production owners remain `applySubscriptionLifecycleWithDb` and `applyPaidSubscriptionInvoiceWithDb` in `subscriptions.ts`.
- Introduce a narrow post-projection composition seam, provisionally:

```ts
reconcileSubscriptionWorkspaceEffects(ctx, userId, now): Promise<void>
```

It calls existing `reconcileServicingStatus` and, after slice 05, disk scheduling.

- Local fake coverage uses a test-only captured lifecycle/invoice adapter under test authentication.
- `billingActions.ts` remains a Stripe command adapter and does not directly patch the subscription projection.

**Runnable/reviewable artifact**

A projection trace fixture shows:

```text
plan request
→ Stripe-shaped update
→ captured lifecycle/invoice event
→ canonical projection write
→ post-projection effect observer
```

The real staging trace shows:

```text
subscription-07 plan request
→ real Stripe test invoice/webhook
→ Pro projection
→ post-projection effect observer
```

**Verification**

- `packages/backend/src/billing.test.ts`: lifecycle and paid-invoice projections each invoke the observer; replay is idempotent.
- `apps/api/src/index.test.ts`: fake action alone remains non-projecting; captured event then projects Pro.
- `packages/test-harness/src/staging-e2e-synthetic`: `subscription-07-upgrade-and-portal` proves the deployed production hook.
- Kill criterion: if the local test requires a second projection writer, replace it with signed/captured webhook delivery.

**Delegated freedoms**

- Captured event IDs and observer injection shape.
- Not delegated: production projection ownership, one monthly grant door, or fake-action non-ownership.

**Dependencies**

None.

## 04-tier-contract-and-birth

**Contract unlocked**

- Starter/Pro/Max advertise 20/50/100 GB usable.
- Their desired provider disks are 28/58/108 GB.
- Free/trial resolves to Starter.
- Every VM is born at 28 GB.
- A paid workspace requests post-attach growth rather than being created large.
- Max remains $200.

**API seam and ownership**

- `packages/contract/src/plans/index.ts` becomes the only tier storage catalog, adding typed `usableStorageGb` and `rawVmDiskGb`.
- `WORKSPACE_VM_CAPS` retains CPU/memory only; its flat disk owner is removed.
- `workspaceVmCreateOptions()` always emits `disk: '28GB'`.
- Workspace durable state gains:
  - `vmDiskGb?: number`: last successfully completed create or grow/restart capacity.
  - `vmDiskTargetGb?: number`: monotonic target requested by reconciliation.
- Attach recording accepts provider-reported capacity, verifies it is the expected 28 GB birth, then schedules post-attach reconciliation.
- Teardown clears both capacity fields beside existing VM identity fields; existing teardown currently clears VM identity/token/share state in one mutation (`packages/backend/convex/domains/workspaces/vmTeardownModel.ts:45-70`).
- No fallback interprets a missing field on an old attached VM as 10 GB or 28 GB; D7 removes those rows instead.

**Runnable/reviewable artifact**

A pure contract fixture renders:

| Context | Birth | Desired | Usable |
|---|---:|---:|---:|
| Trial/free | 28 | 28 | 20 |
| Starter | 28 | 28 | 20 |
| Pro | 28 | 58 | 50 |
| Max | 28 | 108 | 100 |

**Verification**

- Contract tests pin every value and Max price.
- `packages/backend/src/provisioning.test.ts`: replace all 10 GB expectations; trial/Starter/Pro/Max births all create at 28 GB.
- `packages/backend/src/vm-attach.test.ts`: capacity is recorded and Pro/Max attach schedules reconciliation.
- `packages/backend/src/vm-teardown.test.ts`: capacity/target fields clear with VM identity.
- Fake Exe list/create fixtures include `disk_capacity_bytes`.
- Schema and contract type-checks remain green.

**Delegated freedoms**

- Bytes versus integer-GB internal helper representation and precise field names.
- Not delegated: one catalog owner, 28 GB birth, post-attach growth, or absence of migration compatibility.

**Dependencies**

Mechanism verdicts from `00-provider-control` and projection conclusion from `03-projection-reachability`.

## 05-grow-reconciler

**Contract unlocked**

An accepted plan projection or paid-workspace attach converges each attached workspace upward:

```text
desired > realized:
  list provider capacity
  resize only if provider capacity < desired
  restart whenever realized < desired
  record completion after restart

desired <= realized:
  no resize
  no restart
```

Downgrades and equal targets never shrink. Renewal and later projection writes retry failures.

**API seam and ownership**

- New backend workspace-domain owner, provisionally `domains/workspaces/vmDisk.ts`.
- Proposed seam:

```ts
scheduleWorkspaceVmDiskReconcile(ctx, workspaceId, reason): Promise<void>
reconcileWorkspaceVmDisksForUser(ctx, userId, reason): Promise<void>

type WorkspaceVmDiskExe =
  Pick<ExeClient, 'list' | 'resize' | 'restart' | 'setSharePublic'>
```

- Policy remains outside `@repo/exe`; Exe stays a transport.
- Subscription lifecycle, paid invoice, post-attach, and billing-user reassignment invoke the scheduler.
- The action re-reads workspace and payer plan; scheduled arguments never carry an authoritative tier.
- Crash-safe phase rule: if Exe already reports the target but `vmDiskGb < target`, skip resize, still restart, reassert public state if slice 01 proved it necessary, then record.
- Duplicate scheduling must coalesce or converge without duplicate resize/restart. The exact claim encoding is delegated, but stale claims must be recoverable by later projection attempts.
- Record completion with compare-and-set against the same `vmName`; replacement races cannot stamp capacity onto a new VM.

**Runnable/reviewable artifact**

A fake-Exe call ledger shows:

- 28→58.
- 58→108.
- 58→28 no-op.
- Crash after resize, before restart.
- Crash after restart, before record.
- Duplicate scheduling.
- VM replacement during the action.
- Missing `disk_capacity_bytes`.

**Verification**

- New focused backend `vm-disk.test.ts`.
- `packages/backend/src/billing.test.ts`: both projection doors schedule all payer workspaces, renewal retries, pending downgrade does not shrink.
- `packages/backend/src/vm-attach.test.ts`: Pro/Max post-attach growth.
- `packages/backend/src/vm-teardown.test.ts`: an action racing teardown safely no-ops.
- `packages/gateway/src/runner/process-runner.test.ts`: all fix73/restart recovery cases remain green.
- Rerun slices 00–01 through the real scheduler before accepting the slice.

**Delegated freedoms**

- Action/mutation names, coalescing token representation, audit event names, and bounded polling/backoff.
- Not delegated: actual-capacity relist, crash-after-resize restart, strict grow-only guard, same VM, or monthly retry.

**Dependencies**

`00-provider-control`, `01-reboot-continuity`, `03-projection-reachability`, and `04-tier-contract-and-birth`.

## 06-drive-telemetry

**Contract unlocked**

- VM sync optionally reports `driveUsedBytes`.
- Existing `diskUsedMb/diskTotalMb` continue to represent whole-root operational telemetry.
- Backend retains the last good drive sample and sample timestamp per workspace.
- Empty drive presents as approximately 0 GB, independent of image size.

**API seam and ownership**

- New gateway owner, provisionally `DriveUsageSampler`, owns the `du` process, cache, timeout, and single-flight refresh.
- `sampleVmTelemetry()` reads only the current cached value and requests a background refresh when stale.
- `VmTelemetryMetricsSchema` gains optional `driveUsedBytes`.
- Convex telemetry validation/persistence accepts it and updates the workspace’s latest projection when the normal five-minute sample is due.
- Historical telemetry may retain it, but billing must not execute one history query per workspace.

**Runnable/reviewable artifact**

A local sampler fixture exposes cache age, last-good bytes, scan state, last error, and next eligibility time. This makes du-cost drift observable rather than implicit.

**Verification**

- `telemetry-sampler.test.ts`: drive-only semantics, integer safety, empty drive, stale/fresh behavior.
- `sync-client.test.ts`: many five-second polls cause at most one scan per cache interval.
- Scan failure/timeout preserves the last good sample and never fails VM sync.
- Backend telemetry tests prove optional old-client compatibility and correct workspace association.
- Preserve existing root disk histories/charts unchanged.
- Recheck the performance envelope established in `02-du-cost`.

**Delegated freedoms**

- Process wrapper, cache persistence location, timeout/cadence within the benchmark’s accepted envelope, and whether history stores the optional field.
- Not delegated: drive-only allocated bytes, no synchronous recursive walk, last-good behavior, or bounded billing reads.

**Dependencies**

`02-du-cost` and `04-tier-contract-and-birth`.

## 07-reserve-enforcement

**Contract unlocked**

Below one gateway-owned physical free-space reserve:

- Capacity-increasing file operations refuse before staging bytes.
- Reads and deletes remain available.
- Same-filesystem rename/move remains available as a recovery operation.
- A new agent turn is refused before spawning or accepting work.
- A currently running turn is not killed.
- The session receives a stable, friendly storage-full error.
- A racing large write may still hit ENOSPC; D14 does not promise a quota filesystem.

**API seam and ownership**

- New gateway `WorkspaceStorageGuard` owns fresh `statfs`/`bavail` reserve decisions and consumes `DriveUsageSampler` only for diagnostics.
- Proposed contract:

```ts
type StorageAdmission =
  | { ok: true }
  | {
      ok: false
      code: 'storage_full'
      freeBytes: number
      reserveBytes: number
    }
```

- Files call the guard before PUT, copy, mkdir, and symlink. Delete and same-filesystem move/rename remain allowed.
- The agent session coordinator calls the same guard before accepting input that would begin/resume a turn.
- Refusal becomes a settled, typed session disposition rather than a generic gateway failure. Generic gateway dispatch failures currently remain queued for later retry, which would otherwise create an endless full-disk retry loop (`apps/api/src/agent-runner.ts:276-332`).
- Extend the agent/session wire contract with a stable `storage_full` code and `level: 'error'`; the web localizes it. Do not recognize the event by matching English copy.
- File HTTP refusal is `507` with `{ error: 'storage_full' }`.

**Runnable/reviewable artifact**

An injectable-statfs harness demonstrates the boundary without filling a real disk.

**Verification**

- Gateway file route tests: PUT/copy/mkdir/symlink refuse; no partial final file; delete and move/rename succeed.
- Coordinator tests: no runner factory call below reserve; one settled storage event; retry succeeds after cleanup.
- A live runner remains untouched when free space crosses the threshold.
- API tests preserve the typed 507/disposition rather than flattening it to generic 502.
- English and Spanish session presentation tests.
- Existing file event, symlink, runner, and replay suites stay green.

**Delegated freedoms**

- Internal operation classifier and initial reserve constant after image/free-space measurement.
- The constant must live in one gateway module and be one-line tunable.
- Not delegated: delete escape hatch, no mid-turn kill, typed refusal, or one shared guard.

**Dependencies**

`06-drive-telemetry`.

## 08-decommission-branching

**Contract unlocked**

At the seven-day retirement point:

| Workspace history | Archive size | Disposition |
|---|---:|---|
| Never subscribed | any | Skip archive; teardown |
| Subscribed | ≤1 GiB | Archive; teardown; resumable |
| Subscribed | >1 GiB | Skip archive; teardown; future resume is fresh |

Every branch reaches a terminal archived/teardown projection instead of poisoning the hourly retry sweep.

**API seam and ownership**

- Backend candidate projection includes the one-way subscriber discriminator `subscriptionEverActivatedAt`; billing already uses it as the trial-eligibility boundary (`packages/backend/convex/domains/credits/userBilling.ts:55-63`).
- Backend owns:

```ts
type ArchiveDisposition =
  | 'skip_never_subscribed'
  | 'archive_uploaded'
  | 'skip_oversize'
```

- Gateway archive owner changes from whole-buffer materialization to capped streaming:
  - Stream tar output through a byte limiter.
  - Abort and return a typed oversize response at 1 GiB + 1 byte.
  - Stream eligible output without re-reading it into memory.
  - Clean all temporary/process state on success, abort, or client disconnect.
- Backend treats typed oversize as a successful no-archive branch, then marks archived and tears down.
- Unrelated archive failures remain isolated per candidate.
- Existing idle, banned, admin, and servicing state ownership stays unchanged.

**Runnable/reviewable artifact**

A disposition matrix fixture runs trial, small subscriber, exact boundary, oversized subscriber, and unrelated transient-failure cases.

**Verification**

- `packages/backend/src/provisioning.test.ts`, including SUBS-IMPL-07:
  - Trial never calls `/v1/vm/archive`.
  - Small subscriber archive still restores.
  - Oversized subscriber archives no bytes and tears down once.
  - Oversize does not remain an infinite candidate.
- Gateway archive tests cover exact boundary, chunked tar output, abort cleanup, and no whole-buffer allocation.
- `packages/backend/src/vm-teardown.test.ts` remains green.
- Mark archive-offload’s trial/oversize branch as implemented here when the slice lands; no archive provider is added.

**Delegated freedoms**

- Streaming primitive, temporary-file versus direct-pipe implementation, and audit event naming.
- Not delegated: three D5 branches, 1 GiB boundary, no unbounded buffering, or final teardown.

**Dependencies**

`04-tier-contract-and-birth`. The drive sampler may provide an advisory early hint, but it cannot be the authoritative archive-size decision.

## 09-locked-storage-ui

**Contract unlocked**

- Billing plan card displays real per-workspace storage in GB.
- Credits remain percentage-only.
- Active workspace gets a dismissible warning at 90%.
- Full storage renders the locked red hard-stop with delete/upgrade guidance.
- Downgraded workspaces may honestly display more than 100% of the new advertised allowance while retaining their larger physical disk.
- Warning copy says that the workspace and all its files “will shut down in 7 days”; it does not promise preservation.

**API seam and ownership**

- `BillingWorkspace` gains:

```ts
type BillingWorkspaceStorage = {
  usedBytes?: number
  sampledAt?: number
  usableBytes: number
  provisionedBytes?: number
}
```

- Backend `userBillingOverview` projects one storage record per payer workspace. No account-level pooling.
- `usableBytes` derives from the payer’s active plan, falling back to Starter for trial/free.
- Web billing settings renders a labeled row for every payer workspace.
- Root-level storage warning selects `activeWorkspaceSlug`. Non-payer members do not receive upgrade controls because the existing overview is payer-scoped.
- Warning state keys by workspace plus threshold band/quota so cleanup or an upgrade re-arms it.
- Max near-full copy offers cleanup, not an unavailable upgrade.
- Session storage refusal uses the stable event code from slice 07.
- Toast gains an error tone rather than building a parallel alert system.

**Runnable/reviewable artifact**

Playground fixtures:

- Empty Starter.
- Ordinary Starter.
- 90% Starter with Pro CTA.
- 90% Pro with Max CTA.
- Near-full Max cleanup-only state.
- Storage full.
- Unknown/stale first sample.
- Multiple payer workspaces.
- Downgraded workspace above 100%.
- Seven-day shutdown wall.
- English and Spanish.

**Verification**

- Invoke `ui-playground` first and add the red fixtures before implementation.
- Component/client schema tests for billing projection, dismissal/re-arm, Max behavior, multiple workspaces, and exact D6 meaning.
- Compare candidate shots against `specs/per-tier-storage/assets/storage-ui-directions.html` using `compare-screenshots`.
  - Slice variable: information hierarchy and state treatment of the meter/nudge/hard-stop.
  - Crop: billing plan card, active-workspace toast area, and wall/error surface.
  - Out of scope: unrelated settings spacing or apps-in-file-view visuals.
- Run an unprimed `screenshot-critique` last before accepting any shot.
- Open final shots with `preview-shots` as a non-blocking checkpoint for about five minutes; if there is no response, record the evidence-based verdict, close Preview, and continue.

**Delegated freedoms**

- Reversible spacing, responsive stacking, meter component names, and how multiple labeled workspace rows fit inside the plan card.
- Not delegated: locked surfaces, per-workspace accounting, real GB labels, 90%, CTA direction, or shutdown meaning.

**Dependencies**

`06-drive-telemetry` and `07-reserve-enforcement`.

## 10-staging-cutover

**Contract unlocked**

Staging contains no legacy 10 GB VM/workspace state. Fresh acceptance workspaces begin at 28 GB, upgrades grow the same VM, and all storage/restart/archive/UI behavior is proven through the deployed system.

**API seam and ownership**

- Test harness owns the live evidence.
- A reviewed operator runbook owns D7’s staging-only destructive wipe.
- The runbook first inventories exact Convex workspace/user records and exact tagged Exe VMs; deletion uses those resolved IDs/names, not a broad tag or glob.
- No production migration, catch-up scan, capacity inference, or copy-down path is introduced.
- Production rollout remains subject to the existing monthly-subscription cutover controls.

**Runnable/reviewable artifact**

A staging evidence bundle contains:

- Pre-wipe inventory and post-wipe empty verification.
- Fresh VM capacity.
- Upgrade old/new capacity and unchanged VM name.
- Marker checksum, URL, proxy, share, gateway instance, and session recovery evidence.
- Billing meter snapshots.
- Archive disposition evidence.

**Named staging legs affected**

- `subscription-01-trial-generation`: assert fresh trial VM is 28 GB and usage projects near 0 of 20 GB.
- `subscription-02-exhaustion-wall-pause`: assert the new seven-day shutdown wording.
- `subscription-03-checkout` and `subscription-04-activation-resume`: Starter remains 28 GB; checkout does not recreate the VM.
- `subscription-06-idempotency-and-topup-invoice`: webhook replay must not duplicate disk scheduling/restarts.
- `subscription-07-upgrade-and-portal`: prove real Stripe projection reaches the storage hook, same VM grows 28→58, restart occurs, data/proxy survive, and quota becomes 50 GB.
- `subscription-08-downgrade-scheduled`: no immediate shrink.
- `subscription-10-clock-lapse`: block-code and wallet behavior remain unchanged.
- `subscription-11-full-stop-archive-resume`: retain the small-subscriber archive/restore path and assert restored capacity follows current plan policy.
- `subscription-12-cleanup`: cleanup handles capacity/reconcile state.
- `agent-continuity`: restart during an active turn, then no lingering turn lock.
- `share-byte-arrival` and the share journey’s `share-file-arrival`, `share-app-viewer`, and subsequent mutation legs: share/proxy state reconverges after the same full VM reboot.
- Billing/browser acceptance: real plan-card storage meter and warning-wall copy.

These leg names are the harness’s required set (`packages/test-harness/src/staging-e2e-synthetic:68-112`).

**Verification**

- All package/unit/integration suites for affected packages.
- UI playground, screenshot comparison, and unprimed critique green.
- Run disposable provider/reboot probes again after deployment.
- Before running `bun run e2e:staging`, ask the user for explicit approval: it takes roughly 12 minutes and creates real staging and Stripe test resources.
- Full staging suite, not only the modified legs, must pass before completion.

**Delegated freedoms**

- Exact evidence bundle format, run tags, and polling bounds.
- Not delegated: scoped staging wipe, real Stripe projection proof, same-VM checks, active-turn recovery, full share/proxy reboot proof, or full-suite gate.

**Dependencies**

All preceding slices.

# 3) Seams and ownership map

| Concept | Single owner | Writer / operation | Transport | Consumers |
|---|---|---|---|---|
| Tier usable/raw storage | `packages/contract/src/plans` | Static catalog by plan ID | Package import | Backend policy, billing projection, web formatting |
| VM birth capacity | Backend attach policy | Always 28 GB create | `ExeClient.create` | Exe provider |
| Desired disk target | Backend workspace-disk reconciler | Payer plan → target | Convex row/scheduler | Disk action |
| Realized disk capacity | Backend workspace row | Attach or successful resize→restart | Convex query | Reconciler, billing overview, tests |
| Provider-observed capacity | Exe lobby | `list().disk_capacity_bytes` | `@repo/exe` | Disk action only |
| Grow/restart effect | Backend node action | list→resize→restart→record | Exe API | Workspace projection |
| Projection trigger | Subscription projection owner | Post-projection workspace effects | Internal function call | Servicing reconciliation, disk scheduler |
| Drive-used bytes | Gateway `DriveUsageSampler` | Cached background `du` | VM sync telemetry | Backend latest projection/history |
| Physical reserve | Gateway `WorkspaceStorageGuard` | Fresh `statfs` admission | In-process typed result | Files, agent coordinator |
| Storage refusal | Contract/API session seam | Typed 507 or settled event | HTTP/session stream | Web file/session UI |
| Per-workspace storage read model | Backend billing overview | Latest sample + tier quota | Billing contract/API | Settings and active-workspace warning |
| Archive eligibility/disposition | Backend provisioning | Subscriber history + bounded archive result | Gateway archive route | Teardown/resume |
| Archive byte cap | Gateway archive implementation | Capped tar stream | HTTP | Backend provisioning |
| Visual state | Web | Projection → meter/nudge/error | React components | User |
| Live oracle | Test harness | Real Stripe/Exe/browser journeys | Staging environment | Release gate |

Package rules:

- `@repo/contract` owns durable cross-package facts and schemas, not filesystem behavior.
- `@repo/exe` owns Exe transport, not plan policy or retry state.
- Backend owns subscription-to-workspace projection and all external disk orchestration.
- Gateway owns local disk observation and local admission.
- API relays typed contracts; it does not calculate quota or capacity.
- Web owns localization, threshold presentation, dismissal, and CTA choice.
- Test harness consumes production seams but production packages never import it.

# 4) Firewalls

- D1–D14 are fixed. Implementation cannot reopen capacities, birth policy, grow-only behavior, archive branches, 90%, or the locked surfaces.
- Do not derive tier from price. Plan ID is authoritative.
- Do not change Max’s $200 price.
- Do not create a second monthly-credit grant door. Paid monthly grants remain on the existing invoice-owned path (`specs/done/monthly-subscriptions/README.md:36-47`, `specs/done/monthly-subscriptions/README.md:103-109`).
- Do not add another wallet writer; preserve the existing single-writer rule (`specs/done/monthly-subscriptions/README.md:48-57`, `specs/done/monthly-subscriptions/README.md:110-113`).
- Do not persist a parallel entitlement boolean; subscription entitlement remains derived (`specs/done/monthly-subscriptions/README.md:58-64`, `specs/done/monthly-subscriptions/README.md:117-118`).
- `reconcileServicingStatus` remains the sole owner of servicing status and block codes. Disk scheduling is a sibling effect, not a replacement owner (`specs/done/monthly-subscriptions/README.md:65-75`, `specs/done/monthly-subscriptions/README.md:119-125`).
- Preserve distinct servicing block codes and payer-wall behavior (`specs/done/monthly-subscriptions/README.md:126-137`).
- Do not make fake Stripe a production subscription writer.
- Do not resize when desired is equal to or below actual.
- Do not shrink, copy to a smaller VM, or create downgrade migration machinery.
- Do not infer actual provider capacity solely from the workspace row after a failed action.
- Do not create Pro/Max VMs directly at 58/108 GB; all births are 28 GB.
- Do not add legacy 10 GB compatibility or catch-up code. Staging is wiped.
- Do not pool storage between workspaces.
- Do not use whole-root disk telemetry for the customer meter.
- Do not remove or reinterpret existing root disk telemetry/operator charts.
- Do not run `du` synchronously on every VM sync.
- Do not put Stripe or plan knowledge in gateway.
- Do not block deletion at low free space.
- Do not kill an already running turn when the reserve is crossed.
- Do not intercept arbitrary shell writes or claim hard quota enforcement.
- Do not recognize `storage_full` by matching localized message text.
- Do not materialize an unbounded 100 GB archive in gateway memory or temporary storage.
- Do not change existing idle/banned/admin archive ownership beyond the D5 servicing branch.
- Do not implement archive-offload storage/provider work here (`specs/done/monthly-subscriptions/README.md:267-268`).
- Reasserting public state after restart, if the probe proves it necessary, must reuse `setSharePublic`; it must not create a second proxy/share owner.
- D7’s destructive wipe is staging-only and must operate on an explicit inventory. Never generalize it to production.
- Coordinate implementation with the hot files identified in `MAP.md`, especially subscribe-wall and playground work (`specs/per-tier-storage/MAP.md:100-107`).

# 5) Risks and open questions

1. **Exact staging resize permission — highest risk.** Restart is already exercised in staging, but repository documentation does not establish resize scope. Slice 00 kills the plan early on a 403.

2. **Resize/restart crash window.** Provider capacity can reach the target before the guest has rebooted or the workspace row is recorded. The reconciler must distinguish provider-observed capacity from completed resize/restart state.

3. **Duplicate disk actions.** Projection replay, attach, reassignment, and renewal can schedule overlapping work. Coalescing must be durable and stale-claim-safe; “catch 422 and assume success” is not acceptable.

4. **Paid workspace birth.** D2 means a Pro/Max payer’s newly created workspace is still born at 28 GB. Missing the post-attach trigger would leave it permanently undersized until a future billing event.

5. **Fake-Stripe wording mismatch.** Measured fact: deployed staging is real Stripe; local fake Stripe does not project. Recommended resolution is captured-event local coverage plus the real `subscription-07` staging hook proof. If “deployed fake-Stripe staging” is literally required, it needs a separate environment/configuration decision rather than a production ownership change.

6. **Active-turn restart.** Existing staging coverage reboots a sleeping session. The binding risk remains open until a live active turn is interrupted and a subsequent prompt is accepted without `turn_already_running`.

7. **Share/public proxy persistence.** Existing evidence is indirect for public ingress and only service-restart-level for shares. The full VM reboot probe decides whether the reconciler must reassert public state and whether share realization needs an explicit post-boot repair.

8. **`du` cost.** Inode count may dominate byte count. The five-minute single-flight cache is the starting design, but slice 02 owns the actual cadence/timeout verdict.

9. **Reserve versus the fixed +8 GB raw allowance.** The image research reports roughly 7.2 GB of existing image use, leaving limited room between 20 GB of customer data and a 28 GB disk. The reserve must be measured and may stop slightly before the advertised logical limit. It remains one tunable gateway constant; D1’s raw sizes do not move.

10. **Meter freshness.** A five-minute backend projection is intentionally not a hard quota. UI should expose stale/unknown state rather than imply real-time precision.

11. **Downgrade over-100% display.** D4 and D12 imply that a retained 58 GB disk can be measured against a new 20 GB entitlement. Recommended presentation: visually clamp the bar at 100% but show the real “used of allowance” numbers and hard-stop only on physical reserve, not logical percentage.

12. **Multi-workspace billing UI.** Recommended interpretation of the locked single-meter mock: it depicts one workspace. Accounts funding multiple workspaces receive separately labeled meters; never a pooled total.

13. **Payer-only upgrade nudge.** Because billing overview is payer-scoped, the recommended behavior is to show upgrade CTAs only to the billing user. Non-payers may still see the session’s storage-full explanation but not an unauthorized billing action.

14. **Archive cap implementation.** A cheap drive-usage sample can skip obvious oversize cases, but only the bounded tar stream is authoritative because archive content includes more than ordinary drive files.

15. **Consumption cost.** Empty large capacities are not themselves billed, but each VM retains its image bytes. Exe image-layer dedup remains a non-blocking operational follow-up, not a feature dependency.

16. **Rollback.** Code can roll back; grown disks cannot. In staging, rollback is wipe/reseed under D7. Production rollback must leave larger disks in place—never shrink or copy down.