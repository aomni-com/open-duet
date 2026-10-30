# Campaign attribution and conversions

Shipped 2026-07-26; identity and lead handling reworked 2026-07-29. Duet has
one provider-neutral, transient analytics stream; campaign journeys attach to
it; and first-party TypeScript conversion functions evaluate those journeys
without an analytics event database ever existing.

The durable explanation of the shipped architecture — vocabulary grammar, why
events are transient, attribution versus conversion, the function state
machine, and ownership boundaries — lives in the module glossary at
[`packages/backend/convex/domains/analytics/README.md`](../../../packages/backend/convex/domains/analytics/README.md).
This record holds what that glossary deliberately does not: the decisions, the
constraints that forced them, and the dead ends.

## Why this shape

- **The stream is transient because history already has owners.** Product
  tables and audit rows are the durable record; PostHog is a replaceable sink.
  Storing analytics events would create a second event database whose replay
  semantics, retention, and privacy would all need owners. Durable rows exist
  only for real domain history, campaign attribution, leads, conversion
  control state, and provider-delivery state.
- **Campaigns are typed code constants, never database records.** The dominant
  requirement was low maintenance: one generic Convex action selects
  `campaigns[slug].conversion.run` — an ordinary function reference — so there
  are no function keys, version pins, per-function actions, or admin config.
  Config is read live on every attribution, evaluation, and delivery attempt,
  so edits deliberately affect journeys in progress.
- **Attribution is acquisition provenance, not the conversion criterion.**
  One journey per attribution row, minted with a fixed expiry that never
  slides. Routing is single-target: an explicit `attributionId` wins,
  otherwise the user's immutable acquisition, otherwise analytics only.
  Lifecycle events never broadcast to every campaign a user ever clicked.
- **Every analytics event names a user.** `userId` is required on the
  envelope and `distinct_id` is only ever that user. An event that cannot name
  one did not come from a person, so no fallback identity is invented — a
  synthetic distinct ID mints a throwaway sink person per event that merges
  with nothing and inflates person counts forever. Producers that cannot name
  a user emit nothing and let their durable domain row be the record: a file
  event whose actor is `system` (archive restore, unattributed Syncthing) or
  `terminal`, and a conversion evaluation on a journey with no acquired user.
- **Duet mints no visitor identity of its own.** PostHog owns its anonymous
  distinct ID and merges it into the user when the product calls
  `identify(userId)` at sign-in (`apps/web/spa/analytics.ts`). A second
  Duet-side anonymous id would fragment the very person it describes, and
  attribution does not need one: provenance lives in the attribution row's
  signals and the row is claimed by the user at signup.
- **Ad delivery is server-only.** The lander's GTM/Meta/Reddit/OpenAI browser
  runtimes were removed outright; the staging browser journey asserts their
  absence. Each provider has an independent retried adapter; one provider's
  failure cannot block another or the user action.

## Invariants the code must keep honoring

1. `@repo/contract` owns event names, every subset (including the
   analytics-excluded sensitive audit list), JSON validation, and the
   envelope.
2. `emitAnalyticsEvent` owns sink scheduling and conversion routing; there is
   no second server PostHog caller.
3. Domain writers own when events exist; emission attaches to the successful
   authoritative write and a sink failure never rolls back the product write.
4. `conversion.evaluated` is statically excluded from the trigger union — the
   derived event can never trigger another conversion.
5. Eligible results reuse one stable conversion ID across every provider
   retry; provider dedupe fields all map to it.
6. The transient mailbox has no production listing or replay API; inputs are
   deleted after success or terminal failure. The one deliberate exception is
   the staging-gated, exact-run-scoped evidence query in
   `packages/backend/convex/testing/campaignConversions.ts`, which reports a
   bounded count of pending input keys and never input payloads. Anything
   wider is a regression — the static firewall in
   `packages/backend/src/campaign-analytics-firewalls.test.ts` rejects the
   known analytics-history and browser-ad shapes.
7. A journey never stalls: conversion-function failure exhausts retries into a
   recorded error that drops the input and advances; completion-callback
   failure settles the same way (see below).
8. The product host's acquisition cookie is host-only; `*.service.example.invalid` apps
   sharing the registrable suffix is not a trust boundary.
