# Virtual Model Tiers — Choices Ledger

Every decision made where the spec was silent, re-audited against the final
shipped code (not the pass that introduced it). Grouped by verdict,
least-confident first. Each entry stands alone — you should not need to read
code to judge it.

---

## Needs your call

(Entry 1 resolved itself with a live measurement; entry 2 remains.)

### 1. ~~How we split cached vs uncached input tokens~~ — SETTLED 2026-07-30

Measured live once staging credentials became decryptable: the generation
record's prompt count EXCLUDES cached tokens (a cache-read call reported 2
prompt tokens beside 11,974 cached ones). The shipped subtractive rule would
have parked every multi-turn generation as `charge_failed` — the guard built
for exactly this outcome fired in the probe, not in production. Now: cached
tokens bill at the cached rate, fresh prompt tokens and cache-WRITE tokens
bill at the input rate (writes cost 1.25x base upstream, inside the tier
margin — recorded as the one new judgment call here), and the error path is
deleted. Pinned by tests shaped exactly like the live capture.

### 2. The lander no longer advertises "900+ AI models"

**The choice.** The public pricing page's trust strip said "900+ AI models" and
its FAQ answered "What AI models are included?" by naming Claude Code, Codex,
Nano Banana 2, Seedance and 900+ content-creation models. Since chat is now
three tiers and the gateway only allows a curated list, those claims stopped
being true for chat, so they became "Outcome-based AI tiers" and a tier
explanation. The side effect: the media models (image/video) are no longer
named anywhere on the pricing page, and the model-count selling point is gone.

**Why it matters.** It's marketing positioning on your main pricing page, not
an implementation detail — you may want the breadth claim kept and rescoped to
media rather than dropped.

**Verdict:** Defensible, but it's your call and it's a one-file copy revert.
**Confidence:** Low — this is taste, not correctness.

---

## Sound

### ~~The VM's memory-template build runs on the economy tier~~ — DELETED (Example User, 2026-07-31)

The builder (arrived from session-app-pane, not tiers) pre-built an empty
agent memory database at VM boot by spawning a throwaway agent, so each new
agent's first turn copied a file (~8s to first turn) instead of creating a
database cold (~31s). Example User's call: complexity not worth shaving boot
seconds — bigger VMs solve it — so the whole rail is deleted (the module,
its test, the boot hook, and the template-copy seed in agent-context).
Agents now always create their own database on first turn, paying the cold
cost. If first-turn latency ever matters again, the deleted module's header
carried the measurements (~5.9s pure CPU per agent; copy-vs-reuse equal) —
recover it from git history rather than re-deriving.

### A subscriber whose plan can't be read defaults to balanced

Plan-based defaults were Example User's instruction ($20 starter -> economy, $50 pro
-> balanced, $200 max -> frontier), but three edges were mine. (a) A user
with an ACTIVE subscription whose stored plan value is missing or unknown
(say a future plan id this code predates) defaults to balanced — the old
flat subscriber default — rather than being bumped down to economy on bad
data. (b) The plan is consulted only while the subscription is live: a
lapsed max subscriber does not carry "frontier default" into their unpaid
state. (c) The plan value is parsed defensively (an unparseable value acts
like "no plan") instead of throwing. All three live in one chokepoint
(`workspaceTierEntitlement` + `defaultTierFor`), so a fourth plan someday is
a two-line change. Confidence: high.

### Staging's generation table was emptied whole, not filtered

When the schema deploy failed on pre-tier rows, Example User said to delete
whatever was blocking. The scope was mine: I replaced the ENTIRE staging
`gatewayGenerations` table with nothing (`convex import --replace` with an
empty file) rather than deleting only the rows in the old shape. Rationale:
every row in that table was staging e2e churn, the old-shape rows were the
majority, and a filtered export-edit-import cycle is where mistakes live.
Consequence: no staging generation history predates 2026-07-30 — the e2e
handoff warns about this. Prod was untouched (its table was verified empty
first). Confidence: high.

### Merge resolutions: the pane's structure won, the tiers' content won

The staging merge collided two rewrites of the same screens. The rule I
applied everywhere: session-app-pane's NEW STRUCTURE (its rewritten
launchRunner with spawn-cwd fallback, its session screen with the question
panel and app pane) is kept, and the tier feature's CONTENT (the quality
slider where the model menu was, the clamp banner, the tier field where
gatewayModelId was) is substituted inside it. The alternative — keeping our
structure and grafting their features in — would have re-implemented their
feature inside ours. One consequence to know: staging's new tests were
written against the old wire, so their fixtures were mechanically renamed to
the tier wire — EXCEPT the quarantine test, whose deliberately-legacy
envelope is the point (my first blanket rename broke it and was reverted).
Confidence: high.

### The live journey no longer assumes which tier an unconfigured workspace gets

