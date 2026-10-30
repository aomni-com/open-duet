import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

import type { ClassifierDecision, ClassifierInput } from "../src/model-routing/classifier.js";
import {
  ModelRouter,
  ROUTER_INACTIVITY_THRESHOLD_MS,
  type ModelRouterOptions,
  type RouteClassifier,
} from "../src/model-routing/router.js";
import { AdvisorTurnLifecycle } from "../src/model-routing/advisor-lifecycle.js";
import { ADVISOR_EXECUTOR_GUIDANCE_LAYER } from "../src/model-routing/prompts.js";
import * as modelResolver from "../src/model-resolution/resolver.js";
import type { AdvisorPolicy, RoutingTable } from "../src/model-routing/table.js";
import { settlementNotice } from "../src/turn-runner/task-tools.js";
import type { AskAdvisorToolStorage } from "../src/turn-runner/tools.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import { waitFor } from "./helpers/async.js";
import { inDockerTest, testIfDocker } from "./helpers/docker-only.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";
import { createAssistantMessage } from "./helpers/messages.js";

let advisorFixtureCwd: string | undefined;
let adapterFixtureCwd: string | undefined;
const runners = new Set<RouterTurnRunner>();

const previousDuetApiKey = process.env.DUET_API_KEY;

beforeAll(async () => {
  process.env.DUET_API_KEY = "router-test-key";
  adapterFixtureCwd = await mkdtemp(join(tmpdir(), "router-adapter-policy-"));
  await mkdir(join(adapterFixtureCwd, ".duet"));
  await writeFile(
    join(adapterFixtureCwd, ".duet", "models.json"),
    JSON.stringify(adapterRoutingFixture()),
  );
});

