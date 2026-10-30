import { describe, expect } from "bun:test";
import type { SubagentResult, SubagentRun } from "../src/turn-runner/subagent.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { TestTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";
import { testIfDocker } from "./helpers/docker-only.js";

const definition: StateMachineDefinition = {
  name: "replacement",
  prompt: "Run work.",
  states: [
    { kind: "agent", name: "work", prompt: "Work." },
    { kind: "terminal", name: "done", status: "completed" },
  ],
};

class ReplacementRunner extends TestTurnRunner {
  readonly firstRunStarted = Promise.withResolvers<void>();
  readonly interrupted = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  oldUnwound = false;
  replacementStarted = false;
  replacementOverlapped = false;
  private created = 0;

  constructor(private readonly rejectOnAbort: boolean) {
    super({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
    this.controlResults = [
      { type: "select_state_machine_state", decision: { state: "work" } },
      {
        type: "select_state_machine_state",
        decision: { state: "work", input: { plan: "revised" } },
      },
      { type: "select_state_machine_state", decision: { state: "done" } },
    ];
  }

  protected override createStateSubagentRun(): SubagentRun {
    this.created += 1;
    if (this.created > 1) {
      this.replacementStarted = true;
      this.replacementOverlapped = !this.oldUnwound;
      return {
        prompt: async () => ({ type: "complete", result: "replacement done" }),
        interrupt: () => {},
        partialAssistantText: () => undefined,
        interruptedReason: () => undefined,
      };
    }
    let reason: string | undefined;
    return {
      prompt: async () => {
        this.firstRunStarted.resolve();
        await this.release.promise;
        this.oldUnwound = true;
        if (this.rejectOnAbort) throw new Error("Request was aborted.");
        return { type: "interrupted" } satisfies SubagentResult;
      },
      interrupt: (value) => {
        reason = value;
        this.interrupted.resolve();
      },
      partialAssistantText: () => "old partial output",
      interruptedReason: () => reason,
    };
  }
}

describe("state-machine replacement", () => {
  testIfDocker(
    "awaits the previous state's prompt resolution before creating the replacement handle",
    async () => {
      await exerciseReplacement(false);
    },
  );
  testIfDocker("old run does not write state_failed or terminal after being replaced", async () => {
    await exerciseReplacement(true);
  });
});

async function exerciseReplacement(rejectOnAbort: boolean): Promise<void> {
  const runner = new ReplacementRunner(rejectOnAbort);
  const { turn } = await startTurn(runner, { mode: definition, prompt: "Run work." });
  try {
    await runner.firstRunStarted.promise;
    const revised = runner.turn({ type: "prompt", message: "revise work", behavior: "steer" });
    await runner.interrupted.promise;
    // Let the replacement pass proceed while the old executor remains gated.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.replacementStarted).toBe(false);
    expect(runner.oldUnwound).toBe(false);
    runner.release.resolve();
    const [terminal, revisedTerminal] = await Promise.all([turn, revised]);
    expect(revisedTerminal).toBe(terminal);
    expect(runner.oldUnwound).toBe(true);
    expect(runner.replacementStarted).toBe(true);
    expect(runner.replacementOverlapped).toBe(false);
    expect(terminal).toMatchObject({ type: "complete", status: "completed" });
    const session = terminal.state.stateMachine;
    expect(session?.history.filter((entry) => entry.type === "state_failed")).toEqual([]);
    expect(session?.history.filter((entry) => entry.type === "state_completed")).toContainEqual(
      expect.objectContaining({ state: "work", output: { result: "replacement done" } }),
    );
    expect(session?.terminal).toMatchObject({ status: "completed" });
  } finally {
    runner.release.resolve();
    runner.interrupt({ type: "interrupt" });
    await turn;
    await runner.dispose();
  }
}
