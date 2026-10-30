# Device-auth slice 05 feasibility spikes

Run date: 2026-07-24. These are test-infrastructure prototypes only. No
production route, public export, schema, backend domain, or UI changed.

## Verdicts

| Spike | Verdict | Evidence |
|---|---|---|
| 05A — SSRF-safe pinned fetch | **pass (mechanics) / in-Vercel leg deferred to slice 08** | 9 tests/65 assertions over the adversarial corpus; the pinned-lookup probe runs green under local Node 24 against ctl-staging (verdict `local-only-not-kill-gate-evidence` by design). The true in-Vercel run rides slice 08's staging validation, where the CIMD fetcher executes in the deployed runtime for real. Lead fixed a probe bug: Node 24 detaches `response.socket` before `end` — capture remoteAddress at headers time. |
| 05B — refresh-family atomicity | **pass** | Lead ran the real Convex fixture: 4 tests/15 assertions green in a local Convex deployment — rotation, grace re-rotation, family revocation, and the concurrency race. Required a committed `node_modules` symlink in the fixture dir (non-workspace member; convex dev's bundler cannot resolve `convex/server` without it — same root cause as the known convexDev temp-project failures). |
| 05C — MCP client conformance | **pass** | Real clients from the pinned MCP SDK complete both registration modes against an in-memory AS/RS at root and negotiate protocol revision `2025-11-25`. |

## 05A — SSRF-safe pinned fetch

### Proven here

`resolveClientMetadata(clientId, { resolveDns, requestPinnedAddress, now })`
accepts only HTTPS metadata URLs without credentials, resolves every A/AAAA
answer, and rejects the whole answer set if any address is non-public. The
deterministic corpus covers IPv4 and IPv6 unspecified, loopback, private,
shared, link-local, documentation, benchmarking, multicast, reserved, and
IPv4-mapped-IPv6 addresses. IPv4-mapped IPv6 is rejected even when the mapped
IPv4 address would otherwise be public.

The chosen public address, address family, five-second deadline, 64 KiB body
limit, TLS SNI name, and HTTP Host value cross the injected transport seam.
The resolver rejects transport evidence when the connected socket address,
SNI, or Host differs from the validated target. Redirects are manual, limited
to three, and repeat URL and DNS validation at every hop. Local fixtures also
prove redirect-to-private rejection, a DNS-rebinding socket mismatch,
oversized response rejection, exact `application/json`, exact original-string
`client_id` self-match, elapsed-time rejection, and the redirect bound.

The transport prototype uses the first address only after validating the
complete DNS answer set. This is conservative: one unsafe answer rejects the
metadata URL instead of trying another address.

### Kill criterion

**pass (mechanics; in-Vercel leg deferred to slice 08 — see Verdicts).** Local behavior proves the resolver contract but cannot
prove that the deployed Vercel/Node runtime honors a custom `node:https`
`lookup`, preserves TLS SNI/Host, and connects to the selected address.

The runnable probe is
`packages/test-harness/scripts/device-auth-pinned-fetch-runtime-probe.ts`.
It performs a real HTTPS request with an injected one-address lookup, caps
time and bytes, and compares the selected address to the TLS socket's remote
address. Local execution deliberately reports
`local-only-not-kill-gate-evidence` and exits 2.

Lead command, executed **inside the deployed Vercel Node runtime**:

```bash
node --experimental-strip-types packages/test-harness/scripts/device-auth-pinned-fetch-runtime-probe.ts https://service.example.invalid/
```

Pass requires JSON with `verdict: "pass"`, `runtime.vercel: true`,
`lookupCalls: 1`, `selectedAddress.address === connection.remoteAddress`
(allowing IPv4-mapped socket notation), and
`connection.servername === "service.example.invalid"`.

### Local transcript

```text
bun test .../resolve-client-metadata.test.ts \
  .../device-auth-refresh-spike.test.ts \
  .../mcp-conformance.test.ts
16 pass, 0 fail, 92 expect() calls across 3 files, 63 ms
```

The 05A portion is 9 tests and 65 assertions. During red/green work the
missing implementation failed first; targeted falsifications of address
classification, connection-evidence checking, response bounds, and exact
client-id matching each failed for the expected reason before restoration.

### Artifacts retained

- `packages/test-harness/src/device-auth-spikes/resolve-client-metadata.ts` —
  spike-only resolver and injected transport contract for slices 08–09 to
  consult.
- `packages/test-harness/src/device-auth-spikes/resolve-client-metadata.test.ts`
  — deterministic adversarial corpus and future regression reference.
- `packages/test-harness/scripts/device-auth-pinned-fetch-runtime-probe.ts` —
  the outstanding deployed-runtime kill-gate probe.

## 05B — refresh-family atomicity

### Proven here

The pure transition models a grant-family row containing hashes only and a
monotonic generation. Presenting the head advances the generation and moves
the old head into predecessor grace. Presenting that immediate predecessor
within the 30-second fixture grace replaces the current unclaimed successor
at the same generation. It does not extend the predecessor's original grace
deadline. A deeper ancestor or an immediate predecessor after grace revokes
the family without replacing its live head.

Applying two same-head presentations serially yields `rotated` followed by
`graceRerotate`, leaves exactly one descendant, and does not revoke the family.
That is the state Convex's serializable mutation contract should produce when
concurrent calls conflict and one transaction retries against the first
commit.

The real fixture keeps lookup, comparison, transition, and patch inside one
Convex mutation. Its caller supplies the next access and refresh **hashes**;
raw token generation is intentionally outside this atomicity spike. The
mutation surface identifies a family from `presentedHash` rather than trusting
a caller-supplied family id. The spike uses a bounded table lookup; slice 07
must replace that fixture-only lookup with an index owned by the durable token
model.

### Kill criterion

**pass (lead ran the Convex fixture green — see Verdicts).** The pure state machine passes, and actual Convex
serialization and concurrent mutation behavior are not proven here. The
checked-in harness fails before deployment startup because the sandbox cannot
reserve `192.0.2.1`:

```text
error: Failed to listen at 192.0.2.1
syscall: "listen"
errno: 1
code: "EPERM"
0 pass, 1 fail
```

Lead command:

```bash
bun test packages/test-harness/src/device-auth-refresh-convex-spike.test.ts
```

Pass requires all four fixture tests, especially the `Promise.all`
concurrency case, to finish green. A concurrency result with two live
descendants or a revoked family is a **kill** and requires reshaping slice 07.

### Local transcript

The 05B pure portion of the combined run is 5 tests and 16 assertions. It
proves head rotation, grace re-rotation, deeper-ancestor revocation,
post-grace revocation, and the serial same-head race. The initial tracer test
failed against an unimplemented transition, and a temporary grace
re-rotation falsification failed with `rotated` instead of
`graceRerotate` before restoration.

### Artifacts retained

- `packages/test-harness/fixtures/device-auth-refresh-convex/` — isolated
  schema, transition, and mutation fixture; it cannot affect Duet's production
  Convex schema.
- `packages/test-harness/src/device-auth-refresh-spike.test.ts` — locally
  runnable pure transition proof.
- `packages/test-harness/src/device-auth-refresh-convex-spike.test.ts` — the
  outstanding real Convex lifecycle, hashes-only, and concurrency proof.

## 05C — MCP conformance

### Proven here

The repository resolves `@modelcontextprotocol/sdk` to **1.29.0**. A real SDK
`Client` and `StreamableHTTPClientTransport` drive an injected-fetch AS/RS
fixture with the SDK's `WebStandardStreamableHTTPServerTransport`; no
listener or network substitute is involved.

The observed flow is:

```text
POST https://mcp.example/
401 WWW-Authenticate resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"
GET https://mcp.example/.well-known/oauth-protected-resource
GET https://auth.example/.well-known/oauth-authorization-server
AUTHORIZE resource=https://mcp.example/ method=S256
POST https://auth.example/token resource=https://mcp.example/ pkce=true
POST https://mcp.example/
INVALID_ORIGIN status=403
```

The fixture proves RFC 9728 protected-resource discovery, RFC 8414
authorization-server metadata, `resource` in both authorization and token
requests, independent S256 verifier checking, dynamic client registration,
HTTPS metadata-document URL as `client_id`, MCP at root `/`, a real
`listTools` result (`spike-proof`), invalid Origin rejection, and negotiated
MCP revision `2025-11-25`. DCR and URL-form client id use separate runs
because the SDK selects those registration mechanisms mutually exclusively.

### Kill criterion

**pass.** The pinned SDK and its web-standard transports satisfy the required
revision and root-path flow. No SDK upgrade or transport adapter is indicated
by this spike.

The 05C portion of the combined run is 2 tests and 11 assertions.

### Artifacts retained

- `packages/test-harness/src/device-auth-spikes/mcp-conformance.ts` — reusable
  in-memory protocol fixture and observable transcript owner.
- `packages/test-harness/src/device-auth-spikes/mcp-conformance.test.ts` —
  DCR and URL-client-id conformance guards.

## Choices and deviations

### Choices

- 05A uses 3 redirects, 64 KiB, and 5 seconds as conservative spike limits;
  later product work may tighten them but must keep all three bounds.
- 05A rejects a mixed public/private DNS answer set and all IPv4-mapped IPv6,
  avoiding address-selection ambiguity.
- 05B grace re-rotation keeps the generation and original grace deadline
  while replacing the unclaimed successor; only a head rotation advances the
  generation.
- 05B accepts newly minted hashes as mutation inputs so no raw token material
  enters Convex storage or mutation results.
- 05C uses two real-client runs because DCR and URL metadata client id are
  alternative SDK registration paths.

### Deviations

- 05A's deployed-runtime probe is checked in but not executed here because
  this task has no network or deployed-runtime access.
- 05B's Convex tests are red-green-ready but cannot run here because local
  listener creation fails with `EPERM`; the pure proof assumes Convex retries
  conflicting mutations against committed state.
- 05C uses the slice-permitted real MCP client rather than Inspector.

## Cleanup

All retained files are durable spike evidence or outstanding lead-run probes.
No disposable scratch modules remain. Temporary source mutations used to
prove tests could fail were restored. The temporary Node bundle under
`/private/tmp/device-auth-probe-build` was deleted after its build check.

## Integrated verification

```text
bun run check-types
23 successful, 23 total

bunx oxlint <all spike TypeScript files>
exit 0

bunx tsc --noEmit --strict --target ESNext --module NodeNext \
  --moduleResolution NodeNext --types node,bun \
  packages/test-harness/scripts/device-auth-pinned-fetch-runtime-probe.ts
exit 0

bun build packages/test-harness/scripts/device-auth-pinned-fetch-runtime-probe.ts \
  --target=node --outdir=/private/tmp/device-auth-probe-build
Bundled 1 module; exit 0
```
