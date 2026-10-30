## Recon findings

- `ExeClient.stat()` is already wired to `stat <name> --range=…`, but returns `unknown`; the probe shows the envelope is `{ points?: [...] }`. The provider boundary therefore needs a typed, runtime-validated `ExeStatResponse`, not a cast inside billing code. `packages/exe/src/exe.ts:303-306`, `specs/vm-compute-fees/research/probe-fleet.ts:6-13`.

- Today telemetry is written only from VM sync: the backend accepts the gateway payload, applies a five-minute backend clock, inserts legacy percentage/MiB fields, and deliberately lets telemetry failure leave heartbeat persistence healthy. Provider ingestion must replace this writer, not sit beside it. `packages/backend/convex/domains/workspaces/vmSync.ts:349-363`, `packages/backend/convex/domains/workspaces/vmTelemetry.ts:10-42`.

- The durable table is also the projection source: history reads `vmTelemetrySamples`, bounds it to 10,000 rows, downsamples to 120 points, and never calls an external provider. That is the correct read architecture to preserve. `packages/backend/convex/domains/workspaces/vmTelemetry.ts:89-147`.

- The stored schema is entirely legacy-shaped—`cpuPct`, MiB memory/disk, and `driveUsedMb`—and the workspace carries an obsolete `lastTelemetrySampleAt`. This must be a genuine hard cutover after the staging wipe, not an additive provider table or a permanent dual schema. `packages/backend/convex/schema.ts:312-320`, `packages/backend/convex/schema.ts:361-372`.

- The external history contract and chart should remain stable. The chart consumes `cpuPct`, `memUsedMb`, `memTotalMb`, `diskUsedMb`, and `diskTotalMb`; it already positions points by elapsed timestamp, so provider cadence gaps remain visible. `packages/contract/src/vm/index.ts:20-43`, `apps/web/spa/settings/telemetry-history-chart.tsx:15-66`, `apps/web/spa/settings/telemetry-history-chart.test.ts:5-25`.

- The storage landmine is real. Capacity already subtracts the 8 GB image headroom, while usage currently reads `driveUsedMb`. A raw fresh-provider value around 7.449 GB would therefore appear as user data unless usage separately projects `max(0, fsUsedGb - VM_IMAGE_HEADROOM_GB)`. `packages/backend/convex/domains/credits/userBilling.ts:133-166`, `packages/contract/src/plans/index.ts:30-34`.

- Removing telemetry from the gateway deletes more than `/proc` sampling: the telemetry-only drive sampler performs recurring `du` walks, while `telemetrySamplerIo.statvfs` is also injected into the live disk guard. The sampler and `du` rail should disappear, but the `statfs` adapter must be re-owned by the disk guard. `packages/gateway/src/vm/drive-usage.ts:12-62`, `packages/gateway/src/runtime/http.ts:165-188`, `packages/gateway/src/vm/disk-guard.ts:17-38`.

- There are two compatibility validators, not one. The shared Zod request strips unknown top-level fields but still declares legacy telemetry; the closed Convex validator explicitly declares every telemetry member. Both must keep accepting and ignoring the legacy field until every deployed gateway has crossed the removal condition. `packages/contract/src/vm/index.ts:80-121`, `packages/backend/convex/domains/workspaces/vmSync.ts:103-131`.

- The VM-size analogue does not scale to this job. It reads a fixed 500 candidates and makes one `exe.list()` call, then loops in one action. Provider metering instead needs one external call per workspace, real pagination, bounded concurrency, retry isolation, and no lobby walk. `packages/backend/convex/domains/workspaces/vmSizeModel.ts:16-52`, `packages/backend/convex/domains/workspaces/vmSize.ts:42-99`.

- Driving from this deployment’s workspace rows is load-bearing: provider names are opaque, and one account serves staging and production. The existing provider tags document that shared account, but a billing sweep should not depend on provider enumeration or tag filtering at all. `packages/contract/src/resources/index.ts:35-59`.

- A `usage` debit has more side effects than a wallet change: it updates account and workspace monthly spend, inserts the ledger row, and schedules generic daily/weekly/monthly usage rollups. The VM-fee implementation must intentionally preserve and test those effects. `packages/backend/convex/domains/credits/ledger.ts:65-129`, `packages/backend/convex/domains/credits/usageRollups.ts:108-151`.

