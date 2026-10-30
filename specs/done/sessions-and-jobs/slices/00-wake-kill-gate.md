# 00 — Wake kill gate: prove the mid-turn reminder is lost

**Kill gate.** Nothing in this spec may cite "the wake bug" until this slice has
a colour. No production code changes here.

## Contract unlocked

A deterministic verdict on one question: **when a one-time reminder's deadline
arrives while a turn is already running, is the reminder delivered?**

## Why this is a gate and not a bug fix

MAP.md L2 originally filed four live defects. A second reading found the
invariant that masks most of them: a turn cannot end while scheduled work is
pending — `pendingWork().kind === 'sleep'` breaks the parent loop and yields a
`sleep` terminal (`~/dev/duet-agent/src/turn-runner/turn-runner.ts:996-1005`,
`:1381`), so a prompt to a sleeping session re-emits `sleep`, normally with the
same `wakeAt`, which re-arms every timer downstream. A passing test already
covers that (`test/session.test.ts:913`).

What the invariant does **not** cover is a wake arriving while a turn is genuinely
active. That is this slice.

## The seam — read this before writing the test

**Drive `TurnRunner.turn({ type: 'wake' })` directly.** Do not write this
end-to-end.

Duet's gateway spawns `duet --rpc` (`RUNNER_RPC_FLAG`,
`packages/gateway/src/runner/process-runner.ts:322`), and **RPC mode bypasses
`SessionManager` entirely** — stated outright at
`~/dev/duet-agent/src/cli/rpc.ts:210-211`. `runRpcCommand` routes a `wake`
straight to `runner.turn(...)` (`src/cli/rpc.ts:531-541`).

Consequently:

- `Session.scheduleWake` (`src/session/session.ts:609-638`) — where U1's
  cancel-on-prompt and U2's `fire()` ordering live — **is not on Duet's path.**
- Neither current caller ever hands a wake to a live runner: `Session.fire()`
  returns unless the state is already `sleeping` (`:614-615`), and the gateway
  deletes its wake record the moment it is claimed. **An end-to-end repro will
  therefore go green for the wrong reason and prove nothing.**

Build on `TestTurnRunner` (`test/helpers/turn-runner-protocol.ts:26`): it
subclasses the production `TurnRunner` and overrides only `runAgentWorker` /
`createStateSubagentRun`, so the turn loop, `taskManager`, and `parentInputs`
queue under test are the real ones. Inject `ManualRuntimeClock`
(`test/helpers/manual-runtime-clock.ts`) through the `clock` dependency
(`src/turn-runner/turn-runner.ts:200-201, 530`) and drop
`minimumScheduledDelayMs` (`:532`) so the 30s floor does not force real time.

## The three repros

**00-A — repo `~/dev/duet-agent`, the one that decides the gate.**
`test/turn-runner-wake-midturn.test.ts`. Definition
`timer(reminder) → agent(tell_user) → terminal`. Start an agent state so a turn
is genuinely running (`activeTurnPromise` set, `pendingWork().kind === 'open'`),
then call `runner.turn({ type: 'wake' })`. Assert the reminder is delivered
exactly once.

Expected red: the wake is enqueued as `{ type: 'wake', queued: true }`
(`turn-runner.ts:1081-1083`) and then `continue`d past (`:954-961`).

**00-B — repo `~/dev/duet-agent`, off Duet's path, secondary evidence only.**
`test/session-wake-survives-prompt.test.ts`. `Session` + `ManualRuntimeClock`:
sleep pending → `prompt()` → advance past `wakeAt` → assert the wake still
fires. Must be driven by a real `TurnRunner`, not `FakeTurnRunner` — the
existing test at `session.test.ts:913` uses a scripted terminal list and so
cannot see this. **A red here does not on its own justify a release**; label it
in the test name and the README as TUI/library surface.

**00-C — repo Duet.** `packages/gateway/src/agent-sessions/coordinator.wake.test.ts`
with injected timers: session sleeping with an armed wake → deliver a prompt →
assert the wake survives. `claimWakeForCommand` cancels the timer
(`coordinator.ts:298`) and `finishWakeClaim` → `ledger.clearWakeClaim` deletes
the record outright. Whether that is observable depends on the runner
re-emitting `sleep` — which is what 00-A/00-B decide.

## What the human can run or see

Three named tests and, for each, a red/green line recorded in this spec's
README. Follow [write-tests](../../../.claude/skills/write-tests/SKILL.md) and
capture the initial red output verbatim before touching production code.

## Verification gates

1. `cd ~/dev/duet-agent && bun run test` (Docker; wrap file-writing cases in
   `testIfDocker` or they silently never run).
2. `bun run test` in Duet for 00-C.
3. The new tests must fail against untouched 0.3.7 **before** any production
   edit. A test that has never been red is not a repro.

## Must stay green

`test/turn-runner-active-turns.test.ts`, `test/state-machine-*.test.ts`,
`test/quiescence.test.ts`, and `session.test.ts`'s sleep/resume cases. The
`continue` at `:954-961` exists to skip *stale* wakes — a stale wake must remain
a no-op after any later fix.

## Fixed by this slice

- The repro runs against the real turn loop with the model stubbed, never
  against a scripted terminal list.
- The verdict is evidence, not implementer judgment.
- Green means no 0.3.8. Red means slices 01, 02, 04 run.
- Slice 03 runs either way.

## Delegated to the implementer

The exact definition JSON, fixture naming, and how the harness suspends an agent
state mid-flight.

## What feedback would change this slice

A production sighting of a missed reminder outranks the test: if one exists, the
gate is red regardless of what 00-A reports, and slice 01 starts from the
sighting instead.