afterAll(async () => {
  if (adapterFixtureCwd) await rm(adapterFixtureCwd, { recursive: true, force: true });
  if (previousDuetApiKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = previousDuetApiKey;
});

afterEach(async () => {
  for (const runner of runners) {
    runner.interrupt({ type: "interrupt" });
    for (const pending of runner.pendingStreams.splice(0)) {
      pending.stream.push({
        type: "done",
        reason: "stop",
        message: {
          ...createAssistantMessage({ errorMessage: "fixture interrupted", stopReason: "aborted" }),
          model: pending.model.id,
          provider: pending.model.provider,
          api: pending.model.api,
        },
      });
    }
    await Promise.allSettled([...runner.inFlightWork]);
    await runner.dispose();
  }
  runners.clear();
});

function orientationStepBoundary(): number {
  const lifecycle = new AdvisorTurnLifecycle(0);
  for (let step = 1; step <= 100; step++) {
    if (lifecycle.takeOrientationCheckpoint(step)) return step;
  }
  throw new Error("No advisor orientation checkpoint within fixture work budget");
}

function adapterRoutingFixture(): RoutingTable {
  const table = advisorPolicyFixture();
  table.tiers.frontier!.routes.general!.target = { modelName: "sol", thinkingLevel: "medium" };
  table.tiers.frontier!.routes.plan!.target = { modelName: "opus", thinkingLevel: "high" };
  table.tiers.frontier!.routes.implement!.target = { modelName: "sol", thinkingLevel: "medium" };
  table.tiers.balanced!.routes.general!.target = { modelName: "sol", thinkingLevel: "low" };
  return table;
}

interface PendingStream {
  model: Model<any>;
  stream: ReturnType<typeof createAssistantMessageEventStream>;
}

class RouterTurnRunner extends TurnRunner {
  readonly pendingStreams: PendingStream[] = [];
  readonly requestModels: Model<any>[] = [];
  readonly requestMessages: Context["messages"][] = [];
  readonly requestContexts: Context[] = [];
  readonly requestThinkingLevels: Array<string | undefined> = [];
  readonly inFlightWork = new Set<Promise<unknown>>();
  readonly advisorContextTexts: string[] = [];
  private readonly classify: RouteClassifier;
  private readonly everySteps: number;
  private readonly planTarget?: { modelName: string; thinkingLevel: "low" | "medium" | "high" };
  private readonly stepKeywords?: string[];
  private readonly stubAdvisor: boolean;

  constructor(options: {
    classify: RouteClassifier;
    everySteps?: number;
    planTarget?: { modelName: string; thinkingLevel: "low" | "medium" | "high" };
    effectiveContext?: number;
    model?: string;
    cwd?: string;
    stepKeywords?: string[];
    systemInstructions?: string;
    stubAdvisor?: boolean;
    clock?: ManualRuntimeClock;
  }) {
    super({
      model: options.model ?? "frontier",
      mode: "agent",
      cwd: options.cwd ?? advisorFixtureCwd ?? adapterFixtureCwd,
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
      effectiveContext: options.effectiveContext,
      systemInstructions: options.systemInstructions,
    }, options.clock ? { clock: options.clock } : undefined);
    runners.add(this);
    this.classify = options.classify;
    this.everySteps = options.everySteps ?? 1;
    this.planTarget = options.planTarget;
    this.stepKeywords = options.stepKeywords;
    this.stubAdvisor = options.stubAdvisor ?? false;
  }

  parentAgentForTest(): Agent {
    return this.requireParentAgent();
  }

  emitStateAgentEventForTest(event: AgentEvent): void {
    this.emitAgentEvent(event, { taskId: "t1" });
  }

  emitParentTurnEndForTest(
    message: Extract<AgentMessage, { role: "assistant" }>,
    toolResults: Extract<AgentEvent, { type: "turn_end" }>["toolResults"],
  ): void {
    this.emitParentAgentEvent({ type: "turn_end", message, toolResults });
  }

  private trackWork<T>(work: Promise<T>): Promise<T> {
    this.inFlightWork.add(work);
    void work.then(
      () => this.inFlightWork.delete(work),
      () => this.inFlightWork.delete(work),
    );
    return work;
  }

  override turn(...args: Parameters<TurnRunner["turn"]>): ReturnType<TurnRunner["turn"]> {
    return this.trackWork(super.turn(...args));
  }

  createStateAgentForTest(state: StateMachineAgentState) {
    const run = this.createStateSubagentRun({
      state,
      prompt: state.prompt,
      origin: { taskId: "t1" },
    });
    const prompt = run.prompt;
    run.prompt = () => this.trackWork(prompt());
    return run;
  }

  async transformForTest(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const transform = this.requireParentAgent().transformContext;
    if (!transform) throw new Error("Expected parent context transform");
    return transform(messages);
  }

  seedCompactionHistory(messages: AgentMessage[]): void {
    const state = this.getState();
    if (!state) throw new Error("Expected started runner state");
    const seeded = { ...state, agent: { ...state.agent, messages } };
    this.requireParentAgent().state.messages = messages;
    (this as unknown as { setState: (state: typeof seeded) => void }).setState(seeded);
  }

  protected override createModelRouter(options: ModelRouterOptions): ModelRouter {
    const table = structuredClone(options.table);
    table.classifier.everySteps = this.everySteps;
    if (this.stepKeywords) {
      table.classifier.stepTriggers = [{ name: "test-plumbing", keywords: this.stepKeywords }];
    }
    if (this.planTarget) {
      table.tiers.frontier!.routes.plan!.target = this.planTarget;
    }
    return new ModelRouter({ ...options, table, classify: this.classify });
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    // Routing tests exercise the parent loop only; durable memory is unrelated.
  }

  protected override createAskAdvisorStorage(
    router: ModelRouter,
    policy: AdvisorPolicy,
  ): AskAdvisorToolStorage {
    const storage = super.createAskAdvisorStorage(router, policy);
    if (!this.stubAdvisor) return storage;
    storage.callAdvisor = async (input) => {
      this.advisorContextTexts.push(input.contextText);
      return {
        advice: `Advisor review ${this.advisorContextTexts.length}: inspect the boundary carefully.`,
        usage: {
          inputTokens: 12,
          inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 3,
          outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
          totalTokens: 15,
        },
      };
    };
    return storage;
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFunction = (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      this.requestModels.push(model);
      this.requestThinkingLevels.push(options?.reasoning);
      this.requestMessages.push(structuredClone(context.messages));
      this.requestContexts.push(context);
      this.pendingStreams.push({ model, stream });
      if (options?.signal?.aborted) {
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              ...createAssistantMessage({ errorMessage: "aborted", stopReason: "aborted" }),
              model: model.id,
              provider: model.provider,
              api: model.api,
            },
          });
        });
      }
      return stream;
    };
    return agent;
  }

  completeNext(input: {
    text?: string;
    tool?: { name: string; arguments: Record<string, unknown> };
    usageTokens: number;
    thinking?: string;
  }): void {
    const pending = this.pendingStreams.shift();
    if (!pending) throw new Error("No pending model stream");
    const extraContent: AssistantMessage["content"] = [
      ...(input.thinking
        ? [{ type: "thinking" as const, thinking: input.thinking, thinkingSignature: "sig" }]
        : []),
      ...(input.tool
        ? [
            {
              type: "toolCall" as const,
              id: `tool_${Date.now()}`,
              name: input.tool.name,
              arguments: input.tool.arguments,
            },
          ]
        : []),
    ];
    pending.stream.push({
      type: "done",
      reason: input.tool ? "toolUse" : "stop",
      message: {
        ...createAssistantMessage({
          text: input.text,
          extraContent,
          usage: { input: input.usageTokens - 1, output: 1 },
        }),
        model: pending.model.id,
        provider: pending.model.provider,
        api: pending.model.api,
      },
    });
  }

  failNextWithContextOverflow(): void {
    const pending = this.pendingStreams.shift();
    if (!pending) throw new Error("No pending model stream");
    pending.stream.push({
      type: "error",
      reason: "error",
      error: {
        ...createAssistantMessage({
          errorMessage: "prompt is too long: 2000000 tokens > 1000000 maximum",
          stopReason: "error",
        }),
        model: pending.model.id,
        provider: pending.model.provider,
        api: pending.model.api,
      },
    });
  }
}

function scriptedClassifier(decisions: ClassifierDecision[]): RouteClassifier {
  return async () => {
    const decision = decisions.shift();
    if (!decision) throw new Error("No scripted route decision");
    return decision;
  };
}

