# Per-tier VM storage — rationale record

**Shipped to staging 2026-07-23** (branch endpoint `309f65be`, merged at
`987816dc`). Built in one unsupervised session: Codex wrote the passes,
Claude orchestrated, reviewed, and verified; every decision made without
Example User is in [choices.md](choices.md). All local gates are green — unit and
fixture suites across contract/backend/gateway/api/web/test-harness, the
Docker visual gate (27 fixtures × 2 viewports), and a whole-branch review
whose three findings were fixed red-first. The staging fleet wipe (D7) was
executed by Example User the same day ([wipe-runbook.md](wipe-runbook.md)); the
live `bun run e2e:staging` proof was delegated to a follow-up session and
had not yet run when this record was written.

This document is the *why* and the *what-must-stay-true*; the code is the
source of truth for *how*. The build ladder (11 slices) is collapsed; its
durable content is folded in below. Planning provenance:
[MAP.md](MAP.md) (the quadrant walk with Example User; decision ledger D1–D14) and
`assets/draft-{a,b,c}-*.md` (three blind biased build plans synthesized
into the ladder).

> **Later policy supersession (2026-08-03):** the historical
> “trial → `retired`, terminal” result below is being replaced for future
> decommissions by [trial workspace recommission](../trial-recommission/README.md):
> still no archive bytes, but the same workspace remains `archived` and can
> recommission an empty VM after purchase. This note does not rewrite what this
> feature originally shipped.

## What shipped

Each subscription tier owns workspace storage, advertised as **usable file
space**: Starter/free 20GB, Pro 50GB, Max 100GB — provisioned as 28/58/108GB
raw disks (+8GB allowance for the OS image; exe.dev reads "NGB" as N GiB).
VMs are born at the payer's tier size. Upgrades grow the same disk in place
(exe `resize` + immediate awaited restart, ~10s blip); downgrades keep the
larger disk. A per-workspace storage meter and a 90% upgrade nudge ride the
billing overview; a best-effort 1GiB free-space reserve refuses
capacity-growing writes (507 `storage_full`) and new agent turns (settled
with a durable timeline error event) while never touching running turns or
deletes. Day-7 decommission branches: trial → teardown without archive
(`retired`, terminal); subscriber ≤1GiB tar → archive → resumable (the
pre-existing path, byte-identical); subscriber >1GiB → teardown without
archive (`archived`, no storage id — identity resumable onto a fresh
current-tier disk).

## Why it's shaped this way

- **Free space is the enforcement currency, not quota.** There is no quota
  accountant anywhere: the gateway never learns plans or tiers, and the
  meter's GB never gates anything. The +8GB image headroom is what makes
  "filesystem nearly full" coincide with "quota exceeded", so one `statvfs`
  probe against one reserve constant (`DRIVE_FREE_SPACE_RESERVE_BYTES`,
  contract) is the entire enforcement mechanism, fail-open by design (D14 —
  best-effort; a broken probe must not brick the drive). The probe measured
  that even under a 1GiB reserve the advertised 20GB still fits with
  +0.17GB margin ([research/tier-disk-rail.md](research/tier-disk-rail.md)).
- **One derivation, two writers, one resize door.** Desired size is derived
  fresh every time from the payer's projection
  (`vmDiskPolicy.desiredVmDiskGb` — no entitlement/time logic; a
  still-projected lapsed Pro maps to 58). The row field
  `workspaces.vmDiskGb` records *realized physical capacity* and has
  exactly two writers forever: attach-record and resize-record. The only
  caller of `exe.resize`/`exe.restart` in the repo is
  `vmDisk.resizeWorkspaceVmDisk`. Reconciliation
  (`reconcileWorkspaceVmDisks`) rides as a *sibling* immediately after
  `reconcileServicingStatus` at every subscription projection door — never
  nested — so resize failures self-heal on the next projection write
  (renewals give a free monthly retry, D8).
- **Grow-only, row-keyed, always-restart.** The lobby 422s any non-growing
  resize (probe-proven; the fake exe mirrors it so the guard is testable).
  The action's done-decision keys off the row, resize-need off the lobby,
  and it always restarts when the row is under target — covering the
  crash-after-resize-before-restart window where the lobby is already at
  size but the guest filesystem never grew. Restart-throw after a
  successful resize still records: the disk *is* bigger.
- **Drive bytes, not filesystem bytes, face the user.** The whole-fs
  telemetry (`diskUsedMb`) would show 7.2GB used on an empty workspace (the
  image). The gateway's `createDriveUsageSampler` is the sole producer of
  drive-bytes truth (`du -sb -P`, cache-first, 5min TTL, never delays the
  5s sync poll); `driveUsedMb` is additive and optional end-to-end because
  old gateways must keep syncing.
