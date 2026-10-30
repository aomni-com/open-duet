# Session App Pane — rationale record

Shipped to staging 2026-07-30 (merged to `staging`; convex deployed; the
gateway release is published by the deployed API and VMs self-update on
their next poll — the journey's fresh VM proved the path; live journey
`session-app-pane` green end-to-end). Planning provenance: `MAP.md` (the binding quadrant walk) and
`choices.md` (every decision made where the plan was silent or wrong).

## What shipped

An agent can move its session's working directory
(`POST /v1/ws/:ws/agent/sessions/:id/cwd`); the session view reacts by
opening the app anchored at that directory in an app-dominant pane beside the
chat (below `lg`, a header chip opens the same viewer full-screen); and every
runner spawn receives a generated, byte-deterministic `your-apps.md` prompt
layer naming the agent's apps and teaching the move — with explicit guidance
to move eagerly when building, editing, or demonstrating an app.

## Why this shape

- **The cwd is real, not a parallel "focus" field.** One authoritative
  durable value (`agentSessions.cwd`) drives spawn directory, timeline path
  resolution, and the pane; the gateway's session envelope holds a
  newest-wins projection of it (`launch.cwd`), refreshed on every delivery
  and by the endpoint. A second UI-only concept would have forked "where is this
  session" forever. Consequence accepted: old relative media paths re-resolve
  after a move; the prompt layer tells agents to prefer drive-absolute paths
  when showing files.
