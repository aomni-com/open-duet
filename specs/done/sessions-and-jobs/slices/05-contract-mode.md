# 05 — Contract: session-owned `mode`, frozen at launch

**Repo:** Duet. Independent of slice 00's colour.

## Contract unlocked

A state machine becomes a property of a session, supplied at creation, on the
public wire.

## API seam

`packages/contract/src/agent/index.ts`, sole owner of every cross-service shape.

```ts
// AgentStartSessionRequestSchema (:705) gains:
mode: AgentStateMachineDefinitionSchema.optional()
  .refine(scheduleFloorHolds, { message: 'schedule_below_minimum' })

// GatewayRunnerInputRequestSchema.launch (:760-771) gains:
mode: AgentStateMachineDefinitionSchema.optional()

// SessionSnapshotSchema (:79-89) gains:
startMode: AgentStateMachineDefinitionSchema.optional()
```

`mode` is optional; omitted means `auto`, exactly as today.

## The seam defect this slice must fix

`mergedLaunch` (`packages/gateway/src/agent-sessions/ledger.ts:726-737`) freezes
**only** `onboarding`; every other key is `...existing.launch, ...input` —
newest-wins by design, because `cwd` and `tier` are user-changeable mid-session
(`:711-725`).

`mode` is session *identity* in the same sense `onboarding` is: it decides what
the runner starts as, and a later dispatch must not flip it. **`mode` joins the
frozen set at `:731`.** Without this, launch is a mutable channel carrying an
immutable value.

## The floor is Duet's policy, not the runtime's

`~/dev/duet-agent/src/turn-runner/tools.ts:1410-1413` deliberately exempts
definitions supplied via `mode:` from the minimum-cadence check, because a
definition the agent did not author may legitimately have a shorter cadence.

Do not ask upstream to overturn that, and do not import a shared constant.
**Duet's create wire owns its own number** — a uniform cost guard on every
caller, not a trust decision (`SECURITY.md:92-125`). The refinement reads only
`intervalMs` / `wakeAfterMs` / `wakeAt` on states that carry them and leaves
state interiors otherwise opaque, preserving the contract's stated stance
(`contract/src/agent/index.ts:59-75`).

## What the human can run or see

Contract tests: a definition with a 1-second timer rejected at the wire; the
same definition accepted by the runner when it arrives by another path.

## Verification gates

`bun run test` (contract suite), `bun run check-types`.

## Must stay green

Existing create-request parsing; `auto` sessions; the launch envelope's
version-skew tolerance (it stays `.loose()`).

## Fixed by this slice

`mode` is frozen at creation. The floor lives on the Duet wire and nowhere else.
Omitted mode means `auto`.

## Delegated to the implementer

The refinement's error shape and the exact floor value.
