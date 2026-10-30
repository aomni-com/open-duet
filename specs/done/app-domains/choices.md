# App domains — final choices

These are decisions made where the request left a gap, checked against the final
feature. Explicit user requirements live in the rationale README. Every decision
below is retained; there are no deferred correctness decisions.

## Operational consequences

### Reserve a hostname after an uncertain provider write

- **When:** provider effect settlement review.
- **Decision:** an interrupted add/delete, lost response or provider server error
  keeps the hostname reserved and asks support to confirm the remote operation
  settled before cleanup resumes. The alternative was releasing it after a timeout
  or a later missing-domain response.
- **Gap:** the request did not prescribe recovery when the provider may still be
  changing an alias after Duet stopped waiting.
- **Rationale:** native HTTP cancellation stops our wait without stopping the
  remote write. Reusing a hostname then lets an old operation alter a new binding.
- **Consequence:** rare ambiguous writes need operator repair; ordinary removal
  immediately stops serving and automatically retries bounded cleanup. The repair
  remains attached to its captured project/branch, even after its app disappears.

### Keep successful bindings serving through failed observations

- **When:** provider/lifecycle review and recheck correction.
- **Decision:** malformed responses, unavailable credentials and transport failures
  retain an active binding and its DNS evidence. Authoritative absence, mismatch
  or an observed unready domain demotes it. Explicit rechecks expose derived
  `checking: true` while queued/running; completion removes it. The alternative was
  taking every active domain offline while checking or on any provider failure.
- **Gap:** recheck progress and the effect of observation failures were unspecified.
- **Rationale:** inability to observe does not establish that a working address
  changed. Progress is distinct from serving eligibility and derives from the
  existing work owner, without another stored status.
- **Consequence:** an active address keeps working during Recheck; the dialog
  observes the result and suppresses duplicate rechecks. There is no periodic
  active-domain health check or browser timer once the work settles. The mounted
  paged inventory observes its loaded unsettled rows after a manager closes and
  refreshes app address caches only when readiness/hostname changes; it never
  starts per-row requests or invalidates its own observation loop.

### Separate runtime domain authority from deployment credentials

- **When:** staging credential provisioning.
- **Decision:** Convex receives a separately named Vercel token restricted to the
  edge project. The local deploy token remains local. The alternative was reusing
  account-wide deployment authority inside request handling.
- **Gap:** the feature needed a runtime registration credential.
- **Rationale:** domain operations belong to one existing project and the existing
  secret-delivery rail already supplies Convex credentials.
- **Consequence:** staging and production each receive their own project-restricted
  runtime credential through the encrypted rail. No new secret service or identity system ships.

## Product and authority

### Let readers inspect and local editors manage every app binding

- **When:** control contract and app-menu implementation.
- **Decision:** Custom domains is reachable from every app menu; viewers inspect,
  local owners/editors attach, recheck and remove. A required `manageDomain`
  control comes from the server, including for broken, disabled, installed or
  read-only shared apps. The alternative was hiding inspection or reusing runtime
  editing permissions.
- **Gap:** permissions for local copies and unhealthy apps were unspecified.
- **Rationale:** an address belongs to the local app, independently of who owns
  its files or runtime. Cleanup must stay available when the service is unhealthy.
- **Consequence:** shared/installed copies can have independent local addresses;
  managing one cannot change the original app, share permissions or visibility.
  The existing apps scope and workspace trust model remain the authority.

### Keep the accepted slot visible until cleanup finishes

- **When:** shared management panel implementation.
- **Decision:** attach/remove use accepted server responses without optimistic
  replacement. Removal uses an inline confirmation, explains the Duet fallback
  and retains the removing hostname. The alternative was immediately showing an
  empty attachment form.
- **Gap:** transient removal presentation and confirmation were unspecified.
- **Rationale:** the hostname and single app slot remain reserved during cleanup;
  an empty form would offer an action the server must refuse.
- **Consequence:** one panel owns menu and Settings actions, DNS evidence and
  errors. Exhausted cleanup exposes Retry; uncertain writes expose support guidance.

### Fetch app navigation details only when Open app is clicked

- **When:** workspace inventory implementation.
- **Decision:** Settings renders one paged aggregate. Open app resolves that app
  and reuses the bounded cached agent roster through the same location owner as
  Drive. The alternative was requesting every app while rendering inventory.
- **Gap:** aggregate rows have identity and controls, but no duplicated anchor path.
- **Rationale:** existing containment and product navigation rules already locate
  the app; per-row reads would add fan-out and a second projection.
- **Consequence:** paging and inspection survive a navigation failure; only the
  requested row displays loading feedback; a navigation error uses the shared toast. Open app enters Duet internally.
  Existing public-only standalone Open/Copy menu availability is unchanged.

### Store a single normalized DNS hostname

- **When:** contract grammar implementation.
- **Decision:** accept a hostname or HTTP(S) root URL, normalize case/scheme/root
  slashes and store the hostname. Refuse paths, ports, wildcards, platform domains,
  numeric/IP aliases and Unicode spelling transformations; accept ASCII punycode.
  The alternative was storing a URL or silently converting Unicode input.
