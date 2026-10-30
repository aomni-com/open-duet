# Session Timeline — shipped record

Shipped 2026-07-08 on `main` (slices collapsed into this record). Agent
sessions have a single merged, seq-ordered timeline in Convex: every user
input — the initial prompt, follow-up messages, **notes**, ask-answers, with
optional images — is a first-class event beside the runner's relayed events.
A note queues context without waking the runner; any runner-bound input
flushes all unseen notes (text and images) with it. Sessions are listable
over REST/MCP. The same change window audited the entire Convex schema and
pruned it (including renaming the model-gateway metering table to
`gatewayGenerations`).

This document is the why and the invariants; the code is the how.

## Why it is shaped this way

- **The runner RPC contract is frozen** (`specs/done/agent-drive/research/agent-cli-contract.md`):
  delivery to the agent is a single `prompt` command — `message` string plus
  protocol-native `images` (that images field was under-documented in the
  original contract record and re-verified against
  `src/types/protocol.ts` in the external duet-agent repo; the record was corrected). All queueing
  therefore lives Duet-side, and flush = composing one message + one image
  list.
- **Delivery cursor over per-event leases.** Convex and the VM gateway can't
  share a transaction, so delivery is fenced, not exactly-once: a session-
  level `lastDeliveredInputSeq` cursor plus one in-flight `deliveryAttempt`
  whose API-minted `attemptId` (`runnerAttemptId()` in `apps/api/src/index.ts`)
  fences attempt clearing (mark/abandon only clear a matching attempt). The
  cursor itself advances monotonic-max WITHOUT the fence — safe because a
  mark is only ever issued after the gateway accepted the exact composed
  payload, and `throughSeq` is bound to that composition; the guarantee
  (**at-least-once, never falsely-delivered**) rests on that call discipline
  plus monotonicity, not on the fence. Under the flush rule, advancing past earlier notes
  on a later success is correct by construction (they were in the
  composition). Concurrent dispatches don't 409; a duplicate-notes window in
  races is accepted (notes are context). The rejected alternative — per-event
  `deliveredAt` leases with stale reclaim — buys exactly-once-ish bookkeeping
  at 3x the machinery; adopt only if duplicate notes prove harmful.
- **Disjoint `type` strings, no envelope.** Existing SSE consumers and tests
  key on `event.type`; wrapping events in an origin envelope would have
  forced a compatibility branch through every consumer. Runner and user
  event unions are disjoint by test.
- **Images are storage-backed, never inline.** Convex documents cap ~1MB;
  event rows carry `{storageId, mimeType, bytes}` metadata and dispatch
  resolves blobs server-side via short-lived storage URLs (not base64
  through action results — divergence from the plan, recorded during build).
- **A failed dispatch is a queued input, not an error state.** Session
  create returns 201 with `dispatched:false` when the VM is unreachable; the
  prompt (and everything queued) flushes on the next runner-bound input via
  the API's drain loop — which exists because composition carries one input
  per delivery, so backlogged inputs dispatch sequentially (the runner's own
  follow-up queue absorbs them).

## Invariants (must keep holding)

1. `relayRunnerEvent` validates `AgentTurnEventSchema` and only that — user
   events cannot enter through the VM relay route, and runner events cannot
   be forged through user mutations.
2. Never mark user input delivered before the VM gateway accepted the
   dispatch; cursor advance is monotonic-max, and the attemptId fences
   attempt-record clearing (pinned:
   `packages/backend/src/agent-sessions.test.ts` monotonic + stale-mark
   cases).
3. Notes cost nothing and never dispatch: scope check (`ws:{slug}:agent`)
   only — no credit preflight, no gateway call.
4. Text-only flows materialize no `images` field when absent. (The stronger
   byte-identical-to-pre-images claim was retired by
   [session-input-attribution](../session-input-attribution/README.md): input
   events now carry a required typed `sender` and no `submittedAt`/`origin`.)
5. Image ingest caps (4 per input, 5MB each, png|jpeg|webp|gif) enforce at
   every surface; replay bytes are served only through the scope-checked
   session images route (no capability URLs).
6. The timeline is append-only and seq-ordered; `session_created` then
   `user_prompt(initial)` open every session.

## Pointers into the code

- Convex core: `packages/backend/convex/domains/agentSessions/model.ts` —
  `appendUserNote`, `prepareRunnerInputDelivery`,
  `markRunnerInputDelivered`, `abandonRunnerInputDelivery`, `listSessions`;
  pinned by `packages/backend/src/agent-sessions.test.ts`.
- Event shapes + composition: `packages/contract/src/agent/index.ts` —
  `AgentSessionTimelineEventSchema`, `isRunnerDeliverableUserEvent`,
  `composeRunnerMessage`, image schemas/caps; snapshot tests beside it.
- REST: `apps/api/src/index.ts` — session routes incl. `POST .../note`,
  `GET .../agent/sessions` (list), the images replay route, and
  the drain (`apps/api/src/agent-runner.ts:drainRunnerInputQueue`); pinned by
  `apps/api/src/index.test.ts`.
- VM gateway forward: `packages/gateway/src/routes/agentSessions.ts`
  (`startTurn`/`answer` carry `images` into the prompt command).
- MCP: `list_agent_sessions`, `add_agent_note` in `apps/mcp/src/index.ts`.
- Schema audit + prune rationale: `research/schema-audit.md` (verdicts,
  Example User's keep-or-kill decisions, and the retained-table reasoning —
  including why the workspace version triple stays).

## Divergences from the plan (worth knowing)

- `by_workspace_updated` already existed unused — the plan said "create it";
  the schema audit had it right. The plan was wrong twice in opposite
  directions about one index.
- `interrupt_requested` joined the timeline union during the first slice:
  the real stream already contained it; the contract had to parse reality.
- Multi-input backlogs deliver earliest-first (composition carries one
  input), which forced the drain loop — not in the original plan.
- `lastDeliveredInputSeq` shipped required-with-no-backfill and the
  `gatewayGenerations` rename shipped with no live-data migration: both
  deliberately pre-launch-only postures; a live deployment would need
  migrations first.
- `users` phone/anonymous fields were deletable — verified empirically
  (custom `createOrUpdateUser`, no phone/anon providers, auth suites green
  without them), not by trusting @convex-dev/auth docs.

## Dead ends

- Per-event delivery leases (draft C of the planning fan-out): correct but
  heavier; rejected for the cursor + fence. Revisit only on evidence of
  harmful duplicate note delivery.
- Naive concat resolution of parallel test-file merges: twice produced
  structurally broken files; the working pattern is git's own 3-way
  (`git apply -3` of one branch's diff onto the other's tree) plus block-
  boundary repair.

## Not shipped (deliberate)

- duetfs CLI surfaces for notes/list (future).
- Server-side auto-retry of failed initial dispatch (queued-until-next-input
  was chosen instead).
- A fleet/status reader for the workspace version triple (kept write-side;
  named as the cheap missing reader in the audit).
