import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as catalog from "../src/model-resolution/catalog.js";
import { chooseTransport } from "../src/connected-providers/transport-preference.js";

// Catalog contents are deployment data; exercise transport selection against
// controlled coverage rather than whatever family version currently ships.
let catalogLookup: ReturnType<typeof spyOn>;
beforeEach(() => {
  const coverage: Record<string, Partial<Record<catalog.TransportName, string>>> = {
    covered: {
      "openai-codex": "connected-worker",
      "duet-gateway": "metered-worker",
      "vercel-ai-gateway": "metered-worker",
      openrouter: "metered-worker",
    },
    copilot: { "github-copilot": "copilot-worker", "duet-gateway": "metered-copilot" },
    uncovered: { "duet-gateway": "metered-only" },
  };
  catalogLookup = spyOn(catalog, "transportModelId").mockImplementation(
    (transport, shorthand) => coverage[shorthand]?.[transport],
  );
});
afterEach(() => catalogLookup.mockRestore());

describe("connected provider transport preference", () => {
  test("prefers an eligible connected transport that covers a shorthand", () => {
    expect(
      chooseTransport("covered", {
        connections: [{ provider: "openai-codex", eligibility: "eligible" }],
      }),
    ).toEqual({
      transport: "openai-codex",
      modelId: "connected-worker",
      planCovered: true,
      reason: "connected",
    });
  });

  test("truth table preserves pins, skips ineligible plans, and falls through missing coverage", () => {
    const cases = [
      {
        name: "no connections + covered shorthand",
        input: "covered",
        connections: [],
        expected: ["duet-gateway", "metered-worker", false, "router_order"],
      },
      {
        name: "eligible codex + covered shorthand",
        input: "covered",
        connections: [{ provider: "openai-codex", eligibility: "eligible" }],
        expected: ["openai-codex", "connected-worker", true, "connected"],
      },
      {
        name: "unknown eligibility is usable until a probe rejects the plan",
        input: "covered",
        connections: [{ provider: "openai-codex", eligibility: "unknown" }],
        expected: ["openai-codex", "connected-worker", true, "connected"],
      },
      {
        name: "plan-ineligible codex + covered shorthand",
        input: "covered",
        connections: [{ provider: "openai-codex", eligibility: "plan_ineligible" }],
        expected: ["duet-gateway", "metered-worker", false, "router_order"],
      },
      {
        name: "eligible copilot + covered shorthand",
        input: "copilot",
        connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        expected: ["github-copilot", "copilot-worker", true, "connected"],
      },
      {
        name: "eligible copilot + uncovered sonnet 5",
        input: "uncovered",
        connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        expected: ["duet-gateway", "metered-only", false, "router_order"],
      },
      {
        name: "both connections in reverse order + codex-only routed result",
        input: "covered",
        connections: [
          { provider: "github-copilot", eligibility: "eligible" },
          { provider: "openai-codex", eligibility: "eligible" },
        ],
        expected: ["openai-codex", "connected-worker", true, "connected"],
      },
      {
        name: "both connections + copilot-only routed result",
        input: "copilot",
        connections: [
          { provider: "openai-codex", eligibility: "eligible" },
          { provider: "github-copilot", eligibility: "eligible" },
        ],
        expected: ["github-copilot", "copilot-worker", true, "connected"],
      },
      {
        name: "explicit router pin wins",
        input: "openrouter:openai/gpt-6-sol",
        connections: [{ provider: "openai-codex", eligibility: "eligible" }],
        expected: ["openrouter", "openai/gpt-6-sol", false, "explicit_pin"],
      },
      {
        name: "explicit connected pin wins even when the plan was marked ineligible",
        input: "github-copilot:claude-sonnet-5",
        connections: [{ provider: "github-copilot", eligibility: "plan_ineligible" }],
        expected: ["github-copilot", "claude-sonnet-5", true, "explicit_pin"],
      },
      {
        name: "unknown explicit provider passthrough wins",
        input: "anthropic:claude-future",
        connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        expected: ["anthropic", "claude-future", false, "explicit_pin"],
      },
    ] as const;

    for (const { name, input, connections, expected } of cases) {
      const choice = chooseTransport(input, { connections });
      expect([choice.transport, choice.modelId, choice.planCovered, choice.reason], name).toEqual([
        ...expected,
      ]);
    }
  });
});

test("router order skips routers without configured credentials", () => {
  const choice = chooseTransport("covered", {
    connections: [],
    configuredRouters: ["openrouter"],
  });
  expect(choice).toEqual({
    transport: "openrouter",
    modelId: "metered-worker",
    planCovered: false,
    reason: "router_order",
  });
});
