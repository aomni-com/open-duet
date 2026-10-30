# MAP — Approved model catalog + default skills rail

Quadrant walk completed 2026-07-16 — the pre-build decision record that seeded
this feature. It shipped; [README.md](README.md) is the closed rationale record
and the entry point. This map is kept as decision provenance (the four-quadrant
reasoning and the ledger that fixed the catalog shape); its build-plan and
pre-code-confirm sections were folded into the slices and deleted at close.
chat-app paths are relative to `/Users/synthetic-user/dev/chat-app`.

## 1. Known knowns (settled ground)

- **duet has no model selection today.** The send path carries only
  `prompt`/`images` (`packages/contract/src/agent/index.ts:312-321`); the
  gateway spawns `duet --rpc` with no `--model`
  (`packages/gateway/src/runner/process-runner.ts:459-475`); the CLI falls
  back to its built-in default (`opus-4.8`).
- **The reference implementation is chat-app's catalog**:
  `packages/shared/src/types/ai-models.ts` — `AI_MODELS` (11 chat entries,
  lines 99-281) + `IMAGE_GATEWAY_MODEL_IDS` / `FREE_VIDEO_GATEWAY_MODEL_IDS` /
  `VIDEO_GATEWAY_MODEL_IDS` / `WHITELISTED_GATEWAY_MODEL_IDS` (lines 368-461),
  enforced in its proxy route
  (`apps/web/app/api/v1/ai-gateway/[...path]/route.ts:159-296`).
- **"Paid" in duet** = the workspace's `billingUserId` →
  `users.billing.firstPaidAt` (`packages/backend/convex/schema.ts:141`,
  stamped by `domains/credits/topups.ts:224`). No plan tiers; "free trial" =
  unpaid account on the $10 trial grant.
- **The agent CLI already discovers skills** at `~/.duet/skills`,
  `~/.agents/skills`, `~/.claude/skills` (+ project ancestors), deduping
  symlinked duplicates by realpath (`@duetso/agent
  dist/src/turn-runner/skills.js:8-39`; dedupe verified in
  `@earendil-works/pi-coding-agent dist/core/skills.js:303-326`). Nothing
  populates these dirs on duet VMs today.
- **The vm-sync-rail** (5s poll, `packages/gateway/src/vm/sync-client.ts`,
  `apps/api/src/routes/vm.ts`) already distributes hash-verified artifacts
  (gateway release: atomic versioned install + symlink swap + lock,
  `packages/gateway/src/gateway-release.ts:257-369`). Skills become a sibling
  artifact.
- **Media generation exists but is unreachable from chat**: `duet model -m
  <slug> --type image|video` (CLI subcommand) and `apps/mcp` `generate_media`
  work against the model-gateway's reservation billing; no skill tells the
  chat agent the command exists.
- **This work reverses a recorded decision**: the closed model-gateway spec
  chose "no model allowlist" (`specs/done/model-gateway/README.md:74-76`).
  Record the reversal there when this ships.
- **Environment**: staging only. No backward-compat engineering required; the
  existing VM fleet is disposable (Example User: "you can delete old fleet").

## 2. Known unknowns (decision ledger)

