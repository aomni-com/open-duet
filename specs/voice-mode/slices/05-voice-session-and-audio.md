# Slice 05 — Retained Voice session and audio

Status: **complete.** The retained lifecycle, concurrent duplicate-upload
settlement, and self-rescheduling multi-batch audio deletion are implemented
and verified.

## Contract unlocked

Without LiveKit or a production worker, a fake call participant can create one
retained Voice conversation, append ordered transcript/audio messages, end it,
read it through the ordinary session seam, and delete every event and blob.

Invoke `write-tests` and pin the lifecycle red/green before implementation.

## Canonical ownership

Do not add `sessionKind` to every stored `agentSessions` row and do not migrate
existing data. Add one `voiceCalls` row keyed one-to-one by
`voiceSessionId`. Its presence is the only durable Voice-channel discriminator
and it owns call-to-room binding and expiry:

```ts
type VoiceCallRecord = {
  workspaceId: WorkspaceId
  userId: UserId
  voiceSessionId: AgentSessionId
  clientRequestId: string
  clientRequestFingerprint: string
  roomName: string
  callEndsAt: number
  ticketDigest: string
  ticketExpiresAt: number
  ticketConsumedAt?: number
  retainedAudioBytes: number
  createdAt: number
}
```

`retainedAudioBytes` is the transactionally maintained call-level admission
ledger for the 64 MiB ceiling. Individual part metadata remains owned only by
`agentSessionAudio`; the counter prevents an unbounded scan of every prior
utterance on each commit.

The selected owner is canonical on the referenced session (`agentId` absent is
root); do not copy it onto `voiceCalls`. The existing session status and Voice
start/end events are the only durable lifecycle state. Do not add a second call
state enum to this row.
`(workspaceId, userId, clientRequestId)` owns activation idempotency; a retry
with a different selected owner is rejected by the fingerprint.
A retry whose canonical Voice session is already deleting is also rejected;
it never resurrects or returns a hidden session.

Creating a call creates an ordinary `agentSessions` row attributed to the
selected visible agent. It never dispatches a runner. Use:

```text
prompt = ""
searchText = ""
title = "Voice call"
titleOrigin = "manual"
titleStatus = "complete"
status = "running"
```

No fake user prompt, fake Voice agent, title-generation job, runner input, or
default-session mutation is created. Normal end maps the session to `complete`;
failed activation/disconnect timeout maps it to `interrupted`. Voice sessions
never use `ask` or `sleep`.

Session summary/snapshot responses join the one-to-one row and emit
`channel: "voice"` only for Voice sessions. Existing text-session storage and
responses retain their present canonical shape; there is no compatibility
reader or dual schema.

## Voice events

Extend the canonical session-event contract with:

```ts
type VoiceCallStartedEvent = {
  type: "voice_call_started"
  callId: string
  startedAt: string
}

type VoiceMessageEvent = {
  type: "voice_message"
  utteranceId: string
  role: "user" | "agent"
  transcript: string
  startedAtMs: number
  endedAtMs: number
  audioMediaId: string
  source?:
    | { kind: "main"; clientRequestId: string }
    | { kind: "runtime"; category: VoiceRuntimeSpeechCategory }
  interrupted?: boolean
}

type VoiceCallEndedEvent = {
  type: "voice_call_ended"
  reason: "user" | "disconnect" | "timeout" | "unavailable" | "error"
  endedAt: string
}
```

User messages must omit `source`. Agent messages must have exactly one source:
a correlated Main request or the frozen runtime-speech category. Transcript is
final ASR/synchronized spoken text, not tool traces or Main reasoning.

## Audio plane

Add `agentSessionAudio`, the only audio metadata owner, with indexes by session
and media ID. It stores storage ID, MIME, bytes, and duration; events store only
the media reference. Do not rename/generalize `agentSessionImages` and do not
reuse its base64 prompt-input contract.

The worker-facing seam is one binary multipart request:

