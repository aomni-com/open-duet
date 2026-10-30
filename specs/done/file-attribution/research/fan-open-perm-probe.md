# FAN_OPEN_PERM pid-pinning pre-probe (slice 09, reslice mechanism)

Run: 2026-07-13T03:55:58.335Z on VM `duet-test-fan-open-perm-20260713t035510-sdkb` (deleted after capture).
Question: is the resliced slice-09 mechanism — a second fanotify group
(`FAN_CLASS_CONTENT | FAN_OPEN_PERM`) that pins `pid → /proc/<pid>/cgroup`
while the opener is blocked in `open()`, alongside the existing FID/name
`FAN_CLASS_NOTIF` group — viable on the real exe.dev image? Four measured
questions: (1) coexistence + short-lived 20/20 capture, (2) per-open overhead,
(3) listener-death auto-allow, (4) OOM-landmine memory flatness.

## Environment

- Kernel: `6.12.93`
- Bun: `1.3.14`
- Privilege: helper + driver ran as uid 0 (sudo)
- On this image the drive is a directory on the SHARED root superblock
  (drive dev `/dev/vda` == root dev `/dev/vda`), so a
  filesystem-wide PERM mark would gate every open on the VM — including this
  harness. The drive is `mount --bind`ed onto itself and the **blocking** PERM
  group (`FAN_CLASS_CONTENT`) is marked `FAN_MARK_MOUNT`, scoping the gate to
  opens resolved through the drive path only; root opens stay ungated so a
  listener stall cannot wedge the VM. The **non-blocking** NOTIF FID/name group
  uses `FAN_MARK_FILESYSTEM` (FID-mode marks *reject* `FAN_MARK_MOUNT` with
  EINVAL — measured this run). In production the drive would be its own
  mount/volume, which reproduces the same seam. The listener touches only procfs
  and a tmpfs output file after arming, so it can never block on its own gated
  open.

## 1. Coexistence + short-lived pid pinning (the fork-map-killer case)

20× `sh -c 'cat /…/shortlived/f<i>'` — each a distinct short-lived process the
first FID spike failed to attribute 0/20 (it exited before the async lookup).
Here every opener is blocked in the gated `open()`, so `/proc/<pid>/cgroup` is
read race-free while it is provably alive.

| Check | Result |
| --- | --- |
| Short-lived opens captured | 20/20 |
| Distinct files captured | 20/20 |
| cgroup read non-null for every capture | PASS |
| opener alive (comm readable) during handling | PASS |
| NOTIF (FID/name) group delivered alongside | PASS (482 events) |

Sample captured cgroup lines: `0::/init.scope`.
Total perm events handled in this phase: 20.

**PASS** — short-lived attribution 20/20, perm and NOTIF groups coexist on one mount.

## 2. Per-open overhead (kill criterion: >~1 ms p99 added ⇒ RED)

Open latency times the `open()`/`close()` syscalls only (bun:ffi libc), path
buffers pre-encoded outside the timed region. Baseline = no listener (mark
absent); listener = the pinning group active, answering `FAN_ALLOW` per open
(pid cached after first miss, so a single-pid storm pays one `/proc` read total).

| Workload | p50 base → listen (added) | p99 base → listen (added) | p99.9 listen | max listen |
| --- | --- | --- | --- | --- |
| Sequential (5000) | 1.4 µs → 5.7 µs (+4.3 µs) | 4.4 µs → 48.6 µs (**+44.2 µs**) | 1136.1 µs | 2136.1 µs |
| Storm (30000) | 0.8 µs → 4.7 µs (+3.8 µs) | 2.0 µs → 10.8 µs (**+8.8 µs**) | 479.7 µs | 3954.2 µs |

Storm wall: baseline 37 ms → listener 191 ms for 30000 opens
(5.13 µs/open mean added).

**Added p99: sequential +44.2 µs, storm +8.8 µs** — kill criterion is +1 ms (1000 µs) p99. PASS.

## 3. Listener-death auto-allow

Victim opens `f0` in a tight loop for ~2.5 s; the listener is `kill -9`'d
~0.9 s in. If the kernel auto-allows on group-fd close, opens keep flowing;
if not, the victim wedges in `open()` forever.

| Check | Result |
| --- | --- |
| Victim hung after kill (open blocked forever) | no |
| Opens before kill | 195867 |
| Opens after kill | 1065810 |
| Max single-open stall, whole run | 6.26 ms |
| Max single-open stall, after kill | 6.26 ms |

**PASS** — opens resumed immediately after the group closed; worst post-kill stall 6.26 ms.

## 4. OOM landmine — memory flatness under the storm

Slice 13 proved a watcher opening non-`O_PATH` handles self-amplifies to OOM
(RSS climbs linearly with events). This listener drops self-pid events, resolves
only via procfs readlink (no gated opens), and closes every kernel `event_fd`.
The storm plus a 5-second sustained spin drove
1,299,037 gated opens through the listener while
RSS was sampled every 200 ms:

| Metric | Value |
| --- | --- |
| perm events handled (storm + spin) | 1,299,037 (1,269,037 in the spin) |
| RSS first / last | 44292 KB / 89932 KB |
| RSS min / max | 44292 KB / 89936 KB |
| RSS drift, whole run (max − min) | 45644 KB |
| RSS drift, steady state (2nd half of samples) | 4684 KB |
| cgroup cache size / misses | 2 / 0 |

RSS sample sequence (KB, every 200 ms): 44292 → 62980 → 83120 → 87492 → 87352 → 87336 → 85392 → 85272 → 85188 → 85224 → 85240 → 85240 → 85240 → 85256 → 85256 → 85260 → 85252 → 85256 → 85256 → 85256 → 85256 → 85256 → 85256 → 85256 → 85252 → 89920 → 89936 → 89932

**PASS** — after warmup, RSS holds within 4684 KB across
1,299,037 gated opens (bounded pid cache = 2 entry, 0 misses).
It plateaus rather than climbing with event count — the self-pid-drop +
O_PATH-only + event_fd-close mitigation holds; the slice-13 landmine does not fire.

## Criteria

| Criterion | Result |
| --- | --- |
| Perm group + NOTIF group coexist; FAN_ALLOW lets the opener proceed | PASS |
| Short-lived `sh -c 'cat f'` × 20 pinned via /proc while blocked | PASS (20/20) |
| Sequential added p99 < 1 ms | PASS |
| Storm added p99 < 1 ms | PASS |
| Listener kill → opens auto-allowed (no wedge) | PASS |
| Memory flat across the storm (mitigation holds) | PASS |

Verdict: **GREEN** — the resliced slice-09 mechanism is viable on the exe.dev image. A FAN_CLASS_CONTENT/FAN_OPEN_PERM pinning group runs alongside the FID/name NOTIF group; the blocked opener lets /proc/<pid>/cgroup be read race-free (short-lived 20/20 — the case the fork map lost 0/20); per-open p99 overhead stays well under the 1 ms kill criterion; a kill -9 of the listener auto-allows pending opens (no I/O wedge); and self-pid drop + O_PATH-only resolution keep memory flat. Resliced 09 proceeds — build the helper on this mechanism.