- **Storage reads ride the billing overview** (synthesis decision S5) — the
  meter, nudge, and hard-stop copy all consume
  `BillingWorkspace.storage`; nothing recomputes. The denominator after a
  downgrade is retained physical capacity (S3: a kept 58GB disk shows "… of
  50 GB"), which is why the bar can never exceed 100%. The upgrade step is
  suppressed when it wouldn't grow usable space (Example User reviewed 2026-07-23:
  kept — "Upgrade → 50 GB" to someone holding 50GB sells nothing).
- **Decommission policy has one owner.** `provisioningCore` decides
  (`retireDisposition`, `dispositionAfterArchiveFailure` — pure, table-
  tested); the sweep executes; `archiveWorkspaceFromVm` stays policy-blind.
  `subscriptionEverActivatedAt` is the one-way trial boundary. The gateway
  archive stages tar bytes through a 1GiB limiter into a 0600 temp file so
  oversize gets a typed 413 *before* any response byte.
- **Why VMs are born at tier size, not grown after birth** (S1): the
  attach-plan reads the payer row directly, so birth and growth share one
  derivation and there is no second sizing policy to drift; the rejected
  alternative cost every Pro/Max workspace a pointless resize+restart blip
  at birth.

## Invariants (violating these silently breaks the feature)

1. Monthly-subscriptions invariants 1–7 stand untouched (see
   [monthly-subscriptions](../monthly-subscriptions/README.md));
   `storage_full` is its own name at the gateway/file/session layers, never
   a servicing block code, recognized by typed code, never by copy.
2. Strict grow-only everywhere: every resize requires desired > current;
   no shrink, no copy-down — production rollback leaves grown disks in
   place.
3. Tier never varies compute: the resize action passes only `--disk`;
   birth uses the fixed `WORKSPACE_VM_CAPS` cpu/memory unchanged.
4. `VmSyncResponseSchema` stays `.strip()`; `driveUsedMb` stays optional;
   whole-fs fields keep operator semantics.
5. Deletes and same-fs moves are never refused; running turns are never
   killed; a racing writer into ENOSPC is accepted (L1/D14).
6. Per-candidate sweep isolation; `archive_too_large` keeps its name;
   transport failures stay retryable.
7. Raw 28/58/108 never appear in product UI; advertised GB comes from
   `storageGb` only; credits stay %-only in the plan card.
8. Fake Stripe never writes a subscription projection (S2 — measured, not
   assumed; the api overview test pins that a fake upgrade leaves the
   overview on Starter).
9. No migration/backfill for pre-tier rows ever existed (D7) — the wipe was
   the cutover; its absence of convergence code is the deliverable.

## Pointers into the code

- Catalog: `packages/contract/src/plans` (`storageGb`,
  `VM_IMAGE_HEADROOM_GB`, `vmDiskGbForPlan`, `STORAGE_WARNING_RATIO`);
  reserve: `packages/contract/src/drive`
  (`DRIVE_FREE_SPACE_RESERVE_BYTES`); error name:
  `packages/contract/src/files` (`STORAGE_FULL_ERROR`).
- Sizing policy + reconciler:
  `packages/backend/convex/domains/workspaces/vmDiskPolicy.ts`; resize
  action/model/schedule: `vmDisk.ts`, `vmDiskModel.ts`,
  `vmDiskSchedule.ts`; row truth threading: `vmAttach.ts` /
  `vmAttachModel.ts`; shared teardown fragment:
  `CLEARED_WORKSPACE_VM_FIELDS` in `vmTeardownModel.ts`. Tests:
  `src/vm-disk.test.ts`, `src/vm-attach.test.ts`, billing fan-out pins in
  `src/billing.test.ts` (three workspaces → three schedules; 50 same-size →
  zero, R7).
- Telemetry: `packages/gateway/src/vm/drive-usage.ts`,
  `telemetry-sampler.ts`; backend `vmSync.ts` / `vmTelemetry.ts`.
- Reserve guard: `packages/gateway/src/vm/disk-guard.ts`; consumers in
  `routes/files.ts` and `agent-sessions/coordinator.ts` (three doors: fresh
  input, scheduled wake, ask-checkpoint answer). Refusal terminal
  semantics: `terminalStatus` in
  `packages/backend/convex/domains/agentSessions/agentSessionsShared.ts`.
- Sweep: `provisioningCore.ts` / `provisioningActions.ts`
  (`ArchiveWorkspaceError`); gateway streaming:
  `packages/gateway/src/vm/archive.ts` (`pipeArchiveWithLimit`,
  `stageWorkspaceArchive`); tests `archive-stream.test.ts`,
  `src/sweep-disposition.test.ts`, `src/provisioning.test.ts`
  (SUBS-IMPL-07 unchanged — the gate).
