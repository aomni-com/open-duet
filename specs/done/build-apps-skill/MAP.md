# build-apps skill + app icons — quadrant map

Walked 2026-07-16/17 with Example User. **Shipped 2026-07-17 — see `README.md` (the
rationale record) for what landed and where.** This map remains the walk's
DECISION record: the `build-apps` default skill (duet's rewrite of chat-app's),
plus the product surface it needs — app display names, image icons, and the
gateway building page. Supersedes the placeholder `README.md` requirement
note in this folder.

Feature in one line: agents get a skill that builds/deploys apps on a
consistent stack with a generated icon and a live-from-second-one publish
flow; the product grows `name` + `icon` on apps, icon rendering on both app
surfaces, and a building page instead of raw 404s.

## Q1 — Known knowns (settled ground)

- Duet's app surface: `{path, command, installCommand?, port?, slug}` via
  `POST /v1/ws/:ws/apps` (`apps/api/src/routes/apps.ts:58`,
  `RegisterAppRequestSchema` `packages/contract/src/apps/index.ts`), run by
  the gateway AppSupervisor, served at `{app}--{ws}.edge[-staging].service.example.invalid`
  (edge-hosts cutover, commits 2c3f9fbe/b7451218). Update PATCHes in place —
  no chat-app config-replace footgun.
- apps-in-file-view is landed on staging: Files-row app glyph
  (`apps/web/spa/files/file-glyph.tsx`), status tints, `packages/seed-drive`
  birth content with a sample `hello` app.
- Skills rail ships ONE bundle of every `packages/skills-registry/skills/*`
  to the VM (`apps/api/src/routes/vm.ts:68,114`); `target:` frontmatter is
  inert chat-app metadata — nothing filters on it. Only `{{APP_URL}}` renders
  (`skills-registry/src/render.ts:20`); agents use `$DUET_API_URL`,
  `$DUET_API_KEY`, `$DUET_GATEWAY_BASE_URL` env instead of placeholders.
- Image gen is solved: `media-creation` skill → `duet model -m image` writes
  the file and prints the path. `impeccable` skill exists in the registry.
- Publishes are the sibling surface: drive file/folder → path on the edge
  host (`service.example.invalid/{ws}/{publishSlug}`), so absolute-path navigation
  breaks there; apps get subdomains and working roots.
- VM image (`packages/vm-image/Dockerfile`) has bun / node 24 / python3, no
  static server; Syncthing bake pattern (pinned + SHA, `:91-103`) is the
  template for adding one.
- Chat-app original read in full (`/Users/synthetic-user/dev/chat-app/.../build-apps/`
  SKILL.md + 5 refs). Its channel/pin/path-mount/prompt-app machinery has no
  duet equivalent and is not ported.
- exe VMs never sleep (platform fact, Example User) — serving icons off VM disk is
  always-available. (Workspace `suspendedAt` is a separate billing/admin
  state; the whole workspace UI gates on it, not just icons.)

## Q2 — Known unknowns (decision ledger)

