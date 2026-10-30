# 03 — Delete the gateway wake claim

**Repo:** Duet. **Unconditional — this runs on both branches of slice 00.**

## Contract unlocked

One wake scheduler per VM with one mutual-exclusion mechanism. A user command
never clears a session's persisted scheduled wake.

## The parallel abstraction being removed

The coordinator already serialises every per-session operation through
`withSession` (`packages/gateway/src/agent-sessions/coordinator.ts:180, 435,
599`). On top of that it runs a *second* exclusion protocol —
`wake.generation` + `wake.claim`, with `claimWake` / `clearWakeClaim` /
`releaseWakeClaim` in the ledger (`ledger.ts:386-431`) and call sites at
`coordinator.ts:200, 242, 296, 642, 682, 740`.

It guards against a second dispatcher. There is one gateway per VM. Two owners
of "who may run this session's wake" — delete the weaker one.

Upstream does the simple thing already: a repeating poll whose `fire()` no-ops
unless the session is sleeping (`~/dev/duet-agent/src/session/session.ts:609-627`),
and `RPC.md:84` states that a `wake` sent while not sleeping is a benign no-op.

## API seam

- `packages/gateway/src/agent-sessions/ledger.ts` — remove `claimWake`,
  `clearWakeClaim`, `releaseWakeClaim` from the `GatewaySessionLedger` interface
  (`:92-105`) and `claim` from the persisted wake shape (`:57`).
- `packages/gateway/src/agent-sessions/coordinator.ts` — delete
  `claimWakeForCommand` / `finishWakeClaim` / `releaseWakeClaim` (`:290-321`);
  `deliverInputUnclaimed` stops touching the wake at all; `dispatchWake` becomes
  read record → send `wake` → clear record; `restoreWakeSchedules`
  (`:511-543`) drops the claim-release step and re-arms from the persisted
  record.

**Post-shape, and the invariant to write down:** the persisted `wake` record is
truth, the timer is derived state, and `generation` survives **only** as the ABA
guard for `armWake`'s stale-callback check (`:596-597`) — that one is
load-bearing.

**Not a migration** (D29 holds): live VMs carry envelopes with `wake.claim`
persisted. `parseWake` (`ledger.ts:686-694`) must tolerate and drop the unknown
key. Dropping a field a newer reader does not know is not a migration.

## What the human can run or see

A sleeping session, prompted before its deadline, still wakes on the original
deadline — visible as `nextWakeAt` on the Jobs card
(`relaySummary.nextWakeAt`, `contract/src/sessions/index.ts:67`).

## Verification gates

Slice 00-C flipped to green. `bun run test` (gateway suite),
`bun run check-types`, `bun run lint`. Write the red test before the deletion.

## Must stay green

Ledger crash-recovery tests; `restoreWakeSchedules` quarantine and corrupt-record
handling (`:513-521`); duplicate-input acceptance; session deletion; quiesce
behavior; relay outbox durability.

## Fixed by this slice

Deletion, not repair. The persisted record stays the durability owner. Prompts,
answers, and cwd mutations do not consume a wake. **Interrupts still do** — an
interrupt is a deliberate stop, the same semantics the upstream Session fix
kept; the pre-existing tests pinning interrupt-clears-wake (and
hydration-failure-preserves-wake) stay exactly as written.

## Delegated to the implementer

Whether the `DEFAULT_RETRY_MS` re-arm on dispatch failure survives (it should),
and whether a reduced generation token is still needed for stale-callback
protection.

## What feedback would change this slice

If a gateway test proves a second dispatcher genuinely exists, restore only the
minimal token the failing test demands — never command-time wake consumption.
