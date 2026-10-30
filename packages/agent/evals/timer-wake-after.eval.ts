import { afterEach, describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { parseDurationToMs } from "../src/turn-runner/duration.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const runners: TurnRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
});

const model = process.env.EVAL_MODEL ?? "sonnet-5";

/**
 * Routing eval for the timer `wakeAfterMs` field added in PR #58.
 *
 * Timer states accept either `wakeAt` (absolute Unix-epoch ms or ISO 8601)
 * or `wakeAfterMs` (relative duration measured from selection time, accepting
 * `ms`-style strings like `"16h"` or a raw millisecond number). When the user
 * frames a wait in relative terms ("wait 16 hours, then check…"), the agent
 * should pick `wakeAfterMs`, not compute an absolute `wakeAt` itself: the
 * relative form is what the schema is built for, it makes the definition
 * reusable, and it sidesteps drift between when the agent renders the prompt
 * and when the parent actually selects the state.
 *
 * This eval drives a planning-only turn: the agent registers the state
 * machine and returns a completed or sleeping terminal without waiting for
 * the 16-hour deadline. The assertion inspects the accepted persisted plan.
 */
describe("timer wakeAfterMs routing", () => {
  testIfDocker(
    "uses wakeAfterMs (not wakeAt) when the wait is described as a relative duration",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          You are in a planning-only eval. You cannot call bash, read, edit,
          write, or any other coding tool — those would touch real systems
          you do not control here. You CAN call
          create_state_machine_definition and todo_write.

          The user's request below is exactly the kind of wait-then-do work
          that needs a relay (state machine) with a timer state. Set one up.
          Include a terminal state named "eval_done" with status "completed"
          so the relay has a happy-path exit, but pick the firstState that
          matches what the user actually asked for. Reply with a short
          status update afterwards describing what you scheduled.
        `,
      });
      runners.push(runner);

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: dedent`
          Wait 16 hours, then post a follow-up message in this channel
          summarizing the overnight CI runs. The wait length is fixed (16h
          from now), not tied to a specific clock time — set up the relay so
          the timer survives the session boundary and the follow-up agent
          state runs after the wait completes.
        `,
      });
      const terminal = await turn;

      // Inspect the accepted persisted definition, rather than an attempted
      // tool input that may have been rejected by the actual runner.
      const definition = terminal.state.stateMachine?.definition;
      expect(definition).toBeTruthy();
      if (!definition) throw new Error("missing definition");

      const timerStates = definition.states.filter((s) => s.kind === "timer");
      // The whole point of the prompt is the wait. There must be a timer.
      expect(timerStates.length).toBeGreaterThanOrEqual(1);

      const timer = timerStates[0];
      if (!timer) throw new Error("expected at least one timer state");

      // Primary assertion: the relative-wait prompt routed to wakeAfterMs,
      // not wakeAt. Failing this means the prompt/tool guidance isn't
      // pointing the model at the relative form for "wait N hours" framing.
      expect(timer.wakeAfterMs).toBeDefined();
      expect(timer.wakeAt).toBeUndefined();

      // The requested wait is fixed at 16h. Accept either a duration string
      // ("16h", "16 hours") or a raw millisecond number; both are valid
      // per-schema, and we want this eval to track behavior, not surface
      // syntax.
      const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
      const resolved = parseDurationToMs(timer.wakeAfterMs, "relative timer");
      expect(resolved).toBe(SIXTEEN_HOURS_MS);

      // The turn ends in `sleep` when the agent wires the timer as the
      // firstState (the relay is genuinely waiting), or in `complete` when
      // the agent created the relay but did not enter the wait this turn.
      // Either form is acceptable — the wakeAfterMs routing assertions
      // above are what we actually care about.
      expect(["complete", "sleep"]).toContain(terminal.type);
    },
    120_000,
  );
});
