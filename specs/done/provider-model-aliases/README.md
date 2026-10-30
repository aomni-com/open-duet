# Provider model aliases

Provider choices preserve a person's preferred provider and capability level while
allowing Duet to upgrade the backing model. The existing Max/Standard/Lite
routers remain available. Advanced choices appear in conversation composers and
workspace defaults, using the same selector and comparison points.

## Why aliases are routes

A saved selection describes intent rather than a model version. The existing
agent router already accepts a virtual name with one destination and carries
that name into billing attribution. Reusing this mechanism avoids another
resolver, attribution bridge, or loader policy. The gateway owns the complete
`.duet/models.json`; maintaining it is a product responsibility, not a user task.

Routing data travels inside the normal gateway bundle. Its content participates
in the release hash, so the existing VM updater distributes mapping changes.
The gateway refreshes the file at the resolved runner directory before launch,
including nested agent directories. Identical content is left untouched; failed
preparation prevents launch. A running turn retains its model, while subsequent
spawns consume the current mapping. Offline VMs catch up through the same updater.

The pinned agent's standard policies are exported during the gateway build.
This preserves their owner and avoids a hand-maintained copy of automatic routing.
See [routing configuration](../../../packages/gateway/src/runner/routing-config.ts),
[exporter](../../../packages/gateway/scripts/export-routing-table.mjs), and
[release transition tests](../../../packages/gateway/src/runner/routing-release.test.ts).

## Contracts and invariants

The [selection contract](../../../packages/contract/src/model-tiers/index.ts)
owns stable IDs, current targets, labels, ratings, rates, and billing coverage.
The three-router subscription ladder stays separate from the eight selectable
values. Existing persistence columns and wire field names are retained; plan
changes must not overwrite a provider alias.

| Choice | Initial target | Intelligence / speed / cost |
| --- | --- | --- |
| OpenAI frontier | gpt-6-astra | 5 / 2 / 5 |
| OpenAI max | gpt-5.6-sol | 4 / 3 / 4 |
| Anthropic frontier | fable-5.1 | 5 / 2 / 5 |
| Anthropic max | opus-5 | 4 / 3 / 4 |
| Anthropic balanced | sonnet-5.5 | 4 / 4 / 2 |

All ratings use a five-point scale and were approved by the user. Frontier
pricing is $12 input, $60 output, and $1.20 cached input per million tokens;
max pricing is $10/$30/$1. Rates are shared across providers. The compaction
premise led the user to reject worst-case long-context pricing.

The OpenAI Sol and Anthropic balanced selections use the same Duet tariff: $3
input, $15 output, and $0.20 cached input per million tokens. The published
Sonnet 5.5 provider rates are $2 input, $10 output, and $0.10 cached input per
million tokens.

Each alias has one execution destination, medium effort, no vision fallback,
and no advisor. Failure must not silently select another model. Support work
retains its existing models and at-cost treatment outside the billing closure.
Historical targets must remain in billing coverage when mappings change so late
settlement keeps the agreed rate; coverage is not an execution fallback list.
See [runtime tests](../../../packages/gateway/src/runner/routing-config.test.ts)
and [settlement](../../../packages/backend/convex/domains/modelGateway/settlement.ts).

The [shared selector](../../../packages/ui/src/components/quality-selector.tsx)
owns desktop hover/keyboard disclosure and mobile tap expansion. Product
[option metadata](../../../apps/web/spa/model-tiers/tier-quality-options.ts)
supplies labels and ratings. The selected alias remains visible with its points;
expanded rows also identify the current model.

## Rejected approaches and visual provenance

Concrete version pins conflicted with automatic upgrades. Protected built-in
aliases and a new loader merge policy conflicted with gateway ownership of the
complete custom file. A separate router distribution service duplicated the
existing release path. None is needed for models supported by the installed agent.

The original desktop/mobile product captures in [before](assets/before/) are the
visual reference: familiar router choices and score presentation remain intact.
[Before-layout](assets/before-layout/) preserves the rejected clipped drawer and
edge-touching submenu. [Before-scores](assets/before-scores/) preserves the
intermediate design before the user requested comparison points.
[Final captures](assets/after/) and [crops](assets/crops/) show the accepted design.
The matching [320px before](assets/mobile-320-before.png) and
[after](assets/mobile-320-after.png) captures record the final selected-label fix;
[before header crop](assets/before-narrow/) and
[after header crop](assets/after-narrow/) isolate that comparison. These are real
browser captures, not mockups. [Documentation crops](assets/docs/) preserve the
related rendered prose. [Visual review](assets/visual-review.md) records the
independent critiques and [telemetry](assets/comparison.json) the comparisons.

The first layout hid the last mobile option. A taller scrollable drawer fixed
that. Adding scores exposed truncation in settings and at 320px: a wider desktop
control and tighter mobile score spacing preserved the full label and points.

## Verification record

The real staging journey observed the same VM update from the previous gateway
release without changing agent 0.3.24, then exercised all aliases, resumed a
conversation, checked ordinary routing, read the nested routing file, and verified
execution charges. Cleanup left no orphans. The registered journey callback ran
inside its existing fixture with a bounded pre-deployment update wait; see the
[sanitized receipt](assets/staging-evidence.json). The presentation follow-up has
its own [deployed ratings receipt](assets/staging-ratings.json).

Focused runtime, contract, browser, and release tests passed. All 23 packages
passed type checking. Docker interaction/screenshot checks and fresh visual
critique accepted the final UI, including 320px touch behavior. Independent final
code review found no actionable regressions.

The full root test run completed with two backend failures. The stale-dispatch
case passed unchanged on an isolated rerun. The file-activity case had a scheduler
race in its fixture: a test-only pause now keeps projection pending until the test
explicitly runs it. All 50 file-activity tests passed, and restoring the forbidden
raw-log fallback made the regression assertion fail. The full root suite was not
rerun; the skipped trailing asset/coverage gates were run separately and passed.

[Implementation choices](choices.md) records engineering discretion.
[Research](research.md) retains the reference mechanisms and pricing rationale.
