# Agents — shipped record

**Status: shipped to staging 2026-07-21.** Built the same day from the
[`explore-unknowns` map](MAP.md) via a six-slice `write-spec` ladder, implemented
with Codex and integrator-reviewed. This document is the *why* and the
*invariants*; the code is the source of truth for *how*, and the pointers below
lead into it. The pre-build decision ledger is [`MAP.md`](MAP.md) (17 closed
decisions); the decisions made where the spec was silent, with verdicts and the
live-e2e evidence, are [`choices.md`](choices.md).

## What shipped

An **agent** is an anchored drive folder that bundles a custom system prompt
(`AGENTS.md`), its own skills (`.agents/skills/`), its own apps, and optional
onboarding/training behavior (`agent.json`). Agents share like folders —
accepting a share materializes a replica agent on the recipient's VM.
Observational memory and logs are per-agent and live outside the drive, so they
never sync and cannot leak on a share.
Curated memory files live inside each agent's drive folder, sync with ordinary
content, and are inherited by descendant agents. A session belongs to the agent
that is the nearest agent-anchor ancestor of its `cwd`; the default agent is
simply the drive root (no ancestor).

The problem it solves: before this, every session ran with one workspace-wide
prompt, one shared memory DB, and workspace-wide behavior. There was no way to
package a persona (custom prompt + skills + isolated runtime state) or hand it
to a teammate. Agents make that boundary first-class, reusing the drive's
existing anchor, sharing, and
replication rails rather than inventing new ones.

## The reason it works this way

- **Almost nothing new at the runtime layer.** The upstream `@duetso/agent`
  runner already derives skills and prompt from the session `cwd` and already
  accepts a state-machine definition on its start command. Session-owned launch
  mode now lives with the session contract; the agent boundary supplies prompt,
  skills, and memory. This is why the feature is mostly a data model plus wiring,
  not a new execution engine. The one real gap was product-side: the web app never
  sent `cwd`, which is why the picker is deferred (see
  [`../agents-ui/`](../agents-ui/README.md)).

- **Resolution happens twice, from one rule, and never on the wire.** A single
  pure helper `resolveNearestAgent` (`packages/contract/src/agents/index.ts`)
  owns the nearest-agent ranking. Convex calls it at session creation to stamp
  durable attribution; the gateway calls it at spawn to pick memory and prompt.
  `GatewayRunnerInputRequest.launch` carries no `agentId` (it later gained an
  optional `onboarding` flag and lost `.strict()`; see the superseded invariant
  below). Two independent resolvers off
  one shared function keep the launch contract closed while letting Convex own
  *attribution* and the gateway own *runtime*, each from its own authoritative
  data (Convex's `agents` rows; the gateway's VM anchor projection). An
  integration fixture feeds the same anchor set to both and asserts they agree —
  a disagreement is release-blocking.

- **Runtime eligibility keys off a projected `agentId`, never `anchor.kind`.**
  This is the load-bearing, non-obvious decision. When you share an agent folder
  directly, the recipient's anchor for it is the **`share-mount`** anchor (the
  shared-apps convention: one anchor per path, so the replica reuses the mount
  anchor rather than creating a second `kind:'agent'` anchor at the same path). A
  `kind`-based filter would therefore miss every directly-shared agent — the
  *primary* sharing case. So the backend projects an optional `agentId` onto each
  VM anchor (set when an enabled agent row references it) and the gateway resolves
  on that. Kind stays `share-mount` for the sync system; agent-eligibility is a
  separate projected fact. Confirmed as the right call against the simpler
  `kind`-only alternative (which would force agents to be shared via a wrapper
  parent folder) — see [`MAP.md`](MAP.md) landmine 2 and choices Slice-02.

- **Per-agent observational memory and logs live outside the drive, keyed by
  anchorId.** `~/.duet/agents/<anchorId>/{memory.db,logs.log}` stays local and
  follows the workspace archive. Curated memory is ordinary drive content under
  `.agents/memories`, so it follows the agent's sync/share boundary and inherits
  down the folder tree; [`train-files`](../train-files/README.md) owns that
  successor contract.

- **Share replication reuses one generic convergence driver, not a fork.** Rather
  than clone the shared-apps rule, the app convergence logic was extracted into a
  neutral, entity-generic driver
  (`packages/backend/convex/domains/replication/shared.ts`) with `app` and
  `agent` adapters. The desired-share graph, path-within-share membership,
  origin→mount translation, one-replica-per-(origin×share) rule, and collision
  policy live once. `sharedReplicaAdapters()` is the single `[app, agent]` list
  consumed by accept-seed, revoke, and unlink. Extraction was done as its own
  behavior-preserving pass with the existing app-replication test as the oracle.

