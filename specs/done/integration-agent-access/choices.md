# Per-agent integration access — choices ledger

## Sound

### Inject the narrow Tool Router Sessions SDK boundary

- **When:** Provider and callback implementation, 2026-08-01.
- **The choice:** The production adapter accepts a function that resolves only
  Composio's session create, use, update, and delete operations. In production the function
  still builds the real SDK client only when an operation runs, so booting the
  API without a Composio key behaves as before. In a test, the function returns
  a small fake that records the exact SDK request. The alternative was to mock
  the whole `@composio/core` module or require credentials merely to inspect an
  adapter request, either of which would couple focused tests to more SDK
  behavior than this adapter owns.
- **The gap:** The product contract required SDK-seam tests when live credentials were
  absent but did not choose an injection boundary.
- **The reach:** Future provider adapter tests can exercise creation and
  rehydration without changing process-wide module state, while provider-side
  behavior still requires the separate live probe.
- **Verdict:** sound — it is the smallest boundary that proves Duet's request
  composition and preserves lazy credential failure.
- **Confidence:** high.

### Keep the MCP transport envelope in the adapter result

- **When:** Provider and callback implementation, 2026-08-01.
- **The choice:** A created or rehydrated session now returns its durable
  provider session ID alongside the existing MCP transport object, which
  contains the URL and the short-lived header needed to proxy a request. The
  durable owner stores only the ID, then calls rehydrate to obtain current
  transport data after a restart. The alternative
  was to replace the result with only flat persisted fields, which would force
  the current proxy and future rehydration path to invent another transport
  shape immediately.
- **The gap:** The product contract required returning the provider ID and MCP URL and
  forbade persisting authorization headers, but did not prescribe the in-memory
  adapter result shape.
- **The reach:** Durable ownership persists only `providerSessionId`; the MCP
  URL and headers are derivative in-memory transport data.
- **Verdict:** sound — it extends the established proxy seam without confusing
  the transport header with durable state.
- **Confidence:** high.

### Treat each signed callback version as an exact wire shape

- **When:** Provider and callback implementation, 2026-08-01.
- **The choice:** After validating the HMAC signature, the parser accepts only
  the exact keys for version 1 of `user-connect` or `tool-router`. A descriptor
  with an extra signed field is rejected even though its signature is valid.
  The alternative was a permissive parser that ignored extra fields, allowing
  version 1 to grow silently and leaving different deploys to disagree about
  what those fields mean.
- **The gap:** The product contract mandated versioning and rejection of the legacy shape,
  but did not say whether a version tolerates additional signed fields.
- **The reach:** Any callback wire change must intentionally introduce parser
  support for a new version rather than relying on additive version-1 rollout.
- **Verdict:** sound — these descriptors can outlive a deployment, so an exact
  version contract makes rollout behavior explicit.
- **Confidence:** medium.

### Normalize public agent strings once at the durable write owner

- **When:** Policy contract and durable-authority implementation.
- **The choice:** The HTTP request carries agent IDs as ordinary strings. The
  Convex mutation—the single function that stores a policy—converts each string
  into a real agent-table ID before reading or writing anything. For example,
  `not-an-agent-id`, a deleted agent ID, and an ID from another workspace all
  reach that same check and produce the same invalid-request result. The
  alternative was to let Convex's argument validator reject malformed strings
  before the policy owner ran, which would make malformed and merely unknown
  IDs follow different HTTP error paths.
- **The gap:** The spec required all three cases to be rejected but did not say
  where malformed database IDs become a stable business error.
- **The reach:** Later runtime code can trust every stored non-root value to be
  a once-valid agent ID, while the public endpoint has one predictable `400`
  response for bad principals.
- **Verdict:** sound — one write owner establishes the durable type and keeps
  database-validator details out of the REST contract.
- **Confidence:** high.

### Report invalid principals as the existing generic invalid request

- **When:** Policy contract and durable-authority implementation.
- **The choice:** A client that submits a malformed, missing, deleted, or
  foreign-workspace agent receives `400 {"error":"invalid_request"}`. The
  alternative was to add a new public error schema and error code solely for
  this setting. The stored policy remains unchanged because Convex rolls back
  the rejected mutation.
- **The gap:** The spec fixed successful request and response shapes but did
  not assign an error vocabulary for invalid agent IDs.
- **The reach:** UI callers use the same ordinary validation failure path as
  other integration request errors; introducing a more specific user-visible
  message later would require an intentional public-contract change.
- **Verdict:** sound — it is the smallest public surface that preserves a
  deterministic client error and transactional rollback.
