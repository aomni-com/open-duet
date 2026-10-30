# Slice-09 gate probe: production attribution helper

Run: 2026-07-13T04:30:36.966Z on VM `duet-test-attribution-helper-20260713t042925-gsmw` (deleted after capture).
Artifact under test: `packages/gateway/src/attribution/helper-main.ts` bundled
with `bun build --target=bun` (the slice-10 release shape), run as
`sudo bun helper-main.js /home/synthetic-user/drive <gatewayPid>` with stdout a pipe
(L12) and commands on stdin. All numbers below are read from its production
NDJSON frames — no probe-side shims. Mechanism pre-probe:
[fan-open-perm-probe.md](fan-open-perm-probe.md) (GREEN).

## Environment

- Kernel: `6.12.93`, Bun: `1.3.14`, uid: 0
- Session cgroups: `/sys/fs/cgroup/runners/session-alpha1` (member A),
  `…/session-beta2` (member B) — canonical slice-08 leaves; the helper emits
  the leaf name as `unit`.
- Protocol lint: 12438 stdout lines, 0 unparseable → PASS.

## 1. Real filenames: create / delete / rename / atomic save (PASS)

| Op                               | Frame                                                     |
| -------------------------------- | --------------------------------------------------------- |
| create                           | `{"path":"m/created.txt","unit":"session-alpha1"}`        |
| delete                           | `{"path":"m/created.txt","unit":"session-alpha1"}`        |
| rename (×1, dedup wants 1)       | `{"path":"m/new.txt","fromPath":"m/old.txt","unit":null}` |
| shell atomic save → joined write | `{"path":"m/report.md","unit":"session-alpha1"}`          |
| python os.replace → joined write | `{"path":"m/editor.md","unit":"session-alpha1"}`          |
| content read                     | `{"path":"m/new.txt","unit":"session-alpha1"}`            |

Paths are drive-relative. Both atomic saves attribute the REAL filename to the
writer's unit via the codec's handle→writer join — the writer was pinned at its
open even though python had exited before the rename's NOTIF delivery.

Units on the delete/rename rows are best-effort by mechanism: `rm`/`mv`
are short-lived exec'd binaries whose unlink/rename syscalls involve NO open,
so the perm gate never pins them and the live `/proc` fallback races their
exit (measured rate in §5). The criterion here is: real filenames always,
never a WRONG unit, and every pin-reachable frame (create/write/read +
atomic-save joins) deterministically attributed.

## 2. Long-lived cgroup member: 20/20 (PASS)

20 redirection writes by the session-cgroup bash itself —
every file carries `unit: "session-alpha1"`.

## 3. THE GATE — short-lived `sh -c` attribution (PASS)

The case the first FID spike lost 0/20: each opener is a distinct short-lived
process, pinned by the FAN_OPEN_PERM group while blocked in open(2).

| Workload                            | Attributed |
| ----------------------------------- | ---------- |
| `sh -c 'cat f'` × 20                | **20/20**  |
| `sh -c 'echo x > f'` × 20           | **20/20**  |
| frames with unit null in this phase | 0          |

## 4. Grandchildren + parallel sessions (PASS)

- Grandchild (`sh -c 'sh -c …'`) write: `{"path":"s/gc.txt","unit":"session-alpha1"}` — cgroup
  inheritance needs no tracking.
- Two sessions bursting 20 concurrent short-lived writers each:
  A 20/20, B 20/20,
  cross-attributed frames: **0**.

## 5. 500 renames: count + overflow (PASS)

| Metric                                                       | Value         |
| ------------------------------------------------------------ | ------------- |
| rename frames (want exactly 500: FAN_RENAME vs legacy dedup) | 500           |
| final stats overflow                                         | 0             |
| mv unit: attributed / null / WRONG                           | 161 / 339 / 0 |

Each `mv` is a short-lived pid that performs rename(2) with NO open — the
perm gate never sees it, so its unit rides the racy live-`/proc` fallback:
161/500 attributed, never to a
wrong unit. Phase-1's single mv: unit `null`.
**Slice-10/11 input:** rename attribution for fork-per-rename workloads is
best-effort; the atomic-save join (§1) already carries the writer's unit, so
the loss is the standalone-`mv` audit row, not save attribution.

