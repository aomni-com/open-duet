# Metered VM compute fees — rationale record

Workspace VMs draw a daily credit fee for the CPU and RAM they actually consume,
metered from exe.dev's provider-side `stat`. The same rail feeds the telemetry
chart and the storage bar, so nothing in the product measures a VM by asking the
VM. Workspace creation is limited by the creator’s current memberships and plan.

**Live on staging** since 2026-08-11, proven end to end by the
`vm-compute-fees` journey in `packages/test-harness`. **Production is
deliberately untouched** — the exe.dev token is set in `.env.production`, but
secrets were never pushed to prod, prod was never deployed, and prod's
`vmTelemetrySamples` was never wiped. That is the money path and it waits on a
human.

This document is the *why*. The code is the source of truth for *how*.

## The problem

Every workspace VM lives in one shared exe.dev pool. A VM pegged at 100% —
mining, or a runaway loop — crowds out other customers, and until now cost its
owner nothing beyond their subscription. `desiredServicingStatus`
(`domains/credits/subscriptions.ts`) does not look at balance **for
subscribers** — its trial branch does, which is what Invariant 5 relies on. So a
paying subscriber could burn their credits, stop making AI calls, and keep four
cores busy for the rest of the month at zero marginal cost.

## The reason it's shaped this way

**The fee converts stolen compute into lost AI budget, never into debt.** The
rates — `$0.003` per core-hour and `$0.0006` per GB-hour, in
`packages/contract/src/vm-usage/` — were derived backwards from one constraint
Example User set: *one VM saturated 24/7 for a month must still cost less than that
plan's monthly credit grant.* Starter binds at 60.5%. A miner therefore loses
most of their AI allowance and an honest user with a runaway process can never
end up owing money.

Nothing enforces that at runtime. It is a property of two constants, guarded by
`vmComputeFeeStaysUnderGrant`, which reads plan widths through
`workspaceVmCapsForPlan` and grants from `SUBSCRIPTION_PLANS` rather than
restating either — so widening Max when the pool grows, or trimming a grant,
fails the test and forces a deliberate re-derivation.

**A day's fee under ten cents is not charged at all.** The fee deters pool
abuse; it is not a collections mechanism. Without a floor every workspace would
grow a ledger row, three usage rollups and a spend-cap increment every day for
fractions of a cent — at 500 workspaces, 500 rows and 1,500 scheduled mutations
daily to bill about a dollar in total. `VM_USAGE_MIN_CHARGEABLE_MICRO_USD` sits
well above anything honest use produces (the busiest real workspace costs
~$0.017/day) and far below abuse (a saturated Starter VM costs ~$0.40/day, four
times the floor). Usage under the floor is **dropped, not carried forward** —
carrying it would need per-workspace running state to close an exposure of at
most $3/month of compute, about 3% of one VM sustained.

**There is no free allowance** on the rate itself. The live fleet measures 0.019–0.144 cores per
VM; a 4-core miner is ~28× the busiest legitimate workspace. At these rates an
idle VM costs about $0.09 a month and the busiest real one about $0.52, so an
allowance would buy nothing but a threshold to tune and an edge to explain.

**The gap clamp is deliberately conservative.** Over the HTTPS transport
production uses, points arrive a flat 600–601 s apart, so the 35-minute clamp is
far above anything normal. That is free: a larger clamp only ever *accepts* more
intervals, while a smaller one would silently stop billing during ordinary
jitter. It only has to stay well below a real outage.

