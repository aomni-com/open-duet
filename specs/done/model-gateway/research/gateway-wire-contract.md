# Model-gateway wire contract

Status: frozen contract record for `service.example.invalid`, verified against
`@duetso/agent@0.1.202` source (`/Users/synthetic-user/dev/duet-agent`, read-only) and
chat-app's production proxy (`/Users/synthetic-user/dev/chat-app`, read-only) on
2026-07-07. Duet's gateway serves this contract; the agent is a client, not a
negotiator. Sibling of `specs/done/agent-drive/research/agent-cli-contract.md`.

> **Shipped deviations (recorded at close, 2026-07-10):** the shipped proxy
> additionally refuses `/v1/generation` locally
> (`LOCALLY_BLOCKED_UPSTREAM_PATHS`, `apps/model-gateway/src/index.ts`) — the
> gateway polls generations server-side for reconcile, so clients never read
> cost data through the passthrough. The agent release this doc anticipated
> has shipped: the repo pins `@duetso/agent@0.2.0` with
> `DUET_GATEWAY_BASE_URL` support.

## Shared rules

- Base URL: `https://service.example.invalid`, no path prefix. The agent treats it as a
  provider origin and appends SDK-owned paths; the gateway is a catch-all
  path+query passthrough to `https://ai-gateway.vercel.sh`.
- Credential: a `duet_sk_` API key. The gateway accepts it as
  `Authorization: Bearer <key>` OR `x-api-key: <key>` — both forms are
  mandatory because the SDKs choose, not the caller (see below). Vercel
  `vck_` keys are rejected (401), never forwarded.
- The caller's auth headers are stripped before forwarding; upstream gets
  `Authorization: Bearer ${AI_GATEWAY_API_KEY}` (platform key) plus
  `http-referer: https://service.example.invalid` and `x-title: Duet`.
- SSE streams pass through verbatim. Response headers `content-encoding`,
  `content-length`, `transfer-encoding` are stripped (Node fetch may
  auto-decompress while keeping stale headers).
- `GET/POST /v1/credits` is refused (403, `endpoint_not_available`) — it would
  expose the platform's upstream Vercel credit pool.

## Path families the agent actually sends

All wire shapes below are owned by SDKs embedded in pi-ai / the AI SDK; the
agent only swaps the base URL. Verified in duet-agent source and node_modules.

| Traffic                                                      | Path                        | Auth header | Client                                                                                                   |
| ------------------------------------------------------------ | --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| Anthropic + gateway-catalog chat (all non-`openai/*` models) | `POST /v1/messages`         | `x-api-key` | Anthropic SDK inside pi-ai (`providers/anthropic.js:661`; SDK appends `/v1/messages`, sends `x-api-key`) |
| OpenAI responses models (`openai/*`)                         | `POST /v1/responses`        | `Bearer`    | OpenAI SDK, agent-supplied `<base>/v1` (`duet-gateway.ts:139-144`)                                       |
| OpenAI completions models                                    | `POST /v1/chat/completions` | `Bearer`    | OpenAI SDK, same base                                                                                    |
| `duet model` + duetfs/MCP media (post-fold)                  | `/v4/ai/*`                  | `Bearer`    | `@ai-sdk/gateway` `createGateway({ baseURL: <base>/v4/ai })` (`cli/model-gateway.ts:43`)                 |
| Model catalog                                                | `GET /v1/models`            | `Bearer`    | plain fetch (`cli/model-gateway.ts:56`)                                                                  |

All five families are launch-required: the demo path uses the first three;
duetfs/MCP (after the bespoke-route fold) and `duet model` use the last two.

## Agent-side coordination (separate repo; Duet adapts to the release)

- duet-agent replaces `${DUET_APP_BASE_URL}/api/v1/ai-gateway` with a dedicated
  gateway-base env var (`duet-gateway.ts:4,26` today). `DUET_APP_BASE_URL`
  cannot be reused — it also drives login, skill-sync, embeddings, analytics,
  feedback (`duet-app-url.ts`, `login.ts:55`, `sync-skills.ts:64`).
- `DUET_API_KEY` remains the credential env. Both env vars are injected
  per-spawn by the in-VM gateway runner, not by VM create-time env.
- Until the agent release ships, the old compiled-in path exists only in old
  agent versions; the gateway serves only the bare-path contract above. No
  compatibility mount for `/api/v1/ai-gateway/*`.

## Billing-relevant response facts

- Cost is NEVER in the proxied response. The gateway learns an upstream
  generation id and reconciles cost later against upstream
  `GET /v1/generation?id=<generationId>` (`data.total_cost`), backoff
  [15s, 30s, 60s, 120s]; 404/429/5xx or missing `total_cost` = not ready.
- Generation-id extraction (port of chat-app `extract-generation-id.ts`):
  JSON bodies → `generationId` field (AI SDK protocol's native tag, incl.
  providerMetadata entries); SSE → scan first 16KB for `"generationId"` or a
  top-level `"id":"gen_..."`. Vercel tags Anthropic `message_start`
  `message.id` with a `gen_` id, so `/v1/messages` traffic reconciles too
  (regression-tested in chat-app `extract-generation-id.test.ts`).

## Error contract toward the agent

- 401: missing/invalid/expired key (chat-app envelope shapes).
- 402 `ledger_preflight_blocked` equivalents, chat-app bodies:
  `insufficient_credits | monthly_cap` (+ `balanceMicroUsd`,
  `autoTopupScheduled`, `billingUrl`), and servicing-status bodies
  `subscription_inactive` (paused/canceled) / `payment_required` (banned).
- 403 `endpoint_not_available` for blocked upstream paths;
  `insufficient_scope` for a key without `ws:{slug}:ai`.
- 429 for the per-workspace rate limit.
- pi-ai surfaces all of these to the agent as plain provider API errors; no
  agent-side handling is assumed beyond display/retry.

## Deleted assumptions (do not build against these)

- No `/api/v1/ai-gateway` path prefix anywhere on the new host.
- No `vck_` passthrough; no per-request upstream key selection.
- No synchronous `actualCostMicroUsd` in any upstream response — the bespoke
  `realAiGatewayUpstream` shape (`POST /v1/generate`) was fictional and is
  deleted with the fold.
- No workspace-in-path (`/v1/ws/:slug/ai/*`) on the gateway: the billing
  workspace is resolved from the key (one key ↔ one workspace invariant).
- No language-model path classification (`LANGUAGE_MODEL_PATH_SUFFIXES`): it
  was chat-app's unpaid-org abuse heuristic; Duet attaches no policy to paths.
