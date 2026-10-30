# Slice 06 — Drive Miller columns and preview

**Depends on:** slice 05.

## Contract unlocked

The core Drive browser adopts the reference's lazy horizontal navigation and
preview silhouette while continuing to use Duet's real file transport and
preview stack.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Port `MillerColumns`, `FileColumn`, depth fades, trail/selected treatments,
  auto-scroll, and keyboard traversal from the source presentation.
- Load one directory through `IFileSystemProvider.list` when its column opens;
  cache by normalized browser path and expose loading/error per column.
- Extend the frontend entry projection to preserve contract kind and symlink
  target; render symlinks as explicit opaque entries rather than dropping or
  following them.
- Project existing app-aware rows into each listed directory so real app
  status/navigation remains visible without corrupting filesystem entries.
- Port the preview-column proportions and empty/selected-folder states while
  reusing Duet's current `PreviewPane`, editor, office/media/PDF rendering,
  attribution/history, download, and conflict behavior.
- Reuse the one open-viewer state for double-click and Enter.
- Display real size in preview metadata. Key any thumbnail cache by path plus
  current ETag, or leave it uncached; Duet mutates stable paths in place.
- Support comfortable/compact row density, long names, deep paths, empty
  directories, per-column retry, and horizontal depth cues.

## API seam

The directory-cache owner calls only `IFileSystemProvider`. Presentation never
imports the REST client. Existing preview and app-aware owners are composed,
not copied.

## Human review surface

Root, deep-path, selected-file, selected-folder, loading-column, error-column,
and empty-directory fixtures with a working preview.

## Verification

- Red tests first for lazy/deduped list calls, path truncation, selection,
  symlink visibility/non-follow behavior, ETag thumbnail invalidation, keyboard
  Left/Right/Up/Down/Enter, retry, and app-aware row projection.
- Run current preview/editor/conflict suites unchanged.
- Visual variable: Miller depth and browser-to-preview proportions.
- Freeze/mask toolbar; crop the browser body and mask filenames/provider data.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and non-blocking `preview-shots`.

## Stays green

Slice-05 state tests and all existing Files behavior.

## Feedback that changes the slice

Column width, preview ratio, density, and depth-cue strength may change. URL
folder deep links are not added; the live reference also keeps this state local.
