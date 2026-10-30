import { afterEach, describe, expect, test } from "bun:test";
import { currentParkState } from "../src/turn-runner/state-machine-session.js";
import type { StateMachineDefinition, StateMachineSession } from "../src/types/state-machine.js";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { parkNudge } from "../src/turn-runner/prompts.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

class ParkRunner extends TurnRunner {
  readonly controlResults: TurnRunnerControlResult[] = [];
  readonly requestPrompts: string[] = [];
  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }
  protected override createAgent(
    input: AgentConfigInput,
    control?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, control);
    agent.streamFunction = (model, context) => {
      const user = [...context.messages].reverse().find((message) => message.role === "user");
      if (!user || user.role !== "user") throw new Error("Parent request has no user prompt");
      this.requestPrompts.push(
        typeof user.content === "string"
          ? user.content
          : user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      );
      const action = this.controlResults.shift();
      const tool =
        action && action.type !== "none"
          ? {
              type: "toolCall" as const,
              id: `control-${this.requestPrompts.length}`,
              name: action.type,
              arguments:
                action.type === "ask_user_question"
                  ? { questions: action.questions }
                  : action.type === "select_state_machine_state"
                    ? { decision: action.decision }
                    : {},
            }
          : undefined;
      const message = {
        ...createAssistantMessage(tool ? { extraContent: [tool] } : { text: "Waiting here." }),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }),
      );
      return stream;
    };
    return agent;
  }
}
const runners = new Set<ParkRunner>();
function createParkRunner() {
  const runner = new ParkRunner();
  const events: TurnEvent[] = [];
  runner.subscribe((event) => events.push(event));
  runners.add(runner);
  return { runner, events };
}
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners.clear();
});

function parkDefinition(): StateMachineDefinition {
  return {
    name: "parent_owned_gate",
    prompt: "Wait for the user's approval before continuing.",
    states: [
      { kind: "park", name: "await_approval", when: "Approval has not arrived yet." },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function parkedSession(): StateMachineSession {
  return {
    definition: parkDefinition(),
    prompt: "Wait for approval.",
    currentState: "await_approval",
    history: [{ type: "state_started", timestamp: 1, state: "await_approval" }],
    createdAt: 0,
    updatedAt: 1,
  };
}

describe("currentParkState", () => {
  test("returns the inert current park while the machine is active", () => {
    expect(currentParkState(parkedSession())?.name).toBe("await_approval");
  });

  test("returns undefined for a terminal machine", () => {
    const session = parkedSession();
    session.terminal = { state: "done", status: "completed" };
    expect(currentParkState(session)).toBeUndefined();
  });
});

describe("parent-owned park gate", () => {
  test("selecting park starts no task and leaves the machine parked", async () => {
    const { runner, events } = createParkRunner();
    const definition = parkDefinition();
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { state: "await_approval" },
    });

    const terminal = await (await startTurn(runner, { mode: definition, prompt: "Begin." })).turn;

    expect(terminal.type).toBe("complete");
    expect(terminal.state.stateMachine?.currentState).toBe("await_approval");
    expect(terminal.state.stateMachine?.history.at(-1)).toMatchObject({
      type: "state_started",
      state: "await_approval",
    });
    expect(terminal.state.stateMachine?.progress?.states.await_approval?.runs).toBe(1);
    expect(events.filter((event) => event.type === "task_started")).toEqual([]);
  });

  test("the parent asks while parked and a later answer drives the transition", async () => {
    const { runner } = createParkRunner();
    const definition = parkDefinition();
    const questions = [
      { question: "Deploy now?", options: [{ label: "Go ahead" }, { label: "Wait" }] },
    ];
    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "await_approval" } },
      // The end-of-turn park nudge spends one more pass before the first
      // turn ends; this parent is genuinely waiting, so it stays parked.
      { type: "none" },
      { type: "ask_user_question", questions },
      { type: "select_state_machine_state", decision: { state: "done" } },
    );

    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;
    const asked = await runner.turn({
      type: "prompt",
      message: "Ask me before deploying.",
      behavior: "follow_up",
    });
    expect(asked).toMatchObject({ type: "ask", questions });
    expect(asked.state.stateMachine?.currentState).toBe("await_approval");

    const terminal = await runner.turn({
      type: "answer",
      questions,
      answers: { "Deploy now?": ["Go ahead"] },
      behavior: "follow_up",
    });
    expect(terminal.state.stateMachine?.terminal).toEqual({
      state: "done",
      status: "completed",
      reason: undefined,
    });
  });

  test("each parent pass that starts parked carries the binding park nudge", async () => {
    const { runner } = createParkRunner();
    const definition = parkDefinition();
    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "await_approval" } },
      { type: "none" },
    );
    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;
    await runner.turn({ type: "prompt", message: "Still waiting.", behavior: "follow_up" });

    const parkedPrompts = runner.requestPrompts.slice(1);
    expect(parkedPrompts).toContainEqual(expect.stringContaining("Still waiting."));
    for (const prompt of parkedPrompts) {
      expect(prompt).toContain(parkNudge("await_approval"));
    }
  });
});
