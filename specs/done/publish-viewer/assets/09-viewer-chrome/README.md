# Slice 09 — Published viewer chrome, accepted visual evidence

Desktop shots from the Docker visual gate (mobile variants live beside the
baselines at `apps/web/tests/visual/__screenshots__/{desktop,mobile}/
playground.spec.ts/`). Every fixture renders the production
`PublishViewerShell` against `MockFileSystemProvider` — no auth, query, apps, or
attribution source. The shell owns only the banner + layout + notice
composition; `DriveBrowser` and `PreviewPane` stay the sole owners of listing
and file rendering, in their read-only public modes.

- `publish-viewer-banner.png` — the light identity banner on its own:
  `{workspaceName} · {ownerName} · published with Duet`. Workspace name carries
  the weight, owner is secondary, attribution is quietest. Three rows: normal,
  a long workspace+owner stress case (truncates, never overflows), and dark
  theme. Fixture `publish-viewer-banner`.
- `publish-viewer-folder-root.png` — a folder publish at its root: the banner
  over the bare read-only `DriveBrowser`. Same component as the public column
  of the slice-07 `publish-browser` shot, with the publish-specific hero: the
  heading is the published root's name and the tagline is the read-only
  publish copy, never the authenticated product's "Drive" identity. Fixture
  `publish-viewer-folder-root`.
- `publish-viewer-deep-folder.png` — a nested folder: the breadcrumb roots at
  the publish (`marketing-site › campaigns › … › creative-assets`) and never
  above it; long names truncate. Fixture `publish-viewer-deep-folder`.
- `publish-viewer-text-source.png` — an HTML file shown as verbatim source, not
  executed; header carries only the name/size and Download. Fixture
  `publish-viewer-text-source`.
- `publish-viewer-media.png` — a raster image routes to the read-only media
  viewer (header + zoom + sized image stage), proving media still opens in its
  viewer in read-only mode. Fixture `publish-viewer-media`.
- `publish-viewer-single-file.png` — a single-file (`kind: 'file'`) publish
  opens its preview stack directly under the banner, no folder chrome. Fixture
  `publish-viewer-single-file`.
- `publish-viewer-empty-folder.png` — an empty published folder gets a
  publish-scoped empty notice (`This folder is empty`), not the shared Drive
  empty state whose copy/icon assume an authenticated editor. Fixture
  `publish-viewer-empty-folder`.
- `publish-viewer-error.png` — a friendly, localized error notice with Retry
  (never the raw fetch error). Fixture `publish-viewer-error`.

Not copied here but covered by baselines and reviewed: `publish-viewer-svg-source`
(SVG shown as source — the script-in-SVG hole stays closed), `publish-viewer-loading`,
`publish-viewer-not-found`, and every mobile variant.

## Reversible decisions recorded here

- **Banner treatment.** A light, non-sticky top bar (`bg-muted/25`, hairline
  border) with a dot-separated single line that wraps and truncates under width
  pressure. Weight hierarchy: workspace (medium/foreground) → owner (muted) →
  attribution (quietest). Reversible: sticky, a Duet mark, or a "bare, no
  banner" reversal is a prop away.
- **Banner content.** Exactly the three spec parts; `rootName` is intentionally
  left out of the banner (the content — Drive heading, breadcrumb, or file name
  — already carries it).
- **Loading/error visuals.** Centered notices under the always-present banner:
  loading shows a reduced-motion-safe spinner; error shows a generic localized
  message + Retry rather than the raw provider error (friendlier, deterministic,
  no internals leaked to anonymous visitors).
- **Empty-folder composition.** The shell renders its own empty notice for a
  zero-entry folder instead of the shared `DriveBrowser` empty state. An empty
  folder has no listing for `DriveBrowser` to own, and its authenticated copy
  ("Upload files or create a folder") + search icon are wrong for a public
  read-only page (flagged by the unprimed critique). Reversible: delete the
  branch to fall back to the shared empty state.
- **Locale.** The mount keeps `locale="en"`. The anonymous public viewer has no
  user/locale signal and the `ViewerDescriptor` carries none, so English is the
  honest default; all copy is i18n-backed (`duetApp.publishViewer`, mirrored in
  `es-419`) so threading a real locale later is a one-line change.

## Contract gaps reported (not fixed here — out of slice scope)

- **A paused publish never reaches the viewer.** The edge serves its own paused
  page before proxying to the viewer, so the viewer has no paused state — the
  closeout review removed the unreachable `paused` notice, its fixture, and its
  i18n keys. The paused-publish surface is `edge-paused` (the edge's own page),
  not this viewer.
- **Shared `DocumentTile` truncation/mobile density.** Long document names mix
  ellipsis-clamp and full wrap, and mobile cards are tall — shared-component
  behavior, out of this slice's scope.
