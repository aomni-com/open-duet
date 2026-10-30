# Slice 07 — Drive Library modes with honest scope

**Depends on:** slice 06.

## Contract unlocked

Port the reference Library's grid, list, and split presentations over the same
open-directory state, with search explicitly bounded to data Duet has loaded.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Port the Library hero, location bar, grid/list/split switch, folder/document
  sections, result cards, empty states, and split preview composition.
- Reuse the slice-05 path chain and slice-06 directory cache/preview/viewer.
- Search only the current directory and label the scope **This folder**.
- Remove the reference Everywhere scope and any copy suggesting indexed or
  complete recursive search.
- Preserve folder navigation and full-file open across view changes.
- Keep comfortable/compact Miller state intact when switching back from
  Library.

## API seam

Library consumes the same cached current-directory entries and provider-backed
preview callbacks. It owns presentation-only query/layout state.

## Human review surface

Separate grid, list, split, current-folder search, no-results, and empty-folder
fixtures at desktop/mobile.

## Verification

- Red tests first for bounded search, navigation/view-state continuity, split
  selection, and absence of Everywhere/global-search copy.
- Visual variable: one Library layout at a time. Compare grid, list, and split
  separately; mask filenames/content.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and a non-blocking `preview-shots` contact sheet.

## Stays green

Miller navigation, previews, and Drive controls.

## Feedback that changes the slice

Library density and search copy may change. A complete workspace search remains
an explicit report omission until a real indexed contract exists.
