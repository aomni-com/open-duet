# Publish viewer — publish is a read-only public file/folder viewer

Publishing a path in Duet exposes it as a **read-only, public, anonymous
viewer** that shows the **source** of files. A published folder opens a
file-browser UI; clicking a file opens it in the matching viewer showing its
source — a text viewer for text, never a rendered web page. `index.html` is
shown as its HTML source, not served as a live page. Hosting and rendering are
what **apps** are for; publish is "show these files to people."

This replaced the previous publish, which was a transparent raw-byte reverse
proxy at the edge — so `index.html` rendered as a live page and any published
byte was reachable at the bare URL. That behavior is gone (hard cutover, no
compat shim). The `publishes` table did **not** change: no visibility column,
no migration. What changed is how a publish URL is *served*, not how it is
*authored* — the existing `/v1/ws/{ws}/publishes` CRUD is still the only
authoring contract.

## Why it works this way

- **Source, not hosting, is a safety boundary, not just a product choice.** The
  old raw-render publish executed whatever HTML/SVG/JS a workspace published,
  anonymously, on a Duet origin. Forcing every text-like response to
  `text/plain` (SVG included — it can carry script) closes that hole by
  construction: there is no code path that renders published bytes.
- **The viewer reuses the authenticated Drive's own components.** Rather than
  build a second file browser, the same `DriveBrowser` and `PreviewPane` render
  both the authenticated editable Drive and the anonymous read-only publish,
  discriminated by explicit capability/mode props. This is only possible
  because presentation already flowed through the `IFileSystemProvider` seam;
  the viewer is a third provider implementation, not a fork. `FilesSurface` is
  deliberately *not* reused — it is welded to react-query, the workspace-apps
  context, attribution, and write mutations, none of which a public viewer may
  touch.
- **The public URL grammar stays `service.example.invalid/<ws>/<pub>/*`, query-branched.**
  A bare request (any ordinary query) is the viewer; the reserved `?raw` and
  `?list` selectors are the only way to reach bytes or a listing. Keeping the
  same grammar (rather than a new `/publish/` prefix) means every already-shared
  publish link keeps working and there is exactly one public address per
  publish. `/publish/...` exists only as the *internal* apps/web route the edge
  rewrites to.
- **Two request branches with disjoint credentials.** The viewer page and its
  `/_next/*` assets proxy to a configured apps/web origin with every caller
  credential stripped; `?raw`/`?list` proxy to the in-VM gateway with only the
  gateway bearer. Neither branch can leak the other's authority: the gateway
  bearer never reaches apps/web, and no caller cookie/session/`x-duet-*` header
  reaches either upstream on a public request.

## Invariants (must stay true)

- **The publish URL always serves the viewer.** No default request returns
  published bytes. Bytes come only via `?raw`, a directory JSON only via
  `?list`, a folder archive only via `?zip` (added post-close; same visibility
  policy as the viewer); more than one selector together is a `400`. The
  selector predicate has one owner, `classifyPublishRequest`
  (`packages/contract/src/edge/index.ts`), and the gateway's `publicSelector`
  (`packages/gateway/src/routes/publishes.ts`) is the same presence test, so
  the two layers cannot disagree on a URL.
- **Text is shown as source, never rendered.** Text-like `?raw` responses
  (`html`, `svg`, `js`, `css`, `md`, `json`, `yaml`, …) are served
  `text/plain; charset=utf-8`; SVG is classified as text. Media
  (`png/jpg/pdf/audio/video`) keep their real type so their viewers render
  them. The text classifier is `isTextLikeDriveFile`
  (`packages/contract/src/files/index.ts`), shared by the gateway override and
  the web viewer's source mode — one list, never re-derived.
- **The public route is provably unauthenticated.** `app/publish/*` lives
  outside the `(product)` route group (the only group that mounts
  `AuthProvider`), classifies as `'other'` /
  `isProtectedProductPath === false`, reads no cookie, carries no session, and
  makes no authenticated API call. Its only trusted input beyond the URL is the
  edge-injected, already-validated `x-duet-viewer-descriptor` header. The
  browser data path is `PublicFileSystemProvider` alone
  (`credentials: 'omit'`, no authenticated client import). Pinned by
  `apps/web/src/routing/publish-viewer-route.test.ts` and the kill-gate script,
  not left to omission.
