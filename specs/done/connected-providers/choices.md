# Choices ledger — connected-providers (CONSOLIDATED, final)

Re-audited against shipped code (agent v0.3.1 + duet staging `7ab8b9fc`).
Grouped by verdict, least-confident first. Every entry is standalone.

## Yours to confirm (least confident first)

1. **Copilot "connected by" label falls back to email** when the user has
   no display name — live behavior everywhere attribution shows. Fine, or
   want a nicer fallback?
2. **`lastMessageUsage` keeps raw provider pricing on plan-covered turns**
   (turn totals zero; the per-message datum shows the would-have-been
   cost). Only visible in the wire envelope today.
3. **Plan-ineligible rows still offer "Reconnect"** (recovery = different/
   upgraded account) and warn/error states share one amber treatment —
   quiet-register calls from the critique, accepted for v1.
4. **Hosted fake issuer uses time-based approval + signed stateless
   grants** (11c) — journey timing tolerates an approval window instead of
   poll counts.

## Sound (verified against shipped code)

- **Lock module lives at `src/file-lock.ts`**, not inside
  `connected-providers/` — auto-upgrade shares it; a shared owner beats a
  nested one. (slice 01, codex; kept at integration)
- **Store layout:** one `~/.duet/connected-providers.json` `{version:1,
  connections:{[provider]:record}}`; `.lock` sibling; UUID tmp files; JSON
  status envelope `{connections:[...]}`; stale-lock TTL 10 min + mtime
  fallback for unreadable payloads (review fix). (slice 01)
- **Unreadable lock files go stale by mtime, never instantly** — reclaiming
  mid-write would let two writers race. (integration fix after review P1)
- **Capability probe:** only HTTP 402 (thrown or stopReason-error path) may
  mark `plan_ineligible` besides copilot's empty `availableModelIds`;
  transient failures stay `unknown`. (review-driven, regression-tested)
- **`--no-browser` only suppresses URL auto-open**; device-code mode is
  forced by `--device-code`, `--json`, or non-interactive stdin. (review P2)
- **Codex refresh is duet-agent-owned** (pi-ai omits the required `scope`
  param and 401s — PROBE.md); refresh tokens rotate and persist wholesale.
- **Deterministic connected preference:** `openai-codex` before
  `github-copilot`. (slice 05)
- **Sync `resolveProviderApiKey` kept** via in-process token cache +
  `ensureFreshConnectedTokens()` at turn start; mid-turn cache miss falls to
  router for that call while refreshing in background. (slice 05)
- **Copilot `modifyModels` hook applied at coverage check AND spec
  resolution** (Enterprise baseUrl + account filtering); an explicit pin
  keeps the static spec when filtered — runtime fallback owns the outcome.
  (branch-review P1 fix)
- **Router order skips unconfigured routers** (`configuredRouters` on the
  transport snapshot) so fallback never lands on a backend that cannot
  authenticate. (slice 06 review P1 + branch-review passthrough fix)
- **Legacy persisted sessions:** pre-`transport` usageByModel snapshots are
  discarded at hydration (existing `lastMessageUsage` guard precedent) —
  fail-safe hydration, not a compat layer. (branch review P1)
- **Fallback wording:** "ChatGPT plan limit hit for … — continuing on Duet
  credits." (slice 06, delegated taste)
- **openrouter memory fallback:** ~~`haiku-4.5`~~ REVERSED by Example User
  post-close (2026-07-24): memory is always luna. OpenRouter serves
  `openai/gpt-5.6-luna`; pi-ai's catalog just lags, so duet-agent adds a
  manual clone route (`MISSING_MODEL_CLONES.openrouter` in
  `duet-gateway.ts`) and `MEMORY_MODEL_BY_PROVIDER.openrouter` stays on
  the default luna memory model. Landed in duet-agent commits
  `518cec8` + `fcca9d8` (unreleased; rides the next agent release).
- **NDJSON test assertion is serializer-independent** (parsed events +
  redaction + empty stderr) — inline snapshots differ between local and
  Docker bun. (integration)

## Provisional (user may want to revisit)

- **`lastMessageUsage` keeps raw provider pricing** on plan-covered turns
  (turn accounting zeroes; the last-message datum shows what the message
  would have cost). Visible only in the wire envelope, not the sidebar
  total. Revisit if it ever surfaces in UI as a "cost".
- **Live-store seeding for the smoke test** wrote the v1 store format
  directly from probe credentials (no import command exists). Example User's
  machine now has a real connected ChatGPT in `~/.duet/connected-providers.json`.

- **Pending-connector attribution** (whole-branch review): connect start
  persists the initiating actor; completion and VM observation consume it —
  a lost terminal poll can no longer attribute a connection to the
  workspace owner. (review-driven, regression-tested)
- **Staging legs self-skip contract**: `DUET_CONNECT_FAKE_ISSUER_URL`
  optional until slice 11b; absent → legs excluded from the required gate
  and validation skipped, loud skip artifact recorded. (review-driven)

## Late provisional calls (fleet-incident window, 2026-07-23)

- **Staging VM image rebuild started under standing authority, then Example User
  ratified and expanded** ("publish to prod as well"): image rebuilt from
  latest staging, boot-verified, pushed; staging AND production
  DUET_VM_IMAGE_REF pinned to digest 26576e20d582. Prod promotion was
  explicit instruction, not inference.
- **Sync-request contract doctrine flipped at Example User's direction**: requests
  strip unknown keys (client-side self-validation owns drift-catching);
  unparseable-but-authenticated senders receive a 200 rescue envelope
  (gateway release only) instead of 400 — "bad request = sender needs the
  update". Legacy-shape + coercion regression tests pin the image floor.
- **E2E ownership handed to another session** (Example User): seven attempts
  diagnosed and cleared three fleet-level blockers (sync brick, update
  deferral deadlock, image generation); final probe proved an end-to-end
  agent session on the new image. The remaining e2e run is not this
  spec's to finish.
- **Three probe workspaces left alive deliberately** (retire tooling only
  accepts staging-e2e-synthetic* identities): duet-so+probe-dispatch-{1615,98380,
  21252}@agentmail.to — the last one is a working new-image specimen.
