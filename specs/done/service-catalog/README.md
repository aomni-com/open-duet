# Service catalog

The service catalog is Duet’s closed, reviewed gateway for vendor APIs. It gives agents a discover → read docs → call workflow while keeping one vendor account behind an allowlist, one billing rule, and one ownership model for shared resources.

## Why this shape

The upstream vendors have incompatible authentication, request bodies, response formats, and billing signals. A generic forwarding proxy would either expose account-level routes or duplicate billing and ownership logic in every provider adapter. The catalog therefore owns route admission, provider request/response hooks, pricing rules, fixtures, and probes in pure TypeScript; the API owns HTTP adaptation; Convex owns vault credentials, workspace ownership, expiry, and ledger persistence.

The allowlist is deliberate. An unlisted route returns a bodyless 404 before credentials or billing are touched. Routes are admitted only for stateless generation, public reads, caller-owned opaque ids, or explicitly shared non-sensitive pools. Shared resources are readable and usable by every workspace, while mutation and deletion require the recorded creator; tracked resources expire through the provider’s real deletion path.

Billing remains one system: vendor units are rounded into micro-dollars, the 20% margin is applied once, and settlement records a signed negative usage debit. The API’s `x-duet-charge-usd` response header lets the CLI report the amount without teaching agents vendor-specific pricing.

## Invariants

- Service definitions, route matching, pricing, validation, fixtures, and probes have one owner in [`packages/service-catalog`](../../../packages/service-catalog/README.md).
- The API strips `x-duet-workspace` before forwarding and resolves the workspace from authenticated membership.
- Discovery exposes metadata, documentation links, billing mode, and route shapes; it never exposes vendor credentials or prices.
- The external skill teaches the method and includes a concrete ElevenLabs voiceover example. Internal skills are checked so every documented proxy path matches an admitted route.
- Probe evidence must include safe request inputs and, where a vendor exposes it, a usage-ledger comparison.
- ScrapeCreators remains a research placeholder in [`future-data-sources.md`](future-data-sources.md); no route or availability promise exists until its production-entry gate is met.

## Code pointers

- Catalog definitions and validator: `packages/service-catalog/src/index.ts` and `vendors.ts`.
- Proxy adapter and discovery: `apps/api/src/routes/services/`.
- Vault, shared-pool ownership, and expiry: `packages/backend/convex/domains/serviceVault/`.
- CLI commands: `packages/duet/src/commands/services.ts`.
- Skill route cross-check: `packages/service-catalog/src/index.test.ts`.
- Paid staging journey and cleanup ledger: `packages/test-harness/src/service-catalog-staging.ts`.
- Acceptance transcript: [`acceptance-transcript.md`](acceptance-transcript.md).

## Evidence and dead ends

The deployed staging journey passed discovery, paid ElevenLabs TTS and music, Firecrawl crawl completion, an unlisted-route 404, shared-pool ownership refusal, real voice expiry, signed ledger parity, and cleanup with no orphans. A fresh Claude Code run with only the external skill and staging login found ElevenLabs through `duet services`, called TTS, wrote a valid MP3, and reported the billed amount.

The first acceptance run used local macOS speech because the generic service instructions did not make the audio workflow concrete. The external skill now names the catalog search, service detail, TTS route, output flag, and verification step.

The vendor factory remains a separate concern: it may author future definitions, but it does not own runtime admission or billing.

## Final choices

The implementation choices are preserved in [`choices.md`](choices.md), including the lower-confidence provider probe and staging-harness decisions.