- **The gateway's filesystem answer is a write precondition.** The API
  commits the row only after the gateway validates the path against the real
  drive (`resolveSpawnCwd` — the same owner spawn uses). A typo'd path
  bounces as an in-turn 422 the agent can read; nothing bad is ever
  persisted. The residual race (folder deleted after acceptance) falls back
  at spawn — bound sessions to their anchor root, root sessions to the drive
  root — with a durable warning, healing a pre-existing brick (deleting a
  live session's cwd folder used to make every future dispatch throw).
- **The pane is a pure function of `snapshot.cwd`.** No open/close events, no
  persisted pane state; collapse is ephemeral component state keyed by the
  cwd value. Reload re-derives. The pane is strictly a viewer — the shared
  `AppFrameBody` exposes exactly one route-owned `unavailableAction` slot
  (the Apps route's repair card) and no overlay/annotation/mutation seams;
  the pane passes nothing into it.
- **Browser freshness is causal, not polled.** In product use a move is the
  agent's own tool call, and durable `tool_call` frames already arrive on
  the open session stream — the detail query refetches on those (1s leading-edge
  coalesce) with a terminal-frame backstop. No blind polling, no new wire.
- **Prompt determinism is a caching contract.** The generated layer is
  byte-identical across identical inputs (code-point slug sort, no volatile
  fields, no timestamps); its bytes change only when the app set genuinely
  changes, so the model's prompt-cache prefix survives ordinary turns.
- **The VM is one trust domain.** The endpoint uses the uniform
  `sessions`-capability gate; `vmModelScopes` gained `sessions` rather than
  any route-specific credential special-case (see `SECURITY.md`, "Inside a
  workspace VM there is one trust domain"). Scope drift heals server-side:
  vm-sync delivers rotated credentials unprompted when a live key's scope set
  is stale, so the fleet converges within one sync poll (5s default) of a
  scope-set change.

## Invariants (violating any of these reintroduces a shipped incident)

- `visibility`/`canonicalUrl` stay **out of** `sameGatewayAppConfig` and
  `sameGatewayAppRuntimeConfig` (`packages/contract/src/apps/index.ts`) —
  else version-skewed gateways freeze every app in `reconciling` and
  visibility toggles restart app processes. Pinned by contract tests.
- `GatewayAppConfigSchema` stays **strip-by-default with optional-forever new
  fields** — reports extend it on the vm-sync request, and stripping is what
  keeps app credential fields from echoing. Never `.loose()`, never required
  fields. Pinned by contract + vm tests.
- **Every convex `v.object` that carries the config wire must declare the
  optional metadata fields** (`gatewayAppConfigValidator` in
  `packages/backend/convex/domains/workspaces/vmSync.ts`). Convex validators are closed; the
  one that lagged the zod schema took staging's fresh-workspace
  reconciliation down for ~40 minutes (see Dead ends). Pinned by a backend
  test that pushes the exact production report shape.
- **cwd moves never rebind.** The mutation patches `cwd`, `updatedAt`, and
  the session revision — nothing else;
  agent binding is settled at envelope creation. A root session moving into
  an agent's folder does not become that agent.
- **Fallback never reparents.** A bound session whose *anchor* is gone still
  fails closed — falling back would swap its memory DB and prompt layers.
- **Canonical receipts only.** `a/../b` persists as `b`; pane identity and
  process identity must never split on path spelling.
- The pane derives from `snapshot.cwd` alone; collapse always has a reopen
  affordance; a broken-anchor app explains itself rather than rendering a
  blank frame.

## Pointers into the code

| Concern | Where |
|---|---|
| cwd grammar + canonical form | `canonicalAgentCwd`, `AgentCwdSchema` — `packages/contract/src/agent/index.ts` |
| cwd→app selection, app→agent scoping | `appForCwd`, `groupAppsByAgent` — `packages/contract/src/{apps,agents}/index.ts` |
| Filesystem validation + spawn fallback | `resolveSpawnCwd` — `packages/gateway/src/agent-sessions/spawn-cwd.ts` |
| Gateway endpoint (route + controller) | route in `packages/gateway/src/routes/agentSessions.ts`; `setCwd` — `packages/gateway/src/agent-sessions/coordinator.ts` |
| Public route (gateway-first ordering, 422 passthrough, CAS, 409 re-align) | `apps/api/src/routes/agent.ts`; `passthroughStatuses` in `apps/api/src/gateway/client.ts` |
| Convex mutation | `setSessionCwdImpl` — `packages/backend/convex/domains/agentSessions/cwd.ts` |
| Prompt renderer + file plumbing | `packages/gateway/src/agents/your-apps-prompt.ts`, `agent-context.ts`; sample at `assets/your-apps-sample.md` |
| Wire plumb (visibility/canonicalUrl) | `withPublicAppUrls` — `apps/api/src/gateway/app-configs.ts`; `AppSupervisor.desiredConfigs()` — `packages/gateway/src/routes/apps.ts` |
| `workspaceSlug` to the gateway | vm-sync response composition — `apps/api/src/routes/vm.ts`; desired-state store wiring — `packages/gateway/src/runtime/http.ts` |
| Scope-drift healing | `vmModelKeyScopesStale` — `packages/backend/convex/domains/apiKeys/model.ts`, consumed in `packages/backend/convex/domains/workspaces/vmSync.ts` |
| Browser freshness | `createSessionDetailRefreshSignal` — `apps/web/spa/sessions/session-data.ts` |
| Pane + chip + viewer | `useSessionPaneApp` — `apps/web/spa/sessions/session-pane-app.ts`; `AppFrameBody` — `apps/web/spa/apps/app-frame.tsx`; `apps/web/spa/routes/sessions.tsx` |
| Live journey | `packages/test-harness/src/staging-e2e-synthetic` (`bun run e2e:staging -- --journey session-app-pane`) |

Behavior pins: contract comparator/strip/skew tests; gateway
`process-runner.test.ts` (fallback, ask-terminal rehydration, wake) and
`routes/agentSessions.test.ts` (endpoint statuses);
backend `vm-sync.test.ts` (report metadata acceptance, scope-drift delivery)
and `apps.test.ts`; API `index.test.ts` cwd-route suite; web
`session-pane-app.test.ts`, `app-frame-body.test.tsx`, and the
`sessions-desktop-pane` playground fixture.

## Dead ends and divergences (what a future reader would otherwise re-derive)

- **`.loose()` on the gateway app config** (the plan's original call) died
  against a pinned security gate: reconciliation reports must *strip* unknown
  fields so app credentials can never echo. Skew safety is
  drop-unknowns + optional fields.
- **The convex-validator outage.** The one wire layer nobody audited —
  a closed `v.object` arg validator — rejected every sync from an updated
  gateway (fields present in zod, absent in convex). Staging fresh-workspace
  reconciliation was down ~40 min; the fix deployed and the fleet self-healed
  in one poll. The lesson is now an invariant above.
- **Broadening `vmModelScopes` was first rejected, then chosen.** The
  route-specific `system_vm` dual-accept looked "safer" but was scope theater
  inside a single trust domain; Example User overruled it and the principle landed
  in `SECURITY.md`.
- **Per-event cwd stamping** (correct-forever timeline media after moves) was
  rejected as disproportionate; drive-absolute-path guidance in the prompt is
  the mitigation.
- **1s polling and a new SSE cwd event** both lost to causal
  refetch-on-tool-call for browser freshness.
- **Ask-parked runners were abolished mid-close (Example User's ruling: "terminal
  means terminal").** Historically an `ask` terminal kept its runner alive as
  a warm-start for the answer; this feature first shipped retirement
  machinery (kill the parked runner when its spawn cwd went stale) to keep
  moves correct across an ask. Example User ruled the parking itself out: every
  terminal — `ask` included — now kills the runner, and answers always
  rehydrate from the durable checkpoint (which already had to survive
  restarts and month-long silences). The retirement machinery was deleted
  with it. Cost: an answer pays one spawn. Pinned by
  `ask kills its runner and the answer rehydrates the checkpoint into a
  fresh spawn` (`gateway.test.ts`).
- **An idle session page is deaf to external reactivation** (pre-existing,
  surfaced twice by the journey): the event stream closes at a terminal frame
  and nothing reopens it for an API-delivered prompt. The journey therefore
  opens the page during the move turn and asserts recovery through durable
  history. The gap stands, recorded in `choices.md`.
- **A visibility toggle does not push to the gateway** — it rides the sync
  poll (5s default); only `disabled` pushes (it must stop/start processes).
- **The endpoint cannot express "move to drive root"** (`a/..` → 422); root
  exists only as the absent launch cwd.

## Provenance & evidence

- `MAP.md` — the quadrant walk this was built from (binding decisions, with
  in-flight corrections annotated).
- `choices.md` — the consolidated decision ledger, grouped by how much they
  deserve review.
- `assets/session-app-pane-desktop.png` / `assets/session-app-pane-mobile-chip.png`
  — captured by the green live-staging journey: the real agent ran the curl
  from its generated prompt and the Hello pane opened beside the chat with no
  reload. These are the feature's acceptance images.
- `assets/journey.json` — the green run's evidence
  (`staging-e2e-synthetic`): move `welcome` →
  `welcome/hello-app`, garbage 422 with row preserved, bound-escape 422,
  recovery marker in durable history, full cleanup with zero orphans.
- `assets/your-apps-sample.md` — the rendered prompt layer (wording remains
  redlineable; shape is contract).