- Direct ledger application does not trigger auto-topup; auto-topup is scheduled only by spend preflight. Paid credits may go negative because allocation exhausts monthly credit and routes the remainder to paid credit, while only the monthly bucket is forbidden from becoming negative. `packages/backend/convex/domains/credits/ledger.ts:263-334`, `packages/backend/convex/domains/credits/wallet.ts:31-40`, `packages/backend/convex/domains/credits/wallet.ts:133-148`.

- A VM fee must explicitly reconcile servicing after the debit. Trial entitlement depends on balance remaining above the hard-block floor, whereas a live subscriber remains entitled independently of balance. `packages/backend/convex/domains/credits/subscriptions.ts:45-64`, `packages/backend/convex/domains/credits/subscriptions.ts:97-133`.

- Billing history currently discards transaction metadata and the web labels solely by transaction `type`. A distinct “VM compute” label therefore requires a typed metadata discriminator, backend projection, shared response field, and UI branch; storing metadata alone would be invisible. `packages/backend/convex/domains/credits/userBilling.ts:236-264`, `packages/contract/src/billing/index.ts:172-189`, `apps/web/spa/routes/user-settings.tsx:553-597`.

- The brief names `transferWorkspaceBilling`, but the real exported mutation is `setBillingUser`. It validates the new payer as an owner and patches `billingUserId` before entitlement/disk reconciliation. The cap belongs inside this transaction, before the patch. `packages/backend/convex/domains/workspaces/mutations.ts:218-263`.

- The existing creation gate is membership-based and effectively “one unless subscriber”; it is not keyed on `billingUserId`, and every subscriber currently bypasses it. The new 1/3/10 rule should replace that policy while preserving the system-workspace bypass. `packages/backend/convex/domains/workspaces/birth.ts:77-99`, `packages/backend/convex/domains/workspaces/birth.ts:101-145`.

- The exact daily reference plus teardown settlement exposes a missed edge: one workspace can tear down and reprovision in the same UTC day. A first-wins immutable daily debit would make the replacement VM’s remaining usage unbillable. The daily ledger operation therefore needs cumulative, increase-only settlement under the one global reference, while samples must carry the VM generation nonce so integration never bridges two VM lifetimes. The generation already exists and teardown already compares it. `packages/backend/convex/schema.ts:314-327`, `packages/backend/convex/domains/workspaces/vmTeardown.ts:58-90`.

## Slice graph

### 1. Provider telemetry hard cutover

**Contract unlocked**

Provider-side `exe stat` becomes the sole telemetry source. `vmTelemetrySamples` stores provider measurements; storage and the existing CPU/memory/disk history read projections of those same rows. The gateway stops sampling CPU, RAM, filesystem use, and Drive use.

**API seam and owner**

- `@repo/exe` owns:

  ```ts
  interface ExeStatPoint {
    timestamp: string
    cpu_cores: number
    cpu_nominal: number
    mem_used_bytes: number
    mem_total_bytes: number
    fs_used_gb: number
    fs_total_gb: number
  }

  interface ExeStatResponse {
    points: ExeStatPoint[]
  }

  ExeClient.stat(name, range): Promise<ExeStatResponse>
  ```

  Validate the envelope, finite non-negative metrics, positive nominal totals, and parseable timestamps at this provider boundary.

- `domains/workspaces/vmTelemetry.ts` becomes the sole sample writer. Its durable row is:

  ```ts
  {
    workspaceId,
    vmName,
    vmTokenNonce,
    at,
    cpuCores,
    cpuNominal,
    memUsedBytes,
    memTotalBytes,
    fsUsedGb,
    fsTotalGb
  }
  ```

  Values remain raw; only provider snake_case is normalized to repository camelCase.

- `ingestProviderTelemetryWithDb(ctx, { workspaceId, expectedVmName, expectedVmTokenNonce, points })` verifies the workspace still names that VM generation, deduplicates `(workspaceId, vmTokenNonce, at)`, and inserts only new points.

