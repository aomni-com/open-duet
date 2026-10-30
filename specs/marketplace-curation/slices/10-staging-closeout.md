# 10 — Staging closeout: deploy, hub re-sync, live journey

**Contract unlocked:** the whole feature proven on live staging; prod
untouched (ledger #16).

## Rollout order (the Runbook, executed)

1. Local gates first: `bun test --changed=origin/staging` sweep, per-app
   `bun run build` (Next build is not in local gates), ui-playground green,
   then ONE root `bun run test` (known pre-existing reds reproduce on main —
   verify there before blaming the branch).
2. Deploy Convex to staging (`convex dev --once` — never
   `deployment select`), then api/web.
3. Press hub sync from internal-admin. Expect the one-time ETag rotation
   ("What's new" for every subscriber — accepted, ledger #13). This sync also
   flushes the pending suggested-first-message re-sync.
4. Press sync AGAIN: assert zero files written, zero deleted, archive ETag
   stable — the idempotence proof, once, live.
5. Run the journey: `bun run e2e:staging -- --journey marketplace-curation`.
   Never the full e2e run.

## The journey (`packages/test-harness`, register in `src/staging-e2e-synthetic`)

New journey, separate from the existing marketplace journey (either can run
alone):
1. Admin sign-in (real magic-link helper) → hub sync → assert counts.
2. An official listing's **detail** carries a non-empty `description`
   containing a sentinel from its authored DESCRIPTION.md (not AGENTS.md's
   first paragraph); the **catalog** response provably lacks a description
   key (ledger #14, live).
3. In the journey workspace: write `DESCRIPTION.md` + a small `header.png`
   into an agent folder via the files API, publish a listing → detail
   description matches the file; `headerImageUrl` and `iconUrl` fetch **200
   with image/* content-type** — the inspector → action → storage → URL rail
   proven live (with official art deferred, this community listing is the
   only thing keeping `headerImageUrl` from being a plumbed-but-unwritten
   field — the exact defect class a prior journey caught).
4. Re-publish after deleting header.png → URL gone (null-clears leg, live).
5. Feature that listing via the admin endpoint → catalog shows
   `featured: true` exactly once; browser: Featured section renders first
   with the same card. Settings page of the installed official from step 2
   shows the same description as its detail page.
6. Cleanup in `finally`: unfeature, unlist the journey listing, restore
   original states.

## Verification

Journey green; the second-sync no-op observed; screenshots from the browser
legs pass an unprimed **screenshot-critique**.

## After

Update the README's Next Agent Prompt to SHIPPED state; then `close-spec`
archives this folder to `specs/done/` as a rationale record. Prod promotion
is a separate, Example User-gated event (prod hub re-seed runbook applies).

## Delegated to implementer

Journey helper reuse, sentinel strings, workspace naming.

## Must stay green

Every other registered journey's selection entry; staging data left as found
apart from the intended sync.
