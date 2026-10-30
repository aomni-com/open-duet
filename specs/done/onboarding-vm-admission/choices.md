# Choices ledger

## Sound

### `onboardedAt` remains the single VM admission owner

Signup creates a workspace row before the user has completed payment and setup.
The shipped behavior keeps that row as metadata and uses the existing
`onboardedAt` timestamp as the one durable fact that permits VM provisioning.
The attach lifecycle reads that fact instead of introducing a second flag that
could drift from the onboarding completion mutation.

**Reach:** future VM attach callers must consume the same timestamp-based rule.
**Verdict:** sound. **Confidence:** high.

### The admission check exists in both the plan and preparation mutation

The attach action first reads a plan. An incomplete workspace is rejected there
so the action avoids even listing provider VMs. The preparation mutation repeats
the check immediately before it writes provisioning state and calls the provider,
protecting the race where the row changes between those two steps.

**Reach:** any refactor of the action must retain the transactional preparation
check as the final provider boundary.
**Verdict:** sound. **Confidence:** high.

### Existing incomplete-workspace resources remain untouched

A workspace created before this cutover may already have a VM or queued attach.
The shipped change does not reclaim or rewrite those resources. This preserves
the user's chosen scope and avoids an operational migration path.

**Reach:** operators should not interpret this feature as historical resource
cleanup.
**Verdict:** sound. **Confidence:** high.

### Bootstrap keeps immediate scheduling only for explicit non-onboarding births

The existing `requiresOnboarding` option distinguishes ordinary browser signup
from internal or programmatic births that are complete at creation. Ordinary
signup now skips scheduling; explicitly non-onboarding births retain their
existing eager VM behavior. Invite bootstrap still returns through direct invite
consumption before personal-workspace creation.

**Reach:** future birth callers must choose the existing option deliberately;
ordinary signup must not silently regain eager provisioning.
**Verdict:** sound. **Confidence:** high.
