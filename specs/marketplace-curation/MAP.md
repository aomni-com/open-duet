# Marketplace curation — quadrant map

Featured listings, 2:1 header images, and long-form descriptions for agents.
Product of an explore-unknowns walk with Example User, 2026-08-15. **This map is
binding input for write-spec / implementation** — every decision below is a
given, not a suggestion. Mock the UI decisions were made against:
https://claude.ai/code/artifact/f3611a47-10eb-4e43-9f86-63a1b6e93dac

> **SUPERSEDED FOR EXECUTION (2026-08-15):** the spec now exists — start from
> `README.md` in this folder (Next Agent Prompt) and `slices/`. This map
> remains the decision record; do not follow its kickoff prompt, and note the
> OPEN byte-transfer item below is now SETTLED (README, "The settled seam"):
> inspection carries bounded bytes → Convex storage action → refs on the row.

## Known knowns (settled ground, cited)

- The definition file is `agent.json`, one per agent folder. Schema
  `AgentConfigSchema` (`packages/contract/src/agents/index.ts:89`) is
  `.loose()`. **This feature ends up changing agent.json not at all** — both
  new assets are convention files, and featured is a DB column.
- 24 official agents live in `packages/official-agents-seed/content/agents/`;
  catalog metadata is *derived, never declared* (package README). Sync:
  `buildOfficialSyncPlan` → `officialHub:beginSync` → gateway
  `converge-subtree` → `completeSync` → `registerListingImpl`.
- Marketplace derivation single owner: `deriveListingMetadata`
  (`packages/contract/src/marketplace/index.ts:390`); precedence single owner:
  `resolveListingMetadata` (`convex/domains/marketplace/listings.ts:57`);
  ordering/filter single owner: `tag-filter.ts` (`apps/web/spa/marketplace/`).
- The two origin producers that must always agree: gateway
  `inspector.ts` (`packages/gateway/src/marketplace/`) and seed
  `officialListingOrigins` (`packages/official-agents-seed/src/index.ts`).
- Settings page = `agent-detail-canvas.tsx`; readme read pattern =
  `agentReadmeQueryOptions` (`apps/web/spa/drive/agent-profile.ts:68` — 404→null,
  retry:false, `joinDrivePath`).
- Convex file storage exists and is the session-images precedent
  (`convex/domains/agentSessions/images.ts`).
- No prior featured/header/description attempt exists anywhere (greps clean).

## Known unknowns — decision ledger

| # | Decision | Closed by |
|---|----------|-----------|
| 1 | `featured` = admin-set column on `agentListings`; set from a new internal-admin panel (listing enumeration + toggle, `accessArgs` + `convexJson` + audit pattern; NOT a register/sync arg — sync must never touch it) | Example User |
| 2 | Featured UX = a "Featured" section at the top of the marketplace grid, same card component as everything else | Example User |
| 3 | Card = **cover card**: 2:1 art on top, identity below; ALL cards render the header image when present, not just featured | Example User |
| 4 | Imageless/failed-load fallback = seeded gradient band + large initial; it is the *common* path and must look shipped | Example User |
| 5 | Header image = convention file `header.png` > `header.jpg` > `header.webp` beside AGENTS.md (precedence authored, never sort order) | Example User + territory |
| 6 | Description = `DESCRIPTION.md` sibling file; **marketplace detail and agent settings render the same content**; falls back to full AGENTS.md when absent | Example User |
| 7 | Agent-page hero **DEFERRED** — header image renders only on marketplace cards for now; detail + settings get the description body, no banner. Unblocked by a later design pass | Example User (OPEN-deferred) |
| 8 | Serving = **copy bytes into Convex file storage at registration/hub-sync** (VM guaranteed awake then); listings carry server-projected storage URLs for header *and icon* (marketplace shows real avatars). No edge changes; `?zip` invariant untouched. (Revised from live `?raw` after the sweep: raw = per-request VM proxy, 30s cache, breaks on sleeping VMs) | Example User, revised once |
| 9 | I author `DESCRIPTION.md` for all 24 official agents in this build; header art waits for a designer (cards ride the gradient fallback) | Example User |
| 10 | Settings page reorder: description card on top, Skills card at the bottom | Example User |
| 11 | One avatar fallback everywhere: the existing generated `AgentAvatar` (DiceBear) — no second style | Example User |
| 12 | No metadata refresh sweep: description/header refresh only at registration/sync; existing third-party listings gain them on re-publish. Documented, pre-launch-appropriate | Claude (informed) |
| 13 | ETag rotation from adding files to 24 agents = one-time "What's new" for every subscriber; accepted, content genuinely changed | Claude (informed) |
| 14 | DESCRIPTION.md capped at 64KiB, size-checked at the inspector via `entry.size` before reading (typed refusal); description ships on the **detail wire only**, never the catalog projection | Claude (informed) |
| 15 | No `descriptionOverride` column — the file is already publisher-authored copy; `override ?? derived` stays a summary/title concern | Claude (informed) |
| 16 | Done = staging deploy + hub re-sync + seed/marketplace/visual gates; prod untouched; community publishers get header/description automatically (convention files) | Assumed, unobjected |