- **Confidence:** high.

### Keep provider connection rows narrower than joined API connections

- **When:** Policy contract and durable-authority implementation.
- **The choice:** The provider adapter returns connection lifecycle fields but
  cannot return `allowedAgentIds`; the API adds that field only after reading
  Duet's durable policy. For example, reconnecting Gmail gives the provider a
  new connection ID, then the API joins the old Gmail policy by toolkit slug.
  The alternative was to let both provider and backend-shaped objects carry an
  optional policy field and defensively decide which copy wins.
- **The gap:** Adding the optional field to the public connection schema widened
  the pre-existing provider interface unless the implementation narrowed it.
- **The reach:** Future provider adapters cannot accidentally become a second
  policy authority, and later UI/runtime work receives one joined public shape.
- **Verdict:** sound — the type boundary makes the spec's single-owner rule
  structural instead of conventional.
- **Confidence:** high.

### Do not create a separate audit-event vocabulary for policy edits

- **When:** Policy contract and durable-authority implementation.
- **The choice:** Setting or clearing agent access changes the durable policy
  row but does not emit a second audit/analytics event. Provider connect and
  disconnect lifecycle already has no backend audit row; the alternative was
  to expand the shared analytics vocabulary and provenance schema for this one
  setting before any audit consumer was named.
- **The gap:** The spec delegated event naming if an event was introduced but
  did not require an event or identify a product surface that reads it.
- **The reach:** The policy table is the only durable history-free truth. Adding
  an audit trail later remains possible, but would be a separate observability
  decision with a real consumer rather than incidental implementation machinery.
- **Verdict:** sound — it avoids an ownerless analytics surface while matching
  the adjacent provider lifecycle.
- **Confidence:** medium.

### Derive projection from provider availability at the API boundary

- **When:** Next-turn integration readiness implementation.
- **The choice:** The composition root exposes the session provider only when
  `COMPOSIO_API_KEY` is configured; routes derive backend projection from that
  one presence check. The backend remains the sole membership/hash projector,
  while the gateway receives no integration launch field when the provider is
  unavailable. The alternative was a separate enablement flag that could
  disagree with provider availability.
- **The gap:** The spec required an absent launch field without giving the
  backend access to provider configuration.
- **The reach:** Any future provider-availability source changes only the
  composition root; policy projection and hashing stay provider-agnostic.
- **Verdict:** sound — it preserves the ownership seam and the required absent
  state with no duplicated permission logic.
- **Confidence:** high.

### Hash versioned canonical JSON for the disabled-toolkit set

- **When:** Next-turn integration readiness implementation.
- **The choice:** The fingerprint hashes JSON containing the fixed version tag
  `duet-integration-permissions-v1` and the sorted, deduplicated slug array.
  The alternative was delimiter-based text, which would need an additional
  escaping contract to remain unambiguous.
- **The gap:** The spec delegated the version tag and canonical byte encoding.
- **The reach:** A future semantic change introduces a new version tag instead
  of silently reinterpreting existing durable rows.
- **Verdict:** sound — JSON gives a deterministic, inspectable encoding and the
  SHA-256 output records whether the provider Session already has the desired
  toolkit policy; it is not a public identifier or cache key.
- **Confidence:** high.

### Treat an omitted integration-ready marker as an explicit access clear

- **When:** Gateway launch persistence review.
- **The choice:** The gateway preserves unknown launch fields across version
  skew, but it deletes a previously persisted `integrations` field when the
  next accepted launch omits it. The alternative was the generic object merge,
  which retained an old marker and could resurrect integration access after
  the provider became unavailable.
- **The gap:** The existing launch merge did not distinguish a known
  fail-closed permission field from unknown additive fields.
- **The reach:** Missing readiness always means no integrations MCP server; this
  deliberately provides no compatibility fallback for older writers.
- **Verdict:** sound — it enforces the user's hard-cutover rule at the last
  durable runtime boundary.
- **Confidence:** high.

### Synchronize integrations before a scheduled wake starts a new runner

- **When:** Whole-change runtime audit, 2026-08-01.
- **The choice:** Before an overdue wake launches a fresh runner, the gateway
  asks one VM-authenticated API endpoint to project current policy and update
  the conversation's provider Session. If synchronization is unavailable, the
  wake runs with integrations omitted rather than stale readiness. The
  alternative was to reuse the sleeping envelope forever or make the gateway
  understand policy rows.
- **The gap:** User-input turns already projected current policy, but an
  autonomous wake had no input-delivery transaction and silently reused its
  prior snapshot.
