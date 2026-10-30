# Specific-people sessions

## Purpose

Specific-people sessions let a workspace member start a side conversation with an agent and selected current workspace members without adding noise to everyone else's session lists. This is a noise boundary, not a data-protection boundary: the workspace remains one trust domain, owners override audience admission for ordinary root or onboarded-agent sessions, workspace agents and apps retain workspace-principal access, and agent memory may recall any workspace conversation.

The public API owns the complete policy and returns the effective audience, archive state, and caller permissions. The web app only renders those contracts.

## Product invariants

- A session is either `workspace` or `specific`; its kind is immutable. At creation, a specific audience automatically includes its human creator. The UI shows the creator and agent as fixed participants while composing and lets the creator add people; the audience can remove the creator later.
- Specific audiences contain current membership generations, not durable user identities. Removing a member immediately revokes access. Rejoining does not restore an old grant.
- Owners override audience admission for ordinary root or agent sessions. Editors and viewers need audience admission. Onboarding sessions remain hidden from viewers, and a session whose agent row is gone is hidden from every human. Whether an agent has completed a declared onboarding is never an access fact here: the declaration lives in the agent's config on the VM, so that lock belongs to the web (see the agent-onboarding spec), and an ordinary agent never carries `onboardedAt` at all. Every admitted participant can participate, rename, manage a specific audience, and personally archive; owners and editors also have global lifecycle authority. Workspace principals can participate, manage a mutable specific audience, and use global lifecycle operations.
- Global archive removes the session from everyone's active discovery and takes precedence over independent personal archive preferences. It does not revoke admitted point access. Restoring one discovery lane does not restore the other.
- Default and onboarding sessions stay workspace-wide. A child session copies its parent's audience once at creation.
- Every content and lifecycle route uses the same access policy. An admitted SSE stream may finish, but reconnect is reauthorized.
- Accepted input is durable before VM delivery. The gateway gets one bounded foreground attempt; a cold VM falls back to the existing queued result and durable drain.

## Storage and discovery

`agentSessions.audienceKind` is required. Specific sessions also carry a required granted-participant count. There is deliberately no creator authorization field: attribution is historical, while access derives from the current principal, membership generation, audience, and owner override.

`agentSessionMemberStates` owns both a generation-bound audience grant and that member's personal archive preference. `agentSessionDiscovery` is a materialized bounded projection, not a lazy cache. Secure pagination cannot fetch a broad page and discard unauthorized rows afterward without short pages, ordering leaks, or skipped eligible sessions. Audience and lifecycle mutations therefore update canonical state and indexed discovery lanes together; canonical sessions and member state remain authoritative.

All public collections use `{ items, nextCursor }` with opaque cursors bound to route and filters. Pagination happens at the authorized source with deterministic order. Web, CLI, MCP, and staging walkers consume continuation explicitly rather than hiding drain-all loops.

## API and capability contract

Creation accepts no audience for a workspace session, or a specific audience:

```json
{"audience":{"kind":"specific","memberUserIds":["user_..."]}}
```

Projections return the effective `audience`, independent global/personal `archive` timestamps and reason, and caller-specific `permissions`. Audience members use the standard page envelope and a strict add/remove delta. Removing the final participant globally archives the session. Access denials remain generic `not_found`; invalid additions and malformed deltas use public audience error codes, while removal of an already-absent member is idempotent.

Permanent deletion seals the addressed session immediately, recursively claims its descendants, and returns `204`. Physical cleanup waits for retryable runner disposal, and repeated deletion remains response-idempotent without exposing tombstones.

The contracts and cursor codecs live in [`packages/contract/src/sessions/`](../../../packages/contract/src/sessions/) and [`packages/contract/src/pagination/`](../../../packages/contract/src/pagination/). API ownership lives in [`apps/api/src/routes/agent.ts`](../../../apps/api/src/routes/agent.ts) and [`apps/api/src/session-principal.ts`](../../../apps/api/src/session-principal.ts).

## Implementation ownership

- [`access.ts`](../../../packages/backend/convex/domains/agentSessions/access.ts) owns policy; `audience.ts`, `creation.ts`, `memberState.ts`, and `membershipRemoval.ts` own audience lifecycle.
- [`discovery.ts`](../../../packages/backend/convex/domains/agentSessions/discovery.ts) owns authorized list lanes; `projection.ts` owns public shapes and permissions.
- [`session-audience-picker.tsx`](../../../apps/web/spa/sessions/session-audience-picker.tsx) and [`session-audience-manager.tsx`](../../../apps/web/spa/sessions/session-audience-manager.tsx) render the API-owned audience. `session-controls.tsx` renders lifecycle actions from returned permissions.
- [`staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic) is the permanent deployed acceptance journey: UI creation, owner override, generic denial, audience pagination, reconnect revocation, workspace-app access, membership-generation revocation, and verified cleanup.

## Rejected alternatives and rollout lessons

- A creator field would create a second stale access concept without product behavior.
- Lazy discovery cannot authorize before page boundaries.
- Extra polling, archive tables, and a separate side-session agent relationship duplicated existing session lineage, member state, and durable drain owners.
- Resumable Convex migrations populated required fields, after which the strict schema and empty migration runner returned. Migration machinery was a rollout phase, not compatibility code.
- Browser `networkidle` is not an absence oracle in a streaming product; the journey waits for stable absence in the exact session list.
- The app-principal proof ultimately registers only the app identity and key it consumes instead of provisioning an unrelated VM runtime.

## Verification and visual provenance

The focused live staging journey passed against the production-mirroring topology and strict schema, with complete cleanup and no orphans. Production then passed strict Convex validation and the reusable release-convergence verifier. Staging is the accepted behavior gate; no feature-specific production verifier remains.

The [production release evidence](assets/production-release-evidence.md) records the migration, strict-schema, deployment-convergence, and cleanup receipt.

Accepted desktop and mobile states live in [`apps/web/tests/visual/__screenshots__/`](../../../apps/web/tests/visual/__screenshots__/). The [visual review](assets/visual-review.md) records the participant-header comparison, fresh critiques, and the accepted extreme-mobile popover tradeoff; its comparison images remain here as provenance.
