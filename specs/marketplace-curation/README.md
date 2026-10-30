# Marketplace curation

Featured listings (admin-set), 2:1 header images on marketplace cards, and
long-form `DESCRIPTION.md` descriptions rendered identically on the
marketplace detail page and the agent settings page.

**Binding inputs:** `MAP.md` in this folder (the decision ledger from the
quadrant walk — every ledger decision is a given, never re-opened here) and
the approved mock (linked from MAP.md). This README + `slices/` supersede the
MAP's kickoff prompt and its OPEN item, both now marked as such in MAP.md.

Hard cutover: no backward compatibility, no data migrations. The only
ordering facts are operational (see Runbook): Convex deploys before api;
gateway wire fields are optional forever because VM gateways upgrade on
their own cadence.

## Next Agent Prompt

_Last updated: 2026-08-15. Status: spec written, nothing built._

You are implementing this spec. Read this README fully, then `MAP.md` for
the decision ledger. Do not re-open ledger decisions or the settled seam
(below). Start with **slice 00 and slice 01 — they are parallel and
everything else depends on them**. Work slice by slice via the
`implement-spec` skill; each slice file is the contract. Before behavior
changes, use the `write-tests` red/green flow; for visual slices, the
`ui-playground` flow plus `screenshot-critique` (and `compare-screenshots`
against the prior look / the mock) as the slice files instruct. Update this
section (status, date, pickup point, checklist) before ending every pass.

Active warnings:
- Slice 00 is a kill gate. If the storage-URL rail fails, STOP and apply its
  recorded fallback before touching any other slice.
- The five-validator lockstep (Firewalls below) means backend schema work
  lands complete or not at all — never partially.
- Staging root `bun run test` has known pre-existing reds — reproduce in the
  main checkout before blaming your branch.

Global TODO (owning slice in parens):
- [ ] Storage rail kill gate: action store → stamp → getUrl-in-query → browser render (00)
- [ ] Origin contract: snapshot/wire fields, bounds, precedence owner, derive fallback, both producers (01)
- [ ] Convex persistence rail: schema, lockstep validators, assets action, register stamping (02)
- [ ] Wire projection: catalog union + featured + image URLs; detail description (03)
- [ ] API orchestration: publish route + hub-sync route copy media (04)
- [ ] Featured admin rail: enumeration + toggle + Listings panel (05)
- [ ] Cover cards + real avatars + skeleton (06)
- [ ] Featured section partition (07)
- [ ] Description on detail + settings, settings reorder (08)
- [ ] 24 official DESCRIPTION.md + authoring bar (09)
- [ ] Staging deploy, hub re-sync, live journey, closeout gates (10)

## The settled seam (was MAP.md's OPEN item)

**Inspection carries bounded bytes; a Convex action turns them into storage
refs; the register rail's vocabulary is the ref, never the bytes.** All four
independent drafts converged here. Decisive facts:

- `ctx.storage.store` is **action-only** (`agentSessions/images.ts` precedent)
  and registration/`completeSync` are mutations — so a storage action seam is
  mandatory regardless of transport. The api route orchestrates: inspect →
  `storeListingAssets` action → register mutation with refs. The hub-sync
  route has the same slot between converge and `completeSync`.
- `api-pulls-?raw` was rejected: it re-litigates the map's landmine #1
  (per-request VM proxy, sleeping-VM failure at registration time) and would
  force a second edge-URL constructor beside `deriveListingSourceUrl`'s
  single-owner `?zip` contract.
- Bounds enforced by `entry.size` **before** reading: description ≤64KiB,
  image ≤512KiB, typed refusals. ~1.5MiB max inspection response rides the
  same authenticated channel that already carries the 16MiB converge body.
- The AGENTS.md **fallback is clamped to the same 64KiB** in
  `deriveListingMetadata` — an unclamped fallback could blow the Convex row
  where only DESCRIPTION.md was capped.
- Media args are **tri-state**: value = replace, `null` = clear (and delete
  blob), absent = leave untouched. An old-fleet gateway that omits the fields
  must never strip a listing's art (the wholesale-replace landmine one layer
  up).
- Stores are **sha256-idempotent**; replace deletes the displaced blob
  (delete is mutation-legal). The sync button is pressed repeatedly and must
  be blob-idempotent.

## Slice graph

```
00 storage-kill-gate ─┐
01 origin-contract  ──┴→ 02 persistence-rail → 03 wire-projection ─┬→ 05 featured-admin → 07 featured-section
                          02 → 04 api-orchestration                ├→ 06 cover-cards
01 → 09 official-descriptions                                      └→ 08 description-surfaces
ALL → 10 staging-closeout
```

