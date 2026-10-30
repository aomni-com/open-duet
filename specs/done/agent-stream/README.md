# Agent-session streaming reshape (closed 2026-07-10)

Live agent output streams **straight from the sandbox**; Convex stores only
render-ready canonical steps. The gateway emits ALL events live over a
per-session SSE endpoint (deltas included) from an in-memory ring buffer and
relays to Convex only what persists: canonical events as append-only rows,
doc-patch events as LWW session fields. Ephemerals never leave the live
stream. The API proxies the gateway's live stream and backfills canonical
rows for prior turns. The duetfs CLI is the reference consumer. The browser
session viewer was out of this spec's scope and shipped separately
(`apps/web/app/settings/sessions/[sessionId]/`); data migration (pre-launch)
and `steer` prompt behavior stayed out (the gateway only ever sends
`follow_up`).

## The wire contract (one line)

A live SSE frame **with `id:`/seq is a durable row** in Convex; an id-less
`step`/`usage`/`memory`/`system` frame is **ephemeral**, live-only, never a
row; doc-patch events also travel id-less but persist as LWW fields on the
session doc, not rows. Consumers accumulate ephemerals and swap in the
canonical step on its `id:` frame; the terminal event is itself a durable
row, so the shipped CLI finishes on it without a refetch — a consumer that
lost frames resumes with `Last-Event-ID` instead.

## Event membership (three-way, keyed on `event.step.type`)

`classifyAgentTurnEvent(event)` in `@repo/contract` returns exactly one of:

| Class         | Means                                                    | Home                                    |
| ------------- | -------------------------------------------------------- | --------------------------------------- |
| **ephemeral** | only a live viewer needs it; a reload loses nothing       | live SSE only — never relayed           |
| **canonical** | part of the transcript a reader rebuilds from             | append-only row in `agentSessionEvents` |
| **doc_patch** | the latest value replaces the last, so no history is kept | LWW field on `agentSessions` — no row   |

Which event lands in which class is the classifier's own answer, pinned by the
frozen-membership test beside it — read those rather than a list here, because
membership moves as the product learns what a returning reader actually needs.
It has already moved twice: a tool call's *start* became canonical once it was
clear a mid-turn reload otherwise renders a long call as a transcript that
simply stops, and top-level `system` became canonical by severity (`warn` and
`error`) after a code allowlist proved to be a list nobody remembers to extend.

The discriminant must reach `event.step.type` — it cannot key on `event.type`
alone, because top-level `system` and nested `step.system` classify separately.

## Single-owner invariants

- **The membership rule** is owned once by `@repo/contract`
  (`classifyAgentTurnEvent` + `isCanonicalEvent`/`isEphemeralEvent`). Gateway
  and backend are two enforcement points importing one rule — never two
  copies.
- **The seq counter** is authored solely by Convex, in the
  `appendEvent` + patch pair inside `relayRunnerEventImpl`. Ephemerals and
  doc-patches never advance it; the gateway never invents seqs (it only echoes
  Convex-acked ones as `id:`).
- **Storage decisions** live only in `relayRunnerEventImpl`, which parses
  `AgentTurnEventSchema` and so structurally cannot touch user/session events
  — "never drop user events" holds by construction. User/session events
  (`session_created`/`user_prompt`/`user_note`/`answer_submitted`/
  `interrupt_requested`) remain durable timeline rows.
- **The live buffer** is owned by `DefaultAgentSessionsController`, keyed by
  sessionId, reset on the runner **`startTurn` lifecycle** — never on the
  relayed `turn_started` event, because the real binary may re-emit
  `turn_started` on a follow-up. It outlives every runner (runners are deleted
  at every terminal — `ask` included, since the terminal-means-terminal
  ruling of 2026-07-30; answers rehydrate from the durable checkpoint — see
  the turn-runner principle in `packages/gateway/README.md`).
- **The backfill↔live splice** is owned by the API events route at a single
  boundary seq `N`: Convex owns `[0..N]`, the gateway buffer owns `(N..]`.
  The route honors `last-event-id` (`apps/api/src/routes/agent.ts`).
- **Delivery/seq math keys on user-event rows, not row density** — the
  `markExistingRunnerInputsDelivered` scan cap and the
  `runnerDeliveryKindForPrepared` read window must not shrink; sparser
  canonical seqs are strictly safer.
- **Gateway auth**: the events route sits behind the `app.use('*')` vmToken
  gate (`packages/gateway/src/runtime/http.ts`; allowlist is `/healthz`
  only). Per-session authz stays in API/Convex `getSession`.
- The runner command contract (`behavior: 'follow_up'`, `start`→`turn_started`
  ordering) is pinned by `gateway.test.ts`.

## Live verification (the go/no-go, all GO)

- **Exe HTTPS edge streams `text/event-stream` un-buffered** — verified twice:
  a throwaway-VM probe on 2026-07-09 (10 ticks, 4492ms spread vs 4500ms
  expected, `content-type` preserved), then the compounded
  Vercel-proxy + exe-edge + real-runner path on 2026-07-10 via the staging
  live probe (`packages/test-harness/src/staging-e2e-synthetic`, run against
  service.example.invalid): 31 id-less delta frames, first delta 22.0s before the
  terminal, forced mid-turn reconnect with `Last-Event-ID` resumed with zero
  canonical seq gaps, terminal durable, and the post-terminal refetch returned
  canonical-only rows (no persisted ephemerals). Ring buffer survived a real
  token-flood turn across the reconnect. The contingency (switch transport to
  websockets / shorter heartbeat cadence) was never needed.

## Dead ends & divergences

- **Slices 2–5 were one landable unit**: between the storage split (Convex
  stops storing deltas) and the API proxy splice, trunk loses live deltas.
  The transitional poll path was removed when the splice landed; nothing of
  it survives.
- **Resetting the buffer on the relayed `turn_started` event** (instead of the
  runner `startTurn` lifecycle) was rejected — the real binary re-emits
  `turn_started` on follow-up prompts, which would have wiped the buffer
  mid-session.
- Draft provenance: synthesized from three blind drafts with orthogonal
  biases — fewest-slices (Codex), risk-first (Codex), seam-quality (Claude).
  Where they independently agreed (recon corrections, the classifier pivot,
  seq ownership, firewalls) the design was firm; the shipped shape takes the
  seam backbone from C, the explicit smoke gate from B, and A's slice merges.

## Pointers

- Classifier: `packages/contract/src/agent` (`classifyAgentTurnEvent`,
  `TurnStepSchema`)
- Relay/storage: `packages/backend/convex` `relayRunnerEventImpl`,
  `agentSessionEvents` / `agentSessions`
- Ring buffer + SSE source: `packages/gateway/src`
  (`DefaultAgentSessionsController`, runtime/http)
- Splice: `apps/api/src/routes/agent.ts` events route (backfill +
  live proxy, `last-event-id`)
- CLI consumer: `packages/duetfs/src/agent.ts` (`streamSse`), tests in
  `packages/duetfs/src/cli.test.ts`
- Live smoke: `packages/test-harness/src/staging-e2e-synthetic` (+ `demo-60s.ts`
  mock-agent relay)
