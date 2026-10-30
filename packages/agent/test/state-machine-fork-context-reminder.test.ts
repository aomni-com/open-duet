import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import { createForkContextReminder } from "../src/turn-runner/prompts.js";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { createAssistantMessage } from "./helpers/messages.js";

/** Read the actual child request, replacing only the model stream at the network edge. */
async function captureTailPrompt(state: StateMachineAgentState): Promise<string> {
  let requestMessages: Context["messages"] | undefined;
  let requestTools: string[] = [];
  class CapturingTurnRunner extends TurnRunner {
    constructor() {
      super({
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      });
    }
    child(): SubagentRun {
      return this.createStateSubagentRun({ state, prompt: state.prompt, origin: { taskId: "t1" } });
    }
    protected override createAgent(
      input: AgentConfigInput,
      onControlResult?: (result: TurnRunnerControlResult) => void,
    ): Agent {
      const agent = super.createAgent(input, onControlResult);
      agent.streamFunction = (model, context) => {
        requestMessages = structuredClone(context.messages);
        requestTools = context.tools?.map((tool) => tool.name) ?? [];
        const stream = createAssistantMessageEventStream();
        const message = {
          ...createAssistantMessage({ text: "Child task completed." }),
          model: model.id,
          provider: model.provider,
          api: model.api,
        };
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      };
      return agent;
    }
  }
  const runner = new CapturingTurnRunner();
  try {
    await runner.start({ type: "start" });
    expect(await runner.child().prompt()).toEqual({
      type: "complete",
      result: "Child task completed.",
    });
    expect(requestTools).not.toContain("ask_user_question");
    const user = [...(requestMessages ?? [])].reverse().find((message) => message.role === "user");
    if (!user || user.role !== "user") throw new Error("Child model received no user task");
    return typeof user.content === "string"
      ? user.content
      : user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  } finally {
    await runner.dispose();
  }
}

describe("fork-context reminder", () => {
  test("the reminder draws the parent/sub-agent line and forbids routing", () => {
    const reminder = createForkContextReminder();
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("copy of the parent");
    expect(reminder).toContain("You are NOT the parent agent");
    expect(reminder).toContain("fresh sub-agent");
    expect(reminder).toContain("cannot select or route to other states");
  });

  test("a forked agent state leads its tail turn with the reminder", async () => {
    const tail = await captureTailPrompt({
      kind: "agent",
      name: "recall_secret",
      forkContext: true,
      prompt: "Find the token in the conversation above and reply with it.",
    });

    const reminderIndex = tail.indexOf("<system-reminder>");
    const identityIndex = tail.indexOf("state_agent_identity");
    const taskIndex = tail.indexOf("Find the token");

    // The reminder must land first so the model resets its identity before it
    // reads the inherited transcript's identity layer or the task itself.
    expect(tail).toStartWith("<system-reminder>");
    expect(reminderIndex).toBe(0);
    expect(identityIndex).toBeGreaterThan(reminderIndex);
    expect(taskIndex).toBeGreaterThan(identityIndex);
  });

  test("a non-forked agent state has no reminder and no inlined identity", async () => {
    const tail = await captureTailPrompt({
      kind: "agent",
      name: "recall_secret",
      prompt: "Find the token in the conversation above and reply with it.",
    });

    // Fresh-context states carry their identity in the system prompt, so the
    // tail turn is just the task — no reminder, no identity layer inlined.
    expect(tail).not.toContain("<system-reminder>");
    expect(tail).not.toContain("state_agent_identity");
    expect(tail).toBe("Find the token in the conversation above and reply with it.");
  });
});
