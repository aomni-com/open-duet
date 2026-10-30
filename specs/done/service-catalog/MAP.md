# Service catalog — quadrant map

Walked on 2026-10-11 with `explore-unknowns`. The walk narrowed the scope to
**reorganizing the service catalog and making it discoverable**: the catalog,
the vault, the runtime cutover, the discovery endpoints, the `duet services`
CLI, the docs, and the external skill. The factory moves to its own spec.
Where this map and [`README.md`](README.md) disagree, this map wins until the
README is reconciled. Reconciling is the first build step.

---

## Q1 — Known knowns (settled ground)

**The territory today**

- **Proxy.** One catch-all, `app.all('/v1/services/:service/*')`
  (`apps/api/src/routes/services/index.ts:30`). The six vendors are hand
  configured in `config.ts`, and there's no endpoint that lists them.
- **Workspace selection.** `requireWorkspaceFromKey`
  (`apps/api/src/shared.ts:292-322`) takes an explicit slug, otherwise a
  single-workspace key, otherwise answers 403 `workspace_ambiguous` with a
  generic message. VM keys and app keys belong to one workspace. The human
  credential `duet login` saves follows its owner's memberships, so it can
  cover several.
- **Internal skills.** The in-VM `duet` reference skill
  (`packages/skills-registry/skills/duet/SKILL.md`) is a table of
  capabilities pointing at docs, with no services row. Dedicated internal
  skills exist for important vendors (`elevenlabs`, `firecrawl`,
  `socialapi`, `go-to-market` sub-skills).
- **External skill.** `skills/duet/SKILL.md` plus `references/{installation,models}.md`.
  External agents install it with `npx skills add …/skills/duet` (root
  `README.md:17-39`). It treats `duet --help` as the contract, and no CI
  checks it.
- **CLI.** `packages/duet`. Remote commands register through
  `CommandRegistry` (`cli-support.ts:53-70`) and use one `ApiClient`
  (`http.ts`). It has no services command.
- **Public contract.** The registry in
  `packages/contract/src/endpoints/index.ts` generates the docs `/reference`.
  It has no services entries: "absent from this registry is not a public
  promise."
- **Firecrawl in the VM.** The VM gateway sets
  `FIRECRAWL_API_URL=${api}/v1/services/firecrawl`
  (`packages/gateway/src/runtime/http.ts:1388`), so the Firecrawl SDK goes
  through the proxy.

**Carried over from the spec (unchanged):**

- an allowlist catalog in `@repo/service-catalog`;
- vendor cost × 1.2, applied in one function;
- the Convex vault (plain values per D12);
- separate staging and production keys;
- a hard cutover with no migrations;
- no BYO keys;
- HTTP only;
- `/v1/capabilities/*` reserved for later.

**The proxy URL doesn't change.** It stays
`/v1/services/<vendor>/<vendor path>`, and documented routes behave as today.
Differences behind the same URL:

- unlisted paths return 404;
- prices become vendor cost × 1.2;
- the bare `/v1/services/<vendor>` becomes discovery;
- the vendor's root `/` and OPTIONS aren't proxied;
- the workspace is named with a header (Q6).

---

## Q2 — Known unknowns (decision ledger)

