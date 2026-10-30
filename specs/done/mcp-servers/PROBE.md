# Slice 00 — kill gate evidence

Run 2026-08-17. Probes were throwaway scripts outside the repo tree; this file
is their durable record.

**Verdict: GREEN, proceed.** No kill condition fired. Three findings change the
plan's shape and are folded into the slices below.

---

## Leg 1 — the shipped runner takes N servers · **GREEN**

Imported `connectMcpServers` from `@duetso/agent@0.3.12`
(`dist/src/turn-runner/mcp.js`) directly — no model, no LLM — and pointed it at
two live local MCP servers, one of which deliberately exposed a tool with the
**same name** as the other's.

```
TOOLS: ["integrations__create_ticket","integrations__search_docs",
        "probe_two__read_wiki","probe_two__search_docs"]
WARNINGS: []
```

| Assertion | Result |
| --- | --- |
| both servers registered | ✅ |
| sorted (prompt-cache stable) | ✅ |
| namespacing prevents same-name collision | ✅ |
| each tool routed to **its own** upstream | ✅ |
| no warnings | ✅ |

`execute()` on `integrations__search_docs` reached server A and
`probe_two__search_docs` reached server B, and each result carried
`details: { mcpServer, mcpTool }` naming the right origin.

**Consequence:** the firewall holds — **no `@duetso/agent` change is needed**,
so the ladder is not blocked behind a publish, a catalog bump, or an image pin.

---

## Leg 2 — SDK client mechanics · **GREEN (local half)**

`discoverOAuthServerInfo` from `@modelcontextprotocol/sdk@1.29.0` completed
against a real server and returned a fully populated metadata document.

> **Gotcha for implementers:** the returned field is
> **`authorizationServerMetadata`**, not `metadata`. Reading `info.metadata`
> yields `undefined` for every field and looks exactly like a server that
> advertises nothing. This cost a debugging cycle here; do not repeat it.

Shape: `{ authorizationServerUrl, authorizationServerMetadata, resourceMetadata }`.

**Still open:** the *deployed* half. Whether `auth()` completes a full
authorize→callback→exchange round trip **from a Vercel serverless invocation,
with a human completing consent**, is unproven — it needs a preview deploy and a
browser click. The bundle question is already retired (the SDK's `client/auth.js`
bundles under `apps/api`'s exact build command: 87 modules, 223 KB, only
`node:crypto` and `node:module` external, all entry points callable on Node 24).
Slice 09 is where the remaining risk lands.

---

## Leg 3 — what real servers actually advertise

Five servers swept. `mcp.deepwiki.com` answers `initialize` with **200 and no
challenge** — a genuine no-auth server, used for leg 4.

| | Linear | Notion | Sentry | GitHub Copilot |
| --- | --- | --- | --- | --- |
| RFC 9728 challenge + PRM | ✅ | ✅ | ✅ | ✅ |
| **CIMD supported** | **✅** | **✅** | **✅** | ❌ |
| DCR `registration_endpoint` | ✅ | ✅ | ✅ | ❌ |
| `revocation_endpoint` | = token ep | = token ep | = token ep | ❌ |
| `iss` param supported | absent | absent | absent | absent |
| PKCE methods | `S256` | `plain`,`S256` | `plain`,`S256` | `S256` |

### Finding 1 — CIMD is real today, and it is the hot path

**Every OAuth-capable server tested advertises
`client_id_metadata_document_supported: true`.** Revised D7's CIMD-first branch
is not forward-looking speculation — it is what these servers want *now*.

Consequences, folded into slice 08:

- Duet **never registers a client** on Linear, Notion, or Sentry. D18's
  orphan-registration problem does not arise for any of them.
- The DCR fallback is the **cold** path, not the hot one. Still build it — the
  tested set is not the world — but do not let it drive the design.
- Slice 11's RFC 7592 cleanup applies to **none** of
  the tested servers. It exists for the DCR fallback only.

GitHub Copilot supports neither, so **D7's refusal branch has a live example**
and is not a hypothetical.