- `projectTelemetryHistorySample(row)` preserves the public shape:

  - `cpuPct = clamp(cpuCores / cpuNominal * 100, 0, 100)`
  - byte fields become MiB
  - `diskUsedMb = fsUsedGb * 1024`
  - `diskTotalMb = fsTotalGb * 1024`

  `disk_used_gb` is never typed, stored, projected, or billed.

- `projectWorkspaceStorage` remains the only storage projection and changes to:

  ```ts
  usedBytes = max(0, fsUsedGb - VM_IMAGE_HEADROOM_GB) * 1024 ** 3
  ```

- Keep `telemetry` in both VM-sync validators, rename it internally as legacy/accepted-and-ignored, and attach the exact closed-validator removal condition from the existing compatibility comments. Stop reading it in `persistVmSyncObservationImpl`.

- In the gateway, delete `telemetry-sampler.ts`, `drive-usage.ts`, their tests, `readTelemetry`, and `telemetrySamplerIo`. Add a narrowly named `diskGuardStatvfs` test injection or equivalent local adapter so `createDiskGuard` still owns its filesystem probe.

- Add a paginated deployment-scoped dispatcher and a single-workspace provider action. The dispatcher reads this Convex deployment’s workspace rows, passes `vmName` plus `vmTokenNonce`, never calls `exe.list()`, bounds concurrent `stat` calls, and isolates/retries individual failures.

**Human-visible checkpoint**

Run the provider action against one staging workspace, then inspect:

- raw provider rows through a testing query;
- `/v1/ws/:slug/telemetry`, still returning the existing chart shape;
- Billing storage, showing 0 used on a fresh VM;
- the unchanged CPU/memory/disk chart populated without a gateway telemetry field.

**Verification gates**

- `packages/exe/src/exe.test.ts`: command shape, response validation, malformed timestamps/numbers.
- `packages/backend/src/vm-telemetry.test.ts`: dedupe, generation mismatch, provider-to-public projection, downsampling, retention, and no sync-originated writes.
- `packages/backend/src/user-billing-storage.test.ts`: 7.449 GB projects to zero, values above 8 GB subtract exactly once, and VM-less workspaces still omit measurements.
- `packages/contract/src/vm/index.test.ts`: old gateway telemetry remains accepted.
- `packages/gateway/src/vm/sync-client.test.ts`, runtime tests, and `disk-guard.test.ts`: sync sends no telemetry and the disk guard still probes/fails open.
- Before deploying the new schema, manually clear staging `vmTelemetrySamples` and verify the table is empty. Then deploy the final schema once—no migration function, dual write, or backfill.

**Explicitly out of scope**

No debit yet; no billing-history label; no storage billing; no image-baseline/version tracking; no live provider read in a user query.

**Why these changes are one slice**

Provider typing, durable shape, public projection, storage correction, and sampler deletion are one source-of-truth cutover. Splitting them would deliberately create either two telemetry writers or a period where the UI reads the wrong units.

### 2. Daily VM compute settlement and teardown closeout

**Contract unlocked**

Every non-exempt VM receives one cumulative UTC-day `usage` ledger entry with reference `vm_usage:<workspaceId>:<yyyymmdd>`, priced at 3000 microUSD/core-hour and 600 microUSD/GB-hour, with no allowance and no debt cap.

**API seam and owner**

- `domains/workspaces/vmUsage.ts` owns pure integration and orchestration:

  ```ts
  integrateVmUsage(points, { startAt, endAt })
    -> { coreHours, gbHours }

  priceVmUsageMicroUsd({ coreHours, gbHours })
    -> number

  settleWorkspaceVmUsageWindowWithDb(ctx, {
    workspaceId,
    startAt,
    endAt,
    dayKey,
    now
  })
  ```

- Integration sorts/deduplicates points per `vmTokenNonce`, uses trapezoidal integration between consecutive timestamps, clips segments to `[startAt, endAt]`, never bridges VM generations, and never assumes ten minutes. Memory uses `memUsedBytes / 1024 ** 3`. With no points, one point, no positive interval, or a final rounded charge of zero, it writes no zero-dollar ledger row.

