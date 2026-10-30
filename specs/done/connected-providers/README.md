# Connected Providers — rationale record

Closed 2026-07-23. Users link their own ChatGPT (`openai-codex`) or GitHub
Copilot (`github-copilot`) subscriptions and Duet's agent runs covered
models on them at `$0 · plan` instead of metered credits. Shipped across
two repos: duet-agent (released as `@duetso/agent` v0.3.2) and this repo
(merged to staging). Decision provenance: [MAP.md](MAP.md) (the quadrant
walk that fixed every product decision); live evidence: [PROBE.md](PROBE.md);
decisions made without Example User during the build: [choices.md](choices.md).

## Why it works this way

- **Providers are transports, not model sources.** The curated catalog and
  the routing table never change with connection state; transport selection
  prefers a connected provider that covers the already-chosen model, else
  the metered router order. This keeps Duet's editorial model list the
  product and makes a connection purely a billing optimization. The obvious
  alternative — subscription models appearing in the picker — was rejected
  in the MAP (Q3: "curation is the product").
- **The token store is authored and read only inside the workspace VM**
  (`~/.duet/connected-providers.json`, 0600). No backend schema models its
  contents; the workspace card drives the VM's own `duet connect` over the
  gateway. Refresh-token **rotation was observed on every live refresh
  probed** (PROBE.md), which is why the agent serializes refreshes through
  one workspace-owned store.
- **The credential file is durable workspace state.** The VM state archive
  carries it to a reprovisioned VM, while excluding only its advisory lock
  and unfinished atomic-write files (`packages/gateway/src/vm/archive.ts`).
  The backend stores and proxies that archive opaquely, preserving the
  provider connection without putting tokens on the VM-sync wire or in a
  control-plane schema.
- **Model-gateway is bypassed for plan-covered calls** — it is a
  credit-billing boundary and these calls spend no credits. Consequence
  accepted for v1: the product usage page cannot see them; the TUI's
  plan-covered rows are the visibility.
- **pi-ai is patched in-repo, not waited on** (`duet-agent/patches/`):
  its token refresh omits the OAuth `scope` param (401s), and the codex
  transport hardcodes `originator`. duet-agent owns its refresh fetch and
  boots with `originator: duet` (proven accepted live; revert via
  `DUET_CODEX_ORIGINATOR=pi`). Upstream report: earendil-works/pi#7001 —
  informational only.

## Invariants the code must keep honoring

- No token-named field in the connected-provider and VM-sync wire schemas —
  pinned by the schema-walk test in
  `packages/contract/src/connected-providers/index.test.ts`; CLI output
  redaction has its own snapshot tests, and credential restoration (without
  lock or atomic-write debris) has a regression in
  `packages/gateway/src/vm/archive.test.ts`.
- One credential store owner: `duet-agent src/connected-providers/store.ts`
  (locked read-modify-write via the shared `src/file-lock.ts`; rotated
  credentials persist wholesale). The VM gateway shells `duet connect`
  and never opens the file.
  Because that store is Duet's alone, the model registry has to say so:
  a request's `apiKey` is honored only for a provider that declares
  api-key auth, and `openai-codex` declares OAuth alone, so
  `duet-agent src/model-resolution/models.ts` re-registers each connected
  provider with a Duet-managed one. Drop it and every ChatGPT-connected
  turn is refused with "Provider is not configured" before a request is
  built (`test/model-dispatch.test.ts`).
- Capability probe semantics: only a confirmed billing refusal (402, thrown
  or `stopReason:"error"` path) or copilot's empty `availableModelIds` may
  persist `plan_ineligible`; transient failures stay `unknown`
  (`capability-probe.ts` + regression tests).
- Fallback never crosses transports after visible output or a tool effect;
  one plain `TurnSystemEvent`, no new protocol event; usage aggregates by
  (model, transport) so a mid-turn fallback shows a `$0` row and a metered
  row when both attempts produced billable usage (`turn-runner`,
  `usage-accounting.ts`; mixed-transport aggregation is the tested
  contract).
- Attribution: connect *start* persists a pending-connector intent
  (one-hour expiry); completion and VM observation consume it, so a lost
  poll within that window attributes correctly. Past expiry the
  observation falls back to the workspace's billing user — a deliberate
  bound, not a bug (`packages/backend/convex/domains/connectedProviders/model.ts`).
- Connect routes are browser-session-only; any member connects, connector
  or owner disconnects, **no tier gate** (a test pins trial workspaces
  working).
- The fake OAuth issuer (`packages/fake-oauth-issuer`, env-gated API mount
  via `DUET_ENABLE_FAKE_OAUTH_ISSUER`) implements the wire table pinned in
  the agent's conformance fixtures; grants are stateless signed values with
  injectable time (serverless-safe; flow ids are random, approval is
  time-derived). Flag off = the routes are not registered.

