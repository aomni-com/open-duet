import { describe, expect } from "bun:test";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { CurrentStateMachineStateResult } from "../src/turn-runner/tools.js";
import type { SubagentResult, SubagentRun } from "../src/turn-runner/subagent.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import { waitFor } from "./helpers/async.js";
import { testIfDocker } from "./helpers/docker-only.js";

class OutputRunner extends TurnRunner {
  assistantText = "drafting research";
  agentStarted = false;
  private selected = false;
  private readonly completion = Promise.withResolvers<SubagentResult>();

  async inspect(): Promise<CurrentStateMachineStateResult> {
    const tool = this.createTools("auto").tools.find(
      (candidate) => candidate.name === "get_current_state_machine_state",
    );
    if (!tool) throw new Error("Missing inspection tool");
    return (await tool.execute("inspect-active-state", {}))
      .details as CurrentStateMachineStateResult;
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    const control = this.selected
      ? { type: "none" as const }
      : { type: "select_state_machine_state" as const, decision: { state: "work" } };
    this.selected = true;
    return {
      control,
      outcome: {
        type: "complete",
        status: "completed",
        result: "selected",
        state: {
          ...input.state,
          status: "completed",
          agent: { ...input.state.agent, status: "completed" },
        },
      },
    };
  }

  protected override createStateSubagentRun(): SubagentRun {
    this.agentStarted = true;
    return {
      prompt: () => this.completion.promise,
      interrupt: () => this.completion.resolve({ type: "interrupted" }),
      partialAssistantText: () => this.assistantText,
      interruptedReason: () => undefined,
    };
  }
}

function runner(): OutputRunner {
  return new OutputRunner({
    model: "anthropic:claude-opus-4-7",
    mode: "auto",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
}

describe("state-machine active output", () => {
  testIfDocker("returns active agent partial assistant text", async () => {
    const instance = runner();
    const definition: StateMachineDefinition = {
      name: "agent-output",
      prompt: "Run agent.",
      states: [{ kind: "agent", name: "work", prompt: "Research." }],
    };
    const { turn } = await startTurn(instance, { mode: definition, prompt: "Run agent." });
    try {
      await waitFor(() => instance.agentStarted);
      expect((await instance.inspect()).activeOutput).toEqual({
        state: "work",
        kind: "agent",
        output: { assistantText: "drafting research" },
      });
    } finally {
      instance.interrupt({ type: "interrupt" });
      await turn;
      await instance.dispose();
    }
  });

  for (const kind of ["script", "poll"] as const) {
    testIfDocker(`returns active ${kind} stdout and stderr`, async () => {
      const instance = runner();
      const definition: StateMachineDefinition = {
        name: `${kind}-output`,
        prompt: "Run shell.",
        states: [
          kind === "poll"
            ? {
                kind: "poll",
                name: "work",
                command: "printf shell-out; printf shell-err >&2; sleep 30",
                intervalMs: 60_000,
              }
            : {
                kind: "script",
                name: "work",
                command: "printf shell-out; printf shell-err >&2; sleep 30",
              },
        ],
      };
      const { turn } = await startTurn(instance, { mode: definition, prompt: "Run shell." });
      try {
        await waitForOutput(async () => {
          const active = (await instance.inspect()).activeOutput;
          return (
            active?.kind === kind &&
            active.output?.stdout === "shell-out" &&
            active.output?.stderr === "shell-err"
          );
        });
        expect((await instance.inspect()).activeOutput).toEqual({
          state: "work",
          kind,
          output: { stdout: "shell-out", stderr: "shell-err" },
        });
      } finally {
        instance.interrupt({ type: "interrupt" });
        await turn;
        await instance.dispose();
      }
    });
  }

  testIfDocker("omits activeOutput when no state is running", async () => {
    const instance = runner();
    try {
      await instance.start({
        type: "start",
        mode: {
          name: "idle",
          prompt: "Done.",
          states: [{ kind: "terminal", name: "work", status: "completed" }],
        },
      });
      expect(await instance.inspect()).not.toHaveProperty("activeOutput");
    } finally {
      await instance.dispose();
    }
  });
});

async function waitForOutput(ready: () => Promise<boolean | undefined>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for active shell output");
    await Bun.sleep(1);
  }
}
