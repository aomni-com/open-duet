# Per-agent integration access

A workspace can leave a connected integration available to every agent or
define the exact Duet agents that receive its toolkit. Policy is evaluated
before Duet accepts and dispatches session input.

The feature intentionally composes the normal toolkit surface rather than
creating a security boundary inside a workspace VM. Per
[SECURITY.md](../../../SECURITY.md), code running in one workspace VM remains in
one trust domain.

## Why the policy has three states

The absence of a policy means **All**. This preserves the behavior of existing
connections and automatically includes agents created later. A stored empty
list means **Nobody**; a stored non-empty list means exactly those principals.
Conflating absence with an empty list would either silently revoke existing
access or make “Nobody” impossible.

Default Duet is represented by the stable `root` principal. Other entries are
durable agent IDs, not display names, slugs, provider connection IDs, or anchor
paths. Policies are keyed by workspace and toolkit slug so reconnecting an
account does not erase the user's decision. Deleted agent IDs simply stop
matching; agent lifecycle does not become coupled to integration policy.

The public contract is owned by `SetIntegrationAgentPolicyRequestSchema`,
`IntegrationAgentPolicyResponseSchema`, and `IntegrationConnectionListSchema`
in `packages/contract/src/integrations/index.ts`. The durable transition is split
between `setIntegrationAgentPolicy` for explicit lists and
`clearIntegrationAgentPolicy` for All in
`packages/backend/convex/domains/integrations/model.ts`.

## Why policy is synchronized before dispatch

The backend is the only component that turns agent policy into a disabled-toolkit
set. User input and autonomous wakes both ask that owner for the current set,
then synchronize the conversation's provider Session before dispatching work.
A policy edit by itself does not reach into a running turn; the next accepted
input is the cutover point.

Initial synchronization is part of readiness. Duet does not dispatch user input
when the provider Session cannot be created or updated; an autonomous wake still
runs, but with integrations omitted. A provider Session that disappears after
readiness is different: the MCP boundary replaces that temporary provider state
and continues without involving the user. The gateway
receives only a boolean saying integrations are ready; it never receives policy
hashes or storage IDs and never reimplements membership logic.

The projection owner is `projectIntegrationTurnConfig` in
`packages/backend/convex/domains/integrations/turnConfig.ts`. Its public launch
marker is `IntegrationTurnLaunchSchema` in
`packages/contract/src/agent/index.ts`; scheduled-wake transport is owned by
`createAgentSessionsController` in
`packages/gateway/src/agent-sessions/coordinator.ts`.

## Why one provider Session belongs to one Duet session

Composio recommends reusing a Tool Router session when the same remote Sandbox
context should survive; its SDK retains a Workbench compatibility alias and the
meta-tool retains the name. Duet therefore keeps one current provider Session
for each Duet session. Permission changes update the healthy Session in place,
preserving that conversation's temporary Sandbox/Workbench; unrelated
conversations never share it.

Provider Sessions have no Duet TTL and no permission-history cache. Their
Workbench is useful continuity, not user-owned durable data. If Composio loses a
Session, Duet atomically adopts a replacement with the current toolkit policy
and retries through it; concurrent recovery attempts converge on one replacement.
The durable row stores only the current provider Session identity and the
currently applied policy fingerprint. Transport headers are rehydrated in memory
for each MCP request.
If an older concurrent update finishes late, Duet clears readiness and retries
the current policy on the next dispatch rather than claiming stale state is ready.
Deleting the Duet session deletes its one provider Session best effort; provider
availability cannot reverse the accepted Duet deletion.

Provider lifecycle is owned by `apps/api/src/composio-session.ts`; the shared
input-readiness step for ordinary and default sessions lives in
`apps/api/src/routes/session-integrations.ts`. Policy projection lives in
`packages/backend/convex/domains/integrations/turnConfig.ts`, and the provider
adapter lives in `apps/api/src/providers/composio.ts`.

The same adapter is the provenance boundary for provider catalog and connection
metadata. Provider identity fields are structurally UTF-8-bounded and rejected
when invalid; Composio display names may be scalar-safely shortened and invalid
optional logos omitted there, before they become accepted Duet rows. Both provider pages and
public pages have explicit row and cursor ceilings. Composio's SDK materializes
its HTTP response before Duet can validate it, so the upstream transport body is
an external SDK assumption rather than a locally stream-enforced bound; no
materialized row crosses the adapter or API route without the public proof.

