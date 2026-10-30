# Drafting brief — metered VM compute fees

You are drafting an implementation plan (a slice ladder) for a feature in the
Duet monorepo at `/Users/synthetic-user/dev/duet`, branch `staging`. Another agent will
synthesize your draft with two others written blind against this same brief.
**Do not look for or read other drafts.**

Read `AGENTS.md`, `README.md`, and `SECURITY.md` first. Recon the real code
before proposing anything — every claim you make must cite a file and line you
actually read.

---

## The feature in one paragraph

Workspace VMs share one exe.dev CPU/RAM pool, so a saturating VM (crypto
mining, a runaway loop) crowds out other customers. Add a **daily credit
deduction for VM CPU and RAM**, metered from exe.dev's provider-side `stat`
API, priced so it is invisible to normal users and eats an abuser's AI budget.
While we are in there, **migrate the whole VM telemetry rail** off in-VM
self-reporting onto the same provider source, and **cap how many workspaces a
user can be the billing user of**.

## Non-goals — do not plan these

- **No VM shrinking at zero credits.** Explored and deliberately dropped. An
  abuser at zero balance keeps a full-width VM and keeps crowding the pool.
  Accepted trade. Do not add a slice for it, do not "improve" it.
- **No storage/disk charging.** Storage is reported, never billed.
- **No debt cap or clamp.** See decision 11.
- **No backward compatibility, no data migrations, no deploy-order dances**
  beyond the one named in landmine 2. Prod has no data; staging is wipeable.

---

## Settled decisions — carry these verbatim, do not re-derive or re-litigate

These came from a quadrant walk with the user. Treat every one as a given. If
you think one is wrong, note it in a clearly-marked "objections" section at the
end of your draft — but plan as if it stands.

| # | Decision |
|---|---|
| 1 | Meter from provider-side `exe stat`, not in-VM telemetry |
| 2 | Migrate the whole telemetry rail onto it; delete the in-VM sampler |
| 3 | Store `fs_used_gb` raw — no image baseline, no image-version tracking |
| 4 | Keep writing samples to `vmTelemetrySamples`; never read `exe stat` live from a user-facing query |
| 5 | `driveUsedMb` retired; storage reads the same provider sample |
| 6 | Ledger entry uses `type: 'usage'`, reference `vm_usage:<workspaceId>:<yyyymmdd>` |
| 7 | **Rates: $0.003 per core-hour, $0.0006 per GB-hour** (3000 and 600 microUSD) |
| 8 | **No allowance** — charge from the first unit |
| 9 | The pricing constraint is a **test**, not a runtime rule |
| 10 | Shrink-on-zero-credits: dropped (see non-goals) |
| 11 | No debt cap. If mercy is ever wanted later, forgive with a separate `adjustment` ledger entry — never clamp the debit |
| 12 | Workspace limits **1 / 3 / 10** (starter/pro/max) keyed on `billingUserId` |
| 13 | Enforce that limit at creation **and** in `transferWorkspaceBilling` |
| 14 | Over-limit users keep what they have; downgrades take nothing away (creation-gated only) |
| 15 | A day with no telemetry points is **skipped**, not billed at zero |
| 16 | Integration interval derived from point timestamps, never assumed to be 10 minutes |
| 17 | Teardown charges the final partial window through the same function as the cron |
| 18 | Servicing-exempt workspaces skipped; trial and archived workspaces need no special case |
| 19 | The fee does **not** trigger auto-topup |
| 20 | Label the charge in billing history via `transactionMetadata` |
| 21 | **Hard cutover**: wipe staging `vmTelemetrySamples`, no dual-write, no backfill |
| 22 | Storage bar must read **0 on a fresh VM** — store raw, subtract `VM_IMAGE_HEADROOM_GB` at projection |

### Why the rates are what they are

The user's constraint: *one VM saturated 24/7 for a full month must still cost
less than that plan's monthly credit grant.* The fee converts stolen compute
into lost AI budget, never into debt. At $0.003/core-h + $0.0006/GB-h:

| Plan | Width | Saturated 30d | Grant | Share |
|---|---|---|---|---|
| Starter | 4c / 8 GB | $12.10 | $20 | 61% |
| Pro | 8c / 16 GB | $24.19 | $60 | 40% |
| Max | 10c / 24 GB | $31.97 | $250 | 13% |

