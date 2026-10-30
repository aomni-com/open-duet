# Slice 02 — Full-bleed shell and top bar

**Depends on:** slice 01.

## Contract unlocked

Prove the reference shell silhouette and accessible top bar as a controlled,
backend-independent surface before production routing changes.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Port the reference shell frame, panel sizing, equal side gutters, tab switcher
  classes/interaction, and reduced-motion panel transition directly.
- Make the SPA component accept workspace switcher and right-side control slots;
  it owns neither workspace nor account state.
- Use path-backed Agents / Drive / Jobs / Integrations selection from the
  slice-01 route owner.
- Preserve 48px desktop and 56px mobile heights, centered tabs, icon/label
  treatment, ARIA relationships, roving focus, Arrow keys, Home/End, and focus
  visibility.
- Leave the reference assistant trigger/drawer absent. Use fixture slots that
  match real status/account controls, never an inert placeholder.
- Extend the existing typed SPA playground; do not create another fixture API.

## API seam

`DriveTopBar` is controlled presentation: tab definitions, selected value,
navigation callbacks, and left/right slots enter through props. `DriveShell`
owns viewport/overflow and an active panel slot.

## Human review surface

A shell fixture at desktop/mobile with real-shape workspace/account slots and
each tab selected.

## Verification

- Red tests first for ARIA IDs, roving focus, keyboard activation, active-route
  matching, and equal side-slot geometry contract.
- Visual variable: top-bar height/centering and shell silhouette only.
- Crop the top strip and mask all panel content.
- Run Docker visual checks, `compare-screenshots`, then unprimed
  `screenshot-critique` on each final shot.
- Offer `preview-shots` non-blockingly.

## Stays green

All current product fixtures and the slice-01 route tests.

## Feedback that changes the slice

Spacing, compact tab labels, and right-side control arrangement may change.
Data semantics and tab count do not.

## Implementation handoff

- `DriveShell`, `DriveTopBar`, and `DriveTabPanel` are controlled presentation
  owners; they import no workspace, account, router, or product-data state.
- The tab contract provides stable ARIA relationships, one roving focus target,
  wrapped Arrow navigation, Home/End activation, and 48px/56px shell heights.
- The typed `drive-shell` playground supplies working workspace/account slots
  and captures all four selected states. Focused route/shell tests and web
  typecheck cover the installed contract.
- [Desktop and mobile candidate evidence](../assets/02-shell/README.md) records
  the unprimed critique and the discovery that the source overview screenshots
  are not live-shell parity baselines.
- Docker approval is the only outstanding slice gate: the local Docker daemon
  did not respond to `docker info`. Retry the exact `bun ui:approve drive-shell`
  command during slice 13; do not bless the local Chromium captures as Docker
  baselines.
