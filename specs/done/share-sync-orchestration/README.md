# Share sync orchestration

Sharing is an email-addressed lifecycle whose desired transport state travels
through initial VM registration and the recurring VM-sync rail. A recipient
accepts into a chosen workspace and path; the two gateways converge their local
Syncthing state from complete snapshots and report what they actually applied.
Moves preserve the link when identity remains unambiguous. Unlink and
delete-driven unlink preserve local files, while revoke removes replicated
ownership and ends transport.

## Why this shape

Share actions write durable intent and never push configuration directly to a
VM. Gateways restart, bridges are in-memory, devices are reprovisioned, and
either side can be temporarily unavailable; a one-shot imperative sequence
cannot repair those cases. Complete desired snapshots make every poll a repair
opportunity and make absence the teardown signal.

The request is addressed to a normalized email rather than a workspace. That
lets a non-user follow a deep link through sign-up and lets the recipient choose
where the mount belongs at acceptance time. The raw invitation token exists only
at delivery; the stored row holds its hash and prefix.

Filesystem identity and share lifecycle remain separate. The gateway reports
marker and inode evidence, while a backend policy decides relocate, wait, or
unlink. This keeps transient filesystem observations from becoming destructive
state transitions and gives both origin and recipient roots the same policy.

## Invariants

- Initial VM registration can carry the first desired share snapshot;
  `POST /v1/vm/sync` is the only recurring share control-plane request. Share
  lifecycle and anchor transitions never directly mutate gateway share or
  Syncthing transport state. An anchor transition may separately push app
  reconciliation when affected replica apps change.
- Desired state is complete and idempotent. Anything absent is pruned from
  share-owned folders, mounts, peers, bridges, and tunnel accepts; mirror-owned
  state is outside that ownership domain.
- `.duet-anchor` is part of the unremovable share ignore floor at both root and
  nested depths. Local anchor identity must never sync to the peer.
- `share.sync.tokenSecret` remains in Convex. Acceptors receive a digest and
  expiry; dialers receive short-lived derived bearer [REDACTED] Structural
  generations exclude credential rotation.
- VM realization reports are actual state, not desired state. A status is
  current only when both workspace reports match their role-specific current
  generations. Terminal lifecycle transitions remove obsolete realization
  rows, and historical rows cannot exhaust the live workspace bound.
- “Up to date” means both gateways applied the current configuration
  healthily. It does not claim byte-for-byte equality.
- Recipient mount paths are private to recipient projections. Outgoing
  management rows expose the source path, never the recipient path.
- Linked roots cannot contain one another. An attempted move into another
  linked tree ends the moved link non-destructively.
- One missing observation waits. Two consecutive marker-negative misses
  unlink. A unique marker or matching inode relocates; conflicting or ambiguous
  identity unlinks rather than guessing.
- Relocation is serialized and restart-safe: Syncthing stops before the stored
  path changes, the old root is guarded against reappearance, and readiness is
  reported only after restart and targeted rescan. A durable journal replays an
  interrupted transition.
- Manual unlink detaches replica apps into local apps and keeps files. Revoke
  deletes replica ownership. Origin- or recipient-side confirmed deletion uses
  the unlink semantics so received bytes remain where they are.
- Management history is bounded without hiding live or pending rows; recent
  terminal rows fill only the remaining capacity.

## Decisions that changed during implementation

The initial manual-route probe proved the transport ingredients but also proved
why it could not be the product architecture: it did not repair process restart,
GC, or reprovision. Those mutation routes were removed when the converger became
the sole writer.

The first relocation proposal considered pause–repath–resume. A live probe on
the actual Syncthing image showed that both pause and service stop were safe,
but recreating an empty old root could propagate deletion. The shipped
stop–repath–start sequence therefore includes an old-root guard and a durable
recovery journal.

A user-facing “needs attention” state was rejected. Trackable identity moves;
the first uncertain miss waits; persistent ambiguity unlinks without deleting
files. Infrastructure failures remain `syncing` and retry on the rail.

The first read-mode staging proof exposed a feedback loop in which targeted
rescans were treated as completed repair. The enforcer now waits until the
creator version is locally materialized before consuming queued events.

Single-file sharing remains out of scope because the transport, markers, mount
store, and ignore file are folder-root concepts. Shipping a parent with a
narrow ignore policy is the future-compatible workaround.