- **Reads are confined to the published anchor subtree.** `?raw`/`?list`
  resolve through `normalizeDrivePath` + anchor-relative joining; `..` and
  encoded/double-encoded traversal are rejected; a directory symlink addressed
  by `?list` is refused (`path_is_symlink`). The load-bearing guarantee is that
  the **fully-resolved `servePath`** — after every symlink on the path is
  realpath'd, whether a final-component link or an intermediate directory link
  — must stay inside the anchor subtree and re-clear the serving floor,
  or the read is a 404. The request path alone is never trusted, because a
  symlink target the request never named would otherwise escape. This
  confinement (`publicConfinement` in `serveDriveGet`,
  `packages/gateway/src/routes/files.ts`) was found and closed by review, not an
  original slice — in two passes: the first guarded only the request path, and
  the close-spec audit caught that it then guarded only *final-component*
  symlinks, leaving intermediate directory symlinks able to leak until the
  check was moved onto the resolved `servePath` for every branch.
- **The serving floor is absolute; dotfile-hiding is presentation.** (Revised
  post-close, 2026-07-22, Example User's call: publishing a folder publishes
  everything in it.) The gateway never serves `.env*`, `.git`, `node_modules`,
  or `.duet-anchor` at any depth — one owner, `isPublishExcludedDrivePath`
  (`packages/contract/src/publishes/index.ts`), applied to request paths,
  resolved serve paths, listings, and `?zip` walks. Ordinary dotfiles ARE
  served and listed; the viewer hides them by default behind a banner
  show-hidden toggle, mirroring the authenticated Drive's vocabulary.
- **One anchor, many consumers.** A path may back a publish plus a compatible
  app/agent/share-root at once; `getOrCreateAnchorForPath` returns the
  unchanged active anchor and each entity references it. `share-mount` is
  excluded. Deleting one consumer leaves the anchor active while another
  remains (`anchorHasLiveConsumer`). This is four caller allow-list edits — the
  adoption mechanism and schema are untouched.
- **The authenticated Drive hides dotfiles by default.** A `showHidden` toggle
  (default off) reveals them. This is a deliberate change to the authenticated
  Drive's default that this feature owns, superseding `drive-shell-port`'s
  earlier no-toggle stance (see below).
- **`noindex` + a bounded 30s cache** stay on every publish response.

## Pointers into the code

- **Contract** — `packages/contract/src/files/index.ts` (`isHiddenDriveEntry`,
  `filterDriveEntries`, `isTextLikeDriveFile`);
  `packages/contract/src/edge/index.ts` (`classifyPublishRequest`,
  `ViewerDescriptorSchema`, `DUET_VIEWER_DESCRIPTOR_HEADER`,
  serialize/parse helpers).
- **Gateway** — `packages/gateway/src/routes/publishes.ts` (selector
  validation, hidden-segment rejection, `publicConfinement`);
  `packages/gateway/src/routes/files.ts` (`serveDriveGet` with the injected
  `contentTypeOverride`/`listingPolicy`/`publicConfinement` policies — the
  authenticated `/v1/files` path passes none and is unchanged).
- **Edge** — `apps/edge/src/index.ts`: `tryViewerAsset` (the `/_next/*`,
  `/favicon.ico`, `/manifest.json` relay before route parsing),
  `dispatchPublish`, `proxyToViewer` (credential-stripped viewer rail),
  `proxyToGateway` (bearer-only gateway rail, publish branch strips caller
  cookies + `x-duet-*`).
- **Backend** — `packages/backend/convex/domains/publishes/model.ts`
  (`resolveForEdge` projects the viewer descriptor; `createPublish`);
  anchor coexistence is the `compatibleExistingKinds` allow-lists in the
  `publishes`/`shares`/`apps`/`agents` domains. Pinned by
  `packages/backend/src/publish-anchor-coexistence.test.ts` (15-case matrix).
- **Web** — `apps/web/app/publish/[workspaceSlug]/[publishSlug]/[[...path]]/page.tsx`
  (server page, descriptor-only); `apps/web/spa/publish/`
  (`publish-viewer-controller.ts` DOM-free URL↔path class,
  `publish-viewer.tsx` mount, `publish-viewer-shell.tsx` banner/layout/notices);
  `apps/web/spa/files/lib/public-provider.ts` (`PublicFileSystemProvider`);
  `apps/web/spa/files/drive-view.tsx` + `preview-pane.tsx` +
  `preview-presentation.ts` (the shared read-only capability/mode contracts).
- **Skill** — `packages/skills-registry/skills/publish/SKILL.md`; the app-vs-
  publish boundary paragraph in `.../skills/build-apps/SKILL.md`.
- **Transport proof** — `packages/test-harness/scripts/publish-viewer-kill-gate.ts`
  (opt-in real-Chromium gate; run from `packages/test-harness`).

## The reason it was risk-sliced this way

The whole approach hinged on one unproven assumption: that a Next.js page
proxied through the edge could load its `/_next/*` assets anonymously. The edge
turns any ≥2-segment path on the publish host into `<ws>/<pub>/…`, and apps/web
sets no `assetPrefix`, so a proxied viewer's asset requests would be misparsed
as publishes. The first slice was a **kill gate**: build no viewer UI until a
real browser loads the page and all its assets anonymously through the edge. It
passed — an explicit edge asset-relay branch (chosen over a Next `assetPrefix`
or a parser exemption) routes `/_next/*` to the viewer origin before publish
parsing can see them. Had it failed, the plan was to re-cut toward a static
bundle or a dedicated public app.

