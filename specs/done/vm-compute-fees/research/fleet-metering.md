# Probe: can we meter VM CPU/RAM from exe.dev, and what does the real fleet look like?

- Date: 2026-08-09
- Method: read-only. `exe list` filtered to `duet-workspace`, then
  `exe stat <vm> --range=…` per VM. No VM was created, resized, or removed.
- Script: [`probe-fleet.ts`](probe-fleet.ts) (run with
  `bun run --env-file=.env.local specs/done/vm-compute-fees/research/probe-fleet.ts`
  from the repo root).

## Verdict 1 — WITHDRAWN. `exe stat` is still 403 on the token

> **Superseded 2026-08-10.** This section claimed the July 403 no longer
> reproduced. It does. The probe that "disproved" it ran over SSH, not over the
> HTTPS token production uses. See
> [the correction](#correction-2026-08-10--the-kill-gate-passed-on-the-wrong-transport).
> Everything below this heading in the ORIGINAL section was wrong; the verdicts
> about the payload shape, the fleet distribution and the cost model are
> unaffected, because those describe data rather than permission.

## Verdict 2 — the payload carries the billable unit natively

```json
{
  "timestamp": "2026-08-07T20:25:57Z",
  "cpu_cores": 0.02,
  "cpu_nominal": 4,
  "mem_used_bytes": 555114496,
  "mem_total_bytes": 8589934592,
  "fs_used_gb": 7.449460736,
  "fs_total_gb": 30.064771072,
  "disk_size_gb": 30.064771072,
  "disk_used_gb": 0.132644864,
  "disk_logical_used_gb": 0.42448896,
  "network_tx_mbps": 0.00036,
  "network_rx_mbps": 0.00077,
  "io_read_mbps": 0,
  "io_write_mbps": 0,
  "vm_name": "workspace-redacted"
}
```

- **`cpu_cores` is absolute cores, not a percentage.** No `cpuPct × width`
  reconstruction, and no need to cache VM width anywhere — which matters
  because `vmSizeModel.ts:55` deliberately refuses to cache it.
- `cpu_nominal` gives the allocated width for free, so a "% of your VM" display
  needs no second source.
- Points arrive at a ~10-minute cadence (the in-VM sampler ran at 5).

### Do not use `disk_used_gb`

It looks tailor-made for storage reporting — 0.13 GB on a VM whose filesystem
reports 7.449 GB used, i.e. "image excluded for free." It is not stable:

| point | `fs_used_gb` | `disk_used_gb` |
|---|---|---|
| 20:25:57 | 7.449460736 | 0.132644864 |
| 20:35:58 | 7.449460736 | 0.125353984 |
| 20:45:58 | 7.449460736 | 0.126873600 |

Cumulative usage does not fall. It also contradicts the July pool probe, where
account-level `disk_used_bytes` came to ~6.4 GB per VM — i.e. the image *is*
counted there (`specs/done/per-tier-storage/research/disk-billing.md`). Two
fields, two meanings, one unexplained. `fs_used_gb` is the stable one and is
what the plan stores.

## Verdict 3 — the real fleet is nowhere near the abuse threshold

16 workspace VMs, all currently 4 cores / 8 GB (no Pro or Max VM exists yet, so
those widths are **unmeasured**).

| Population | cores avg | cores p95 | cores max | RAM avg | RAM max |
|---|---|---|---|---|---|
| Idle (10 of 16) | 0.019–0.020 | 0.020 | 0.02 | 0.02–0.16 GB | 0.67 GB |
| Working (6 of 16) | 0.056–0.144 | 0.34–0.35 | 0.36 | 0.08–0.48 GB | 1.08 GB |
| A 4-core miner would be | 4.000 | 4.000 | 4.00 | ~7 GB | 8 GB |

The idle floor of ~0.02 cores is the [idle-vm-cpu](../../idle-vm-cpu/) work showing up;
it was ~0.33 before.

**Abuse is ~28× the busiest legitimate VM on CPU and ~15× on RAM.** That gap is
the entire reason the plan charges from the first core-hour instead of granting
a free allowance — at the chosen rates an idle VM costs $0.09/month and the
busiest real VM $0.52/month, so an allowance would buy nothing but a threshold
to tune and an edge to explain.

## Verdict 4 — cost model at the chosen rates

$0.003/core-hour, $0.0006/GB-hour:

| | core-h/mo | GB-h/mo | fee | vs Starter grant |
|---|---|---|---|---|
| Idle VM | 14.4 | 72 | $0.09 | 0.4% |
| Busiest real VM | 103.7 | 345.6 | $0.52 | 2.6% |
| Starter saturated | 2880 | 5760 | $12.10 | 61% |
| Pro saturated | 5760 | 11520 | $24.19 | 40% of $60 |
| Max saturated | 7200 | 17280 | $31.97 | 13% of $250 |

Starter binds — correctly, since it is the cheapest plan to abuse. A single flat
rate is naturally progressive in the user's favour because grants scale faster
than VM width.

## RESOLVED 2026-08-10 — `stat` granted, gate re-run honestly, PASS

The blocker below is closed. `stat` **is** grantable on an exe.dev API key; the
web dialog's command list is scrollable and it sits below the fold. Minted via

```
ssh-key generate-api-key --label=… --cmds=<list> --exp=never
```

**`--cmds` is not validated** — a name exe.dev does not recognise is accepted
silently and the key simply cannot run it. `share` alone yields 403; the
grantable name is the full `share set-public`, the same way the dialog lists
`domain add`. Every scope was therefore exercised against a throwaway canary
(`new → share set-public → resize → restart → cp → rm`) before the key was
deployed. Do this again on any future re-mint; a clean mint proves nothing.

The replacement key is deliberately **broader than today's callers** and expires
**never** — the narrow, default-scoped key is exactly what produced this
outage, and a 30-day key would produce a silent fleet-wide one a month out.
`team *`, `billing *` and `ssh-key add/remove` are excluded: a backend token
should not administer the account, move money, or mint credentials for itself.

### The gate, re-run over HTTPS with the deployed credential

```
failures: 0/16 · points seen: 2,288 · VERDICT: PASS
```

### Numbers that change, now that they are measured on the right transport

| | over SSH (wrong) | over HTTPS (real) |
|---|---|---|
| `stat` latency p50 | 3,407 ms | **751 ms** |
| 500-VM serial sweep | ~28 min | ~6.3 min |
| Gap between points | 61 s – 1,049 s | **600 – 601 s**, dead flat |

The gap distribution is the significant one: over HTTPS the cadence is a clean
ten minutes, not the ragged 1–17.5 minutes SSH reported. `VM_USAGE_MAX_POINT_GAP_MS`
stays at **35 min** regardless — real gaps sit nowhere near it, and a larger
clamp only ever *accepts* more intervals, so the conservative value costs
nothing. Slice 04's bounded concurrency likewise stays: it was sized against the
pessimistic number and remains correct at the real one.

## CORRECTION 2026-08-10 — the kill gate passed on the wrong transport

**Everything in the "Slice 00 feasibility results" section below was measured
over SSH, which is not how production talks to exe.dev. The gate should have
read FAIL.**

`ExeClient` picks its transport from whether it was given a token:

```ts
get transport() { return this.token ? 'https' : 'ssh' }
```

The probes constructed `new ExeClient()` with no arguments, so they took the
**SSH** path — authenticating as the account owner, which can run any command.
The deployed backend constructs `new ExeClient({ token: EXE_TOKEN })` and speaks
**HTTPS `/exec`**, which is scope-limited.

Re-run with the token, against the same fleet:

```
failures: 16/16
points seen: 0
stat duet-ws-… --range=24h (http 403)
{"error":"command not allowed by token permissions"}
```

`list` succeeds on the same token; `stat` does not. **The HTTPS token has never
carried `stat` scope** — the July 403 recorded in
`specs/done/per-tier-storage/research/disk-resize.md:126` was this same wall, and
it was never lifted. Nothing about `EXE_TOKEN` changed; `.env.local`,
`.env.staging` and the deployed Convex all hold the same value.

**Consequence: the feature cannot meter anything until `stat` is granted to the
HTTPS token at exe.dev.** The code is complete and every local gate is green;
the deployed sampler logs a per-VM 403 and stores nothing, which is the designed
behaviour for an unavailable provider — it does not bill zero.

`probe-feasibility.ts` now refuses to run over SSH, so this gate cannot pass
that way again.

**What survives the correction:** the Q3 gap distribution and the Q5
interval-average verdict are still valid — they describe the provider's data,
which is the same whichever transport reads it. What does not survive is Q1's
verdict and Q2's latency numbers (SSH is far slower than HTTPS: p50 3.4s vs
229ms, so the concurrency requirement in slice 04 is more conservative than it
needs to be, which is harmless).

