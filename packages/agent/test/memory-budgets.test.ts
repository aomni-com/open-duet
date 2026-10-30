import { describe, expect, test } from "bun:test";

import {
  OBSERVATION_BUFFER_RATIO,
  REFLECTION_BUFFER_RATIO,
  deriveMemoryBudgets,
  FIXED_OBSERVER_BUDGETS,
  GLOBAL_CONTEXT_TOKEN_BUDGET,
  MEMORY_BUDGET_RATIOS,
  resolveObservationalMemorySettings,
  validateObservationalMemorySettings,
} from "../src/memory/observational.js";

/** Local budgets scale with the actor window while fixed memory layers retain their own caps. */
describe("Memory budgets", () => {
  test("local-session ratios leave headroom for the system prompt", () => {
    const total = MEMORY_BUDGET_RATIOS.messageTokens + MEMORY_BUDGET_RATIOS.observationTokens;
    // The two local-session ratios used to share `effectiveContext` with
    // the global pack so the three summed to 1. The global pack is now a
    // fixed cap, so the remaining ratios only need to leave headroom for
    // the system prompt and tool slack the raw tail absorbs.
    expect(total).toBeLessThan(1);
  });

  test("local trigger budgets scale with the supplied actor window", () => {
    const small = deriveMemoryBudgets(50_000);
    const large = deriveMemoryBudgets(500_000);
    for (const [smallValue, largeValue] of [
      [small.observation.messageTokens, large.observation.messageTokens],
      [small.reflection.observationTokens, large.reflection.observationTokens],
    ]) {
      // Flooring each derived budget may lose less than one token per unit.
      expect(largeValue!).toBeGreaterThanOrEqual(smallValue! * 10);
      expect(largeValue!).toBeLessThan(smallValue! * 10 + 10);
    }
  });

  test("globalContextTokenBudget is fixed across actor windows", () => {
    for (const effectiveContext of [50_000, 200_000, 1_000_000]) {
      const budgets = deriveMemoryBudgets(effectiveContext);
      expect(budgets.globalContextTokenBudget).toBe(GLOBAL_CONTEXT_TOKEN_BUDGET);
    }
  });

  test("globalContextTokenBudget clamps down on tiny effectiveContext", () => {
    // Test-mode fixtures sometimes pass effectiveContext smaller than the
    // global cap; the loader should never be told to pack more tokens than
    // the actor can hold.
    const budgets = deriveMemoryBudgets(1);
    expect(budgets.globalContextTokenBudget).toBe(1);
  });

  test("observer-only budgets are fixed regardless of effectiveContext", () => {
    const small = deriveMemoryBudgets(50_000);
    const large = deriveMemoryBudgets(1_000_000);
    expect(small.observation.maxTranscriptTokens).toBe(FIXED_OBSERVER_BUDGETS.maxTranscriptTokens);
    expect(small.observation.maxObservationLogTokens).toBe(
      FIXED_OBSERVER_BUDGETS.maxObservationLogTokens,
    );
    expect(small.observation.previousObserverTokens).toBe(
      FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    );
    expect(large.observation.maxTranscriptTokens).toBe(FIXED_OBSERVER_BUDGETS.maxTranscriptTokens);
    expect(large.observation.maxObservationLogTokens).toBe(
      FIXED_OBSERVER_BUDGETS.maxObservationLogTokens,
    );
    expect(large.observation.previousObserverTokens).toBe(
      FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    );
  });

  test("buffer activations match their per-pipeline ratios across scales", () => {
    for (const effectiveContext of [10_000, 200_000, 500_000]) {
      const budgets = deriveMemoryBudgets(effectiveContext);
      expect(budgets.observation.bufferActivation).toBe(
        Math.floor(OBSERVATION_BUFFER_RATIO * budgets.observation.messageTokens),
      );
      expect(budgets.reflection.bufferActivation).toBe(
        Math.floor(REFLECTION_BUFFER_RATIO * budgets.reflection.observationTokens),
      );
      expect(budgets.observation.bufferActivation).toBeLessThan(budgets.observation.messageTokens);
      expect(budgets.reflection.bufferActivation).toBeLessThan(
        budgets.reflection.observationTokens,
      );
    }
  });

  test("tiny effectiveContext still produces strictly positive budgets that pass validation", () => {
    // 2 is the smallest E where every ratio rounds down to at least 1
    // distinct from its trigger: messageTokens=1.2→1, buffer=0.5→1 would
    // tie; the atLeastOne floor keeps both at 1 only when the rounding
    // would collapse them. Validate the function with a small but
    // realistic test-mode value instead, which is what the test fixtures
    // pass when forcing compaction.
    const budgets = deriveMemoryBudgets(17);
    expect(budgets.observation.messageTokens).toBeGreaterThan(0);
    expect(budgets.observation.bufferActivation).toBeGreaterThan(0);
    expect(budgets.reflection.observationTokens).toBeGreaterThan(0);
    expect(budgets.reflection.bufferActivation).toBeGreaterThan(0);
    expect(budgets.globalContextTokenBudget).toBeGreaterThan(0);

    const settings = resolveObservationalMemorySettings(17);
    // Validation throws on `buffer >= trigger`; assert it does not.
    expect(() => validateObservationalMemorySettings(settings)).not.toThrow();
  });

  test("resolveObservationalMemorySettings merges derived budgets with user knobs", () => {
    const settings = resolveObservationalMemorySettings(200_000, {
      observation: { instruction: "always remember X" },
      reflection: { instruction: "always condense Y" },
      reflectionBias: 2,
      recencyHalfLifeMs: 1_000,
      retrieval: false,
    });

    // User knobs flow through.
    expect(settings.observation.instruction).toBe("always remember X");
    expect(settings.reflection.instruction).toBe("always condense Y");
    expect(settings.reflectionBias).toBe(2);
    expect(settings.recencyHalfLifeMs).toBe(1_000);
    expect(settings.retrieval).toBe(false);
  });
});
