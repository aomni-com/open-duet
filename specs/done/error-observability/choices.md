# Implementation choices

## Diagnostic coverage

**When:** request-boundary implementation and integration.
**Decision:** Retain API transport causes only for explicit working-directory
changes and agent deletion. Exclude session dispatch, interrupts and background
work rather than instrumenting the shared transport.
**Gap:** The audit identified a generic transport catch without fully tracing
which callers fail the user's operation.
**Rationale:** Dispatch can recover through durable queued work; interrupt has a
durable fallback. Logging their temporary failures would misrepresent recovery
and repeat during outages.
**Consequence:** This work improves final-failure diagnosis, not retry telemetry.

**When:** model forwarding pass.
**Decision:** Successful durable recording remains the sole failure owner. If it
fails, retain the forwarding code and generation ID plus the recording code or
Convex request ID. No-generation failures log only recognized transport codes.
**Gap:** The request did not specify how to represent two failures together.
**Rationale:** Correlation preserves evidence of a missing record without copying
an exception that the backend already logs. A generic no-generation failure adds
nothing beyond the response.
**Consequence:** Media reservation release keeps its existing generic reason;
this change does not enrich records that already exist.

**When:** edge and MCP passes.
**Decision:** Exclude edge SSE/WebSocket requests and cancelled requests, and
exclude MCP upstream HTTP failures and invalid credentials.
**Gap:** Request-scoped handlers can also serve automatic reconnects or expected
authentication failures.
**Rationale:** Those events would create repetitive or duplicate diagnostics;
no new rate-limiting machinery is warranted for this scope.
**Consequence:** Ordinary external HTTP retries can still produce repeated logs
when each attempt loses a recognized local transport cause.

## Evidence and ownership

**When:** combined shape review.
**Decision:** Share one finite transport-code projection in the existing contract
redaction module; keep logging decisions and sinks in each service.
**Gap:** Independent passes produced four slightly different code filters.
**Rationale:** The safe vocabulary is one cross-service rule, while diagnostic
ownership depends on each caller. A generic logging framework would obscure it.
**Consequence:** Unknown runtime codes are intentionally omitted, and examining at most four Error objects
bounds traversal. No arbitrary exception text enters the new diagnostics.

**When:** request-boundary implementation.
**Decision:** Treat diagnostics as best effort and retain the existing response
if a sink throws.
**Gap:** A reporting failure could otherwise replace the operation's failure.
**Rationale:** Observability must not become a new product failure mode.
**Consequence:** A broken logging sink may lose evidence without changing the
customer's status, response or subsequent recovery.

**When:** request-boundary implementation.
**Decision:** Keep operation names and known transport codes, adding an opaque
workspace or generation ID only where it helps locate the failed operation. Use
a backend request ID in preference to repeating a backend exception.
**Gap:** The request did not prescribe diagnostic fields.
**Rationale:** These fields distinguish connection refusal, timeouts and related
causes without collecting user content or duplicating upstream records.
**Consequence:** Operators can correlate failures but cannot reconstruct request
payloads from these diagnostics. This describes the four-service implementation,
not the earlier browser request-failure helper.

## Verification and retained scope

**When:** request-boundary implementation and closeout.
**Decision:** Exercise failures and subsequent recovery through the request
boundary, including quiet exclusions and a throwing console sink, rather than
asserting private helper calls. Reuse existing logging destinations without
adding a live staging failure-injection endpoint.
**Gap:** The request did not specify how to trigger exceptional failures safely
and deterministically.
**Rationale:** Controlled transports test the actual response and diagnostic
contract without introducing a production control surface solely for tests.
**Consequence:** The checks establish behavior under injected failures; they do
not prove an incident was reproduced on live staging or repair the original
customer's account.

**When:** pruning pass, `a4487d769`.
**Decision:** Delete the exhaustive catch inventory and retain a short rationale
with code pointers instead of maintaining a product-wide handler catalog.
**Gap:** The requested audit did not dictate its permanent output format.
**Rationale:** An inventory rapidly becomes stale and encourages logging because
a catch exists, rather than because evidence is missing.
**Consequence:** Excluded handlers are not a backlog; future additions require a
specific debugging gap. Ignoring and untracking artifacts was the user's explicit
instruction, not an agent-selected product change.