## Slice 00 feasibility results — 2026-08-09 (MEASURED OVER SSH — see correction above)

Run: [`probe-feasibility.ts`](probe-feasibility.ts), read-only over 16 VMs.

### Q1 — token and field coverage: **PASS**

`0/16` failures, **2,258 points**, and every one of `cpu_cores`, `cpu_nominal`,
`mem_used_bytes`, `mem_total_bytes` present, finite and non-negative on **every
point**. The kill gate is green: provider metering is viable.

### Q2 — latency: slower than assumed, and it reshapes slice 04

**p50 3,407 ms, p95 5,462 ms per `stat` call.** That is far slower than a lobby
call and it changes the sampler's shape:

| fleet | serial | at concurrency 8 |
|---|---|---|
| 100 VMs | ~5.7 min | ~0.7 min |
| 500 VMs | **~28.4 min** | ~3.5 min |

A serial 500-VM sweep would take nearly half an hour inside one Convex action —
comfortably a timeout. **Slice 04 must sample with bounded concurrency, not a
serial `for` loop**, and its cursor batching is load-bearing rather than
defensive. This is the "first N-call fan-out" firewall becoming a measured
requirement.

### Q3 — gap distribution: the 10-minute cadence is a lie

n=2,242 consecutive pairs:

| min | p50 | p99 | max |
|---|---|---|---|
| **61 s** | 600 s | 977 s | **1,049 s** |

