# 06 — Cover cards + real avatars (visual slice: the card)

**Slice variable:** the card. Featured sectioning (07) and description
bodies (08) are out of scope — judge only card geometry, art, fallback, and
avatar.

**Contract unlocked:** every non-compact marketplace card is a cover card —
2:1 art band on top (server-projected URL), identity + summary below —
matching the approved mock; imageless/failed cards ride a shipped-looking
seeded gradient; cards and detail show real icons.

## API seam

- NEW `apps/web/spa/marketplace/card-art.tsx` —
  `MarketplaceCardArt({ seed, headerImageUrl? })`: plain `<img>` (never
  `next/image` — remotePatterns) with the `FileIconImage` failed-URL-state
  pattern (keyed on the URL, not a boolean); fallback = deterministic seeded
  gradient band + large initial. The gradient lives here and ONLY here.
- `gallery-card.tsx` restructured: root keeps `overflow-hidden rounded-2xl`;
  `p-5` moves to an inner body wrapper so the art band is full-bleed. The
  hover ring, stretched-link pseudo-element (nested-interactive design
  preserved), consent-selection layout, and `min-h` contract are re-derived
  in the same commit. `compact` NEVER renders art.
- `loading.tsx` `CatalogCardSkeleton` mirrors the new geometry in the same
  commit (it is a hand-maintained mirror — the slice boundary is the
  firewall).
- `AgentAvatar` gains an explicit-`src` mode (foreign storage URL, plain img,
  DiceBear on error/absence — the single fallback); `MarketplaceAgentMark` +
  detail header pass `iconUrl`. The workspace-scoped drive-icon path is never
  used on marketplace surfaces (cross-workspace 404).

## Human-visible

Playground fixture states: card with art (success stubbed via `page.route` —
the `media.example.test` pattern; the 404/fallback case comes free), broken
URL, imageless gradient, compact unchanged, installed/unavailable states,
skeleton.

## Verification

- `ui-playground` red/green; `coverage.ts` entries for every new export.
- Component tests: stretched link + Install button independently clickable;
  icon URL → custom path, broken → DiceBear.
- **compare-screenshots**: before/after grid shots — judge card geometry and
  loading parity only.
- **screenshot-critique** (unprimed) as the LAST check before accepting any
  shot.

## Explicitly out of scope (visible wrongness allowed here)

Featured section order/heading (07); description rendering (08); detail-page
layout beyond the avatar swap.

## Delegated to implementer

Gradient palette derivation from the seed, exact band treatment inside the
existing radius, skeleton shimmer details.

## Must stay green

`marketplace.test.tsx` (order assertions untouched until 07), onboarding
"picked for you" rail (compact), consent sheet card usage.

## Feedback that would change this slice

Card min-height / grid column sizing taste once real shots exist — reversible
cosmetics; open a preview-shots window (~5 min, non-blocking) and proceed on
the evidence if silent, recording the call here.
