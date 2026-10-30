# Live-app SSE transport verdict

## Verdict: PASS after edge lifecycle repair

An app-owned SSE stream reaches the real session pane through the gateway
loopback proxy and public edge, remains incremental, reconnects naturally at an
edge-owned segment boundary, resumes from `Last-Event-ID`, and releases every
app writer. The shipped app contract can rely on native `EventSource` again.

The edge owns the hosting lifecycle without owning app state: it opts into
downstream request cancellation, forwards cancellation through both proxy hops,
and ends only app `text/event-stream` responses while the function is still
alive to cancel its upstream reader. Apps continue to own events, ids, and
resume semantics.

## Passing staging evidence

The recorded repaired run was
`staging-e2e-synthetic` from Git commit `8d80814f`.

- The ordinary pane selected the app from session `cwd`, completed both launch
  redirects, and received the secure, HTTP-only app-access cookie.
- The public edge returned `200 text/event-stream`. Sixteen frames arrived as
  separate chunks. The fifteen measured heartbeat gaps ranged from 14.858 to
  15.234 seconds.
- The raw segment ended with a clean EOF after 240.492 seconds, while the edge
  invocation still had time to clean up. Its last event id was 16.
- The iframe constructed one native `EventSource`. It opened twice with one
  intervening error, reconnected after 4.302 seconds, sent
  `Last-Event-ID: 16`, and received event 17 first. Neither the outer document
  nor iframe document navigated or reloaded.
- `POST /api/tasks` returned 201 and its marker appeared in the existing iframe
  after 1.028 seconds, inside the five-second contract.
- Writer accounting stayed exact. At the segment boundary the three total
  writers were two closed plus the one reconnected iframe writer. Closing the
  pane produced `opened=3`, `closed=3`, `active=0`; the replacement-window
  cancellation probes left the same zero-writer final state.
- All seventeen programmatic requests sent `Accept: text/event-stream`; five
  occurred during app replacement and none received the building page.
- Cleanup passed: all six ledgered resources were deleted, no orphans remained,
  and the run's exact VM was absent from exe.dev.

## Failure that established the repair boundary

The pre-repair run was
`staging-e2e-synthetic` at Git commit `7f0e1bc3`.
Streaming itself was already sound: twenty heartbeat frames arrived
incrementally and the raw response reached clean EOF after 300.263 seconds.
Recovery and cleanup were not. The iframe never opened a replacement request,
never sent its last event id, and abandoned writers remained active after both
the segment end and pane close.

That comparison rules out buffering, SSE framing, and application state as the
cause. Waiting for the hosting platform to terminate the function was the
broken owner boundary; proactive edge closure plus ordinary HTTP cancellation
is the repaired contract. Increasing `maxDuration` would only move the same
boundary and remains intentionally out of scope.

App-access sessions retain their pre-existing eight-hour TTL. An overnight pane
can therefore still look open after its authorization expires; this gate did
not change that separate limitation.
