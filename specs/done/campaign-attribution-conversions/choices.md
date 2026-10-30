# Campaign attribution and conversions — choices ledger

Every decision made where the spec was silent, re-audited against the final
shipped code. All entries are **Sound**; they are grouped by confidence with
the least-confident first, so review effort lands where it matters.

## Sound — medium confidence

### Backend-authored events share one origin

- **The choice:** Audit, prompt, file, and onboarding-completion events all
  carry `origin: "product_backend"`; browser-submitted business events carry
  `product_browser`, and executor-derived evaluations carry
  `conversion_executor`. The alternative — one origin per backend domain —
  would make origin a copy of the event-name taxonomy.
- **The reach:** Future campaign origin filters and sink queries inherit one
  stable server-versus-browser boundary.
- **Why sound:** Origin identifies the transport/authority boundary; event
  names identify product domains.

### Mirror file activity resolves to the sync-device owner

- **The choice:** The shared file actor resolver treats a `mirror:<deviceId>`
  actor as the user who owns that sync-device credential; a missing or
  non-sync credential stays anonymous. Checking the credential kind prevents
  unrelated API-key IDs from asserting identity.
- **The reach:** File history and conversion triggers agree on mirror identity
  through one policy owner.

### Server PostHog settings reuse the browser project through server-only aliases

- **The choice:** Secret fanout copies the existing browser-facing PostHog
  key/host into Convex-only `POSTHOG_API_KEY`/`POSTHOG_HOST`. Changing the
  staging PostHog project once changes both native browser telemetry and the
  server sink; a second encrypted pair could silently drift to another
  project.

### The private browser endpoint uses ordinary accepted/invalid/not-found HTTP semantics

- **The choice:** A valid browser event returns `202` after Convex schedules
  it; malformed or caller-spoofed fields return `400`; a workspace absent from
  the authenticated session returns `404`, hiding membership existence.
- **The reach:** Product callers treat emission as asynchronous and cannot
  probe workspace existence through this endpoint.

### Attribution cookies preserve first-touch UTMs and latest click IDs

- **The choice:** The lander campaign handler prefers an existing host cookie
  for UTM fields but the current request for advertising click IDs, overwrites
  caller-supplied IP/user-agent with request context, and stores the opaque
  journey in the host-only `duet_campaign_journey` cookie.
- **The reach:** All lander actions inherit consistent first-touch campaign
  context while the click identifier for the action actually being submitted
  wins.
- **Superseded in part:** lead capture no longer mints attribution, so this
  applies to the signup handoff and the grow scan only.

### Custom retrier cleanup was deleted — the component vacuums itself

- **When:** Originally Slice 05; deleted 2026-07-26 at Example User's direction
  ("if it adds almost no complexity keep, otherwise delete").
- **The choice:** The installed `@convex-dev/action-retrier` keeps one
  bookkeeping row per run. The build originally added a custom
  status-check/100 ms-reschedule/missing-safe protocol to delete each row
  right after its run completed, working around the component stamping
  completion only after our callback returns. On inspection the component
  already runs its own daily cron that deletes completed runs older than one
  week — so the custom machinery only made rows disappear a few days
  earlier. It was deleted outright: one module, two mutations, their
  scheduling calls, and three tests. Completed run rows now simply sit for
  up to a week until the component's cron removes them.
- **The reach:** Zero cleanup code to debug; the only cost is transient
  bookkeeping rows with a bounded one-week lifetime, invisible to product
  behavior.

### Stored terminal errors keep only the first 4,096 characters

- **The choice:** When every retry fails, the instance retains a readable
  error prefix capped at 4,096 characters with an ellipsis marking
  truncation, instead of copying an arbitrarily large thrown message into
  permanent journey state.

### Prompt chronology validation was deleted — arrival order is good enough

- **When:** Originally Slice 06; deleted 2026-07-26 at Example User's direction.
- **The choice:** The grow classifier judges a new user from their first five
  prompts, loaded at evaluation time from references stored in journey
  state. The build originally validated that the five rows' durable creation
  timestamps never went backwards across sessions, throwing on
  "time-traveling" references. Example User's call: the classifier is reading
  isolated prompts (not conversation history) to gauge how someone uses the
  product — exact ordering across sessions changes nothing about that
  signal, so the validation (plus companion sequence-number and duplicate
  checks) was deleted. The query now simply loads each referenced prompt in
  the order given, still enforcing the two checks that matter: the session
  belongs to the acquired user, and the referenced row exists.