| # | Decision | Closed by | Why |
|---|---|---|---|
| Q1 | **Internal VM skills stay**, with dedicated depth for the important services so VM agents are productive. **External skill:** one comprehensive skill covering every CLI command. It gets one generic `references/services.md` teaching the loop *search the catalog, then read the service's own docs, then call through Duet*, and never lists services by name. | user | External agents install exactly one skill, so it has to cover every command and scale to hundreds of services. |
| Q2 | `GET /v1/services` lists `{ id, name, summary, category, docsUrl, llmsTxtUrl?, proxyBaseUrl }` and supports search (`q`, `category`, cursor). `GET /v1/services/:id` adds `routes: [{ method, path, billing: 'free' \| 'metered' }]` and `notes`. No prices or margin are shown. | user | Agents see what's allowed before they hit a 404, and our pricing stays private. |
| Q3 | `duet services search [q] [--category]`, `duet services show <id>`, and `duet services call <id> <METHOD> <path> [--body '<json>' \| --body @file] [--form k=v] [--query k=v] [--out file]`, all supporting `--json`. | user (`--body` naming: territory, card 2) | Mirrors the shape of `duet model`, so external agents never hand-build authenticated requests. |
| Q4 | Publish everything: `services.list` and `services.get`, plus the proxy as GET/POST/PUT/PATCH/DELETE `/v1/services/{service}/{path}` with binary bodies. Add a docs page `/services`, and a "Services" row in the internal `duet` skill's capability map. | user | The docs `/reference` page is the contract, and both skills point to it. |
| Q5 | A new `specs/service-factory/` holds the factory work. | user | The catalog comes first. |
| Q6 | Multi-workspace keys name the workspace with the **`x-duet-workspace` header**, which is stripped before forwarding. It replaces `?workspace=` on the proxy as a hard cutover; no code caller uses the query parameter. | user | One convention shared with the model gateway, and vendor query strings, including their own `workspace` parameter, pass through untouched. |
| Q7 | The **`workspace_ambiguous` error is instructive for agents.** It lists the workspace slugs the key grants and says how to choose one on this surface: `x-duet-workspace: <slug>`, or with the CLI `duet workspace use <slug>` or `--workspace <slug>`. The CLI always sends its selected workspace, and with none selected it prints the same guidance itself. | user | The CLI is used by agents, so an error has to say what to do next. |
| Q8 | Discovery endpoints accept **any valid key** (`api_key`, workspace-free, like `/v1/whoami`). The proxy registers as `api_key`, and its summary names the `services` capability and the `x-duet-workspace` header. | user (probe 1) + territory (card 6) | No restriction is needed to list the catalog, and the registry can't express a workspace scope without a workspace path segment. |
| Q10 | **ElevenLabs voices are a `sharedPool`** (the account is on **Pro**: 160 voice slots, 290 voice operations a month, verified live). Create (instant clone, design and save, add library voice), list, read, and use are open. Edit and delete only by the creating workspace. Voices created through the proxy **expire after 24 h**. Pre-existing voices, including the four "battlegame" ones, and curated voices are untracked, permanent, read-only, and **not cleaned up**. Professional cloning is refused (1 slot on the whole account). Duet seeds curated designed voices (prompt as `description`, `curator: duet` labels); users search, read prompts, hear `preview_url`, and remix to customise. | user | Voices aren't sensitive and sharing is the point. Owner-only changes plus a TTL keep the pool safe and bounded. |
| Q11 | **Route admission rules for every service, now and in future** (spec README): admit only `generate`, `publicRead`, `ownedById`, or `sharedPool`. Always refuse: changing or deleting what the caller's workspace doesn't own; listing user content that isn't shared by design; undeclared shared quota; account surfaces; non-request billing; non-HTTP. Every `Route` declares `admission`, and the validator enforces it. The canonical copy is `packages/service-catalog/README.md`. | user | One upstream account serves every workspace, and rules enforced in code can't be skipped at the hundredth vendor. |
| Q12 | **Shared-pool ownership tracking is general** (slice 05): `servicePoolResources` records `{service, pool, resourceId, workspaceId, expiresAt}` on create (awaited before the response returns; on failure the vendor item is deleted and a 502 returned). Mutate and delete check the owner (instructive 403). `scheduler.runAt` deletes at the TTL through the pool's declared vendor delete route. Every pool declares `ttlMs`, `expire`, and its quota. | user ("generalize this across any arbitrary service") | One mechanism for every vendor's shared resources |
| Q13 | **Per-provider business logic is first-class**: optional `hooks` (`beforeForward`, `afterResponse`) on `ServiceDefinition`, run inside `callService`. Hooks can't bypass admission, billing, ownership, or the vault; they never see the key; they declare `needs`; they are pure; each ships with a fixture test. Cross-vendor composition stays in `/v1/capabilities/*`. | user ("our advantage over treg … custom business logic per provider") | Duet's edge over a plain forwarding proxy, kept bounded so it doesn't sprawl |
| Q14 | **One required pre-read for every service author**, human or agent: `packages/service-catalog/README.md` (slice 01). Sections: why the rules exist; route admission rules, **including the full shared-resource rule** (everyone lists and uses; only the creating workspace edits or deletes; TTL expiry; untracked items read-only); pricing; provider logic; discovery metadata; adding a vendor step by step; what the validator enforces. `AGENTS.md`'s read-the-folder-README rule makes it discoverable. Until slice 01 ships, the spec README is the source. | user | A rule in a spec dies with the spec. A rule beside the code is read every time. |
| Q15 | **The service-factory spec blocks nothing here.** The catalog ships, and the six existing vendors are maintained (keys seeded with `service:vault`), without the factory; the factory only consumes the catalog, probe, and vault. | user | Independent work, one-way dependency |
| Q9 | **Done** means a fresh Claude Code with only the external `duet` skill, asked "make me a voiceover of this script", finds ElevenLabs, reads its docs, and produces the MP3 through `duet services call` with no hints. | user (probe 3) | It is the real consumer path. |