The nominal cadence is 600 s, but real gaps run from **1 minute to 17.5
minutes**. Any implementation that assumes 10-minute intervals would be wrong on
both tails — which is exactly what decision 16 forbids, now with evidence rather
than principle behind it.

**`VM_USAGE_MAX_POINT_GAP_MS = 35 * 60 * 1000`** — 2× the observed maximum,
rounded up. Above the p99 by a wide margin so normal jitter is never clamped,
and far below the multi-hour gap a real provider outage would produce.

### Resolved: the 7-day anomaly is a non-issue

`--range=24h` returns **141–142 points**, which is the full ~144 the cadence
implies. The earlier observation that `--range=7d` returned only 57–93 points
therefore says something about the 7d range specifically, not about data
density. The fee only ever reads 24h windows, so this open question is closed as
irrelevant — but it does mean **`--range=7d` must not be used for backfill**
without re-measuring.

## Slice 00 canary results — 2026-08-09

Run: [`probe-canary.ts`](probe-canary.ts). Three VMs created and removed
sequentially; cleanup verified clean.

### Q4 — Pro reports its nameplate; Max is **still unverified**

```
pro: reported 8c/16G · expected 8c/16G — MATCH
max: no metrics point appeared within 5 minutes
```

Pro matches exactly. The Max canary was removed before its first metrics point
existed, so **`cpu_nominal` on a 10c/24G VM has never been observed**. Low risk
— Pro matching means the mechanism reports provisioned width faithfully — but
it is an assumption, not a measurement, and the affordability table's Max row
rests on it. Re-run with a longer poll if it ever matters.

### Q5 — `cpu_cores` is an **interval average**, so integration is by step

One core pinned for 11 minutes produced **a single point at 0.900 cores**.

That is the interval-average signature. An instantaneous sample taken during a
steady one-core burn would read ~1.000; 0.900 is the mean over a window the
burn covered about nine tenths of. A run of partially-raised neighbouring
points, which is what instantaneous sampling produces, did not appear.

**Consequence for `integrateVmUsage`: each point owns the interval behind it at
full height (step), never a trapezoid between neighbours.** Trapezoidal
integration would average each reading with the one before it and systematically
under-report the leading edge of any burst — which is exactly the shape abuse
takes.

### An unplanned finding: a new VM produces no metrics for several minutes

The Max canary produced **zero** points in ~5 minutes, and the burn canary's
first point arrived ~4 minutes after creation.

**This narrows but does not close the create-and-destroy evasion** that slice 07
was written to handle. A workspace created and destroyed inside roughly five
minutes yields no points at all, so the teardown charge has nothing to bill.
The exposure is bounded — a few minutes of compute per provision cycle, and
provisioning is slow and auditable — but slice 07 should not claim the hole is
fully closed.

## Caveats — what this probe does NOT establish

- **Pro and Max widths are unmeasured.** Every live VM is 4c/8G.
- **`--range=7d` returned only 57–93 points per VM**, not the ~1000 a full week
  at 10-minute cadence would give. Either the VMs are young or the range
  downsamples. Irrelevant to a 24h billing window; would matter for any backfill.
- **Rate limits are unknown.** 16 `stat` calls a day is free; 500 is untested.
- **The 0.712 "fleet avg concurrent cores" the script prints is approximate** —
  it derives the window length from point count, which the 7d anomaly above
  makes unreliable. Treat the per-VM averages as sound and that one aggregate
  as indicative only.
