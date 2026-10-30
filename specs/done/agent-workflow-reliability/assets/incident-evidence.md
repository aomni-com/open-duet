# Investigation baseline

Sources inspected on 2026-09-28:

- [Search/Remote session](https://service.example.invalid/w/newera/sessions/jn7c6hrjkkkpwg3r4efcr2kdkn8f93dj), September 28.
- [Nova session](https://service.example.invalid/w/newera/sessions/jn7abj11m515nzggb4akpydg8d8ew3te), September 22–25.
- Duet source revision `265a679e3b052a1ea6fc4d1f3ca217dd994b2be0`.
- Agent source revision `3bc0ea503c2fc1b945de3e0c79c4c967d42a38b4`.

These revisions identify inspected source, not an independently established version running during each historical event. Tool results corroborate the dropped-field behavior directly. The [sanitized call reproduction](relay-call-reproduction.json) freezes the critical request/result shape. Private raw transcript exports remain outside the repository; fixtures must be synthetic and self-contained, never depend on `/tmp` investigation files.

| Observed behavior | Evidence | Owning slice / preservation check |
| --- | --- | --- |
| Misplaced overrides silently disappear | Search had 44 top-level override calls; seq 6572 requests override/input, seq 6573 returns success with only decision.state | 02: exact shape rejection before execution |
| Worker repeats original work despite correction | seq 3705 requests no additional worktree; subsequent state completion creates another | 03/04: worker consumes effective correction, correct cwd |
| Approval waiver absent from accepted handoff | seq 7091 supplies authorization outside decision | 04: effective persistent correction or opt-in fork reaches worker and survives resume |
| Circular candidate SHA prerequisite | publish-candidate requires SHA before creating commit; seq 6003/6078/6490 corrections fail to reach worker | 05: local commit journey completes without circular prerequisite |
| Search broadening narrows existing matches | advisor seq 1628, 2883, 3029 flags dropped fields and changed tests | 05: independent hidden populated-result oracle, preserved legacy matches |
| Nova verification misses positive People results | advisor seq 31116/31416 and executor admission after release | 05/06: populated People result plus actual provider invocation |
| Fake provider selected in live app | Nova code inspection seq 23089 and diagnosis seq 23091/23093 | 05: fixture has fake/real provider trap; prove execution, not prose |
| Advisor is neither absent nor sufficient | Search 35 attempts/29 responses; Nova 60/58; remaining attempts rate-limited | 01: zero new advisor calls, tool exposure, or reminders |

Counts describe these exports, not a causal estimate of token waste. Advisors caught real regressions and model-access errors but did not identify the malformed control shape in retained responses. Some advice promoted rendered text rather than public API data as the search boundary; later advice corrected that distinction. Parent execution sometimes ignored advice to stop expanding scope. The user's decision is to disable advisors rather than tune them.

Nova's transitions used the correct nesting. Do not claim the dropped-override defect explains every incident. Route/model differences are observational, not proof that a particular model caused drift. Synthetic journeys should run the shipped compound tiers and preserve actual route attribution.

## Who introduced relays

Rechecked the raw exports against user-authored `prompt_submitted` events. In Search, Example User's initial request (seq 2) asks for a remote button; the agent creates a four-step execution relay at seq 91/92. His later request to expand keyword matching (seq 669), followed by choosing Boolean option 1 (seq 726), precedes the agent's nine-step relay at seq 740. None of the ten user messages in this export explicitly requests relays.

In Nova, Example User asks to build/deploy the feature (seq 2), supplies requirements, then says to build the plan and start building (seq 720). The agent creates a fourteen-step execution relay at seq 746/747 without an explicit relay request. Later user messages reference the stuck workflow: seq 19917 asks to avoid the stale relay; seq 22290 explicitly requests a fresh replacement relay after the existing one broke. Thus the initial orchestration was agent-initiated; the later replacement was user-requested recovery. Event pairs above are tool lifecycle records, not separate relay creations.

This supports investigating simpler default execution for ordinary edits. It does not prove a no-relay counterfactual would have completed either task or explain every Nova defect; no additional routing/prompt change is included in the current release from this observation alone.