### Finding 2 — `revocation_endpoint` equals `token_endpoint` on all three

Linear, Notion, and Sentry all advertise their **token endpoint** as their
revocation endpoint. That is very likely boilerplate rather than a working
RFC 7009 implementation.

This makes slice 11's existing rule **essential
rather than cautious**: RFC 7009 §2.2 mandates `200` for an unknown token, so a
`200` was never proof — and against these endpoints it is barely even evidence.
Attempt revocation, record the attempt, **never claim success**, and always
delete the local credential row regardless.

### Finding 3 — nobody advertises `iss`, and two accept `plain` PKCE

No server sets `authorization_response_iss_parameter_supported`, so
[D23](MAP.md)'s validation will mostly take the "absent + absent → proceed" and
"absent + present → compare anyway" rows. **Build it anyway** — the table's
compare-anyway row is exactly for servers that emit `iss` before updating their
metadata, and the spec is moving toward MUST.

Notion and Sentry accept `plain` PKCE. Duet must **force `S256`** and never
negotiate down.

**No third-party state was created.** The probe stopped short of `POST /register`
once discovery showed CIMD available — registering would have left a real client
on someone's server to test a path the tested servers do not need.

---

## Leg 4 — byte measurements · answers **O1** and **U2**

Against `mcp.deepwiki.com` (no auth required).

### U2 — framing is SSE, not JSON

**Every** response, including `initialize` and `tools/list`, came back as
`content-type: text/event-stream`. The SSE path is the **hot** path, not the
exotic one. `capMcpPayload` must parse SSE frames or the cap silently never
fires on real traffic.

### D6 — the tools block

3 tools, **1,516 bytes** total (~433 tokens); largest single tool schema 633
bytes. A small server's per-turn cost is negligible — the row's estimate matters
for the large ones.

### O1 — tool-result sizes

| tool | content | structuredContent | full result | ≈ tokens |
| --- | ---: | ---: | ---: | ---: |
| `read_wiki_structure` | 1,466 | 1,452 | 2,967 | 848 |
| `ask_question` | 4,468 | 4,454 | 8,971 | 2,563 |
| **`read_wiki_contents`** | **688,313** | **688,299** | **1,376,661** | **~393,000** |

**The cap is not decorative.** One ordinary call on a public server returns
**1.3 MB** — enough to blow any context window, burn a fortune in credits, and
exceed Convex's 1 MiB document limit on the way through.

**The server duplicates its own payload.** `structuredContent` is a near-exact
copy of `content` (688,299 vs 688,313 bytes). This is the *server* duplicating,
not the runner. It confirms slice 03's cap order:
dropping `structuredContent` first halves an oversized result at **zero
information cost**.

**O1 resolved: `128 * 1024` stands.** Legitimate results clustered at 3–9 KB;
the outlier was 1.3 MB. 128 KiB sits far above every real result measured and far
below the disaster case, and stays under the 300 KB relay budget as the README's
ordering invariant requires. No reason to raise it to the 256 KiB ceiling.

---

## Incidental — the staging fake-issuer host has no deployment

Checked while resolving slice 14's discovery-path
decision. `DUET_CONNECT_FAKE_ISSUER_URL` points at
`https://service.example.invalid`, which is a **root host**, so
hosting the MCP-OAuth fixture there would have made the SDK's normal root
discovery work. But:

```
POST https://service.example.invalid/device/code
HTTP/2 404
x-vercel-error: DEPLOYMENT_NOT_FOUND
```

The domain is aliased in Vercel with **no deployment assigned**. Slice 14
therefore keeps the path mount and serves OIDC-shaped metadata.

**Beyond this feature:** that same host is what
`packages/test-harness/src/staging-e2e-synthetic` requires, so the
**`connected-providers` staging journey cannot currently pass**. Not this spec's
to fix and not blocking any slice here — reported so it is not rediscovered as a
mystery failure later.

### O3 — step-up authorization

No server returned a 403 `insufficient_scope` during discovery. Nothing observed
justifies building step-up in v1; **O3 stays deferred.**
