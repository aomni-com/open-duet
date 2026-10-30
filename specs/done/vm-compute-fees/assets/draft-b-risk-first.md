## 1. Recon findings

- `ExeClient.stat()` already sends `stat <name> --range=<range>`, but returns `unknown`; the first production contract must therefore type and validate the provider response before billing can consume it. The package’s HTTP adapter already redacts command errors, so the new parser belongs in `@repo/exe`, not in billing code. `packages/exe/src/exe.ts:164-190`, `packages/exe/src/exe.ts:303-305`

- The present telemetry table stores projected UI units—percent, MiB, and `driveUsedMb`—rather than provider facts. Its writer performs unconditional inserts, and `by_workspace_at` is only an index, not a uniqueness constraint. Overlapping 24-hour provider reads would therefore duplicate points unless the new sole writer performs timestamp-keyed upserts. `packages/backend/convex/schema.ts:361-372`, `packages/backend/convex/domains/workspaces/vmTelemetry.ts:20-42`

- `lastTelemetrySampleAt` exists solely to throttle the in-VM writer. It becomes obsolete under provider timestamps and should disappear in the hard cutover rather than survive as dead schema. `packages/backend/convex/schema.ts:310-313`, `packages/backend/convex/domains/workspaces/vmTelemetry.ts:16-18`

- The current public telemetry contract and chart need not change shape. The backend can project provider facts into `cpuPct`, memory MiB, and disk MiB before returning them; the chart already positions points by their actual timestamps, so irregular provider cadence remains visible. `packages/contract/src/vm/index.ts:20-43`, `apps/web/spa/settings/telemetry-history-chart.tsx:15-16`, `apps/web/spa/settings/telemetry-history-chart.tsx:163-181`

- The existing rail is materially fresher than a once-daily provider sweep: the gateway attempts telemetry every sync, while the backend admits one point every five minutes. A daily-only replacement therefore changes storage and chart freshness unless explicitly accepted or the provider probe supports a cheaper intermediate cadence. `packages/backend/convex/domains/workspaces/vmTelemetry.ts:10-18`, `packages/gateway/src/runtime/http.ts:579-585`

- `projectWorkspaceStorage` currently reads `driveUsedMb` directly and subtracts image headroom only from capacity. Replacing that value with raw `fs_used_gb` without subtracting `VM_IMAGE_HEADROOM_GB` from usage would indeed make a fresh VM appear used. The same projection should own both adjustments: usable capacity is `rawDiskGb - headroom`, used bytes are `max(0, fsUsedGb - headroom) × 2^30`. `packages/backend/convex/domains/credits/userBilling.ts:133-166`, `packages/contract/src/plans/index.ts:30-34`

- The billing brief understates ledger idempotency. `applyLedgerEntryWithDb` defaults its reference lookup to the current billing user; only `idempotencyScope: 'global'` checks a reference globally. Because billing ownership can change, `vm_usage:<workspaceId>:<yyyymmdd>` must explicitly use global idempotency or the same workspace-day can debit two payers. `packages/backend/convex/domains/credits/ledger.ts:65-79`, `packages/backend/convex/domains/credits/transactionByReference.ts:4-18`, `packages/backend/convex/domains/workspaces/mutations.ts:242-247`

- A negative `usage` entry already increments account and workspace monthly spend and schedules daily, weekly, and monthly usage rollups. It spends monthly credits first and routes overflow to paid credits, whose balance may become negative; no new wallet path, cap, or clamp is needed. `packages/backend/convex/domains/credits/ledger.ts:82-128`, `packages/backend/convex/domains/credits/wallet.ts:31-39`, `packages/backend/convex/domains/credits/wallet.ts:133-148`

- The fee will not trigger auto-topup by merely using the ledger. Auto-topup is called only from the spend preflight, not from `applyLedgerEntryWithDb`; the VM fee must continue to bypass that preflight. `packages/backend/convex/domains/credits/ledger.ts:263-296`, `packages/backend/convex/domains/credits/ledger.ts:311-334`

- A debit alone does not immediately reconcile workspace servicing. To realize the stated trial behavior, the charge mutation must call the existing servicing reconciler after an applied debit. That reconciler pauses an exhausted trial but keeps a paid-through subscriber active regardless of balance. `packages/backend/convex/domains/credits/subscriptions.ts:45-64`, `packages/backend/convex/domains/credits/subscriptions.ts:97-118`

- “Label via `transactionMetadata`” crosses three seams. Typed transaction metadata currently has no VM-usage discriminator; user billing history deliberately omits metadata; and the web UI labels every `usage` item identically. The implementation therefore needs a typed metadata field plus a narrow public projection such as `usageKind: 'vm_compute'`, never raw metadata exposure. `packages/backend/convex/validators.ts:99-121`, `packages/backend/convex/domains/credits/userBilling.ts:236-264`, `packages/contract/src/billing/index.ts:172-189`, `apps/web/spa/routes/user-settings.tsx:562-599`

