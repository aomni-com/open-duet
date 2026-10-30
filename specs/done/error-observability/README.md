# Lost request diagnostics

A browser sign-in investigation reached a generic session-exchange failure after
authentication had succeeded. That motivated an audit of consumed failures, but
logging every catch would obscure incidents with expected fallback and retry
noise. The retained scope is the few request boundaries where useful transport
evidence has no other owner.

## One owner for each failure

The handler that converts an exception into a generic response owns its missing
diagnostic. Shared fetch helpers remain silent: their callers may rethrow to the
framework, retry, recover, or store the failure durably. An upstream HTTP failure
alone does not justify a second log.

API diagnostics are opt-in for explicit working-directory changes and agent
deletion. Session dispatch also serves a recurring recovery loop, and interrupt
has a durable fallback; both were excluded after tracing their callers.

Model forwarding logs only when its durable failure recording also fails, or
when a recognized transport failure has no generation record. A backend request
ID links to a recording exception already owned by Convex; the gateway does not
copy its text. A successful recording remains quiet, including reservation
release whose existing reason is deliberately generic.

Hosted MCP retains local authentication-connection causes, while invalid
credentials and upstream HTTP failures remain quiet. Edge diagnostics cover
selected-origin transport failures; resolver failures, served-path reporting,
SSE and WebSocket reconnect requests are excluded. Ordinary HTTP callers may
retry externally, so this is not a global outage deduplicator.

## Safe, bounded evidence

The shared `safeTransportCode` projection accepts known runtime codes and examines
at most four Error objects, including the original error. Arbitrary messages, stacks, URLs, headers, bodies and
provider output do not enter these new diagnostics. Unknown causes are omitted
unless a failed generation-recording operation supplies useful correlation.
The small shared projection prevents divergent disclosure rules; each service
still owns the decision to log.

Diagnostics use existing console sinks and cannot replace the original failure
response if reporting itself throws. Public responses, cancellation behavior,
cache invalidation, recovery, retries and billing behavior remain unchanged.
No endpoint, database field, background task, dependency or telemetry service
was added. Browser-wide capture and the original exhaustive catch inventory
were rejected because handler count does not establish a debugging gap.

## Code and verification

- [API gateway client](../../../apps/api/src/gateway/client.ts): `callAgent` and
  its request-boundary regressions in `client.test.ts`.
- [Model gateway](../../../apps/model-gateway/src/index.ts):
  `logUnrecordedForwardingFailure`, covered by `forwarding-diagnostics.test.ts`.
- [Hosted MCP](../../../apps/mcp/src/http.ts): authentication boundary, covered
  by `http.test.ts`.
- [Edge dispatch](../../../apps/edge/src/index.ts): origin failure boundary,
  covered by `index.test.ts`.
- [Safe projection](../../../packages/contract/src/redaction/index.ts):
  `safeTransportCode`, exercised through those service boundaries.

The request-boundary regressions cover retained causes, quiet exclusions,
unchanged responses, sink failure and recovery on a subsequent request.
The original browser-session diagnostics are separately owned by
[request-failure](../../../apps/web/src/server/request-failure.ts).

Verification: focused request tests, types/lint and independent code review pass.
The repository-wide run passed 21 package tasks; sleep interrupted backend and
model-gateway fixtures. All 172 tests in the nine affected backend files and all
83 model-gateway tests passed subsequent uninterrupted runs. Visual coverage,
visual owner union and asset ownership checks also pass. No live failure-injection
endpoint was added for staging verification.
