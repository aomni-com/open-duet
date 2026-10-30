# Per-tier storage implementation plan

Marker: `draft-a-tier-storage`

## 1) Recon facts

### Binding behavior

- The storage catalog is fixed at 20/50/100GB usable and 28/58/108GB raw. Every VM is created at 28GB, including paid workspaces; growth is only 28→58→108, followed immediately by restart. Equal-size and downgrade reconciliation are strict no-ops (`specs/per-tier-storage/MAP.md:9-18`, `specs/per-tier-storage/MAP.md:65-78`).
- Day-7 retention has three fixed outcomes: never-subscribed trial data is discarded, subscriber archives at or below 1GB remain resumable, and subscriber archives above 1GB are discarded rather than blocking teardown (`specs/per-tier-storage/MAP.md:24-32`).
- Storage presentation is per workspace, counts only bytes under the drive directory, warns at 90%, and uses best-effort free-space admission rather than a filesystem quota (`specs/per-tier-storage/MAP.md:65-78`).
- Staging is intentionally wiped; no migration, backfill, or compatibility path for existing 10GB VMs is permitted (`specs/per-tier-storage/MAP.md:34-38`).
- The retained provider probe established that resize is grow-only, is not guest-visible until restart, and preserves file contents. Equal and smaller resize requests return 422 (`specs/per-tier-storage/research/disk-resize.md:83-121`).
- Exe bills consumed disk blocks rather than the maximum provisioned capacity, so larger tier disks do not by themselves consume their full nominal capacity (`specs/per-tier-storage/research/disk-billing.md:1-7`).

### Current control plane

- `SUBSCRIPTION_PLANS` currently owns plan IDs, prices, and monthly credits, but no storage values. Max is already $200/month (`packages/contract/src/plans/index.ts:3-24`).
- VM resources independently hard-code a single `disk: '10GB'` setting (`packages/contract/src/resources/index.ts:1-5`).
- VM attach resolves a plan, lists the deterministic provider VM, and creates one if necessary (`packages/backend/convex/domains/workspaces/vmAttach.ts:56-75`, `packages/backend/convex/domains/workspaces/vmAttach.ts:99-128`). Creation always consumes the flat resource disk value (`packages/backend/convex/domains/workspaces/vmAttach.ts:157-174`).
- The attach plan contains VM identity and servicing permission, but no desired disk (`packages/backend/convex/domains/workspaces/vmAttachModel.ts:42-53`). Attach recording persists provider identity but no raw capacity (`packages/backend/convex/domains/workspaces/vmAttachModel.ts:96-135`).
- The workspace schema has VM connection fields but no current-capacity or resize-progress field (`packages/backend/convex/schema.ts:193-269`).
- The provider client already exposes `disk_capacity_bytes`, `resize()`, and `restart()` (`packages/exe/src/exe.ts:35-47`, `packages/exe/src/exe.ts:284-304`).
- Backend deliberately narrows that client behind `WorkspaceVmExe`; its production adapter and fakes currently omit resize, restart, and mutable provider capacity (`packages/backend/convex/domains/workspaces/vmExe.ts:7-24`, `packages/backend/convex/domains/workspaces/vmExe.ts:34-66`).
- The existing disk probe already creates, grows, restarts, verifies a checksum, and exercises equal/shrink failures (`packages/exe/scripts/probe-disk-resize.ts:60-73`, `packages/exe/scripts/probe-disk-resize.ts:97-161`). It does not yet prove that the deployed staging token can perform both commands or that public gateway reachability survives restart.

### Subscription and entitlement ownership

- Subscription lifecycle projection writes finish by calling `reconcileServicingStatus` (`packages/backend/convex/domains/credits/subscriptions.ts:266-316`). Paid-invoice projection follows the same pattern after the monthly grant (`packages/backend/convex/domains/credits/subscriptions.ts:319-418`).
- Upgrades are immediate Stripe changes; downgrades are stored as pending until period end (`packages/backend/convex/domains/credits/billingActions.ts:265-303`). Therefore desired disk must derive from the accepted current subscription projection, never `pendingPlan` or price comparison.
- `reconcileServicingStatus` is the sole owner of entitlement-driven pause/resume effects and session terminalization (`packages/backend/convex/domains/credits/subscriptions.ts:68-103`).
- The shipped subscription invariants require one `invoice.paid` grant door, wallet-only balance mutation, derived entitlement, exclusive servicing ownership, distinct block codes, and payer-derived wall state (`specs/done/monthly-subscriptions/README.md:103-137`).
- Workspace birth records the payer and derives servicing state atomically (`packages/backend/convex/domains/workspaces/birth.ts:57-82`, `packages/backend/convex/domains/workspaces/birth.ts:95-105`). A missing subscription can therefore map to Starter storage without another persisted entitlement flag.
- The test-only subscription fixture also projects a subscription and invokes servicing reconciliation; it must exercise the same disk-reconcile seam as production (`packages/backend/convex/testing/workspaces.ts:243-293`).

