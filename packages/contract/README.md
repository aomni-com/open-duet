# @repo/contract

`@repo/contract` is the shared language between Duet apps, the Convex backend,
the in-VM gateway, hosted MCP, and clients. It holds schemas, normalized path and
scope grammar, capability names, redaction rules, and small protocol helpers that
must mean the same thing on both sides of a boundary.

## Boundary

Put a fact here only when two independently deployed or independently tested
pieces need to agree on it. Product behavior that has one runtime owner should
stay with that owner and export a narrow shape here only when another package must
validate or produce it.

Path safety, scope parsing, and token/header grammar are examples of contract
facts: copying them into apps creates subtle authorization and traversal bugs.

Drive paths have two explicit dialects. Logical paths from schemas, storage,
filesystem listings, and decoded request values treat percent signs as ordinary
filename bytes. Only raw URL suffixes use the URL-path normalizer, which decodes
each segment exactly once before applying the same traversal and reserved-path
rules. Keeping that transport decode at the HTTP boundary prevents both filename
aliasing and recursive-decoding traversal bugs.

Schemas here are also the source of truth for the developer docs in
[`apps/docs`](../../apps/docs/README.md): its endpoint reference renders
methods, paths, scopes, and wire shapes straight from this package. When a
change here alters the public API surface, update the docs prose and examples
in the same change.

Complete VM replacement is capped at 500 active/broken anchors, 100 apps, and
50 total active incoming/outgoing shares per workspace. Publish snapshot
components and pause generations are capped at 512
UTF-8 bytes, and OAuth authorization state at 4 KiB, at both request and response
schemas so downstream storage never has a wider shape than the public wire.
VM provider/version metadata is likewise byte-bounded before workspace storage;
the API composes independently bounded core and share projections into the
single existing VM response. Every variable-width field added by that API
composition—including public app and artifact URLs, credentials, skills, and
report acknowledgements—has a structural byte or item ceiling in the response
schema.

Model selections keep a stable identity across provider upgrades. The model-tier
boundary owns both the ranked router ladder and the wider selection vocabulary;
only routers participate in subscription-default promotion. Provider aliases name
the current execution target separately from historical billing coverage, so a
delayed generation keeps its fixed price after a target upgrade. Retired selections
remain valid only as recorded billing attribution, with their final tariff retained
for delayed settlement; new session selections and gateway claims reject them.

Customer tariffs express the value of the outcome, not the provider's token
price. Upgrading a model never reprices the customer's tier: lower upstream
cost improves margin, and a higher-cost model can still be the right choice
for the job. Execution targets and billing coverage change independently of
the tariff. Support and media calls retain their separate at-cost policy.

## Pointers

- `src/index.ts` is the public barrel; imports from this package should go
  through it unless a test is exercising an internal module directly.
- `src/pagination` owns the base query and page envelope shared by every
  browsable public collection. The endpoint registry marks which routes are
  collections; resource modules extend the base query with their filters and
  declare their source ordering and cursor positions. The same module binds opaque
  cursors to their authenticated subject, filters, order, and declared domain,
  and exposes the lazy page iterator clients use instead of rebuilding eager
  arrays.
- `src/http` owns shared HTTP wire facts, including the authenticated API
  ceiling and its typed refusal; runtime consumption remains in the backend.
- `src/address`, `src/drive`, `src/scopes`, and `src/slug` own shared identity
  and path grammar.
- `src/entry-code` owns the one grammar and generator for a code a human reads
  off a screen or an email and types back — device pairing and email sign-in
  both. Its alphabet excludes the characters that look alike, and its regex is
  deliberately wider than that alphabet so a human who types `O` for a character
  that cannot be `0` is not told their code is malformed. It is *not* the
  magic-link intent nonce: those were one constant until the code became
  human-typed, at which point a single pattern rejected every browser sign-in.
- `src/desktop` owns the fixed display, browser artifact, and grant vocabulary
  shared by the VM image, gateway, API, and web app. Runtime lifecycle policy
  stays in the gateway rather than becoming a cross-service contract.
