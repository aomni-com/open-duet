# Choices ledger — public desktop

These product and architecture choices were settled before implementation.
Implementation-time judgments are appended here, least-confident first, and
audited at every maintenance checkpoint.

## Settled by the user

1. Public primitives, not an SDK or component kit, are the product. Customers
   should be able to reproduce Duet's web desktop pane using the public API.
2. Mint, status, and focus are public under the existing workspace `sessions`
   capability. There is no desktop scope and no credential-kind fork.
3. The mint request carries exact `embedOrigin`. The response keeps
   `entryUrl`, `expiresAt`, `phase`, and real VM `screen`; redundant `token`
   and any other redundant fields are deleted.
4. Exact per-grant origin binding is required. A wildcard is only a reslice
   fallback if the exact design proves structurally unworkable.
5. Grant expiry is admission-only. An admitted viewer stays connected until
   network/frame teardown. Proactive 90-second iframe replacement is deleted.
6. Add one general authenticated API limit: 600 requests/minute per stable
   principal. Desktop calls participate normally; there is no extra desktop
   limiter. Existing stricter limits remain.
7. Every desktop is reached through the agent route, including `root`. The
   workspace-level view remains hidden and is not taught.
8. Agent handoff supports both requesting human action and showing the human
   something. The exact presentation tab is focused before linking.
9. A handoff question follows the ordinary Markdown link as one separate
   `ask_user_question` call with the option labels `Done` and `I'm stuck`,
   producing the terminal `ask` event.
10. Headed browser beats Firecrawl when human viewing or interaction is part
    of the intent. Cross-window visibility is allowed; this is one shared VM
    trust domain.
11. Hard cutover: no compatibility route, old request reader, dual response,
    or migration.
12. The work ends only after the exact staging-tested image is promoted without
    rebuilding and both staging and production fleets are reprovisioned.

## Architecture judgments from exploration

- Canonical origin validation lives in the shared contract so API, gateway,
  docs, and tests do not develop competing grammars. Input must exactly equal
  `new URL(input).origin`; normalization is not a second accepted spelling.
- The gateway resolves an authorized grant to its payload and writes a
  per-response CSP. It does not mutate a workspace/global origin allowlist.
- Expired digest grants are swept on insertion and the live registry is
  bounded. Capacity refusal never evicts a valid grant.
- The limiter consumes only after successful authentication. Credential rows
  own API/OAuth/app/sync-device buckets; user ids own browser/impersonation
  buckets. `system_vm` and auth-bypassed routes consume nothing.
- The web frame and status poll are separate lifecycles. Expiry does not hide
  or replace an already-admitted frame. Remint triggers are component mount or
  route/page reload and the browser `online` event—not a timer and not an
  unobservable iframe-internal socket event.
- The existing `agent-browser-windows` journey remains the one live owner;
  this feature extends it rather than creating a second desktop lifecycle.

## Audited implementation choices

### Sound — medium confidence

**A transient browser batch failure gets one fresh-batch retry.** A resumed
handoff correctly started a new browser batch but reported failure when that
socket or target became unavailable. The workspace-browser skill now tells the
agent to run `duet-browser` once more and rediscover the page by URL, title, and
visible witness. If the replacement also fails, it reports the blocker instead
of looping. The alternative was treating a recoverable batch lifetime as the
end of the human workflow or allowing unbounded retries. Verdict: sound because
browser batches are intentionally temporary and rediscovery is already the
cross-turn identity rule. Confidence: medium; the focused live journey passed
with the recovery-aware bundle but did not deliberately force the retry branch.

**Live handoff attribution follows the active target, not batch inventory
order.** One agent turn may invoke `duet-browser` more than once, so multiple
new batches can exist before the terminal question. The journey finds which new
same-owner batch contains the native window's active target, then snapshots all
batch ids present before answering. Resume must create a batch absent from that
entire snapshot while returning native focus to the marked target. The
alternative was treating the first inventory row as the handoff batch, which
made a correct multi-batch turn fail and could misclassify another pre-answer
batch as the resumed one. Verdict: sound because both handoff identity and
resume chronology are derived from observable semantics. Confidence: medium;
the focused live journey passed this oracle once with multiple batches.

