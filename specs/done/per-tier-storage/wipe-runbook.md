# Staging wipe runbook — per-tier-storage cutover (D7)

**Staging only. Never generalize to production** — prod rollback leaves
grown disks in place; disks never shrink or copy down. The deliverable of
this wipe is the *absence* of migration code: after it, no pre-tier state
exists anywhere.

Operator: Example User (or an agent with Example User's live approval in-channel).
Precondition: no other in-flight work is mid-test against staging (check
with the team/other sessions — a wipe under someone's active e2e run
strands their fixtures).

## 1. Inventory (read-only, keep the output as evidence)

1. Convex staging: list workspace rows and their `vmDiskGb`:
   - `bunx convex run --prod=false <staging deployment> domains/... ` — or
     via dashboard data browser: `workspaces` table, export
     `_id, slug, status, vmName, vmDiskGb`.
   - Every row with `vmDiskGb: undefined` and a `vmName` is pre-tier.
2. exe.dev fleet: `ssh exe.dev ls --json` filtered to tag `duet-workspace`
   → record `vm_name`, `disk_capacity_bytes`. Pre-tier VMs read
   10737418240 (10GiB).
3. Save both listings into
   `specs/per-tier-storage/assets/wipe-evidence-pre.json` (credential-free).

## 2. Delete by resolved IDs — never by glob

1. For each inventoried workspace row: delete through the existing
   workspace-deletion path (mutation), which schedules VM teardown — or,
   for rows whose teardown wedges, delete the row via convex data tools and
   `ssh exe.dev rm <vm_name>` for its exact inventoried VM name.
2. Delete users only if the run also wants a clean identity slate
   (optional; the tier rail derives from plan projections, so stale users
   are harmless).
3. exe.dev: for any `duet-workspace`-tagged VM still listed after Convex
   teardown settles, `ssh exe.dev rm <exact vm_name>` from the step-1
   inventory. Never `rm` by pattern; never touch `Example User`, `duet-test-*`
   probes mid-run, or untagged VMs.

## 3. Post-wipe assertions (the D7 contract)

- `ssh exe.dev ls --json` → zero `duet-workspace`-tagged VMs with
  10GiB capacity (ideally zero such VMs at all).
- Convex `workspaces` table → no live row lacking `vmDiskGb`.
- Save listings to
  `specs/per-tier-storage/assets/wipe-evidence-post.json`.

## 4. Rebirth proof

- Create one fresh staging workspace (through the product or a harness
  identity): row records `vmDiskGb: 28`, exe reports 30064771072 bytes
  (28GiB), and once the gateway samples, telemetry shows `driveUsedMb: 0`
  on the empty drive beside whole-fs `diskUsedMb ≈ 7400`.

Then run the full staging e2e (`bun run e2e:staging`, ~12 min) — the
cutover is proven only by the full suite, not the touched legs.