### Retirement and archive behavior

- The day-7 candidate rail selects paused and banned workspaces after `SERVICING_ARCHIVE_AFTER_MS` (`packages/backend/convex/domains/workspaces/provisioningCore.ts:124-190`).
- The current executor attempts to archive every candidate with a VM before committing retirement, with failures isolated per workspace for later retry (`packages/backend/convex/domains/workspaces/provisioningActions.ts:107-194`).
- Declared archives above 1GB currently throw `archive_too_large` (`packages/backend/convex/domains/workspaces/provisioningActions.ts:284-342`). Consequently an oversized paused subscriber currently retries indefinitely instead of reaching teardown.
- The gateway currently materializes the tar response as a `Uint8Array`, so a reliable oversized branch also needs to remove the full-memory archive path (`packages/gateway/src/runtime/http.ts:551-570`).
- SUBS-IMPL-07 already pins subscriber archive/resume with preserved file contents (`packages/backend/src/provisioning.test.ts:518-595`).

### Storage observation and admission

- Existing VM telemetry reports CPU, memory, and whole-filesystem `diskUsedMb`/`diskTotalMb`; it has no drive-only measurement (`packages/contract/src/vm/index.ts:11-25`, `packages/contract/src/vm/index.ts:65-93`).
- The gateway calls `statvfs` on the drive path, but derives usage from the filesystem’s total/free block counters. That is operational filesystem use, not the recursive bytes beneath the drive directory (`packages/gateway/src/vm/telemetry-sampler.ts:72-100`).
- VM sync validates and persists only those existing metrics (`packages/backend/convex/domains/workspaces/vmSync.ts:73-89`, `packages/backend/convex/schema.ts:271-281`).
- Gateway observations run on every sync poll, while durable telemetry admits a sample every five minutes (`packages/gateway/src/runtime/http.ts:473-477`, `packages/backend/convex/domains/workspaces/vmTelemetry.ts:10-18`). A recursive drive walk therefore needs caching and single-flight behavior.
- File PUT writes through a temporary file with no reserve check (`packages/gateway/src/routes/files.ts:99-183`). The actions surface separately implements mkdir, symlink, delete, move, and copy (`packages/gateway/src/routes/files.ts:498-668`).
- New agent execution is centralized immediately before runner startup in `AgentSessionCoordinator` (`packages/gateway/src/agent-sessions/coordinator.ts:283-340`, `packages/gateway/src/agent-sessions/coordinator.ts:394-414`). That is the narrow boundary for “no new turns”; checking `process-runner` would be too low-level.
- Agent contracts already support error-level system events, while canonical system steps are renderable in the normal session projection (`packages/contract/src/agent/index.ts:335-439`, `packages/contract/src/agent/index.ts:482-528`, `apps/web/spa/sessions/projection/index.ts:314-321`).

### Billing and UI

- The billing overview already returns all payer workspaces, but only as ID, slug, and name (`packages/contract/src/billing/index.ts:58-62`, `packages/backend/convex/domains/credits/userBilling.ts:40-101`).
- Billing settings already contains the current plan card and percent-only credit meter (`apps/web/spa/routes/user-settings.tsx:243-369`).
- The low-credit pattern is a dismissible billing CTA toast mounted at the application root (`apps/web/spa/entitlements/low-credit-warning.tsx:10-35`, `apps/web/spa/root.tsx:220-235`).
- Current subscribe-wall copy promises that everything is saved, which is incompatible with both trial teardown and oversized-subscriber teardown (`apps/web/messages/en/app.json:17-45`).
- The locked direction has exactly three surfaces: a real-GB plan-card meter, a dismissible 90% nudge, and a storage-full error (`specs/per-tier-storage/assets/storage-ui-directions.html:42-69`).

### Existing live acceptance