- The current size sweep is not a safe template for enumeration. It reads only active workspaces, has a non-cursor cap of 500, then does one provider lobby call. VM fees need deployment-owned workspace enumeration, real pagination, and one isolated provider action per VM; copying this loop would omit later workspaces or time out. `packages/backend/convex/domains/workspaces/vmSizeModel.ts:16-23`, `packages/backend/convex/domains/workspaces/vmSizeModel.ts:41-52`, `packages/backend/convex/domains/workspaces/vmSize.ts:42-52`

- Candidate enumeration must start from this Convex deployment’s workspace rows and stat their recorded names. Provider tags cannot safely select an environment because the shared contract records that one account backs staging and production; workspace identity is already persisted as `vmName`. `packages/contract/src/resources/index.ts:35-59`, `packages/backend/convex/schema.ts:319-327`

- The gateway landmine is real: telemetry and the disk guard share the local `telemetrySamplerIo.statvfs` object. The disk guard is otherwise already a clean independent abstraction and fails open when its filesystem probe fails. Decoupling this dependency before deleting the sampler is the cheapest runtime-risk reduction. `packages/gateway/src/runtime/http.ts:165-188`, `packages/gateway/src/vm/disk-guard.ts:7-35`

- The closed Convex observation validator must retain `telemetry` as accepted-and-ignored after the backend stops reading it. This is stricter than the Zod API parser, which strips unknown fields; deleting the Convex field can still break an older API/gateway combination. `packages/backend/convex/domains/workspaces/vmSync.ts:103-131`, `packages/contract/src/vm/index.ts:109-121`

- Teardown currently lists the provider, removes the VM, and only then clears its workspace fields. The final stat and ledger mutation must be inserted before removal and while the row exists. The direct attach rollback removals remain intentionally outside that owner. `packages/backend/convex/domains/workspaces/vmTeardown.ts:50-91`, `packages/backend/convex/domains/workspaces/vmAttach.ts:76-101`, `packages/backend/convex/domains/workspaces/vmAttach.ts:138-158`

- The current creation gate is not keyed on `billingUserId`: it counts owner memberships and gives every active subscriber unlimited creation. Billing transfer only checks that the target is a live owner. Both must be replaced by one billing-user limit owner. `packages/backend/convex/domains/workspaces/birth.ts:77-99`, `packages/backend/convex/domains/workspaces/mutations.ts:218-247`

- “Live” already means everything except `deleted` and `retired`, including archived workspaces. Reusing that definition gives creation-gated downgrades without deleting or exempting existing archived workspaces. `packages/backend/convex/domains/workspaces/authorization.ts:17-19`

- The existing plan module is the correct home for both rates and workspace limits: it already owns monthly grants, storage sizes, image headroom, and the exhaustive starter/pro/max table. `packages/contract/src/plans/index.ts:3-38`

## 2. Slice graph

### 1. Make `exe stat` a repeatable kill gate

**Contract unlocked:** Duet has a validated provider response rather than an `unknown` cast, and a repeatable live probe verifies the current token plus all three provisioned widths before any customer balance can change. `packages/exe/src/exe.ts:164-190`, `packages/contract/src/resources/index.ts:3-26`

**API seam:**

- `@repo/exe` owns `ExeStatPoint` with `cpu_cores`, `cpu_nominal`, `mem_used_bytes`, `mem_total_bytes`, `fs_used_gb`, and parsed epoch-millisecond `timestamp`; `disk_used_gb` is neither exposed nor retained.
- `ExeClient.stat(name, '24h')` returns `Promise<ExeStatPoint[]>` after strict envelope and numeric validation.
- Add `probe:vm-stat` beside the existing VM-cap and tier-disk probes. It creates disposable tagged 4/8, 8/16, and 10/24 VMs, waits for at least two points, records point counts/cadence/nominal fields, and always removes them. Existing probes and cleanup policy establish this package as the owner of such live checks. `packages/exe/package.json:15-28`, `packages/exe/README.md:126-169`, `packages/test-harness/README.md:15-46`

**Human-visible result:** `bun run probe:vm-stat` prints a credential-free JSON/Markdown report containing the three nominal widths, response latency, timestamp ordering, and cleanup verdict.

**Verification gates:** parser fixtures for direct-array and observed envelope shape; malformed timestamp, negative usage, missing fields, and redacted provider errors; live probe on staging.

**Kill/reshape verdict:** stop within one probe run if `stat` is again 403, if 8/16 or 10/24 reports the wrong nominal resources, if points cannot be obtained within the declared wait budget, or if response semantics differ by width. Token failure goes to exe.dev scope repair; width mismatch reshapes pricing inputs; missing history kills automated deduction until the provider supplies a reliable source.

