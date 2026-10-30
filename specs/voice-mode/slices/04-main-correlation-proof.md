# Slice 04 — Main-turn correlation proof

Status: complete (2026-08-01).

## Contract unlocked

A deterministic harness proves that one Voice request can own one selected
Main default-session result across lazy creation, queued follow-ups, questions,
retries, deletion, and terminal states. No caller infers “the latest output.”

Invoke `write-tests` before changing contracts or delivery behavior.

## Existing seam to prove

Use the root/custom default-session routes in
`apps/api/src/routes/default-session.ts`. Preserve their lazy creation and
existing `clientRequestId` plus content-fingerprint idempotency.

The proof consumes this normalized contract. Any pure normalizer or durable
receipt added here lands in its permanent contract/API owner and is consumed
unchanged by Slice 07; do not build a disposable production adapter:

```ts
type MainSendReceipt = {
  clientRequestId: string
  mainSessionId: string
  created: boolean
  delivery: "accepted" | "queued"
  startCursor: number
}

type MainReadResult =
  | { state: "working"; cursor: number }
  | { state: "question"; cursor: number; text: string }
  | { state: "complete"; cursor: number; text: string }
  | { state: "sleep" | "interrupted"; cursor: number; text?: string }
  | { state: "unavailable"; reason: string; cursor?: number }
```

`startCursor` or an equivalent durable receipt boundary must ensure later
polling returns only the terminal/dialogue result belonging to that submitted
turn. Source sequence boundaries are acceptable only if the tests prove them
under concurrency. Otherwise add `clientRequestId` correlation to the relevant
durable turn/terminal events or add one dedicated receipt owner.

## Runnable artifact

Build a small API/backend integration harness that prints the receipt and
normalized result for these fixed cases:

- no default session, created and completed;
- existing idle default session, accepted;
- existing running session, queued follow-up;
- duplicate retry with the same ID/body;
- same ID with different content rejected;
- concurrent retries racing;
- Main asks a question, then receives a correlated answer;
- complete, sleep, interrupted, deleted, billing-blocked, unlaunchable, and
  unavailable outcomes;
- default session deleted between send/read and later recreated;
- an older Main completion arriving while a newer Voice request is queued.

The artifact must demonstrate that no case returns an older or sibling turn's
answer.

## Verification

- Preserve the current new-session `201` and existing-session `202` public
  responses; normalization belongs to the future MCP adapter.
- Pin canonical mapping from real statuses (`running`, `ask`, `complete`,
  `sleep`, `interrupted`) and route failures to the product result union.
- Pin bounded cursor paging and ensure tool/reasoning events are not mistaken
  for the answer text.
- Pin question/answer ownership when newer speech arrives while Main is asking.
- Pin queued `behavior: "follow_up"`; this path never uses `steer`.
- Run focused contract, API default-session, backend delivery/event, and
  idempotency suites.

## Stop/go rule

If correlation cannot be proven with the current event boundaries, implement
the minimal durable correlation before marking this slice complete. Do not
push the ambiguity into MCP polling or the Voice prompt.

## Delegated decisions

- Whether the durable fix is an event field or a dedicated receipt, based on
  the smallest single-owner change shown by the failing tests.
- Pure reducer/helper names.

Not delegated: terminal mapping, request ID, queued semantics, answer
ownership, no-latest-output rule, or default-session continuity.

## Non-goals

- MCP registration, worker code, Voice session persistence, audio, or UI.

## Stay-green gate

Keep existing default-session lazy creation, idempotency, history pagination,
question/answer, and ordinary text-session tests green alongside the new race
fixtures.

## Human feedback that changes this slice

Only a change to “selected default session is Main,” queued follow-up behavior,
or correlation semantics changes this slice. Voice wording and UI feedback do
not.

## Implementation handoff

The permanent contract owner is `@repo/contract/sessions`:

- `MainSendReceipt` normalizes both preserved public response shapes and keeps
  the submitted event sequence as `startCursor`.
- `MainReadResult` scans at most 500 history rows after that cursor and accepts
  only a terminal row whose `turnClientRequestIds` explicitly contains the
  receipt's request ID.
- Gateway durable state snapshots the request IDs accepted by one live runner
  turn onto its terminal relay outbox item. Backend history persists and
  returns that metadata without putting it inside the agent-authored event.
- A terminal may own multiple request IDs because multiple commands can join
  one already-running turn. A queued `follow_up` is delivered as a later turn
  and therefore receives later terminal ownership.

Run `bun run proof:voice-main-correlation` for the focused executable proof.
The key race test was falsified by temporarily removing the explicit request-ID
predicate: it returned the older completion at cursor 5 instead of the owned
completion at cursor 7, then passed again after restoration.

Slice 07 exposes these normalizers through bound MCP without adding a second
polling reducer or inferring the latest output.