- **Gap:** attachment input grammar was unspecified.
- **Rationale:** provider assignment, lookup and browser navigation must agree on
  the exact DNS identity the user entered.
- **Consequence:** international domains use their punycode spelling. Inventory
  app names reuse the ordinary bounded app-name validator rather than a wider copy.

## Storage, lifecycle and delivery

### Keep bulky DNS evidence separate from the canonical slot

- **When:** transaction-budget experiment.
- **Decision:** the canonical slot owns hostname/status/work; a referenced row
  owns records/conflicts. Detail and inventory join them, while app/VM projections
  read the small slot. The alternative was duplicating an address projection or
  reading every full DNS payload when assembling VM configuration.
- **Gap:** worst-case provider payloads were not sized in planning.
- **Rationale:** the maximum accepted diagnostics across the app ceiling exceeded
  Convex's transaction read budget in the real configuration query.
- **Consequence:** diagnostic updates/deletion are atomic; visible inventory pages
  cap at five rows and retain opaque continuation. Orphan cleanup stays out of inventory.

### Reuse durable retry ownership and capture the provider target

- **When:** lifecycle implementation and cleanup review.
- **Decision:** existing ActionRetrier runs/callbacks own work, with a global five
  worker cap, fair due scheduling and six automatic cleanup attempts. App/replica
  removal share one primitive; workspace deletion seals admission and schedules
  its first cleanup page separately. The alternative was a new queue/lease engine
  or another paginated query inside composed parent deletion.
- **Gap:** concurrency, crash recovery and teardown composition were unspecified.
- **Rationale:** the component already owns retries and crash detection. Convex
  permits one paginated query per transaction; parent sealing already stops serving.
- **Consequence:** cleanup survives parent deletion and uses immutable captured
  team/project/branch. Domain bindings are local metadata and never replicate with
  files or marketplace declarations. Operator repair is bounded domain-specific work.

### Treat addresses as presentation, without restarting services

- **When:** shared address contract and reconciliation integration.
- **Decision:** compact hostname/status metadata feeds one standalone URL selector
  used by API, menus and public gateway prompts. Process equality ignores it.
  An internal reconciliation callback nudges existing delivery, with VM sync as
  recovery. The alternative was persisting another canonical URL or restarting
  the service after a domain transition.
- **Gap:** how addresses reach humans and agents was unspecified.
- **Rationale:** DNS readiness changes where requests arrive, not commands or files.
- **Consequence:** standalone projections refresh together; embedded launch keeps
  its standard Duet destination. Three existing-audit-owner event names distinguish
  attachment, activation and removal without recording credentials/DNS challenges.

### Carry the original host across the VM ingress hop

- **When:** live proxy verification.
- **Decision:** edge stamps its resolved original app host in an internal header;
  gateway restores ordinary `x-forwarded-host` before app delivery and removes
  that internal header. The alternative was trusting the standard header through
  another proxy or adding a second app-serving path.
- **Gap:** the request did not prescribe how multiple infrastructure hops preserve
  the public hostname.
- **Rationale:** live traffic proved VM ingress replaces ordinary proxy headers
  with its own hostname. The existing edge/gateway transport can carry the original
  address without changing app admission or asking applications to adopt a new API.
- **Consequence:** custom and standard apps see the correct conventional forwarded
  host. An unstamped request keeps its ordinary path; this is addressing metadata,
  not new credential or permission authority.

### Bound each provider attempt and verify replay ownership

- **When:** provider adapter and reference parity implementation.
- **Decision:** a provider operation has a total 30-second deadline and 256 KiB
  body limit. Incomplete add/verify metadata and narrow already-assigned replay
  responses require a point read of the captured project/branch; deletion inspects
  ownership before mutation. The alternative was trusting any success/conflict
  response or adding hidden transport retries.
- **Gap:** inconsistent provider response shapes and replay outcomes were unspecified.
- **Rationale:** only the authoritative assignment distinguishes our replay from
  someone else's alias; lifecycle already owns retry timing.
- **Consequence:** full DNS conflicts remain intact within the budget. Oversized
  or malformed responses are explicit diagnostics, never partial instruction lists.
  An omitted branch in an authoritative point read means production, while mutation
  omission alone cannot authorize activation.

### Discard caches that cannot supply required authority

- **When:** final browser-cache review.
- **Decision:** use the existing cache generation to discard app responses that
  predate required `manageDomain` meaning. The alternative was guessing authority
  from absent fields or migrating persisted responses.
- **Gap:** the new required control's effect on old browser data was unspecified.
- **Rationale:** the persistence owner explicitly requires a new generation for
  required additions; old answers cannot supply the new meaning before refetch.
- **Consequence:** readers pay one cold cache load after upgrade, with no response
  compatibility shim. The deployed web release reports the same generation.

### Keep domain inventory focused on address evidence

- **When:** final consumer review.
- **Decision:** inventory carries app identity and domain evidence. Full app views
  own runtime health; an app-menu manager can additionally show the full app's
  unavailable-service notice. The alternative was per-row runtime reads or another
  availability projection solely for that incidental notice.
