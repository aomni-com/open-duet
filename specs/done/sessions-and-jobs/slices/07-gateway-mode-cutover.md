# 07 — Gateway: start from the envelope, delete `agent.json` mode

**Repo:** Duet. Depends on slices 05 and 06. Hard cutover (D29).

## Contract unlocked

The runner's start mode comes from the session's launch envelope, and
`agent.json` no longer decides anything about modes anywhere in the product.

## API seam

**Read side.** `packages/gateway/src/agent-sessions/coordinator.ts:479-485`
already sends `mode` only when there is no checkpoint. Replace the
`loadAgentStartMode` call (`:393-397`) with a read of `args.envelope.launch.mode`,
defaulting to `'auto'`. Resumes continue from the durable checkpoint, untouched.

**Delete side — all of it, in this slice:**

- `packages/gateway/src/agents/agent-config.ts` — `loadAgentStartMode` and its
  `agent.json` read (`:12-41`), plus the invalid-config warning path that exists
  only to describe a bad `mode`.
- `packages/contract/src/agents/index.ts` — `mode` from `AgentConfigSchema`
  (`:39`) and from `AgentEffectiveConfig` (`:62`), and its projection in
  `resolveAgentConfig` (`:88`).
- `apps/web/spa/routes/agents/agent-mode.ts` and its use in the agent detail
  canvas — the read-only "mode" display now describes a field that no longer
  exists. Repoint at the session or delete the surface; do not dual-read.
- Any `manage-agents` skill prose and seeded documentation mentioning
  `agent.json`'s `mode`.

`agent.json` stays `.loose()`, so a workspace file still carrying `mode` parses
and is ignored. That is the cutover, not a migration.

## What the human can run or see

Create a session by REST with an inline `timer → agent → terminal` machine;
watch the runner enter it. Create a session under an agent whose `agent.json`
still has a `mode`; watch it start in `auto`.

## Verification gates

`bun run test` (gateway + contract + web suites), `bun run check-types`,
`bun run lint`, `bun run build` for `apps/web`.

## Must stay green

Onboarding's forced `auto` (`coordinator.ts` passes `onboarding` through the
envelope); checkpoint resume; the agent detail canvas's remaining fields; agent
registration and deletion.

## Fixed by this slice

One source for mode. No compatibility read. The deletion is complete in this
slice — no follow-up cleanup slice exists to absorb leftovers.

## Delegated to the implementer

Whether the detail canvas drops the mode row entirely or shows the session's
machine instead; internal naming in the coordinator.