| # | Question | Answer | Closed by |
|---|----------|--------|-----------|
| Q1 | Skills delivery to VMs | New vm-sync-rail artifact: sync response gains `skills: {hash, url}`; apps/api serves the rendered bundle; gateway installs on hash mismatch | Example User (a) |
| Q2 | Which skills port now | 12 now; `build-apps`, `cron` + the 7 chat-app-coupled skills deferred (see stubs `specs/service-proxies/`, `specs/build-apps-skill/`) | Example User |
| Q3 | Catalog shape | Full chat-app parity, NOT minimal — see §"Catalog contract" | Example User (b + follow-ups) |
| Q4 | Enforcement point | model-gateway preflight = security boundary (allowlist + paidOnly hard 402); api-side zod validation for UX; proxy parses bodies (see L2) | Example User + territory |
| Q5 | How model choice rides | Per-message `model` (role id) with session stickiness; chain: message → session.lastModelId → workspace.defaultModelId → default role | Example User (a + workspace default) |
| Q-A | Where roles resolve | Control-plane only: api resolves role→slug at dispatch, spawns `--model duet:<slug>`; skills ship rendered `models.json` (role→slug map) so agents pass real slugs; gateway allowlist enforces slugs | Example User (a) |
| Q-B | build-apps + cron scope | Both deferred; placeholder spec for build-apps specifically | Example User |
| OPEN-1 | providerLock on native wire formats | **RESOLVED 2026-07-16 by research:** Vercel documents `providerOptions.gateway.only` as a top-level JSON body field on every surface incl. native Anthropic `/v1/messages` and OpenAI-compat endpoints (no header mechanism). See spec README Contracts; slice 00 live-verifies | Research |
| OPEN-2 | Image/video pricing numbers | Chat pricing copies verbatim from chat-app; image (`perImage`) and video (`perSecond`) need real values — placeholder estimates are labeled in the catalog until filled | OPEN (Example User or research) |
| OPEN-3 | Media role names | Suggested: `image` / `image:mini` / `image:google`; `video` / `video:fast` / `video:pro` — finalize in spec | OPEN (low stakes) |

## 3. Unknown knowns (extracted context)

- **Role ids are load-bearing product surface** (reshaped Q3): DB stores
  roles like `recommended` / `frontier:openai`, translated to slugs at
  dispatch, so "recommended" can be re-pointed any time. Same system for
  image/video roles. Skills reference roles in prose while `models.json`
  exposes the underlying slugs for traceability.
- **All catalog entries get `name` + `simpleName`** (all kinds, not just chat).
- **`isFree` = run-but-don't-debit** (future promotions). Initial catalog:
  `zai/glm-5.2` marked `isFree`.
- **Tests must be catalog-agnostic**: assert gate mechanics with fixture
  catalogs; never assert which real models are free/paid/hidden — the list
  changes with promotions. Binding testing principle.
- **`enabled` → `hidden`**: hidden models (e.g. `openai/gpt-5.4-mini`) are
  gateway-valid but never UI-listed.
- **Everything is restricted to the catalog** — chat agent, `duet model`,
  MCP `generate_media`, duetfs, raw API-key users. No exemptions.
- **Done bar** = staging live probe: free-trial workspace 402s on a paidOnly
  model, approved model works end-to-end, role repoint propagates, skills
  land on a real VM with symlinks + `models.json`.
- **UI is out of scope** — no picker; the contract/API seams must be ready
  for the later UI port (hence full-parity catalog fields).
- **`duetfs ai` gets deleted** (redundant `duet model` twin, born as a
  model-gateway slice-09 smoke surface, hardcoded to legacy
  `openai/gpt-image-1` — `packages/duetfs/src/ai.ts:10`).

## 4. Unknown unknowns (landmine cards)

- **L1 (decided Q-A)** — `duet` CLI throws on unknown `--model` shorthands
  and passes provider-pinned unknowns verbatim upstream
  (`model-resolution/resolver.js:96-106`, `duet-gateway.js:80-94`); the proxy
  never rewrites outbound model headers/bodies. → Roles never leave the
  control plane; only slugs cross the wire.
- **L2 (decided)** — Chat/memory/embedding traffic carries `model` only in
  the JSON body (native Anthropic/OpenAI wire); the proxy currently reads
  headers only and streams bodies zero-copy
  (`apps/model-gateway/src/index.ts:397-418`,
  `packages/contract/src/http/index.ts:3-9`). Header-only enforcement is a
  total bypass. → Proxy buffers+parses JSON on model-bearing endpoints; body
  is source of truth; fail closed. **Port chat-app's parse logic**
  (`route.ts:204-296`: JSON body `model` field, `ai-model-id` /
  `ai-language-model-id` header fallback for AI-SDK calls). providerLock
  injection rides the same parse (AI-SDK format now; OPEN-1 for native).
