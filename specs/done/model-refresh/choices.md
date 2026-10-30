# Implementation choices

This is the consolidated decision record for the model refresh. Stable customer
prices, automatic upgrades and retained video role names were user requirements;
the entries below explain implementation choices made where the request left room.

## Existing users and independent updates

### Stable names across the CLI boundary

**When:** qualification, shared-contract and final training review.

**Decision:** gateway-managed routes and training commands pass family names such
as `sol`, `opus` and `luna`. Direct SDK requests carry concrete provider IDs. The
alternative was to require every binary update to finish before accepting work.

**Gap:** the request did not define what happens while the CLI and workspace
gateway are on different releases. **Rationale:** both installed generations
understand the family names and already own their mappings. **Consequence:**
existing work can finish during a deferred update; the upgraded binary selects
the new target without a second update coordinator.

### Recover saved selections at the existing read boundaries

**When:** saved-session qualification and final combined review for 0.3.29.

**Decision:** one closed mapping recognizes known replaced model names when
resuming sessions or loading saved routing files. Saved workflow models use that
same recovery boundary after project routing is known. Provider choice, routing
effort, valid custom tier names and historical messages retain their meaning. Routing files
are interpreted in memory, not rewritten. Unknown advanced selectors keep their
existing handling. The alternative was to retain executable old models or migrate
stored files and sessions.

**Gap:** old CLI versions stored some family choices as concrete names, and an
old gateway can supply its routing file to a new CLI. **Rationale:** recovering
intent where it is read handles both update orders with one mapping. **Consequence:**
known obsolete selections advance automatically. Fresh and different explicit
provider overrides retain their normal precedence, and clearing a resumed session
returns to the current launch preferences. Future retirements update this same owner.

### Refresh stale connected-provider availability once

**When:** connected-provider review.

**Decision:** when a valid Copilot cache lists replaced models but lacks their
successors, perform one locked, coalesced refresh per load. Genuine account denial
remains authoritative. The alternative was to immediately fall back to metered
traffic because of a stale cache.

**Gap:** the request did not prescribe cache recovery. **Rationale:** the existing
credential refresh owns availability and already serializes concurrent callers.
**Consequence:** stale data gets one recovery opportunity; ordinary turns do not
repeatedly poll, and this does not grant access the account lacks.

## Model and input boundaries

### Fill SDK catalog gaps at the existing provider adapter

**When:** runtime model qualification.

**Decision:** reuse a supported sibling transport when the installed SDK lacks a
new model entry. Metered metadata comes from published provider information;
connected-provider limits remain conservative. A shipped SDK entry takes precedence.
The alternative was a dependency upgrade or a generic transport fallback.

**Gap:** provider releases preceded the installed SDK catalog. **Rationale:** the
existing adapter is the boundary between Duet's model choices and SDK metadata.
**Consequence:** current models work with the existing SDK; connected sessions may
compact earlier than metered sessions until authoritative limits are available.

### Preserve remote and local video image inputs

**When:** media qualification.

**Decision:** pass HTTP(S) image input through as a URL and local image input as
bytes. No upload service was introduced. **Gap:** the provider documentation did
not establish whether the existing local-input path would work. **Rationale:**
qualification established that it does, so mandatory hosting would add needless
machinery. **Consequence:** both input forms retain their natural workflow.

### Keep onboarding's model defaults

**When:** lightweight consumer qualification.

**Decision:** remove the recommender's zero-temperature override while preserving
its schema, timeout and the new model's default reasoning. The alternative was to
turn reasoning off to retain that sampling override. **Gap:** the request did not
choose new sampling settings. **Rationale:** retaining the model's default reasoning
fits the intended capable successor better than disabling it for an old parameter.
**Consequence:** deterministic sampling is no longer explicitly requested.

## Accounting and distribution

### Prepare admission and accounting before publishing

**When:** gateway qualification and standalone-release preparation.

**Decision:** deploy additive model admission and fixed-price billing coverage
before publishing the CLI, retaining the old product pin and disclosures until
full rollout. **Gap:** standalone installations can upgrade before hosted Duet.
**Rationale:** publishing first would reject internal calls or send new chat IDs
through upstream-cost billing. **Consequence:** backend readiness precedes package
publication; those early probes establish service readiness, not new-runtime proof.

### Separate old request admission from current selections

**When:** final shared catalog pass.

**Decision:** stable memory and media roles choose successors, while prior concrete
IDs remain hidden admission records. Historical flat-rate coverage also remains.
The alternative was to remove old acceptance when managed workspaces converged.

**Gap:** standalone clients update independently, and active calls may outlive a
rollout. **Rationale:** accepting an old request is separate from selecting an old
model in the current runtime. **Consequence:** current defaults and product choices
advance, while old in-flight or standalone requests remain serviceable; advanced
raw-model admission retains the existing API behavior.

### Keep media estimates representative

**When:** media catalog pass.

**Decision:** retain the catalog's one estimate per image or second, document its
representative settings, and share metadata between the two quality Seedance roles.
The alternative was a new pricing calculator covering every provider dimension.

**Gap:** provider prices vary by output settings and may be token based.
**Rationale:** catalog estimates are informational; generation settlement owns the
actual bill. **Consequence:** the estimates are neither exact quotes nor reservation
amounts. Existing media/services settlement policy remains unchanged.

### Observe billing metadata through the response stream

**When:** video qualification and gateway review.

**Decision:** scan a bounded rolling text window as SSE response chunks flow to
the client. If the client cancels before metadata arrives, drain only until the
generation ID or end of stream; a known ID permits immediate cancellation. The
alternatives were to stop after a short prefix or buffer the entire video.

**Gap:** supported video responses can put billing identity after a large inline
payload. **Rationale:** the existing response owner can preserve client backpressure
and collect that identity without a second unbounded buffer. **Consequence:**
trailing IDs remain billable; truly missing IDs retain existing release behavior.

### Compose the package release from the requested work

**When:** agent publication.

**Decision:** release from the last published source plus this feature and necessary
test fixes, excluding unrelated local development. **Gap:** the sibling checkout
contained six unpublished commits outside this task. **Rationale:** publishing the
whole checkout would widen the requested release. **Consequence:** those commits
remain in the user's original checkout, while immutable release tags and npm bytes
identify the model update independently of unrelated development.

### Keep benchmark results tied to their actual models

**When:** final active-consumer review.

**Decision:** current benchmark configurations use the current family targets.
Reports use the existing campaign and catalog owners to classify current and
historical usage as executor or advisor work, while displaying the original
model IDs. The alternative was to rewrite old results or maintain a second
version table just for reporting.

**Gap:** changing the executable defaults could make earlier runs unrecognizable
to current reports. **Rationale:** the role is stable across versions, while the
recorded model remains the fact needed to compare runs honestly. **Consequence:**
old results remain readable and current models are classified correctly;
reporting does not relabel an old generation as a new model.