Starter binds. Multi-VM abuse is the only path to debt, which is why decision
12 exists.

---

## Measured facts — from a live read-only probe, 2026-08-09

`exe stat <vm> --range=24h` **works** with the current token (it was HTTP 403
in July — see `specs/done/per-tier-storage/research/disk-resize.md:126`).
It returns points at a ~10-minute cadence:

```json
{ "cpu_cores": 0.02, "cpu_nominal": 4,
  "mem_used_bytes": 555114496, "mem_total_bytes": 8589934592,
  "fs_used_gb": 7.449, "disk_used_gb": 0.132,
  "timestamp": "2026-08-07T20:25:57Z" }
```

- `cpu_cores` is **absolute cores already**, not a percentage. This is the
  billable unit; no `cpuPct × width` reconstruction is needed.
- **Do not use `disk_used_gb`** — it fluctuated `0.1326 → 0.1254 → 0.1269`
  across consecutive points while `fs_used_gb` stayed flat at `7.449`.
  Unexplained; `fs_used_gb` is the stable one.
- Live fleet, 16 workspace VMs, all currently 4c/8G:
  - Idle (10 of 16): 0.019–0.020 cores, 0.02–0.16 GB
  - Working (6 of 16): 0.056–0.144 cores avg, p95 0.34–0.35, 0.08–0.48 GB
  - A 4-core miner would be 4.0 cores / ~7 GB — ~28× the busiest real VM
- At the chosen rates, an idle VM costs **$0.09/month** and the busiest real VM
  **$0.52/month**. That is why decision 8 (no allowance) holds.
- `--range=7d` returned only 57–93 points per VM, not ~1000. Unexplained.
  Irrelevant for a 24h window; would matter for any backfill.

---

## Landmines found in a systematic sweep — every draft must handle these

1. **Storage bar jumps to 37% for every user.** `projectWorkspaceStorage`
   computes `usableGb = rawDiskGb - VM_IMAGE_HEADROOM_GB` — the allowance
   already excludes 8 GB for the image. Today's `usedBytes` comes from
   `du(driveDir)`, which also excludes the image, so they agree. `fs_used_gb`
   does not: it reads 7.449 GB on a fresh VM. Fails silently — no error, just a
   wrong bar, and the 90% storage warning fires ~8 GB early.
   `domains/credits/userBilling.ts:139-142`, `contract/src/plans/index.ts:29`.

2. **Deleting the `telemetry` field from `vmSyncObservationValidator` 500s the
   fleet.** That validator carries three fields kept purely as
   accepted-and-ignored, each commented: *"a gateway older than this deployment
   still sends it, and a closed validator would 500 the whole sync rail."*
   Keep the field, stop reading it, add the same comment and removal condition.
   `domains/workspaces/vmSync.ts:104-118`.

3. **The disk guard shares dependencies with the sampler being deleted.**
   `createDiskGuard({ driveMount, statvfs: telemetrySamplerIo.statvfs, now })`.
   Removing `telemetrySamplerIo` takes the disk guard's filesystem probe with
   it — and the guard is what stops a workspace filling its disk. Fails at
   runtime in the VM, not in CI. `packages/gateway/src/runtime/http.ts:178-188`.

4. **This is the first N-call fan-out to the provider.** The existing size sweep
   makes exactly one lobby call (`exe.list()`) and iterates the result; a fee job
   needs one `exe stat` per VM. The sweep's candidate query also takes a flat 500
   with no cursor and documents that as unsafe past 500 VMs. Sixteen calls is
   free; five hundred serial calls in one Convex action is a timeout arriving as
   a partially-billed day. `domains/workspaces/vmSizeModel.ts:16-23`, `vmSize.ts:42-52`.

5. **One exe.dev account backs both staging and production.** `exe.list()`
   returns every VM on the account; names are opaque hashes and tags are the only
   environment marker. Driving the job from workspaces in *this* Convex
   deployment and statting them by name is naturally scoped; walking the lobby is
   not — and the inverted loop looks more efficient.
   `contract/src/resources/index.ts:35-59`.

6. **The fee can pause a trial user's workspace, but not a subscriber's.** Trial
   entitlement requires `spendableBalance > HARD_BLOCK_FLOOR` ($1) and
   `desiredServicingStatus` pauses anyone unentitled; subscribers are entitled by
   subscription state regardless of balance. Correct behaviour, non-obvious.
   `domains/credits/creditsShared.ts:172`, `subscriptions.ts:53`.