## 6. Exclusion, suppress, shutdown (PASS)

| Check                                   | Result     |
| --------------------------------------- | ---------- |
| gateway-pid write → frames              | 0 (want 0) |
| frames from the helper's own pid        | 0 (want 0) |
| writes while suppressed → frames        | 0 (want 0) |
| frame after suppress off                | yes        |
| `{"t":"shutdown"}` on stdin → exit code | 0          |

## 7. Per-open overhead (kill criterion: +1 ms p99) (PASS)

| Workload          | p50 base → helper (added) | p99 base → helper (added)         | p99.9 helper |
| ----------------- | ------------------------- | --------------------------------- | ------------ |
| Sequential (5000) | 0.7 µs → 6.9 µs (+6.3 µs) | 1.8 µs → 158.2 µs (**+156.4 µs**) | 1092.3 µs    |
| Storm (10000)     | 1.0 µs → 7.4 µs (+6.4 µs) | 2.6 µs → 49.4 µs (**+46.8 µs**)   | 7669.7 µs    |

Unlike the pre-probe's minimal listener this includes the full production path
(NOTIF decode + O_PATH resolution + joiner running concurrently).

## 8. Memory flatness — OOM landmine (PASS)

633,156 gated opens in a 5s spin
(fs frames suppressed so the stdout pipe is not the variable; decode, O_PATH
resolution, and perm handling all live). Helper RSS sampled every 200 ms:

- samples (KB): 110636 → 110272 → 107312 → 108840 → 105444 → 105240 → 100680 → 99404 → 99404 → 103100 → 103100 → 102792 → 101228 → 101228 → 99696 → 99712 → 99712 → 99712 → 99712 → 99712 → 99616 → 99568 → 99568 → 99728 → 99728 → 99376 → 98992 → 93124
- steady-state drift (2nd half): **6604 KB** (bound 15000)

## 9. Crash safety + clean shutdown (PASS)

| Check                          | Result                      |
| ------------------------------ | --------------------------- |
| SIGTERM → exit code            | 0                           |
| final stats frame emitted      | yes                         |
| final counters                 | overflow=0 cgroupMisses=343 |
| kill -9 mid-storm: victim hung | no                          |
| opens before / after kill      | 91841 / 1253323             |
| max post-kill stall            | 4.35 ms                     |

## Criteria

| Criterion                                            | Result                           |
| ---------------------------------------------------- | -------------------------------- |
| create/delete/rename/atomic-save → real filenames    | PASS                             |
| long-lived cgroup member 20/20                       | PASS (20/20)                     |
| **short-lived sh -c cat/echo attributed (the gate)** | **PASS** (cat 20/20, echo 20/20) |
| grandchildren attribute via inheritance              | PASS                             |
| parallel bursts never cross-attribute                | PASS (cross=0)                   |
| 500 renames, zero overflow, no double count          | PASS (500/500)                   |
| self/gateway-pid exclusion                           | PASS                             |
| suppress + shutdown commands                         | PASS                             |
| per-open added p99 < 1 ms (seq + storm)              | PASS                             |
| RSS flat across the storm                            | PASS                             |
| clean SIGTERM with final stats                       | PASS                             |
| kill -9 auto-allows (no I/O wedge)                   | PASS                             |
| every stdout line is a valid frame                   | PASS                             |

Verdict: **GREEN** — the production helper reproduces the pre-probe mechanism end to end. Short-lived attribution 20/20 + 20/20 (the number that decides slice 10); atomic saves attribute the real filename to the pinned writer; two concurrent sessions never bleed into each other; overhead, memory, and crash behavior hold the pre-probe envelope. Slice 10 (supervision + packaging) can build on this helper unchanged. Known best-effort edge, measured above: unit attribution of open-less short-lived processes (`rm`/`mv` — unlink/rename with no open → no pin) — 161/500 renames via live fallback, 0 wrong; a slice-11 policy input, not a helper defect.