- Round once after summing CPU and RAM, matching the repository’s existing “single final rounding” billing convention. `packages/contract/src/model-tiers/index.ts:186-217`.

- `domains/credits/ledger.ts` owns `upsertCumulativeUsageLedgerEntryWithDb`. For the global daily reference it:

  - creates the first debit through the existing wallet-allocation path;
  - on a later same-day settlement, applies only the positive delta to the existing cumulative target;
  - never lowers or forgives the debit;
  - updates monthly-spend projections and schedules usage rollups for the delta only;
  - keeps the payer from the first successful settlement for that workspace-day, so a later billing transfer cannot create a second daily row.

- Daily cron targets the previous UTC day. Its dispatcher has real cursors, a fixed day/window carried through every page, bounded provider concurrency, and per-workspace retries. A failed provider call cannot stop or partially commit another workspace.

- Teardown verifies the scheduled VM identity, stats it before `remove`, ingests the last provider points, and invokes the same daily settlement function for `[UTC-day-start, teardownNow]`. Superseded identities and attach-rollback removals remain uncharged. The current ordering is provider removal followed by `clearWorkspaceVm`; settlement inserts before both. `packages/backend/convex/domains/workspaces/vmTeardown.ts:64-91`, `packages/backend/convex/domains/workspaces/vmAttach.ts:138-159`.

- Stat or settlement failure must not leave a VM consuming the shared pool indefinitely. Teardown attempts settlement first, records the failure for retry from already-retained samples, then continues removal. Ordinary daily failures skip rather than fabricate a zero charge.

- Skip `servicingExemptAt !== undefined`; trial and archived rows receive no separate branch.

- Call `reconcileServicingStatus` after an applied delta. This can pause a depleted trial but leaves a live subscriber active.

- Do not call spend preflight or auto-topup code.

- Extend typed `transactionMetadata` with `usageKind: 'vm_compute'`; project it into billing history and render “VM compute” instead of generic “Usage.” The ledger remains `type: 'usage'`.

**Human-visible checkpoint**

A deterministic provider-point fixture shows:

- exact core-hours, GB-hours, and debit;
- one billing row labeled “VM compute”;
- the exact reference and cumulative idempotency on rerun;
- unchanged token counts but increased overall usage spend;
- no auto-topup attempt.

A real staging workspace can additionally ingest actual `exe stat` points before the fixture exercises the deterministic debit.

Because this changes visible Billing history, invoke `ui-playground` before the TSX work, capture the history row and error states, run `compare-screenshots`, then finish with an unprimed `screenshot-critique`.

**Verification gates**

- Pure tests for irregular timestamps, clipping at UTC boundaries, out-of-order and duplicate points, generation gaps, CPU and RAM separately, and single final rounding.
- Pricing constraint test over the real plan grants and VM widths:

  - Starter: 4c/8 GB, 30 days, debit 12,096,000 microUSD `< 20,000,000`
  - Pro: 8c/16 GB, debit 24,192,000 `< 60,000,000`
  - Max: 10c/24 GB, debit 31,968,000 `< 250,000,000`

  This is a test only, never a runtime rule. Plan grants live at `packages/contract/src/plans/index.ts:12-28`; widths live at `packages/contract/src/resources/index.ts:3-32`.

- Convex tests for global reference idempotency, cumulative same-day reprovision settlement, monthly-first/paid-overflow allocation, negative paid balance, usage-rollup delta, no allowance, no auto-topup, trial pause, subscriber continuity, exemption skip, and no-points skip.
- Action harness with more than 500 fake workspaces, real cursor advancement, bounded in-flight calls, one failure among successes, retry exhaustion, and an assertion that `exe.list()` is never called.
- Teardown tests pin `stat → ingest/settle → remove → clear`, replacement-generation protection, provider failure cleanup, and unchanged attach-rollback behavior.
- Contract/API/web tests pin `usageKind: 'vm_compute'` through Billing history.

**Explicitly out of scope**

No shrinking at zero credits. No disk fee. No allowance. No balance clamp, mercy rule, backfill, or new auto-topup trigger.

**Why these changes are one slice**

