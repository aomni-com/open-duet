# Per-tier VM storage — quadrant map

Walked with Example User 2026-07-21/22. **The write-spec pass has run: the build plan
is [README.md](README.md) + [slices/](slices/), and it supersedes this map's
build sketch and builder-confirm list.** The decision ledger (D1–D14) remains
binding; the README adds synthesis decisions S1–S5 on top of it. Spike evidence lives
in [research/](research/) (probes ran against real exe.dev VMs); the locked UI
direction is [assets/storage-ui-directions.html](assets/storage-ui-directions.html)
("steal all", Example User).

## The feature in one paragraph

Each subscription tier owns a VM disk size — advertised as **usable file
space**: Starter **20GB**, Pro **50GB**, Max **100GB** — provisioned as
28/58/108GB raw (+8GB allowance for the OS image). Free/trial users get the
Starter size. Tier changes grow the disk in place on the same VM (exe `resize`
+ immediate restart); downgrades keep the larger disk. A storage meter and a
90% upgrade nudge surface usage; a best-effort reserve keeps the VM healthy at
the top of the disk. Cancel and trial exhaustion decommission through the
existing 7-day pause rail, with the archive step now conditional.

## Quadrant 1 — Known knowns (territory facts, all verified)

exe.dev mechanics — [research/disk-resize.md](research/disk-resize.md),
[research/disk-billing.md](research/disk-billing.md), live probes 2026-07-21:

- `resize --disk` on a running VM: accepted in ~650ms, **grow-only**, guest fs
  sees the space **only after a reboot** (~2.5s restart + ~9s to SSH-ready).
  Data survives (payload checksum verified across resize+reboot).
- **No shrink path**: smaller **and equal** target both 422
  (`--disk must be larger than current`); `cp --disk` smaller than source also
  422s. Every resize call must guard `desired > current` strictly.
- **Consumption billing**: provisioned capacity is free; the pool counts
  written bytes only (fleet cross-check: 170GB provisioned, 89.75GB counted,
  zero overage; an empty 100GB VM added 0). Overage $0.08/GB/mo past the
  100GB pooled allotment. Per-VM plan cap 500GB.
- The Duet image consumes **7.2GB** of every disk (`/usr` 5.4G — LibreOffice,
  ffmpeg, tesseract…); the workspace drive is a directory on the root fs
  (`DRIVE_ROOT_PATH = /home/synthetic-user/drive`, `packages/contract/src/drive`), so
  there is no separately resizable volume and disk quota tooling is absent
  (no `setquota`, no `prjquota` mount option).

Duet wiring:

- Every VM is currently created at a flat 10GB via `WORKSPACE_VM_CAPS`
  (`packages/contract/src/resources/index.ts`) threaded through
  `workspaceVmCreateOptions` (`vmAttach.ts`). No disk field exists on plans,
  workspace rows, or telemetry.
- Plan changes: upgrades immediate (proration invoice), downgrades at period
  end via `pendingPlan` (`domains/credits/billingActions.ts`,
  `subscriptions.ts`). Both projection-write paths already end with
  `reconcileServicingStatus` — the natural hook point for disk reconciliation.
- The decommission rail exists and is test-pinned: terminal/trial-exhausted →
  pause → 7 days (`SERVICING_ARCHIVE_AFTER_MS`, `provisioningCore.ts`) → sweep
  archives the drive tar and tears the VM down (`SUBS-IMPL-07`,
  `provisioning.test.ts`). The archive step throws `archive_too_large` above
  1GB (Convex file storage cap, `provisioningActions.ts`), and the sweep's
  per-candidate failure isolation retries such workspaces forever.
- The ExeClient gained `resize()` / `stat()` and `disk_capacity_bytes` during
  the spike (`packages/exe/src/exe.ts`); `stat`/`billing` are not covered by
  the probe token's `cmds` scope (403 observed).

## Quadrant 2 — Decision ledger