9. An analytics event carries a `userId`, and the sink's `distinct_id` is that
   value and nothing else. Widening the envelope to allow a person-less event,
   or reintroducing a fallback identity, breaks both at once.

## Decisions the code cannot explain

- **The retrier's completion callback is a non-retryable point.** The
  installed `@convex-dev/action-retrier` catches an `onComplete` throw, logs
  it, and still marks the run completed — so any completion-processing error
  would permanently strand `activeRunId`. `settleConversionRun` and
  `settleDeliveryRun` (in `conversionModel.ts` / `destinationDelivery.ts`)
  convert completion failures into the designed terminal-input path. The same
  component owns its completed-run bookkeeping and removes old rows with its
  daily vacuum; Duet deliberately has no parallel cleanup process.
- **The PostHog credential is write-only by design.** Live staging proves
  conversion control and an empty mailbox; stable insert-ID mapping and
  non-recursion are contract-tested locally. Adding a read credential would
  have meant adding an analytics-history surface.
- **The grow classifier's threshold 55 was calibrated on Sonnet 4.6.**
  Provenance: the rubric, ordered structured output, and threshold were
  ported from the sibling chat-app repository's `packages/user-classifier`
  (external to this repo), whose calibration targeted
  `anthropic/claude-sonnet-4.6`. The feature shipped pinned to that model;
  the day after close (2026-07-26) the user switched the live config to
  `anthropic/claude-sonnet-5` accepting the uncalibrated score distribution,
  with recalibration as follow-up debt. The current model lives in the
  campaign registry (`config.ts`), which is the one place to change it.
