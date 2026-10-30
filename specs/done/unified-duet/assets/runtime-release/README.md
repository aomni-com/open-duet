# Runtime manager verification

The [release manager](../../../../../packages/gateway/src/runtime-release.ts) owns one
matched application. Its manifest comes from the contract package; local and
transported manifests pass through the same completeness and content identity
checks. URL metadata does not become installed release metadata. No npm version
participates in activation.

Durable staging precedes activation. The manifest is published after all payload
renames, so interrupted writes remain unbootable and a retry can complete the
same candidate. Retention preserves the lock metadata until activation finishes;
deleting it early admits another process during the switch. Inspection checks actual bytes and modes before either current
or previous can execute. Repairs apply exact modes before syncing the file:
creation permissions alone inherit the service umask and cannot meet that
contract reliably.

Quarantine applies to every route back into a failed content version, including
previous-link recovery and an unchanged API announcement after rollback. A new
content version remains eligible. Existing boot state owns that decision; there
is no updater-specific registry.

The [updater](../../../../../packages/gateway/src/runtime-update.ts) waits for the
inclusive active-work signal without forcing a restart at its advisory deadline.
Its required admission callback belongs to runtime composition. That owner
closes the existing start gate, checks idle again, and returns its unblock
closure. The updater holds that closure until the manager lifecycle completes,
including lock release. A stale desire or failure reopens admission; complete
success keeps it closed through restart. A newer desire or work arriving during download
can leave a complete candidate staged without switching current or exiting.

## Evidence

On the pinned Bun 1.3.14 host, the focused manager, bootstrap, updater and
boot-health files pass; their exact output is in [green.txt.gz](green.txt.gz).
The scoped TS7 configuration compiles those owners and their real imports,
including the contract and desired-state store supplied by their owners. The
[recorded scoped config](typecheck-config.json) was placed inside `packages/gateway`
for that check. Lint
passes. No full-suite, live VM, image build, deployed API or staging verification
is claimed by this receipt.

The fixtures use scratch directories and an HTTP edge with asymmetric bytes for
each artifact. Filesystem operations remain real except explicit failure
injection. Every scratch directory and altered process umask is restored even on
failure. The [shared fixture](../../../../../packages/gateway/src/testing/runtime-release-fixture.ts)
owns the test inventory used by the manager, bootstrap and updater tests.

Recorded red controls:

- [Old owner](inventory-red.txt.gz): the complete runtime install cannot succeed
  against the previous gateway wire/grammar.
- [Independent length check](length-red.txt.gz): removing length validation lets
  matching hashes activate an incorrectly declared inventory.
- [Restrictive umask](umask-red.txt.gz): native and data repair never converged
  until exact modes were applied before fsync.
- [Quarantine after rollback](quarantine-update-red.txt.gz): the unchanged failed
  announcement reapplied before consulting existing boot state.
- [Active work past deadline](active-work-red.txt.gz): the previous forced gate
  activated during training after its deadline.
- [Admission during download](admission-red.txt.gz): bypassing the shared admission
  owner activated and exited while newly accepted work was busy.
- [Lock retention](lock-retention-red.txt.gz): retention deleted the interprocess
  lock while activation was still running.
- [Cleanup recovery](cleanup-red.txt.gz): omitting cleanup of the held admission
  closure left starts blocked after a failed lock release.
- [First-image recovery](first-release-red.txt.gz): a quarantined first release
  with no previous prevented a different fixed release from booting.

Own shape/diff/docs review resolved quarantine activation and first-image
recovery gaps, active-work timing, and premature lock deletion. The configured Codex CLI review reproduced
restrictive-umask repair and post-activation lock-cleanup defects. Both are
resolved and guarded here; the latter also exposed premature lock deletion
during retention.
The original [review verdict](codex-review.txt.gz) records its focused
tests, type-check and reproduced finding. The [seam review](seam-review.txt.gz) exposed the
admission cleanup gap; the [final cleanup review](cleanup-review.txt.gz) is clean
and includes scratch probes of stale, inner/exit failure and success paths. Root composition and constructor/image transport
checks are separately owned and required before slice closeout.