- **Gap:** the aggregate's amount of app context was delegated.
- **Rationale:** domain readiness and service health answer separate questions,
  and Settings can inspect/repair domains without loading every app.
- **Consequence:** both entry points share the same domain slot and actions, while
  optional app-health context differs. Open app enters the full app view.

## Browser identity

### Reuse protected Duet sign-in and bind grants to durable app identity

- **When:** private standalone return implementation.
- **Decision:** anonymous private document GETs use a thin protected Duet return
  route and the existing session/proxy. Launch accepts paired validated host/path
  only for that app's current standard or active custom host. Grants carry durable
  app ID and live admission is checked before installing cookies. The alternative
  was another identity flow, cookies shared across domains or slug-only credentials.
- **Gap:** the user permitted a straightforward private return flow on both hosts.
- **Rationale:** existing identity handles sign-in; app IDs prevent a deleted app's
  grant authorizing a replacement at the same address. Request signals distinguish
  documents from iframe/fetch/XHR/API, without treating `/api` as a special path.
- **Consequence:** deep paths return safely; absent host/path always launches on
  Duet. Current-app membership denial stays 403 and cannot loop through login.
  Explicit product routes precede the fallback SPA rewrite.

### Recover obsolete cookies as guest visits, while refusing obsolete grants

- **When:** former-app credential regression review.
- **Decision:** an old app cookie loses viewer identity when the address is reused;
  the replacement's guest policy then governs public/private behavior. An old
  query grant stays refused before cookie installation. The alternative was
  letting an old cookie block a public replacement or retaining old identity.
- **Gap:** address reuse in a browser holding old app credentials was unspecified.
- **Rationale:** cookies are incidental existing browser state; a query grant is
  an explicit authorization attempt. Both must respect durable app identity.
- **Consequence:** public replacements serve; private documents can sign in;
  private iframe/subrequests remain denied. Trusted resolver provenance owns this
  distinction, without a compatibility shim or second credential service.

## Verification choices

### Preserve executable reference evidence without redeploying the old product

- **When:** reference reproduction.
- **Decision:** unchanged old provider/action/storage bodies execute through
  controlled framework/network boundaries. Complete outputs encode missing values
  explicitly and source/runner/fixture identities are SHA-256 frozen. The alternative
  was deploying the old product or replacing handler decisions with fake results.
- **Gap:** isolated reproduction mechanics and serialization were delegated.
- **Rationale:** this preserves request composition and subtle state-update behavior,
  while ordinary JSON would silently drop undefined fields.
- **Consequence:** the oracle proves controlled provider/handler parity only; real
  transactions, UI, identity, routing and TLS have separate production-owner gates.

### Use a single cleanup-owned live fixture with precise claims

- **When:** staging journey and cleanup review.
- **Decision:** read-only preflight refuses an occupied apex. One workspace/VM hosts
  an ordinary app and a same-slug replacement. Fresh real-browser navigations own
  document redirect assertions; synthetic requests own iframe/API refusals. Old
  query-grant replay must finish
  inside its conservative lifetime. Cleanup intent precedes attachment, captured
  app IDs survive parent/auth teardown, and provider assignment/alias absence is
  checked independently. The alternative was stealing a concurrent fixture or
  treating expiry/parent deletion as proof of app identity/provider cleanup.
- **Gap:** exclusivity, release identity and exact live proof were unspecified.
- **Rationale:** existing fixture/ledger rails own resources. Handwritten navigation headers did
  not reproduce the deployed browser path; actual browser navigation proves it.
  Provider alias metadata
  proves the actual edge deployment without adding a public version endpoint.
- **Consequence:** all five deployed owners must identify one full revision and
  staging branch. Replacement proves identity reuse; local tests own actual member
  revocation. Successful ordinary detach proves local slot absence; partial late
  cleanup makes only its observed captured-app/container and remote-absence claims.

### Preserve unrelated visual failures and accept evidenced historical drift

- **When:** visual fixture review.
- **Decision:** refresh four historical control fixtures only after production
  before/after images were byte-identical and independent critics accepted them.
  Keep unrelated existing Settings failures recorded with their old baselines.
  The alternative was changing unrelated rendering or weakening screenshot gates.
- **Gap:** baseline drift predated this feature but appeared in its required checks.
- **Rationale:** a baseline must describe the current production owner; unrelated
  failures must remain visible rather than becoming hidden skips.
- **Consequence:** feature-owned exact desktop/mobile gates are green; retained
  unrelated failures limit any claim about the entire visual suite. Native shots,
  comparisons, crops and independent judgments remain available for review.

### Keep production verification on an existing healthy workspace

- **When:** production release preparation.
- **Decision:** repair stale source-only probe configuration to use the existing
  official-agents hub already used by production smokes. The alternative was
  reviving the archived probe or provisioning a fresh production fixture.
- **Gap:** the request did not prescribe repair of a retired verification target.
- **Rationale:** a read-only probe needs a reachable gateway, and an existing house
  workspace supplies it without changing customer state or incurring a new VM.
- **Consequence:** only local encrypted verification configuration changes; it is
  not delivered to serving projects. Production browser/app behavior continues to
  rely on the accepted staging journey plus read-only production release checks.