| # | Question | Decision | Closed by |
|---|----------|----------|-----------|
| 1 | Ordering vs apps-in-file-view | Build on top; its surfaces are landed | Example User |
| 2 | App model | One model (command+port); no chat-app machinery | Example User |
| 3 | Static apps | `static-web-server` baked into VM image (pinned+SHA like Syncthing); skill teaches `static-web-server -p $PORT -d .` (+ `--page-fallback index.html` for SPAs). **No fallback, no backward compat: old images are deleted and every VM reprovisions onto the new image.** Measured: SWS ~4–8 MB RSS vs `bunx serve` ~90 MB | Example User |
| 4 | Publish-early semantics | Register the moment the agent starts building | Example User |
| 5 | Publish-early UI | Gateway serves a building page instead of raw 404; mtime probe on the app folder distinguishes "actively building" | Example User |
| 6 | Icon transport | Image file in the app folder on VM disk; optional `icon` field names it; `icon.png` recommended default, not hardcoded | Example User |
| 7 | Icon surfaces | Both Files rows and Apps page; fallback to status-tinted glyph when unset/missing | Example User |
| 8 | Icon generation | Via `media-creation` (`duet model -m image`); chat-app icon house style **verbatim** (vibrant saturated gradient, glossy white 3D object, no text, full-bleed 1024², ≤1 MB) | Example User |
| 9 | Webhook/prompt apps | OUT — never used, not implementing | Example User |
| 10 | App `name` field | Optional human display name; folder name when unset | Example User |
| 11 | Publish vs static app | Skill decision rule: single file/doc → publish; anything with navigation → static app; runs code → service | Example User |
| 12 | Theme param | Apps must support `?theme=light\|dark` — duet will embed apps in iframes later (iframe NOT in this spec) | Example User |
| 13 | Starter template | Dropped (`duet-ai-starter` is stale chat-app-era Vite/Drizzle). Skill specifies the blessed stack in ~5 lines: bun + Hono, one process on `$PORT` serving API + static, SQLite file in the app folder, no build step unless asked. Goal: every app on a consistent stack | Example User |
| 14 | Icon policy | Skill mandates icons for user-facing apps; API keeps `icon` optional, no enforcement | Example User |
| 15 | Final polish | Ported near-verbatim: `impeccable` on the deployed URL incl. ≤400px width before done; skip for headless/API-only | Example User |
| 16 | Skill target | `target: sandbox` — the rail doesn't filter on it today and every instruction assumes a VM shell; flipping later is one frontmatter line | territory + Example User |

No OPEN items.

## Q3 — Unknown knowns (extracted taste & context)

Reaction sheet: https://claude.ai/code/artifact/62391707-81d8-4a8f-8bef-18fa6ae41e03