Pricing, cumulative ledger settlement, cron dispatch, teardown closeout, servicing reconciliation, and history labeling are one financial transaction contract. Separating teardown or presentation would ship either unbilled terminal usage or an indistinguishable charge.

### 3. Billing-user workspace caps and release journey

**Contract unlocked**

A user may be the billing user of at most 1 / 3 / 10 live workspaces for starter / pro / max. The same policy gates creation and billing transfer; existing over-limit users and downgrades lose nothing.

**API seam and owner**

- `domains/workspaces/billingWorkspaceLimit.ts` owns:

  ```ts
  billingWorkspaceLimitFor(user, now): {
    plan: 'starter' | 'pro' | 'max'
    limit: 1 | 3 | 10
  }

  assertCanBecomeWorkspaceBillingUser(ctx, {
    userId,
    now,
    excludingWorkspaceId?
  }): Promise<void>
  ```

- No live subscription maps to starter/1. A live subscription uses its validated plan.

- Count `workspaces.by_billing_user`, excluding only `deleted` and `retired`; archived workspaces continue to count because they remain live under the repository’s liveness definition. `packages/backend/convex/domains/workspaces/authorization.ts:17-19`.

- `createWorkspaceRow` calls the assertion before insertion unless `bypassOwnerBillingGate` is true.

- `setBillingUser` validates membership, returns early if unchanged, then calls the same assertion before patching `billingUserId`.

- Add one structured refusal contract:

  ```ts
  {
    error: 'workspace_limit'
    plan: 'starter' | 'pro' | 'max'
    limit: 1 | 3 | 10
  }
  ```

  Creation returns it as 402, preserving the existing upgrade-shaped refusal rail. Billing transfer returns it as 409. Both web surfaces render actionable plan-limit copy rather than a generic mutation failure.

**Human-visible checkpoint**

- Starter with one workspace sees a plan-limit refusal on creation.
- Pro can become payer for three and is refused on the fourth.
- Max can become payer for ten and is refused on the eleventh.
- Downgrading an already-over-limit payer leaves every workspace untouched; only the next create/transfer is refused.
- The billing-user Settings page shows the structured refusal without changing the payer.

Use the existing playground/API fixtures for the two refusal states, then run the same visual comparison and unprimed critique gates.

**Verification gates**

- Pure 1/3/10 plan mapping tests, including lapsed subscription → starter.
- Convex creation tests for exact-boundary success/failure, archived counting, deleted/retired exclusion, downgrade preservation, and system bypass.
- `setBillingUser` tests for exact-boundary success/failure, unchanged-payer no-op, atomic no-patch on refusal, and existing owner validation.
- Contract/API tests for 402 creation and 409 transfer responses.
- Web tests for actionable creation and billing-user error copy.

**Explicitly out of scope**

No deletion, archival, forced billing transfer, or workspace shrinking on downgrade. The policy remains creation/transfer-gated only.

**Why this remains separate**

The cap is economically related to compute billing but owns a different transactional seam and different user-visible refusal contract. Merging it into settlement would make one review verdict cover unrelated provider, ledger, and membership behavior.

## Dependencies and ordering

1. Slice 1 blocks Slice 2 because pricing must consume the final provider-backed sample shape and teardown must call its sole ingestion seam.
2. Slice 3 can proceed in parallel with Slice 1; it touches the workspace contract and payer mutation but not telemetry or the ledger.
3. Slice 2 and Slice 3 both touch Billing-facing contracts/UI, so integrate their shared contract changes before the final web verification.
4. The staging table wipe occurs immediately before deploying Slice 1’s final schema. It is the only cutover operation.
5. The focused live staging journey lands after all three slices and is registered in `staging-e2e-synthetic`, whose registry is the package’s selectable-journey owner. `packages/test-harness/README.md:149-162`, `packages/test-harness/src/staging-e2e-synthetic:24-32`.

## Kill gates

- **Fastest kill — Slice 1 provider boundary:** if the deployed token cannot reliably return valid 24-hour points, timestamps are not stable enough to deduplicate, or bounded fan-out cannot complete without provider throttling, kill compute billing before any debit code ships. Telemetry may remain on the existing rail until that verdict; the earlier 403 demonstrates why this is a real gate. `specs/vm-compute-fees/research/fleet-metering.md:10-22`.