**The two-turn browser handoff gets a local twelve-minute progress budget.**
The live journey's resumed browser turn was still emitting durable progress when
the former six-minute history wait expired. Both the initial handoff and resumed
turn therefore use a 720-second bound inside the handoff module, comparable to
the repository's existing long agent-work budgets. Shared browser, history, and
desktop waits remain unchanged. The alternative was raising a generic timeout
and masking unrelated stalls. This is still a hard deadline with a retained
history tail when it fails. Verdict: sound because the longer budget follows
observed useful work without widening other workflows. Confidence: medium; the
focused live journey completed both turns within the local ceiling.

**A normal page reload is the viewer's explicit retry.** When a viewer needs a
new capability, reloading or remounting the agent Desktop page destroys the old
component and mints a new URL; returning online also remints. The alternative
was a second in-pane Retry button and state machine, even though the iframe
cannot tell its parent that Kasm's internal socket closed. This keeps one real
retry path and means future viewer UX should not add a hidden refetch-only seam.
The plan left the exact retry control open. This choice constrains reconnect UI.
Verdict: sound because every observable trigger exists in production and is
tested. Confidence: medium; a dedicated button remains a reversible future UX
choice.

### Sound — high confidence

**Public iframe acceptance uses an inert document on the allowed app origin.**
The staging viewer intercepts a test-only URL under the real app origin and
serves the one iframe it needs. Loading the full product app and then replacing
its DOM left product hydration and navigation alive; they could remove the
iframe or close its pending socket wait even though desktop admission was
healthy. The alternative was retrying that race or adding a production probe
route. This choice keeps exact `frame-ancestors` enforcement while giving the
public iframe test one controlled variable and adds no deployed endpoint.
Verdict: sound because the browser still supplies the real allowed origin and
the live iframe uses the real gateway capability. Confidence: high; repeated
failures identified the product-document race and the unit test pins the probe
origin.

**A premature completed handoff turn fails immediately with redacted history.**
The live observer waits for either the required terminal question or a completed
turn. If the agent completes without asking, the journey writes its full history
through the credential-aware artifact collector and fails immediately. The
alternative was waiting the entire handoff budget for an `ask` that can no
longer occur, while retaining only event names too weak to diagnose the agent's
browser failure. Verdict: sound because `complete` is terminal and the retained
artifact preserves evidence without leaking capabilities. Confidence: high;
the regression test pins the terminal decision and the artifact collector owns
redaction.

**Human-handoff acceptance observes completion through durable history, not a
long-held answer request.** After the person chooses `Done`, the desktop journey
submits the answer through the ordinary asynchronous endpoint, receives `202
Accepted`, and polls the session's persisted event history until the resumed
turn completes. Its job is to prove the browser handoff and rediscovery, not how
long one HTTP connection can remain open. A separate foreground-session-waits
journey owns `/answer/wait`, including its continuation and disconnect behavior.
The earlier combined shape let a 266-second platform connection deadline fail
an otherwise valid browser resume. The plan required a live answer/resume but
did not assign the wait transport. This choice keeps each journey's failure
signal tied to the behavior it owns and means future handoff checks should use
durable history unless the wait transport itself is the subject. Verdict:
sound; the same public answer is delivered, while completion is read from the
system's durable source of truth. Confidence: high.

