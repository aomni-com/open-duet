# Agent session continuity, Jobs, and authored messages

## Purpose

Agent sessions are durable runner conversations, not flat event feeds. A user
can schedule work, survive a gateway restart, steer or queue a follow-up while
the runner is active, and return to a transcript whose user and Duet authorship
is unambiguous. Any session carrying a runner state machine belongs to Jobs;
ordinary runner snapshots use machine state—not transient turn status—to place
it under Active or History. Workspace servicing terminalization is a separate
control-plane override.

This shape exists because three authorities have different lifetimes:

- Convex owns pending public input and the queryable product projection.
- The long-lived gateway VM owns accepted runner commands, checkpoints, relay
  outbox entries, and wake intent below its durable `stateDir`.
- `duet-agent` owns prompt routing, todos, the follow-up queue, interruption,
  and state-machine semantics.

The services meet only at explicit receipts. Convex retries an input until the
gateway proves the runner accepted it. Once accepted, the gateway ledger owns
recovery; hosts mirror runner documents without recreating their behavior.

## Why the boundaries matter

A reminder originally disappeared from Jobs after a follow-up because Jobs was
implemented as `status=sleep`. That treated a momentary turn status as durable
workflow identity. Job identity now follows durable workflow state: production
runner-event writers create the indexed Job projection alongside the state
machine, and absence of a terminal plus a non-interrupted current state
distinguishes Active from History.

`agentSessions.status` remains useful as cached conversation lifecycle for
controls and ordinary Session filtering. It is deliberately absent from Job
membership and ordinary runner-snapshot classification. Runner event
projection has no servicing/status condition. Separately, pausing or banning a
workspace terminalizes its still-active Job rows into History while gateway
quiescence prevents further execution; that explicit control-plane policy does
not reinterpret a later runner state-machine event.

Wake ownership stays with the gateway because Duet's exe VM is long-lived. A
Convex scheduler would create a second execution authority and would solve the
short-lived-VM problem of the reference chat app rather than Duet's problem.
Durable absolute deadlines make gateway ownership survive restarts and let
overdue work be reclaimed.

Authorship follows input origin, not adjacency: every user input is a complete
user message, and subsequent runner output belongs to a Duet message. A prompt
arriving mid-turn therefore preserves Duet → user → Duet while reasoning,
tools, asks, lifecycle events, and final text stay ordered under one Duet
identity. Runner documents remain panels rather than authored rows.

## Invariants

- `duet-agent` is the protocol authority. Duet validates and persists its
  current todo, follow-up, turn-state, and state-machine shapes; it does not
  translate them into host-invented equivalents.
- Public create/message input defaults to `steer` and may explicitly request
  `follow_up`. The first prompt accepts either value. Notes and answers keep
  their separate behavior.
- A prompt is `accepted` only after the runner emits its correlated acceptance.
  Until then the ordered Convex event tail remains the retry source.
- A live runner receives new input directly. If no runner exists, the gateway
  hydrates the durable checkpoint, starts one, and then sends the command.
- A checkpoint, wake generation, and ordered relay outbox entry commit locally
  before backend network I/O. Stable relay IDs make retries idempotent.
- Interrupt hydrates an absent sleeping runner and uses native interruption.
  It waits for the interrupted checkpoint and for its relay outbox to drain
  before reporting success, preventing a stale History snapshot from racing a
  reactivation command.
- A state machine is a Job regardless of `running`, `ask`, `sleep`, or terminal
  turn status. Archived sessions remain outside the default Jobs query. A later
  runner snapshot may reactivate a History job.
- The backend classifies relay path items and their stable indices. Web code
  consumes `RelaySummary`; it does not infer the current item by matching names
  or claim that definition adjacency predicts the next runtime transition.
- Session headers and Job rows use the same Relay component and projection.
- Raw retained event rows stay flexible only behind mandatory shared-schema
  parsing. Todos, follow-ups, Job summaries, and relay summaries use concrete
  validators; the state machine uses a validated stable envelope with flexible
  runner-owned definition, input, progress, history, and terminal interiors.
- Every rendered message has one explicit author/avatar. Tool and reasoning
  content can never inherit user presentation from adjacency.

## Public seams

The contract is centered on `AgentPromptBehavior`, `SessionSnapshot`,
`JobSummary`, `RelaySummary`, and `ProjectedMessage`:

- create/message requests accept `behavior: "steer" | "follow_up"` and return
  `delivery: "accepted" | "queued"`;
- Sessions and Jobs are separate server-paginated collections; Job rows keep
  the canonical Session detail URL;
- Session snapshots carry typed todos, follow-up queue, state machine, and
  relay summary;
- the browser projects ordered timeline events into authored messages while
  preserving runner documents separately.

## Pointers into the code

- Protocol and document schemas: `packages/contract/src/agent/index.ts` and
  `packages/contract/src/sessions/index.ts` (`AgentTurnEventSchema`,
  `AgentStateMachineSessionSchema`, `JobSummarySchema`, `RelaySummarySchema`,
  `projectRelaySummary`).