- Read model: `projectWorkspaceStorage` in
  `packages/backend/convex/domains/credits/userBilling.ts`; UI:
  `apps/web/spa/entitlements/storage-surfaces.tsx`, `storage-warning.tsx`;
  copy in the `duetStorage` catalog namespace.
- Probes: `packages/exe/scripts/probe-tier-disk.ts`
  (`bun run probe:tier-disk`), evidence retained in [research/](research/).
- Staging legs: `packages/test-harness/src/staging-e2e-synthetic` +
  the extended subscription journeys in `staging-e2e-synthetic`;
  `storage-tier-resize` is registered **optional** (Example User, 2026-07-23 —
  subscription-07, already required, proves the resize rail).

## Divergences from the plan (what a reader would otherwise re-derive)

- **Share state survives the resize-reboot** (probe verdict), so the
  planned re-`setSharePublic` step in the resize action was never built.
- **The "workspace restarted to add storage" timeline line was not built**:
  session events have per-session appenders only; no workspace-level seam
  exists. The restart is observable via `workspace.vm_disk_resized` audit
  events.
- **Storage-full refusals terminalize the session to `interrupted`**, not
  the planned "idle": implemented literally, idle left the projection stuck
  `running`/`sleep` forever (whole-branch review finding). `interrupted` is
  the established retryable state — the retry-in-session behavior idle was
  meant to buy.
- **The reserve guard grew a third door**: answering a session at an `ask`
  checkpoint originally bypassed the guard entirely. (At the time the answer
  resumed through a live parked runner; since the 2026-07-30
  terminal-means-terminal ruling every terminal kills its runner and answers
  rehydrate through the ordinary no-runner door — the guard's coverage is
  unchanged. See the turn-runner principle in `packages/gateway/README.md`.)
- **The upgrade CTA is conditional** (see S3 note above) — not in the plan;
  added by the whole-branch review, kept after Example User's review.
- **The wall's founder note was removed** with D6 (its closing line was the
  retention promise being killed); the edge paused page kept its viewer
  copy — the plan's sweep list named it, but that surface addresses viewers
  of a published app, and "Your workspace…" is owner copy.
- **Residual-VM-state detection widened**: detect and clear now share the
  one field-list owner, so `syncthingDeviceId` counts as residual state —
  the old hand-kept lists had already drifted.
- **exe "GB" is GiB.** "28GB" provisions 30.06 decimal GB — the headroom
  math lands *better* than advertised (R1 closed without the feared Example User
  decision on reserve size).
- The plan's ~15s blip allowance measured at **9.5–9.9s** end-to-end;
  harness legs tolerate 30s for staging variance.

## Dead ends

- Timing `du` through SSH exec: the ~2.8s connection setup dwarfed the
  ~0.2s scan and would have inflated the 100GB cost model several-fold,
  pushing the sampler toward a needlessly conservative design. In-VM timing
  killed it; the corrected numbers made the cheap cache-first sampler
  obviously sufficient.
- Piping tar straight into the archive response: no way to return a typed
  oversize error after the first body byte. Staged temp-file won.
- Mutating the shared test-fixture owner's billing state: poisoned entire
  suites twice; the dedicated-user-per-billing-state pattern replaced it.

## Visual provenance

[assets/storage-ui-directions.html](assets/storage-ui-directions.html) is
the locked direction for all three surfaces (meter / nudge / hard-stop),
built during planning and blessed by Example User as "steal all" — the shipped
surfaces were gated against it with a hierarchy/copy comparison plus an
unprimed critique. The committed baselines under
`apps/web/tests/visual/__screenshots__/*/playground.spec.ts/storage-*.png`
(22 storage fixtures in en + es-419, plus 5 re-baselined en wall
fixtures; desktop + mobile each) are the accepted result; `assets/draft-*.md` and
`assets/drafting-brief.txt` record the three blind plans the ladder was
synthesized from.

## Follow-ups living elsewhere

- Real >1GiB archives: [specs/archive-offload](../../archive-offload/README.md)
  (its trial-skip rung shipped here; the oversize-teardown branch retires
  when it lands).
- es-419 voice unification:
  [specs/es419-copy-voice](../../es419-copy-voice/README.md).
- Pool economics: each VM burns ~7.2GB of the consumption pool by existing
  (the base image is counted per-VM). Known issue, already on exe.dev's
  roadmap (Example User, 2026-07-23) — the day-7 decommission rail is the
  mitigation in the meantime.
- The live staging e2e proof (delegated to another session); this record
  was closed before it by Example User's explicit instruction.