- The staging subscription journey names twelve ordered legs (`packages/test-harness/src/staging-e2e-synthetic:70-87`).
- Existing relevant legs cover trial pause/wall, checkout/resume, Pro upgrade, scheduled downgrade, period-end lapse, and subscriber archive/resume (`packages/test-harness/src/staging-e2e-synthetic:250-371`, `packages/test-harness/src/staging-e2e-synthetic:479-698`).
- The separate continuity journey already exercises real reboot recovery (`packages/test-harness/src/staging-e2e-synthetic:183-223`).

---

## 2) Slice ladder

```text
01-tier-capacity-lifecycle
              ↓
02-storage-truth-and-admission
              ↓
03-locked-ui-and-live-cutover
```

Three slices is the smallest safe ladder:

- D5 stays in slice 01 because it changes the same VM lifecycle/decommission rail as birth and resize.
- Drive measurement and reserve enforcement stay together in slice 02 because both require one gateway-owned storage-state boundary.
- All presentation and live cutover work stays in slice 03 so there is one visual review and staging acceptance rung.

### 01-tier-capacity-lifecycle

#### Contract unlocked

- Starter/Pro/Max advertise 20/50/100GB and map to raw 28/58/108GB.
- Every VM is first created at 28GB.
- A workspace whose accepted plan requires more capacity grows in place and restarts immediately.
- Same-size, downgrade, duplicate, and stale reconciliation never call provider resize.
- Subscription projection and VM attachment both eventually retry incomplete growth.
- Day-7 retention implements all three D5 outcomes without changing subscription ownership.

This slice begins with the scariest-assumption gate: extend and run the real staging resize probe before production implementation. It must prove the deployed `EXE_TOKEN` can resize and restart, preserve a checksum, retain the stable `https_url`, and restore unauthenticated public proxy access. Failure stops the slice.

#### API seam, modules, types, and ownership

**Plan catalog**

Proposed extension of `packages/contract/src/plans/index.ts`:

```ts
type SubscriptionPlan = {
  // existing price and credit fields
  usableStorageGb: 20 | 50 | 100
  vmDiskGb: 28 | 58 | 108
}
```

This becomes the single mapping from plan name to advertised/raw storage. `WORKSPACE_VM_CAPS` stops owning a parallel disk policy; it retains CPU and memory only.

**Workspace capacity state**

Proposed optional workspace fields in `schema.ts`:

```ts
vmDiskGb?: 28 | 58 | 108          // confirmed guest-visible raw capacity
vmDiskResizeTargetGb?: 58 | 108   // unfinished grow/restart target
vmDiskResizeClaimedAt?: number     // stale-stealable concurrency claim
```

`vmDiskGb` describes the attached VM, not entitlement. VM teardown clears all three with the existing connection fields. A recreated VM therefore always returns to 28GB before reconciliation, satisfying D2.

**Disk policy/model**

Proposed isolate-safe owner: `domains/workspaces/vmDiskModel.ts`.

Responsibilities:

- Resolve desired raw size from the payer’s accepted current subscription, defaulting to Starter.
- Identify attached workspaces whose desired size is strictly greater than confirmed/provider capacity.
- Create one stale-stealable claim and schedule the node action.
- Never patch servicing state, credits, subscription projections, or provider data.

**Provider action**

Proposed node owner: `domains/workspaces/vmDiskActions.ts`.

Algorithm:

1. Re-read workspace identity, payer projection, desired target, and current claim.
2. List the provider VM and read `disk_capacity_bytes`.
3. If provider capacity is below desired, call `resize`.
4. Persist/recover `vmDiskResizeTargetGb`, then call `restart`.
5. Wait for readiness, reassert public sharing, and verify the current VM identity.
6. Record confirmed capacity and clear progress state.
7. If provider capacity is already at the pending target but confirmed capacity is lower, skip equal resize and redo restart/readiness before recording.
8. If desired is equal or lower than provider/confirmed capacity, clear stale work and return without resize or restart.

This covers the crash windows both after resize and after restart. A repeated restart is acceptable; an equal-size resize is not.

`WorkspaceVmExe` gains capacity-aware `list`, `resize`, and `restart` operations. Its fake tracks provider capacity and supports injected failures.

**Birth and attachment**

`workspaceVmCreateOptions` always emits `disk: '28GB'`, regardless of plan. `recordWorkspaceVmAttach` records 28GB and schedules disk reconciliation after the identity is durable. Thus a Pro or Max workspace is born at 28GB and then grows through the same idempotent action.