**Out of scope:** no Convex writes, ledger entries, cron, storage projection, workload saturation, or account-wide lobby sweep.

### 2. Prove the N-call rail without billing anyone

**Contract unlocked:** a deployment-scoped, paginated candidate rail and provider-call execution strategy are proven at fleet scale before they can write telemetry or money. The existing flat-500 candidate query is explicitly unsuitable. `packages/backend/convex/domains/workspaces/vmSizeModel.ts:16-23`

**API seam:**

- `vmUsageSweepModel.ts` owns a cursor-paginated query returning only `{ workspaceId, vmName }`, selected from this deployment’s rows with a defined `vmName` and no `servicingExemptAt`.
- `vmUsageSweep.ts` owns one-VM actions, bounded scheduling jitter, retry classification, and per-run counts. It never calls `exe.list()`.
- A retained read-only probe invokes those seams without an `onSample` writer; it is a separate command, not a runtime `dryRun` flag.
- Extend `WorkspaceVmExe` and its fake with typed `stat`; the current fake does not implement it. `packages/backend/convex/domains/workspaces/vmExe.ts:7-18`, `packages/backend/convex/domains/workspaces/vmExe.ts:37-79`

**Human-visible result:** run the read-only staging sweep against the present fleet and a local synthetic 500-candidate fixture; inspect scheduled/completed/failed counts, p50/p95 latency, 403/429/504 classification, and confirmation that every name originated from Convex.

**Verification gates:** cursor traversal reaches candidate 501; one failed stat does not stop later candidates; duplicate scheduler delivery is harmless; concurrency never exceeds the measured bound; staging and production cannot cross because no provider enumeration occurs.

**Kill/reshape verdict:** finish in hours, not days. If bounded calls produce 429s or cannot finish within a daily window, reshape to wider jitter or a lower scheduler rate. If even serialized one-VM actions are unreliable, stop the feature and request a provider batch/export seam.

**Out of scope:** no telemetry table changes, debit, cron activation, gateway deletion, or UI.

### 3. Separate the disk guard from telemetry and canary it in a real VM

**Contract unlocked:** deleting telemetry can no longer remove the disk-full protection by dependency accident. `packages/gateway/src/runtime/http.ts:165-188`

**API seam:**

- `disk-guard.ts` remains the sole disk-write guard.
- Runtime construction receives a dedicated filesystem-capacity dependency such as `diskGuardIo.statvfs`; telemetry may temporarily reuse the same low-level implementation but no longer owns it.
- `GatewayEnv.telemetrySamplerIo` remains temporarily for the sampler and is removed only in slice 9. `packages/gateway/src/runtime/env.ts:80-85`

**Human-visible result:** a gateway unit composition test proves file writes are refused when the dedicated probe reports less than the reserve, and a disposable staging VM boots the new gateway and completes a real write/read/delete journey.

**Verification gates:** focused disk-guard tests; gateway runtime composition test; package build; disposable VM canary with guaranteed cleanup.

**Kill/reshape verdict:** one local test run plus one VM boot. A production runtime that cannot construct, or a disk guard that no longer blocks a simulated full filesystem, stops the gateway cutover. The fallback is to leave the sampler intact while moving only the shared `statfs` adapter into its own module.

**Out of scope:** do not yet delete `telemetry-sampler.ts`, `drive-usage.ts`, the sync wire field, or backend ingestion.

### 4. Freeze pricing, integration, and workspace-limit policy as pure contracts

**Contract unlocked:** all monetary and limit decisions are deterministic and independently testable before any database mutation exists. The plan module already owns exhaustive plan facts. `packages/contract/src/plans/index.ts:3-38`

**API seam:**

- Add exact constants: CPU `3000` microUSD/core-hour and RAM `600` microUSD/GiB-hour.
- Add `WORKSPACE_LIMIT_BY_PLAN = { starter: 1, pro: 3, max: 10 }`.
- `integrateVmUsage(points, { startAt, endAt })` sorts and deduplicates timestamps, clips adjacent intervals to the requested window, trapezoid-integrates absolute cores and used memory, divides bytes by `2^30`, and rounds once after summing the complete debit.
- Zero points or fewer than two usable timestamps returns `null`; it never creates a zero debit.
- No allowance, disk component, debt cap, or runtime “below grant” check is introduced.

**Human-visible result:** a fixture command prints idle, busy, miner, irregular-cadence, and 30-day saturated plan calculations in dollars and grant share.

**Verification gates:** exact rates; irregular timestamp intervals; boundary clipping; unordered/duplicate points; no-point and one-point skips; no disk field in the formula; negative paid balance remains possible; saturated 30-day 4/8, 8/16, and 10/24 results are each below that plan’s grant. Wallet behavior is already designed to keep monthly nonnegative while paid absorbs overflow. `packages/backend/convex/domains/credits/wallet.ts:31-39`, `packages/backend/convex/domains/credits/wallet.ts:133-148`

