# models-and-skills — approved model catalog + default-skills rail

Shipped to staging 2026-07-16. This record is the *why*; the code is the *how*.
Binding pre-build decisions live in [MAP.md](MAP.md) (quadrant walk); this file
records what actually landed and what must keep holding.

## What shipped

Duet gained model selection and a delivered skill library, both governed by one
typed catalog:

- **An approved-model catalog** (`packages/contract/src/approved-models/`) is
  the single authority for every role → gateway-slug mapping and every policy
  flag (`isFree` / `paidOnly` / `hidden` / `providerLock`). 23 entries: chat,
  image, video, and a hidden embedding/memory pair.
- **Model choice threads the send path** as a *role id* from the public API,
  resolves to a slug exactly once inside Convex, and reaches the VM as
  `duet --model duet:<slug>`. The gateway enforces the catalog at preflight —
  before any spend — and pins the upstream request to the resolved model.
- **12 default skills** are rendered into a deterministic, hashed bundle, served
  by apps/api, and installed atomically onto every VM's `~/.duet/skills` with
  symlink farms into `~/.claude/skills` and `~/.agents/skills`.

The problem it solves: before this, the send path carried only `prompt`/`images`
and the VM ran the CLI's built-in default; the model gateway forwarded whatever
model a caller named and classified modality from incidental headers. Model
choice was invisible to the product and unenforceable. Now the catalog is
product policy, enforced at the one boundary that spends money.

## The reason it works this way

- **Roles are public; slugs are internal — a hard boundary, not a convention.**
  Public APIs accept `ApprovedModelRoleId` and reject raw slugs; the VM wire and
  the model-gateway only ever see slugs. A slug is a routing detail that changes
  with provider deals; a role is the stable product concept. Keeping roles out
  of the VM/gateway means a slug repoint is a one-line catalog edit that
  propagates through `models.json` and dispatch without touching any consumer.
  Resolution happens once, in the Convex delivery transaction — never
  re-derived downstream.

- **Preflight is the security boundary, and it derives the model from the
  request body.** The dominant chat/memory/embedding traffic carries `model`
  only in the JSON body, so header-based classification could be bypassed. The
  proxy parses the body as the source of truth
  (`apps/model-gateway/src/request-inspection.ts`), fails closed on a missing or
  malformed model, and the Convex preflight allowlist- and payment-checks the
  slug *before* consuming a rate-limit token, reserving credit, or creating a
  generation row. Rejection must cost nothing.

- **Billing eligibility follows the workspace payer, not the key holder.** A
  `paidOnly` model is gated on `workspace.billingUserId`'s
  `billing.firstPaidAt`, never the API key's own user — a non-paying teammate on
  a paid workspace must pass, and the key user stays the request *actor* for
  attribution. Keys at preflight are single-workspace-scoped, so there's no
  multi-workspace ambiguity to resolve.

- **The `isFree` decision is snapshotted at preflight.** `chargeToWorkspace` is
  written once when the generation row is created; settlement records upstream
  cost but never re-reads catalog policy. A promotion or repoint mid-flight
  therefore can't retroactively change what a caller is billed.

- **Skills are content, delivery, and install as three separate owners.**
  `packages/skills-registry` owns the bytes; apps/api only serves them;
  `packages/gateway/src/skills-install.ts` is the only thing that writes the VM
  filesystem. The bundle is a canonical JSON manifest (not a tarball) hashed
  with sha256 over the exact served bytes — the same hash the sync advertises
  and the installer verifies before parsing. Coupling the hash to the rendered
  content (including `models.json`) is deliberate: a catalog change re-hashes
  the bundle and re-syncs the fleet for free.

- **No transitional scaffolding.** Staging-only hard cutovers throughout: no
  compat shims, no migrations, no dual-reads. `chargeToWorkspace` is optional in
  storage solely so pre-existing rows parse; every writer requires it.

## Invariants — what must stay true

- **`packages/contract/src/approved-models/` is the only model authority.** No
  consumer builds its own model map/set. `data.ts` is never imported directly —
  always via the package index, so fixtures stay injectable (every test
  constructs its own catalog via `createApprovedModelCatalog`; none asserts
  which *real* model is free/paid/hidden/default, because promotions change the
  list). Distinct from the older `model-catalog/` module (a Vercel
  id→media-type parser — different concept, untouched).
