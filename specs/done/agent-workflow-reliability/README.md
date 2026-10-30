# Agent workflow reliability

Duet rejects malformed relay controls before they can silently discard requested instructions. Accepted corrections travel through the existing input and checkpoint lifecycle. Bounded execution receipts distinguish selected work from work actually delivered. Shipped compound presets disable advisors; Balanced uses Sonnet 5.5 for its general, planning, implementation and writing routes.

The motivating [Search and Nova sessions](assets/incident-evidence.md) exposed different failures. Search repeatedly supplied overrides outside the selector's accepted envelope. Nova used the correct shape but still drifted and reported insufficiently verified outcomes. Strict parsing fixes the former; it cannot guarantee good judgment or truthful completion in every task.

## Why these boundaries remain

The parent owns routing, durable state definitions and user interaction; workers receive scoped instructions. The [historical design review](assets/relay-design-history.md) supports retaining that ownership rather than adding an intent database, forwarding every parent message, or flattening the selector API. A current correction must affect actual worker construction, not just the parent's acknowledgment.

Raw tool admission runs before generic SDK coercion, after any tool-owned argument preparation. Fixed control envelopes reject unknown fields; explicitly open user-data maps remain open. Errors identify bounded field paths without echoing argument values. The hard cutover changes new calls, not saved history: old calls are never replayed as new requests, and no data migration or compatibility parser is introduced.

An accepted selector call is not proof that a worker started. Receipts attach to the existing history after executor construction and carry the same identity at actual start. Fingerprints compare rendered work, directory and inherited context; unused input keys cannot disguise an unchanged retry. A warning after three retained identical settled attempts encourages recovery without banning legitimate retries after external conditions change. Missing or evicted history is unknown, not evidence of progress.

Corrections use the existing definition-edit and selection mechanisms. Accepted relay control is applied before the remaining queued messages are delivered; checkpointed pending input can be restored and edited follow-ups replace pending copies. Explicit interruption still clears unconsumed queued work; the live journey proves preservation of an already-applied definition correction, not delivery of every accepted message across interruption. Explicit input templates and opt-in context inheritance remain the handoff mechanisms.

Advisor removal is preset policy, including managed resume and nested execution. Historical advisor messages remain readable, and separately authored configurations can still opt into the existing machinery. Already-running processes may retain loaded policy until they drain; staging evidence is not a claim that every production process has changed.

## Verification and limits

The agent package is published as **0.3.30**. Its runtime matches the qualified candidate; the subsequent evaluator-only repair preserves complete worker reports and tool provenance without changing model execution. [Publication evidence](assets/published-package.json) and [package integration](assets/package-integration.json) retain exact identities.

Both named staging journeys passed on API/backend revision `27dbea555`, gateway `0.0.0+b7e7da3fc547`, installed agent 0.3.30 and explicit Balanced/Sonnet 5.5 execution:

- [Populated search](assets/staging-search-pass.json): authenticated browser queries, positive People and Jobs results, negative queries, and independent provider invocation evidence.
- [Correction and completion](assets/staging-correction-pass.json): a user correction, intervening status input, interruption/resume, persisted effective execution evidence and the required commit/release artifact, with unrelated fixture files preserved.

Both cleaned up every recorded resource with no orphans. [Staging closeout](assets/staging-closeout.json) retains failed setup attempts too. A stale local package, an oversized DNS label and a preflight budget shorter than the normal rollout were harness/setup failures before model work; their corrections did not change the agent runtime. The rollout budget includes its staggered slot, control-plane polling and installation allowance.

The [fixture revision 2 outcomes](assets/outcomes-fixture-v2.json) qualified Balanced and Frontier. The original preservation run remains **70/75**, with baseline comparisons and narrower follow-ups retained in the [evaluation report](assets/evaluation-results.md); this is not a claim of universal regression freedom. The ordinary [full Duet run](assets/duet-closeout-partial.json) ended during disk exhaustion and subsequent [backend/API checks](assets/duet-linux-check.json) remained incomplete. The release decision proceeds on the qualified runtime, focused integration checks and the two successful deployed journeys while retaining those unresolved broad-gate results. No broad-suite green claim is made.

### Economy acceptance

Economy's current DeepSeek V4.1 Flash routing remains unchanged. Its correction outcome qualified, but populated-search/outage report-accuracy gates failed. The user explicitly accepted Economy's limitations and requested retaining the latest DeepSeek. Those failed judgments remain in the outcome evidence; this acceptance is not evidence that Economy passed them.

## Rejected additions and residual risk

Complete worker-instruction retention was an optional diagnostic experiment, not a prevention mechanism. It unnecessarily created a second release candidate and qualification cycle. It was removed; bounded receipts and previews remain. The unused 0.3.31 tag was deleted after confirming publication was skipped. Its [experimental results](assets/outcomes-instruction-retention.json) remain available, including failures; controlled parity checks did not establish that logging caused those failures.

A universal semantic release judge, automatic cancellation of repeated prompts and a second intent ledger were rejected as new product restrictions or duplicate owners. Outcome correctness is checked through independent synthetic behavior, while report accuracy uses a separate explicit evaluator. Worker statements prove what was said, not that their claimed checks ran.

Example User did not initially request relays in either investigated session; he later explicitly requested a replacement for a broken Nova relay. This motivates examining simpler default execution for ordinary edits. The [matched historical-source comparison](assets/Example User-relay-comparison.json) subsequently passed its independent search checks with relays available and disabled, but the available arm chose no relay. It therefore does not establish the effect of executing a relay or reproduce the historical loop. This release does not change when agents choose relays.

## Code and evidence ownership

- The sibling `duet-agent` repository owns tool admission, state-machine decisions/session history, input delivery and model routing in `src/turn-runner/` and `src/model-routing/`; its tests and `evals/` own deterministic and real-model preservation.
- [Gateway routing](../../../packages/gateway/src/runner/routing-config.ts) consumes the pinned export. [Session persistence](../../../packages/gateway/src/agent-sessions/) and the [shared contract](../../../packages/contract/src/agent/) carry receipts through existing storage boundaries.
- [Workflow journeys](../../../packages/test-harness/src/staging-e2e-synthetic) reuse the published fixture/oracle through the deployed API and browser. The [evidence helpers](../../../packages/test-harness/src/staging-e2e-synthetic) own release convergence and observable outcome checks.
- [Implementation choices](choices.md) records the nontrivial decisions and tradeoffs. Historical attempts remain under `assets/`; no customer transcript or customer app code is embedded in the synthetic fixtures.
