# Slice 05 — Drive toolbar, breadcrumb, and view controls

**Depends on:** slice 02. May run after slice 01 in parallel with Agents.

## Contract unlocked

Port the reference Drive control hierarchy over real directory metadata and one
explicit browser-state owner.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Define one Files browser state for open directory chain, selection, filter,
  sort, density/view mode, directory cache, and open viewer.
- Port `DashboardToolbar` and `PathBreadcrumb` presentation directly.
- Add Show groups, current-directory search, name/modified/kind sorting,
  Duet-only size sorting, comfortable/compact/Library switch, and breadcrumb
  collapse.
- Derive kind/filter groups from real directory/file names and extensions.
- Omit the reference URL group; Duet has no URL-file metadata contract.
- Count/filter only current/open loaded entries; never label the result as a
  complete workspace count.
- Place real Duet create/upload/activity affordances in the reference toolbar
  rhythm without changing their behavior.
- Inject the current `SpaApi` file methods already implemented by
  `DuetApiClient` into `RestFileSystemProvider`; no new method or endpoint.

## API seam

Browser state depends on `IFileSystemProvider` and pure entry projections.
Toolbar/breadcrumb are controlled presentation. `RestFileSystemProvider`
remains the sole transport adapter.

## Human review surface

A provider-backed Drive fixture with filters, sorting, density/view selection,
long breadcrumbs, and real-shape actions above a masked browser body.

## Verification

- Red tests first for filter/sort derivation (including real byte size),
  path-chain updates, count scope, URL-group absence, and provider injection.
- Visual variable: control-strip and breadcrumb hierarchy only.
- Crop toolbar/breadcrumb; mask the file browser beneath it.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and a non-blocking `preview-shots` checkpoint.

## Stays green

Existing file-provider, file-operation, share, and preview tests.

## Feedback that changes the slice

Control ordering, widths, and responsive collapsing may change. Workspace-wide
search/count semantics require a missing contract and are not inferred.
