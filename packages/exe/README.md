# @repo/exe

A small exe.dev control-plane client plus probes for kicking the tires on
[exe.dev](https://exe.dev) as a sandbox backend for v2 — specifically to **get a
feel for start / stop times**.

## Why this exists

Today the product runs on [e2b](https://e2b.dev). e2b's persistence is a
**memory snapshot**: `pause` freezes RAM + processes, `resume` restores them in
~1s. That's fast, but it has real downsides we've hit:

- snapshots can **lose data** / behave inconsistently across multiple
  resume cycles, and
- long-lived sandboxes (6+ months) get **janky**.

exe.dev takes the opposite approach: a VM is a **persistent disk you reboot**
(Cloud Hypervisor micro-VM, ~2s to create). There is **no memory snapshot** —
so "resume" is really a cold boot from disk. That trades e2b's instant
memory-restore for a simpler, more durable model. The open question is: **how
much does the reboot actually cost?** That's what this package measures.

### How the models differ

|                  | e2b                           | exe.dev                                    |
| ---------------- | ----------------------------- | ------------------------------------------ |
| Persistence unit | memory snapshot + fs          | persistent disk (fs only)                  |
| "Resume"         | restore RAM & processes (~1s) | reboot from disk                           |
| Survives restart | processes + RAM + files       | **files only**                             |
| Retention        | paused up to 30 days          | indefinite (you keep the disk)             |
| Control API      | SDK                           | SSH (`ssh exe.dev …`) / HTTPS `POST /exec` |

## Prerequisites

exe.dev's control plane is available two ways; the harness auto-selects based
on whether `EXE_TOKEN` is set.

**HTTPS token (default here).** Put a token in the repo-root `.env.local`:

```bash
EXE_TOKEN=exe1.…    # mint one with: bun run token
```

The token needs `cmds` covering `new`, `ls`, `restart`, `rm` (the one in
`.env.local` already does). The `bench`/`demo` scripts load `../../.env.local`
automatically. Verify your access with `bun run whoami`.

**SSH.** Register your local key by running `ssh exe.dev` once, then leave
`EXE_TOKEN` unset. Only SSH can run commands _inside_ a VM, so SSH mode also
measures true shell-readiness (see the caveat below).

SSH and HTTPS lobby operations share a finite command budget, including response
bodies. Creation gets a longer budget for a cold image pull; other commands keep
their short budget. A timed-out create or delete may already have taken effect; lifecycle
owners settle it by their recorded resource identity.

## Usage

### Timing benchmark

Creates a fresh VM per iteration, times each lifecycle phase, deletes it, then
prints avg/p50/p90/p95/min/max:

```bash
bun run bench -- --iterations 5
bun run bench -- --iterations 10 --image exeuntu --cpu 2 --memory 4GB
bun run bench -- --iterations 3 --keep      # don't delete (inspect the VMs)
```

Metrics — **HTTPS**: `create`, `running`, `restart`, **`restartRunning`**,
`delete`. **SSH**: `create`, `sshReady`, `exec`, `restart`, **`restartReady`**,
`delete`. The `restart*` metric is the stop→start / reboot-from-disk cost — the
number to compare against an e2b resume.

#### ⚠️ What each transport actually measures

`create`/`restart`/`delete` are **control-plane round-trip latencies** (how long
the `new`/`restart`/`rm` API call takes). Over HTTPS, `running`/`restartRunning`
just confirm the **lobby marks the VM `running`, which happens almost instantly
(~200 ms) and is NOT a booted, usable OS**. To measure real boot-to-usable time
you must use SSH mode (`sshReady`/`restartReady` poll an actual in-VM shell) —
that needs your SSH key registered with exe.dev.

#### Measured baseline (5 iterations, HTTPS, default 2 CPU / exeuntu)

| metric                   | avg     | min    | max                         |
| ------------------------ | ------- | ------ | --------------------------- |
| `create` (new returns)   | ~0.9 s  | 0.84 s | 1.05 s                      |
| `running` (lobby flips)  | ~0.2 s  | —      | — (one poll; not real boot) |
| `restart` (returns)      | ~1.25 s | 1.19 s | 1.41 s                      |
| `restartRunning` (lobby) | ~0.2 s  | —      | — (one poll; not real boot) |
| `delete` (rm returns)    | ~1.3 s  | 1.08 s | 1.85 s                      |

Takeaway: the exe.dev **control plane is sub-second-to-~1.4 s** for each op. The
true reboot-from-disk time (the real "stop/start" cost vs e2b's ~1 s memory
resume) still needs an SSH run to pin down.

### Lifecycle demo (disk persists, memory doesn't)

Creates (or reconnects to) one VM, writes a file + starts a background process,
restarts, and verifies that **the file survives but the process and uptime do
not** — proving the no-live-memory behavior — while timing the reboot:

```bash
bun run demo             # leaves the VM running for reruns
bun run demo -- --cleanup   # delete the VM afterwards
```

State (the VM name) is cached in `.exe-state/` so reruns reconnect to the same
VM. The demo drives create/restart/delete over the token when `EXE_TOKEN` is
set, but its in-VM steps (writing files, checking the process) still require
SSH access to the VM. Add `--verbose` to any command to echo every underlying
call (`POST /exec` or `ssh`).

## Layout

- `src/exe.ts` — typed client: `create` / `restart` / `remove` / `list` /
  `getStatus` / `waitUntilRunning` (both transports), plus `exec` /
  `waitUntilReady` (SSH-only, in-VM).
- `src/index.ts` — public package entrypoint for `@repo/exe`.
- `scripts/benchmark-lifecycle.ts` — the timing harness.
- `scripts/lifecycle-demo.ts` — the persistence-semantics demo.
- `scripts/probe-shared-chrome.ts` — one disposable native-image check for the
  systemd-owned shared Chrome, loopback CDP, window identity and geometry, and
  a real persistent cookie surviving a full desktop target stop/start.
- `scripts/probe-browser-extension.ts` — one disposable exact-image check for a
  deterministic policy-installed MV3 extension, its loopback command channel,
  exact Chrome tab-to-CDP-target correlation, worker/browser-generation
  reconnect, and an independent X11 focus oracle.
- `scripts/probe-chrome-freeze.ts` — one disposable exact-image gate for the
  page-scoped Chrome lifecycle freeze: renderer CPU economics, state-preserving
  thaw, and the explicit media/dialog/popup/download/service-worker boundary.
- `scripts/probe-chrome-tab-suspension.ts` — one disposable exact-image kill gate
  comparing extension-native tab freeze with tab discard while retaining exact
  tab/window/URL/target, CPU, restore, and state-loss evidence.
- `scripts/probe-cdp-proxy.ts` — one disposable native-image check that runs the
  workspace-browser Playwright shape through a transparent browser-level CDP
  relay while a separate actuator connection places new tabs.

## Rail-only share-sync probe

`bun run probe:rail-share-sync` creates two temporary staging workspaces and
proves share realization through the VM sync rail. It never configures a share
through gateway mutation endpoints. The probe checks complementary
origin/recipient realization, byte arrival, ten unchanged polls, gateway
restart healing, revoke and unlink pruning, share floors, read-mode enforcement,
and retained recipient bytes.

The staging secrets come from the repository environment. The probe creates a
run-tagged staging-E2E identity through the programmatic login seam, uses the
internal-key Convex seams with that explicit actor, then retires the identity
after its workspaces and credentials are removed. No hand-minted Convex auth
token or pre-existing probe account is required.

Every run writes a credential-free JSON transcript under
`probe-results/transcripts/`, exits nonzero on a failed leg or cleanup, and
removes the exact workspaces and VMs it created. Markdown reports from the
exe.dev mechanism probes live alongside them under `probe-results/reports/`;
these package-owned paths do not depend on archived feature specs.

## VM size probe

`bun run probe:vm-caps` answers the only question that gates a change to how big
workspace VMs are: will exe.dev actually schedule this size? It creates one
throwaway VM per size and deletes it immediately.

Two things make the answer non-obvious. A workspace VM lives in a **reserved
pool**, and the pool — not the account plan — is what bounds it: cpu cannot
exceed the pool's own width, while memory is bounded by the account plan only
for VMs created _outside_ a pool. A probe that forgets the pool measures a limit
that applies to nothing we provision. And a rejection is not always a rejection:
a `422` names a real limit, a `504` is a transient scheduling timeout, so a size
that fails once may schedule instantly on the next run.

The sizes probed are read from the caps table in `@repo/contract` rather than
listed here, so this always measures what production asks for. Raising a cap
past the pool's width needs exe.dev to grow the pool first.

## Tier-disk rail probe

`bun run probe:tier-disk` is the per-tier-storage kill gate: one disposable
staging VM from the real Duet image proves the staging token's
resize/restart scope, public-share survival across the resize-reboot,
empty-drive headroom vs the advertised tier size, in-VM `du` cost, and the
resize→restart→healthz blip. The report is retained at
`specs/done/per-tier-storage/research/tier-disk-rail.md`; the run exits nonzero
if any verdict goes unmeasured, the token scope is short, or a test VM
leaks.
