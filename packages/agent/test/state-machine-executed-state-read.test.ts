import { expect, test } from "bun:test";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { CurrentStateMachineStateResult } from "../src/turn-runner/tools.js";
import { TestTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";

class ExecutedStateRunner extends TestTurnRunner {
  async inspect(): Promise<CurrentStateMachineStateResult> {
    const tool = this.createTools("auto").tools.find(
      (candidate) => candidate.name === "get_current_state_machine_state",
    );
    if (!tool) throw new Error("Missing live state inspection tool");
    return (await tool.execute("inspect-completed-state", {}))
      .details as CurrentStateMachineStateResult;
  }

  protected override createStateSubagentRun(): SubagentRun {
    return {
      prompt: async () => ({ type: "complete", result: "I found nothing to do." }),
      interrupt: () => {},
      partialAssistantText: () => undefined,
      interruptedReason: () => undefined,
    };
  }
}

test("live read reports the executed state despite its misleading self-report", async () => {
  const runner = new ExecutedStateRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  runner.controlResults = [
    { type: "select_state_machine_state", decision: { state: "implementing" } },
    { type: "select_state_machine_state", decision: { state: "done" } },
  ];
  let live: CurrentStateMachineStateResult | undefined;
  runner.worker = async (input, next) => {
    if (input.prompt.includes("<state_completed>")) live = await runner.inspect();
    return next();
  };
  try {
    const terminal = await (
      await startTurn(runner, {
        prompt: "Implement the known task.",
        mode: {
          name: "executed-state",
          prompt: "Implement the known task.",
          states: [
            { kind: "agent", name: "plan", prompt: "Plan." },
            { kind: "agent", name: "implementing", prompt: "Implement." },
            { kind: "terminal", name: "done", status: "completed" },
          ],
        },
      })
    ).turn;
    expect(terminal).toMatchObject({ type: "complete", status: "completed" });
    expect(live?.currentState).toBe("implementing");
    expect(live?.history).toContainEqual(
      expect.objectContaining({
        type: "state_completed",
        state: "implementing",
        output: { result: "I found nothing to do." },
      }),
    );
  } finally {
    await runner.dispose();
  }
});
