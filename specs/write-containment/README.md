# Write containment — agent writes confined to the drive

Status: bootstrapped from the file-attribution exploration (2026-07-12); to be
expanded via write-spec in its own session. Shares research with
[specs/file-attribution/](../file-attribution/research/).

## Goal

An agent session (and anything it execs) can write only to the workspace drive
plus a designated scratch allowlist, and can read anywhere in the VM. API and
MCP file writes are already drive-contained by the gateway. SSH terminal
sessions are explicitly exempt.

## Decisions already made

- **Mechanism: Landlock LSM, applied at agent-runner spawn.** The gateway's
  runner (`packages/gateway/src/runner/process-runner.ts`) applies a Landlock
  ruleset between fork and exec (small spawn-wrapper helper); the restriction
  is kernel-enforced and inherited by the whole process tree — same
  inheritance property the attribution design leans on for cgroups
  (`packages/gateway/src/runner/cgroup.ts`).
- **Allowlist, not literal drive-only.** Agent workflows require writable
  scratch outside the drive: `/tmp`, bun/npm/pip caches under `~`, playwright
  browsers, etc. Literal read-only-except-drive bricks the agent on day one.
- **Scope: agent sessions + API/MCP.** API/MCP writes are already contained —
  gateway file routes refuse path escapes via realpath walks
  (`packages/gateway/src/routes/files.ts`: `normalizeDrivePath`,
  `ensureSafeWriteParent`, `safeExistingPath`); pin that behavior with tests
  rather than rebuilding it. SSH terminals stay unrestricted.
- **Own spec, decoupled from file-attribution.** Attribution is observation
  (zero breakage risk); containment can break agent workflows and needs its
  own verification story.

## Territory facts

- exe.dev workspace kernel is 6.12.93 (see
  [fanotify spike](../file-attribution/research/fanotify-spike.md)) — Landlock
  is mature there, but the supported Landlock ABI level needs probing.
- Gateway runs as `exedev` with passwordless sudo; runner spawns sessions
  `detached` with per-session cgroups — the spawn point for applying the
  ruleset already exists.
- Probe harness for real-VM verification: `packages/exe/scripts/probe-*.ts`
  (see the two file-attribution probes for the pattern).

## Open questions

- **Landlock requires `no_new_privs`, so a landlocked agent cannot sudo at
  all.** Today the VM grants `exedev` passwordless sudo, and the agent may rely
  on it (e.g. `sudo apt-get install`). Decide: is losing sudo inside agent
  sessions acceptable (arguably a feature), or does dependency installation
  need a sanctioned path (e.g. a gateway-mediated install API)?
- Exact scratch allowlist (start: `/tmp`, `~/.cache`, `~/.bun`, `~/.npm`,
  `~/.duet-scratch`?) and how it's versioned/updated per image.
- How to apply the ruleset under Bun's `child_process.spawn` (likely a tiny
  exec-wrapper binary or `bun:ffi` in a preload) — needs a spike.
- Interaction with gateway self-writes and syncthing (both run outside agent
  sessions — unaffected, but verify).
- Failure mode: if applying the ruleset fails, does the session refuse to
  start (fail-closed) or start unconfined with a loud event (fail-open)?

## Verification sketch

Probe-style test on a real exe.dev VM: start an agent-session-shaped process
under the ruleset; assert writes inside the drive and `/tmp` succeed, writes to
`~/`, `/etc`, gateway state dir fail, reads everywhere succeed, and `sudo -n
true` fails inside the session.
