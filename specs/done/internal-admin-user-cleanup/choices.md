# Choices ledger

## Sound

- **A cleanup operation is a durable Convex operation with per-resource rows.**
  A browser request can end while a workspace VM teardown or membership-session
  reconciliation is still running, so the operation stores its frozen plan,
  resource attempts, statuses, and retry state. This keeps lifecycle ownership
  in `internalAdmin/cleanup` and lets operators poll or retry safely.

- **Workspace membership generations are represented by the membership row id.**
  The membership-removal owner deletes the exact row passed to it; a rejoin gets
  a new row, so a stale cleanup plan cannot remove the replacement membership.

- **Identity retirement is anonymization, not a users-row delete.**
  The canonical retirement owner preserves audit foreign keys, fences OAuth
  families, revokes personal credentials, and preserves workspace-principal
  `system_vm`/app keys for a surviving workspace created by that user.

## Needs-user

- **The UI panel is embedded in the existing Workspaces admin section.**
  This is reversible and keeps the first user cleanup surface beside the legacy
  workspace tools. A future information-architecture pass can move it to a
  dedicated section without changing the REST or Convex seams.

## Unsound choices corrected during implementation

- **Workspace soft deletion was initially modeled as a generic cascade.**
  The canonical deletion rail marks the workspace deleted and schedules domain,
  backup, MCP, and VM teardown; most historical rows remain. The manifest now
  records retained history or explicit provider blockers instead of promising
  row deletion that the owner does not perform.

- **Generated Convex Auth links were initially named as direct user fields.**
  Verification codes point through `accountId`, refresh tokens through
  `sessionId`, and verifier/rate-limit cleanup has separate owners. The
  manifest records those real links and the retirement implementation fences
  them through bounded canonical paths.

- **Start validates provenance before inserting operation state.** An operator
  request with a short reason or malformed request id now fails before any
  operation or resource row exists, so an invalid audit request cannot leave
  work that has no valid audit record. The validation mirrors the existing
  internal-admin audit contract.

- **Blocked and failed starts replay the existing operation.** Pressing Start
  again after a blocker or failed resource does not create a second plan; the
  operator must choose Retry, which replans current memberships and billing.
  This keeps one durable history per target operation while still making retry
  explicit.
