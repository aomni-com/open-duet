# Backend lifecycle foundation

This receipt covers backend admission, effects, teardown, and address projection.
Public REST and visual acceptance remain owned by their later gates.

The focused backend suite drives real Convex functions with `convex-test`, registers
actual ActionRetrier component functions, and controls Vercel HTTP responses. Its
provider assignment map is the final cleanup oracle. It does not run a real Vercel
operation, provision a VM, or add a test-only product endpoint.

Foundation verification: `bun test ./src/custom-domains.test.ts` — 9 passing
cases, 32 assertions; backend `check-types` and focused oxlint passed. Occupancy,
app/workspace/replica teardown, and metadata projection began red. Ownership
verification, late-add cleanup, and repair receipt assertions were additionally
falsified by deliberate production defects, then restored and passed together.

The lifecycle uses the existing ActionRetrier component's run identity,
completion, and infrastructure recovery. A removal never cancels its admitted
add/check. It keeps the reservation until that run finishes and captured-target
cleanup completes. Recovery reads terminal run status if a completion callback was
missed. The worker selects only available concurrency slots and advances due times;
it carries no expiring reservation lease or independent retry service.

Self-review across shape, diff, and docs is complete for this foundation. The local
Codex CLI review could not start because the configured model is unsupported by
its account; peer review and remaining hardening tests are pending. This is not a
slice 03 completion verdict.

## Bounded diagnostics checkpoint

The aggregate API now accepts `{ paginationOpts }` and returns a Convex page,
ordered by domain creation time/ID. It reads only the indexed listed lane, at most
five diagnostic rows. App, replica, and workspace teardown remove their slot from
that lane. The `customDomainDiagnostics` child keeps provider payloads out of
recurring app/VM metadata reads; its required pointer is created atomically and
successful observations replace that same child.

The focused suite now passes 12 cases and 47 assertions. A fixture with maximum
record/conflict values across all 100 apps reads full configs within enforced
Convex limits, retains exact diagnostic values through five-row pages, and
continues to the next page. Deliberately loading those diagnostics through the
summary join fails at the real 16 MiB read budget; restoration passes. Component
fixture cleanup cancels pending retries before restoring the external transport.

## Lifecycle hardening

The expanded focused file passed 18 cases and 81 assertions before the final
pruned-run variant. That strengthened cancellation case separately passed all
seven assertions after its missing-run fix, and the other 16 short cases passed
again (67 assertions). Backend typecheck, focused lint, and diff checks passed.
The file includes real
ActionRetrier cleanup backoff through all six attempts, manual retry of that
same work ID, 55 due slots with observed provider concurrency at most five,
missing-credential admission/read/removal behavior, and retry after an initial
failed add. Operational parser failures preserve an active binding; successful
unready and missing-assignment observations demote it. No external provider or
staging resource was touched.

The original cancellation fixture held a fetch promise while ignoring its abort
signal. It proved retention during that controlled wait, but did not prove remote
effect settlement. That assurance is superseded: a native fetch abort against a
local HTTP server returns while the server still owns its delayed alias write.
Waiting for rejected transport promises cannot prevent that late commit.

The uncertainty suite uses real native fetch and local HTTP servers for delayed
ADD and DELETE effects. After abort, public retries retain the reservation; the
server completes its effect later; an explicit operator settlement acknowledgment
then permits captured-target cleanup and safe subsequent attachment. Deliberately
removing DELETE admission made the native-delete case fail. Server errors after
committed adds also quarantine; verification errors and cancellation before alias
dispatch remain operational failures. Every new regression was falsified against
its owning production branch and restored green.

`convex-test` rejects finishing a canceled in-progress scheduled callback, so the
cancellation case pauses only the fixture's pending scheduler trigger and invokes
the real domain worker under its admitted component run. The run cancellation,
cleanup, domain functions, and provider transport remain real at their respective
seams. This case does not claim to validate production scheduler termination.
ActionRetrier owns ordinary crash/retry recovery. Admitted alias writes with no
known completion leave the worker pool and enter indexed operator repair; their
hostname remains reserved without a clock-based lease. Component cancellation and
run pruning do not clear that quarantine.

The uncertainty closeout ran both focused files: 23 passing tests and 101
assertions, including the six-attempt cleanup backoff. Focused lint and diff checks
passed. The isolated backend type check reported only serving-contract skew:
the shared contract already has `app-host`, while this checkout's older
`convex/http.ts` does not yet handle it. Serving integration owns that remaining
cross-branch check; no domain-file type error was reported.

Shape/diff/docs self-review is complete for this backend pass. The account's
configured CLI review remains unavailable; parent-owned peer review, public REST
transport traces, UI gates, and live staging are separate remaining acceptance
work. This receipt does not mark slice 03 or the complete feature done.
