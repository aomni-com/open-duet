import { describe, expect, test } from "bun:test";

import { resolveRoute, resolveTierDefault } from "../src/model-routing/resolve.js";
import { type RoutingTable } from "../src/model-routing/table.js";

const catalog = {
  modelAcceptsImages: (name: string) => name !== "glm",
};

const FIXTURE_ROUTING_TABLE: RoutingTable = {
  defaultTier: "frontier",
  tiers: Object.fromEntries(
    ["frontier", "balanced"].map((tier) => [
      tier,
      {
        routes: {
          general: {
            description: "Fixture general work",
            target: { modelName: "fixture-model", thinkingLevel: "low" },
          },
          implement: {
            description: "Fixture implementation",
            target: { modelName: "fixture-model", thinkingLevel: "medium" },
          },
        },
        advisor: {
          enabled: false,
          target: { modelName: "fixture-model", thinkingLevel: "low" },
          minStepsBetween: 2,
        },
      },
    ]),
  ),
  classifier: {
    target: { modelName: "fixture/classifier" },
    everySteps: 2,
    guidance: "Fixture guidance",
  },
};

/** Give the fixture one text-only route with a configured image fallback. */
function textOnlyImplementTable(): RoutingTable {
  const table = structuredClone(FIXTURE_ROUTING_TABLE);
  table.tiers.balanced.routes.implement.target.modelName = "glm";
  table.tiers.balanced.routes.implement.visionFallbackModelName = "luna";
  return table;
}

describe("model route resolution", () => {
  test("applies a route's vision fallback without changing its route or effort", () => {
    expect(
      resolveRoute(textOnlyImplementTable(), "balanced", "implement", { hasImages: true }, catalog),
    ).toEqual({
      tier: "balanced",
      route: "implement",
      modelName: "luna",
      thinkingLevel: "medium",
      visionFallback: true,
      chain: ["balanced"],
    });
  });

  test("keeps a text-only target when its route has no vision fallback", () => {
    const table = textOnlyImplementTable();
    delete table.tiers.balanced.routes.implement.visionFallbackModelName;

    expect(resolveRoute(table, "balanced", "implement", { hasImages: true }, catalog)).toEqual({
      tier: "balanced",
      route: "implement",
      modelName: "glm",
      thinkingLevel: "medium",
      visionFallback: false,
      chain: ["balanced"],
    });
  });

  test("re-enters a virtual fallback chain while preserving the selected route effort", () => {
    const table = textOnlyImplementTable();
    table.tiers.balanced.routes.implement.target.thinkingLevel = "low";
    table.tiers.balanced.routes.implement.visionFallbackModelName = "frontier";

    expect(resolveRoute(table, "balanced", "implement", { hasImages: true }, catalog)).toEqual({
      tier: "frontier",
      route: "implement",
      modelName: "fixture-model",
      thinkingLevel: "low",
      visionFallback: true,
      chain: ["balanced", "frontier"],
    });
  });

  test("re-enters the same route when a target names another virtual model", () => {
    const table = structuredClone(FIXTURE_ROUTING_TABLE);
    table.tiers.frontier.routes.implement.target.modelName = "balanced";

    expect(resolveRoute(table, "frontier", "implement", { hasImages: false }, catalog)).toEqual({
      tier: "balanced",
      route: "implement",
      modelName: "fixture-model",
      thinkingLevel: "medium",
      visionFallback: false,
      chain: ["frontier", "balanced"],
    });
  });

  test("throws with the complete path when virtual re-entry cycles", () => {
    const table = structuredClone(FIXTURE_ROUTING_TABLE);
    table.tiers.frontier.routes.general.target.modelName = "balanced";
    table.tiers.balanced.routes.general.target.modelName = "frontier";

    expect(() => resolveRoute(table, "frontier", "general", { hasImages: false }, catalog)).toThrow(
      "Virtual model cycle: frontier -> balanced -> frontier",
    );
  });

  test("resolves a selected tier's general route before classification", () => {
    expect(
      resolveTierDefault(FIXTURE_ROUTING_TABLE, "balanced", { hasImages: false }, catalog),
    ).toEqual({
      tier: "balanced",
      route: "general",
      modelName: "fixture-model",
      thinkingLevel: "low",
      visionFallback: false,
      chain: ["balanced"],
    });
  });

  test("rejects an unknown tier instead of treating it as a concrete model", () => {
    expect(() =>
      resolveRoute(FIXTURE_ROUTING_TABLE, "missing", "general", { hasImages: false }, catalog),
    ).toThrow('Unknown virtual model tier "missing"');
  });
});