**Subscription integration**

Call disk reconciliation adjacent to—never inside or instead of—`reconcileServicingStatus` after:

- lifecycle subscription projection,
- paid-invoice projection,
- synthetic testing projection.

The current accepted plan is the only input. A pending downgrade does nothing. Renewal projection retries an incomplete grow, satisfying D8.

**Day-7 retention**

Extend paused-retirement candidates with an archive policy derived from the existing one-way “ever subscribed” marker:

```ts
type ServicingArchivePolicy =
  | 'skip_never_subscribed'
  | 'try_subscriber_archive'

type ServicingArchiveOutcome =
  | { kind: 'stored'; storageId: Id<'_storage'> }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'skipped_trial' }
```

Behavior:

- `skipped_trial`: do not contact the archive endpoint; commit teardown without archive.
- `stored`: preserve the existing resumable archive flow.
- `too_large`: commit teardown without archive.
- Transport, authentication, or provider failures remain retryable and isolated per workspace.

**Inference:** a subscriber with no archive should remain in the existing `archived` servicing state, with no `archiveStorageId`. On resubscribe, the existing attach rail provisions a fresh VM rather than falsely restoring data. This avoids a new servicing status and preserves future resubscription.

The gateway archive seam must return a reliable typed oversized outcome without buffering an unbounded tar. The implementation may use a bounded prepared snapshot or a capped tar-measurement pass followed by streaming, but must:

- classify the actual tar payload, not drive logical bytes;
- stop work after 1GB plus one byte;
- never retain an oversized partial artifact;
- cap the upload stream again to cover races;
- leave non-size failures retryable.

#### Runnable/reviewable artifact

- Credential-free provider probe report: 28→58, restart, checksum, stable URL, public reachability, cleanup verified.
- Backend test matrix covering birth, growth, downgrade no-op, retry crash windows, and the three retirement outcomes.
- Audit output per grow containing workspace, VM identity, confirmed/provider/desired capacity, action phase, and result.

#### Verification

Use `write-tests` red/green before implementation.

Named tests:

- `packages/contract/src/plans/index.test.ts`
  - “pins usable and raw storage for every named tier”
  - “Max remains $200”
- `packages/backend/src/provisioning.test.ts`
  - update the create-options assertion from 10GB to 28GB;
  - retain SUBS-IMPL-07 subscriber archive/resume;
  - add never-subscriber/no-archive teardown;
  - add oversized-subscriber/no-archive teardown;
  - retain per-candidate failure isolation.
- `packages/backend/src/vm-attach.test.ts`
  - every birth requests 28GB;
  - paid attachment records 28GB then schedules growth;
  - identity/servicing races remain safe.
- New `packages/backend/src/vm-disk.test.ts`
  - 28→58 and 58→108 ordering;
  - same/downgrade strict no-op;
  - concurrent duplicate claim;
  - resize success/restart failure;
  - resize success/crash before phase record;
  - restart success/record failure;
  - stale accepted-plan action;
  - provider VM missing or identity changed.
- `packages/backend/src/billing.test.ts`
  - extend the upgrade/downgrade coverage at `packages/backend/src/billing.test.ts:727-803`;
  - assert both accepted projection paths schedule retry;
  - assert pending downgrade and stale invoices do not resize;
  - retain the exact monthly grant count.
- `packages/backend/src/vm-teardown.test.ts`
  - capacity and resize-progress fields clear with VM identity;
  - teardown remains idempotent.
- Gateway archive tests:
  - small tar streams successfully;
  - exact limit succeeds;
  - limit-plus-one produces typed `too_large`;
  - oversized content is not retained;
  - transport failure remains retryable.

#### Delegated freedoms

- Exact model/action file split.
- Claim token format, stale timeout, retry cadence, and audit event names.
- Bounded archive implementation technique.

Not delegated: catalog numbers, 28GB birth, strict greater-than guard, resize→restart order, per-workspace behavior, D5 outcomes, or calls beside both subscription projection paths.

#### Dependencies

None. The provider probe is an entry gate inside this slice, not a fourth slice.

#### Why it cannot merge with slice 02

This slice owns provider control-plane and destructive lifecycle behavior. It can be rejected solely on token scope, restart recovery, idempotency, or retention correctness without introducing a new gateway telemetry protocol. Combining those concerns would bury the primary provider kill gate in a broad cross-package change.