00∥01 first. 04/05/06/08 are parallel after 03. 09 is parallel with
everything after 01. 07 needs 05 only for the live human loop (fixtures
first).

## Concept ownership (firewalls)

One owner per concept; a slice that tempts a second owner is wrong.

| Concept | Single owner | Never |
|---|---|---|
| Header filename precedence (`header.png` > `.jpg` > `.webp`, exact case) | `LISTING_HEADER_CANDIDATES` in contract, imported by BOTH producers | sort order deciding; per-producer lists |
| Origin snapshot | `ListingOriginSnapshot` (contract) — both producers emit the identical shape (twin-producer parity test) | inspector-only or seed-only fields |
| Description + fallback rule | `deriveListingMetadata`: `descriptionMd ?? agentsMd`, clamped 64KiB | fallback re-implemented at read time or in the UI |
| Listing media lifecycle (store/stamp/URL/delete) | `domains/marketplace/assets.ts` action + register mutation stamping | any other writer/deleter of listing blobs; bytes in `derived` |
| Edge URL construction | `deriveListingSourceUrl` (`?zip`, unchanged) | any new edge-URL constructor; client-side URL assembly — image URLs are **server-projected storage URLs** |
| Featured state | `featuredAt` column, written ONLY by `setListingFeatured` (admin, audited) | register/sync args carrying featured; UI trusting `featured` without server-side `state === 'listed'` |
| Catalog partition + order | `tag-filter.ts` — featured/verified/community all partitioned there (the existing inline route filters MOVE in; leave-code-better) | a third/fourth inline `.filter()` in `marketplace.tsx` |
| Card art + gradient fallback | new `card-art.tsx` component | `AgentAvatar` learning gradients; card-art learning DiceBear |
| Avatar fallback | `AgentAvatar` (DiceBear), gaining an explicit-`src` mode | a second avatar style anywhere |
| Settings description read | ONE queryFn: DESCRIPTION.md, 404 → AGENTS.md | two racing queries; a second joinDrivePath |
| Description presentation | shared `AgentDescription` component on both surfaces | two renderers that can drift |

End state reads as designed today: the marketplace always had cover cards, a
featured rail, server-projected media URLs, and a description contract —
nothing bolted on, no transitional scaffolding anywhere in the ladder.

## Runbook (operational facts the spec must survive)

- **Deploy order:** Convex first (`convex dev --once` for staging — never
  `deployment select`), then api/web. New inspection refusal enums must exist
  in the api's contract before any gateway release emits them (an unknown
  refusal collapses to `gateway_unavailable`).
- **Hub sync:** press once after deploy; adding 24 DESCRIPTION.md files
  rotates every publish ETag → one-time "What's new" for all subscribers
  (accepted, ledger #13). A second unchanged press must write nothing and
  rotate nothing — assert it once on staging.
- **Paused publishes:** sync never resumes them; a paused publish serves
  frozen bytes while listing metadata advances. Converge reap deletes
  hand-placed hub files — the plan is the whole truth under managed roots.
- **Failure/recovery:** inspect refusal → nothing registered. Asset action
  failure during sync → old rows stay authoritative; retry the same sync.
  Diagnostics carry ids/phase/size/hash-prefix, never bytes.
- **Recorded residue choices (pre-launch):** taken-down listings keep their
  media blobs (takedown is a pure mutation; clearing via the admin route is a
  possible follow-up, not in scope); a refused registration after a store
  orphans fresh blobs (api best-effort deletes; residue acceptable);
  community listings gain description/header only on re-publish (no refresh
  sweep, ledger #12).

## Known unknowns owned by slices

- Storage `getUrl` inside `catalog`/`detail` QueryCtx + browser CSP for the
  storage host → slice 00 (with recorded fallbacks: URL stamped at store
  time, or api asset proxy route).
- Real inspection response size behavior at the cap → slice 01 boundary test.
- `completeSync` arg growth with 24×≤64KiB descriptions → slice 02's real-
  deployment payload test.

## Verification standing orders

Narrowest-runner ladder while iterating; root `bun run test` once, at slice
10. Every visual slice: `ui-playground` red/green, coverage-ledger entries,
unprimed `screenshot-critique` as the LAST check on any accepted shot, and
`compare-screenshots` whenever there is a prior look or the mock to judge
against. i18n changes always land en + es-419 together. Staging journey
(slice 10) runs once, at the end: `bun run e2e:staging -- --journey
marketplace-curation`.