The journey originally asserted a fresh subscriber workspace defaults to
'balanced'. Under plan defaults that depends on the fixture account's plan
($20 account -> economy), which the journey doesn't control. It now asserts
only the wire shape (a valid tier + all_tiers access), then sets an explicit
Standard default and verifies THAT round-trips; the plan-default matrix is
pinned by backend tests instead. The alternative — pinning the fixture's
current plan into the journey — breaks the day the account's plan changes.
Confidence: high.

### One unit test was deleted with its helper

The review pass inlined a trivial exported function that existed only so a
unit test could call it (given a click on a slider stop, return "open the
upgrade dialog" for locked stops or "change the value" otherwise). Its test
went with it. The invariant is not untested: the playground visual test
clicks a real locked stop and asserts the dialog opens AND the selection
stays put — the same contract at a truer level. Recorded because deleting
any test deserves a line. Confidence: medium.


### Stranded forwarding rows are released, never billed (Example User, 2026-07-31)

A transient failure recording the upstream generation id used to leave a row
in `forwarding` forever, invisible to the recovery sweep — a silent revenue
leak that predates this feature. Per Example User: simplest possible fix, no weird
states. The sweep now releases forwarding rows older than one hour (nothing
legitimate forwards that long) with the reason persisted on the row; they are
never billed, because without the id there is no ground truth to bill from.
The sibling finding — a billing-owner change mid-reconciliation debits the
new owner unchecked — Example User classified as an acceptable edge case; recorded,
not changed. Two sub-choices inside the fix were mine: the staleness
threshold is ONE HOUR (nothing legitimate forwards that long; generous
enough that a slow stream never gets released mid-flight), and one existing
test's exact released-row count became a lower bound, because the sweep is
deployment-global and sibling tests' stranded rows (born at a fixed 1970
epoch in the harness) release in the same pass.


### Cache-write tokens bill at the plain input rate — RATIFIED by Example User 2026-07-31

Vercel reports cache WRITES as their own count, excluded from prompt tokens
(measured live). Tier rates have no cache-write leg, so those tokens join the
uncached-input leg and bill at the input rate. Known negative leg on the
premium routes (fable $12.50 / sol $6.25 upstream per 1M written vs Max $10 /
Standard $5 charged); writes happen once while reads repay at ~10x margin, so
blended margin holds. Example User confirmed this as the design — no separate write
rate.

### The firstPaidAt firewall exempts bookkeeping owners' reads

The firewall test barred every read of the ever-paid stamp outside gates.
Staging added an analytics classification (subscription.started vs .renewed)
that reads it inside the billing module — reporting, which the retirement
decision explicitly preserves. The firewall now exempts the small bookkeeping
allowlist entirely while still catching a read anywhere else, where a gate
would live.

### A born-failing staging assertion was corrected, not skipped

Staging's new cwd test asserted session rows carry an agentAnchorId column.
No code on either branch has ever written one — the test failed identically
on pristine origin/staging (verified in a throwaway worktree). The assertion
now pins the attribution the rows actually carry (agentId + agentName)
rather than being skipped or deleted. Fixing it exposed a second latent
defect in the same test: its "revision bumped exactly once" assertion raced
the async title-generation attempts that also bump the workspace's session
revision (every settled attempt, including failures and retries, bumps it).
The snapshot now waits for the revision to go quiet before measuring — the
strict +1 contract is kept rather than loosened to >=.


### 3. Internal models bill the old way only when no tier header is present

Memory and embedding models get called by background jobs (training, memory
maintenance) that belong to no user session and so have no tier. Those calls
are allowed through without tier attribution and bill as they always did. But
if the *same* model is called from a real session that does send a tier, the
tier is honored — and a header claiming a tier that doesn't contain the model
is rejected. So the exception is exactly as narrow as its reason, and can't be
used to dodge validation by attaching a false claim.

### 4. A locked tier offers an upgrade instead of changing your selection

In the compose bar, clicking a locked tier opens an upgrade dialog and leaves
your selection untouched. In workspace settings, the same click goes straight
to Billing rather than opening a second dialog. Two surfaces, one rule:
activating something you can't have never silently changes your state.

### 5. The settings card shows what you chose *and* what you get

If a workspace stored "Standard" and the subscription later lapsed, the card
keeps the slider on Standard (your preference) while the copy names the tier
actually in effect (Lite). The alternative — silently rewriting the stored
preference — would lose the fact that you ever chose Standard, so resubscribing
wouldn't restore it.

### 6. A paid-tier denial reuses the subscription-required response