**Factory decisions moved to `specs/service-factory/`** (decided and kept
there, not built here):

- **Harness:** browser-use-pi, which is updated more often than
  browser-harness-js and is a separate codebase from it, built on Pi Mono and
  `devtools-protocol`.
- **Browser:** a local headed Chromium only, with a persistent profile per
  vendor. No cloud browser, telemetry off.
- **Helpers:** workspace helper modules for AgentMail, the vault, and the
  probe.
- **Instructions:** `llms.txt` plus a per-vendor `playbook.md`.
- **Blocked vendors:** park and report.
- **Cards:** Stripe Issuing first (its live virtual cards expose the full
  number and CVC, $0.10 each, no PCI needed for our own use; the account
  needs Issuing approved). Natural later; its card issuing is still "coming
  soon".
- **Signup:** autonomous signup from a committed `identity.json` and one
  AgentMail inbox per vendor.
- **Authoring:** the factory drafts vendor definitions (`service.ts`,
  playbook, fixtures). No SDLC or PR process in any spec (user).

---

## Q3 — Unknown knowns (extracted)

- **Consumers.** External agents are mostly Claude Code or Codex on a person's
  laptop, logged in with `duet login`. That is a human credential that can
  cover several workspaces, which led to Q6 and Q7. In-VM agents use
  single-workspace VM keys, and deployed apps use single-workspace app keys.
- **Taste.**
  - The external skill teaches a method, never a list.
  - Internal skills earn their depth where productivity matters.
  - Errors must instruct agents what to do.
  - Prefer one convention (the header) over two.
- **ElevenLabs is on the Creator plan** (user, 2026-10-11). Measured live:
  - there are no new API endpoints;
  - `mp3_44100_192` now works;
  - 44.1 kHz PCM and WAV still return 403 (Pro and above);
  - one professional voice-clone slot (refused by Q10 anyway).

  The user enabled `voices_read`, `models_read`, and `user_read` on the key
  (verified live on 2026-10-11), so this prerequisite is cleared.
- **Sample output: the user said "keep all"** (A–F):
  - a category column with a closed vocabulary;
  - `llmsTxtUrl` when the vendor publishes one;
  - one line of notes;
  - routes shown as method, path, and free or metered;
  - search ranked by name, then category, then summary;
  - **`billed $…` after `call`**, read from a new proxy response header,
    `x-duet-charge-usd`. The charge is computed before the response returns.
    For a JSON response whose cost depends on the body, the header follows
    the buffered body.

---

## Q4 — Unknown unknowns (landmine cards)

| # | Card | Evidence | Status |
|---|---|---|---|
| 1 | **A live bug: the proxy used a query parameter for Duet workspace selection.** | `apps/api/src/routes/services/index.ts:32-36, 83-84` | **Decided:** workspace selection comes from `x-duet-workspace`; the catalog forwards vendor query parameters unchanged. |
| 2 | The CLI's global `--json` takes over any `--json` argument, so a request body passed that way is lost silently. | `packages/duet/src/cli-support.ts:120-121`, `cli.ts:75` | **Decided:** the body flag is `--body`. |
| 3 | The shared `ApiClient` throws on non-2xx and keeps only a string `body.error`. Vendor errors would turn into CLI errors. | `packages/duet/src/http.ts:70, 81-105` | **Decided:** `call` uses raw mode. Duet blocks (marked with `x-duet-gateway`) use the CLI's normal error mapping. A vendor error prints its body verbatim (or writes it to `--out`), prints `HTTP <status>` on stderr, and exits 1. |
| 4 | The route-coverage test ignores `app.all`, so the published proxy entries would fail it. | `apps/api/src/endpoint-metadata.test.ts:84-87` | **Decided:** `app.on(['GET','HEAD','POST','PUT','PATCH','DELETE'])`, as in `routes/workspaces.ts:409-414`. OPTIONS is dropped. |
| 5 | Route order: the wildcard already captures `/v1/services/<id>`. | Hono probe (2026-10-11); `apps/api/src/index.ts:265` | **Decided:** list and detail register before the wildcard. The vendor's root `/` isn't proxyable. |
| 6 | Scope typing can't express the `services` capability without a workspace path segment. | `packages/contract/src/endpoints/index.ts:384-390`; `composio.execute` at `:2322` | **Decided:** Q8. |
| 7 | The VM Firecrawl SDK goes through the proxy, so SDK paths missing from the allowlist become silent 404s. | `packages/gateway/src/runtime/http.ts:1388` | **Decided:** slice 02 seeds Firecrawl's allowlist from the v2 SDK's paths, and the cross-check covers the SDK and the skills. |
| 8 | Docs CI wiring. | `PUBLIC_API_ENDPOINT_CATEGORIES` (`index.ts:346-362`); `ENDPOINT_CATEGORY_ROUTES` and `DOCS_SECTIONS` (`apps/docs/lib/docs.ts:15-194`); `verify-content.ts`; `PUBLIC_API_COLLECTIONS` plus the list in `index.test.ts:28-70`; `endpoint-coverage.generated.json`; visual baselines | **Sharp edge:** do all of it in the docs slice. |
| 9 | Shipping the CLI needs a version bump (`packages/duet/package.json`). Help is one string (`src/cli/help.ts:11-41`), and a test asserts the command list (`test/unified-cli.test.ts:68-80`). `parseNamedOptions` truncates `--query k=v=x`. | as cited; `cli-support.ts:159` | **Sharp edge**, plus a fix: split on the first `=` only. |
| 10 | Discovery needs per-service metadata nobody stores. | — | **Decided:** `service.ts` owns `name`, `summary`, `category` (a closed enum in the catalog, enforced by the validator), `docsUrl`, `llmsTxtUrl?`, and `notes`. |
| 11 | **The internal `elevenlabs` skill's "Pick a voice" section predates the `sharedPool` decision.** It doesn't cover curated voices, reading design prompts, remixing, or labelling the voices agents create. | `packages/skills-registry/skills/elevenlabs/SKILL.md` ("Pick a voice") | **Decided:** slice 02 rewrites it: search `/v2/voices` (curated first by the `curator` label), then `shared-voices`, then remix or design. Pass the design prompt as `description`, and label created voices. Say that voices can't be edited or deleted. |

