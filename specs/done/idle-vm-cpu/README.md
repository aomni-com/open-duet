# Idle workspace VM CPU

The shipped pass reduces an idle workspace VM from roughly `0.33 vCPU` to
recorded detached measurements of `0.0052–0.0112 vCPU`, with installed app
servers contributing to the higher result. The lower measurement came from a VM
with no installed apps; the higher came from a representative VM with apps.

Those are deliberately two results, not one flattering headline. “Idle” means
no human is driving the workspace, so always-on workspace apps remain part of
the machine's cost. The pass therefore delivered about a 25× reduction but did
not establish a universal sub-`0.01 vCPU` bound. Closing this work records the
optimization as shipped; it does not redefine the remaining app workload away.

The detailed decision history and measurement caveats remain in
[`choices.md`](choices.md).

## Why the CPU fell

The expensive work was mostly repeated derivation on permanent background
rails. Three changes removed it without weakening user-visible freshness:

- Connected-provider status is read from the VM when a person opens the
  settings surface, rather than spawning a CLI process on every VM sync. The
  stored projection remains the fallback when the VM cannot answer.
- A quiet VM receives a slower sync cadence. User-visible work is pushed
  directly, while reports, credentials, quiescing, runner input, and component
  drift restore the fast cadence. The idle ceiling derives from the heartbeat
  staleness window, because sync is also VM liveness.
- The file-attribution helper caches stable kernel handle resolution and blocks
  in `poll(2)` until an observed descriptor or its stats deadline needs work,
  instead of repeatedly resolving the same handles and waking on an arbitrary
  short timer.

This shape avoids two tempting but wrong optimizations: a long-lived copy of a
VM-owned credential store is stale by construction, and an independently chosen
slow poll can cause a healthy quiet VM to be swept as unhealthy.

## Invariants

- Anything a person waits on is pushed directly to the gateway. The adaptive
  VM sync interval is for heartbeat and background reconciliation, not an
  implicit user-facing queue.
- Quiet means no pending delivery, credential handoff, quiesce, component
  update, or outbound report. Full desired-state lists are not activity by
  themselves.
- The slow cadence stays derived from `VM_SYNC_STALE_MS` and leaves room for a
  dropped heartbeat plus retry. Missing component versions fail toward the fast
  cadence; deliberately paused updates do not.
- Connected-provider rows are a fallback projection, not the truth source.
  Read-time VM observation refreshes them when possible, and VM unavailability
  costs freshness rather than making the settings page fail.
- Provider observation caching is only a short spawn-rate guard. Concurrent
  readers share one probe, and an observation invalidated while the probe is in
  flight is returned to that caller but never cached.
- File-handle resolution caches both successes and failures. File moves
  invalidate the affected handle; directory moves invalidate the whole cache
  because every descendant path may have changed.
- The attribution helper sleeps until descriptor readiness or its stats
  deadline. Changing the stats interval also changes its maximum idle wake
  cadence.
- The idle-poll regression guard measures process CPU plus the instrumented
  provider-probe child's CPU. A spawn count or a stubbed cheap command would not
  pin the regression it is meant to catch.

## Code and tests

- Adaptive sync cadence: `vmSyncPollAfterMs` and
  `MAX_VM_IDLE_SYNC_INTERVAL_SECONDS` in
  `apps/api/src/vm-poll-interval.ts`, pinned by
  `apps/api/src/vm-poll-interval.test.ts`. Version drift is deliberately not a
  fast-cadence trigger — the VM's npm rail paces its own installs.
- Shared heartbeat boundary: `VM_SYNC_STALE_MS` in
  `packages/contract/src/vm/index.ts`, consumed by the API cadence and
  `packages/backend/convex/domains/workspaces/provisioningCore.ts`.
- Read-time provider refresh: `registerConnectedProvidersRoutes` in
  `apps/api/src/routes/connected-providers.ts` and
  `GatewayClient.listConnectedProviders` in `apps/api/src/gateway/client.ts`.
  Route behavior is pinned in `apps/api/src/train.test.ts`; gateway probe caching
  and invalidation are pinned by
  `packages/gateway/src/connected-providers/connect-session.test.ts`.
- Attribution handle caching and idle blocking: `createHandlePathCache`,
  `pollTimeoutMs`, and the helper loop in
  `packages/gateway/src/attribution/helper-main.ts`. The cache and timeout
  policies are pinned by `packages/gateway/src/attribution/helper-main.test.ts`;
  the FFI loop remains legible in the production owner rather than exercised by
  that unit test.
- The real idle-poll CPU budget is pinned by `an idle sync poll stays inside
  its CPU budget` in `packages/gateway/src/gateway.test.ts`.

## Dead ends and bounded residue

- Extending provider-status cache lifetime reduced CPU but left an inherently
  stale control-plane copy. Moving the read to the moment of use removed the
  wrong owner rather than tuning its interval.
- A spawn-count regression test and a test using `/bin/echo` both passed without
  measuring the expensive behavior. The surviving test accounts for actual CPU
  consumed by the runtime probe.
- Measuring over SSH put the observer inside the measurement and produced noisy,
  inflated numbers. Detached collection is the comparison standard.
- Profiling a live staging gateway by stopping it briefly produced no usable
  profile because Bun did not flush on that shutdown path. Do not repeat that
  procedure without wiring profiler shutdown into the service.
- Re-reading Syncthing's stable API key remains a real inefficiency, but measured
  around `0.00007 vCPU`; caching it would add invalidation state for no material
  saving.
- The recorded residual `0.0052–0.0112 vCPU` is diffuse across the gateway,
  attribution helper, Syncthing, kernel work, and workspace apps. Further
  reduction is new work with a new target, not an unfinished slice of this
  shipped pass.

## Release and measurement provenance

The rebuilt VM image was promoted to both environments and left in place. The
closing measurements came from existing VMs that self-updated through the
release rail; no clean measurement was taken from a freshly provisioned VM on
that image. Measurements were collected detached from SSH because the observer
shell and its `/proc` scans distorted earlier samples. There was no UI
visual-design or screenshot-baseline gate; the
original CPU dashboard screenshot was quantitative input, not a visual target.
The measurement procedure and its corrections are recorded in `choices.md`,
especially entries 15–20.
