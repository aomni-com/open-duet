import { afterEach, describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const runners: TurnRunner[] = [];
const scratchDirs: string[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(
    scratchDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const model = process.env.EVAL_MODEL ?? "sonnet-5";

describe("system prompt files", () => {
  testIfDocker(
    "loads the default AGENTS.md prompt file into the model context",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-system-prompt-file-"));
      scratchDirs.push(cwd);
      await writeFile(
        join(cwd, "AGENTS.md"),
        [
          "# Agent Guidelines",
          "",
          "When the user asks for the prompt-file verification phrase, reply with exactly:",
          "",
          "PROMPT_FILE_LAYER_CONFIRMED",
          "",
          "Do not add punctuation, markdown, or any other words.",
        ].join("\n"),
        "utf-8",
      );

      const runner = new TurnRunner({
        model,
        cwd,
        mode: "agent",
        memoryStores: false,
        skillDiscovery: { includeDefaults: false },
      });
      runners.push(runner);

      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt: "What is the prompt-file verification phrase?",
        })
      ).turn;

      expect(terminal.type).toBe("complete");
      expect(terminal.type === "complete" ? terminal.result?.trim() : "").toBe(
        "PROMPT_FILE_LAYER_CONFIRMED",
      );
    },
    30_000,
  );
});
