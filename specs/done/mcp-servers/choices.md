# Choices ledger — final

Every decision made **without Example User** while building this feature,
re-audited against the **shipped code** rather than against the pass that made
it. Provisional entries have been collapsed to their end state, entries a later
slice superseded are gone, and duplicates are merged.

Choices only. Test counts, gate results and review findings live in the slice
files and [PROBE.md](PROBE.md); they are not decisions anyone now owns.

Ranked **least confident first** inside each group — start at the top.

---

## Needs your decision

### 1. A deleted workspace revokes nothing at the third party

Deleting a workspace used to strand **every** MCP token and client registration
it ever obtained, permanently: `deleteWorkspaceImpl` is a soft delete that
removes no rows, and afterwards there is no server row, no member and no route
through which anyone could disconnect them. A reap now deletes those rows.

But a Convex mutation cannot make network calls, so the reap **deletes our
record and leaves the third party's grant alive**. It trades a *reachable*
orphan for an *unreachable* one — strictly better than before, since keeping the
rows left both — and it is not clean.

Doing better needs a Convex→`apps/api` rail that does not exist. That is new
infrastructure in service of a cleanup path, so it is your call to want. The
obvious alternative — refusing to delete a workspace until its servers are
disconnected — is worse product.

### 2. Third-party OAuth tokens sit in Convex in plain text

This is D12 and you chose it, but it is worth seeing once more now that it is
real: `mcpServerCredentials` holds access and refresh tokens for third-party
services with no application-layer encryption. The deployment is the boundary.
The table is separate from `mcpServers` so a token cannot leak by a query
forgetting to strip it, and four call sites touch it, all internal-key gated.

---

## Sound, but worth knowing

### 3. The SSRF guard resolves, then fetches

It checks IP literals **and** resolved addresses against every special-use
range, unwraps IPv4-mapped IPv6 so `::ffff:192.0.2.1` cannot smuggle loopback,
uses manual redirects with same-origin-only re-follow, and re-checks every hop.

What it does not do is **pin** the vetted address into the connection, so a DNS
record that changes between the check and the connect can still land on a
private address. Closing that needs a custom dispatcher carrying the original
Host and SNI, which may not be available on Vercel's runtime. The module's
docstring is confident; this is the sentence it does not say.

### 4. The tool-result cap is approximate at the margin

Truncation computes its keep-length in raw bytes while the limit is measured on
JSON-encoded bytes, so a heavily-escaped result can land slightly over the cap
after its single cut. Cutting twice would misreport the original size — the same
trade `storable-event.ts` already makes and documents. The overshoot is bounded by
one part's escape overhead.

### 5. The runner does not surface an MCP result's `isError`

A tool result a server marks `isError` reaches the model as a successful call
carrying that result's text. It is what lets a capped result through, so
nothing here is broken by it — but a server that answers with a deliberate
error is indistinguishable from one that succeeded. The behaviour is in the
published `@duetso/agent` binary, outside this repo, so it is recorded rather
than fixed.

### 6. A failed registration cleanup is one-shot

When two connects race the same authorization server, the loser deletes the
client it just minted via RFC 7592 — once, with no retry. A transient network
failure at that exact moment leaves a permanent orphan on the third party.
Retrying against a server that just refused buys little; the alternative is a
retry loop nobody is waiting on.

### 7. Revocation on disconnect is attempted, never claimed

RFC 7009 mandates a `200` for an unknown token, and every real server measured
(Linear, Notion, Sentry) advertises its **token** endpoint as its revocation
endpoint — almost certainly boilerplate. So the response reports the *attempt*.
Nothing in the product says a third party forgot anything, because we cannot
know it. One POST per token, no retry: the row goes regardless and a human is
waiting.

### 8. The consent callback shares a rate-limit bucket

It uses the existing `oauth_authorize` pre-auth bucket (60/min) rather than its
own, because that vocabulary is a closed list in `@repo/contract` and adding to
it was outside the slice's scope. Heavy MCP consent traffic and heavy Duet-OAuth
traffic therefore contend for one budget.

### 9. `_generated/api.d.ts` was hand-edited twice

`bun run codegen` refuses without a `CONVEX_DEPLOYMENT`, which this worktree has
none of. Both edits are codegen's mechanical, alphabetically-sorted pattern, and
they are verified functionally — the backend tests boot a real deployment that
would fail if the module list were wrong. **Re-run codegen from a configured
checkout before promoting to production.**

### 10. `retryable` exists on the proxy seam and no custom source uses it

The hook is implemented and tested because the shared forwarder needs it, but
refresh-on-401 is a second refresh trigger and a second token-call site, and the
refresh design is expiry-driven only. Left deliberately unbuilt rather than
half-built.

### 11. The agent-principal validator sits under `domains/`

`packages/backend/README.md` says shared validators belong in the top-level
Convex files. It lives with the two functions that give it meaning instead,
which the spec's single-owner table asked for. A real inconsistency with a
written convention; moving it later disturbs nothing.

---

## Sound — decided and settled

### Architecture

