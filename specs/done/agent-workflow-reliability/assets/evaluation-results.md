# Evaluation evidence

These results describe unreleased candidates. Current runtime
`866c21412dff14fe34ea6e8092d130d082202f62` adds the initial-state semantic
admission guard: an unknown `firstState` must fail before replacement or worker
effects. Focused goal confirmation and a fresh bounded outcome gate remain.
[Its CI](https://github.com/Example User/duet-agent/actions/runs/36493508536) is pending
at this checkpoint. Prior evaluator source `ec5938d` passed
[CI](https://github.com/Example User/duet-agent/actions/runs/36491741747).

## Completed preceding candidate

Runtime `5501cf316410f228a3e7df5baad3bd86dfa329de` passed all three outcome
scenarios on Economy, Balanced, and Frontier under evaluator source
`ec5938df27d42ed9607f67f602cc67ae35d688c4`, explicitly using `gpt-6-astra`.
Frontier required nine actor attempts. Economy completed correction with three
consecutive passes, populated search with four, and outage with three.
Balanced populated-search attempts 1–5 retain their transport failures; the
user explicitly authorized three replacements, and attempts 6–8 all passed.
Its correction and outage scenarios also achieved three consecutive passes.
This qualifies the preceding runtime only, not the new admission guard.

Evaluator repairs include native script execution evidence and material-operation
judgment: observed result comparisons are not rejected for imprecise terminology
or missing unrequested adversarial cases. Six frozen Astra controls accepted three
supported reports while retaining rejection of unperformed HTTP verification,
fabricated named tests, and an unsupported definite cause. Calibration inputs,
receipts, and helper identity are in `/tmp/workflow-material-operations-research`.
Rejudgments preserve raw events, exact public reports, independent outcome checks,
and original verdicts; they do not rerun actor work. All outcomes remain under
`/tmp/workflow-candidate-evidence/5501cf316410f228a3e7df5baad3bd86dfa329de`.

## Latest preservation cohort

All 75 selected files ran once against source `fcee58e`, whose actor runtime is
unchanged from `5501cf3`: 68 files passed and seven failed. The
[per-file ledger](preservation-fcee-results.jsonl) preserves original results
under `/tmp/workflow-preservation-fcee58e-shard{0,1,2}`.

| Failed file | Current interpretation |
| --- | --- |
| session-resume-history | Timeout; retain the result without increasing limits. |
| state-machine-usage-by-model | Stale model-alias assertion; eval-only repair in progress. |
| goal-command | Exposed an unknown initial-state admission failure; the new runtime guard requires separate confirmation. |
| advisor-context-compaction | Opt-in advisor preservation failure; retain the audit without tuning advisor policy. |
| advisor-challenges-narrow-fix | Two tests passed; one timed out at 120 seconds and one failed because advice reopened broader implementation scope. |
| advisor-trigger | Opt-in consultation expected but no advisor call occurred. |
| model-routing-step-trigger | Two stale model-alias assertions; eval-only repair in progress. |

No universal-green or no-regression conclusion follows from this cohort.
Shipped compound advisor defaults remain disabled; opt-in misses are not
authorization to strengthen or promote advisor behavior.

## Earlier candidate identities

Runtime `529aa4ce5b7e421a6ece7de7f61c5d3fee913b27` passed 1,428 tests,
build, and lint ([CI](https://github.com/Example User/duet-agent/actions/runs/36478326234)),
but failed its outcome gate as recorded below. Evaluator repairs did not erase
that failed candidate.

## Earlier failed outcome gate

Frontier and Balanced each passed all nine required runs. Economy correction
attempts were pass, control-order failure, report rejection, report rejection,
pass. Attempt 3's rejection was an evaluator false positive; attempt 4's was real:
a worker observed a direct function call throwing, and the parent described a
verified end-to-end HTTP 503 check. No such HTTP failure probe was recorded.
Attempt 2 asked before parking, so its second control action was
rejected. Even correcting attempt 3's verdict cannot satisfy three consecutive
passes within the five-started-attempt cap. This candidate failed the gate;
its later Economy scenarios were not started.

The earlier `62198d7` candidate also failed Economy: one report invented a
provider restart as the definite cause of a timeout. Keep its evidence. A new
judge or corrected rubric does not reset actor attempt counts.

Raw outcome evidence: `/tmp/workflow-candidate-evidence/<actor>/<tier>`.

## Earlier preservation coverage

All 74 selected files ran (70 live, four deterministic); original results were
64 passing files and ten failing files. The [per-file ledger](preservation-results.jsonl)
preserves every initial result. Follow-ups below do not overwrite that ledger.

| Failed file | Follow-up and interpretation |
| --- | --- |
| model-routing-mixed-task | Fixture expected a stale classifier ID. Resolve the configured table's actual classifier; focused live run passed 39 assertions. |
| session-resume-history | Startup timed out before model execution. Unchanged isolated run passed 60 assertions at the original 30-second limit. |
| recall-memory-cross-session | Failed with host-mounted scratch; passed unchanged using canonical container-local scratch in isolation: four tests and eight assertions. |
| recall-memory-implicit-triggers | Failed with host-mounted scratch; canonical scratch in isolation passed all seven tests and 14 assertions. |
| session-loop-wire-starvation | Canonical scratch passed the unchanged test and seven assertions in 4.74 seconds. |
| goal-command | Skipped the prescribed initial park on both earlier and current runtimes. Independent evaluation detected and repaired missing work; this is not established as a new regression. |
| state-machine-routing | Three matched old/new trials: old 3/3, current 2/3. The failing current run persisted a terminal-only plan. A real planning deficiency; this small sample cannot establish causation. |
| advisor-challenges-narrow-fix | Original advice respected scope but lacked regex keywords. Semantic positive/negative controls pass. A fresh live sample legitimately failed because it reopened broader implementation scope; retain that failure. |
| advisor-trigger | Explicit opt-in advisor architecture case missed consultation on both allowed attempts; existing test documents noisy consultation. Other five cases passed. Shipped advisors remain off. |
| model-routing-step-trigger | Both cases classified as general rather than implementation. The reporting-prompt change does not enter the classifier input. Real classifier quality miss; no demonstrated changed-input regression. |

Host-mounted scratch differs from the canonical runner, so those runs cannot
isolate a product timing regression. The follow-ups also reduced concurrent load;
they do not establish storage placement as the sole cause. No timeouts were raised. Evidence directories: `/tmp/workflow-preservation-529aa4c-shard{0,1,2}`,
`/tmp/workflow-resume-history-isolated`,
`/tmp/workflow-cross-session-isolation-localtmp-529aa`,
`/tmp/workflow-preservation-529aa4c-recall-wire-localtmp`,
`/tmp/workflow-routing-paired`, and `/tmp/workflow-mixed-routing-classifier-check`.

## Reporting investigation

The calibrated Astra evaluator matched six fixed positive/negative controls,
including accepting an explicitly uncertain hypothesis and rejecting invented
verification and a definite unsupported cause. This is calibration, not an
estimated error rate. Original judgments remain recorded.

The first diagnostic replay batch accidentally used the startup reasoning level
(`low`) instead of the saved final route (`medium`). Its results cannot establish
an exact replay improvement. The corrected protocol is frozen in
`/tmp/workflow-report-research-v2/plan.json`: three baseline cases, then the same
three cases with one evidence-provenance instruction, six actor calls maximum,
fixed Astra evaluator, no tools executed. Neither diagnostic batch counts as a
task-matrix pass. The corrected batch completed all six calls: baseline verdicts
were accepted/rejected/accepted; the candidate was accepted/rejected/rejected.
The candidate retained the definite unsupported cause and offered no clear
improvement. Similar supported-report wording received inconsistent judgments,
so these small counts are not reliable effect-size estimates. Do not promote
the candidate or restart the task matrix from this evidence.

The staging evidence parser now recognizes the actual wrapped retry reminder; its
red/green reproduction and six other checks pass (seven tests, nine assertions).
The package typecheck still cannot resolve the unpublished fixture export.

No package publication, Duet dependency pin, or live staging journey has occurred.
Those await the latest runtime qualification and preservation review; unit CI alone
cannot close this spec or support a no-regression claim.

## Protocol-teaching repair after the failed candidate

The continuation audit found invalid selection paths in dynamic reminders and
creation-time cwd errors, including `override.prompt` and `override.cwd`. The
repair qualifies selection guidance with `decision` and preserves the distinct
valid definition and update-state argument shapes. A guided-recovery test
failed when the old error text produced an inadmissible top-level override,
then passed using the corrected path.

A separate [saved-context comparison](control-order-comparison.json) tested
one-control-per-parent-pass wording and the real continuation after parking.
Baseline responses batched ask and select in all three trials; revised responses
selected park alone in all three. The six-call protocol retained the actual
model and medium reasoning, executed no tools, and used no retries. This is
evidence for a narrow instruction repair, not an accepted outcome run.

The suspected mandatory-check duplication did not reproduce in its one bounded
real-script probe: the existing parent ran the check once and advanced to done,
with unchanged test and artifact bytes. Verification policy is unchanged.

Any new candidate must be frozen before confirmation, use the calibrated judge
explicitly throughout its cohort, and retain the old candidate's failed verdict.
The reporting failure remains a required outcome check, not a claimed repair.

## Runtime 866 final confirmation

Actor `866c21412dff14fe34ea6e8092d130d082202f62` adds semantic rejection of unknown initial states before relay creation. Source `ffac54f` repairs stale alias assertions; `3f573cc` supplies the required initial state in a clock test helper. Neither latter commit changes runtime behavior. CI 36494399366 passed after the clock fixture correction.

Balanced and Frontier each passed three consecutive runs in all three scenarios. Economy correction passed 1–3; populated search failed 1 then passed 2–4. Economy outage passed 1, rejected 2–3, passed 4–5: the candidate fails the consecutive-pass gate and has no remaining starts. Outage 2 claimed search worked despite all live queries returning 503. Outage 3 asserted a deliberate block rather than misconfiguration from 503/400/405 responses, which establish availability but not cause. These are material reporting failures, not evaluator transport errors. Original reports, requests, events and verdicts remain under `/tmp/workflow-candidate-evidence/866c21412dff14fe34ea6e8092d130d082202f62`.

The focused `/goal` run under `/tmp/workflow-preservation-866-goal` used valid initial state `evaluate`, completed incomplete/complete evaluator rounds, and failed the initial-park assertion. It did not reproduce the malformed-state fatal error. The other 74 preservation files are running in `/tmp/workflow-preservation-866-final-shard{0,1,2}` with source ffac54f, image `sha256:c26087be41d883a9a4e16cfd9c2ff1cfd165f57795a9ad08c5ffab88ef053ff1`, explicit Sol judge, and unchanged test timeouts. Their inventory hash is `9f456a98b637b366f5489ca63e7d08fc5154e80b7e57ce0d2022b0ce148b9c1f`. No repeated goal run is needed to complete that inventory.

### Saved-report comparison after the failed 866 gate

The bounded [comparison](reporting-comparison-866.json) replayed three exact saved parent histories with their final answer removed, actual DeepSeek medium reasoning, frozen runtime image and unchanged Astra judge. Tools were advertised but never executed. Baseline accepted 5/9 reports; an opening-status instruction accepted 2/3; a stronger evidence-versus-prior-reasoning instruction accepted 7/9 after replication. The latter still asserted a deliberate outage, guaranteed future success, and overstated retry coverage. Neither instruction is promoted. These are diagnostic model calls, not full-task outcomes or permission to reset the exhausted candidate. Further work must address the demonstrated failure rather than repeat the same prompt wording until a sample passes.

### Completed 866 preservation and user-directed model comparison

The 74-file run plus the separately retained `/goal` result completed with 70/75 passing files; [all results](preservation-866-results.jsonl) are preserved. No old final-shard directory was reused. Interrupt/resume added `rerun: true` to transition input where the scenario required the same input. Advisor triggering missed the explicit opt-in call. Advisor compaction omitted the archived marker in its answer. Vision fallback itself passed after the alias fix; the no-fallback case chose the general route rather than the expected implementation route. The initial-park failure remains the earlier final-runtime result. No timeout increase or result deletion was used.

The user subsequently requested testing Balanced instead, supporting Sonnet 5.5, and making it Balanced's default. Vercel's public model catalog confirms `anthropic/claude-sonnet-5.5`, tool/vision/reasoning support, 1M context and 128K output. The next comparison holds saved report context and the existing judge fixed across models. This supersedes the prior prohibition on these Balanced target changes; it does not erase Economy's failed outcome gate.

### Balanced model comparison and integrated Sonnet support

The user-requested [fixed-context comparison](report-model-comparison.json) completed 18 model calls and 16 Astra judgments. GPT-6 Sol medium accepted 7/9 and requested additional tools in two cases (inconclusive; tools never executed). Sonnet 5.5 medium accepted 6/9 and misstated executed checks/history in three. System prompt, tools, messages, context and judge matched the saved baseline. This does not prove a pure Economy defect or that Sonnet eliminates reporting errors. No model-only replay counts as a full-task pass.

Actor `1402655ff1f4ceecf0c10922c6f246418df5abca` integrates gateway Sonnet 5.5 support and Balanced Sonnet defaults. Explicit older Sonnet versions retain their target; capabilities and cost come from the public provider contract. A live medium tool call passed. Integrated Docker coverage passed 81 tests/476 assertions, and fresh/resumed Balanced dispatch is covered. CI 36500681521 and the bounded Balanced outcome matrix are running; first correction/release passed. No release is claimed.

### Nominal provider defect found during 140 confirmation

The controlled provider only returned `person-ada` and `job-platform`; no request could return `person-bo` or `job-designer`. The task README promised literal email/company and natural-language matching across populated People and Jobs, and the immutable dataset contained Bo/Studio/designer records. The independent probes tested only first-row positives, so they missed this impossible part of the nominal task. Slice 05 did not specify a partially broken provider in success scenarios; outage behavior already has its own variant. Current140 cohorts stop after in-flight attempts, preserving their exact fixture identity. A repair must expand the controlled provider and independent probes, not relax reporting judgments or rewrite old attempts. Saved-report comparisons still describe the accuracy of their exact recorded evidence; they do not establish full-task model reliability.

### Fixture repair and final Sonnet live delta

`0a3feed` repairs the shared nominal provider and expands independent probes to 16, including second-row positives and conjunctive/category negatives. Fixture revision is 2; archive SHA256 is `b77b40a888f6fd5e581124d2f1bf6fa4e9c0e5b3a3d7cb37b10db183b93011a5`. Three red/green cycles established second-row reachability, constrained matching, and neutral natural-language connectors; final focused Docker coverage passed 11 tests/49 assertions. Staging bundles the same exported provider/oracle, so no duplicate matcher or signature change is needed. Prior actor140 runs stopped after completing their in-flight tasks and do not qualify this fixture.

The Sonnet 5.5 live delta passed structured text/image output, Balanced resume, and three relay call-shape trials. Its inheritance test initially assumed a concrete model name and compared the worker's actual Sonnet 5.5 target with the virtual name `balanced`. The repaired assertion compares the actual parent and worker identities, preserves the explicit override case, and rejects substituted Haiku. Its one live repaired run passed two tests/eight assertions. The stdout/stderr file captures overlapped in that run; the artifact explicitly records this limitation and retains the successful exit/summary. Original failure and repaired source hashes remain in `/tmp/workflow-sonnet55-live-delta` and `/tmp/workflow-sonnet55-inheritance-repaired`. CI36501494134 for the Sonnet implementation plus connected-provider fixture repair passed.

### Corrected-fixture outcome closeout

Source `0cd51fb` completed all bounded cohorts under fixture revision 2. Balanced qualified all scenarios in 11 starts (one retained outage-report rejection); Frontier qualified in nine starts. Economy correction qualified in three starts, but populated search ended accepted/accepted/rejected/rejected/rejected and outage ended accepted/accepted/rejected/rejected/accepted. Neither latter sequence meets three consecutive passes within five starts. All independent search probes passed on the rejected populated-search attempts; the failures concern unsupported verification, category, or coverage claims. Outage reports additionally overstated HTTP verification and guaranteed future success without a successful provider response. No further paid runs remain active. The [complete ledger](outcomes-fixture-v2.json) preserves all 33 starts.

The exact candidate tarball built successfully but failed isolated Duet installation because its manifest references an omitted patch file. Original archive SHA256 is `ac62f4214bc961cccf265945648cca33a52bbc7c069a5e7dcbf280b7ad980b42`; evidence is `/tmp/workflow-package-0cd51fb`. Downstream installed-package checks have not passed. Follow-up classification: published 0.3.29 reproduces the local-file tarball failure, but a fresh normal registry install passes with Bun 1.3.14. Including the patch file does not fix the local-file path because Bun resolves it against the consuming project. This establishes a trial-path limitation, not a registry publication defect; packaging remains unchanged while a registry-equivalent trial is checked. The Economy release decision remains separate.

The bounded package-path diagnosis also reproduced the failure using the original archive over HTTP. Normal registry installation succeeds; no packaging or auth changes were made. Isolated routing export/typechecks remain unverified because the tarball trial could not install; exact published-package checks remain a closeout requirement. Scratch servers were stopped.

A separate retained-evidence audit inspected 164 event files across seven actor revisions. No run contained the unchanged-execution diagnostic or `unchangedFrom`; the goal failures exercised only two identical executions, below its three-attempt threshold. Deterministic tests prove diagnostic delivery, and correction journeys prove changes after user input, but neither proves live recovery after this warning. Slice 03 retains that narrow verification gap.

### Isolated installed-package verification

A temporary local registry metadata facade installed the original `0cd51fb` tarball without changing its bytes. The [integration receipt](package-integration.json) records matching fixture hash, routing export/check, gateway and test-harness types, 23 contract-tier tests, and four receipt/fresh-resumed advisor tests. Gateway typechecking first exposed widened fixture discriminants and possibly absent routing status; the focused test-only fixes then passed. The original provider-failure alias case timed out and was not retried. This verifies package integration before publication; it does not replace normal registry pinning, full Duet closeout, or deployed staging journeys. The temporary server was stopped and registry configuration restored.

### Live unchanged-execution recovery path

Eval-only `d5449bb` adds a narrow warning-path check on unchanged runtime `0cd51fb`. Three real script executions create identical settled history and trigger the production diagnostic; each of three subsequent live Balanced/Sonnet 5.5 continuations selected a failed terminal naming the missing external approval, without fabricating that file or starting another identical script. Two offline controls reject repeated unchanged work and suppressed warning evidence. Five tests/38 assertions passed. [The receipt](retry-recovery-results.json) explicitly records forced initial selections and the instruction to report a missing approval as blocked. This proves model use of the live recovery path, not causal warning superiority, autonomous discovery of a loop, or full-report truth. Final type guards were replayed against the saved samples without additional paid calls. Runtime and fixture bytes did not change, so no outcome caps reset.

### Pre-feature comparison of the five preservation failures

Untouched runtime `3bc0ea` with its frozen dependencies ran the five exact failed cases using current eval-only fixtures and the same explicit Sol judge, original timeouts, and existing attempt limits. No runtime patch or model override was applied. The [identity and results](preservation-baseline-five.json) retain all starts. Initial park was again omitted; advisor-trigger's first internal attempt consulted but missed reclassification capture, and its second omitted consultation as the candidate did. These symptoms therefore occurred before this feature, without establishing equal failure rates. The baseline passed transition-input preservation, archived-marker retention, and the expected no-fallback implementation route. Their candidate failures remain unresolved regression risks; one baseline pass cannot determine causality or waive a gate. All five processes completed and their containers were cleaned up.

Paired transcript inspection found no concrete new code mechanism to repair for the three differences. Transition input permits extra keys and the runner forwards it unchanged; retained traces do not include the raw selection establishing where `rerun: true` originated. Both advisor runs included six messages, compacted two, omitted none, and executed the custom opt-in advisor; actual summary/request bodies were not retained, so marker loss versus answer omission cannot be distinguished. Classifier/router code, dependencies, and Economy routing were unchanged; both saw an image-triggered reclassification, but one chose implementation and the other general. Missing request bodies prevent isolating prompt-mediated effects from sampling. These limitations prohibit a no-regression claim; they do not justify filtering valid input or changing unrelated model behavior without evidence.

### Full Duet closeout stopped at disk capacity

The single `bun run test` in the isolated installed-package trial was stopped with SIGTERM after 1:04:51 when the host reported 100% disk capacity and about 1.7 GiB available. The [complete partial receipt](duet-closeout-partial.json) retains source, artifact and lock identities, all 86 backend failure markers, completed package summaries, and raw evidence paths. No full-suite retry occurred. Gateway passed 1,356 tests with two skips; the harness passed 332 with four skips; web passed 1,901. Backend reached 859 passes and 86 failures before interruption: 78 function execution timeouts, one startup timeout, one deployment setup error, one isolate error, four auth-code uniqueness errors, and one eventual-state assertion. There is no final Turbo aggregate, and post-Turbo visual/asset checks were not reached.

Gateway checkpoint/replay and backend cursor-safe document replay both preserved the new receipts in this run. Those passes do not waive the broader failed/incomplete gate. The lockfile changed only the agent catalog/package entry, excluding unrelated dependency version drift; neither that check nor late disk capacity establishes the cause of the earlier timeouts. All 11 captured owned processes exited. Three gateway fixture processes lacking proven ownership were left untouched. Cleanup removed only three reinstallable diagnostic node_modules directories and preserved source, manifests, lockfiles, tarballs, logs, and all eval artifacts; available space increased to about 3.2 GiB. No shared Docker images/volumes, worktrees, or unrelated files were removed.

### Focused timeout control after disk cleanup

After user-authorized cleanup, one previously timed-out disposable-signup case passed with six assertions and unchanged test limits. It used a fresh local fixture on the root checkout with installed agent 0.3.29; the test source matched the failed package trial. [Control identity and limits](backend-timeout-control.json) record that distinction. This establishes only that the timeout did not recur in this control. It neither proves disk was the cause nor qualifies candidate 0.3.30, and does not replace the aborted full run. No backend production source changed in this feature; the backend diff contains tests only. No further retries were started.

### Remaining static closeout checks

The three post-Turbo checks that the aborted full run never reached passed separately on the root checkout: shared UI visual coverage, visual-owner union/contact-sheet index, and asset ownership/reachability. [The receipt](static-closeout.json) records commands and source identity. They changed no implementation or baseline. These are static checks, not screenshot rendering or deployed journeys, and they do not turn the interrupted backend suite or failed model gates green.

### Review baseline accounting

The feature baseline combines original Duet head `265a679e3` with unrelated upstream staging `bb5946c83`; `git merge-tree --write-tree` produces tree `27554faa2cd4c28a6082811df2e462195d60a76f`. Compare against that combined baseline so neither the pre-existing subscription-preflight test repair nor upstream Crustdata work is attributed to this feature. The feature's backend diff is only the receipt replay test; no backend production source changed.

The concurrent skill-only commit `a8b2f8f40` was pushed by another task while verification ran. It changes no application/test source; preserve it and exclude it from feature sizing. Adding its audit-tests skill blob to the combined baseline produces current comparison tree `42fcf7c61693b1cc0d181e94927b12590b7769e0`. The Docker source snapshot remains valid for application/test code.

### Published package and remaining local gate

Agent 0.3.30 publication succeeded at `0583f6d`; every packaged file matches the qualified runtime archive. The [published-package receipt](published-package.json) records real registry integration and passing routing, tier, and type checks. Duet pin commit `fd75b6364` is committed locally.

The [host continuation](duet-serial-continuation.json) and [Linux continuation](duet-linux-check.json) retain additional local failures without changing assertions or deadlines. Linux model-gateway passed its whole package; backend stopped at a Convex one-second function timeout. API reached 16 passes and two fixture deployment failures before test bodies. The captured generic push errors do not establish their cause. Thirty-three backend files remain unverified. A local-gate exception question is pending; neither it nor staging qualification is implied by agent publication.

A subsequent continuation attempted only remaining files: anchor rename (15 tests) and app replication (three tests) passed; auth requests reached nine passes then failed because verification returned `invalid_code` where `issued` was required. The cause is unresolved. The batch stopped without retries, leaving 30 files unstarted. The original 33-file checkpoint remains historical evidence.

### Whole-spec audit: prompt inspection gap in 0.3.30

The slice 03 contract promises full effective task prompt inspection. Current receipts retain a bounded preview and fingerprint, while the full prepared worker prompt is transient. Completed child messages are not durably retained by the parent checkpoint. At that audit checkpoint the requirement was incomplete. Candidate `ea997a3` subsequently implements exact retained task instructions through the existing history/checkpoint owner without inflating routine model-facing history; qualification remains pending. Published 0.3.30 qualification establishes its bounded receipts, not this missing inspection contract.

The instruction-retention candidate `ea997a3` passed 1,442 CI tests, controlled old/new replay, and three targeted live cases. Those checks do not replace slice 05's explicit final-change outcome gate. Release workflow `36522648812` was cancelled while testing, before its npm publish step. Balanced and Frontier matrices were then launched on this documented new runtime revision with the original per-scenario bounds and Astra judge; Economy's accepted limitations remain unchanged. All earlier matrices stay in evidence.

The final-change cohorts stopped after Balanced correction rejections made three consecutive passes impossible within five starts. A raw-transcript audit then established missing evaluator evidence: both cited worker SHA reports were present in completed worker outputs, and child tool origins had been flattened away. Evaluator-only `7ec20900` retains attributed reports separately from execution proof and preserves tool origins. One corrected Astra judgment per saved report accepted all five Balanced and three Frontier correction attempts, with independent outcome replay passing. Original verdicts, starts and raw events remain untouched. A synthetic negative control rejected unsupported verification despite a worker claiming it, so worker words are not promoted to execution evidence. At that checkpoint, populated-search and outage had not started; their final disposition is below.

### Final instruction-retention candidate disposition

[Actor `ea997a3` with evaluator `7ec20900`](outcomes-instruction-retention.json) finished 22 task starts: Frontier qualified all scenarios; Balanced qualified correction and populated search but exhausted outage with pass/pass/reject/reject/pass. The rejected reports correctly disclosed provider failure, but asserted a pre-change smoke-test pass. Neither executed that test before editing, and neither the README nor user prompt supplied a passing result. Code supports an expected pass, not the unqualified historical result under Verification. This is distinct from the repaired worker-attribution evidence omission; no further evaluator change or task attempt is planned.

All owned matrix containers and the host-space watcher exited. Version0.3.31 remains unpublished. The user has been asked whether to defer this debugging addition and proceed with the already-published0.3.30 fixes to staging, accepting the documented incomplete ordinary local gate. No approval has arrived; both staging journeys remain required.