- Convex validators and indexed storage: `packages/backend/convex/validators.ts`
  and the `agentSessions` table in `packages/backend/convex/schema.ts`.
- Input queue and delivery leases: `packages/backend/convex/domains/agentSessions/delivery.ts`
  and `apps/api/src/agent-runner.ts`.
- Runner-event and Job projection:
  `packages/backend/convex/domains/agentSessions/events.ts`
  (`applyStateMachineProjection`) and
  `packages/backend/convex/domains/agentSessions/queries.ts` (`listJobsImpl`).
- Durable execution: `packages/gateway/src/agent-sessions/ledger.ts` and
  `packages/gateway/src/agent-sessions/coordinator.ts`.
- Authored-message projection and presentation:
  `apps/web/spa/sessions/projection/index.ts` (`projectSession`,
  `ensureAgentMessage`), `apps/web/spa/sessions/session-message.tsx`, and
  `apps/web/spa/sessions/ordered-agent-parts.tsx`.
- User prompt behavior: `apps/web/spa/sessions/session-composer.tsx`.
- Jobs and Relay presentation: `apps/web/spa/jobs/`,
  `apps/web/spa/routes/jobs.tsx`, and `apps/web/spa/relay/relay-status.tsx`.
- Restart acceptance: `packages/test-harness/src/staging-e2e-synthetic`.

Behavior is pinned by the adjacent contract, gateway ledger/coordinator,
backend agent-session, API, web projection, Job, Relay, and composer tests.
The visual interaction states are pinned by `apps/web/tests/visual/playground.spec.ts`.

## Divergences and dead ends

- The planned protocol release was `0.2.4`. Shipping reached
  `@duetso/agent@0.2.6`: `0.2.5` reduced the obsolete 15-minute scheduling
  floor to 30 seconds, and `0.2.6` made interruption of a hydrated sleeping
  schedule settle the state machine as interrupted, clear its wake, and stop
  its tasks. Compatibility code was intentionally rejected; the VM image was
  rebuilt and all staging runners were reprovisioned.
- Returning interrupt success as soon as native interruption completed was
  insufficient. Reactivation could reach Convex before the interrupted event.
  Gateway interrupt completion therefore includes the ordered relay drain.
- Coupling state-machine projection to `agentSessions.status` or workspace
  servicing created a complex false dependency. Ordinary runner projection
  derives Jobs only from the runner state machine; workspace terminalization
  remains an explicit, separate control-plane override.
- Treating tools/reasoning as top-level timeline rows, then grouping adjacent
  roles in the renderer, lost authorship. Special-casing `turn_started` was
  also unnecessary; generalized user-boundary/runner-boundary grouping is the
  durable rule.
- Copying the reference chat app's same-author avatar suppression, mock Jobs
  data, backend scheduler, or older runner schemas was rejected. Only its
  authored-message rhythm, ordered-parts containment, row density, and Relay
  information hierarchy were carried over.
- A production workspace authorization ceiling is not a test cleanup policy.
  Fixtures clean up what they create instead of weakening that ceiling.

## Rollout and evidence

The immutable runtime is `@duetso/agent@0.2.6` in
`ghcr.io/aomni-com/duet-vm-image@sha256:8ecb0dc409fc69397f29e2906d71d8635e70f02d99d126f88210b863b59da8e2`.
Both staging and production configuration pin that digest; staging was applied
and all ten active workspaces were verified on 0.2.6 with the same desired and
observed immutable image. Commit `46eda71c` keeps production configuration in
parity; this record makes no claim about a separate production deployment.

The live continuity leg passed repeatedly, including final run
`staging-e2e-synthetic`: a different gateway process recovered the
future wake, both steer and follow-up were runner-accepted, native interrupt
projected `currentState: "interrupted"`, the Job moved to History, and a later
snapshot reactivated it. Cleanup passed with zero orphans. That full run later
failed in the independent share-revocation leg because the recipient file API
returned HTTP 500 instead of the required 404; the continuity evidence and
cleanup were already complete.

## Visual provenance

The original defect is preserved at
`assets/reported/session-event-grouping-dark.png`. It established the core
requirement that tools and reasoning need an explicit Duet owner rather than
user-message styling.

The Duet before-state is pinned at revision
`6a1d489004bec58d0c4d272a1961bd881e7e3758`. The interaction references from
the separately versioned `chat-app` repository are pinned at revision
`3389036ed12e71c917c20c30dea782930506d424`: authored-message/avatar rhythm,
ordered collapsed/expanded parts, dense responsive rows, and compact/full Relay
disclosure. They were inspiration, not backend or pixel-copy authority.

The preserved visual inventory, rejected interpretations, shipped comparison
captures, and byte checksums remain in `assets/README.md` and
`assets/SHA256SUMS`.