---

### 02-storage-truth-and-admission

#### Contract unlocked

- VM sync reports recursive drive-directory bytes separately from whole-filesystem telemetry.
- Empty drive usage is exactly zero.
- Billing overview exposes each workspace’s latest used bytes, usable capacity, and sample time.
- When free space is below the reserve, content-growing file operations and new agent turns fail predictably.
- Cleanup operations remain usable, and running turns are never killed.

#### API seam, modules, types, and ownership

**Drive telemetry**

Additive proposed wire field:

```ts
type VmTelemetry = {
  // existing operational fields
  driveUsedBytes?: number
}
```

Do not redefine `diskUsedMb` or `diskTotalMb`.

Proposed gateway owner: `vm/drive-usage-sampler.ts`.

```ts
type DriveUsageSample = {
  usedBytes: number
  sampledAt: number
}
```

It recursively measures only `DRIVE_ROOT_PATH`, does not follow out-of-tree symlinks, shares one in-flight walk, and caches the last successful result for five minutes. A failed walk omits or preserves stale drive usage without failing the VM heartbeat.

Extend the VM-sync validator, telemetry schema, insertion, latest-sample query, and downsampling path with `driveUsedBytes`.

**Billing projection**

Proposed contract extension:

```ts
type BillingWorkspaceStorage = {
  usedBytes: number | null
  usableBytes: number
  sampledAt: number | null
}

type BillingWorkspace = {
  id: string
  slug: string
  name: string
  storage: BillingWorkspaceStorage
}
```

`null` means no successful measurement; it must never be rendered as zero.

**Inference:** `usableBytes` should describe actual retained workspace capacity, not merely its downgraded plan:

```text
confirmed raw VM GB − 8GB image allowance
```

That makes a downgraded 58GB VM continue to display 50GB usable, matching D4 and the physical hard stop. For an unattached/archived workspace, fall back to the current tier’s advertised usable size until a new 28GB VM is attached. All byte conversions use one binary-GiB helper; UI labels remain product “GB.”

**Reserve admission**

Proposed gateway owner: `storage/storage-admission.ts`.

```ts
type StorageAdmission =
  | { allowed: true; availableBytes: number }
  | {
      allowed: false
      code: 'storage_full'
      availableBytes: number
      reserveBytes: number
    }
```

Recommended initial reserve: 1GiB. This is an implementation tuning constant under D14, not a new product decision.

Use live `statfs`/`statvfs` available-to-unprivileged bytes for admission; do not use cached drive usage.

File behavior:

- Guard PUT, copy, mkdir, and symlink before their first write.
- Allow delete unconditionally.
- Allow move/rename when it stays within the drive filesystem because it is storage-neutral.
- Return HTTP 507 with a typed `storage_full` body.
- Do not claim to intercept writes performed by shells, applications, sync tools, or an already-running agent.

Agent behavior:

- Check admission in `AgentSessionCoordinator` immediately before creating, starting, or waking a runner for a new turn.
- If full, create a canonical system step and failed completion using the existing session event pipeline.
- Settle the input cursor exactly once so backend delivery does not repeatedly redeliver the same rejected turn.
- Include stable `storage_full` metadata for web presentation.
- Never signal or terminate an existing runner.

#### Runnable/reviewable artifact

A hermetic gateway fixture with fake filesystem and clock demonstrates:

1. a non-empty root filesystem plus empty drive reports `driveUsedBytes: 0`;
2. repeated five-second sync observations perform one drive walk per five-minute window;
3. PUT/copy fail with 507 while delete/move still work;
4. rejected agent input produces one friendly terminal event and zero runner starts;
5. deleting files or growing the disk re-allows the next turn.

#### Verification

Use `write-tests` red/green before implementation.

Named tests:

- `packages/contract/src/vm/index.test.ts`
  - additive drive-byte serialization and backward compatibility.
- Billing contract tests
  - null-before-first-sample;
  - zero for an empty sampled drive;
  - exact usable capacities.
- `packages/gateway/src/vm/telemetry-sampler.test.ts`
  - drive-only scope;
  - empty drive;
  - symlink behavior;
  - cache hit, expiry, and single-flight;
  - walk failure does not break whole-filesystem telemetry.