**Out of scope:** no ledger calls, runtime mercy, auto-topup, VM shrinking, storage billing, database schema, or provider calls.

### 5. Hard-cut telemetry onto raw provider samples

**Contract unlocked:** `vmTelemetrySamples` has one provider-backed writer, while user-facing telemetry and storage continue to read stored samples rather than calling exe.dev live. `packages/backend/convex/domains/workspaces/vmTelemetry.ts:98-121`, `packages/backend/convex/domains/credits/userBilling.ts:114-130`

**API seam:**

- Replace projected table fields with `{ workspaceId, at, cpuCores, cpuNominal, memUsedBytes, memTotalBytes, fsUsedGb }`.
- `upsertProviderTelemetrySamples(ctx, workspaceId, points)` is the sole writer: deduplicate the payload, look up exact `workspaceId + at`, insert missing points, and treat already-present identical points as success.
- `listTelemetryHistoryImpl` remains the sole public projector, producing `cpuPct`, memory MiB, `diskUsedMb = max(0, fsUsedGb - VM_IMAGE_HEADROOM_GB) × 1024`, and usable disk total for the existing contract.
- `projectWorkspaceStorage` reads the newest raw sample and computes `usedBytes = max(0, fsUsedGb - VM_IMAGE_HEADROOM_GB) × 2^30`.
- Remove `driveUsedMb`, `lastTelemetrySampleAt`, and `recordTelemetrySampleIfDue`.
- Stop reading `args.observation.telemetry`, but retain the closed Convex `telemetry` validator with the accepted-and-ignored comment and removal condition. `packages/backend/convex/domains/workspaces/vmSync.ts:103-131`, `packages/backend/convex/domains/workspaces/vmSync.ts:349-363`

**Human-visible result:** after one internal collection for a disposable VM, the existing telemetry endpoint and chart show provider-derived CPU/memory/storage; a fresh VM’s storage bar reads zero. The endpoint already serves persisted history through an authenticated member query. `apps/api/src/routes/telemetry.ts:6-18`, `apps/web/spa/settings/telemetry-history-chart.tsx:21-69`

**Verification gates:** exact timestamp upsert; overlapping 24-hour payload does not duplicate; downsampling retains real elapsed-time gaps; fresh `7.449` GB projects to zero used; storage warning uses projected workspace usage; public response still parses the existing contract; old telemetry-bearing sync requests still succeed.

**Cutover gate:** wipe staging `vmTelemetrySamples`, then deploy the new schema/backend. There is no dual-write, backfill, compatibility table, or migration code. This is the sole deploy-order exception required by the closed validator and incompatible table shape. `packages/backend/convex/schema.ts:361-372`, `packages/backend/convex/domains/workspaces/vmSync.ts:103-131`

**Out of scope:** no debit yet, no gateway sampler deletion yet, no live query to exe.dev, and no storage charge.

### 6. Apply one globally idempotent daily VM-compute debit

**Contract unlocked:** one settlement mutation atomically stores the provider points and applies at most one VM-compute fee per workspace/day. `applyLedgerEntryWithDb` remains the only wallet writer. `packages/backend/convex/domains/credits/ledger.ts:45-137`

**API seam:**

- `settleWorkspaceVmUsage(ctx, { workspaceId, points, dayKey, startAt, endAt, now })` owns the charge.
- It reloads the workspace, skips when `servicingExemptAt` is present, upserts the samples, invokes the pure integrator, and skips without a transaction when there are insufficient points.
- The ledger call is exactly:
  - `type: 'usage'`
  - `amountMicroUsd: -computedAmount`
  - `reference: vm_usage:<workspaceId>:<yyyymmdd>`
  - `idempotencyScope: 'global'`
  - typed `transactionMetadata: { usageKind: 'vm_compute' }`
- After an applied debit, call the existing payer servicing reconciler. This pauses an exhausted trial and leaves a paid-through subscriber active. `packages/backend/convex/domains/credits/subscriptions.ts:53-64`, `packages/backend/convex/domains/credits/subscriptions.ts:97-118`
- The daily coordinator freezes one UTC window and day key for the whole run, paginates candidates, and starts jittered retried one-VM actions. Each action makes one `stat` call and one settlement mutation.
- Add a small sweep-run record or equivalent durable completion accounting so scheduled/applied/idempotent/skipped/failed totals can be inspected; do not infer completion from logs alone.

**Human-visible result:** trigger one deterministic local sweep and inspect one labeled billing-history row, its workspace usage rollup, the reduced balance, and the durable sweep totals.