- **The reach:** The backend remains the only permission and fingerprint owner;
  the gateway transports only an integrations-ready marker.
- **Verdict:** sound — one narrow refresh seam closes the runtime hole without
  duplicating policy logic.
- **Confidence:** high.

### Discard a refreshed wake runner until its launch is durably accepted

- **When:** Whole-change independent review correction, 2026-08-01.
- **The choice:** A scheduled wake may launch a runner with newly projected
  permissions and then fail while sending or recording the wake. That runner is
  killed before the retry is armed, so the retry projects again and launches
  from one coherent snapshot. The alternative was to retain the unaccepted
  runner: the next retry would see it alive, skip projection, and record the old
  persisted permissions beside a process already running the new ones.
- **The gap:** The wake-refresh contract specified fail-closed refresh behavior but
  did not state who owns a runner in the interval between process launch and
  durable wake acceptance.
- **The reach:** A retry can never make the ledger and the running MCP tool set
  disagree. Once wake acceptance succeeds, later activity-reporting failures do
  not kill that accepted runner.
- **Verdict:** sound — failed pre-acceptance work is discarded and retried from
  the current authority instead of preserving a split-brain launch.
- **Confidence:** high.

### Keep ready provider sessions TTL-free and skip a transport memo

- **When:** Durable provider-session ownership implementation.
- **The choice:** Every ready request calls `sessions.use(providerSessionId,
  {mcp:true})` for a fresh in-memory transport header. There is no process-local
  memo or clock expiry. Another transport cache would save a provider call but introduce an invalidation path
  before latency evidence justified it.
- **The gap:** The spec delegated whether a non-authoritative transport memo was
  worthwhile.
- **The reach:** Duet processes share the current provider identity while it
  remains healthy; expiring authorization material exists only for one request.
- **Verdict:** sound — one durable owner is simpler; permission changes update
  that owner without coordinated clocks.
- **Confidence:** high.

### Fail closed when an older provider update finishes late

- **When:** Final concurrency review, 2026-08-03.
- **The choice:** If an in-place update completes after the backend projection
  has already changed, its failed applied-state mark clears readiness. The next
  dispatch reapplies current policy to the same provider Session. The
  alternative was a provider-specific lease and waiter protocol.
- **The reach:** Concurrent input and wake refreshes can cause a retryable turn,
  but cannot leave durable readiness claiming a policy the provider may no
  longer hold.
- **Verdict:** sound — fail-closed compensation preserves the simple one-Session
  lifecycle without another lock owner.
- **Confidence:** high.

### Treat a lost provider Workbench as disposable internal state

- **When:** User correction during closeout, 2026-08-03.
- **The choice:** Duet reuses a healthy provider Session for conversation
  continuity, but does not make that temporary Workbench a user-owned durable
  object. If Composio reports the current Session missing, Duet creates and
  adopts a replacement with the current permissions, resets the stale MCP
  transport identity, and continues the request without a repair flow.
- **The reach:** Users and agents never choose, inspect, or restore Composio
  Sessions. Provider lifecycle loss may discard temporary Workbench context,
  but it does not become a product state or user action.
- **Verdict:** sound — this is the product boundary explicitly established by
  the user; provider machinery remains Duet's responsibility.
- **Confidence:** high.

### Return the provider identity when conversation deletion begins

- **When:** Whole-change review, 2026-08-01.
- **The choice:** The mutation that marks a conversation deleting also returns
  its one provider Session ID. The API schedules best-effort provider deletion;
  provider failure cannot change the accepted Duet deletion.
- **The gap:** Conversation cleanup removed Tool Router rows but did not retain
  the provider IDs long enough to exercise the spec's provider-side cleanup
  seam.
- **The reach:** Conversation deletion remains independent of provider
  availability without an outbox or a second lifecycle state machine.
- **Verdict:** sound — provider identity leaves durable ownership at the same
  transaction boundary as the conversation.
- **Confidence:** high.

### Bind optimistic policy mutations to their originating workspace

- **When:** Whole-change review, 2026-08-01.
- **The choice:** Each policy mutation captures its workspace slug, query key,
  and workspace-qualified pending ID when the user clicks. Every optimistic,
  success, rollback, and settled callback uses those captured values. The
  alternative was to close over the route's current workspace, allowing a
  request started in workspace A to update workspace B after navigation.
- **The gap:** Row-local serialization was pinned, but cross-workspace
  navigation while a request was pending was not.
- **The reach:** Slow policy saves can settle safely after workspace switches;
  pending and error presentation is projected only for the workspace currently
  on screen.
- **Verdict:** sound — request identity now follows the resource being mutated
  rather than whichever route happens to render later.
