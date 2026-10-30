# Official Agent App Test Harness

Official-agent apps have two complementary proofs: deterministic local visual
baselines for authored app states, and a focused staging journey for the real
workspace, VM, product route, and private launch-grant boundary. This split is
intentional. Local pixels should be reproducible and reviewable in git;
deployed evidence should exercise real infrastructure and then disappear with
its ephemeral workspace.

The harness covers every app declared by the official-agent manifest,
including onboarding apps. The initial corpus contains 22 semantic scenes and
44 committed screenshots: desktop and mobile for each scene. The deployed
journey covers all six apps and captures both the product composition and the
app iframe at both viewports.

## Durable invariants

`officialSeedAgents` is the authoritative app roster. The typed driver registry
necessarily maps each manifest identity to a production factory, but an exact
equality test prevents that adapter list from drifting. Scenario coverage, the
generated visual ledger, and the staging plan derive from the manifest.

Local scenarios start the production app factories with fresh temporary
storage. They arrange state through each app's public HTTP API and wait on
visible semantic state rather than sleeps or `networkidle`—the apps keep SSE
or polling connections open. Only true external boundaries are controlled:
Connect Repos receives a deterministic repository probe, and the provider
onboarding apps share a fake Duet edge. A scene never writes runtime state
files directly and never runs against an authored source directory.

The committed screenshots belong to `official-apps`, the fifth independent
visual owner beside lander, web, docs, and shared UI. Expected paths derive
from the scenario registry and are pinned by both focused tests and the runtime
verifier. A full approval may prune stale files only inside the official-app
screenshot root; filtered approval cannot prune other scenes. Approval writes
the manifest-derived ledger before capture, then regenerates and verifies the
combined owner index after screenshots change. This ordering lets new and
deleted scenes converge in one command.

The staging loader owns only reset, bounded file transfer, sequential agent
registration, and API-returned identities. Lifecycle policy remains with its
caller: `scripts/try.ts` is the durable human workbench, while
`runWorkspaceBrowserJourney` creates an ephemeral user and workspace, waits for
the real VM, authenticates a real browser, and treats verified cleanup as part
of the result. Automated coverage never invokes `try`.

Private app proof uses the agent-owned product route and the launch-grant
iframe, not an app's canonical URL. Registration and routes use the actual
agent and app slugs returned by the API. Onboarding agents are unlocked through
the existing public completion endpoint only so sibling apps can be addressed;
their apps remain in safe disconnected states and the journey never initiates
OAuth or captures credentials.

Deployed semantic readiness is intentionally structural: each authored page
must expose its primary `<h1>` and settle either a waiting connection pill or a
visible `.empty` panel. A new presentation contract must extend that small
derivation explicitly; it must not silently degrade to an iframe-exists check.

## Working with the harness

The author workflow is documented beside the apps in
[`packages/official-agents-seed/README.md`](../../../packages/official-agents-seed/README.md).
The main entry points are:

- [`tests/visual/scenarios.ts`](../../../packages/official-agents-seed/tests/visual/scenarios.ts)
  for typed semantic scenes and public-HTTP arrangements;
- [`tests/visual/drivers.ts`](../../../packages/official-agents-seed/tests/visual/drivers.ts)
  for the manifest-exhaustive production-factory adapters;
- [`tests/visual/run-visual.ts`](../../../packages/official-agents-seed/tests/visual/run-visual.ts)
  and [`verify-screenshots.ts`](../../../packages/official-agents-seed/tests/visual/verify-screenshots.ts)
  for capture, comparison, and safe pruning;
- the committed
  [`__screenshots__`](../../../packages/official-agents-seed/tests/visual/__screenshots__)
  corpus and generated [`visual owner index`](../../../visual-coverage/index.generated.html)
  for human review;
- [`official-agent-workspace.ts`](../../../packages/test-harness/src/official-agent-workspace.ts)
  for the lifecycle-neutral staging/manual loader; and
- [`staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic)
  for deployed orchestration and evidence capture.

Add a visual state by adding one typed scenario row with its public-HTTP setup
and semantic readiness assertion. The runner supplies isolated lifecycle,
locale, timezone, reduced motion, theme, both viewports, screenshot naming, and
cleanup. Adding a manifest app also requires one production-factory driver;
coverage tests fail until every declared app has a driver and a visual scene.

Use `bun run agent-apps:check` for the complete official-app owner and
`bun run agent-apps:approve` to update it in the pinned Playwright/Bun Docker
environment. The ordinary `bun run ui:check <agent-app-id>` and
`bun run ui:approve <agent-app-id>` grammar supports focused iteration. Only
container approval is authoritative. Removed or renamed scenes require a full
owner approval so stale screenshots can be removed safely.

Run the deployed proof with
`bun run e2e:staging -- --journey official-agent-apps`. Its PNGs and JSON are
private run artifacts under `artifacts/staging-e2e-synthetic` by default (overridable
with `DUET_E2E_ARTIFACT_DIR`), not committed baselines.

## Why the implementation has this shape

A generic fixture language was rejected. The six apps expose different public
APIs, and a schema capable of describing all of them would merely hide direct,
typed HTTP setup behind translators. A small scenario registry and app-owned
arrangement functions match the repository's existing visual-test polish and
make adding another shot straightforward.

Neither `try` nor the raw exe.dev pool is a suitable automated lifecycle.
`try` intentionally reuses and resets a durable shared staging workspace. The
VM pool creates a machine but not Duet workspace metadata, authentication,
registration, launch grants, or browser state. The existing workspace-browser
fixture already owns those boundaries and verified teardown.

Staging screenshots are deliberately not baselines. Their workspace identity,
VM timing, and outer product shell are deployed evidence, whereas committed
app pixels must remain deterministic. Conversely, the local playground cannot
prove private framing because same-site launch-grant cookies require deployed
Duet hosts.

The harness exposed two real defects that it now prevents. The local degraded
scene found that a revoked Connect Repos grant left setup marked complete,
producing contradictory “complete” and “revoked” states; completion now also
requires a connected grant. The live staging critique found that the product's
mobile split can give an app iframe only about 188 pixels, narrower than the
standalone phone baseline; provider controls now stack at that width, with a
geometry regression guarding against overlap.

## Constraints and follow-ups

The edge hostname grammar joins app and workspace slugs into one DNS label.
Both public schemas independently allow 40 characters, but two maximum slugs
cannot fit the DNS 63-byte limit while remaining reversibly encoded. This
feature gives only its ephemeral staging workspace a manifest-derived,
hash-backed shorter slug. A general platform solution needs an explicit
addressing design; lossy truncation was intentionally not introduced here.

The outer product shell continues to preserve its chat-and-app split at mobile
width, leaving a narrow iframe. That composition is product UI policy, not a
harness concern; the app-level overlap it revealed was fixed, while a broader
mobile shell redesign remains future product work.

The initial repo-wide closeout command reached unrelated existing failures in
backend/API exact-shape assertions for `servicingStatusChangedAt`, a backend
exact audit-count assertion, and gateway runner-hydration tests. This feature
changes none of those packages. Its owning behavior suites, type/lint checks,
exact 22-scene/44-image Docker visual gate, owner-union verification, and
focused live staging journey were green.

## Visual provenance

The committed baselines are captures of the repository's production app code
under controlled authored states; no external design reference was used. A
fresh visual critique reviewed the complete local corpus and the live staging
captures. Ordinary polish opportunities were left in the honest baselines;
only the contradictory revoked state and the plainly overlapping narrow-frame
provider controls crossed the agreed bug-fix boundary.