**Composio and custom servers share one byte path and nothing else.** They agree
only that a runner's request arrives, an Authorization-shaped header is
injected, and bytes are forwarded. Unifying their lifecycles would have meant an
interface whose methods are `undefined` on one side.

**Custom-server readiness has no owner, on purpose.** D17 says preparation must
never gate dispatch, and the cheapest way to guarantee that forever is to have
no readiness concept that a later change could wire into the fail-closed gate.
The projection writes nothing and takes a read-only context, which is that rule
made mechanical.

**The ten `projectIntegrations` sites were not touched.** Threading a parallel
flag would have reproduced L1's bug for custom servers. The projection is
unconditional instead — measured at under 1 ms, below the noise floor.

**The launch marker carries names only.** No third-party URL and no third-party
token ever reaches the VM; the gateway builds proxy URLs and attaches Duet's own
credential.

**Custom servers get a workspace-scoped proxy URL with no session segment,**
while Composio keeps its session-scoped one — its provider Session is
conversation-scoped and a custom server has none.

**Per-agent policy rows live in their own table.** The Composio projection folds
every row it finds into the disabled-toolkit set it pushes to the vendor, so a
custom server's row in that table would be sent to Composio as a disabled
toolkit. The *rule* is shared; the rows are not.

### Guards that are structural rather than remembered

**`saveClientInformation` is deliberately absent from the OAuth provider.**
Implementing it is what would *enable* the SDK's `registerClient()`, which
strips the two RFC 7592 fields that make a registration deletable. Its absence
means that function cannot run through Duet's provider at all.

**Handing out the refresh token and taking the lease are one transactional
write,** so the token reaches at most one caller per generation. Lease ownership
governs who may fetch; generation governs who may write.

**`failMcpRefresh` checks generation too.** Without it a loser whose lease
lapsed mid-flight reports `invalid_grant` and destroys the grant the winner just
refreshed — the failure path undoing the success path.

**Registration adoption is a compare-and-swap, not an upsert.** Last-write-wins
would leave the winner's client registered on the third party with nothing
pointing at it, and the loser would never learn it had one to clean up.

**Server names forbid `__` and reserve `integrations`.** The name is a tool-name
prefix, so `_` being legal made the joined name undecodable; and because the
config is a `Record`, a server named `integrations` would silently displace the
Composio entry rather than collide.

### Product calls

**No egress warning anywhere, and no confirmation on remove.** Adding a server
is the consent (D13), and a custom server is a URL the user typed — re-adding is
one paste, where a Composio disconnect destroys a provider-side grant.

**No expiry field for pasted tokens.** Duet cannot know when one dies, and a
user-entered guess would be a lie we then acted on. The health signal is the
expiry story.

**`registrationSupported` means CIMD *or* DCR.** A DCR-shaped reading would
report false for Linear, Notion and Sentry — all of which Duet can connect to —
and send users to a token fallback they do not need.

**Only `ready` servers are launched.** A server waiting on a human spends a
connect attempt and a tool-call failure per turn to restate what its row already
says. This is not a readiness gate: a `ready` server that is actually broken
still ships its name and is warned away by the runner.

**"Not authorized yet", not "Waiting for authorization".** Beside a Connect
button the old string claims a flow is already in flight.

**Composio tools now show an "Integrations" chip they never had** — D19 applied
uniformly. Two independent unprimed reviewers were shown it and neither wanted
it suppressed.

**The MCP servers panel renders under the page's error state too,** so a
Composio catalog outage cannot hide a workspace's own servers.

### Verification calls

**Baselines are deleted and regenerated, never force-approved.** On the
integrations page the gate was caught three separate times reporting stale
images as matching — including one that predated the panel entirely.

**Two staging-journey assertions were weakened deliberately, because the strong
form is not observable.** "Exactly one token-endpoint call" became "generation
advanced by exactly one" (the fixture's request log is per-lambda memory), and
revocation asserts a well-formed request was issued rather than that the server
forgot the token (a stateless fixture cannot know).

**The journey's leg order is OAuth-then-static,** because the fixture has one
MCP endpoint that only accepts tokens it minted — so the static leg pastes what
the consent leg produced and every hop stays inside `apps/api`.

**Staging journeys answer the V1 migration dialog instead of clicking it.**
Every run gets a fresh browser profile, so that modal is always offered, and a
modal correctly takes the app behind it out of the accessibility tree — which
made three runs read as "the Connect button is missing" when it was on screen
the whole time. `dismissV1MigrationNotice` seeds the opt-out before the first
navigation, in the shared workspace-browser setup rather than per journey:
clicking would race the dialog's own async appearance, and the previous
per-journey copy had drifted to a key the app no longer reads, so it suppressed
nothing.

**The runner reports a tool call by whether it answered, not by the result's
`isError`.** So a capped result — flagged on the wire purely so a
schema-bearing client accepts it — still shows in the timeline as a successful
call carrying the shortened prose. The journey asserts it that way. Worth
knowing beyond this feature: a server that deliberately answers with an error
result has that presented to the model as a success. That behaviour lives in
`@duetso/agent`, not this repo.