- Gateway file-route tests
  - PUT/mkdir/symlink/copy rejected at reserve;
  - delete and same-filesystem move remain available;
  - typed 507 response;
  - unknown-length write races remain best effort.
- Agent coordinator tests
  - no runner factory/start below reserve;
  - one canonical friendly failure;
  - input delivery is settled, not redelivered;
  - recovery after cleanup;
  - active turn is not killed.
- `packages/backend/src/vm-sync.test.ts`
  - new field validates, stores, and survives omitted older-gateway payloads.
- VM telemetry tests
  - latest value/sample time;
  - downsampling retains drive bytes.
- `packages/backend/src/billing.test.ts`
  - independent multi-workspace values;
  - null and zero remain distinct;
  - retained larger capacity after downgrade.
- API proxy tests
  - billing projection shape;
  - file 507/body passes through unchanged;
  - session terminal failure preserves `storage_full`.

#### Delegated freedoms

- Drive walker implementation and cache internals.
- Internal naming and logging.
- Adjustment of the reserve and cache TTL from measured staging evidence through their single constants.

Not delegated: drive-only scope, per-workspace accounting, null/zero distinction, cleanup escape hatch, canonical session failure, or no mid-turn killing.

#### Dependencies

Slice 01 supplies the tier catalog and confirmed attached capacity.

#### Why it cannot merge with slice 03

This is a headless filesystem and protocol contract. It must be falsifiable with fake drive bytes, free space, and a never-called runner before screenshots consume the resulting API. Combining it with presentation could make fixtures look correct while the deployed gateway/backend seam remains wrong.

---

### 03-locked-ui-and-live-cutover

#### Contract unlocked

- Billing settings shows a real-GB meter for every payer workspace.
- The active workspace gets a dismissible upgrade nudge at exactly 90%.
- File and agent `storage_full` outcomes produce the locked hard-stop presentation.
- Trial/lapse copy includes the exact D6 warning.
- Fresh staging proves the entire feature against real Exe, Stripe, gateway, and browser paths.

#### API seam, modules, types, and ownership

- Billing settings consumes only `UserBillingOverview.workspaces[].storage`; web code does not query Convex directly or infer storage from Stripe prices.
- Render one meter per workspace. Do not pool usage.
- Credits remain percent-only.
- Null usage renders “Measuring…”; sampled zero renders `0 GB`.
- Plan picker storage labels come from `usableStorageGb`, never raw capacity.
- Proposed `StorageWarning` follows the existing low-credit toast structure but keys dismissal by workspace and threshold episode.
- It appears at `usedBytes / usableBytes >= 0.9`, clears its latch below 90%, and re-arms when capacity grows.
- Max does not offer a nonexistent upgrade. It offers cleanup guidance.
- File errors and canonical agent failures converge on the locked destructive toast:
  “Storage full. This workspace’s {capacity} GB is used up. Delete files or upgrade to keep working.”
- Replace false save guarantees with the exact sentence: “your workspace and all its files will shut down in 7 days.” Apply it everywhere the trial/lapse wall promises retention, with locale-shape parity.
- Add playground fixtures for null, empty, normal, 89%, 90%, full, Max-full, multiple workspaces, and retained larger capacity after downgrade.

#### Runnable/reviewable artifact

- Docker-playable billing, toast, and hard-stop states.
- Desktop and mobile screenshots for all three locked surfaces.
- A live staging report recording raw capacity, usage projection, restart identity/recovery, retention disposition, and reserve recovery.

#### Verification

Because this is visual work, invoke `ui-playground` before TSX changes and use its red/green fixture workflow.

Component tests:

- GB formatting and null/zero distinction.
- One meter per workspace.
- 89.99% does not warn; 90% does.
- Dismissal and re-arm after cleanup.
- Re-arm after Starter→Pro.
- Max cleanup behavior.
- File and agent hard-stop sources render the same user contract.
- Exact D6 English sentence and locale key parity.

Visual gates:

- Run the visual playground suite.
- Use `compare-screenshots` against `storage-ui-directions.html` for meter density, hierarchy, warning, and hard-stop treatment.
- Run unprimed `screenshot-critique` last on accepted desktop and mobile shots.

Affected staging legs:

