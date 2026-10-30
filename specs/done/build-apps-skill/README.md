# build-apps skill + app identity + building page — rationale record

**Status: shipped to staging 2026-07-17.** `MAP.md` in this folder is the
binding decision record from the quadrant walk (16-decision ledger); the
reaction sheet that fixed the visual taste lives at
https://claude.ai/code/artifact/62391707-81d8-4a8f-8bef-18fa6ae41e03
(Direction D icon treatment, V1 building page — those two picks drove every
visual call below).

## What shipped

Agents get a `build-apps` default skill (the 17th registry skill): one
blessed stack, publish-early registration, a mandatory generated icon for
user-facing apps, static serving via a pinned `static-web-server`, theme
param, mobile rules, final `impeccable` polish. The product grew optional
`name`/`icon` on apps end to end (contract → convex → REST → share
replication → Files rows and the Apps page), a gateway building page that
replaces raw 502s/404s while an app's folder is hot, and a required
`build-app` staging leg where a real agent builds a real app from a natural
ask.

Live acceptance evidence (ran twice, consecutively green): registration
~91 s after dispatch, generated icon (81 KB), visibility public without the
harness's fallback flip firing, app URL served the requested marker on the
first poll (~119 s), `?theme=dark` 200, resource cleanup verified with zero
orphans. (Run-log history; the artifacts were not retained in-tree.)

## The reason it works this way

- **Icon is a file in the app folder, not stored bytes.** exe VMs never
  sleep, so serving off VM disk is always available; Syncthing already moves
  the folder, so share replicas inherit icons with zero plumbing; and the
  wire stays a string. Caching is solved by versioned URLs instead of blob
  storage: a same-value `icon` PATCH deliberately bumps `updatedAt`, and only
  version-selected file GETs receive `immutable` cache headers.
- **Status never touches the icon.** The walk fixed Direction D: the icon is
  brand, the pill is state. `app-status.ts` stays the one status owner; the
  Files row keeps the real folder name secondary because file operations must
  never lie about their target.
- **The building page lives in the gateway,** because `resolveForEdge` never
  gates on runtime status — reconciling/failed apps already proxy through.
  Containment is a pure verdict (`decideBuildingFallback`): GET/HEAD that
  accept HTML, hot folder, and (for real upstream responses) root-path 404s
  only — so a static server's own 404s get covered during a build without
  ever masking a real response. Future mtimes are ignored, or one extracted
  archive would pin the page open for years.
- **Two equality contracts, not one.** `sameGatewayAppRuntimeConfig` (no
  `name`) drives process decisions; `sameGatewayAppConfig` (with `name`)
  drives desired/report exactness. A single comparator either restarts
  healthy apps on rename or lets stale reports pass. Supersession of queued
  reconcile work judges *runtime* identity — a metadata drift must not cancel
  runtime work.
- **The skill teaches reality, not aspiration.** Register-before-code
  returns 502 `app_reconcile_failed` and self-heals within ~30 s of code
  landing; the skill says so verbatim, because the first thing an agent does
  with a surprising 502 is invent a workaround.
- **Hard cutover, no fallbacks.** `static-web-server` v2.43.0 exists because
  it is baked into the image (Syncthing-style pin, SHA
  `da3c4e59…`); there is no `bunx serve` path anywhere, per the map. The
  skill was held unmerged until the new image was verified live, because the
  skills rail publishes a merged bundle to every VM at deploy time — a skill
  that teaches a missing binary bricks static builds.

## Invariants that must keep holding

- Icons render clean — never tinted, ringed, or badged by status; the only
  status effect is the disabled whole-row dim, which the icon inherits with
  the rest of the row. Fallback is the status-tinted glyph. Pills appear on
  unhealthy rows only.
- File operations (rename/delete dialogs, breadcrumbs, aria) always name the
  directory entry, never the display name.
- `icon` never enters `GatewayAppConfig`; `name` never enters
  `sameGatewayAppRuntimeConfig`.
- Metadata-only updates never push a reconcile, never transition
  `runtimeStatus`, never emit `app.deployed` — and still fan out to replicas
  through the one convergence rule.
- `updatedAt` strictly advances on every metadata-only icon PATCH
  (same-value included);
  only version-selected file GETs get long caching; unversioned file reads
  keep their exact prior headers.
