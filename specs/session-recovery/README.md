# Session recovery

Make session state converge after interruptions and failures without repeating customer work. The production audit found three backend-running/VM-interrupted conversations, failed pause sweeps against missing agent roots, two recurring transition failures, and three inactive unfinished relays still grouped as running.

## Next Agent Prompt

Duet gateway/backend changes are pushed to `staging`; the staging bucket migration completed after scanning 137 sessions. Agent changes remain committed locally in duet-agent `main`, with the catalog still pinned to released 0.3.26. Both selected live journeys, sessions-and-jobs and relay-recovery, pass with cleanup verified and no orphaned resources. Harness contract drift was corrected, and deliberate reboot sequences now wait for gateway health certification. Production and customer VMs remain untouched. Remaining release work is the agent package release/catalog update, resolution or baseline attribution of the broad-suite timeouts, then a separately authorized production rollout and migration.

- [x] Stop settlement and restart convergence.
- [x] Persist the journal materialization frontier; prove newer prompt/wake, acknowledgement crashes, corruption, and explicit legacy recovery.
- [x] Conditional checkpoint-to-backend reconciliation, including old persisted checkpoints.
- [x] Actionable transition suspension without repeating completed work; queued input respects parent control boundaries.
- [x] Correct interrupted relay grouping and persisted discovery projection (b4d089df6; migration completed on staging; production remains pending).
- [x] Reproduced and fixed final tool-result compaction losing its matching call; historical requests remain unavailable.
- [x] Added and verified future-state edits without executing them or changing the wake.
- [x] Final implementation review, focused regressions, and commits.
- [ ] Clean broad local gates: remaining Convex and training-store timeouts are documented below.
- [x] Staging gateway/backend rollout and interrupted-session bucket migration.
- [x] Selected `sessions-and-jobs` live journey.
- [x] Final `relay-recovery` live journey.
- [ ] Agent release/catalog update and separately authorized production rollout.

## Contracts

The gateway owns whether a process exists and its private checkpoint. The backend owns session/discovery projections. The agent owns actual task execution and state-machine decisions. An observation that work stopped must never be treated as permission to resume it.

A stopped checkpoint cannot override newer user input or a newer timer execution. Envelope acceptedThroughSeq is not inherently checkpoint provenance. Reconciliation needs a conditional transaction and explicit evidence; replaying a terminal through the ordinary event path is insufficient. A legacy record that cannot prove coverage stays inconclusive rather than fabricating completion.

Pausing must settle without starting model work when no process exists. Missing roots cannot heal by repeatedly attempting the same launch. Persist enough stop state to survive gateway restart while preserving the native checkpoint for an explicit resume.

Transition exhaustion must retain the completed state's result and the parent's outstanding selection obligation. Recovery may retry that selection; it must not automatically run the completed state again. Recurrence is currently graph intent, so do not introduce an inferred recurring-job subsystem or automatically revive archived/failed jobs.

## Scope and verification

The audit is `/tmp/production-session-audit-2026-09-26.md`. Raw customer data remains outside the repository; tests use synthetic fixtures. Existing model/provider errors and sleeping-job edit limitations require reproductions before implementation claims. Approval parks, billing blocks, explicit interruption, and provider capability restrictions remain respected.

Three independent planning passes agreed on input/turn fencing, durable stop settlement, and parent-only transition recovery. The fewest-slices plan groups shared lifecycle owners; risk and seam reviews require separate red/green proofs for every ordering boundary. No new table, cron, status enum, or compatibility adapter is assumed: choose the smallest contract after reproducing the first case.

## Current evidence

The root Duet suite completed once: 20 of 23 package tasks passed; backend, gateway, and API reported failures. Fresh backend reruns passed all 12 selected session/recovery cases, including the canonical terminal's input coverage; the separate billing-burst fixture still exceeded Convex's one-second function limit. The serial API rerun passed 32 of 40 cases, including session recovery and VM sync. Five admin cases still hit execution limits; the large share-list fixture timed out and its backend shutdown caused two subsequent failures. These remain unresolved gate failures, not claimed green or proven unrelated baseline defects.

The complete final gateway suite passed: 1,352 tests, two existing skips, zero failures. Its quiesce fixture now observes sync completion while interruption remains held, with unconditional cleanup and independent review. Visual-coverage ownership, visual union, public assets, backend typechecks, and scoped format/lint checks passed.

The final isolated agent Docker sweep ran all 1,369 tests: 1,368 passed and one unrelated training-store case exceeded its five-second timeout. All recovery, provider, and parent-control cases passed. The two earlier obsolete usage fixtures were corrected with their cost assertions preserved. The focused Docker rerun passed two cases and repeated that timeout at 5.1 seconds against the unchanged five-second limit. No assertion or timeout was relaxed.

Production changes were independently reviewed. Tests cover newer input, autonomous timer turns sharing an input cursor, temporary API failure, durable stop, journal acknowledgement crashes, corrupt records, explicit legacy recovery, and parent continuation without repeating completed work. Historical provider requests were unavailable, so the reproduced compaction defect does not establish that every historical provider error is resolved.

The follow-up review corrected edited-queue restoration alongside retained steering input, including stale queued commands in saved checkpoints. All three regression cases failed before correction; all 277 turn-runner Docker tests now pass. Fresh gateway and backend recovery/migration checks also pass (77 tests). The earlier broad-suite timeout limits remain unresolved.

The staging migration completed successfully with 137 rows scanned. The [sessions-and-jobs run](https://github.com/aomni-com/duet/actions/runs/36251689777) passed with no orphaned resources after its harness was updated to the existing default-session envelope and compact job-summary contracts. Early relay-recovery runs deliberately rebooted a probationary release repeatedly and triggered rollback; the resulting older gateway hydrated on repeated Stop. The journey now requires the announced release's persisted health certification before beginning those reboots, while preserving every no-restart assertion. The readiness regression and existing boot-health/rollback tests pass. The [final relay-recovery run](https://github.com/aomni-com/duet/actions/runs/36253059679) passed against gateway `0.0.0+77c2a65ddfe9`: sleep/wake across reboot, interruption and resume, active-session restart, fresh-prompt completion, repeated Stop without another turn, and 1 KiB tool previews. Cleanup passed with no orphaned resources. Certification setup allows the existing five-minute idle sync cadence; recovery assertions and production rollback rules are unchanged. These live runs use released agent 0.3.26 and do not validate the unreleased agent changes. No customer VM was modified.
