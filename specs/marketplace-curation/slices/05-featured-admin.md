# 05 — Featured admin rail: enumeration + toggle + Listings panel

**Contract unlocked:** an operator can discover any listing and flip its
featured state from internal-admin, audited; the marketplace reflects it.

## API seam

- Convex `domains/internalAdmin`: `listMarketplaceListings` (id, title via
  `resolveListingMetadata`, publisher slug, agent name, state, featured,
  installs; simple pagination) + `setListingFeatured({ listingId, featured, reason })`
  writing `featuredAt = Date.now() | undefined`, audit event
  `admin.marketplace.featured.set`. Row-write only — the `accessArgs` +
  `convexJson` + audit pattern, NOT the authorizeEffect VM rail.
- api: `GET /v1/internal-admin/listings`,
  `POST /v1/internal-admin/listings/:listingId/featured`. Contract schemas
  `InternalAdminListingListSchema`, `InternalAdminListingFeatureRequestSchema`.
- SPA: a "Listings" `Panel` in `internal-admin.tsx` beside the takedown panel
  (which stays a separate destructive control): table of listings with state
  + featured badges, feature/unfeature button per row (disabled only while
  its own mutation is pending), success feedback. New client methods +
  `duetQueryOptions.admin.listings` + `InternalAdminApi` pick. i18n keys
  under `duetAdmin` in **en and es-419**.

## Human-visible

Open internal-admin: find a listing, feature it, watch the badge flip and the
audit row land; open the marketplace and see it in the Featured section
(after slice 07; before that, `featured: true` in catalog JSON).

## Verification

- api route tests: 403 non-admin; toggle round-trip; audit row asserted.
- Convex fixture: toggle on a taken-down listing → still absent from catalog.
- `message-leaf-key-parity.test.ts` green.
- Visual: coverage-ledger entries for new exports; admin panel baseline via
  ui-playground; unprimed **screenshot-critique** on the accepted panel shot.

## Delegated to implementer

Table columns beyond the contract list, pagination UX, `reason` optionality.

## Must stay green

Existing takedown flow and its confirmation phrase; the admin search panel.

## Feedback that would change this slice

Whether featuring should require a reason string (currently optional).
