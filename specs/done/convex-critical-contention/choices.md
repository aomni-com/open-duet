# Choices ledger — critical contention and normal signup refusal

Audit date: 2026-09-11. Audited tree: `c94235162`, against `babf06307`.
Scope: the whole session's implementation and follow-up, including the three
planning agents' recommendations, the review corrections, and the staging work.
This is the first choices audit for this work. The implementation and its tests
are unchanged; this ledger is the audit's only repository addition.

**Review these first:** C01 (unsettled charges and spending limits), C04 (the
Auth dependency patch), and C03 (the rate limiter's reduced usable allowance).
There is **one needs-user choice, no unsound choices, and 24 sound choices**.
“Sound” does not mean cost-free or proven at arbitrary load. Confidence means
how likely the user would have made the same choice, not confidence that a test
passed. Entries are grouped by verdict and ordered by confidence within each group.

The original request was to fix all critical Convex failures. The later request
explicitly required intentional signup refusals to complete without throwing.
Those outcomes are requirements, not invented decisions. The agent-authored plan
selected most of the machinery below; its existence is not treated as independent
user approval. Existing account eligibility, credential scopes, monthly-first
wallet spending and reservation refund rules remain givens from the existing
system. This audit does not reopen choices banked by other features' ledgers.

## Needs-user — decide the product tradeoff; provisional behavior is explicit

### C01. New work can be admitted while known charges are still waiting

**When:** `8428be34d`. **Confidence:** low.

**The choice.** Suppose an account has $1 left. A completed service call submits
a $1 charge, which is saved for a background worker. Until that worker deducts
it, the next request's admission check still sees $1 and may proceed. A paused
or overloaded worker lengthens this interval. The batch size is bounded, but
neither the age nor the dollar amount of waiting charges has an admission bound.
Final deductions remain exact; the spending limit does not include this known,
unapplied liability. Services and model reconciliation already had post-response
billing delays; the new queue can extend them.

```text
save completed call's charge → acknowledge acceptance
next request → check committed wallet and spending → possibly allow
later worker → deduct saved charge
```

The unbuilt alternative makes admission account for accepted charges, or stops
new paid work when a defined delay or exposure limit is reached. That would
change latency and availability as well as the customer's overage exposure.

**The gap.** “Fix contention” did not specify how much delayed billing or
temporary overage is acceptable. The planning agents explicitly raised this
tradeoff; the implementation retained committed-balance admission without a
backlog limit. **The reach.** Every future postpaid service inherits this rule;
the eventual wallet total alone cannot prove that a cap prevented excess work.

**Verdict: needs-user.** Tolerance for temporary spending exposure is a product
and cost decision. **Recommended provisional call:** preserve the existing
postpaid admission rule for this change, label it honestly, and use staging to
measure queued age and amount before choosing a production exposure policy.
This is not a new monitoring implementation or a deployment authorization.
It can be reversed by making admission account for accepted liability; existing
saved charges and ledger entries remain valid. The audit does not halt work or
change admission itself.

Evidence: [admission](../../../packages/backend/convex/domains/credits/ledger.ts),
[queue](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[paused-worker test](../../../packages/backend/src/service-proxy.test.ts).

## Unsound — corrected decisions to redo from

None established by this audit. In particular, the numeric capacity choices
below are accepted as bounded tuning with explicit limitations, not as proofs
that arbitrary traffic can never contend. C01 remains an unchosen product
tradeoff rather than being silently assigned an engineering verdict.

## Sound — medium confidence

### C02. Process eight charges at a time, with a 100 ms pause between batches

**When:** `8428be34d`. **Confidence:** medium.

**The choice.** If twenty charges arrive together for one payer, the worker
selects at most eight, processes that group, then pauses before selecting the
next group. Admission, refunds and grants can use the wallet between batches.
A worker that drained everything in one transaction would hold a larger write
set; a worker that never paused would compete more continuously with foreground
work. Larger batches might improve throughput, and smaller ones might improve
latency for other writers.

```text
select up to 8 pending IDs → apply batch → wait 100 ms → select again
```

**The gap.** No batch size, latency target or sustained-load target was supplied.
**The reach.** These values tune throughput and billing delay. The pause alone
implies an idealized ceiling of 80 items per second per continuously busy lane,
before execution time; this is arithmetic, not a measured capacity promise.

**Verdict: sound.** Small batches and gaps provide bounded transactions and
forward progress in the tested bursts. The exact numbers remain tuning, and
the tests do not establish a sustained-load service guarantee.
Evidence: [worker](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[mixed traffic tests](../../../packages/backend/src/service-proxy.test.ts).

### C03. Spread authenticated requests across 32 randomly selected counters

**When:** `8428be34d`. **Confidence:** medium.

**The choice.** Requests using the same credential previously competed for
eight counter documents. They now randomly select one of 32. This reduces
collisions, but each counter has a smaller allowance: in a fresh 600-request
window, `floor(600 / 32)` is 18, so the total available allowance is at most
576. A request can receive a rate-limit refusal when its chosen counter is full
even while other counters have room. For example, a nineteenth request landing
on the same counter is refused after its first eighteen admissions. The old
random layout also admitted conservatively; this change increases fragmentation.

The unbuilt alternative would coordinate counters to use more of the advertised
ceiling, or use a different admission primitive. That coordination can itself
reintroduce shared writes.

**The gap.** The task named contention, not a target concurrency or usable
fraction of the request ceiling. **The reach.** Authenticated API traffic now
has a specialized counter layout, while lower-volume limiters retain their
existing layout. More shards consume more rows and sacrifice some usable budget.

**Verdict: sound.** The existing limiter explicitly treats its number as an
upper bound, not an entitlement to exactly that many admissions. Local and
staging 64-request bursts support the capacity improvement; they do not prove
universal contention freedom. Future load work should measure refusal rates
and capacity rather than repeatedly increasing the count on one passing sample.
Evidence: [new layout](../../../packages/backend/convex/domains/apiKeys/apiRateLimit.ts),
[existing ceiling policy](../../../packages/backend/convex/domains/shared/rateLimits.ts).

### C04. Maintain a pinned Convex Auth patch to make refusal a normal outcome

**When:** `969995a30`. **Confidence:** medium.

**The choice.** A stranger requests a login email. The account-creation callback
needs to say “no account” without throwing, but the installed library expected
a user ID. The work changes that library contract to accept `null`, meaning an
ordinary refusal before account writes. Email, OAuth and credential creation
propagate the result. Both application consumers pin Auth to `0.0.94`; Bun
applies a checked-in patch containing the TypeScript, runtime JavaScript,
declarations and generated maps when dependencies are installed.

An application-only precheck would duplicate the gate and leave the underlying
callback unable to refuse normally if that path were reached. Catching the
exception outside the mutation would leave the failed-function entry intact.
An upstream library with equivalent refusal support could replace this patch.

**The gap.** The user chose non-throwing refusal, but not how to bridge the
library's narrower callback contract. **The reach.** Dependency upgrades now
include maintaining or removing this patch. The same nullable contract reaches
built-in credential providers, even though email and Google are the main doors.
Source and built output must stay aligned; this is real maintenance ownership.

**Verdict: sound.** The change lives at the contract that lacked the outcome,
without creating a second eligibility authority. Its removal condition is
documented. It is justified debt, not a free change or an upstream feature.
Evidence: [patch rationale](../../../patches/README.md),
[account callback](../../../packages/backend/convex/auth.ts),
[OAuth refusal test](../../../packages/backend/src/oauth-signup-refusal.test.ts).

### C05. Park failed charges for repair instead of repeatedly retrying unchanged input

**When:** `8428be34d`. **Confidence:** medium.

**The choice.** A model's cost report is missing information needed to price it.
The worker records a failed charge, keeps its payload and a bounded error
message, and continues with other charges. It does not retry that same bad
report forever. An operator can repair the state and invoke the internal retry
operation; a corrected generation report can also restart it. The alternative
is automatic repeated retries, or silently discarding the charge.

```text
apply item fails → retain failed item → continue other items
repair or corrected report → mark pending → wake worker
```

**The gap.** The task did not define a billing failure operations workflow.
**The reach.** Durable does not mean every charge will settle without
intervention. Failed items remain inspectable and error logs remain meaningful;
this change does not add an operator UI, failure-age alert, or automatic repair.

**Verdict: sound.** Irrecoverable input should not stop unrelated billing or
produce an endless no-progress loop. This creates an operations responsibility
that must not be confused with automatic recovery from a stopped worker.
Evidence: [failure/retry owner](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[repair tests](../../../packages/backend/src/settlement-queue.test.ts).

### C06. Freeze a generation's accepted report while it is pending

**When:** `8428be34d`, including review corrections. **Confidence:** medium.

**The choice.** A generation's first cost report is accepted and waits in the
queue. If another report arrives before application, it receives an acceptance
response without replacing the stored cost. If application has failed because
pricing data is incomplete, a corrected report can replace that data and retry.
Already settled or released generations keep their existing outcome. An
alternative “latest report wins” rule could make the eventual bill depend on
which report happens to arrive immediately before the worker reads it.

```text
terminal generation → preserve terminal result
pending accepted report → preserve report
failed report + corrected report → replace data and retry
otherwise → save report and enqueue
```

**The gap.** Queueing created a new period during which several reports can
compete. **The reach.** Corrections after a successful settlement need a
separate accounting adjustment; replaying the same generation is not a rebill.

**Verdict: sound.** Stable accepted work prevents timing-dependent charges,
while explicit failed-state repair avoids freezing an unpriceable report forever.
Evidence: [report rules](../../../packages/backend/convex/domains/modelGateway/settlement.ts),
[regressions](../../../packages/backend/src/model-gateway.test.ts).

### C07. Keep only unfinished work in the queue; keep completed money in the ledger

**When:** `8428be34d`. **Confidence:** medium.

**The choice.** A service charge is stored with its workspace, actor, amount,
reference, metadata and timestamp. A model charge instead points at its existing
generation record, which already owns the cost report. Both use a new
`billingSettlements` table with the billing account, `pending` or `failed`
status, and optional error. One index selects account/status; another finds a
generation's item. On success the queue row is deleted. The money ledger, and
the generation record where applicable, are the lasting evidence.

The alternative stores another completed copy of every charge in a job history
table. That makes status lookups easier but introduces another permanent record
that can disagree with the money ledger.

**The gap.** The task did not choose a job schema, retention policy or public
status service. **The reach.** A returned settlement ID is an intake receipt,
not a promise of a permanent status row. There is no new public polling API.
Service replays may create multiple temporary rows; the application step still
deduplicates the money. Conflicting service payloads do not become an adjustment:
the already-applied reference wins, following existing ledger semantics.

**Verdict: sound.** The queue owns unfinished work and the existing ledger owns
completed accounting. This avoids duplicating the financial record.
Evidence: [schema](../../../packages/backend/convex/schema.ts),
[payloads](../../../packages/backend/convex/domains/credits/settlementTypes.ts),
[application](../../../packages/backend/convex/domains/credits/settlementQueue.ts).

### C08. Recheck the payer when queued work is applied

**When:** `8428be34d`. **Confidence:** medium.

**The choice.** Workspace W submits a charge while A pays for it. W changes
payer to B before the worker runs. The worker sees the change and moves the
item to B's lane before applying it. The alternative fixes A as payer at
acceptance. Existing postpaid ledger behavior resolves the current workspace
payer; the queue preserves that behavior instead of inventing a new billing
snapshot. Reservations still follow their existing held-credit rules.

```text
read current workspace payer
different from item's lane → move item and wake correct lane
same payer → apply money transaction
```

**The gap.** The original synchronous operation did not have a queue interval
in which assignment could change. **The reach.** Changing a workspace's payer
can move unpaid postpaid work. It does not authorize charging the same service
reference again; C19 handles that separate identity rule.

**Verdict: sound.** It preserves the current payer contract and keeps wallet
writers grouped by the account they will actually modify.
Evidence: [payer selection](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[existing payer tests](../../../packages/backend/src/model-gateway.test.ts).

### C09. Carry the submitted accounting time through delayed application

**When:** `8428be34d`. **Confidence:** medium.

**The choice.** A charge submitted with a September timestamp is applied after
an October charge. It still enters the ledger with its submitted timestamp,
but it must not reset October's current-month spending counter back to September.
The current counter stores one month, not a complete month-by-month history;
the ledger remains the historical record. The alternative uses worker time
for everything and silently moves delayed charges across reporting months.

```text
apply ledger entry using captured accounting time
entry month older than current counter month → leave current counter alone
otherwise → update that month's counter
```

**The gap.** The task did not specify the clock for delayed work.
**The reach.** “Event time” here means the supplied timestamp, or acceptance
time when none is supplied; it is not a new reconstruction of actual provider
usage time. Postpaid wallet allocation still uses the wallet when applied, while
reservation refunds keep their existing credit-epoch rules (the identity of the
monthly credit grant being refunded). It does not reserve an old monthly grant.

**Verdict: sound.** Delaying a worker should not rewrite the charge's submitted
accounting period or erase a newer period's cap usage.
Evidence: [workspace counter](../../../packages/backend/convex/domains/credits/workspaceSpend.ts),
[account counter](../../../packages/backend/convex/domains/credits/creditsShared.ts),
[month regression](../../../packages/backend/src/billing-contention.test.ts).

### C10. Refused OAuth signup returns without a sign-in code or a new refusal message

**When:** `969995a30`. **Confidence:** medium.

**The choice.** An unknown person completes Google consent. The gate refuses
account creation, consumes the one-use verifier for that attempt, and redirects
back without the exchange code that would sign them in. This removes the
exception path but does not add a new “book a call” result parameter to the
OAuth redirect. The library's old exception path also redirected without a code.
The alternative would introduce a distinct browser-visible OAuth refusal result.

**The gap.** The user requested clean function outcomes, not a new OAuth
failure experience. **The reach.** Email signup has an explicit refusal result
at the web endpoint; Google signup remains a return without successful sign-in.
This patch alone does not promise explanatory OAuth UI.

**Verdict: sound.** Preserving the existing redirect behavior keeps the change
within the requested outcome. A unified signup refusal experience would be
separate product work, not something this audit silently adds.
Evidence: [patch rationale](../../../patches/README.md),
[OAuth state assertions](../../../packages/backend/src/oauth-signup-refusal.test.ts).

### C11. Prove deployed accounting with synthetic costs and no provider or VM

**When:** `8428be34d`, fixture correction `f132ddadc`. **Confidence:** medium.

**The choice.** The staging journey creates an isolated account, workspace and
credential, then submits known synthetic charges while exercising credential,
preflight, session and file paths. It checks exact ledger references and balance
changes, waits for outstanding work, and uses the ordinary cleanup rail. It
does not provision a VM or buy a real model response. The alternative would
exercise external providers as well, at greater cost and with additional causes
of failure unrelated to database contention.

The fixture has an expiring test identity and requires the existing internal
key; the runner targets staging. The fixture mutation itself follows the repo's
existing privileged testing surface, not a new trust model. Membership creation
was corrected to use the normal insertion owner so its derived membership data
also exists.

**The gap.** A live journey was required, but its realism, load and cost were not
specified. **The reach.** This proves deployed accounting concurrency and
cleanup for a finite burst, not provider billing accuracy, end-user browser UX
or indefinite overload behavior. Local tests additionally stop/restart the
worker and verify exact final money; they do not merely assert enqueue success.

**Verdict: sound.** It isolates the mechanism implicated by the critical
failures and keeps the evidence boundary explicit.
Evidence: [journey](../../../packages/test-harness/src/staging-e2e-synthetic),
[fixture](../../../packages/backend/convex/testing/billingContention.ts).

### C12. Close the implementation while keeping rollout and the unrelated gate failure explicit

**When:** `b74f45ba8`, `c94235162`; follow-up `969995a30`. **Confidence:** medium.

**The choice.** The work was committed and its spec archived after local checks,
independent reviews and the earlier billing staging journey. The full root test
run still has an unrelated fixture-order failure: a test seeds more workspaces
than the fleet view includes, then expects later fixtures in that bounded view.
The case passes alone and fails after the large fixture. The session did not
change that fleet behavior, deploy production, or migrate production. The later
payer-replay and auth fixes have local verification rather than a newer live
journey receipt.

The alternative would expand the work into the fleet fixture issue and
production rollout before closing the code plan. That would change scope and
the evidence needed for handback.

**The gap.** “Fix” did not explicitly separate in-tree completion from live
production mitigation. **The reach.** The archived spec is a rationale record,
not proof that current production errors have disappeared. The rollout and
compatibility removal steps remain real work.

**Verdict: sound.** The user explicitly asked to close the spec, and the
handback distinguished code completion, partial broad-gate status and pending
deployment. Calling the live production incident resolved would be unsound;
that is not the claim accepted here.
Evidence: [recorded verification boundary](README.md).

## Sound — high confidence

### C13. Change billing replies from “money applied” to “work accepted”

**When:** `8428be34d`. **Confidence:** high.

**The choice.** A service reports a charge and receives
`{accepted: true, settlementId}` after the work is durably stored. A model
settlement reports `{accepted: true}`; reconciliation and sweep results now
describe queued work rather than completed deductions. The old replies included
an applied/settled flag and a balance. Returning such a balance immediately
after enqueue would falsely suggest that the charge had been deducted.

The external service HTTP response stays the same because its caller already
submits billing in post-response work and does not use the old balance result.
Durability begins when intake commits; this is not a new guarantee against
losing a service report before it reaches intake.

**The gap.** Introducing a queue required an honest internal API contract.
**The reach.** Future callers must distinguish acceptance from completion and
read the ledger or generation result when they need completed accounting.

**Verdict: sound.** The new response reports exactly what the operation has
done and avoids an invented balance or synchronous waiting protocol.
Evidence: [service seam](../../../packages/backend/convex/domains/serviceProxy/model.ts),
[reconciliation](../../../packages/backend/convex/domains/modelGateway/actions.ts).

### C14. Give workspace spending one exact row separate from workspace configuration

**When:** `8428be34d`. **Confidence:** high.

**The choice.** A $1 charge changes a new `workspaceSpending` row containing
`workspaceId`, the current month key and the exact micro-USD total. It no longer
rewrites the workspace document read by unrelated session and file operations.
An index finds the row by workspace. The cap setting stays on the workspace.
Admission helpers now receive the spending value explicitly instead of deriving
it from workspace configuration. Money units are unchanged: one micro-USD is
one millionth of a dollar.

The alternative shards or estimates the spending total, or leaves this hot
counter embedded in the widely read workspace. The wallet and ledger are not
split or projected asynchronously by this choice.

**The gap.** The request identified failures, not a storage boundary.
**The reach.** New cap readers must use the spending owner. The extra row and
lookup are the cost of preventing unrelated workspace reads from being retried.

**Verdict: sound.** One exact owner separates data with different write rates
without changing what a committed spending total means.
Evidence: [owner](../../../packages/backend/convex/domains/credits/workspaceSpend.ts),
[schema](../../../packages/backend/convex/schema.ts),
[isolation tests](../../../packages/backend/src/billing-contention.test.ts).

### C15. Migrate spending additively and let live writes win

**When:** `8428be34d`; staging migration during closeout. **Confidence:** high.

**The choice.** A workspace has $10 in its old spending fields when the new
code deploys. If a $1 charge arrives before migration reaches it, that charge
initializes the new row at $11. The later migration sees the row and preserves
$11, then removes that workspace's legacy totals while retaining its cap.
Readers use the new row when present and the old total otherwise. The existing
resumable migration runner processes batches of 50 workspaces.

```text
new row exists → use it; migration must not overwrite it
new row absent → seed from legacy total
after backfill → remove legacy values; later remove schema/read fallback
```

**The gap.** The repo required additive migrations, but the exact live-write
precedence and batch choice needed implementation. **The reach.** Legacy schema
fields and fallback reads remain until every deployment completes migration;
old ledger entries do not need rewriting.

**Verdict: sound.** Repeated migration cannot erase charges accepted during
rollout. It follows the established migration owner rather than introducing a
one-shot script with competing totals.
Evidence: [migration](../../../packages/backend/convex/migrations.ts),
[live-write preservation](../../../packages/backend/src/billing-contention.test.ts).

### C16. Serialize background settlement by payer using the official Batch Worker

**When:** `8428be34d`. **Confidence:** high.

**The choice.** Two workspaces share Alice's wallet; Bob owns another wallet.
Their background charges use one serial worker for Alice and a separate worker
for Bob. Alice's charges cannot overlap each other through that worker, while
Bob does not wait behind Alice's backlog. The selected dependency is pinned
Batch Worker `0.2.2`, compatible with the repo's Convex version. Its mounted
component also owns worker configuration/state records and scheduled recovery.

A global single worker would make all accounts wait together. Workspace workers
would still collide on Alice's shared wallet. Plain scheduling improves retry
durability but does not impose one-at-a-time application. Building another
scheduler would duplicate component-owned wakeup and recovery mechanisms.

**The gap.** The task did not prescribe a concurrency primitive or dependency.
**The reach.** Future background billing belongs to this account boundary.
Reservation admission, grants and refunds remain atomic foreground writers;
this is not a promise that every wallet writer has been serialized.

**Verdict: sound.** The ownership key matches the shared money being updated,
and the compatible component avoids an unrelated Convex upgrade.
Evidence: [worker](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[component registration](../../../packages/backend/convex/convex.config.ts).

### C17. Select pending IDs in a snapshot query before the write transaction

**When:** `8428be34d`. **Confidence:** high.

**The choice.** The worker selects eight pending IDs from a consistent database
snapshot, then its write transaction loads those particular rows. If a ninth
charge arrives meanwhile, it waits for the next selection. The write transaction
does not rescan the open pending range. The alternative scans that range while
writing money, making a new arrival another reason to retry the batch.

```text
query snapshot → selected IDs
mutation → reread selected IDs → ignore already-finished rows → apply
new arrivals → subsequent query
```

**The gap.** A queue needs an explicit boundary between finding work and changing
money. **The reach.** Future batch code must preserve bounded selection and
revalidate selected items rather than treating the snapshot as authorization.

**Verdict: sound.** It removes an avoidable source of contention while the
transaction still checks the actual work it is about to apply.
Evidence: [nextBatch and applyOne](../../../packages/backend/convex/domains/credits/settlementQueue.ts).

### C18. Isolate each charge's failure while keeping its accounting changes atomic

**When:** `8428be34d`. **Confidence:** high.

**The choice.** In a batch of charges A, B and C, B fails after attempting a
wallet update. Each item runs in a nested mutation, which acts as a savepoint:
B's partial changes roll back, the parent records its failure, and C can still
run. The ledger, wallet, spend counters and reservation/generation transition
for a successful item stay in one transaction. Catching an error around inline
writes could retain partial changes; letting it abort the whole batch could
repeatedly stop A and C as well.

**The gap.** Batch execution needed a transactional failure boundary.
**The reach.** A future billing operation must reuse the ledger/reservation
owner inside this boundary rather than splitting its money writes across jobs.

**Verdict: sound.** One bad input cannot leave half a debit or permanently
starve later charges, and the existing financial invariants keep one owner.
Evidence: [savepoint boundary](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[rollback regression](../../../packages/backend/src/settlement-queue.test.ts).

### C19. Identify a service replay by workspace and reference across payer changes

**When:** `969995a30`, following independent review. **Confidence:** high.

**The choice.** Job J charges payer A for workspace W. W switches to payer B;
a duplicate report for J then reaches the worker. The existing wallet-level
deduplication key includes the payer, so by itself it would permit charging B.
The queue now checks the existing workspace/reference ledger index first and
treats J as already charged. It adds no new table or index for this check.

```text
ledger contains (workspace W, reference J) → no second debit
otherwise → apply through existing ledger owner
```

The alternative would make a payer change turn a replay into another bill, or
change idempotency for all ledger operations. This fix changes neither the
identity of unrelated credits nor the existing account-level safeguard.

**The gap.** Delayed duplicate reports crossed two different account lanes.
**The reach.** Service references identify work, not the payer's current tenure.

**Verdict: sound.** The identity follows the original job and is tested with
both payers' exact balances and the surviving ledger entry.
Evidence: [guard](../../../packages/backend/convex/domains/credits/settlementQueue.ts),
[payer replay test](../../../packages/backend/src/settlement-queue.test.ts).

### C20. Route recovery through the same owner and give accepted costs precedence over late failure

**When:** `8428be34d`, including review corrections. **Confidence:** high.

**The choice.** A model cost has been accepted but the worker is paused. A late
timeout report must not release that generation and erase its charge. The
release/failure paths check for accepted settlement ownership. Likewise, a
missed-charge sweep queues known costs through the same owner instead of
directly charging the wallet beside the worker. A failure or release that
finished before cost acceptance retains its existing terminal behavior.

**The gap.** Adding an async owner required precedence rules for old recovery
and terminal paths. **The reach.** New model cleanup or retry code must respect
accepted work; another direct settlement entrance would recreate the race.

**Verdict: sound.** Durable acceptance would mean little if a later timeout
could cancel it accidentally or a sweep could bypass its serialization.
Evidence: [terminal and sweep rules](../../../packages/backend/convex/domains/modelGateway/settlement.ts),
[failure reports](../../../packages/backend/convex/domains/modelGateway/generations.ts).

### C21. Deduct the old counter layout's spent allowance during rollout

**When:** `8428be34d`. **Confidence:** high.

**The choice.** A credential has used 60 of an old counter's 75 requests when
deployment switches layouts. Each of its four new child counters receives only
`floor((75 - 60) / 4)`, or three requests. A fresh namespace alone would give
that credential a second allowance in the same minute. The implementation
reads the corresponding old counter only when its window matches, and uses a
distinct `#api:` namespace for new rows.

**The gap.** The new layout needed coexistence semantics for already-stored
counts. **The reach.** The temporary read and legacy test support can be removed
after the new layout has been live for a complete rate-limit window. It does
not justify a permanent version-negotiation system.

**Verdict: sound.** Deployment cannot refund spent request budget; rounding
remains conservative as required by the existing limiter policy.
Evidence: [compatibility calculation](../../../packages/backend/convex/domains/apiKeys/apiRateLimit.ts),
[exhausted-window regression](../../../packages/backend/convex/domains/apiKeys/apiRateLimit.test.ts).

### C22. Share one approximate last-used timestamp writer across both credential paths

**When:** `c1b8a9e5a`, after the first live staging burst. **Confidence:** high.

**The choice.** A key is used by both ordinary API traffic and model preflight.
Ordinary API use already throttled its last-used timestamp, but model preflight
wrote it every time. Both now use the same helper and existing configured
window, five minutes by default. A second request inside the window leaves the
timestamp alone; a request after the window advances it. The alternative keeps
a more precise gateway timestamp but repeatedly invalidates concurrent readers
of the same credential document.

**The gap.** The live test revealed a second writer outside the initial counter
fix. **The reach.** Last-used time is approximate activity evidence, not a
per-request audit trail; future writers must share the same owner.

**Verdict: sound.** It generalizes an existing policy to every caller instead
of compensating with still more counter shards.
Evidence: [timestamp owner](../../../packages/backend/convex/domains/apiKeys/authenticate.ts),
[cross-caller regression](../../../packages/backend/convex/domains/apiKeys/authenticate.test.ts).

### C23. Carry normal refusal through the web and agent doors without changing eligibility

**When:** `969995a30`. **Confidence:** high.

**The choice.** An unknown address requests an email link. The gate returns a
decision, the auth callback returns `null`, and email initiation returns
`{started: false}` without creating an account or sending email. The web endpoint
converts that to its existing HTTP 403 `signup_closed` response and creates no
new intent cookie. The agent sign-in rail still returns the same request handle
shape for known and unknown addresses, with no usable code bound for a refusal.
That preserves its existing protection against discovering who has an account.

```text
gate refuses → normal false outcome
web caller → named HTTP refusal
agent caller → ordinary request handle, no email/code
unexpected provider or configuration failure → still throw
```

The alternative catches every auth error as “signup closed,” hiding real email
outages, or changes who may sign up. Neither is needed to satisfy the user.

**The gap.** The desired non-throwing behavior required concrete outcomes at
each interface. **The reach.** A policy refusal is distinct from an operational
failure. No new user/auth table, eligibility exception or durable refusal log
was introduced by this follow-up.

**Verdict: sound.** It carries the user's explicit requirement through each
consumer while preserving the existing security and browser contracts.
Evidence: [gate](../../../packages/backend/convex/domains/users/signupGate.ts),
[web mapping](../../../apps/web/src/auth/magic-link-intent.ts),
[agent rail](../../../packages/backend/convex/domains/authRequests/actions.ts),
[public-path tests](../../../packages/backend/src/signup-gate.test.ts).

### C24. Deploy a tolerant web reader before the backend's new refusal result

**When:** `969995a30`. **Confidence:** high.

**The choice.** During rollout, the new web handler might still talk to the old
backend that throws `signup_closed`. It recognizes that specific old error and
maps it to the same refusal as the new `started: false` result. Other errors
continue to throw. Deploying the new backend first would make the old web
handler treat `started: false` as a delivery failure.

```text
deploy web accepting old refusal or new false
deploy backend returning false
after all targets move → remove old-error reader
```

**The gap.** Web and backend deployments are separate events.
**The reach.** This is a temporary response compatibility branch with a stated
removal condition, not a permanent internal API version scheme. It does not
remove old backend dashboard errors until that backend is replaced.

**Verdict: sound.** The sequence preserves signup behavior during the actual
deployment interval without duplicating eligibility logic.
Evidence: [web reader](../../../apps/web/src/auth/send-magic-link.ts),
[old/new response test](../../../apps/web/src/auth/send-magic-link.test.ts).

### C25. Refresh the stale base and repair changed-area test assumptions without broadening product behavior

**When:** before `8428be34d`; follow-ups `f132ddadc`, `072fd1733`.
**Confidence:** high.

**The choice.** The starting checkout lagged the deployed backend. The work was
carried onto a branch based on the newer staging base so deployment would not
erase newer auth and transcript changes. Closeout then repaired tests that
assumed immediate billing completion, seeded only the old counter layout, or
walked hundreds of paginated requests without obeying a rate-limit response.
The pagination test advances its logical clock by the advertised retry delay
and still verifies every expected row. A cache-warming assertion now checks its
required fields while permitting newer cache metadata, and a staging transcript
helper parses the existing event schema before using its narrower predicate.

The alternatives were deploying stale code, weakening final money/row
assertions, or altering unrelated product behavior merely to make tests pass.
The unrelated fleet fixture issue remains disclosed under C12.

**The gap.** The task did not specify how to integrate a stale checkout or
handle incidental closeout incompatibilities. **The reach.** Tests now exercise
the real asynchronous boundary and current schemas. They still require exact
final results; a successful intake response is not their accounting oracle.

**Verdict: sound.** It preserves newer work and corrects test assumptions at
their own boundary instead of expanding the fix into unrelated behavior.
Evidence: [service assertions](../../../apps/api/src/routes/services/index.test.ts),
[pagination walk](../../../apps/api/src/apps.test.ts),
[counter fixtures](../../../packages/backend/convex/testing/apiKeys.ts),
[transcript helper](../../../packages/test-harness/src/staging-e2e-synthetic).

## Handoff

The sound ownership decisions above are the baseline for subsequent work;
do not rediscover or re-decide them merely because implementation moves files.
C01 is the remaining product-policy call. C02 and C03 are tuning limits,
C04 is dependency maintenance, and C12 is the boundary of the deployment claim.
No fixes, test edits, dependency installation, commits or deployments were
performed by this audit.
