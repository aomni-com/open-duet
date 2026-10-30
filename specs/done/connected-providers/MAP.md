# Connected Providers — quadrant map

Walked 2026-07-23 (explore-unknowns). Feature: users link their own model
subscriptions ("Login with ChatGPT", GitHub Copilot) as **transports** for
Duet's curated model catalog. First-class duet-agent feature; duet product is
thin credential plumbing.

> **SUPERSEDED for build purposes (2026-07-23):** durable rationale now lives
> in [README.md](README.md), and the implementation is the source of truth for
> mechanics. This map remains as decision provenance.

---

## Q1 — Known knowns (territory facts, cited)

**pi-ai already ships the hard layer** (`@earendil-works/pi-ai`, in
duet-agent's tree):

- OAuth rail: `BUILT_IN_OAUTH_PROVIDERS` = `anthropic`, `github-copilot`,
  `openai-codex` behind one `OAuthProviderInterface` — `login()`,
  `refreshToken()`, `getApiKey()` (auto-refresh), `modifyModels()`
  (`dist/utils/oauth/`). Credential shape `{refresh, access, expires, …}`
  (+ `accountId` for codex).
- Codex login: `loginOpenAICodex` (PKCE, `auth.openai.com`, public client
  `app_EMoamEEZ73f0CkXaXp7hrann`, localhost:1455 callback, manual-paste
  fallback) and `loginOpenAICodexDeviceCode`; generic
  `pollOAuthDeviceCodeFlow` helper.
- Codex transport: `openai-codex-responses` provider —
  `chatgpt.com/backend-api`, WebSocket with SSE fallback, cached-context
  deltas, `chatgpt-account-id` header.
- Copilot login is **natively device-code** (`github.com/login/device/code`).
  Anthropic OAuth is paste-based, no device flow — and policy-excluded
  regardless (Anthropic prohibits third-party harness use).

**The token is not an API key.** ChatGPT OAuth tokens are valid only against
the Codex backend, never `api.openai.com` ("For general OpenAI API calls,
continue to use Platform API keys" — learn.chatgpt.com/docs/auth). Policy is
gray-but-tolerated: opencode ships ChatGPT login (Jan 2026); OpenAI's only
public statement declines to answer the ToS question (openai/codex#8338).

**duet-agent model stack** (where the feature lands):

- `src/model-resolution/resolver.ts` — provider inference from env keys;
  `PROVIDER_ORDER` = duet-gateway → vercel-ai-gateway → openrouter.
- `src/model-resolution/catalog.ts` — `MODEL_DEFINITIONS` shorthands +
  aliases + per-provider ids (`canonicalizeProviderModelId` = the mapping
  precedent); `clampModelOutputTokens`.
- `src/model-resolution/duet-gateway.ts` — `resolveMissingModel` synthesizes
  specs pi-ai hasn't shipped (the precedent for codex-serving gpt-5.6-*).
- `src/model-routing/table.ts` — `BUILT_IN_ROUTING_TABLE` (frontier /
  balanced / economy), rewritten by this feature in family shorthands.
- `src/cli/login.ts` is Duet's own device flow (do not overload);
  `src/cli/env.ts` pastes keys; RPC mode (`RPC.md`) is a per-turn
  stdin/stdout runner — connect is NOT a turn command.

**duet product side:**

- VM gateway (`packages/gateway`) owns VM-local execution; `sync-client.ts`
  already projects credentials + runs acknowledged outboxes — the connect
  round-trip rides this rail. `runner/process-runner.ts` spawns
  `duet --rpc --model <name>`.
- ~~Archive covers `driveDir` only~~ **CORRECTED:** `src/vm/archive.ts` tars
  `driveDir` AND the state dir, which is `~/.duet` (`runtime/env.ts`
  `DEFAULT_STATE_DIR`). The connected-provider credential store is durable
  workspace state and therefore rides this archive across reprovisioning;
  only its lock and incomplete atomic-write files are excluded.
- `model-gateway` is a billing/credential boundary (its README) —
  subscription traffic **bypasses it by design**; no ledger entries.
- Web: workspace settings cards (`apps/web/spa/routes/workspace-settings.tsx`).

## Q2 — Known unknowns (decision ledger — all closed)

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Scope | OAuth **rail**: `openai-codex` + `github-copilot`; anthropic policy-excluded | Example User |
| 2 | Connect topology | **B** — per-workspace login over the gateway rail; duet-agent owns the live store and refresh chain; backend schemas never model tokens; opaque state archives preserve the store | Example User |
| 3 | Surfaces | CLI `duet connect [chatgpt\|copilot]` + `--status`/`--disconnect`; product = "Connected providers" card in workspace settings | Example User |
| 4 | Provider semantics | Providers are **transports, not model sources**. Routing/pins pick the model (unchanged); transport selection prefers a connected provider that supports it, else router order | Example User |
| 5 | Fallback | Silent fallback down router order (duet-gateway → vercel → openrouter); emit a plain **TurnSystemEvent message** (no new typed event); TUI renders it | Example User |
| 6 | Cost accounting | Subscription-served calls = **$0 plan-covered** with provider marker in cost sidebar + usage events | Example User |
| 7 | Catalog | ~~Keep all 12 families~~ **Revised by Example User 2026-07-23: 11 families** — the `gpt` family is deleted (only 5.6-gen OpenAI models are curated; `gpt-5.5`/`gpt-5.4-mini` leave the catalog). Versionless family shorthands (`fable opus sonnet haiku sol terra luna kimi grok deepseek glm` → latest of family); surviving versioned shorthands remain aliases; **routing table rewritten in family names** | Example User |
| 8 | Coverage policy | Table stays model-first; transport is opportunistic (no coverage-driven pins) | Example User |
| 9 | Caveat copy | Quiet one-liner on the card | Example User |
| 10 | Audience | Hosted + standalone CLI in one spec | Example User |
| 11 | Gating | Every tier including trial | Example User |
| 12 | Done condition | Staging e2e journey incl. connect via web, against an **env-gated fake OAuth issuer**; one manual live-provider check at ship | Example User (landmine 1A) |
| 13 | Credential store | Under **`~/.duet`** (agent-owned, opaque to backend schemas, preserved by the VM state archive across reprovisioning) | Example User (landmine 2A) |
| 14 | Multi-member | Any member connects their own account; card labels "connected by X"; X or workspace owner disconnects | Example User (landmine 3A) |
| 15 | Same-VM refresh races | Advisory file lock + reread-before-refresh (multiple duet-agent processes share one store) | decide-and-inform, unobjected |

OPEN (minor): whether the session model picker gets a "Connect…" affordance
for discovery, or settings card is the only entry point. Default if unforced:
settings-only for v1.

## Q3 — Unknown knowns (extracted, and what each reshaped)

- **Curation is the product.** The model list is Duet-editorial, always the
  same regardless of connections, and will shrink. Killed the
  "subscription models appear in picker" assumption.
- **Codex sub covers gpt-5.6 sol/terra/luna** (Example User's knowledge; pi-ai's
  4-model `openai-codex` catalog entry is stale and is not source of truth).
  Flips coverage: a connected ChatGPT plan serves frontier
  implement/general, all of economy, classifier, and memory. Verify in the
  probe slice.
- **Versionless vocabulary is the wanted UX** — `opus`, `fable` as the way
  users and the router speak about models.
- **Don't invent protocol surface** — fallback notice is just a
  TurnSystemEvent message.
- **Copilot rides along, wider than expected** — its catalog serves the
  Claude families incl. `fable-5`/`opus-4.8` (spelling differs:
  `claude-opus-4.8` — mapping table required).

## Q4 — Unknown unknowns (landmine cards)

1. **E2E vs OAuth reality** — device-code needs a human + real subscription;
   staging e2e is unattended. **Decided A:** env-gated fake OAuth issuer on
   staging exercising card → backend → gateway → `duet connect` → store →
   plan-covered session; manual live check once at ship.
2. **Credential placement = custody** — backend schemas and the sync rail must
   never model or project provider tokens. **Decided A:** keep the live store
   in `~/.duet`, owned by duet-agent. Because that directory is the VM's
   archived state, the opaque archive carries the store across reprovisioning;
   it excludes only lock and incomplete atomic-write files.
3. **Members burn one member's plan** — **Decided A:** any member, labeled
   "connected by X", X/owner disconnect. Label is the consent mechanism.
4. **Sharp edge — capability probe:** free ChatGPT / Copilot-less GitHub
   logins succeed then fail on first call. Connect ends with a one-token
   probe; card can show "connected — plan not eligible".
5. **Sharp edge — codex behavior parity:** codex endpoint constrains
   instructions/`store:false`; pi-ai transport handles it in pi, but duet's
   own system prompts need one probe slice (same slice verifies
   sol/terra/luna).
6. **Sharp edge — product usage page is blind** to plan-covered calls
   (ledger fed only by model-gateway callbacks). Accepted for v1; later fix
   is an agent→backend usage event, not a ledger entry.
7. **Sharp edge — originator/client identity:** pi-ai defaults
   `originator: "pi"`. **Corrected during spec drafting:** it is hardcoded
   post-header-merge in the transport, and `earendil-works/pi` is a
   third-party repo — configurability needs an upstream PR (filed at slice
   12, non-blocking). v1 ships with `"pi"`; the fallback rail degrades
   gracefully if it is ever blocklisted.

## Facts the builder must confirm before coding

- Codex endpoint actually serves `gpt-5.6-sol/terra/luna` under a plan
  (slice 00; Example User asserts yes).
- Whether refresh rotates the refresh token (informational under topology B;
  affects nothing decided) — recorded by slice 00.
- Exact Copilot model-id spellings per family — verified from pi-ai's
  catalog during drafting (see slice 04's seed values); slice 00 confirms
  against the live account.
- Duet system prompt passes the codex transport unaltered (slice 00).
- ~~Gateway outbox round-trip latency~~ **Resolved during spec drafting:**
  connect uses the existing direct backend→gateway call path
  (`GatewayClient.fetchGateway`, precedent `pushOfficialAgentsPull` /
  `callAgent`); provider status is also read on demand through the gateway
  and is never projected onto the sync rail.
- ~~i18n via `web-locale`~~ **Corrected:** `packages/web-locale` owns locale
  persistence, not copy; card copy lives in `apps/web/messages/en/app.json`
  + `es-419/app.json` (slice 10).

## Tweakable plan (sorted by likelihood-of-tweaking)

> **Superseded** by [README.md](README.md) — kept for the record of how the
> walk sorted the work; do not build from this section.

**Judgment calls (alternatives still swappable):**
- Family shorthand set + rewritten routing table names (Q2#7) — names are
  taste; everything else survives a rename.
- Card copy + "connected by X" layout; the OPEN picker affordance.
- TurnSystemEvent message wording for fallback/plan-exhausted.

**Mechanical (trusted):**
- duet-agent: `~/.duet` OAuth store w/ file lock; `duet connect` (browser +
  device-code paths, probe call, `--status/--disconnect`); two provider
  entries + transport-preference layer + $0 accounting + fallback event;
  family shorthands + table rewrite.
- duet: gateway connect action + sync/outbox wiring; workspace-settings
  card; fake OAuth issuer; staging e2e journey.

**Suggested slice ladder** (two-repo, duet-agent first, mirrors train-files):
00 probe (codex live: models + prompt parity) → 01 credential store +
`duet connect` → 02 provider entries + transport preference + accounting +
fallback → 03 families + routing table rewrite → 04 gateway connect action →
05 web card + wiring → 06 fake issuer + staging e2e.
