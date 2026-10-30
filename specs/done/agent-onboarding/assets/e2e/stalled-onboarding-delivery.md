# RESOLVED: onboarding session delivery stalls — two causes

Found 2026-07-29 by Leg B of the `agent-onboarding` staging journey, which is
the first check that ever waited on an onboarding agent to act. Not reproduced
by any local suite.

## What happens

An onboarding session is created, the kickoff prompt is recorded, a delivery
attempt is opened — and the runner never takes it up. The session sits in
`running` forever and the agent emits nothing at all.

Observed on run `staging-e2e-synthetic`:

| field | value |
| --- | --- |
| history | exactly 2 events: `session_created`, `user_prompt` |
| `status` | `running` (only value ever observed, polled 1s for 180s) |
| `deliveryAttempt` | `{ attemptId: 'drain:15950eee-…', kind: 'initial_prompt', throughSeq: 2 }` |
| `lastDeliveredInputSeq` | `0` |
| `lastModelId` | `recommended` |

`throughSeq: 2` against `lastDeliveredInputSeq: 0` is the shape of the bug: the
control plane published the turn and nothing ever acknowledged it.

## What it is not

- **Not staging being down.** The `build-app` journey, which needs a real agent
  turn and shares none of this code, passed on the same deployment minutes
  later — `agent:dispatch` and `agent:terminal` both green.
- **Not a regression from the prompt-layering work.** The only gateway change
  between the run that passed and the runs that failed is the *text* of the
  generated completion prompt. The runner never started, so it never read it.
- **Not someone else's merge.** No gateway or Convex commits arrived from
  `origin/staging` in that window; the merges were web/lander only.
- **Not the drain index.** Sessions are created `visible: true` unconditionally,
  and `onboarding` was deliberately kept off
  `by_workspace_visible_pending_updated`, so hidden turns are still drain
  candidates.

## Intermittent

Run `…ms54ms1e-1937e7` completed the same path successfully — the agent
onboarded itself in 254s. Three consecutive later runs stalled. So this
reproduces often but not always, which fits a race around session start rather
than a hard break.

## Why no local test caught it

Leg A opens an onboarding session and then calls the onboarded endpoint itself,
so it passes with the runner completely dead — it did, in all three stalled
runs. The gateway unit tests pin the runner argv, which is correct and says
nothing about whether a turn is ever delivered.

## Resolution (2026-07-29)

Green on `staging-e2e-synthetic`: the agent asked for the
codeword, held the lock while it waited, took the reply, recorded it, and
onboarded itself. Cleanup passed with zero orphans.

Two independent defects, both fixed:

1. **Head-of-line blocking in the drain** (`apps/api/src/agent-runner.ts`). A
   dispatch that *returned* a failure aborted the whole pass, so sessions behind
   the wedged one were never dispatched. The captured log proved it: exactly one
   `/input` request, and its session id was leg A's, not leg B's — leg B's turn
   was never asked for. Pinned by a unit test at the dispatch seam.
2. **A turn-start ceiling that could not converge**
   (`packages/gateway/src/runner/process-runner.ts`). Cold starts exceeded 90s;
   on timeout the runner is killed, so every retry cold-started into the same
   wall. Raised, with the real latency now logged so the bound stops being
   inferred.

**What made this findable at all** was fixing the observability first: the
gateway collapsed the runner's own account of the failure into a bare 503 and
logged nothing, so `POST …/input 503 90711ms` was the entire record. Logging the
underlying error surfaced `Timeout waiting for turn_started`, and the exact
90.7s pointed straight at the constant.

**Wrong turns worth not repeating:** it was not the model credentials
(`spawn_model_credentials` never appears), not repeated `--system-prompt-file`
(the rpc parser accumulates them), not an agent self-update race (the binary pin
completes before spawn), not the MCP endpoint, not the function budget
(`maxDuration` is 800s), and agent 0.3.6 was not required.