- **The reach:** Classification is insensitive to cross-session prompt
  ordering by design; only ownership and existence are contracts.

### A wake without an onboarding completion is an invalid retryable input

- **The choice:** A "wake" is the timer input the executor delivers when a
  journey's scheduled `wakeAt` moment arrives — for grow, the three-hour
  fallback that classifies a quiet user who never sent five prompts. The
  function only ever *schedules* that wake in the same result that stored
  the onboarding-completion timestamp into its journey state. So if a wake
  is delivered and the state has no onboarding timestamp, the journey's
  persisted state is structurally impossible — something corrupted it.
  `classifyFit` throws in that case, which hands the problem to the generic
  executor: retry, and if it keeps failing, record the error on the journey,
  drop that input, and continue. The unbuilt alternatives — silently ignore
  the wake, or end the journey as "not a fit" — would each translate
  corrupted control state into a quiet product decision nobody would ever
  investigate.

### A lead's email and an acquired user's durable ID may identify the same delivery

- **The choice:** When a delivery references both the triggering lead and an
  acquired user, identity resolution uses the lead's submitted email but the
  user's durable database ID as the external ID — each field from its
  strongest owner.
- **The reach:** Changing precedence would alter provider matching but not
  persisted conversion control.
- **Superseded:** a delivery can no longer reference a lead, so identity comes
  from the acquired user alone.

### Google refreshes OAuth on each retrier attempt

- **The choice:** Every Google delivery attempt exchanges the configured
  refresh token for a fresh access token immediately before `events:ingest`,
  instead of maintaining a cached access token with its own expiry,
  concurrency, and secret-persistence rules.
- **The reach:** One extra OAuth request per attempt; delivery rows and
  campaign configuration stay free of ephemeral tokens.

### Local-test campaign helpers stay deployed, minus dead surface

- **The choice:** The internal-key-gated `testing/campaigns.ts` helpers remain
  deployed, matching the repository's testing-module convention; the unused
  lead listing was deleted. The bootstrap helper's injected emitter writes a
  marker row because that is the only oracle observing which concurrent
  bootstrap transaction committed its emit — a fake HTTP sink sees only
  post-dedupe delivery. A second-opinion review asked to remove or
  environment-gate the module; declined as inconsistent with the twenty-plus
  sibling testing modules.

## Sound — high confidence

### An acquired attribution belongs to one user

- **The choice:** Signup transactionally claims an attribution for the first
  acquired user; the same user may reuse it idempotently, and a different
  user presenting the same opaque handoff value is treated as unattributed.
- **The reach:** Attribution-scoped conversion state can never mix message or
  onboarding events from multiple users.

### Lead-triggered delivery carries the exact lead row ID

- **The choice:** `lead.captured` exposes its stable `leadId`, and eligible
  delivery control copies that reference, so provider identity resolution
  reads the lead that actually triggered conversion instead of guessing
  first/latest.
- **Superseded:** leads no longer participate in campaigns at all. A lead is a
  contact record captured for later email follow-up, minting no attribution and
  emitting no analytics event, so `lead.captured`, the envelope's `leadId`, and
  lead-based delivery identity were deleted.

### Conversion value means major currency units

- **The choice:** A function's `value` is a finite nonnegative amount in major
  currency units; adapters own any configured conversion to minor units
  (OpenAI uses an explicit ISO-currency exponent).
- **Why sound:** One provider-neutral meaning prevents silent 100× monetary
  errors without provider details leaking into conversion functions.

### Google uses the current Data Manager ingestion API

- **The choice:** The Google adapter targets Data Manager `events.ingest`
  rather than the newly restricted legacy click-upload surface the planning
  reference pointed at.

### A file batch creates one retrier job with bounded sink concurrency

- **The choice:** A durable file batch enters analytics as one retrier job
  sending PostHog requests in groups of ten. A partial failure retries the
  whole job; stable insert IDs make the repeats deduplicate. One job per
  event would cross Convex's nested-operation risk at the product write seam.

### PostHog-owned identity fields override same-named arbitrary properties

- **The choice:** The sink writes the stable event ID to `$insert_id`, picks
  `distinct_id` from user ID, anonymous ID, or finally the event ID, and
  writes envelope identity after spreading caller properties, so a caller
  property can never defeat deduplication or attribution.
