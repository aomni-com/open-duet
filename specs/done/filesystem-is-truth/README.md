# Filesystem truth for anchored entities

Apps, agents, and publishes are projections of entries in a workspace drive. If
an anchored entry is conclusively gone, the corresponding row is removed too;
after the missing-entry debounce, Duet does not preserve a database object that
claims missing files still exist. Shares remain outside this rule because they
are agreements between workspaces, not entities owned by one drive.

The individual judgment calls and their history remain in [`choices.md`](choices.md).

## Why the boundary is the filesystem

The user can edit the drive directly, outside the web application's database
mutations. Filesystem evidence is therefore eventually authoritative for the
existence of reapable anchored entries. The database supplies identity and
relationships, while a short debounce protects against transient observations.

Firing an agent prefers recoverable residue over false references: it removes
rows before files, so interruption leaves an ordinary unregistered folder
rather than live rows pointing at nothing. When no other consumer owns it, a
surviving reaped anchor becomes orphaned and can preserve path identity if that
entry is later registered again. Replica teardown may instead remove its own
anchor, and orphaned anchors otherwise have no collector; preserved identity is
the reason that small metadata residue is accepted.

Publisher authority covers publisher-owned bytes and narrowly classified
regenerable residue. When a listing drops an app, row
teardown does not directly issue a folder deletion. Marketplace convergence may
remove unchanged publisher files, derived directories, and an app directory
left empty by that cleanup, while preserving subscriber edits and additions
except narrowly classified disposable residue and the materializer's documented
open-inode race. The app disappears from the map without a separate
notification; any surviving subscriber work remains in an ordinary folder.

## Invariants

- A traceless app, agent, or publish entry waits through the consecutive-missing
  debounce, then its entity rows are reaped without passing through the
  `broken` repair state. A path that still exists but cannot be identified is a
  repair case instead. The threshold is the temporal debounce; unreadable-drive
  and in-flight-restore suppression prevent those observations from advancing
  it.
- Share anchors are not reaped by this rail. Replicas leave through share
  convergence; owned entities use their ownership teardown.
- Firing an agent removes every anchored app, agent, and publish row beneath its
  folder and fails closed rather than partially deleting a subtree it cannot
  enumerate. Shares remain governed by their own rail.
- Firing an agent removes database ownership before deleting drive bytes. If
  work is interrupted, the safe failure residue is an unregistered folder.
- Reaping retires a surviving, unclaimed anchor to `orphaned`; registering the
  same path may revive its identity. Replica convergence may delete its anchor.
- Dropping a marketplace app deletes its row; its files follow the publisher-vs-
  subscriber ownership rule above. A managed, switched-off app therefore means
  installation is still in progress; there is no retired-app state and no
  direct delete control.
- Derived-content cleanup stays conservative. Only segments accepted by
  `isDerivedContentPath` are automatically disposable; ambiguous names such as
  `dist`, `build`, `out`, `target`, `vendor`, and `coverage` remain protected.
- Recursive file deletion does not pre-walk the tree merely to count it. The
  successful response may omit `affectedEntries`.
- Product UI and REST routes derive brokenness from drive observations and
  expose no manual broken transition. Test fixtures use the separate
  `testing/anchors:markAnchorBrokenForTest` mutation.

## Code and tests

- Missing-entry classification: `resolveAnchorRenameDecisions` and
  `REAP_MISSING_POLLS` in
  `packages/backend/convex/domains/anchors/renameDecision.ts`, pinned by
  `packages/backend/src/anchors-rename-decision.test.ts`. Consecutive observation
  counting is owned by `recordMissingObservation` in
  `packages/gateway/src/routes/anchors.ts` and pinned by
  `packages/gateway/src/gateway.test.ts`.
- Reap application and anchor retirement: `applyRename` in
  `packages/backend/convex/domains/anchors/model.ts`, pinned by
  `packages/backend/src/anchors.test.ts`.
- Descendant enumeration and ownership-specific teardown: `anchorsUnderPath`,
  `deleteAgentSubtree`, and `deleteAnchorEntities` in
  `packages/backend/convex/domains/anchors/subtree.ts`. The core nested deletion
  journey is pinned by `packages/backend/src/agents.test.ts` and
  `packages/test-harness/src/staging-e2e-synthetic`; edge behavior remains
  legible at the owning functions rather than being implied by those tests.
- Fired-agent row-before-bytes ordering: the delete route in
  `apps/api/src/routes/agents.ts`, including its best-effort folder cleanup.
  The gateway helper's typed refusal semantics are pinned separately by
  `apps/api/src/gateway/client.test.ts`.
- Publisher-drop cleanup: `retireDroppedApps` in
  `packages/backend/convex/domains/marketplace/model.ts`, pinned by
  `packages/backend/src/marketplace.test.ts`.
- Regenerable-directory policy: `isDerivedContentPath` in
  `packages/contract/src/drive/index.ts`, consumed by
  `packages/gateway/src/marketplace/puller.ts` and pinned for the shipped cases
  by `packages/gateway/src/marketplace/puller.test.ts`.
- Installing-state and deletion controls: `appIsInstalling` and `appControls`
  in `packages/contract/src/apps/index.ts`, pinned by
  `packages/contract/src/apps/index.test.ts` and
  `apps/web/spa/apps/app-frame-body.test.tsx`.
- Recursive-delete response semantics: `FileOperationResponseSchema` in
  `packages/contract/src/files/index.ts` and `deleteDrivePath` in
  `packages/gateway/src/routes/files.ts`, pinned by
  `packages/gateway/src/routes/files-symlinks.test.ts` and the oversized-tree
  case in `packages/gateway/src/gateway.test.ts`.

## Dead ends

- Raising the recursive-delete size ceiling retained an unnecessary tree walk
  whose only output was an unread count. Removing the count removed the reason
  for the ceiling.
- Marking a vanished entry `broken` before deletion created a repair state that
  was false for its entire lifetime and left audit noise when the entry returned
  quickly.
- Skipping replicas stranded replicas nested below a share mount. They need the
  same filesystem verdict but a different teardown rail.
- Once publisher drop deleted the row, the retired-app predicate could only
  match managed apps awaiting their first pull. It mislabeled installation and
  offered a direct delete that raced the pull.
- Deleting every directory a build might produce risks authored or committed
  output. The cleanup list intentionally accepts leftover ambiguous output over
  silent loss of user work.

## Visual provenance

No external reference image is recorded for this work. Product-owned regression
baselines cover the destructive agent-delete copy (`agent-delete-dialog.png`),
the narrowed meaning of a broken app (`app-broken-on-card.png`), and a managed
app awaiting its first pull (`app-installing.png`). They live beside the web
visual tests.
