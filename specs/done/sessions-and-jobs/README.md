# Sessions and Jobs — rationale record

SHIPPED to staging 2026-07-31; live journey green the same day (run
`staging-e2e-synthetic`, all five stages including a real
timer wake). This document is the durable *why*; the code is the *how*.
[`MAP.md`](./MAP.md) holds the 29 decisions of the planning walk;
[`choices.md`](./choices.md) holds the implementation ledger and the surviving
needs-owner registry; [`slices/`](./slices/) preserves the build ladder.

## What this feature is

A state machine is a property of a **session**, supplied at creation on the
public wire — not a property of an agent folder. Every agent (and the drive
root) has a **default session**: the conversation the user returns to,
addressed by a path alias so no client ever needs an id first. The default
session's job is to stay a conversation — trackable work is delegated into
*other* sessions the user can watch, which the existing Jobs UI surfaces the
moment their machine starts. Sessions record who started them, so children can
interrogate parents and the UI shows lineage. No new agent tools: two default
skills teach the REST calls the runner's environment could already make.

## The principles that shaped it

- **A job is a session.** No new entity, no new table, no second lifecycle.
  `JobSummary` stays a projection (`relaySummary`) over sessions whose machine
  has started; a requested-but-never-started machine is deliberately NOT a job
  (`startMode` is the request, `stateMachine` the observation — two columns,
  two writers, never seeded across).
- **Session identity freezes at creation; parameters stay live.** `mode`
  joined `onboarding` in `mergedLaunch`'s frozen set (gateway ledger); `cwd`
  and `tier` remain newest-wins. The runner receives `mode` exactly once, on
  the checkpoint-less `start`.
- **Aliases over ids.** `…/sessions/default` is resolved server-side against
  owner-row pointers (`agents.defaultSessionId`,
  `workspaces.rootDefaultSessionId`) — no new index dimension on the
  8-index `agentSessions` table, no empty rows, no "never ran" status; the
  first message creates through the ordinary path and stamps atomically.
- **Attribution is structural.** The parent rides the URL
  (`POST /agent/sessions/{parent}/sessions`), never the body. The message
  `origin` string this spec introduced was superseded by the typed
  `sender` union and request `sourceSessionId` — see
  [session-input-attribution](../session-input-attribution/README.md) for the
  durable attribution rationale; `createdBySessionId` and the
  route-stamps-the-parent principle are unchanged.
- **Skills, not tools; a layer, not a skill, for the "when".** The runner's
  env already carries the credential and URL, so `start-session` and
  `schedule-task` document real calls. But a skill cannot fire before the
  model knows it needs one, so the delegation *instruction* is a generated
  system-prompt layer rendered only for default sessions — stated as
  procedure, not preference, because live probes showed "discouraged" losing
  to the runner's own machine-authoring tool.
- **The VM is the security boundary.** The create wire accepts a full
  definition from any workspace credential — no state-kind allowlist, no
  key-kind carve-outs (`SECURITY.md`). The schedule floor on the wire is
  Duet's own cost policy; upstream deliberately exempts `mode:`-supplied
  definitions and was not asked to change.
- **Wakes: one scheduler, one exclusion.** The gateway's wake claim/generation
  protocol guarded a dispatcher that cannot exist and destroyed wakes on
  prompts; it was deleted, with acceptance made atomic in the ledger.
  Upstream, the kill gate proved the mid-turn wake invariant HOLDS (the
  reminder's own scheduled task keeps the queue alive) — the feared bug did
  not exist, no release was cut for it, and the repro lives on as a
  regression pin in both repos.

## Where the how lives

- Contract: `packages/contract/src/agent/index.ts` (mode, floor, origin),
  `sessions/index.ts` (default-alias schemas, summaries).
- Backend: `packages/backend/convex/domains/agentSessions/` (delivery owns
  create/stamp/inherit; events own the projection), `apiKeys/model.ts`
  (`vmModelScopes`, now with `integrations`).
- API: `apps/api/src/routes/agent.ts` (flat + nested create),
  `routes/default-session.ts` (the aliases).
- Gateway: `agent-sessions/` (envelope-driven start, claimless wakes),
  `agents/default-session-prompt.ts` + `parent-session-prompt.ts` (the
  layers, resolved only through `agent-context.ts`).
- Web: session header lineage chip, attributed bubbles
  (`spa/sessions/session-message.tsx`), default entry points on the roster.
- Skills: `packages/skills-registry/skills/{start-session,schedule-task}/`.
- Journey: `packages/test-harness/src/staging-e2e-synthetic`.

## What the shipping fight taught (full evidence in choices.md)

The journey failed five different ways before green, and every failure bought
a durable fact: fresh VMs raced the gateway self-update (image rebuilt with
layers baked); the delegation prose had to become procedure; a fast child
*is a job* and structurally leaves the sessions list; clients must outlive
the ~330s dispatch hold and treat nudges as best-effort under the ~255s
transport ceiling; and the fleet-wide cold-spawn wedge root-caused to the
VM key lacking `integrations` (0.3.8's MCP connect stalls turn_started),
with a measured ~2–3 min memory.db cold-init floor beneath it. Ten
needs-owner items survive in `choices.md`'s registry.