- **L3 (decided)** — Infra models must be approved+hidden or every turn
  breaks: `openai/gpt-5.4-mini` (memory default), `google/gemini-embedding-2`
  (embedding default, env `DUET_EMBEDDING_MODEL`). paidOnly reads the
  **workspace's billing user**, not the API-key owner (preflight currently
  loads `key.userId` — a non-paying teammate on a paid workspace must not be
  blocked).
- **L4 (decided Q-B)** — `build-apps` (chat-app sandbox-gateway API,
  `/session/public/*`) and `cron` (`/session/cron/config`, no duet
  equivalent) are rewrites, not ports. Deferred.
- **L5 (decided)** — `/v1/models` passthrough would lie about availability.
  → Filter the response to the approved subset, shape-identical (the CLI has
  a hand-duplicated catalog fetcher that must keep parsing it). Adapt
  `apps/mcp/src/tools/media.ts` to resolve roles + approved catalog.
- **L6 (decided)** — Skills artifact follows the release-rail pattern:
  sha256-verified fetch, versioned dir, atomic symlink swap, per-dir lock —
  not wipe-and-rewrite. apps/api serving requires adding the bundle to the
  Vercel build copy step (`vercel-bundle.mjs` `cpSync`) — forgetting it is a
  silent runtime 404. Sync field ships `.optional()` (free), but no
  compat engineering beyond that (staging). Hash the per-workspace
  **rendered** payload — catalog changes re-sync skills fleet-wide, which is
  desired (carries `models.json`).
- **L7 (confirmed, in scope + tests)** — `answer()` fallback respawn drops
  `cwd` and `lastEventSeq` (`process-runner.ts:352-356`): a session in a
  subdirectory whose runner dies mid-ask resumes at drive root with a reset
  event buffer. Fix so the fallback rebuilds from persisted session state;
  `model` rides the same fix. Regression tests required.
- **L8 (decided)** — pdf/file-conversion assume system binaries (tesseract,
  poppler, qpdf, ghostscript, libreoffice, pandoc, libvips) that no repo
  defines. → Audit `packages/vm-image/Dockerfile` against the skills'
  toolchain, add missing packages, rebuild image, reprovision fleet (staging
  fleet is disposable).

**Sharp edges (no decision needed):**
- New contract module name must not collide with existing
  `ModelCatalog`/`fetchModelCatalog` (`packages/contract/src/model-catalog/`
  — a different concept: Vercel-catalog id→media-type). Also distinct from
  `model-credentials.ts` (proxy auth env) and `domains/modelGateway`
  (billing). Suggested: `packages/contract/src/approved-models/`.
- Modality classification keys off incidental headers, path second
  (`index.ts:397-427`) — key off pathname first before layering allowlist
  buckets.
- RPC `start` has a dormant `options` bag — leave it; model rides CLI args.
- Placeholder rendering gets a build-time assertion that every `{{KEY}}` in
  skill text has a supplier (chat-app only guards `GATEWAY_PORT`). With
  build-apps/cron deferred, live placeholders shrink to `{{APP_URL}}` +
  the rendered `models.json`.
- impeccable references a `NOTICE.md` that chat-app never wrote (Apache-2.0
  obligation) — author it during the port. `npx impeccable` needs registry
  access (VMs have it — npm-rail proves it); confirm the package is public.
- Normalize `bunx` vs `npx` across skill prose to one runner (image ships
  both; pick `bunx`).
- `env-vars` skill's "system-managed" table is stale even in chat-app —
  rewrite for what duet actually seeds (`DUET_API_KEY`,
  `DUET_GATEWAY_BASE_URL`).
- media sub-skills contain contradictory default-model prose (Seedance 2.0
  Fast vs Veo table) — collapse into the role system during adaptation.