- `subscription-01-trial-generation`: assert the fresh VM is born at raw 28GB and an empty drive projects zero usage.
- `subscription-02-exhaustion-wall-pause`: assert the exact D6 warning.
- `subscription-07-upgrade-and-portal`: assert the same VM grows 28→58, restarts, preserves a marker, restores public proxy access, and allows a later agent turn without `turn_already_running`.
- `subscription-08-downgrade-scheduled`: assert scheduling does not resize and the VM remains 58GB.
- `subscription-10-period-end-lapse`: preserve existing servicing/block-code behavior and retained physical capacity.
- `subscription-11-full-stop-archive-resume`: retain ≤1GB subscriber archive/restore and assert recreated VM birth follows 28GB-first behavior.
- Add a disposable never-subscriber retirement subleg proving no archive request and complete teardown.
- Add a disposable reserve subleg proving file/new-turn refusal, delete availability, and recovery.
- Keep `agent-continuity` green as the independent real-restart regression.
- VM-creating or file-writing `apps-in-file-view`, build-app, file, and share journeys are regression-sensitive and remain in the full suite (`packages/test-harness/src/staging-e2e-synthetic:70-108`).

D7 cutover is an operator action after deployment inventory and before final acceptance:

1. Resolve the exact shared-staging Convex deployment and Duet-tagged Exe fleet.
2. Delete staging application data and matching VM disks only.
3. Verify no pre-tier 10GB staging VM or workspace row remains.
4. Let the staging suite seed fresh 28GB workspaces.
5. Add no production migration, compatibility read, or catch-up scheduler.

Because this is a large cross-cutting feature, request approval before running `bun run e2e:staging`; the run consumes real staging and Stripe test resources.

#### Delegated freedoms

- Reversible spacing and icon choices inside the locked visual grammar.
- Fixture names and responsive grouping.
- Locale phrasing outside the exact D6 sentence.

Not delegated: the three surfaces, real-GB data source, per-workspace behavior, threshold, copy meaning, or CTA availability.

#### Dependencies

Slices 01 and 02.

#### Why it cannot merge with a neighbor

This is the sole visual and external-system acceptance rung. Provider lifecycle and filesystem correctness cannot be accepted by screenshots, while the UI cannot be truthfully accepted until the overview and error protocols are stable.

---

## 3) Seams and ownership map

| Contract or state | Sole owner | Consumers |
|---|---|---|
| Tier name, price, credits, usable GB, raw GB | `packages/contract/src/plans/index.ts` | Backend disk policy; web labels and next-tier CTA |
| Invariant CPU/memory caps | `packages/contract/src/resources/index.ts` | VM creation |
| Desired workspace disk | Proposed backend `vmDiskModel.ts`, derived from current payer subscription | Attach follow-up and reconciliation scheduling |
| Confirmed attached capacity and resize phase | Workspace row, written by attach/disk action and cleared by teardown | Idempotency and billing projection |
| Provider resize/restart | Proposed `vmDiskActions.ts` through `WorkspaceVmExe` | Scheduled after attach and accepted subscription projection |
| Entitlement pause/resume | Existing `reconcileServicingStatus` | Existing subscription lifecycle only |
| Day-7 archive disposition | `provisioningCore` candidate policy plus `provisioningActions` executor | Archive, teardown, audit |
| Drive-used bytes | Gateway cached drive walker | VM sync and backend telemetry |
| Free-space admission | Gateway storage-admission owner | Files routes and agent coordinator |
| User-facing workspace storage | Billing overview | Billing meter and active-workspace warning |
| Threshold episode and dismissal | Web | Per-workspace toast only |
| Live external proof | Test harness | Real provider/Stripe/browser acceptance |

Package boundaries remain:

- Contract defines shared runtime-safe shapes and constants; it owns no I/O (`packages/contract/README.md:8-13`).
- Backend owns durable Convex state and reconciliation (`packages/backend/README.md:7-12`).
- Exe remains a thin provider transport; tier and retry policy stay outside it (`packages/exe/README.md:3-12`).
- Gateway owns VM-local filesystem, process, and telemetry behavior (`packages/gateway/README.md:8-13`).
- Web consumes API contracts rather than backend internals (`apps/web/README.md:3-16`).
- Test harness consumes production interfaces; production packages never import it (`packages/test-harness/README.md:8-17`).

## 4) Firewalls

