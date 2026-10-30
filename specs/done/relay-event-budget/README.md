# Relay event budget

No event the gateway relays weighs more than the control plane can store, and
no single record can hold a session hostage. Agents are told the cheap way to
show someone a file, because the expensive way is what broke this.

Decisions made during the build, ranked by remaining risk, are in
`choices.md` — read that first if you are about to change any of this.

## What went wrong, and why the shape follows from it

2026-08-17, production. A session stopped responding to every message and its
Stop button returned 502.

Convex refuses any document over 1 MiB. The head of that session's relay
journal was a **1.29 MiB `tool_call`** whose output held 1,353,092 bytes of
base64 PNG against a **93-byte input** — the agent had `read` an image file
back to look at it. That record could never be stored, the journal is FIFO, and
so nothing behind it moved either: 55 records, 12.9 MB, retried every five
seconds for hours. The queue's own 16 MB cap then killed every new runner about
200ms after it started, which is why new messages produced nothing at all. And
the API reported the storage failure as `401 unauthorized`, so the diagnosis
went to the credential rail first.

Four separate things had to be true for one oversized image to take a session
down, and the fix addresses each:

- **Nothing bounded a single event.** The journal capped its *total* size but
  never one record, against a ceiling the control plane enforces and the
  gateway never knew. Now `storableEvent` gives every event a budget sized
  under Convex's document limit.
- **An undeliverable record blocked the deliverable ones.** Now the budget is
  applied on the way in *and* to records read back from disk, so a journal an
  older gateway jammed heals on restart instead of needing surgery.
- **A killed runner told no one.** The session went on reading as a live turn.
  Now the kill reports itself and the control plane ends the turn.
- **The failure lied about its cause.** Now the relay route reports a relay
  failure as one.

## Why it works this way

**The timeline is a projection, not the record of truth.** This is what makes
trimming safe at all: the agent's own view of a tool result and the durable
ledger checkpoint both keep the full output. Only the copy travelling to the
control plane is cut. Any change that starts treating relayed events as an
archive invalidates the whole design.

**Image data never travels.** Not "when it is too big" — never. Nothing in the
control plane reads it (there is no consumer of `step.output` outside the web
timeline), and a file worth seeing belongs in the drive, where markdown renders
it. That is also why this spec ships a prompt layer: the habit that caused the
incident was an agent trying to *show* someone a picture the only way it knew.

**`state` is exempt from the budget.** It rides on `turn_started` and all four
terminals, and the control plane drops it before storing in every one of those
cases — the ledger envelope owns the checkpoint. Measuring it would cut a
turn's real state to satisfy a limit it never meets.

**The gateway reports; the control plane concludes.** A backlog kill would
naturally want to write an `interrupted` terminal, and the gateway cannot: a
terminal folds its `state` into the ledger checkpoint, and the gateway has no
state to fold except the real one it would destroy. So it emits a
`relay_backlog` system event and Convex ends the turn through
`terminalizeSession` — the same owner that ends a turn for a paused workspace
or a deleted agent.

**A repeated relay id settles rather than being refused.** Refusing a known id
whose content changed is what strands a record at the head of the queue, which
is the failure this spec exists to end. The guard it replaced protected against
a gateway minting one id for two events; that signal survives as a log line
(see `choices.md`).

## Invariants

- A relayed event fits `CONVEX_EVENT_BUDGET_BYTES`, measured whole. Nothing on
  the wire is exempt from the measure — an exempt field is a hole the size of
  whatever grows in it.
- The runner's transcript is not on the wire at all. The control plane projects
  three fields off `state` and drops the rest, and the checkpoint a later turn
  resumes from is the VM's own; shipping the messages fed a mutation that dies
  parsing them.
- Retrying is bounded. A payload the control plane refuses is refused for good,
  and one that outlives the retry budget is dropped so the queue behind it can
  move — the turn ends visibly rather than reading as live forever.
- A record that cannot be delivered — unparseable or oversized — is dropped or
  trimmed, never left to block the records behind it.
- Every removal leaves a marker naming what went and how big it was. A reader
  can tell a dropped image from a truncated log.
- Sacrifice order is images, then `details`, then prose. The answer is the last
  thing to go.
- A killed runner is a finished turn: whatever kills it, the control plane
  learns, or the session lies about being alive.
- One table decides what the drive serves, what the timeline embeds, and what
  the prompt advertises. A format the timeline embeds but the drive serves as
  `application/octet-stream` fails silently.

## Where it lives

| Concern | Code |
| --- | --- |
| The budget and its sacrifices | `packages/gateway/src/agent-sessions/storable-event.ts` |
| Applied in, and healed on load | `relay-outbox.ts` (`normalize`, `admitBeyondCapacity`), `ledger.ts` |
| Gateway-drawn endings and their reports | `coordinator.ts` (`reportGatewayEndedTurn`, and the event builders beside it) |
| What "the gateway ended this turn" means | `packages/contract/src/agent/index.ts` (`GATEWAY_REPORTED_TERMINAL_CODES`) |
| Ending the turn | `packages/backend/convex/domains/agentSessions/events.ts` (`isGatewayReportedTerminalCode`, `terminalizeSession`) |
| Honest relay errors | `apps/api/src/routes/agent.ts` (`/v1/vm/agent/sessions/:sessionId/events`) |
| One media table | `packages/contract/src/files/index.ts` (`DRIVE_FILE_MIME_TYPES`, `driveMediaKind`, `inlineMediaExtensions`) |
| Telling agents how to show a file | `packages/gateway/src/agents/showing-files-prompt.ts` |

Behavior is pinned by `storable-event.test.ts`, `ledger.test.ts` (journal
normalization and NUL-hole tolerance), `coordinator.envelope.test.ts` (the
backlog report), `agent-sessions.test.ts` in `packages/backend` (terminalization
and receipt settling), and `sessions.test.ts` in `apps/api` (the relay route's
error).

## Divergences from the plan

- **The media table and its consumers landed together**, not as separate
  slices. Splitting them would have committed a state with three copies of the
  table, which is the thing the work removes.
- **The budget constant lives in the gateway**, not `@repo/contract` as
  planned: it has exactly one enforcer.
- **The backlog terminal is written by Convex, not the gateway** — see the
  reason above. The plan assumed the gateway could author it.
- **`state` being exempt was not foreseen.** The plan said "bound every event";
  the code says "bound every event the control plane stores", which is the same
  rule once you know `state` is always dropped.

## Dead ends

- **Truncating a terminal's `state` to fit the budget.** It would have cut the
  checkpoint a later answer resumes from, to satisfy a limit that never applied
  to it.
- **Letting the gateway author the `interrupted` terminal.** Same reason, from
  the other direction: authoring one means folding invented state into the
  ledger over the real checkpoint.
- **Comparing re-serialized journal records to detect normalization.** Zod
  reparse does not preserve key order, so every load would have looked changed
  and rewritten the file. Identity comparison on the normalizer's return value
  is what makes "nothing needed doing" cheap and exact.

## The Bun bug underneath

The journal that jammed was *also* corrupt: 5.2 MB of NUL bytes in the middle
of a 20 MB file. On Linux, Bun 1.3.14's `writeFileSync(fd, string)` follows a
write of 2 MiB or more to an O_APPEND descriptor with an equal-length run of
NULs, doubling the file. macOS is unaffected, so nothing local can reproduce
it. The fix — a `writeSync` loop in `packages/gateway/src/atomic-json.ts` —
predates this spec but belongs to the same incident; `atomic-json.test.ts`
guards it, and the 300 KB budget now keeps any single journal append far below
the threshold anyway.