async function startRunner(runner: RouterTurnRunner, events: TurnEvent[]): Promise<void> {
  runner.subscribe((event) => events.push(event));
  await runner.start({ type: "start", mode: "agent" });
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAABGUUKwAAAAi0lEQVR4Ae3VgQ3AIAwEscD+OweJNc7dgNe5OTu7E/5u+O3/6QZQQHwBBOIBjAIUEF8AgXgAfoIIIBBfAIF4AK4AAgjEF0AgHoArgAAC8QUQiAfgCiCAQHwBBOIBuAIIIBBfAIF4AK4AAgjEF0AgHoArgAAC8QUQiAfgCiCAQHwBBOIBuAIIIBBf4AFTuAN9D/8DSwAAAABJRU5ErkJggg==";

describe("TurnRunner virtual-model adapter", () => {
  test("a user prompt after an hour reruns routing with a fresh cache decision", async () => {
    const clock = new ManualRuntimeClock(Date.now());
    const events: TurnEvent[] = [];
    const runner = new RouterTurnRunner({
      clock,
      everySteps: 99,
      classify: scriptedClassifier([{ route: "general" }, { route: "plan" }]),
    });
    await startRunner(runner, events);

    const first = runner.turn({ type: "prompt", message: "Start.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Started.", usageTokens: 5 });
    await first;

    await clock.advanceBy(ROUTER_INACTIVITY_THRESHOLD_MS + 1_000);
    const second = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Planned.", usageTokens: 5 });
    await second;

    expect(events.filter((event) => event.type === "router_switch")).toContainEqual(
      expect.objectContaining({
        trigger: "inactivity",
        fromModel: "sol",
        toModel: "opus",
      }),
    );
  });

  test("task plumbing is routing-neutral while genuine assistant text still arms a trigger", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stepKeywords: ["SETTLEMENT_TRIGGER_Q7"],
      classify: scriptedClassifier([{ route: "general" }]),
    });
    await startRunner(runner, []);
    const first = runner.turn({ type: "prompt", message: "Begin.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "ordinary", usageTokens: 5 });
    await first;

    const plumbing = settlementNotice([
      {
        descriptor: {
          id: "t1",
          kind: "tool",
          name: "bash",
          label: "SETTLEMENT_TRIGGER_Q7",
          ownerScopeId: "turn-1",
          status: "completed",
          startedAt: 1,
        },
        output: [],
        settlement: { id: "t1", status: "completed", settledAt: 2, result: "done" },
      },
    ]);
    runner.emitParentTurnEndForTest(createAssistantMessage({ text: "ordinary" }), [
      {
        role: "toolResult",
        toolCallId: "settlement-test",
        toolName: "bash",
        content: [{ type: "text", text: plumbing }],
        details: undefined,
        isError: false,
        timestamp: 2,
      },
    ]);
    expect(runner.routeStatus()?.stepsUntilClassification).toBeGreaterThan(0);

    runner.emitParentTurnEndForTest(
      createAssistantMessage({ text: "Genuine SETTLEMENT_TRIGGER_Q7 analysis." }),
      [],
    );
    expect(runner.routeStatus()?.stepsUntilClassification).toBe(0);
    await runner.dispose();
  });

  testIfDocker("a concrete-started session can switch to a project-only virtual tier", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-concrete-"));
    try {
      const table = adapterRoutingFixture();
      table.defaultTier = "custom";
      table.tiers = { custom: table.tiers.balanced! };
      table.tiers.custom!.routes.general!.target.modelName = "gpt-6.1-sol";
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
      const runner = new RouterTurnRunner({
        model: "gpt-6-sol",
        cwd,
        classify: scriptedClassifier([]),
      });
      await startRunner(runner, []);

      expect(runner.setModel("custom")).toEqual({ routed: true });
      expect(runner.routeStatus()?.tier).toBe("custom");
      expect(runner.parentAgentForTest().state.model.id).toBe("openai/gpt-6.1-sol");
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("concrete pin suspends routing and virtual selection rebuilds it for re-classification", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "plan" }]),
    });
    await startRunner(runner, []);

    expect(runner.setModel("gpt-6-luna")).toEqual({ routed: false });
    expect(runner.routeStatus()?.pinned).toBe(true);
    expect(runner.parentAgentForTest().state.model.id).toBe("openai/gpt-6-luna");

    expect(runner.setModel("frontier")).toEqual({ routed: true });
    expect(runner.routeStatus()?.pinned).toBe(false);
    expect(runner.routeStatus()?.stepsUntilClassification).toBe(0);

    const turn = runner.turn({ type: "prompt", message: "Plan this.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels.at(-1)?.api).toBe("anthropic-messages");
    runner.completeNext({ text: "Planned.", usageTokens: 5 });
    const terminal = await turn;
    expect(terminal.state.options?.model).toBe("frontier");
  });

  test("explicit virtual state model resolves its tier default while omission still inherits", async () => {
    const runner = new RouterTurnRunner({ classify: scriptedClassifier([]) });
    await startRunner(runner, []);

    const explicit = runner.createStateAgentForTest({
      kind: "agent",
      name: "balanced-child",
      prompt: "Do the child task.",
      model: "balanced",
      thinkingLevel: "high",
    });
    const explicitWork = explicit.prompt();
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels.at(-1)?.id).toBe(runner.parentAgentForTest().state.model.id);
    expect(runner.requestThinkingLevels.at(-1)).toBe("low");
    runner.completeNext({ text: "Explicit child complete.", usageTokens: 5 });
    expect(await explicitWork).toEqual({ type: "complete", result: "Explicit child complete." });

    const inherited = runner.createStateAgentForTest({
      kind: "agent",
      name: "inherited-child",
      prompt: "Do the inherited task.",
    });
    const inheritedWork = inherited.prompt();
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels.at(-1)?.id).toBe(runner.parentAgentForTest().state.model.id);
    expect(runner.requestThinkingLevels.at(-1)).toBe(
      runner.parentAgentForTest().state.thinkingLevel,
    );
    runner.completeNext({ text: "Inherited child complete.", usageTokens: 5 });
    expect(await inheritedWork).toEqual({ type: "complete", result: "Inherited child complete." });
  });

  test("resumed routed selection re-classifies instead of restoring a concrete target", async () => {
    const original = new RouterTurnRunner({ classify: scriptedClassifier([]) });
    await startRunner(original, []);
    const saved = structuredClone(original.getState()!);
    expect(saved.options?.model).toBe("frontier");

    const resumed = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "plan" }]),
    });
    await resumed.start({ type: "start", state: saved });
    const turn = resumed.turn({
      type: "prompt",
      message: "Continue planning.",
      behavior: "follow_up",
    });
    await waitFor(() => resumed.pendingStreams.length === 1);
    expect(resumed.requestModels[0]!.api).toBe("anthropic-messages");
    resumed.completeNext({ text: "Continued.", usageTokens: 5 });
    const terminal = await turn;
    expect(terminal.state.options?.model).toBe("frontier");
  });

  test("mid-turn cross-family swap emits router_switch and attributes usage per message model", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([
        { route: "plan" },
        { route: "implement", probabilities: { implement: 0.88, plan: 0.12 } },
      ]),
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const turn = runner.turn({
      type: "prompt",
      message: "Plan, then implement.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels[0]!.api).toBe("anthropic-messages");
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 10,
      thinking: "The architecture is settled.",
    });

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels[1]!.api).toBe("openai-responses");
    runner.completeNext({ text: "Implemented.", usageTokens: 20 });
    const terminal = await turn;

    const switches = events.filter((event) => event.type === "router_switch");
    expect(switches.at(-1)).toEqual({
      type: "router_switch",
      tier: "frontier",
      route: "implement",
      fromModel: "opus",
      toModel: "sol",
      thinkingLevel: "medium",
      trigger: "cadence",
      probabilities: { implement: 0.88, plan: 0.12 },
      visionFallback: false,
    });
    expect(terminal.turnUsage?.totalTokens).toBe(30);
    expect(terminal.usageByModel).toEqual([
      expect.objectContaining({
        model: runner.requestModels[0]!.id,
        usage: expect.objectContaining({ totalTokens: 10 }),
      }),
      expect.objectContaining({
        model: runner.requestModels[1]!.id,
        usage: expect.objectContaining({ totalTokens: 20 }),
      }),
    ]);
    expect(
      terminal.usageByModel?.reduce((total, entry) => total + entry.usage.totalTokens, 0),
    ).toBe(terminal.turnUsage?.totalTokens);
    expect(terminal.state.options?.model).toBe("frontier");
    expect(runner.requestMessages).toHaveLength(2);
    expect(JSON.stringify(runner.requestMessages[1])).toBe(
      JSON.stringify(terminal.state.agent.messages.slice(0, -1)),
    );
    expect(runner.requestMessages[1]!.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(runner.requestMessages[1]![0])).toContain("Plan, then implement.");
    expect(terminal.state.wireGuardHorizon?.evictionHorizon ?? 0).toBe(0);
  });

  test("explicit compaction arms one classification without a second switch-only compaction", async () => {
    const inputs: ClassifierInput[] = [];
    const decisions = [{ route: "general" }, { route: "plan" }];
    const runner = new RouterTurnRunner({
      everySteps: 99,
      effectiveContext: 1_000,
      classify: async (input) => {
        inputs.push(input);
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected classification feedback loop");
        return decision;
      },
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const first = runner.turn({ type: "prompt", message: "Begin.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Started.", usageTokens: 5 });
    await first;

    runner.seedCompactionHistory(
      Array.from({ length: 12 }, (_unused, index) => ({
        role: "user" as const,
        content: `history-${index} ${"x".repeat(1_000)}`,
        timestamp: index + 1,
      })),
    );
    await runner.compact();

    const second = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Continued.", usageTokens: 5 });
    await second;

    const third = runner.turn({
      type: "prompt",
      message: "Continue again.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Still continuing.", usageTokens: 5 });
    await third;

    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "compaction"]);
    expect(events.filter((event) => event.type === "router_switch")).toEqual([
      expect.objectContaining({
        trigger: "compaction",
        fromModel: "sol",
        toModel: "opus",
      }),
    ]);
    expect(
      events.filter((event) => event.type === "system" && event.message.startsWith("compact:"))
        .length,
    ).toBe(1);
  });

  test("memory-budget compaction arms classification at the next boundary", async () => {
    const inputs: ClassifierInput[] = [];
    const runner = new RouterTurnRunner({
      everySteps: 99,
      effectiveContext: 100,
      classify: async (input) => {
        inputs.push(input);
        return { route: "general" };
      },
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const first = runner.turn({ type: "prompt", message: "Begin.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Started.", usageTokens: 5 });
    await first;

    await runner.transformForTest([
      { role: "user", content: "x".repeat(1_000), timestamp: 1 },
      { role: "user", content: "latest", timestamp: 2 },
    ]);
    const second = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Continued.", usageTokens: 5 });
    await second;

    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "compaction"]);
    expect(events.filter((event) => event.type === "router_switch")).toEqual([]);
    expect(
      events.filter((event) => event.type === "system" && event.message.startsWith("compact:")),
    ).toEqual([]);
  });

  test("context-overflow recovery classifies once without forcing an extra model turn", async () => {
    const inputs: ClassifierInput[] = [];
    const decisions = [{ route: "general" }, { route: "plan" }];
    const runner = new RouterTurnRunner({
      everySteps: 99,
      classify: async (input) => {
        inputs.push(input);
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected classification feedback loop");
        return decision;
      },
    });
    await startRunner(runner, []);
    runner.seedCompactionHistory([
      { role: "user", content: "one", timestamp: 1 },
      createAssistantMessage({ text: "two", timestamp: 2 }),
      { role: "user", content: "three", timestamp: 3 },
      createAssistantMessage({ text: "four", timestamp: 4 }),
    ]);

    const turn = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.failNextWithContextOverflow();
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Recovered.", usageTokens: 5 });
    await turn;

    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "compaction"]);
    expect(runner.requestModels).toHaveLength(2);
    expect(runner.parentAgentForTest().state.model.api).toBe("anthropic-messages");
  });

  testIfDocker("an image tool result triggers the vision guard at the next boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-image-step-"));
    try {
      await writeFile(join(cwd, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
      // The fixture supplies a text-only route with an image-capable fallback.
      const table = adapterRoutingFixture();
      table.tiers.balanced!.routes.implement!.target.modelName = "glm-5.3";
      table.tiers.balanced!.routes.implement!.visionFallbackModelName = "gpt-6-luna";
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
      const runner = new RouterTurnRunner({
        model: "balanced",
        cwd,
        everySteps: 99,
        classify: scriptedClassifier([{ route: "implement" }, { route: "implement" }]),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Read shot.png, then report what you found.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.requestModels.at(-1)?.id).toBe("zai/glm-5.3");
      runner.completeNext({
        tool: { name: "read", arguments: { path: "shot.png" } },
        usageTokens: 5,
      });

      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.routeStatus()?.facts).toEqual({ hasImages: true });
      expect(runner.requestModels.at(-1)?.id).toBe("openai/gpt-6-luna");
      runner.completeNext({ text: "The image was read.", usageTokens: 5 });
      await turn;

      expect(events.filter((event) => event.type === "router_switch").at(-1)).toMatchObject({
        trigger: "step_trigger",
        route: "implement",
        fromModel: "glm-5.3",
        toModel: "gpt-6-luna",
        visionFallback: true,
      });
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  testIfDocker("configured keyword output forces step-trigger classification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-keyword-step-"));
    try {
      const table = adapterRoutingFixture();
      table.classifier.stepTriggers = [{ name: "escalate", keywords: ["ESCALATE_ROUTE"] }];
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
      const runner = new RouterTurnRunner({
        cwd,
        everySteps: 99,
        classify: scriptedClassifier([{ route: "general" }, { route: "plan" }]),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Run the requested check.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "printf ESCALATE_ROUTE" } },
        usageTokens: 5,
      });

      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Escalated.", usageTokens: 5 });
      await turn;

      expect(events.filter((event) => event.type === "router_switch").at(-1)).toMatchObject({
        trigger: "step_trigger",
        route: "plan",
      });
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  testIfDocker("a concrete session ignores image step routing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-concrete-image-"));
    try {
      await writeFile(join(cwd, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
      const runner = new RouterTurnRunner({
        model: "gpt-6-luna",
        cwd,
        classify: scriptedClassifier([]),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Read shot.png.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "read", arguments: { path: "shot.png" } },
        usageTokens: 5,
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Done.", usageTokens: 5 });
      await turn;

      expect(runner.routeStatus()).toBeUndefined();
      expect(events.filter((event) => event.type === "router_switch")).toEqual([]);
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("state-agent assistant events do not tick the parent router", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "general" }]),
    });
    await startRunner(runner, []);
    const message = createAssistantMessage({ text: "child result" });

    runner.emitStateAgentEventForTest({ type: "message_end", message });
    expect(runner.routeStatus()?.assistantSteps).toBe(0);
  });

  test("interrupting an in-flight classifier keeps the routed model unchanged", async () => {
    let classificationStarted = false;
    let calls = 0;
    const classify: RouteClassifier = async (_input, signal) => {
      calls += 1;
      if (calls === 1) return { route: "plan" };
      classificationStarted = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const runner = new RouterTurnRunner({ classify });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const turn = runner.turn({
      type: "prompt",
      message: "Work until interrupted.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 5,
    });
    await waitFor(() => classificationStarted);
    runner.interrupt({ type: "interrupt" });
    const terminal = await turn;

    expect(terminal.type).toBe("interrupted");
    expect(runner.routeStatus()?.modelName).toBe("opus");
    expect(runner.parentAgentForTest().state.model.id).toBe(runner.requestModels[0]!.id);
    expect(events.filter((event) => event.type === "router_switch")).toHaveLength(1);
  });

  test("memory transform re-reads the smaller routed context window", async () => {
    const resolveModel = modelResolver.resolveModelName;
    const catalog = spyOn(modelResolver, "resolveModelName").mockImplementation((name) => ({
      ...resolveModel(name),
      contextWindow: name === "haiku-4.5" ? 96 : 2048,
    }));
    try {
      const runner = new RouterTurnRunner({
        classify: scriptedClassifier([{ route: "general" }, { route: "plan" }]),
        planTarget: { modelName: "haiku-4.5", thinkingLevel: "low" },
        effectiveContext: 2048,
      });
      await startRunner(runner, []);
      const largeTail: AgentMessage[] = [
        { role: "user", content: "a".repeat(1500), timestamp: 1 },
        createAssistantMessage({ text: "b".repeat(1200), timestamp: 2 }),
        { role: "user", content: "c".repeat(100), timestamp: 3 },
      ];
      expect(await runner.transformForTest(largeTail)).toEqual(largeTail);

      const turn = runner.turn({ type: "prompt", message: "Change phase.", behavior: "follow_up" });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.requestModels.at(-1)?.contextWindow).toBe(96);
      expect(await runner.transformForTest(largeTail)).toEqual([largeTail[2]!]);
      runner.completeNext({ text: "Done.", usageTokens: 5 });
      await turn;
    } finally {
      catalog.mockRestore();
    }
  });
});