- **Billing kill — Slice 2 cumulative settlement:** if retries, teardown, or same-day reprovision can create two daily entries or lose later usage under the exact reference, do not enable the cron. The pricing/integration tests should answer this locally before any staging debit.

- **Release kill — Slice 3 transfer enforcement:** if a billing-user transfer can cross the cap between assertion and patch, the economic guard is incomplete. Both occur in one Convex mutation, so failure here is architectural rather than eventually consistent.

- **Operational kill:** the focused staging journey must observe actual provider telemetry, one labeled deterministic debit, idempotent rerun, a zero fresh-VM storage bar, and a workspace-limit refusal. Any missing leg blocks release.

## Single-owner invariants

| Concept | One owner | A second owner would be |
|---|---|---|
| Provider response validation | `@repo/exe` `ExeClient.stat()` | Casting `unknown` or validating provider snake_case inside an action |
| Telemetry sample writer | `vmTelemetry.ingestProviderTelemetryWithDb` | VM sync inserting samples, a second provider table, or teardown inserting directly |
| Public telemetry projection | `vmTelemetry.projectTelemetryHistorySample` | The API or web reconstructing provider units |
| Charge calculation | `vmUsage.integrateVmUsage` + `priceVmUsageMicroUsd` | Cron and teardown carrying separate integration or pricing math |
| Wallet/ledger settlement | `ledger.upsertCumulativeUsageLedgerEntryWithDb` | VM code patching wallet, transaction, monthly spend, or rollups independently |
| Storage projection | `userBilling.projectWorkspaceStorage` | Subtracting image headroom during ingestion or in the web |
| Workspace-limit verdict | `billingWorkspaceLimit.assertCanBecomeWorkspaceBillingUser` | Separate counting logic in birth, transfer, API, or UI |
| Disk-full protection | Gateway `createDiskGuard` | Retaining telemetry sampler dependencies merely to supply `statvfs` |

## Risks and firewalls

- **Same-day VM generations:** without `vmTokenNonce` on samples, integration would bridge the old VM’s last point to the replacement’s first or silently discard overlapping timestamps. Integrate each nonce independently.

- **Billing-user changes within a day:** the first successful daily settlement owns that day’s payer and global reference. Later deltas update that transaction; they must not create a second payer-scoped row. Document this attribution rule in the ledger test.

- **Provider truncation:** a later 24-hour response may contain fewer points than an earlier response. Cumulative settlement is increase-only; it never refunds because a provider window shrank. Retries must occur while the target day is still available; there is no 7-day recovery or backfill.

- **Provider outage during teardown:** protecting the shared pool outranks retaining a VM until billing succeeds. Settle from retained points, record/retry a failed charge, and remove the VM even when a fresh stat fails.

- **Partial fleet runs:** a page cursor must never depend on every provider call succeeding. Individual failures are retried and reported; completed workspaces remain committed and the sweep progresses.

- **Usage-report semantics:** `type: 'usage'` automatically adds VM spend to overall usage rollups while adding no tokens or app dimension. Pin that explicitly so reporting does not later “fix” away a settled side effect. `packages/backend/convex/domains/credits/usageRollups.ts:154-172`.

- **Float precision:** validate finite metrics, integrate in hours once, and round the combined CPU+RAM price once. Never round per point or per resource.

- **Prune race:** schedule settlement before the existing 04:30 UTC telemetry prune and retain the full 30-day policy. `packages/backend/convex/crons.ts:109-125`.

- **Schema cutover:** deploying the provider-only table shape before clearing staging will fail schema validation against legacy rows. Clearing any other table, adding a migration reader, or dual-writing is outside the authorized cutover.

- **Gateway regression:** deletion of `telemetrySamplerIo` must leave the disk guard’s `statvfs` test and runtime wiring intact; otherwise writes fail open forever and disk exhaustion protection silently disappears.

- **Visual ambiguity:** generic “Usage” is insufficient evidence. The Billing history contract must expose the typed metadata discriminator; UI string selection alone would be unverifiable from the API.

## Test strategy

