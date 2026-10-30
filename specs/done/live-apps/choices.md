# Live Apps — choices ledger

This ledger preserves the decisions made while Live Apps was planned, measured,
implemented, and closed. The sibling [README](README.md) owns the current
architectural rationale; this file records which ambiguities were resolved and
what future work inherits from those calls.

## Scope boundary

Live Apps is a platform capability: a later conversation can discover an app's
private API, mutate that app's data, and update an already-open pane through the
public host. The platform does not define the app's resource model.

Hello happens to be a task list because a tiny add-and-display interaction is
easy to verify. Its `/api/tasks` routes, task schema, and `tasks.json` file are
worked-example details, not Live Apps contracts. No generic platform behavior
may depend on those names or imply that arbitrary app data is task-shaped.

## User-owned direction

### Applications own their state and events

The platform supplies discovery, routing, and a hosting-safe transport boundary.
Each app owns its API, persistence, event meaning, and UI. This rules out a
central notification service or a platform-owned application-data schema.

### Keep push-based updates after the first staging probe failed

The first deployed SSE probe reached the hosting cutoff, failed to reconnect,
and stranded app writers. That result reopened the transport decision. The user
chose to repair the edge lifecycle rather than replace SSE with bounded polling.
The repaired path had to prove native browser reconnection and zero abandoned
writers before downstream implementation resumed.

### Roll out through newly seeded workspaces

Hello is a worked example in the starter drive, so the rollout is a hard cutover
for new workspaces. Existing workspaces and user-created apps are not migrated,
rewritten, or swept.

## Implementation choices

### Use the registered port and the app README for discovery

The generated app list already knows each registered port. Rendering the
loopback URL there and telling the agent to read the app README supplies the
whole discovery contract. A README-presence marker, new app field, filesystem
scan, or asynchronous prompt projection would add another owner without adding
capability.

The loopback address follows the human visibility description so the public URL
and the VM-local agent URL remain visibly different. Runtime commands and API
scopes stay out of the prompt.

### Segment only app SSE responses at the public edge

The edge closes app responses declared as `text/event-stream` while the hosting
invocation still has cleanup time. Pages, downloads, publishes, and mutations
remain ordinary pass-through responses. The measured safety margin belongs to
the edge deployment contract, not to every generated app.

Cancellation uses the existing HTTP request signal across browser, edge,
gateway, and app. A cleanup endpoint or platform writer registry would duplicate
lifecycle state already carried by the request.

### Let native EventSource reconnect

Apps do not recreate `EventSource` manually to accommodate the hosting boundary.
The platform neither persists nor replays application events. An app may use
events as invalidation nudges and refetch state, as Hello does, or implement its
own replayable log when its domain requires gap-free delivery.

### Keep platform cadence in the builder skill

The main builder skill states the measured hosting behavior. The copyable live
updates reference owns the stable app-side pattern: heartbeat, request-abort
cleanup, and native reconnect. This prevents deployment telemetry from becoming
a second copied constant inside sample code.

### Keep Hello deliberately small

Hello uses dependency-free atomic JSON because replicated SQLite sidecars would
obscure the live-update lesson in a synced starter folder. Process-local write
serialization and atomic replacement are sufficient for the example's API.
This does not establish JSON—or direct editing of the backing file—as a storage
policy for other apps. While Hello runs, its API is the supported mutation
surface; Live Apps adds no file-merge semantics.

The runnable service and page are separate files because the UI and event client
are large enough to hide the API lifecycle inside an inline template. This is
local decomposition, not an app framework.

### Split acceptance by boundary

The generated-app HTTP journey proves public API reachability, persistence, SSE
media type, hosting-safe segment closure, and a subsequent connection. It does
not prescribe an arbitrary generated app's JSON envelope; the unique marker can
appear anywhere in returned JSON.

The browser journey proves the complementary contract in a real session pane:
agent discovery, data-not-source behavior, native live DOM update, stable page
and iframe identity, and cleanup. A model-created marker proves the agent path;
a second direct marker measures app-to-DOM latency without charging model time
to the transport.

Source stability covers the complete app tree recursively. Only the exact
Hello runtime data path is excluded; a same-named file elsewhere in the tree is
still source and must affect the snapshot.

Both journeys use the shared live-to-live gateway convergence fixture so rollout
ordering has one owner.

## Rejected alternatives

- **Bounded polling:** weakens the requested push behavior and makes every app
  compensate for a platform lifecycle failure.
- **A central notification rail:** makes the platform a second owner of app
  state and events.
- **A new app schema field or README marker:** duplicates discovery information
  already present in the registered port and README.
- **Manual browser retry:** spreads hosting-specific lifecycle code into every
  app instead of using standard `EventSource` behavior.
- **Waiting for the hosting cutoff:** the red probe showed that termination can
  prevent upstream cleanup.
- **SQLite for Hello:** sidecar replication and dependencies add noise to a
  worked example without defining better policy for arbitrary apps.
- **A platform task model:** Hello's subject is incidental; Live Apps must remain
  neutral about application resources and storage.

## Evidence that settled the risky choices

The red and repaired transport measurements are preserved in
[`research/live-app-sse-probe.md`](research/live-app-sse-probe.md). The final
public HTTP and real-pane summaries live under [`assets/`](assets/). Those runs
proved the shipped behavior; this ledger preserves why the implementation has
its present ownership boundaries.
