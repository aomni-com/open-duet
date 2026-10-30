# Foreground session waits

Foreground session waits let one session delegate work to another with a single
request that both durably submits the input and waits for the terminal event
caused by that input. Existing asynchronous endpoints remain the background
primitive; polling and history remain recovery and context tools rather than the
normal foreground workflow.

## Why this shape

Submission and observation are one client operation but remain two durable
facts. The backend commits an input before the gateway accepts it, and the
gateway may emit several terminal-looking events over the lifetime of a session.
Neither “the next terminal event” nor current session status proves which input a
terminal covers. The gateway therefore snapshots its accepted input boundary
onto the exact terminal relay item, and the backend joins that immutable boundary
to the submitted input sequence.

The wait stays API-owned rather than gateway-owned. The backend event row is the
authoritative public marker, including its sequence and timestamp; gateway SSE is
only a low-latency nudge to recheck durable state. A disconnected HTTP client
abandons its observer, not the already-committed work. A later retry recovers the
same input, and a deadline returns an opaque cursor that resumes observation
without submitting again.

Foreground support crosses the API, backend, and VM gateway without a parallel
submission protocol. Both response modes use the ordinary durable input and
gateway delivery path; foreground mode adds observation after submission.

Default-session aliases are convenient names, not durable identities. They are
resolved once during submission; every observer and cursor uses the canonical
session thereafter. Idempotent recovery runs before current alias, parent,
capability, spend, or image-persistence checks so an input committed before an
ambiguous disconnect cannot disappear when mutable routing state changes.

The implementation decisions that resolve details beyond the public contract are
preserved in the [choices ledger](choices.md).

## Invariants

- A completed wait returns only the earliest durable terminal whose snapshotted
  accepted boundary covers the submitted `inputSeq`. Session status, current
  delivery cursors, request IDs, and event order alone are never causality
  oracles.
- The accepted boundary is copied into the relay outbox item while the gateway's
  per-session ledger is serialized. A later input cannot retroactively make an
  older terminal cover more work.
- Backend-owned terminalization attaches coverage only when the same mutation
  settles and clears a known pending input. Pause, deletion, and unrelated
  control-plane terminalization do not invent coverage.
- Public history remains the one transcript representation. Wait responses carry
  the exact terminal marker and correlation tuple, never accumulated history or
  synthesized output.
- Wait requests require one UUID and are strict. Retrying the identical request
  resumes observation of its durable input without repeating submission effects.
- Foreground and background requests share one durable submission and gateway
  delivery path. Foreground behavior begins only after submission, when the API
  observes the correlated terminal instead of returning immediately.
- Request abort and the 720-second application deadline stop only observer-owned
  streams and timers. The deadline starts at wait-route entry, so submission and
  observation share one budget. Neither condition cancels a runner, abandons a
  queue lease, deletes a session, or interrupts durable work.
- A healthy gateway event stream owns wakeups. Durable state is checked before
  attaching and after activity; reconnect backoff is used only when that stream
  closes or cannot connect.
- Existing async create, message, answer, default-alias, and note responses remain
  their background contracts. Notes have no foreground wait variant.
- The 720-second application deadline remains below the API's 800-second function
  cap. A lower deployed unary ceiling is a release failure, not permission to
  shorten the product contract silently.

## Where the contracts live

- Public request, response, and endpoint vocabulary:
  `packages/contract/src/agent/index.ts`,
  `packages/contract/src/sessions/index.ts`, and
  `packages/contract/src/endpoints/index.ts`. Gateway capability and VM sync
  vocabulary live in `packages/contract/src/vm/index.ts`.
- Gateway acceptance and immutable relay coverage:
  `createAgentSessionLedger` in
  `packages/gateway/src/agent-sessions/ledger.ts`.
- Durable causality and retry identity: `findCoveringTerminalImpl` and
  `findWaitSubmissionImpl` in
  `packages/backend/convex/domains/agentSessions/queries.ts`, with relay and
  delivery mutation ownership in the neighboring `events.ts` and `delivery.ts`.
- Shared API side effects: `submitSessionInput` in
  `apps/api/src/session-submission.ts`. Foreground route composition lives in
  `apps/api/src/routes/session-waits.ts`; async adapters continue to serialize
  their existing response families in the ordinary agent/default route modules.
- Durable observation: `observeSessionWait` in `apps/api/src/session-wait.ts`.
- Developer and agent guidance: `apps/docs/app/sessions/page.mdx`,
  `packages/skills-registry/skills/start-session/SKILL.md`, and
  `packages/gateway/src/agents/parent-session-prompt.ts`.
- Deployed acceptance: `runForegroundSessionWaitsJourney` in
  `packages/test-harness/src/staging-e2e-synthetic`, selected
  by `foreground-session-waits` in the staging journey registry.

The adjacent tests pin the contract at each owner. The API integration suite
keeps all six public routes and the async compatibility families together; the
backend and gateway suites pin fast-terminal races, queue re-leasing, restart,
legacy relay retry, and VM-generation readiness.

## What deployment taught us

The first authenticated staging run reached the deployed API but returned 404,
showing that local correctness could not substitute for publishing the API,
backend schema/functions, and gateway release together. The normal API deployment
rail provided that ordering.

The first post-deploy journey then exposed an acceptance-harness defect: an
assertion eagerly constructed its failure message by reading `response.text()`
even for HTTP 200, consuming the body before JSON parsing. Response validation now
reads JSON once on success and text only on failure. The corrected journey proved
root and nested waits, parent follow-up, ask/answer, abort recovery without input
duplication, asynchronous background creation followed by a canonical snapshot
that still showed its held turn running, canonical history, ordinary unary
durations, and verified cleanup.

Staging exposes no safe control seam for taking a shared gateway offline, and a
real 720-second sleep would test cost rather than semantics. Transient outage
queueing and the exact deadline remain deterministic local integration gates; the
live journey records that coverage boundary explicitly. The final redacted result
is preserved in [`assets/staging-evidence.json`](assets/staging-evidence.json).

## Rejected alternatives

- **Public SSE as the wait result:** the existing stream may close when the
  gateway is unavailable and a live frame is not the authoritative durable row.
- **The first terminal after the input:** durable order does not prove causal
  coverage when old relay items arrive late or a later input is accepted first.
- **Reading the gateway's current accepted cursor during relay:** it lets a newer
  input retroactively enlarge an older terminal's meaning.
- **Poll-only waiting:** it is correct but adds avoidable latency and discards the
  gateway's existing live activity signal.
- **A gateway health endpoint or release-version inference:** neither proves
  which inputs a terminal accepted.
- **A durable waiter table:** the input and event logs already hold the durable
  facts; another table would add lifecycle and cleanup without improving
  causality.
- **A second continuation token or endpoint:** the idempotent request already
  identifies the durable input, so another identity only creates drift.
- **Cancelling work on HTTP disconnect:** it turns a transport failure into a
  destructive session command and breaks durable delegation.
- **Returning output or history inline:** it creates a second transcript format
  that can drift from public history.

## Evidence provenance

This feature has no visual surface and used no baseline or inspiration imagery.
Its acceptance standard is the durable API contract and the focused deployed
journey. The preserved staging evidence is a manually derived, redacted summary
of the harness-shaped result: it records the actual causal sequences, request
durations, abort recovery, background response, and zero-orphan cleanup while
omitting transient resource identifiers. The runnable journey and its emitted
`ForegroundSessionWaitsEvidence` remain the source of truth for reproducible
field shape and assertions.
