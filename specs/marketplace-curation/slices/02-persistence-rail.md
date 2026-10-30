# 02 — Convex persistence rail (the five-validator lockstep)

**Contract unlocked:** listing rows can hold description, media refs, and
featured state; registration/sync stamp them correctly; nothing can partially
deploy.

## API seam

All in one change (Convex deploys before api — record in the PR):
- `schema.ts` `agentListings`: `derived.description: v.optional(v.string())`;
  `headerImage` / `iconImage`:
  `v.optional(v.object({ storageId: v.id('_storage'), sha256: v.string(), mimeType: v.string() }))`;
  `featuredAt: v.optional(v.number())`; index
  `by_state_and_featured: ['state', 'featuredAt']`.
- The lockstep (all optional): `registerListingFromAgent` arg validator,
  `seedAgent` validator in `officialHub.ts` (+ its hand-written TS twin),
  `ListingDerivedMetadata` — with slice 01's contract this closes the five.
- `storeListingAssets` action finalized from slice 00: **sha256-idempotent**
  (same sha for the role → skip store, reuse ref); stamp mutation swaps refs
  and returns displaced storageIds; action deletes them.
- `registerListingImpl`: accepts optional media refs with **tri-state**
  semantics (ref = replace, null = clear, absent = untouched); `derived`
  replacement stays wholesale — but description can never be null-ish because
  the derive always yields the fallback.
- `featuredAt` is NOT in register/seed args — structurally unreachable by
  sync/publish.

## Human-visible

Convex fixture run: register a listing with refs, see catalog/detail rows
carry them; feature a row by direct db patch and watch a re-register leave
`featuredAt` intact.

## Verification

Fire **new-shaped payloads at the real Convex functions** (validators are a
second schema — TypeScript green proves nothing):
- `official-hub-seed.test.ts` (all 6 seedAgent call sites) extended with a
  max-size (64KiB) description — the arg-growth gate.
- Re-register with new sha → old blob deleted; same sha → same storageId;
  absent media → prior refs untouched; explicit null → cleared + deleted.
- Feature → takedown → revive: `featuredAt` survives, register never touches
  it.
- Old-shape payloads (no new fields) still register — optionality proof.

## Delegated to implementer

Whether media refs live top-level or under one `media` object on the row
(pick one, mirror it in every validator); internal mutation naming.

## Must stay green

Every existing marketplace/officialHub backend test; schema validation on
existing staging-shaped rows (all new fields optional — no backfill, no
migration).

## Feedback that would change this slice

None expected — this slice is deliberately mechanical once 00/01 are green.