```http
POST /v1/voice/calls/:callId/messages
Authorization: bound voice_call credential
Content-Type: multipart/form-data

metadata = VoiceMessageEvent without audioMediaId
audio = Ogg/Opus binary
```

The API caps the body before buffering, verifies Ogg/Opus signature and
duration, stores the blob, and calls one idempotent internal commit keyed by
`(callId, utteranceId)`. A failed commit deletes the just-uploaded blob. A retry
returns the existing canonical event. Concurrent duplicate uploads settle one
event/media row and delete the loser blob.

The internal storage/commit seam lands in this slice. Its external multipart
route lands with Slice 06, because that route is intentionally callable only
with the bound `voice_call` credential; there is no temporary unprotected or
general-workspace worker route.

Each Convex storage ID has at most one `agentSessionAudio` owner across every
call. A storage ID already owned by another message is rejected without
deleting that owner's blob; only a fresh duplicate upload can be loser cleanup.

Initial hard limits:

- 60-minute call;
- 4 MiB audio per utterance;
- 64 MiB retained audio per Voice session;
- transcript bounded to the existing prompt/message limit;
- MIME exactly the Slice 03 selected Ogg/Opus string.

Reaching the aggregate media cap stops later retention but does not drop the
live call. It produces a content-free failure signal for the ended UI and
telemetry.

## Read and delete behavior

The ordinary session history/projection preserves `voice_message` order, joins
the referenced canonical audio row, and projects transcript followed by one
authorized playable audio part. Audio URL resolution checks workspace/session
ownership and refuses deleting sessions.

This slice lands the ordered events and authorized audio resolver. The
session-detail projection that turns those two canonical records into the
read-only transcript/player surface lands in Slice 09, where the existing text
projection can branch on `channel: "voice"` without a temporary mixed view.

Extend the existing bounded, self-rescheduling deletion cascade so it removes
Voice audio blobs/rows and the `voiceCalls` row before deleting the session.
End and delete are idempotent. Deleting an active Voice session first marks the
call ended/revoked; LiveKit room closure is wired later.

Presence of the `voiceCalls` row makes the retained session read-only to every
ordinary input/runner seam. Message, note, answer, interrupt, cwd, nested
creation, delivery bookkeeping, and VM relay cannot turn the Voice record into
a second Main session. Rename, archive, read, and delete remain session product
operations.

## Runnable artifact and verification

An API/backend harness must:

1. Create root and custom-agent Voice sessions.
2. Commit interleaved user/Main/runtime utterances with short audio fixtures.
3. Re-fetch and play each authorized audio part in order.
4. Interrupt one agent message and show only its prefix event/artifact.
5. End, then delete the session.
6. Prove every media URL returns unavailable and no storage row survives.

Tests cover invalid MIME/signature, size/duration/call caps, missing/incorrect
agent source, cross-call media, duplicate/concurrent utterance IDs, mid-upload
delete, failed commit cleanup, archive/read behavior, cursor replay, and bounded
multi-batch deletion.

The backend harness in this slice covers lifecycle, provenance, idempotency,
metadata caps, authorized replay, and deletion. Multipart body capping,
Ogg/Opus inspection, and route-level mid-upload cleanup are exercised when the
bound external route is added in Slice 06.

## Delegated decisions

- Convex module/helper names and binary parser consistent with current API
  owners.
- Audio player cosmetics are deferred to Slice 09.

Not delegated: two-record ownership, no fake prompt/agent, event shapes, source
invariants, caps, Ogg/Opus, idempotency, or deletion order.

## Non-goals

- Tickets, MCP, default Main delivery, LiveKit, browser UI, or resume.

## Stay-green gate

Keep ordinary session list/history/archive/delete behavior, image retention,
bounded deletion, and storage authorization green. No test may require a
migration or a Voice-aware text-session reader.

## Human feedback that changes this slice

Feedback changing retained transcript/audio content, per-call/session limits,
or the read-only conversation record changes this slice. Player cosmetics and
live overlay behavior belong to Slice 09.