describe("advisor executor guidance layer", () => {
  beforeAll(async () => {
    if (!inDockerTest) return;
    advisorFixtureCwd = await mkdtemp(join(tmpdir(), "advisor-opt-in-"));
    const table = adapterRoutingFixture();
    table.tiers.frontier!.advisor.enabled = true;
    await mkdir(join(advisorFixtureCwd, ".duet"));
    await writeFile(join(advisorFixtureCwd, ".duet", "models.json"), JSON.stringify(table));
  });
  afterAll(async () => {
    if (advisorFixtureCwd) await rm(advisorFixtureCwd, { recursive: true, force: true });
    advisorFixtureCwd = undefined;
  });
  testIfDocker(
    "completion review resets a recent orientation consultation's cooldown",
    async () => {
      const runner = new RouterTurnRunner({
        everySteps: 99,
        stubAdvisor: true,
        classify: async () => ({ route: "general" }),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Implement the durable queue migration.",
        behavior: "follow_up",
      });
      for (let step = 0; step < orientationStepBoundary(); step++) {
        await waitFor(() => runner.pendingStreams.length === 1);
        runner.completeNext({
          tool: { name: "bash", arguments: { command: "true" } },
          usageTokens: 5,
        });
      }

      await waitFor(() => runner.pendingStreams.length === 1);
      expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("orientation checkpoint");
      runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
      await waitFor(() => runner.advisorContextTexts.length === 1);
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.routeStatus()?.advisorGate.allowed).toBe(false);
      expect(runner.routeStatus()?.advisorGate.stepsUntilAllowed).toBeGreaterThan(0);
      runner.completeNext({ text: "The migration is implemented.", usageTokens: 5 });

      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.routeStatus()?.advisorGate).toEqual({ allowed: true, stepsUntilAllowed: 0 });
      const completionRequest = JSON.stringify(runner.requestMessages.at(-1));
      expect(completionRequest).toContain("completion-review checkpoint");
      expect(completionRequest).toContain("Implement the durable queue migration.");
      expect(completionRequest).toContain("Advisor review 1");
      runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
      await waitFor(() => runner.advisorContextTexts.length === 2);
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Migration complete and reviewed.", usageTokens: 5 });

      const terminal = await turn;
      expect(terminal.type).toBe("complete");
      if (terminal.type !== "complete") throw new Error(`Unexpected terminal: ${terminal.type}`);
      expect(terminal.result).toBe("Migration complete and reviewed.");
      expect(runner.advisorContextTexts[1]).toContain("The migration is implemented.");
      expect(runner.advisorContextTexts[1]).toContain("completion-review checkpoint");
      expect(
        events.filter(
          (event) =>
            event.type === "step" &&
            event.step.type === "tool_call_start" &&
            event.step.toolName === "ask_advisor",
        ),
      ).toHaveLength(2);
      await runner.dispose();
    },
  );

  testIfDocker("tool work after an early completion review receives a final review", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stubAdvisor: true,
      classify: async () => ({ route: "general" }),
    });
    await startRunner(runner, []);

    const turn = runner.turn({
      type: "prompt",
      message: "Diagnose the bug, implement the fix, and verify it.",
      behavior: "follow_up",
    });
    for (let step = 0; step < orientationStepBoundary(); step++) {
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
    }

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("orientation checkpoint");
    runner.completeNext({
      text: "The root cause is clear; review it before I edit.",
      usageTokens: 5,
    });

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("completion-review checkpoint");
    runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
    await waitFor(() => runner.advisorContextTexts.length === 1);
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "apply-fix" } },
      usageTokens: 5,
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "The fix is implemented and verified.", usageTokens: 5 });

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("completion-review checkpoint");
    runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
    await waitFor(() => runner.advisorContextTexts.length === 2);
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "verify-final-fix" } },
      usageTokens: 5,
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "The final diff is reviewed and complete.", usageTokens: 5 });

    const terminal = await turn;
    expect(terminal.type).toBe("complete");
    expect(runner.advisorContextTexts).toHaveLength(2);
    expect(runner.advisorContextTexts[1]).toContain("The fix is implemented and verified.");
    await runner.dispose();
  });

  testIfDocker(
    "a final response at the orientation boundary consumes the steer before the pass stops",
    async () => {
      const runner = new RouterTurnRunner({
        everySteps: 99,
        stubAdvisor: true,
        classify: async () => ({ route: "general" }),
      });
      await startRunner(runner, []);

      const turn = runner.turn({
        type: "prompt",
        message: "Investigate the migration and finish after the evidence is clear.",
        behavior: "follow_up",
      });
      for (let step = 0; step < orientationStepBoundary() - 1; step++) {
        await waitFor(() => runner.pendingStreams.length === 1);
        runner.completeNext({
          tool: { name: "bash", arguments: { command: "true" } },
          usageTokens: 5,
        });
      }
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "The evidence looks complete.", usageTokens: 5 });

      await waitFor(() => runner.pendingStreams.length === 1);
      expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("orientation checkpoint");
      runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
      await waitFor(() => runner.advisorContextTexts.length === 1);
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Evidence reviewed; migration complete.", usageTokens: 5 });

      const terminal = await turn;
      expect(terminal.type).toBe("complete");
      expect(runner.advisorContextTexts).toHaveLength(1);
      expect(JSON.stringify(terminal.state.agent.messages)).not.toContain(
        "completion-review checkpoint",
      );
      await runner.dispose();
    },
  );

  testIfDocker(
    "a voluntary final-evidence consultation does not trigger an immediate duplicate",
    async () => {
      const runner = new RouterTurnRunner({
        everySteps: 99,
        stubAdvisor: true,
        classify: async () => ({ route: "general" }),
      });
      await startRunner(runner, []);

      const turn = runner.turn({
        type: "prompt",
        message: "Inspect the evidence, obtain strategic review when ready, and finish.",
        behavior: "follow_up",
      });
      for (let step = 0; step < orientationStepBoundary() - 1; step++) {
        await waitFor(() => runner.pendingStreams.length === 1);
        runner.completeNext({
          tool: { name: "bash", arguments: { command: "true" } },
          usageTokens: 5,
        });
      }
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
      await waitFor(() => runner.advisorContextTexts.length === 1);
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Reviewed and complete.", usageTokens: 5 });

      const terminal = await turn;
      expect(terminal.type).toBe("complete");
      expect(runner.advisorContextTexts).toHaveLength(1);
      const transcript = JSON.stringify(terminal.state.agent.messages);
      expect(transcript).not.toContain("orientation checkpoint");
      expect(transcript).not.toContain("completion-review checkpoint");
      await runner.dispose();
    },
  );

  testIfDocker(
    "routine agent work finishes without lifecycle consultation checkpoints",
    async () => {
      const runner = new RouterTurnRunner({
        everySteps: 99,
        stubAdvisor: true,
        classify: async () => ({ route: "general" }),
      });
      await startRunner(runner, []);

      const turn = runner.turn({
        type: "prompt",
        message: "Read one value and answer.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Done.", usageTokens: 5 });

      const terminal = await turn;
      expect(terminal.type).toBe("complete");
      expect(runner.advisorContextTexts).toEqual([]);
      expect(JSON.stringify(terminal.state.agent.messages)).not.toContain("checkpoint");
      expect(runner.requestMessages).toHaveLength(2);
      await runner.dispose();
    },
  );

  testIfDocker("routed tiers with the advisor enabled carry the timing layer", async () => {
    const frontier = new RouterTurnRunner({ classify: scriptedClassifier([]) });
    await startRunner(frontier, []);
    expect(frontier.parentAgentForTest().state.systemPrompt).toContain(
      ADVISOR_EXECUTOR_GUIDANCE_LAYER,
    );
    await frontier.dispose();

    const balanced = new RouterTurnRunner({ model: "balanced", classify: scriptedClassifier([]) });
    await startRunner(balanced, []);
    expect(balanced.parentAgentForTest().state.systemPrompt).not.toContain(
      ADVISOR_EXECUTOR_GUIDANCE_LAYER,
    );
    await balanced.dispose();

    const concrete = new RouterTurnRunner({
      model: "gpt-6-sol",
      classify: scriptedClassifier([]),
    });
    await startRunner(concrete, []);
    expect(concrete.parentAgentForTest().state.systemPrompt).not.toContain(
      ADVISOR_EXECUTOR_GUIDANCE_LAYER,
    );
    await concrete.dispose();
  });

  testIfDocker("advisor guidance retains an unrelated workflow rule", async () => {
    const workflowRule = "WORKFLOW-USES-BOUNDED-VALIDATION";
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([]),
      systemInstructions: workflowRule,
    });
    await startRunner(runner, []);

    const systemPrompt = runner.parentAgentForTest().state.systemPrompt;
    expect(systemPrompt).toContain(workflowRule);
    expect(systemPrompt).toContain(ADVISOR_EXECUTOR_GUIDANCE_LAYER);
    await runner.dispose();
  });
});

