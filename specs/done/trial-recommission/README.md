# Trial workspace recommission

A never-subscribed trial may lose its VM and every drive byte without losing
the workspace or its conversations. Later entitlement recommissions that same
workspace onto a fresh VM, and every accepted old-session message must either
run safely or reach a durable terminal outcome.

## Why this shape

`archived` without `archiveStorageId` already means “identity retained, drive
not retained.” Reusing it avoids a second workspace, a file-archive feature,
or another lifecycle state. Workspace id, slug, memberships, agents, sessions,
and transcripts survive; VM-local files, cwd directories, and gateway session
envelopes do not.

Automatic decommission is a servicing policy, not an activity policy. Only a
workspace continuously `paused` or `banned` for seven days is eligible. Active
workspaces—including subscribers—are never retired for inactivity. For a
never-subscribed payer the seven days cannot start before their trial expires
— the candidates query defers the window to `trialExpiresAt`
(`servicingWindowStartedAt`), because a pause stamp older than a live trial is
evidence of a stale stamp, not of an unserviced week. Signup-to-eligibility is
therefore fourteen days at minimum for trials; a subscriber's window starts at
their pause, since disputes and failing top-ups legitimately pause a paid
period. Provider deletion completes asynchronously after the transition.

> **Amendment (2026-08-12):** both halves of this paragraph were enforced after
> a real staging workspace was destroyed thirteen minutes after its trial
> expired — the sweep read a signup-day pause stamp as a served week. The same
> incident scoped this spec's own journey: `decommissionUnservicedWorkspaces`
> takes a `workspaceId`, and the journey passes its fixture's, because an
> unscoped call from a test is the fleet-wide reaper aimed at live staging.

Purchase converges through the workspace VM owner. If teardown is still in
flight, attach intent latches monotonically behind it; if teardown already
finished, attach starts directly. Residual old-generation state always uses
the teardown path. Stale callbacks cannot clear or adopt a replacement
generation.

## Session guarantees

Agent context derives from the session cwd and the gateway's projected anchor
map. The gateway records that resolution in its VM-local session envelope so
later turns and wakes stay with the same agent, but a fresh VM derives it again
from cwd rather than receiving a parallel durable binding.

- An unusable root cwd falls back to `/` and records
  `session-synthetic-007`.
- An unusable bound child cwd falls back only to the valid bound-agent root.
- A missing bound-agent root settles
  `bound_agent_root_unavailable` as retryable `interrupted`; it never launches
  as root.
- Permanent commissioning failure settles pending work as
  `workspace_provisioning_failed` and consumes its delivery state.
- Transient VM, gateway, model-credential, and provider-attempt failures remain
  queued.

Delivery marking advances cursors and clears its matching lease, but never
reopens a terminal status produced while the gateway call was in flight. This
ordering is essential because no-runner settlement can relay `interrupted`
before the API receives and marks the gateway receipt.

## Ownership

- Servicing eligibility and decommission disposition live in the workspace
  provisioning domain.
- Teardown/attach ordering lives in VM convergence and scheduling.
- Pending-input ownership lives in the backend session row; runtime agent
  context derives from cwd in the gateway.
- Filesystem cwd classification and no-runner settlement live in the gateway.
- Relay projection is the terminal-status owner; delivery marking owns only
  cursors and leases.

The implementation is documented by the code and regression tests in
`packages/backend/convex/domains/workspaces`,
`packages/backend/convex/domains/agentSessions`,
`packages/gateway/src/agent-sessions`, and the focused journey
`packages/test-harness/src/staging-e2e-synthetic`.

## Verification rationale

Deterministic local tests own race interleavings, stale callbacks, permanent
provider failures, missing agent roots, cwd classification, no-runner
settlement, and the delivery-mark race. The focused staging journey owns the
composed live contract: no trial archive bytes, retained history and send wall,
same-row recommission, fresh VM nonce, queued root recovery, durable fallback,
bound-root interruption, and zero-orphan cleanup.

The focused journey activates paid entitlement through the staging synthetic
subscription seam. Real Stripe checkout remains owned by the existing full
subscription lifecycle journey; duplicating its clocks, checkout, and cleanup
would make this VM/session regression a second billing suite without adding a
new contract boundary.

Unassisted staging runs covered both convergence paths: one latched attach
behind an in-flight teardown, while another attached directly after teardown
had completed. Both completed verified cleanup.
