# Slice 11 — Atomic route and real-data cutover

**Depends on:** slices 02–10.

## Contract unlocked

Install every approved controlled surface as the only workspace product and
delete the superseded product route/chrome in the same pass.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Extract workspace resolution/access/`transitionWorkspace` from
  `ProductShell`; keep it as the sole authenticated workspace boundary.
- Mount one `DriveShell` beneath that boundary with the canonical route tree.
- Wire real workspace switch/status/account slots, rail projections,
  session/app controllers, Files provider/share/app sources, Train controller,
  and Integrations controller.
- Move the existing Cmd/Ctrl+number workspace shortcuts into the new workspace
  controls so deleting `ProductShell` does not silently remove them.
- Make root/workspace root land at Agents and register all titles/manifest
  patterns from the one route owner.
- Update share landing/acceptance, broken-app navigation, OAuth `redirectTo`,
  session/app actions, settings/account links, and workspace switching to
  canonical targets.
- Delete the current product destination leaves, desktop sidebar, mobile bottom
  nav, sticky product header, hard-coded path literals, and `ProductShell` once
  no live consumer remains.
- Keep settings/admin capabilities reachable through the new control owners;
  do not classify them as product-route compatibility.
- Render settings/admin inside the same authenticated `DriveShell` chrome but
  outside its tabpanels, with no falsely active product tab.
- Do not land any blank pillar, old-route redirect, shell mode, or fixture data
  fallback.

## API seam

The workspace boundary resolves/access-checks/transitions. `DriveShell`
composes controlled surfaces. Existing domain controllers remain sole data
owners. `SpaApi` may expose only already-existing client methods.

## Human review surface

Direct-load and navigation through every canonical route with real local
identity/API wiring, plus normal not-found behavior for removed product paths.

## Verification

- Red tests first for route manifest, roots, old-path absence, active tabs,
  workspace switching/shortcuts, settings reachability, share/OAuth returns,
  and no product fixture/mock imports.
- Run focused domain suites and SPA typecheck.
- Visual variable: fixture-to-live parity only; no approved geometry may move.
- Compare identical top-bar/rail/page crops between typed fixture and product
  composition, then run unprimed `screenshot-critique` on live frames.
- Run Docker visual checks and non-blocking `preview-shots`.

## Stays green

All slice 02–10 behavior and visual gates; settings/admin/status/logout;
workspace denial/loading; route build output.

## Feedback that changes the slice

If wiring requires changing a wire shape or retaining a second path/shell,
stop and report the gap rather than weakening the cutover.