function advisorPolicyFixture(): RoutingTable {
  return {
    defaultTier: "frontier",
    tiers: Object.fromEntries(
      ["frontier", "balanced"].map((tier) => [
        tier,
        {
          routes: Object.fromEntries(
            ["general", "plan", "implement", "writing", "visual"].map((route) => [
              route,
              {
                description: `Fixture ${route} work`,
                target: { modelName: "gpt-6.1-sol", thinkingLevel: "medium" },
              },
            ]),
          ),
          advisor: {
            enabled: false,
            target: { modelName: "opus", thinkingLevel: "medium" },
            minStepsBetween: 5,
          },
        },
      ]),
    ),
    classifier: {
      target: { modelName: "sonnet", thinkingLevel: "low" },
      everySteps: 5,
      guidance: "Fixture routing guidance",
    },
  };
}

describe("configured compound advisor policy", () => {
  testIfDocker(
    "every configured tier with advisors disabled completes work without advisor tools or guidance",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "compound-policy-"));
      const configuredTable = advisorPolicyFixture();
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(configuredTable));
      try {
        for (const model of Object.keys(advisorPolicyFixture().tiers)) {
          const runner = new RouterTurnRunner({
            cwd,
            model,
            stubAdvisor: true,
            everySteps: 99,
            classify: async () => ({ route: "general" }),
          });
          try {
            await startRunner(runner, []);
            const turn = runner.turn({
              type: "prompt",
              message: "Answer with Done.",
              behavior: "follow_up",
            });
            await waitFor(() => runner.pendingStreams.length === 1);
            expect(runner.requestContexts[0]!.tools?.map((tool) => tool.name)).not.toContain(
              "ask_advisor",
            );
            expect(runner.requestContexts[0]!.systemPrompt).not.toContain("ask_advisor");
            runner.completeNext({ text: "Done.", usageTokens: 5 });
            const terminal = await turn;
            expect(terminal.type).toBe("complete");
            expect(runner.advisorContextTexts).toEqual([]);
            expect(JSON.stringify(terminal.state.agent.messages)).not.toContain(
              "completion-review checkpoint",
            );
          } finally {
            await runner.dispose();
          }
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});

