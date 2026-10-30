---
name: ui-playground
description: Run Duet's Docker visual-regression gate. Use after changing TSX in a visual app, shared UI/Tailwind code, route presentation, playground fixtures, screenshot coverage, or when asked for visual diffs, regression checks, or baseline approval.
---

# UI Playground

Treat screenshots as executable UI review, not golden files to update blindly.

## Workflow

1. **Inventory the change.** Run the affected owner's visual-coverage check and the root union. Lander, web, docs, and shared UI each own an exact ledger; missing, stale, duplicate, or cross-owner rows are red.
2. **Use production owners.** A fixture imports the real component and supplies deterministic props. If it needs product data, extract a presentational owner or inject a typed boundary; never mount Convex, auth, or network providers in the playground.
3. **Capture production owners in Docker.** The root command removes stale output, builds each selected app, and serves its optimized artifact before Playwright. Check only affected IDs unless a shared token, font, layout, or global stylesheet changed.
4. **Look at every changed desktop and mobile PNG.** A passing hash proves stability, not correctness. Reject clipping, overflow, ambiguous navigation, missing states, stale loading UI, bad focus, weak contrast, or mobile-only loss of hierarchy.
5. **Get visual judgment.** Run unprimed screenshot critique. Compare against a source/reference when one exists, treating metrics as diagnostic rather than ground truth. Open the smallest review set in one Preview window for the non-blocking checkpoint.
6. **Re-run green.** The exact Docker check, coverage ledger, build, typecheck, and lint must all pass before committing screenshots with their code.

## Commands

```bash
# Product/shared-UI playground: both desktop and mobile.
bun ui:check spa-shell
bun ui:check spa-shell ui-primitives
bun ui:approve my-fixture
bun ui:approve --force my-fixture

# One representative lander route or docs page.
bun ui:check lander-public-root
bun ui:check docs-getting-started

# Explicit full sweep after global visual inputs change.
bun ui:check --all
bun ui:approve --all

# Coverage and build-output invariants.
bun --cwd=apps/web run verify:visual-coverage
bun --cwd=apps/lander run verify:visual-coverage
bun --cwd=apps/docs run verify:visual-coverage
bun --cwd=packages/ui run verify:visual-coverage
bun visual:union
bun assets:verify
bun --cwd=apps/web run verify:build-output

# If a verify above fails on drift, regenerate — coverage first, union second.
bun --cwd=apps/web run visual:coverage:write      # or apps/lander, apps/docs, packages/ui
bun visual:union:write
```

Both ledgers are verified **before** Playwright starts, and a drifted one aborts
the run without taking a single shot. Adding or deleting baselines drifts the
union, so a change that retires screenshots costs a `visual:union:write` before
the very run that would have regenerated them — otherwise two Docker runs are
spent discovering it.

`--force` rewrites every matched baseline; it does not broaden the fixture selection. Host Playwright output and `next dev` captures are unsupported because committed baselines belong to the pinned Linux/Chromium image running the optimized build. The `:in-docker` scripts are CI/container internals.

## Coverage model

- The registry is pure metadata and every entry declares a capture kind. There is no generic screenshot skip.
- The render map is the only JSX thunk map; its key type must exhaust the registry.
- Component coverage is symbol-exact. `owned-by` names one concrete fixture or route; globs and directory exemptions are invalid.
- Public static/SEO coverage enumerates every concrete URL. Screenshots cover each distinct template plus two deliberately rich blog bodies; adding posts must not grow the screenshot corpus.
- Each app owns its fixtures, targets, and baselines. Shared UI owns a ledger that points to one real app fixture/route without copying its screenshots. The root command proves the four-owner union; apps never import one another for coverage.
- Public/playground surfaces stay backend-independent. Product fixtures use REST/SSE fakes at the client seam, never direct Convex or live staging data.

## Baseline rules

- New fixture code and both viewport PNGs land together.
- Plain `approve` may leave a sub-threshold baseline unchanged; use `--force` when intentional pixels moved but Git did not.
- Do not loosen screenshot tolerances, ignore snapshots, add `test.skip`, or mark CI non-blocking to make a diff green.
- Flow states use named browser steps and named shots; static fixtures do not hide time-driven behavior.
- PR visual CI runs in the same Playwright image as local approval. Keep the package and image versions exact and synchronized.

## Hermeticity

- Pin data, locale, time, random values, fonts, and local assets.
- Wait for fonts, images, editors/iframes when present, and stable layout before setting the ready signal.
- Stabilize animation and carets without mutating production DOM during hydration. Playwright's caret-hiding stylesheet is unsafe for this app's very large selectively hydrated pages; no current visual scenario focuses an editable field, so the suite leaves caret handling at `initial`.
- Router context is allowed only when navigation state is itself under test; supply an explicit initial route.