**For the builder to confirm before coding:**

- ~~Whether TTS accepts a public library `voice_id` without adding it.~~
  **Answered by the territory (2026-10-11, live):**
  - TTS with library voice `CPEHCHnlRsWkpvhbDlfn` returned 200, with
    `character-cost: 1`.
  - ElevenLabs then shows the voice under the account's voices (21 premade
    plus that 1 professional voice), but `voice_slots_used` stayed 0 and
    `voice_add_edit_counter` stayed 0.
  - So library voices work by ID with no quota cost. Using them quietly
    grows the account's voice list, which the proxy never exposes.

  The key now has `voices_read`, `models_read`, and `user_read`. The
  subscription reads `tier: creator`, `voice_limit: 30`,
  `max_voice_add_edits: 95`, `professional_voice_limit: 1`.

- Which vendors publish `llms.txt`. ElevenLabs and Firecrawl do; check the
  other four.
- The exact set of Firecrawl v2 SDK paths.
- Whether `x-duet-charge-usd` can be set on streaming responses for
  header-priced routes. It should be: ElevenLabs sends `character-cost` before
  the body.

---

## Tweakable plan (sorted by how likely you are to tweak it)

**Judgment calls (the most likely to change):**

1. **The `x-duet-charge-usd` header and `billed $…` line in the CLI.** The
   default is on. Alternative: leave cost out of responses.
2. **The category vocabulary.** Default: `audio, search, scraping,
   enrichment, seo, social, media, data`.
3. **The external `references/services.md` wording.** It teaches the loop
   with ElevenLabs as the single worked example. That example is
   illustrative, not a per-service section.
4. **Search ranking.** Default: substring match on name, then category, then
   summary.

**Slices** (the README and `slices/` now carry these):

- **01** Catalog kernel, plus metadata, admission, pools, and hook types.
- **02** Six vendors and the probe, plus Firecrawl SDK paths, `llmsTxtUrl`,
  and the ElevenLabs voice pool.
- **03** Vault and ledger.
- **04** Runtime cutover, plus the workspace header, the instructive
  ambiguity error, `app.on`, the charge header, and hook execution.
- **05** Shared-pool ownership and expiry.
- **06** Discovery endpoints and the contract registry.
- **07** `duet services` CLI.
- **08** Docs and skills.
- **09** Closeout, with the Q9 acceptance run.
- The factory lives in `../service-factory/`.

*Mechanical work (I trust you on it):* generated-file regeneration, visual
baselines, codegen, and help text.

---

## Copyable implementation prompt

> Implement `specs/done/service-catalog/`. Read `MAP.md`, then the README's rationale
> Agent Prompt. Start slice 01 (catalog kernel) and slice 03 (vault) in
> parallel, red/green with `write-tests`. Work on the current branch and
> commit per slice.