testIfDocker(
  "current policy governs resumed compound sessions and their nested workers",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "compound-resume-"));
    const nestedCwd = join(cwd, "worker");
    await mkdir(join(cwd, ".duet"));
    await mkdir(nestedCwd);
    try {
      for (const model of Object.keys(advisorPolicyFixture().tiers)) {
        const previousTable = advisorPolicyFixture();
        previousTable.tiers[model]!.advisor.enabled = true;
        const path = join(cwd, ".duet", "models.json");
        await writeFile(path, JSON.stringify(previousTable));
        const previous = new RouterTurnRunner({
          cwd,
          model,
          stubAdvisor: true,
          everySteps: 99,
          classify: async () => ({ route: "general" }),
        });
        let saved;
        try {
          await startRunner(previous, []);
          const turn = previous.turn({
            type: "prompt",
            message: "Review this task.",
            behavior: "follow_up",
          });
          await waitFor(() => previous.pendingStreams.length === 1);
          previous.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
          await waitFor(() => previous.pendingStreams.length === 1);
          previous.completeNext({ text: "Reviewed.", usageTokens: 5 });
          saved = (await turn).state;
          expect(previous.advisorContextTexts).toHaveLength(1);
          expect(JSON.stringify(saved.agent.messages)).toContain("Advisor review 1");
        } finally {
          await previous.dispose();
        }

        // The host refreshes its managed file before starting a replacement process.
        await writeFile(path, JSON.stringify(advisorPolicyFixture()));
        const resumed = new RouterTurnRunner({
          cwd,
          model,
          stubAdvisor: true,
          everySteps: 99,
          classify: async () => ({ route: "general" }),
        });
        try {
          await resumed.start({ type: "start", state: saved });
          expect(resumed.getState()!.agent.messages).toEqual(saved.agent.messages);
          const turn = resumed.turn({
            type: "prompt",
            message: "Continue with Done.",
            behavior: "follow_up",
          });
          await waitFor(() => resumed.pendingStreams.length === 1);
          expect(resumed.requestContexts[0]!.tools?.map((tool) => tool.name)).not.toContain(
            "ask_advisor",
          );
          expect(resumed.requestContexts[0]!.systemPrompt).not.toContain("ask_advisor");
          resumed.completeNext({ text: "Done.", usageTokens: 5 });
          expect((await turn).type).toBe("complete");
          expect(resumed.requestContexts).toHaveLength(1);

          const child = resumed.createStateAgentForTest({
            kind: "agent",
            name: "worker",
            model,
            cwd: nestedCwd,
            prompt: "Return Worker done.",
          });
          const result = child.prompt();
          await waitFor(() => resumed.pendingStreams.length === 1);
          expect(resumed.requestContexts.at(-1)!.tools?.map((tool) => tool.name)).not.toContain(
            "ask_advisor",
          );
          expect(resumed.requestContexts.at(-1)!.systemPrompt).not.toContain("ask_advisor");
          resumed.completeNext({ text: "Worker done.", usageTokens: 5 });
          expect(await result).toEqual({ type: "complete", result: "Worker done." });
          expect(resumed.advisorContextTexts).toEqual([]);
        } finally {
          await resumed.dispose();
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "fresh and resumed work dispatches the targets from the replacement table",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "balanced-default-"));
    try {
      for (const route of ["plan", "implement", "general", "writing", "visual"] as const) {
        const priorTable = advisorPolicyFixture();
        priorTable.tiers.balanced.routes[route]!.target.modelName =
          route === "visual" ? "kimi" : "sonnet";
        await mkdir(join(cwd, ".duet"), { recursive: true });
        await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(priorTable));
        const previous = new RouterTurnRunner({
          cwd,
          model: "balanced",
          classify: async () => ({ route }),
        });
        let saved;
        try {
          await startRunner(previous, []);
          saved = structuredClone(previous.getState()!);
        } finally {
          await previous.dispose();
        }
        const currentTable = advisorPolicyFixture();
        currentTable.tiers.balanced.routes[route]!.target.modelName =
          route === "visual" || route === "writing" ? "sonnet-5.5" : "gpt-6.1-sol";
        await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(currentTable));
        for (const state of [undefined, saved]) {
          const runner = new RouterTurnRunner({
            cwd,
            model: "balanced",
            classify: async () => ({ route }),
          });
          try {
            await runner.start({
              type: "start",
              ...(state ? { state } : { mode: "agent" as const }),
            });
            const turn = runner.turn({
              type: "prompt",
              message: "Complete this work.",
              behavior: "follow_up",
            });
            await waitFor(() => runner.pendingStreams.length === 1);
            expect(runner.requestModels[0]!.id).toContain(
              route === "visual" || route === "writing" ? "sonnet" : "gpt-6.1-sol",
            );
            expect(runner.requestContexts[0]!.tools?.map((tool) => tool.name)).not.toContain(
              "ask_advisor",
            );
            runner.completeNext({ text: "Done.", usageTokens: 5 });
            expect((await turn).state.options?.model).toBe("balanced");
          } finally {
            await runner.dispose();
          }
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