**Verification gates:** retry applies once; billing transfer between retries still applies once because scope is global; no points means no transaction; exemption is rechecked in the settlement mutation; paid balance may go negative; no auto-topup action is scheduled; monthly spend and usage rollups increase; trial reconciliation pauses while subscriber reconciliation does not. `packages/backend/convex/domains/credits/ledger.ts:95-128`, `packages/backend/convex/domains/credits/ledger.ts:283-334`

**Billing-history seam:** add only the public `usageKind` discriminator to the history contract and render “VM compute” for it; retain the existing generic label for model usage. Raw references and metadata remain private. `packages/backend/convex/domains/credits/userBilling.ts:236-264`, `packages/contract/src/billing/index.ts:172-189`, `apps/web/spa/routes/user-settings.tsx:562-599`

**Visual gate:** use `ui-playground` for the labeled billing row, compare before/after billing-history shots, and run unprimed screenshot critique before acceptance, as required for visual changes. `AGENTS.md:71-81`

**Out of scope:** no auto-topup, disk charge, allowance, debt forgiveness, shrink-on-zero, or workspace-count enforcement.

### 7. Charge teardown’s final partial UTC window before removal

**Contract unlocked:** the one billable teardown owner attempts the current day’s final partial settlement through the same stat-and-settle path as the cron before deleting the provider VM. `packages/backend/convex/domains/workspaces/vmTeardown.ts:41-95`

**API seam:**

- Extend `WorkspaceVmRemoveExe` to include `stat`.
- In `removeVmForWorkspaceImpl`: resolve the recorded identity, stat it, call the slice-6 settlement with the current UTC day window ending at teardown time, then call `remove`, then `clearWorkspaceVm`.
- Reuse the same global VM-day reference, so a regular sweep and teardown racing on the same day cannot double-debit.
- Attach rollback removals remain direct and uncharged. `packages/backend/convex/domains/workspaces/vmAttach.ts:94-101`, `packages/backend/convex/domains/workspaces/vmAttach.ts:146-158`

**Human-visible result:** a teardown fixture returns the ordered trace `stat → settle → remove → clear`, and the ledger contains either one partial charge or the pre-existing daily charge, never both.

**Verification gates:** exact call ordering; missing workspace; superseded VM identity; stat failure; settlement retry; provider VM already absent; same-day cron race; exempt workspace; final sample retained after VM removal.

**Firewall:** provider-stat failure must not permanently leak a VM into the shared pool. Attempt bounded retry, record the missed-final-charge outcome, then favor removal over indefinite retention; leaked VMs have already been shown to degrade live workspaces severely. `packages/test-harness/README.md:19-46`

**Out of scope:** no charge for attach rollback VMs, no post-removal provider stat, and no new deletion owner.

### 8. Enforce 1/3/10 through one billing-user limit owner

**Contract unlocked:** creation and billing transfer ask one exact policy whether assigning another live workspace to a user is permitted.

**API seam:**

- `workspaceBillingLimit.ts` owns:
  - `workspaceLimitForUser(user, now)` using active starter/pro/max entitlement, with non-subscribers falling back to starter.
  - `countBilledLiveWorkspaces(ctx, userId)` using `by_billing_user` and the existing live definition.
  - `assertCanBillAnotherWorkspace(ctx, userId, now)`.
- `assertCanCreateWorkspace` delegates to it before insertion.
- `setBillingUser` delegates to it for the new payer before patching.
- System-workspace `bypassOwnerBillingGate` remains the only explicit creation bypass. `packages/backend/convex/domains/workspaces/birth.ts:101-124`
- Refusal is a structured `ConvexError`, extended through the contract and API as a plan-aware `workspace_limit_reached` response. The present creation route already preserves structured refusal while the transfer route needs a new mapping. `apps/api/src/routes/workspaces.ts:64-92`, `apps/api/src/routes/workspaces.ts:115-143`, `apps/api/src/routes/workspaces.ts:528-545`

**Human-visible result:** the create dialog names the current plan limit and offers the billing/upgrade route; billing-user settings report the same limit when transfer would exceed it. Current surfaces otherwise render unknown failures generically. `apps/web/spa/shell/create-workspace-dialog.tsx:14-58`, `apps/web/spa/routes/workspace-settings.tsx:743-802`

**Verification gates:** starter refuses workspace 2, pro refuses 4, max refuses 11; deleted and retired do not count; archived does count; downgrade leaves existing rows untouched but blocks the next creation/transfer; transfer to the existing payer is an idempotent no-op; failed transfer leaves payer and audit history unchanged.

**Visual gate:** add hermetic playground fixtures for creation refusal and billing-transfer refusal, then run `ui-playground`, before/after comparison, and unprimed screenshot critique. `AGENTS.md:71-81`

**Out of scope:** no deletion on downgrade, no migration, no proactive warnings for already-over-limit accounts, and no VM resize.

### 9. Delete the in-VM telemetry rail