## Code map

- Public lifecycle, ignore, and VM wire contracts:
  [`packages/contract/src/shares/`](../../../packages/contract/src/shares/),
  [`packages/contract/src/sync-ignore/`](../../../packages/contract/src/sync-ignore/),
  and [`packages/contract/src/vm/`](../../../packages/contract/src/vm/).
- Durable lifecycle and effects:
  [`packages/backend/convex/domains/shares/lifecycle.ts`](../../../packages/backend/convex/domains/shares/lifecycle.ts),
  [`model.ts`](../../../packages/backend/convex/domains/shares/model.ts), and
  [`effects.ts`](../../../packages/backend/convex/domains/shares/effects.ts).
- Desired-state projection and realization comparison:
  [`packages/backend/convex/domains/shares/syncProjection.ts`](../../../packages/backend/convex/domains/shares/syncProjection.ts)
  and [`packages/backend/convex/domains/workspaces/vmSync.ts`](../../../packages/backend/convex/domains/workspaces/vmSync.ts).
- Filesystem evidence and transition policy:
  [`packages/gateway/src/routes/anchors.ts`](../../../packages/gateway/src/routes/anchors.ts),
  [`packages/backend/convex/domains/shares/anchorTransitions.ts`](../../../packages/backend/convex/domains/shares/anchorTransitions.ts),
  and [`packages/backend/convex/domains/anchors/model.ts`](../../../packages/backend/convex/domains/anchors/model.ts).
- Gateway convergence, relocation, GC, and repair:
  [`packages/gateway/src/sync/share-converger.ts`](../../../packages/gateway/src/sync/share-converger.ts)
  and [`packages/gateway/src/sync/read-mode-enforcer.ts`](../../../packages/gateway/src/sync/read-mode-enforcer.ts).
- Browser request, accept, and management surfaces:
  [`apps/web/spa/files/share-dialog.tsx`](../../../apps/web/spa/files/share-dialog.tsx),
  [`apps/web/spa/shares/recipient-requests.tsx`](../../../apps/web/spa/shares/recipient-requests.tsx),
  [`apps/web/spa/shares/shares-management.tsx`](../../../apps/web/spa/shares/shares-management.tsx),
  and [`apps/web/spa/shares/status-projector.ts`](../../../apps/web/spa/shares/status-projector.ts).
- End-to-end rail and browser evidence:
  [`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic),
  [`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic),
  and the backend/gateway tests beside their owners.

## Visual provenance

The former settings stub is preserved under
[`assets/slice-12/reference/`](assets/slice-12/reference/). The accepted
management surface and comparisons under [`assets/slice-12/`](assets/slice-12/)
were captured for the 2026-07-17 visual gate at commit `779609c5`; reference is
on the left and candidate on the right. They drove the two-state live
vocabulary, incoming/outgoing hierarchy, path privacy, and unlink/revoke
confirmation emphasis.

The real staging states came from run `staging-e2e-synthetic` on
2026-07-17, with API commit `7532d60e` and web commit `b36e704e`. They are
preserved as
[`owner-healthy.png`](assets/final-acceptance/owner-healthy.png),
[`recipient-healthy.png`](assets/final-acceptance/recipient-healthy.png), and
[`owner-ended.png`](assets/final-acceptance/owner-ended.png). These establish
the standard beyond fixtures: both perspectives show healthy convergence, and
the origin management row visibly reaches a terminal state.

## Acceptance record

The live relocation choice is frozen in
[`assets/relocation-probe-verdict.json`](assets/relocation-probe-verdict.json),
and the exact rail-only restart/GC/byte proof is
[`assets/staging-e2e-synthetic`](assets/staging-e2e-synthetic).

The composed scoped result is
[`assets/final-acceptance/acceptance.json`](assets/final-acceptance/acceptance.json).
It is a human-reviewed, sanitized projection of that run's raw `timeline.json`,
produced by the staging harness. It records email and deep-link delivery,
browser acceptance, bidirectional bytes, read repair, same- and
cross-filesystem moves, transient misses, nested move policy, explicit unlink,
both delete-driven unlink paths, revoke after mount pruning, the dedicated
`share-byte-arrival` leg, and zero cleanup orphans. The harness owners are
[`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic)
and
[`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic).
The composed runner's later Firecrawl transport failure is retained explicitly.