**Revocation is verified with the credential being revoked.** The live journey
creates a temporary sessions-scoped API key, deletes it during cleanup, and then
uses that same key to call desktop status. Only `401 Unauthorized` proves the
key has lost its authority. The earlier verifier instead listed API-key metadata
using the fixture's separate browser-session credential. Because the shared
cleanup ledger performs every cleanup before its verification pass, that
separate credential may already have expired or been revoked even though the
temporary key was cleaned correctly. The plan required credential-free cleanup
but did not specify its oracle. This choice means future resource cleanup should
prove the deleted resource's own authority is gone rather than depend on another
temporary resource surviving long enough to inspect metadata. Verdict: sound;
it tests the security outcome directly and rejects a still-live key, transport
failure, or workspace-only failure. Confidence: high.

**One admission decision travels with the HTTP request.** The gateway verifies
the capability and reads its allowed origin once, then carries that result in
request-local context while proxying Kasm. Rechecking later could cross the
expiry millisecond and reject a request that had already been admitted. The
alternative was two clock-sensitive authorizations. The plan required atomic
admission but did not name the transport. This constrains proxy middleware to
consume, not recompute, authorization. Verdict: sound; it directly enforces
admission-only expiry. Confidence: high.

**The live desktop grant registry is capped at 4096.** At 600 requests per
minute and a two-minute TTL, one principal can legitimately hold 1200 grants;
4096 leaves room for concurrent principals while bounding accidental runaway
issuance. When full, the gateway rejects a new grant and never evicts a valid
viewer. The plan delegated the number. This is a local memory/capacity knob,
not a public quota. Verdict: sound with measured headroom. Confidence: high;
fleet occupancy can change the constant later without changing the contract.

**Workspace lifecycle refusal names live in the shared gateway contract.** A
workspace may be paused, still provisioning, unhealthy, or archived. The API
already returned those four states, and publishing desktop errors made the docs
need the same vocabulary. Keeping another copy in the API would let runtime and
documentation drift. The alternative was to leave API-local constants and type
the same strings again in the desktop schema. The plan fixed the public errors
but did not assign the pre-existing lifecycle names. This choice makes every
future public data-plane schema consume the same codes. Verdict: sound because
independently deployed consumers now share one owner. Confidence: high.

**Live acceptance reads the active tab through the VM's native browser
inventory instead of exporting Chrome's loopback debugger socket.** The
staging test runs outside the workspace VM, while Chrome's debugger endpoint
is deliberately bound to loopback inside that VM. The gateway's authenticated
extension-status endpoint reports each native window, its active tab, and the
same Chrome target id that a debugger client would see. Before handoff, the
journey proves the active marked tab belongs to the new handoff batch. After
resume, it separately proves a fresh batch target was created while the active
target returned to that original marked tab. The alternative was to make the
debugger remotely reachable only for a test,
which would add a production capability solely to satisfy the harness. The
plan asked for a direct inventory/CDP oracle but did not settle how an external
runner could cross the loopback boundary. This choice means future live tests
should use the authenticated native inventory for observation and keep raw
CDP VM-local. Verdict: sound because it proves the user-visible active tab
without widening the runtime API. Confidence: high.

**Artifact redaction recognizes desktop capabilities by their full path
shape.** A desktop entry URL contains a public grant id and a secret joined by
a dot under `/v1/desktop/`; either part alone is not sufficient to connect.
The artifact collector now replaces that whole path segment and rejects a
retained file that still contains one. The alternative was to rely only on a
list of known secrets, which cannot catch a newly issued grant URL appearing
in a browser trace before the collector learns its value. The plan required
capability-bearing URLs to be absent but delegated the detector. This choice
constrains future desktop capability formats to update the one generic
artifact detector when their path grammar changes. Verdict: sound because it
catches unknown grants as well as known test secrets. Confidence: high.

**The public example uses Web-standard requests, responses, and DOM APIs
instead of choosing a customer framework.** A customer's server authenticates
its own `/api/desktop/*` routes, then forwards to Duet with the API key; its
browser receives only the short-lived viewer response and mounts an ordinary
iframe. The alternative was a Next.js-specific route and React component,
which would look convenient in our docs but force Express, Bun, Rails, and
other customers to translate framework details before understanding the
security boundary. The plan required copy-runnable backend and browser code
but delegated the language and factoring. This choice makes the example
portable while leaving framework adapters to future demand. Verdict: sound
because the public contract itself is HTTP plus browser primitives.
Confidence: high.