## Why the MCP URL is a session resource

The runner connects to
`/v1/ws/:workspaceSlug/agent/sessions/:sessionId/integrations/mcp`. Workspace
authorization and conversation identity are explicit in the resource path.
There is no public config-row ID, permission fingerprint, or provider name.
The MCP route normally rehydrates the already-prepared provider Session and
forwards bytes. A provider `not found` response is an internal lifecycle signal,
not a product state: the route replaces the Session, drops the stale MCP
transport identity, and forwards the original request through the replacement.

## Why connection links and sessions have different lifetimes

A user-requested connection return descriptor is intentionally short-lived. A
durable Tool Router session, however, may need to create a fresh connection
months later. Their signed return descriptors are consequently distinct: the
user-requested descriptor expires after ten minutes, while the session descriptor is
non-expiring, workspace-bound, and points to a server-derived Integrations
destination. The callback only validates and redirects; it does not exchange
credentials or mutate the connection.

Only the versioned descriptor shapes are accepted. Keeping an unversioned
payload beside them would create a second security-sensitive wire contract with
no product need. The provider documentation evidence is preserved in
[the Composio research note](research/composio-sessions.md).

## UI principles

Access editing stays inside the connected integration row because toolkit
identity—not the agent—is the policy owner. Unchecking “All agents” stores
Nobody; checking it deletes the policy. Unchecking one child while All is active
materializes every other visible principal. Selecting every visible child
remains an explicit list so future agents are still excluded.

Each row serializes only its own optimistic mutation. A failure restores the
previous server state and returns keyboard focus to that row's access control.
The principal list has one bounded scroll owner for default Duet plus the
product's 500-agent maximum; the surrounding page does not become a second
nested scroll surface.

The policy transition is owned by `nextIntegrationPolicy` and rendered by
`IntegrationAgentAccessEditor` in
`apps/web/spa/routes/integrations/integration-agent-access.tsx`. Workspace-bound
optimistic cache ownership lives in `apps/web/spa/routes/integrations.tsx`.

## Invariants future changes must preserve

- No row means All; an empty row means Nobody; an explicit row never widens to
  include a future agent.
- Toolkit slug is policy identity. Provider connection IDs are lifecycle data,
  not authorization identity.
- Provider synchronization completes before session input is dispatched.
- The backend alone computes membership and fingerprints. The gateway and web
  client do not become parallel permission authorities.
- One Duet session has one current provider Session and temporary Sandbox/Workbench.
- Permission changes update that provider Session in place; no historical
  permission configurations are retained.
- A provider-lost Session is replaced automatically with no user repair flow.
- Provider credentials and transport headers are never persisted or written to
  artifacts.
- Missing initial readiness fails closed; loss after readiness self-heals at the MCP boundary.

The detailed implementation judgments remain in the
[choices ledger](choices.md).

## Verification

Focused behavior tests live beside the contract, backend, API, gateway, and web
owners above. Deployed acceptance is the selectable `integration-agent-access`
journey in `packages/test-harness`.

The focused live staging journey proves provider toolkit denial/allowance,
meta-tool preservation, in-place permission updates with Workbench continuity,
automatic replacement after provider Session loss, cross-conversation isolation,
disconnect/reconnect persistence, clearing to All, and verified cleanup. The
prior staging verdict record is in
[staging-e2e-synthetic](evidence/staging-e2e-synthetic).

## Visual provenance

[The UI evidence](assets/ui/) preserves the prechange hierarchy, accepted inline
editor, overflow states, comparison reports, and desktop/mobile contact sheets.

## Rejected alternatives

- Minting a provider session every turn was rejected because it discards useful
  Workbench context and adds provider latency.
- Creating the initial provider Session lazily from MCP requests was rejected
  because creation belongs to Duet-session readiness. Replacing provider state
  that disappeared after readiness is an internal repair, not a second lifecycle.
- Permission-history caches were rejected because the provider can update the
  same conversation Session without losing its Workbench.
- Provider connection IDs were rejected as policy keys because reconnecting
  creates a new provider lifecycle object.
- An enable-list projection was rejected because missing policy must remain
  allow-all without enumerating the provider catalog.
- A bulk editor, Save button, per-tool policy, and VM-internal capability
  boundary remain intentionally outside this feature.
