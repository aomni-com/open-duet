# 03 — Wire projection: catalog union, featured flag, image URLs, detail description

**Contract unlocked:** the SPA can render everything from the wire alone —
server-projected URLs, a featured boolean, and the long description on
detail. No client ever constructs an asset URL.

## API seam

`packages/backend/convex/domains/marketplace/listings.ts`:
- `listedCatalogImpl` becomes the **union owner**: top-100-by-installs ∪
  every row from `by_state_and_featured` with `state === 'listed'` and
  `featuredAt` set — deduped by `_id`. Both arms re-assert `listed`
  (takedown keeps `featuredAt`; a featured listing at install-rank 101 must
  still surface).
- `catalog` projection += `featured: boolean`, `headerImageUrl?`, `iconUrl?`
  via `ctx.storage.getUrl` (or the slice-00 fallback shape). O(≤100+featured)
  getUrl calls per read is accepted — do NOT "optimize" into a stamped-URL
  second owner without slice-00 evidence forcing it.
- `detail` projection += `description` (from `derived.description`) and the
  same URL fields. **Description never enters the catalog projection**
  (ledger #14 — the `changelog` asymmetry precedent).

`packages/contract/src/marketplace/index.ts`:
- `MarketplaceListingSummarySchema` += `featured: z.boolean().optional().default(false)`,
  `headerImageUrl: z.string().optional()`, `iconUrl: z.string().optional()`
  — tolerant-on-read (the `tags` precedent; web and api deploy separately).
- `MarketplaceListingDetailSchema` += `description: z.string().optional().default('')`.

## Human-visible

curl the local api: `/v1/marketplace` shows `featured` + URL fields and
provably lacks `description`; `/v1/marketplace/:pub/:agent` carries it.

## Verification

- Convex fixture tests: featured+unlisted row never surfaces; featured row
  outside the top-100 window surfaces exactly once (dedup); URLs resolve for
  rows with refs, absent otherwise.
- Contract tests: parse a summary/detail WITHOUT the new fields (the two
  existing tolerance tests are the template — copy their structure).
- api route tests re-snapshot the response shapes.

## Delegated to implementer

Union implementation details (two indexed reads + merge vs. filter), naming.

## Must stay green

Existing catalog/detail projection tests; the O(listings) document-read
comment in `listings.ts` (the workspace get per listing) — do not add reads
per listing beyond the publish/URL needs this slice states.

## Feedback that would change this slice

If the featured set should also be size-capped (e.g. max 6 in the rail) —
currently uncapped server-side; the UI renders what it gets.