**Creation limits bound new VM allocation, not billing responsibility.**
The [backend's creation rule](../../../packages/backend/README.md) counts
memberships when creating a workspace. Joining and payer changes allocate no
VM and carry no plan-capacity gate. This is not a hard cap on aggregate compute
charges: a payer can take responsibility for existing workspaces.

**Metering is provider-side because the alternative is asking the abuser.** The
in-VM sampler that used to fill `vmTelemetrySamples` ran inside the machine
being billed. `exe stat` returns `cpu_cores` as absolute cores measured from the
hypervisor — the exact billable unit, unforgeable from inside the VM.

**Integration is by step, not trapezoid.** A canary with one core pinned for
eleven minutes produced a *single* point at 0.900 cores: `cpu_cores` is an
average over the preceding interval, not an instantaneous sample. Each point
therefore owns the interval behind it at full height. A trapezoid would average
each reading with the one before and systematically under-report the leading
edge of every burst — which is the shape abuse takes.

## Invariants

1. **Under-bill, never over-bill.** Two rules together, and the clamp only
   holds because of how it is measured: an interval is clamped on the **true**
   gap between two readings, *before* clipping to the window, and a point with
   no predecessor bills nothing at all. Clamping the clipped duration instead —
   the first implementation — let a multi-hour outage straddling midnight bill
   up to a full clamp of load at the first post-outage reading's rate, and a
   lone point bill from midnight at its own rate. Both are charges for time
   nothing observed; both are pinned by name in `vm-usage/index.test.ts`.

   A day with no billable interval writes **no ledger row at all** — a day we
   could not measure and a day of genuine zero usage are different facts, and
   only one deserves a trace.

2. **One owner per concept.** `vmUsagePointsFromStat` (`@repo/exe`) is the only
   reader of exe.dev's wire vocabulary; `recordProviderTelemetrySamplesWithDb`
   the only PRODUCTION writer to `vmTelemetrySamples`. One test seam,
   `seedTelemetrySamplesForTest`, inserts directly — bypassing both the dedup
   and the `expectedVmName` guard, and accepting any `at`. It ships to every
   deployment behind `DUET_API_INTERNAL_KEY` like every other seam in
   `convex/testing/`. The two seams added by this feature
   (`recordVmSamplesForTest`, `chargeVmComputeDayForTest`) deliberately route
   *through* the production owners instead, which is the pattern to copy; `applyVmComputeWindowWithDb`
   (`domains/credits/vmComputeUsage.ts`) the sole producer of `vm_usage:`
   ledger entries — the daily cron and teardown both call it rather than
   computing a fee inline.

3. **Dedup on the provider's own timestamp.** `stat --range=24h` re-returns its
   whole window every sweep, so an hourly sampler sees each point about six
   times. A dedup wrong by a millisecond multiplies every bill and is
   indistinguishable from real usage afterwards. `at` comes from
   `Date.parse(point.timestamp)` and nothing else.

4. **Presentation clamps never reach the fee.** `cpuPct` is clamped to 100 for
   the chart; the fee reads raw `cpuCores`, the only number distinguishing a
   saturated 10-core VM from a saturated 4-core one. A percentage would
   under-charge the largest consumers by 2.5×.

5. **The charge reconciles servicing itself.** `applyLedgerEntryWithDb` does
   not, and a trial's entitlement depends on its balance staying above the $1
   floor — without an explicit `reconcileServicingStatus` a fee could drop a
   trial under the floor and leave it fully serviced.

6. **The fee never routes through preflight**, so no background job charges a
   card. `scheduleAutoTopupIfNeeded` hangs off `runPreflightWithDb`, which the
   fee path never calls.

7. **Storage is stored raw and adjusted only where displayed.**
   `vmTelemetrySamples` holds the provider's `fsUsedGb` verbatim;
   `projectWorkspaceStorage` subtracts `VM_IMAGE_HEADROOM_GB` because the
   advertised allowance already excludes it. The chart deliberately shows the
   raw figure — it answers "what is on the disk", the bar answers "how much of
   your allowance have you used".

8. **Never choose who to bill from `exe.list()`.** One exe.dev account backs
   staging and production; names are opaque hashes and tags the only
   environment marker, so enumerating the fleet would attribute production VMs
   to staging workspaces. The sampler and the daily charge take their candidates
   from *this deployment's* workspace rows, pinned by a test that asserts
   `list()` is never called.

   **The one exception, inherited rather than chosen:** teardown settlement runs
   inside `removeVmForWorkspaceImpl`, which already builds a `providerVmNames`
   set from `exe.list()` to decide what to remove — and the final charge is
   gated on that same set (`vmTeardown.ts`, pinned by "never meters a VM the
   provider no longer has"). So a truncated or failing `list()` silently drops
   one partial day's settlement. Bounded, and the alternative — billing a VM the
   provider says is gone — is worse.

## Entry points

| Concern | Code | Pinned by |
|---|---|---|
| Provider wire → domain | `packages/exe/src/stat.ts` | `stat.test.ts` |
| Rates, integration, charge floor, affordability | `packages/contract/src/vm-usage/` | `vm-usage/index.test.ts` |
| Sampler + fleet scheduler | `domains/workspaces/vmUsage.ts` | `vm-usage-sweep.test.ts` |
| Which VMs are metered (incl. `unhealthy`) | `domains/workspaces/vmUsageModel.ts` | `vm-usage-candidates.test.ts` |
| Sample storage, billing read + chart projection | `domains/workspaces/vmTelemetry.ts` | `vm-telemetry.test.ts` |
| Storage quota bar | `domains/credits/userBilling.ts` | `user-billing-storage.test.ts` |
| The charge | `domains/credits/vmComputeUsage.ts` | `vm-compute-charge.test.ts` |
| Teardown settlement | `domains/workspaces/vmTeardown.ts` | `vm-teardown.test.ts` |
| Workspace limits | `domains/workspaces/birth.ts` | `auth-workspaces.test.ts` |
| Live proof | `packages/test-harness/src/staging-e2e-synthetic` | `bun run e2e:staging -- --journey vm-compute-fees` |

Measurement evidence — fleet distribution, the canary verdicts, the transport
correction — is in [`research/fleet-metering.md`](research/fleet-metering.md),
with the runnable probes beside it. Decisions made on the user's behalf,
including three still open, are in [`choices.md`](choices.md).

## Dead ends and divergences

**The kill gate passed on the wrong transport, and ten slices were built on
it.** `ExeClient` speaks SSH when constructed without a token and HTTPS when
constructed with one. Every probe said `new ExeClient()`, so slice 00 measured
the account owner's unrestricted SSH permissions while the deployed backend uses
a scope-limited token. The gate reported PASS on 2,258 points; the deployed
sampler 403'd on every VM. The July 403 recorded in
`specs/done/per-tier-storage/` was the same wall — re-probed, seen to "work",
and written off as unexplained, when what had changed was the transport.
`probe-feasibility.ts` now refuses to run over SSH. **A previously-recorded
failure that suddenly passes deserves suspicion of the measurement first.**

**Shrinking VMs at zero credits was specified, explored, and dropped.** An
abuser at zero balance keeps a full-width VM and keeps consuming pool capacity;
the fee stops them buying AI, not compute. A chosen trade, not an oversight.

**Teardown narrows create-and-destroy; it does not close it.** A new VM emits no
metrics for its first four to five minutes, so a workspace born and killed
inside that window has nothing to bill however perfectly the teardown is
ordered. Closing it would need a minimum charge at creation or a VM-side clock;
both rejected.

**A boolean flag had silently broken every VM snapshot.** `--copy-tags` is a
boolean exe.dev only accepts as `--copy-tags=false`; the client sent
`--copy-tags true` as two arguments, so exe read `true` as the positional
new-name and rejected the command. The weekly cron had never once succeeded —
seventeen VMs on the account, zero snapshot copies. Fixed here, which means the
cron (disabled during this build) must **stay** disabled until someone decides
that backups justify roughly doubling VM count.

**Two schema columns could not be dropped in one deploy.** The running code
rewrote `vmTelemetrySamples.cpuPct` and `workspaces.lastTelemetrySampleAt` every
few minutes, so any schema omitting them failed validation on rows that did not
exist when the push began. Racing a wipe against it cannot win. The cutover was
two phases: deploy a schema that tolerates the old fields (which stops the
writes), then strip the rows and remove the tolerance.

**`--cmds` on an exe.dev API key is not validated.** An unrecognised name is
accepted silently and the key simply cannot run it — `share` alone yields 403,
because the grantable name is the full `share set-public`. Every scope must be
exercised on a throwaway canary before a re-mint is deployed; a clean mint
proves nothing. The current key is deliberately over-scoped and never expires,
because a minimal, expiring key is exactly what caused this feature's outage.

**The plan was wrong about two seams.** `transferWorkspaceBilling` does not
exist — the mutation is `setBillingUser`. And slice 03's function deletion and
slice 05's call-site deletion had to happen together or the build broke between
them.

## Provenance

Planned by a quadrant walk, then three blind drafts against one brief — two
codex, one claude, with distinct biases (fewest-slices, risk-first,
seam-quality) — synthesized rather than chosen between. The brief and all three
drafts are in [`assets/`](assets/). They agreed on fourteen points and split on
ten; each split is resolved above or in the code. The drafts caught three things
the quadrant map missed: the Convex fake exe had no `stat` (so no integration
test could reach the sampler), metering only `active` workspaces would let an
abuser escape by killing the gateway, and a debit alone does not pause a trial.

No visual baselines drove this feature. Its one user-visible surface — the
labelled fee row in billing history — is pinned by `settings-billing-history`
in `apps/web/tests/visual/`, added because the billing card previously had **no
visual coverage at all**: the settings surface scrolls inside its own container,
so `fullPage` screenshots stopped above it and a new row changed zero pixels.
