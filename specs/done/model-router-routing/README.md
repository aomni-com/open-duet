# Duet model router

The gateway can send eligible tier-attributed language-model generations to an
operator-configured upstream while keeping the normal Vercel path available for
fallback. The feature exists to use capacity and credits at other providers
without changing the contract a Duet user sees: the same workspace audit event,
`usage` ledger transaction, tier pricing, and response shape remain in place.

The first adapter covers the OpenAI chat-completions and Responses paths and the
Anthropic messages path. The policy is a global ordered rule list stored in
Convex and edited from internal admin. A rule matches an anchored model glob,
provides an endpoint base URL, and supplies the exact saved headers used for that
attempt. There is no route for model discovery, embeddings, or media.

## Why the boundary is shaped this way

The existing gateway already decides whether a request is allowed to spend and
whether a tier has a flat rate for an exact model. Routing must happen after that
billing decision: a broad rule such as `openai/*` can choose an endpoint only
when `tierBillsAtFlatRate(tier, model)` has already accepted the request. Calls
without a tier, calls outside the tier closure, and unsupported operations stay
on the ordinary Vercel path.

Vercel remains the safe fallback because configured endpoints are an optimization
that may be unavailable or refuse a request. A failure before configured bytes
begin retries the same generation through Vercel. Once bytes begin, the gateway
preserves them; missing native usage releases the generation with
`missing_usage_telemetry` rather than duplicating the generation or charging an
estimate.

Configured providers report their own usage instead of Vercel generation cost.
The gateway normalizes the provider's native JSON/SSE counts and settles directly
using the existing tier price. Provider response IDs are retained as the
idempotent upstream reference and ledger metadata. Internal margin reports keep
the canonical model provider and add a separate `vercel` or
`configured_upstream` route source; the operator calculation compares total
billing against recorded Vercel AI Gateway costs, counting unknown upstream costs
as zero.

The policy is intentionally a hard cutover with an absent-row-as-empty default.
A policy read or malformed policy cannot take down the primary gateway. Route
headers are the explicit operator credential boundary: caller authentication,
Duet attribution, workspace, and hop-by-hop transport headers never cross into a
configured request.

## Invariants

- Only `POST /v1/chat/completions`, `POST /v1/responses`, and `POST /v1/messages`
  are eligible, with OpenAI and Anthropic family/path agreement.
- Raw tier presence and the exact flat-rate closure check precede family, method,
  path, and ordered glob matching.
- Rules are first-match-wins and disabled rules never match.
- Configured attempts forward only the saved route headers and preserve the
  original supported path and query.
- A configured failure before response bytes falls back to Vercel; a started
  response is never retried.
- Native provider usage must be complete, finite, and nonnegative. OpenAI cached
  input and Anthropic cache read/write counts are normalized into the shared
  billing shape.
- Routed settlement uses the normal `usage` ledger type and workspace audit
  contract. Route source and configured endpoint details are internal margin
  dimensions only.
- Existing margin rows without a route source are promoted/read as `vercel`, so
  historical data remains visible while new rows separate route sources.
- Adding a provider requires an adapter behind the gateway seam; it must not add
  a new user-facing route or billing category.

## Code pointers

- `packages/contract/src/model-gateway-routing/` owns policy, rule, header, path,
  and admin request schemas plus cross-field validation.
- `packages/backend/convex/domains/internalAdmin/model.ts` owns the audited
  singleton policy read/write; `packages/backend/convex/schema.ts` owns its row
  and the route-source margin dimension.
- `apps/api/src/routes/internal-admin.ts` exposes the authenticated internal-admin
  policy endpoint.
- `apps/model-gateway/src/model-router-gateway.ts` owns policy loading, the
  eligibility order, glob selection, header isolation, and OpenAI stream usage
  request shaping.
- `apps/model-gateway/src/model-router-usage.ts` owns OpenAI, Responses, and
  Anthropic JSON/SSE usage normalization; `apps/model-gateway/src/index.ts` owns
  the attempt/fallback lifecycle and direct settlement handoff.
- `packages/backend/convex/domains/modelGateway/settlement.ts` owns routed flat
  pricing and the existing ledger/audit lifecycle; `marginRollup.ts` owns the
  internal route-source split.
- `apps/web/spa/routes/internal-admin.tsx` owns the operator editor; its API
  client, fixtures, and message catalogs are adjacent in `apps/web/`.
- Focused behavior is pinned by the model-gateway router/usage/integration tests,
  routed settlement and margin tests, internal-admin tests, and the visual
  playground baselines.

## Dead ends and evidence

A generic provider SDK, tokenizer, or media-routing abstraction was deliberately
left out. The supported endpoint was probed live through the existing Funnel on
2026-10-07 using the existing local Claude/Codex setup; all three JSON and stream
paths returned native usage, so estimation was unnecessary. No local endpoint,
Claude, Codex, or Tailscale configuration was changed.

The first implementation contained an unused second router seam. It was removed
so the contract package and `model-router-gateway.ts` remain the single owners of
policy validation and matching. A later review also established protocol-aware
nested stream IDs, standard hop-by-hop header rejection, negative derived-count
rejection, and route-source-aware margin folding; those corrections are now part
of the invariants above.

## Visual provenance

The internal-admin screen had no product reference image; the requirement was to
add a readable Model router navigation item and editor while preserving the
existing admin surface. The approved candidate and historical comparison
baselines are the desktop and mobile `internal-admin*.png` files under
`apps/web/tests/visual/__screenshots__/`. The visual gate regenerated the affected
admin baselines and passed the full internal-admin desktop/mobile set. A fresh
screenshot critique found no clipping or blocking defect; its unrelated responsive
polish observations remain outside this feature.
