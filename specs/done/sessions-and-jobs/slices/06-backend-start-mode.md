# 06 — Backend: `startMode` column with one writer

**Repo:** Duet. Depends on slice 05.

## Contract unlocked

The requested machine is persisted where every other launch-identity value is,
so it survives wakes and crash recovery.

## API seam

`packages/backend/convex/schema.ts`, `agentSessions` (`:985-1007`) gains:

```ts
startMode: v.optional(agentStateMachineDefinitionValidator)
```

**No new index.** It is never a query dimension, so it does not touch the
8-index set at `:1009-1045` and L3's index-cap argument does not apply.

Written **once**, by `createSessionForInitialDelivery`
(`domains/agentSessions/delivery.ts:718-774`). Read by whatever projects
`launch` on dispatch.

## The two-owner trap this slice exists to avoid

`stateMachine`, `jobView`, and `relaySummary` on that same row have exactly one
writer: `applyStateMachineProjection`, fired off a runner event
(`domains/agentSessions/events.ts:502-517`).

`startMode` is the **request**. `stateMachine` is the **observation**. They must
be different columns with different writers. Seeding the requested definition
into `stateMachine` would put two writers on the projection column and resurrect
the struck D24 in a new place — a session would appear in Jobs before its
machine started, and a machine that never starts (because the prompt did not
match the definition's routing guidance) would leave a permanent phantom job.

## Convex validators are a second schema

Every additive field needs its closed `v.object` arg validator widened in the
same commit, or the mutation 500s. Write a test that fires a NEW-shaped payload
at the real convex function — not at a mock.

## What the human can run or see

`convex data agentSessions` showing `startMode` on a session created with one,
and `stateMachine` still absent until the machine actually starts.

## Verification gates

`bun run test` (backend suite), convex codegen clean, `bun run check-types`.

## Must stay green

Create deduplication and fingerprinting; job projection; onboarding's forced
`auto`; the existing index set.

## Fixed by this slice

Two columns, two writers, no overlap. No seeded job projection.

## Delegated to the implementer

The validator factoring for the definition shape, and whether the fingerprint
that dedupes creation includes `startMode` (it should — two identical prompts
with different machines are different sessions).