- **Superseded:** `distinct_id` is the envelope's required `userId` and
  nothing else; the anonymous-id and event-id fallbacks both minted throwaway
  people and were deleted with the anonymous-id rail.

### Envelope versions are positive integers

- **The choice:** The shared envelope accepts only positive-integer versions;
  fractional or negative values have no coherent schema-revision meaning.

### A scan mints or validates attribution before paid generation

- **The choice:** `grow/scan` mints or reuses the journey before invoking
  Firecrawl or AI, so a disabled campaign rejects before upstream spend and a
  failed generation still leaves the submitted journey durable.

### Growth generation credentials move entirely to the API

- **The choice:** The API Vercel project owns Firecrawl and AI gateway
  credentials; the static lander owns neither, and lander routes remain
  proxy-only.

### A delayed conversion inherits the attribution's acquired user

- **The choice:** An event-triggered conversion copies the user carried by
  the event; a timer-triggered conversion copies the user permanently claimed
  by the attribution, so the three-hour classify-fit wake still delivers with
  a person identity.

### Checkpoint names are nonblank and at most 256 characters

- **The choice:** Checkpoint names are deployed identifiers, not user
  content; blank or over-long names are rejected before lookup or storage.

### Every campaign points at a real conversion function

- **The choice:** `grow` runs `classifyFit`; every other current campaign
  references one shared baseline function directly. Switching a campaign
  between functions is a live code-config change, not a data migration.
  (Superseded in part: the baseline is now `convertOnSignupAndPurchase`, and
  an attributed signup credits acquisition but leaves the journey open for a
  later purchase rather than completing immediately.)

### Repeated onboarding events keep the first completion time

- **The choice:** The first onboarding completion fixes the three-hour
  fallback deadline; duplicate completions with different IDs never slide it.

### Live message thresholds are constrained to the retained window

- **The choice:** Campaign config accepts message thresholds one through five
  because journey state retains at most five prompt references; a higher
  value would silently turn the message trigger off rather than widen state.

### Provider error bodies are not retained

- **The choice:** A non-success response throws only the provider label and
  HTTP status (`Google delivery failed with HTTP 429`); provider response
  text may echo submitted identity and can be very large, so it never enters
  durable control rows.

### Completion-callback failures settle as terminal inputs

- **The choice:** `settleConversionRun`/`settleDeliveryRun` wrap completion
  processing; if any step throws, the failure becomes the designed
  terminal-input outcome — record a bounded error, drop the input, advance.
  The installed retrier swallows callback throws and still marks the run
  completed, so the unwrapped path would strand `activeRunId` forever.
  Deliberate nuance: Convex keeps writes made before a caught throw, so a
  failure that fires *after* the instance has already advanced degrades to a
  lost wake-schedule or analytics event for that one input — never a rewound
  or stalled journey. That asymmetry is pinned by the
  "failure after the instance has advanced" test in `conversions.test.ts`;
  an independent review proposed not catching around writeful completion,
  which was rejected because the uncaught path restores the original
  permanent-stall bug.

### An expired journey consumes its fired wake

- **The choice:** A wake firing after the attribution's fixed expiry clears
  `wakeAt` before returning, so durable control state never advertises timer
  work that already fired and can never rerun. No expiry state machinery was
  added; expiry stays derivable from the attribution row.

### The analytics-excluded audit subset lives in the contract

- **The choice:** `ANALYTICS_EXCLUDED_AUDIT_EVENT_NAMES` (sensitive
  credential/impersonation audit facts that never reach analytics sinks) is
  exported from `@repo/contract/analytics`, typed against the audit roster it
  constrains; the audit writer consumes the exported policy.

### Backend test harnesses set DUET_APP_URL, never the vendor alias

- **The choice:** Convex-dev-based backend suites configure `DUET_APP_URL`;
  the shared harness bridge maps it to the `SITE_URL` vendor key that
  `@convex-dev/auth` requires. (The boundary scan that once policed the
  legacy name was itself deleted on 2026-07-26 with the rest of
  `scripts/app-boundaries.ts`; the naming convention stands on its own.)

### Lead capture and signup keep separate journey attributions

- **The choice:** The generic lead action creates its own attribution and
  lead row; the later signed signup action creates the immutable acquisition
  attribution. Both retain the same captured signals while conversion routing
  follows acquisition — the staging journey exercises the shipped action
  registry rather than a merged relationship production does not have.

### Live proof reads conversion control, not analytics receipts

