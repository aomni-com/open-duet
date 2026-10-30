# 01 — Upstream: deliver a wake that lands mid-turn

**Repo:** `~/dev/duet-agent`. **Conditional on slice 00-A red.** If 00-A is
green, skip to slice 03 and land 00's tests as regression pins.

## Contract unlocked

A `wake` command accepted during an active turn is executed, not silently
dropped. A one-time reminder fires exactly once even when its deadline lands
mid-turn.

## API seam

`src/turn-runner/turn-runner.ts`, owned by the parent input loop. Two candidate
shapes:

- **(a) route like steer** — extend `handleCommandDuringActiveTurn`
  (`:1073-1090`) so a wake reaches the running parent the way
  `sendCommandToAgent` delivers steer/follow-up.
- **(b) hold at the boundary** *(recommended)* — keep the enqueue, remove the
  unconditional `continue` at `:954-961`, and let the loop process the wake once
  `pendingWork()` settles.

**Take (b) unless the test says otherwise.** (a) creates a second delivery route
for one concept (`parentInputs` versus pi's native queues) and needs a
wake→user-message translation that does not exist. (b) is a deletion plus a
narrowed guard. 00-A pins the observable either way, so (a) remains available
with evidence.

The guard must be *narrowed*, not removed: a stale wake — one with nothing
pending behind it — must still be a no-op. That is what `:954-961` was for.

## Hygiene included in this slice, not used to justify the release

U1 and U2 live in `src/session/session.ts` and are **off Duet's path** (RPC
bypasses `SessionManager`). Fix them here because they are real for the TUI and
for library consumers:

- `prompt()`, `answer()`, `interrupt()` each call `cancelWake()` (`:263, 276,
  290`) with the only re-arm being a `sleep` terminal (`:533`). Cancellation
  moves to the places that legitimately retire a deadline: a non-`sleep`
  terminal, and `dispose`.
- In `fire()`, move the `cancelWake()` at `:613` **after** the
  `status !== 'sleeping'` check at `:615`, so a non-sleeping instant stops
  killing the 30s poll that the comment at `:618-620` exists to preserve.

## What the human can run or see

00-A green. For the hygiene half: `bun run cli`, set a short reminder, chat
during it, reminder still fires.

## Verification gates

`bun run test` (full Docker suite), `bun run check-types`, `bun run lint`.

## Must stay green

`test/turn-runner-active-turns.test.ts`, `test/state-machine-*.test.ts`,
`test/quiescence.test.ts`, and `session.test.ts`'s sleep/resume cases including
`replaySleepFromResumedState` (`:250-258`).

## Fixed by this slice

Boundary redelivery over model injection. The queued-wake skip is narrowed to
stale wakes rather than deleted. U1/U2 are hygiene and are named as such in the
commit message.

## Delegated to the implementer

(a) versus (b) given test evidence; the internal representation of a held wake;
whether `interrupt()` retires the wake (it should — an interrupt is a deliberate
stop).

## What feedback would change this slice

If the fix cannot make 00-A green without changing public relay semantics, stop:
do not advertise reminders, do not build `schedule-task`'s reminder half, and
keep the red repro as the blocker.
