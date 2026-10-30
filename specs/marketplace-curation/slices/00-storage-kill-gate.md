# 00 — Storage rail kill gate

**Contract unlocked:** proof (or disproof) of the load-bearing assumption
under every image slice: base64 bytes → Convex action `ctx.storage.store` →
ref stamped on a listing row → `ctx.storage.getUrl` **inside the
catalog/detail QueryCtx** → the URL renders in the marketplace SPA (CSP /
remote-host policy included). If any link fails, the recorded fallback is
applied BEFORE any other slice starts.

## API seam

Skeleton of the final seam, not throwaway code:
- `packages/backend/convex/domains/marketplace/assets.ts` — action
  `storeListingAssets({ internalKey, listingId, header?, icon? })` where each
  asset is `{ base64, mimeType } | null | undefined` (tri-state: replace /
  clear / untouched). Stores via `ctx.storage.store(new Blob(...))`
  (`agentSessions/images.ts` precedent), then `runMutation` an internal
  `stampListingAssets` that swaps refs `{ storageId, sha256, mimeType }` on
  the row and returns displaced storageIds; the action deletes them.
- Probe `ctx.storage.getUrl(storageId)` inside a query on a real local Convex
  deployment (the convex test-fixture rail) and fetch the URL
  **unauthenticated** → 200 + byte-identical content.
- Browser probe: render one such URL in the marketplace route against the dev
  stack (or staging Convex) and confirm the `<img>` paints — this is the CSP
  check; inline-media may have proxied instead of hot-linking, so do not
  assume.

## Human-visible

A convex fixture test printing a live storage URL that curls 200, and one
screenshot of the URL rendering inside the marketplace page.

## Verification

One convex fixture test file (run alone — 60s+ budget floor per the fixture
architecture): store → stamp → getUrl 200 → re-stamp with new bytes deletes
the orphan → `null` clears → `undefined` leaves the prior blob live.

## Kill condition + fallbacks (record the outcome in this file)

- `getUrl` unusable in QueryCtx → stamp the URL string at store time (actions
  can getUrl).
- Storage host blocked by SPA CSP/policy → thin api proxy route
  `/v1/marketplace/assets/:listingId/:kind` streaming from storage.
Either fallback is contained to this seam; neither changes producers or UI
contracts. Write the winner here before proceeding.

## Delegated to implementer

Internal naming, test file layout, whether the browser probe is manual (a
recorded note + screenshot suffices) or scripted.

## Must stay green

Existing backend package tests; no schema fields beyond the `media`/assets
skeleton this slice needs (the full lockstep is slice 02).

## Feedback that would change this slice

If Example User prefers the api-proxy shape a priori (e.g. to keep storage hosts out
of the page entirely), slices 03/06 consume the proxy URL instead — same
contracts.
