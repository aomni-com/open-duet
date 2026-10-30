import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { ATOMIC_REFLECTIONS, SUMMARY_REFLECTION } from "./fixtures/bumping/blob-vs-atomic.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { createMemoryFixture, type MemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * Live-observer evals for the SELECTION half of the usage-bumping
 * path: when the observer cites a memory and the global pool
 * contains both a broad summary reflection and narrow, unit-sized
 * siblings covering the same fact, only the atomic rows the turn
 * actually leaned on should have their `last_used_at` advance.
 *
 * Harness: full-observer (drives `updateObservationalMemory`
 * end-to-end against the live memory model). `applyUsageBumps` is
 * private, and the SELECTION logic includes both the observer
 * citing the correct ids and the bump applying only to those rows,
 * so the end-to-end path is the right level of test even though
 * it costs a live model call. The assertions land on stored
 * `last_used_at` values rather than on prompt output.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

async function readLastUsed(
  fixture: MemoryFixture,
): Promise<Map<string, { lastUsedAt: number; content: string }>> {
  const result = await fixture.session.withDb(async (db) =>
    db.query<{ id: string; last_used_at: number; content: string }>(
      "SELECT id, last_used_at, content FROM observations",
    ),
  );
  const out = new Map<string, { lastUsedAt: number; content: string }>();
  for (const row of result?.rows ?? []) {
    out.set(row.id, { lastUsedAt: row.last_used_at, content: row.content });
  }
  return out;
}

function atomicIdsForSubjects(ids: string[], subjects: string[]): string[] {
  return subjects.map((subject) => {
    const index = ATOMIC_REFLECTIONS.findIndex((seed) => seed.content.startsWith(subject));
    if (index < 0 || !ids[index]) throw new Error(`Missing authored atomic subject: ${subject}`);
    return ids[index]!;
  });
}

function expectUsageBumps(
  before: Map<string, { lastUsedAt: number; content: string }>,
  after: Map<string, { lastUsedAt: number; content: string }>,
  citedIds: string[],
): void {
  for (const [id, baseline] of before) {
    const stored = after.get(id);
    expect(stored?.content).toBe(baseline.content);
    if (citedIds.includes(id)) {
      expect(stored!.lastUsedAt).toBeGreaterThan(baseline.lastUsedAt);
    } else {
      expect(stored!.lastUsedAt).toBe(baseline.lastUsedAt);
    }
  }
}

async function runObserverTurn(
  fixture: MemoryFixture,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  await rebuildMemoryContextPack({
    session: fixture.session,
    cache: fixture.cache,
    settings,
    sessionId,
  });

  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
    createAssistantMessage({
      text: assistantText,
      timestamp: Date.now() + 1,
    }),
  ];

  await updateObservationalMemory({
    session: fixture.session,
    memory: fixture.cache,
    sessionId,
    effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
    actorModel: memoryModel,
    messages,
  });
}

describe("bump prefers the narrowest row that carries the cited fact", () => {
  testIfDocker(
    "bumps narrow siblings, not the broad summary, when both cover the cited fact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const [summaryId, ...atomicIds] = await seedObservations(fixture, [
          SUMMARY_REFLECTION,
          ...ATOMIC_REFLECTIONS,
        ]);
        const before = await readLastUsed(fixture);
        const citedIds = atomicIdsForSubjects(atomicIds, [
          "[2026-05-15] Anthropic retry fix",
          "[2026-05-15] Vitest 4 upgrade",
        ]);
        expect(before.get(summaryId)!.lastUsedAt).toBeGreaterThan(0);

        await runObserverTurn(
          fixture,
          "session-synthetic-098",
          "Remind me what shipped in v0.1.131 and what Vitest 4 upgrade commit landed on staging.",
          "v0.1.131 released the transient-retry fix for `Anthropic stream ended before message_stop` " +
            "in `src/turn-runner/transient-error.ts`, and the Vitest 4 upgrade was pushed as commit " +
            "`885746567` to staging.",
        );

        const after = await readLastUsed(fixture);

        // Each cited fact refreshes its authored narrow row; every other
        // pre-existing row, including the broad summary, stays unchanged.
        expectUsageBumps(before, after, citedIds);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "falls back to the summary row when no narrower row carries the cited fact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const [summaryId] = await seedObservations(fixture, [SUMMARY_REFLECTION]);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(summaryId)!.lastUsedAt;

        await runObserverTurn(
          fixture,
          "session-synthetic-099",
          "Remind me what shipped in v0.1.131 and what Vitest 4 upgrade commit landed on staging.",
          "v0.1.131 released the transient-retry fix for `Anthropic stream ended before message_stop` " +
            "in `src/turn-runner/transient-error.ts`, and the Vitest 4 upgrade was pushed as commit " +
            "`885746567` to staging.",
        );

        const after = await readLastUsed(fixture);
        // No atomic siblings exist; the only row covering those facts
        // is the only row, so the bump lands on it.
        expect(after.get(summaryId)!.lastUsedAt).toBeGreaterThan(seededTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "multiple atomic citations all get bumped",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const atomicIds = await seedObservations(fixture, ATOMIC_REFLECTIONS);
        const before = await readLastUsed(fixture);
        const citedIds = atomicIdsForSubjects(atomicIds, [
          "[2026-05-15] Anthropic retry fix",
          "[2026-05-15] Bundled ripgrep support",
          "[2026-05-15] Memory-observation formatting",
        ]);

        await runObserverTurn(
          fixture,
          "session-synthetic-100",
          "Quick recap: what changed for transient Anthropic retries, bundled ripgrep, and the " +
            "memory-observation formatting?",
          "v0.1.131 made `Anthropic stream ended before message_stop` transient in " +
            "`src/turn-runner/transient-error.ts`. Bundled ripgrep ships via `@vscode/ripgrep` " +
            "optional platform deps and `withBundledRipgrep` is wired in `src/turn-runner/tools.ts`. " +
            "Memory-observation formatting (v0.1.130) now skips completed events when both " +
            "`observation` and `usageBumped` are empty, otherwise keeps the `Memory observation " +
            "recorded.` prefix with the optional `Reinforced N prior memor{y,ies}.` suffix.",
        );

        const after = await readLastUsed(fixture);
        expectUsageBumps(before, after, citedIds);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});