- Building-page replacement of a real upstream response: root path + 404 +
  hot only; everything else passes through byte-exact; probe errors degrade
  to today's behavior, never a 500.
- The probe stays bounded: root + one level, capped lstat count, no symlink
  traversal, `.env`, `.env.*`, and `.duet` names excluded from display, future mtimes
  ignored.
- VM system keys mint `[ai, apps]` for their workspace, and a live key with
  a stale scope set is rotated at mint, never reused.
- `build-app` stays in `REQUIRED_STAGING_LEGS`; acceptance fails when
  resource cleanup fails.

## Pointers into the code

| Concern | Owner |
|---|---|
| Wire grammar, safe paths, equality pair | `packages/contract/src/apps/index.ts`, `packages/contract/src/relative-path/` |
| Durable metadata + update semantics | `packages/backend/convex/domains/apps/model.ts` (`registerAppImpl`, `updateApp`) |
| Replica convergence incl. metadata fan-out | `packages/backend/convex/domains/apps/replication.ts` (`reconcileReplicasForOriginApp`, `metadataWasExplicitlyUpdated`) |
| VM key scopes + stale-scope rotation | `packages/backend/convex/domains/apiKeys/model.ts` (`vmModelScopes`, `mintVmModelKeyForWorkspace`) |
| Icon component + display name | `apps/web/spa/apps/app-icon.tsx`, `app-status.ts` |
| Versioned caching + proxy exemption + image-fetch read-event suppression | `packages/gateway/src/routes/files.ts`, `apps/web/src/server/duet-proxy.ts` |
| Building page trio | `packages/gateway/src/apps/{building-page,build-activity,building-fallback}.ts`, composed in `routes/apps.ts` |
| SWS pin + image probes | `packages/vm-image/Dockerfile`, `scripts/verify-image.ts` |
| The skill | `packages/skills-registry/skills/build-apps/` |
| Seed identity | `packages/seed-drive/manifest.ts`, `content/welcome/hello-app/icon.png` |
| Live acceptance | `packages/test-harness/src/apps-live.ts` (required leg in `staging-e2e-synthetic`) |

Tests that pin the sharpest edges: rename-does-not-restart (PID identity,
`packages/gateway/src/gateway.test.ts`), building-fallback decision table +
byte-exact passthrough (`packages/gateway/src/apps/building-fallback*.test.ts`),
future-mtime cold (`packages/gateway/src/apps/build-activity.test.ts`),
stale-scope rotation (`packages/backend/src/api-keys.test.ts`), metadata-only
same-value icon PATCH bumps `updatedAt` (`packages/backend/src/apps.test.ts`).

## Dead ends and divergences worth keeping

- **Both planning drafts' SWS SHAs were wrong** (two different wrong values
  for two different versions). The pin that shipped was resolved against the
  GitHub release and verified by independent download — never trust a
  planning doc's checksum.
- **The live acceptance caught the release-blocking bug the whole test
  pyramid missed:** VM keys had only the `ai` scope, so no agent could ever
  register an app (403). Everything else — skill prose, SWS, icon — the
  agent did perfectly on the first real run. Scripted E2E with a real agent
  earns its cost.
- **Fresh-provision `unhealthy` flakes were the old image,** not new code:
  workspaces went active in ~11 s on the image gateway, then died during
  release convergence (old-updater crash-loop). The cutover image ended it.
  Also: create sessions only after full release convergence, or they report
  `dispatched:false` and prompts may never deliver.
- **`bunx serve` was the walk's first static answer** (~90 MB RSS, measured
  during the walk, not retained as a benchmark);
  killed for a baked SWS (~4–8 MB) once image rebuilds were declared cheap.
  The interim bun one-file fallback was cut entirely — no fallback server
  exists, by decision.
- **The cutover's "reprovision the fleet" collapsed to nothing:** staging had
  zero active workspaces. One pre-existing unhealthy workspace (`walter`)
  holds a deferred reprovision blocked by its own stale session.
- **Seed icon** was generated straight through the AI gateway (not the VM
  `duet model` CLI) and palette-compressed to the 286,543-byte PNG that is
  checked in (the raw generation was ~1.2 MB, over the ≤1 MB contract).
