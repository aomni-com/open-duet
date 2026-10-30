# Recent jobs from Build default chats

Build's displayed default chat gets a Recent jobs modal of unarchived direct children across assigned agents. Selecting a row opens Work. Root and agent default chats share desktop/mobile behavior, status grouping and pagination. Work's sidebar and existing jobs panel retain their behavior; deeper delegation discovery is outside scope.

The existing default-chat alias and parent-ID children endpoint own the data. No new schema, endpoint or query parameter.

## Next Agent Prompt

Implementation and cleanup are committed in `4e1cc20a3` and `207fc5e73`. Feature, visual and review gates pass. Repository closeout remains unresolved: unchanged deployment-backed tests have local Convex startup failures and execution timeouts. The earlier zero-cost billing failure is not an established product defect; an isolated diagnostic passed its original assertions. A disposable trailing-output diagnostic captured `400 InvalidModules`: pushed-module loading exceeded the local backend’s four-second execution limit. Next: restore reliable local deployment setup, finish the unexecuted deployment-backed and API checks, then archive the audited rationale. Do not mark this spec complete while the global gate is unresolved.

## Gates

- [x] Root and agent default-chat children are discoverable across owners; unrelated rows stay out. Current default pointer owns discovery, including first-message creation.
- [x] Modal-only child requests/polling, bounded empty-page draining, status groups and manual older-page continuation.
- [x] Initial/continuation retry recovery, preserved loaded rows, empty/loading states, archive pointer clearing, Escape/focus restoration and mobile alignment.
- [x] Matched production-route header comparison, frozen modal states, final unprimed visual acceptance and nonblocking Preview checkpoint.
- [x] Narrow query tests, web unit suite, types/lint/build, visual owner union and asset verification. Final independent code review reports no actionable issues.
- [ ] Clean repository closeout. One root attempt produced local Convex push failures and execution timeouts in unchanged backend code; it was stopped after failures to release resources. Isolated marketplace and fleet reprovision retries passed. A billing diagnostic passed, while the subsequent repository-source retry failed before assertions during deployment setup. Additional backend unit coverage passed 466 tests with one timing failure that passed alone. Remaining deployment-backed files and the API package have not completed verification.
- [ ] Archive with close-spec after the global gate is settled. The proposed rationale at `/tmp/duet-build-jobs-rationale.md` and final choices already passed independent claim audits.

## Evidence

- `/tmp/duet-build-jobs-query-tests.log`: 64 pass.
- `/tmp/duet-build-jobs-closeout-visual.log`: 10 desktop/mobile cases pass, including existing Work Recent jobs.
- `/tmp/duet-build-jobs-cleanup-visual.log`: 11 pass, one desktop skip; existing mobile Work app viewer still dismisses and restores focus with Radix owning Escape.
- `/tmp/duet-build-jobs-root-closeout.log`: web 1,918 pass; broad repository attempt fails and was terminated after failures.
- `/tmp/duet-build-jobs-isolated-backend.log`: previously failed marketplace sweep passes in isolation.
- `/tmp/duet-build-jobs-retry-0.log`: isolated model-gateway billing groups, four pass and one fail; `/tmp/duet-build-jobs-billing-diagnostic.log`: the same billing scenario passes its original assertions in a scratch diagnostic.
- `/tmp/duet-build-jobs-retry-v2-0.log`: repository-source retry fails in deployment setup before the billing scenario executes.
- `/tmp/duet-build-jobs-backend-unit-closeout.log`: additional backend unit coverage, 466 pass and one fleet timing failure; that case passes alone.
- `/tmp/duet-build-jobs-startup-drain.log`: disposable harness diagnostic captures the underlying four-second module-loading timeout; assertions never execute.
- `/tmp/duet-build-jobs-retry-plan.json`: exact failed selections and unexecuted backend files for subsequent narrow verification; `api` is the unexecuted package.

## Visual standard and choices

The [saved assets](assets/) preserve pre-change headers, matched header comparisons, modal/empty/loading states and [review evidence](assets/review-evidence.md). Fresh critique led to visible row arrows and scoped mobile icon centering. Preview proceeded with those choices on the evidence. [Implementation choices](choices.md) records the final product tradeoffs.