- **Google uses Data Manager `events.ingest`**, not the legacy click-upload
  API the planning reference named — at build time Google restricted the
  legacy surface for new integrations, and its conversion contract accepts
  alternative click identities rather than a combined payload (official wire
  references: [Data Manager `events.ingest`](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest),
  [Meta CAPI](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event),
  [Reddit CAPI](https://ads-api.reddit.com/docs/v3/operations/Post%20Conversion%20Events),
  [OpenAI Conversions API](https://developers.openai.com/ads/conversions-api)).
  The adapter picks exactly one of `gclid`/`gbraid`/`wbraid`. Golden provider
  payloads are pinned in
  [assets/slice-07-golden-payloads.md](assets/slice-07-golden-payloads.md)
  and `destinationAdapters.test.ts`.
- **All four destinations shipped disabled.** Provider credentials and
  account-side action IDs are deployment inputs; enabling a destination is a
  one-line flip in the campaign registry (`config.ts`) plus secret fanout —
  no new code paths. Staging evidence reports disabled destinations as
  skipped rather than faking sends.
- **Leads are not campaign journeys** (2026-07-29). A lead is a contact record
  captured for later email follow-up; realistically that person returns through
  a different campaign and acquires then. Tying a lead to an attribution row
  therefore credited a campaign for an acquisition that had not happened, and
  the lead had no user to name, which is why `lead.captured` was the only event
  that could not carry a `userId`. Capturing a lead now mints no attribution,
  sets no journey cookie, and emits nothing; deleting the event took the
  envelope's `leadId`, `campaignLeads.attributionId`,
  `conversionDeliveries.leadId`, and lead-based delivery identity with it.
- **Signup credits acquisition but does not end the journey** (2026-07-29). A
  paid subscription is the outcome campaigns actually care about, so
  `convertOnSignupAndPurchase` converts at signup with `done: false` — keeping
  ad platforms learning on signup volume — and converts again on
  `subscription.started` carrying the plan's monthly price as
  `value`/`currency`. `subscription.started` is the user's first paid invoice
  ever and `subscription.renewed` every later one, so a campaign credits
  acquisition once without re-crediting each billing cycle. `grow` is the
  exception: `classifyFit` closes its journey at the fit verdict, and a closed
  journey accepts no further triggers, so crediting purchases there requires
  giving that function a second non-terminal outcome first.
- **Signup emission and acquisition binding are separate idempotent writes.**
  Convex Auth creates the user before bootstrap sees a handoff, so the
  exactly-once signup marker may exist without acquisition; the first later
  valid handoff fills the still-absent acquisition without replaying signup.
  Concurrency is pinned in `packages/backend/src/invitations.test.ts`, whose
  transactional emit oracle writes marker rows because a fake HTTP sink can
  only observe post-dedupe delivery.

## Dead ends

- **Function registries, version pins, `actions` arrays, `connectionId`** —
  drafted, rejected: every one added a maintenance surface with no consumer.
- **Broadcasting lifecycle events to all of a user's attributions** —
  rejected; it credits unrelated campaigns and needs a dedupe layer.
- **A live PostHog receipt in the staging journey** — rejected (write-only
  credential; would force an analytics-history API).
- **Extending the boundary-scan exemption list for test fixtures that set the
  vendor `SITE_URL`** — reverted during the closing review; tests set
  `DUET_APP_URL` and the harness bridge in
  `packages/test-harness/src/convex-dev.ts` owns the vendor alias.
- **External lead service, Growth Slack notification, and Resend audience
  side effects** — removed with the lead cutover; a lead is one row.
- **A Duet-minted anonymous visitor id** — built 2026-07-29 and deleted the
  same day. The field `campaignAttributions.anonymousId` had been plumbed
  through the schema, the event envelope, and the PostHog sink since the
  original ship without any producer ever writing it. Filling it was tried two
  ways and both were wrong: reading PostHog's own cookie made a replaceable
  sink the registry of who a person is, and minting a first-party id created a
  third identity that merged with neither the browser's anonymous person nor
  the user. The rail was deleted instead.
- **HMAC-signed handoff tokens** — shipped, then removed the day after close
  at the user's direction. The signature only duplicated checks the
  attribution row already enforces (fixed expiry, signup action, one
  immutable claim) and could not stop a relayed validly-minted token, while
  costing a per-env secret whose absence made `finalizeSignup` throw — a
  marketing env var on the signup critical path. The handoff value is now the
  raw attribution row ID; worst case with or without the signature is
  identical (marketing misattribution noise, no user data).

## Pointers

- Vocabulary/envelope: `packages/contract/src/analytics/`; signals allowlist
  and normalizer: `packages/contract/src/campaigns/`.
- Emitter/fanout: `packages/backend/convex/domains/analytics/model.ts`; sink:
  `posthog.ts`; browser ingress: `apps/api/src/routes/analytics.ts` via
  `apps/web/src/server/duet-proxy.ts`.
- Campaign registry: `packages/backend/convex/domains/campaigns/config.ts`;
  attribution/routing/executor/settle: `conversionModel.ts` +
  `conversionExecutor.ts`; classifier: `fitClassifier.ts` +
  `conversionFunctions.ts`; adapters: `destinationAdapters.ts`.
- Handoff: `packages/backend/convex/domains/campaigns/handoff.ts`,
  cookie route `apps/web/src/auth/campaign-handoff.ts`; bootstrap binding:
  `packages/backend/convex/domains/invitations/model.ts`.
- Campaign actions (owned end to end by the lander since the 2026-07-26
  post-close collapse — context capture, validation, rate limit, growth
  brief, and the direct Convex mutation all in one place):
  `apps/lander/src/campaigns/actions.ts`. The original ship routed these
  through an `apps/api` dispatcher behind a lander proxy; that hop was
  deleted as unnecessary indirection once the lander-holds-no-credentials
  policy was dropped.
- Live journey: `packages/test-harness/src/staging-e2e-synthetic`
  (`bun run e2e:staging -- --journey campaign-conversions`); staging-only
  evidence seam: `packages/backend/convex/testing/campaignConversions.ts`.
- Behavior pins: `conversions.test.ts`, `conversionFit.test.ts`,
  `destinationAdapters.test.ts`, `destinationDelivery.test.ts`,
  `campaign-handoff.test.ts`, `campaign-attribution.test.ts`,
  `analytics-producers.test.ts`.

## Evidence

The final live staging run — full acquisition → signup → five prompts →
classify-fit termination (score 96) → skipped-disabled destinations → clean
teardown — is recorded in
[assets/slice-09-live-evidence.md](assets/slice-09-live-evidence.md). The
decisions made where the plan was silent are recorded in
[choices.md](choices.md), re-verified against the shipped code when the spec
was closed.
