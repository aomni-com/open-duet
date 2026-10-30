# Root cause: exe.dev VMs run at ~37% of nominal CPU

Found 2026-07-30 while chasing why `turn_started` took 138–376s on staging.

**Resolution, same day — the conclusion below was half right.** The steal
measurements stand, but "not fixable from this repo" did not survive: two
same-repo changes took `turn_started` from 446s to 13.9s on a live journey.

1. **The fleet was the contention.** 24 VMs shared the account's CPU — ten of
   them leaked by this investigation's own diagnostic probe (`login-as
   { create: true }` provisions a full VM per call). Deleting leaks took the
   per-VM CPU share 4.3% → 27.5% and `turn_started` 446s → 29s. Workspaces
   born from the programmatic-login path are now marked ephemeral and their
   VMs tagged `duet-ephemeral` so a sweep never has to guess
   (`convex/domains/workspaces/vmTags.ts`,
   `packages/exe/scripts/sweep-ephemeral-vms.ts`).
2. **~5.9s of the per-agent CPU was removable.** Creating a PGlite database
   from scratch dominated every agent's first turn. The VM now builds one
   template at boot and copies it per agent
   (`packages/gateway/src/agents/memory-template.ts`); a live VM logged
   `memory_template_built` 49s off the critical path and
   `seedOutcome: seeded` at agent creation.

Measured floor after both: **13.9s** `turn_started` on a fresh VM at a
13-VM fleet — but the number moves with account load (58s/113s on a later,
busier run). The per-VM steal itself remains the platform's; below is the
original record of it.

## The measurement that isolates it

The same agent binary, in the same VM image, differing only by machine:

| environment | `turn_started` |
| --- | --- |
| laptop, native (`bun src/cli.ts`) | **1210ms** |
| laptop + Composio MCP attached | 1076ms |
| exact staging VM image, **emulated** amd64, 2 cores | **~4400ms** |
| same image + 4 CPU burners (contention) | 15100ms |
| same image + model-gateway credentials | ~5000ms |
| **real exe.dev VM, 2 cores, idle, nothing else running** | **119s / 173s / 229s / 376s** |

The last row is `duet rpc` alone on a freshly created, idle VM: no gateway, no
syncthing, no apps, no MCP, no model credentials, no skills, no drive, and a
fresh database per run. It is *slower than running the same image under CPU
emulation on a laptop*, which is the tell.

## Why: the hypervisor is taking the CPU

`/proc/stat` steal deltas, sampled over 20s windows on idle VMs:

| VM | stolen | effective cores (of 2) |
| --- | --- | --- |
| fresh #1 | 60.1% | 0.80 |
| fresh #2 | 64.3% | 0.71 |
| fresh #3 | 56.9% | 0.86 |
| **production workspace, 8.3h uptime** | **70.9%** | 0.58 |
| **production workspace, 2.2h uptime** | **66.0%** | 0.68 |
| average | **63.4%** | 0.73 |

This affects **live user workspaces**, not just e2e VMs. It is not
host-specific (three fresh VMs, all ~60%) and it does not settle with age (an
8-hour-old VM is still at 71%). CPU-bound work and disk are fine — a 1e7 loop
ran in 1700ms and 10MB disk I/O in 197ms. Only *being scheduled* is broken,
which is why identical commands vary 60x: `bun -e "0"` measured 19400ms, then
304ms, then 1099ms on one VM.

## Why a 15s budget looked unreachable (superseded — see Resolution above)

A **noop** process spawn cost ~19.4s cold on these VMs (`bun -e "0"`), and
`node --version` cost 16.8s — measured at the 24-VM fleet. What this section
originally missed: the fleet size was largely self-inflicted, and process
spawn cost scales with the same contention. At 10–13 VMs the same spawn is
sub-second and the 15s budget is reachable (13.9s measured live).

## What was eliminated, by construction rather than argument

- **Not the gateway** — it was not running in any of these measurements.
- **Not CPU contention from our services** — the box was idle.
- **Not PGlite/memory** *as the cause of the 119–376s scale* — fresh database
  each run; run 2 was still 119s. (PGlite is still ~5.9s of real per-agent
  CPU, which is why the memory template exists — it just cannot explain two
  orders of magnitude.)
- **Not MCP, model credentials, skills, or the drive** — none present.
- **Not the agent's serial startup** (`duet-agent#88` / 0.3.7). A/B on one VM,
  same host, same steal, version the only variable: **0.3.5 = 230790ms,
  0.3.7 = 257604ms**. No improvement. Both the reviewer's original
  `max(phase)` argument and the later "scheduling latency is per-await-hop"
  refinement predicted a win here; neither survived the measurement.

## What would fix the per-VM steal itself

Capacity on exe.dev's side — a plan/quota change, a dedicated-CPU tier, or a
less oversubscribed host. `billing plan` returns
`403 command not allowed by token permissions` for the API token, so reading
the account's limits needs the owner's SSH key.

Reproduction for a support ticket: create any VM from this image, run
`bun -e "0"` twice, and sample `/proc/stat` steal over 20s.
`packages/exe/scripts/probe-vm-caps.ts` is the sibling probe for what sizes
the account will schedule.
