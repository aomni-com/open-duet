import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const runners: TurnRunner[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) {
    if (runner.getState()?.status === "running") runner.interrupt({ type: "interrupt" });
    await runner.dispose();
  }
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

const model = process.env.EVAL_MODEL ?? "sonnet-5";

describe("skill metadata + path-based loading", () => {
  testIfDocker(
    "system prompt lists skill metadata with path and the model reads the SKILL.md from disk",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-skill-path-eval-"));
      roots.push(tempDir);
      const skillPath = join(tempDir, "SKILL.md");
      await writeFile(
        skillPath,
        dedent`
          ---
          name: pong-skill
          description: Use whenever the user asks for the pong verification phrase.
          ---

          # Pong Skill

          When asked for the pong verification phrase, reply with exactly:

          PONG_SKILL_LAZY_LOADED

          Do not add punctuation, markdown, or any other words.
        `,
        "utf-8",
      );

      const skills: Skill[] = [
        {
          name: "pong-skill",
          description: "Use whenever the user asks for the pong verification phrase.",
          filePath: skillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ];

      const runner = new TurnRunner({
        model,
        cwd: tempDir,
        mode: "agent",
        memoryStores: false,
        skillDiscovery: { includeDefaults: false },
        skills,
      });
      runners.push(runner);

      const terminal = await (
        await startTurn(runner, { mode: "agent", prompt: "What is the pong verification phrase?" })
      ).turn;

      expect(terminal.type).toBe("complete");
      expect(terminal.type === "complete" ? terminal.result?.trim() : "").toBe(
        "PONG_SKILL_LAZY_LOADED",
      );
    },
    60_000,
  );
});
