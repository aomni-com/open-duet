import * as childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { SkillContext } from "../src/turn-runner/skill-context.js";
import type { TurnRunnerConfig } from "../src/types/config.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempDir: string;
let skillsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-context-reload-"));
  skillsDir = join(tempDir, ".duet", "skills");
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function installSkill(name: string, description: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  // Skill loader requires frontmatter with name + description.
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe("SkillContext.reload", () => {
  testIfDocker("picks up skills added after ensureLoaded()", async () => {
    installSkill("alpha", "first skill");
    const ctx = new SkillContext({
      skillDiscovery: { includeDefaults: false, cwd: tempDir, skillPaths: [skillsDir] },
    });
    await ctx.ensureLoaded();
    expect(ctx.getSkills().find((s) => s.name === "alpha")?.description).toBe("first skill");
    expect(ctx.getSkills().some((s) => s.name === "beta")).toBe(false);

    installSkill("beta", "second skill");
    // ensureLoaded is a no-op after first run — only reload re-discovers.
    await ctx.ensureLoaded();
    expect(ctx.getSkills().some((s) => s.name === "beta")).toBe(false);

    await ctx.reload();
    expect(ctx.getSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "alpha", description: "first skill" }),
        expect.objectContaining({ name: "beta", description: "second skill" }),
      ]),
    );
  });

  testIfDocker("concurrent ensureLoaded() callers share one discovery", async () => {
    const counterPath = join(tempDir, "runs");
    writeFileSync(counterPath, "");
    const ctx = new SkillContext({
      skills: [explicitSkill(`Use when !\`printf x >> ${counterPath}; printf ready\`.`)],
      skillDiscovery: { includeDefaults: false, cwd: tempDir, skillPaths: [skillsDir] },
    });

    await Promise.all([ctx.ensureLoaded(), ctx.ensureLoaded()]);

    // A second load would re-run every skill's description command, so the
    // counter — not just the merged skill list — is what proves single-flight.
    expect(readFileSync(counterPath, "utf-8")).toBe("x");
    expect(ctx.getSkills().find((skill) => skill.name === "explicit")?.description).toBe(
      "Use when ready.",
    );
  });

  testIfDocker("a reload racing an in-flight load lands on the newer snapshot", async () => {
    let releaseSlow: (() => void) | undefined;
    const commands: string[] = [];
    const shell = spyOn(childProcess, "execFile").mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      complete: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const command = args[1]!;
      commands.push(command);
      if (command === "printf slow") releaseSlow = () => complete(null, "slow", "");
      else complete(null, "fast", "");
      return {} as childProcess.ChildProcess;
    }) as typeof childProcess.execFile);
    const config: TurnRunnerConfig = {
      skills: [explicitSkill("Use when !`printf slow`.")],
      skillDiscovery: { includeDefaults: false, cwd: tempDir, skillPaths: [skillsDir] },
    };
    const ctx = new SkillContext(config);
    let loading: Promise<void> | undefined;
    let reloading: Promise<void> | undefined;
    try {
      loading = ctx.ensureLoaded();
      if (!releaseSlow) throw new Error("Older metadata expansion did not reach the process edge");
      config.skills = [explicitSkill("Use when !`printf fast`.")];
      installSkill("beta", "second skill");
      reloading = ctx.reload();
      // Drain promise callbacks while the old process result stays explicitly
      // held. An unqueued newer discovery can finish before we release it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseSlow();
      await Promise.all([loading, reloading]);
      expect(commands).toEqual(["printf slow", "printf fast"]);
      expect(ctx.getSkills().find((skill) => skill.name === "beta")?.description).toBe(
        "second skill",
      );
      expect(ctx.getSkills().find((skill) => skill.name === "explicit")?.description).toBe(
        "Use when fast.",
      );
    } finally {
      releaseSlow?.();
      await Promise.allSettled([loading, reloading]);
      shell.mockRestore();
    }
  });
});

function explicitSkill(description: string): Skill {
  return {
    name: "explicit",
    description,
    filePath: join(tempDir, "explicit.md"),
    baseDir: tempDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
}
