# Model router choices

This is the final decision ledger for the shipped model-router feature. It records
implementation choices that future router providers must inherit; routine names
and code mechanics are omitted.

## Sound

### 1. Policy reads fail open to an empty route list (high confidence)

If the gateway cannot read Convex, it treats the active policy as having zero
rules and sends the request to Vercel. The alternative would be to reject the
user's generation because the optional routing control plane is unavailable.
The gateway's primary service remains available and Vercel is the contractual
fallback, so a policy outage cannot become a customer outage.

**Gap:** The plan required Vercel fallback but did not spell out what a policy
read outage should do.

**Reach:** Future provider adapters must keep policy loading advisory; adding a
new route must never make the normal gateway depend on Convex availability.

**Verdict:** sound — preserves the always-available fallback promised by the
feature.

### 2. One global ordered policy replaces the whole rule set atomically (high confidence)

The admin save writes one singleton row containing the ordered rules. A save is
therefore visible as one complete policy: the gateway cannot observe half of a
rule list, and first-match order is the same order the operator edited. The
alternative would be separate rule rows whose ordering and partial updates would
need another consistency mechanism.

**Gap:** The plan named a global ordered policy but did not choose the storage
shape.

**Reach:** Every future provider uses the same policy owner and atomic replace;
there is no second per-provider ordering system to reconcile.

**Verdict:** sound — the singleton matches the global scope and keeps the write
path small.

### 3. Tier billing eligibility is evaluated before model glob matching (high confidence)

For a request with `x-duet-tier`, the gateway first asks the existing
`tierBillsAtFlatRate(tier, model)` closure whether that exact model is priced at
the tier rate. Only then can a rule such as `openai/*` select an endpoint. A
glob therefore cannot turn an at-cost or unknown model into a flat-rate charge.
The alternative would let a broad glob change billing eligibility.

**Gap:** The matching order was a product invariant, but the existing gateway
had no router seam that enforced it.

**Reach:** New providers and rule syntaxes must remain routing decisions after
the billing decision, never the source of billing truth.

**Verdict:** sound — makes the user's billing contract independent of routing.

### 4. The first adapter supports only the three observed LLM paths (high confidence)

Configured routes accept OpenAI chat completions, OpenAI Responses, and
Anthropic messages. Model lists, embeddings, images, video, audio, and unrelated
paths stay on Vercel. The alternative would create a broad provider abstraction
before the configured endpoint has those contracts.

**Gap:** The user explicitly limited the first endpoint to LLM calls, while the
gateway serves more modalities.

**Reach:** A later provider adds an adapter behind the same classifier without
silently expanding media or embedding behavior.

**Verdict:** sound — the fixed allowlist keeps unsupported operations safe and
testable.

### 5. Configured requests forward exactly the saved route headers (high confidence)

The gateway constructs a fresh upstream request from the saved header list and
does not merge caller authorization, Duet attribution, workspace, or transport
headers. An operator can save `authorization` or `x-api-key` as the route's
credential, while a caller cannot replace it. The alternative would make a
caller-controlled header part of the configured provider credential.

**Gap:** The endpoint's credential shape is intentionally operator-controlled,
but the plan did not require a header merge policy beyond exact forwarding.

**Reach:** Future providers inherit a clear secret boundary: route credentials
come from policy storage; request metadata comes from the gateway's own logic.

**Verdict:** sound — isolates configured credentials and matches the endpoint
contract discovered in the live probe.

### 6. A successful configured response settles directly from native usage (high confidence)

The gateway parses provider usage, then calls a dedicated Convex mutation that
prices the existing tier and writes the normal `usage` ledger transaction. It
does not ask Vercel to reconcile a provider-specific ID and does not invent an
upstream dollar cost. The alternative would either mislabel the provider ID as a
Vercel generation or require a fake cost.

**Gap:** Existing settlement was built around Vercel's upstream cost lookup.

**Reach:** Each future adapter can normalize native usage into the same billing
shape while retaining the existing user-facing audit and ledger contracts.

**Verdict:** sound — preserves billing semantics while keeping external cost
unknown.

### 7. Internal margins add route source while retaining canonical provider (high confidence)

A routed OpenAI call is still grouped under provider `openai`, but its internal
row also says `configured_upstream`; Vercel rows say `vercel`. Since the
configured endpoint does not report a trusted dollar cost, its cost is absent
from settlement. The operator calculation follows the
[Vercel-cost reporting scope](README.md), while routing provenance remains
separate from provider identity.

**Gap:** The user asked how external-provider margins should read, while the
existing rollup had only provider.

**Reach:** New adapters can add route sources without fragmenting provider
aggregation or changing the workspace audit/ledger contract.

**Verdict:** sound — separates internal routing provenance from canonical model
provider identity.

### 8. Response bytes are preserved when usage is missing (high confidence)

Once a configured response has begun, the gateway returns those bytes to the
caller and never retries them through Vercel. If the response ends without valid
usage, it releases the generation with `missing_usage_telemetry`. The alternative
would duplicate a generation after the caller may already have received output,
or charge from an estimate the provider never supplied.

**Gap:** The provider may occasionally omit telemetry even though the live
endpoint normally returns it.

**Reach:** Every streaming adapter must distinguish “failed before bytes” from
“completed without billable telemetry”; the latter cannot be retried safely.

**Verdict:** sound — protects response correctness and avoids silent
under/overcharging.

### 9. Existing margin rows default to `vercel` when route source is absent (medium confidence)

Rows written before this feature have no route-source field. Readers and the
fold path interpret that absence as `vercel`, while newly settled rows write an
explicit source. The alternative would either break old rows or merge routed and
Vercel rows into one ambiguous bucket.

**Gap:** The schema had already-produced rollup rows and no migration was part of
the hard cutover.

**Reach:** Future schema cleanup can remove the optionality only after old rows
are retired; until then internal reports remain complete.

**Verdict:** sound — it is a narrow read compatibility rule for existing data,
not a parallel routing implementation.