**Contract unlocked:** provider telemetry is the only surviving telemetry source; the gateway no longer reads `/proc/stat`, `/proc/meminfo`, filesystem usage, or `du` for reporting.

**API seam:**

- Remove `telemetry-sampler.ts`, `drive-usage.ts`, their tests, `readTelemetry`, and `telemetrySamplerIo`.
- Remove telemetry from `VmSyncRequestSchema` and gateway request composition.
- Keep only the backend Convex `telemetry` validator as accepted-and-ignored until every deployed gateway version has crossed the stated removal condition.
- Preserve the independently owned disk guard introduced in slice 3. `packages/gateway/src/runtime/http.ts:178-188`, `packages/gateway/src/runtime/http.ts:579-585`, `packages/backend/convex/domains/workspaces/vmSync.ts:103-131`

**Human-visible result:** the gateway production composition test posts no telemetry, while real VM file writes and disk-full protection remain green.

**Verification gates:** gateway package tests and build; sync request contract tests; backend legacy telemetry-bearing request test; real staging VM boot/write/read/delete canary.

**Kill/reshape verdict:** if the canary loses disk protection or fails to boot, revert only this deletion slice; provider ingestion and charging remain independently testable. Slice 3 ensures the failure does not require backing out billing architecture.

**Out of scope:** do not remove the accepted-and-ignored Convex field in this feature.

### 10. Close with one live staging journey

**Contract unlocked:** the deployed feature is proven through its real provider, Convex, API, browser, ledger, and teardown seams.

**API seam:** add `vm-compute-fees` to `STAGING_JOURNEYS` with the smallest workspace-browser fixture capable of reading storage, telemetry, and billing history. The registry is the owner of focused journeys. `packages/test-harness/src/staging-e2e-synthetic:24-30`, `packages/test-harness/src/staging-e2e-synthetic:148-162`

**Journey:**

1. Mint one explicit ephemeral staging identity and register it in the cleanup ledger.
2. Wait for provider telemetry on its real VM.
3. Invoke the protected sweep seam for a frozen UTC window.
4. Verify raw provider sample ingestion through the public telemetry projection.
5. Verify fresh-VM storage reads zero.
6. Verify one labeled `usage` debit and unchanged auto-topup state.
7. Retry and prove idempotency.
8. Delete the workspace and prove teardown removes the VM after the final settlement attempt.
9. Sweep tagged ephemeral VMs and verify cleanup. The harness requires both ephemeral marking and cleanup verification. `packages/test-harness/README.md:26-46`

**Verification gates:** focused journey only—`bun run e2e:staging -- --journey vm-compute-fees`—then the one root closeout `bun run test`; do not run the full staging suite. `AGENTS.md:83-93`

**Out of scope:** no 60-minute full staging run, provider backfill, production mutation, or persistent test identity.

## 3. Dependencies and ordering

```text
1 provider contract/probe
├── 2 fan-out proof ────────┐
├── 3 disk-guard split ──┐  │
└── 4 pure policies ─────┼──┼──> 5 telemetry cutover ──> 6 daily debit ──> 7 teardown
                         │  │
                         │  └───────────────────────────> 8 workspace limits
                         └────────> 9 gateway deletion (after 5 is live)
                                     
5 + 6 + 7 + 8 + 9 ─────────────────────────────────────> 10 staging closeout
```

- Slices 2, 3, and 4 can proceed in parallel after slice 1 because they touch separate seams: scheduler architecture, gateway filesystem composition, and pure policy respectively.

- Slice 5 requires the provider contract from slice 1 and the deployment-scoped rail from slice 2. Its staging table wipe is the only hard-cutover ordering step.

- Slice 6 requires the raw sample writer from slice 5 and pricing integrator from slice 4.

- Slice 7 requires the settled charge function from slice 6; it must not invent a second calculator or ledger path.

- Slice 8 depends only on slice 4’s plan-limit constants and can run in parallel with slices 5–7.

- Slice 9 requires slice 3’s disk-guard independence and slice 5’s provider writer. It need not wait for workspace limits.

- Slice 10 waits for all production seams and is the only live staging closeout gate. The repo requires narrow local runners during implementation and one root test at handback. `AGENTS.md:37-69`, `AGENTS.md:83-93`

## 4. Kill gates

