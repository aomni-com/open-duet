# Slice 08 — Drive operations and exceptional states

**Depends on:** slice 07.

## Contract unlocked

Every current Duet Files capability works inside the ported browser and uses a
coherent reference-style feedback/dialog language.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Recompose upload/drag-drop, create file/folder, rename, copy, move, delete,
  download, share, activity, attribution, seen-by, history, and notices into the
  new toolbar/column/preview ownership.
- Preserve app-aware open, broken-app repair, phantom row, move, and delete
  semantics in Miller and Library modes.
- Preserve optimistic changes, abort/cancel, progress, conflict/retry, partial
  app/filesystem failure, permission denial, share callback, and unavailable
  share states.
- Preserve the server-enforced reserved-path behavior. The authenticated Drive's
  show-hidden toggle (publish-viewer slice 03, default off) is a read-only
  listing convenience and does **not** expose reserved `.duet` paths to writes —
  server enforcement stands. This supersedes the earlier "no hidden-file toggle"
  invariant; rework the toolbar to keep the toggle, not drop it.
- Ensure dialogs/popovers/menus use one portal/focus stack and are not clipped
  by the browser's overflow owners.
- Remove obsolete current Files list markup only after its last behavior owner
  is represented in the new surface.

## API seam

Existing provider/share/attribution/app-operation owners remain unchanged.
The new browser supplies selected entry/path and refresh callbacks; it does not
reimplement operations.

## Human review surface

A runnable interaction fixture for each operation plus focused upload,
conflict, destructive, share, permission, and partial-failure states.

## Verification

- Red tests first for every operation from Miller and Library entry points,
  including refresh/selection behavior after success or failure.
- Retain all current Files, share, attribution, and app-aware regression suites.
- Visual variable: feedback/overlay hierarchy, one operation state per shot.
- Mask the stable browser; compare only the active notice/dialog/popover.
- Run Docker visual checks, `compare-screenshots` where the source has a target,
  unprimed `screenshot-critique`, and non-blocking `preview-shots`.

## Stays green

All Drive slices and current Files contracts.

## Feedback that changes the slice

Action placement and dialog density may change. Operation semantics and API
shapes may not.