- **Confidence:** high.

### Restore focus to the integration disclosure after a failed save

- **When:** Inline editor and overflow implementation, 2026-08-01.
- **The choice:** A save disables the row fieldset, so the checkbox that
  initiated the request cannot reliably remain the browser's focus owner. If
  the request fails, the editor restores the exact prior policy and focuses
  that row's disclosure summary. For example, a keyboard user immediately
  lands on the same integration's persistent control beside the visible error
  instead of losing focus into the page. The alternative was to force focus
  back to a newly enabled checkbox after rollback.
- **The gap:** The product contract required a sensible focus target but did not choose one
  for a control that becomes disabled during the request.
- **The reach:** Failure recovery is stable for normal and scrolled 501-agent
  lists, while a later retry remains one disclosure-and-checkbox navigation
  away.
- **Verdict:** sound — the summary survives pending and rollback transitions
  and identifies the exact row whose save failed.
- **Confidence:** high.

### Keep staging diagnostics separate from the public MCP resource

- **When:** Focused staging-journey implementation, 2026-08-01.
- **The choice:** The journey attaches its MCP client through the public
  workspace/session resource. An internal-key-protected query observes the
  provider Session ID only for direct provider assertions and cleanup.
- **The gap:** The spec required direct MCP/provider responses as the oracle,
  while the production API deliberately keeps its config identity internal.
- **The reach:** Staging can prove exact toolkit and Workbench behavior without
  exposing storage identities in the customer API.
- **Verdict:** sound — the internal read is diagnostic, not the behavioral
  transport, and remains protected by the staging internal key.
- **Confidence:** medium.

### Make focused provider credentials mandatory and ledger every remote session

- **When:** Focused staging-journey implementation, 2026-08-01.
- **The choice:** An explicit `integration-agent-access` run fails before it
  provisions a workspace when either real Composio or Firecrawl credential is
  unavailable. Once running, it records each Firecrawl account and each Tool
  Router session in the shared cleanup ledger. A failed provider deletion is
  reported as an orphan while the ledger continues deleting the Duet sessions,
  workspace, and VM. The alternative was a green skip or cleanup that knew only
  about the connected account and leaked the workbench sessions minted by the
  access matrix.
- **The gap:** The acceptance contract delegated provider selection and required partial
  failure cleanup, but did not choose focused-run behavior for missing secrets
  or explicitly assign Tool Router deletion ownership.
- **The reach:** The terminal gate cannot claim live provider coverage when it
  never had provider credentials, and repeated acceptance runs do not silently
  accumulate remote workbenches.
- **Verdict:** sound — explicit acceptance must either prove its contract or
  fail with the missing prerequisite, and cleanup covers every remote identity
  the journey creates.
- **Confidence:** high.

### Reopen the live editor after each server-confirmed policy save

- **When:** Focused live staging closeout, 2026-08-02.
- **The choice:** The live browser journey opens the connected integration's
  agent-access disclosure before each edit and opens it again after the policy
  response succeeds. In staging, the settled query response can replace the
  native `<details>` node: the policy is saved correctly, but the replacement
  starts closed and its checkboxes are hidden. Reopening the same row lets the
  journey inspect the settled UI state. The alternative was to treat the hidden
  checkbox as a failed save or bypass the editor with a direct API mutation.
- **The gap:** The product contract required real inline-editor mutations and settled-state
  assertions but did not specify how the browser harness should handle native
  disclosure state across a server-driven row replacement.
- **The reach:** The staging oracle continues to exercise the shipped UI even
  when a successful save recreates its disclosure. It does not require the
  product to preserve browser-owned open state, and it does not weaken the
  response or checkbox assertions.
- **Verdict:** sound — the journey restores only presentation state and still
  proves the mutation and canonical UI result through public browser seams.
- **Confidence:** high.

## Unsound

### Permission-fingerprint history and arbitrary row caps

Keeping one provider Session per permission fingerprint created historical
Workbench configurations the product did not need, then required arbitrary
limits to bound that history. The provider supports updating toolkit
permissions on the same Session, so the owner is now one row per Duet session
with no policy-count or permission-history cap.

### Lazy provider creation inside MCP forwarding

Creating the initial provider Session from ordinary MCP requests manufactured a
concurrent creation problem. The claim lease, polling loop, and remint budget all
compensated for that misplaced lifecycle. Initial creation now completes during
Duet-session readiness. This does not apply when a ready Session later vanishes:
that provider failure is repaired invisibly at the MCP boundary.

## Needs user

None found in these passes.
