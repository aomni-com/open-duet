# Slice 06 — Call ticket and bound credential

Status: **complete.** Activation, ticket exchange, credential/resource binding,
route admission, and retry-stable browser participant identity are implemented
and verified. Slice 07 owns the closed MCP registry behind that credential.

## Contract unlocked

An authenticated browser can activate one call and receive a room-scoped
LiveKit token. The named external worker can exchange a dispatch-only ticket
for a short-lived Duet credential bound to exactly that call, retained session,
and selected Main owner.

Read `SECURITY.md` before deciding or implementing this slice. Invoke
`write-tests` and land the security model update with the code.

## Activation seam

```http
POST /v1/ws/:workspaceSlug/voice/calls
Authorization: browser session
Content-Type: application/json

{
  "agent": { "kind": "root" },
  "clientRequestId": "uuid"
}
```

Custom-agent selection uses `{ "kind": "custom", "agentId": "..." }`.
The backend checks workspace membership, user ownership, selected-agent
existence, and canonical backend launchability before creating anything.

The browser calls this only after disclosure acceptance and successful
microphone permission. The endpoint idempotently creates the Slice 05 session
and call, a unique LiveKit room, and an explicit dispatch for the single named
`duet-voice` worker. Dispatch confirmation is durable. A retry skips a confirmed
dispatch; if the request died before confirmation, it redispatches the same
deterministically derived one-time ticket so the call can recover without
storing ticket plaintext.

```ts
type CreateVoiceCallResponse = {
  callId: string
  voiceSessionId: string
  livekitUrl: string
  participantToken: string
  connectExpiresAt: number
  callEndsAt: number
}
```

The participant token grants join and microphone publication to that room
only, dispatches the named worker when the unique room is created, expires in
five minutes if unused, and contains one opaque exchange ticket only inside
worker job metadata. The response/browser never sees that ticket, a Duet
bearer, or the LiveKit API secret.

UI-only onboarding locks cannot be authoritatively inferred by this API; the
card prevents those activations. Backend launchability is still rechecked.

## Ticket exchange

```http
POST /v1/voice/calls/exchange
Content-Type: application/json

{ "ticket": "..." }
```

The ticket is a 256-bit HMAC over the activation identity, stored only as a
digest, expires in 60 seconds, and is consumed atomically. A successful
exchange returns:

```ts
type VoiceCallExchangeResponse = {
  credential: string
  expiresAt: number
  mcpUrl: string // canonical root plus ?agent=root|<slug>
  callId: string
  voiceSessionId: string
}
```

Add credential kind `voice_call`. Reuse the existing exact workspace sessions
scope and exact MCP audience. Add resource binding fields for call ID,
Voice-session ID, and selected root/custom owner. These are external credential
constraints, not new workspace capability vocabulary.

The credential expires at call end plus at most two minutes, with a 60-minute
hard call limit. End revokes it immediately. There is no refresh family in v1.

## Deny-by-default admission

Because the same bearer reaches MCP and its downstream API requests, API auth
must reject `voice_call` credentials everywhere except:

- whoami;
- the exact exchange-derived call message/end endpoints;
- the exact selected root/custom default-session get/history/message/answer
  operations used by the bound MCP adapter.

Every admitted route resolves the resource from credential binding and rejects
caller-selected sibling workspace, agent, session, or call targets. The MCP
query `agent` must equal the credential's selected owner. Ordinary credentials
retain their existing route behavior.

Update `SECURITY.md` to explain why this resource binding exists at the
external-worker boundary while the workspace VM remains one trust domain.

## Runnable artifact and verification

A redacted threat-table harness proves:

- activation response contains no ticket or Duet credential;
- explicit dispatch metadata reaches the named worker;
- one of two concurrent exchanges wins and every replay fails;
- expiry before exchange fails and terminalizes abandoned connecting calls;
- wrong audience, workspace, agent query, sibling session, sibling call, and
  arbitrary API routes fail;
- end/revocation blocks new MCP and media requests;
- duplicate activation with the same request ID returns the same call;
- a crash before durable dispatch confirmation can redispatch the same ticket;
- a disabled/deleted selected agent before activation is refused;
- ticket, bearer, transcript, and audio never enter logs/audit payloads.

Register all new `/v1` endpoints or the required named private-owner exclusion
in the endpoint metadata firewall.

## Delegated decisions

- Hash primitive and storage module consistent with existing API-key owners.
- LiveKit room-name encoding, provided it is unique, opaque, and contains no
  workspace/agent/user names.

Not delegated: token/ticket TTLs, browser response, credential kind/binding,
audience/scope, route allowlist, revocation, or no-refresh rule.

## Non-goals

- New per-agent capabilities, OAuth grants, app/system/browser credential
  reuse, worker-per-agent deployment, or passing the ticket through the browser.

## Stay-green gate

Keep all existing credential kinds, audience checks, ordinary MCP/API route
admission, API-key audit behavior, and endpoint inventory tests green.

## Human feedback that changes this slice

Only a change to the external worker topology, browser-held material, call
lifetime, or resource binding changes this slice. Workspace-internal scope
preferences do not override `SECURITY.md`.