**Customer authentication and workspace selection stay on the customer's
backend.** The sample handler calls an `authorize` callback before mint,
status, or focus and reads the Duet workspace slug and API key from server
configuration. It never accepts either value from browser input. Without
that check, any visitor to the customer's site could use the customer's
credential to view or focus the workspace desktop. The plan said the API key
must remain backend-only but did not define the example's application-session
boundary. This choice constrains future examples to show authorization as a
required input rather than an optional comment. Verdict: sound because it
demonstrates the minimum safe public proxy. Confidence: high.

**Full example sources are collapsed until a reader asks to expand them.** An
expanded backend, browser mount, and shared type listing made the mobile guide
more than thirteen thousand pixels tall and buried the status, focus, and
error sections. The final page keeps the exact checked-in executable source
but places it behind native disclosure controls. The alternative was to trim
the example into unchecked fragments or accept a wall of code. The plan
delegated reversible layout. This choice constrains only presentation; the
source remains searchable, copyable, and tested. Verdict: sound because the
guide is substantially easier to scan without weakening runnable evidence.
Confidence: high.

**Mount failure and background failure use different reporting paths.** The
browser example awaits the first mint so its caller sees a rejected mount
immediately. After mounting, status polling and online-event remints report
through `onError` because they happen outside the original call stack. The
alternative was to swallow every error or invent a long-lived promise that
cannot represent repeated background work. The plan required bounded retry
guidance but did not settle this example callback shape. This choice gives
framework adapters a clear place to connect error UI without tying it to the
iframe lifecycle. Verdict: sound. Confidence: medium; a future SDK could use
events or an observable instead without changing the API contract.

**HTTP and WebSocket viewer admissions both consume the ingress-owned grant
decision.** The outer gateway authenticator intentionally lets desktop HTTP
paths reach the origin-aware ingress, but it is not sufficient authority to
upgrade a WebSocket. The upgrade handler therefore calls the same grant
registry used by HTTP admission and refuses an absent, expired, or malformed
grant before reading local Kasm credentials. Reusing the outer syntactic
desktop-path result would admit invented credentials. The plan required one
admission boundary but delegated the runtime wiring. Verdict: sound after
review caught and removed the parallel, weaker WebSocket decision. Confidence:
high; the regression test starts from a syntactically valid unregistered path.

**The general rate-limit schema is one reference-wide protocol fact, not a
field repeated on every operation.** Every ordinarily authenticated endpoint
shares the same principal budget, while some operations retain purpose-built
limits with different bodies. The reference renders the common 429 schema once
and keeps each endpoint's `errorSchema` operation-specific. Repeating the same
block on 136 operations made the reference tens of thousands of pixels longer
and still obscured the distinction between the two kinds of limit. The plan
required public documentation but delegated its factoring. Verdict: sound;
clients see both the shared protocol and local exceptions without schema
duplication. Confidence: high.

**Durable rate-limit contention is retried at the API boundary.** Convex keeps
the exact principal-wide fixed-window counter atomic, but a product page opens
many authenticated requests in parallel and separate serverless instances can
race on that one row. The API retries only Convex's named optimistic-concurrency
failure with at most eight total attempts. Full-jitter exponential sleeps have
ceilings of 10, 20, 40, 80, 160, 320, and 640 milliseconds: at most 1.27 seconds
of sleep before the last failure, excluding mutation latency. Authentication
failures, route errors, and rate-limit refusals are never retried. A disconnected
request does not cancel an in-flight retry, but the fixed attempt ceiling bounds
that extra work; a sixteen-request startup burst can therefore produce at most
128 mutation attempts. Sharding would either make the exact 600-request ceiling
probabilistic or require a second aggregation hotspot, and an instance-local
limit would let callers multiply their budget across lambdas. Verdict: sound
because the public ceiling stays exact while ordinary startup concurrency no
longer leaks a storage-engine 500. Confidence: medium; deterministic tests prove
the classifier, backoff, attempt ceiling, and all sixteen durable counter
increments, while live acceptance did not deliberately force contention.

