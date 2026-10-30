import { describe, expect, test } from "bun:test";
import type { ClassifierInput } from "../src/model-routing/classifier.js";
import { ModelRouter } from "../src/model-routing/router.js";
import type { RoutingTable } from "../src/model-routing/table.js";
import { settlementNotice } from "../src/turn-runner/task-tools.js";

const KEYWORD = "SETTLEMENT_ROUTE_SENTINEL_Q7";

describe("task settlement routing neutrality", () => {
  test("ignores settlement plumbing but reroutes for genuine assistant text", async () => {
    const table: RoutingTable = {
      defaultTier: "frontier",
      tiers: {
        frontier: {
          routes: {
            general: {
              description: "Default fixture work",
              target: { modelName: "worker-a", thinkingLevel: "medium" },
            },
            plan: {
              description: "Planning fixture work",
              target: { modelName: "worker-b", thinkingLevel: "high" },
            },
          },
          advisor: {
            enabled: false,
            target: { modelName: "advisor", thinkingLevel: "low" },
            minStepsBetween: 5,
          },
        },
      },
      classifier: {
        target: { modelName: "classifier", thinkingLevel: "low" },
        everySteps: 99,
        guidance: "Controlled fixture",
        stepTriggers: [{ name: "settlement", keywords: [KEYWORD] }],
      },
    };
    const inputs: ClassifierInput[] = [];
    const decisions = [{ route: "general" }, { route: "plan" }];
    const router = new ModelRouter({
      table,
      tier: "frontier",
      resolveCatalog: { modelAcceptsImages: () => true },
      classify: async (input) => {
        inputs.push(input);
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected classifier call");
        return decision;
      },
    });
    router.initialTarget({ hasImages: false });
    await router.prepareTurn({});

    const settlement = settlementNotice([
      {
        descriptor: {
          id: "t1",
          kind: "tool",
          name: "bash",
          label: KEYWORD,
          ownerScopeId: "turn-1",
          status: "completed",
          startedAt: 1,
        },
        output: [],
        settlement: { id: "t1", status: "completed", settledAt: 2, result: "done" },
      },
    ]);
    router.noteAssistantStep({ blockTypes: ["text"], text: settlement });
    expect(await router.prepareTurn({})).toBeUndefined();
    expect(inputs.map(({ trigger }) => trigger)).toEqual(["turn_start"]);

    router.noteAssistantStep({
      blockTypes: ["text"],
      text: `Genuine assistant analysis: ${KEYWORD}`,
    });
    expect(await router.prepareTurn({})).toMatchObject({ trigger: "step_trigger", route: "plan" });
    expect(inputs.map(({ trigger }) => trigger)).toEqual(["turn_start", "step_trigger"]);

    // Falsification: pass the settlement builder's inner text without its synthetic sentinel.
    // The first prepareTurn then returns a step_trigger switch and the one-input assertion reds.
  });
});
