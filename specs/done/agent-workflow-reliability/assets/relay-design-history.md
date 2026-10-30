# Relay design history and preservation requirements

Reviewed 2026-09-28 against the local duet-agent Git history and shipped task-layer rationale. Commit messages describe the authors' evidence at the time; those historical eval results were not rerun for this review.

| Source | Why the existing design exists | Consequence for this plan |
| --- | --- | --- |
| `d76328af47529c3bcf45a5892a0bceedef2cbd58` — explicit input routing | Durable work resumes through explicit schema-validated transition input and templates, without hidden shared state | Keep templates as the deliberate data-selection boundary; do not automatically inject every input key |
| `5be2e36d7a505bb27b4a0aa0f0cdf9574768bc3d` — scope workers to current state | Planning workers were doing downstream implementation themselves; state identity and full state map prevent overreach | Preserve fresh contexts and state-local responsibility, including negative scope tests |
| `95d7973adcc2aec482bb26a236efae0e015f8ee3` — parent owns routing | Workers report; parent chooses next state. Instructions to workers to route caused failures | No independent worker decision/approval channel |
| `3999c36ba1a1d9b59aac18b4c5d5d4f31a0cdd63` — verify and correct workers | Parent accepted false worker reports and merely apologized when user contradicted them; a falsified eval drove actual prompt correction | Preserve verification and tuned re-selection, not blind trust or automatic bypass |
| `c1cd25913e9d81e255b139033b5e9de539face22` — persistent overrides | Corrected instructions should survive later runs without being passed repeatedly; one-shot probes explicitly opt out | Existing definition is the durable correction owner; a second raw-user-message ledger is unnecessary until disproven |
| `9c8ca2aa6a66f16c722e2829c917c9cc0277cdaf` — carry-forward at transition | GLM narrated findings but omitted them from handoff. Commit reports a completion-boundary reminder improved a real-session eval from 0/N to about 7/8, while another system-prompt copy gave no lift | Evaluate correction at the actual transition, not by adding repeated global reminders |
| `b6dfec821b306dab6bb3ee5c79969cabd9e95bb8` — forkContext | Explicit escape hatch when restatement loses context; retain exact parent prompt prefix for caching, count only new worker usage, honor restricted skill lists | Keep opt-in fork semantics and cache/skill/usage regression gates |
| `93fc452cbc740e4b7c814039206a839f65c6c0ad` — forked worker identity | Full parent history made workers act like the parent continuing its conversation | Any context change must preserve worker identity, not just prove a sentinel was copied |
| `b940443af8a8dffa24e593c4dadcc2fa624fa9ab` — remove decision.kind | Redundant kind led GPT to guess invalid action verbs and loop; state name already determines dispatch | Simpler tool grammar can help, but history does not prove flattening decision is needed. Keep one current shape and test admission first |
| `33011286853fefb4da93cd386c98ac7e0bf5fc69` — edit future state without execution | Change a sleeping relay's future instructions while preserving current state, wake, and input; live state changes require explicit restart | Use update_state_machine_state for future corrections, not re-selection merely to edit |
| `29ee7d90b7556116e4b59e61bd28026b5c76e474` — poll success loop | Exit-0 poll skipped intended delay and looped; specific misconfigured-gate guard fixed it | Keep poll semantics separate from agent retry diagnostics |
| `273c37a37f3327d9305257d31382ffb002a38cae` — advisor loop bound | Advisor-requested verification was rearming mandatory reviews | Disabling advisors remains user direction; do not build another reviewer loop |

The shipped `duet-agent/specs/done/task-layer/README.md` and `choices.md` establish one task constructor, one parent decision loop, quiescent terminals, explicit stops rather than timeout kills, and settlement delivery outside the SDK steer/followUp queues. Their regression history includes a transition-enforcement bug that reran successful async states. New diagnostics must not recreate that behavior.

## Revised decisions

The first draft overreached by prescribing a raw user-command ledger, automatic input blocks, and a flat selector before checking why existing mechanisms existed. Those proposals are superseded here and in their owning slices.

Keep `decision` nesting for this implementation; strictly reject misplaced fields, teach complete paths, and verify real-model recovery. No special architectural rationale for the outer nesting was found beyond its historical decision envelope. That is not proof a breaking rename improves outcomes. If corrected teaching/admission still fails live evals, a separately bounded matched-input experiment can compare a flat grammar before reslicing; no dual-shape compatibility parser.

Keep fresh workers, explicit template/override delivery, persistent definitions, optional forkContext, and edit-without-run. Strengthen evidence at those seams and measure whether corrections survive. Do not globally forward all user messages, automatically activate forkContext, or introduce a second persistence owner.

Terminal selection is an escape path: selecting failed/cancelled without override/input must always work regardless of the previous state's missing input or invalid cwd. Extraneous terminal override/input can produce an explicit error, but recovery with a minimal terminal selection must be tested immediately.