**Desktop admission retries one transient browser-session 401.** The product
opens several authenticated reads together. During that startup burst, one
serverless request can still present the browser credential that a neighboring
request is rotating, so the one-shot desktop grant may receive `unauthorized`
while ordinary status reads immediately succeed. The desktop session query waits
250 milliseconds and retries that 401 once. It does not retry missing scopes,
workspace refusals, or other API failures, and it still never remints merely
because an already-admitted viewer grant reached its admission deadline. A more
general proxy-level replay would have to buffer unsafe request bodies and change
every product operation for a race observed only at this one-shot boundary. The
refused 401 is emitted by global authentication before route dispatch, so it
cannot have minted a grant before the safe retry. The
plan settled reload and reconnect behavior but did not settle transient initial
browser-session rotation. Verdict: sound as the smallest recovery at the affected
boundary. Confidence: medium; the focused staging startup passed, and the query
lifecycle test proves one 401 recovers and a 403 is attempted once, while
persistent 401s stop after two total attempts.

**Copyable example types stay standalone but are compile-time equal to the
canonical contract.** Customers should not need Duet's private monorepo package
to paste the browser/backend example into their own project. The docs therefore
keep Web-standard local interfaces, while a repository test compares them in
both directions with the contract-owned response types. The alternative was an
internal package import in customer code or an unchecked duplicate. The plan
required framework-neutral runnable examples but delegated drift prevention.
Verdict: sound because a contract edit now breaks the docs build without
reducing portability. Confidence: high.

**Live expiry evidence follows the admitted WebSocket itself at the isolated
deadline.** Rendered canvas
pixels survive a disconnected viewer and aggregate viewer counts can be
replaced by another pane, so neither proves admission-only expiry. The journey
captures the exact public iframe's WebSocket before its grant expires, then,
before agents, focus changes, or other viewer activity can intervene, asserts
that socket remains open while a new admission with the same URL is refused.
Public status must report at least one live viewer, but the proof does
not assume the product iframe remains connected as a second viewer; that is an
unrelated browser lifecycle. Public admission/expiry and human handoff are
separate harness modules so the journey remains a composer rather than another
protocol owner. Verdict: sound; it observes the connection whose lifetime the
contract promises without coupling the count to a different pane. Confidence:
high.

**The live handoff prompt states the outcome, not the procedure.** The staging
journey asks the agent to prepare a visible handoff and later resume after the
human responds, but it does not name the desktop route, browser command,
question terminal, choices, or target-rediscovery rules. Those mechanics must
come from the installed skills; the journey independently verifies the route,
question choices, active target, and fresh-batch resume. A procedural prompt
would make acceptance self-fulfilling and could stay green after the shipped
skill regressed. Verdict: sound because the test exercises the product guidance
customers actually receive. Confidence: high.

**The browser skill shows the terminal question's exact argument shape.** A
weaker live model correctly prepared and foregrounded the page, read the rule
that prose was insufficient, and still ended with a plain-text question. The
runner's tool takes a nested `questions` list whose entries each contain an
`options` list; naming the tool and labels did not reliably teach that shape.
The skill now includes one compact call-shaped example with the required `Done`
and `I'm stuck` labels. The staging prompt remains outcome-only, so acceptance
still proves that the installed skill supplies the procedure rather than
teaching it in the test. Verdict: sound because the example documents a stable
external tool boundary and directly addresses the weakest supported model's
observed failure without weakening acceptance. Confidence: medium; the focused
live journey passed with the published bundle once.