- Do not change D1–D14, plan names, Max’s $200 price, Stripe price mapping, or upgrade/downgrade timing.
- Do not add another monthly-credit grant path; `invoice.paid` remains the single grant door (`specs/done/monthly-subscriptions/README.md:103-109`).
- Do not mutate balances outside the wallet owner (`specs/done/monthly-subscriptions/README.md:110-116`).
- Do not persist a parallel entitlement or `isActive` flag (`specs/done/monthly-subscriptions/README.md:117-118`).
- Do not move entitlement pause/resume out of `reconcileServicingStatus` or make disk reconciliation another servicing writer (`specs/done/monthly-subscriptions/README.md:119-125`).
- Preserve `subscription_required` and `subscription_inactive`; `storage_full` is a separate VM-local capacity outcome.
- Do not derive tiers from price or create a second storage catalog.
- Do not create a paid VM directly at 58/108GB. Birth is always 28GB.
- Do not shrink, replace, copy-to-smaller, or restart on equal/lower desired capacity.
- Do not pool capacity across workspaces or implement a guest filesystem quota.
- Do not redefine whole-filesystem `diskUsedMb` as user-visible drive usage.
- Do not count the 8GB image allowance in user-visible storage.
- Do not block delete or a proven storage-neutral move.
- Do not kill an already-running turn or claim to intercept arbitrary shell/application writes.
- Do not build archive-provider offload; only D5’s local archive/no-archive disposition ships.
- Do not alter idle, banned, or administrator retirement semantics except where D5 specifically changes paused subscription retention.
- Do not add migration, backfill, compatibility, or catch-up code for 10GB staging rows.
- Do not expose raw 28/58/108GB values in product UI.
- Do not make production code depend on the staging harness.
- Coordinate implementation with the overlapping active work identified by MAP L6 before touching subscribe-wall, file UI, gateway tests, provisioning actions, contract telemetry, or shared playground fixtures (`specs/per-tier-storage/MAP.md:103-107`).

## 5) Risks and open questions

D1–D14 are closed. These are implementation risks or bounded choices only.

1. **Staging credential and public ingress — highest risk.** The current deployed credential’s resize/restart scope and post-restart share state are unproven. Slice 01’s first probe is the kill gate (`specs/per-tier-storage/MAP.md:109-115`).

2. **Resize crash windows.** Provider capacity can advance before durable phase state, and restart can finish before confirmed capacity is recorded. Provider observation plus a pending-restart phase must prevent equal-size resize while tolerating repeated restart.

3. **Routine runner death.** Upgrade makes restart recovery a normal path, exercising the existing dead-runner/turn-lock seam identified by MAP L4 (`specs/per-tier-storage/MAP.md:101-104`). Unit coverage and staging leg 07 must both prove a later turn can start.

4. **Archive-size classification.** Current backend classification relies on declared length, while the gateway buffers the tar. The bounded archive seam must prove exact tar-byte classification without an unbounded memory or disk artifact. Chunked/racing input must not be silently mislabeled as an ordinary retry forever.

5. **Recursive usage cost.** A walk near 100GB may be expensive. Five-minute, single-flight caching is the initial recommendation because backend telemetry already admits at five-minute intervals (`packages/backend/convex/domains/workspaces/vmTelemetry.ts:10-18`). Measure duration in staging before tuning.

6. **Reserve races.** Preflight cannot prevent concurrent writers or an active process from exhausting the remaining space. This residual is explicitly accepted by D14; failures must degrade cleanly and preserve deletion.

7. **Reserve value.** Recommended initial value is 1GiB. Keep it behind one gateway constant so staging evidence can tune it without changing the API or UI contract.

8. **Downgrade meter denominator — inference resolved for the plan.** Display actual retained usable capacity because D4 preserves the larger disk and admission follows physical free space. Showing the downgraded advertised tier would permit values above 100% while the workspace still physically has more room.

9. **Archived workspace presentation.** With no attached VM or current telemetry, show the current tier’s advertised capacity and unknown usage. Do not pretend an archived workspace has a measured zero.

10. **Multiple workspaces.** The locked mock shows one example meter, while D12 requires per-workspace accounting. The smallest honest implementation is multiple rows in the same plan card, not an aggregate meter.

11. **Destructive staging wipe.** Exact deployment and VM targets must be inventoried and verified before deletion. It is a reviewed operational cutover, not repository migration code.

12. **Affected staging scope.** Direct changes land in subscription legs 01, 02, 07, 08, 10, and 11, plus new disposable retirement/reserve checks. `agent-continuity`, VM creation, file, share, build-app, and apps-in-file-view journeys remain required regressions because they exercise restart, storage, or fresh-VM assumptions.