- Answer-path schema (`AgentGatewayAnswerRequestSchema`) has no model field —
  fine under session stickiness; answers reuse `session.lastModelId`.

## Catalog contract (agreed shape)

```ts
// packages/contract/src/approved-models/
type ChatPricing  = { inputPer1M: number; outputPer1M: number; cachedInputPer1M: number } // USD
type ImagePricing = { perImage: number }
type VideoPricing = { perSecond: number }

type ApprovedModel = {
  id: string              // stable role: 'recommended' | 'frontier:openai' | 'image' | 'video:fast' | …
  gatewayModelId: string  // actual slug: 'anthropic/claude-opus-4.8' — repointable per role, any time
  kind: 'chat' | 'image' | 'video' | 'embedding'
  name: string; simpleName: string; description: string
  pricing: ChatPricing | ImagePricing | VideoPricing   // discriminated by kind; embedding: none
  speed?: 1|2|3|4|5; intelligence?: 1|2|3|4|5          // chat only
  isFree?: true      // run but don't debit (promotions); initial: zai/glm-5.2
  paidOnly?: true    // gateway 402s unless workspace's billing user has firstPaidAt
  hidden?: true      // gateway-valid, never UI-listed: gpt-5.4-mini, gemini-embedding-2
  providerLock?: string[]  // e.g. glm-4.7 → ['cerebras'] (copy chat-app's verbatim)
}
```

Chat entries: copy chat-app's 11 verbatim (roles, pricing, scores, locks) +
hidden `gpt-5.4-mini`. Media entries: chat-app's image/video sets with the
free/paid split expressed as `paidOnly` (images all free-tier; video free
tier = `grok-imagine-video-1.5`, `seedance-v1.5-pro`; other 5 paidOnly).
Default chat role = `recommended` (chat-app points it at
`openai/gpt-5.6-terra`; duet's de-facto default today is opus-4.8 — pick at
spec time, it's one line of catalog data).

## Skills roster (12 now)

Verbatim: `pdf`, `file-conversion`, `github`, `env-vars`*, `create-skill`,
`add-skill`, `find-skills`, `webhook-collector`, `impeccable`* (+NOTICE.md).
Adapted: `media-creation` (roles + `models.json`, normalized prose),
`ai-gateway` (duet URLs), `remember` (verify `duet memory` subcommand — see
pre-code confirms). *small text fixes noted in sharp edges.

Install layout on VM (gateway-owned):

```
~/.duet/skills/<skill>/…          canonical, versioned install + symlink swap
~/.duet/skills/models.json        rendered role→slug/pricing/flags reference
~/.duet/.skills-hash              per-workspace rendered-payload hash
~/.claude/skills/<skill> → ~/.duet/skills/<skill>   per-skill symlinks,
~/.agents/skills/<skill> → ~/.duet/skills/<skill>   gateway-repaired, user files untouched
```

(Claude Code isn't on the image; `~/.claude` is forward-compat. The duet
agent reads `~/.duet/skills` directly and dedupes the symlinks by realpath.)

## Wire seams

```ts
// contract: model rides the send path (role ids, zod-validated vs catalog)
AgentStartSessionRequestSchema = z.object({ prompt, images, model: optional })
AgentMessageRequestSchema      = z.object({ prompt,          model: optional })
// resolution at dispatch (apps/api): message.model → session.lastModelId
//   → workspace.defaultModelId → default role; role → slug; spawn --model duet:<slug>
// persistence: lastModelId on the session doc (delivery rebuilds dispatch from
//   the session doc, same as cwd — delivery.ts pattern); workspaces.defaultModelId
//   gets its own single-purpose endpoint (repo convention: no generic settings PUT)

// gateway blocks (same GatewayBlock envelope as billing blocks)
{ code: 'model_not_allowed' }      // not in catalog
{ code: 'model_requires_payment' } // paidOnly × unpaid billing user

// sync response (optional field)
skills?: { hash: string, url: string }
```