- **Duplicate slugs are a security invariant.** Catalog construction rejects two
  entries sharing a `gatewayModelId` with divergent
  `kind`/`isFree`/`paidOnly`/`providerLock` (enforcement is slug-keyed; `hidden`
  may differ — it's presentation only). `balanced` and `balanced:anthropic`
  legitimately share `anthropic/claude-sonnet-5`, which is why the enforced
  slug set has 22 unique ids for 23 roles.
- **The resolved model is durable, prompt-bound state.** Each queued input
  stores its own resolved role, so two queued prompts with different models each
  keep theirs — never re-derived from mutable session state at drain time.
  `agentSessions.lastModelId` provides stickiness, `workspaces.defaultModelId`
  the default, `DEFAULT_CHAT_MODEL_ROLE` the floor. Dead-runner recovery rebuilds
  from persisted state via the internal `resume` context, never from gateway
  memory.
- **One launch spec drives both spawn and respawn.** `AgentLaunchSpec`
  (`{sessionId, cwd?, lastEventSeq?, gatewayModelId}`) is a single object so a
  fallback path cannot silently omit a field — the exact shape of the bug this
  work fixed (see Dead ends).
- **providerLock replaces, never merges.** For a locked model the proxy sets
  `providerOptions.gateway.only` to the catalog's list, discarding any
  caller-supplied `only` — the catalog owns routing policy. Its purpose is
  keeping models *fast* (pinning to high-throughput providers, e.g.
  `glm-4.7`→Cerebras), not access control.
- **`/v1/models` tells the truth.** The gateway filters the upstream list to
  approved slugs (hidden included — a UI flag, not a gateway one), byte-preserving
  each retained entry; malformed upstream 2xx becomes 502 rather than leak
  unfiltered data.
- **The installer never damages a user-owned path in the link farms.** In
  `~/.claude/skills` and `~/.agents/skills` — the user's own agent-config
  territory — it replaces only links it previously created (symlinks pointing
  into `~/.duet/skills*`); a real file or dir at a link target is preserved and
  logged. (`~/.duet/skills` itself is the gateway's exclusive state — its
  release symlink is swapped unconditionally; nothing else writes there.) It
  verifies sha256 before parsing, re-validates the manifest against the contract
  schema at the trust boundary (safe relative paths, no duplicates), and swaps
  atomically with rollback to the previous release on any failure.

## Where it lives (pointers into the code)

- Catalog: `packages/contract/src/approved-models/` — `catalog.ts`
  (constructor + `resolveGatewayModelId`, `evaluateModelAccess`,
  `visibleModels`, `renderModelsReference`), `data.ts` (production entries +
  `DEFAULT_CHAT_MODEL_ROLE`), `index.ts` (`APPROVED_MODELS`,
  `ApprovedModelRoleIdSchema`). Behavior pinned in `index.test.ts`.
- Threading: public schemas in `packages/contract/src/agent/index.ts`
  (`model?: ApprovedModelRoleId`; internal `gatewayModelId` + `resume`);
  resolution chain in `packages/backend/convex/domains/agentSessions/delivery.ts`
  (`resolveAgentModelRole`); dispatch in `apps/api/src/agent-runner.ts`;
  `setDefaultModel` + `workspace.default_model_changed` audit in
  `packages/backend/convex/domains/workspaces/mutations.ts`. Stickiness pinned in
  `packages/backend/src/agent-sessions.test.ts`.
- Spawn/respawn: `packages/gateway/src/runner/process-runner.ts`
  (`AgentLaunchSpec`, `defaultRunnerFactory` argv), regression in
  `process-runner.test.ts`.
- Enforcement: `packages/backend/convex/domains/modelGateway/preflight.ts`
  + `blocks.ts`; body parse in `apps/model-gateway/src/request-inspection.ts`;
  lock + filter in `apps/model-gateway/src/{provider-lock,model-list}.ts`.
  Pinned in `packages/backend/src/model-gateway.test.ts` and
  `apps/model-gateway/src/index.test.ts`.
- Skills: `packages/skills-registry/` (content + `render.ts` + `bundle.ts`),
  contract schema `packages/contract/src/skills/index.ts`, delivery in
  `apps/api/src/routes/vm.ts` (`GET /v1/vm/skills/:hash`), install in
  `packages/gateway/src/skills-install.ts`.
- MCP + duetfs: `apps/mcp/src/tools/media.ts`, `packages/contract/src/mcp/`;
  `packages/duetfs/src/ai.ts` was deleted.
- VM image: `packages/vm-image/Dockerfile`, `src/required-tools.ts`,
  `scripts/verify-image.ts`.
- The decision reversal it caused is recorded in
  [`specs/done/model-gateway/README.md`](../model-gateway/README.md) ("No model
  allowlist… header-classification" → catalog-governed, body-first).

## Divergences from the plan

- **Convex rejects a top-level union args validator.** The plan made the
  preflight args a discriminated union ("generation requires model"); Convex's
  push 400s on a non-object top-level validator. The model requirement is
  instead a fail-closed check inside `gatewayPreflightImpl` — same guarantee,
  different mechanism.
- **`publicSession` projection had to learn `lastModelId`.** Threading wrote the
  field but the read projection (`queries.ts`) omitted it, so the stickiness
  test read stale data until the projection was extended — an integration seam
  the slice plan didn't call out.
- **Media roster grew four vendor-qualified video roles.** OPEN-3 suggested
  three media role names; the chat-app source set has seven video slugs, so
  `video:seedance`/`video:google`/`video:kling`/`video:kling:image` were added
  for full slug coverage. Media prices ship as labeled estimates (OPEN-2 was
  never settled — the catalog owns the numbers; changing them touches no code).
  Default chat role is `recommended` → `openai/gpt-5.6-terra` (OPEN-4,
  chat-app parity).
- **`models.json` lives under `media-creation/reference/`, not the bundle root.**
  the media-creation skill references `reference/models.json`, so the injected
  catalog rides there; it still carries the full 23-model set and re-hashes the
  bundle on any catalog change.
- **The VM image is code-complete; its promotion is a separate ops step.** The
  Dockerfile (headless LibreOffice re-added, ~2.1GB), `required-tools.ts`
  (derived from the rendered bundle), and verifier all landed and were proven by
  a local `docker build` + full container `verify-image` (every binary, 17
  Python modules, real soffice docx+pptx→pdf, CLI rail, syncthing pin). See
  **Open operational follow-up**.

## Dead ends

- **Header-derived model routing is a live bypass (the load-bearing find).** The
  Vercel AI Gateway routes by the `ai-model-id` / `ai-language-model-id` header
  *in preference to the body*. A staging live probe caught it: an approved model
  in the body passed preflight while a different model in the header was what
  upstream actually ran — enforcement checked one model, the fleet ran another.
  The fix pins every present model header to the body-derived inspected slug
  (`apps/model-gateway/src/index.ts`), so upstream can only run what preflight
  authorized. This is why body-first parsing plus header-pinning both exist;
  either alone leaves the hole.
- **The respawn path silently reset cwd and event cursor.** Before this work, a
  dead-runner answer respawned from `{prompt}` alone, dropping the session's
  subdirectory cwd (back to drive root) and its `lastEventSeq` (back to 0). The
  single `AgentLaunchSpec` object exists specifically so no launch path can omit
  a field again; the regression test was verified red against the pre-slice tree.
- **`bunx --help` is not a liveness probe.** It wants a package arg and exits 1
  even when bunx is healthy — the first image `verify-image` run failed on it.
  Probe with `bunx --version`.
- **Audio media was cut, not built.** `generate_media` drops the audio kind
  entirely (the catalog has no audio kind; "everything restricted to the
  catalog"). Re-adding it means adding a catalog kind, not re-plumbing MCP.
- **LibreOffice was dropped, then un-dropped (OPEN-5, final).** The image had
  removed LibreOffice for ~331MB; research found pptx/xlsx→pdf has no mature
  LibreOffice-free path (every npm converter wraps it or ships a ~150MB wasm
  build; pandoc can't read pptx), so the image re-adds the headless subset —
  capability beats image size on staging.

## Open operational follow-up (Example User-gated)

The slice-12 image is proven in-tree but not yet on the fleet. Promoting it
touches shared infra (a `ghcr.io/aomni-com` push, an encrypted-secret change,
and a live fleet reprovision), so it was deliberately not fired autonomously.
To ship, from a machine holding `.env.keys` + ghcr push access:
`bun --cwd packages/vm-image run build-image:staging` (build → container verify
→ push → write the new `DUET_VM_IMAGE_REF` digest into `.env.staging`), commit
the re-encrypted `.env.staging`, `bun run secrets:push:staging -- --apply`, then
reprovision the disposable staging fleet. The one live check that waits on this
is file-conversion (soffice) on a real VM; every other contract — enforcement,
threading, `/v1/models` filter, and the skills rail end-to-end — was verified on
deployed staging (see the acceptance notes below).

## Acceptance evidence

The durable, committed evidence is the test suite, which pins every contract
above: the enforcement matrix and header-pin (`apps/model-gateway/src/index.test.ts`),
reject-before-spend and the billing-user-vs-key-user split
(`packages/backend/src/model-gateway.test.ts`), stickiness and prompt-bound
resolution (`packages/backend/src/agent-sessions.test.ts`), the L7 respawn
regression (`packages/gateway/src/runner/process-runner.test.ts`), the
installer failure matrix (`packages/gateway/src/skills-install.test.ts`), the
artifact route's hash/404/401 (`apps/api/src/index.test.ts`), and the docs gate
(84 public endpoints). At close, `check-types`, `lint`, and `turbo run test`
(18/18 packages) were green.

Beyond the tests, the release was gated on point-in-time live probes run
2026-07-16 against deployed staging (fresh synthetic workspaces, each torn
down) — these are how the header-routing bypass was found and how the
`/v1/models` filter and skills rail were confirmed end-to-end on a real VM.
They were acceptance observations, not committed artifacts; the tests are what a
future reader re-runs.

Test convention: the catalog **policy** units use fixture catalogs and never
assert which real model is free/paid/hidden/default, so promotions can't break
them. Integration and roster tests do read the production `APPROVED_MODELS` for
*structure* (that roles resolve, that the 12 skills are present) — structure is
stable across promotions in a way policy flags are not.