- **The choice:** The staging-only projection is scoped to exact run-owned
  IDs and returns bounded acquisition, conversion state, and delivery status;
  it does not reconstruct consumed input IDs or query PostHog. The configured
  sink credential is write-only and Duet intentionally owns no analytics
  history, so stable sink identity and non-recursion are contract-tested
  locally instead.

## Post-close follow-ups (2026-07-26, Example User-directed session)

### The prod secret fanout ran the full topology rail, not a single key

- **When:** Post-close follow-up, after Example User asked for the prod
  `DUET_CAMPAIGN_HANDOFF_SECRET` fanout.
- **The choice:** The ask named one secret, but the fanout rail
  (`bun run secrets:push:prod -- --apply`) has no single-key mode — it
  upserts every managed secret from the encrypted `.env.production` onto all
  seven targets (64 pairs set, 0 failed; the six unprovisioned ad-destination
  credentials correctly skipped). The unbuilt alternative was a hand-run
  `convex env set DUET_CAMPAIGN_HANDOFF_SECRET …` touching only that key.
- **The gap:** Whether "do the fanout" meant the designed rail or a surgical
  write.
- **The reach:** Any prod target var that had drifted from the encrypted
  source since the last push (2026-07-23) was silently overwritten back. The
  rail never deletes, and its orphan report came back clean, so no unmanaged
  var was touched.
- **Verdict:** Sound — the rail is the declared single owner of the
  secret→target topology, and partial pushes are how drift starts.
- **Confidence:** High.

### The classifier swap is live on staging; prod code deploy is held for Example User

