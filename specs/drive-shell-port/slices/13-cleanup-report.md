# Slice 13 — Refactor-clean, full gate, and final report

**Depends on:** slice 12.

## Contract unlocked

The repository reads as if the Drive product was designed this way today, and
the user receives an exact account of everything ported, adapted, or omitted.

## Work

- Invoke `write-tests` for any cleanup behavior change.
- Run `refactor-clean` over the implementation and ownership table.
- Delete unused shell/destination/mobile-nav code, current presentation markup,
  wrappers, exports, fixtures, tests, translations, styles, and route literals.
- Collapse any implementation-only adapter/default immediately; no `v2`,
  `classic`, `legacy`, `compat`, `fallback`, dual-controller, or dual-shell
  branch survives.
- Prove every concept in the README ownership table has one owner and one live
  consumer path.
- Update durable project documentation only where navigation principles
  changed; do not duplicate the route table across docs.
- Complete `CUTOVER-REPORT.md`: every row final, evidence linked, counts
  reconciled, routes/deletions recorded, API firewall proven, visual evidence
  linked, commands/results recorded, and remaining gaps summarized.
- Re-run the complete route/workspace/OAuth/share/operation matrix and visual
  coverage ledger.

## API seam

No new runtime seam is introduced. Cleanup proves the README ownership table;
the report is the sole durable port/omission ledger and links evidence produced
by existing tests, route owners, and visual gates.

## Refactor-clean audit

Reject:

- any redirect/alias for removed product leaves;
- two route builders, workspace switch state machines, session/app canvases,
  Files directory caches, Train controllers, or Integrations controllers;
- inline `/w/${...}` Drive path construction outside the route owner;
- product sample/mock imports or fake fallback data;
- duplicated desktop/mobile rail markup;
- source Convex/backend imports or new client transport methods;
- report rows without a final verdict and evidence.

## Human review surface

The final report plus the smallest complete desktop/mobile evidence montage.

## Verification

- Run focused suites after each cleanup batch.
- Run final Docker visual coverage and prove registry/render-map/baseline union.
- Run final `compare-screenshots` and unprimed `screenshot-critique`; cleanup may
  not move approved geometry without reopening its isolated gate.
- Open the final report/montage through `preview-shots` as a non-blocking
  checkpoint; after about five minutes without feedback, record the final
  evidence-based verdict, close the shots, and continue.
- From repository root run:

  ```sh
  bun run test
  bun run check-types
  bun run lint
  ```

- Run route-manifest/build-output and boundary checks.
- Run `git diff --check`, inspect `git status`, and preserve unrelated work.
- Validate the report: every planned ledger row has one allowed final verdict,
  every omission names a missing current contract, and summary counts match.

## Done means

- The new Drive route tree is the only workspace product route tree.
- All current domain APIs are mapped truthfully and all sacred behavior passes.
- No backend/schema/generated API change exists.
- No compatibility or dead navigation remains.
- Every visual/accessibility/responsive gate passes.
- `CUTOVER-REPORT.md` is complete and suitable to hand directly to the user.

## Stays green

Every behavior, visual, accessibility, route, settings/admin, and API-firewall
contract established by slices 01–12.

## Feedback that changes the slice

Only evidence corrections, an incomplete ledger row, a stale owner, or a
regression may reopen cleanup. New product contracts/features become separate
work rather than being smuggled into closeout.
