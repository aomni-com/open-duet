# Staging cutover evidence

The hard cutover and named journey ran against staging on 2026-08-13. Production
was not reset: the specification requires a staging cutover, and deleting the
production epoch without deploying the matching production readers and writers
would leave production on an empty incompatible boundary.

## Cutover

- Deployment: `chatty-llama-452`.
- Before reset: 5,541 canonical events, 33,129 scope rows, 3,128 access rows,
  1,216 batch receipts, and no rows in the four new namespace/projection tables.
- A recovery snapshot was retained outside the repository before replacement.
- All eight declared activity tables were replaced and verified empty.
- The 16 workspaces that were active before the cutover were paused from a saved
  manifest, their gateways restarted to discard sealed legacy retries, then only
  those 16 were resumed. Every resumed gateway reached the deployed release and
  reported certified boot health.

## Named journey

Final accepted run: `staging-e2e-synthetic`.

- The complete structural operation matrix ran, including rename chains,
  rename-over, path reuse, copy, delete/recreate, atomic save, noisy-boundary
  moves, folder move, lineage miss, and restore suppression.
- A forced relay `401` was retried into one batch receipt and one canonical event.
- `.git` and `node_modules` persisted as counted summaries of 25 and 24 raw facts;
  the changed-summary rollup preserved the combined count of 49.
- Projection reached zero lag with 128 memberships in the accepted run; its
  observed work remained under the 64-operation ceiling. Root, exact, subtree,
  and new-parent cursors all used `fa:<seq>`.
- Raw operational telemetry observed 77 events and 74 scan-nudge paths. The
  retained sample was a concrete `node_modules/pkg/cache` descendant.
- Present-anchor reconciliation walked zero entries. The missing-anchor slow path
  walked 27 entries, excluded two generated subtrees, and did not falsely reap the
  existing anchor. The restore probe returned `skipped / restore_in_flight` and
  boot health remained certified.
- The browser kept five live columns. Desktop showed both the ancestor and moved
  folder refresh facts; after narrowing to 390 px, mobile kept the moved folder's
  own `nested` and `refresh.txt` rows in view. Cleanup deleted every journey-owned
  resource and reported no orphans.

The production-route before/after screenshot comparison recorded a mobile distance
of `0.03296` and desktop distance of `0.00555`. The mobile change is the intended
column-aim correction; desktop movement is limited to generated fixture labels and
row timing. The exact optimized-build geometry gate passes in both Playwright
projects.
