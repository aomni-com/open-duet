# Choices

This ledger records decisions the implementation made where the plan left room
for more than one reasonable answer. It is grouped by confidence so the least
certain calls are easiest to review.

## Sound, lower confidence

- **Vendor billing probes may use an account usage endpoint when one exists.**
  A probe reads usage before and after a metered request and compares the delta
  with the catalog's computed units. If a vendor has no usable usage endpoint,
  the probe still reports the request and response signals without inventing a
  ledger result. **Gap:** the plan did not prescribe one common usage response
  shape. **Reach:** future vendors need a pure reader and must treat an
  unavailable usage endpoint as unproven rather than silently green. **Verdict:**
  sound. **Confidence:** medium.

- **The staging voice-expiry test shortens the real TTL instead of faking state.**
  A test-only Convex mutation moves one tracked resource to a bounded short
  expiry and schedules the same production expiry action that reads the vault,
  deletes the upstream voice, and marks the row expired. That proves the actual
  cleanup path while avoiding a 24-hour wait. **Gap:** the production TTL is
  intentionally long. **Reach:** each future shared pool needs a production
  expiry adapter before it can claim the same journey coverage. **Verdict:**
  sound for ElevenLabs. **Confidence:** medium.

- **Every documented service route is admitted unless it crosses a named
  security boundary.** The catalog covers the route surface taught by the
  service skills; account/private data and unpartitionable shared listings stay
  excluded and are called out in the service README. The skills cross-check
  fails closed if a skill teaches a proxy path absent from the catalog.
  **Verdict:** sound. **Confidence:** high.

- **The external skill includes a concrete voiceover recipe.** A fresh agent
  initially chose macOS speech because the generic service loop did not say what
  to do for audio. The skill now explicitly says to search `audio`, show
  `elevenlabs`, call the TTS route, and verify the MP3. **Gap:** the plan named
  the discover/read/call method but left the worked example open. **Reach:**
  future capability examples should make the intended catalog path obvious when
  a generic agent has a local fallback. **Verdict:** sound. **Confidence:**
  medium.

## Sound, high confidence

- **The catalog is pure TypeScript and owns route matching, pricing, validation,
  provider hooks, fixtures, and probe declarations.** Convex owns secrets,
  ownership, expiry, and ledger persistence; the API owns HTTP adaptation. This
  gives each fact one owner and lets catalog tests run without credentials.
  **Verdict:** sound. **Confidence:** high.

- **The proxy is an allowlist.** A route absent from the catalog returns a
  bodyless 404 before vendor credentials or billing are touched. This prevents a
  shared upstream account from accidentally exposing history, account settings,
  or another user's content. **Verdict:** sound. **Confidence:** high.

- **All service charges use one rounding order and one margin.** The catalog
  rounds vendor units into micro-dollars first, then applies the 20% margin and
  rounds again. The runtime keeps preflight and settlement as the billing owner;
  the catalog supplies only route and vendor-cost metadata. **Verdict:** sound.
  **Confidence:** high.

- **Shared resources use one general ownership mechanism.** A created resource
  is recorded with its service, pool, resource id, workspace owner, and expiry.
  Reads and uses are open; mutations and deletes require the recorded owner;
  untracked resources are read/use only. **Verdict:** sound. **Confidence:**
  high.

- **The public vault boundary is an adapter, not a second storage model.** The
  internal Convex model remains the owner of validation and storage. Narrow
  public adapters accept the internal key so the API's `ConvexHttpClient` can
  reach that model, while trusted Convex actions and the stdin seeding command
  continue to use the internal functions. **Verdict:** sound. **Confidence:**
  high.

- **Workspace selection uses `x-duet-workspace`.** The API resolves the
  workspace from authenticated membership, strips the header before forwarding,
  and rejects ambiguous selection with an instructive 403. This replaces the
  old query parameter that could leak a workspace slug to a vendor. **Verdict:**
  sound. **Confidence:** high.

- **Discovery and the CLI expose method, docs, admission, and call results, not
  prices or credentials.** Agents search, read one service's links and allowed
  routes, then call through `duet services`; the response header carries the
  computed charge so the CLI can print `billed $…`. **Verdict:** sound.
  **Confidence:** high.

- **Vendor errors pass through the call command.** The CLI uses raw response
  handling for vendor failures and reserves Duet's structured error mapping for
  gateway blocks. Agents can diagnose an upstream failure without losing its
  useful fields. **Verdict:** sound. **Confidence:** high.

- **The skills registry is checked against the catalog.** A test scans authored
  skill files for proxy paths, normalizes parameter placeholders, and requires
  every documented proxy path to match an admitted route. This keeps prose from
  promising an endpoint the allowlist rejects. **Verdict:** sound. **Confidence:**
  high.

- **ScrapeCreators is a research placeholder only.** Its product, API, docs,
  OpenAPI, authentication, likely public-data scope, exclusions, and unknowns
  live in `future-data-sources.md`; no route, key, price, or availability promise
  was added. **Verdict:** sound. **Confidence:** high.

- **Service usage ledger rows are signed debits.** The closeout oracle compares
  each row to `-ceil(ceil(vendor units × unit rate) × 1.2)`, so a workspace being
  credited by mistake cannot pass on magnitude alone. **Verdict:** sound.
  **Confidence:** high.