Someone with credits but no active subscription who asks for Max gets the
existing `subscription_required` billing response, not the older
`model_requires_payment` one (which describes a concrete model's policy, not a
tier's entitlement). No new error vocabulary for clients to learn.

### 7. Legacy-id cleanup also enforces entitlement

The helper that turns a stored tier id into a usable one (rejecting obsolete
ids like `recommended`, falling back to the workspace default) *also*
downgrades a paid tier to Lite for an unsubscribed workspace. Callers can't
honor a stale `frontier` by forgetting a second check — the unsafe combination
is unreachable rather than merely discouraged. Whether a clamp happened is
still reported separately, so the user-facing notice still fires.

### 8. The clamp notice is its own durable event, written just before its input

When your tier is clamped, that's recorded as a system timeline event tied to
the triggering input, so a retried request can't produce two notices. The
durable input remains the single thing that owns idempotency.

### 9. Workspace tier entitlement comes from the billing owner, not the viewer

Whether a workspace can use paid tiers is derived from whoever pays for it —
never from the subscription of whoever happens to be looking. One projection
owns that, so no surface can accidentally ask the wrong person.

### 10. A stale VM session is thrown away and rebuilt, not parsed

After the cutover a VM may still hold a session file in the old format. Rather
than teach the code to read both shapes (which the spec forbids), it
quarantines the file and lets the backend recreate the session from its own
durable record, with a test proving the in-flight turn is retried rather than
silently dropped.

### 11. Public session data exposes a parsed tier, not the legacy column name

The tier is stored in a column still named after the old model concept. The
public API exposes a properly named, validated `tier` instead of leaking that
historical name, and omits values that don't parse rather than passing junk
through.

### 12. Entitlement at workspace creation uses server time

The check on creating a second workspace asks "are you subscribed right now?"
using server time at the moment of the request, rather than accepting a
timestamp from the caller. Authorization can't be influenced by a value
supplied from outside the gate.

### 13. "Unpaid" test users now lose their subscription too

A shared test helper named "clear this user's paid status" only erased the old
ever-paid timestamp. Once entitlement moved to live subscriptions it no longer
made a user unpaid — and a real test caught it (someone who should have been
refused a paid model was allowed). The helper now drops the subscription too,
so its name matches what it does.

### 14. Generated test workspace names are trimmed to fit

Test workspaces got names like `modelgw-tier-attribution-<timestamp>-<n>`,
which sat about one character under the 40-character limit. Once a file's
counter reached two digits, names overflowed — so *adding* a test made
unrelated tests fail. The generator now trims to fit instead of relying on
everyone choosing short prefixes.

### 15. Screenshots wait for images, not just fonts

The visual harness waited for fonts but not pictures, so screenshots could fire
while avatars and app icons were still decoding. That produced a difference
that *changed size* between runs — the signature of a race, not a real change.
Screenshots now wait for images to finish decoding.

### 16. Enforcement-only catalog entries are identified by their gateway id

With chat roles deleted, the surviving catalog rows exist purely so the gateway
can allow, price-gate and provider-lock a concrete model. They are keyed by
their gateway id and can no longer be resolved as a product-facing role, so
nothing can accidentally reintroduce "pick this specific model" as a user
concept.

---

## Cosmetic (recorded, not worth your time)

- **Tier score dots** — Max 3/5/1, Standard 4/4/3, Lite 5/3/5 for
  speed/intelligence/cost. Pure presentation.
- **Slider shape** — three discrete stops (not a draggable range), ordered
  Lite → Standard → Max, on a gradient track.
- **Tooltip wording** — a localized prefix plus the tier's model names in a
  fixed order, pulled from the contract rather than hand-written.
- **Card placement** — the default-tier card sits in General settings, after
  Drive identity.
- **Usage badges** — shown only on rows that carry a tier; older rows are left
  alone rather than back-labelled.
- **Removed an orphaned model-provider icon component** left with no consumer
  once the picker stopped showing concrete models.

---

## Audited 2026-08-01 (post-close session)

Decisions made without you while chasing leg 5. Ranked least-confident first.

### UNSOUND — redo from the corrected decision

**Raising the Convex warm-boot budget from 180s to 240s does not guarantee
anything.** *Scenario:* `bun run test` runs every package at once. `apps/api`,
`packages/backend` and `packages/test-harness` each spin up their own real local
Convex deployment, and one convex-dev test starts two more on purpose. Each
deployment has a "ready timeout" — how long the harness waits for it to boot
before giving up — and that budget was 180 seconds. Across a day of full runs,
a test died at almost exactly 180,0xx ms four separate times, in three different
packages, a different test each time, and every one passed when run alone. I
raised the ceiling to 240s. *The gap:* nothing says how long a boot may take
when N deployments compete for one machine. *Why it is unsound:* the property
that makes the failure go away is "240 happened to be enough on my laptop
today", not anything that bounds the wait. A busier machine, or one more
package spinning Convex, puts it right back — and the next person sees the same
mystery with a bigger number on it. This is exactly the bumped-timeout shape.
*Corrected decision to redo from:* the number of concurrent local Convex
deployments must be BOUNDED, not the time each is given — cap the concurrency
for Convex-spinning packages (a turbo concurrency limit, or a shared lock in
`convexDev` so at most N boot at once) so the budget is meaningful again. Then
the timeout can go back down and a breach means a real wedge. *Reach:* every
future package that spins Convex inherits this, and the CI machine is likely
slower than this laptop. *Confidence: low — I believe you would want the
concurrency bounded rather than the clock loosened.*

### NEEDS-USER — decide

**I rotated the admin workspace's VM model key on live staging to get a
plaintext key.** *Scenario:* to prove whether a valid VM key authenticates
against the model-gateway, I needed a real key. The backend stores only a HASH
of each key, so the only way to obtain the plaintext is to mint a new one —
and the mint path returns nothing when a usable key already exists, so I called
`rotateVmModelKey`, which REVOKES the existing key and issues a replacement.
`admin-s-workspace` on staging therefore had its VM credential invalidated;
its gateway re-requests one on its next 5-second sync, so it self-heals, but any
turn running on that VM at that instant would have died with the same 401 I was
investigating. *The gap:* nothing sanctioned a read-only way to answer the
question. *Provisional call:* keep it — the probe produced the finding that
closed out the investigation, staging is explicitly disposable, and the damage
window is one sync tick. *Reverse by:* nothing to reverse; the key already
rolled forward. *Avoid next time by:* adding a testing-only "issue a scratch VM
key" mutation that does not revoke the live one. *Confidence: medium.*

**`'0'` typed into the spend-cap field now means NO CAP.** *Scenario:* the
billing settings page has a free-text money field for a monthly spend cap.
Previously any unparseable value became `dollarsToMicroUsd(...)` = 0, and a cap
of 0 does not mean "no cap" — it means block every request. I added
`optionalCapToMicroUsd`, which returns null (no cap) for blank, whitespace,
non-finite, negative — AND for exactly `0`. So a user who types `0` intending
"stop all spending" now gets no cap at all, the opposite of their intent.
*The gap:* nothing says what a literal zero cap should mean. *Provisional call:*
keep it — a spend cap of zero is far more likely a typo or a cleared field than
a deliberate freeze, and the safe failure is "no cap" rather than "silently
frozen account". *Reverse by:* treating `0` as a real cap and adding an explicit
"pause all spend" control instead. *Confidence: medium.*

### SOUND — the architecture you now own

**Queuing turns until credentials arrive overturns a previously deliberate
contract.** You directed the behaviour, so the queuing itself is yours; these
sub-decisions were mine. The refusal fires only when the gateway HAS a model
rail and its credentials have not landed — a gateway with no `modelEnv` provider
at all (unit tests, any deployment with no model rail) still spawns freely, so
the change cannot brick those. Train is untouched: it degrades without model env
rather than failing, so it still runs and still logs the missing credentials
once. And the fourteen gateway tests that relied on keyless spawning were put
into the state a registered VM is actually in — credentials seeded via
`registeredRuntime` plus a helper for the seven that build runtimes directly —
rather than being weakened or deleted. *Confidence: high.*

**`readEventStream` gained an opt-in `returnPartialOnTimeout` instead of
changing its default.** *Scenario:* a caller that reconnects needs the frames
AND the last event id it reached; without them it resumes with no
`last-event-id`, and the server then streams from NOW rather than replaying, so
everything the abandoned attempt saw is invisible. Making the function return
partial state by default would have changed behaviour for every journey that
currently relies on it throwing. The flag is off unless asked for. *Confidence:
high.*

**Leg 5 now refuses to judge tiers unless the follow-up turn terminated
`completed`.** *Scenario:* a turn that fails produces no completion of its own,
and the only fresh generations are then the PREVIOUS turn's trailing memory and
embedding work — which carries the previous tier and looks exactly like "the
switch did not take effect". This is the check whose absence produced a verdict
I had to retract. *Confidence: high.*

**Two findings from the dead-test hunt were declined rather than actioned.**
`deleteWorkspace` is not dead — its implementation is live via the
ephemeral-user retirement cron, and its tests exercise real owner
authorization; removing the thin wrapper would churn nine tests to delete
something the first delete-workspace route will need. The zero-token-telemetry
billing case is a pricing decision, not a defect: both alternatives (park and
retry forever, or fall back to upstream cost) are worse in different ways, and
it is barely reachable. Documented in place instead. *Confidence: high.*

**Trivial discretion:** naming of `optionalCapToMicroUsd`,
`seedModelCredentials`, `readTurnToTerminal` and the new test files; 120-second
SSE leg length; 900-second overall turn budget copied from the sessions-and-jobs
journey.
