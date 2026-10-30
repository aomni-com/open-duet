# Whole-change review — 2026-09-29

Ordered pass: shape, complete diff, then documentation across Duet tree baseline `42fcf7c61693b1cc0d181e94927b12590b7769e0` and agent commit baseline `3bc0ea503c2fc1b945de3e0c79c4c967d42a38b4`. Independent Codex full-diff reviews supplemented direct lifecycle and documentation review.

Shape: existing admission, state-history, input, routing and staging-ledger owners remain coherent. No new production service or semantic approval gate was introduced. The optional full-instruction archive remains removed.

Confirmed findings and repairs:

- The agent's `evals/helpers/workflow-report.ts` drops matched native script starts on `state_failed` or `state_interrupted` and only retains completed outputs. A truthful final report about such a failure can therefore lack the corresponding runtime evidence in the report judge's input. This affects evaluator completeness, not the actor runtime. Fixed in agent `a0dca7d`: matched failed/interrupted script settlements now retain recorded errors, reasons and available partial output, including later enriched interruption snapshots. Red/green Docker coverage: 7 tests / 22 assertions; type/lint/format and independent review passed.
- Duet's `staging-e2e-synthetic` compares health to one announcement captured before a potentially long wait. A concurrent staging rollout can make the VM correctly follow a newer gateway while the journey waits for the old one. Refresh the announcement during convergence, revalidate the pinned agent, and retain the matched manifest. This does not invalidate the completed runs, whose recorded manifests and runtime versions agreed. Fixed in Duet `8f5181416`: every poll refreshes the announcement, validates the immutable agent pin, and returns the matched manifest with health. Red/green replacement-release regression and mid-wait agent-pin rejection passed; 11 tests / 21 assertions, types/lint/format and independent review passed.

Resolved documentation finding: queue retention was stated too broadly. Explicit interrupt clears unconsumed queued work (`TurnRunner.interrupt`; existing `interrupt drops queued work and emits one interrupted terminal` test). The live journey proves an already-applied definition correction survives interrupt/resume. README and choices now state that limit.

Rejected independent finding: task IDs do not universally restart at t1 on saved-session resume. `snapshotState` persists `nextTaskId`, `start` passes it into `TaskManager.recover`, and recovery preserves the monotonic counter. A fabricated repeated-id array does not demonstrate a runtime collision on this path.

Verification: the Duet independent review ran 66 focused harness/gateway tests successfully. Agent build, type, lint and format checks passed in its independent review; its Docker test attempt was denied by the review sandbox, so no new agent-suite pass is claimed. Existing live results and broad-suite limitations remain unchanged. Root-to-spec and harness documentation links resolve.

Verdict: clean after resolving both verification-tooling findings and the documentation overstatement. The earlier independent closeout audits checked final claims, but did not substitute for this complete ordered diff review.
