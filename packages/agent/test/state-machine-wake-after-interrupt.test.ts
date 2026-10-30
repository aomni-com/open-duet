import { describe, expect, test } from "bun:test";
import {
  planDecision,
  planWake,
  recordSettled,
  startSession,
} from "../src/turn-runner/state-machine-decisions.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

describe("state-machine wake after interrupt", () => {
  test("interrupted work stays unscheduled until an explicit selection", () => {
    const definition: StateMachineDefinition = {
      name: "wake-after-interrupt",
      prompt: "Run.",
      states: [{ kind: "agent", name: "research", prompt: "Research." }],
    };
    const planned = planDecision(
      startSession({ prompt: "Run.", definition, currentState: "research" }),
      { state: "research" },
    );
    const interrupted = recordSettled(planned.session, "research", "agent", {
      type: "interrupted",
      reason: "User pressed stop.",
    });
    expect(interrupted.outcome).toEqual({ type: "interrupted" });
    const checkpoint = structuredClone(interrupted.session);
    for (const now of [1, 2, 3]) expect(planWake(interrupted.session, now)).toBeUndefined();
    expect(interrupted.session).toEqual(checkpoint);
    expect(interrupted.session.currentState).toBe("interrupted");
    expect(interrupted.session.terminal).toBeUndefined();
    expect(planDecision(interrupted.session, { state: "research" }).work).toMatchObject({
      run: { stateName: "research", subagent: { prompt: "Research." } },
    });
  });
});
