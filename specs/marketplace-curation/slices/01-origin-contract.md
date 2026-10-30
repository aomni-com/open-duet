# 01 — Origin contract: snapshot, bounds, both producers

**Contract unlocked:** one producer-neutral origin snapshot carries the
long-form description and bounded header/icon bytes; both producers emit the
identical shape; the derive owns the fallback.

## API seam

`packages/contract/src/marketplace/index.ts`:
- `ListingOriginSnapshot` += `descriptionMd: string | null`,
  `headerImage: ListingMediaBlob | null`, `iconImage: ListingMediaBlob | null`
  (`ListingMediaBlob = { mimeType, base64 }`).
- `ListingOriginSnapshotWireSchema` += the same fields, **optional forever**
  (`agentJson` precedent — VM gateways lag indefinitely; absent ≠ null:
  absent means "producer too old to know", which downstream treats as
  leave-untouched for media and fallback for description).
- Exported bounds: `MAX_LISTING_DESCRIPTION_BYTES = 64 * 1024`,
  `MAX_LISTING_IMAGE_BYTES = 512 * 1024`.
- `LISTING_HEADER_CANDIDATES = ['header.png', 'header.jpg', 'header.webp']`
  — the ONE owner of authored precedence (exact case), imported by both
  producers. MIME-by-extension map beside it.
- Inspection refusal union += `listing_description_too_large`,
  `listing_image_too_large`.
- `deriveListingMetadata` → `ListingDerivedMetadata.description: string` =
  `descriptionMd ?? agentsMd`, **clamped to 64KiB either way** (the fallback
  clamp — an unclamped AGENTS.md fallback can blow the Convex row).
- Inspect **request** += optional `iconPath` (safe relative path) — icon
  identity is a Convex-row fact the inspector cannot discover.

`packages/gateway/src/marketplace/inspector.ts`: read `DESCRIPTION.md`
(exact-case `find`), the first header candidate present, and the requested
`iconPath` off the existing `collectPublishSubtree` walk — `entry.size`
checked against the bounds BEFORE any read (typed refusal, no transfer).
Binary reads never touch `TextDecoder`.

`packages/official-agents-seed/src/index.ts` `officialListingOrigins`:
`descriptionMd` via text read; header/icon by **key presence** using the same
imported candidates; manifest `icon` supplies iconPath.

## Human-visible

Contract + gateway + seed test output; a gateway route test moving a
max-size (512KiB) image through the real inspect route — the wire-size
boundary proof.

## Verification

- Contract: wire round-trip with fields absent parses; derive fallback with
  and without `descriptionMd`; clamp behavior; precedence order.
- `inspector.test.ts` exact-`toEqual` updated; refusal cases (oversize
  description / image); precedence case (png beats webp when both exist);
  missing/invalid iconPath → `iconImage: null`, never an error.
- **Twin-producer parity test** (in seed package): the same fixture agent
  folder pushed through the inspector and through `officialListingOrigins`
  yields identical snapshots. This test makes producer drift impossible.

## Delegated to implementer

Exact zod naming, where the MIME map lives inside contract, fixture folder
layout.

## Must stay green

`MarketplaceInspectionResponseSchema` envelope tests (old-gateway tolerance
case added beside them); seed bundle-budget assertions; existing derive tests.

## Feedback that would change this slice

Raising the image cap (designer art may want >512KiB) — a constant change,
but re-run the slice-01 boundary test at the new cap.