- **Icon × status = Direction D**: the icon stays clean (never tinted,
  ringed, or badged); status moves to a text pill at the row/card end,
  shown on unhealthy rows only (`starting… / broken / disabled`); disabled
  rows still dim whole-row. Reuse the status colors from `apps-surface.tsx`
  (extract the shared helper — don't invent a fourth scheme).
- **Building page = V1, live activity**: shimmering icon placeholder, "{name}
  is being built", recently-touched files with relative times, self-refresh
  until the app answers. Filename exposure to public visitors on public apps
  is a **deliberately accepted** risk (V3 member/public split was on the
  table and passed over).
- **Skill skeleton: all 12 sections stolen** (triggers; surface decision
  rule; blessed stack; project structure; publish-early flow; icon protocol;
  static apps; services & runtime; theme param; mobile responsiveness; final
  polish; inspect-before-mutate).
- **Done-condition**: staging deploy + a live e2e where an agent builds a
  real app end-to-end via the skill (scripted: create workspace → prompt →
  poll app URL to 200; rides `scripts/staging-e2e-synthetic` patterns +
  `DUET_PROGRAMMATIC_LOGIN_SECRET`).
- Consumers: the VM sandbox agent only (see ledger #16).

## Q4 — Unknown unknowns (landmine cards)

Sweep covered: convex apps model + replication, gateway apps
route/supervisor, edge resolve chain, contract apps/skills, skills rail,
seed-drive, web Files/Apps surfaces, chat-app original.

1. **DECIDED (b) — Files row shows the app `name`, folder name secondary.**
   The row is still a directory entry; rename/delete dialogs must keep
   operating on (and naming) the folder, with the app name secondary text so
   file-ops stay honest.
2. **DECIDED (b) — gateway intercepts static-app 404s while building.** SWS
   starts instantly on an empty dir and serves its own 404, so the building
   page would never show for static apps. Gateway intercept containment:
   only root path `/`, only status 404, only while folder mtimes are hot;
   pass real 404s through once activity goes cold. (Composes with the #5
   mtime probe — one recency check serves both.)
3. **Replicas silently lose `name`/`icon` unless plumbed** —
   `reconcileReplicasForOriginApp` patches only `command`/`installCommand`
   (`domains/apps/replication.ts:136-141`) and seeding copies a fixed field
   set (`:321`). Add both fields to both paths; the icon *file* already
   syncs via Syncthing.
4. **Building page lives in the gateway, not the edge** — `resolveForEdge`
   never gates on `runtimeStatus` (`domains/apps/model.ts:482-534`; only
   anchor state + visibility), so reconciling/failed apps already proxy
   through. Add `name` to `GatewayAppConfig` (slug fallback) so the page can
   greet with the display name.
5. **Icon bytes vs row pixels**: 1024² PNGs (~1–2 MB) render at 22px. Cache
   headers on the icon read + client caching; skill caps the file ≤1 MB.
6. **SWS bake rides the pending image rebuild** (models-and-skills image
   push + reprovision, Example User-gated). No fallback and no backward compat —
   old images are deleted and all VMs reprovision (Example User's call); the skill
   documents only the SWS one-liner.
7. **Mechanical tail** (trusted): endpoint-registry + generated-docs regen
   for `name`/`icon` (regen the coverage ledger); i18n keys ×2 (en +
   es-419); ui-playground fixtures + both-viewport baselines for pill/icon
   rows and the building page; `icon` validated as a safe relative path
   inside the app folder (reuse the `isSafeRelativePath` idiom,
   `contract/src/skills/index.ts:3`); seed-drive `hello` app gets `name` +
   `icon.png`.

## Contract deltas (the seam, summarized)

```
apps table + App wire + RegisterApp/UpdateApp:
  name?: string          // display name; folder name when unset
  icon?: string          // safe relative path inside the app folder; icon.png by convention

GatewayAppConfig: + name? (building page greeting; slug fallback)

Replication: name/icon join command/installCommand in seed copy + patch diff.

Web icon fetch: existing drive-file read rail (same one preview-pane <img>
uses) + cache headers; fallback glyph on 404/unset.

Gateway: building-page handler on proxy-miss AND on root-404-while-hot
(landmine 2 containment); mtime recency probe (top level + one deep, capped).

VM image: static-web-server pinned + SHA-verified (Syncthing pattern,
Dockerfile:91-103).

Skill: packages/skills-registry/skills/build-apps/ (SKILL.md + references),
target: sandbox, 12 sections per Q3.
```

> **SUPERSEDED 2026-07-17 (shipped):** everything below this line was the
> pre-build planning tail; the build landed and `README.md` is the record.

## Builder must confirm before coding

- [ ] SWS flag names against the pinned release (`--page-fallback` vs
      `--page-fallback-path` drift across versions) before writing the skill
      one-liner.
- [ ] The exact drive-file read endpoint + auth the web app uses for images
      (`preview-pane.tsx` url provenance) — icons must ride the same rail.
- [ ] Whether the gateway can cheaply see "upstream responded 404" on the
      proxy path it owns (`routes/apps.ts:364` region) for landmine 2's
      intercept.
- [ ] Image rebuild scheduling: fold SWS into the already-pending
      models-and-skills image push, or cut a separate image — one reprovision
      either way.

## Tweakable plan (sorted by likelihood-of-tweaking)

1. **Building page behavior** (decisions #5 + landmine 2) — the 404
   intercept containment and mtime windows are judgment calls; degrade is
   generic-page-only (V2) if the probe or intercept fights back.
2. **Files-row name treatment** (landmine 1b) — exact secondary-text layout
   is a taste call; playground fixture first, screenshot gate before wiring.
3. **Skill prose** — 12 sections settled, but wording/ordering will iterate
   against the live e2e; the icon prompt template is copied verbatim from
   chat-app `reference/app-icons.md`.
4. *Mechanical (trusted)*: schema + wire fields, replication plumbing, icon
   read + caching, SWS image bake, seed-drive name+icon, i18n, endpoint/docs
   regen, playground baselines, e2e script.

## Implementation prompt (paste when ready to build)

> Implement `specs/build-apps-skill/MAP.md` (binding). Confirm the four
> "builder must confirm" items first. Slice suggestion: (1) contract+schema
> `name`/`icon` + replication plumbing, (2) icon read + Files/Apps rendering
> with pill treatment (playground fixture + baselines first), (3) gateway
> building page + mtime probe + 404 intercept, (4) SWS image bake, (5) the
> skill itself, (6) seed-drive name+icon, (7) staging e2e. write-tests-first
> per AGENTS.md; ui-playground gates on every visual slice.
