I read the map, both research probes, the locked UI asset, and walked the code. Plan below.

---

# Per-tier storage — implementation plan (slice ladder)

## 1) Recon facts (measured)

**Contract / caps**
- `packages/contract/src/resources/index.ts:1-5` — `WORKSPACE_VM_CAPS = { cpu: 1, memory: '2GB', disk: '10GB' }`. `disk` at `:4` is the *only* disk default in the repo; `rg '10GB'` finds it plus one test pin (`packages/backend/src/provisioning.test.ts:80`) and the probe default (`packages/exe/scripts/probe-disk-resize.ts:33`). Confirms L7 exactly — two call sites, no third.
- `packages/contract/src/plans/index.ts:11-24` — `SUBSCRIPTION_PLANS` carries only `monthlyPriceMicroUsd` / `monthlyCreditsMicroUsd`. **No storage field exists.** `LOW_CREDIT_WARNING_RATIO = 0.1` at `:31` is a *remaining* ratio (10% left = 90% used) — D13's "mirror" means threshold `0.9` used, arithmetically the complement, not the same constant.
- `packages/contract/src/vm/index.ts:11-20` — `VmTelemetryMetricsSchema` has `diskUsedMb`/`diskTotalMb` and is `.strict()`. `VmSyncResponseSchema` at `:204-226` is `.strip()` (consumer-tolerant, deliberately).
- `packages/contract/src/drive/index.ts:1` — `DRIVE_ROOT_PATH = '/home/synthetic-user/drive'`.
- `packages/contract/src/agent/index.ts:385-391` — a `{ type: 'system', level: 'debug'|'info'|'warn'|'error', message }` turn event already exists, and `classifyAgentTurnEvent` (`:482-497`) classifies `'system'` as **canonical** (durable, replayed in history). D14's "friendly session error event" needs **no new event type**.

**VM creation path**
- `packages/backend/convex/domains/workspaces/vmAttach.ts:157-175` — `workspaceVmCreateOptions()` reads `WORKSPACE_VM_CAPS.cpu/memory/disk` (`:167-169`) directly from the contract; the caller passes only name/image/tags/env. There is no per-workspace disk parameter today.
- `packages/backend/convex/domains/workspaces/vmExe.ts:7` — `WorkspaceVmExe = Pick<ExeClient, 'create'|'list'|'remove'|'setSharePublic'>`. `resize`/`restart` are **not** in the narrowed type; the in-repo fakes (`:35-52`, `:54-67`) implement exactly those four.
- `packages/backend/convex/domains/workspaces/vmAttachModel.ts:42-54` — `workspaceVmAttachPlanImpl` returns `{ imageRef, vmName, vmTokenNonce, attachAllowed }`. It has `workspace` in hand (so `billingUserId` is one `ctx.db.get` away) but does no billing join.
- `packages/backend/convex/schema.ts:193-269` — `workspaces` has `imageRef`, `vmName`, `vmAttachRunId`, `vmTeardownRunId`, `lastTelemetrySampleAt`. **No disk/capacity field.** Index pattern `by_vmAttachRunId` at `:258`.

**exe client**
- `packages/exe/src/exe.ts:288-294` — `resize(name, {cpu,memory,disk})` exists and emits `--disk=<v>` (note `=`-form). `restart` at `:302-304`. `stat` at `:297-299`. `ExeVm.disk_capacity_bytes` at `:45-46`. `list()` at `:318-321` is the only place capacity is observable.
- Probe evidence (`specs/per-tier-storage/research/disk-resize.md:47-54, 111-122`): grow accepted in 650 ms; **equal-size 422s** as hard as shrink; guest fs only after reboot. At 20 GiB raw with 7.3 G used, `df` reported **12 G avail** → filesystem overhead ≈ **0.7 GiB** on top of the 7.2 GiB image (`:86-89`).