Implementation follows red/green TDD through the `write-tests` skill before each behavioral change. Iterate with the owning package’s single test or file, then `bun test --changed`; reserve the root `bun run test` for one final closeout run. `AGENTS.md:31-69`.

**Fixtures**

- Canonical saturated points for 4c/8 GB, 8c/16 GB, and 10c/24 GB.
- Idle and working values from the measured probe.
- Irregular timestamps, duplicates, reversed order, UTC-boundary clipping, zero points, one point, malformed points, and provider truncation.
- Two VM nonces in one workspace-day.
- Existing daily ledger row followed by a larger cumulative target.
- Trial, subscribed, servicing-exempt, archived, transferred-payer, and negative-paid-balance accounts.
- Starter/pro/max payers at limit minus one, exact limit, and already over limit.

**Must stay green**

- VM sync compatibility and heartbeat-failure isolation.
- Telemetry authorization, history ordering, downsampling, and pruning.
- Gateway sync, runtime construction, and disk guard.
- Wallet allocation, monthly-spend, usage-rollup, servicing, and billing-history suites.
- Workspace creation, membership, billing-user transfer, and API refusal tests.
- Telemetry chart geometry and Billing/Settings presentation tests.

**Focused live staging journey: `vm-compute-fees`**

Register a `workspace-browser` journey that:

1. uses its existing ephemeral workspace and VM—no untracked provider resource;
2. invokes the protected testing wrapper around the real single-workspace provider action;
3. proves provider-backed telemetry through the public telemetry API and visible chart;
4. proves the fresh storage projection reports zero used;
5. applies deterministic provider-shaped points through the same ingestion/settlement owner;
6. proves the exact debit, reference, metadata label, and unchanged result on rerun;
7. proves a structured workspace-limit refusal;
8. deletes through the ordinary cleanup ledger, exercising teardown without leaking the VM.

Run only:

```bash
bun run e2e:staging -- --journey vm-compute-fees
```

The repository explicitly forbids using the full staging suite as this feedback loop. `AGENTS.md:83-93`.

## Objections

