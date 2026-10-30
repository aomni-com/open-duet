import type {
  StateMachinePollState,
  StateMachineScriptState,
} from "../../src/types/state-machine.js";
import { TestTurnRunner, startTurn } from "./turn-runner-protocol.js";
import { ManualRuntimeClock } from "./manual-runtime-clock.js";

/** Drive actual runner/task/shell wiring, replacing only the model's parent decisions. */
export async function runShellState(
  state: StateMachinePollState | StateMachineScriptState,
  cwd = process.cwd(),
) {
  const runner = new TestTurnRunner(
    {
      model: "anthropic:claude-opus-4-7",
      cwd,
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    },
    { clock: new ManualRuntimeClock(1_000) },
  );
  runner.controlResults = [
    { type: "select_state_machine_state", decision: { state: state.name } },
    { type: "select_state_machine_state", decision: { state: "done" } },
  ];
  try {
    return await (
      await startTurn(runner, {
        prompt: "Run the shell state.",
        mode: {
          name: "shell-state",
          prompt: "Run shell work.",
          states: [state, { kind: "terminal", name: "done", status: "completed" }],
        },
      })
    ).turn;
  } finally {
    await runner.dispose();
  }
}
