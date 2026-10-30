# Custom MCP servers — rationale record

A workspace attaches remote MCP servers of its own, and its agents get those
tools. They sit beside the Composio-backed catalog on the Integrations page,
share its per-agent access rule, and are otherwise a separate lifecycle end to
end.

Closed 2026-08-18. Decision provenance: [MAP.md](MAP.md) — the quadrant walk
that fixed every product decision, and the landmine sweep. Measured evidence:
[PROBE.md](PROBE.md). Decisions made without Example User during the build:
[choices.md](choices.md).

**Nothing is owed.** The `mcp-servers` staging journey ran green against live
staging on 2026-08-18: all eight legs, cleanup clean, no orphans. It found one
real defect on the way, recorded under
[Dead ends](#dead-ends-and-what-they-cost) — capping an oversized result
returned it to the model as a protocol failure rather than a shortened
document, for every server that declares an output schema. See
[Verification](#verification).

---

## Why it works this way

**Two lifecycles, one byte path.** Composio owns a provider session with
CAS-adopted identity, a permission fingerprint, a live vendor catalog, and a
readiness gate that refuses dispatch. A custom server has none of those. The
only thing they genuinely share is that a runner's request arrives, an
Authorization-shaped header is injected, and bytes are forwarded — so that, and
only that, is shared code in `apps/api/src/mcp/proxy.ts`. Unifying the
lifecycles would have meant an interface whose methods are `undefined` on one
side.

**Duet proxies rather than handing the VM a token.** The runner is given a Duet
URL and Duet's own bearer; `ctl` attaches the third-party credential per
request. The alternatives — tokens in the VM, or a token injected into the
runner's `mcpServers` map at spawn — both freeze the credential at session
start, so a long session outlives its access token. Proxying also gives one
chokepoint for the result cap, health, and policy.

**Readiness for a custom server is not a step; it is an observation.** The
launch marker is projected from durable rows inside a mutation that already
runs, with no network I/O, so a broken server still ships its name. The runner
connects, fails, and warns it away. Only the proxy learns anything, per request.
This is deliberate: the cheapest way to guarantee a custom server never gates
dispatch is to have no readiness concept a later change could wire into the
fail-closed gate. `projectMcpServerTurnLaunch` takes a `QueryCtx` and writes
nothing — that signature is the rule made mechanical.

**The launch marker carries names, nothing else.** The control plane knows which
servers exist; only the gateway knows how its VM addresses and authenticates to
`ctl`. So names cross the wire and `buildMcpServersConfig` turns them into URLs
with the VM's own credential. No third-party URL and no third-party token ever
reaches a VM.

**Custom servers get a workspace-scoped proxy URL with no session segment,**
while Composio keeps its session-scoped one. Composio's provider Session is
conversation-scoped; a custom server has none, so naming a session would mean a
session-ownership lookup per tool call to protect nothing. That the URL is
guessable by another agent in the same workspace is not a concern — inside a
workspace VM there is one trust domain ([SECURITY.md](../../../SECURITY.md)).

**The tool name is a codec, not a prefix to strip.** `splitNamespacedToolName`
in `packages/contract/src/mcp/naming.ts` is the only decoder. Feeding the web
projection a list of servers would have made a pure function ask a network
question; instead the runner's own encoding is decodable, which is why a
*deleted* server's historical tool calls still render correctly and why the chip
appears at `tool_call_start`, before `details.mcpServer` exists.

**The per-agent rule is shared; the rows are not.**
`domains/agentAccess/policy.ts` owns the three states (absent = All, empty =
Nobody, list = exactly those) for both features. The rows stay in separate
tables because `projectIntegrationTurnConfig` scans every row in the workspace
and folds each *denied* one into the disabled-toolkit set it pushes to Composio
— so a custom server's row in that table would be sent to a vendor as a
disabled toolkit the moment an agent was not on its list.

**CIMD first, DCR second, refuse third.** The MCP authorization spec deprecates
Dynamic Client Registration in favour of Client ID Metadata Documents, and every
server measured that offers Duet *any* way to obtain a client id offers CIMD —
three of the four OAuth-protected servers probed. The fourth, GitHub Copilot,
offers neither and is the live example of the refusal branch.

On the CIMD branch Duet registers nothing, so there is nothing to orphan. The
DCR fallback exists for servers outside that set, and is the only branch the
RFC 7592 cleanup serves.

---

## Invariants the code must keep honoring

### Credentials

- **Third-party tokens live in Convex in plain text; the deployment is the
  boundary.** They are in `mcpServerCredentials`, a separate table from
  `mcpServers`, because Convex queries return whole documents — a token beside
  the server's name would have to be hand-stripped by every list, health, and
  projection read.
- **Every toucher of that table has a distinct purpose, and there is no
  mechanical guard on the count** — so read this list before adding one. In
  `apps/api`: the lifecycle route stores a pasted static token, `mcp/oauth.ts`
  saves what consent produced, `mcp/refresh.ts` rotates under the lease, and
  `mcp/disconnect.ts` spends and deletes. Inside Convex two more reach it as
  cascades rather than as credential logic: `deleteMcpServerRow` when a server
  is removed without a disconnect, and `reapMcpCredentialsForWorkspace` when a
  workspace is deleted. Nothing in `packages/gateway`, `apps/web`, or
  `apps/mcp` names it, and nothing enforces that.
- **Exactly one read hands out a refresh token outside the lease** —
  `beginMcpServerDisconnect`, the call that spends it. It is also the only read
  returning the RFC 7592 access token.
- **No token-named field in this feature's wire schemas.** Pinned by the
  schema-walk in `packages/contract/src/mcp-servers/index.test.ts`, which is
  stricter than the `connected-providers` original it copies: that one matches
  field names exactly and would miss `accessToken`. One allowlisted exception,
  named explicitly — the pasted static token on the add *request*. Scope worth
  knowing: the walk covers the `mcp-servers`, `mcp` and `agent` contract modules,
  not all of `@repo/contract`.
- **Health carries codes, never bodies.** An upstream body can contain the very
  credential the split-out table exists to protect.

### Concurrency

- **Taking the refresh lease and handing out the refresh token are one
  transactional write**, so the token reaches at most one caller per generation.
  `claimMcpRefreshLease` in `domains/mcpServers/credentials.ts`.
- **Lease ownership governs who may fetch; generation governs who may write.**
  A lease that lapsed mid-flight must not discard a result nobody superseded —
  and `failMcpRefresh` checks generation too, or a slow loser's `invalid_grant`
  destroys the grant the winner just refreshed.
- **Assert on `generation`, never on token-value inequality.**
  `refreshAuthorization` preserves the old refresh token when the authorization
  server returns none, and the test fixture rotates only every *other* refresh.
- **Registration adoption is a compare-and-swap, not an upsert.** Last-write-wins
  leaves the winner's client registered upstream with nothing pointing at it.

### The launch wire

- **`mergeGatewaySessionLaunch` fail-closes `mcpServers` by name**, exactly as it
  does `integrations` (`packages/gateway/src/agent-sessions/ledger.ts`). Without
  that line a removed server resurrects from the on-disk envelope on the next
  turn and stays forever, because every later turn re-merges it.
- **The wake path computes its answer above and outside the Composio branch.**
  A Composio failure returns 200 with `mcpServers` and `integrations` simply
  absent — which is what that response already means, and what
  [integration-agent-access](../integration-agent-access/README.md) says a wake
  should do.
- **The projection is unconditional.** There is no flag mirroring
  `projectIntegrations`; adding one would reproduce for custom servers the bug
  where a Composio-less deployment silently gets no MCP servers at all.
- **The dispatch shape is declared in two places that must agree** — Convex's
  `runnerDispatchValidator` and the hand-written TypeScript return type beside
  it (`domains/agentSessions/model.ts`, `delivery.ts`). A field added to one and
  not the other **typechecks fine and throws at runtime**. Any test for a new
  field must fire a real `prepareRunnerInputDelivery` rather than a helper, or
  it proves nothing.

### Bounds

- **The tool-result cap must stay at or below `CONVEX_EVENT_BUDGET_BYTES`**,
  pinned by a test in `apps/api/src/config.test.ts`. Below it, anything the model
  was allowed to see the timeline can still show in full.
- **The cap parses JSON-RPC and rewrites `result`; it never cuts bytes.** A
  truncated frame is unparseable JSON, which turns an oversized-but-useful
  answer into a hard tool failure.
- **A cap that drops `structuredContent` must flag the result `isError`.** The
  structured half is shed first because it usually duplicates `content`, but a
  server sends it because it declared an `outputSchema`, and an SDK client
  rejects a schema-bearing result that arrives without one unless it is flagged.
  Pinned by `result-cap.test.ts` in both directions: flagged when the structure
  goes, still a success when prose alone was truncated. Dropping the flag
  reproduces the `-32600` the live journey caught.
- **The proxy also bounds what it holds and how long it waits.** A frame can only
  be capped whole, so the buffer holding a partial one is bounded by nothing
  else; and an upstream gets seconds, not the SDK's minute, because the runner
  connects its servers serially.
- **SSE is capped by a streaming transform, never by buffering.** The proxy also
  serves `GET`, the standalone server→client channel that never closes;
  buffering it pins the invocation until the function times out. A test fails
  *by timeout* if anyone reverts this — the only way that regression announces
  itself. Slice-00 measurement: SSE is the framing real servers use, including
  for `initialize` and `tools/list`, so this is the hot path.
- **Health writes are debounced, and that is correctness, not tidiness.**
  Dispatch reads the whole `mcpServers` by-workspace index range on every
  message; un-debounced health writes touch that range and put the proxy into
  optimistic-concurrency conflict with the workspace's own dispatches.

### Server names

`[a-zA-Z0-9_-]`, no `__`, and `integrations` reserved
(`packages/contract/src/mcp/naming.ts`). The name is a tool-name prefix, so `_`
being legal made the joined name ambiguous; and because the runner's config is a
`Record`, a server named `integrations` would silently *displace* the Composio
entry rather than collide.

---

## Pointers into the code

| Concept | Owner |
| --- | --- |
| Naming, the tool-name codec, launch schema | `packages/contract/src/mcp/naming.ts`, `src/agent/index.ts` |
| Wire schemas | `packages/contract/src/mcp-servers/index.ts` |
| Rows, projection, health, credentials, disconnect | `packages/backend/convex/domains/mcpServers/` |
| The three-state agent rule, shared with Composio | `packages/backend/convex/domains/agentAccess/policy.ts` |
| One MCP byte path and the result cap | `apps/api/src/mcp/proxy.ts`, `result-cap.ts` |
| Probe, SSRF guard | `apps/api/src/mcp/probe.ts`, `ssrf.ts` |
| Client registration (CIMD/DCR), consent, refresh, disconnect | `apps/api/src/mcp/registration.ts`, `oauth.ts`, `refresh.ts`, `disconnect.ts` |
| Routes | `apps/api/src/routes/mcp-servers.ts` |
| Names → URLs for the runner | `packages/gateway/src/agent-sessions/mcp-servers.ts` |
| Timeline chip | `apps/web/spa/sessions/projection/index.ts` and `apps/web/spa/sessions/ordered-agent-parts.tsx` |
| Panel | `apps/web/spa/routes/integrations/mcp-servers-panel.tsx` |
| Hermetic MCP-OAuth fixture | `packages/fake-oauth-issuer/` |
| Staging journey | `packages/test-harness/src/staging-e2e-synthetic` |

---

## What the SDK does not do, and what that forced

`@modelcontextprotocol/sdk` is the OAuth client. Four of its behaviors shaped
this design and are easy to reintroduce by accident:

- **`auth()` refreshes unconditionally** — there is no expiry check anywhere in
  it. On a request path that rotates the refresh token per tool call from every
  concurrent lambda. Duet calls `refreshAuthorization` itself and owns the
  expiry decision; `auth()` runs on the connect path only.
- **`auth()` re-registers on `invalid_client`**, turning a flapping
  authorization server into a stream of orphaned registrations. Duet handles
  that error itself and marks the registration instead.
- **`registerClient()` discards `registration_client_uri` and
  `registration_access_token`** — the only two fields that make a registration
  deletable. Duet issues the DCR POST itself. **This is enforced structurally:**
  Duet's `OAuthClientProvider` has no `saveClientInformation`, and the SDK
  refuses to register when a provider cannot save the result. Adding that method
  removes the guard.
- **The SDK implements no RFC 9207 `iss` validation**, which the spec makes a
  client MUST. Duet validates it at the callback, before the code reaches any
  token endpoint, with no normalization before comparing.

And one shape trap: `discoverOAuthServerInfo` returns
`authorizationServerMetadata`, not `metadata`, and the OIDC branch of that
parsed object is strip-mode — `revocation_endpoint` and
`authorization_response_iss_parameter_supported` come back `undefined` while the
served document carries them. Read those two from the raw document.

---

## What we cannot clean up, and why

Recorded so nobody assumes disconnect is complete:

- **An authorization server that does DCR but not RFC 7592** leaves a permanent
  registration on its side.
- **A revocation `200` proves nothing.** RFC 7009 mandates it for an unknown
  token, and all three real servers measured that advertise revocation at all name
  their *token* endpoint for it — almost certainly boilerplate. The product reports the
  attempt, never the outcome.
- **A pasted static token is the user's to revoke at its source.** Disconnect
  deletes the row and attempts nothing.
- **A deleted workspace revokes nothing upstream.** `deleteWorkspaceImpl` was a
  soft delete that removed no rows at all, so one deletion used to strand every
  token and registration permanently; a reap now deletes them. But a Convex
  mutation cannot make network calls, so it trades a *reachable* orphan for an
  *unreachable* one. Closing that needs a Convex→`apps/api` rail that does not
  exist. **Open for Example User.**

---

## Dead ends

- **Shelling out to a CLI** — `openclaw mcp login`, `mcp-remote`. Both assume a
  browser on the CLI's own machine; Duet's user is in a web app and the VM has
  no user-facing browser. OpenClaw's own docs concede it: its per-requester mode
  drops loopback and requires a public HTTPS callback origin, which for us is
  `apps/api` — the thing we would have had to own anyway. `mcp-remote` is
  additionally a **stdio** proxy, and the runner has no stdio transport.
- **A pi plugin.** pi has no MCP by design — "no subagents, no plan mode, no
  approval prompts, no MCP, no governance in core".
- **Tool filtering, allowlists, a meta-tool router.** Considered for the token
  cost of a large server; rejected because no prebuilt implementation existed to
  adopt and building a router is a feature of its own. The row shows the cost
  instead.
- **VM-held tokens**, the `connected-providers` shape, and **backend-stores /
  gateway-injects**. Both freeze the credential in headers at session `start`.
- **Widening `integrations` into one list.** It rewrites a shipped wire contract
  and forces the fail-closed gate to learn per-entry semantics.
- **A real third-party server as the recurring staging gate.** The gate would
  break on someone else's outage or consent-page redesign. Reality is proven
  once, by hand; the recurring gate is hermetic.
- **`retryable` refresh-on-401.** The hook exists on the proxy seam and no
  custom source uses it: it would be a second refresh trigger and a second
  token-call site, and the refresh design is expiry-driven only.
- **Dropping `structuredContent` silently.** The cap sheds the structured half
  first because [PROBE.md](PROBE.md) measured a real server sending it as a
  near-exact copy of `content` — 688,299 against 688,313 bytes, so halving the
  payload at no information cost. Right about the bytes, wrong about the
  contract: a server sends that half *because* it declared an `outputSchema`,
  and an SDK client refuses a schema-bearing result that arrives without one
  (`client/index.js:499`). The first live run of the journey caught it — the
  model got `MCP error -32600` and no document at all, which is strictly worse
  than the oversized result the cap was protecting it from. Truncating the
  structure instead is no escape; the validator on the next line rejects it
  against the schema. So the cap marks such a result `isError`, the client's one
  exemption, and the kept prose rides along on it. **The invariant: the cap may
  shrink a result, but it may never claim to have delivered a half it dropped.**
  Worth knowing for anyone reading the timeline: the runner classifies a tool
  call by whether it answered, not by the result's `isError`, so a capped result
  still shows in the timeline as a call that succeeded.

---

## Verification

Focused tests live beside each owner above. The deployed acceptance is the
selectable `mcp-servers` journey in `packages/test-harness`, registered in
`staging-e2e-synthetic`.

```bash
bun run e2e:staging -- --journey mcp-servers
```

**Green against live staging, 2026-08-18** — all eight legs, cleanup clean, no
orphans. The runner needs `DOTENV_PRIVATE_KEY_STAGING` to decrypt
`.env.staging` (that file is gitignored and lives only in the main checkout, so
a worktree has to carry the key across), and the staging API needs
`DUET_ENABLE_FAKE_OAUTH_ISSUER=1` — the journey's preflight fails by name if
that flag is missing rather than dying later as a confusing `server_unreachable`.

The run measured: 196,608 bytes capped to 131,057 with the truncation marker
reaching the timeline, generation 2 → 3 across two concurrent proxied calls, and
removal both revoking the grant and deleting the RFC 7592 registration.

Its eight legs prove, in order: OAuth consent through the browser to a real tool
call, a static token, per-agent policy in both directions, **a broken URL
degrading without refusing dispatch**, an oversized result arriving capped,
one refresh under two concurrent proxied calls, disconnect issuing a
well-formed revocation, and no credential in any artifact.

The fourth is the one that matters: its evidence field is literally
`dispatchRefused: false`. It is the difference between a typo costing a tool and
a typo locking a user out of their own agent.

Two assertions are deliberately weaker than their slice asked, because the
strong form is not observable: "exactly one token-endpoint call" is asserted as
"generation advanced by exactly one" (the fixture's request log is per-lambda
memory), and revocation asserts a well-formed request was issued rather than
that the server forgot the token (a stateless fixture cannot know).

---

## Visual provenance

There was no baseline or inspiration image to match — this feature had no visual
target handed to it. The standard it was held to was an unprimed
`screenshot-critique` on every visual pass. That tool leaves no artifact behind,
so the quotations below are the only surviving record of what it demanded; they
are reproduced here rather than summarized for that reason. It rejected the work
twice before accepting it: the panel's first health
treatment was called "two alerts and one caption, wearing the same slot", with
the status band "reporting all-clear while the real problem is hidden in the
metadata line above it — a genuine misreading of state". The bordered per-server
blocks, the consistent tinted health bands, and the separate amber
dropped-tools line are all answers to that.

The shipped scenes are the `integrations-mcp-*` baselines under
`apps/web/tests/visual/__screenshots__/`, written by the integrations scenes in
`apps/web/tests/visual/playground.spec.ts`. The timeline chip is a separate set
— `session-ordered-parts-*` — from its own fixture; re-blessing one does not
touch the other.

**A caution that outlived the build.** On the integrations page the visual gate
was caught three separate times reporting stale baselines as matching —
including one that predated the panel's existence entirely, and one scene that
had silently become byte-identical to its neighbour and so tested nothing. On
that page, re-blessing a scene means **deleting the baseline and regenerating**;
`--force` is not enough. Treat a green gate there as evidence about the
baselines, not about the app.