7. **Teardown must stat before it removes, while the workspace row still lives.**
   `applyLedgerEntryWithDb` opens with `ctx.db.get(workspaceId)` and throws
   "Workspace not found"; the teardown action calls `clearWorkspaceVm` after
   removing the VM. Two orderings are wrong and both look reasonable.
   Attach-rollback removals in `vmAttach.ts:95,149,157` stay uncharged by design.
   `domains/workspaces/vmTeardown.ts:81-95`, `credits/ledger.ts:65`.

---

## Key seams to read before drafting

- `packages/backend/convex/domains/credits/ledger.ts` — `applyLedgerEntryWithDb`,
  idempotent on `reference`; note what `type: 'usage'` triggers (monthly-spend
  patch feeding spend caps, plus `scheduleUsageRollup`).
- `packages/backend/convex/domains/credits/wallet.ts` — `allocateSpend` clamps
  monthly and routes overflow to paid; that is why paid can go negative.
- `packages/backend/convex/domains/workspaces/vmTelemetry.ts` — the sample table,
  5-min cadence, 30-day retention, prune cron, `listTelemetryHistory`.
- `packages/backend/convex/domains/workspaces/vmSize.ts` + `vmSizeModel.ts` —
  the closest existing analogue: a cron that reconciles VMs against the lobby.
  Read it for shape, batching, error isolation, and audit-event conventions.
- `packages/backend/convex/domains/workspaces/vmTeardown.ts` — the one owner for
  billable VM removal.
- `packages/backend/convex/domains/workspaces/birth.ts` — `assertCanCreateWorkspace`
  and the structured `ConvexError` refusal pattern.
- `packages/backend/convex/domains/workspaces/mutations.ts` — `transferWorkspaceBilling`.
- `packages/backend/convex/domains/credits/userBilling.ts` — `projectWorkspaceStorage`.
- `packages/exe/src/exe.ts` — `ExeClient.stat()` returns `unknown`; it needs typing.
- `packages/gateway/src/vm/telemetry-sampler.ts` + `runtime/http.ts` — the code
  being deleted.
- `apps/web/spa/settings/telemetry-history-chart.tsx` — plots `cpuPct`,
  `memUsedMb`, `memTotalMb`, `diskUsedMb`, `diskTotalMb`. Must keep working.
- `packages/backend/convex/crons.ts` — cron conventions.
- `packages/test-harness/src/staging-e2e-synthetic` — the live journey registry.

## Repo conventions that constrain the plan

- Read `AGENTS.md`: narrowest-test-runner ladder, `bun run test` is a closeout
  gate not a feedback loop, and big changes end with their own live staging
  journey registered in `staging-e2e-synthetic`.
- Convex closed arg validators are a second schema — additive wire fields must be
  added there or syncs 500.
- No prettier in this repo; format by hand.
- `Math.random()` and `Date.now()` are fine in Convex mutations here, but note
  the existing jitter pattern in `usageRollups.ts`.

---

## Your bias

**{{BIAS}}**

---

## Output contract

Return the draft as markdown, highest-value first. No preamble, no summary of
this brief. Sections, in order:

1. **Recon findings** — what you actually read that changed your plan, with
   file:line. Include anything the brief got wrong or missed. Be specific;
   "I read the ledger" is worthless.
2. **Slice graph** — a numbered ladder. For each slice: the contract it
   unlocks, the API seam (module, exported functions, types, data shape,
   owner), what the human can run or see, the verification gates, and what is
   explicitly out of scope for that slice.
3. **Dependencies and ordering** — what blocks what, and where the ladder can
   fork in parallel.
4. **Kill gates** — which slice would kill the feature if it failed, and how
   fast.
5. **Single-owner invariants** — for each concept the feature touches
   (telemetry sample writer, the charge function, the storage projection, the
   workspace-limit check), name the one owner and the thing that would create a
   second one.
6. **Risks and firewalls** — including anything the landmine list missed.
7. **Test strategy** — which tests at which seam, what fixtures, what must stay
   green, and what the live staging journey covers.
8. **Objections** — any settled decision you think is wrong, with evidence.
   Clearly marked as objections; the plan above must still assume they stand.
