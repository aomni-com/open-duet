# Apps in Files

Apps are folders with durable identity, not a second kind of filesystem entry.
The Files browser projects app metadata onto ordinary directory rows, opens a
healthy app from the row, and preserves an explicit folder-navigation target.
Broken origin-app anchors whose last-known folder is absent remain discoverable
as repairable phantom rows. When a current seed bundle exists, fresh workspaces
begin with a content-addressed starter drive and a registered sample app so this
model is visible from first boot.

## Why this shape

The filesystem remains the authority for what exists at a path, while the app
row and its anchor carry identity and runtime intent. Folding app state into
`DirectoryEntry` would make filesystem providers responsible for backend
metadata and would require inventing fake entries for missing folders. The
sibling projection keeps those ownership domains separate.

Origin-app identity follows the anchor rather than the current path. Normal
moves are therefore left to the marker-and-inode reconciliation rail;
introducing a second move mutation would create competing owners. Manual
reanchor is a broken-only origin recovery path and addresses apps by slug
because that is the identity agents and users know. Replica app lifecycle stays
replication-owned; if its anchor breaks, recreation may produce a new app ID.

Starter content rides the existing archive pull rail instead of image baking
or pre-boot file writes. When an active seed bundle exists, a workspace pins it
at birth, which makes reprovision deterministic and ensures a later seed
publication cannot silently change an existing workspace. Workspace creation
also remains valid when no current seed is published. A real restore archive
always wins.

## Invariants

- Origin app IDs survive rename, relocation, breakage, and repair. Repair
  changes the anchor path; it does not delete and recreate the app. Replica
  identity remains owned by replication.
- Files joins only exact app-anchor folders. Ancestors are ordinary folders,
  and a missing broken anchor may project a phantom without synthesizing a
  `DirectoryEntry`.
- Runtime status, anchor status, disabled state, tint, and open target have one
  shared interpretation. Only active, reconciled apps open their canonical
  URL; every other state opens app detail.
- Row activation and folder navigation are separate targets. Live apps open in
  a safe new tab so Files remains available.
- Origin app-folder deletion removes app metadata before filesystem content.
  Replica folders never call the origin-only app deletion operation.
- The public list filter is `{ path?, scope? }`, where scope is `subtree`,
  `children`, or `self`; a scope without a path is invalid and an explicit
  empty path means drive root.
- Seed archives are deterministic and content-addressed. When a current seed
  bundle exists, birth pins both the archive and manifest registrations;
  reprovision does not re-seed.
- A running process is not evidence that app reconciliation finished. The
  gateway acknowledges the exact desired config it applied, delivery retries,
  and the backend ignores a report that became stale after a newer config or
  anchor path.
- Private app launch keeps the canonical URL clean: an authenticated product
  route mints a short-lived grant and the edge exchanges it for its cookie.

## Decisions that changed during implementation

The first staging workspace proved that process liveness alone left the sample
app permanently reported as reconciling. Readiness therefore became an
acknowledged VM-sync observation rather than an inference from process state.

Seed selection was moved from phone-home time to workspace birth. Phone-home
and reprovision share enough state that resolving the latest seed there would
have re-seeded old workspaces.

Replica-folder deletion deliberately remained filesystem-only. Reusing
`deleteApp` looked convenient but would have violated its origin-only contract
and confused replicated ownership.

## Code map

- Path and filter semantics: [`packages/contract/src/apps/`](../../../packages/contract/src/apps/),
  especially `matchesAppsPathScope`, `appsUnderPath`, and
  `browserPathToDrivePath`.
- Durable app and reconciliation policy:
  [`packages/backend/convex/domains/apps/model.ts`](../../../packages/backend/convex/domains/apps/model.ts).
- Seed publication, birth pinning, and archive precedence:
  [`packages/seed-drive/`](../../../packages/seed-drive/) and
  [`packages/backend/convex/domains/workspaces/seed.ts`](../../../packages/backend/convex/domains/workspaces/seed.ts).
- Files projection and interaction:
  [`apps/web/spa/files/app-rows.ts`](../../../apps/web/spa/files/app-rows.ts),
  [`apps/web/spa/apps/app-status.ts`](../../../apps/web/spa/apps/app-status.ts),
  and [`apps/web/spa/files/files-surface.tsx`](../../../apps/web/spa/files/files-surface.tsx).
- Public REST boundary:
  [`apps/api/src/routes/apps.ts`](../../../apps/api/src/routes/apps.ts) and the
  endpoint registry under [`packages/contract/src/endpoints/`](../../../packages/contract/src/endpoints/).
- Gateway reconciliation acknowledgement:
  [`packages/gateway/src/routes/apps.ts`](../../../packages/gateway/src/routes/apps.ts)
  and [`packages/gateway/src/vm/sync-client.ts`](../../../packages/gateway/src/vm/sync-client.ts).
- Behavior and staging proofs:
  [`apps/web/spa/files/app-rows.test.ts`](../../../apps/web/spa/files/app-rows.test.ts),
  [`packages/backend/src/apps.test.ts`](../../../packages/backend/src/apps.test.ts),
  and [`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic).

## Visual provenance

The 2026-07-16 visual gate at commit `370a5a8e` is preserved under
[`assets/03-files-glyph-playground/`](assets/03-files-glyph-playground/).
`reference/{desktop,mobile}.png` captures the pre-feature `/playground/files`
browse fixture; `candidate/{desktop,mobile}.png` captures the adjacent apps
state-matrix fixture. The side-by-side files put reference on the left and
candidate on the right. They record the chosen visual rule: replace the folder
glyph with an app-window glyph, use the existing app-status colors, dim disabled
rows, and render a missing broken app as inert rather than as a folder. A broken
row whose folder still exists remains a decorated, navigable directory row.

The final staging captures came from run `staging-e2e-synthetic` on
2026-07-17, with API commit `7532d60e` and web commit `b36e704e`. They are
[`desktop.png`](assets/final-acceptance/desktop.png) and
[`mobile.png`](assets/final-acceptance/mobile.png). Their side-by-side
comparisons with the approved playground state matrix are preserved as
[`desktop-playground-comparison.png`](assets/final-acceptance/desktop-playground-comparison.png)
and
[`mobile-playground-comparison.png`](assets/final-acceptance/mobile-playground-comparison.png).
The content differs because one side is the exhaustive fixture and the other
is a real seeded workspace; the comparison was used to judge layout, glyph,
spacing, and responsive continuity rather than pixel identity.

## Acceptance record

The scoped staging journey and cleanup record is
[`assets/final-acceptance/acceptance.json`](assets/final-acceptance/acceptance.json).
It is a sanitized projection of that run's raw `timeline.json`, produced by the
staging harness. The runner covers seed delivery and previews, filtered app
queries, private launch, identity-preserving rename, broken-folder repair
through both UI and REST, app-aware deletion, responsive captures, and zero
cleanup orphans; the feature owner is
[`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic).
The composed runner's later Firecrawl transport failure is retained in the
record rather than being hidden.