- **Start mode belongs to the session, not the agent.** The coordinator injects
  the durable launch envelope's definition only when there is no checkpoint; an
  omitted definition means `auto`, onboarding forces `auto`, and a resumed
  session carries its running machine's `state`. See
  [`sessions-and-jobs`](../sessions-and-jobs/README.md) for the successor
  ownership contract.

- **Agents authored by agents; the config is content, identity is the anchor.**
  The default agent (drive root) configures others via a new `manage-agents`
  skill and the public agents REST API. `AGENTS.md`/`agent.json` are pure synced
  content and never carry a slug/id/anchor/path — path identity has one owner,
  the anchor.

## Invariants — what must stay true

- **`resolveNearestAgent` is the only nearest-agent ranking.** Both Convex
  attribution and gateway runtime call it; neither reimplements it. Deepest
  exact-or-ancestor wins, sibling-prefix does not match, drive root → null.
- **~~The launch wire stays `.strict() { cwd, gatewayModelId }`.~~ SUPERSEDED
  2026-07-27 by [`agent-onboarding`](../agent-onboarding/README.md).** The wire
  is now loose and carries an optional `onboarding` flag; strict rejection was
  reclassified as an anti-pattern because an unknown field 400s the whole
  request on a gateway one release behind. **The part that still holds:**
  attribution
  routes through Convex; runtime resolves gateway-locally. No `agentId` on the
  launch object.
- **Runtime agent eligibility = the projected `agentId` on the VM anchor**, never
  `anchor.kind`. A replica at an exact share root is a `share-mount` anchor that
  carries an `agentId`.
- **Per-agent observational DB/logs stay under
  `~/.duet/agents/<anchorId>/`** — outside the drive, never synced, never served,
  in the archive, left in place on delete (supports un-delete). Curated memory
  files stay with the drive content instead.
- **One generic replication driver.** No parallel `agents/replication.ts` that
  rediscovers desired shares; adapters supply only entity-specific row ops +
  collision policy. The app-replication test stays byte-identical as the oracle.
- **Launch-envelope `mode` only when `checkpoint === undefined`** — and, since
  [`agent-onboarding`](../agent-onboarding/README.md), never for an onboarding
  launch: that conversation is driven by its own layered system prompt, so a
  state machine would fight it. Resume sends `state`; never both.
- **Default-agent launch semantics stay root-compatible.** No agent ancestor ⇒
  drive-root cwd, the root observational `~/.duet/memory.db`, mode `auto`, and no
  `--system-prompt-file` (the CLI's own `cwd/AGENTS.md` default serves the
  drive-root agent). Curated root memory files are the inherited layer for every
  descendant.
- **Attribution is an immutable creation-time snapshot.** `agentId`/`agentName`
  are stamped once; renames/deletes never rewrite a session's history.
- **The prompt flag is singular `--system-prompt-file`** (probe-confirmed:
  absolute path honored, replaces the default `["AGENTS.md"]`); Duet omits it when
  the boundary file is absent.
- **`agent.json` parse failures never block an agent surface.** Missing or
  malformed config keeps the permissive onboarding/training defaults; it never
  participates in runner start mode.
- **Replica fan-out is bounded** by `MAX_AGENTS_PER_WORKSPACE` (mirrors
  `MAX_APPS_PER_WORKSPACE`).

## Pointers into the code

| Concern | Owner |
|---|---|
| Nearest-agent rule + public agent schemas + `agents` capability | `packages/contract/src/agents/index.ts`, `src/scopes/` |
| `agents` table, `kind:'agent'`, session `agentId`/`agentName` | `packages/backend/convex/schema.ts` |
| Agent CRUD + `MAX_AGENTS` + attribution resolution | `domains/agents/{model,resolution}.ts` |
| Session attribution stamp + projection | `domains/agentSessions/{delivery,queries,agentSessionsShared}.ts` |
| Generic replica driver + adapters | `domains/replication/{shared,adapters}.ts`, `domains/{apps,agents}/replication.ts` |
| Share accept/revoke/unlink multi-resource wiring | `domains/shares/{model,effects}.ts`, `domains/anchors/model.ts` |
| VM anchor `agentId` projection | `domains/anchors/model.ts` (`listForVm`), `packages/contract/src/{anchors,vm}/` |
| REST routes + synchronous reconcile push (502 on failure) | `apps/api/src/routes/agents.ts`, `src/gateway/client.ts` |
| Gateway cwd→agent context (`--db` + `--system-prompt-file` + mkdir 0700) | `packages/gateway/src/agents/agent-context.ts` |
| One anchor registry (single sink) + `POST /v1/anchors/reconcile` | `packages/gateway/src/agents/anchor-registry.ts`, `runtime/http.ts` |
| Session-owned mode injection (checkpoint-gated) | `packages/gateway/src/agent-sessions/{coordinator,ledger}.ts` |
| Envelope binds anchorId (respawn stability) | `packages/gateway/src/agent-sessions/ledger.ts` |
| `manage-agents` default skill | `packages/skills-registry/skills/manage-agents/SKILL.md` |