- **When:** Post-close follow-up, after Example User asked for the Sonnet 5 swap.
- **The choice:** `grow.conversion.config.modelId` is now
  `anthropic/claude-sonnet-5` (threshold 55 kept verbatim per "recalibrate
  later"), committed, pushed, and deployed to staging Convex. Deploying the
  same commit to prod Convex was attempted and then deliberately surfaced
  instead of forced: `convex deploy` ships the entire current backend tree,
  not one line, and the permission classifier blocked it.
- **The gap:** "Make grow classifier sonnet-5" did not say which deployments
  must pick it up immediately.
- **The reach:** Per the spec's live-config design, any in-flight staging
  grow journey now classifies its next evaluation with Sonnet 5 against the
  4.6-calibrated threshold — borderline scores near 55 may flip until
  recalibration. Prod Convex still runs its previous backend push.
- **Verdict:** Resolved by Example User (2026-07-26): prod deploy authorized and
  applied — prod Convex received the full current backend, including the
  campaign tables and indexes for the first time; prod API probes returned
  200 after.
- **Confidence:** High.

### The handoff signature was removed; the attribution row authorizes itself

- **When:** Post-close follow-up, Example User-directed ("optimize for simplicity
  and maintainability").
- **The choice:** The campaign signup handoff no longer carries an
  HMAC-signed token — the redirect and HttpOnly cookie now carry the raw
  attribution row ID, and bootstrap authorizes it purely from the row:
  exists, `action === 'signup'`, campaign still defined, fixed expiry not
  passed, transactional one-user-forever claim. Deleted with the signature:
  `DUET_CAMPAIGN_HANDOFF_SECRET` (topology entry, both encrypted env values,
  both Convex deployments), ~110 lines of WebCrypto sign/verify plus its
  tests, and the hard throw that made product signup depend on a marketing
  env var.
- **The gap:** Example User judged the signature complexity unjustified; analysis
  agreed — it duplicated row-side checks and could not stop the realistic
  abuse (relaying a validly minted token), so its only real protection was
  against claiming attributions from internally leaked IDs.
- **The reach:** Worst case is unchanged (misattribution noise in marketing
  data; no user data at stake). One transition loss accepted: a signed-token
  cookie minted before this change no longer resolves, so that signup lands
  unattributed. Convex row IDs remain opaque and unguessable; if a future
  requirement ever needs handoff values that outlive row visibility rules,
  re-adding a signature is a contained change inside `handoff.ts`.
- **Verdict:** Sound — directed by Example User; the enforcement that matters was
  always the row's claim transaction.
- **Confidence:** High.

### The lander owns campaign actions end to end; the API dispatcher is gone

- **When:** Post-close follow-up, 2026-07-26, Example User-directed.
- **The choice:** When a visitor clicks a campaign signup link or submits a
  lead form on the marketing site, the request used to make two hops: a
  lander route captured browser context (cookies, UTM parameters, click IDs,
  IP), squeezed it into a custom encoded header, and forwarded to an
  `apps/api` route that decoded the header, validated the body, rate-limited
  scans, generated the growth brief, and finally called Convex. Now one
  lander module (`apps/lander/src/campaigns/actions.ts`) does all of it and
  calls Convex directly with the internal key. Deleted with the hop: the
  API's campaign dispatcher and its auth-bypass wiring, the encoded
  context-header contract between the two apps, and the proxy's
  response-relaying code (~500 lines net). The lander gained four env vars
  (Convex deployment, internal key, Firecrawl, AI gateway) via the secret
  topology. The old design served a "lander holds no credentials" policy
  that Example User explicitly retired.
- **The gap:** Which app owns anonymous campaign actions was a policy
  question the original build answered with the now-dead boundary rule.
- **The reach:** Campaign changes now deploy with one app instead of
  spanning a Convex push and an API build (the skew that briefly 502'd
  staging signup earlier today becomes structurally impossible). The API
  keeps only the authenticated product-browser analytics ingress; it no
  longer knows campaigns exist.
- **Verdict:** Sound — directed by Example User; one owner, one deploy, less code.
  Reviewed tradeoff, accepted: the lander's server runtime now holds the
  same universal internal key the API always held, so a lander server-code
  compromise reaches every internal-key-gated Convex function, not just the
  two campaign mutations. An independent review proposed a campaign-scoped
  credential; declined as a second secret lifecycle for a marginal boundary
  (both apps live in the same Vercel account either way). Revisit if the ad
  destinations go live and the lander's blast radius starts carrying spend.
- **Confidence:** High.

### The analytics emitter is two plain functions, not a factory stack

- **When:** Post-close follow-up, 2026-07-26 (overengineering sweep).
- **The choice:** Emitting an analytics event used to go through three
  factory functions (`createAnalyticsEmitter`, `createAnalyticsBatchEmitter`,
  `createAnalyticsFanout`) that each existed to be instantiated exactly once,
  wired together, and exercised by tests injecting fake sinks. Now
  `emitAnalyticsEvents` is one plain function: parse each event, route
  conversions transactionally, and — if PostHog is configured — schedule one
  retried sink batch; `emitAnalyticsEvent` wraps a single event in a list.
  The factory-only tests went with the factories; routing behavior stays
  pinned by the campaign-domain suites and the static no-history firewall
  test survives unchanged.
- **The reach:** Anyone reading the emitter now sees the whole policy in
  twenty lines instead of assembling it from three indirections.
- **Verdict:** Sound — the indirection had exactly one consumer: its tests.
- **Confidence:** High.

### Mailbox purge is one bounded delete, not a batch continuation scheme

- **When:** Post-close follow-up, 2026-07-26 (overengineering sweep).
- **The choice:** When a journey finishes, its queued mailbox inputs are
  deleted. The build originally deleted them in batches of 256 and, if a
  batch came back full, scheduled a follow-up mutation to continue — paging
  machinery for a mailbox that can realistically hold a handful of rows
  (five prompt events and an occasional wake). Now the purge reads up to
  1,000 rows (a safety ceiling, not a pager) and deletes them in place; the
  scheduled continuation mutation and its option plumbing are gone.
- **The reach:** If some future journey design could genuinely exceed a
  thousand queued inputs, purging needs revisiting — nothing today comes
  within two orders of magnitude of it.
- **Verdict:** Sound — the continuation guarded a load profile the product
  cannot produce.
- **Confidence:** High.

### The closed spec record was amended rather than left frozen

- **When:** Post-close follow-up.
- **The choice:** The archived README's classifier paragraph now records the
  post-close model swap and the open recalibration debt, instead of leaving
  the frozen record claiming the newer Sonnet "was deliberately not
  substituted" — which became false the day after close.
- **The reach:** Done-spec records stay truthful over time; readers of the
  archive learn the current model owner is `config.ts`, not the record.
- **Verdict:** Sound — a rationale record that contradicts shipped config is
  worse than an amended one.
- **Confidence:** High.

### A racing bootstrap probe retries through client redirects

- **The choice:** The live journey's repeated-bootstrap `page.evaluate` runs
  through a bounded retry that absorbs only "execution context destroyed"
  navigation races; the 204 assertion still owns correctness. Anchoring on a
  particular intermediate SPA route would couple the journey to routing
  internals.