| Slice | Failure that kills or reshapes the feature | Time to verdict | Fallback |
|---|---|---:|---|
| 1 | Token returns 403; no usable 24-hour history; Pro/Max nominal fields disagree with provisioned caps | One probe run, bounded by first provider points | Repair token scope or obtain a provider-supported export; do not bill from in-VM telemetry |
| 2 | One-call-per-VM produces sustained 429/504 or cannot drain a synthetic 500-VM day | Same day | Increase jitter/lower rate; if still unreliable, require a provider batch endpoint |
| 3 | Gateway fails to boot/write or disk guard no longer blocks simulated full disk | One focused local run plus one VM canary | Keep sampler, land only the independent filesystem adapter, repeat |
| 4 | Saturated Starter exceeds its grant or integration depends on assumed cadence | Seconds | Stop and revise rates/integration; never add a runtime allowance |
| 5 | Overlapping stat ranges duplicate samples, legacy sync 500s, or fresh storage is nonzero | One local deployment test | Do not activate cron; fix writer/projection/validator before money |
| 6 | Retry or billing transfer can double-charge; fee schedules auto-topup; missing telemetry creates a debit | One focused backend test file | Keep collection read-only; do not register the charge cron |
| 7 | Final settlement requires deleting first, or settlement failure can indefinitely leak a VM | One teardown test file | Prefer removal with recorded underbilling; never retain crowding capacity indefinitely |
| 9 | Sampler deletion removes disk protection inside a real VM | One staging canary | Revert only gateway deletion; provider telemetry remains authoritative |

## 5. Single-owner invariants

| Concept | One owner | A forbidden second owner |
|---|---|---|
| Provider response | `@repo/exe` typed `ExeStatPoint` parser | Re-parsing `unknown` in Convex, a probe, or teardown |
| Telemetry sample writer | `upsertProviderTelemetrySamples` in `vmTelemetry.ts` | Sync persistence, teardown, or cron inserting table rows directly |
| Public telemetry projection | `listTelemetryHistoryImpl` | Web chart interpreting raw provider fields |
| Storage projection | `projectWorkspaceStorage` | Subtracting image headroom in ingestion or UI |
| Compute integration | Pure `integrateVmUsage` policy module | Cron and teardown implementing separate arithmetic |
| Charge function | `settleWorkspaceVmUsage` | Cron or teardown calling `applyLedgerEntryWithDb` themselves |
| Daily orchestration | `vmUsageSweep` coordinator/retrier | An account-wide `exe.list()` loop or a second cron |
| VM deletion | `removeVmForWorkspaceImpl` | A fee-specific deletion action; attach rollback remains its already-defined non-billable exception |
| Workspace limit | `assertCanBillAnotherWorkspace` | Separate creation and transfer counters |
| Plan constants | `@repo/contract` plans module | Backend-local rate or limit tables |
| Disk-full protection | `createDiskGuard` plus its dedicated filesystem dependency | Telemetry sampler owning the guard’s probe |
| Billing label | Typed transaction metadata projected as public `usageKind` | UI parsing reference strings or raw metadata |

These boundaries follow the repository’s “one home per fact” rule and preserve the backend as metadata/policy owner while the gateway remains the VM-local side-effect owner. `README.md:11-27`, `packages/backend/README.md:1-12`, `packages/gateway/README.md:1-12`

## 6. Risks and firewalls

- **Provider interval semantics remain undocumented in code.** Slice 1 must capture the real envelope and slice 4 must use timestamp-clipped adjacent intervals without assuming ten minutes. No extrapolation before the first or after the last observed point.

- **Daily key versus rolling range:** freeze the UTC `startAt`, `endAt`, and `yyyymmdd` once at sweep start and pass them through every retry. Deriving them from retry-time `Date.now()` would move a failed workspace into a different reference day. Existing cron and usage-rollup code already pass stable period keys instead of recomputing them in the delayed mutation. `packages/backend/convex/domains/credits/usageRollups.ts:108-150`

- **Billing transfer race:** global reference scope prevents duplicate workspace-day charges. The charge is assigned to the billing user present when the settlement mutation commits because the ledger resolves the payer from the workspace inside that transaction. `packages/backend/convex/domains/credits/ledger.ts:65-71`

- **Overlapping reads:** timestamp upsert is mandatory. Unconditional insertion would distort charts and any later integration over stored points. `packages/backend/convex/domains/workspaces/vmTelemetry.ts:35-42`

- **Provider malformed data:** fail one workspace closed for charging, record the failure, and continue the sweep. Never convert missing or invalid telemetry into zero usage.

- **Provider rate limiting:** pagination alone does not limit simultaneous scheduled actions. The scheduler owner must apply measured jitter and retrier backoff; the existing usage rollup rail demonstrates repository-approved jitter. `packages/backend/convex/domains/credits/usageRollups.ts:108-150`

- **Teardown versus revenue:** final charging is subordinate to reclaiming shared capacity. A permanently unremovable VM is worse than one missed partial debit, given the documented effect of leaked VMs on live workloads. `packages/test-harness/README.md:19-46`

- **Servicing exemption race:** candidate selection is only an optimization. Settlement must recheck `servicingExemptAt` transactionally because the workspace may become exempt after scheduling. The schema makes exemption a workspace fact. `packages/backend/convex/schema.ts:333-337`

- **Trial pause fan-out:** reconciliation operates over every workspace billed to the exhausted user. That is existing payer-level behavior, not a fee-specific pause loop. `packages/backend/convex/domains/credits/subscriptions.ts:97-118`