Behavior is pinned by tests beside each owner — notably
`packages/backend/src/{agents,agents-replication,apps-replication}.test.ts`,
`packages/gateway/src/agents/*.test.ts`, and
`packages/gateway/src/runner/process-runner.test.ts`.

## Divergences from the plan (what a reader would otherwise re-derive)

- **The runner prompt flag is singular `--system-prompt-file`, not plural.** The
  spec (and the map) said `--system-prompt-files`; the installed CLI rejects the
  plural. Caught at Slice 02's confirm-before-coding probe — a wrong flag would
  have shipped a gateway that silently never applied agent prompts.
- **Per-agent memory is keyed by `anchorId`, not `agentId`** as the map's prose
  first implied. The anchor is the stable path-identity owner; a rebuilt/renamed
  agent behaves correctly.
- **`deleteAgent` returns `{ ok: true, affectedRecipientWorkspaceIds }`** (the API
  strips the metadata; the public contract stays `{ ok: true }`). This broke a
  Slice-01 test asserting strict `{ ok: true }` that Codex's narrow per-slice gate
  never re-ran — caught only by the integrator's broad sweep. Lesson: a
  return-shape change must re-run the owning CRUD suite.
- **The `agents` VM capability is additive but not free in tests.** Exact
  VM-key-scope assertions in `api-keys.test.ts` (×9) and `provisioning.test.ts`
  (×1) pinned `[ai, apps]` and had to become `[ai, apps, agents]`. Surfaced only
  by the full-suite gate, not the per-slice gates.
- **Slug-collision policy was hoisted into the shared driver** during the agent
  adapter pass so apps and agents share one owner — a refactor-clean improvement
  beyond the plan.
- **`assertLinkedRootDoesNotNest` was generalized** `protectAppAnchors →
  protectManagedAnchors` to cover agent anchors, rather than adding a parallel
  branch.

## Dead ends (do not re-walk)

- **`kind:'agent'`-only runtime resolution.** Rejected: a directly-shared agent's
  recipient anchor is `share-mount`, so kind-filtering misses the primary sharing
  case. The projected-`agentId` mechanism exists specifically for this. (The even
  worse variant — converting a `share-mount` anchor's kind to `agent` on accept —
  was also rejected: it conflates sync-mount identity with agent identity and
  would fight the share-lifecycle code.)
- **Threading `agentId` through the launch wire.** Rejected; Convex and the
  gateway resolve independently from one shared helper instead. (The original
  reason was to keep the contract `.strict()`. That premise is gone — see the
  superseded invariant above — but the decision stands on its own: attribution
  has one owner, and a client must not be able to claim an agent it did not
  launch under.)
- **Cloning the shared-apps replication rule for agents.** Rejected in favor of
  extracting one generic driver — a parallel `agents/replication.ts` would be the
  compat-layer trap the plan explicitly forbade.
- **Double-sharing an agent and a nested app inside it to different users.**
  Accepted as an unsupported limitation (not a TODO): it needs two *overlapping*
  share roots, which `assertLinkedRootDoesNotNest` forbids because Syncthing send
  folders cannot nest. See [`MAP.md`](MAP.md) ledger #17.

## Acceptance evidence

The durable evidence is the test suite pinning every invariant above. Beyond it,
a live staging e2e ran 2026-07-21 (run `staging-e2e-synthetic`) against
freshly-provisioned VMs on the deployed new gateway + backend: **all 46 functional
journey legs passed** (train, durability, ledger, publish, agent-continuity, 11
subscription legs, the full share journey, admin, browser). The aggregate reported
`fail` only on the strict browser-console-noise gate (566 environmental
third-party CDN/DNS + aborted-navigation entries, zero JS exceptions, zero
duet-API 5xx, nothing agents-related — and this feature touched no frontend) and
two teardown-cleanup legs (99/99 resources deleted, 0 orphans). Detail and the
per-leg breakdown are in [`choices.md`](choices.md).

## Not shipped (deliberate)

- **The web surface** — agent picker that sends `cwd`, and Jobs-tab rendering of
  the `agent:{id,name}` the API already carries — is a separate follow-up spec:
  [`../agents-ui/`](../agents-ui/README.md). This spec is headless/API-first by
  design.
- **`agent.json.triggers`** ships reserved-and-empty; automatic session creation
  (cron/webhook) is a future feature.
