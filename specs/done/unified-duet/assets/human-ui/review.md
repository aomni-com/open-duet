# UI02/04 review evidence

Target: Human login has one Sign in action with current live membership authority, without workspace/capability pickers. Named keys show their one-time secret. Removing one synced Mac explains and stops that Mac alone while keeping other Macs and the person's ordinary keys available. Content must remain readable at desktop and mobile widths.

Production owners: device-approval-card, app/device page, SPA API client/query resource, user-settings account page. Typed contract uses clientName; device approval body is {userCode}; key creation is {name,expiresAt?}; sync-machine resources are /user/sync-machines and DELETE /user/sync-machines/:machineId. Sync machines have machineId, name, Syncthing peer ID, creation/last-used timestamps, and optional removedAt. There is no sync credential UI or alias endpoint.

Initial red: Existing approval UI could not consume the new human DTO because it read scopes.some; Docker preflight also reported the old grant-shaped consumer types. This is an honest integration baseline failure, not a healthy old-product capture. Existing committed PNGs were used only as historical comparison evidence. Narrow behavior tests exposed and pinned the revised production output. The terminal-action test was additionally falsified by enabling approval actions for settled requests; it failed, then passed after restoration.

Green: apps/web `bun test --changed ./scripts ./app ./src ./spa ./components`: 990 passed, 0 failed across 120 files. Terminal-status assertions now reside with device-approval-card rather than a page file importing only the card. Focused client/card tests after that cleanup: 53 passed. Message-leaf parity and card final check: 5 passed. Web check-types, changed-file formatting, targeted lint, and git diff check passed.

Docker final exact check: `bun ui:check device-approval user-logins oauth-grants-settings`: 8 tests passed across desktop/mobile. This runs optimized production build, type checks, lint, asset checks, owner coverage union, build-output verification, and exact screenshot checks. All 10 changed/new PNGs were inspected. The earlier direct Bun `--changed` accidentally discovered Playwright files; its 990 unit tests passed but that invocation had two runner errors. The corrected explicit unit roots above passed cleanly.

Fresh critique: Initial unprimed reviewer found mobile machine dates truncated and revoked-app text faint; corrected production rows and recaptured. A second fresh reviewer confirmed readable device states/buttons, secret/copy control, wrapped metadata/names, and distinct removed/revoked states. Its two minor observations were a partly hidden prior row beneath sticky navigation at a scrolled removal capture and reuse of the familiar trash glyph across settings. The removal capture's target Mac card is fully visible; the prior-row overlap is ordinary scrolling under sticky chrome. Distinct accessible control names, card context, and explicit removal copy remain; icon vocabulary is a settled existing settings convention. No clipping or overlap affects the target card.

Compare-screenshots: Diagnostic pairs/artifacts are at comparisons/{desktop,mobile}/report. Historical mobile device approval was 563px wide at the 390px viewport, while the candidate is 390px wide; this is viewport overflow eliminated by removing grant UI, not an equal-size pixel match. Only the common 390px viewport was compared; full raw historical images remain available in Git. Historical device fixture had five states (desktop4500/mobile4242 tall), candidate has four human statuses (desktop3600/mobile3376). Pending-state crops compare one viewport; OAuth crops use common height because wrapping changes height. Full candidate images were also reviewed. Desktop pending distance 0.14041 is unchanged from the first candidate comparison; metadata/copy changes do not affect it. Distances measure movement only. The candidate is closer to the target because it eliminates grant selection and overflow while preserving actions and readable statuses.

Review: Removed obsolete grant helper tests and exported UI workspace-selection helpers; no replacement compatibility layer. Kept public schema, local metadata, and gateway registry owners separate. Shared human credential fixture/issuer migration and CLI identity setup remain parent-owned. The parent owns the runHumanDeviceLogin caller integration in staging-e2e-synthetic The live journey has not been executed. Codex CLI independent review was already unavailable under the supported account default in the parent pass; no CLI installation or model workaround attempted.

Non-blocking preview: Opened a single Preview window with pending-login before/after and the final mobile Mac-removal screenshot, then closed it before autonomous continuation.

## Attribution cleanup

The production member directory was the only supplied actor-name lookup.
Machine-name and share-name hooks had no production caller; their named labels
existed only as unit-test possibilities. Removed those hooks, branches, stale
credential comments, and their two English/Spanish message leaves. Sync remains
`Sync`; mirror remains `Synced from a device`, including when the backend
attributes the row to a member. Actual member-name lookup and the shared physical
actor parser are unchanged. No UI registry, query, alias, or test hook replaces
the deleted possibilities.

The old injected-name assertion went red when those hooks were removed. The
updated test asserts the actual shipped labels for every actor kind. A separate
falsification changed the mirror label to System: the focused assertion failed,
then passed after restoring the production label. Final attribution file:
25 tests passed; attribution plus message-catalog parity: 27 passed. Changed-file
formatting, lint, and diff checks passed.

`bun ui:check agent-surface-busy` passed both desktop/mobile cases, including its
optimized build, types, lint, owner union, assets, and build-output checks. No
baseline PNG was rewritten. This verifies preservation through the existing
visual gate rather than claiming a new visual feature or a byte-identical
capture; the normal configured screenshot tolerance still applies. The earlier
human-login captures and fresh visual critiques above remain the evidence for
the intentionally changed UI.
