# Analytics and conversion tracking

Duet uses one typed stream of completed product facts for analytics and
conversion evaluation. The stream is provider-neutral: product code describes
what happened, while sinks and advertising adapters translate that fact for an
external system.

## Vocabulary

Event names use `domain.past_tense_action`. Name a completed business fact, not
an intent, UI gesture, funnel stage, or provider operation. For example,
`subscription.started` says that a subscription began; names such as
`checkout_clicked`, `bottom_of_funnel`, or `meta_purchase` would bind the
vocabulary to presentation or delivery details.

The canonical event sets and finite-JSON boundary live in
[`@repo/contract`](../../../../contract/src/analytics/). Audit events,
analytics events, and conversion triggers deliberately overlap without being
identical:

- an audit event is the durable accountability record for a domain transition;
- an analytics event is a transient fact sent to configured consumers;
- a conversion trigger is an analytics event that campaign policy may evaluate.

When a domain transition already writes an audit record, derive analytics from
that same authoritative transition and reuse its event name. This keeps one
business fact from acquiring competing meanings. Some useful product facts are
not audit-worthy, and sink-only feedback must not recursively trigger
conversion evaluation; the contract registry owns those distinctions.

An audit event's provenance passes three separate gates, so a new provenance
key is three edits that have to agree. The closed validator in
[`convex/schema.ts`](../../schema.ts) admits it to the durable row; the
projection in [`../audit/model.ts`](../audit/model.ts) admits it to the
analytics payload; and the public
[`WorkspaceAuditProvenanceSchema`](../../../../contract/src/workspaces/) admits
it to the audit endpoint's wire shape. Skipping the first rejects the write and
skipping the second drops the key silently, while the first and third are held
together by a compile-time bridge in
[`../workspaces/auditProvenanceBridge.ts`](../workspaces/auditProvenanceBridge.ts)
that fails `check-types` when either side gains a key the other lacks. Reuse an
existing key only where it means the same thing — one key answering two
questions is how a breakdown starts counting the wrong rows.

Labels that exist only to describe an event — a goal id, the surface an install
came from — are recorded as given rather than parsed against their vocabulary.
That vocabulary belongs at the caller's compile-time surface instead, because
refusing an unrecognized label here would fail the very transition the label
was only meant to annotate.

## History and delivery

Analytics is a transient fanout, not a second event database. Product-domain
rows and audit records own history. PostHog and any future analytics providers
are replaceable sinks, so losing or replacing one never changes Duet's
authoritative product state. The fanout and its best-effort sink scheduling live
in [`model.ts`](model.ts); sink-specific translation belongs beside
[`posthog.ts`](posthog.ts).

Every analytics event names a user, and a sink's own identity model stays the
sink's. Duet mints no anonymous visitor id: PostHog mints its anonymous distinct
ID in the browser and merges it into the user when the product calls
`identify(userId)` at sign-in, so a second Duet-side id would only fragment the
person it is supposed to describe. A producer that cannot name a user has no
person to describe and emits nothing — the durable domain row is the record.

Campaign attribution needs no identity of its own either. Acquisition provenance
lives in the attribution row's signals (`gclid`, `utm_*`), and the row is claimed
by the user at signup, so a click becomes attributable the moment there is
someone to attribute it to.

Emit on the server whenever the backend observes the completed fact. This
avoids browser blocking and ties the event to the successful product write.
The authenticated browser ingress in [`api.ts`](api.ts) is reserved for facts
the backend cannot observe. Native PostHog browser telemetry may still describe
page and interaction behavior, but it is separate from server-owned business
events and never delivers advertising conversions.

## Attribution and conversion

Attribution answers where a campaign journey came from. A conversion function
answers whether that journey achieved the campaign's outcome. They are separate
so campaign acquisition can stay stable while outcome logic evolves.

An event with an explicit attribution targets that journey. Otherwise an
authenticated lifecycle event targets the user's immutable acquisition
attribution. It is never broadcast across all campaign touches. This
single-target rule prevents one signup or later product event from crediting
unrelated campaigns. An event with neither an explicit attribution nor an
acquired user has no conversion target, though analytics sinks may still
receive it.

Campaign policy in [`../campaigns/config.ts`](../campaigns/config.ts) selects
trigger names and a normal TypeScript conversion function. Both are deployed
code, but configuration is read live: changing campaign policy affects journeys
already in progress without migrating or pinning a function version.

Conversion functions return two independent decisions:

- `eligible` says whether this result should be delivered as a conversion;
- `done` says whether this journey should stop receiving future inputs.

For example, `{ eligible: true, done: false }` emits the current conversion and
keeps the journey open for a later outcome. Keeping the decisions independent
also allows a function to finish without credit or to credit a terminal result.
The function contract is owned by
[`../campaigns/conversionTypes.ts`](../campaigns/conversionTypes.ts), and its
truth-table behavior is pinned in the campaign-domain tests.

Mailbox inputs are transient work, not analytics history. Durable conversion
state, checkpoints, and wakes exist only to make arbitrary functions reliable
across retries and time. State carries the small context a function needs on its
next call; checkpoints protect expensive or non-deterministic work; wakes
resume evaluation when time itself is a trigger.

An eligible result receives a stable, provider-neutral conversion ID. Provider
delivery is at-least-once, so every retry of the same result must reuse that ID
for downstream deduplication. Provider wire formats, identity normalization,
and value translation stop at
[`../campaigns/destinationAdapters.ts`](../campaigns/destinationAdapters.ts);
they must not leak back into event names or conversion functions.

## Where changes belong

- **Vocabulary and shared event shape:** the
  [`analytics contract`](../../../../contract/src/analytics/).
- **Domain emission:** the mutation that owns the successful product transition;
  use the shared emitter rather than adding a parallel sink call. The one
  thing that mutation must not do for analytics' sake is read a principal row
  it would otherwise leave alone — `agentSessions` and `apiKeys` are written on
  nearly every request, and a transaction that joins one of them to name a
  user can lose every OCC retry to that traffic, taking the product write down
  with it. When naming the user needs such a join, the owning mutation drafts
  the event and a scheduled mutation finishes it in its own transaction;
  [`../fileActivity/analytics.ts`](../fileActivity/analytics.ts) is the shape.
- **Campaign policy:** the
  [`campaign registry`](../campaigns/config.ts), including trigger selection and
  live configuration.
- **Conversion rule:** an ordinary function in the
  [`campaign domain`](../campaigns/), with durable orchestration kept in the
  generic executor.
- **Analytics sink:** the provider-neutral fanout in [`model.ts`](model.ts) and
  a sink-specific adapter beside it.
- **Advertising provider adapter:** the
  [`campaign destination boundary`](../campaigns/destinationAdapters.ts), where
  provider-specific payload and credential semantics terminate.

The database shape for durable attribution and conversion control remains
owned by [`convex/schema.ts`](../../schema.ts); it is not an analytics-history
schema.