None. The plan assumes all 22 settled decisions stand.
eardownModel.ts:53-72`

- **Cleanup hostage risk:** final metering is best-effort. A provider or ledger failure must not keep a saturating VM alive solely to collect a partial fee. Existing disk/telemetry observations likewise fail open rather than brick core behavior. `packages/gateway/src/vm/disk-guard.ts:28-35`, `packages/backend/convex/domains/workspaces/vmSync.ts:349-362`

- **Presentation clamps must not become billing clamps:** CPU percentage may be capped at 100 for the existing schema, but fee math consumes raw `cpuCores`. Storage clamps only below zero after image-headroom subtraction.

- **Usage-report semantics:** because the settled transaction type is `usage`, VM fees increase monthly spend and workspace usage totals and can make later AI preflight fail a cap. Do not silently exclude them with another reporting rail. `packages/backend/convex/domains/credits/ledger.ts:95-128`

- **Auto-topup:** the fee path must never call `runPreflightWithDb`; that is the only place the current ledger schedules threshold topups. `packages/backend/convex/domains/credits/ledger.ts:263-334`

- **Trial pause:** ledger application alone is insufficient. Missing the explicit servicing reconcile would debit the trial without pausing it until some unrelated reconciliation event. `packages/backend/convex/domains/credits/subscriptions.ts:53-64`, `packages/backend/convex/domains/credits/subscriptions.ts:97-133`

- **Validator cutover:** retain legacy telemetry in both request validators while stopping all reads. Removing it from the closed Convex validator is a fleet-wide 500 risk. `packages/backend/convex/domains/workspaces/vmSync.ts:103-131`

- **Disk guard regression:** delete the sampler only after `statvfs` is independently composed and exercised through a guarded write. `packages/gateway/src/runtime/http.ts:165-188`

- **Limit races:** count and insert/transfer occur in one Convex mutation. Tests must issue concurrent attempts so optimistic transaction retries prove the limit cannot be overshot.

- **No accidental migration work:** wipe staging `vmTelemetrySamples`; do not backfill, dual-write, retain `driveUsedMb`, or create image-version state. The retained `lastTelemetrySampleAt` remains a live newest-provider-sample cursor rather than compatibility debris. `packages/backend/convex/schema.ts:312`

## Test strategy

Before each behavioral edit, the implementing agent invokes `write-tests` and follows red/green TDD. Iteration uses the narrowest owning-package runner; root `bun run test` runs once at closeout. `AGENTS.md:31-69`

### Slice 1

- `packages/exe/src/exe.test.ts`: valid `points` envelope, malformed envelope, invalid timestamp/number, and exact `stat --range=24h` command. Existing fetch injection supports this without a live call. `packages/exe/src/exe.test.ts:55-64`
- `packages/backend/src/vm-telemetry.test.ts`: replace five-minute cadence fixtures with raw storage, dedupe, ordering, projection, downsampling, authorization, and retention. Preserve the 120-point browser cap and bounded prune chain. `packages/backend/src/vm-telemetry.test.ts:62-184`
- `packages/backend/src/vm-sync.test.ts`: old-gateway telemetry is accepted and ignored; sync/heartbeat stays healthy. Replace current in-VM sampling expectations. `packages/backend/src/vm-sync.test.ts:950-1068`
- `packages/backend/src/user-billing-storage.test.ts`: fresh 7.449 GB → 0 bytes, 8 GB → 0, 9 GB → 1 GiB, retained disk denominator, VM-less projection. `packages/backend/src/user-billing-storage.test.ts:5-77`
- Gateway: delete sampler/drive-usage tests; keep `disk-guard.test.ts`, change `sync-client.test.ts` to assert telemetry omission, and replace the production-composition sampler test with a disk-guard wiring test. `packages/gateway/src/gateway.test.ts:1669-1720`
- Keep API telemetry and chart geometry tests green. `apps/api/src/billing.test.ts:806-843`, `apps/web/spa/settings/telemetry-history-chart.test.ts:5-30`

### Slice 2

- New pure pricing fixtures cover exact rates, irregular timestamps, duplicate/unsorted points, partial windows, resource-unit conversion, no-data skip, and round-once arithmetic.
- Backend integration fixtures cover sample-plus-ledger atomicity, reference replay, usage rollups, monthly-spend patches, negative paid debt, no scheduled topup, trial pause, subscriber continuity, and servicing exemption. Existing billing tests already pin rollup/cap agreement and provide the owning suite. `packages/backend/src/billing.test.ts:1801-1921`
- Teardown mocks record exact call order and failure behavior. Existing missing-provider, duplicate-delivery, and replacement-generation cases must stay green. `packages/backend/src/vm-teardown.test.ts:60-119`
- Contract/API/UI fixtures pin `usageKind` exposure while references and raw metadata remain private. `apps/api/src/billing.test.ts:44-74`

### Slice 3

- `packages/backend/src/auth-workspaces.test.ts`: replace unlimited-subscriber behavior with Starter/Pro/Max boundary tables; add downgrade, concurrency, transfer, archived, retired/deleted, and system-bypass cases. The current creation and payer-transfer tests are the natural owners. `packages/backend/src/auth-workspaces.test.ts:325-390`, `packages/backend/src/auth-workspaces.test.ts:478-601`
- `apps/api/src/billing.test.ts`: creation and billing-user 402 refusal contracts at the boundary. Existing payer-route coverage remains green. `apps/api/src/billing.test.ts:298-437`
- Contract and web tests distinguish `workspace_limit_reached` from unknown errors; visual fixtures cover creation and payer-transfer refusal states.
- Register and run only `vm-compute-fees`; do not run all staging journeys. `packages/test-harness/src/staging-e2e-synthetic:148-163`, `AGENTS.md:83-93`

### Closeout

Run, in order:

1. Owning-file tests while red/green.
2. `bun test --changed` after each multi-file slice.
3. Owning package `check-types`, `lint`, and test scripts.
4. UI playground, screenshot comparison, and unprimed critique for slices 1 and 3.
5. Staging table wipe and deploy.
6. `bun run e2e:staging -- --journey vm-compute-fees`.
7. One root `bun run test` closeout gate. `README.md:90-113`, `AGENTS.md:83-93`

## Objections

None. The plan assumes all 22 settled decisions stand.
