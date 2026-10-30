# Custom MCP servers — quadrant map

The decision record behind [the rationale record](README.md). Produced by a
full quadrant walk with Example User on 2026-08-17, before any code existed. Every
decision here was binding on the build; the README says what the code now does
with them and where they were revised.

Companion artifacts (clickable):

- [The map](https://claude.ai/code/artifact/6a055dd5-f8b5-4250-946b-fef1002772e8)
- [The add-flow mock](https://claude.ai/code/artifact/f9d09584-6463-42cd-92d2-73adf8fbd485)

> The build plan rendered on the map artifact was a **pre-spec sketch**, and the
> slice ladder that replaced it has itself been collapsed into the README now
> that the feature shipped. Read [README.md](README.md) for what is true today.

---

## The request

Let users attach **arbitrary remote MCP servers** to a workspace so their
agents get those tools, listed beside today's Composio-backed integration
catalog. Composio stays the curated catalog; this is a second connection
*kind*, not a replacement.

---

## Q1 — Known knowns

Facts read out of the tree, not recalled.

| Fact | Evidence |
| --- | --- |
| The runner already accepts N MCP servers. `McpServersConfig` is `Record<string, McpHttpServerConfig>`; exactly one key, `integrations`, is filled today. | `packages/contract/src/mcp/index.ts:9,17` |
| That entry points at Duet's own API, which byte-forwards to a per-Duet-session Composio Tool Router. **This route is the template the whole feature clones.** | `apps/api/src/routes/composio.ts:99` |
| The gateway builds the map at spawn from its own desired state and passes it in the runner's `start` command. | `packages/gateway/src/runtime/http.ts:1268`, `agent-sessions/coordinator.ts:587` |
| Only `type: "http"` exists. No stdio, no SSE transport, static headers only, no client-side OAuth. | `packages/contract/src/mcp/index.ts:11` |
| Servers connect at `start` only — but every terminal event kills the runner, so each turn re-hydrates and recomputes the map. | `@duetso/agent` `dist/src/types/protocol.d.ts:404`; `coordinator.ts:245` |
| Every listed tool is registered unconditionally, namespaced `{server}__{tool}`, sorted once for prompt-cache stability. A server that fails to connect or list is `warn()`-ed and skipped — the user is never told. | `@duetso/agent` `dist/src/turn-runner/mcp.js:30-95` |
| Per-integration agent policy already exists with three states: absent = All, empty = Nobody, list = exactly those. Keyed by toolkit slug. | `packages/backend/convex/domains/integrations/{model,turnConfig}.ts` |
| An `integrations` capability already exists and is already elevated. No new capability is needed. | `packages/contract/src/scopes/index.ts:12,43` |
| Duet is already an MCP *server* with OAuth 2.1 at the origin root — unrelated direction, but the repo already owns MCP transport, PRM discovery, and DCR. | `apps/mcp/`, `specs/done/mcp-oauth-green/` |
| The full MCP OAuth *client* flow has already been written once, by hand, against our own server. | `packages/test-harness/src/staging-e2e-synthetic` |

---

## Q2 — Decision ledger

`user` = Example User decided. `territory` = the code decided. `walk` = decided during
the walk and reported to Example User.

| ID | Decision | Why | Closed by |
| --- | --- | --- | --- |
| D1 | Scope is user-added remote MCP servers, listed beside Composio connections. Composio stays the curated catalog. | A second connection kind, not a replacement. | user |
| D2 | OAuth to the remote server is in v1. No-auth and pasted-static-token ride along. | The contract already expresses both; they cost nothing next to OAuth. | user |
| D3 | Use `@modelcontextprotocol/sdk`'s `client/auth`. **No new CLI in the VM image.** | pi has no MCP by design; OpenClaw and `mcp-remote` both assume a browser on the CLI's own machine, which Duet does not have. The SDK is already a dependency (`apps/mcp`, `packages/test-harness`) and its `OAuthClientProvider` seam lets Duet own storage and redirect. | territory |
| D4 | **Duet proxies.** The runner gets a Duet URL; `ctl` attaches the Authorization header per request and forwards bytes. | Tokens stay in the control plane, refresh is per-request so nothing expires mid-session, and it clones a proven route. | user |
| D5 | Servers attach to the **workspace**, reusing the existing three-state per-agent policy. | Same row, same editor as a Composio toolkit. Keeps published marketplace agents from carrying a server URL into strangers' workspaces. | user |
| D6 | Import **every** tool, no filtering. Show tool count and estimated per-turn token cost at add time and on the row. | Conditional on no prebuilt pi plugin existing — confirmed none does. The probe already returns `listTools()`, so the count is free. | user |
| D7 | **Revised 2026-08-17.** Registration priority is **CIMD → DCR → refuse**. Try Client ID Metadata Documents first; fall back to DCR for servers that only speak the old way; only when neither works, refuse OAuth and offer the static-token path. | The MCP authorization spec now deprecates DCR: "Dynamic Client Registration is deprecated and retained for backwards compatibility with authorization servers that do not support Client ID Metadata Documents." A server without a `registration_endpoint` may be *ahead* of us, not behind. The SDK already supports CIMD via `clientMetadataUrl`. See D24. | user |
| D8 | **Narrowed 2026-08-17 during drafting.** Server keys are `[a-zA-Z0-9_-]{1,48}`, **must not contain `__`**, and **must not be the reserved name `integrations`**. A tool whose namespaced name would exceed 128 chars is dropped at probe with a visible warning. | The key becomes a tool-name prefix; tool names must match `^[a-zA-Z0-9_-]{1,128}$`. Two defects in the original: (1) `_` is allowed, so `my__server__TOOL` is ambiguous and `{server}__{tool}` is not decodable — which D19's chip needs it to be; (2) `McpServersConfig` is a `Record`, so a server named `integrations` **silently displaces the Composio entry**. Both are contract-level, not route-level, validation. | walk |
| D9 | Reuse the `integrations` capability for the proxy route. | Already exists, already elevated, same guard the Composio route uses. | territory |
| D10 | `ctl` records last-success / last-error per server; the row surfaces it. | With filtering off the table, this is the only feedback channel. Today a skipped server is invisible. | walk |
| D11 | Changes take effect on the **next turn**. No mid-turn cutover, no restart button. | Every terminal kills the runner, so the next input respawns and recomputes. | territory |
| D12 | Tokens live in **Convex, plain**, like any other row. The deployment is the boundary. | Explicit call. Sets the precedent for third-party credentials generally. | user |
| D13 | **No egress warning.** Adding the server is the consent. | Explicit call. | user |
| D14 | **Any workspace member** can add one, same as connecting an app. | Matches Composio connect: browser-session-only, any member, no tier gate. | user |
| D15 | Done means a staging journey registered in `packages/test-harness`. | Repo convention for a feature this size. | user |
| D16 | A **second independent `mcpServers` field** on the launch marker. `integrations` is untouched. | A Composio outage cannot take out custom servers, and there is no `COMPOSIO_API_KEY` coupling. | user |
| D17 | Custom-server preparation is **best-effort and never gates dispatch**. | A typo'd URL must not lock a user out of their own agent. Composio's fail-closed gate is untouched. | walk |
| D18 | **Narrowed by revised D7.** Disconnect revokes the token via RFC 7009 when advertised. Registration reuse — one client registration per (workspace, authorization server) — applies **only to the DCR fallback branch**; the CIMD branch has no registration to store, reuse, or orphan. | Otherwise add/remove cycles litter third-party servers with orphaned "Duet" registrations. CIMD dissolves the problem for servers that support it. | walk |
| D19 | The timeline projection strips **any** known server prefix; the server name becomes a separate chip. | Otherwise Composio tools render clean and custom tools render raw. | walk |
| D20 | **Cap MCP tool-result size at the proxy.** Applies to the Composio path too. | Nothing caps it today; the relay budget only protects the timeline, not the model call. | walk |
| D21 | Slice 00's kill gate hits a **real** OAuth-protected MCP server once. The **recurring** staging journey runs against our extended fake issuer. | Reality proven once; regression guarded by something that cannot fail because a third party had an outage. | user |
| D22 | **No backward compatibility, no data migrations.** Hard cutover. | New field nothing reads yet, new tables with no existing rows, no column drops. Consistent with the repo's standing position that prod has no data worth preserving and staging is wipeable. | user |
| D23 | **Duet validates RFC 9207 `iss` itself, at the callback**, before the authorization code reaches any token endpoint. Record the issuer from validated AS metadata alongside the PKCE verifier; compare with simple string comparison, no normalization. | The spec makes this a client **MUST**, and `@modelcontextprotocol/sdk@1.29.0` does not implement it — `client/auth.js` has no `iss` handling at all. We own the callback, so we own this check. Without naming it here it never gets written. | walk |
| D24 | Duet **hosts one Client ID Metadata Document** at a stable HTTPS URL and uses that URL as its `client_id`. | Required by revised D7's first branch. Note Duet deleted a CIMD path on 2026-07-26 because the live *resolver* was broken — that was the server side (us resolving others' documents). This is the publishing side, which is a static JSON document. | walk |

### Decisions with no owning slice

Audited 2026-08-18, because a decision agreed in planning and never turned into
a slice reads as done when "all slices closed" — the classic silent miss. Every
D1–D24 was reconciled against shipped code. **Two need no code, and both are
verified rather than assumed:**

- **D1 (scope)** — satisfied by construction: custom servers are listed beside
  Composio connections by slices 05 and 13, with separate lifecycles throughout.
- **D22 (no compat, no migrations)** — verified by inspection: no feature flag,
  no `mcpServersV2` field, no dual-read, and no compatibility layer exists
  anywhere in `apps/api/src/mcp`, `domains/mcpServers`, or the gateway's
  `mcp-servers.ts`. The plan's one named piece of transitional scaffolding
  turned out never to have been created at all.

Every other decision has an owning slice and is referenced from it.

### Still open

| ID | Open question | What unblocks it |
| --- | --- | --- |
| O1 | The byte value of D20's response cap. | Measure real server responses in slice 00. The relay budget's 300 KB is a starting point, but the model-context cap and the timeline cap are different concerns and may want different numbers. |
| O3 | Step-up authorization on a mid-turn `insufficient_scope` 403. Deferred from v1 — see [External spec conformance](#o3--step-up-authorization-is-deferred). | Slice 00 records whether the real server it targets ever challenges this way. Revisit only if one does; the fix needs a consent redirect mid-turn, which has no product surface today. |

---

## Q3 — Unknown knowns

Context the mock extracted that a direct question would not have.

- **Convex is the boundary, full stop.** Duet had two contradictory precedents
  — Composio holds its own tokens, and `connected-providers` deliberately keeps
  tokens inside the VM with no backend schema. D12 settles the general case: a
  third-party token is a row. This reshapes more than this feature; it is the
  answer for the next credential too.
- **Adding a server is the consent, and Duet does not editorialize.** D13
  rejects warning copy entirely, consistent with treating the workspace as the
  user's own machine.
- **Custom servers are not a power-user tier.** D14 puts them level with
  connecting Gmail — no owner gate, no tier gate.
- **Hermetic beats realistic for the recurring gate, but reality gets proven
  once.** D21 is the synthesis: a real server in the kill gate, our own issuer
  in the regression.
- **Two owners beat one concept.** D16 chose an independent field over
  unifying `integrations` into one list — blast-radius isolation over
  conceptual tidiness, on a wire that is already shipped.

---

## Q4 — Unknown unknowns

The sweep covered the ~24 files this task touches: the contract's `mcp` /
`integrations` / `agent` / `scopes` / `vm` modules; the gateway's
`runtime/http.ts`, `agent-sessions/coordinator.ts`, `storable-event.ts`; the
API's `composio` / `integrations` / `session-integrations` / `oauth` routes
plus `session-submission.ts` and `agent-runner.ts`; the backend's
`integrations/{model,turnConfig}.ts` and `agentSessions/delivery.ts`; the web
integrations surface and timeline projection; `packages/fake-oauth-issuer`; and
the runner's MCP client in `@duetso/agent`.

### L1 — `integrations` is one boolean gated on Composio being configured, at ten call sites → decided (D16)

**Corrected 2026-08-17 during drafting: ten sites, not nine.**

**Evidence.** `apps/api/src/session-submission.ts:83`, `routes/agent.ts:207,564,745`,
`routes/session-waits.ts:126,179,228,285`, `routes/default-session.ts:247`,
`routes/vm.ts:490` — all `projectIntegrations: options.composioMcpProvider !== undefined`.
Gateway `runtime/http.ts:1272` bails unless `launch.integrations !== undefined`.

**The tenth site is the wake path**, `apps/api/src/routes/agent.ts:81-131`, and it is
worse than the other nine: it returns an empty refresh outright when
`composioMcpProvider === undefined` (`:95-97`) and `503 integration_unavailable`
when Composio synchronization throws (`:122-131`). The gateway's wake handler
(`packages/gateway/src/agent-sessions/coordinator.ts:784-800`) strips launch fields and
swallows any error from it. So a Composio outage during an autonomous wake would take
custom servers down with it — at the one place D16's blast-radius isolation matters most.
The projection must be computed **above** the Composio branch and returned even when
Composio fails.

**Bites.** The flag means "`COMPOSIO_API_KEY` is set", not "this turn has
integrations". A workspace with three custom servers and no Composio connection
would receive no MCP servers at all — silently dead in exactly the
configuration a Composio-less deployment has.

**Changes.** The launch marker carries a server list, not a boolean. Contract
change across nine sites, plus its Convex validator twin or the syncs 500.

### L2 — An integration failure refuses the user's message outright → decided (D17)

**Evidence.** `routes/session-integrations.ts:19-39` returns `false` →
`session-submission.ts:63` returns `{ kind: 'integration_unavailable' }`; the
input is never dispatched.

**Bites.** Deliberate and correct for Composio. Catastrophic if a user-pasted
URL joins the same gate: a typo would lock the user out of their own agent.

### L3 — Nothing caps an MCP tool result before it enters the model's context → decided (D20), open value (O1)

**Evidence.** `@duetso/agent` `turn-runner/mcp.js:93-113` — no size check, and
`structuredContent` is duplicated into `details`.
`packages/gateway/src/agent-sessions/storable-event.ts` caps the timeline copy
only, by design ("the agent's own view of a result and the durable checkpoint
keep the full text either way").

**Bites.** A 4 MB response sends ~8 MB into the turn, blows the context window
and burns credits — while the timeline shows a tidy `[truncated]` marker so
nobody can see why. **This is a pre-existing hole on the Composio path too**
and should be closed at the same seam.

### L4 — `fake-oauth-issuer` speaks only device-code → resolved by D21

**Evidence.** `packages/fake-oauth-issuer/src/index.ts` — the entire route
table is `POST /device/code`, `POST /token`, `POST /chat/completions`.

**Bites.** Built for `connected-providers` device login; shares exactly one
endpoint with MCP OAuth, and not the grant type. "Extending" it means PRM
metadata, AS metadata, `/oauth/register`, `/oauth/authorize` with PKCE and a
clickable consent page, `/token` for `authorization_code`, plus a working MCP
endpoint. A slice of its own, not a closeout line item.

### L5 — DCR mints a client registration on someone else's server and nothing removes it → decided (D18)

**Evidence.** `routes/integrations.ts:85,185` — disconnect is a Composio-side
lifecycle call with no analogue for a self-registered OAuth client.

**Bites.** Same shape as a lesson already in the repo: every minted exe API key
leaves a permanent SSH-key row, so anything that mints must remove.

### L6 — Custom tools render raw in the timeline while Composio's render clean → decided (D19)

**Evidence.** `apps/web/spa/sessions/projection/index.ts:31-38` strips exactly
one prefix, `integrations__`.

**Note, corrected 2026-08-17.** Two *custom* servers cannot collide — the config
is a `Record`, so they cannot share a key. But the original claim that
collisions are impossible was wrong in two ways, both fixed by the narrowed D8:

- a server named `integrations` does not collide, it **silently displaces** the
  Composio entry;
- `_` being legal made `{server}__{tool}` ambiguous, so the decoder D19 needs
  could not be written at all.

### L7 — `mergeGatewaySessionLaunch` fail-closes exactly one field, **by name**

**Found during drafting by two independent drafters. My Q4 sweep missed
`ledger.ts` entirely — it is not in the file list above.**

**Evidence.** `packages/gateway/src/agent-sessions/ledger.ts:920-930`:

```ts
const merged = { ...existing.launch, ...input, … }
// Unlike unknown version-skewed fields, this known permission boundary is
// fail-closed: an omitted config means this launch has no integrations MCP
// server, never that it should inherit a previous turn's access.
if (input.integrations === undefined) delete merged.integrations
```

**Bites.** Everything else rides along newest-wins. A new `mcpServers` field without
the identical `delete` means a server the user removed — or whose token was revoked —
**resurrects on the next hydration or wake and stays in the envelope forever**, because
every subsequent turn re-merges it from disk. Exactly the class of bug the existing line
was written to prevent.

**Changes.** One line, plus a test that pins it. The feature is wrong without it.

### L8 — the persisted launch envelope is parsed by a hand-rolled reader that validates only four fields

**Evidence.** `packages/gateway/src/agent-sessions/ledger.ts:791-801` spreads
`...launchRecord` and re-validates only `cwd`, `tier`, `onboarding`, `mode`.

**Bites.** `mcpServers` survives a reload — which we want — but arrives at
`mcpServersForSpawn` completely untyped. Not a trust-boundary concern (one trust domain
inside the VM), but a crash class. `mcpServersForSpawn` must `safeParse` and drop on
failure rather than trust the field.

### Sharp edges — accepted, no action

- **Prompt-cache churn.** The runner sorts tools once "so the tools block is
  stable across turns for prompt caching". Adding or removing a server
  invalidates that block on the next turn of every affected session.
- **Marketplace agents cannot carry servers** — resolved by D5. An installed
  agent whose prompt references `acme_internal__*` tools simply will not have
  them, with no diagnostic beyond D10's health row.
- **Third-party content reaches an agent with Drive write and delegation.**
  D13 accepts this explicitly. Recorded as an accepted risk, not an open
  question. Note this is *outside* the VM trust boundary, so
  [SECURITY.md](../../SECURITY.md)'s one-trust-domain rule does not settle it —
  Example User did.

### Confirm before coding (slice 00 owns these)

- ~~`@modelcontextprotocol/sdk`'s `auth()` bundles for Vercel.~~ **Partially
  retired during drafting:** the SDK's `client/auth.js` was bundled with
  `apps/api`'s exact build command — 87 modules, 223 KB, only `node:crypto` and
  `node:module` external, all entry points callable under Node 24. That proves
  the *bundle*. Slice 00 leg 2 still owns proving the *flow* on a deployed
  preview.
- Streamable HTTP GET (the SSE leg) forwards correctly from a **second** route.
  Composio's works and `apps/api` builds with `VC_MAX_DURATION=800`, so this is
  confirmation, not investigation.
- `mcp-session-id` needs **per-server isolation** in the proxy — the Composio
  route forwards one; N servers means N transport identities.
- The new launch field's **Convex validator twin**. A closed `v.object` arg
  validator that misses an additive field makes syncs 500.
- **Refresh under concurrency.** Vercel runs concurrent lambdas and rotating
  refresh tokens invalidate the loser. A Convex-mutation lease is the shape;
  the fetch itself lives in an action, which is not transactional.

---

## External spec conformance

Primary source: the [MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization).
Duet is the **client** here. These are the client-side normative requirements
the spec must encode; each one is a thing that silently does not happen unless
a slice owns it.

| Requirement | Level | Who implements it |
| --- | --- | --- |
| Discovery via RFC 9728 protected-resource metadata, from the `WWW-Authenticate` challenge | MUST | SDK (`discoverOAuthProtectedResourceMetadata`) |
| Support **both** RFC 8414 and OpenID Connect Discovery for AS metadata | MUST | SDK (`discoverAuthorizationServerMetadata`) — verify OIDC leg in slice 00 |
| Obtain a client ID via CIMD, pre-registration, or DCR | MUST | Duet (D7 priority order, D24) |
| Support Client ID Metadata Documents | SHOULD | Duet (D24) — SDK exposes `clientMetadataUrl` |
| RFC 8707 `resource` parameter in **both** authorization and token requests, sent regardless of whether the AS supports it | MUST | SDK (`selectResourceURL`) — confirmed present |
| PKCE `S256` | MUST | SDK |
| **RFC 9207 `iss` validation before the code reaches the token endpoint** | MUST | **Duet (D23) — the SDK does not do this** |
| Scope selection: prefer the `scope` from the `WWW-Authenticate` challenge, else `scopes_supported` from PRM, else omit | SHOULD | Duet — the probe already reads the challenge |
| Step-up on a 403 `insufficient_scope`: re-authorize with the **union** of previously requested and newly challenged scopes | SHOULD | **Deferred — see O3** |
| Keep refresh tokens confidential in transit and storage | MUST | Duet (D12 puts them in Convex) |
| Do not assume refresh tokens will be issued | MUST | Duet — the static-token expiry story (D10) covers the no-refresh case |

Note the spec revision the SDK targets: `LATEST_PROTOCOL_VERSION = "2025-11-25"`
with `SUPPORTED_PROTOCOL_VERSIONS` back to `2024-10-07`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:2-4`).

### O3 — step-up authorization is deferred

A server may 403 with `insufficient_scope` mid-turn, asking for scopes the
stored token lacks. The spec's answer is to re-authorize with the union of old
and new scopes — which means a **user consent redirect in the middle of an
agent turn**, and there is no product surface for that. v1 surfaces the 403
through D10's health signal and asks the user to reconnect the server. Revisit
if real servers actually challenge this way; slice 00 should record whether the
one it targets does.

## Rejected alternatives

Recorded so they are not re-proposed.

- **Shelling out to a CLI** (`openclaw mcp login`, `mcp-remote`). Both assume a
  browser on the CLI's own machine; Duet's user is in a web app and the VM has
  no user-facing browser. OpenClaw's own docs concede this — its `per-requester`
  mode drops loopback and requires a public HTTPS callback origin, which for us
  is `apps/api`, the thing we would have to own anyway. `mcp-remote` is
  additionally a **stdio** proxy, and the runner has no stdio transport.
- **A pi plugin.** pi has no MCP by design — "no subagents, no plan mode, no
  approval prompts, no MCP, no governance in core". There is nothing to import.
- **Replacing Composio with direct MCP** to each provider. Considered and not
  chosen (D1); it puts every provider's OAuth on Duet.
- **Tool filtering / allowlists / a meta-tool router.** Rejected by D6.
- **VM-held tokens** (the `connected-providers` shape) and **backend-stores /
  gateway-injects**. Both rejected by D4: headers freeze at session `start`, so
  a long session outlives its access token, and neither gives a chokepoint for
  policy, health, or the D20 cap.
- **Widening `integrations` into one list.** Rejected by D16 — it rewrites a
  shipped wire contract and forces the fail-closed gate to learn per-entry
  semantics.
- **A real third-party server as the recurring staging gate.** Rejected by D21:
  the gate would break on someone else's outage or consent-page redesign.
