# Slice 07 + 03 (UI half) — accepted visual evidence

Desktop shots from the Docker visual gate (mobile variants live beside the
baselines). Fixtures are hermetic: the same `DriveBrowser`/`PreviewPane`
rendered against `MockFileSystemProvider`, no auth/query/apps/attribution
source. Baselines live at
`apps/web/tests/visual/__screenshots__/{desktop,mobile}/playground.spec.ts/`.

- `publish-browser.png` — the one `DriveBrowser`, authenticated (full
  upload/create/hidden toolbar) beside public read-only (no write/auth chrome).
  The diff is exactly the omitted controls. Fixture `publish-browser`.
- `publish-preview.png` — the read-only/source `PreviewPane`: Markdown and SVG
  shown as verbatim source (never rendered), only Download in the header — no
  Save/history/seen-by. Fixture `publish-preview`. (Media still routes to its
  viewer in this mode; that path is pinned by
  `spa/files/preview-presentation.test.ts` and the media glyphs in
  `publish-browser`, not screenshot here because an opened image's async decode
  is non-deterministic in the static harness.)
- `show-hidden-toggle.png` — slice 03: the authenticated Drive default
  (hidden-off, dotfiles filtered) beside the toggle revealed (`.duet-anchor`,
  `.env`, `.notes` listed). Fixture `show-hidden-toggle`.

Unprimed screenshot-critique on all three: no real defects.