## What diverged from the plan (worth not re-deriving)

- **The `gpt` family was deleted mid-spec** (Example User: only curated OpenAI
  families are covered) — codex coverage is `sol/terra/luna` plus `astra`
  (added 2026-09-18 once pi-ai's codex catalog served it; live-verified).
  A new OpenAI family is covered only when its catalog entry gains an
  `openai-codex` id — the golden matrix in duet-agent's
  `test/fixtures/connected-providers-coverage.json` pins the set.
- **Copilot shipped fixture-tested but live-unverified** — Example User's account
  is plan-ineligible; the probe proved login + token exchange + the
  ineligible classification (the state the card shows). His live test is
  deliberately post-close.
- **"Connected by" labels fall back to email** when the user has no display
  name; tests pin the fallback.
- **The staging e2e journey is registered and provisioned but its green
  run belongs to the e2e session.** `staging-e2e-synthetic`
  is a named focused journey (`'connected-providers'` in
  `staging-e2e-synthetic`; run via `bun run e2e:staging -- --journey
  connected-providers`), and the staging-only issuer env
  (`DUET_ENABLE_FAKE_OAUTH_ISSUER` + `DUET_CONNECT_FAKE_ISSUER_URL`) is
  provisioned through the secret-topology rail, so the legs no longer
  self-skip. Post-close attempts all timed out at the fixture's
  gateway-version wait — root cause was fleet-wide, not this feature:
  staging's `vmUpdateControl` singleton was missing (wiped by the
  schema-cleanup preflight reset), silently pausing every VM's
  self-update. Fixed by making the missing row mean "updates flow"
  (see specs/done/vm-sync-rail) plus bumping the stale
  `DEFAULT_AGENT_VERSION` pin that would have downgraded agents on
  unpause.
- **The e2e work uncovered three fleet-level pre-existing failures**
  unrelated to this feature (old-image gateways bricked by strict sync
  schemas; a 24h update deferral deadlocked by its own zombie sessions;
  the image generation itself). Fixing them produced: request-schema
  strip+coercion with an image-floor regression test, the **rescue
  envelope** (unparseable-but-authenticated sync ⇒ 200 with the gateway
  release, so schema breaks heal in one cycle — Example User's design), sync
  request-echo self-diagnosis, a VM image rebuild pinned to digest
  `26576e20d582` in staging *and* production, and a durable diagnostic
  (`packages/test-harness/scripts/probe-session-dispatch.ts`). A probe
  session ran end-to-end on the new image ("PROBE-OK").
- **Dead end:** harness retries modeling a "memory.db busy after train"
  theory — two retry sites later, the real cause was the fleet brick above.
  The retries remain (harmless, annotated) but the theory was wrong.
- **Dead end:** capturing a wedged VM's sync request via server logs —
  Vercel CLI exposes no runtime console output; the answer came from
  replaying reconstructed bodies against the deployed schema and, durably,
  from the request-echo now in the gateway.

## Pointers

- duet-agent: `src/connected-providers/` (store, registry, fake-issuer
  seam, capability-probe, transport-preference, fallback-notice, tokens),
  `src/cli/connect.ts`, `src/model-resolution/catalog.ts`
  (`FamilyName`, `TransportName`, `transportModelId`),
  `patches/@user@example.invalid`. Tests:
  `test/connected-providers-*.test.ts`, `test/cli-connect*.test.ts`,
  `test/catalog-family-shorthands.test.ts`.
- duet: `packages/contract/src/connected-providers/`,
  `packages/gateway/src/connected-providers/connect-session.ts`,
  `apps/api/src/routes/connected-providers.ts`,
  `packages/backend/convex/domains/connectedProviders/`,
  `apps/web/spa/connected-providers/`, `packages/fake-oauth-issuer/`,
  `packages/test-harness/src/staging-e2e-synthetic`.
- Visual baselines:
  `apps/web/tests/visual/__screenshots__/*/playground.spec.ts/settings-connected-providers*.png`
  — the card's states, desktop+mobile: the accepted standard from the
  unprimed critique round, which drove two changes (Disconnect's bordered
  affordance; the Cancel action in the device-code panel).

## Still open (owned outside this spec)

- Example User's live checks: ChatGPT via the staging card; Copilot once his plan
  allows.
- The green e2e run of the `connected-providers` journey (the session
  owning staging verification; issuer secrets are provisioned and the
  fleet-level blocker is fixed).
- Update-rail sharp edge: the 24h update deferral counts never-streamed
  runners as "active" — health-qualify that gate (update-rail owner).
- Delete the legacy sync tolerances (`activityGeneration` coercion,
  telemetry loose-parse) once no pre-rework image remains in any fleet.