**Live acceptance uses model turns only where agent behavior is the subject.**
The journey originally asked a third browser agent to paint an Alpha heading so
the screenshot was easier to read. That turn added several minutes and could
loop even though the actual assertions need only two Alpha sessions to receive
two fresh batches in one managed window. Alpha now uses the public session path
plus direct VM batch creation for that deterministic ownership proof. Root and
Beta sessions likewise establish their stable owners, then the harness consumes
each batch's one-use gateway CDP grant to write and read the same default-context
cookie through the exact target. The Beta handoff turn remains the real model
oracle for the shipped browser skill, exact tab presentation, terminal question,
and resume behavior. The plan required all of those outcomes but did not require
setup cookies or tabs to be model-created. Verdict: sound because each
model-dependent behavior retains a real model oracle while deterministic browser
state no longer depends on irrelevant shell retries. Confidence: high.

**Named live sessions wait for authoritative agent ownership before browsing.**
Creating an agent updates product metadata before the VM necessarily sees the
new filesystem anchor. A session requested with that new agent's cwd during the
gap can validly resolve as root, after which its browser batch also belongs to
root. The journey now reads the created session snapshot and accepts it only
when its `agent.id` equals the provisioned stable agent ID. A premature
root-bound attempt is immediately deleted and retried within the existing
three-minute desktop bound; every attempt remains in the cleanup ledger. Merely
sleeping for a guessed delay would hide the race rather than observe its actual
completion. The plan required exact owner-window evidence but did not settle
how live provisioning convergence is observed. Verdict: sound because the
acceptance waits on the same public ownership projection that downstream users
consume. Confidence: high after the live inventory exposed the misbinding
directly.

**Chrome restart preserves the Kasm framebuffer service.** The aggregate
desktop target requires Kasm, wants the self-restarting Chrome unit, and orders
Chrome after Kasm. Both services remain `PartOf` the target, so starting and
stopping the target still owns the complete stack, while Chrome's expected
forced-extension restart cannot deactivate the target or replace Xvnc. A held
disposable staging VM proved the prior failure exactly: Chrome restarted once,
the target's `Requires=` edge stopped Kasm, and Xvnc returned under a new PID.
Removing only the browser-to-Kasm edge was insufficient because the target's
reverse requirement still propagated the exit. The alternative was reconnecting
viewers with expired admission URLs or masking a process-lifecycle defect with
relay heartbeats. Verdict: sound because systemd ownership now matches the
independent failure domains. Confidence: high after the rebuilt image passed the
focused viewer-expiry journey and the exact digest rolled through both fleets.

**Live acceptance uses model turns only where agent behavior is the subject.**
The journey originally asked a third browser agent to paint an Alpha heading so
the screenshot was easier to read. That turn added several minutes and could
loop even though the actual assertions need only two Alpha sessions to receive
two fresh batches in one managed window. Alpha now uses the public session path
plus direct VM batch creation for that deterministic ownership proof. Real
root-to-Beta cookie turns still prove the shared browser profile, and the Beta
handoff turn still proves the shipped browser skill, exact tab presentation,
terminal question, and resume behavior. The plan required all of those outcomes
but did not require every setup tab to be model-created. Verdict: sound because
each model-dependent behavior retains a real model oracle while deterministic
window bookkeeping no longer depends on irrelevant content generation.
Confidence: high.

## Rejected alternatives

- Separate desktop scope — duplicates the accepted `sessions` authority.
- Wildcard `frame-ancestors` — makes `embedOrigin` decorative and capability
  leakage easier to exploit in an unintended embed.
- Viewer refresh before TTL — creates visible reconnects and mistakes an
  admission credential for a connection lease.
- Desktop exemption from the global limiter — contradicts a global cost/sanity
  ceiling and creates a privileged high-volume rail.
- Target IDs across turns — ask terminates the runner, fresh batches and tab
  discard can change target identity.
- Firecrawl for human login/show-and-tell — the headed browser is the only
  surface the person can see and operate.