The other early risks resolved without re-cutting: deep-link file-vs-folder
typing and single-file size (for PreviewPane's 25 MB office ceiling) came
entirely from the provider — the parent `?list` entry, or a `bytes=0-0` `?raw`
range probe whose `content-range` total covers even empty files — so **no third
public verb and no listing-schema field were needed** (the R3 fallback was
avoided). The edge gained a typed per-environment viewer origin
(`DUET_WEB_ORIGIN`), never trusting the inbound `Host`. The banner identity
came from a validated `viewer` descriptor projected in `resolveForEdge`, with
`ownerName` a non-email display label (creator name → first+last → workspace
name → `Duet workspace`).

## Dead ends and things deliberately not done

- **Rendered publishes are gone, on purpose.** The raw-render reverse proxy was
  the whole point of the old feature; it is the thing removed. Tests that
  asserted raw bytes at the bare URL were re-pinned to assert viewer HTML at the
  bare URL and live source at `?raw` — the old contract was proven wrong, not
  worked around.
- **An unreachable `paused` viewer state was removed.** An early cut gave the
  viewer shell a `paused` notice, but the edge serves its own paused page
  *before* proxying to the viewer, so the viewer can never receive a paused
  state. The closeout review deleted the notice, its fixture, and its i18n keys
  rather than leave three files pretending a state the machine can't reach; the
  paused-publish surface is the edge's own page (`edge-paused`).
- **No new REST/MCP publish API.** The `publish_file` MCP TODO was explicitly
  not revived; the existing CRUD is the authoring contract.
- **`FilesSurface` was not reused and `serveDriveGet` was not forked** — reuse
  happened at the `IFileSystemProvider` seam and via injected gateway policies
  instead.

## Cross-spec: `drive-shell-port`

`drive-shell-port` reworks the same `apps/web/spa/files/` presentation and
shares the `IFileSystemProvider`/`PreviewPane` seam. Two of its stated
invariants were superseded or scoped here, and both specs were amended (commit
`a715a401`):

- Its "no hidden-files toggle" stance is superseded — this feature adds the
  authenticated-Drive `showHidden` toggle (default off).
- Its "folder/file nav stays client-local, no URL deep links" constraint stays,
  but applies only to the **authenticated** Drive; URL↔path deep-linking lives
  solely on the separate public `PublishViewerController`.

When `drive-shell-port` reworks these components it must preserve the
`DriveBrowser` capability union, the `PreviewPane` `mode` prop + its
`preview-presentation` decision owner, and the show-hidden toggle.

## Decisions ledger

Everything decided where the spec was silent — including the four decisions
that carry a "your call" flag for Example User (dotfiles-hidden-by-default, the
banner's creator-owner label, the published-root hero name, and closing on
local evidence without the staging e2e) — lives in
[`choices.md`](choices.md), consolidated and verified against the shipped code.
That, not the diff, is the review surface for this unsupervised build.

## Visual provenance

The accepted visual evidence is the standard the viewer was held to — that it
reuses the authenticated Drive's appearance faithfully, adding only the publish
banner and read-only framing:

- [`assets/07-readonly-components/`](assets/07-readonly-components/) — the
  shared `DriveBrowser`/`PreviewPane` rendering authenticated Drive beside
  public read-only, and the default-off vs revealed show-hidden toggle. This is
  the "same component, two modes" proof.
- [`assets/09-viewer-chrome/`](assets/09-viewer-chrome/) — the composed public
  viewer: folder root, deep folder (breadcrumb rooted at the published name),
  text-as-source, media, single-file, empty, error, and the banner crop, at
  desktop and mobile widths. The README there names what each shot proves.
- [`visualizations/slice-graph.html`](visualizations/slice-graph.html) — the
  dependency graph the parallel build followed.

## Status

Shipped in-tree on the `worktree-moonlit-nibbling-castle` build branch: all
twelve planned slices, plus the whole-spec review's fixes (two anchor-
confinement leaks, a credential-strip gap, the unreachable-paused removal, and
a workspace-named-`publish` deep-link fix). Local gates, the real-Chromium
kill-gate, and the Docker visual gate are green. The live staging e2e
(`bun run e2e:staging`) was **not** run — Example User chose to close on local
evidence; it remains the only unrun proof of the re-pinned live journeys
(real-VM provisioning, staging publish leg, 60s demo) and the real anonymous
deep-link path, and is the first thing to run if the public journey is ever in
doubt.