| # | Decision | Closed by |
|---|----------|-----------|
| D1 | Advertised GB = **usable file space**; provision tier + 8GB image headroom → raw disks **28 / 58 / 108GB** | Example User |
| D2 | **Free/trial gets Starter storage**: every VM is born at 28GB; the only transitions that exist are 28→58→108 | Example User |
| D3 | Upgrade → `resize` + **immediate restart**; ~15s blip accepted as part of the upgrade moment | Example User |
| D4 | Downgrade / same-size → **no disk change** (strict `desired > current` guard; avoids the 422; keeping the bigger disk is an accepted limitation) | Example User |
| D5 | Day-7 sweep branches: **trial (never subscribed) → teardown, no archive**; **subscriber drive tar ≤1GB → archive → resumable** (today's behavior); **subscriber >1GB → teardown, no archive** until archive-offload lands | Example User |
| D6 | Warning copy: "your workspace and all its files will shut down in 7 days" — plain, no download-coaching | Example User |
| D7 | Staging-only fleet: **delete all data**; no migration/catch-up code for pre-tier 10GB VMs | Example User |
| D8 | Resize failures self-heal: the disk reconcile hook rides every subscription projection write, so renewals retry monthly | territory |
| D9 | Max stays **$200/mo**; tiers map by name, not by the "$100" figure (reprice would be a separate Stripe task) | Example User (ratified assumption) |
| D10 | UI = plan-card **storage meter** (real GB, credits stay %-only) + **90% upgrade nudge** + **hard-stop error** — the three surfaces in assets/, stolen as-is | Example User |
| D11 | Meter counts **drive bytes only** — an empty workspace reads 0GB; the 7.2GB image is invisible to users | Example User |
| D12 | Quota is **per workspace** (a Starter with 3 workspaces holds 3×20GB); no pooled cross-VM accounting | Example User |
| D13 | Nudge threshold **90%**, mirroring `LOW_CREDIT_WARNING_RATIO` | Example User |
| D14 | Disk-full enforcement is **best-effort**: gateway file routes refuse writes below a free-space reserve, and the gateway **refuses to start agent turns** below it, emitting a friendly session error event the UI shows. No mid-turn killing; an agent racing into ENOSPC is accepted | Example User |
| OPEN | **Archive-offload provider pick (B2 vs R2)** — unblocks real archives for >1GB drives and retires D5's no-archive branch; `specs/archive-offload/` | Example User, deliberately open |
| OPEN | Prod cutover — no special constraint; rides the existing Example User-gated monthly-subscriptions cutover wave | shrugged off |

## Quadrant 3 — Unknown knowns (extracted taste)

- **Free tier markets the same storage as base** — "free gets same storage" came
  out only when the 10GB default question confused; the flat default was never
  a product intent.
- **GB is a promise about the user's files**, not about hardware — D1/D11 both
  fell out of this instinct.
- **Storage shows real GB in the UI** while credits stay %-only — the D12
  restraint from monthly-subscriptions applies to money, not bytes.
- **Decommission copy stays unceremonious** — warn plainly, don't coach.
- **Pragmatism over completeness at the edges** — downgrades keeping disks and
  best-effort enforcement were both accepted instantly; polish belongs to the
  meter/nudge surfaces users see daily.

## Quadrant 4 — Landmines (sweep covered contract, vmAttach, subscriptions/billingActions, retire sweep, vmExe, gateway sampler/files/runner, vmSync schema, billing UI)

| # | Finding | Status |
|---|---------|--------|
| L1 | **Agent shell writes bypass any gateway guard** — runner-spawned processes (`process-runner.ts`) write straight to the fs; fs-full wedges the gateway's own state writes (logs, desired-state, PGlite memory.db — the train-502 incident class) | **Decided → D14** |
| L2 | **Telemetry is whole-fs** — `statvfs(driveMount)` (`telemetry-sampler.ts:91`) would show 7.2GB used on an empty workspace. D11 needs a new drive-bytes sample (cached `du` walk — not free over ~100GB) plus a new field through the vmSync telemetry schema (`contract/src/vm/index.ts`, `vmSync.ts`) | Sharp edge — real scope, no decision |
| L3 | **Every VM burns ~7.2GB of pool by existing** (14 near-empty VMs → 89.75GB counted): ~$0.58/workspace/mo baseline, pool overflows past ~14 VMs. Overage is metered, not refused | Awareness; worth one email to exe.dev re image-layer dedup |
| L4 | **Upgrade-restart mid-turn** turns the fix73 crash path (turn-lock release on dead runner + boot orphan sweep) into a routine path | Test requirement for the build |
| L5 | **Sweep retries oversized archives forever** — the >1GB failure leaves the workspace as-is each pass | Fixed by D5's branching |
| L6 | **Working tree is hot** — apps-in-file-view is mid-flight and touches `subscribe-wall.tsx`, which D6's copy also touches | Build on a clean branch, coordinate |
| L7 | `provisioning.test.ts` and exe probe defaults pin `'10GB'` | Update with the caps change |
| L8 | D5's trial-skip **is archive-offload slice 00** | Annotate `specs/archive-offload/README.md` as built-here to prevent a double build |

Facts the builder must confirm before coding — **SUPERSEDED**: items 1, 2, and
4 are now the probe verdicts of
[slices/00-rail-probes.md](slices/00-rail-probes.md); item 3 was resolved at
synthesis by draft B's recon (README decision S2 — the fake-Stripe action
never projects; local coverage uses captured webhook fixtures, staging uses
real test-mode Stripe).

## Tweakable build sketch — SUPERSEDED

The build plan is now [README.md](README.md) with the slice ladder in
[slices/](slices/). This sketch was the pre-spec approximation; do not build
from it.
