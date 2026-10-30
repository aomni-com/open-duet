# Slice 07 — Agent-bound MCP and Voice input

Status: complete on 2026-08-01. The canonical root transport now constructs a
narrow registry from one resolved owner, and Voice provenance survives durable
history while its ASR reminder remains delivery-only.

## Contract unlocked

The hosted MCP server can expose one selected agent's default session as three
normalized tools. Voice-delivered text carries durable provenance and receives
the ASR reminder every time it reaches Main.

Invoke `write-tests` before contract, gateway, API, or MCP changes.

## Agent-bound MCP server feature

Teach the canonical root MCP transport to accept exactly one optional query:

```text
/?agent=root
/?agent=<canonical-agent-slug>
```

Server construction resolves the selected owner once and builds a bound tool
registry. With no query, an ordinary credential receives the existing ordinary
registry. With `agent`, an ordinary credential receives only the bound Main
registry. A `voice_call` credential requires `agent`, requires it to match the
credential binding, and can never receive the ordinary registry.

Do not register broad tools and hide them after enumeration. The registry is
constructed narrowly at the owner.

## Exact LLM-visible tools

```ts
main_send({
  kind: "request" | "answer"
  text: string
  clientRequestId: string // UUID
}): Promise<{
  created: boolean
  delivery: "accepted" | "queued"
  startCursor: number
}>

main_read({
  clientRequestId: string // UUID
  cursor: number // startCursor first; then the last returned cursor
}): Promise<
  | { state: "working"; cursor: number }
  | { state: "question"; cursor: number; text: string }
  | { state: "complete"; cursor: number; text: string }
  | { state: "sleep" | "interrupted"; cursor: number; text?: string }
  | { state: "unavailable"; reason: string; cursor?: number }
>

main_cancel(): Promise<{ state: "interrupted" | "idle" }>
```

No tool schema contains workspace, agent, call, Voice session, or Main session
identifiers. Tool output does not expose Main session IDs or reasoning/tool
traces. The server derives all routing from the binding. It consumes Slice
04's full `MainSendReceipt` internally, then projects only `created`,
`delivery`, and `startCursor` to the model.

- `main_send(request)` posts to the selected root/custom default-session
  message alias with `behavior: "follow_up"`, normalizes new `201` and existing
  `202`, and preserves `clientRequestId` idempotency.
- `main_send(answer)` is valid only for the bound default session's current
  question and uses the existing answer seam.
- `main_read` uses the Slice 04 receipt/cursor contract and canonical terminal
  mapping. Its first cursor is the matching `main_send.startCursor`; every
  later poll passes the preceding result cursor. No default session before a
  request is `unavailable`, not a prompt to create a fresh arbitrary session.
- `main_cancel` interrupts only the currently running bound default session and
  is exposed so the policy may honor an explicit spoken request to cancel the
  agent's work. Barge-in and End never call it.

`run_agent`, files, memory, integrations, training, roster, arbitrary sessions,
and every other ordinary tool are absent.

LiveKit constructs this server as:

```py
MCPServerHTTP(mcp_url, transport_type="streamable_http")
```

Do not add `/mcp`, SSE, or a compatibility transport.

## Voice input provenance and reminder

Add optional `inputMode: "voice"` to the canonical message and answer request,
durable `user_prompt`/`answer_submitted` events, idempotency fingerprint,
runner-input wire, and delivery composition. The bound MCP adapter always sets
it. Ordinary text requests omit it and retain their exact current bytes.

The stored transcript/answer stays byte-identical to ASR. At the single durable
prompt-composition seam used by both live delivery and replay, prepend this
ephemeral block when `inputMode === "voice"`:

```text
<system-reminder>
This user message was transcribed from speech. It may contain mistakes in
spelling, names, homophones, punctuation, or phrase segmentation. Use context
and memory to interpret it, and ask for clarification when ambiguity matters.
</system-reminder>
```

The reminder is not a fake timeline message, not part of the retained Voice or
Main transcript, and not placed in the global developer prompt.

## Runnable artifact and verification

Build a bound MCP inspector using fake root/custom default sessions. It prints
`tools/list`, each JSON schema, and golden send/read/cancel traces.

Tests pin:

- ordinary no-query registry unchanged;
- root/custom query resolves the correct default alias;
- exact three-tool list and absence of hidden selectors/general tools;
- `voice_call` query/binding mismatch denied;
- create/existing response normalization and queued follow-up;
- every Slice 04 status/question/race fixture;
- `main_cancel` only reaches the bound current session;
- barge-in/end policy fixtures make zero cancel calls;
- durable raw ASR text and fingerprint remain unmodified;
- reminder appears for initial lazy creation, existing-session follow-up,
  answer, queued delivery, and replay/rehydration;
- reminder never appears for ordinary text input and is never stored as an
  authored event.

Run focused contract, gateway delivery/replay, default-session API, MCP tool
list/scope/audience, and canonical-root transport suites.

## Delegated decisions

- Internal registry factory and pure projector names.
- User-facing tool descriptions consistent with the frozen semantics.

Not delegated: query shape, tool count/names/schemas, status mapping, selected
default-session ownership, reminder text/placement, or no-legacy transport.

## Non-goals

- Worker policy, Voice session audio ingestion, UI, or LiveKit connection.

## Stay-green gate

Keep the ordinary no-query MCP tool surface, canonical-root transport,
default-session API semantics, replay determinism, and byte-identical text
delivery green.

## Human feedback that changes this slice

Feedback changing which selected-agent operations Voice may perform or the ASR
reminder semantics changes this slice. Tool naming prose may change without
changing schemas.
