# Future data source intake: ScrapeCreators

Status: **placeholder only**. No ScrapeCreators proxy route, catalog entry,
vault credential, or service availability claim is enabled by this document.

This is the intake note for a possible future data source in the service proxy.
It preserves the research and the admission gate so a later implementation
pass does not turn a vendor link into an unreviewed shared-account route.

## Candidate source

- Product site: <https://scrapecreators.com/>
- API base: <https://api.scrapecreators.com>
- API documentation: <https://docs.scrapecreators.com/>
- OpenAPI description: <https://docs.scrapecreators.com/openapi.json>
- Agent-readable summary: <https://docs.scrapecreators.com/llms.txt>
- Full agent-readable docs: <https://docs.scrapecreators.com/llms-full.txt>

## Known facts

- The API authenticates with an `x-api-key` header.
- The published API covers public-data lookups and search across platforms
  including TikTok, Instagram, YouTube, Facebook, X, LinkedIn, and Reddit.
- The OpenAPI description contains more than 100 paths across more than 27
  platforms.
- The docs say there is no enforced rate limit and recommend staying below 500
  concurrent requests. A future catalog entry must still declare and monitor
  any shared quota that the vendor bills or operationally enforces.
- A first admission candidate is stateless public-data lookup/search work,
  classified as `generate` under the service-catalog admission rules.

## Explicit exclusions for the first pass

Do not proxy account, billing, credential, webhook, private saved-project, or
other user-content surfaces. Listing or reading private vendor-owned content
must remain outside the shared Duet account boundary unless a future route has
an unguessable caller-owned id and is admitted as `ownedById`.

## Unknowns to resolve before implementation

1. Measure the vendor billing unit, response cost signal, and failure/refund
   behavior. The current docs do not establish a cost model that can be put in
   the catalog safely.
2. Choose a small explicit route allowlist from the OpenAPI document. Do not
   import the whole document or expose paths by prefix.
3. Capture scrubbed request/response fixtures, including pagination, empty
   results, vendor errors, and any response field used for pricing.
4. Obtain a staging key and confirm its scope, quota, and rotation owner in the
   service vault. Vendor keys must never appear in fixtures, logs, discovery,
   or hooks.
5. Implement and run the catalog validator and `service:probe` checks against
   the chosen routes, including the vendor ledger comparison.

## Production-entry acceptance gate

Create a real catalog entry only after all of the following are reviewable:

- measured vendor cost and one catalog price rule per admitted route;
- an explicit route allowlist with an admission kind on every route;
- scrubbed fixtures and deterministic replay tests;
- passing `validateCatalog` and `service:probe` evidence;
- a seeded vault credential with a documented staging/production owner;
- service discovery metadata linking the docs and `llms.txt` resources;
- a staging call proving an admitted route works, an unlisted route returns the
  catalog's bodyless 404, and the charge ledger records the vendor cost plus
  the standard margin;
- a focused review of the route boundary and exclusion list.

Until that gate is complete, this file is a research placeholder and is not a
promise that ScrapeCreators is available through Duet.