- **Monthly caps:** the fee itself is postpaid and bypasses preflight, but its `usage` entry increases monthly spend and can cause later AI preflight to hit an account/workspace cap. This follows the existing ledger semantics. `packages/backend/convex/domains/credits/ledger.ts:95-128`, `packages/backend/convex/domains/credits/creditsShared.ts:153-169`

- **Telemetry freshness:** the daily provider rail may make charts and storage up to one day stale instead of approximately five minutes. Slice 2 must report whether a more frequent bounded cadence is affordable; do not silently choose a high-frequency N-call cron. `packages/backend/convex/domains/workspaces/vmTelemetry.ts:14-18`

- **Schema cutover:** old projected rows cannot coexist with a closed raw schema. Wipe staging first; do not write a converter, dual-reader, or compatibility fields. `packages/backend/convex/schema.ts:361-372`

- **Security boundary:** the provider token remains in the backend action environment. No token or provider call enters a user-facing query or the workspace VM. The repository treats the VM as one trust domain, but credentials leaving that boundary still require deliberate handling. `SECURITY.md:80-98`, `README.md:115-128`

## 7. Test strategy

Every implementation slice begins with the repository’s `write-tests` red/green workflow and uses the narrowest owning-package runner; `bun run test` is reserved for the final closeout. `AGENTS.md:31-69`

**`@repo/exe`**

- Extend `packages/exe/src/exe.test.ts` with observed stat envelopes, request command shape, strict invalid-point cases, timestamp conversion, and error redaction.
- Add probe-level cleanup tests and the three-width live probe.
- Iterate with `bun test src/exe.test.ts`; run `bun run test` in `packages/exe` only when that slice closes. `packages/exe/package.json:9-29`

**Contract**

- Pricing constraint test across all `SUBSCRIPTION_PLANS`.
- Exact 1/3/10 limit table.
- Telemetry public-response compatibility.
- Billing-history `usageKind` round-trip without admitting raw metadata or references.
- Workspace-limit refusal schema for both creation and transfer. Existing billing tests explicitly assert that history excludes raw `reference` and `metadata`; that protection must stay green. `apps/api/src/billing.test.ts:797-803`

**Backend pure tests**

- Irregular timestamp integration, boundary clipping, duplicates, gaps, no points, one point, unit conversion, and round-once behavior.
- Rate table calculations for 4/8, 8/16, and 10/24.
- Cursor traversal past 500, jitter bounds, retry classification, and no use of `exe.list()`.

**Backend deployment-backed tests**

- Raw sample upsert and overlapping 24-hour payload.
- Telemetry projection and downsampling.
- Fresh storage zero plus 90% warning behavior.
- Legacy telemetry-bearing sync accepted but ignored.
- One daily usage transaction, global idempotency across payer transfer, negative paid balance, usage rollups, and no auto-topup schedule.
- Servicing-exempt skip, exhausted trial pause, subscriber remains active, archived workspace receives no special exclusion.
- Teardown ordering, race with cron, stat failure, superseded identity, and attach rollback exclusion.
- Starter/pro/max creation and transfer limits; downgrade preserves rows; deleted/retired exclusion; archived inclusion.
- Extend testing fixtures from the old projected telemetry fields to raw provider fields. The present fixture still seeds `cpuPct`, MiB, and `driveUsedMb`. `packages/backend/convex/testing/vmTelemetry.ts:22-60`

**API/web tests**

- Telemetry endpoint keeps its existing member-readable response shape. `apps/api/src/billing.test.ts:806-841`
- Billing history exposes only the narrow `usageKind`.
- Creation and billing-transfer limit errors preserve structured status/body contracts.
- Create dialog and billing-user settings render actionable limit copy.
- Billing history renders “VM compute” only for the tagged usage entry.
- Telemetry geometry stays timestamp-based. `apps/web/spa/settings/telemetry-history-chart.test.ts:5-26`

**Gateway tests**

- Dedicated disk-guard dependency controls write refusal.
- Production sync composition sends no telemetry.
- Runtime builds after sampler and drive-usage deletion.
- Real VM canary verifies boot and drive writes.

**Closeout**

- Run affected package `bun test --changed` sweeps, package type checks, and gateway build.
- Run `ui-playground`, screenshot comparison, and unprimed screenshot critique for the two changed visual surfaces. `AGENTS.md:71-81`
- Run `bun run e2e:staging -- --journey vm-compute-fees`.
- Run the root `bun run test` exactly once before handoff. `AGENTS.md:66-69`, `AGENTS.md:83-93`

## 8. Objections

None. The plan assumes all 22 settled decisions stand, including no allowance, no storage charging, no debt clamp, no VM shrinking, hard telemetry cutover, creation-gated downgrades, and best-effort final teardown charging.