- `src/edge`, `src/gateway`, and `src/mcp` own cross-service protocol shapes.
  For publishes, `src/edge` owns the public grammar: the request-mode selector
  (`classifyPublishRequest` — viewer/raw/list, both selectors → invalid) and
  the validated viewer descriptor + its internal header, while `src/files`
  owns the shared drive-entry predicates (`isHiddenDriveEntry`/
  `filterDriveEntries`, `isTextLikeDriveFile`) that the gateway and web
  viewers consume instead of re-deriving extension or dot-prefix logic.
- `src/oauth` owns the authorization-server, protected-resource, public-client,
  token exchange, and browser-consent wire grammar. Runtime OAuth policy stays
  with the API and backend owners; independently deployed consumers share only
  these validated shapes. Audience, refresh-family, and client-metadata security
  policy has one canonical home in
  [`SECURITY.md`](../../SECURITY.md#oauth-credentials-resource-bound-expiring-grant-families).
- `src/approved-models` holds the gateway's policy for known concrete model ids
  (`isFree`/`internal`/`providerLock`, media pricing) — a chat model it does not
  list still runs under a tier claim — while retaining stable roles only for
  media and internal agent paths. Chat
  presentation and pricing belong to `src/model-tiers`; media role resolution
  stays here for MCP and installed skills. Distinct from `src/model-catalog` (a
  Vercel id→media-type parser — different concept).
- `src/model-tiers` owns the virtual-tier vocabulary, presentation metadata,
  billing rates, the closures those rates cover, shared provider-alias routing composition,
  stored-tier coercion, and pure
  pricing math that independently deployed consumers must apply identically —
  including the typical turn every "about N messages" estimate divides a
  balance by, so the app and the public pricing page cannot quote different
  numbers.
- `src/skills` owns both the validated default-skills bundle manifest and the
  workspace skill-listing vocabulary. The CLI/gateway listing is a bounded
  internal discovery result; the independently browsable public picker is a
  strict collection page with opaque continuation.
- `src/agent` owns the runner turn vocabulary — events, commands, terminal
  codes, turn state — and the one slice of that state allowed off the VM
  (`relayedTurnState`): the control plane projects a few fields and stores
  none, so everything else is weight that can only break the relay.
- `src/agents` owns both the bounded VM roster transport and its public
  reachable-agent page. The gateway remains the sole hierarchy and lock-verdict
  owner; the public API only pages that ordered projection.
- `src/analytics` owns the canonical event vocabulary, finite JSON boundary,
  and the narrow product-browser request shape shared with the API.
- `src/train` owns the upload, start, and job-report vocabulary shared across the train rail.
  Its persisted diagnostics, record summaries, and report batches are byte-bounded contract
  values; redaction is presentation policy and is never treated as a work bound.
- `src/marketplace` owns the listing, subscription, desired-state, report, and
  typed-error vocabulary, plus the ONE source-URL constructor
  (`deriveListingSourceUrl`) and the schema every consumer re-validates a
  received URL through (`ListingSourceUrlSchema`). Install identifies a
  **listing**, never a bare agent name: two publishers may ship the same name.
  Catalog copy, declarations, and pull diagnostics are storage-shaped here so a
  maximum public page is bounded before any row is written.
- `src/onboarding` owns the workspace-onboarding recommendation wire shapes.
  The response is **exactly four picks or none** — a partial list is not
  transportable, so every degradation (LLM failure, fabricated agent names,
  an older API) reaches the client as the same empty shape. The purpose it
  carries is `WorkspacePurposeSchema` from `src/workspaces`, not a second
  definition.
- `src/sessions` owns the session wire shapes and, more importantly, the
  derivations a session row *materializes*. A column Convex cannot index a
  computation into — the activity bucket (`bucketOf`), the last message said in
  a conversation — is decided here once. The backend stamps that preview on
  write, while the browser applies the same materialization rule to a locally
  committed input before the event exists; a second implementation would make
  optimistic and durable rows disagree about their own caption. The event rule
  is exhaustive, so a new event type cannot land without deciding whether it is
  something a person can read as a message.
  An unfinished machine is not itself evidence of activity after a turn is
  interrupted: the session becomes inactive while its resumable machine history
  remains intact. A completed state within an ongoing relay is different and
  still belongs to that relay’s active lifecycle. This module also owns the
  session-principal shape: authorization identity and actor attribution travel
  together but remain distinct facts.
- `src/redaction` owns secret masking rules used before logs or imported memory
  leave their local context.
