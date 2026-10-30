# Provider parity evidence

The [candidate replay](provider-candidate.ts) calls the production provider adapter
against controlled HTTP responses. Its [complete transcript](provider-candidate-output.json)
and [source identities](provider-candidate-manifest.json) record this implementation
pass. The [frozen reference oracle](reference.md) remains unchanged. This is provider
composition evidence; host routing, authentication, TLS, and real provider authority
remain live-journey gates.

## Matched inputs and explicit deltas

Every frozen provider case has a separate [candidate fixture](provider-candidate-fixtures.json).
The runner executes the identity-verified frozen oracle, then checks every case
identity and every original response body before comparing its complete output.
Candidate fixtures contain no editable expected baseline. Declared differences are
checked against explicit request/output transformations, rather than acting as
free-form excuses for divergence. Additional
scripted point reads supply the destination metadata the old response fixture lacks.
Each candidate case lists the differences it exercises:

- Staging add requests include `gitBranch: "staging"`; production omits it. The
  admitted team and project use the captured target rather than deployment-token
  environment variables.
- Incomplete successful add/read/verify responses cause one additional
  project-domain GET before config is read. The new observation refuses the wrong
  project or branch. A documented omitted production branch represents null;
  successful add/verify mutation responses with omitted branch metadata must be
  inspected even for production. A point GET may omit the production branch, but
  that omission cannot satisfy a staging target.
- Removal prepends a current-assignment GET and checks that destination before
  DELETE. The original DELETE response, including 404, is preserved in the corpus.
- Observations separate ownership verification from DNS routing, return explicit
  DNS/conflict arrays, and include provider apex/destination metadata. Readiness
  remains `ownershipVerified && !misconfigured`.
- The multi-label apex case uses provider `apexName`, giving `example.co.uk` the
  ranked A recommendations instead of the reference's incorrect CNAME.
- Errors carry a stable typed code, retryability and optional HTTP status. Their
  bounded diagnostic does not preserve arbitrary raw error bodies. Generic conflict
  responses remain refusals rather than permission to move an alias.

All preserved successful cases retain complete ordered TXT instructions, routing
recommendations, conflicts, CNAME dot normalization, missing-assignment reads, and
idempotent delete results. The replay asserts complete HTTP method/path/query/header/
body sequences and complete observations or typed errors, not representative fields.

## Add replay and refusal

Only an HTTP 400/409 response with a recognized already-assigned code
(`domain_already_in_use` or `not_modified`) admits an inspection. It succeeds only
when that assignment still matches the captured destination; the adapter never moves
it. The [Vercel add API](https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project)
documents same-project existing-domain 400 and already-assigned 409 outcomes;
[Vercel's error reference](https://vercel.com/docs/rest-api/errors) documents the
`not_modified` domain result. The exact current provider code still belongs in the
live replay test; scripted transport is no evidence that an authenticated token can
perform that operation.

## Local verification

The focused provider file and existing config tests passed. The frozen reference
probe ran once with its source/fixture/output identities enforced. Candidate replay
passed every reference case. Deliberately removing conflict forwarding made
production/reference parity fail against the actual frozen output, then restoring
it returned green. Red/green tracer work introduced the provider operations
and target config; deliberate production falsification also proved the deadline,
body ceiling, remote-target refusal, runtime-token requirement and combined DNS
instruction bound can fail. A stalling-body test exposed an uncancelled response
stream; the adapter now cancels it before releasing the read lock and preserves the
original typed timeout.

The backend's package type check and focused lint passed. Research parity has its
own narrow test beside the replay tooling; it does not pull the frozen Bun build
probe into the Convex type-check graph. Shape review kept one
external HTTP adapter, one captured target and the shared DNS contracts; no SDK,
parallel retry loop, or provider-state database was added. Code review checked
success, missing assignment, transient failure, replay and changed-target cleanup.
No independent CLI review is claimed: the configured account/model failure was
already established in the parent pass, and repeating it would not review code.