~~OPEN~~ **SETTLED 2026-08-15** (see README "The settled seam"): inspection
carries bounded bytes; a Convex **action** stores them (store is action-only —
a fact all four spec drafts confirmed independently); tri-state media args;
sha256-idempotent; api pulls-`?raw` rejected. Both producers feed the one
snapshot. Slice 00 remains a kill gate on getUrl-in-query + browser CSP.

## Unknown knowns (extracted taste)

- Header image ≠ icon/avatar — two distinct assets with different jobs.
- "Settings and marketplace pages should really show the same thing" — one
  shared description presentation, owner chrome around it on settings.
- "All the same cards" — no special featured card variant; featured is
  placement, not chrome.
- Hero banners on agent pages: not wanted yet; grid art is the whole show.
- Content production is split: copy now (Claude), art later (designer).

## Unknown unknowns — landmine cards

1. **`?raw` unfit for grids** (decided → storage copy, ledger #8):
   `apps/edge/src/index.ts:254,259,354` — per-request Convex resolve + VM
   proxy + awaited served-path mutation; SPA can't even build the URL (no edge
   host, no publish slug client-side; `deriveListingSourceUrl` is the sole URL
   constructor and hard-codes `?zip`).
2. **Five closed validators in lockstep, Convex deploys first** (sharp edge):
   `schema.ts:738` (`agentListings.derived`), `registerListingFromAgent` args
   (`listings.ts:345`), `seedAgent` (`officialHub.ts:40`),
   `ListingDerivedMetadata` + `deriveListingMetadata` (contract). All
   `v.optional`. Gateway wire fields optional **forever** (VM fleet upgrades
   on its own cadence) — copy the `agentJson` precedent
   (`marketplace/index.ts:475`).
3. **Derived is replaced wholesale on re-register** (`listings.ts:186`): a
   producer that omits description silently erases it. `featured` must stay
   out of register args or sync nulls it (the patch nulls absent overrides).
4. **Featured queries must re-assert `state === 'listed'`** — takedown keeps
   `featured: true` (`listings.ts:757`), and revive would resurface it. The
   catalog is top-100-by-installs (`listings.ts:237,270`), so the featured set
   needs its own server query (+ index; existing indexes are all `by_state_*`).
5. **Card layout contract**: `min-h-[17rem] p-5` card + hand-mirrored skeleton
   (`marketplace/loading.tsx:113`) + stretched-link pseudo-element
   (`gallery-card.tsx:266`) change together; image must escape the padding;
   `compact` (onboarding rail) never renders art. Plain `<img>` with the
   `FileIconImage` failed-URL-state pattern (`drive-file-icon.tsx:89`) —
   `next/image` remotePatterns rejects our hosts.
6. **Featured partition lives in `tag-filter.ts`** (the declared single owner
   of filter+order), not a fourth inline `.filter()` in `marketplace.tsx`;
   section heading renders only when non-empty (preserves the documented
   byte-identical launch-state property, `marketplace.tsx:178`).
7. **Settings fallback is one query, not two**: try DESCRIPTION.md, 404 →
   AGENTS.md inside one queryFn (two racing queries flash). The `"AGENTS.md"`
   card title becomes wrong — new i18n keys in `en` **and** `es-419`
   (`message-leaf-key-parity.test.ts` hard-fails otherwise).
8. **Both producers, exact case**: `DESCRIPTION.md` matching is
   case-sensitive `find` (`inspector.ts:47`); seed side detects header by key
   presence, never `TextDecoder` (binary → mojibake).
9. **Seed mechanics**: codegen is manual (`bun run codegen`, drift-tested);
   converge reap deletes hand-placed hub files; bundle budget
   `MAX_COMFORTABLE_BYTES = 16MiB` (`seed.test.ts:44`) is the number to defend
   when header art arrives; a paused publish serves frozen bytes until resumed.
10. **Test surface that breaks on contact**: `inspector.test.ts:47` exact
    `toEqual` on derived; `official-hub-seed.test.ts` (6 call sites against the
    seedAgent validator — the local tripwire for #2);
    `marketplace.test.tsx:235` asserts gallery document order; visual coverage
    ledger (`tests/visual/coverage.ts:445`) requires entries for new exports;
    playground stubs remote images via `page.route`
    (`playground.spec.ts:67`) — the 404/fallback case comes free, the success
    case must be stubbed. Seed authoring bar for the 24 DESCRIPTION.md files
    extends `seed.test.ts` (existence, ≤64KiB, prose rules mirroring the
    ≤200-char summary test).

## Tweakable plan (sorted by likelihood you'll tweak it)

1. **Byte-transfer seam** (the OPEN item) — inspection-carries-bytes vs
   api-pulls-raw-once. Recommendation: inspection carries bounded bytes.
2. **Admin panel shape** — recommended: one "Listings" panel on
   internal-admin: enumeration (id, title, publisher, state, featured,
   installs) + feature/unfeature button; reuses Panel/AdminState scaffolding.
3. **Featured index** — `by_state_and_featured` vs filtering the listed set
   (fine at current scale); pick when writing the query.
4. **Shared description component** — one component consumed by
   detail-page.tsx and agent-detail-canvas.tsx vs two thin renderers over the
   same data shape.
5. Mechanical (trusted): validator/wire plumbing per landmine #2, seed origins
   + inspector reads, DESCRIPTION.md authoring ×24 (AUTHORING.md bar), i18n
   en/es-419, fixtures + coverage entries + skeleton, settings reorder,
   `bun run codegen`, hub re-sync on staging.
