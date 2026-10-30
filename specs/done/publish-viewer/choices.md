# Choices ledger — publish-viewer (consolidated)

Every decision made where the spec was silent, re-audited against the final
shipped code at consolidation. Grouped by verdict, least-confident first.
Each entry is standalone. Choices only — gate results and evidence live in
the spec README's evidence ledger and the merge commits.

## Needs your eyes (Example User) — decisions you own

- **Your Drive now hides dotfiles by default.** Opening your own authenticated
  Drive, files starting with `.` (like `.env`) are hidden until you press the
  new "Hidden" toolbar toggle. The spec chose this default and flagged it for
  you. If you want dotfiles visible by default (only the public viewer forced
  clean), it's a one-line default flip; the toggle stays either way.
- **The public banner names the publish creator, not just the workspace.** A
  visitor sees `{workspace name} · {creator's display name} · published with
  Duet`. The "owner" label falls back through creator name → first+last →
  workspace name → the constant `Duet workspace`, and can never be an email
  (schema-enforced). If you'd rather show only the workspace, the projection
  swaps in one place in the backend.
- **The folder viewer's big heading is the published folder's name.** Your
  ~5-minute checkpoint window passed silently, so I resolved it on evidence:
  the shared component's default hero said "Drive · Browse the folders and
  documents in this drive" — product-internal copy on a public page, with the
  published root's name shown nowhere. Public pages now show the root name +
  "A read-only view of these published files.", and nested breadcrumbs root at
  that name. All shipped as display-only props; trivially reversible.
- **Two cosmetic notes from the unprimed critique were left as-is:** the hero
  glyph is the same hard-drive icon the authenticated Drive uses (reads
  slightly odd for a publish), and the tagline uses the design system's
  muted-text contrast. Both are one-prop changes if you want them.

## Known limits — verified honest, not fixable in this run

- **The staging e2e is the only execution proof for the re-pinned live
  journeys.** The real-VM provisioning journey and the staging publish leg now
  assert the new grammar (bare URL = viewer HTML that never contains the
  published bytes; source only via `?raw`, text/plain), but neither can run
  locally. They run in `bun run e2e:staging` — pending your approval.
- **The public route's "makes no authenticated call" pin is source-level**
  (no auth/session imports; public-mode props asserted) because the repo's
  React test harness never runs effects. The behavioral credential pin lives
  one layer down: the provider asserts `credentials: 'omit'` on every fetch
  and zero network calls for mutations. The kill-gate Chromium script is the
  end-to-end behavioral proof (opt-in, not part of `bun test`).
- **The Docker visual gate tolerates ~0.5% pixel drift per full-page shot, so
  copy-sized changes pass silently** (discovered when the hero fix produced no
  visual failure). Copy is pinned in unit tests instead; the pixel gate
  screens layout.
- **The publish skill states the edge hosts as prose** (`service.example.invalid`,
  staging `staging.example.invalid`) — no discovery endpoint exists to ask.
  The staging e2e exercises the real staging host.