**Billing / servicing**
- `packages/backend/convex/domains/credits/subscriptions.ts:68-103` — `reconcileServicingStatus` is the single entitlement→servicing writer. Plan-bearing projection writes end at `:315` (`applySubscriptionLifecycleWithDb`) and `:417` (`applyPaidSubscriptionInvoiceWithDb`); both call it last. `:379` stamps `subscriptionEverActivatedAt` (D5's trial discriminator).
- `packages/backend/convex/domains/credits/billingActions.ts:280-284` — `direction` is derived from `monthlyPriceMicroUsd` comparison; the action itself never touches workspaces. Upgrades ride `always_invoice` → `invoice.paid` → the `:417` path.

**Decommission rail**
- `packages/backend/convex/domains/workspaces/provisioningCore.ts:27` — `SERVICING_ARCHIVE_AFTER_MS = 7d`; `idleRetirementCandidatesImpl` at `:124-191` returns `mode: 'retire_idle'|'archive_paused'|'archive_banned'` (`:184-189`) and **does not project `billingUserId` or trial-ness**.
- `packages/backend/convex/domains/workspaces/provisioningActions.ts:138-150` — the sweep archives **unconditionally** for every candidate with a live VM, *before* branching on mode. `archive_too_large` throws at `:318-323`; `:183-190` is the per-candidate isolation that makes L5's forever-retry real.
- `packages/backend/convex/crons.ts:14-21` — retire sweep runs hourly.

**Gateway**
- `packages/gateway/src/vm/telemetry-sampler.ts:91,98-99` — `statvfs(driveMount)` where `driveMount = config.driveDir` (`runtime/http.ts:473-477`); `diskUsedMb = (blocks - bfree) * frsize`. **Whole-filesystem**, confirming L2 exactly.
- `packages/gateway/src/runtime/http.ts:131-143` — `telemetrySamplerIo` is already an injectable `{readFile, statvfs, sleep}` seam (real impl uses `node:fs statfs`).
- `packagesges/gateway/src/routes/files.ts:105-183` — PUT streams to a temp file then renames; `:99-103` is `POST /actions`. No free-space check anywhere.
- `packages/gateway/src/agent-sessions/coordinator.ts:148-200` — `deliverInput` → `deliverInputUnclaimed` is the single funnel for prompt/answer/wake before `launchRunner`.

**UI**
- `apps/web/spa/routes/user-settings.tsx:341-357` — the plan card's metric grid; `monthlyUsedPercent` computed at `:231-237`. Metrics are **text-only `BillingMetric`s, no bars today.**
- `apps/web/spa/entitlements/low-credit-warning.tsx:22-33` — the toast pattern D10's nudge mirrors: fire-once-per-key `useEffect` + `showToast({message, tone, action})` + server acknowledge.
- `apps/web/messages/en/app.json:27-30` — the `lapsed` wall copy D6 rewrites; `:58-61` the low-credit strings.

**e2e**
- `packages/test-harness/src/staging-e2e-synthetic:74-108` — 12 subscription legs + 11 share legs in `REQUIRED_STAGING_LEGS`. Leg 07 (`staging-e2e-synthetic:479-521`) does the real starter→pro upgrade; leg 11 (`:622-652`) drives `retireIdleWorkspaces` with a forced clock and asserts archive→resume.

**Inference (labelled):** advertised-vs-real headroom. From the 20 GiB probe (`disk-resize.md:86-89`), a 28 GiB disk should yield ≈ 28 − 7.3 (image) − 0.7 (fs overhead) ≈ **19.8 GiB avail on an empty drive**, and a 1 GiB reserve pulls the effective write ceiling to ≈ **18.8 GiB against an advertised 20**. This is arithmetic on measured numbers, not a measurement. Slice 00 measures it.

---

## 2) Slice ladder

Dependency graph:

```
00 ──▶ 01 ──▶ 02 ──▶ 03 ──▶ 04 ──▶ 05
                      │        └──▶ 12
                      └──▶ 06 ──▶ 07 ──▶ 10 ──▶ 11
                             └──▶ 08 ──▶ 09 ──┘
  (05, 11, 12) ──────────────────────────▶ 13
```

---

### 00-resize-rail-probe

**Depends on:** nothing. **Gates:** the entire ladder.

**Why first:** this is the scariest assumption. Everything downstream assumes a *backend-token* `resize`+`restart` on a *Duet-image* VM is survivable. The spike proved resize on a bare VM with a probe token that 403'd on `stat` (`disk-resize.md:126-128`) — it did not prove the token scope we ship with, nor that the lobby share/proxy state survives a reboot, nor the real headroom.

**Contract unlocked:** none — no production code. A probe script + a retained report.

**API seam:** `packages/exe/scripts/probe-tier-disk.ts` + `probe:tier-disk` in `packages/exe/package.json` (mirrors `probe:disk-resize` at `:17`, but env-file `../../.env.staging` like `probe:rail-share-sync` at `:22` so it uses the **staging backend `EXE_TOKEN`**). Owns nothing; reads `ExeClient` only.

**Artifact:** `specs/per-tier-storage/research/tier-disk-rail.md`, retained as evidence.

**Verification — five assertions, all runtime:**
1. **MAP fact 1** — the staging `EXE_TOKEN` accepts `resize` and `restart` (not 403).
2. **MAP fact 2** — after `setSharePublic` + `restart`: `https_url` unchanged in `ls`, and an unauthenticated GET of the gateway's public path behaves as pre-restart (share state survived).
3. **D1 headroom** — create at **28GB** on the real `DUET_VM_IMAGE_REF`; record `df` avail on an empty drive. Report the delta against the advertised 20GB.
4. **MAP fact 4** — `du -sb /home/synthetic-user/drive` wall time on an empty drive and on ~5GB of synthetic files; extrapolate the 100GB cost.
5. **D3 blip** — wall-clock from `resize` call to gateway `/health` answering again, on a VM running the real gateway.

**Delegated:** script structure, file-generation method, whether to reuse `probe-common.ts`.

**Kill criteria:** if (1) fails, the ladder stops until the token is rescoped — a build on a 403 rail is worthless. If (3) shows avail materially under 20GB, **do not silently change D1's 28/58/108** (a given); report the number and let Example User pick the reserve/denominator. If (2) fails, slice 03 needs a re-`setSharePublic`-after-restart step and the blip is longer than D3 assumed.

---

### 01-tier-storage-contract

**Depends on:** 00. **Gates:** 02.

**Contract unlocked:** the tier→disk mapping exists in exactly one place, and no default disk exists anywhere.

**API seam:**
- `packages/contract/src/plans/index.ts` — `SubscriptionPlan` gains `storageGb`; values **20 / 50 / 100** (D1). New exports: `VM_IMAGE_HEADROOM_GB = 8`, `vmDiskGbForPlan(planId): number` (= `storageGb + 8` → 28/58/108), `STORAGE_WARNING_RATIO = 0.9` (D13).
- `packages/contract/src/resources/index.ts` — **delete `disk`** from `WORKSPACE_VM_CAPS`. `cpu`/`memory` stay untouched.
- `packages/backend/convex/domains/workspaces/vmAttach.ts:157-175` — `workspaceVmCreateOptions` gains a **required** `diskGb: number` param; `disk: \`${diskGb}GB\``.

**Ownership:** `plans/index.ts` is the sole owner of tier→disk. Deleting `WORKSPACE_VM_CAPS.disk` in the same rung is what makes it *sole* — leaving it would be exactly the parallel abstraction this bias forbids.

**Runnable artifact:** `bun --cwd packages/contract test` — a table test asserting `vmDiskGbForPlan` for all three plans and that `storageGb + VM_IMAGE_HEADROOM_GB` is the only derivation.

**Verification:** `packages/contract/src/plans/index.test.ts` gains the mapping table. `packages/backend/src/provisioning.test.ts:68-84` flips from `disk: '10GB'` to `disk: '28GB'` **with an explicit `diskGb` argument** (L7). `check-types` green across the monorepo proves no third reader of `WORKSPACE_VM_CAPS.disk`.

**Delegated:** function naming, whether `storageGb` sits on `SubscriptionPlan` or a sibling record (the *values* and the +8 rule are fixed).

**Firewall:** `monthlyPriceMicroUsd`/`monthlyCreditsMicroUsd` untouched — D9 says Max stays $200 and tiers map by name.

---

### 02-birth-at-tier-size

**Depends on:** 01. **Gates:** 03, 06.

**Contract unlocked:** every VM is born at its payer's tier size; the provisioned size is a durable, single-writer fact on the workspace row.

**API seam:**
- `packages/backend/convex/schema.ts` — `workspaces.vmDiskGb: v.optional(v.number())` (raw provisioned GB, not usable).
- **New** `packages/backend/convex/domains/workspaces/vmDiskPolicy.ts` — the D2 owner:
  ```ts
  export function storagePlanForUser(user: Doc<'users'>): SubscriptionPlanId   // free/trial → 'starter'
  export async function desiredVmDiskGb(ctx: QueryCtx, workspace: Doc<'workspaces'>): Promise<number>
  ```
  Pure-ish, reads `workspace.billingUserId` → user → `subscription.plan` → `vmDiskGbForPlan`. **No `Date.now()`, no entitlement logic** — a lapsed Pro still maps to 58 (D4: we never shrink).
- `vmAttachModel.ts:42-54` — `workspaceVmAttachPlanImpl` returns `diskGb` from `desiredVmDiskGb`.
- `vmAttachModel.ts:96-136` — `recordWorkspaceVmAttachImpl` gains `diskGb` and patches `vmDiskGb`. **This and slice 03's recorder are the only two writers of `vmDiskGb`, forever.**
- `vmAttach.ts:115-128` — threads `workspace.diskGb` into `workspaceVmCreateOptions`.

**Runnable artifact:** create a workspace as a Pro payer in the backend test harness; assert the fake exe saw `disk: '58GB'` and the row reads `vmDiskGb: 58`.

**Verification:**
- `packages/backend/src/vm-attach.test.ts` — new cases: trial payer → 28; starter → 28; pro → 58; max → 108. The existing `SUBS-IMPL-07` trio (`:150,158,166`) must stay green byte-for-byte.
- `packages/backend/src/provisioning.test.ts` — the caps pin from 01.
- `bun --cwd packages/backend run codegen` clean.

**Delegated:** field name (`vmDiskGb` vs `vmDiskCapacityGb`), where `storagePlanForUser` physically lives (workspaces vs credits domain) — the *single-owner* property is fixed, the address is not.

**Firewall:** `attachAllowed` semantics unchanged; a paused workspace still never attaches.

---

### 03-resize-action

**Depends on:** 02. **Gates:** 04.

**Contract unlocked:** a resize is an idempotent, single-flight, strict-grow-guarded action that leaves the row truthful. **No caller yet** — this rung is exercised only by tests.

**API seam:**
- `packages/backend/convex/domains/workspaces/vmExe.ts:7` — `WorkspaceVmExe` widens to include `'resize' | 'restart'`; both fakes (`:35-52`, `:54-67`) gain them. The fake's `resize` **must 422 on `desired <= current`** — a fake that accepts everything makes the guard untestable.
- **New** `packages/backend/convex/domains/workspaces/vmDisk.ts` (`'use node'`, mirrors `vmAttach.ts`):
  ```ts
  export const resizeWorkspaceVmDisk = internalAction({ args: { workspaceId } })
  ```
  Sequence: read plan → `exe.list()` → find VM → read `disk_capacity_bytes` → **if `desiredBytes <= currentBytes`, return `{ changed: false }` and still reconcile the row** → `exe.resize(name, { disk: '58GB' })` → `exe.restart(name)` → `recordWorkspaceVmResize`.
- **New** `vmDiskModel.ts` — `recordWorkspaceVmResize` internal mutation: patches `vmDiskGb`, writes `workspace.vm_disk_resized` audit event via `writeAuditEvent`.
- **New** `vmDiskSchedule.ts` — `scheduleWorkspaceVmResize` using `retrier.run` + `vmResizeRunId` + `by_vmResizeRunId` index, a literal copy of the `vmSchedule.ts:13-36` / `schema.ts:228,258` pattern. Single-flight: skip when `vmResizeRunId !== undefined`.

**Ownership:** `vmDisk.ts` is the sole caller of `exe.resize`/`exe.restart` in the repo. `disk_capacity_bytes` from the lobby is the **reconciliation source**, never a second store — the row is truth-of-record and is re-derived from the lobby on every attempt, which is what makes a lost/duplicated resize self-heal (D8).

**Runnable artifact:** `bun --cwd packages/backend test src/vm-disk.test.ts`.

**Verification (new `packages/backend/src/vm-disk.test.ts`):**
- grow 28→58 issues exactly one `resize` then one `restart`, in that order, and records 58;
- **equal size issues zero exe calls** (D4, and the 422 the probe measured at `disk-resize.md:117-122`);
- **smaller desired issues zero exe calls** (D4, downgrades keep the disk);
- a `resize` throw leaves `vmDiskGb` unchanged and does **not** restart;
- a `restart` throw still records the new size (the disk *is* bigger; the guest sees it next boot) — this is the case that makes D8's monthly retry converge instead of oscillating;
- concurrent invocation with a live `vmResizeRunId` is a no-op;
- missing VM in `list()` is a no-op, not a throw (a torn-down workspace must not wedge the sweep).

**Delegated:** action/module names; whether restart is awaited or scheduled; audit event name.

**Firewall:** never calls `exe.remove`. Never writes `status`, `servicingStatus`, or any wallet field.

---

### 04-disk-reconcile-hook

**Depends on:** 03. **Gates:** 12 (ordering only), 05.

**Contract unlocked:** D8 — every subscription projection write reconciles disks, so a failed resize retries at the next renewal with no bespoke sweep.

**API seam:**
- **New** `packages/backend/convex/domains/credits/…` *no* — deliberately in `domains/workspaces/vmDiskPolicy.ts`:
  ```ts
  export async function reconcileWorkspaceVmDisks(ctx: MutationCtx, userId: Id<'users'>, now: number): Promise<void>
  ```
  Iterates `workspaces.by_billing_user` (same index `reconcileServicingStatus` uses at `subscriptions.ts:76-79`), skips `deleted`/`retired`/`archived` and any workspace with no `vmName`, and for each row where `desiredVmDiskGb > vmDiskGb` calls `scheduleWorkspaceVmResize`.
- Two call sites, **as siblings, immediately after** the existing calls: `subscriptions.ts:315` and `subscriptions.ts:417`.

**Ownership + the invariant this protects:** `reconcileServicingStatus` remains the sole entitlement→servicing writer (monthly-subscriptions Invariant 5). `reconcileWorkspaceVmDisks` is a *sibling*, not a caller and not a callee — a disk failure can never move servicing state, and a servicing change can never trigger a resize. Structurally separate loops over the same index is the price of that; pay it.

**Runnable artifact:** replay a captured Stripe `invoice.paid` upgrade fixture (`packages/backend/test-fixtures/stripe-subscriptions/`) and watch one resize schedule appear.

**Verification (`packages/backend/src/billing.test.ts` + `src/vm-disk.test.ts`):**
- starter→pro `invoice.paid` schedules exactly one resize per workspace of that payer;
- a payer with three workspaces schedules three (D12: per workspace, no pooling);
- pro→starter `pendingPlan` lifecycle schedules **zero**;
- a second identical `invoice.paid` (replay) schedules zero (the run-id guard + the grow guard);
- **regression pin:** the `SUBS-IMPL-07` suites in `credits.test.ts:284,412`, `agent-sessions.test.ts:220`, `provisioning.test.ts:456,518,597` and `vm-sync.test.ts:224` all stay green — this is the invariant-5 gate.
- **MAP fact 3** is discharged here: assert the *fake-Stripe* plan-change path (`billingActions.ts:191-305` with `useTestFakeStripe`) also reaches the hook.

**Delegated:** whether the skip decision is computed in the loop or by a projected candidates query.

**Risk this rung owns:** a renewal storm (every payer's monthly invoice fanning out N scheduled actions). The grow-guard means the schedule is skipped when sizes match, so steady-state cost is one `ctx.db.get` per workspace. Verify with a 50-workspace fixture that zero actions schedule when nothing changed.

---

### 05-restart-mid-turn

**Depends on:** 04. **Gates:** 13.

**Contract unlocked:** L4 — an upgrade restart during a live agent turn is a *routine* path, not a crash path. Purely a hardening + test rung; production code changes only if the tests go red.

**Why a whole slice:** `fix73` (turn-lock release on a dead runner) and the boot orphan sweep (`packages/gateway/src/runner/orphan-sweep.ts`) were built for *failures*. D3 makes them fire on every upgrade. If they leak, the user's reward for paying more is a permanently wedged session.

**API seam:** none intended. If red: `packages/gateway/src/agent-sessions/coordinator.ts` recovery path and/or `runner/orphan-sweep.ts`.

**Verification:**
- `packages/gateway/src/gateway.test.ts` — a session with a live runner survives a simulated hard process death + restart: the turn lock is released, the session is not stuck `running`, a subsequent `deliverInput` (`coordinator.ts:148`) is accepted, and the timeline shows a terminal marker rather than a gap.
- `packages/backend/src/agent-sessions.test.ts` — the backend-side session projection reaches a terminal state for a runner that never returns.
- Manual: on a staging workspace, start a turn, run `resizeWorkspaceVmDisk`, confirm the session recovers and the drive is intact.

**Delegated:** whether the restart emits a `{type:'system', level:'warn'}` "workspace restarted to add storage" marker into the timeline. **Recommendation: yes** — it costs one line, uses the event type slice 09 needs anyway, and turns a mystery 15s stall into an explanation.

---

### 06-drive-bytes-telemetry

**Depends on:** 02. **Gates:** 07.

**Contract unlocked:** D11/L2 — a new drive-bytes-only measurement flows gateway → contract → Convex, additive alongside the existing whole-fs fields.

**API seam:**
- **New** `packages/gateway/src/vm/drive-usage.ts` — `createDriveUsageSampler({ driveDir, du, now, ttlMs })` returning `{ read(): Promise<number | undefined> }`. Cached: returns the last value immediately and refreshes out-of-band when older than `ttlMs`; **never blocks the sync poll**, never runs two walks concurrently. `du` is injected (same discipline as `telemetrySamplerIo`, `runtime/http.ts:131-143`).
- `packages/gateway/src/vm/telemetry-sampler.ts:72-101` — `VmTelemetrySamplerDependencies` gains `driveUsedBytes(): Promise<number | undefined>`; `sampleVmTelemetry` emits `driveUsedMb` when defined. `statvfs`-derived `diskUsedMb`/`diskTotalMb` **stay exactly as they are** (they are the fs-health signal and slice 08's guard input).
- `packages/contract/src/vm/index.ts:11-20` — `VmTelemetryMetricsSchema` gains `driveUsedMb: z.number().nonnegative().optional()`. Optional is load-bearing: the schema is `.strict()` and old gateways omit it.
- `packages/backend/convex/domains/workspaces/vmSync.ts:80-89` — the telemetry validator gains `driveUsedMb: v.optional(v.number())`.
- `packages/backend/convex/schema.ts:271-281` — `vmTelemetrySamples.driveUsedMb: v.optional(v.number())`.
- `packages/backend/convex/domains/workspaces/vmTelemetry.ts:161-165` — `averageMetric(bucket, 'driveUsedMb')` added to the downsampler (missing it silently drops the field from every chart read).

**Ownership:** the gateway sampler is the **sole producer** of drive-bytes truth. The backend stores and averages; it never computes drive size. Nothing else in the repo may `du` the drive.

**Runnable artifact:** `bun --cwd packages/gateway test src/vm/drive-usage.test.ts` + the sampler test; then `curl /v1/ws/:slug/telemetry` on staging showing `driveUsedMb: 0` on an empty workspace with `diskUsedMb ≈ 7400`.

**Verification:**
- `drive-usage.test.ts` — cold read; cached read issues no second `du`; a `du` throw yields `undefined` and never rejects; concurrent reads coalesce to one walk; a stale value is served while the refresh runs.
- `packages/gateway/src/vm/telemetry-sampler.test.ts:79-117` — extended; the existing `statvfs:` call-order assertion (`:116`) stays.
- `packages/backend/src/vm-telemetry.test.ts` — persistence + downsample of the new field; a sample **without** `driveUsedMb` still persists (old-gateway tolerance).
- **D11 acceptance:** empty workspace ⇒ `driveUsedMb === 0` while `diskUsedMb > 7000`.

**Delegated:** `ttlMs` (MAP fact 4 measured it in slice 00 — pick from that number), `du -sb` vs a Bun readdir walk, whether the refresh is timer- or read-triggered.

**Firewall:** `diskUsedMb`/`diskTotalMb` semantics unchanged — `telemetry-history-chart.tsx` and `workspace-settings.tsx:419` keep reading what they read.

---

### 07-workspace-storage-read-model

**Depends on:** 06. **Gates:** 10, 11.

**Contract unlocked:** one authoritative read for "how much of this workspace's quota is used" — the single source both UI surfaces consume.

**API seam:**
- `packages/contract/src/workspaces/index.ts`:
  ```ts
  export const WorkspaceStorageSchema = z.object({
    quotaGb: z.number().int().positive(),     // advertised usable: 20 | 50 | 100
    usedBytes: z.number().nonnegative(),
    sampledAt: z.number().nonnegative().optional(),
    plan: SubscriptionPlanIdSchema,           // the tier the quota came from
    nextPlan: SubscriptionPlanIdSchema.optional(),   // powers "Upgrade → 50 GB"
    nextQuotaGb: z.number().int().positive().optional(),
  })
  ```
- **New** `packages/backend/convex/domains/workspaces/storage.ts` — `workspaceStorage` query: `assertRole(viewer)` (same gate as `vmTelemetry.ts:183-199`), joins `desiredVmDiskGb`'s plan resolution to `storageGb`, reads the newest `vmTelemetrySamples` row by `by_workspace_at`.
- **New** `apps/api/src/routes/…` — `GET /v1/ws/:workspaceSlug/storage`, registered in `apps/api/src/index.ts` beside `registerTelemetryRoutes`.
- `apps/web/spa/api/client.ts` + `query-keys.ts` + `query-options.ts` — `workspaces.storage(slug)`.

**Ownership:** this query is the **sole** place quota GB and used bytes meet. The meter, the nudge and the hard-stop copy all read it; none of them recompute. Critically, **it is display-only** — nothing gates on it (see slice 08).

**Runnable artifact:** `curl /v1/ws/:slug/storage` → `{"quotaGb":20,"usedBytes":13312000000,"plan":"starter","nextPlan":"pro","nextQuotaGb":50}`.

**Verification:**
- `apps/api/src/index.test.ts` — member-readable, non-member 403, unknown slug 404, no telemetry sample yet ⇒ `usedBytes: 0` with no `sampledAt`.
- backend query tests: trial payer ⇒ `quotaGb: 20, plan: 'starter'` (D2); max payer ⇒ no `nextPlan`.
- Uses the *payer's* plan, not the viewer's (monthly-subscriptions Invariant 7, tested both directions).

**Delegated:** endpoint path, whether `nextPlan` is derived server- or client-side (**server** recommended: the tier ladder already lives in contract, and the UI shouldn't reimplement it).

---

### 08-disk-full-guard-writes

**Depends on:** 06. **Gates:** 09, 11.

**Contract unlocked:** D14 first half — gateway file writes refuse below a free-space reserve, with a typed error the UI can key on.

**API seam:**
- `packages/contract/src/drive/index.ts` — `export const DRIVE_FREE_SPACE_RESERVE_BYTES = 1024 ** 3` (1 GiB).
- **New** `packages/gateway/src/vm/disk-guard.ts`:
  ```ts
  export interface DiskGuard { ensureWritable(): Promise<'ok' | 'full'> }
  export function createDiskGuard(deps: { statvfs; reserveBytes; ttlMs; now }): DiskGuard
  ```
  Decision is **`bavail * frsize < reserveBytes`** — filesystem free space. Cached with a short TTL so a directory upload doesn't `statvfs` per file.
- `packages/gateway/src/routes/files.ts` — `FilesRouteOptions` gains `diskGuard`; `PUT /*` (`:105`) and the mutating branches of `POST /actions` (`:99`) return `c.json({ error: 'storage_full' }, 507)` before touching the temp file. Reads (`:78-97`) and deletes (`:185-200`) are **never** refused — deleting is the user's escape hatch.
- `packages/contract/src/files/index.ts` — `'storage_full'` added to the file-error union.

**Ownership — the load-bearing seam decision:** the refusal owner is **free space**, not the meter. There is deliberately **no quota accountant**: no per-workspace byte ledger, no `usedBytes > quotaBytes` comparison in any write path. D1's +8GB headroom is exactly what makes "fs free < 1 GiB" ≈ "drive used ≥ advertised quota", so one cheap `statvfs` enforces the product promise. Building a second quota-enforcement path would be the parallel abstraction a later slice has to delete — and it would also be *wrong*, because the thing that actually wedges the VM (L1: shell writes, PGlite `memory.db`, gateway logs) is fs space, not drive bytes.

Correspondingly, **no `VmSyncResponse` field is added.** The reserve is a contract constant; the gateway never learns tiers or plans. (Considered and rejected: shipping `storage: { quotaBytes, reserveBytes }` down the sync response. It would give the gateway a second, staler copy of a number slice 07 already owns.)

**Runnable artifact:** `bun --cwd packages/gateway test src/routes/files.test.ts` plus a live curl against a filled staging drive returning 507.

**Verification:**
- guard unit: below reserve ⇒ `'full'`; exactly at ⇒ `'ok'`; `statvfs` throw ⇒ **`'ok'`** (fail-open — a broken probe must not brick the drive; D14 is explicitly best-effort);
- route: PUT below reserve ⇒ 507 `storage_full` **and no temp file left in `tempDir`**; GET/list/DELETE unaffected; `/actions` copy/move refused, rename allowed (rename frees nothing but consumes nothing);
- `packages/gateway/src/routes/files-symlinks.test.ts` and `files-events.test.ts` stay green — the guard runs before the symlink discipline and must not reorder it.

**Delegated:** the exact 507-vs-413 status (507 recommended: semantically "insufficient storage", and no existing handler claims it), TTL, whether `/actions` refuses per-op or wholesale.

**Firewall:** L1 is *accepted*, not fixed — agent shell writes still bypass this. Do not attempt cgroup/quota enforcement here; there is no `prjquota` on the image (MAP Q1).

---

### 09-disk-full-guard-turns

**Depends on:** 08. **Gates:** 11.

**Contract unlocked:** D14 second half — the gateway refuses to *start* a turn below the reserve and says so in the session, instead of letting an agent run into ENOSPC.

**API seam:**
- `packages/gateway/src/agent-sessions/coordinator.ts:156` — `deliverInputUnclaimed` consults `diskGuard.ensureWritable()` **before** `ensureSessionEnvelope`/`launchRunner`. On `'full'`: emit `{ type: 'system', level: 'error', message: <storage-full copy> }` into the session buffer (canonical per `agent/index.ts:482-497`, so it lands in durable history) and return without launching.
- `AgentSessionsControllerOptions` gains `diskGuard`.

**Ownership:** the same `DiskGuard` instance as slice 08 — one object, two consumers. No second free-space read anywhere.

**Runnable artifact:** a gateway test that fills the fake fs, posts a prompt, and shows the session timeline containing the system error with **no runner process spawned**.

**Verification:**
- below reserve ⇒ zero `runnerFactory` calls, one canonical system/error event, delivery reported as accepted-and-terminal (never a 500 and never a silent drop);
- **no mid-turn killing** — a turn already running when space drops keeps running (D14 explicit);
- the accepted-through-seq bookkeeping stays consistent so `fix64`'s pending-input drain (`vmSync.ts:201`) doesn't re-deliver forever;
- above reserve ⇒ the existing launch path is byte-identical.

**Delegated:** whether the refusal also terminalizes the session or leaves it idle (**idle** recommended — the user deletes a file and retries in the same session).

**Firewall:** does not touch `authorizeSpend`, `creditsShared.ts`, or any block code. `storage_full` is a **new, distinct** name — never reuse `subscription_required` / `subscription_inactive` (Invariant 5).

---

### 10-storage-meter

**Depends on:** 07. **Gates:** 11.

**Contract unlocked:** UI surface A — the plan card shows real GB.

**Preflight:** invoke `ui-playground` first (AGENTS.md), then `screenshot-critique` + `compare-screenshots`.

**API seam:**
- **New** `apps/web/components/playground/storage-surfaces-playground.tsx` — all three surfaces (A/B/C) on fixed fake data, so 10 and 11 share one visual gate and one baseline.
- `apps/web/spa/routes/user-settings.tsx:341-357` — a `Storage` row in the existing metric grid, reading `duetQueryOptions.workspaces.storage(...)`; value `"12.4 GB of 20 GB"`, plus a proportional bar per the asset (`storage-ui-directions.html:48-49`).
- `apps/web/messages/{en,es-419}/app.json` — `duetSettings.user.billing.storage*`.

**Which workspace:** the billing settings page is user-scoped and already picks `billing.data.workspaces[0]` for every mutation (`user-settings.tsx:148,162,170,181,191`). D12 is per-workspace, so the meter must name the workspace it describes. **Recommendation:** one meter row per workspace when the payer has more than one; single unlabelled row otherwise. Flag to Example User — this is the one place D12 collides with an account-scoped page.

**Runnable artifact:** `/playground` panel + the settings page at 0 GB, 12.4/20, and 19.6/20.

**Verification:** unit test for the GB formatter (1 decimal, `0 GB` at zero, GiB-vs-GB convention stated once); a settings-page test asserting the storage row renders from the query and is absent while pending; playground screenshots approved via the visual gate.

**Delegated:** bar styling, exact label text within the locked direction.

**Firewall:** credits stay **%-only** (monthly-subscriptions D12 — money never gets a dollar figure). Whether the *credits* row also gains a bar is a pure-visual question for `screenshot-critique`; the asset shows one, and a bar is not a dollar figure, so it is permitted but not required.

---

### 11-nudge-hardstop-and-decommission-copy

**Depends on:** 07, 08, 09, 10. **Gates:** 13.

**Contract unlocked:** UI surfaces B and C, plus D6's copy.

**API seam:**
- **New** `apps/web/spa/entitlements/storage-warning.tsx` — modelled directly on `low-credit-warning.tsx:22-33`: fires once per (workspace, threshold-crossing), `tone: 'warning'`, action → `/settings/billing`. Threshold `usedBytes / (quotaGb * 1024³) >= STORAGE_WARNING_RATIO` (D13, from slice 01). Re-arms when usage drops back below or the quota grows.
- Hard-stop: the SPA's file-write error handling maps `storage_full` → an error toast with the surface-C copy, rendering GB from the slice-07 read. Max-tier users get no upgrade CTA.
- **D6 copy:** `apps/web/messages/en/app.json:27-30` (`lapsed.body`) and the sibling trial/wall entries gain the plain sentence *"your workspace and all its files will shut down in 7 days"* — no download coaching. Mirror in `es-419`. Also `apps/web/spa/entitlements/subscribe-wall.tsx` and `apps/web/components/playground/edge-paused-page-playground.tsx`.

**⚠️ Coordination (L6):** `subscribe-wall.tsx`, `edge-paused-page-playground.tsx` and `messages/en/app.json` are all **currently dirty in the working tree** from apps-in-file-view. Build this ladder on a clean branch cut after that lands, and re-check this rung's diff against it before merging.

**Runnable artifact:** playground panels B and C; a live 507 from staging producing the toast.

**Verification:**
- warning fires once at 90%, not at 89%, not twice; re-arms after an upgrade;
- no nudge on the Max tier;
- hard-stop toast renders on `storage_full` and not on other file errors;
- `apps/web/spa/entitlements/subscribe-wall.test.tsx` updated for the new copy, **both viewer directions still asserted** (Invariant 7);
- visual gate for B and C.

**Delegated:** dismiss/persistence mechanics (the low-credit rail acknowledges server-side; storage may stay client-only — recommended, since there's no period key to anchor an acknowledgement to).

---

### 12-sweep-branching

**Depends on:** 04 (ordering; technically only needs 02). **Gates:** 13.

**Contract unlocked:** D5 — the day-7 sweep decides *before* archiving whether an archive is owed, and an oversize archive stops retrying forever (L5).

**API seam:**
- `packages/backend/convex/domains/workspaces/provisioningCore.ts` — two pure exports, the **decommission-policy owner**:
  ```ts
  export function retireDisposition(input: { mode; everSubscribed: boolean }): { archive: boolean }
  export function dispositionAfterArchiveFailure(errorCode: string): 'teardown' | 'retry'
  ```
- `idleRetirementCandidatesImpl` (`:124-191`) joins each candidate's `billingUserId` → `billing.subscriptionEverActivatedAt` and projects **`archive: boolean`** alongside `mode`.
- `provisioningActions.ts:138-150` — the sweep archives **only when `candidate.archive === true`**; today it archives unconditionally. On a thrown `archive_too_large` (`:318-323`) it consults `dispositionAfterArchiveFailure` and, for `'teardown'`, proceeds to `markServicingArchived` with `archiveStorageId: undefined` instead of falling into the catch at `:183-190`.
- `markServicingArchivedImpl` (`provisioningCore.ts:193-233`) already accepts an optional `archiveStorageId`; the resulting `archived` row simply has nothing to restore. **Check with Example User:** an archived-without-archive row is resumable-into-empty; if he'd rather it read `retired`, that's a one-line change and a distinguishable audit event. Flag, don't decide.

**Ownership:** the candidates *query* classifies (policy), the *action* executes (mechanism). The action never re-derives trial-ness. Both policy functions live in one module so "what do we owe a decommissioned workspace" has one address.

**Runnable artifact:** `bun --cwd packages/backend test src/provisioning.test.ts src/archive-upload.test.ts`.

**Verification:**
- trial payer, 7-day pause ⇒ **zero** `/v1/vm/archive` fetches, VM torn down, distinct audit event;
- subscriber, small drive ⇒ today's behavior, byte-identical — **`provisioning.test.ts:518` (`SUBS-IMPL-07 archives a seven-day pause and resumes from the same files`) stays green unmodified**, which is the whole gate on this rung;
- subscriber, oversize ⇒ one archive attempt, then teardown; a **second** sweep pass finds the workspace gone, not retried (the L5 fix, asserted by call count);
- an unrelated archive failure (network) still retries (isolation at `:183-190` preserved);
- `retireDisposition` table test over `mode × everSubscribed`.

**Delegated:** audit event names; whether the trial branch skips the `/v1/vm/archive` fetch entirely (it must) or short-circuits inside `archiveWorkspaceFromVm` (it must not — keep that function ignorant of policy).

**Documentation obligation (L8):** annotate `specs/archive-offload/README.md:47-48` — slice `00-trial-skip` is **built here**; delete it from that ladder so it is never built twice.

---

### 13-staging-wipe-and-close

**Depends on:** 05, 11, 12. **Gates:** nothing.

**Contract unlocked:** D7 — the staging fleet is recreated at tier sizes with no migration code, and the live e2e proves the rail.

**API seam:** none. Operational + harness.

**Steps:**
1. **Wipe** every staging workspace and its VM. D7 is explicit: *no migration/catch-up code for pre-tier 10GB VMs.* Do not write a backfill; the absence of one is the deliverable. (Verify no orphan VMs remain via `exe ls` — the pool is billed on written bytes, `disk-billing.md:5`.)
2. **Fresh provisions** land at 28GB and report `driveUsedMb: 0`.
3. **New harness leg** `storage-tier-resize` in `packages/test-harness`, added to `SUBSCRIPTION_LIFECYCLE_LEGS` / `REQUIRED_STAGING_LEGS` (`staging-e2e-synthetic:74-108`): after leg 07's real starter→pro upgrade, poll `exe ls` for `disk_capacity_bytes === 58 GiB`, poll `/v1/ws/:slug/storage` for `quotaGb === 50`, and confirm the workspace returns to `active` with a working `https_url` (MAP fact 2, live). **Adding a required leg is a Example User call** — propose it, don't assume it.
4. **`bun run e2e:staging`** (~12 min, real Stripe test objects) — with Example User's approval, per AGENTS.md.
5. Close: fold the durable *why* into `specs/done/per-tier-storage/README.md`, move the spec, prune intermediate captures.

**Verification — the full 52-leg run green.** See §5 for the leg-by-leg exposure.

**Delegated:** wipe mechanics (convex import vs targeted deletes — the staging-drift memo says strip/delete records, no migrations), capture retention.

---

## 3) Seams and ownership map

| Concern | **Single owner** | Address | Everyone else |
|---|---|---|---|
| **Disk-size truth** (raw provisioned GB) | `workspaces.vmDiskGb` row field | written **only** by `vmAttachModel.recordWorkspaceVmAttach` (birth) and `vmDiskModel.recordWorkspaceVmResize` (growth) | reads the row. `ExeVm.disk_capacity_bytes` (`exe.ts:45-46`) is a *reconciliation input* read inside `vmDisk.ts`, never a second store |
| **Drive-usage truth** (bytes under `/home/synthetic-user/drive`) | gateway `vm/drive-usage.ts` sampler | one cached `du`; emitted as `driveUsedMb` in the vm-sync telemetry payload | backend stores/averages it. Nothing else may walk the drive for size |
| **Tier → disk mapping** | `packages/contract/src/plans/index.ts` | `storageGb` + `VM_IMAGE_HEADROOM_GB` + `vmDiskGbForPlan` | `WORKSPACE_VM_CAPS.disk` is **deleted**. D2's free/trial→starter fallback is `vmDiskPolicy.storagePlanForUser`, the one place a missing subscription becomes a tier |
| **Decommission policy** | `provisioningCore.retireDisposition` + `dispositionAfterArchiveFailure` | classified in the candidates *query*, executed by the sweep *action* | `archiveWorkspaceFromVm` stays policy-blind; the action never re-derives trial-ness |
| **Disk-full refusal** | gateway `vm/disk-guard.ts` (`DiskGuard`) | one `statvfs`-derived free-space decision vs `DRIVE_FREE_SPACE_RESERVE_BYTES` | file routes (08) and the session coordinator (09) *ask* it. **No quota accountant exists** — the meter's GB never gates anything |

**Package boundaries**

- `@repo/contract` — tiers, GB values, the +8 rule, the reserve constant, wire schemas. Pure, no I/O, isolate-safe.
- `@repo/exe` — already complete (`resize`/`restart`/`disk_capacity_bytes` landed in the spike). **This ladder adds nothing to it.**
- `packages/backend` — sizing decisions, the row of record, the reconcile hook, the sweep. Never measures bytes.
- `packages/gateway` — measures bytes, enforces free space. **Never learns a plan, a tier, or a quota.** This asymmetry is the strongest seam in the plan: it means a pricing change ships without a gateway release, and the gateway's guard keeps working on a VM whose backend is mid-deploy.
- `apps/api` — one new read route; no logic.
- `apps/web` — display only; every number comes from `/v1/ws/:slug/storage`.

**Parallel-abstraction audit** (bias requirement — confirmed no slice builds something a later slice deletes):

- 01 *deletes* `WORKSPACE_VM_CAPS.disk` in the same rung that introduces `vmDiskGbForPlan`. No overlap window.
- 06 *adds* `driveUsedMb` beside `diskUsedMb` rather than redefining it — these are genuinely two measurements with two consumers (the meter; the guard). Not a duplicate.
- 07's read model is display-only and 08's guard is fs-only, so no rung ever needs to reconcile them.
- 08 explicitly declines a `VmSyncResponse.storage` field, so no wire copy of the quota is ever created and then removed.
- 12 replaces the unconditional archive with a branch; it does not add a second sweep.
- The only thing 13 removes is *data*, not code.

---

## 4) Firewalls — what must NOT change

1. **One monthly-grant door.** No rung touches `wallet.ts`, `SUBSCRIPTION_PLANS[*].monthlyCreditsMicroUsd`, or any grant path. Adding `storageGb` to the plan record must not become a second reason to write a ledger row.
2. **Wallet single-writer.** No slice mutates `paidCreditBalanceMicroUsd` / `monthlyCreditBalanceMicroUsd`.
3. **`reconcileServicingStatus` ownership.** `reconcileWorkspaceVmDisks` is a *sibling call* at `subscriptions.ts:315` and `:417` — never nested inside, never a caller of it. It writes `vmDiskGb` and `vmResizeRunId` only. A resize failure must be invisible to servicing state.
4. **Block codes stay distinct.** `subscription_required` (account entitlement) and `subscription_inactive` (workspace servicing) are untouched; storage refusal is a new `storage_full`. Do not extend `blocks.ts`.
5. **`archive_too_large`** keeps its name and its 1GB constant (`provisioningActions.ts:318-323`) — the harness and the archive-offload spec both reference it.
6. **Per-candidate sweep isolation** (`provisioningActions.ts:183-190`) survives 12 intact.
7. **Grow-only, strictly.** Every `exe.resize` call passes `desiredBytes > currentBytes`, from the lobby's own reported capacity. Equal-size is a 422 (`disk-resize.md:117-122`) — assert it in the fake, not just in a comment.
8. **No shrink, ever, anywhere** — including `cp --disk` (also 422, `:129-134`).
9. **No migration code (D7).** Do not write a backfill for 10GB VMs. Their absence is verified by the staging wipe.
10. **`WORKSPACE_VM_CAPS.cpu` / `.memory`** unchanged; `resize` never passes `--cpu`/`--memory`.
11. **`VmSyncResponseSchema` stays `.strip()`** and `VmTelemetryMetricsSchema`'s new field stays **optional** — an old gateway must keep syncing.
12. **Credits stay %-only** in the plan card; storage is the only surface showing real units.
13. **Deletes are never refused** by the disk guard — it is the user's only unassisted way out of a full drive.
14. **L1 stays accepted.** No cgroup/quota/fs-enforcement attempt on agent shell writes.

---

## 5) Risks and open questions

**R1 — Advertised 20 GB may not be reachable (highest product risk).** Measured overhead on a 20 GiB VM was ≈0.7 GiB of fs metadata on top of the 7.3 GiB image (`disk-resize.md:86-89`). *Inference:* a 28 GiB disk yields ≈19.8 GiB avail empty, and a 1 GiB reserve makes the effective ceiling ≈18.8 GiB against an advertised 20. **Slice 00 measures this on a real Duet-image 28GB VM.** D1 (28/58/108) is a given, so the tunables are the reserve size and whether the meter's denominator is advertised or measured. If the gap is >1 GB, this is a Example User decision before slice 10 ships a number.

**R2 — Restart mid-turn becomes routine (L4).** Owned by slice 05. The failure mode is a silently wedged session at exactly the moment a user pays more money. Slice 05 is deliberately test-only-until-red.

**R3 — `du` cost on large drives (MAP fact 4).** A synchronous walk on a 100 GB drive would stall the 5s sync poll. Mitigated structurally: `drive-usage.ts` is cache-first and non-blocking by construction, and the cadence comes from slice 00's measurement.

**R4 — Renewal fan-out.** `reconcileWorkspaceVmDisks` on every projection write across the fleet. Guarded by the grow-check (a no-op read when sizes match) plus the `vmResizeRunId` single-flight. Pinned by a 50-workspace zero-action test in slice 04.

**R5 — Pool overage (L3).** Every VM burns ~7.2 GB of the 100 GB pooled allotment by existing (`disk-billing.md`: 14 VMs → 89.75 GB counted). At ~$0.58/workspace/mo the pool overflows past ~14 VMs today, and larger *provisioned* disks don't add to it (consumption billing) but larger *used* disks will. Not a code risk — an awareness item, plus MAP's suggested email to exe.dev about image-layer dedup.

**R6 — Hot working tree (L6).** `subscribe-wall.tsx`, `edge-paused-page-playground.tsx` and `messages/en/app.json` are dirty right now from apps-in-file-view. Slice 11 must rebase onto a clean branch.

**R7 — MAP fact 2 unverified.** The spike kept `https_url` across a reboot but never re-checked `set-public`. If share state doesn't survive, slice 03 needs a re-`setSharePublic` after every restart. **Slice 00 settles it before any code is written.**

**R8 — Staging fake-Stripe path (MAP fact 3).** `billingActions.ts` swaps in `fakeSubscriptionStripe` (`:307`) when no secret is present; if that path never produces a projection write, the hook never fires in fake-Stripe environments. Discharged by an assertion in slice 04.

**Open questions for Example User** (none block the start; each blocks a specific rung):

- **Q1 (blocks 10):** the billing settings page is account-scoped but the quota is per-workspace (D12). One meter row per workspace, or a single row for the primary? Recommendation: per-workspace when >1.
- **Q2 (blocks 12):** a workspace decommissioned *without* an archive — row status `archived` (resumable into empty) or `retired`? Recommendation: `retired` for the trial branch; it's honest, and `archived` implies restorable bytes.
- **Q3 (blocks 13):** add `storage-tier-resize` to `REQUIRED_STAGING_LEGS`? Recommendation: yes — the resize rail has no other live coverage.
- **Q4 (blocks 11):** does the credits row also get a bar (the asset shows one)? Pure visual; the D12 money restraint is about figures, not bars.

**Staging e2e legs affected**

| Leg | Exposure |
|---|---|
| `subscription-07-upgrade-and-portal` (`staging-e2e-synthetic:479-521`) | **Highest.** The real starter→pro upgrade now triggers resize + restart. The existing `pollOverview` will race the ~15s blip. Extend, don't just hope. |
| `subscription-08-downgrade-scheduled` (`:523`) | Must prove **zero** exe calls (D4). Silent-regression risk: a 422 here would surface as a sweep error, not a leg failure. |
| `subscription-11-full-stop-archive-resume` (`:622-652`) | D5's subscriber ≤1GB branch. The bounded sweep-retry loop at `:628-651` still works, but a mis-branch turns the archive into a teardown and the leg fails at `:669-675`. |
| `subscription-02-exhaustion-wall-pause` | D6 copy change; any text assertion on the wall needs updating. |
| `subscription-03/04-checkout/activation-resume` | First workspaces born at 28 GB; a reprovision after resume must re-derive the size. |
| `agent-continuity`, `build-app` | Indirect — slice 08/09's guard sits in front of every file write and every turn start. A fail-closed bug here fails both legs. |
| `share-file-arrival`, `share-byte-arrival` | Indirect — Syncthing writes land through the drive; the guard must not refuse them (it doesn't touch that path, but confirm). |

---

**Where to start:** slice 00, and treat it as a gate rather than a formality — it decides whether D3's mechanic, D1's arithmetic, and the shipping token scope are all real at once. Nothing else in this ladder is worth writing until it reports.
