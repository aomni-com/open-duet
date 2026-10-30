# VM telemetry history

Duet keeps a bounded history of each workspace VM's CPU, memory, and workspace
drive usage. The history exists for diagnosis and capacity awareness on the
single-workspace Usage surface; it is not a fleet-monitoring system or a
billing source.

## Why this shape

The gateway already reports observations through the VM sync rail, so
telemetry stays additive to that contract instead of creating a second polling
channel. CPU is derived from two `/proc/stat` snapshots because Linux exposes
cumulative counters, while memory uses `MemAvailable` and disk usage measures
the configured workspace drive mount.

Five-minute storage cadence has its own cursor on the workspace row. Deriving
the cadence from the samples table would add an indexed read to every hot-path
sync poll; coupling it to heartbeat persistence would make telemetry cadence
depend on an unrelated throttle. The cursor and sample are written in one
Convex transaction.

Samples are the sole telemetry history. A daily reaper removes data at the
30-day boundary in bounded batches and schedules a continuation after every
full batch until a short or empty batch proves the expired prefix is drained.
That continuation matters because the tested 500-workspace fleet model
produces more rows per day than one bounded mutation deletes.

The read surface performs one indexed range read with a raw safety ceiling,
then distributes consecutive samples across up to 120 averaged buckets. The
chart positions those points by backend timestamp, so missing samples remain
visible as time gaps without sending thousands of five-minute rows to a
browser.

## Invariants

- Gateway sampling/provider exceptions and backend telemetry-write exceptions
  must not fail VM sync or heartbeat persistence. These observational side
  effects are not VM-health dependencies.
- Sample timestamps come from the backend's injected clock. VM clock skew must
  not reorder history.
- `vmTelemetrySamples` is the history owner. The workspace row contains only
  `lastTelemetrySampleAt`, an atomic cadence cursor; latest telemetry is read
  from the newest indexed sample.
- The gateway computes CPU utilization from a counter delta, clamps it to
  0–100%, and treats regressed or stationary counters as zero.
- History reads require workspace viewer membership. Internal-service reads
  must also carry the authenticated actor; the service credential alone is
  insufficient, so backend authorization remains authoritative.
- Retention work is bounded to 500 deletes per mutation and self-schedules
  until the expired prefix is drained.
- The chart remains a single-workspace view with distinct used and total lines
  for memory and disk, timestamp-proportional spacing, plus explicit loading,
  error, and empty states.

## Deployment invariant

Older deployed workspace documents can contain the removed inline
`vmTelemetry` object. Convex validates existing documents before accepting the
new schema, so an operator must strip those values from every affected target
deployment before pushing the schema containing only
`lastTelemetrySampleAt`. The cleanup and schema push are an ordered rollout;
the final code intentionally carries no permanent compatibility field.

## Decisions and dead ends

- A separate telemetry mutation was rejected because it would add another
  Convex call and workspace read to every VM poll. The persistence mutation
  delegates the side write to the telemetry owner before its heartbeat
  early-return instead.
- Looking up the newest sample to decide whether another is due was rejected
  because it turns the default five-second sync path into a perpetual
  indexed-read path.
- A one-shot daily deletion was rejected after throughput analysis. At
  five-minute cadence it cannot reliably drain a fleet-day within Convex's
  mutation write ceiling.
- Storing only current telemetry was removed rather than retained beside the
  sample table; two owners would eventually disagree.
- The 10,000-row raw-read guard and the browser payload bound solve different
  problems. The raw guard remains, while a separate 120-point averaging cap
  uses the available point budget and keeps the mobile chart legible.

## Code and test map

- Shared wire and browser schemas:
  `VmTelemetryMetricsSchema`, `VmTelemetrySampleSchema`, and
  `VmTelemetryHistoryResponseSchema` in
  `packages/contract/src/vm/index.ts`.
- Linux sampling:
  `sampleVmTelemetry`, `parseProcStat`, `cpuPctFromStatSnapshots`, and
  `parseMemInfo` in `packages/gateway/src/vm/telemetry-sampler.ts`; production
  composition is in `packages/gateway/src/runtime/http.ts`.
- Cadence, storage, retention, authorization, and reads:
  `recordTelemetrySampleIfDue`, `pruneTelemetrySamplesImpl`,
  `listTelemetryHistoryImpl`, and `latestTelemetryImpl` in
  `packages/backend/convex/domains/workspaces/vmTelemetry.ts`.
- Sync integration:
  `persistVmSyncObservationImpl` in
  `packages/backend/convex/domains/workspaces/vmSync.ts` and the
  `readTelemetry` provider in `packages/gateway/src/vm/sync-client.ts`.
- Browser API:
  `registerTelemetryRoutes` in `apps/api/src/routes/telemetry.ts`.
- Product surface:
  `TelemetryHistoryChart` in
  `apps/web/spa/settings/telemetry-history-chart.tsx`.
- Behavioral coverage:
  `packages/contract/src/vm/index.test.ts`,
  `packages/contract/src/endpoints/index.test.ts`,
  `packages/gateway/src/vm/telemetry-sampler.test.ts`,
  `packages/gateway/src/vm/sync-client.test.ts`,
  `packages/gateway/src/gateway.test.ts`,
  `packages/backend/src/vm-telemetry.test.ts`,
  `packages/backend/src/vm-sync.test.ts`, `apps/api/src/index.test.ts`, and
  `apps/web/spa/api/client.test.ts`; chart timing is pinned in
  `apps/web/spa/settings/telemetry-history-chart.test.ts`, and visual states in
  `apps/web/tests/visual/playground.spec.ts`.

## Visual provenance

There was no external reference image or earlier telemetry design to match.
The standard was the existing workspace Usage shell plus deterministic
product-shell fixtures. The populated captures established hierarchy, axis
legibility, used/total distinction, and mobile safe-area behavior:

- [Desktop populated](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/spa-shell-workspace-usage.png)
- [Mobile populated](../../../apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/spa-shell-workspace-usage.png)

The state captures make loading, failure, and no-data behavior part of the
visual contract rather than incidental text:

- [Desktop loading](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/settings-telemetry-loading.png),
  [error](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/settings-telemetry-error.png),
  and [empty](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/settings-telemetry-empty.png)
- [Mobile loading](../../../apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/settings-telemetry-loading.png),
  [error](../../../apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/settings-telemetry-error.png),
  and [empty](../../../apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/settings-telemetry-empty.png)

The visual standard is encoded in the final artifacts: a 120-point response
cap, explicit capacity labels, contrasting total lines, vertical plot-edge
clearance, and local bottom scroll clearance on the mobile Usage section.