- **Publishing onto a symlinked anchor directory fails closed.** The
  confinement check compares the fully-resolved `servePath` against
  `realpath(driveDir)/anchorRelativePath` (the anchor path is not itself
  realpath'd), so if the anchor directory is a symlink, even legitimate
  in-anchor reads 404. This costs availability of that one unusual publish
  shape, never confinement — an adversarial audit confirmed it leaks nothing.
  Not worth realpath'ing the anchor on every read unless such publishes become
  a real use case.

## Known-and-left — pre-existing patterns the review noted, not this feature's

- **Publish `kind` lives in two Convex columns** (`publishes.kind` and
  `anchors.settings.kind`), written once from one arg and read by different
  subsystems. Can't diverge today (single writer, no kind-mutation);
  denormalization inherited from the anchor model, not introduced here.
- **`publishServedPaths` is a write-only audit table** (one
  `publish.new_file_served` event, queried only for self-dedup) — a
  pre-existing audit apparatus, untouched by this feature.
- **Minor cross-package dedup left as cosmetic:** the edge re-lists the two
  publish edge hosts the contract also enumerates; the `raw`/`list` selector
  tokens are spelled in three places without a shared constant; the
  `/publish/` internal-rewrite prefix is encoded in the edge, the controller,
  and the route folder. All single-writer, none a correctness risk.

## Sound — structural decisions, one owner each

**Contract (`@repo/contract`)**
- Shared predicates live in `src/files` beside `FileEntry`:
  `isHiddenDriveEntry` (leading dot, no `.env` special-case),
  `filterDriveEntries`, and `isTextLikeDriveFile` (union of the two
  pre-existing text lists + `svg`; `xml` was in neither and stays out; a
  dotless name equal to an extension is not text-like).
- `classifyPublishRequest` lives in `src/edge` (the spec's single-owner map
  assigns the request-mode selector to contract). Selector *presence* is
  authoritative (`?raw=` empty counts); both selectors → `invalid` → 400
  `{error:'invalid_selector'}` — the same code the gateway returns, so the
  two layers can never disagree.
- The viewer descriptor `{workspaceName, ownerName, rootName, kind}` is a
  non-strict schema (unknown/private fields strip on parse), serialized into
  the single internal header `x-duet-viewer-descriptor`, required in the edge
  resolve response. `rootName` is the anchor basename via a dedicated helper
  (not the slug helper, whose fallback is wrong for display).

**Gateway**
- Anchor confinement for public reads took two review passes to get right, and
  the history is worth keeping: the original slices guarded only the *request
  path*; the whole-spec review added `publicConfinement` but scoped it to
  *final-component* symlinks; the close-spec audit proved an *intermediate*
  directory symlink still leaked, so the check now runs on the fully-resolved
  `servePath` for every branch. The lesson: confine the realpath'd target, not
  the requested path, and do it once at the single serve point — not per
  symlink shape.
- The public endpoint reuses `serveDriveGet` through two injected policies —
  `contentTypeOverride` (text-like → `text/plain; charset=utf-8`) and
  `listingPolicy {filterHidden, projectPath}` — the authenticated `/v1/files`
  path passes neither and is byte-identical.
- Containment and `.env*` rejection run before selector validation (a
  traversal probe is 404 regardless of selector); selector misuse reuses the
  streamer's existing 409s; listing paths are projected into the publish-root
  namespace with `node:path` `relative`.

**Edge**
- Viewer assets relay via an explicit prefix branch (`/_next/`, `/__nextjs`,
  `/favicon.ico`, `/manifest.json`) gated to publish hosts, before publish
  route parsing — not a Next `assetPrefix`, not a parser exemption.
- One dispatch (`dispatchPublish`), one gateway rail (`proxyToGateway`, shared
  with app routes), one viewer rail (`proxyToViewer`). Viewer-bound requests
  are stripped of `cookie`, `authorization`, `host`, and every caller
  `x-duet-*`; the gateway bearer never rides the viewer branch.
- The page branch still resolves the publish before proxying (existence /
  paused / env-anchor checks kept for bare requests).
- Served-path reporting fires only on successful nested `?raw` file responses
  — never viewer HTML or `?list` JSON; root-file publishes never report.
- `noindex` + the existing 30s bounded cache stay on all publish responses.

**Backend**
- Anchor coexistence is exactly four caller allow-list edits;
  `getOrCreateAnchorForPath`, the schema, and `anchorHasLiveConsumer` are
  untouched. An adopted anchor keeps its original creator's kind forever
  (pre-existing behavior, now pinned by the 15-case matrix test).
  Kind-conflict messages were updated to name the new allow-lists.
- A publish whose creator row is missing resolves as unresolvable (`null`),
  never a placeholder identity.

**Web**
- A paused publish is served entirely by the edge's own paused page, upstream
  of the viewer, so the viewer has no paused state — the closeout review
  deleted the unreachable `paused` notice, fixture, and i18n keys rather than
  leave three files pretending a state the state machine can't reach.
- `PublicFileSystemProvider` (third `IFileSystemProvider` implementation):
  `stat` prefers the parent `?list` entry; a single-file root uses a
  `bytes=0-0` range probe whose `content-range` total also covers the empty
  file via the 416 shape — so R3 closed with no new public verb and no
  listing-schema amendment. Mutators throw a typed read-only error
  synchronously before any fetch. Fetch failures surface a self-owned
  `PublicFileSystemError` (no authenticated client import). The provider is
  registered in the web boundary linter's network-owner allow-list (the
  sanctioned mechanism).
- `DriveBrowser` uses a nested `capabilities` discriminated union — public
  mode has no write/menu/activity props at all (no fake callbacks);
  navigation/open callbacks stay common. Display-only `hero` and breadcrumb
  root-label overrides carry the publish identity.
- `PreviewPane` takes a `mode` defaulting to the authenticated
  editable/rich/attributed behavior, so existing call sites are unchanged;
  one pure module (`preview-presentation.ts`) owns the text/binary/chrome
  decision. SVG counts as text only in source mode — authenticated rich mode
  still renders it as an image. Download stays available in read-only mode
  (a read, not a write).
- The show-hidden toggle is ephemeral React state on the browser-state owner
  (default off), filtering rows, the footer byte sum, and the status dialog
  from one derivation; the provider and gateway never learn about it.
- `PublishViewerController` is a DOM-free class in `spa/publish/` with an
  injected provider and history port; deep-link file-vs-folder typing is
  provider-derived; a deeper path under a single-file publish is not-found;
  search resets on folder navigation; the provider base URL is
  `window.location.origin/<ws>/<pub>` (the same-origin public grammar).
- `PublishViewerShell` owns banner/layout/notices only; the empty-folder
  notice is publish-scoped (the shared Drive empty state assumes an editor);
  locale is `en` with all copy i18n-backed (es-419 mirrored).

**Skills / journeys**
- The publish skill's env surface is `$DUET_API_URL` + `$DUET_API_KEY` only;
  the build-apps boundary paragraph lives inside the existing "Which Surface"
  heading; the roster's "no static-hosting language" test bans unambiguous
  app-server tokens rather than everyday words.
- The 60s demo reports the bare shareable URL and probes liveness via `?raw`;
  the kill-gate script waits for the client-mounted viewer shell and asserts
  the descriptor round-trips into the banner (path fidelity is the
  controller tests' job).
