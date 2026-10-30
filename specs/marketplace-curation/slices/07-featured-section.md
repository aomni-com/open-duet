# 07 — Featured section (visual slice: grid composition)

**Slice variable:** grid composition — sectioning, order, headings. Card
internals were judged in 06.

**Contract unlocked:** featured listings render once, in a "Featured"
section above the verified/community sections, same cards (placement, not
chrome).

## API seam

- `tag-filter.ts` (the single filter/order owner) gains the partition:
  `partitionCatalog(listings, selection) → { featured, verified, community }`
  — tag filter applies to all three arms, `orderListings` orders each,
  featured rows are excluded from the lower arms.
- `marketplace.tsx` renders three sections through the partition and
  **deletes its two existing inline `.filter()` calls** (they move into the
  owner — leave-code-better; this removes today's second owner rather than
  adding a third).
- Featured heading renders only when the arm is non-empty — with nothing
  featured the surface stays byte-identical to today's launch state.
- i18n: `sectionFeatured` under `duetApp.marketplace`, en + es-419.

## Human-visible

Feature a listing from the slice-05 panel, reload the marketplace, see the
Featured section lead with the same card; unfeature, watch the grid return to
the pre-feature layout. Playground fixture: mixed featured/verified/community.

## Verification

- `tag-filter.test.ts`: partition disjointness, ordering, tag narrowing all
  arms, empty-featured ⇒ absent section.
- `marketplace.test.tsx` document-order assertions extended: featured →
  verified → community; no listing rendered twice.
- i18n parity; ui-playground baseline with and without a featured row.
- **compare-screenshots** against the no-featured grid (the byte-identical
  property) and the mock's featured row; **screenshot-critique** unprimed as
  the last check.

## Explicitly out of scope

Card internals (06); any featured badge/chrome on the card itself — the mock
approved plain placement.

## Delegated to implementer

Section spacing, whether featured uses the same column sizing (mock says
yes — same cards, same grid).

## Must stay green

Tag-rail behavior; the verified/community split semantics; onboarding rail.

## Feedback that would change this slice

Capping the rail (see slice 03 feedback) or a "Featured" chip on cards —
Example User's earlier mock pass kept a small chip in card meta; treat the chip as a
delegated cosmetic: include it if it reads well in shots, record the call.
