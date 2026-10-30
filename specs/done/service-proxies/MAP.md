# Service proxies + coupled default skills — quadrant map

Walked 2026-07-16 (explore-unknowns). Reference codebase: chat-app at
`~/dev/chat-app`.

> **SUPERSEDED FOR BUILDING: the spec is materialized.** Implement from
> [`README.md`](README.md) + [`slices/`](slices/) (written 2026-07-16 by
> write-spec, synthesized from four independent drafts). This map remains
> the rationale record — quadrants, landmine evidence, audit findings —
> but its "Tweakable build plan", "Builder must-confirm list", and
> kickoff prompt are folded into the spec (must-confirms became probes
> P1–P5). Where map sketch and spec differ, the spec wins. Draft-recon
> corrections folded into the spec: `{{APP_URL}}` renders per-workspace
> today (cache fix must make it origin-bare); `COMPOSIO_API_KEY` is
> apps/api-only (mint can't live in Convex); fleet recreate needs a VM
> image build (`packages/vm-image/`); installed agent accepts http-only
> MCP configs; skills address the proxy via `$DUET_API_URL`, not
> `{{APP_URL}}`.

North star (D's words): **"do it the exact same way chat-app does it"** —
deviate only where duet's stack forces a translation, and every forced
translation is recorded here.

---

## Q1 — Known knowns (settled ground)

### The reference implementation (chat-app)

- The entire proxy surface is **one catch-all route + one config table**:
  `apps/web/app/api/v1/services/[service]/[...path]/route.ts` +
  `services/config.ts`. Adding a service = one config entry (baseUrl,
  upstream-key env var, auth-header shape, pricing, optional pathBlacklist).
- Per-request flow: bearer `DUET_API_KEY` auth → org derived server-side from
  token (never trusted from caller) → servicing-status gate (402) → credit
  preflight (402) → per-sandbox rate limit 60/600 rpm (429) → strip caller
  auth headers, inject upstream key, forward verbatim → stream response →
  meter after response (Next `after()`) via idempotent ledger reference.
- Six services live: crustdata, fullenrich, dataforseo, elevenlabs (all flat
  50,000 µUSD/2xx), socialapi (flat), firecrawl (variable:
  $0.005/credit ~6× margin, async crawl/extract charges deferred to the
  terminal poll with deterministic reference, browser sessions $0.002/sec,
  4xx free). `pathBlacklist` hides vendor credit-balance endpoints.
- Composio is **not** in the catch-all: bespoke
  `POST /api/v1/composio/execute/{toolSlug}` (raw fetch to
  `backend.composio.dev/api/v3/tools/execute/{slug}`, `x-api-key` injection,
  `entity_id` = org id injected server-side, **unmetered**), plus a per-org
  Composio **Tool Router session** whose `.mcp` URL is fed to agents at
  session start (`agent-gateway/src/session-controller.ts:1314-1339`) —
  fresh mint per agent session, no cache/expiry/teardown, errors swallowed.
  `manageConnections` enables mid-turn OAuth via a server callback route
  (`convex/routes/oauth.ts`, pure redirect).
- The `packages/services/src/*` SDK clients cited in README.md are
  backend-internal, not the proxy — useful only as upstream API contract
  docs.

### What duet already has (build-on surface)

- **Skills rail — done**: `packages/skills-registry` → per-workspace bundle →
  `GET /v1/vm/skills/:hash` (`apps/api/src/routes/vm.ts:318-336`) →
  `packages/gateway/src/skills-install.ts` (sha256-verified, atomic symlink
  swap). 12 default skills shipped.
- **Billing machinery — done**: model-gateway
  (`apps/model-gateway/src/index.ts`) does preflight → inject upstream key →
  forward → `waitUntil` post-response settle against the credits ledger.
  Ledger is reference-deduped with settle-exactly-once pinned by tests
  (`packages/backend/src/credits.test.ts`, `model-gateway.test.ts`).
- **Agent credential — done**: gateway seeds `DUET_API_KEY` +
  `DUET_GATEWAY_BASE_URL` at runner spawn
  (`packages/gateway/src/model-credentials.ts:41-48`).
- **Runner-side MCP — done**: `@duetso/agent`'s turn-runner implements
  `ensureMcpServersConnected(command.mcpServers)`; tools surface as
  `<server>__<tool>`. Gateway-side `mcpServers` field declared but dormant
  (`packages/gateway/src/runner/protocol.ts:8`).
- **Durable keys for deployed apps — done**: `issueUserKey`
  (`packages/backend/convex/domains/apiKeys/userKeys.ts:15`) mints
  workspace-scoped user keys with optional (= no) expiry.
- **Composio provider — partial**: `apps/api/src/providers/composio.ts` +
  `/v1/ws/:slug/integrations/{catalog,connect,connections,use}` routes;
  never reads `session.mcp`.
- `FIRECRAWL_API_KEY` already in `scripts/secret-topology.mjs` (api+lander).
- apps/api already runs at **800s max duration** via `VC_MAX_DURATION` in
  `apps/api/vercel.json:4`.

---

## Q2 — Known unknowns (decision ledger)

| # | Question | Answer | Closed by |
|---|---|---|---|
| Q1 | v1 roster / slicing | Claude's call; firecrawl end-to-end first; **everything** ships by the end | user |
| Q2 | Composio shape | Chat-app's decomposition verbatim: `/v1/composio/execute/{slug}` for deployed apps (server injects workspace identity), Tool Router MCP for agents | user |
| Q3 | Pricing | Clone chat-app verbatim (flat $0.05/2xx; firecrawl variable; composio execute unmetered) | user |
| Q4 | Existing integrations routes | UI routes (catalog/connect/connections) stay; `use` → `execute` hard cutover (no-backward-compat) | user |
| Q5 | Roster | All six: firecrawl, crustdata, fullenrich, dataforseo, elevenlabs, socialapi | user ("exact same way") |
| Q6 | Vendor keys | Copy from chat-app's env into `secret-topology.mjs` | settled-unless-objection |
| Q7 | Durable key for deployed apps | Already exists (`issueUserKey`) — skill docs point at it | territory |
| Q8 | Runner MCP support | Already shipped in `@duetso/agent` | territory |
| OPEN-1 | Connected-toolkit slugs in system prompt | **OPEN — deferred.** Duet has no server-side prompt seam (chat-app's is a Convex action; duet's prompt lives in the out-of-repo `duet` CLI). MCP tool listing makes tools discoverable without it. Unblocks: a prompt-append seam in the runner protocol, if ever wanted. | — |

## Q3 — Unknown knowns (extracted context)

- **Taste**: chat-app is settled precedent, not a suggestion. Translations
  only where forced (see fidelity table). No redesign, no "improvements".
- **Done-condition**: **live** — each of the four skills exercised in a
  staging VM against real vendors (real credits) before the spec closes.
  Code + tests + rail delivery is not done.
- **Existing direct Firecrawl callers** (apps/api train scraper, lander
  growth brief) stay direct — do NOT route them through the proxy.
- **Consumers**: VM agents (via seeded `DUET_API_KEY`) and standalone
  deployed apps (via durable user keys). Web UI keeps its REST
  connect/OAuth flow.
- **Out of scope** (unchanged from README): `duet`, `kanban` (product
  surface), `crm` (`crm.cli` equivalent), `cron` (gateway cron mechanism).

### Port-fidelity table (every forced translation)

| Chat-app piece | Duet translation |
|---|---|
| Next.js catch-all in apps/web | Hono wildcard `/v1/services/:service/*` in **apps/api** |
| `export const maxDuration = 800` | Dead idiom on duet's bun-bundle rail — cap already set via `VC_MAX_DURATION` in `apps/api/vercel.json` (Card L7) |
| Stable sandbox gateway token → org | 24h VM model credential → workspace; billed wallet = workspace's `billingUserId` (Cards L5, L6) |
| Next `after()` billing | `waitUntil` from `@vercel/functions` (new dep in apps/api) + injectable fallback, as model-gateway does |
| `@convex-dev/rate-limiter` token bucket 60/600 rpm | Port semantics onto homegrown `consumeFixedWindow` + new schema table (Card L8) |
| `{{APP_URL}}` etc. codegen | skills-registry renderer — `{{APP_URL}}` is the ONLY placeholder; anything else throws (Card L9) |
| Composio SDK 0.6.11 | 0.13.1 — `sessions.create(userId, { mcp: true, ... })`; `.mcp` is opt-in (Card L2) |
| Convex-action prompt injection of connected toolkits | No seam exists — OPEN-1, deferred |

---

## Q4 — Unknown unknowns (landmine cards, worst first)

**L1 — `.strict()` sync schema vs old gateways.** `VmSyncResponseSchema`
was `.strict()` and the gateway `.parse`s it (`sync-client.ts`); an
unknown key throws → sync stalls → error backoff, including self-update.
Slice 06's redesign avoided adding a sync field, so this seemed moot — but
during the slice-07 live pass it turned out the **existing `skills` field
(prior feature) had already bricked the staging VM's old gateway** the
same way. **RESOLVED by slice 08**: the consumer now `.strip()`s unknown
fields and salvages `gatewayRelease` from a minimal envelope even when the
full response won't validate, so no future response-shape change can brick
a gateway that can parse today's response. Already-stuck gateways were
recovered via the one-time `unblock-staging-vm.sh` roll-forward. The
user's "destroy and recreate the fleet" authorization stands for any
genuinely breaking change, but is no longer needed for additive fields.

**L2 — Composio SDK drift 0.6.11 → 0.13.1.** Chat-app's `session.mcp` after
plain `create()` doesn't compile on 0.13 (`SessionWithoutMcp`); MCP is
opt-in. **Decided**: `composio.sessions.create(workspaceId, { mcp: true,
manageConnections: {...} })`; MCP config shape itself unchanged
(`{type:'http'|'sse', url, headers}`). Session lifecycle mirrors chat-app:
fresh mint per agent session, no cache, errors → skill degrades silently.
Duet's 0.13.1 is the newest published version as of 2026-07-16 (npm
checked) — user wants the package current; re-verify latest at build time
and bump if newer.

**L3 — OAuth callback gap.** Duet's `allowedRedirect`
(`apps/api/src/routes/integrations.ts:175-191`) pins redirects to the
integrations page and strips query params; chat-app's mid-turn
`manageConnections` needs a server callback carrying context params.
**Decided**: new server-side callback route in apps/api mirroring chat-app's
`routes/oauth.ts` (pure redirect), used by both `authorize` and
`manageConnections`.

**L4 — Two execute paths would coexist.** Duet's `/integrations/use` is
SDK-based, connection-gated (409), metered-at-$0; chat-app's
`/composio/execute/{slug}` is raw REST, not connection-gated, unmetered.
**Decided** (Q2+Q4, reaffirmed by user 2026-07-16 "delete unused
/integration route"): chat-app contract wins; `use` deleted in the composio
slice; `execute` injects `entity_id` = workspaceId server-side; unmetered
(pricing parity). Correction to "unused": `use` has three live callers —
web SPA invoke surface (`apps/web/spa/routes/integrations.tsx:78` →
`client.ts useIntegration`), apps/mcp `use_integration` tool
(`apps/mcp/src/tools/integrations.ts:18`, capability `integrations.use`),
and tests. Cutover plan: delete the SPA invoke surface, **repoint
`use_integration` at the `execute` contract** (duet product surface, no
chat-app equivalent — external claude.ai connectors use it), migrate
tests. Hard cutover, no compat shim.

**L5 — Ledger reference semantics.** Dedupe is an app-level lookup on
`(billingUserId, reference)`; duplicate = silent `{applied:false}`
success-shaped no-op (`credits/ledger.ts:31-58`); wallet is per-user,
shared across that user's workspaces. **Sharp edge**: references must embed
the upstream call id (globally unique), flat vs deferred-settle references
must differ, and callers must check `applied` (the integrations route
doesn't — don't copy that).

**L6 — $1 floor, negatives allowed, deferred settles unprotected.** Preflight
blocks at balance ≤ $1.00 (`HARD_BLOCK_FLOOR_MICRO_USD`); charges never
clamp — deferred firecrawl settles can overdraw (pinned by
`credits.test.ts:235-236`). Chat-app behaves the same. **Decided**: accept;
no reservations for proxy calls.

**L7 — Vercel platform traps in apps/api.** Per-route `maxDuration`/`config`
exports are dead (bundle rail reads only `VC_MAX_DURATION`,
`scripts/vercel-bundle.mjs:45-56`) — already 800s, one cap for ALL apps/api
routes. `@vercel/functions` not yet a dep of apps/api — add it for
`waitUntil`, injectable for tests. Model-gateway's JSON path
buffer-inspects request bodies — for pass-through use `requestBody`/
`duplexFor` + the contract's stripped-header sets
(`packages/contract/src/http/index.ts:3-9`, `gateway/index.ts:13-26`)
directly. Auth middleware already wraps `/v1/*` and is body-safe; keep the
proxy authed (no bypass entry), budget one Convex round-trip TTFB.

**L8 — No rate-limiter component.** `@convex-dev/rate-limiter` isn't
installed; duet's pattern is `consumeFixedWindow` + a schema table
(`domains/shared/fixedWindowRateLimit.ts`, cf. `workspaceRateLimits`).
**Decided**: port chat-app's 60 rpm free / 600 rpm paid semantics onto a
fixed window keyed per workspace.

**L9 — Skills renderer throws on unknown placeholders**, and the throw
propagates through `WorkspaceSkillsBundles.forWorkspace` into the sync
response — one bad placeholder breaks the workspace's ENTIRE VM sync
(`render.ts:27-32`, `vm.ts:347-358`). **Sharp edge**: audit every ported
skill; only `{{APP_URL}}` survives; chat-app's `{{GATEWAY_PORT}}`/
`{{ORG_SLUG}}`/`{{AVAILABLE_MODELS}}` must be rewritten or dropped.

**L10 — Env + MCP config freeze at runner spawn, per-session.** Runner
spawns once per session; env and `start`-frame `mcpServers` never refresh
(`process-runner.ts:284-296,341-347`). VM model keys expire at 24h (refresh
window 2h) with no expiry check on read. Sessions outliving the key 401
mid-turn — **pre-existing** for model calls; proxies inherit it, add
nothing new. Mid-session Composio connects reach the agent on next session.
**Sharp edge, accepted.**

**L11 — Error envelope split.** apps/api's 401 `{error:'unauthorized'}` and
integrations' 402 `ledger_preflight_blocked` diverge from the gateway
contract's typed blocks (`packages/contract/src/gateway/index.ts:43-127`:
`insufficient_credits`, `monthly_cap`, `subscription_inactive`,
`payment_required`, `rate_limited`+retryAfterSeconds). **Decided**: proxy
speaks the gateway block contract; route through
`requirePreflightedSpendWorkspace`-equivalent semantics (servicing gate +
preflight) but with gateway-shaped bodies.

**L12 — Beyond-feature finding: unbounded skills-bundle cache.**
`WorkspaceSkillsBundles` pins full bundle bytes+object per workspace
forever (`vm.ts:339-360`); bundles differ only by `appUrl`. Corpus ~1 MB
today; this feature roughly doubles it (go-to-market alone is 30+ files).
**Decided**: fix in-spec — key the cache by rendered `appUrl` (or bound
it), since every workspace on the same appUrl yields identical bytes.

**L13 — Spec contention.** `specs/write-containment` plans a Landlock
spawn-wrapper in the same `process-runner.ts` spawn path (env seeding must
survive it); `specs/done/vm-telemetry-history` extends the same strict sync
schemas (compat side mooted by L1's fleet recreate; merge-conflict side
remains). **Sharp edge**: whichever lands second rebases; nothing here
blocks.

**L14 — Deployed-VM runner version.** Runner MCP support is confirmed in the
repo's installed `@duetso/agent`, but the VM image's `duet` CLI version
must actually include it. **Builder must confirm live** before the composio
slice.

**L15 — Tool Router MCP headers ARE the org key (found live, wave-0
probe P2, 2026-07-16).** `composio.sessions.create(ws, {mcp:true})` on
0.13.1 returns `mcp.headers['x-api-key']` byte-identical to
`COMPOSIO_API_KEY` (verified), and the MCP URL 401s without it. Chat-app
delivers `session.mcp` headers into sandbox runners — i.e. chat-app leaks
its org Composio key to every sandbox (flagged to Example User to check on the
chat-app side). **Decided**: duet does NOT port that design. Slice 06
redesigned as an MCP passthrough proxy (`/v1/composio/mcp`, duet-key
auth, server-side `x-api-key` injection, per-workspace TTL session
cache); the gateway composes the runner's mcpServers config locally from
`DUET_API_URL` + its own credentials. Cascade: no sync-schema change →
L1's fleet destroy/recreate and slice 07's VM image rebuild are no longer
needed (the user's recreate authorization stands but has nothing to apply
to); vm-telemetry-history contention narrows to nothing.

**Prior art**: none — no previous attempt at `/v1/services/*` (git log
clean); Firecrawl exists only as direct integrations (train scraper,
lander) which stay as-is.

---

## API-surface audit (unprimed subagent, 2026-07-16 — all adopted)

1. **Block-marker header**: every duet-originated non-2xx gets
   `x-duet-gateway: block` + `x-duet-gateway-code: <code>`; absence means
   the error is the vendor's, streamed verbatim. Also stamped by
   model-gateway — one owner for the convention. Without this, callers
   can't tell duet's 402/429 from the vendor's.
2. **One error vocabulary**: extend `GatewayBlockSchema` with
   `service_not_found` (404, unknown `:service`) and `service_unavailable`
   (503, upstream key unconfigured); retire `ledger_preflight_blocked` —
   the proxy and integrations paths emit `insufficient_credits`/
   `monthly_cap` shapes like the model gateway. `pathBlacklist` 404 stays
   deliberately bodyless (camouflage).
3. **Workspace ambiguity**: `/v1/services/*` and `/v1/composio/execute/*`
   are single-workspace-key surfaces; a multi-workspace durable key is
   rejected with coded 403 `workspace_ambiguous` instead of silently
   picking a workspace to bill / use as Composio `entity_id`.
4. **`x-api-key` accepted**: the `/v1/*` middleware currently constructs
   headers with only `authorization` (index.ts:107-110) though the
   extractor already supports `x-api-key` — pass it through, so
   native-header SDKs (ElevenLabs `xi-api-key` aside) work drop-in.
   `Authorization: Bearer` stays canonical. The catalog service proxy is
   query-transparent: vendor query parameters are forwarded unchanged, while
   vendor credential injection remains defined by each catalog auth scheme.
5. **Typed `mcp` sync field**: strict zod shape (server name →
   `{url, headers?}`), field named `mcpServers` end-to-end (sync response
   and runner start frame), `integrations__` tool prefix exported as one
   constant.
6. **OAuth callback hardening**: the callback is the one intentional
   unauthenticated route — trust Composio's signed state/duet nonce, never
   reflected query params; final redirect through the existing
   `allowedRedirect` allowlist; params use workspace vocabulary, not
   chat-app's `organizationId`/`channelId`.
7. **`use_integration` repoint is a rewrite**: the old
   `IntegrationActionResponseSchema` envelope (upstreamCallId,
   costs, balance) disappears — execute returns Composio's raw shape.
   Proxy echoes `x-duet-request-id` for correlation; builder verifies
   nothing reads the old envelope fields.
8. **Composio as third idiom** — accepted and documented as such
   (wrapped body, identity injection, unmetered); not to be confused with
   the transparent `:service/*` passthrough.

Audit endorsed as keep-as-is: verbatim passthrough primitive, post-response
`waitUntil` billing + deterministic references, server-side key injection +
auth stripping, blacklist camouflage, 503 semantics, actionable block
bodies, key-derived workspace for VM credentials.

## Builder must-confirm list (before coding the relevant slice)

1. VM image's `duet` CLI honors `mcpServers` in the `start` frame (L14) —
   verify on a staging VM via SSH before the composio slice.
1b. After the sync-contract `mcp` field lands: **destroy and recreate the
   VM fleet** (L1) — do not stage the rollout.
1c. Re-check npm for a newer `@composio/core` than 0.13.1 and bump if so
   (L2).
2. Copy catalog vendor keys from the encrypted dotenv source into the Convex
   service vault for each target deployment with `bun run service:vault put`:
   `CRUSTDATA_API_KEY`, `FULLENRICH_API_KEY`, `DATAFORSEO_BASE64_PASSWORD`,
   `ELEVENLABS_API_KEY`, and `SOCIALAPI_API_KEY`. Keep them source-only in
   deployment topology; `FIRECRAWL_API_KEY` remains in API and lander envs for
   the direct callers that still need it.
3. Audit ported skill text for non-`{{APP_URL}}` placeholders (L9).
4. Confirm chat-app's current `SERVICE_PROXY_CONFIG` at port time (pricing
   numbers, blacklists) — this map snapshots 2026-07-16.

