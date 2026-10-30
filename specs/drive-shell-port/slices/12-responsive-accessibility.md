# Slice 12 — Mobile, accessibility, localization, and overflow

**Depends on:** slice 11.

## Contract unlocked

The full product works deliberately from 320px phones to large desktops,
through keyboard, screen reader, zoom, localization, reduced motion, loading,
and exceptional states.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Move the one Agents rail primitive into the project Dialog/Drawer below the
  chosen breakpoint; do not duplicate rail markup.
- Complete focus trap, initial focus, Escape/backdrop close, selected-item
  close, trigger-focus restoration, semantic title, and inert background.
- Match the 56px compact top bar, icon tabs, accessible names, touch targets,
  safe areas, and virtual-keyboard composer clearance.
- Verify Miller horizontal gestures/keyboard access, preview-to-list back
  behavior, Library split fallback, Train table/card overflow, Integrations
  cards, dialogs/popovers, and portal stacking.
- Verify 200% zoom, 320px width, long workspace/session/app/provider/file names,
  English/Spanish expansion, light/dark, reduced motion, offline/error,
  loading, empty, permission denial, and cursor continuation.
- Remove double scrollbars, clipped overlays, accidental horizontal page
  scroll, hidden focus, and sticky elements owned by removed chrome.

## API seam

No data contract changes. Responsive behavior is presentation state over the
same controlled owners.

## Human review surface

A desktop/mobile/320px montage for every pillar plus the drawer, selected
session, deep Drive path, Library split fallback, Train overflow, Integrations
catalog, and representative exceptional states.

## Verification

- Red tests first for focus lifecycle, tab names/keyboard, breakpoint behavior,
  touch targets, scroll/overflow invariants, and localization rendering.
- Run available automated accessibility checks and manually record the
  tab/drawer/dialog focus sequence.
- One visual variable per loop: compact topbar, drawer, each responsive page,
  then each exceptional state. Mask all stable regions.
- Run Docker visual coverage, `compare-screenshots`, unprimed
  `screenshot-critique` on every final image, and a non-blocking final
  `preview-shots` montage.

## Stays green

All behavior and approved desktop visuals from slices 02–11.

## Feedback that changes the slice

Breakpoints, truncation, and mobile composition may change. Missing product
data and removed routes do not return to fill space.