## Tweakable build plan (sorted by likelihood-of-tweaking)

**Judgment calls (tweak here):**

1. **Slice order** — (1) firecrawl proxy end-to-end: catch-all route +
   config table + billing + rate limit + skill + live staging exercise;
   (2) flat services as config entries (crustdata, fullenrich, dataforseo,
   elevenlabs, socialapi) + `go-to-market` + `branded-content` skills;
   (3) composio: `execute` route (+ delete `use`), MCP through sync →
   gateway → runner (L1 rollout order), OAuth callback, +
   `composio-credentials` skill; (4) live verification pass on all four
   skills. Alternative: composio before flat services if MCP is hotter.
2. **Cache fix scope** (L12) — in-spec appUrl-keyed cache vs. defer to its
   own change.
3. **OPEN-1** — connected-toolkit prompt injection stays deferred unless a
   prompt seam materializes.

**Mechanical (trust-you-on-this):** config-table port with per-service
entries and firecrawl's charge calculator; reuse contract header-strip sets
+ `requestBody`/`duplexFor`; gateway-shaped error bodies; ledger references
`service:<svc>:<uuid>` / `service:firecrawl:crawl:<id>:final`; secret
topology adds; skills ported with `{{APP_URL}}` rendering; sync-contract
`mcp` field mirroring the `skills` field pattern; MCP store in gateway
mirroring `createModelCredentialStore`.
